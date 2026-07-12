/**
 * Delivery dispatch board — doorstep deliveries as claimable tasks.
 *
 * The pattern that worked at Crown Heights (post a delivery, a volunteer
 * with a vehicle claims it), rebuilt on our shift-slot mechanics: tasks live
 * in the distros doc (same grantable access domain), claims are keyed by
 * device so they merge cleanly, and volunteer vehicle profiles drive the
 * "fits you" matching in the UI.
 */

import type { DocHandle } from "@automerge/automerge-repo";
import type { DeliveryTask, DistrosDoc } from "../schema.ts";
import { newId, nowIso } from "../schema.ts";

export interface CreateDeliveryInput {
  items: string;
  householdId?: string;
  householdName?: string;
  phone?: string;
  address?: string;
  notes?: string;
}

export function createDelivery(
  handle: DocHandle<DistrosDoc>,
  input: CreateDeliveryInput,
  actor: string,
  now: string = nowIso()
): DeliveryTask {
  if (!input.items.trim()) throw new Error("Say what's being delivered.");
  const id = newId();
  handle.change((d) => {
    if (!d.deliveries) d.deliveries = {};
    const task: DeliveryTask = {
      id,
      items: input.items.trim(),
      status: "Open",
      createdBy: actor,
      createdAt: now,
    };
    if (input.householdId) task.householdId = input.householdId;
    if (input.householdName?.trim()) task.householdName = input.householdName.trim();
    if (input.phone?.trim()) task.phone = input.phone.trim();
    if (input.address?.trim()) task.address = input.address.trim();
    if (input.notes?.trim()) task.notes = input.notes.trim();
    d.deliveries[id] = task;
  });
  return handle.doc().deliveries![id]!;
}

function mustGet(handle: DocHandle<DistrosDoc>, id: string): DeliveryTask {
  const task = handle.doc().deliveries?.[id];
  if (!task) throw new Error(`No delivery task ${id}`);
  return task;
}

export class DeliveryTakenError extends Error {
  constructor() {
    super("Someone already claimed this delivery.");
    this.name = "DeliveryTakenError";
  }
}

/** A volunteer takes the delivery. Idempotent for the same claimant. */
export function claimDelivery(
  handle: DocHandle<DistrosDoc>,
  id: string,
  claimant: { peerId: string; name: string },
  now: string = nowIso()
): DeliveryTask {
  const task = mustGet(handle, id);
  if (task.status === "Delivered") throw new Error("That delivery is already done.");
  if (task.status === "Claimed" && task.claimedBy?.peerId !== claimant.peerId) {
    throw new DeliveryTakenError();
  }
  handle.change((d) => {
    const t = d.deliveries![id]!;
    t.status = "Claimed";
    t.claimedBy = { peerId: claimant.peerId, name: claimant.name, at: now };
  });
  return mustGet(handle, id);
}

/** Hand a claimed delivery back to the board. */
export function releaseDelivery(
  handle: DocHandle<DistrosDoc>,
  id: string,
  peerId: string
): DeliveryTask {
  const task = mustGet(handle, id);
  if (task.status !== "Claimed" || task.claimedBy?.peerId !== peerId) return task;
  handle.change((d) => {
    const t = d.deliveries![id]!;
    t.status = "Open";
    delete t.claimedBy;
  });
  return mustGet(handle, id);
}

/** Mark it delivered (the claimant, or an admin wrapping up). */
export function completeDelivery(
  handle: DocHandle<DistrosDoc>,
  id: string,
  now: string = nowIso()
): DeliveryTask {
  mustGet(handle, id);
  handle.change((d) => {
    const t = d.deliveries![id]!;
    t.status = "Delivered";
    t.deliveredAt = now;
  });
  return mustGet(handle, id);
}

export function removeDelivery(handle: DocHandle<DistrosDoc>, id: string): void {
  mustGet(handle, id);
  handle.change((d) => {
    delete d.deliveries![id];
  });
}

/** Board listing: open first, then claimed, then recent done (capped). */
export function listDeliveries(
  doc: DistrosDoc | undefined,
  opts: { doneLimit?: number } = {}
): DeliveryTask[] {
  const all = Object.values(doc?.deliveries ?? {});
  const rank = { Open: 0, Claimed: 1, Delivered: 2 } as const;
  const sorted = all.sort(
    (a, b) => rank[a.status] - rank[b.status] || (a.createdAt < b.createdAt ? -1 : 1)
  );
  const doneLimit = opts.doneLimit ?? 5;
  let doneSeen = 0;
  return sorted.filter((t) => (t.status !== "Delivered" ? true : ++doneSeen <= doneLimit));
}
