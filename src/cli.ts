/**
 * bam-lf — the local-first BAM command line.
 *
 * Run with: node --experimental-strip-types src/cli.ts <command> [flags]
 * (Node >= 22.13; `npm run cli -- <command>` also works.)
 *
 * Commands:
 *   identity                       create-or-show this device's Ed25519 identity
 *   org create --name <org>        bootstrap a new org (roster + base docs)
 *   org join --roster <url>        join an existing org by roster automerge: URL
 *   roster list                    show members
 *   roster add --peer <hex> --name <n> [--role admin|volunteer]
 *   roster revoke --peer <hex>
 *   import --snapshot <dir>        import an Airtable snapshot (PII stays local)
 *   stats                          open request counts + roster summary
 *   outbox [--unsent]              list queued SMS messages
 *   outbox drain --mark-sent       gateway loop step: print unsent + stamp sentAt
 *   jobs expire                    daily cron: time out stale open requests
 *   jobs scrub-pii                 daily cron: scrub expired PII
 *   jobs website-data [--out f]    hourly cron: open request counts as JSON
 *   sync [--endpoint <wss://…>]    connect to a Subduction relay and stay up
 *
 * Relay trust: pass --relay-peer <hex> when you know the relay's key, or
 * --trust-relay to learn it on the first connect and pin it in state.json
 * (needed for relays whose key isn't published, e.g. the Ink & Switch
 * experiment relay at wss://sync.subduction.inkandswitch.com — the default
 * endpoint; not yet publicly resolvable as of 2026-07-06).
 *
 * `jobs` and `outbox drain` connect using the endpoint/relay saved by
 * `org join`/`sync` (if any) and linger briefly so mutations replicate —
 * these are the cron automations, run on a dedicated enrolled device.
 *
 * Common flags: --data-dir <dir>   identity + storage + state (default ./.bam-lf)
 *
 * State layout: <data-dir>/identity.key (32 secret bytes, 0600),
 * <data-dir>/state.json ({rosterUrl}), <data-dir>/storage/ (automerge-repo).
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MemorySigner } from "@automerge/automerge-subduction";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { DEFAULT_SYNC_ENDPOINT, learnedRelayPeers, openStore } from "./store.ts";
import type { BamStore } from "./store.ts";
import {
  addMember,
  buildInviteUrl,
  createInvite,
  parseInviteUrl,
  revokeInvite,
  revokeMember,
  type InvitePayload,
} from "./roster.ts";
import type { Role } from "./schema.ts";
import { importSnapshot } from "./import.ts";
import { openRequestCounts } from "./domain/metrics.ts";
import { listOutbox, markOutboxSent } from "./domain/outreach.ts";
import { expireStale, scrubExpiredPii } from "./domain/lifecycle.ts";

interface Flags {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

async function loadSigner(dataDir: string): Promise<MemorySigner> {
  const keyPath = join(dataDir, "identity.key");
  if (existsSync(keyPath)) {
    const bytes = new Uint8Array(await readFile(keyPath));
    return MemorySigner.fromBytes(bytes);
  }
  // MemorySigner cannot export its secret, so we mint the 32 secret bytes
  // ourselves, persist them (0600), and always construct via fromBytes.
  await mkdir(dataDir, { recursive: true });
  const secret = crypto.getRandomValues(new Uint8Array(32));
  await writeFile(keyPath, secret);
  await chmod(keyPath, 0o600);
  return MemorySigner.fromBytes(secret);
}

interface CliState {
  rosterUrl?: string;
  endpoint?: string;
  /** The relay's peer id — each device's deny-by-default policy must
   * explicitly trust the relay key or the client never connects. */
  relayPeer?: string;
}

async function loadState(dataDir: string): Promise<CliState> {
  try {
    return JSON.parse(await readFile(join(dataDir, "state.json"), "utf-8")) as CliState;
  } catch {
    return {};
  }
}

