import { FIELD_FORMATS } from './formats.js';

export type SequenceId = 'A' | 'B' | 'C';

export interface SchemaEntry {
  /**
   * Either a full tag (`32A`) or SWIFT's "any option" notation (`50a`), which
   * means field 50 in whichever option the sender chose.
   */
  readonly tag: string;
  readonly mandatory: boolean;
  readonly repeatable?: boolean;
  readonly sequence?: SequenceId;
}

export interface MtSchema {
  readonly type: string;
  readonly name: string;
  /** ISO 20022 message identifier this MT maps onto by default. */
  readonly mxTarget: string;
  readonly entries: readonly SchemaEntry[];
  /** Tag whose first occurrence opens sequence B (MT202 COV). */
  readonly sequenceBStart?: string;
  /** Tag that opens each iteration of a repeating group (statement lines). */
  readonly repeatingGroupStart?: string;
  /** Human readable summary used by the CLI and API. */
  readonly summary: string;
}

const e = (tag: string, mandatory: boolean, extra: Partial<SchemaEntry> = {}): SchemaEntry => ({
  tag,
  mandatory,
  ...extra,
});

export const MT_SCHEMAS: Readonly<Record<string, MtSchema>> = Object.freeze({
  '103': {
    type: '103',
    name: 'Single Customer Credit Transfer',
    mxTarget: 'pacs.008.001.08',
    summary: 'Customer payment between financial institutions.',
    entries: [
      e('20', true), e('13C', false, { repeatable: true }), e('23B', true),
      e('23E', false, { repeatable: true }), e('26T', false), e('32A', true),
      e('33B', false), e('36', false), e('50a', true), e('51A', false),
      e('52a', false), e('53a', false), e('54a', false), e('55a', false),
      e('56a', false), e('57a', false), e('59a', true), e('70', false),
      e('71A', true), e('71F', false, { repeatable: true }), e('71G', false),
      e('72', false), e('77B', false), e('77T', false),
    ],
  },
  '200': {
    type: '200',
    name: "Financial Institution Transfer for its Own Account",
    mxTarget: 'pacs.009.001.08',
    summary: "Movement of the sender's own funds to its account at another institution.",
    entries: [
      e('20', true), e('32A', true), e('53B', false), e('56a', false),
      e('57a', true), e('72', false),
    ],
  },
  '202': {
    type: '202',
    name: 'General Financial Institution Transfer',
    mxTarget: 'pacs.009.001.08',
    summary: 'Bank to bank transfer, optionally covering an underlying customer payment.',
    entries: [
      e('20', true), e('21', true), e('13C', false, { repeatable: true }), e('32A', true),
      e('52a', false), e('53a', false), e('54a', false), e('56a', false),
      e('57a', false), e('58a', true), e('72', false),
      // Sequence B, present only in the COV variant: the underlying customer
      // credit transfer this bank to bank transfer covers.
      e('50a', false, { sequence: 'B' }),
      e('59a', false, { sequence: 'B' }),
      e('70', false, { sequence: 'B' }),
      e('33B', false, { sequence: 'B' }),
    ],
    sequenceBStart: '50a',
  },
  '210': {
    type: '210',
    name: 'Notice to Receive',
    mxTarget: 'camt.057.001.06',
    summary: 'Advance notice that the account will be credited.',
    entries: [
      e('20', true), e('25', false), e('30', true),
      e('21', true, { sequence: 'B', repeatable: true }),
      e('32B', true, { sequence: 'B' }),
      e('50a', false, { sequence: 'B' }),
      e('52a', false, { sequence: 'B' }),
      e('56a', false, { sequence: 'B' }),
    ],
    repeatingGroupStart: '21',
  },
  '900': {
    type: '900',
    name: 'Confirmation of Debit',
    mxTarget: 'camt.054.001.08',
    summary: 'Confirms that the account has been debited.',
    entries: [
      e('20', true), e('21', true), e('25', true), e('13D', false),
      e('32A', true), e('52a', false), e('72', false),
    ],
  },
  '910': {
    type: '910',
    name: 'Confirmation of Credit',
    mxTarget: 'camt.054.001.08',
    summary: 'Confirms that the account has been credited.',
    entries: [
      e('20', true), e('21', true), e('25', true), e('13D', false),
      e('32A', true), e('50a', false), e('52a', false), e('56a', false), e('72', false),
    ],
  },
  '940': {
    type: '940',
    name: 'Customer Statement Message',
    mxTarget: 'camt.053.001.08',
    summary: 'End of day statement for an account.',
    entries: [
      e('20', true), e('21', false), e('25', true), e('28C', true), e('60a', true),
      e('61', false, { sequence: 'B', repeatable: true }),
      e('86', false, { sequence: 'B', repeatable: true }),
      e('62a', true), e('64', false), e('65', false, { repeatable: true }),
    ],
    repeatingGroupStart: '61',
  },
  '942': {
    type: '942',
    name: 'Interim Transaction Report',
    mxTarget: 'camt.052.001.08',
    summary: 'Intraday report of entries booked since the last statement.',
    entries: [
      e('20', true), e('21', false), e('25', true), e('28C', true),
      e('34F', true, { repeatable: true }), e('13D', true),
      e('61', false, { sequence: 'B', repeatable: true }),
      e('86', false, { sequence: 'B', repeatable: true }),
      e('90D', false), e('90C', false),
    ],
    repeatingGroupStart: '61',
  },
  '192': {
    type: '192',
    name: 'Request for Cancellation',
    mxTarget: 'camt.056.001.08',
    summary: 'Asks the receiver to cancel a payment sent earlier.',
    entries: [
      e('20', true), e('21', true), e('11S', true), e('79', false),
    ],
  },
  '196': {
    type: '196',
    name: 'Answers',
    mxTarget: 'camt.029.001.09',
    summary: 'Answers a query or cancellation request.',
    entries: [
      e('20', true), e('21', true), e('11a', false), e('76', true),
      e('77A', false), e('79', false),
    ],
  },
});

/**
 * Message types that share a schema with another type: the n9x exception
 * messages are identical apart from the customer/bank category digit.
 */
export const SCHEMA_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '292': '192',
  '992': '192',
  '296': '196',
  '996': '196',
  '205': '202',
  '950': '940',
});

export function schemaFor(messageType: string): MtSchema | undefined {
  const direct = MT_SCHEMAS[messageType];
  if (direct) return direct;
  const alias = SCHEMA_ALIASES[messageType];
  return alias ? MT_SCHEMAS[alias] : undefined;
}

export function isSupportedType(messageType: string): boolean {
  return schemaFor(messageType) !== undefined;
}

export function supportedTypes(): string[] {
  return [...Object.keys(MT_SCHEMAS), ...Object.keys(SCHEMA_ALIASES)].sort();
}

/** Full tags a schema entry accepts, expanding SWIFT's `50a` notation. */
export function expandTag(tag: string): string[] {
  if (!tag.endsWith('a')) return [tag];
  const number = tag.slice(0, -1);
  const options = Object.keys(FIELD_FORMATS).filter(
    (key) => key.startsWith(number) && key.length > number.length,
  );
  // Some fields (59) have an option-less form alongside lettered options.
  if (FIELD_FORMATS[number]) options.push(number);
  return options.length > 0 ? options : [number];
}

/** Numeric part of a schema entry tag (`50a` -> `50`, `32A` -> `32`). */
export function tagNumber(tag: string): string {
  return tag.replace(/[A-Za-z]$/, '');
}
