/**
 * Distribution outreach (spec 6.2, the outreach flowchart, and 6.4 A4-A6),
 * ported from bam/services/outreach.py to the CRDT store.
 *
 * The local-first twist: there is no SMS provider here. `queueBlast`
 * renders each message and appends it to the shared `smsOutbox`; any
 * gateway device (or operator with a sending tool) drains the outbox and
 * stamps `sentAt` via `markOutboxSent`. `lastTexted` is stamped when the
 * message is queued — the queue IS the send decision for recency purposes,
 * and a dry run writes nothing at all.
 */

import type { DocHandle } from "@automerge/automerge-repo";
import type { BamDoc, Household, OutboxMessage } from "../schema.ts";
import { fulfilledCountKey, localDate, newId, nowIso } from "../schema.ts";
import { normalizeType } from "./catalog.ts";
import { applyStatusChange, addDays } from "./lifecycle.ts";

export const DEFAULT_MAX_MESSAGES = 240; // spec 6.2: 240 texts ~ 60 appointments
export const DEFAULT_REQUEST_FORM_URL = "https://forms.fillout.com/t/ivajQbwoWxus";

export interface OutreachFilters {
  requestTypes?: string[];
  languages?: string[];
  excludeTextedWithinDays?: number;
  excludeAttendedWithinDays?: number;
  limit?: number;
}

export interface OutreachCandidate {
  householdId: string;
  name?: string;
  phoneNumber?: string;
  languages: string[];
  openRequestTypes: string[];
  oldestOpenRequestAt?: string;
  lastTexted?: string;
}

/**
 * Build the outreach list for a distribution (spec 6.2 step 1): households
 * with at least one Open goods request (restricted to `requestTypes` when
 * given — the "available supplies match" filter), a usable phone, a
 * language overlap when `languages` is given (exact strings — see
 * BAM.LANGUAGES), no current Booked appointment, and recency windows on
 * lastTexted / lastAttended. Ordered by the Date of Oldest Fulfillable
 * Request ascending.
 */
export function buildOutreachList(
  doc: BamDoc,
  filters: OutreachFilters = {},
  now: string = nowIso()
): OutreachCandidate[] {
  const today = localDate(now);
  const typeFilter = filters.requestTypes?.length
    ? new Set(filters.requestTypes.map((t) => normalizeType(t) ?? t))
    : null;

  const openByHousehold = new Map<string, { types: Set<string>; oldest: string }>();
  for (const req of Object.values(doc.requests)) {
    if (req.status !== "Open") continue;
    if (typeFilter && !typeFilter.has(req.type)) continue;
    const entry = openByHousehold.get(req.householdId);
    if (!entry) {
      openByHousehold.set(req.householdId, {
        types: new Set([req.type]),
        oldest: req.requestOpenedAt,
      });
    } else {
      entry.types.add(req.type);
      if (req.requestOpenedAt < entry.oldest) entry.oldest = req.requestOpenedAt;
    }
  }

  const candidates: OutreachCandidate[] = [];
  for (const [householdId, open] of openByHousehold) {
    const h = doc.households[householdId];
    if (!h || !h.phoneNumber || h.invalidPhoneNumber) continue;
    if (h.appointmentStatus === "Booked") continue;
    if (filters.languages?.length) {
      const overlap = filters.languages.some((l) => h.languages.includes(l));
      if (!overlap) continue;
    }
    if (filters.excludeTextedWithinDays && h.lastTexted) {
      const cutoff = addDays(today, -filters.excludeTextedWithinDays);
      if (h.lastTexted > cutoff) continue;
    }
    if (filters.excludeAttendedWithinDays && h.lastAttended) {
      const cutoff = addDays(today, -filters.excludeAttendedWithinDays);
      if (h.lastAttended > cutoff) continue;
    }
    candidates.push({
      householdId,
      name: h.name,
      phoneNumber: h.phoneNumber,
      languages: [...h.languages],
      openRequestTypes: [...open.types].sort(),
      oldestOpenRequestAt: open.oldest,
      lastTexted: h.lastTexted,
    });
  }

  candidates.sort((a, b) =>
    (a.oldestOpenRequestAt ?? "") < (b.oldestOpenRequestAt ?? "")
      ? -1
      : (a.oldestOpenRequestAt ?? "") > (b.oldestOpenRequestAt ?? "")
        ? 1
        : a.householdId < b.householdId
          ? -1
          : 1
  );
  return filters.limit != null ? candidates.slice(0, filters.limit) : candidates;
}

