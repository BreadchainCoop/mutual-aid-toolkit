/**
 * Intake processing (port of bam/services/intake.py, spec section 6.1).
 *
 * Turns a raw form submission into `Household`, `RequestRow` and
 * `SocialServiceRequestRow` records: phone/email validation, household
 * matching (including anonymized-household reconnection via `phoneHash`),
 * request-type normalization with open-request dedup, and furniture
 * delivery addresses.
 *
 * Divergence from the server build: there is no form-submissions table —
 * intake is processed synchronously against the CRDT, nothing raw is
 * stored — so the server's prior-submission fallback for dedup of
 * invalid-phone households (CONTRACT intake bullet 2) does not apply here;
 * invalid phones still dedup and reconnect via the raw-string `phoneHash`.
 */

import type { DocHandle } from "@automerge/automerge-repo";
import type { BamDoc, Household, RequestRow, SocialServiceRequestRow } from "../schema.ts";
import { newId, nowIso } from "../schema.ts";
import { BY_KEY, isSocialService, normalizeType } from "./catalog.ts";
import { hashPhone, normalizePhone, validateEmail } from "./validation.ts";

/** Types whose requests get the form's bed details appended to their notes. */
const BED_DETAIL_TYPES = new Set(
  Object.keys(BY_KEY).filter(
    (key) =>
      key.includes("mattress") || key.includes("bed") || key === "crib" || key === "furniture"
  )
);

export interface IntakePayload {
  phoneNumber: string;
  name?: string;
  email?: string;
  languages?: string[];
  requestTypes?: string[];
  furnitureItems?: string[];
  bedDetails?: string[];
  kitchenItems?: string[];
  socialServiceRequests?: string[];
  internetAccess?: string[];
  roofAccessible?: boolean;
  notes?: string;
  streetAddress?: string;
  cityState?: string;
  zipCode?: string;
}

export interface IntakeResult {
  householdId: string;
  createdHousehold: boolean;
  createdRequestIds: string[];
  createdSocialServiceRequestIds: string[];
  skippedDuplicateTypes: string[];
  unknownTypes: string[];
  phoneValid: boolean;
}

function findHousehold(
  doc: BamDoc,
  predicate: (h: Household) => boolean
): Household | undefined {
  for (const h of Object.values(doc.households)) {
    if (predicate(h)) return h;
  }
  return undefined;
}

function appendUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}

function appendNote(existing: string | undefined, note: string): string {
  return existing ? `${existing}\n${note}` : note;
}

function hasOpen(
  rows: { [id: string]: RequestRow } | { [id: string]: SocialServiceRequestRow },
  householdId: string,
  typeKey: string
): boolean {
  return Object.values(rows).some(
    (r) => r.householdId === householdId && r.type === typeKey && r.status === "Open"
  );
}

/**
 * Process one submission (spec 6.1 steps 3-7).
 *
 * Creates or updates the household, creates one Open `RequestRow` per
 * normalized goods type and one Open `SocialServiceRequestRow` per
 * normalized social-service type, skipping types the household already has
 * Open (interpretation decision 2). Async because phone hashing goes
 * through WebCrypto.
 */
