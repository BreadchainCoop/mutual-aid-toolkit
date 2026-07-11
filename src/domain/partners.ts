/**
 * Partner-org fulfillment sync (the status × partner model).
 *
 * Households get referred out to partner orgs (a furniture bank, a mesh
 * installer, a legal clinic); the partner later reports back a list of phone
 * numbers it delivered to — or gave up on. `partnerSyncByPhone` matches those
 * phones to households and closes their open rows exactly the way check-in
 * does: same `applyStatusChange` status/processing-date stamps, same
 * Fulfilled Request Count bump on Delivered (see checkin.ts `fulfill`), plus
 * an audit line on the row notes, the partner attribution on social-service
 * rows, and the per-type `lastDeliveredByType` stamp that drives item
 * cooldowns.
 */

import type { DocHandle } from "@automerge/automerge-repo";
import type { BamDoc, RequestRow, SocialServiceRequestRow } from "../schema.ts";
import { fulfilledCountKey, localDate, nowIso } from "../schema.ts";
import { normalizeType } from "./catalog.ts";
import { applyStatusChange } from "./lifecycle.ts";
import { normalizePhone } from "./validation.ts";

export interface PartnerSyncInput {
  partner: string;
  phones: string[];
  outcome: "Delivered" | "Timeout";
  /** Restrict to these catalog type keys (default: every open row). */
  types?: string[];
  includeGoods?: boolean; // default true
  includeServices?: boolean; // default true
  /** Compute the identical report with zero mutations. */
  dryRun?: boolean;
}

export interface PartnerSyncReport {
  matchedHouseholdIds: string[];
  closedRequestIds: string[];
  closedSocialServiceRequestIds: string[];
  unmatchedPhones: string[];
}

/** Trailing 10 digits of a phone in any formatting (US national number). */
function lastTenDigits(phone: string): string {
  return (phone.match(/\d/g) ?? []).join("").slice(-10);
}

/**
 * Apply a partner's fulfillment report. Each input phone is normalized to
 * E.164 and matched against household phone numbers exactly, falling back to
 * a last-10-digits comparison (partner exports rarely agree on formatting);
 * phones that match nothing land in `unmatchedPhones`. Every OPEN row of the
 * requested scopes/types on a matched household is closed with
 * `input.outcome`.
 */
export function partnerSyncByPhone(
  handle: DocHandle<BamDoc>,
  input: PartnerSyncInput,
  now: string = nowIso()
): PartnerSyncReport {
  const doc = handle.doc();
  const includeGoods = input.includeGoods !== false;
  const includeServices = input.includeServices !== false;
  const typeFilter = input.types?.length
    ? new Set(input.types.map((t) => normalizeType(t) ?? t))
    : null;
  const today = localDate(now);
  const households = Object.values(doc.households);

  const report: PartnerSyncReport = {
    matchedHouseholdIds: [],
    closedRequestIds: [],
    closedSocialServiceRequestIds: [],
    unmatchedPhones: [],
  };

  const matched = new Set<string>();
  for (const phone of input.phones) {
    const lookup = normalizePhone(phone).normalized ?? phone;
    let household = households.find((h) => h.phoneNumber === lookup);
    if (!household) {
      const suffix = lastTenDigits(lookup);
      if (suffix.length === 10) {
        household = households.find(
          (h) => h.phoneNumber !== undefined && lastTenDigits(h.phoneNumber) === suffix
        );
      }
    }
    if (!household) {
      report.unmatchedPhones.push(phone);
      continue;
    }
    if (!matched.has(household.id)) {
      matched.add(household.id);
      report.matchedHouseholdIds.push(household.id);
    }
  }

  const closable = (row: RequestRow | SocialServiceRequestRow): boolean =>
    row.status === "Open" &&
    matched.has(row.householdId) &&
    (!typeFilter || typeFilter.has(row.type));

  if (includeGoods) {
    for (const row of Object.values(doc.requests)) {
      if (closable(row)) report.closedRequestIds.push(row.id);
    }
  }
  if (includeServices) {
    for (const row of Object.values(doc.socialServiceRequests)) {
      if (closable(row)) report.closedSocialServiceRequestIds.push(row.id);
    }
  }

  const nothingToClose =
    !report.closedRequestIds.length && !report.closedSocialServiceRequestIds.length;
  if (input.dryRun || nothingToClose) return report;

  const noteLine = `[${input.partner} sync ${today}: ${input.outcome}]`;
  handle.change((d) => {
    const close = (row: RequestRow | SocialServiceRequestRow): void => {
      applyStatusChange(row, input.outcome, now);
      row.notes = row.notes ? `${row.notes}\n${noteLine}` : noteLine;
      if (input.outcome === "Delivered") {
        const key = fulfilledCountKey(today, row.type);
        d.fulfilledCounts[key] = (d.fulfilledCounts[key] ?? 0) + 1;
        const h = d.households[row.householdId];
        if (h) {
          if (!h.lastDeliveredByType) h.lastDeliveredByType = {};
          h.lastDeliveredByType[row.type] = today;
          h.updatedAt = now;
        }
      }
    };
    for (const id of report.closedRequestIds) close(d.requests[id]!);
    for (const id of report.closedSocialServiceRequestIds) {
      const row = d.socialServiceRequests[id]!;
      close(row);
      row.partnerOrg = input.partner;
    }
  });
  return report;
}

/** Attribute (or, with null, un-attribute) a social-service request to a
 * partner org — the manual half of the status × partner model. */
export function setPartnerOrg(
  handle: DocHandle<BamDoc>,
  socialServiceRequestId: string,
  partner: string | null,
  now: string = nowIso()
): void {
  if (!handle.doc().socialServiceRequests[socialServiceRequestId]) {
    throw new Error(`Unknown social service request ${socialServiceRequestId}`);
  }
  handle.change((d) => {
    const row = d.socialServiceRequests[socialServiceRequestId]!;
    if (partner === null) {
      if (row.partnerOrg !== undefined) delete row.partnerOrg;
    } else {
      row.partnerOrg = partner;
    }
    row.updatedAt = now;
  });
}
