/** Encrypted checkpoints: round-trip, wrong-passphrase rejection, restore. */

import { describe, expect, it } from "vitest";
import { MemorySigner } from "@automerge/automerge-subduction";
import { Repo } from "@automerge/automerge-repo";
import { createCheckpoint, decryptCheckpoint, importCheckpoint } from "../src/checkpoint.ts";
import type { BamDoc, RosterDoc } from "../src/schema.ts";
import { freshStore, makeHousehold, makeRequest } from "./helpers.ts";

describe("encrypted checkpoints", () => {
  it("round-trips the whole org and restores it into a fresh repo", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { name: "Ckpt Test" });
    makeRequest(store.base, h.id, { type: "soap" });

    const { bytes, header } = await createCheckpoint(store, "correct horse battery");
    expect(header.docs.map((d) => d.key)).toContain("roster");
    expect(header.docs.map((d) => d.key)).toContain("base");
    expect(header.docs.map((d) => d.key)).toContain("distros");
    // Ciphertext must not leak plaintext (name should not appear raw).
    const asText = new TextDecoder().decode(bytes);
    expect(asText).not.toContain("Ckpt Test");

    const { docs } = await decryptCheckpoint(bytes, "correct horse battery");
    const restorerPeer = "ab".repeat(32);
    const repo = new Repo({ signer: MemorySigner.generate() as never });
    const { rosterUrl } = importCheckpoint(repo, restorerPeer, docs, "laptop");

    const roster = await repo.find<RosterDoc>(rosterUrl as never);
    const rosterDoc = roster.doc()!;
    // Restorer enrolled as admin; pointers rewritten to the NEW doc urls.
    expect(rosterDoc.members[restorerPeer]?.role).toBe("admin");
    expect(rosterDoc.baseDocUrl).toBeTruthy();
    expect(rosterDoc.baseDocUrl).not.toBe(store.base.url);
    const base = await repo.find<BamDoc>(rosterDoc.baseDocUrl as never);
    const households = Object.values(base.doc()!.households);
    expect(households.some((x) => x.name === "Ckpt Test")).toBe(true);
    expect(rosterDoc.dataDomains?.["distros"]?.docUrl).not.toBe(store.distros!.url);
  });

  it("rejects a wrong passphrase and garbage files", async () => {
    const store = await freshStore();
    const { bytes } = await createCheckpoint(store, "right passphrase");
    await expect(decryptCheckpoint(bytes, "wrong passphrase")).rejects.toThrow(/passphrase/i);
    await expect(
      decryptCheckpoint(new TextEncoder().encode("not a checkpoint at all"), "x")
    ).rejects.toThrow(/isn't a checkpoint/i);
    await expect(createCheckpoint(store, "short")).rejects.toThrow(/8 characters/);
  });
});
