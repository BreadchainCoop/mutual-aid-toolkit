import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import type { DocHandle } from "@automerge/automerge-repo";
import { impactReport, waitlistReport } from "../src/domain/reporting.ts";
import { labelFor } from "../src/domain/catalog.ts";
import type { BamDoc } from "../src/schema.ts";
import { newId } from "../src/schema.ts";
import { FIXED_NOW, TODAY, daysAgo, freshStore, makeHousehold, makeRequest } from "./helpers.ts";

const ES = "Español / Spanish / 西班牙语";
const EN = "Inglés / English / 英文";

beforeAll(async () => {
  await initSubduction();
});

function makeSocialRequest(handle: DocHandle<BamDoc>, householdId: string, type: string): void {
  const id = newId();
  handle.change((d) => {
    d.socialServiceRequests[id] = {
      id,
      type,
      householdId,
      status: "Open",
      internetAccess: [],
      roofAccessible: false,
      requestOpenedAt: FIXED_NOW,
      statusLastUpdatedAt: FIXED_NOW,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
  });
}

describe("waitlist report", () => {
  it("buckets open rows by age and tracks the oldest", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    const oldest = daysAgo(200);
    makeRequest(store.base, h.id, { type: "soap", requestOpenedAt: daysAgo(5) });
    makeRequest(store.base, h.id, { type: "soap", requestOpenedAt: daysAgo(40) });
    makeRequest(store.base, h.id, { type: "soap", requestOpenedAt: daysAgo(100) });
    makeRequest(store.base, h.id, { type: "soap", requestOpenedAt: oldest });
    makeRequest(store.base, h.id, { type: "soap", requestOpenedAt: daysAgo(1), status: "Delivered" });

    const [row] = waitlistReport(store.base.doc(), TODAY);
    expect(row!.type).toBe("soap");
    expect(row!.label).toBe(labelFor("soap"));
    expect(row!.category).toBe("toiletries");
    expect(row!.open).toBe(4); // the Delivered row is not on the waitlist
    expect(row!.age).toEqual({ d30: 1, d90: 1, d180: 1, older: 1 });
    expect(row!.oldestOpenAt).toBe(oldest);
  });

  it("counts paced rows inside open, and only while pacedUntil is in the future", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    makeRequest(store.base, h.id, { type: "soap", pacedUntil: "2026-07-10" }); // still paced
    makeRequest(store.base, h.id, { type: "soap", pacedUntil: "2026-06-30" }); // lapsed
    makeRequest(store.base, h.id, { type: "soap" });

    const [row] = waitlistReport(store.base.doc(), TODAY);
    expect(row!.open).toBe(3);
    expect(row!.paced).toBe(1);
  });

  it("attributes languages (preferredLanguage first) and flags unsupported ones", async () => {
    const store = await freshStore();
    const prefers = makeHousehold(store.base, { languages: [EN], preferredLanguage: ES });
    const english = makeHousehold(store.base, { languages: [EN] });
    const silent = makeHousehold(store.base, { languages: [] });
    const klingon = makeHousehold(store.base, { languages: ["Klingon"] });
    for (const h of [prefers, english, silent, klingon]) {
      makeRequest(store.base, h.id, { type: "soap" });
    }

    const [row] = waitlistReport(store.base.doc(), TODAY);
    expect(row!.byLanguage).toEqual({ [ES]: 1, [EN]: 1, Unknown: 1, Klingon: 1 });
    expect(row!.unsupportedLanguage).toBe(2); // silent + klingon
  });

  it("includes social-service rows and sorts by open count descending", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    makeRequest(store.base, h.id, { type: "soap" });
    makeRequest(store.base, h.id, { type: "soap" });
    makeSocialRequest(store.base, h.id, "tenant_legal");

    const rows = waitlistReport(store.base.doc(), TODAY);
    expect(rows.map((r) => r.type)).toEqual(["soap", "tenant_legal"]);
    expect(rows[1]!.category).toBe("social_service");
    expect(rows[1]!.open).toBe(1);
  });
});

describe("impact report", () => {
  async function seeded() {
    const store = await freshStore();
    store.base.change((d) => {
      d.fulfilledCounts["2026-06-01|soap"] = 3;
      d.fulfilledCounts["2026-06-15|soap"] = 2;
      d.fulfilledCounts["2026-06-15|pads"] = 1;
      d.fulfilledCounts["2026-07-01|soap"] = 4;
    });
    return store;
  }

  it("sums delivered counts inside an inclusive range", async () => {
    const store = await seeded();
    const report = impactReport(store.base.doc(), { start: "2026-06-10", end: "2026-06-30" });
    expect(report.delivered).toEqual({ soap: 2, pads: 1 });
    expect(report.totalDelivered).toBe(3);
    expect(report.start).toBe("2026-06-10");
    expect(report.end).toBe("2026-06-30");
    expect(report.generatedAt).toBeTruthy();
  });

  it("treats a missing bound as unbounded", async () => {
    const store = await seeded();

    const fromMid = impactReport(store.base.doc(), { start: "2026-06-15" });
    expect(fromMid.delivered).toEqual({ soap: 6, pads: 1 });
    expect(fromMid.totalDelivered).toBe(7);
    expect(fromMid.end).toBeNull();

    const untilStart = impactReport(store.base.doc(), { end: "2026-06-01" });
    expect(untilStart.delivered).toEqual({ soap: 3 });
    expect(untilStart.start).toBeNull();

    const everything = impactReport(store.base.doc(), {});
    expect(everything.totalDelivered).toBe(10);
  });
});
