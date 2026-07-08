import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import { MemorySigner } from "@automerge/automerge-subduction";
import {
  addMember,
  revokeMember,
  reinstateMember,
  rosterPolicy,
  setRole,
  isAdmin,
  NotAuthorized,
} from "../src/roster.ts";
import { openStore } from "../src/store.ts";
import { freshStore } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

describe("roster rules", () => {
  it("bootstraps the founding device as admin", async () => {
    const store = await freshStore();
    const roster = store.roster.doc()!;
    expect(roster.members[store.peerId]!.role).toBe("admin");
  });

  it("admins add and revoke; volunteers cannot", async () => {
    const store = await freshStore();
    const volunteer = MemorySigner.generate().peerId().toString();
    const stranger = MemorySigner.generate().peerId().toString();

    addMember(store.roster, store.peerId, { peerId: volunteer, name: "Vol", role: "volunteer" });
    expect(store.roster.doc()!.members[volunteer]!.role).toBe("volunteer");

    expect(() =>
      addMember(store.roster, volunteer, { peerId: stranger, name: "X", role: "volunteer" })
    ).toThrow(NotAuthorized);
    expect(() => revokeMember(store.roster, volunteer, store.peerId)).toThrow(NotAuthorized);

    revokeMember(store.roster, store.peerId, volunteer);
    expect(store.roster.doc()!.members[volunteer]!.revokedAt).toBeDefined();
  });

  it("an admin cannot revoke itself (lockout guard)", async () => {
    const store = await freshStore();
    expect(() => revokeMember(store.roster, store.peerId, store.peerId)).toThrow(NotAuthorized);
  });

  it("promotes a volunteer to admin and demotes back", async () => {
    const store = await freshStore();
    const vol = MemorySigner.generate().peerId().toString();
    const admin2 = MemorySigner.generate().peerId().toString();
    addMember(store.roster, store.peerId, { peerId: vol, name: "Vol", role: "volunteer" });
    addMember(store.roster, store.peerId, { peerId: admin2, name: "Admin2", role: "admin" });

    setRole(store.roster, store.peerId, vol, "admin");
    expect(isAdmin(store.roster.doc()!, vol)).toBe(true);
    setRole(store.roster, store.peerId, vol, "volunteer");
    expect(isAdmin(store.roster.doc()!, vol)).toBe(false);
  });

  it("promotion clears the invite linkage so isAdmin passes", async () => {
    const store = await freshStore();
    const vol = MemorySigner.generate().peerId().toString();
    addMember(store.roster, store.peerId, { peerId: vol, name: "Vol", role: "volunteer" });
    // simulate an invite-enrolled member (has an inviteId/proof)
    store.roster.change((d) => {
      d.members[vol]!.inviteId = "inv1";
      d.members[vol]!.inviteProof = "secret";
    });
    setRole(store.roster, store.peerId, vol, "admin");
    const m = store.roster.doc()!.members[vol]!;
    expect(m.role).toBe("admin");
    expect(m.inviteId).toBeUndefined();
    expect(isAdmin(store.roster.doc()!, vol)).toBe(true);
  });

  it("refuses to demote the last admin", async () => {
    const store = await freshStore();
    expect(() => setRole(store.roster, store.peerId, store.peerId, "volunteer")).toThrow(NotAuthorized);
  });

  it("volunteers cannot change roles", async () => {
    const store = await freshStore();
    const vol = MemorySigner.generate().peerId().toString();
    addMember(store.roster, store.peerId, { peerId: vol, name: "Vol", role: "volunteer" });
    expect(() => setRole(store.roster, vol, store.peerId, "volunteer")).toThrow(NotAuthorized);
  });

  it("reinstates a revoked member", async () => {
    const store = await freshStore();
    const vol = MemorySigner.generate().peerId().toString();
    addMember(store.roster, store.peerId, { peerId: vol, name: "Vol", role: "volunteer" });
    revokeMember(store.roster, store.peerId, vol);
    expect(store.roster.doc()!.members[vol]!.revokedAt).toBeDefined();
    reinstateMember(store.roster, store.peerId, vol);
    expect(store.roster.doc()!.members[vol]!.revokedAt).toBeUndefined();
  });
});

describe("subduction policy (deny by default)", () => {
  it("allows active members, denies strangers and revoked members", async () => {
    const store = await freshStore();
    const volunteer = MemorySigner.generate().peerId().toString();
    const stranger = MemorySigner.generate().peerId().toString();
    addMember(store.roster, store.peerId, { peerId: volunteer, name: "Vol", role: "volunteer" });

    const policy = rosterPolicy(() => store.roster.doc());

    await expect(policy.authorizeConnect(volunteer)).resolves.toBeUndefined();
    await expect(policy.authorizeFetch(volunteer, "tree")).resolves.toBeUndefined();
    await expect(policy.authorizePut(volunteer, stranger, "tree")).resolves.toBeUndefined();

    await expect(policy.authorizeConnect(stranger)).rejects.toThrow(NotAuthorized);
    await expect(policy.authorizeFetch(stranger, "tree")).rejects.toThrow(NotAuthorized);
    expect(await policy.filterAuthorizedFetch(stranger, ["a", "b"])).toEqual([]);
    expect(await policy.filterAuthorizedFetch(volunteer, ["a", "b"])).toEqual(["a", "b"]);

    // Revocation takes effect immediately — the policy reads the live doc.
    revokeMember(store.roster, store.peerId, volunteer);
    await expect(policy.authorizeConnect(volunteer)).rejects.toThrow(NotAuthorized);
  });

  it("alwaysAllow admits the relay/self even off-roster", async () => {
    const store = await freshStore();
    const relay = MemorySigner.generate().peerId().toString();
    const policy = rosterPolicy(() => store.roster.doc(), { alwaysAllow: [relay] });
    await expect(policy.authorizeConnect(relay)).resolves.toBeUndefined();
  });
});

describe("store bootstrap", () => {
  it("openStore(createOrg) links the base doc from the roster", async () => {
    const signer = MemorySigner.generate();
    const store = await openStore({ signer, endpoints: [], createOrg: "Org X" });
    expect(store.roster.doc()!.baseDocUrl).toBe(store.base.url);
    expect(store.base.doc()!.meta.org).toBe("Org X");
  });
});
