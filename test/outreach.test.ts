import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import {
  buildOutreachList,
  listOutbox,
  markOutboxSent,
  queueBlast,
  recordOutcome,
  confirmAppointment,
} from "../src/domain/outreach.ts";
import { FIXED_NOW, TODAY, daysAgo, freshStore, makeHousehold, makeRequest } from "./helpers.ts";

const ES = "Español / Spanish / 西班牙语";
const EN = "Inglés / English / 英文";

beforeAll(async () => {
  await initSubduction();
});

describe("outreach list (spec 6.2 step 1)", () => {
  it("filters by supplies, language, booking, and recency; orders by oldest request", async () => {
    const store = await freshStore();
    const oldSoap = makeHousehold(store.base, { languages: [ES] });
    makeRequest(store.base, oldSoap.id, { type: "soap", requestOpenedAt: daysAgo(10) });
    const newSoap = makeHousehold(store.base, { languages: [ES] });
    makeRequest(store.base, newSoap.id, { type: "soap", requestOpenedAt: daysAgo(1) });
    const wrongType = makeHousehold(store.base, { languages: [ES] });
    makeRequest(store.base, wrongType.id, { type: "pads" });
    const wrongLang = makeHousehold(store.base, { languages: [EN] });
    makeRequest(store.base, wrongLang.id, { type: "soap" });
    const booked = makeHousehold(store.base, { languages: [ES], appointmentStatus: "Booked" });
    makeRequest(store.base, booked.id, { type: "soap" });
    const recentlyTexted = makeHousehold(store.base, { languages: [ES], lastTexted: TODAY });
    makeRequest(store.base, recentlyTexted.id, { type: "soap" });
    const invalid = makeHousehold(store.base, { languages: [ES], invalidPhoneNumber: true });
    makeRequest(store.base, invalid.id, { type: "soap" });

    const list = buildOutreachList(store.base.doc(), {
      requestTypes: ["soap"],
      languages: [ES],
      excludeTextedWithinDays: 7,
    }, FIXED_NOW);

    expect(list.map((c) => c.householdId)).toEqual([oldSoap.id, newSoap.id]);
  });
});

describe("text blast (spec 6.2 step 2 / spec 5 send_sms)", () => {
  it("queues outbox messages, stamps lastTexted, randomizes URLs", async () => {
    const store = await freshStore();
    const a = makeHousehold(store.base, { name: "Maria Lopez" });
    const b = makeHousehold(store.base);
    let n = 0;
    const report = queueBlast(store.base, {
      householdIds: [a.id, b.id, "ghost"],
      template: "Hola [FIRST_NAME]! [REQUEST_URL]",
      tokenFactory: () => `tok${++n}`,
    }, FIXED_NOW);

    expect(report.sent).toBe(2);
    expect(report.unknownHouseholdIds).toEqual(["ghost"]);
    expect(report.messages[0]!.body).toContain("Hola Maria!");
    expect(report.messages[0]!.body).toContain("?r=tok1");
    expect(report.messages[1]!.body).toContain("?r=tok2");
    expect(report.messages[0]!.body).not.toBe(report.messages[1]!.body);

    const doc = store.base.doc();
    expect(doc.households[a.id]!.lastTexted).toBe(TODAY);
    const outbox = listOutbox(doc, { unsentOnly: true });
    expect(outbox).toHaveLength(2);

    markOutboxSent(store.base, outbox[0]!.id, {}, FIXED_NOW);
    expect(listOutbox(store.base.doc(), { unsentOnly: true })).toHaveLength(1);
  });

  it("dry run reports but persists nothing", async () => {
    const store = await freshStore();
    const a = makeHousehold(store.base);
    const report = queueBlast(store.base, {
      householdIds: [a.id],
      template: "hi [FIRST_NAME]",
      dryRun: true,
    }, FIXED_NOW);

    expect(report.sent).toBe(1);
    const doc = store.base.doc();
    expect(doc.households[a.id]!.lastTexted).toBeUndefined();
    expect(Object.keys(doc.smsOutbox)).toHaveLength(0);
  });

  it("caps at maxMessages", async () => {
    const store = await freshStore();
    const ids = [1, 2, 3].map(() => makeHousehold(store.base).id);
    const report = queueBlast(store.base, {
      householdIds: ids,
      template: "x",
      maxMessages: 2,
    }, FIXED_NOW);
    expect(report.sent).toBe(2);
    expect(report.notSentOverLimit).toBe(1);
  });
});

describe("outcomes A4-A6 + booking", () => {
  it("books a confirmed recipient", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    const after = confirmAppointment(store.base, h.id, { date: TODAY, time: "11:00 AM" }, FIXED_NOW);
    expect(after.appointmentStatus).toBe("Booked");
    expect(after.appointmentDate).toBe(TODAY);
  });

  it("wrong number times out requests and flags the phone (A5)", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { appointmentStatus: "Booked", appointmentDate: TODAY });
    const req = makeRequest(store.base, h.id);

    const after = recordOutcome(store.base, h.id, "wrong_number", "reached a stranger", FIXED_NOW);
    expect(after.invalidPhoneNumber).toBe(true);
    expect(after.appointmentStatus).toBeUndefined();
    expect(after.notes).toContain("[wrong number] reached a stranger");
    expect(store.base.doc().requests[req.id]!.status).toBe("Timeout");
  });

  it("rejects unknown outcomes and households", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    expect(() => recordOutcome(store.base, h.id, "ghosted" as never, undefined, FIXED_NOW)).toThrow();
    expect(() => recordOutcome(store.base, "nope", "no_response_timeout", undefined, FIXED_NOW)).toThrow();
  });
});
