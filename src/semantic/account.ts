import { clearingSystemByPrefix, RTGS_PREFIX } from '../reference/clearing-systems.js';
import { looksLikeIban, validateIban } from '../validation/iban.js';

/**
 * Interpretation of the "party identifier" line that opens most MT party
 * fields. The same 34 characters can carry an IBAN, a proprietary account
 * number, a national clearing member id, or an RTGS routing instruction.
 */
export interface AccountIdentification {
  readonly raw: string;
  /** Debit/credit mark from the `[/1!a]` component of institution fields. */
  readonly mark?: 'D' | 'C';
  readonly iban?: string;
  readonly ibanValid?: boolean;
  readonly ibanProblem?: string;
  /** Non-IBAN account number. */
  readonly other?: string;
  readonly clearing?: {
    readonly swiftPrefix: string;
    readonly isoCode: string;
    readonly name: string;
    readonly memberId: string;
    readonly memberIdPlausible: boolean;
  };
  /** `//RT` asks for settlement through an RTGS system. */
  readonly rtgs?: boolean;
  /** Clearing prefix present but unknown to the reference table. */
  readonly unknownClearingPrefix?: string;
}

/**
 * Parse a party identifier.
 *
 * `text` is the value captured by the `[/34x]` component, i.e. with its leading
 * slash already removed. A remaining leading slash means the line was written
 * as `//XX...`, which is the national clearing system convention.
 */
export function parseAccountIdentification(
  text: string,
  mark?: string,
): AccountIdentification | undefined {
  const raw = text.trim();
  if (raw === '') return undefined;

  const base: { raw: string; mark?: 'D' | 'C' } = {
    raw,
    ...(mark === 'D' || mark === 'C' ? { mark: mark as 'D' | 'C' } : {}),
  };

  if (raw.startsWith('/')) {
    const body = raw.slice(1);
    const prefix = body.slice(0, 2).toUpperCase();
    const memberId = body.slice(2).trim();

    if (prefix === RTGS_PREFIX) {
      return { ...base, rtgs: true, ...(memberId ? { other: memberId } : {}) };
    }

    const system = clearingSystemByPrefix(prefix);
    if (system) {
      return {
        ...base,
        clearing: {
          swiftPrefix: system.swiftPrefix,
          isoCode: system.isoCode,
          name: system.name,
          memberId,
          memberIdPlausible: system.memberIdPattern
            ? system.memberIdPattern.test(memberId)
            : true,
        },
      };
    }
    return { ...base, unknownClearingPrefix: prefix, other: body };
  }

  if (looksLikeIban(raw)) {
    const check = validateIban(raw);
    return {
      ...base,
      iban: check.normalised,
      ibanValid: check.valid,
      ...(check.valid ? {} : { ibanProblem: check.reason as string }),
      ...(check.valid ? {} : { other: raw }),
    };
  }

  return { ...base, other: raw };
}

/** A short human label used in diagnostics. */
export function describeAccount(account: AccountIdentification | undefined): string {
  if (!account) return '(none)';
  if (account.iban) return `IBAN ${account.iban}`;
  if (account.clearing) return `${account.clearing.isoCode} ${account.clearing.memberId}`;
  if (account.rtgs) return 'RTGS routing';
  return account.other ?? account.raw;
}
