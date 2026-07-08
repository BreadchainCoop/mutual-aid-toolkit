/**
 * CRDT document schema for the local-first BAM system.
 *
 * Two Automerge documents:
 *
 * - The ROSTER doc (`RosterDoc`) is the access-control root: which Ed25519
 *   device keys (Subduction PeerIds, hex) may sync, and with what role. It
 *   drives the Subduction `Policy` hooks — see roster.ts.
 * - The BASE doc (`BamDoc`) holds the operational data: the same six-table
 *   model as the server implementation (see ../../bam/models.py), keyed by
 *   stable string ids so concurrent edits from different devices merge
 *   per-record instead of conflicting.
 *
 * Design notes:
 * - Ids are strings. Migrated rows keep their Airtable record id; new rows
 *   get `crockford(random)` ids from newId().
 * - Timestamps are ISO-8601 UTC strings, dates are YYYY-MM-DD — Automerge
 *   scalars, so last-writer-wins per field, which matches the operational
 *   semantics (a later status change should win).
 * - There is no SMS provider inside the CRDT world: an outreach blast
 *   appends to `smsOutbox`; any connected gateway device (or an operator)
 *   drains the outbox and stamps `sentAt`. This is the local-first version
 *   of the spec 5 `send_sms` function.
 */

export type RequestStatus = "Open" | "Timeout" | "Delivered";
export type AppointmentStatus = "Booked" | "Checked-in" | "Missed";
export type Role = "admin" | "volunteer";

export interface Household {
  id: string;
  name?: string;
  phoneNumber?: string; // E.164
  phoneHash?: string; // sha256, survives anonymization
  invalidPhoneNumber: boolean;
  intlPhoneNumber: boolean;
  email?: string;
  emailError?: string;
  languages: string[];
  notes?: string;
  appointmentDate?: string; // YYYY-MM-DD
  appointmentTime?: string;
  appointmentStatus?: AppointmentStatus;
  missedAppointmentCount: number;
  lastTexted?: string; // YYYY-MM-DD
  lastCalled?: string;
  lastAttended?: string;
  needsDelivery: boolean;
  needsEmailOutreach: boolean;
  anonymizedAt?: string; // ISO datetime
  createdAt: string; // ISO datetime
  updatedAt: string;
}

export interface RequestRow {
  id: string;
  type: string; // catalog key, or raw label when unresolvable
  householdId: string;
  status: RequestStatus;
  notes?: string;
  requestOpenedAt: string; // ISO datetime
  statusLastUpdatedAt: string;
  processingDate?: string; // YYYY-MM-DD (+14 / +30 on close)
  streetAddress?: string;
  cityState?: string;
  zipCode?: string;
  geocode?: string;
  address?: string;
  bin?: string; // NYC Building Identification Number (furniture delivery)
  addressAccuracy?: string; // Apartment/Building/No result/...
  createdAt: string;
  updatedAt: string;
}

