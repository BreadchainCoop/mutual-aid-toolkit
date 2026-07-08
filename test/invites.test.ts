import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import { MemorySigner } from "@automerge/automerge-subduction";
import {
  buildInviteUrl,
  createInvite,
  isActiveMember,
  isAdmin,
  parseInviteUrl,
  redeemInvite,
  revokeInvite,
  rosterPolicy,
  sha256Hex,
  NotAuthorized,
} from "../src/roster.ts";
import { freshStore } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

const NOW = "2026-07-01T12:00:00.000Z";
const LATER = "2026-07-05T12:00:00.000Z";
const AFTER_EXPIRY = "2026-08-01T12:00:00.000Z";

describe("sha256Hex", () => {
  it("matches known vectors", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("QR invites", () => {
  it("create → redeem enrolls a volunteer that the policy accepts", async () => {
    const store = await freshStore();
    const { invite, secret } = createInvite(
      store.roster, store.peerId, { name: "Distro" }, NOW
    );
    expect(store.roster.doc()!.invites![invite.id]!.tokenHash).toBe(sha256Hex(secret));

    const newDevice = MemorySigner.generate().peerId().toString();
    const member = redeemInvite(
      store.roster, newDevice,
      { inviteId: invite.id, secret, deviceName: "Rosa's phone" }, LATER
    );
    expect(member.role).toBe("volunteer");
    expect(isActiveMember(store.roster.doc(), newDevice)).toBe(true);

    const policy = rosterPolicy(() => store.roster.doc());
    await expect(policy.authorizeConnect(newDevice)).resolves.toBeUndefined();
  });

  it("rejects wrong secrets, expiry, revocation, and use caps", async () => {
    const store = await freshStore();
    const { invite, secret } = createInvite(
      store.roster, store.peerId, { name: "Tight", maxUses: 1 }, NOW
    );
    const d1 = MemorySigner.generate().peerId().toString();
    const d2 = MemorySigner.generate().peerId().toString();

    expect(() =>
      redeemInvite(store.roster, d1, { inviteId: invite.id, secret: "wrong", deviceName: "x" }, LATER)
    ).toThrow(NotAuthorized);
    expect(() =>
      redeemInvite(store.roster, d1, { inviteId: invite.id, secret, deviceName: "x" }, AFTER_EXPIRY)
    ).toThrow(/expired/);

    redeemInvite(store.roster, d1, { inviteId: invite.id, secret, deviceName: "one" }, LATER);
    expect(() =>
      redeemInvite(store.roster, d2, { inviteId: invite.id, secret, deviceName: "two" }, LATER)
    ).toThrow(/used up/);

    // Revocation stops future redemptions but keeps earlier members.
    const fresh = createInvite(store.roster, store.peerId, { name: "Rev" }, NOW);
    const d3 = MemorySigner.generate().peerId().toString();
    redeemInvite(store.roster, d3, { inviteId: fresh.invite.id, secret: fresh.secret, deviceName: "pre" }, LATER);
    revokeInvite(store.roster, store.peerId, fresh.invite.id, LATER);
    const d4 = MemorySigner.generate().peerId().toString();
    expect(() =>
      redeemInvite(store.roster, d4, { inviteId: fresh.invite.id, secret: fresh.secret, deviceName: "post" }, "2026-07-06T00:00:00.000Z")
    ).toThrow(/revoked/);
    expect(isActiveMember(store.roster.doc(), d3)).toBe(true);
  });

  it("a forged self-enrollment cannot claim admin or fake a proof", async () => {
    const store = await freshStore();
    const { invite, secret } = createInvite(store.roster, store.peerId, { name: "V" }, NOW);
    const attacker = MemorySigner.generate().peerId().toString();

    // Simulate a modified client writing its own entry with role=admin.
    store.roster.change((d) => {
      d.members[attacker] = {
        peerId: attacker,
        name: "Mallory",
        role: "admin",
        addedBy: `invite:${invite.id}`,
        addedAt: LATER,
        inviteId: invite.id,
        inviteProof: secret,
      };
    });
    // Compliant replicas reject it: role exceeds the invite's grant.
    expect(isActiveMember(store.roster.doc(), attacker)).toBe(false);
    expect(isAdmin(store.roster.doc(), attacker)).toBe(false);

    // And a made-up proof fails the hash check.
    const attacker2 = MemorySigner.generate().peerId().toString();
    store.roster.change((d) => {
      d.members[attacker2] = {
        peerId: attacker2,
        name: "Mallory2",
        role: "volunteer",
        addedBy: `invite:${invite.id}`,
        addedAt: LATER,
        inviteId: invite.id,
        inviteProof: "not-the-secret",
      };
    });
    expect(isActiveMember(store.roster.doc(), attacker2)).toBe(false);
    const policy = rosterPolicy(() => store.roster.doc());
    await expect(policy.authorizeConnect(attacker2)).rejects.toThrow(NotAuthorized);
  });

  it("invite URLs round-trip", () => {
    const payload = {
      v: 1 as const,
      org: "BAM ✊ 中文",
      rosterUrl: "automerge:abc123",
      endpoint: "wss://relay.example",
      inviteId: "inv1",
      secret: "s3cret",
    };
    const url = buildInviteUrl("https://host/app/", payload);
    expect(url.startsWith("https://host/app/#invite=")).toBe(true);
    expect(parseInviteUrl(url)).toEqual(payload);
    expect(parseInviteUrl("#invite=garbage!!")).toBeNull();
    expect(parseInviteUrl("nonsense")).toBeNull();
  });

  it("only admins can mint or revoke invites", async () => {
    const store = await freshStore();
    const outsider = MemorySigner.generate().peerId().toString();
    expect(() =>
      createInvite(store.roster, outsider, { name: "x" }, NOW)
    ).toThrow(NotAuthorized);
    const { invite } = createInvite(store.roster, store.peerId, { name: "ok" }, NOW);
    expect(() => revokeInvite(store.roster, outsider, invite.id, LATER)).toThrow(NotAuthorized);
  });
});
