import { el, type XmlElement } from '../mx/xml.js';
import { agentFromBic, amountOf } from '../mx/components.js';
import { sanitiseId } from '../core/ids.js';
import { parseAccountIdentification } from '../semantic/account.js';
import {
  creditDebitIndicator,
  parseBalance,
  parseEntryDetails,
  parseStatementLine,
  type Balance,
} from '../semantic/statement.js';
import { isBic, toBic11 } from '../validation/bic.js';
import type { MtField } from '../mt/message.js';
import type { MappingContext } from './context.js';

/**
 * Helpers shared by the cash management messages (camt.052, camt.053,
 * camt.054 and camt.057).
 */

export interface StatementAccount {
  readonly account?: XmlElement;
  readonly servicer?: XmlElement;
}

/**
 * Field 25 (or 25P) identifies the account the statement is about. It is a free
 * text field, so the value can be an IBAN, a proprietary number, or a BIC and
 * account number separated by a slash.
 */
export function statementAccount(
  context: MappingContext,
  currency?: string,
): StatementAccount {
  const field = context.field('25');
  if (!field) return {};

  let accountText = (field.lines[0] ?? '').trim();
  let servicerBic: string | undefined;

  if (field.option === 'P' && field.lines[1]) {
    const candidate = (field.lines[1] as string).trim();
    if (isBic(candidate)) servicerBic = toBic11(candidate);
  }

  const slash = accountText.indexOf('/');
  if (slash > 0) {
    const head = accountText.slice(0, slash).trim();
    if (isBic(head)) {
      servicerBic = servicerBic ?? toBic11(head);
      accountText = accountText.slice(slash + 1).trim();
    }
  }

  const parsed = parseAccountIdentification(accountText.replace(/^\//, ''));
  if (!parsed) return servicerBic ? { servicer: agentFromBic('Svcr', servicerBic) } : {};

  if (parsed.iban && parsed.ibanValid === false) {
    context.diagnostics.warn({
      code: 'MT.FIELD.25_IBAN',
      mtTag: field.tag,
      mxPath: 'Acct/Id',
      message: `Account '${parsed.iban}' looks like an IBAN but failed validation: ${parsed.ibanProblem ?? ''}`.trim(),
    });
  }

  const identification =
    parsed.iban && parsed.ibanValid !== false
      ? el('Id', el('IBAN', parsed.iban))
      : el('Id', el('Othr', el('Id', sanitiseId(parsed.other ?? parsed.raw, 34))));

  return {
    account: el(
      'Acct',
      identification,
      currency ? el('Ccy', currency) : undefined,
      servicerBic ? agentFromBic('Svcr', servicerBic) : undefined,
    ),
    ...(servicerBic ? { servicer: agentFromBic('Svcr', servicerBic) } : {}),
  };
}

/** MT balance field tags mapped onto ISO 20022 balance type codes. */
export const BALANCE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '60F': 'OPBD',
  '60M': 'ITBD',
  '62F': 'CLBD',
  '62M': 'ITBD',
  '64': 'CLAV',
  '65': 'FWAV',
});

export function balanceElement(tag: string, balance: Balance): XmlElement | undefined {
  const type = BALANCE_TYPES[tag] ?? 'OPBD';
  if (!balance.amount.valid && balance.amount.value === '0' && balance.problems.length > 0) {
    return undefined;
  }
  return el(
    'Bal',
    el('Tp', el('CdOrPrtry', el('Cd', type))),
    amountOf('Amt', balance.amount.currency, balance.amount.value),
    el('CdtDbtInd', balance.creditDebit),
    balance.date ? el('Dt', el('Dt', balance.date)) : undefined,
  );
}

/** Read every balance field of a statement, reporting anything unusable. */
export function balances(
  context: MappingContext,
  tags: readonly string[],
): { readonly elements: XmlElement[]; readonly currency?: string } {
  const elements: XmlElement[] = [];
  let currency: string | undefined;

  for (const number of ['60', '62', '64', '65']) {
    for (const field of context.fields(number)) {
      if (!tags.includes(field.tag)) continue;
      const parsed = parseBalanceField(context, field);
      if (!parsed) continue;
      currency = currency ?? parsed.amount.currency;
      const element = balanceElement(field.tag, parsed);
      if (element) elements.push(element);
    }
  }
  return { elements, ...(currency ? { currency } : {}) };
}

