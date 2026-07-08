/**
 * Migration of the production Airtable V2 base into the base doc.
 *
 * Reads the snapshot directory written by the server implementation's
 * `bam import-airtable` (see ../../bam/airtable.py `dump_snapshot`): one JSON
 * file per table, each an array of raw Airtable records
 * `{id, createdTime, fields}`. The mapping rules are a faithful port of
 * ../../bam/services/airtable_import.py — see that module and
 * docs/SPEC-MAPPING.md for the interpretation decisions.
 *
 * Idempotent: rows are keyed by their Airtable record id in the doc maps, so
 * a re-import updates in place and the Airtable value wins (matching the
 * server importer); Fulfilled Request Count uses its natural date|type key.
 * Everything unmappable is *reported*, never silently dropped.
 *
 * The snapshot contains PII: it must stay outside git and is never copied.
 *
 * Divergence from the server importer, forced by the CRDT schema:
 * - `BamDoc` has no form-submissions collection (local-first intake writes
 *   households/requests directly), so "Assistance Request Form Submissions"
 *   records are counted as skipped. The production base holds zero.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DocHandle } from "@automerge/automerge-repo";
import type {
  AppointmentStatus,
  BamDoc,
  Distro,
  Household,
  RequestRow,
  RequestStatus,
  SocialServiceRequestRow,
} from "./schema.ts";
import { fulfilledCountKey, localDate, nowIso } from "./schema.ts";
import { expiryDaysFor, normalizeType } from "./domain/catalog.ts";
import { hashPhone, normalizePhone } from "./domain/validation.ts";

/** Spec section 2: the standard auto-expiration window. Non-catalog and
 * timed-out rows always get this; Delivered catalog goods get their type's
 * window (30 for Pots & Pans) via `expiryDaysFor`. */
const DEFAULT_EXPIRY_DAYS = 14;

/** Snapshot files as written by `dump_snapshot` (production table names). */
const SNAPSHOT_FILES = {
  households: "Households.json",
  requests: "Requests.json",
  socialServiceRequests: "Social Service Requests.json",
  meshRequests: "Mesh Requests.json",
  distros: "Distros.json",
  fulfilledCounts: "Fulfilled Request Count.json",
  formSubmissions: "Assistance Request Form Submissions.json",
} as const;

/** The Mesh table's pipeline statuses -> request lifecycle buckets. The raw
 * status is preserved on the request notes; unknown statuses map to Open. */
const MESH_DELIVERED_STATUSES = new Set(["yay! mesh installed!"]);
const MESH_TIMEOUT_STATUSES = new Set([
  "not interested",
  "cannot install - does not have los",
  "nycha - currently does not qualify",
  "cannot install - no roof access",
  "cannot install - other reason",
]);

const STATUS_BY_VALUE: Record<string, RequestStatus> = {
  open: "Open",
  timeout: "Timeout",
  delivered: "Delivered",
};
const APPOINTMENT_BY_VALUE: Record<string, AppointmentStatus> = {
  booked: "Booked",
  "checked-in": "Checked-in",
  missed: "Missed",
};

interface AirtableRecord {
  id: string;
  createdTime?: string;
  fields?: Record<string, unknown>;
}

export interface TableImportCounts {
  created: number;
  updated: number;
  skipped: number;
}

export interface ImportReport {
  /** importer role -> snapshot filename actually present. */
  tablesFound: Record<string, string>;
  households: TableImportCounts;
  requests: TableImportCounts;
  socialServiceRequests: TableImportCounts;
  meshRequests: TableImportCounts;
  distros: TableImportCounts;
  fulfilledCounts: TableImportCounts;
  formSubmissions: TableImportCounts;
  unmatchedTypes: string[];
  unknownStatuses: string[];
  duplicatePhoneIds: string[];
  orphanedIds: string[];
}

function emptyCounts(): TableImportCounts {
  return { created: 0, updated: 0, skipped: 0 };
}