export async function submitIntake(
  handle: DocHandle<BamDoc>,
  payload: IntakePayload,
  now: string = nowIso()
): Promise<IntakeResult> {
  const doc = handle.doc();
  const phone = normalizePhone(payload.phoneNumber);
  const email = validateEmail(payload.email);
  const rawPhone = (payload.phoneNumber ?? "").trim();
  const normalizedHash =
    phone.valid && phone.normalized ? await hashPhone(phone.normalized) : null;
  const rawHash = !phone.valid && rawPhone ? await hashPhone(rawPhone) : null;

  let existing: Household | undefined;
  let reconnect = false;
  if (phone.valid && phone.normalized) {
    existing = findHousehold(doc, (h) => h.phoneNumber === phone.normalized);
    if (!existing && normalizedHash) {
      // Anonymized household reconnection: the scrub kept phoneHash so a
      // re-request from the same phone restores the history.
      existing = findHousehold(doc, (h) => h.phoneHash === normalizedHash);
      if (existing) reconnect = true;
    }
  } else if (rawHash) {
    // Invalid phone: the household stores no phone. Dedup matches the hash
    // of the raw string (set at creation, preserved by the PII scrub).
    existing = findHousehold(doc, (h) => h.phoneHash === rawHash);
    if (existing) reconnect = true;
  }

  const createdHousehold = existing === undefined;
  const householdId = existing?.id ?? newId();

  // Classify types up front (pure — the change callback must stay sync).
  const unknownTypes: string[] = [];
  const goodsKeys: string[] = [];
  for (const value of [
    ...(payload.requestTypes ?? []),
    ...(payload.kitchenItems ?? []),
    ...(payload.furnitureItems ?? []),
  ]) {
    const key = normalizeType(value);
    // Social-service types belong in the socialServiceRequests table; one
    // appearing in a goods field is malformed input and is reported rather
    // than silently landing in the wrong table (spec 6.1 diagram).
    if (key === null || isSocialService(key)) appendUnique(unknownTypes, value);
    else if (!goodsKeys.includes(key)) goodsKeys.push(key);
  }
  const socialKeys: string[] = [];
  for (const value of payload.socialServiceRequests ?? []) {
    const key = normalizeType(value);
    if (key === null || !isSocialService(key)) {
      appendUnique(unknownTypes, value);
      continue;
    }
    if (!socialKeys.includes(key)) socialKeys.push(key);
  }

  const addressParts = [payload.streetAddress, payload.cityState, payload.zipCode];
  const address = addressParts.filter((part) => part).join(", ") || undefined;

  const createdRequestIds: string[] = [];
  const createdSocialServiceRequestIds: string[] = [];
  const skippedDuplicateTypes: string[] = [];

  handle.change((d) => {
    if (createdHousehold) {
      // Invalid phones store no phoneNumber but do get a hash of the raw
      // string so dedup and post-scrub reconnection stay possible.
      const h: Household = {
        id: householdId,
        invalidPhoneNumber: !phone.valid,
        intlPhoneNumber: phone.international,
        languages: [...(payload.languages ?? [])],
        missedAppointmentCount: 0,
        needsDelivery: false,
        needsEmailOutreach: false,
        createdAt: now,
        updatedAt: now,
      };
      if (payload.name) h.name = payload.name;
      if (phone.valid && phone.normalized) h.phoneNumber = phone.normalized;
      const hash = normalizedHash ?? rawHash;
      if (hash) h.phoneHash = hash;
      if (email.normalized) h.email = email.normalized;
      if (email.error) h.emailError = email.error;
      d.households[householdId] = h;
    } else {
      const h = d.households[householdId]!;
      if (reconnect) {
        if (phone.valid && phone.normalized) h.phoneNumber = phone.normalized;
        delete h.anonymizedAt;
      }
      if (payload.name) h.name = payload.name;
      if (payload.email) {
        // A typo in a re-request must not erase the last known-good email;
        // record the error and keep the old address.
        if (email.error) h.emailError = email.error;
        else delete h.emailError;
        if (email.normalized) h.email = email.normalized;
      }
      for (const language of payload.languages ?? []) {
        if (!h.languages.includes(language)) h.languages.push(language);
      }
      h.invalidPhoneNumber = !phone.valid;
      h.intlPhoneNumber = phone.international;
      if (normalizedHash) h.phoneHash = normalizedHash;
      h.updatedAt = now;
    }

    for (const key of goodsKeys) {
      if (hasOpen(d.requests, householdId, key)) {
        appendUnique(skippedDuplicateTypes, key);
        continue;
      }
      const id = newId();
      const row: RequestRow = {
        id,
        type: key,
        householdId,
        status: "Open",
        requestOpenedAt: now,
        statusLastUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      if (BY_KEY[key]?.category === "furniture") {
        if (payload.streetAddress) row.streetAddress = payload.streetAddress;
        if (payload.cityState) row.cityState = payload.cityState;
        if (payload.zipCode) row.zipCode = payload.zipCode;
        if (address) row.address = address;
        // Keep item-level detail (Sofa, Dresser, ...) with the request so
        // the furniture team sees what was asked for, not just the type.
        if (key === "furniture" && payload.furnitureItems?.length) {
          row.notes = appendNote(row.notes, payload.furnitureItems.join("; "));
        }
      }
      if (BED_DETAIL_TYPES.has(key) && payload.bedDetails?.length) {
        row.notes = appendNote(row.notes, payload.bedDetails.join("; "));
      }
      d.requests[id] = row;
      createdRequestIds.push(id);
    }

    for (const key of socialKeys) {
      if (hasOpen(d.socialServiceRequests, householdId, key)) {
        appendUnique(skippedDuplicateTypes, key);
        continue;
      }
      const id = newId();
      const row: SocialServiceRequestRow = {
        id,
        type: key,
        householdId,
        status: "Open",
        internetAccess: [...(payload.internetAccess ?? [])],
        roofAccessible: payload.roofAccessible ?? false,
        requestOpenedAt: now,
        statusLastUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      if (payload.streetAddress) row.streetAddress = payload.streetAddress;
      if (payload.cityState) row.cityState = payload.cityState;
      if (payload.zipCode) row.zipCode = payload.zipCode;
      if (address) row.address = address;
      d.socialServiceRequests[id] = row;
      createdSocialServiceRequestIds.push(id);
    }
  });

  return {
    householdId,
    createdHousehold,
    createdRequestIds,
    createdSocialServiceRequestIds,
    skippedDuplicateTypes,
    unknownTypes,
    phoneValid: phone.valid,
  };
}
