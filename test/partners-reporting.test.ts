/** Partner fulfillment sync, waitlist/impact reporting, and the new
 * outreach behaviors (email channel, RTL-safe templates, rebooking filter,
 * paced-type exclusion). */

import { describe, expect, it } from "vitest";
import { partnerSyncByPhone, setPartnerOrg } from "../src/domain/partners.ts";
import { impactReport, waitlistReport } from "../src/domain/reporting.ts";
import {
  buildOutreachList,
  queueBlast,
  renderTemplate,
} from "../src/domain/outreach.ts";
import { fulfilledCountKey, newId, nowIso } from "../src/schema.ts";
import { daysAgo, freshStore, makeHousehold, makeRequest, TODAY, FIXED_NOW } from "./helpers.ts";

const SPANISH = "Español / Spanish / 西班牙语";

function makeServiceRequest(
  handle: Awaited<ReturnType<typeof freshStore>>["base"],
  householdId: string,
  overrides: Record<string, unknown> = {}
) {
  const id = newId();
  const now = nowIso();
  handle.change((d) => {
    d.socialServiceRequests[id] = {
      id,
      type: "english_classes",
      householdId,
      status: "Open",
      internetAccess: [],
      roofAccessible: false,
      requestOpenedAt: now,
      statusLastUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as never;
  });
  return handle.doc().socialServiceRequests[id]!;
}

describe("partnerSyncByPhone", () => {
  it("matches formatted phones, closes rows, attributes partner, stamps cooldowns", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { phoneNumber: "+17185551234" });
    const goods = makeRequest(store.base, h.id, { type: "soap" });
    const svc = makeServiceRequest(store.base, h.id);

    const report = partnerSyncByPhone(store.base, {
      partner: "MMeC",
      phones: ["(718) 555-1234", "718-555-0000"],
      outcome: "Delivered",
    }, FIXED_NOW);

    expect(report.matchedHouseholdIds).toEqual([h.id]);
    expect(report.closedRequestIds).toEqual([goods.id]);
    expect(report.closedSocialServiceRequestIds).toEqual([svc.id]);
    expect(report.unmatchedPhones).toEqual(["718-555-0000"]);

    const doc = store.base.doc();
    expect(doc.requests[goods.id]!.status).toBe("Delivered");
    expect(doc.requests[goods.id]!.notes).toContain("[MMeC sync");
    expect(doc.socialServiceRequests[svc.id]!.partnerOrg).toBe("MMeC");
    expect(doc.households[h.id]!.lastDeliveredByType?.["soap"]).toBe(TODAY);
    expect(doc.fulfilledCounts[fulfilledCountKey(TODAY, "soap")]).toBe(1);
  });

  it("dry run computes the same report with zero mutations", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    const goods = makeRequest(store.base, h.id);
    const report = partnerSyncByPhone(store.base, {
      partner: "MMeC",
      phones: [h.phoneNumber!],
      outcome: "Delivered",
      dryRun: true,
    });
    expect(report.closedRequestIds).toEqual([goods.id]);
    expect(store.base.doc().requests[goods.id]!.status).toBe("Open");
    expect(Object.keys(store.base.doc().fulfilledCounts)).toHaveLength(0);
  });

  it("respects scope + type filters and supports Timeout", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    const soap = makeRequest(store.base, h.id, { type: "soap" });
    const pots = makeRequest(store.base, h.id, { type: "pots_and_pans" });
    const svc = makeServiceRequest(store.base, h.id);

    const report = partnerSyncByPhone(store.base, {
      partner: "Big Reuse",
      phones: [h.phoneNumber!],
      outcome: "Timeout",
      types: ["soap"],
      includeServices: false,
    });
    expect(report.closedRequestIds).toEqual([soap.id]);
    expect(report.closedSocialServiceRequestIds).toEqual([]);
    const doc = store.base.doc();
    expect(doc.requests[soap.id]!.status).toBe("Timeout");
    expect(doc.requests[pots.id]!.status).toBe("Open");
    expect(doc.socialServiceRequests[svc.id]!.status).toBe("Open");
    // Timeout must not stamp a delivery.
    expect(doc.households[h.id]!.lastDeliveredByType?.["soap"]).toBeUndefined();
  });

  it("setPartnerOrg sets and clears attribution", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    const svc = makeServiceRequest(store.base, h.id);
    setPartnerOrg(store.base, svc.id, "MESH");
    expect(store.base.doc().socialServiceRequests[svc.id]!.partnerOrg).toBe("MESH");
    setPartnerOrg(store.base, svc.id, null);
    expect(store.base.doc().socialServiceRequests[svc.id]!.partnerOrg).toBeUndefined();
  });
});

