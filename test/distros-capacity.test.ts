import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import {
  SlotFullError,
  bookAppointmentChecked,
  cancelDistro,
  createDistro,
  slotUsage,
} from "../src/domain/distros.ts";
import { FIXED_NOW, freshStore, makeHousehold } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

const DISTRO_AT = "2026-07-05T15:00:00.000Z"; // 11:00 AM in America/New_York
const DISTRO_DATE = "2026-07-05";

describe("distro scheduling and cancellation", () => {
  it("createDistro schedules into the distros doc", async () => {
    const store = await freshStore();
    const distro = createDistro(
      store.distros!,
      { dateTime: DISTRO_AT, location: "Maria Hernandez Park", slotCapacity: 4 },
      FIXED_NOW
    );
    const row = store.distros!.doc().distros[distro.id]!;
    expect(row.status).toBe("Scheduled");
    expect(row.location).toBe("Maria Hernandez Park");
    expect(row.slotCapacity).toBe(4);
    expect(row.createdAt).toBe(FIXED_NOW);
  });

  it("cancelDistro flips Booked households to needsRebooking", async () => {
    const store = await freshStore();
    const distro = createDistro(store.distros!, { dateTime: DISTRO_AT }, FIXED_NOW);
    const h1 = makeHousehold(store.base, {
      appointmentDate: DISTRO_DATE,
      appointmentTime: "11:00 AM",
      appointmentStatus: "Booked",
    });
    const h2 = makeHousehold(store.base, {
      appointmentDate: DISTRO_DATE,
      appointmentTime: "11:30 AM",
      appointmentStatus: "Booked",
    });
    const otherDay = makeHousehold(store.base, {
      appointmentDate: "2026-07-12",
      appointmentStatus: "Booked",
    });
    const checkedIn = makeHousehold(store.base, {
      appointmentDate: DISTRO_DATE,
      appointmentStatus: "Checked-in",
    });

    const result = cancelDistro(
      store.distros!, store.base, distro.id, { reason: "storm" }, FIXED_NOW
    );
    expect(result.distro.status).toBe("Cancelled");
    expect(result.distro.cancelledAt).toBe(FIXED_NOW);
    expect(result.distro.cancelReason).toBe("storm");
    expect(result.rebookHouseholdIds).toEqual([h1.id, h2.id].sort());

    const doc = store.base.doc();
    for (const id of [h1.id, h2.id]) {
      const h = doc.households[id]!;
      expect(h.appointmentDate).toBeUndefined();
      expect(h.appointmentTime).toBeUndefined();
      expect(h.appointmentStatus).toBeUndefined();
      expect(h.needsRebooking).toBe(true);
      expect(h.rebookFrom).toBe(DISTRO_DATE);
    }
    // Only Booked households on that date are swept.
    expect(doc.households[otherDay.id]!.appointmentStatus).toBe("Booked");
    expect(doc.households[checkedIn.id]!.appointmentStatus).toBe("Checked-in");

    expect(() =>
      cancelDistro(store.distros!, store.base, distro.id, {}, FIXED_NOW)
    ).toThrow(/already cancelled/);
    expect(() =>
      cancelDistro(store.distros!, store.base, "nope", {}, FIXED_NOW)
    ).toThrow(/Unknown distro/);
  });

  it("rebooking clears the needsRebooking flags", async () => {
    const store = await freshStore();
    const distro = createDistro(store.distros!, { dateTime: DISTRO_AT }, FIXED_NOW);
    const h = makeHousehold(store.base, {
      appointmentDate: DISTRO_DATE,
      appointmentTime: "11:00 AM",
      appointmentStatus: "Booked",
    });
    cancelDistro(store.distros!, store.base, distro.id, {}, FIXED_NOW);

    const rebooked = bookAppointmentChecked(
      store.base,
      store.distros!.doc(),
      h.id,
      { date: "2026-07-12", time: "10:00 AM" },
      {},
      FIXED_NOW
    );
    expect(rebooked.appointmentStatus).toBe("Booked");
    expect(rebooked.appointmentDate).toBe("2026-07-12");
    expect(rebooked.needsRebooking).toBeUndefined();
    expect(rebooked.rebookFrom).toBeUndefined();
  });
});

