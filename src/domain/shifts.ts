/**
 * Shift/coverage board over the DISTROS doc (see schema.ts `ShiftSlot`).
 *
 * Slots are claimable staffing rows for a distro/event day ("Sunday distro
 * needs 2 Lift, 1 Interpreter (Spanish)"). They live in their own doc so
 * access is grantable per device, and claims are keyed by device PeerId so
 * a claim and a release from different devices merge per-peer instead of
 * conflicting. Capacity (`needed`) is enforced at claim time by honest
 * clients; concurrent over-claims merge harmlessly and simply show gap 0.
 */

import type { DocHandle } from "@automerge/automerge-repo";
import type { DistrosDoc, ShiftSlot } from "../schema.ts";
import { localDate, newId, nowIso } from "../schema.ts";

export interface CreateShiftSlotInput {
  date: string; // YYYY-MM-DD
  eventLabel: string;
  role: string;
  languageRequired?: string;
  needed?: number; // defaults to 1, min 1
  notes?: string;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireSlot(doc: DistrosDoc, id: string): ShiftSlot {
  const slot = doc.shiftSlots[id];
  if (!slot) throw new Error(`Unknown shift slot id ${id}`);
  return slot;
}

/** Create a claimable slot. `needed` defaults to 1 and is clamped to ≥ 1. */
export function createShiftSlot(
  handle: DocHandle<DistrosDoc>,
  input: CreateShiftSlotInput,
  actor: string,
  now: string = nowIso()
): ShiftSlot {
  const id = newId();
  handle.change((d) => {
    const slot: ShiftSlot = {
      id,
      date: input.date,
      eventLabel: input.eventLabel,
      role: input.role,
      needed: Math.max(1, input.needed ?? 1),
      claims: {},
      createdBy: actor,
      createdAt: now,
    };
    if (input.languageRequired) slot.languageRequired = input.languageRequired;
    if (input.notes) slot.notes = input.notes;
    d.shiftSlots[id] = slot;
  });
  return handle.doc().shiftSlots[id]!;
}

/**
 * Patch a slot. Missing/null patch fields are left untouched; setting
 * `languageRequired` or `notes` to the empty string deletes the key
 * (Automerge rejects explicit `undefined`).
 */
export function updateShiftSlot(
  handle: DocHandle<DistrosDoc>,
  id: string,
  patch: Partial<CreateShiftSlotInput>
): ShiftSlot {
  requireSlot(handle.doc(), id);
  handle.change((d) => {
    const slot = d.shiftSlots[id]!;
    if (patch.date != null) slot.date = patch.date;
    if (patch.eventLabel != null) slot.eventLabel = patch.eventLabel;
    if (patch.role != null) slot.role = patch.role;
    if (patch.needed != null) slot.needed = Math.max(1, patch.needed);
    if (patch.languageRequired != null) {
      if (patch.languageRequired === "") delete slot.languageRequired;
      else slot.languageRequired = patch.languageRequired;
    }
    if (patch.notes != null) {
      if (patch.notes === "") delete slot.notes;
      else slot.notes = patch.notes;
    }
  });
  return handle.doc().shiftSlots[id]!;
}

/** Delete a slot (and its claims) outright. Throws on unknown id. */
export function removeShiftSlot(handle: DocHandle<DistrosDoc>, id: string): void {
  requireSlot(handle.doc(), id);
  handle.change((d) => {
    delete d.shiftSlots[id];
  });
}

/** Thrown when a claim would exceed the slot's `needed` headcount. */
export class ShiftFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShiftFullError";
  }
}

/**
 * Claim a slot for this device. Idempotent for a peer that already holds a
 * claim (the display name is refreshed, the original `at` stamp is kept);
 * otherwise throws `ShiftFullError` once `needed` claims exist.
 */
export function claimShiftSlot(
  handle: DocHandle<DistrosDoc>,
  id: string,
  claimant: { peerId: string; name: string },
  now: string = nowIso()
): ShiftSlot {
  const slot = requireSlot(handle.doc(), id);
  const existing = slot.claims[claimant.peerId];
  if (!existing && Object.keys(slot.claims).length >= slot.needed) {
    throw new ShiftFullError(
      `Shift slot ${id} is full (${slot.needed} needed, all claimed)`
    );
  }
  handle.change((d) => {
    const s = d.shiftSlots[id]!;
    s.claims[claimant.peerId] = { name: claimant.name, at: existing?.at ?? now };
  });
  return handle.doc().shiftSlots[id]!;
}

/** Release this peer's claim. Releasing a claim that isn't held is a no-op. */
export function releaseShiftSlot(
  handle: DocHandle<DistrosDoc>,
  id: string,
  peerId: string
): ShiftSlot {
  const slot = requireSlot(handle.doc(), id);
  if (slot.claims[peerId] !== undefined) {
    handle.change((d) => {
      delete d.shiftSlots[id]!.claims[peerId];
    });
  }
  return handle.doc().shiftSlots[id]!;
}

export interface ShiftSlotView extends ShiftSlot {
  claimedCount: number;
  /** Unfilled seats: max(0, needed - claimedCount). */
  gap: number;
  /** Claims flattened for display, earliest first. */
  claimants: Array<{ peerId: string; name: string; at: string }>;
}

function toView(slot: ShiftSlot): ShiftSlotView {
  const claimants = Object.entries(slot.claims)
    .map(([peerId, c]) => ({ peerId, name: c.name, at: c.at }))
    .sort((a, b) => cmp(a.at, b.at) || cmp(a.peerId, b.peerId));
  return {
    ...slot,
    claimedCount: claimants.length,
    gap: Math.max(0, slot.needed - claimants.length),
    claimants,
  };
}

/**
 * The coverage board: slots with claim counts and gaps, sorted by date,
 * then eventLabel, then role. Past dates (before `todayLocal`, which
 * defaults to today in the org timezone) are hidden unless `includePast`;
 * `from`/`to` are inclusive YYYY-MM-DD bounds.
 */
export function listShiftSlots(
  doc: DistrosDoc | undefined,
  opts: { from?: string; to?: string; includePast?: boolean; todayLocal?: string } = {}
): ShiftSlotView[] {
  if (!doc) return [];
  const today = opts.todayLocal ?? localDate(nowIso());
  return Object.values(doc.shiftSlots)
    .filter((s) => {
      if (!opts.includePast && s.date < today) return false;
      if (opts.from !== undefined && s.date < opts.from) return false;
      if (opts.to !== undefined && s.date > opts.to) return false;
      return true;
    })
    .map(toView)
    .sort(
      (a, b) => cmp(a.date, b.date) || cmp(a.eventLabel, b.eventLabel) || cmp(a.role, b.role)
    );
}

/**
 * Headline numbers over non-past slots: total unfilled seats and the
 * earliest date that still has a gap (null when fully covered).
 */
export function coverageSummary(
  doc: DistrosDoc | undefined,
  todayLocal: string
): { openGaps: number; nextGapDate: string | null } {
  let openGaps = 0;
  let nextGapDate: string | null = null;
  for (const slot of listShiftSlots(doc, { todayLocal })) {
    if (slot.gap === 0) continue;
    openGaps += slot.gap;
    if (nextGapDate === null) nextGapDate = slot.date; // list is date-sorted
  }
  return { openGaps, nextGapDate };
}
