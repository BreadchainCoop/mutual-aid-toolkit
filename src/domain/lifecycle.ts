/**
 * Request lifecycle plumbing, auto-expiration, and PII scrubbing (ports of
 * bam/models.py apply_status_change, bam/services/expiration.py, and
 * bam/services/privacy.py).
 *
 * `applyStatusChange` centralizes the Processing Date formula (spec section
 * 4): Delivered stamps +14 days after the status change (+30 for Pots &
 * Pans, via the catalog's per-type window); Timeout always stamps +14.
 *
 * `expireStale` times out Open requests past their type's window measured
 * from `requestOpenedAt` (spec sections 2, 4, 6.1 step 7); households with
 * a Booked appointment for today or later are exempt — someone already
 * scheduled should not lose their request, but a dangling Booked status
 * from a distro whose no-show pass never ran must not make requests
 * immortal (contract rule 3).
 *
 * `scrubExpiredPii` mirrors the server's scrub (spec goal: hash sensitive
 * data; background 8), minus its third pass: there is no form-submissions
 * table in the CRDT model — intake is processed synchronously and never
 * stores the raw submission — so only the closed-request and household
 * passes apply.
 */

import type { DocHandle } from "@automerge/automerge-repo";
import type { BamDoc, RequestRow, RequestStatus, SocialServiceRequestRow } from "../schema.ts";
import { localDate, nowIso } from "../schema.ts";
import { DEFAULT_EXPIRY_DAYS, expiryDaysFor } from "./catalog.ts";

/** The expiry window for a type: the admin-set per-item policy wins, then
 * the catalog default (14 days, 30 for pots & pans). */
function windowDaysFor(doc: BamDoc, type: string): number {
  return doc.itemPolicies?.[type]?.expiryDays ?? expiryDaysFor(type);
}
import { hashPhone } from "./validation.ts";

const DAY_MS = 86_400_000;

/** YYYY-MM-DD arithmetic in UTC (business dates carry no time component). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Set a request's status plus the fields Airtable derives via formulas.
 * Must be called on a row inside a `handle.change` callback.
 */
export function applyStatusChange(
  row: RequestRow | SocialServiceRequestRow,
  status: RequestStatus,
  now: string
): void {
  row.status = status;
  row.statusLastUpdatedAt = now;
  row.updatedAt = now;
  if (status === "Delivered") {
    row.processingDate = addDays(localDate(now), expiryDaysFor(row.type));
  } else if (status === "Timeout") {
    row.processingDate = addDays(localDate(now), DEFAULT_EXPIRY_DAYS);
  } else {
    delete row.processingDate;
  }
}

export interface ExpirationReport {
  timedOutRequestIds: string[];
  timedOutSocialServiceRequestIds: string[];
}

/** Time out every Open request whose expiry window has elapsed. */
export function expireStale(handle: DocHandle<BamDoc>, now: string = nowIso()): ExpirationReport {
  const doc = handle.doc();
  const today = localDate(now);
  const nowMs = Date.parse(now);

  // Only a booking for today or later exempts a household.
  const bookedHouseholdIds = new Set(
    Object.values(doc.households)
      .filter(
        (h) =>
          h.appointmentStatus === "Booked" &&
          h.appointmentDate !== undefined &&
          h.appointmentDate >= today
      )
      .map((h) => h.id)
  );

  const timedOutRequestIds = Object.values(doc.requests)
    .filter(
      (r) =>
        r.status === "Open" &&
        !bookedHouseholdIds.has(r.householdId) &&
        nowMs - Date.parse(r.requestOpenedAt) > windowDaysFor(doc, r.type) * DAY_MS
    )
    .map((r) => r.id);

  // Social services default to the 14-day window, policy-overridable too.
  const timedOutSocialServiceRequestIds = Object.values(doc.socialServiceRequests)
    .filter(
      (r) =>
        r.status === "Open" &&
        !bookedHouseholdIds.has(r.householdId) &&
        nowMs - Date.parse(r.requestOpenedAt) >
          (doc.itemPolicies?.[r.type]?.expiryDays ?? DEFAULT_EXPIRY_DAYS) * DAY_MS
    )
    .map((r) => r.id);

  if (timedOutRequestIds.length || timedOutSocialServiceRequestIds.length) {
    handle.change((d) => {
      for (const id of timedOutRequestIds) applyStatusChange(d.requests[id]!, "Timeout", now);
      for (const id of timedOutSocialServiceRequestIds) {
        applyStatusChange(d.socialServiceRequests[id]!, "Timeout", now);
      }
    });
  }
  return { timedOutRequestIds, timedOutSocialServiceRequestIds };
}

