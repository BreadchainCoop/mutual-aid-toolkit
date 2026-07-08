/**
 * Repo construction: identity, storage, roster-driven policy, and sync.
 *
 * `openStore` wires the pieces validated against
 * @automerge/automerge-repo@2.6.0-subduction.40:
 *
 *   new Repo({ signer, storage, subductionPolicy, subductionWebsocketEndpoints })
 *
 * The signer is the device identity (Ed25519). In the browser use
 * `WebCryptoSigner.setup()` (non-extractable key in IndexedDB); in Node the
 * CLI persists a MemorySigner's 32 secret bytes on disk (0600).
 *
 * Bootstrap order matters: the policy needs the roster, but the roster doc
 * itself arrives over sync. `openStore` therefore resolves the roster handle
 * first (create locally when new; find via URL when joining) and hands the
 * policy a live getter, so authorization always reflects the latest merged
 * roster state.
 */

import { Repo, initSubduction } from "@automerge/automerge-repo";
import type { DocHandle, StorageAdapterInterface } from "@automerge/automerge-repo";
import { emptyBamDoc, emptyRosterDoc, nowIso } from "./schema.ts";
import type { BamDoc, OrgConfig, RosterDoc } from "./schema.ts";
import { addMember, isActiveMember, redeemInvite, rosterPolicy } from "./roster.ts";

/** Matches the Signer interface of @automerge/automerge-subduction. */
export interface SignerLike {
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
  verifyingKey(): Uint8Array;
  peerId(): { toString(): string };
}

export const DEFAULT_SYNC_ENDPOINT = "wss://sync.subduction.inkandswitch.com";

export interface OpenStoreOptions {
  signer: SignerLike;
  storage?: StorageAdapterInterface;
  /** Subduction websocket endpoints; [] disables networking (tests, offline). */
  endpoints?: string[];
  /** Join an existing org: the roster doc's automerge URL. */
  rosterUrl?: string;
  /** Create a new org with this name (mutually exclusive with rosterUrl). */
  createOrg?: string;
  /** White-label config to bake into the new org's doc (branding, features). */
  orgConfig?: Partial<OrgConfig>;
  /** Display name for this device when bootstrapping a new org. */
  deviceName?: string;
  /** Extra peer ids the policy always allows (e.g. a relay's key). */
  alwaysAllow?: string[];
  /**
   * Trust-on-first-use: connect to the configured endpoints without knowing
   * the relay's peer id in advance (needed for relays whose key isn't
   * published, like the Ink & Switch experiment relay). See
   * `RosterPolicyOptions.trustAll` for the exact semantics and caveats;
   * capture the learned id via `learnedRelayPeers` and pin it afterwards.
   */
  trustDialedRelays?: boolean;
  /**
   * QR-invite self-enrollment: when joining and this device isn't on the
   * roster yet, redeem the invite (validated against the invite's
   * tokenHash/expiry by every replica) and enroll as a volunteer.
   */
  invite?: { inviteId: string; secret: string; deviceName: string };
}

export interface BamStore {
  repo: Repo;
  peerId: string;
  roster: DocHandle<RosterDoc>;
  base: DocHandle<BamDoc>;
}

async function findWithRetry<T>(
  repo: Repo,
  url: string,
  { attempts = 8, delayMs = 1500 } = {}
): Promise<DocHandle<T>> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await repo.find<T>(url as never);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export async function openStore(opts: OpenStoreOptions): Promise<BamStore> {
  await initSubduction();
  const peerId = opts.signer.peerId().toString();

  // The policy reads the roster through this box so it is live from the
  // moment the handle resolves, while the Repo can be constructed first.
  const box: { roster?: DocHandle<RosterDoc> } = {};
  const policy = rosterPolicy(() => box.roster?.doc(), {
    alwaysAllow: [peerId, ...(opts.alwaysAllow ?? [])],
    trustAll: opts.trustDialedRelays,
  });

  const repo = new Repo({
    signer: opts.signer as never,
    storage: opts.storage,
    subductionPolicy: policy as never,
    subductionWebsocketEndpoints: opts.endpoints ?? [],
  });

  let roster: DocHandle<RosterDoc>;
  let base: DocHandle<BamDoc>;
  const now = nowIso();

  if (opts.rosterUrl) {
    // Joining races the websocket connection: find() can report a document
    // unavailable before the relay link is even up, so retry with backoff.
    roster = await findWithRetry<RosterDoc>(repo, opts.rosterUrl);
    box.roster = roster;
    // QR onboarding: not on the roster yet + holding an invite -> redeem
    // it (self-enroll as volunteer; replicas validate the proof).
    if (opts.invite && !isActiveMember(roster.doc(), peerId)) {
      redeemInvite(roster, peerId, opts.invite, now);
    }
    const baseUrl = roster.doc()?.baseDocUrl;
    if (!baseUrl) throw new Error("roster has no baseDocUrl (org not fully initialized)");
    base = await findWithRetry<BamDoc>(repo, baseUrl);
  } else {
    const org = opts.createOrg ?? "My Mutual Aid";
    roster = repo.create<RosterDoc>(emptyRosterDoc(org, now));
    box.roster = roster;
    const orgConfig: OrgConfig = { name: org, ...(opts.orgConfig ?? {}) };
    base = repo.create<BamDoc>(emptyBamDoc(org, now, orgConfig));
    roster.change((d) => {
      d.baseDocUrl = base.url;
    });
    // Bootstrap: the creating device becomes the first admin.
    addMember(roster, peerId, {
      peerId,
      name: opts.deviceName ?? "founding device",
      role: "admin",
    }, now);
  }

  return { repo, peerId, roster, base };
}

/**
 * The relay peer ids this store is currently connected to (excluding our
 * own key). After a trust-on-first-use connect, pin these — pass them as
 * `alwaysAllow` (CLI: saved to state.json as `relayPeer`) so future
 * sessions verify the relay instead of trusting blindly.
 */
export async function learnedRelayPeers(store: BamStore): Promise<string[]> {
  const ids = await store.repo.connectedSubductionPeerIds();
  return ids.filter((id) => id !== store.peerId);
}
