/**
 * Operator reporting: the waitlist board (what's owed, to whom, in which
 * language, for how long) and the impact report (what was delivered over a
 * period). Both are derived read-only views over the doc — nothing here
 * mutates.
 */

import type { BamDoc, Household, RequestRow, SocialServiceRequestRow } from "../schema.ts";
import { localDate, nowIso } from "../schema.ts";
import { BY_KEY, LANGUAGES, labelFor } from "./catalog.ts";
import { stockFor } from "./inventory.ts";

const DAY_MS = 86_400_000;
const SUPPORTED_LANGUAGES = new Set(LANGUAGES);

/** No overlap between the household's languages (preferred or also-speaks)
 * and the catalog's LANGUAGES; an empty language set counts as unsupported. */
function hasSupportedLanguage(h: Household): boolean {
  if (h.preferredLanguage !== undefined && SUPPORTED_LANGUAGES.has(h.preferredLanguage)) {
    return true;
  }
  return (h.languages ?? []).some((l) => SUPPORTED_LANGUAGES.has(l));
}

export interface WaitlistRow {
  type: string;
  label: string;
  category: string | null;
  /** Open rows of this type (paced rows included). */
  open: number;
  /** Open rows currently paced (pacedUntil after today) — a subset of open. */
  paced: number;
  /** Open rows by requesting household's language:
   * preferredLanguage ?? languages[0] ?? "Unknown". */
  byLanguage: { [lang: string]: number };
  /** Open rows whose household speaks no catalog-supported language. */
  unsupportedLanguage: number;
  /** Open rows bucketed by age (days since requestOpenedAt):
   * ≤30, 31–90, 91–180, older. */
  age: { d30: number; d90: number; d180: number; older: number };
  oldestOpenAt: string | null;
  /** Units on hand when the item is inventory-tracked; null = untracked. */
  stock: number | null;
}

/**
 * The waitlist: one row per type key present among OPEN goods and
 * social-service requests, sorted by open count descending.
 */
export function waitlistReport(doc: BamDoc, todayLocal: string): WaitlistRow[] {
  const rows = new Map<string, WaitlistRow>();
  const todayMs = Date.parse(`${todayLocal}T00:00:00Z`);

  const tally = (row: RequestRow | SocialServiceRequestRow): void => {
    if (row.status !== "Open") return;
    let entry = rows.get(row.type);
    if (!entry) {
      entry = {
        type: row.type,
        label: labelFor(row.type),
        category: BY_KEY[row.type]?.category ?? null,
        open: 0,
        paced: 0,
        byLanguage: {},
        unsupportedLanguage: 0,
        age: { d30: 0, d90: 0, d180: 0, older: 0 },
        oldestOpenAt: null,
        stock: stockFor(doc, row.type),
      };
      rows.set(row.type, entry);
    }
    entry.open += 1;
    if (row.pacedUntil !== undefined && row.pacedUntil > todayLocal) entry.paced += 1;

    const h = doc.households[row.householdId];
    const lang = h?.preferredLanguage ?? h?.languages[0] ?? "Unknown";
    entry.byLanguage[lang] = (entry.byLanguage[lang] ?? 0) + 1;
    if (!h || !hasSupportedLanguage(h)) entry.unsupportedLanguage += 1;

    const openedMs = Date.parse(`${localDate(row.requestOpenedAt)}T00:00:00Z`);
    const ageDays = Math.round((todayMs - openedMs) / DAY_MS);
    if (ageDays <= 30) entry.age.d30 += 1;
    else if (ageDays <= 90) entry.age.d90 += 1;
    else if (ageDays <= 180) entry.age.d180 += 1;
    else entry.age.older += 1;

    if (entry.oldestOpenAt === null || row.requestOpenedAt < entry.oldestOpenAt) {
      entry.oldestOpenAt = row.requestOpenedAt;
    }
  };

  for (const row of Object.values(doc.requests)) tally(row);
  for (const row of Object.values(doc.socialServiceRequests)) tally(row);

  return [...rows.values()].sort((a, b) => b.open - a.open || (a.type < b.type ? -1 : 1));
}

export interface ImpactReport {
  generatedAt: string;
  start: string | null;
  end: string | null;
  delivered: { [type: string]: number };
  totalDelivered: number;
}

/**
 * Deliveries per type over an inclusive YYYY-MM-DD range (a missing bound is
 * unbounded), summed from the Fulfilled Request Count entries — keys are
 * "YYYY-MM-DD|typeKey" (see schema.fulfilledCountKey).
 */
export function impactReport(
  doc: BamDoc,
  range: { start?: string; end?: string }
): ImpactReport {
  const delivered: { [type: string]: number } = {};
  let totalDelivered = 0;
  for (const [key, count] of Object.entries(doc.fulfilledCounts)) {
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    const date = key.slice(0, sep);
    const type = key.slice(sep + 1);
    if (range.start && date < range.start) continue;
    if (range.end && date > range.end) continue;
    delivered[type] = (delivered[type] ?? 0) + count;
    totalDelivered += count;
  }
  return {
    generatedAt: nowIso(),
    start: range.start ?? null,
    end: range.end ?? null,
    delivered,
    totalDelivered,
  };
}
