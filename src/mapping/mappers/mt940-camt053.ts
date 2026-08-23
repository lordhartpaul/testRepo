import { el } from '../../mx/xml.js';
import { extract } from '../../mt/pattern.js';
import { repeatingGroups } from '../../mt/sequences.js';
import { addDecimals, parseCurrencyAmount } from '../../semantic/amount.js';
import { isoDateTime, parseDate6, parseTime4, parseUtcOffset } from '../../semantic/dates.js';
import { balances, sequenceNumbers, statementAccount, statementEntries } from '../cash.js';
import type { MappingContext } from '../context.js';
import type { Mapper } from '../mapper.js';

/**
 * MT940 Customer Statement -> camt.053.001.08 and
 * MT942 Interim Transaction Report -> camt.052.001.08.
 *
 * The two messages have the same shape; camt.053 is a statement with opening
 * and closing balances, camt.052 is an intraday report with a floor limit and
 * entry totals instead.
 */

function buildStatement(
  context: MappingContext,
  kind: 'statement' | 'report',
): ReturnType<typeof el> {
  const reference = context.id('20') ?? 'NOTPROVIDED';
  const relatedReference = context.id('21');
  const numbers = sequenceNumbers(context);

  const balanceTags =
    kind === 'statement'
      ? ['60F', '60M', '62F', '62M', '64', '65']
      : ['60F', '60M', '62F', '62M'];
  const balanceResult = balances(context, balanceTags);
  const currency = balanceResult.currency ?? floorLimitCurrency(context);

  const { account } = statementAccount(context, currency);

  const groups = repeatingGroups(context.scope, '61', ['86']);
  // Field 86 immediately after a field 61 belongs to that entry; a field 86
  // that follows the closing balance describes the statement as a whole.
  context.consume('61');
  const entryInformationFields = new Set(
    groups.flatMap((group) => group.filter((f) => f.number === '86').map((f) => f.index)),
  );
  const { entries, creditCount, debitCount } = statementEntries(context, groups, currency);

  const statementLevelInformation = context
    .fields('86')
    .filter((field) => !entryInformationFields.has(field.index))
    .map((field) => field.lines.join(' ').trim())
    .filter((text) => text !== '');

  const summary = transactionSummary(context, kind, creditCount, debitCount, entries.length);
  const container = kind === 'statement' ? 'Stmt' : 'Rpt';

  return el(
    kind === 'statement' ? 'BkToCstmrStmt' : 'BkToCstmrAcctRpt',
    el(
      'GrpHdr',
      el('MsgId', reference),
      el('CreDtTm', context.options.now),
      relatedReference ? el('MsgRcpt', el('Nm', relatedReference)) : undefined,
    ),
    el(
      container,
      el('Id', reference),
      numbers.electronic ? el('ElctrncSeqNb', numbers.electronic) : undefined,
      numbers.legal ? el('LglSeqNb', numbers.legal) : undefined,
      el('CreDtTm', context.options.now),
      reportingPeriod(context),
      account,
      ...balanceResult.elements,
      summary,
      ...entries,
      ...statementLevelInformation.map((text) =>
        el(kind === 'statement' ? 'AddtlStmtInf' : 'AddtlRptInf', text.slice(0, 500)),
      ),
      ...floorLimitNotes(context, kind),
    ),
  );
}

/** Field 13D on an MT942 states the moment the report was cut. */
function reportingPeriod(context: MappingContext): ReturnType<typeof el> | undefined {
  const field = context.fields('13').find((f) => f.option === 'D');
  if (!field) return undefined;

  const components = extract('6!n4!n1!x4!n', field.value.trim());
  if (!components) return undefined;
  const [date = '', time = '', sign = '', offset = ''] = components;
  const isoDate = parseDate6(date, { referenceYear: context.options.referenceYear });
  const isoTime = parseTime4(time);
  const utcOffset = parseUtcOffset(sign, offset);
  if (!isoDate || !isoTime || !utcOffset) return undefined;
  return el('FrToDt', el('FrDtTm', isoDateTime(isoDate, isoTime, utcOffset)));
}

