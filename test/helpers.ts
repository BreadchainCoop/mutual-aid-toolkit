/** Shared test helpers: an offline store per test + row factories. */

import { MemorySigner } from "@automerge/automerge-subduction";
import type { DocHandle } from "@automerge/automerge-repo";
import { openStore, type BamStore } from "../src/store.ts";
import type { BamDoc, Household, RequestRow } from "../src/schema.ts";
import { newId, nowIso } from "../src/schema.ts";

/** Automerge rejects explicit `undefined` values; drop them before insert. */
function compact<T extends object>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).filter(([, v]) => v !== undefined)
  ) as T;
}

export const FIXED_NOW = "2026-07-01T12:00:00.000Z";
export const TODAY = "2026-07-01"; // localDate(FIXED_NOW) in America/New_York

export function daysAgo(n: number, from: string = FIXED_NOW): string {
  return new Date(new Date(from).getTime() - n * 86_400_000).toISOString();
}

export async function freshStore(): Promise<BamStore> {
  const signer = MemorySigner.generate();
  return openStore({
    signer,
    endpoints: [],
    createOrg: "BAM Test",
    deviceName: "test device",
  });
}

let phoneCounter = 100;

export function makeHousehold(
  handle: DocHandle<BamDoc>,
  overrides: Partial<Household> = {}
): Household {
  const n = phoneCounter++;
  const id = newId();
  const now = nowIso();
  const row: Household = {
    id,
    name: `Household ${n}`,
    phoneNumber: `+1718555${String(n).padStart(4, "0")}`,
    invalidPhoneNumber: false,
    intlPhoneNumber: false,
    languages: ["Inglés / English / 英文"],
    missedAppointmentCount: 0,
    needsDelivery: false,
    needsEmailOutreach: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  handle.change((d) => {
    d.households[id] = compact(row);
  });
  return handle.doc().households[id]!;
}

export function makeRequest(
  handle: DocHandle<BamDoc>,
  householdId: string,
  overrides: Partial<RequestRow> = {}
): RequestRow {
  const id = newId();
  const now = nowIso();
  const row: RequestRow = {
    id,
    type: "soap",
    householdId,
    status: "Open",
    requestOpenedAt: now,
    statusLastUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  handle.change((d) => {
    d.requests[id] = compact(row);
  });
  return handle.doc().requests[id]!;
}
