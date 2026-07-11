/** The demo seeder must produce data that exercises every feature, and must
 * be obviously fictional (555 phones, example.com emails). */

import { describe, expect, it } from "vitest";
import { seedDemoData } from "../src/domain/seed.ts";
import { waitlistReport, impactReport } from "../src/domain/reporting.ts";
import { buildOutreachList } from "../src/domain/outreach.ts";
import { listShiftSlots } from "../src/domain/shifts.ts";
import { localDate, nowIso } from "../src/schema.ts";
import { freshStore } from "./helpers.ts";

describe("seedDemoData", () => {
  it("populates every surface with fictional data", async () => {
    const store = await freshStore();
    const report = await seedDemoData(store);

    expect(report.households).toBeGreaterThanOrEqual(35);
    expect(report.goodsRequests).toBeGreaterThan(30);
    expect(report.socialServiceRequests).toBeGreaterThan(8);
    expect(report.distros).toBe(3);
    expect(report.shiftSlots).toBe(6);
    expect(report.rebookingQueue).toBe(3);
    expect(report.queuedMessages).toBe(4);

    const doc = store.base.doc();
    // Obviously fictional: every stored phone is a 555 number; every email
    // is @example.com.
    for (const h of Object.values(doc.households)) {
      if (h.phoneNumber) expect(h.phoneNumber).toContain("555");
      if (h.email) expect(h.email).toMatch(/@example\.com$/);
    }

    // Feature surfaces light up.
    const waitlist = waitlistReport(doc, localDate(nowIso()));
    expect(waitlist.length).toBeGreaterThan(5);
    expect(waitlist.some((r) => r.unsupportedLanguage > 0)).toBe(true); // interpreter flag
    expect(waitlist.some((r) => r.paced > 0)).toBe(true); // cooldown pacing

    const impact = impactReport(doc, {});
    expect(impact.totalDelivered).toBeGreaterThan(40);

    const rebooking = buildOutreachList(doc, { rebookingOnly: true });
    expect(rebooking.length).toBe(3);
    const emailList = buildOutreachList(doc, { channel: "email" });
    expect(emailList.length).toBeGreaterThanOrEqual(1);

    const slots = listShiftSlots(store.distros!.doc(), { todayLocal: localDate(nowIso()) });
    expect(slots.some((s) => s.gap > 0)).toBe(true); // visible coverage gaps
    expect(slots.some((s) => s.claimedCount > 0)).toBe(true);

    // Partner attribution landed.
    expect(
      Object.values(doc.socialServiceRequests).some((r) => r.partnerOrg === "MMeC")
    ).toBe(true);
    // Item policies exist (incl. the out-of-season summer example).
    expect(doc.itemPolicies?.["school_supplies"]?.seasonFrom).toBe("08-01");
  });

  it("is safe to run twice (intake dedupes by phone)", async () => {
    const store = await freshStore();
    await seedDemoData(store);
    const first = Object.keys(store.base.doc().households).length;
    await seedDemoData(store);
    const second = Object.keys(store.base.doc().households).length;
    expect(second).toBe(first);
  });
});
