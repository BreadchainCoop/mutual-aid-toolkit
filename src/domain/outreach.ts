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
import { LANGUAGES, normalizeType } from "./catalog.ts";
import { applyStatusChange, addDays } from "./lifecycle.ts";
import { outOfStockTypes } from "./inventory.ts";

export const DEFAULT_MAX_MESSAGES = 240; // spec 6.2: 240 texts ~ 60 appointments
export const DEFAULT_REQUEST_FORM_URL = "https://forms.fillout.com/t/ivajQbwoWxus";

export interface OutreachFilters {
  requestTypes?: string[];
  languages?: string[];
  excludeTextedWithinDays?: number;
  excludeAttendedWithinDays?: number;
  limit?: number;
  /** "sms" (default) requires a usable phone; "email" selects households with
   * a good email that are flagged for email outreach or unreachable by SMS. */
  channel?: "sms" | "email";
  /** Only households whose booked distro was cancelled (needsRebooking). */
  rebookingOnly?: boolean;
  /** Skip request types that are tracked in inventory and OUT (stock 0) —
   * never text someone about an item that isn't on the shelf. */
  inStockOnly?: boolean;
}

export interface OutreachCandidate {
  householdId: string;
  name?: string;
  phoneNumber?: string;
  email?: string;
  languages: string[];
  preferredLanguage?: string;
  needsRebooking: boolean;
  /** Neither preferredLanguage nor languages overlaps the catalog LANGUAGES
   * (an interpreter/translation gap the operator should see). */
  unsupportedLanguage: boolean;
  openRequestTypes: string[];
  oldestOpenRequestAt?: string;
  lastTexted?: string;
}

/** Does the household speak (or prefer) any catalog-supported language? An
 * empty language set counts as unsupported. */
const SUPPORTED_LANGUAGES = new Set(LANGUAGES);
function hasSupportedLanguage(h: Household): boolean {
  if (h.preferredLanguage !== undefined && SUPPORTED_LANGUAGES.has(h.preferredLanguage)) {
    return true;
  }
  return (h.languages ?? []).some((l) => SUPPORTED_LANGUAGES.has(l));
}

/**
 * Build the outreach list for a distribution (spec 6.2 step 1): households
 * with at least one Open goods request (restricted to `requestTypes` when
 * given — the "available supplies match" filter), a usable phone, a
 * language overlap when `languages` is given (exact strings — see
 * BAM.LANGUAGES), no current Booked appointment, and recency windows on
 * lastTexted / lastAttended. Ordered by the Date of Oldest Fulfillable
 * Request ascending.
 *
 * Accepted-but-paced rows (pacedUntil in the future) do not count as open
 * request types; a household whose remaining types are all paced is omitted.
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
  const outOfStock = filters.inStockOnly ? outOfStockTypes(doc) : null;
  for (const req of Object.values(doc.requests)) {
    if (req.status !== "Open") continue;
    if (req.pacedUntil !== undefined && req.pacedUntil > today) continue; // per-item cooldown
    if (outOfStock && outOfStock.has(req.type)) continue; // tracked and OUT
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
    if (!h) continue;
    if (filters.channel === "email") {
      if (!h.email || h.emailError) continue;
      if (!(h.needsEmailOutreach || !h.phoneNumber || h.invalidPhoneNumber)) continue;
    } else {
      if (!h.phoneNumber || h.invalidPhoneNumber) continue;
    }
    if (filters.rebookingOnly && h.needsRebooking !== true) continue;
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
      email: h.email,
      languages: [...h.languages],
      preferredLanguage: h.preferredLanguage,
      needsRebooking: h.needsRebooking === true,
      unsupportedLanguage: !hasSupportedLanguage(h),
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
  /** Supports {name} and {url} (bidi-isolated on substitution), plus the
   * legacy [FIRST_NAME] / [REQUEST_URL] spellings (verbatim substitution). */
  template: string;
  /** Optional per-language map (keys Spanish/Cantonese/English). When present,
   * each household is routed to its language with a Spanish+Cantonese+English
   * "All" fallback; otherwise `template` goes to everyone. */
  templates?: { [lang: string]: string };
  maxMessages?: number;
  dryRun?: boolean;
  requestFormUrl?: string;
  /** "email" queues to household.email with channel:"email" and stamps
   * lastEmailed; unset/"sms" is the SMS path (stamps lastTexted). */
  channel?: "sms" | "email";
  /** Email subject line (channel "email" only). */
  subject?: string;
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
  /** Email blasts only: households with no email or a recorded email error. */
  skippedNoEmail: number;
  notSentOverLimit: number;
  unknownHouseholdIds: string[];
  messages: BlastMessagePreview[];
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** U+2068 FIRST STRONG ISOLATE / U+2069 POP DIRECTIONAL ISOLATE. */
const FSI = "⁨";
const PDI = "⁩";

/**
 * Replace `{key}` placeholders with `vars[key]`. Every substituted value is
 * wrapped in bidi isolates (U+2068 FSI … U+2069 PDI) so an RTL template —
 * e.g. Arabic — cannot visually reorder LTR values like names, URLs, or
 * addresses. Placeholders with no matching var are left verbatim.
 */
