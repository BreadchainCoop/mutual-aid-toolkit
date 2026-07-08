import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import { expireStale, scrubExpiredPii } from "../src/domain/lifecycle.ts";
import { submitIntake } from "../src/domain/intake.ts";
import { FIXED_NOW, TODAY, daysAgo, freshStore, makeHousehold, makeRequest } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

describe("auto-expiration (spec 2/4)", () => {
  it("times out by tier: soap 14d, pots_pans 30d", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    const staleSoap = makeRequest(store.base, h.id, { type: "soap", requestOpenedAt: daysAgo(15) });
    const freshSoap = makeRequest(store.base, h.id, { type: "pads", requestOpenedAt: daysAgo(13) });
    const stalePots = makeRequest(store.base, h.id, { type: "pots_pans", requestOpenedAt: daysAgo(31) });
    const freshPots = makeRequest(store.base, h.id, { type: "pots_pans", requestOpenedAt: daysAgo(15) });

    const report = expireStale(store.base, FIXED_NOW);
    const doc = store.base.doc();
    expect(report.timedOutRequestIds).toEqual(
      expect.arrayContaining([staleSoap.id, stalePots.id])
    );
    expect(doc.requests[freshSoap.id]!.status).toBe("Open");
    expect(doc.requests[freshPots.id]!.status).toBe("Open");
    expect(doc.requests[staleSoap.id]!.processingDate).toBe("2026-07-15"); // +14 local
  });

  it("a current booking exempts; a past-dated one does not", async () => {
    const store = await freshStore();
    const current = makeHousehold(store.base, {
      appointmentStatus: "Booked",
      appointmentDate: "2026-07-03",
    });
    const currentReq = makeRequest(store.base, current.id, { requestOpenedAt: daysAgo(20) });
    const dangling = makeHousehold(store.base, {
      appointmentStatus: "Booked",
      appointmentDate: "2026-06-01",
    });
    const danglingReq = makeRequest(store.base, dangling.id, { requestOpenedAt: daysAgo(20) });

    expireStale(store.base, FIXED_NOW);
    const doc = store.base.doc();
    expect(doc.requests[currentReq.id]!.status).toBe("Open");
    expect(doc.requests[danglingReq.id]!.status).toBe("Timeout");
  });
});

describe("privacy scrub", () => {
  it("scrubs closed rows past processing date and anonymizes inactive households, keeping the hash", async () => {
    const store = await freshStore();
    const res = await submitIntake(store.base, {
      phoneNumber: "+17185550300",
      name: "Rosa",
      requestTypes: ["sofa"],
      streetAddress: "123 Knickerbocker Ave",
    }, daysAgo(60));

    // Close the request long enough ago that its processing date passed.
    store.base.change((d) => {
      const req = d.requests[res.createdRequestIds[0]!]!;
      req.status = "Timeout";
      req.statusLastUpdatedAt = daysAgo(60);
      req.processingDate = "2026-05-20";
      d.households[res.householdId]!.updatedAt = daysAgo(45);
    });

    const report = await scrubExpiredPii(store.base, FIXED_NOW, 30);
    const doc = store.base.doc();
    const req = doc.requests[res.createdRequestIds[0]!]!;
    const h = doc.households[res.householdId]!;

    expect(req.streetAddress).toBeUndefined();
    expect(h.phoneNumber).toBeUndefined();
    expect(h.name).toBeUndefined();
    expect(h.phoneHash).toBeDefined();
    expect(h.anonymizedAt).toBe(FIXED_NOW);
    expect(report.householdsAnonymized).toBe(1);

    // Re-request from the same phone reconnects to the anonymized household.
    const again = await submitIntake(store.base, {
      phoneNumber: "+17185550300",
      name: "Rosa",
      requestTypes: ["soap"],
    }, FIXED_NOW);
    expect(again.createdHousehold).toBe(false);
    expect(again.householdId).toBe(res.householdId);
  });

  it("does not anonymize households with open requests or recent activity", async () => {
    const store = await freshStore();
    const active = makeHousehold(store.base, { updatedAt: daysAgo(45) });
    makeRequest(store.base, active.id); // Open request protects it
    const recent = makeHousehold(store.base, { updatedAt: daysAgo(5) });

    await scrubExpiredPii(store.base, FIXED_NOW, 30);
    const doc = store.base.doc();
    expect(doc.households[active.id]!.anonymizedAt).toBeUndefined();
    expect(doc.households[recent.id]!.anonymizedAt).toBeUndefined();
  });
});
