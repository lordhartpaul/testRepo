import { isKnownCurrency, minorUnits } from '../reference/currencies.js';

export interface SemanticAmount {
  readonly currency: string;
  /** Amount rendered with an ISO 20022 decimal point, e.g. `1234.56`. */
  readonly value: string;
  /** Amount exactly as it appeared in the MT field. */
  readonly raw: string;
  readonly decimals: number;
  readonly valid: boolean;
  readonly problem?: string;
}

/** SWIFT writes the decimal separator as a comma and never uses thousands separators. */
export function swiftToIsoDecimal(amount: string): string {
  const normalised = amount.trim().replace(',', '.');
  return normalised.endsWith('.') ? normalised.slice(0, -1) : normalised;
}

/**
 * Parse `EUR1234,56` style values (fields 32B, 33B, 71F, 71G) and check the
 * number of decimals against the currency's ISO 4217 minor unit.
 */
export function parseCurrencyAmount(text: string): SemanticAmount {
  const trimmed = text.trim();
  const match = /^([A-Z]{3})([\d,]+)$/.exec(trimmed);
  if (!match) {
    return {
      currency: trimmed.slice(0, 3).toUpperCase(),
      value: '0',
      raw: trimmed,
      decimals: 0,
      valid: false,
      problem: `'${trimmed}' is not a currency followed by an amount`,
    };
  }

  const currency = (match[1] as string).toUpperCase();
  const raw = match[2] as string;
  return buildAmount(currency, raw);
}

/** Parse the `6!n3!a15d` combination used by field 32A. */
export function parseValueDateAmount(text: string): {
  readonly date6?: string;
  readonly amount: SemanticAmount;
} {
  const match = /^(\d{6})([A-Z]{3})([\d,]+)$/.exec(text.trim());
  if (!match) {
    return { amount: parseCurrencyAmount(text.trim().slice(6)) };
  }
  return {
    date6: match[1] as string,
    amount: buildAmount((match[2] as string).toUpperCase(), match[3] as string),
  };
}

function buildAmount(currency: string, raw: string): SemanticAmount {
  const commaCount = (raw.match(/,/g) ?? []).length;
  if (commaCount > 1) {
    return {
      currency,
      value: '0',
      raw,
      decimals: 0,
      valid: false,
      problem: `amount '${raw}' contains more than one decimal comma`,
    };
  }

  const value = swiftToIsoDecimal(raw);
  const decimals = value.includes('.') ? (value.split('.')[1] as string).length : 0;

  if (!/^\d+(\.\d+)?$/.test(value)) {
    return { currency, value: '0', raw, decimals, valid: false, problem: `amount '${raw}' is malformed` };
  }
  if (!isKnownCurrency(currency)) {
    return {
      currency,
      value,
      raw,
      decimals,
      valid: false,
      problem: `'${currency}' is not an active ISO 4217 currency code`,
    };
  }

  const allowed = minorUnits(currency);
  if (allowed !== null && allowed !== undefined && decimals > allowed) {
    return {
      currency,
      value,
      raw,
      decimals,
      valid: false,
      problem: `${currency} allows ${allowed} decimal(s) but the amount carries ${decimals}`,
    };
  }

  return { currency, value, raw, decimals, valid: true };
}

/** Sum ISO decimal strings exactly, without going through binary floats. */
export function addDecimals(a: string, b: string, scale: number): string {
  const toUnits = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.split('.');
    const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
    return BigInt(whole + (scale > 0 ? padded : ''));
  };
  const total = toUnits(a) + toUnits(b);
  if (scale === 0) return total.toString();
  const text = total.toString().padStart(scale + 1, '0');
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}

/** Render an amount with exactly the number of decimals the currency requires. */
export function normaliseScale(value: string, currency: string): string {
  const allowed = minorUnits(currency);
  if (allowed === null || allowed === undefined) return value;
  const [whole = '0', fraction = ''] = value.split('.');
  if (allowed === 0) return whole;
  return `${whole}.${(fraction + '0'.repeat(allowed)).slice(0, allowed)}`;
}
