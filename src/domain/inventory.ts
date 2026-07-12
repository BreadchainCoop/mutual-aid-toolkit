/**
 * Inventory — what's actually on the shelves.
 *
 * Two layers over the base doc:
 * - `inventory`: live per-item stock levels. A missing key means the item
 *   isn't tracked (assume available); 0 means tracked and OUT.
 * - `inventoryLog`: post-distro count history — the structured version of
 *   the "POST DISTRO INVENTORY" message volunteers used to type into chat.
 *
 * Check-in fulfillment decrements tracked items automatically (see
 * checkin.fulfill), and outreach can filter to in-stock items only, so
 * nobody gets texted about something that isn't on the shelf.
 */

import type { DocHandle } from "@automerge/automerge-repo";
import type { BamDoc, InventoryCount } from "../schema.ts";
import { newId, nowIso } from "../schema.ts";
import { normalizeType } from "./catalog.ts";

export interface RecordCountInput {
  /** The distro/count date (YYYY-MM-DD). */
  date: string;
  /** Catalog type key (or any label segment) → units on hand. */
  counts: { [type: string]: number };
  notes?: string;
}

/** Record a post-distro count: writes the log entry AND updates the live
 * stock levels for every counted item. */
export function recordInventoryCount(
  handle: DocHandle<BamDoc>,
  input: RecordCountInput,
  actor: { peerId: string; name?: string },
  now: string = nowIso()
): InventoryCount {
  const normalized: { [key: string]: number } = {};
  for (const [rawType, rawCount] of Object.entries(input.counts)) {
    const key = normalizeType(rawType) ?? rawType;
    const count = Math.max(0, Math.round(Number(rawCount)));
    if (Number.isFinite(count)) normalized[key] = count;
  }
  if (!Object.keys(normalized).length) {
    throw new Error("Count at least one item.");
  }
  const id = newId();
  const by = actor.name ?? actor.peerId.slice(0, 8);
  handle.change((d) => {
    if (!d.inventoryLog) d.inventoryLog = {};
    const entry: InventoryCount = {
      id,
      date: input.date,
      by,
      counts: { ...normalized },
      createdAt: now,
    };
    if (input.notes && input.notes.trim()) entry.notes = input.notes.trim();
    d.inventoryLog[id] = entry;
    if (!d.inventory) d.inventory = {};
    for (const [key, count] of Object.entries(normalized)) {
      d.inventory[key] = { onHand: count, updatedAt: now, updatedBy: by };
    }
  });
  return handle.doc().inventoryLog![id]!;
}

/** Quick single-item adjustment ("we just got a soap donation"). */
export function setStockLevel(
  handle: DocHandle<BamDoc>,
  type: string,
  onHand: number,
  actor: { peerId: string; name?: string },
  now: string = nowIso()
): void {
  const key = normalizeType(type) ?? type;
  const by = actor.name ?? actor.peerId.slice(0, 8);
  handle.change((d) => {
    if (!d.inventory) d.inventory = {};
    if (onHand < 0) {
      delete d.inventory[key]; // negative = stop tracking this item
    } else {
      d.inventory[key] = { onHand: Math.round(onHand), updatedAt: now, updatedBy: by };
    }
  });
}

/** Units on hand for a type — null when untracked (assume available). */
export function stockFor(doc: BamDoc, type: string): number | null {
  const entry = doc.inventory?.[type];
  return entry ? entry.onHand : null;
}

/** Tracked-and-out item keys (stock === 0) — what outreach should skip. */
export function outOfStockTypes(doc: BamDoc): Set<string> {
  const out = new Set<string>();
  for (const [key, entry] of Object.entries(doc.inventory ?? {})) {
    if (entry.onHand === 0) out.add(key);
  }
  return out;
}

/** Decrement a tracked item after a delivery (floor 0). Call inside a
 * handle.change — used by checkin.fulfill. */
export function decrementStock(d: BamDoc, type: string, now: string, by: string): void {
  const entry = d.inventory?.[type];
  if (!entry) return;
  entry.onHand = Math.max(0, entry.onHand - 1);
  entry.updatedAt = now;
  entry.updatedBy = by;
}

/** The count history, newest first. */
export function inventoryHistory(doc: BamDoc, limit = 10): InventoryCount[] {
  return Object.values(doc.inventoryLog ?? {})
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}
