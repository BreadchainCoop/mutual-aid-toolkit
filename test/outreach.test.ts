import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import {
  buildOutreachList,
  listOutbox,
  markOutboxSent,
  queueBlast,
  recordOutcome,
  renderTemplate,
  confirmAppointment,
} from "../src/domain/outreach.ts";
import { FIXED_NOW, TODAY, daysAgo, freshStore, makeHousehold, makeRequest } from "./helpers.ts";

const FSI = "⁨";
const PDI = "⁩";

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

  it("excludes paced request types; a household with only paced types is omitted", async () => {
    const store = await freshStore();
    const allPaced = makeHousehold(store.base);
    makeRequest(store.base, allPaced.id, { type: "soap", pacedUntil: "2026-07-10" });
    const mixed = makeHousehold(store.base);
    makeRequest(store.base, mixed.id, { type: "soap", pacedUntil: "2026-07-10" });
    makeRequest(store.base, mixed.id, { type: "pads" });
    const lapsed = makeHousehold(store.base);
    makeRequest(store.base, lapsed.id, { type: "soap", pacedUntil: "2026-06-30" });

    const list = buildOutreachList(store.base.doc(), {}, FIXED_NOW);
    const byId = Object.fromEntries(list.map((c) => [c.householdId, c]));
    expect(byId[allPaced.id]).toBeUndefined();
    expect(byId[mixed.id]!.openRequestTypes).toEqual(["pads"]);
    expect(byId[lapsed.id]!.openRequestTypes).toEqual(["soap"]);
  });

  it("email channel selects good-email households needing email or unreachable by SMS", async () => {
    const store = await freshStore();
    const flagged = makeHousehold(store.base, { email: "a@x.org", needsEmailOutreach: true });
    const phoneless = makeHousehold(store.base, { email: "b@x.org", phoneNumber: undefined });
    const badPhone = makeHousehold(store.base, { email: "c@x.org", invalidPhoneNumber: true });
    const reachable = makeHousehold(store.base, { email: "d@x.org" }); // SMS works, not flagged
    const bounced = makeHousehold(store.base, {
      email: "e@x.org",
      emailError: "bounced",
      needsEmailOutreach: true,
    });
    const noEmail = makeHousehold(store.base, { needsEmailOutreach: true });
    for (const h of [flagged, phoneless, badPhone, reachable, bounced, noEmail]) {
      makeRequest(store.base, h.id, { type: "soap" });
    }

    const emails = buildOutreachList(store.base.doc(), { channel: "email" }, FIXED_NOW);
    expect(emails.map((c) => c.householdId).sort()).toEqual(
      [flagged.id, phoneless.id, badPhone.id].sort()
    );
    expect(emails.every((c) => c.email !== undefined)).toBe(true);

    const sms = buildOutreachList(store.base.doc(), {}, FIXED_NOW);
    const smsIds = sms.map((c) => c.householdId);
    expect(smsIds).toContain(reachable.id);
    expect(smsIds).not.toContain(phoneless.id);
    expect(smsIds).not.toContain(badPhone.id);
  });

  it("rebookingOnly keeps only needsRebooking households and exposes the flag", async () => {
    const store = await freshStore();
    const cancelled = makeHousehold(store.base, { needsRebooking: true });
    makeRequest(store.base, cancelled.id, { type: "soap" });
    const plain = makeHousehold(store.base);
    makeRequest(store.base, plain.id, { type: "soap" });

    const rebook = buildOutreachList(store.base.doc(), { rebookingOnly: true }, FIXED_NOW);
    expect(rebook.map((c) => c.householdId)).toEqual([cancelled.id]);
    expect(rebook[0]!.needsRebooking).toBe(true);

    const all = buildOutreachList(store.base.doc(), {}, FIXED_NOW);
    expect(all.find((c) => c.householdId === plain.id)!.needsRebooking).toBe(false);
  });

  it("flags unsupported languages, honoring preferredLanguage", async () => {
    const store = await freshStore();
    const supported = makeHousehold(store.base, { languages: [ES] });
    const unlisted = makeHousehold(store.base, { languages: ["Klingon"] });
    const preferredOnly = makeHousehold(store.base, { languages: [], preferredLanguage: ES });
    const none = makeHousehold(store.base, { languages: [] });
    for (const h of [supported, unlisted, preferredOnly, none]) {
      makeRequest(store.base, h.id, { type: "soap" });
    }

    const list = buildOutreachList(store.base.doc(), {}, FIXED_NOW);
    const byId = Object.fromEntries(list.map((c) => [c.householdId, c]));
    expect(byId[supported.id]!.unsupportedLanguage).toBe(false);
    expect(byId[unlisted.id]!.unsupportedLanguage).toBe(true);
    expect(byId[preferredOnly.id]!.unsupportedLanguage).toBe(false);
    expect(byId[preferredOnly.id]!.preferredLanguage).toBe(ES);
    expect(byId[none.id]!.unsupportedLanguage).toBe(true);
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

  it("'emailed' stamps lastEmailed and leaves everything open", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { appointmentStatus: "Booked", appointmentDate: TODAY });
    const req = makeRequest(store.base, h.id);

    const after = recordOutcome(store.base, h.id, "emailed", "sent the form link", FIXED_NOW);
    expect(after.lastEmailed).toBe(TODAY);
    expect(after.notes).toContain("[emailed] sent the form link");
    expect(after.invalidPhoneNumber).toBe(false);
    expect(after.appointmentStatus).toBe("Booked"); // not an A4-A6 close-out
    expect(store.base.doc().requests[req.id]!.status).toBe("Open");
  });
});