function parseBalanceField(context: MappingContext, field: MtField): Balance | undefined {
  const parsed = parseBalance(field.value, { referenceYear: context.options.referenceYear });
  for (const problem of parsed.problems) {
    context.diagnostics.warn({
      code: 'MT.FIELD.BALANCE',
      mtTag: field.tag,
      mxPath: 'Bal',
      message: `Balance field ${field.tag}: ${problem}.`,
    });
  }
  return parsed;
}

export interface EntryBuildResult {
  readonly entries: XmlElement[];
  readonly creditCount: number;
  readonly debitCount: number;
}

/**
 * Turn the repeating field 61 / field 86 pairs of a statement into camt entries.
 *
 * Field 61 has no currency of its own: it inherits the account currency from
 * the balance fields, optionally overridden by the one character funds code.
 */
export function statementEntries(
  context: MappingContext,
  groups: readonly (readonly MtField[])[],
  currency: string | undefined,
): EntryBuildResult {
  const entries: XmlElement[] = [];
  let creditCount = 0;
  let debitCount = 0;

  for (const group of groups) {
    const statementField = group[0] as MtField;
    const line = parseStatementLine(statementField.value, {
      referenceYear: context.options.referenceYear,
    });

    for (const problem of line.problems) {
      context.diagnostics.warn({
        code: 'MT.FIELD.61',
        mtTag: '61',
        mxPath: 'Ntry',
        message: `Statement line: ${problem}.`,
      });
    }

    const entryCurrency = resolveEntryCurrency(context, currency, line.fundsCode);
    const indicator = creditDebitIndicator(line.mark);
    if (indicator === 'CRDT') creditCount += 1;
    else debitCount += 1;

    const informationField = group.find((f) => f.number === '86');
    const details = informationField ? parseEntryDetails(informationField.lines) : undefined;
    const additionalInformation = [details?.text, line.supplementaryDetails]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .trim();

    entries.push(
      el(
        'Ntry',
        line.ownerReference ? el('NtryRef', sanitiseId(line.ownerReference)) : undefined,
        entryCurrency ? amountOf('Amt', entryCurrency, line.amount) : undefined,
        el('CdtDbtInd', indicator),
        line.reversal ? el('RvslInd', 'true') : undefined,
        el('Sts', el('Cd', 'BOOK')),
        line.entryDate ? el('BookgDt', el('Dt', line.entryDate)) : undefined,
        line.valueDate ? el('ValDt', el('Dt', line.valueDate)) : undefined,
        line.servicingReference ? el('AcctSvcrRef', sanitiseId(line.servicingReference)) : undefined,
        line.transactionType
          ? el('BkTxCd', el('Prtry', el('Cd', line.transactionType), el('Issr', 'SWIFT')))
          : undefined,
        el(
          'NtryDtls',
          el(
            'TxDtls',
            line.ownerReference
              ? el('Refs', el('EndToEndId', sanitiseId(line.ownerReference)))
              : undefined,
            ...(details?.details ?? []).map((detail) =>
              el('AddtlTxInf', `${detail.key}: ${detail.value}`.slice(0, 500)),
            ),
          ),
        ),
        additionalInformation ? el('AddtlNtryInf', additionalInformation.slice(0, 500)) : undefined,
      ),
    );
  }

  return { entries, creditCount, debitCount };
}

/**
 * The funds code is the third character of the entry currency, used on
 * multi-currency accounts. When it disagrees with the account currency the
 * mismatch is reported rather than silently resolved.
 */
function resolveEntryCurrency(
  context: MappingContext,
  accountCurrency: string | undefined,
  fundsCode: string | undefined,
): string | undefined {
  if (!accountCurrency) {
    context.diagnostics.warn({
      code: 'MX.ENTRY_CURRENCY_UNKNOWN',
      mtTag: '61',
      mxPath: 'Ntry/Amt',
      message: 'No balance field carried a currency, so entry amounts have no currency.',
    });
    return undefined;
  }
  if (fundsCode && fundsCode !== accountCurrency.charAt(2)) {
    context.diagnostics.warn({
      code: 'MX.ENTRY_CURRENCY_MISMATCH',
      mtTag: '61',
      mxPath: 'Ntry/Amt',
      message: `Funds code '${fundsCode}' does not match the account currency ${accountCurrency}; the account currency is used.`,
    });
  }
  return accountCurrency;
}

/** Statement or report identification from field 28C. */
export function sequenceNumbers(context: MappingContext): {
  readonly legal?: string;
  readonly electronic?: string;
} {
  const value = context.value('28');
  if (!value) return {};
  const [statement, sequence] = value.split('/');
  return {
    ...(statement ? { legal: statement.trim() } : {}),
    ...(sequence ? { electronic: sequence.trim() } : {}),
  };
}
