import { isCountryCode } from '../reference/countries.js';

/**
 * Business Identifier Code (ISO 9362) handling.
 *
 * Structure: 4 alphabetic institution code, 2 alphabetic country code,
 * 2 alphanumeric location code, optional 3 alphanumeric branch code.
 */
export const BIC8 = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}$/;
export const BIC11 = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}$/;

export interface BicCheck {
  readonly valid: boolean;
  readonly normalised: string;
  readonly institution?: string;
  readonly country?: string;
  readonly location?: string;
  readonly branch?: string;
  /** True for a test & training BIC (location code ends in `0`). */
  readonly test?: boolean;
  readonly reason?: string;
}

export function validateBic(input: string): BicCheck {
  const normalised = input.trim().toUpperCase();

  if (normalised.length !== 8 && normalised.length !== 11) {
    return { valid: false, normalised, reason: 'a BIC must be 8 or 11 characters' };
  }
  if (!BIC8.test(normalised.slice(0, 8))) {
    return { valid: false, normalised, reason: 'institution, country or location code is malformed' };
  }
  if (normalised.length === 11 && !/^[A-Z0-9]{3}$/.test(normalised.slice(8))) {
    return { valid: false, normalised, reason: 'branch code must be 3 alphanumeric characters' };
  }

  const country = normalised.slice(4, 6);
  if (!isCountryCode(country)) {
    return { valid: false, normalised, country, reason: `unknown country code ${country}` };
  }

  return {
    valid: true,
    normalised,
    institution: normalised.slice(0, 4),
    country,
    location: normalised.slice(6, 8),
    ...(normalised.length === 11 ? { branch: normalised.slice(8) } : {}),
    ...(normalised[7] === '0' ? { test: true } : {}),
  };
}

export function isBic(value: string): boolean {
  return validateBic(value).valid;
}

/** Expand a BIC8 to BIC11 by appending the default `XXX` branch. */
export function toBic11(value: string): string {
  const normalised = value.trim().toUpperCase();
  return normalised.length === 8 ? `${normalised}XXX` : normalised;
}

/** Reduce a BIC11 whose branch is `XXX` back to its BIC8 form. */
export function toBic8(value: string): string {
  const normalised = value.trim().toUpperCase();
  return normalised.length === 11 && normalised.endsWith('XXX')
    ? normalised.slice(0, 8)
    : normalised;
}

/** Country of the institution, used to infer addresses and clearing schemes. */
export function bicCountry(value: string): string | undefined {
  const check = validateBic(value);
  return check.valid ? check.country : undefined;
}
