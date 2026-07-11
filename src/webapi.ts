/**
 * CRDT-backed drop-in replacement for the console's `BAM.api`.
 *
 * The operator console (bam/web/views/*.js, copied verbatim into
 * web/public/console/) was written against the FastAPI JSON surface. This
 * adapter implements the same method names and snake_case response shapes
 * over the local Automerge store, so the views run unchanged with no
 * server at all. Errors are thrown as `ApiError` with `status`/`detail`,
 * matching what the views expect from the fetch wrapper.
 */

import type { BamStore } from "./store.ts";
import type {
  BamDoc,
  Distro,
  DistrosDoc,
  Household,
  RequestRow,
  SocialServiceRequestRow,
} from "./schema.ts";
import { newId, nowIso, localDate } from "./schema.ts";
import { domainAllowed, hasCap, isAdmin } from "./roster.ts";
import {
  BY_KEY,
  GOODS,
  LANGUAGES,
  SOCIAL_SERVICES,
  labelFor,
} from "./domain/catalog.ts";
import { submitIntake } from "./domain/intake.ts";
import type { CheckinView } from "./domain/checkin.ts";
import {
  buildCheckinView,
  checkIn,
  fulfill,
  lookupByPhone,
  processNoShows,
  searchByName,
  searchByPhoneSuffix,
  timeout as timeoutRequestsDomain,
} from "./domain/checkin.ts";
import {
  buildOutreachList,
  queueBlast,
  recordOutcome,
  type OutreachOutcome,
} from "./domain/outreach.ts";
import { expireStale, scrubExpiredPii } from "./domain/lifecycle.ts";
import { fulfilledCountsRange, openRequestCounts } from "./domain/metrics.ts";
import {
  isDisabled,
  isInSeason,
  itemPolicyFor,
  setItemPolicy as setItemPolicyDomain,
} from "./domain/cooldowns.ts";
import {
  SlotFullError,
  bookAppointmentChecked,
  cancelDistro as cancelDistroDomain,
  createDistro as createDistroDomain,
  slotUsage,
} from "./domain/distros.ts";
import {
  searchByEmail,
  setNeedsDelivery,
  setSetAside,
  updateContact,
} from "./domain/checkin.ts";
import { partnerSyncByPhone, setPartnerOrg } from "./domain/partners.ts";
import { impactReport, waitlistReport } from "./domain/reporting.ts";
import {
  ShiftFullError,
  claimShiftSlot,
  createShiftSlot,
  listShiftSlots,
  releaseShiftSlot,
  removeShiftSlot,
  updateShiftSlot,
} from "./domain/shifts.ts";

export class ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function householdOut(h: Household): Record<string, unknown> {
  return {
    id: h.id,
    name: h.name ?? null,
    phone_number: h.phoneNumber ?? null,
    invalid_phone_number: h.invalidPhoneNumber,
    intl_phone_number: h.intlPhoneNumber,
    email: h.email ?? null,
    email_error: h.emailError ?? null,
    languages: h.languages,
    notes: h.notes ?? null,
    appointment_date: h.appointmentDate ?? null,
    appointment_time: h.appointmentTime ?? null,
    appointment_status: h.appointmentStatus ?? null,
    missed_appointment_count: h.missedAppointmentCount,
    last_texted: h.lastTexted ?? null,
    last_emailed: h.lastEmailed ?? null,
    last_attended: h.lastAttended ?? null,
    preferred_language: h.preferredLanguage ?? null,
    needs_delivery: h.needsDelivery,
    needs_email_outreach: h.needsEmailOutreach,
    needs_rebooking: h.needsRebooking ?? false,
    rebook_from: h.rebookFrom ?? null,
    set_aside: h.setAside
      ? { note: h.setAside.note, at: h.setAside.at, by: h.setAside.by }
      : null,
  };
}

function requestOut(r: RequestRow | SocialServiceRequestRow): Record<string, unknown> {
  return {
    id: r.id,
    type: r.type,
    label: labelFor(r.type),
    status: r.status,
    request_opened_at: r.requestOpenedAt,
    processing_date: r.processingDate ?? null,
    notes: r.notes ?? null,
    paced_until: r.pacedUntil ?? null,
    partner_org: (r as SocialServiceRequestRow).partnerOrg ?? null,
  };
}

