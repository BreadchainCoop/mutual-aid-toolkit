/**
 * Per-item cooldown and seasonal policy (the pacing layer over intake).
 *
 * Policies live in `BamDoc.itemPolicies`, keyed by catalog type key, and are
 * consulted at intake time: a `disabled` or out-of-season item is not created
 * at all, while a re-request inside `cooldownDays` of the household's last
 * DELIVERY of that type is created but stamped `pacedUntil` so outreach can
 * hold it until the date passes. A first request is never paced — pacing only
 * keys off `Household.lastDeliveredByType`, which `fulfill` stamps.
 */

import type { DocHandle } from "@automerge/automerge-repo";
import type { BamDoc, ItemPolicy } from "../schema.ts";
import { addDays } from "./lifecycle.ts";

/** The policy for a catalog type key, if one has been configured. */
export function itemPolicyFor(doc: BamDoc, typeKey: string): ItemPolicy | undefined {
  return doc.itemPolicies?.[typeKey];
}

/**
 * Whether `todayLocal` (YYYY-MM-DD) falls inside the policy's seasonal
 * window. The window is MM-DD, inclusive on both ends; a missing boundary
 * means always in season. When `seasonFrom > seasonUntil` the window wraps
 * the year boundary (e.g. 12-01 → 02-28 covers December through February).
 */
export function isInSeason(policy: ItemPolicy | undefined, todayLocal: string): boolean {
  const from = policy?.seasonFrom;
  const until = policy?.seasonUntil;
  if (!from || !until) return true;
  const today = todayLocal.slice(5); // MM-DD
  if (from <= until) return today >= from && today <= until;
  return today >= from || today <= until;
}

/** Hard off-switch: the item is hidden from intake entirely. */
export function isDisabled(policy: ItemPolicy | undefined): boolean {
  return policy?.disabled === true;
}

/**
 * The date (YYYY-MM-DD) a new request of `typeKey` should be paced until,
 * or null when it should enter outreach immediately: no delivery on record
 * (a FIRST request is never paced), no `cooldownDays` configured, or the
 * cooldown already elapsed.
 */
export function cooldownUntil(
  doc: BamDoc,
  householdId: string,
  typeKey: string,
  todayLocal: string
): string | null {
  const days = itemPolicyFor(doc, typeKey)?.cooldownDays;
  if (!days || days <= 0) return null;
  const lastDelivered = doc.households[householdId]?.lastDeliveredByType?.[typeKey];
  if (!lastDelivered) return null;
  const until = addDays(lastDelivered, days);
  return until > todayLocal ? until : null;
}

/**
 * Merge a patch into `doc.itemPolicies[typeKey]`, creating the map and the
 * entry as needed. A null (or explicit undefined) patch value DELETES that
 * key; keys absent from the patch are left alone. An entry that ends up
 * empty is removed entirely.
 */
export function setItemPolicy(
  handle: DocHandle<BamDoc>,
  typeKey: string,
  patch: {
    cooldownDays?: number | null;
    seasonFrom?: string | null;
    seasonUntil?: string | null;
    disabled?: boolean | null;
  }
): void {
  handle.change((d) => {
    if (!d.itemPolicies) d.itemPolicies = {};
    if (!d.itemPolicies[typeKey]) d.itemPolicies[typeKey] = {};
    const entry = d.itemPolicies[typeKey]!;
    const apply = <K extends keyof ItemPolicy>(
      key: K,
      value: ItemPolicy[K] | null | undefined
    ): void => {
      if (!(key in patch)) return;
      if (value === null || value === undefined) delete entry[key];
      else entry[key] = value;
    };
    apply("cooldownDays", patch.cooldownDays);
    apply("seasonFrom", patch.seasonFrom);
    apply("seasonUntil", patch.seasonUntil);
    apply("disabled", patch.disabled);
    if (Object.keys(entry).length === 0) delete d.itemPolicies[typeKey];
  });
}
