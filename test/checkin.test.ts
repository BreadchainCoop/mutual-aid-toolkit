import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import {
  checkIn,
  fulfill,
  lookupByPhone,
  processNoShows,
  searchByEmail,
  searchByName,
  setNeedsDelivery,
  setSetAside,
  updateContact,
} from "../src/domain/checkin.ts";
import { fulfilledCountKey } from "../src/schema.ts";
import { FIXED_NOW, TODAY, freshStore, makeHousehold, makeRequest } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

describe("check-in (spec 6.3)", () => {
  it("looks up by formatted phone variants and shows delivered history", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { phoneNumber: "+17185550200" });
    const delivered = makeRequest(store.base, h.id, { type: "soap" });
    fulfill(store.base, { requestIds: [delivered.id] }, FIXED_NOW);
    makeRequest(store.base, h.id, { type: "pads" });

    const view = lookupByPhone(store.base.doc(), "(718) 555-0200");
    expect(view).not.toBeNull();
    expect(view!.household.id).toBe(h.id);
    expect(view!.openRequests.map((r) => r.type)).toEqual(["pads"]);
    expect(view!.deliveredRequestTypes).toContain("soap");
    expect(lookupByPhone(store.base.doc(), "+19998887777")).toBeNull();
  });

  it("searches by name, excluding anonymized households", async () => {
    const store = await freshStore();
    const ana = makeHousehold(store.base, { name: "Ana María López" });
    makeHousehold(store.base, { name: "Rosa Diaz" });
    makeHousehold(store.base, { name: undefined });

    const matches = searchByName(store.base.doc(), "maría lóp");
    expect(matches.map((m) => m.id)).toEqual([ana.id]);
  });

  it("check-in resets missed count and stamps lastAttended", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, {
      appointmentStatus: "Booked",
      missedAppointmentCount: 1,
    });

    const after = checkIn(store.base, h.id, FIXED_NOW);
    expect(after.appointmentStatus).toBe("Checked-in");
    expect(after.missedAppointmentCount).toBe(0);
    expect(after.lastAttended).toBe(TODAY);
    expect(() => checkIn(store.base, "nope", FIXED_NOW)).toThrow();
  });

  it("fulfillment is idempotent and counts both kinds", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    const req = makeRequest(store.base, h.id, { type: "soap" });
    store.base.change((d) => {
      d.socialServiceRequests["s1"] = {
        id: "s1",
        type: "housing",
        householdId: h.id,
        status: "Open",
        internetAccess: [],
        roofAccessible: false,
        requestOpenedAt: FIXED_NOW,
        statusLastUpdatedAt: FIXED_NOW,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      };
    });

    fulfill(store.base, { requestIds: [req.id, req.id], socialServiceRequestIds: ["s1"] }, FIXED_NOW);
    fulfill(store.base, { requestIds: [req.id] }, FIXED_NOW); // retry: no-op

    const doc = store.base.doc();
    expect(doc.requests[req.id]!.status).toBe("Delivered");
    expect(doc.fulfilledCounts[fulfilledCountKey(TODAY, "soap")]).toBe(1);
    expect(doc.fulfilledCounts[fulfilledCountKey(TODAY, "housing")]).toBe(1);
    // +14 days from the local business date
    expect(doc.requests[req.id]!.processingDate).toBe("2026-07-15");
    expect(() => fulfill(store.base, { requestIds: ["missing"] }, FIXED_NOW)).toThrow();
  });

  it("partial fulfillment leaves other requests open (A1)", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    const a = makeRequest(store.base, h.id, { type: "soap" });
    const b = makeRequest(store.base, h.id, { type: "pads" });

    fulfill(store.base, { requestIds: [a.id] }, FIXED_NOW);
    expect(store.base.doc().requests[b.id]!.status).toBe("Open");
  });

  it("no-show pass: 1st miss returns to queue, 2nd miss times out (A2/A3)", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, {
      appointmentStatus: "Booked",
      appointmentDate: TODAY,
      appointmentTime: "11:00 AM",
    });
    const req = makeRequest(store.base, h.id);

    const first = processNoShows(store.base, TODAY, FIXED_NOW);
    expect(first.missedHouseholdIds).toEqual([h.id]);
    expect(first.timedOutHouseholdIds).toEqual([]);
    let doc = store.base.doc();
    expect(doc.households[h.id]!.missedAppointmentCount).toBe(1);
    expect(doc.households[h.id]!.appointmentDate).toBeUndefined();
    expect(doc.requests[req.id]!.status).toBe("Open");

    // Re-book and miss again.
    store.base.change((d) => {
      const hh = d.households[h.id]!;
      hh.appointmentStatus = "Booked";
      hh.appointmentDate = TODAY;
    });
    const second = processNoShows(store.base, TODAY, FIXED_NOW);
    expect(second.timedOutHouseholdIds).toEqual([h.id]);
    doc = store.base.doc();
    expect(doc.requests[req.id]!.status).toBe("Timeout");
  });
});