function checkinViewOut(view: CheckinView): Record<string, unknown> {
  return {
    household: householdOut(view.household),
    open_requests: view.openRequests.map(requestOut),
    open_social_service_requests: view.openSocialServiceRequests.map(requestOut),
    delivered_request_types: view.deliveredRequestTypes,
  };
}

function distroOut(d: Distro): Record<string, unknown> {
  return {
    id: d.id,
    date_time: d.dateTime,
    location: d.location ?? null,
    duration_minutes: d.durationMinutes ?? null,
    appointments: d.appointments ?? null,
    notes: d.notes ?? null,
    slot_capacity: d.slotCapacity ?? null,
    status: d.status ?? "Scheduled",
    cancelled_at: d.cancelledAt ?? null,
    cancel_reason: d.cancelReason ?? null,
  };
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError(/unknown/i.test(message) ? 404 : 400, message);
  }
}

// --- Browse helpers (parity with bam/services/browse.py) --------------------

function categoryOf(type: string): string | null {
  return BY_KEY[type]?.category ?? null;
}

/** Minutes-since-midnight for an "11:00 AM" display string, so the check-in
 * queue sorts chronologically (a raw string sort puts "11:00 AM" first).
 * Unset sorts last; present-but-unparseable sorts just before that. */
function timeSortKey(appointmentTime?: string): number {
  if (!appointmentTime) return 24 * 60 + 1;
  const m = appointmentTime.trim().toUpperCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return 24 * 60;
  let hour = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === "PM" && hour !== 12) hour += 12;
  if (m[3] === "AM" && hour === 12) hour = 0;
  return hour * 60 + min;
}

function clampPage(limit?: number, offset?: number): [number, number] {
  return [
    Math.max(1, Math.min(Number(limit ?? 50), 200)),
    Math.max(0, Number(offset ?? 0)),
  ];
}

/** Open goods + social-service request counts, keyed by household id. */
function openCounts(doc: BamDoc): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (hid: string) => counts.set(hid, (counts.get(hid) ?? 0) + 1);
  for (const r of Object.values(doc.requests)) if (r.status === "Open") bump(r.householdId);
  for (const r of Object.values(doc.socialServiceRequests)) if (r.status === "Open") bump(r.householdId);
  return counts;
}

const byName = (a: { name?: string }, b: { name?: string }) =>
  (a.name ?? "").toLowerCase().localeCompare((b.name ?? "").toLowerCase());

