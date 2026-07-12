/**
 * Check-in services (port of bam/services/checkin.py, spec section 6.3 +
 * no-show sequence + A2/A3).
 *
 * Covers the distribution-day flow: phone lookup, marking the household
 * checked in, fulfilling requests (which feeds the Fulfilled Request Count
 * metrics), and the end-of-event no-show pass that times out households
 * after their second missed appointment (spec interpretation rule 5).
 */

import type { DocHandle } from "@automerge/automerge-repo";
import type { BamDoc, Household, RequestRow, SocialServiceRequestRow } from "../schema.ts";
import { decrementStock } from "./inventory.ts";
import { fulfilledCountKey, localDate, nowIso } from "../schema.ts";
import { applyStatusChange } from "./lifecycle.ts";
import { normalizePhone } from "./validation.ts";

/** Spec interpretation rule 5: time out after the second missed appointment. */
export const MAX_MISSED_APPOINTMENTS = 2;

export interface CheckinView {
  household: Household;
  openRequests: RequestRow[];
  openSocialServiceRequests: SocialServiceRequestRow[];
  /** "Delivered Request Types" lookup (spec 4) — what the household has
   * already received, goods types first, both lists distinct-sorted. */
  deliveredRequestTypes: string[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byOpenedThenId(
  a: RequestRow | SocialServiceRequestRow,
  b: RequestRow | SocialServiceRequestRow
): number {
  return cmp(a.requestOpenedAt, b.requestOpenedAt) || cmp(a.id, b.id);
}

/** Assemble the volunteer-facing view for a household. */
export function buildCheckinView(doc: BamDoc, household: Household): CheckinView {
  const requests = Object.values(doc.requests).filter((r) => r.householdId === household.id);
  const social = Object.values(doc.socialServiceRequests).filter(
    (r) => r.householdId === household.id
  );
  const delivered = [
    ...new Set(requests.filter((r) => r.status === "Delivered").map((r) => r.type)),
  ].sort();
  const deliveredSocial = [
    ...new Set(social.filter((r) => r.status === "Delivered").map((r) => r.type)),
  ].sort();
  return {
    household,
    openRequests: requests.filter((r) => r.status === "Open").sort(byOpenedThenId),
    openSocialServiceRequests: social.filter((r) => r.status === "Open").sort(byOpenedThenId),
    deliveredRequestTypes: [...delivered, ...deliveredSocial],
  };
}

/**
 * Find a household by phone and return its open requests (6.3 steps 2-3).
 * The phone is normalized to E.164 for the lookup; if it cannot be
 * normalized we fall back to an exact string match.
 */
export function lookupByPhone(doc: BamDoc, phone: string): CheckinView | null {
  const validation = normalizePhone(phone);
  const lookupValue = validation.normalized ?? phone;
  const household = Object.values(doc.households).find((h) => h.phoneNumber === lookupValue);
  if (!household) return null;
  return buildCheckinView(doc, household);
}

/** Case-insensitive name search (spec journey step 5: check in via phone
 * number/name) for recipients who arrive without their phone. */
export function searchByName(doc: BamDoc, name: string, limit = 20): Household[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  return Object.values(doc.households)
    .filter((h) => h.name !== undefined && h.name.toLowerCase().includes(needle))
    .sort((a, b) => cmp(a.name!, b.name!) || cmp(a.id, b.id))
    .slice(0, limit);
}

/** Mark the household checked in (6.3 step 4 precursor). Resets
 * `missedAppointmentCount` per interpretation rule 5. */
export function checkIn(
  handle: DocHandle<BamDoc>,
  householdId: string,
  now: string = nowIso()
): Household {
  if (!handle.doc().households[householdId]) {
    throw new Error(`Unknown household id ${householdId}`);
  }
  handle.change((d) => {
    const h = d.households[householdId]!;
    h.appointmentStatus = "Checked-in";
    h.lastAttended = localDate(now);
    h.missedAppointmentCount = 0;
    h.updatedAt = now;
  });
  return handle.doc().households[householdId]!;
}

/**
 * Mark requests Delivered (6.3 step 4) and record fulfilled counts.
 *
 * All ids are resolved before any mutation; unknown ids throw. Idempotent:
 * duplicate ids within a call and requests that are already Delivered (a
 * double-click, a retried call) are returned unchanged without re-counting
 * or re-stamping `processingDate`. Both goods and social-service deliveries
 * feed the Fulfilled Request Count (spec 2: track fulfilled vs outstanding
 * requests). Returns the resolved rows, goods requests first.
 */
export function fulfill(
  handle: DocHandle<BamDoc>,
  ids: { requestIds?: string[]; socialServiceRequestIds?: string[] },
  now: string = nowIso()
): (RequestRow | SocialServiceRequestRow)[] {
  const doc = handle.doc();
  const requestIds = [...new Set(ids.requestIds ?? [])];
  const socialIds = [...new Set(ids.socialServiceRequestIds ?? [])];
  const missing: string[] = [];
  for (const id of requestIds) {
    if (!doc.requests[id]) missing.push(`request ${id}`);
  }
  for (const id of socialIds) {
    if (!doc.socialServiceRequests[id]) missing.push(`social service request ${id}`);
  }
  if (missing.length) throw new Error(`Unknown ids: ${missing.join(", ")}`);

  const onDate = localDate(now);
  handle.change((d) => {
    const deliver = (row: RequestRow | SocialServiceRequestRow): void => {
      if (row.status === "Delivered") return;
      applyStatusChange(row, "Delivered", now);
      const key = fulfilledCountKey(onDate, row.type);
      d.fulfilledCounts[key] = (d.fulfilledCounts[key] ?? 0) + 1;
      // A delivered request is no longer paced, and the delivery date feeds
      // the per-item cooldown (see cooldowns.ts).
      delete row.pacedUntil;
      const h = d.households[row.householdId];
      if (h) {
        if (!h.lastDeliveredByType) h.lastDeliveredByType = {};
        h.lastDeliveredByType[row.type] = onDate;
      }
      // Tracked inventory walks out the door with the delivery.
      decrementStock(d, row.type, now, "check-in");
    };
    for (const id of requestIds) deliver(d.requests[id]!);
    for (const id of socialIds) deliver(d.socialServiceRequests[id]!);
  });

  const after = handle.doc();
  return [
    ...requestIds.map((id) => after.requests[id]!),
    ...socialIds.map((id) => after.socialServiceRequests[id]!),
  ];
}

/**
 * Time out requests a present recipient DECLINES at check-in (volunteer guide
 * Step 4: "do you still need this?" → NO). Same primitive as fulfill but the
 * status is Timeout, it does NOT feed the Fulfilled Request Count (a timed-out
 * item is closed-but-unfulfilled), and it only transitions OPEN rows (an
 * already-Delivered or already-Timeout id is left untouched). Distinct from
 * the end-of-distro no-show timeout. Returns the resolved rows, goods first.
 */
export function timeout(
  handle: DocHandle<BamDoc>,
  ids: { requestIds?: string[]; socialServiceRequestIds?: string[] },
  now: string = nowIso()
): (RequestRow | SocialServiceRequestRow)[] {
  const doc = handle.doc();
  const requestIds = [...new Set(ids.requestIds ?? [])];
  const socialIds = [...new Set(ids.socialServiceRequestIds ?? [])];
  const missing: string[] = [];
  for (const id of requestIds) {
    if (!doc.requests[id]) missing.push(`request ${id}`);
  }
  for (const id of socialIds) {
    if (!doc.socialServiceRequests[id]) missing.push(`social service request ${id}`);
  }
  if (missing.length) throw new Error(`Unknown ids: ${missing.join(", ")}`);

  handle.change((d) => {
    const timeoutRow = (row: RequestRow | SocialServiceRequestRow): void => {
      if (row.status !== "Open") return;
      applyStatusChange(row, "Timeout", now);
    };
    for (const id of requestIds) timeoutRow(d.requests[id]!);
    for (const id of socialIds) timeoutRow(d.socialServiceRequests[id]!);
  });

  const after = handle.doc();
  return [
    ...requestIds.map((id) => after.requests[id]!),
    ...socialIds.map((id) => after.socialServiceRequests[id]!),
  ];
}

/** Find households by the last digits of their phone (guide Step 2: "type the
 * last 4 digits"). A triage aid returning a candidate list; non-digits are
 * stripped. Phones are stored E.164, so we match the trailing digits. */
export function searchByPhoneSuffix(doc: BamDoc, digits: string, limit = 20): Household[] {
  const suffix = (digits.match(/\d/g) ?? []).join("");
  if (!suffix) return [];
  return Object.values(doc.households)
    .filter((h) => h.phoneNumber !== undefined && h.phoneNumber.endsWith(suffix))
    .sort((a, b) => cmp(a.name ?? "", b.name ?? "") || cmp(a.id, b.id))
    .slice(0, limit);
}

/** Case-insensitive substring search on email — the recovery path when a
 * recipient's stored phone is wrong. Skips anonymized households. */
export function searchByEmail(doc: BamDoc, fragment: string): Household[] {
  const needle = fragment.trim().toLowerCase();
  if (!needle) return [];
  return Object.values(doc.households)
    .filter(
      (h) =>
        h.anonymizedAt === undefined &&
        h.email !== undefined &&
        h.email.toLowerCase().includes(needle)
    )
    .sort((a, b) => cmp(a.name ?? "", b.name ?? "") || cmp(a.id, b.id))
    .slice(0, 20);
}

/**
 * Fix a household's phone and/or email at check-in (the contact-fix cap).
 *
 * The phone goes through the same normalizer intake uses; an unparseable
 * one throws rather than storing garbage. Every change appends an audit
 * line to the household notes naming the actor and date — with only the
 * LAST FOUR digits of either phone (the notes field outlives the phone
 * fields in the PII scrub) and only the domain of a new email.
 */
export function updateContact(
  handle: DocHandle<BamDoc>,
  householdId: string,
  patch: { phoneNumber?: string; email?: string },
  actor: { peerId: string; name?: string },
  now: string = nowIso()
): Household {
  const existing = handle.doc().households[householdId];
  if (!existing) throw new Error(`Unknown household id ${householdId}`);

  const changes: string[] = [];
  let newPhone: string | undefined;
  if (patch.phoneNumber !== undefined) {
    const validation = normalizePhone(patch.phoneNumber);
    if (!validation.valid || !validation.normalized) {
      throw new Error(`invalid phone number: ${patch.phoneNumber}`);
    }
    newPhone = validation.normalized;
    const oldLast4 = existing.phoneNumber ? existing.phoneNumber.slice(-4) : "none";
    changes.push(`phone ****${oldLast4} → ****${newPhone.slice(-4)}`);
  }
  let newEmail: string | undefined;
  if (patch.email !== undefined) {
    const trimmed = patch.email.trim();
    if (!trimmed.includes("@")) {
      throw new Error(`invalid email address: ${patch.email}`);
    }
    newEmail = trimmed;
    changes.push(`email → ${trimmed.slice(trimmed.lastIndexOf("@") + 1)}`);
  }

  const who = actor.name ?? actor.peerId.slice(0, 8);
  handle.change((d) => {
    const h = d.households[householdId]!;
    if (newPhone !== undefined) {
      h.phoneNumber = newPhone;
      h.invalidPhoneNumber = false;
    }
    if (newEmail !== undefined) {
      h.email = newEmail;
      delete h.emailError;
    }
    if (changes.length) {
      const line = `[contact fixed ${localDate(now)} by ${who}: ${changes.join("; ")}]`;
      h.notes = h.notes ? `${h.notes}\n${line}` : line;
    }
    h.updatedAt = now;
  });
  return handle.doc().households[householdId]!;
}

/** Set (or clear, with note=null) the after-hours set-aside marker: items
 * were bagged for this household to pick up later. */
export function setSetAside(
  handle: DocHandle<BamDoc>,
  householdId: string,
  note: string | null,
  actor: { peerId: string; name?: string },
  now: string = nowIso()
): Household {
  if (!handle.doc().households[householdId]) {
    throw new Error(`Unknown household id ${householdId}`);
  }
  handle.change((d) => {
    const h = d.households[householdId]!;
    if (note === null) delete h.setAside;
    else h.setAside = { note, at: now, by: actor.name ?? actor.peerId.slice(0, 8) };
    h.updatedAt = now;
  });
  return handle.doc().households[householdId]!;
}

/** Toggle the needs-delivery flag (recipient can't come to the distro). */
export function setNeedsDelivery(
  handle: DocHandle<BamDoc>,
  householdId: string,
  on: boolean,
  now: string = nowIso()
): Household {
  if (!handle.doc().households[householdId]) {
    throw new Error(`Unknown household id ${householdId}`);
  }
  handle.change((d) => {
    const h = d.households[householdId]!;
    h.needsDelivery = on;
    h.updatedAt = now;
  });
  return handle.doc().households[householdId]!;
}

export interface NoShowReport {
  missedHouseholdIds: string[];
  timedOutHouseholdIds: string[];
}

/**
 * End-of-distro no-show pass (6.3 no-show sequence, A2/A3).
 *
 * Every household still Booked for `distroDate` is marked Missed with the
 * appointment cleared; once `missedAppointmentCount` reaches
 * `MAX_MISSED_APPOINTMENTS` all its open goods and social-service requests
 * time out.
 */
export function processNoShows(
  handle: DocHandle<BamDoc>,
  distroDate: string,
  now: string = nowIso()
): NoShowReport {
  const targets = Object.values(handle.doc().households)
    .filter((h) => h.appointmentStatus === "Booked" && h.appointmentDate === distroDate)
    .map((h) => h.id)
    .sort();
  const report: NoShowReport = { missedHouseholdIds: [], timedOutHouseholdIds: [] };
  if (!targets.length) return report;

  handle.change((d) => {
    for (const id of targets) {
      const h = d.households[id]!;
      h.appointmentStatus = "Missed";
      h.missedAppointmentCount += 1;
      delete h.appointmentDate;
      delete h.appointmentTime;
      h.updatedAt = now;
      report.missedHouseholdIds.push(id);
      if (h.missedAppointmentCount >= MAX_MISSED_APPOINTMENTS) {
        for (const row of Object.values(d.requests)) {
          if (row.householdId === id && row.status === "Open") {
            applyStatusChange(row, "Timeout", now);
          }
        }
        for (const row of Object.values(d.socialServiceRequests)) {
          if (row.householdId === id && row.status === "Open") {
            applyStatusChange(row, "Timeout", now);
          }
        }
        report.timedOutHouseholdIds.push(id);
      }
    }
  });
  return report;
}