describe("waitlistReport", () => {
  it("buckets by age and language, counts paced + unsupported", async () => {
    const store = await freshStore();
    const spanish = makeHousehold(store.base, {
      languages: [SPANISH],
      preferredLanguage: SPANISH,
    });
    const quechua = makeHousehold(store.base, { languages: ["Quechua"] });
    makeRequest(store.base, spanish.id, { type: "soap", requestOpenedAt: daysAgo(5) });
    makeRequest(store.base, spanish.id, {
      type: "soap",
      requestOpenedAt: daysAgo(200),
      pacedUntil: "2026-08-01",
    });
    makeRequest(store.base, quechua.id, { type: "soap", requestOpenedAt: daysAgo(45) });

    const [row] = waitlistReport(store.base.doc(), TODAY);
    expect(row!.type).toBe("soap");
    expect(row!.open).toBe(3);
    expect(row!.paced).toBe(1);
    expect(row!.age).toEqual({ d30: 1, d90: 1, d180: 0, older: 1 });
    expect(row!.byLanguage[SPANISH]).toBe(2);
    expect(row!.byLanguage["Quechua"]).toBe(1);
    expect(row!.unsupportedLanguage).toBe(1);
    expect(row!.oldestOpenAt).toBe(daysAgo(200));
  });
});

describe("impactReport", () => {
  it("sums fulfilledCounts within an inclusive range", async () => {
    const store = await freshStore();
    store.base.change((d) => {
      d.fulfilledCounts[fulfilledCountKey("2026-06-01", "soap")] = 3;
      d.fulfilledCounts[fulfilledCountKey("2026-06-15", "soap")] = 2;
      d.fulfilledCounts[fulfilledCountKey("2026-07-01", "plates")] = 5;
    });
    const june = impactReport(store.base.doc(), { start: "2026-06-01", end: "2026-06-30" });
    expect(june.delivered).toEqual({ soap: 5 });
    expect(june.totalDelivered).toBe(5);
    const all = impactReport(store.base.doc(), {});
    expect(all.totalDelivered).toBe(10);
  });
});

describe("outreach additions", () => {
  it("renderTemplate wraps substitutions in bidi isolates and keeps unknown placeholders", () => {
    const out = renderTemplate("مرحبا {name} — {url} — {nope}", {
      name: "Rosa",
      url: "https://x.test",
    });
    expect(out).toContain("⁨Rosa⁩");
    expect(out).toContain("⁨https://x.test⁩");
    expect(out).toContain("{nope}");
  });

  it("email channel selects email-only households and queueBlast stamps lastEmailed", async () => {
    const store = await freshStore();
    const emailOnly = makeHousehold(store.base, {
      phoneNumber: undefined,
      email: "familia@example.com",
    });
    const phoned = makeHousehold(store.base);
    makeRequest(store.base, emailOnly.id);
    makeRequest(store.base, phoned.id);

    const list = buildOutreachList(store.base.doc(), { channel: "email" });
    expect(list.map((c) => c.householdId)).toEqual([emailOnly.id]);

    const report = queueBlast(
      store.base,
      {
        householdIds: [emailOnly.id],
        template: "Hola {name}",
        channel: "email",
        subject: "BAM appointments",
      },
      FIXED_NOW,
      "test-peer"
    );
    expect(report.sent).toBe(1);
    const doc = store.base.doc();
    const msg = Object.values(doc.smsOutbox)[0]!;
    expect(msg.channel).toBe("email");
    expect(msg.to).toBe("familia@example.com");
    expect(doc.households[emailOnly.id]!.lastEmailed).toBe(TODAY);
  });

  it("excludes paced types and honors rebookingOnly", async () => {
    const store = await freshStore();
    const paced = makeHousehold(store.base);
    makeRequest(store.base, paced.id, { pacedUntil: "2099-01-01" });
    const rebook = makeHousehold(store.base, { needsRebooking: true, rebookFrom: TODAY });
    makeRequest(store.base, rebook.id);

    const all = buildOutreachList(store.base.doc(), {});
    expect(all.map((c) => c.householdId)).toEqual([rebook.id]); // paced-only household omitted

    const rebooking = buildOutreachList(store.base.doc(), { rebookingOnly: true });
    expect(rebooking).toHaveLength(1);
    expect(rebooking[0]!.needsRebooking).toBe(true);
  });

  it("flags unsupported-language households", async () => {
    const store = await freshStore();
    const q = makeHousehold(store.base, { languages: ["Quechua"] });
    makeRequest(store.base, q.id);
    const [c] = buildOutreachList(store.base.doc(), {});
    expect(c!.unsupportedLanguage).toBe(true);
  });
});