/** Import every recognized snapshot file into the base doc. Safe to re-run. */
export async function importSnapshot(
  handle: DocHandle<BamDoc>,
  snapshotDir: string,
  now: string = nowIso()
): Promise<ImportReport> {
  const present = new Set(await readdir(snapshotDir));
  const report: ImportReport = {
    tablesFound: {},
    households: emptyCounts(),
    requests: emptyCounts(),
    socialServiceRequests: emptyCounts(),
    meshRequests: emptyCounts(),
    distros: emptyCounts(),
    fulfilledCounts: emptyCounts(),
    formSubmissions: emptyCounts(),
    unmatchedTypes: [],
    unknownStatuses: [],
    duplicatePhoneIds: [],
    orphanedIds: [],
  };
  for (const [role, file] of Object.entries(SNAPSHOT_FILES)) {
    if (present.has(file)) report.tablesFound[role] = file;
  }

  const tables: Partial<Record<keyof typeof SNAPSHOT_FILES, AirtableRecord[]>> = {};
  for (const role of Object.keys(SNAPSHOT_FILES) as (keyof typeof SNAPSHOT_FILES)[]) {
    if (role in report.tablesFound) {
      tables[role] = await readTable(snapshotDir, SNAPSHOT_FILES[role]);
    }
  }

  if (tables.households) {
    await importHouseholds(handle, tables.households, report, now);
  }
  // Links reference Airtable household ids, which ARE the row ids.
  const householdIds = new Set(Object.keys(handle.doc().households));

  if (tables.requests) {
    importRequests(handle, tables.requests, "goods", householdIds, report, now);
  }
  if (tables.socialServiceRequests) {
    importRequests(handle, tables.socialServiceRequests, "social", householdIds, report, now);
  }
  if (tables.meshRequests) {
    importMeshRequests(handle, tables.meshRequests, householdIds, report, now);
  }
  if (tables.distros) {
    importDistros(handle, tables.distros, report, now);
  }
  if (tables.fulfilledCounts) {
    importFulfilledCounts(handle, tables.fulfilledCounts, report);
  }
  if (tables.formSubmissions) {
    // No formSubmissions collection in BamDoc — see module doc comment.
    report.formSubmissions.skipped += tables.formSubmissions.length;
  }

  return report;
}