export interface ScrubReport {
  requestsScrubbed: number;
  socialServiceRequestsScrubbed: number;
  householdsAnonymized: number;
}

const REQUEST_PII_FIELDS = [
  "streetAddress",
  "cityState",
  "zipCode",
  "geocode",
  "address",
  "notes",
] as const;
const SOCIAL_REQUEST_PII_FIELDS = [
  "streetAddress",
  "cityState",
  "zipCode",
  "address",
  "notes",
] as const;
const HOUSEHOLD_PII_FIELDS = ["phoneNumber", "name", "email", "emailError", "notes"] as const;

function deleteFields<T extends object>(obj: T, fields: readonly (keyof T)[]): void {
  for (const field of fields) {
    if (obj[field] !== undefined) delete obj[field];
  }
}

/**
 * Scrub PII whose retention window has expired; return the counts.
 *
 * Pass 1: closed (Delivered/Timeout) requests of both kinds whose
 * `processingDate` has passed lose their address fields and notes (social
 * rows also lose `internetAccess`). Pass 2: households with no open rows of
 * either kind and `updatedAt` older than the retention window are
 * anonymized, keeping only `phoneHash` (hashing the stored phone first if
 * the hash is missing — the reason this function is async) so a re-request
 * from the same phone reconnects to its history.
 */
export async function scrubExpiredPii(
  handle: DocHandle<BamDoc>,
  now: string = nowIso(),
  retentionDays = 30
): Promise<ScrubReport> {
  const doc = handle.doc();
  const today = localDate(now);
  const cutoffMs = Date.parse(now) - retentionDays * DAY_MS;

  const closedPast = (r: RequestRow | SocialServiceRequestRow): boolean =>
    (r.status === "Delivered" || r.status === "Timeout") &&
    r.processingDate !== undefined &&
    r.processingDate < today;

  const requestIds = Object.values(doc.requests)
    .filter((r) => closedPast(r) && REQUEST_PII_FIELDS.some((f) => r[f] !== undefined))
    .map((r) => r.id);
  const socialIds = Object.values(doc.socialServiceRequests)
    .filter(
      (r) =>
        closedPast(r) &&
        (SOCIAL_REQUEST_PII_FIELDS.some((f) => r[f] !== undefined) || r.internetAccess.length > 0)
    )
    .map((r) => r.id);

  const openHouseholdIds = new Set([
    ...Object.values(doc.requests)
      .filter((r) => r.status === "Open")
      .map((r) => r.householdId),
    ...Object.values(doc.socialServiceRequests)
      .filter((r) => r.status === "Open")
      .map((r) => r.householdId),
  ]);

  const anonymize: { id: string; phoneHash?: string }[] = [];
  for (const h of Object.values(doc.households)) {
    if (h.anonymizedAt !== undefined) continue;
    if (openHouseholdIds.has(h.id)) continue;
    if (Date.parse(h.updatedAt) >= cutoffMs) continue;
    if (h.phoneNumber && !h.phoneHash) {
      // Also hashes raw invalid-phone strings so reconnection stays possible.
      anonymize.push({ id: h.id, phoneHash: await hashPhone(h.phoneNumber) });
    } else {
      anonymize.push({ id: h.id });
    }
  }

  if (requestIds.length || socialIds.length || anonymize.length) {
    handle.change((d) => {
      for (const id of requestIds) {
        const row = d.requests[id]!;
        deleteFields(row, REQUEST_PII_FIELDS);
        row.updatedAt = now;
      }
      for (const id of socialIds) {
        const row = d.socialServiceRequests[id]!;
        deleteFields(row, SOCIAL_REQUEST_PII_FIELDS);
        if (row.internetAccess.length > 0) row.internetAccess = [];
        row.updatedAt = now;
      }
      for (const entry of anonymize) {
        const h = d.households[entry.id]!;
        if (entry.phoneHash) h.phoneHash = entry.phoneHash;
        deleteFields(h, HOUSEHOLD_PII_FIELDS);
        h.anonymizedAt = now;
        h.updatedAt = now;
      }
    });
  }

  return {
    requestsScrubbed: requestIds.length,
    socialServiceRequestsScrubbed: socialIds.length,
    householdsAnonymized: anonymize.length,
  };
}