/** Build the `BAM.api`-compatible adapter over an open store. */
export function makeWebApi(store: BamStore) {
  const doc = (): BamDoc => store.base.doc();
  const distrosDoc = (): DistrosDoc | undefined => store.distros?.doc();
  const roster = () => store.roster.doc();
  const me = () => ({
    peerId: store.peerId,
    name: roster()?.members[store.peerId]?.name,
  });
  const amAdmin = () => isAdmin(roster(), store.peerId);
  const requireAdmin = (what: string): void => {
    if (!amAdmin()) throw new ApiError(403, `Only admins can ${what}.`);
  };
  const requireDistrosDoc = () => {
    if (!store.distros) {
      throw new ApiError(
        403,
        "This device doesn't have access to the Distros & shifts data."
      );
    }
    return store.distros;
  };
  /** Every distro this device can see: the distros doc + legacy base rows. */
  const allDistros = (): Distro[] => [
    ...Object.values(doc().distros),
    ...Object.values(distrosDoc()?.distros ?? {}),
  ];
  const distroOnDate = (date: string): Distro | undefined =>
    allDistros().find(
      (d) => localDate(d.dateTime) === date && d.status !== "Cancelled"
    );

  return {
    ApiError,

    // Check-in (spec 6.3) --------------------------------------------------
    async lookup(phone: string) {
      const view = lookupByPhone(doc(), phone);
      if (!view) throw new ApiError(404, `No household with phone '${phone}'`);
      return checkinViewOut(view);
    },
    async searchByName(name: string) {
      return searchByName(doc(), name).map((h) => ({
        id: h.id,
        name: h.name ?? null,
        phone_number: h.phoneNumber ?? null,
        languages: h.languages,
      }));
    },
    async searchByPhone(digits: string) {
      return searchByPhoneSuffix(doc(), digits).map((h) => ({
        id: h.id,
        name: h.name ?? null,
        phone_number: h.phoneNumber ?? null,
        languages: h.languages,
      }));
    },
    async searchByEmail(fragment: string) {
      return searchByEmail(doc(), fragment).map((h) => ({
        id: h.id,
        name: h.name ?? null,
        phone_number: h.phoneNumber ?? null,
        email: h.email ?? null,
        languages: h.languages,
      }));
    },
    /** Can THIS device edit household contact info? (admins + contactFix cap) */
    canFixContacts(): boolean {
      return hasCap(roster(), store.peerId, "contactFix");
    },
    async updateContact(id: string, body: { phone_number?: string; email?: string }) {
      if (!hasCap(roster(), store.peerId, "contactFix")) {
        throw new ApiError(
          403,
          "This device isn't allowed to edit contact info — ask an admin for the contact-fix grant."
        );
      }
      const patch: { phoneNumber?: string; email?: string } = {};
      if (body.phone_number != null && String(body.phone_number).trim() !== "") {
        patch.phoneNumber = String(body.phone_number);
      }
      if (body.email != null && String(body.email).trim() !== "") {
        patch.email = String(body.email);
      }
      return householdOut(wrap(() => updateContact(store.base, id, patch, me())));
    },
    async setSetAside(id: string, body: { note?: string | null } = {}) {
      const note = body.note == null || body.note === "" ? null : String(body.note);
      return householdOut(wrap(() => setSetAside(store.base, id, note, me())));
    },
    async setNeedsDelivery(id: string, body: { on: boolean }) {
      return householdOut(wrap(() => setNeedsDelivery(store.base, id, !!body.on)));
    },
    async householdView(id: string) {
      const h = doc().households[id];
      if (!h) throw new ApiError(404, `Unknown household id ${id}`);
      return checkinViewOut(buildCheckinView(doc(), h));
    },
    async checkIn(id: string) {
      return householdOut(wrap(() => checkIn(store.base, id)));
    },
    async fulfill(body: { request_ids?: string[]; social_service_request_ids?: string[] } = {}) {
      const requestIds = body.request_ids ?? [];
      const socialIds = body.social_service_request_ids ?? [];
      wrap(() =>
        fulfill(store.base, { requestIds, socialServiceRequestIds: socialIds })
      );
      const after = doc();
      return {
        requests: requestIds.map((id) => requestOut(after.requests[id]!)),
        social_service_requests: socialIds.map((id) =>
          requestOut(after.socialServiceRequests[id]!)
        ),
      };
    },
    async timeout(body: { request_ids?: string[]; social_service_request_ids?: string[] } = {}) {
      const requestIds = body.request_ids ?? [];
      const socialIds = body.social_service_request_ids ?? [];
      wrap(() =>
        timeoutRequestsDomain(store.base, { requestIds, socialServiceRequestIds: socialIds })
      );
      const after = doc();
      return {
        requests: requestIds.map((id) => requestOut(after.requests[id]!)),
        social_service_requests: socialIds.map((id) =>
          requestOut(after.socialServiceRequests[id]!)
        ),
      };
    },

    // Intake (spec 6.1) ----------------------------------------------------
    async intake(payload: Record<string, unknown>) {
      const result = await submitIntake(store.base, {
        phoneNumber: String(payload.phone_number ?? ""),
        name: (payload.name as string) ?? undefined,
        email: (payload.email as string) ?? undefined,
        languages: (payload.languages as string[]) ?? [],
        preferredLanguage: (payload.preferred_language as string) ?? undefined,
        requestTypes: (payload.request_types as string[]) ?? [],
        furnitureItems: (payload.furniture_items as string[]) ?? [],
        bedDetails: (payload.bed_details as string[]) ?? [],
        kitchenItems: (payload.kitchen_items as string[]) ?? [],
        socialServiceRequests: (payload.social_service_requests as string[]) ?? [],
        internetAccess: (payload.internet_access as string[]) ?? [],
        roofAccessible: !!payload.roof_accessible,
        notes: (payload.notes as string) ?? undefined,
        streetAddress: (payload.street_address as string) ?? undefined,
        cityState: (payload.city_state as string) ?? undefined,
        zipCode: payload.zip_code != null ? String(payload.zip_code) : undefined,
      });
      return {
        submission_id: 0, // no separate submissions table in the CRDT model
        household_id: result.householdId,
        created_household: result.createdHousehold,
        created_request_ids: result.createdRequestIds,
        created_social_service_request_ids: result.createdSocialServiceRequestIds,
        skipped_duplicate_types: result.skippedDuplicateTypes,
        unknown_types: result.unknownTypes,
        paced_types: result.pacedTypes.map((p) => ({ type: p.type, until: p.until })),
        out_of_season_types: result.outOfSeasonTypes,
        phone_valid: result.phoneValid,
        already_processed: false,
      };
    },

    // Outreach (spec 6.2 + A4-A6) -------------------------------------------
    async outreachList(filters: Record<string, unknown> = {}) {
      return buildOutreachList(doc(), {
        requestTypes: (filters.request_types as string[]) ?? undefined,
        languages: (filters.languages as string[]) ?? undefined,
        excludeTextedWithinDays: (filters.exclude_texted_within_days as number) ?? 0,
        excludeAttendedWithinDays: (filters.exclude_attended_within_days as number) ?? 0,
        limit: (filters.limit as number) ?? undefined,
        channel: (filters.channel as "sms" | "email") ?? undefined,
        rebookingOnly: !!filters.rebooking_only,
      }).map((c) => ({
        household_id: c.householdId,
        name: c.name ?? null,
        phone_number: c.phoneNumber ?? null,
        email: c.email ?? null,
        languages: c.languages,
        preferred_language: c.preferredLanguage ?? null,
        unsupported_language: c.unsupportedLanguage,
        needs_rebooking: c.needsRebooking,
        open_request_types: c.openRequestTypes,
        oldest_open_request_at: c.oldestOpenRequestAt ?? null,
        last_texted: c.lastTexted ?? null,
      }));
    },
    async blast(
      body: {
        household_ids?: string[];
        template?: string;
        templates?: { [lang: string]: string };
        max_messages?: number;
        channel?: "sms" | "email";
        subject?: string;
      } = {}
    ) {
      const report = queueBlast(
        store.base,
        {
          householdIds: body.household_ids ?? [],
          template: body.template ?? "",
          templates: body.templates,
          maxMessages: body.max_messages ?? undefined,
          channel: body.channel ?? undefined,
          subject: body.subject ?? undefined,
        },
        nowIso(),
        store.peerId
      );
      return {
        sent: report.sent,
        failed: 0, // messages are queued to the shared outbox, not sent inline
        skipped_invalid: report.skippedInvalid,
        skipped_no_phone: report.skippedNoPhone,
        skipped_no_email: (report as { skippedNoEmail?: number }).skippedNoEmail ?? 0,
        not_sent_over_limit: report.notSentOverLimit,
        unknown_household_ids: report.unknownHouseholdIds,
        messages: report.messages.map((m) => ({
          household_id: m.householdId,
          to: m.to,
          body: m.body,
          ok: true,
          error: null,
        })),
      };
    },
    async bookAppointment(
      id: string,
      body: { appointment_date: string; appointment_time: string; force?: boolean }
    ) {
      try {
        return householdOut(
          wrap(() =>
            bookAppointmentChecked(
              store.base,
              distrosDoc(),
              id,
              { date: body.appointment_date, time: body.appointment_time },
              { force: !!body.force }
            )
          )
        );
      } catch (err) {
        if (err instanceof SlotFullError) {
          throw new ApiError(409, err.message);
        }
        throw err;
      }
    },
    /** Live booking pressure for a date: per-slot usage + that distro's cap. */
    async slotUsage(date: string) {
      const distro = distroOnDate(date);
      return {
        date,
        slot_capacity: distro?.slotCapacity ?? null,
        distro_id: distro?.id ?? null,
        usage: slotUsage(doc(), date),
      };
    },
    async recordOutcome(id: string, body: { outcome: string; note?: string | null }) {
      return householdOut(
        wrap(() =>
          recordOutcome(
            store.base,
            id,
            body.outcome as OutreachOutcome,
            body.note ?? undefined
          )
        )
      );
    },

    // Distros ----------------------------------------------------------------
    // Distros live in their own doc (the first grantable data domain); this
    // device may not hold it. Reads merge the legacy base rows; writes need
    // the doc. distrosAccess() tells the views which state they're in.
    distrosAccess(): "granted" | "denied" | "legacy" {
      if (store.distros) return "granted";
      const r = roster();
      if (r?.dataDomains?.["distros"]) {
        return domainAllowed(r, store.peerId, "distros") ? "granted" : "denied";
      }
      return "legacy";
    },
    async createDistro(body: Record<string, unknown>) {
      const handle = requireDistrosDoc();
      const input: Parameters<typeof createDistroDomain>[1] = {
        dateTime: String(body.date_time),
      };
      if (body.location) input.location = String(body.location);
      if (body.duration_minutes != null) input.durationMinutes = Number(body.duration_minutes);
      if (body.appointments != null) input.appointments = String(body.appointments);
      if (body.notes) input.notes = String(body.notes);
      if (body.slot_capacity != null && body.slot_capacity !== "") {
        input.slotCapacity = Number(body.slot_capacity);
      }
      return distroOut(wrap(() => createDistroDomain(handle, input)));
    },
    async listDistros() {
      return allDistros()
        .sort((a, b) => (a.dateTime < b.dateTime ? -1 : 1))
        .map(distroOut);
    },
    async cancelDistro(id: string, body: { reason?: string } = {}) {
      const handle = requireDistrosDoc();
      const result = wrap(() =>
        cancelDistroDomain(handle, store.base, id, { reason: body.reason })
      );
      return {
        distro: distroOut(result.distro),
        rebooked_household_ids: result.rebookHouseholdIds,
      };
    },
    async noShows(body: { distro_date: string }) {
      const report = wrap(() => processNoShows(store.base, body.distro_date));
      return {
        missed_household_ids: report.missedHouseholdIds,
        timed_out_household_ids: report.timedOutHouseholdIds,
      };
    },

    // Shifts & coverage board (in the distros doc) ---------------------------
    async listShifts(params: { from?: string; to?: string; include_past?: boolean } = {}) {
      return listShiftSlots(distrosDoc(), {
        from: params.from,
        to: params.to,
        includePast: !!params.include_past,
        todayLocal: localDate(nowIso()),
      }).map((s) => ({
        id: s.id,
        date: s.date,
        event_label: s.eventLabel,
        role: s.role,
        language_required: s.languageRequired ?? null,
        needed: s.needed,
        notes: s.notes ?? null,
        claimed_count: s.claimedCount,
        gap: s.gap,
        claimants: s.claimants.map((c) => ({ peer_id: c.peerId, name: c.name, at: c.at })),
        mine: !!s.claims[store.peerId],
      }));
    },
    async createShift(body: Record<string, unknown>) {
      requireAdmin("create shift slots");
      const handle = requireDistrosDoc();
      const input: Parameters<typeof createShiftSlot>[1] = {
        date: String(body.date),
        eventLabel: String(body.event_label ?? "Distro"),
        role: String(body.role ?? "Volunteer"),
      };
      if (body.language_required) input.languageRequired = String(body.language_required);
      if (body.needed != null) input.needed = Number(body.needed);
      if (body.notes) input.notes = String(body.notes);
      const slot = wrap(() => createShiftSlot(handle, input, store.peerId));
      return { id: slot.id };
    },
    async updateShift(id: string, body: Record<string, unknown>) {
      requireAdmin("edit shift slots");
      const handle = requireDistrosDoc();
      const patch: Parameters<typeof updateShiftSlot>[2] = {};
      if (body.date != null) patch.date = String(body.date);
      if (body.event_label != null) patch.eventLabel = String(body.event_label);
      if (body.role != null) patch.role = String(body.role);
      if (body.language_required != null) patch.languageRequired = String(body.language_required);
      if (body.needed != null) patch.needed = Number(body.needed);
      if (body.notes != null) patch.notes = String(body.notes);
      wrap(() => updateShiftSlot(handle, id, patch));
      return { ok: true };
    },
    async removeShift(id: string) {
      requireAdmin("remove shift slots");
      const handle = requireDistrosDoc();
      wrap(() => removeShiftSlot(handle, id));
      return { ok: true };
    },
    async claimShift(id: string, body: { name?: string } = {}) {
      const handle = requireDistrosDoc();
      const name = body.name?.trim() || me().name || `device ${store.peerId.slice(0, 8)}`;
      try {
        wrap(() => claimShiftSlot(handle, id, { peerId: store.peerId, name }));
      } catch (err) {
        if (err instanceof ShiftFullError) throw new ApiError(409, err.message);
        throw err;
      }
      return { ok: true };
    },
    async releaseShift(id: string, body: { peer_id?: string } = {}) {
      const handle = requireDistrosDoc();
      const target = body.peer_id ?? store.peerId;
      if (target !== store.peerId) requireAdmin("release someone else's shift");
      wrap(() => releaseShiftSlot(handle, id, target));
      return { ok: true };
    },

    // Partner sync (status × partner-org model) ------------------------------
    async partnerSync(body: Record<string, unknown>) {
      if (!hasCap(roster(), store.peerId, "partnerSync")) {
        throw new ApiError(
          403,
          "This device isn't allowed to run partner syncs — ask an admin for the partner-sync grant."
        );
      }
      const report = wrap(() =>
        partnerSyncByPhone(store.base, {
          partner: String(body.partner ?? ""),
          phones: (body.phones as string[]) ?? [],
          outcome: (body.outcome as "Delivered" | "Timeout") ?? "Delivered",
          types: (body.types as string[]) ?? undefined,
          includeGoods: body.include_goods == null ? true : !!body.include_goods,
          includeServices: body.include_services == null ? true : !!body.include_services,
          dryRun: !!body.dry_run,
        })
      );
      return {
        dry_run: !!body.dry_run,
        matched_household_ids: report.matchedHouseholdIds,
        closed_request_ids: report.closedRequestIds,
        closed_social_service_request_ids: report.closedSocialServiceRequestIds,
        unmatched_phones: report.unmatchedPhones,
      };
    },
    async setPartnerOrg(id: string, body: { partner?: string | null } = {}) {
      wrap(() => setPartnerOrg(store.base, id, body.partner ?? null));
      return { ok: true };
    },
    async partnerOrgs() {
      return { partner_orgs: doc().config?.partnerOrgs ?? [] };
    },
    async setPartnerOrgs(body: { partner_orgs: string[] }) {
      requireAdmin("edit the partner list");
      store.base.change((d) => {
        if (!d.config) d.config = { name: d.meta.org };
        d.config.partnerOrgs = (body.partner_orgs ?? [])
          .map((p) => String(p).trim())
          .filter(Boolean);
      });
      return { ok: true };
    },

    // Reporting: waitlist + impact -------------------------------------------
    async waitlist() {
      const rows = waitlistReport(doc(), localDate(nowIso()));
      return rows.map((r) => ({
        type: r.type,
        label: r.label,
        category: r.category,
        open: r.open,
        paced: r.paced,
        by_language: r.byLanguage,
        unsupported_language: r.unsupportedLanguage,
        age: r.age,
        oldest_open_at: r.oldestOpenAt,
      }));
    },
    async impact(range: { start?: string; end?: string } = {}) {
      const r = impactReport(doc(), range);
      return {
        generated_at: r.generatedAt,
        start: r.start,
        end: r.end,
        delivered: r.delivered,
        total_delivered: r.totalDelivered,
      };
    },

    // Item policies (cooldowns + seasonal windows) ---------------------------
    async itemPolicies() {
      const d = doc();
      const today = localDate(nowIso());
      const out: Record<string, unknown> = {};
      for (const t of [...GOODS, ...SOCIAL_SERVICES]) {
        const p = itemPolicyFor(d, t.key);
        if (!p) continue;
        out[t.key] = {
          cooldown_days: p.cooldownDays ?? null,
          season_from: p.seasonFrom ?? null,
          season_until: p.seasonUntil ?? null,
          disabled: !!p.disabled,
          in_season: isInSeason(p, today),
        };
      }
      return out;
    },
    async setItemPolicy(typeKey: string, body: Record<string, unknown>) {
      requireAdmin("edit item policies");
      if (!BY_KEY[typeKey]) throw new ApiError(404, `Unknown catalog type '${typeKey}'`);
      wrap(() =>
        setItemPolicyDomain(store.base, typeKey, {
          cooldownDays:
            body.cooldown_days == null || body.cooldown_days === ""
              ? null
              : Number(body.cooldown_days),
          seasonFrom:
            body.season_from == null || body.season_from === ""
              ? null
              : String(body.season_from),
          seasonUntil:
            body.season_until == null || body.season_until === ""
              ? null
              : String(body.season_until),
          disabled: body.disabled == null ? null : !!body.disabled,
        })
      );
      return { ok: true };
    },

    // Referral cues shown at check-in ---------------------------------------
    async referrals() {
      return {
        referrals: (doc().config?.referrals ?? []).map((r) => ({
          label: r.label,
          url: r.url ?? null,
          show_for_types: r.showForTypes ?? [],
        })),
      };
    },
    async setReferrals(body: {
      referrals: Array<{ label: string; url?: string; show_for_types?: string[] }>;
    }) {
      requireAdmin("edit referral cues");
      store.base.change((d) => {
        if (!d.config) d.config = { name: d.meta.org };
        d.config.referrals = (body.referrals ?? [])
          .filter((r) => r.label && String(r.label).trim())
          .map((r) => {
            const entry: { label: string; url?: string; showForTypes?: string[] } = {
              label: String(r.label).trim(),
            };
            if (r.url && String(r.url).trim()) entry.url = String(r.url).trim();
            const types = (r.show_for_types ?? []).map(String).filter(Boolean);
            if (types.length) entry.showForTypes = types;
            return entry;
          });
      });
      return { ok: true };
    },

    // Jobs --------------------------------------------------------------------
    async expire() {
      const report = expireStale(store.base);
      return {
        timed_out_request_ids: report.timedOutRequestIds,
        timed_out_social_service_request_ids: report.timedOutSocialServiceRequestIds,
      };
    },
    async websiteData() {
      const counts = openRequestCounts(doc());
      return { generated_at: counts.generatedAt, counts: counts.counts };
    },
    async scrubPii() {
      const report = await scrubExpiredPii(store.base);
      return {
        households_anonymized: report.householdsAnonymized,
        requests_scrubbed: report.requestsScrubbed,
        social_service_requests_scrubbed: report.socialServiceRequestsScrubbed,
        submissions_scrubbed: 0,
      };
    },

    // Metrics -------------------------------------------------------------------
    async openRequests() {
      const counts = openRequestCounts(doc());
      return { generated_at: counts.generatedAt, counts: counts.counts };
    },
    async fulfilled(range: { start?: string; end?: string } = {}) {
      return fulfilledCountsRange(doc(), range);
    },

    // Catalog ---------------------------------------------------------------------
    async catalog() {
      const d = doc();
      const today = localDate(nowIso());
      const entry = (t: { key: string; label: string; category: string }) => {
        const p = itemPolicyFor(d, t.key);
        return {
          key: t.key,
          label: t.label,
          category: t.category,
          cooldown_days: p?.cooldownDays ?? null,
          in_season: isInSeason(p, today) && !isDisabled(p),
          disabled: isDisabled(p),
        };
      };
      return {
        goods: GOODS.map(entry),
        social_services: SOCIAL_SERVICES.map(entry),
        languages: [...LANGUAGES],
      };
    },

    // Instance config (white-label) — read from the CRDT doc, mapped to the
    // console's snake_case shape (same as the server's GET /config), so the
    // shared app.js themes from BAM.api.config() with no server.
    async config() {
      const d = doc();
      const c = d.config ?? { name: d.meta.org };
      const b = c.branding ?? {};
      return {
        org: {
          name: c.name,
          short_name: c.shortName ?? null,
          tagline: c.tagline ?? null,
          timezone: c.timezone ?? null,
        },
        branding: {
          primary_color: b.primaryColor ?? null,
          accent_color: b.accentColor ?? null,
          theme_color: b.themeColor ?? null,
          title: b.title ?? c.name,
          logo: b.logo ?? "loaf",
        },
        features: c.features ?? {},
        catalog: {
          goods: GOODS.map((t) => ({ key: t.key, label: t.label, category: t.category })),
          social_services: SOCIAL_SERVICES.map((t) => ({ key: t.key, label: t.label, category: t.category })),
          languages: [...LANGUAGES],
        },
      };
    },

    // Browse / list views (parity with the Airtable Interfaces) ------------
    async appointments(date?: string) {
      const d = doc();
      const day = date || localDate(nowIso());
      const counts = openCounts(d);
      return Object.values(d.households)
        .filter((h) => h.appointmentDate === day)
        .sort((a, b) => timeSortKey(a.appointmentTime) - timeSortKey(b.appointmentTime) || byName(a, b))
        .map((h) => ({
          household_id: h.id,
          name: h.name ?? null,
          phone_number: h.phoneNumber ?? null,
          languages: h.languages,
          appointment_time: h.appointmentTime ?? null,
          appointment_status: h.appointmentStatus ?? null,
          open_request_count: counts.get(h.id) ?? 0,
          needs_delivery: h.needsDelivery,
          set_aside: h.setAside ? h.setAside.note : null,
        }));
    },

    async browseHouseholds(
      params: { query?: string; limit?: number; offset?: number } = {}
    ) {
      const d = doc();
      const [limit, offset] = clampPage(params.limit, params.offset);
      const q = (params.query ?? "").trim().toLowerCase();
      let all = Object.values(d.households);
      if (q) {
        all = all.filter(
          (h) =>
            (h.name ?? "").toLowerCase().includes(q) ||
            (h.phoneNumber ?? "").toLowerCase().includes(q)
        );
      }
      all.sort(byName);
      const total = all.length;
      const counts = openCounts(d);
      const items = all.slice(offset, offset + limit).map((h) => ({
        id: h.id,
        name: h.name ?? null,
        phone_number: h.phoneNumber ?? null,
        languages: h.languages,
        appointment_date: h.appointmentDate ?? null,
        appointment_time: h.appointmentTime ?? null,
        appointment_status: h.appointmentStatus ?? null,
        open_request_count: counts.get(h.id) ?? 0,
      }));
      return { items, total, limit, offset };
    },

    async browseRequests(
      params: { category?: string; type?: string; status?: string; limit?: number; offset?: number } = {}
    ) {
      const d = doc();
      const [limit, offset] = clampPage(params.limit, params.offset);
      let all = Object.values(d.requests);
      if (params.category) all = all.filter((r) => categoryOf(r.type) === params.category);
      if (params.type) all = all.filter((r) => r.type === params.type);
      if (params.status) all = all.filter((r) => r.status === params.status);
      all.sort((a, b) => b.requestOpenedAt.localeCompare(a.requestOpenedAt));
      const total = all.length;
      const items = all.slice(offset, offset + limit).map((r) => {
        const h = d.households[r.householdId];
        return {
          id: r.id,
          type: r.type,
          label: labelFor(r.type),
          category: categoryOf(r.type),
          status: r.status,
          request_opened_at: r.requestOpenedAt,
          household_id: r.householdId,
          household_name: h?.name ?? null,
          household_phone: h?.phoneNumber ?? null,
          address: r.address ?? null,
          geocode: r.geocode ?? null,
          bin: r.bin ?? null,
          address_accuracy: r.addressAccuracy ?? null,
          notes: r.notes ?? null,
        };
      });
      return { items, total, limit, offset };
    },

    async browseServices(
      params: { type?: string; status?: string; limit?: number; offset?: number } = {}
    ) {
      const d = doc();
      const [limit, offset] = clampPage(params.limit, params.offset);
      let all = Object.values(d.socialServiceRequests);
      if (params.type) all = all.filter((r) => r.type === params.type);
      if (params.status) all = all.filter((r) => r.status === params.status);
      all.sort((a, b) => b.requestOpenedAt.localeCompare(a.requestOpenedAt));
      const total = all.length;
      const items = all.slice(offset, offset + limit).map((r) => {
        const h = d.households[r.householdId];
        return {
          id: r.id,
          type: r.type,
          label: labelFor(r.type),
          status: r.status,
          request_opened_at: r.requestOpenedAt,
          household_id: r.householdId,
          household_name: h?.name ?? null,
          household_phone: h?.phoneNumber ?? null,
          mesh_status: r.meshStatus ?? null,
          bin: r.bin ?? null,
          address_accuracy: r.addressAccuracy ?? null,
          internet_access: r.internetAccess ?? [],
          partner_org: r.partnerOrg ?? null,
          notes: r.notes ?? null,
        };
      });
      return { items, total, limit, offset };
    },
  };
}