describe("slot capacity", () => {
  it("blocks the (cap+1)th booking at the same time; force overrides", async () => {
    const store = await freshStore();
    createDistro(store.distros!, { dateTime: DISTRO_AT, slotCapacity: 2 }, FIXED_NOW);
    const slot = { date: DISTRO_DATE, time: "11:00 AM" };
    const [h1, h2, h3, h4, h5] = Array.from({ length: 5 }, () => makeHousehold(store.base));

    bookAppointmentChecked(store.base, store.distros!.doc(), h1!.id, slot, {}, FIXED_NOW);
    bookAppointmentChecked(store.base, store.distros!.doc(), h2!.id, slot, {}, FIXED_NOW);

    let err: unknown;
    try {
      bookAppointmentChecked(store.base, store.distros!.doc(), h3!.id, slot, {}, FIXED_NOW);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SlotFullError);
    expect((err as SlotFullError).name).toBe("SlotFullError");
    expect((err as SlotFullError).cap).toBe(2);
    expect((err as SlotFullError).used).toBe(2);
    expect(store.base.doc().households[h3!.id]!.appointmentStatus).toBeUndefined();

    // Another time string on the same day is unaffected.
    const other = bookAppointmentChecked(
      store.base, store.distros!.doc(), h4!.id,
      { date: DISTRO_DATE, time: "11:30 AM" }, {}, FIXED_NOW
    );
    expect(other.appointmentStatus).toBe("Booked");

    // An operator can force past the cap.
    const forced = bookAppointmentChecked(
      store.base, store.distros!.doc(), h5!.id, slot, { force: true }, FIXED_NOW
    );
    expect(forced.appointmentTime).toBe("11:00 AM");
    expect(slotUsage(store.base.doc(), DISTRO_DATE)).toEqual({
      "11:00 AM": 3,
      "11:30 AM": 1,
    });
  });

  it("counts Checked-in appointments toward usage; uncapped distros never block", async () => {
    const store = await freshStore();
    createDistro(store.distros!, { dateTime: DISTRO_AT }, FIXED_NOW); // no slotCapacity
    makeHousehold(store.base, {
      appointmentDate: DISTRO_DATE,
      appointmentTime: "11:00 AM",
      appointmentStatus: "Checked-in",
    });
    makeHousehold(store.base, {
      appointmentDate: DISTRO_DATE,
      appointmentStatus: "Missed", // closed — not usage
    });
    expect(slotUsage(store.base.doc(), DISTRO_DATE)).toEqual({ "11:00 AM": 1 });

    const h = makeHousehold(store.base);
    const booked = bookAppointmentChecked(
      store.base, store.distros!.doc(), h.id,
      { date: DISTRO_DATE, time: "11:00 AM" }, {}, FIXED_NOW
    );
    expect(booked.appointmentStatus).toBe("Booked");
  });

  it("enforces capacity on legacy base-doc distros too", async () => {
    const store = await freshStore();
    store.base.change((d) => {
      d.distros["legacy1"] = {
        id: "legacy1",
        dateTime: DISTRO_AT,
        slotCapacity: 1,
        createdAt: FIXED_NOW,
      };
    });
    const h1 = makeHousehold(store.base);
    const h2 = makeHousehold(store.base);
    const slot = { date: DISTRO_DATE, time: "11:00 AM" };

    bookAppointmentChecked(store.base, undefined, h1.id, slot, {}, FIXED_NOW);
    expect(() =>
      bookAppointmentChecked(store.base, undefined, h2.id, slot, {}, FIXED_NOW)
    ).toThrow(SlotFullError);
  });

  it("a cancelled distro no longer caps its date", async () => {
    const store = await freshStore();
    const distro = createDistro(
      store.distros!, { dateTime: DISTRO_AT, slotCapacity: 0 }, FIXED_NOW
    );
    cancelDistro(store.distros!, store.base, distro.id, {}, FIXED_NOW);

    const h = makeHousehold(store.base);
    const booked = bookAppointmentChecked(
      store.base, store.distros!.doc(), h.id,
      { date: DISTRO_DATE, time: "11:00 AM" }, {}, FIXED_NOW
    );
    expect(booked.appointmentStatus).toBe("Booked");
  });
});
