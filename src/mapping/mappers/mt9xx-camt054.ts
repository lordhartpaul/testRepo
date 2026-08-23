import { el } from '../../mx/xml.js';
import { agent, amount, party } from '../../mx/components.js';
import { extract } from '../../mt/pattern.js';
import { parseValueDateAmount } from '../../semantic/amount.js';
import { parseNarrative } from '../../semantic/codes.js';
import { isoDateTime, parseDate6, parseTime4, parseUtcOffset } from '../../semantic/dates.js';
import { statementAccount } from '../cash.js';
import type { MappingContext } from '../context.js';
import type { Mapper } from '../mapper.js';

/**
 * MT900 Confirmation of Debit and MT910 Confirmation of Credit ->
 * camt.054.001.08 Bank to Customer Debit Credit Notification.
 *
 * Both messages describe a single booked entry on the account named in field
 * 25, so they share one mapper that only differs in the credit/debit indicator
 * and in which counterparty fields may appear.
 */
function buildNotification(context: MappingContext, indicator: 'DBIT' | 'CRDT') {
  const reference = context.id('20') ?? 'NOTPROVIDED';
  const relatedReference = context.id('21');
  const settlement = context.field('32');
  const parsed = settlement ? parseValueDateAmount(settlement.value) : undefined;
  const valueDate = parsed?.date6
    ? parseDate6(parsed.date6, { referenceYear: context.options.referenceYear })
    : undefined;

  if (!parsed?.amount.valid) {
    context.diagnostics.error({
      code: 'MT.MISSING.32A',
      mtTag: '32A',
      mxPath: 'Ntry/Amt',
      message: parsed
        ? `Amount is not usable: ${parsed.amount.problem ?? 'unknown problem'}.`
        : 'Field 32A (value date, currency, amount) is missing.',
    });
  }

  const { account } = statementAccount(context, parsed?.amount.currency);
  const bookingDateTime = dateTimeIndication(context, valueDate);

  const orderingCustomer = context.party('50', 'customer');
  const orderingInstitution = context.party('52', 'institution');
  const intermediary = context.party('56', 'institution');

  const narrativeField = context.field('72');
  const narrative = narrativeField
    ? parseNarrative(narrativeField.lines)
        .map((entry) => (entry.code ? `/${entry.code}/ ${entry.text}` : entry.text))
        .join(' ')
        .trim()
    : undefined;

  return el(
    'BkToCstmrDbtCdtNtfctn',
    el('GrpHdr', el('MsgId', reference), el('CreDtTm', context.options.now)),
    el(
      'Ntfctn',
      el('Id', reference),
      el('CreDtTm', context.options.now),
      account,
      el(
        'Ntry',
        amount('Amt', parsed?.amount),
        el('CdtDbtInd', indicator),
        el('Sts', el('Cd', 'BOOK')),
        bookingDateTime ? el('BookgDt', el('DtTm', bookingDateTime)) : undefined,
        valueDate ? el('ValDt', el('Dt', valueDate)) : undefined,
        el(
          'NtryDtls',
          el(
            'TxDtls',
            el(
              'Refs',
              el('MsgId', reference),
              relatedReference ? el('EndToEndId', relatedReference) : undefined,
              maybe('UETR', context.uetr()),
            ),
            orderingCustomer || orderingInstitution
              ? el(
                  'RltdPties',
                  orderingCustomer
                    ? el('Dbtr', party('Pty', orderingCustomer, context.options))
                    : el('Dbtr', agent('Agt', orderingInstitution, context.options)),
                )
              : undefined,
            orderingInstitution || intermediary
              ? el(
                  'RltdAgts',
                  orderingCustomer ? agent('DbtrAgt', orderingInstitution, context.options) : undefined,
                  agent('IntrmyAgt1', intermediary, context.options),
                )
              : undefined,
            narrative ? el('AddtlTxInf', narrative.slice(0, 500)) : undefined,
          ),
        ),
      ),
    ),
  );
}

function maybe(name: string, value: string | undefined) {
  return value === undefined ? undefined : el(name, value);
}

/** Field 13D carries the booking date and time with a UTC offset. */
function dateTimeIndication(context: MappingContext, fallbackDate: string | undefined): string | undefined {
  const field = context.fields('13').find((f) => f.option === 'D');
  if (!field) return undefined;

  const components = extract('6!n4!n1!x4!n', field.value.trim());
  if (!components) {
    context.diagnostics.warn({
      code: 'MT.FIELD.13D',
      mtTag: '13D',
      mxPath: 'Ntry/BookgDt/DtTm',
      message: `Date time indication '${field.value}' does not match 6!n4!n1!x4!n.`,
    });
    return undefined;
  }

  const [date = '', time = '', sign = '', offset = ''] = components;
  const isoDate = parseDate6(date, { referenceYear: context.options.referenceYear }) ?? fallbackDate;
  const isoTime = parseTime4(time);
  const utcOffset = parseUtcOffset(sign, offset);
  if (!isoDate || !isoTime || !utcOffset) return undefined;
  return isoDateTime(isoDate, isoTime, utcOffset);
}

export const mt900ToCamt054: Mapper = {
  mtTypes: ['900'],
  mxId: 'camt.054.001.08',
  description: 'Confirmation of debit',
  map: (context) => buildNotification(context, 'DBIT'),
};

export const mt910ToCamt054: Mapper = {
  mtTypes: ['910'],
  mxId: 'camt.054.001.08',
  description: 'Confirmation of credit',
  map: (context) => buildNotification(context, 'CRDT'),
};