export function renderTemplate(template: string, vars: { [k: string]: string }): string {
  return template.replace(/\{([^{}]+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(vars, key) ? `${FSI}${vars[key]}${PDI}` : placeholder
  );
}

/** Order the "All" message concatenates the per-language texts in (verbatim
 * from bam-automation send_mass_text.py). */
export const ALL_LANGUAGE_ORDER = ["Spanish", "Cantonese", "English"];

/** The if/elif chain shared by the preferred-language and languages passes. */
function matchSendLanguage(joined: string): string | null {
  if (joined.includes("Spanish")) return "Spanish";
  if (joined.includes("Quechua")) return "Spanish";
  if (joined.includes("Mandarin")) return "Cantonese";
  if (joined.includes("Cantonese")) return "Cantonese";
  if (joined.includes("English")) return "English";
  return null;
}

/** Which language to text a household in (bam-automation determine_message_
 * language; exact if/elif order). Households store full trilingual labels, so
 * we substring-match the English middle token. `preferredLanguage` (the
 * "lead with" language) takes precedence over the also-speaks array. */
export function resolveSendLanguage(languages: string[], preferredLanguage?: string): string {
  if (preferredLanguage) {
    const preferred = matchSendLanguage(preferredLanguage);
    if (preferred) return preferred;
  }
  return matchSendLanguage((languages ?? []).join(",")) ?? "All";
}

/** Concatenate the supplied per-language texts in ALL_LANGUAGE_ORDER, blank-
 * line separated; absent languages omitted. */
export function assembleAllMessage(templates: { [lang: string]: string }): string {
  return ALL_LANGUAGE_ORDER.filter((l) => l in templates)
    .map((l) => templates[l])
    .join("\n\n");
}

/** Pick a household's body: resolve its send-language (preferredLanguage
 * first), use that template, else synthesize the "All" concatenation from
 * whatever texts exist. */
export function selectTemplate(
  templates: { [lang: string]: string },
  languages: string[],
  preferredLanguage?: string
): string {
  const body = templates[resolveSendLanguage(languages, preferredLanguage)];
  return body !== undefined ? body : assembleAllMessage(templates);
}

/**
 * Queue a templated text blast (spec 6.2 step 2 / spec 5 `send_sms`) into
 * `smsOutbox`. Each message gets a unique randomized `?r=<token>` variant of
 * the form URL (spec 6.2 sequence diagram: "[REQUEST_URL] (randomized)" —
 * avoids provider spam filtering of identical bodies). Queuing stamps
 * `lastTexted` (or `lastEmailed` when channel is "email"); `dryRun` builds
 * the report without touching the doc.
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

  const isEmail = opts.channel === "email";

  const report: BlastReport = {
    sent: 0,
    skippedInvalid: 0,
    skippedNoPhone: 0,
    skippedNoEmail: 0,
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
    if (isEmail) {
      if (!h.email || h.emailError) {
        report.skippedNoEmail += 1;
        continue;
      }
    } else {
      if (!h.phoneNumber) {
        report.skippedNoPhone += 1;
        continue;
      }
      if (h.invalidPhoneNumber) {
        report.skippedInvalid += 1;
        continue;
      }
    }
    if (report.sent >= cap) {
      report.notSentOverLimit += 1;
      continue;
    }
    const joiner = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${joiner}r=${makeToken()}`;
    const firstName = (h.name ?? "").split(/\s+/)[0] ?? "";
    const rawBody = opts.templates
      ? selectTemplate(opts.templates, h.languages ?? [], h.preferredLanguage)
      : opts.template;
    // {name}/{url} get bidi-isolated; the legacy bracket spellings predate the
    // isolation and keep substituting verbatim for existing templates.
    const body = renderTemplate(rawBody, { name: firstName, url })
      .replaceAll("[FIRST_NAME]", firstName)
      .replaceAll("[REQUEST_URL]", url);
    const to = isEmail ? h.email! : h.phoneNumber!;
    report.sent += 1;
    report.messages.push({ householdId, to, body });
    const message: OutboxMessage = {
      id: newId(),
      to,
      body,
      householdId,
      queuedAt: now,
      queuedBy,
    };
    if (isEmail) {
      message.channel = "email";
      if (opts.subject !== undefined) message.subject = opts.subject;
    } else if (opts.channel === "sms") {
      message.channel = "sms";
    }
    queued.push({ message });
  }

  if (!opts.dryRun && queued.length) {
    handle.change((d) => {
      for (const { message } of queued) {
        d.smsOutbox[message.id] = message;
        const h = d.households[message.householdId];
        if (h) {
          if (message.channel === "email") h.lastEmailed = today;
          else h.lastTexted = today;
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

export type OutreachOutcome =
  | "no_response_timeout"
  | "wrong_number"
  | "no_longer_needed"
  | "emailed";

const OUTCOME_TAGS: Record<OutreachOutcome, string> = {
  no_response_timeout: "[no response]", // A4
  wrong_number: "[wrong number]", // A5
  no_longer_needed: "[no longer needed]", // A6
  emailed: "[emailed]", // fell back to email; requests stay open
};

/**
 * Close out a household after phone outreach (spec 6.4 rows A4-A6): all
 * Open rows of both kinds time out; wrong_number also flags the phone
 * invalid; a Booked appointment is cleared; the outcome tag (plus optional
 * note) lands on the household notes.
 *
 * The "emailed" outcome is the exception: it only stamps `lastEmailed` (we
 * reached out by email and are still waiting) — nothing times out.
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
    const h = d.households[householdId]!;
    if (outcome === "emailed") {
      h.lastEmailed = localDate(now);
    } else {
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
      if (outcome === "wrong_number") h.invalidPhoneNumber = true;
      if (h.appointmentStatus === "Booked") {
        delete h.appointmentStatus;
        delete h.appointmentDate;
        delete h.appointmentTime;
      }
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