export interface SocialServiceRequestRow {
  id: string;
  type: string;
  householdId: string;
  status: RequestStatus;
  notes?: string;
  internetAccess: string[];
  roofAccessible: boolean;
  streetAddress?: string;
  cityState?: string;
  zipCode?: string;
  address?: string;
  meshStatus?: string; // raw mesh install pipeline stage (type === mesh_internet)
  bin?: string; // NYC Building Identification Number (Mesh)
  addressAccuracy?: string;
  requestOpenedAt: string;
  statusLastUpdatedAt: string;
  processingDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Distro {
  id: string;
  dateTime: string; // ISO datetime
  location?: string;
  durationMinutes?: number;
  appointments?: string;
  notes?: string;
  createdAt: string;
}

export interface OutboxMessage {
  id: string;
  to: string; // E.164
  body: string;
  householdId: string;
  queuedAt: string; // ISO datetime
  queuedBy: string; // PeerId hex of the device that queued it
  sentAt?: string; // stamped by whichever gateway device sends it
  error?: string;
}

/**
 * White-label instance config, stored IN the CRDT doc so it syncs to every
 * device (no server, no rebuild). The founding admin sets it at org creation;
 * the console themes itself from it. Mirrors the server's InstanceConfig shape.
 */
export interface OrgConfig {
  name: string;
  shortName?: string;
  tagline?: string;
  timezone?: string;
  branding?: {
    primaryColor?: string;
    accentColor?: string;
    themeColor?: string;
    title?: string;
    logo?: string; // "hands" | "initials" | "none" | raw inline <svg>
  };
  /** Per-view feature toggles, e.g. { furniture: false }. Missing = enabled. */
  features?: { [view: string]: boolean };
}

export interface BamDoc {
  meta: {
    org: string;
    schemaVersion: number;
    createdAt: string;
  };
  /** Instance identity/branding/features (white-label). */
  config?: OrgConfig;
  households: { [id: string]: Household };
  requests: { [id: string]: RequestRow };
  socialServiceRequests: { [id: string]: SocialServiceRequestRow };
  distros: { [id: string]: Distro };
  /** Fulfilled Request Count, one entry per "YYYY-MM-DD|typeKey". */
  fulfilledCounts: { [dateAndType: string]: number };
  smsOutbox: { [id: string]: OutboxMessage };
}

export interface RosterMember {
  /** Subduction PeerId (hex of the Ed25519 verifying key). */
  peerId: string;
  name: string;
  role: Role;
  addedBy: string; // PeerId hex, or "invite:<inviteId>" for self-enrollment
  addedAt: string; // ISO datetime
  revokedAt?: string;
  revokedBy?: string;
  /** Set when self-enrolled via a QR invite. */
  inviteId?: string;
  /** The invite secret (preimage of the invite's tokenHash) — replicas
   * validate sha256(inviteProof) === invite.tokenHash. Visible to roster
   * members only; invites are short-lived and revocable. */
  inviteProof?: string;
}

/**
 * A QR-invite: a bearer credential minted by an admin. The SECRET travels
 * only inside the QR/link; the roster stores its sha256 so every replica
 * can validate self-enrollments without being able to mint new ones.
 */
export interface RosterInvite {
  id: string;
  /** Label shown in the roster view, e.g. "July distro volunteers". */
  name: string;
  /** sha256 hex of the invite secret. */
  tokenHash: string;
  /** Always "volunteer" — admin roles are never grantable by QR. */
  role: Role;
  createdBy: string; // admin PeerId hex
  createdAt: string;
  expiresAt: string; // ISO datetime; redemptions after this are invalid
  /** Soft cap, enforced at redemption time by honest clients and visible
   * to admins (see roster.ts for the trust discussion). */
  maxUses: number;
  revokedAt?: string;
  revokedBy?: string;
}

export interface RosterDoc {
  org: string;
  createdAt: string;
  /** keyed by PeerId hex */
  members: { [peerId: string]: RosterMember };
  /** QR-invites, keyed by invite id. */
  invites?: { [inviteId: string]: RosterInvite };
  /**
   * The Automerge URL of the base document, so a newly-invited device only
   * needs the roster URL + relay endpoint to find everything.
   */
  baseDocUrl?: string;
}

/** Automerge rejects explicit `undefined`; drop such keys (recursively) so an
 * org config with empty optional fields (e.g. no short name) can be written. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

export function emptyBamDoc(org: string, now: string, config?: OrgConfig): BamDoc {
  return {
    meta: { org, schemaVersion: 1, createdAt: now },
    config: stripUndefined(config ?? { name: org }),
    households: {},
    requests: {},
    socialServiceRequests: {},
    distros: {},
    fulfilledCounts: {},
    smsOutbox: {},
  };
}

export function emptyRosterDoc(org: string, now: string): RosterDoc {
  return { org, createdAt: now, members: {} };
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Random, sortable-enough 20-char id for rows created on-device. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % 32];
  return out;
}

export function nowIso(clock?: () => Date): string {
  return (clock ? clock() : new Date()).toISOString();
}

/** Business date (YYYY-MM-DD) in the org's timezone, default America/New_York. */
export function localDate(iso: string, timeZone = "America/New_York"): string {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

export function fulfilledCountKey(date: string, typeKey: string): string {
  return `${date}|${typeKey}`;
}
