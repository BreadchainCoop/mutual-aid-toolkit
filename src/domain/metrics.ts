/**
 * Metrics (spec 5 + the Fulfilled Request Count table), ported from
 * bam/services/metrics.py. `fulfilledCounts` in the doc is keyed
 * "YYYY-MM-DD|typeKey" (see schema.fulfilledCountKey).
 */

import type { BamDoc } from "../schema.ts";
import { nowIso } from "../schema.ts";
import { labelFor } from "./catalog.ts";

export interface TypeCount {
  type: string;
  label: string;
  count: number;
}

export interface OpenRequestCounts {
  generatedAt: string;
  counts: TypeCount[];
}

/**
 * Open request counts per type, goods and social services combined —
 * the payload of the hourly `UpdateWebsiteRequestData` job (spec 5).
 */
export function openRequestCounts(doc: BamDoc, now: string = nowIso()): OpenRequestCounts {
  const totals = new Map<string, number>();
  for (const req of Object.values(doc.requests)) {
    if (req.status === "Open") totals.set(req.type, (totals.get(req.type) ?? 0) + 1);
  }
  for (const req of Object.values(doc.socialServiceRequests)) {
    if (req.status === "Open") totals.set(req.type, (totals.get(req.type) ?? 0) + 1);
  }
  const counts = [...totals.entries()]
    .map(([type, count]) => ({ type, label: labelFor(type), count }))
    .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
  return { generatedAt: now, counts };
}

export interface FulfilledCountRow {
  date: string;
  type: string;
  label: string;
  count: number;
}

/** Fulfilled counts per (date, type), optionally bounded, dates inclusive. */
export function fulfilledCountsRange(
  doc: BamDoc,
  range: { start?: string; end?: string } = {}
): FulfilledCountRow[] {
  const rows: FulfilledCountRow[] = [];
  for (const [key, count] of Object.entries(doc.fulfilledCounts)) {
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    const date = key.slice(0, sep);
    const type = key.slice(sep + 1);
    if (range.start && date < range.start) continue;
    if (range.end && date > range.end) continue;
    rows.push({ date, type, label: labelFor(type), count });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.type < b.type ? -1 : 1));
  return rows;
}
