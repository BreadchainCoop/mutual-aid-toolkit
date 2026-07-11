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
import { emptyBamDoc, emptyDistrosDoc, emptyRosterDoc, nowIso } from "./schema.ts";
import type { BamDoc, DistrosDoc, OrgConfig, RosterDoc } from "./schema.ts";
import {
  addMember,
  domainAllowed,
  isActiveMember,
  isAdmin,
  redeemInvite,
  registerDataDomain,
  rosterPolicy,
} from "./roster.ts";

/** Matches the Signer interface of @automerge/automerge-subduction. */
export interface SignerLike {
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
  verifyingKey(): Uint8Array;
  peerId(): { toString(): string };
}

export const DEFAULT_SYNC_ENDPOINT = "wss://subduction.sync.inkandswitch.com";

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
  /**
   * The distros/shifts doc — the first grantable data domain. Undefined when
   * this device is DENIED the domain (the policy on other peers refuses to
   * serve it), or in a legacy org where no admin has booted since the split
   * (readers fall back to the legacy base.distros rows).
   */
  distros?: DocHandle<DistrosDoc>;
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
  let distros: DocHandle<DistrosDoc> | undefined;
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
    distros = await resolveDistrosDoc(repo, roster, base, peerId, now);
  } else {
    const org = opts.createOrg ?? "My Mutual Aid";
    roster = repo.create<RosterDoc>(emptyRosterDoc(org, now));
    box.roster = roster;
    const orgConfig: OrgConfig = { name: org, ...(opts.orgConfig ?? {}) };
    base = repo.create<BamDoc>(emptyBamDoc(org, now, orgConfig));
    distros = repo.create<DistrosDoc>(emptyDistrosDoc(org, now));
    roster.change((d) => {
      d.baseDocUrl = base.url;
    });
    // Register the first grantable domain, then bootstrap the admin (both
    // use the empty-roster bootstrap path; order keeps them consistent).
    registerDataDomain(roster, peerId, {
      key: "distros",
      name: "Distros & shifts",
      docUrl: distros.url,
    }, now);
    // Bootstrap: the creating device becomes the first admin.
    addMember(roster, peerId, {
      peerId,
      name: opts.deviceName ?? "founding device",
      role: "admin",
    }, now);
  }

  return { repo, peerId, roster, base, distros };
}

/**
 * Locate (or, for admins of pre-split orgs, create) the distros doc.
 *
 * - Domain registered + this device allowed → find it (short retry; the
 *   relay may not have it yet — treat as temporarily unavailable, not fatal).
 * - Domain registered + this device DENIED → don't even dial: other peers'
 *   policies would refuse, and the console shows a no-access state instead.
 * - No domain yet (org predates the split): an ADMIN device performs the
 *   one-time migration — create the doc, move legacy base.distros rows into
 *   it, register the domain. Non-admin devices keep reading the legacy rows.
 */
async function resolveDistrosDoc(
  repo: Repo,
  roster: DocHandle<RosterDoc>,
  base: DocHandle<BamDoc>,
  peerId: string,
  now: string
): Promise<DocHandle<DistrosDoc> | undefined> {
  const rosterDoc = roster.doc();
  const registered = rosterDoc?.dataDomains?.["distros"];
  if (registered) {
    if (!domainAllowed(rosterDoc, peerId, "distros")) return undefined;
    try {
      return await findWithRetry<DistrosDoc>(repo, registered.docUrl, {
        attempts: 4,
        delayMs: 1000,
      });
    } catch {
      return undefined; // offline/unsynced yet — console degrades gracefully
    }
  }
  if (!isAdmin(rosterDoc, peerId)) return undefined;
  const baseDoc = base.doc();
  const handle = repo.create<DistrosDoc>(
    emptyDistrosDoc(baseDoc?.meta.org ?? rosterDoc?.org ?? "", now)
  );
  const legacy = baseDoc?.distros ?? {};
  const legacyIds = Object.keys(legacy);
  if (legacyIds.length) {
    handle.change((d) => {
      for (const id of legacyIds) {
        d.distros[id] = JSON.parse(JSON.stringify(legacy[id]));
      }
    });
    base.change((d) => {
      for (const id of legacyIds) delete d.distros[id];
    });
  }
  registerDataDomain(roster, peerId, {
    key: "distros",
    name: "Distros & shifts",
    docUrl: handle.url,
  }, now);
  return handle;
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
