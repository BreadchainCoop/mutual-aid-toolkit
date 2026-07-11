/**
 * Distro event management: scheduling, cancellation with its rebooking
 * fan-out, and slot-capacity-checked booking.
 *
 * Distros live in the grantable DistrosDoc (see store.ts); pre-split orgs
 * may still carry legacy rows in `BamDoc.distros`, so the booking check
 * searches both. Appointments themselves stay on the household in the BASE
 * doc — `slotUsage` derives booking pressure from those fields, so capacity
 * enforcement needs no extra bookkeeping and merges cleanly.
 */

import type { DocHandle } from "@automerge/automerge-repo";
import type { BamDoc, Distro, DistrosDoc, Household } from "../schema.ts";
import { localDate, newId, nowIso } from "../schema.ts";
import { confirmAppointment } from "./outreach.ts";

export interface CreateDistroInput {
  dateTime: string; // ISO datetime
  location?: string;
  durationMinutes?: number;
  appointments?: string;
  notes?: string;
  slotCapacity?: number;
}

/** Schedule a new distro in the distros doc. */
export function createDistro(
  handle: DocHandle<DistrosDoc>,
  input: CreateDistroInput,
  now: string = nowIso()
): Distro {
  const id = newId();
  handle.change((d) => {
    const row: Distro = {
      id,
      dateTime: input.dateTime,
      status: "Scheduled",
      createdAt: now,
    };
    if (input.location) row.location = input.location;
    if (input.durationMinutes !== undefined) row.durationMinutes = input.durationMinutes;
    if (input.appointments !== undefined) row.appointments = input.appointments;
    if (input.notes) row.notes = input.notes;
    if (input.slotCapacity !== undefined) row.slotCapacity = input.slotCapacity;
    d.distros[id] = row;
  });
  return handle.doc().distros[id]!;
}

/**
 * Cancel a distro and flag everyone booked into it for rebooking.
 *
 * Every BASE-doc household Booked on the distro's local date has its
 * appointment cleared and gets `needsRebooking` + `rebookFrom` so the
 * outreach view can chase them for a new slot. Throws on an unknown id or a
 * distro that is already Cancelled.
 */
export function cancelDistro(
  distrosHandle: DocHandle<DistrosDoc>,
  baseHandle: DocHandle<BamDoc>,
  distroId: string,
  opts: { reason?: string } = {},
  now: string = nowIso()
): { distro: Distro; rebookHouseholdIds: string[] } {
  const existing = distrosHandle.doc().distros[distroId];
  if (!existing) throw new Error(`Unknown distro id ${distroId}`);
  if (existing.status === "Cancelled") {
    throw new Error(`Distro ${distroId} is already cancelled`);
  }
  distrosHandle.change((d) => {
    const row = d.distros[distroId]!;
    row.status = "Cancelled";
    row.cancelledAt = now;
    if (opts.reason) row.cancelReason = opts.reason;
  });

  const date = localDate(existing.dateTime);
  const rebookHouseholdIds = Object.values(baseHandle.doc().households)
    .filter((h) => h.appointmentDate === date && h.appointmentStatus === "Booked")
    .map((h) => h.id)
    .sort();
  if (rebookHouseholdIds.length) {
    baseHandle.change((d) => {
      for (const id of rebookHouseholdIds) {
        const h = d.households[id]!;
        delete h.appointmentDate;
        delete h.appointmentTime;
        delete h.appointmentStatus;
        h.needsRebooking = true;
        h.rebookFrom = date;
        h.updatedAt = now;
      }
    });
  }
  return { distro: distrosHandle.doc().distros[distroId]!, rebookHouseholdIds };
}

/**
 * Booking pressure for a date: how many households hold that date with a
 * Booked or Checked-in appointment, keyed by the exact appointment time
 * string ("" for unset).
 */
export function slotUsage(baseDoc: BamDoc, date: string): { [time: string]: number } {
  const usage: { [time: string]: number } = {};
  for (const h of Object.values(baseDoc.households)) {
    if (h.appointmentDate !== date) continue;
    if (h.appointmentStatus !== "Booked" && h.appointmentStatus !== "Checked-in") continue;
    const time = h.appointmentTime ?? "";
    usage[time] = (usage[time] ?? 0) + 1;
  }
  return usage;
}

/** A booking bounced off a full slot; carries the cap and current usage. */
export class SlotFullError extends Error {
  cap: number;
  used: number;
  constructor(cap: number, used: number) {
    super(`Slot is full (${used}/${cap} booked)`);
    this.name = "SlotFullError";
    this.cap = cap;
    this.used = used;
  }
}

/**
 * Book a household into a slot, enforcing the distro's per-slot capacity.
 *
 * The date's distro is looked up in the distros doc first, then the legacy
 * BASE-doc rows (Cancelled distros never match). When it carries a numeric
 * `slotCapacity` and the requested time string is already at cap, the
 * booking throws `SlotFullError` unless `force` (an operator override).
 * Otherwise it books via `confirmAppointment` and clears any pending
 * rebooking flags — a rebooked household leaves the chase list.
 */
export function bookAppointmentChecked(
  baseHandle: DocHandle<BamDoc>,
  distrosDoc: DistrosDoc | undefined,
  householdId: string,
  appt: { date: string; time: string },
  opts: { force?: boolean } = {},
  now: string = nowIso()
): Household {
  const findOn = (rows: { [id: string]: Distro } | undefined): Distro | undefined =>
    rows
      ? Object.values(rows).find(
          (d) => localDate(d.dateTime) === appt.date && d.status !== "Cancelled"
        )
      : undefined;
  const distro = findOn(distrosDoc?.distros) ?? findOn(baseHandle.doc().distros);

  if (distro && typeof distro.slotCapacity === "number" && !opts.force) {
    const used = slotUsage(baseHandle.doc(), appt.date)[appt.time] ?? 0;
    if (used >= distro.slotCapacity) throw new SlotFullError(distro.slotCapacity, used);
  }

  const booked = confirmAppointment(baseHandle, householdId, appt, now);
  if (booked.needsRebooking !== undefined || booked.rebookFrom !== undefined) {
    baseHandle.change((d) => {
      const h = d.households[householdId]!;
      delete h.needsRebooking;
      delete h.rebookFrom;
    });
  }
  return baseHandle.doc().households[householdId]!;
}