export interface BlastOptions {
  householdIds: string[];
  template: string; // supports [FIRST_NAME] and [REQUEST_URL]
  /** Optional per-language map (keys Spanish/Cantonese/English). When present,
   * each household is routed to its language with a Spanish+Cantonese+English
   * "All" fallback; otherwise `template` goes to everyone. */
  templates?: { [lang: string]: string };
  maxMessages?: number;
  dryRun?: boolean;
  requestFormUrl?: string;
  /** Injectable for deterministic tests; default random token. */
  tokenFactory?: () => string;
}

export interface BlastMessagePreview {
  householdId: string;
  to: string;
  body: string;
}

export interface BlastReport {
  sent: number;
  skippedInvalid: number;
  skippedNoPhone: number;
  notSentOverLimit: number;
  unknownHouseholdIds: string[];
  messages: BlastMessagePreview[];
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function renderTemplate(
  template: string,
  firstName: string,
  requestUrl: string
): string {
  return template.replaceAll("[FIRST_NAME]", firstName).replaceAll("[REQUEST_URL]", requestUrl);
}

/** Order the "All" message concatenates the per-language texts in (verbatim
 * from bam-automation send_mass_text.py). */
export const ALL_LANGUAGE_ORDER = ["Spanish", "Cantonese", "English"];

/** Which language to text a household in (bam-automation determine_message_
 * language; exact if/elif order). Households store full trilingual labels, so
 * we substring-match the English middle token. */
export function resolveSendLanguage(languages: string[]): string {
  const joined = (languages ?? []).join(",");
  if (joined.includes("Spanish")) return "Spanish";
  if (joined.includes("Quechua")) return "Spanish";
  if (joined.includes("Mandarin")) return "Cantonese";
  if (joined.includes("Cantonese")) return "Cantonese";
  if (joined.includes("English")) return "English";
  return "All";
}

/** Concatenate the supplied per-language texts in ALL_LANGUAGE_ORDER, blank-
 * line separated; absent languages omitted. */
export function assembleAllMessage(templates: { [lang: string]: string }): string {
  return ALL_LANGUAGE_ORDER.filter((l) => l in templates)
    .map((l) => templates[l])
    .join("\n\n");
}

/** Pick a household's body: resolve its send-language, use that template, else
 * synthesize the "All" concatenation from whatever texts exist. */
export function selectTemplate(templates: { [lang: string]: string }, languages: string[]): string {
  const body = templates[resolveSendLanguage(languages)];
  return body !== undefined ? body : assembleAllMessage(templates);
}

/**
 * Queue a templated text blast (spec 6.2 step 2 / spec 5 `send_sms`) into
 * `smsOutbox`. Each message gets a unique randomized `?r=<token>` variant of
 * the form URL (spec 6.2 sequence diagram: "[REQUEST_URL] (randomized)" —
 * avoids provider spam filtering of identical bodies). Queuing stamps
 * `lastTexted`; `dryRun` builds the report without touching the doc.
 */
export function queueBlast(
  handle: DocHandle<BamDoc>,
  opts: BlastOptions,
  now: string = nowIso(),
  queuedBy = "local"
): BlastReport {
  const doc = handle.doc();
  const cap = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const baseUrl = opts.requestFormUrl ?? DEFAULT_REQUEST_FORM_URL;
  const makeToken = opts.tokenFactory ?? randomToken;
  const today = localDate(now);

  const report: BlastReport = {
    sent: 0,
    skippedInvalid: 0,
    skippedNoPhone: 0,
    notSentOverLimit: 0,
    unknownHouseholdIds: [],
    messages: [],
  };
  const queued: { message: OutboxMessage }[] = [];

  for (const householdId of opts.householdIds) {
    const h = doc.households[householdId];
    if (!h) {
      report.unknownHouseholdIds.push(householdId);
      continue;
    }
    if (!h.phoneNumber) {
      report.skippedNoPhone += 1;
      continue;
    }
    if (h.invalidPhoneNumber) {
      report.skippedInvalid += 1;
      continue;
    }
    if (report.sent >= cap) {
      report.notSentOverLimit += 1;
      continue;
    }
    const joiner = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${joiner}r=${makeToken()}`;
    const firstName = (h.name ?? "").split(/\s+/)[0] ?? "";
    const rawBody = opts.templates
      ? selectTemplate(opts.templates, h.languages ?? [])
      : opts.template;
    const body = renderTemplate(rawBody, firstName, url);
    report.sent += 1;
    report.messages.push({ householdId, to: h.phoneNumber, body });
    queued.push({
      message: {
        id: newId(),
        to: h.phoneNumber,
        body,
        householdId,
        queuedAt: now,
        queuedBy,
      },
    });
  }

  if (!opts.dryRun && queued.length) {
    handle.change((d) => {
      for (const { message } of queued) {
        d.smsOutbox[message.id] = message;
        const h = d.households[message.householdId];
        if (h) {
          h.lastTexted = today;
          h.updatedAt = now;
        }
      }
    });
  }
  return report;
}

/** Book a confirmed recipient into a slot (spec 6.2 steps 3-4). */
export function confirmAppointment(
  handle: DocHandle<BamDoc>,
  householdId: string,
  slot: { date: string; time: string },
  now: string = nowIso()
): Household {
  if (!handle.doc().households[householdId]) {
    throw new Error(`Unknown household id ${householdId}`);
  }
  handle.change((d) => {
    const h = d.households[householdId]!;
    h.appointmentDate = slot.date;
    h.appointmentTime = slot.time;
    h.appointmentStatus = "Booked";
    h.updatedAt = now;
  });
  return handle.doc().households[householdId]!;
}

export type OutreachOutcome = "no_response_timeout" | "wrong_number" | "no_longer_needed";

const OUTCOME_TAGS: Record<OutreachOutcome, string> = {
  no_response_timeout: "[no response]", // A4
  wrong_number: "[wrong number]", // A5
  no_longer_needed: "[no longer needed]", // A6
};

/**
 * Close out a household after phone outreach (spec 6.4 rows A4-A6): all
 * Open rows of both kinds time out; wrong_number also flags the phone
 * invalid; a Booked appointment is cleared; the outcome tag (plus optional
 * note) lands on the household notes.
 */
export function recordOutcome(
  handle: DocHandle<BamDoc>,
  householdId: string,
  outcome: OutreachOutcome,
  note?: string,
  now: string = nowIso()
): Household {
  if (!OUTCOME_TAGS[outcome]) throw new Error(`Unknown outreach outcome: ${outcome}`);
  if (!handle.doc().households[householdId]) {
    throw new Error(`Unknown household id ${householdId}`);
  }
  handle.change((d) => {
    for (const req of Object.values(d.requests)) {
      if (req.householdId === householdId && req.status === "Open") {
        applyStatusChange(req, "Timeout", now);
      }
    }
    for (const req of Object.values(d.socialServiceRequests)) {
      if (req.householdId === householdId && req.status === "Open") {
        applyStatusChange(req, "Timeout", now);
      }
    }
    const h = d.households[householdId]!;
    if (outcome === "wrong_number") h.invalidPhoneNumber = true;
    if (h.appointmentStatus === "Booked") {
      delete h.appointmentStatus;
      delete h.appointmentDate;
      delete h.appointmentTime;
    }
    const entry = note ? `${OUTCOME_TAGS[outcome]} ${note}` : OUTCOME_TAGS[outcome];
    h.notes = h.notes ? `${h.notes}\n${entry}` : entry;
    h.updatedAt = now;
  });
  return handle.doc().households[householdId]!;
}

/** Unsent (or all) outbox messages, oldest first — for a gateway device. */
export function listOutbox(
  doc: BamDoc,
  opts: { unsentOnly?: boolean } = {}
): OutboxMessage[] {
  const rows = Object.values(doc.smsOutbox).filter(
    (m) => !opts.unsentOnly || !m.sentAt
  );
  rows.sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1));
  return rows;
}

/** Stamp an outbox message as sent (or failed) by a gateway device. */
export function markOutboxSent(
  handle: DocHandle<BamDoc>,
  messageId: string,
  result: { error?: string } = {},
  now: string = nowIso()
): void {
  if (!handle.doc().smsOutbox[messageId]) {
    throw new Error(`Unknown outbox message ${messageId}`);
  }
  handle.change((d) => {
    const m = d.smsOutbox[messageId]!;
    if (result.error) m.error = result.error;
    else m.sentAt = now;
  });
}

/** Re-exported so callers of fulfilledCounts see one import site. */
export { fulfilledCountKey };