describe("contact fixes and check-in flags", () => {
  const ACTOR = { peerId: "a1b2c3d4e5f60708", name: "Maria" };

  it("updateContact rejects garbage phones and keeps full numbers out of notes", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, {
      phoneNumber: "+17185550100",
      invalidPhoneNumber: true,
    });

    expect(() =>
      updateContact(store.base, h.id, { phoneNumber: "banana" }, ACTOR, FIXED_NOW)
    ).toThrow(/invalid phone number/);
    expect(() =>
      updateContact(store.base, "nope", { phoneNumber: "+17185550142" }, ACTOR, FIXED_NOW)
    ).toThrow(/Unknown household/);

    const fixed = updateContact(
      store.base, h.id, { phoneNumber: "(718) 555-0142" }, ACTOR, FIXED_NOW
    );
    expect(fixed.phoneNumber).toBe("+17185550142");
    expect(fixed.invalidPhoneNumber).toBe(false);
    // Audit line: actor + date + last-4 only — never the full numbers.
    expect(fixed.notes).toBe(
      `[contact fixed ${TODAY} by Maria: phone ****0100 → ****0142]`
    );
    expect(fixed.notes).not.toContain("5550100");
    expect(fixed.notes).not.toContain("5550142");
  });

  it("updateContact fixes email with a domain-only audit line", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, {
      email: "old@example.com",
      emailError: "Invalid email address: old@example",
    });

    expect(() =>
      updateContact(store.base, h.id, { email: "not-an-email" }, ACTOR, FIXED_NOW)
    ).toThrow(/invalid email/);

    const fixed = updateContact(
      store.base, h.id, { email: "maria@riseup.net" }, { peerId: "deadbeefcafe1234" }, FIXED_NOW
    );
    expect(fixed.email).toBe("maria@riseup.net");
    expect(fixed.emailError).toBeUndefined();
    // Falls back to the peerId prefix when the actor has no name.
    expect(fixed.notes).toBe(`[contact fixed ${TODAY} by deadbeef: email → riseup.net]`);
    expect(fixed.notes).not.toContain("maria@");
  });

  it("searchByEmail is case-insensitive and skips anonymized households", async () => {
    const store = await freshStore();
    const ana = makeHousehold(store.base, { name: "Ana", email: "Ana.Lopez@Example.com" });
    makeHousehold(store.base, {
      name: "Ghost",
      email: "ghost.lopez@example.com",
      anonymizedAt: FIXED_NOW,
    });
    makeHousehold(store.base, { name: "No Email" });

    const matches = searchByEmail(store.base.doc(), "LOPEZ@example");
    expect(matches.map((m) => m.id)).toEqual([ana.id]);
    expect(searchByEmail(store.base.doc(), "")).toEqual([]);
  });

  it("setSetAside sets and clears the marker", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);

    const on = setSetAside(store.base, h.id, "2 bags on shelf B", ACTOR, FIXED_NOW);
    expect(on.setAside).toEqual({ note: "2 bags on shelf B", at: FIXED_NOW, by: "Maria" });

    const off = setSetAside(store.base, h.id, null, ACTOR, FIXED_NOW);
    expect(off.setAside).toBeUndefined();
    expect(() => setSetAside(store.base, "nope", "x", ACTOR, FIXED_NOW)).toThrow();
  });

  it("setNeedsDelivery toggles the flag", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    expect(setNeedsDelivery(store.base, h.id, true, FIXED_NOW).needsDelivery).toBe(true);
    expect(setNeedsDelivery(store.base, h.id, false, FIXED_NOW).needsDelivery).toBe(false);
    expect(() => setNeedsDelivery(store.base, "nope", true, FIXED_NOW)).toThrow();
  });
});