async function readTable(dir: string, file: string): Promise<AirtableRecord[]> {
  const parsed: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of records`);
  return parsed as AirtableRecord[];
}

/** Households: phone normalize/flags/hash, languages, appointment fields,
 * outreach dates, legacy first date -> createdAt, shared-phone handling. */
async function importHouseholds(
  handle: DocHandle<BamDoc>,
  records: AirtableRecord[],
  report: ImportReport,
  now: string
): Promise<void> {
  const doc = handle.doc();
  // normalized phone -> row id that already claimed it (spec's shared-phone
  // edge case: later claimants are imported without a phone).
  const claimed = new Map<string, string>();
  for (const [id, hh] of Object.entries(doc.households)) {
    if (hh.phoneNumber) claimed.set(hh.phoneNumber, id);
  }

  // hashPhone is async and change callbacks must be synchronous, so rows are
  // fully prepared first and written in one change.
  const prepared: { id: string; row: Household }[] = [];
  for (const record of records) {
    const fields = record.fields ?? {};
    const createdTime = parseDatetime(record.createdTime) ?? now;

    const rawScalar = scalar(first(fields, "Phone Number"));
    const rawPhone =
      rawScalar != null && String(rawScalar).trim() ? String(rawScalar).trim() : undefined;
    const validation = rawPhone
      ? normalizePhone(rawPhone)
      : { normalized: null, valid: false, international: false };

    let phoneNumber = validation.valid ? validation.normalized ?? undefined : undefined;
    const duplicateOf = phoneNumber ? claimed.get(phoneNumber) : undefined;
    const isDuplicate = duplicateOf !== undefined && duplicateOf !== record.id;
    if (isDuplicate) {
      report.duplicatePhoneIds.push(record.id);
      phoneNumber = undefined;
    }

    const existing = doc.households[record.id];

    const hashSource = validation.valid ? validation.normalized : rawPhone;
    const phoneHash = hashSource ? await hashPhone(hashSource) : undefined;

    const languages = asList(first(fields, "Languages", "Language"));
    for (const other of asList(first(fields, "Other Languages"))) {
      if (!languages.includes(other)) languages.push(other);
    }

    const notesRaw = scalar(first(fields, "Notes", "Case Notes"));
    let notes = notesRaw ? String(notesRaw) : undefined;
    if (isDuplicate && rawPhone) {
      const note = `[migration] phone ${rawPhone} already claimed by another household`;
      notes = notes ? `${notes}\n${note}` : note;
    }

    const statusRaw = scalar(first(fields, "Appointment Status"));
    let appointmentStatus: AppointmentStatus | undefined;
    if (statusRaw) {
      appointmentStatus = APPOINTMENT_BY_VALUE[String(statusRaw).toLowerCase()];
      if (!appointmentStatus) appendUnique(report.unknownStatuses, `appointment: ${statusRaw}`);
    }

    let createdAt = existing?.createdAt ?? createdTime;
    const legacyFirst = parseDatetime(first(fields, "Legacy First Date Submitted"));
    if (legacyFirst && legacyFirst < createdAt) createdAt = legacyFirst;

    const row = compact<Household>({
      id: record.id,
      name: strOr(scalar(first(fields, "Name", "First Name"))),
      phoneNumber,
      phoneHash,
      invalidPhoneNumber: Boolean(first(fields, "Invalid Phone Number?")) || !validation.valid,
      intlPhoneNumber:
        Boolean(first(fields, "Int'l Phone Number?", "Intl Phone Number?")) ||
        validation.international,
      email: strOr(scalar(first(fields, "Email"))),
      emailError: strOr(scalar(first(fields, "Email Error"))),
      languages,
      notes,
      appointmentDate: parseDate(first(fields, "Appointment Date")),
      appointmentTime: strOr(scalar(first(fields, "Appointment Time"))),
      appointmentStatus,
      missedAppointmentCount: existing?.missedAppointmentCount ?? 0,
      lastTexted: parseDate(first(fields, "Last Texted")),
      lastCalled: parseDate(first(fields, "Last Called")),
      needsDelivery: Boolean(first(fields, "Needs Delivery")),
      needsEmailOutreach: Boolean(first(fields, "Needs Email Outreach")),
      anonymizedAt: existing?.anonymizedAt,
      createdAt,
      updatedAt: now,
    });

    prepared.push({ id: record.id, row });
    if (phoneNumber) claimed.set(phoneNumber, record.id);
    report.households.created += existing ? 0 : 1;
    report.households.updated += existing ? 1 : 0;
  }

  handle.change((d) => {
    for (const p of prepared) d.households[p.id] = p.row;
  });
}

/** Requests and Social Service Requests share the mapping: type
 * normalization keeping raw labels, status mapping, effective open date
 * (Request Opened At -> Legacy Date Submitted -> createdTime), processing
 * date derivation, orphan skipping. */
function importRequests(
  handle: DocHandle<BamDoc>,
  records: AirtableRecord[],
  kind: "goods" | "social",
  householdIds: Set<string>,
  report: ImportReport,
  now: string
): void {
  const doc = handle.doc();
  const existingRows = kind === "goods" ? doc.requests : doc.socialServiceRequests;
  const counts = kind === "goods" ? report.requests : report.socialServiceRequests;

  const goodsRows: { id: string; row: RequestRow }[] = [];
  const socialRows: { id: string; row: SocialServiceRequestRow }[] = [];

  for (const record of records) {
    const fields = record.fields ?? {};
    const createdTime = parseDatetime(record.createdTime) ?? now;

    const householdId = linkedHousehold(fields, householdIds);
    if (!householdId) {
      report.orphanedIds.push(record.id);
      counts.skipped += 1;
      continue;
    }

    const typeRaw = String(scalar(first(fields, "Type")) ?? "").trim();
    const resolved = normalizeType(typeRaw);
    const typeKey = resolved ?? typeRaw; // preserve the raw label rather than drop data
    if (resolved === null && typeRaw) appendUnique(report.unmatchedTypes, typeRaw);

    const status = requestStatus(fields, report);
    const { openedAt, statusUpdatedAt } = openDates(fields, createdTime);

    let processingDate = parseDate(first(fields, "Processing Date"));
    if (!processingDate && status !== "Open") {
      const days =
        status === "Delivered" && kind === "goods" && resolved !== null
          ? expiryDaysFor(typeKey)
          : DEFAULT_EXPIRY_DAYS;
      processingDate = addDays(localDate(statusUpdatedAt), days);
    }

    const existing = existingRows[record.id];
    const notesRaw = scalar(first(fields, "Notes"));
    const zip = scalar(first(fields, "Zip Code"));
    const common = {
      id: record.id,
      type: typeKey,
      householdId,
      status,
      notes: notesRaw ? String(notesRaw) : undefined,
      requestOpenedAt: openedAt,
      statusLastUpdatedAt: statusUpdatedAt,
      processingDate,
      streetAddress: strOr(scalar(first(fields, "Street Address"))),
      cityState: strOr(scalar(first(fields, "City, State", "City State", "City"))),
      zipCode: zip != null ? String(zip) : undefined,
      address: strOr(scalar(first(fields, "Address", "Current Address"))),
      createdAt: existing?.createdAt ?? createdTime,
      updatedAt: now,
    };

    if (kind === "goods") {
      goodsRows.push({
        id: record.id,
        row: compact<RequestRow>({
          ...common,
          geocode: strOr(scalar(first(fields, "Geocode"))),
        }),
      });
    } else {
      socialRows.push({
        id: record.id,
        row: compact<SocialServiceRequestRow>({
          ...common,
          internetAccess: asList(first(fields, "Internet Access")),
          roofAccessible: Boolean(first(fields, "Roof Accessible?")),
        }),
      });
    }
    counts.created += existing ? 0 : 1;
    counts.updated += existing ? 1 : 0;
  }

  handle.change((d) => {
    for (const p of goodsRows) d.requests[p.id] = p.row;
    for (const p of socialRows) d.socialServiceRequests[p.id] = p.row;
  });
}

/** Mesh Requests -> socialServiceRequests rows of type `mesh_internet`.
 *
 * The mesh install pipeline has 17 statuses; they bucket into the request
 * lifecycle (installed -> Delivered, cannot/won't install -> Timeout,
 * everything in-flight -> Open) with the raw status kept on the notes so no
 * pipeline detail is lost. */
function importMeshRequests(
  handle: DocHandle<BamDoc>,
  records: AirtableRecord[],
  householdIds: Set<string>,
  report: ImportReport,
  now: string
): void {
  const doc = handle.doc();
  const counts = report.meshRequests;
  const prepared: { id: string; row: SocialServiceRequestRow }[] = [];

  for (const record of records) {
    const fields = record.fields ?? {};
    const createdTime = parseDatetime(record.createdTime) ?? now;

    const householdId = linkedHousehold(fields, householdIds);
    if (!householdId) {
      report.orphanedIds.push(record.id);
      counts.skipped += 1;
      continue;
    }

    const statusRaw = String(scalar(first(fields, "Status")) ?? "").trim();
    const lowered = statusRaw.toLowerCase();
    const status: RequestStatus = MESH_DELIVERED_STATUSES.has(lowered)
      ? "Delivered"
      : MESH_TIMEOUT_STATUSES.has(lowered)
        ? "Timeout"
        : "Open";

    const noteParts: string[] = [];
    if (statusRaw) noteParts.push(`[mesh status] ${statusRaw}`);
    const bin = scalar(first(fields, "Building Identification Number"));
    if (bin != null) noteParts.push(`[mesh] BIN ${Math.trunc(Number(bin))}`);
    const accuracy = scalar(first(fields, "Address Accuracy"));
    if (accuracy) noteParts.push(`[mesh] address accuracy: ${String(accuracy)}`);
    const lastRequested = parseDate(first(fields, "Last Requested"));
    if (lastRequested) noteParts.push(`[mesh] last requested: ${lastRequested}`);

    const { openedAt, statusUpdatedAt } = openDates(fields, createdTime);
    let processingDate = parseDate(first(fields, "Processing Date"));
    if (!processingDate && status !== "Open") {
      processingDate = addDays(localDate(statusUpdatedAt), DEFAULT_EXPIRY_DAYS);
    }

    const existing = doc.socialServiceRequests[record.id];
    const zip = scalar(first(fields, "Zip Code"));
    prepared.push({
      id: record.id,
      row: compact<SocialServiceRequestRow>({
        id: record.id,
        type: "mesh_internet",
        householdId,
        status,
        notes: noteParts.length ? noteParts.join("\n") : undefined,
        internetAccess: asList(first(fields, "Internet Access")),
        roofAccessible: Boolean(first(fields, "Roof Accessible?")),
        streetAddress: strOr(scalar(first(fields, "Street Address"))),
        cityState: strOr(scalar(first(fields, "City, State", "City State"))),
        zipCode: zip != null ? String(zip) : undefined,
        address: strOr(scalar(first(fields, "Address"))),
        requestOpenedAt: openedAt,
        statusLastUpdatedAt: statusUpdatedAt,
        processingDate,
        createdAt: existing?.createdAt ?? createdTime,
        updatedAt: now,
      }),
    });
    counts.created += existing ? 0 : 1;
    counts.updated += existing ? 1 : 0;
  }

  handle.change((d) => {
    for (const p of prepared) d.socialServiceRequests[p.id] = p.row;
  });
}

function importDistros(
  handle: DocHandle<BamDoc>,
  records: AirtableRecord[],
  report: ImportReport,
  now: string
): void {
  const doc = handle.doc();
  const counts = report.distros;
  const prepared: { id: string; row: Distro }[] = [];

  for (const record of records) {
    const fields = record.fields ?? {};
    const dateTime = parseDatetime(first(fields, "Date & Time", "Date and Time", "Date"));
    if (!dateTime) {
      counts.skipped += 1;
      continue;
    }
    const existing = doc.distros[record.id];
    const duration = scalar(first(fields, "Duration"));
    const durationSeconds = duration ? Number(duration) : NaN;
    const appointments = scalar(first(fields, "Appointments"));
    const notesRaw = scalar(first(fields, "Notes"));
    prepared.push({
      id: record.id,
      row: compact<Distro>({
        id: record.id,
        dateTime,
        location: strOr(scalar(first(fields, "Location"))),
        // Airtable duration fields are seconds.
        durationMinutes: Number.isFinite(durationSeconds)
          ? Math.trunc(durationSeconds / 60)
          : undefined,
        appointments: appointments != null ? String(appointments) : undefined,
        notes: notesRaw ? String(notesRaw) : undefined,
        createdAt: existing?.createdAt ?? now,
      }),
    });
    counts.created += existing ? 0 : 1;
    counts.updated += existing ? 1 : 0;
  }

  handle.change((d) => {
    for (const p of prepared) d.distros[p.id] = p.row;
  });
}

/** The wide Airtable table (Date + one column per type) -> one entry per
 * date|type key. The Airtable value wins on re-run. */
function importFulfilledCounts(
  handle: DocHandle<BamDoc>,
  records: AirtableRecord[],
  report: ImportReport
): void {
  const doc = handle.doc();
  const counts = report.fulfilledCounts;
  const seen = new Set(Object.keys(doc.fulfilledCounts));
  const entries: { key: string; count: number }[] = [];

  for (const record of records) {
    const fields = record.fields ?? {};
    const onDate = parseDate(first(fields, "Date"));
    if (!onDate) {
      counts.skipped += 1;
      continue;
    }
    for (const [column, value] of Object.entries(fields)) {
      if (column === "Date" || typeof value !== "number") continue;
      const resolved = normalizeType(column);
      if (resolved === null) appendUnique(report.unmatchedTypes, column);
      const key = fulfilledCountKey(onDate, resolved ?? column);
      entries.push({ key, count: Math.trunc(value) });
      counts.created += seen.has(key) ? 0 : 1;
      counts.updated += seen.has(key) ? 1 : 0;
      seen.add(key);
    }
  }

  handle.change((d) => {
    for (const e of entries) d.fulfilledCounts[e.key] = e.count;
  });
}

// ---- field helpers (ports of the server importer's variant-aware readers) --

/** First present field among naming variants. */
function first(fields: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(fields, name)) return fields[name];
  }
  return undefined;
}

/** Airtable lookups arrive as lists; unwrap single-valued ones. */
function scalar(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? value[0] : undefined;
  return value;
}

function asList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

function strOr(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

/** Parse an Airtable datetime/date to ISO-8601 UTC; naive values are treated
 * as UTC (matching the server importer). */
function parseDatetime(value: unknown): string | undefined {
  const v = scalar(value);
  if (v == null) return undefined;
  let text = String(v).trim();
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += "Z";
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function parseDate(value: unknown): string | undefined {
  return parseDatetime(value)?.slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Resolve the record's household link; null when missing or orphaned. */
function linkedHousehold(
  fields: Record<string, unknown>,
  householdIds: Set<string>
): string | null {
  const links = first(fields, "Household", "Households");
  const linkId = Array.isArray(links) && links.length ? String(links[0]) : null;
  return linkId && householdIds.has(linkId) ? linkId : null;
}

function requestStatus(fields: Record<string, unknown>, report: ImportReport): RequestStatus {
  const statusRaw = scalar(first(fields, "Status"));
  const status = statusRaw ? STATUS_BY_VALUE[String(statusRaw).toLowerCase()] : undefined;
  if (!status && statusRaw) appendUnique(report.unknownStatuses, `request: ${String(statusRaw)}`);
  return status ?? "Open";
}

/** The spec's "effective open date" chain, plus status-change timestamp. */
function openDates(
  fields: Record<string, unknown>,
  createdTime: string
): { openedAt: string; statusUpdatedAt: string } {
  const openedAt =
    parseDatetime(first(fields, "Request Opened At")) ??
    parseDatetime(first(fields, "Legacy Date Submitted")) ??
    createdTime;
  const statusUpdatedAt = parseDatetime(first(fields, "Status Last Updated At")) ?? createdTime;
  return { openedAt, statusUpdatedAt };
}

/** Automerge rejects `undefined` values; drop absent optionals before assigning. */
function compact<T extends object>(row: {
  [K in keyof T]: T[K] | undefined;
}): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function appendUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}
