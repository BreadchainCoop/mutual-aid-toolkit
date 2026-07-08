/**
 * End-to-end sync through a real Subduction relay.
 *
 * Gated on SUBDUCTION_RELAY (e.g. ws://127.0.0.1:8944) because it needs a
 * running server: build github.com/inkandswitch/subduction and run
 *   subduction_cli server --socket 127.0.0.1:8944 --data-dir /tmp/subduction-data \
 *     --ephemeral-key --auth open
 * then: SUBDUCTION_RELAY=ws://127.0.0.1:8944 npx vitest run test/sync.test.ts
 *
 * Why not an in-process transport pair? This build's MessageChannel bridge
 * (subductionAdapters) completes the connection handshake but registers no
 * sync peers (`syncWithAllPeers` sees 0 peers), so transport-level tests
 * would silently no-op — verified 2026-07-06 against 2.6.0-subduction.40.
 * The websocket relay path below is the real product path and does work.
 *
 * The roster policy itself (deny-by-default, revocation, filtering) is
 * covered transport-independently in roster.test.ts. Note the trust-model
 * fact verified alongside this test: an `--auth open` relay serves anyone
 * who knows a doc URL — client policies protect peer-served traffic, so
 * PII deployments must run their own relay (--auth keyhive) in a trusted
 * environment. See ../README.md.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Repo, initSubduction } from "@automerge/automerge-repo";
import { MemorySigner } from "@automerge/automerge-subduction";
import { rosterPolicy, addMember } from "../src/roster.ts";
import { openStore } from "../src/store.ts";
import type { RosterDoc } from "../src/schema.ts";

const RELAY = process.env.SUBDUCTION_RELAY;
// The relay is a peer like any other: each device's deny-by-default policy
// must explicitly trust the relay's key or the client never connects.
// The server prints "Peer ID" at startup.
const RELAY_PEER = process.env.SUBDUCTION_RELAY_PEER;
const relayAllow = RELAY_PEER ? [RELAY_PEER] : [];

beforeAll(async () => {
  await initSubduction();
});

describe.skipIf(!RELAY)("sync through a Subduction relay", () => {
  it("device B joins by roster URL and receives the org data", async () => {
    // Device A: create the org and some data, connected to the relay.
    const signerA = MemorySigner.generate();
    const a = await openStore({
      signer: signerA,
      endpoints: [RELAY!],
      alwaysAllow: relayAllow,
      createOrg: "BAM Sync Test",
      deviceName: "device A",
    });
    a.base.change((d) => {
      d.households["h-sync"] = {
        id: "h-sync",
        name: "Sync Household",
        invalidPhoneNumber: false,
        intlPhoneNumber: false,
        languages: [],
        missedAppointmentCount: 0,
        needsDelivery: false,
        needsEmailOutreach: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

    // Enroll device B on the roster before it connects.
    const signerB = MemorySigner.generate();
    addMember(a.roster, a.peerId, {
      peerId: signerB.peerId().toString(),
      name: "device B",
      role: "volunteer",
    });

    // Give the relay a moment to absorb A's commits.
    await new Promise((r) => setTimeout(r, 2000));

    // Device B: join with only the roster URL + relay endpoint.
    const b = await openStore({
      signer: signerB,
      endpoints: [RELAY!],
      alwaysAllow: relayAllow,
      rosterUrl: a.roster.url,
    });

    // B sees the roster (incl. itself) and the base data.
    expect(b.roster.doc()!.members[b.peerId]!.name).toBe("device B");
    const deadline = Date.now() + 15000;
    let name: string | undefined;
    while (Date.now() < deadline) {
      name = b.base.doc()?.households["h-sync"]?.name;
      if (name) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(name).toBe("Sync Household");
  }, 60000);

  it("a device's own policy refuses connects from off-roster peers", async () => {
    // Transport-independent assertion of what a compliant BAM device
    // enforces when peers dial it directly.
    const signer = MemorySigner.generate();
    const repo = new Repo({ signer: signer as never });
    const roster = repo.create<RosterDoc>({
      org: "X",
      createdAt: new Date().toISOString(),
      members: {},
    });
    addMember(roster, signer.peerId().toString(), {
      peerId: signer.peerId().toString(),
      name: "self",
      role: "admin",
    });
    const policy = rosterPolicy(() => roster.doc());
    const stranger = MemorySigner.generate().peerId().toString();
    await expect(policy.authorizeConnect(stranger)).rejects.toThrow();
    expect(await policy.filterAuthorizedFetch(stranger, ["x"])).toEqual([]);
  });
});
