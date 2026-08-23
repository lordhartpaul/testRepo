import { isCountryCode } from '../reference/countries.js';

/**
 * IBAN registry lengths. A country missing from the table is still checked with
 * the ISO 7064 MOD 97-10 checksum, it simply cannot be length-checked.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21,
  LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25,
  SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
});

export interface IbanCheck {
  readonly valid: boolean;
  /** Normalised (upper case, no separators) IBAN. */
  readonly normalised: string;
  readonly country?: string;
  /** Basic bank account number, i.e. the IBAN without country and check digits. */
  readonly bban?: string;
  readonly reason?: string;
  /** True when the country is absent from the registry table. */
  readonly lengthUnknown?: boolean;
}

const IBAN_SHAPE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/;

export function normaliseIban(value: string): string {
  return value.replace(/[\s.\-]/g, '').toUpperCase();
}

/** MOD 97-10 check over the rearranged IBAN, computed in chunks to stay exact. */
function mod97(value: string): number {
  let remainder = 0;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const digits =
      code >= 65 && code <= 90 ? String(code - 55) : char; // A=10 .. Z=35
    for (const digit of digits) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder;
}

export function validateIban(input: string): IbanCheck {
  const normalised = normaliseIban(input);

  if (normalised.length < 5 || !IBAN_SHAPE.test(normalised)) {
    return { valid: false, normalised, reason: 'not shaped like an IBAN' };
  }

  const country = normalised.slice(0, 2);
  if (!isCountryCode(country)) {
    return { valid: false, normalised, country, reason: `unknown country code ${country}` };
  }

  const expected = IBAN_LENGTHS[country];
  if (expected === undefined) {
    // Only countries in the IBAN registry issue IBANs. A domestic account
    // number that happens to start with two letters and two digits - and can
    // even pass the checksum by chance - is not one.
    return {
      valid: false,
      normalised,
      country,
      lengthUnknown: true,
      reason: `${country} does not participate in the IBAN registry`,
    };
  }
  if (normalised.length !== expected) {
    return {
      valid: false,
      normalised,
      country,
      reason: `length ${normalised.length} does not match the ${expected} characters registered for ${country}`,
    };
  }

  const rearranged = normalised.slice(4) + normalised.slice(0, 4);
  if (mod97(rearranged) !== 1) {
    return { valid: false, normalised, country, reason: 'checksum failed (ISO 7064 MOD 97-10)' };
  }

  return { valid: true, normalised, country, bban: normalised.slice(4) };
}

/** Cheap pre-test used when deciding whether a free text line is an account. */
export function looksLikeIban(value: string): boolean {
  const normalised = normaliseIban(value);
  if (!IBAN_SHAPE.test(normalised)) return false;
  const country = normalised.slice(0, 2);
  const expected = IBAN_LENGTHS[country];
  return expected !== undefined && normalised.length === expected;
}
