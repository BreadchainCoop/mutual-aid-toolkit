/**
 * Request-type catalog (port of bam/request_types.py).
 *
 * The catalog data itself lives in ../catalog.json — exported verbatim from
 * the Python catalog, whose labels mirror the production Airtable V2 base's
 * single-select options. This module rebuilds the same lookup structures:
 * `BY_KEY` for canonical keys and a segment index so `normalizeType` accepts
 * a key, a full trilingual label, any " / " language segment, or an alias
 * from either alias table (spec sections 2, 4, 9).
 *
 * Expiry windows are fixed here (14 days standard, 30 for Pots & Pans —
 * spec sections 2 and 4); there is no settings layer in the local-first
 * build, so the JSON's `expiryDays` values are authoritative.
 */

import catalogData from "../catalog.json" with { type: "json" };

export interface RequestType {
  key: string;
  label: string; // "Español / English / 中文" (production string where available)
  category: string;
  expiryDays: number;
}

export const DEFAULT_EXPIRY_DAYS = 14;
export const EXTENDED_EXPIRY_DAYS = 30;

export const GOODS: RequestType[] = catalogData.goods;
export const SOCIAL_SERVICES: RequestType[] = catalogData.socialServices;

/** Types the spec (section 9) names but the production base doesn't track. */
export const SPEC_COMPAT: RequestType[] = catalogData.specCompat;

export const ALL_TYPES: RequestType[] = [...GOODS, ...SOCIAL_SERVICES, ...SPEC_COMPAT];

export const BY_KEY: Record<string, RequestType> = Object.fromEntries(
  ALL_TYPES.map((t) => [t.key, t])
);

/** The production base's Households.Languages options, verbatim (spec
 * background section 6: 11 supported languages, plus Other). */
export const LANGUAGES: string[] = catalogData.languages;

// Segment index, first-writer-wins like the Python setdefault chain: each
// type's full lowercased label and its " / " segments, then ITEM_ALIASES,
// then LEGACY_ALIASES.
const bySegment = new Map<string, RequestType>();
for (const t of ALL_TYPES) {
  const full = t.label.toLowerCase();
  if (!bySegment.has(full)) bySegment.set(full, t);
  for (const segment of t.label.split(" / ")) {
    const s = segment.trim().toLowerCase();
    if (!bySegment.has(s)) bySegment.set(s, t);
  }
}
for (const aliases of [catalogData.itemAliases, catalogData.legacyAliases] as Record<
  string,
  string
>[]) {
  for (const [alias, key] of Object.entries(aliases)) {
    const t = BY_KEY[key];
    if (t && !bySegment.has(alias)) bySegment.set(alias, t);
  }
}

/**
 * Resolve a key, label, label segment, or alias to the canonical key.
 *
 * Trilingual inputs whose full label differs from the catalog's (an older
 * form revision, a simplified/traditional character variant) still resolve
 * if any of their segments matches a known segment or alias.
 */
export function normalizeType(value: string): string | null {
  if (!value) return null;
  const candidate = value.trim();
  if (Object.hasOwn(BY_KEY, candidate)) return candidate;
  const match = bySegment.get(candidate.toLowerCase());
  if (match) return match.key;
  for (const segment of candidate.split(" / ")) {
    const segmentMatch = bySegment.get(segment.trim().toLowerCase());
    if (segmentMatch) return segmentMatch.key;
  }
  return null;
}

export function labelFor(key: string): string {
  return BY_KEY[key]?.label ?? key;
}

/** Expiration window for a type; unknown types get the 14-day default. */
export function expiryDaysFor(key: string): number {
  return BY_KEY[key]?.expiryDays ?? DEFAULT_EXPIRY_DAYS;
}

export function isSocialService(key: string): boolean {
  return BY_KEY[key]?.category === "social_service";
}