/** Fields 90C and 90D carry the entry counts and sums of an MT942. */
function transactionSummary(
  context: MappingContext,
  kind: 'statement' | 'report',
  creditCount: number,
  debitCount: number,
  entryCount: number,
): ReturnType<typeof el> | undefined {
  const credit = summaryField(context, 'C');
  const debit = summaryField(context, 'D');
  if (kind === 'statement' && !credit && !debit) return undefined;

  const totalSum =
    credit && debit && credit.currency === debit.currency
      ? addDecimals(credit.sum, debit.sum, credit.currency === 'JPY' ? 0 : 2)
      : undefined;

  return el(
    'TxsSummry',
    el(
      'TtlNtries',
      el('NbOfNtries', String(entryCount)),
      totalSum ? el('Sum', totalSum) : undefined,
    ),
    credit
      ? el('TtlCdtNtries', el('NbOfNtries', credit.count), el('Sum', credit.sum))
      : creditCount > 0
        ? el('TtlCdtNtries', el('NbOfNtries', String(creditCount)))
        : undefined,
    debit
      ? el('TtlDbtNtries', el('NbOfNtries', debit.count), el('Sum', debit.sum))
      : debitCount > 0
        ? el('TtlDbtNtries', el('NbOfNtries', String(debitCount)))
        : undefined,
  );
}

function summaryField(
  context: MappingContext,
  option: 'C' | 'D',
): { count: string; sum: string; currency: string } | undefined {
  const field = context.fields('90').find((f) => f.option === option);
  if (!field) return undefined;

  const components = extract('5n3!a15d', field.value.trim());
  if (!components) {
    context.diagnostics.warn({
      code: 'MT.FIELD.90',
      mtTag: field.tag,
      mxPath: 'TxsSummry',
      message: `Field ${field.tag} does not match 5n3!a15d; the summary is skipped.`,
    });
    return undefined;
  }
  const [count = '0', currency = '', value = ''] = components;
  const amount = parseCurrencyAmount(`${currency}${value}`);
  return { count, sum: amount.value, currency: amount.currency };
}

/** Field 34F states the floor limit below which entries are not reported. */
function floorLimitNotes(
  context: MappingContext,
  kind: 'statement' | 'report',
): ReturnType<typeof el>[] {
  const fields = context.fields('34').filter((f) => f.option === 'F');
  if (fields.length === 0) return [];

  context.diagnostics.info({
    code: 'MX.FLOOR_LIMIT_AS_TEXT',
    mtTag: '34F',
    mxPath: kind === 'statement' ? 'AddtlStmtInf' : 'AddtlRptInf',
    message: 'The floor limit has no camt element and is recorded as additional report information.',
  });

  return fields.map((field) => {
    const components = extract('3!a[1!a]15d', field.value.trim());
    const [currency = '', mark = '', value = ''] = components ?? [];
    const label = mark === 'D' ? 'debit floor limit' : mark === 'C' ? 'credit floor limit' : 'floor limit';
    return el(
      kind === 'statement' ? 'AddtlStmtInf' : 'AddtlRptInf',
      `${label}: ${currency} ${value.replace(',', '.')}`.trim(),
    );
  });
}

function floorLimitCurrency(context: MappingContext): string | undefined {
  const field = context.message.block4.find((f) => f.tag === '34F');
  if (!field) return undefined;
  const components = extract('3!a[1!a]15d', field.value.trim());
  return components?.[0];
}

export const mt940ToCamt053: Mapper = {
  mtTypes: ['940', '950'],
  mxId: 'camt.053.001.08',
  description: 'Customer statement',
  map: (context) => buildStatement(context, 'statement'),
};

export const mt942ToCamt052: Mapper = {
  mtTypes: ['942'],
  mxId: 'camt.052.001.08',
  description: 'Interim transaction report',
  map: (context) => buildStatement(context, 'report'),
};
