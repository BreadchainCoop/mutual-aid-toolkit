import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import type { DocHandle } from "@automerge/automerge-repo";
import { partnerSyncByPhone, setPartnerOrg } from "../src/domain/partners.ts";
import type { BamDoc, SocialServiceRequestRow } from "../src/schema.ts";
import { fulfilledCountKey, newId } from "../src/schema.ts";
import { FIXED_NOW, TODAY, freshStore, makeHousehold, makeRequest } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

function makeSocialRequest(
  handle: DocHandle<BamDoc>,
  householdId: string,
  overrides: Partial<SocialServiceRequestRow> = {}
): SocialServiceRequestRow {
  const id = newId();
  const row: SocialServiceRequestRow = {
    id,
    type: "tenant_legal",
    householdId,
    status: "Open",
    internetAccess: [],
    roofAccessible: false,
    requestOpenedAt: FIXED_NOW,
    statusLastUpdatedAt: FIXED_NOW,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
  handle.change((d) => {
    d.socialServiceRequests[id] = row;
  });
  return handle.doc().socialServiceRequests[id]!;
}

describe("partner sync by phone", () => {
  it("matches normalized phones, falls back to last 10 digits, reports unmatched", async () => {
    const store = await freshStore();
    const exact = makeHousehold(store.base, { phoneNumber: "+17185550400" });
    // A migrated row whose phone was never normalized to E.164.
    const legacy = makeHousehold(store.base, { phoneNumber: "17185550401" });
    const reqExact = makeRequest(store.base, exact.id, { type: "soap" });
    const reqLegacy = makeRequest(store.base, legacy.id, { type: "pads" });

    const report = partnerSyncByPhone(
      store.base,
      {
        partner: "North Brooklyn Angels",
        phones: ["(718) 555-0400", "+1 718 555 0401", "+19998887777"],
        outcome: "Delivered",
      },
      FIXED_NOW
    );

    expect(report.matchedHouseholdIds).toEqual([exact.id, legacy.id]);
    expect(report.unmatchedPhones).toEqual(["+19998887777"]);
    expect(report.closedRequestIds.sort()).toEqual([reqExact.id, reqLegacy.id].sort());
    expect(report.closedSocialServiceRequestIds).toEqual([]);
  });

  it("closes only the requested scopes and type keys; already-closed rows untouched", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { phoneNumber: "+17185550410" });
    const soap = makeRequest(store.base, h.id, { type: "soap" });
    const pads = makeRequest(store.base, h.id, { type: "pads" });
    const delivered = makeRequest(store.base, h.id, { type: "diapers", status: "Delivered" });
    const social = makeSocialRequest(store.base, h.id);

    const goodsOnly = partnerSyncByPhone(
      store.base,
      {
        partner: "P1",
        phones: ["+17185550410"],
        outcome: "Delivered",
        types: ["soap"],
        includeServices: false,
      },
      FIXED_NOW
    );
    expect(goodsOnly.closedRequestIds).toEqual([soap.id]);
    expect(goodsOnly.closedSocialServiceRequestIds).toEqual([]);
    let doc = store.base.doc();
    expect(doc.requests[soap.id]!.status).toBe("Delivered");
    expect(doc.requests[pads.id]!.status).toBe("Open");
    expect(doc.requests[delivered.id]!.notes).toBeUndefined(); // never re-closed
    expect(doc.socialServiceRequests[social.id]!.status).toBe("Open");

    const servicesOnly = partnerSyncByPhone(
      store.base,
      { partner: "P1", phones: ["+17185550410"], outcome: "Delivered", includeGoods: false },
      FIXED_NOW
    );
    expect(servicesOnly.closedRequestIds).toEqual([]);
    expect(servicesOnly.closedSocialServiceRequestIds).toEqual([social.id]);
    doc = store.base.doc();
    expect(doc.requests[pads.id]!.status).toBe("Open"); // goods scope was off
    expect(doc.socialServiceRequests[social.id]!.status).toBe("Delivered");
  });

  it("Delivered mirrors check-in: stamps, notes line, partnerOrg, counts, cooldown date", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { phoneNumber: "+17185550420" });
    const soap = makeRequest(store.base, h.id, { type: "soap", notes: "left at door ok" });
    const social = makeSocialRequest(store.base, h.id);

    partnerSyncByPhone(
      store.base,
      { partner: "North Brooklyn Angels", phones: ["+17185550420"], outcome: "Delivered" },
      FIXED_NOW
    );

    const doc = store.base.doc();
    const closedSoap = doc.requests[soap.id]!;
    expect(closedSoap.status).toBe("Delivered");
    expect(closedSoap.statusLastUpdatedAt).toBe(FIXED_NOW);
    expect(closedSoap.processingDate).toBe("2026-07-15"); // +14 from the local date
    expect(closedSoap.notes).toBe(
      `left at door ok\n[North Brooklyn Angels sync ${TODAY}: Delivered]`
    );

    const closedSocial = doc.socialServiceRequests[social.id]!;
    expect(closedSocial.status).toBe("Delivered");
    expect(closedSocial.partnerOrg).toBe("North Brooklyn Angels");
    expect(closedSocial.notes).toBe(`[North Brooklyn Angels sync ${TODAY}: Delivered]`);

    expect(doc.fulfilledCounts[fulfilledCountKey(TODAY, "soap")]).toBe(1);
    expect(doc.fulfilledCounts[fulfilledCountKey(TODAY, "tenant_legal")]).toBe(1);
    expect(doc.households[h.id]!.lastDeliveredByType).toEqual({
      soap: TODAY,
      tenant_legal: TODAY,
    });
  });

  it("Timeout closes without feeding counts or cooldown stamps", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { phoneNumber: "+17185550430" });
    const soap = makeRequest(store.base, h.id, { type: "soap" });

    partnerSyncByPhone(
      store.base,
      { partner: "P2", phones: ["+17185550430"], outcome: "Timeout" },
      FIXED_NOW
    );

    const doc = store.base.doc();
    expect(doc.requests[soap.id]!.status).toBe("Timeout");
    expect(doc.requests[soap.id]!.processingDate).toBe("2026-07-15");
    expect(doc.requests[soap.id]!.notes).toBe(`[P2 sync ${TODAY}: Timeout]`);
    expect(Object.keys(doc.fulfilledCounts)).toHaveLength(0);
    expect(doc.households[h.id]!.lastDeliveredByType).toBeUndefined();
  });

  it("dry run computes the identical report with zero mutations", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { phoneNumber: "+17185550440" });
    const soap = makeRequest(store.base, h.id, { type: "soap" });
    const social = makeSocialRequest(store.base, h.id);
    const input = {
      partner: "P3",
      phones: ["718-555-0440", "+15550000000"],
      outcome: "Delivered" as const,
    };

    const dry = partnerSyncByPhone(store.base, { ...input, dryRun: true }, FIXED_NOW);
    const doc = store.base.doc();
    expect(doc.requests[soap.id]!.status).toBe("Open");
    expect(doc.socialServiceRequests[social.id]!.status).toBe("Open");
    expect(doc.socialServiceRequests[social.id]!.partnerOrg).toBeUndefined();
    expect(doc.requests[soap.id]!.notes).toBeUndefined();
    expect(Object.keys(doc.fulfilledCounts)).toHaveLength(0);
    expect(doc.households[h.id]!.lastDeliveredByType).toBeUndefined();

    const wet = partnerSyncByPhone(store.base, input, FIXED_NOW);
    expect(wet).toEqual(dry);
    expect(store.base.doc().requests[soap.id]!.status).toBe("Delivered");
  });
});

describe("setPartnerOrg", () => {
  it("sets and clears the partner attribution", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    const social = makeSocialRequest(store.base, h.id);

    setPartnerOrg(store.base, social.id, "Mesh Collective", FIXED_NOW);
    let row = store.base.doc().socialServiceRequests[social.id]!;
    expect(row.partnerOrg).toBe("Mesh Collective");
    expect(row.updatedAt).toBe(FIXED_NOW);

    setPartnerOrg(store.base, social.id, null, FIXED_NOW);
    row = store.base.doc().socialServiceRequests[social.id]!;
    expect(row.partnerOrg).toBeUndefined();

    expect(() => setPartnerOrg(store.base, "nope", "X", FIXED_NOW)).toThrow();
  });
});