async function saveState(dataDir: string, state: CliState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

async function open(
  dataDir: string,
  endpoints: string[] = [],
  trustDialedRelays = false
): Promise<BamStore> {
  const signer = await loadSigner(dataDir);
  const state = await loadState(dataDir);
  if (!state.rosterUrl) {
    throw new Error(`no org in ${dataDir} — run \`org create\` or \`org join\` first`);
  }
  const storage = new NodeFSStorageAdapter(join(dataDir, "storage"));
  return openStore({
    signer,
    storage,
    endpoints,
    rosterUrl: state.rosterUrl,
    alwaysAllow: state.relayPeer ? [state.relayPeer] : [],
    trustDialedRelays,
  });
}

function print(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/** Open using the endpoint/relay saved by `org join`/`sync` (offline if none). */
async function openWithSavedNetwork(dataDir: string): Promise<BamStore> {
  const state = await loadState(dataDir);
  return open(dataDir, state.endpoint ? [state.endpoint] : []);
}

/** Give a networked store a beat to pull/push before reading or exiting. */
async function settle(store: BamStore, ms = 3000): Promise<void> {
  if (!store.repo.isSubductionConnected()) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (store.repo.isSubductionConnected()) {
    await new Promise((r) => setTimeout(r, ms));
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const dataDir = str(flags, "data-dir") ?? "./.bam-lf";
  const [command, subcommand] = positional;

  switch (command) {
    case "identity": {
      const signer = await loadSigner(dataDir);
      print({ peerId: signer.peerId().toString(), dataDir });
      return;
    }

    case "org": {
      const signer = await loadSigner(dataDir);
      const storage = new NodeFSStorageAdapter(join(dataDir, "storage"));
      if (subcommand === "create") {
        const name = str(flags, "name") ?? "BAM";
        const store = await openStore({
          signer,
          storage,
          endpoints: [],
          createOrg: name,
          deviceName: str(flags, "device-name") ?? "founding device",
        });
        await saveState(dataDir, { rosterUrl: store.roster.url });
        print({
          org: name,
          rosterUrl: store.roster.url,
          baseDocUrl: store.base.url,
          peerId: store.peerId,
        });
        // Give storage a beat to flush before exit.
        await new Promise((r) => setTimeout(r, 300));
        return;
      }
      if (subcommand === "join") {
        // QR onboarding: --invite <url|payload> carries everything —
        // roster URL, endpoint, relay peer, and the pre-authorization.
        const inviteArg = str(flags, "invite");
        const payload = inviteArg ? parseInviteUrl(inviteArg) : null;
        if (inviteArg && !payload) throw new Error("could not parse the invite URL/payload");
        const rosterUrl = payload?.rosterUrl ?? str(flags, "roster");
        if (!rosterUrl) throw new Error("org join requires --roster <automerge:url> or --invite <url>");
        const endpoint = str(flags, "endpoint") ?? payload?.endpoint ?? DEFAULT_SYNC_ENDPOINT;
        let relayPeer = str(flags, "relay-peer") ?? payload?.relayPeer;
        const trustRelay = !!flags["trust-relay"] || (!!payload && !relayPeer);
        if (!relayPeer && !trustRelay) {
          throw new Error(
            "org join needs --relay-peer <hex>, or --trust-relay to learn+pin the relay's key on first use"
          );
        }
        // Joining needs the network: the roster/base docs live elsewhere.
        const store = await openStore({
          signer,
          storage,
          endpoints: [endpoint],
          rosterUrl,
          alwaysAllow: relayPeer ? [relayPeer] : [],
          trustDialedRelays: trustRelay && !relayPeer,
          invite: payload
            ? {
                inviteId: payload.inviteId,
                secret: payload.secret,
                deviceName: str(flags, "device-name") ?? "QR-invited device",
              }
            : undefined,
        });
        if (!relayPeer && trustRelay) {
          // TOFU: pin the learned relay key for all future (verified) runs.
          const learned = await learnedRelayPeers(store);
          relayPeer = learned[0];
          console.error(`trust-on-first-use: pinned relay peer ${relayPeer ?? "(none learned)"}`);
        }
        await saveState(dataDir, { rosterUrl, endpoint, relayPeer });
        print({ joined: store.roster.doc()?.org, rosterUrl, peerId: store.peerId, relayPeer });
        // Linger so a QR self-enrollment replicates before exit.
        await settle(store);
        process.exit(0);
      }
      throw new Error("usage: org create --name <org> | org join --roster <url>");
    }

    case "roster": {
      // Mutating subcommands open with the saved network and linger, so
      // membership/invite changes replicate to the relay immediately (a
      // separately-running `sync` daemon has its own in-memory state and
      // will NOT pick up this process's writes until its next restart —
      // CRDT merges make the concurrent writes safe).
      const mutating = ["add", "revoke", "invite", "revoke-invite"].includes(subcommand ?? "");
      const store = mutating ? await openWithSavedNetwork(dataDir) : await open(dataDir);
      if (mutating) await settle(store);
      if (subcommand === "list" || subcommand === undefined) {
        const roster = store.roster.doc();
        print({
          org: roster?.org,
          rosterUrl: store.roster.url,
          members: Object.values(roster?.members ?? {}).map((m) => ({
            peerId: m.peerId,
            name: m.name,
            role: m.role,
            revoked: !!m.revokedAt,
          })),
        });
        return;
      }
      if (subcommand === "add") {
        const peer = str(flags, "peer");
        const name = str(flags, "name");
        if (!peer || !name) throw new Error("roster add requires --peer <hex> --name <name>");
        const role = (str(flags, "role") ?? "volunteer") as Role;
        addMember(store.roster, store.peerId, { peerId: peer, name, role });
        print({ added: peer, role });
        await settle(store);
        process.exit(0);
      }
      if (subcommand === "revoke") {
        const peer = str(flags, "peer");
        if (!peer) throw new Error("roster revoke requires --peer <hex>");
        revokeMember(store.roster, store.peerId, peer);
        print({ revoked: peer });
        await settle(store);
        process.exit(0);
      }
      if (subcommand === "invite") {
        const name = str(flags, "name");
        if (!name) throw new Error('roster invite requires --name "July distro volunteers"');
        const state = await loadState(dataDir);
        const { invite, secret } = createInvite(store.roster, store.peerId, {
          name,
          expiresInDays: flags["expires-days"] ? Number(flags["expires-days"]) : undefined,
          maxUses: flags["max-uses"] ? Number(flags["max-uses"]) : undefined,
        });
        const payload: InvitePayload = {
          v: 1,
          org: store.roster.doc()?.org,
          rosterUrl: store.roster.url,
          endpoint: str(flags, "endpoint") ?? state.endpoint ?? DEFAULT_SYNC_ENDPOINT,
          relayPeer: str(flags, "relay-peer") ?? state.relayPeer,
          inviteId: invite.id,
          secret,
        };
        const consoleUrl = str(flags, "console-url") ?? "https://ronturetzky.github.io/bam-local-first-demo/";
        const url = buildInviteUrl(consoleUrl, payload);
        const qrcode = await import("qrcode");
        console.error(await qrcode.toString(url, { type: "terminal", small: true }));
        print({
          invite: { id: invite.id, name: invite.name, expiresAt: invite.expiresAt, maxUses: invite.maxUses },
          url,
          note: "The URL/QR is a bearer credential — anyone who scans it joins as a volunteer until it expires or is revoked (roster revoke-invite).",
        });
        await settle(store);
        process.exit(0);
      }
      if (subcommand === "revoke-invite") {
        const inviteId = str(flags, "invite");
        if (!inviteId) throw new Error("roster revoke-invite requires --invite <id>");
        revokeInvite(store.roster, store.peerId, inviteId);
        print({ revokedInvite: inviteId });
        await settle(store);
        process.exit(0);
      }
      throw new Error(
        "usage: roster list | add --peer … --name … [--role …] | revoke --peer … | " +
          'invite --name "…" [--expires-days N --max-uses N --console-url URL] | revoke-invite --invite <id>'
      );
    }

    case "import": {
      const snapshotDir = str(flags, "snapshot");
      if (!snapshotDir) throw new Error("import requires --snapshot <dir>");
      const store = await open(dataDir);
      const report = await importSnapshot(store.base, snapshotDir);
      print(report);
      await new Promise((r) => setTimeout(r, 500));
      return;
    }

    case "stats": {
      const store = await open(dataDir);
      const doc = store.base.doc();
      const counts = openRequestCounts(doc);
      print({
        org: doc.meta.org,
        households: Object.keys(doc.households).length,
        requests: Object.keys(doc.requests).length,
        socialServiceRequests: Object.keys(doc.socialServiceRequests).length,
        distros: Object.keys(doc.distros).length,
        outboxUnsent: listOutbox(doc, { unsentOnly: true }).length,
        rosterMembers: Object.keys(store.roster.doc()?.members ?? {}).length,
        topOpen: counts.counts.slice(0, 5),
      });
      return;
    }

    case "outbox": {
      if (subcommand === "drain") {
        // Gateway step: connect, print every unsent message, and (with
        // --mark-sent) stamp them. A real SMS gateway wraps this: send via
        // its provider between listing and stamping.
        const store = await openWithSavedNetwork(dataDir);
        await settle(store);
        const rows = listOutbox(store.base.doc(), { unsentOnly: true });
        for (const m of rows) {
          console.log(JSON.stringify({ id: m.id, to: m.to, body: m.body }));
          if (flags["mark-sent"]) markOutboxSent(store.base, m.id);
        }
        console.error(`${rows.length} unsent${flags["mark-sent"] ? ", marked sent" : ""}`);
        await settle(store);
        process.exit(0);
      }
      const store = await open(dataDir);
      const rows = listOutbox(store.base.doc(), { unsentOnly: !!flags["unsent"] });
      print(rows.map((m) => ({ id: m.id, to: m.to, queuedAt: m.queuedAt, sentAt: m.sentAt })));
      return;
    }

    case "jobs": {
      const store = await openWithSavedNetwork(dataDir);
      await settle(store);
      if (subcommand === "expire") {
        const report = expireStale(store.base);
        print({
          timedOutRequests: report.timedOutRequestIds.length,
          timedOutSocialServiceRequests: report.timedOutSocialServiceRequestIds.length,
        });
      } else if (subcommand === "scrub-pii") {
        const report = await scrubExpiredPii(store.base);
        print(report);
      } else if (subcommand === "website-data") {
        const counts = openRequestCounts(store.base.doc());
        const out = str(flags, "out");
        if (out) {
          await writeFile(out, JSON.stringify(counts, null, 2) + "\n");
          print({ wrote: out, types: counts.counts.length });
        } else {
          print(counts);
        }
      } else {
        throw new Error("usage: jobs expire | scrub-pii | website-data [--out file]");
      }
      // Linger so the mutation replicates to the relay before exit.
      await settle(store);
      process.exit(0);
    }

    case "sync": {
      const state = await loadState(dataDir);
      const endpoint = str(flags, "endpoint") ?? state.endpoint ?? DEFAULT_SYNC_ENDPOINT;
      const relayPeer = str(flags, "relay-peer") ?? state.relayPeer;
      const trustRelay = !!flags["trust-relay"] && !relayPeer;
      if (relayPeer && relayPeer !== state.relayPeer) {
        await saveState(dataDir, { ...state, endpoint, relayPeer });
      }
      const store = await open(dataDir, [endpoint], trustRelay);
      console.log(`syncing via ${endpoint} as ${store.peerId}`);
      if (trustRelay) {
        console.log("trust-on-first-use: will pin the relay's key once connected");
      }
      console.log("Ctrl-C to stop.");
      let pinned = !trustRelay;
      const status = async (): Promise<void> => {
        console.log(
          `[${new Date().toISOString()}] connected=${store.repo.isSubductionConnected()}`
        );
        if (!pinned && store.repo.isSubductionConnected()) {
          const learned = await learnedRelayPeers(store);
          if (learned.length) {
            pinned = true;
            await saveState(dataDir, { ...state, endpoint, relayPeer: learned[0] });
            console.log(
              `pinned relay peer ${learned[0]} — future runs verify it (state.json)`
            );
          }
        }
      };
      setTimeout(() => void status(), 3000);
      setInterval(() => void status(), 30000);
      await new Promise(() => {}); // run until interrupted
      return;
    }

    default:
      console.error(
        "usage: bam-lf <identity|org|roster|import|stats|outbox|sync> [flags]\n" +
          "  (see the header of src/cli.ts for details)"
      );
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
