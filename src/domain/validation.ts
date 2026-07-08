/**
 * Phone/email normalization and hashing (port of bam/validation.py, the V2
 * "/clean-record" role).
 *
 * The server build uses the `phonenumbers` library; here a pragmatic
 * zero-dependency E.164 normalizer with US as the default region covers the
 * shapes the forms actually produce. The intake flow stores the outcome on
 * the household via the spec's flag fields: `Invalid Phone Number?`,
 * `Int'l Phone Number?` and `Email Error`.
 *
 * `hashPhone` is byte-for-byte compatible with the Python `hash_phone`
 * (sha256 of the utf-8 string, lowercase hex) so migrated `phone_hash`
 * values still reconnect anonymized households:
 * sha256("+17185550100") = f9cac1eb20e53b4b0c965eb7d977bfa2f36cf2d0957a8153078270647f032a77.
 */

export interface PhoneValidation {
  normalized: string | null; // E.164, or null if unparseable
  valid: boolean;
  international: boolean; // valid but outside the US
}

export interface EmailValidation {
  normalized: string | null;
  error: string | null;
}

const INVALID_PHONE: PhoneValidation = { normalized: null, valid: false, international: false };

/**
 * Normalize a raw phone string to E.164, US default region:
 * - 10 digits -> +1##########
 * - 11 digits with a leading 1 -> +1##########
 * - "+"-prefixed international numbers pass through when they carry 8-15
 *   digits (`international` unless the country code is 1)
 * - anything else is invalid.
 */
export function normalizePhone(raw: string): PhoneValidation {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ...INVALID_PHONE };
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return { ...INVALID_PHONE };
    return { normalized: `+${digits}`, valid: true, international: !digits.startsWith("1") };
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) {
    return { normalized: `+1${digits}`, valid: true, international: false };
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return { normalized: `+${digits}`, valid: true, international: false };
  }
  return { ...INVALID_PHONE };
}

/** Stable hash so anonymized households reconnect on re-request (async
 * because WebCrypto's digest is). */
export async function hashPhone(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let out = "";
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0");
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Pragmatic email check (the server uses email_validator): empty input is
 * not an error, a malformed address yields `error` with no `normalized`,
 * and a good address is normalized by lowercasing the domain part.
 */
export function validateEmail(raw: string | undefined): EmailValidation {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { normalized: null, error: null };
  if (!EMAIL_RE.test(trimmed)) {
    return { normalized: null, error: `Invalid email address: ${trimmed}` };
  }
  const at = trimmed.lastIndexOf("@");
  const normalized = trimmed.slice(0, at) + "@" + trimmed.slice(at + 1).toLowerCase();
  return { normalized, error: null };
}
