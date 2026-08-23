import { parseCurrencyAmount, swiftToIsoDecimal, type SemanticAmount } from './amount.js';
import { parseDate6, parseMonthDay, type DateResolutionOptions } from './dates.js';

/**
 * Field 61 (statement line) and the balance fields of MT940/MT942.
 *
 * Field 61 is the densest field in the MT catalogue:
 *
 *   6!n[4!n]2a[1!a]15d1!a3!c16x[//16x][CrLf 34x]
 *   value  entry  mark funds amount  type  owner   servicing  supplementary
 *
 * A regular expression cannot split it reliably (the reference may itself
 * contain slashes), so it is scanned left to right.
 */

export type EntryMark = 'C' | 'D' | 'RC' | 'RD';

export interface StatementLine {
  readonly raw: string;
  readonly valueDate?: string;
  readonly entryDate?: string;
  readonly mark: EntryMark;
  /** True for a reversal (`RC`/`RD`). */
  readonly reversal: boolean;
  /** Third character of the currency code when the account is multi-currency. */
  readonly fundsCode?: string;
  /** Amount without a currency; the currency comes from the balance fields. */
  readonly amount: string;
  /** SWIFT transaction type identification code, e.g. `NTRF`. */
  readonly transactionType?: string;
  readonly ownerReference?: string;
  readonly servicingReference?: string;
  readonly supplementaryDetails?: string;
  readonly problems: readonly string[];
}

export function parseStatementLine(
  value: string,
  options: DateResolutionOptions = {},
): StatementLine {
  const problems: string[] = [];
  const [first = '', ...rest] = value.split('\n');
  const supplementaryDetails = rest.join(' ').trim();
  let cursor = 0;

  const take = (count: number): string => {
    const slice = first.slice(cursor, cursor + count);
    cursor += count;
    return slice;
  };
  const peek = (count = 1): string => first.slice(cursor, cursor + count);

  const valueDateRaw = take(6);
  const valueDate = parseDate6(valueDateRaw, options);
  if (!valueDate) problems.push(`value date '${valueDateRaw}' is not a valid YYMMDD date`);

  let entryDate: string | undefined;
  if (/^\d{4}$/.test(peek(4))) {
    const entryRaw = take(4);
    const year = valueDate ? Number(valueDate.slice(0, 4)) : new Date().getUTCFullYear();
    entryDate = parseMonthDay(entryRaw, year);
    // An entry date in December for a value date in January belongs to the
    // previous year (and the mirror case at a year end crossing forward).
    if (entryDate && valueDate) {
      const monthGap = Number(entryDate.slice(5, 7)) - Number(valueDate.slice(5, 7));
      if (monthGap > 6) entryDate = parseMonthDay(entryRaw, year - 1);
      else if (monthGap < -6) entryDate = parseMonthDay(entryRaw, year + 1);
    }
    if (!entryDate) problems.push(`entry date '${entryRaw}' is not a valid MMDD date`);
  }

  let mark: EntryMark;
  const twoChar = peek(2);
  if (twoChar === 'RC' || twoChar === 'RD') {
    mark = twoChar;
    cursor += 2;
  } else {
    const oneChar = peek(1);
    if (oneChar === 'C' || oneChar === 'D') {
      mark = oneChar;
      cursor += 1;
    } else {
      mark = 'C';
      problems.push(`debit/credit mark '${oneChar}' is not one of C, D, RC, RD; assumed credit`);
    }
  }

  let fundsCode: string | undefined;
  if (/^[A-Z]$/.test(peek(1)) && /^[0-9]/.test(first.slice(cursor + 1, cursor + 2))) {
    fundsCode = take(1);
  }

  let amountRaw = '';
  while (cursor < first.length && /[0-9,]/.test(first[cursor] as string)) {
    amountRaw += first[cursor];
    cursor += 1;
  }
  if (amountRaw === '') problems.push('no amount found in the statement line');

  let transactionType: string | undefined;
  if (/^[A-Z][A-Z0-9]{3}$/.test(peek(4))) {
    transactionType = take(4);
  } else if (peek(4).trim() !== '') {
    problems.push(`transaction type '${peek(4)}' is not a 1!a3!c code`);
  }

  const remainder = first.slice(cursor);
  const separator = remainder.indexOf('//');
  const ownerReference = (separator === -1 ? remainder : remainder.slice(0, separator)).trim();
  const servicingReference =
    separator === -1 ? undefined : remainder.slice(separator + 2).trim();

  return {
    raw: value,
    ...(valueDate ? { valueDate } : {}),
    ...(entryDate ? { entryDate } : {}),
    mark,
    reversal: mark === 'RC' || mark === 'RD',
    ...(fundsCode ? { fundsCode } : {}),
    amount: swiftToIsoDecimal(amountRaw || '0'),
    ...(transactionType ? { transactionType } : {}),
    ...(ownerReference ? { ownerReference } : {}),
    ...(servicingReference ? { servicingReference } : {}),
    ...(supplementaryDetails ? { supplementaryDetails } : {}),
    problems,
  };
}

/** ISO 20022 credit/debit indicator for a statement line. */
export function creditDebitIndicator(mark: EntryMark): 'CRDT' | 'DBIT' {
  return mark === 'C' || mark === 'RC' ? 'CRDT' : 'DBIT';
}

export interface Balance {
  readonly raw: string;
  readonly creditDebit: 'CRDT' | 'DBIT';
  readonly date?: string;
  readonly amount: SemanticAmount;
  readonly problems: readonly string[];
}

/** Balance fields 60a, 62a, 64 and 65: `1!a6!n3!a15d`. */
export function parseBalance(value: string, options: DateResolutionOptions = {}): Balance {
  const problems: string[] = [];
  const match = /^([CD])(\d{6})([A-Z]{3})([\d,]+)$/.exec(value.trim());
  if (!match) {
    return {
      raw: value,
      creditDebit: 'CRDT',
      amount: parseCurrencyAmount(value.slice(7)),
      problems: [`balance '${value}' does not match 1!a6!n3!a15d`],
    };
  }

  const date = parseDate6(match[2] as string, options);
  if (!date) problems.push(`balance date '${match[2]}' is not a valid YYMMDD date`);

  return {
    raw: value,
    creditDebit: match[1] === 'C' ? 'CRDT' : 'DBIT',
    ...(date ? { date } : {}),
    amount: parseCurrencyAmount(`${match[3]}${match[4]}`),
    problems,
  };
}

export interface EntryDetail {
  readonly key: string;
  readonly value: string;
}

/**
 * Field 86 arrives either as free text, as `/CODE/value` pairs, or in the
 * `?NN` sub-field layout used by several domestic communities.
 */
export function parseEntryDetails(lines: readonly string[]): {
  readonly details: readonly EntryDetail[];
  readonly text: string;
} {
  const joined = lines.join('\n');
  const text = lines.map((line) => line.trim()).join(' ').replace(/\s+/g, ' ').trim();

  if (joined.includes('?')) {
    const details: EntryDetail[] = [];
    const pattern = /\?(\d{2})([^?]*)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(joined)) !== null) {
      details.push({ key: match[1] as string, value: (match[2] as string).replace(/\n/g, '').trim() });
    }
    if (details.length > 0) return { details, text };
  }

  const details: EntryDetail[] = [];
  const pattern = /\/([A-Z][A-Z0-9]{1,8})\/([^/]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    details.push({ key: match[1] as string, value: (match[2] as string).trim() });
  }
  return { details, text };
}
