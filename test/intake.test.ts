import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import { submitIntake } from "../src/domain/intake.ts";
import { hashPhone } from "../src/domain/validation.ts";
import { FIXED_NOW, freshStore } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

describe("intake (spec 6.1)", () => {
  it("creates a household with flags and one Open request per type", async () => {
    const store = await freshStore();
    const res = await submitIntake(store.base, {
      phoneNumber: "(718) 555-0142",
      name: "Ana Lopez",
      email: "ana@example.com",
      languages: ["Español / Spanish / 西班牙语"],
      requestTypes: ["soap", "Ollas y Sartenes / Pots & Pans / 鍋碗瓢盆"],
      socialServiceRequests: ["housing"],
    }, FIXED_NOW);

    expect(res.createdHousehold).toBe(true);
    expect(res.phoneValid).toBe(true);
    expect(res.createdRequestIds).toHaveLength(2);
    expect(res.createdSocialServiceRequestIds).toHaveLength(1);
    expect(res.unknownTypes).toEqual([]);

    const doc = store.base.doc();
    const h = doc.households[res.householdId]!;
    expect(h.phoneNumber).toBe("+17185550142");
    expect(h.phoneHash).toBe(await hashPhone("+17185550142"));
    expect(h.invalidPhoneNumber).toBe(false);
    const types = res.createdRequestIds.map((id) => doc.requests[id]!.type).sort();
    expect(types).toEqual(["pots_pans", "soap"]);
    for (const id of res.createdRequestIds) {
      expect(doc.requests[id]!.status).toBe("Open");
      expect(doc.requests[id]!.processingDate).toBeUndefined();
    }
  });

  it("dedups by phone across formatted variants and merges languages", async () => {
    const store = await freshStore();
    const first = await submitIntake(store.base, {
      phoneNumber: "+17185550143",
      languages: ["Inglés / English / 英文"],
      requestTypes: ["soap"],
    }, FIXED_NOW);
    const second = await submitIntake(store.base, {
      phoneNumber: "(718) 555-0143",
      languages: ["Español / Spanish / 西班牙语"],
      requestTypes: ["soap", "pads"],
    }, FIXED_NOW);

    expect(second.createdHousehold).toBe(false);
    expect(second.householdId).toBe(first.householdId);
    expect(second.skippedDuplicateTypes).toContain("soap");
    expect(second.createdRequestIds).toHaveLength(1); // pads only

    const h = store.base.doc().households[first.householdId]!;
    expect(h.languages).toEqual([
      "Inglés / English / 英文",
      "Español / Spanish / 西班牙语",
    ]);
    expect(Object.keys(store.base.doc().households)).toHaveLength(1);
  });

  it("reports unknown and cross-category types instead of misfiling", async () => {
    const store = await freshStore();
    const res = await submitIntake(store.base, {
      phoneNumber: "+17185550144",
      requestTypes: ["helicopter", "housing"], // housing is a social type
    }, FIXED_NOW);

    expect(res.createdRequestIds).toEqual([]);
    expect(res.unknownTypes).toEqual(expect.arrayContaining(["helicopter", "housing"]));
    expect(Object.keys(store.base.doc().requests)).toHaveLength(0);
  });

  it("furniture requests carry the delivery address", async () => {
    const store = await freshStore();
    const res = await submitIntake(store.base, {
      phoneNumber: "+17185550145",
      furnitureItems: ["Sofa"],
      streetAddress: "123 Knickerbocker Ave",
      cityState: "Brooklyn, NY",
      zipCode: "11221",
    }, FIXED_NOW);

    const doc = store.base.doc();
    const sofa = doc.requests[res.createdRequestIds[0]!]!;
    expect(sofa.type).toBe("sofa");
    expect(sofa.streetAddress).toBe("123 Knickerbocker Ave");
  });

  it("invalid phones dedup by raw-string hash", async () => {
    const store = await freshStore();
    const first = await submitIntake(store.base, {
      phoneNumber: "not a phone",
      requestTypes: ["soap"],
    }, FIXED_NOW);
    const second = await submitIntake(store.base, {
      phoneNumber: "not a phone",
      requestTypes: ["pads"],
    }, FIXED_NOW);

    expect(first.phoneValid).toBe(false);
    expect(second.createdHousehold).toBe(false);
    expect(second.householdId).toBe(first.householdId);
    const h = store.base.doc().households[first.householdId]!;
    expect(h.phoneNumber).toBeUndefined();
    expect(h.invalidPhoneNumber).toBe(true);
    expect(h.phoneHash).toBe(await hashPhone("not a phone"));
  });

  it("reconnects an anonymized household via phoneHash", async () => {
    const store = await freshStore();
    const first = await submitIntake(store.base, {
      phoneNumber: "+17185550146",
      name: "Rosa",
      requestTypes: ["soap"],
    }, FIXED_NOW);

    // Simulate the privacy scrub: PII gone, hash kept.
    store.base.change((d) => {
      const h = d.households[first.householdId]!;
      delete h.phoneNumber;
      delete h.name;
      h.anonymizedAt = FIXED_NOW;
    });

    const second = await submitIntake(store.base, {
      phoneNumber: "+17185550146",
      name: "Rosa",
      requestTypes: ["pads"],
    }, FIXED_NOW);

    expect(second.createdHousehold).toBe(false);
    expect(second.householdId).toBe(first.householdId);
    const h = store.base.doc().households[first.householdId]!;
    expect(h.phoneNumber).toBe("+17185550146");
    expect(h.anonymizedAt).toBeUndefined();
  });
});
