import { beforeAll, describe, expect, it } from "vitest";
import { Repo, initSubduction } from "@automerge/automerge-repo";
import type { DocHandle } from "@automerge/automerge-repo";
import { MemorySigner } from "@automerge/automerge-subduction";
import {
  ShiftFullError,
  claimShiftSlot,
  coverageSummary,
  createShiftSlot,
  listShiftSlots,
  releaseShiftSlot,
  removeShiftSlot,
  updateShiftSlot,
} from "../src/domain/shifts.ts";
import { emptyDistrosDoc, type DistrosDoc } from "../src/schema.ts";
import { FIXED_NOW, TODAY } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

const ADMIN = "peer-admin";
const ANA = { peerId: "peer-ana", name: "Ana" };
const BEN = { peerId: "peer-ben", name: "Ben" };

function freshDistros(): DocHandle<DistrosDoc> {
  const signer = MemorySigner.generate();
  const repo = new Repo({ signer: signer as never });
  return repo.create<DistrosDoc>(emptyDistrosDoc("BAM Test", FIXED_NOW));
}

describe("shift slots (coverage board)", () => {
  it("creates a slot with defaults and without undefined optionals", () => {
    const distros = freshDistros();
    const slot = createShiftSlot(
      distros,
      { date: TODAY, eventLabel: "Sunday distro", role: "Check-in" },
      ADMIN,
      FIXED_NOW
    );
    expect(slot.needed).toBe(1);
    expect(slot.claims).toEqual({});
    expect(slot.createdBy).toBe(ADMIN);
    expect(slot.createdAt).toBe(FIXED_NOW);
    expect("languageRequired" in slot).toBe(false);
    expect("notes" in slot).toBe(false);

    const withExtras = createShiftSlot(
      distros,
      {
        date: TODAY,
        eventLabel: "Sunday distro",
        role: "Interpreter",
        languageRequired: "Spanish",
        needed: 0, // clamped to the minimum of 1
        notes: "Arrive 15 min early",
      },
      ADMIN,
      FIXED_NOW
    );
    expect(withExtras.needed).toBe(1);
    expect(withExtras.languageRequired).toBe("Spanish");
    expect(withExtras.notes).toBe("Arrive 15 min early");
  });

  it("claims and releases; releasing a claim that isn't held is a no-op", () => {
    const distros = freshDistros();
    const slot = createShiftSlot(
      distros,
      { date: TODAY, eventLabel: "Sunday distro", role: "Lift", needed: 2 },
      ADMIN,
      FIXED_NOW
    );

    const claimed = claimShiftSlot(distros, slot.id, ANA, FIXED_NOW);
    expect(claimed.claims[ANA.peerId]).toEqual({ name: "Ana", at: FIXED_NOW });

    // Releasing a peer with no claim changes nothing.
    const untouched = releaseShiftSlot(distros, slot.id, BEN.peerId);
    expect(Object.keys(untouched.claims)).toEqual([ANA.peerId]);

    const released = releaseShiftSlot(distros, slot.id, ANA.peerId);
    expect(released.claims).toEqual({});

    expect(() => claimShiftSlot(distros, "nope", ANA)).toThrow(/Unknown shift slot/);
    expect(() => releaseShiftSlot(distros, "nope", ANA.peerId)).toThrow(/Unknown shift slot/);
  });

  it("throws ShiftFullError once needed claims exist", () => {
    const distros = freshDistros();
    const slot = createShiftSlot(
      distros,
      { date: TODAY, eventLabel: "Sunday distro", role: "Driver", needed: 1 },
      ADMIN,
      FIXED_NOW
    );
    claimShiftSlot(distros, slot.id, ANA, FIXED_NOW);

    let caught: unknown;
    try {
      claimShiftSlot(distros, slot.id, BEN, FIXED_NOW);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShiftFullError);
    expect((caught as Error).name).toBe("ShiftFullError");

    // Releasing frees the seat again.
    releaseShiftSlot(distros, slot.id, ANA.peerId);
    expect(() => claimShiftSlot(distros, slot.id, BEN, FIXED_NOW)).not.toThrow();
  });

  it("re-claiming by the same peer is idempotent and refreshes the name", () => {
    const distros = freshDistros();
    const slot = createShiftSlot(
      distros,
      { date: TODAY, eventLabel: "Sunday distro", role: "Driver", needed: 1 },
      ADMIN,
      FIXED_NOW
    );
    claimShiftSlot(distros, slot.id, ANA, FIXED_NOW);

    const later = "2026-07-01T13:00:00.000Z";
    const after = claimShiftSlot(distros, slot.id, { ...ANA, name: "Ana M." }, later);
    expect(Object.keys(after.claims)).toEqual([ANA.peerId]);
    expect(after.claims[ANA.peerId]!.name).toBe("Ana M.");
    expect(after.claims[ANA.peerId]!.at).toBe(FIXED_NOW); // original stamp kept
  });

  it("computes claimedCount, gap (never negative), and sorted claimants", () => {
    const distros = freshDistros();
    const slot = createShiftSlot(
      distros,
      { date: TODAY, eventLabel: "Sunday distro", role: "Lift", needed: 3 },
      ADMIN,
      FIXED_NOW
    );
    claimShiftSlot(distros, slot.id, BEN, "2026-07-01T13:00:00.000Z");
    claimShiftSlot(distros, slot.id, ANA, FIXED_NOW);

    let [view] = listShiftSlots(distros.doc(), { todayLocal: TODAY });
    expect(view!.claimedCount).toBe(2);
    expect(view!.gap).toBe(1);
    expect(view!.claimants.map((c) => c.name)).toEqual(["Ana", "Ben"]); // earliest first

    // Shrinking needed below the claim count clamps gap at 0.
    updateShiftSlot(distros, slot.id, { needed: 1 });
    [view] = listShiftSlots(distros.doc(), { todayLocal: TODAY });
    expect(view!.claimedCount).toBe(2);
    expect(view!.gap).toBe(0);
  });

  it("hides past dates by default, honors includePast and inclusive from/to, sorts", () => {
    const distros = freshDistros();
    const mk = (date: string, eventLabel: string, role: string) =>
      createShiftSlot(distros, { date, eventLabel, role }, ADMIN, FIXED_NOW);
    mk("2026-06-28", "Sunday distro", "Check-in"); // past
    mk("2026-07-05", "Sunday distro", "Lift");
    mk("2026-07-05", "Sunday distro", "Check-in");
    mk("2026-07-05", "Board meeting", "Notes");
    mk("2026-07-12", "Sunday distro", "Check-in");

    expect(listShiftSlots(undefined)).toEqual([]);

    const upcoming = listShiftSlots(distros.doc(), { todayLocal: TODAY });
    expect(upcoming.map((s) => [s.date, s.eventLabel, s.role])).toEqual([
      ["2026-07-05", "Board meeting", "Notes"],
      ["2026-07-05", "Sunday distro", "Check-in"],
      ["2026-07-05", "Sunday distro", "Lift"],
      ["2026-07-12", "Sunday distro", "Check-in"],
    ]);

    const all = listShiftSlots(distros.doc(), { todayLocal: TODAY, includePast: true });
    expect(all).toHaveLength(5);
    expect(all[0]!.date).toBe("2026-06-28");

    const bounded = listShiftSlots(distros.doc(), {
      todayLocal: TODAY,
      includePast: true,
      from: "2026-06-28",
      to: "2026-07-05",
    });
    expect(bounded.map((s) => s.date)).toEqual([
      "2026-06-28",
      "2026-07-05",
      "2026-07-05",
      "2026-07-05",
    ]);
  });

  it("updates fields, deletes optionals on empty string, throws on unknown id", () => {
    const distros = freshDistros();
    const slot = createShiftSlot(
      distros,
      {
        date: TODAY,
        eventLabel: "Sunday distro",
        role: "Interpreter",
        languageRequired: "Spanish",
        needed: 2,
        notes: "Front table",
      },
      ADMIN,
      FIXED_NOW
    );

    const after = updateShiftSlot(distros, slot.id, {
      role: "Interpreter (walk-ups)",
      needed: 0, // clamped back to 1
      languageRequired: "",
      notes: "",
    });
    expect(after.role).toBe("Interpreter (walk-ups)");
    expect(after.needed).toBe(1);
    expect("languageRequired" in after).toBe(false);
    expect("notes" in after).toBe(false);
    // Untouched fields survive the merge.
    expect(after.date).toBe(TODAY);
    expect(after.eventLabel).toBe("Sunday distro");

    expect(() => updateShiftSlot(distros, "nope", { notes: "x" })).toThrow(/Unknown shift slot/);
  });

  it("removes a slot; unknown id throws", () => {
    const distros = freshDistros();
    const slot = createShiftSlot(
      distros,
      { date: TODAY, eventLabel: "Sunday distro", role: "Check-in" },
      ADMIN,
      FIXED_NOW
    );
    removeShiftSlot(distros, slot.id);
    expect(distros.doc().shiftSlots[slot.id]).toBeUndefined();
    expect(() => removeShiftSlot(distros, slot.id)).toThrow(/Unknown shift slot/);
  });

  it("coverageSummary totals gaps over non-past slots only", () => {
    const distros = freshDistros();
    expect(coverageSummary(undefined, TODAY)).toEqual({ openGaps: 0, nextGapDate: null });
    expect(coverageSummary(distros.doc(), TODAY)).toEqual({ openGaps: 0, nextGapDate: null });

    // Past gap: ignored.
    createShiftSlot(
      distros,
      { date: "2026-06-28", eventLabel: "Sunday distro", role: "Lift", needed: 2 },
      ADMIN,
      FIXED_NOW
    );
    // Fully covered today: no gap.
    const covered = createShiftSlot(
      distros,
      { date: TODAY, eventLabel: "Sunday distro", role: "Check-in" },
      ADMIN,
      FIXED_NOW
    );
    claimShiftSlot(distros, covered.id, ANA, FIXED_NOW);
    // Two open seats on the 5th, one on the 12th.
    const lift = createShiftSlot(
      distros,
      { date: "2026-07-05", eventLabel: "Sunday distro", role: "Lift", needed: 3 },
      ADMIN,
      FIXED_NOW
    );
    claimShiftSlot(distros, lift.id, BEN, FIXED_NOW);
    createShiftSlot(
      distros,
      { date: "2026-07-12", eventLabel: "Sunday distro", role: "Driver" },
      ADMIN,
      FIXED_NOW
    );

    expect(coverageSummary(distros.doc(), TODAY)).toEqual({
      openGaps: 3,
      nextGapDate: "2026-07-05",
    });
  });
});