describe("template rendering (bidi isolation)", () => {
  it("wraps every substituted value in FSI/PDI so RTL templates keep LTR values intact", () => {
    const body = renderTemplate("مرحبا {name}، الرابط: {url}", {
      name: "Maria Lopez",
      url: "https://forms.example/x",
    });
    expect(body).toBe(`مرحبا ${FSI}Maria Lopez${PDI}، الرابط: ${FSI}https://forms.example/x${PDI}`);
  });

  it("leaves unknown placeholders verbatim", () => {
    expect(renderTemplate("hi {name} {mystery}", { name: "Ana" })).toBe(
      `hi ${FSI}Ana${PDI} {mystery}`
    );
  });

  it("queueBlast isolates {name}/{url} substitutions in queued bodies", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { name: "Fatima Hassan" });
    const report = queueBlast(store.base, {
      householdIds: [h.id],
      template: "أهلاً {name}: {url}",
      tokenFactory: () => "tok9",
    }, FIXED_NOW);
    expect(report.messages[0]!.body).toContain(`${FSI}Fatima${PDI}`);
    expect(report.messages[0]!.body).toContain(`?r=tok9${PDI}`);
  });
});

describe("email blast + language preference", () => {
  it("queues email messages with channel/subject, stamps lastEmailed, counts skippedNoEmail", async () => {
    const store = await freshStore();
    const a = makeHousehold(store.base, { name: "Maria Lopez", email: "maria@x.org" });
    const noEmail = makeHousehold(store.base);
    const bounced = makeHousehold(store.base, { email: "z@x.org", emailError: "bounced" });

    const report = queueBlast(store.base, {
      householdIds: [a.id, noEmail.id, bounced.id],
      template: "Hola {name}",
      channel: "email",
      subject: "Distro this Sunday",
    }, FIXED_NOW);

    expect(report.sent).toBe(1);
    expect(report.skippedNoEmail).toBe(2);
    expect(report.skippedNoPhone).toBe(0);
    expect(report.messages[0]!.to).toBe("maria@x.org");

    const doc = store.base.doc();
    const [msg] = Object.values(doc.smsOutbox);
    expect(msg!.channel).toBe("email");
    expect(msg!.subject).toBe("Distro this Sunday");
    expect(msg!.to).toBe("maria@x.org");
    expect(doc.households[a.id]!.lastEmailed).toBe(TODAY);
    expect(doc.households[a.id]!.lastTexted).toBeUndefined();
  });

  it("explicit sms channel stamps channel:'sms' and still uses lastTexted", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    queueBlast(store.base, {
      householdIds: [h.id],
      template: "hi {name}",
      channel: "sms",
    }, FIXED_NOW);
    const doc = store.base.doc();
    const [msg] = Object.values(doc.smsOutbox);
    expect(msg!.channel).toBe("sms");
    expect(doc.households[h.id]!.lastTexted).toBe(TODAY);
    expect(doc.households[h.id]!.lastEmailed).toBeUndefined();
  });

  it("routes templates by preferredLanguage over the languages array", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { languages: [EN], preferredLanguage: ES });
    const report = queueBlast(store.base, {
      householdIds: [h.id],
      template: "",
      templates: { Spanish: "hola {name}", English: "hi {name}" },
      tokenFactory: () => "tok",
    }, FIXED_NOW);
    expect(report.messages[0]!.body.startsWith("hola ")).toBe(true);
  });
});
