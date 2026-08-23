import { DiagnosticCollector, type Diagnostic } from '../core/diagnostics.js';
import { fieldFormat } from '../mt/formats.js';
import type { MtField, MtMessage } from '../mt/message.js';
import { matchPattern } from '../mt/pattern.js';
import { expandTag, schemaFor, tagNumber, type MtSchema } from '../mt/schemas.js';
import { parseCurrencyAmount, parseValueDateAmount } from '../semantic/amount.js';
import { BANK_OPERATION_CODES } from '../semantic/codes.js';
import { validateBic } from './bic.js';

/**
 * MT side validation: field formats, schema completeness and the network
 * validated rules the FIN interface would apply before accepting the message.
 *
 * Rules are identified by their SWIFT codes (C1, C2, T26, ...) so a diagnostic
 * can be looked up in the message reference guide.
 */

export interface MtValidationResult {
  readonly diagnostics: readonly Diagnostic[];
  /** Rules that were evaluated, for reporting coverage. */
  readonly rulesChecked: readonly string[];
}

export function validateMt(message: MtMessage, messageType?: string): MtValidationResult {
  const diagnostics = new DiagnosticCollector();
  const rulesChecked: string[] = [];

  validateFieldFormats(message, diagnostics);
  validateReferences(message, diagnostics, rulesChecked);
  validateBics(message, diagnostics, rulesChecked);

  const type = messageType ?? message.messageType;
  const schema = type ? schemaFor(type) : undefined;
  if (schema) {
    validateAgainstSchema(message, schema, diagnostics);
    applyNetworkRules(message, schema, diagnostics, rulesChecked);
  }

  return { diagnostics: diagnostics.all(), rulesChecked };
}

/** Every field is checked against the format specification for its tag. */
function validateFieldFormats(message: MtMessage, diagnostics: DiagnosticCollector): void {
  for (const field of message.block4) {
    const format = fieldFormat(field.tag);
    if (!format) {
      diagnostics.info({
        code: 'MT.FIELD.UNKNOWN_TAG',
        mtTag: field.tag,
        message: `Field ${field.tag} is not in the format catalogue; its content is not format checked.`,
      });
      continue;
    }
    const result = matchPattern(format.pattern, field.value);
    if (!result.ok) {
      diagnostics.warn({
        code: 'MT.FIELD.FORMAT',
        mtTag: field.tag,
        message: `${format.name}: ${result.error ?? 'does not match its format'}.`,
        hint: `Expected ${format.pattern}.`,
      });
    }
  }
}

/**
 * Rule T26: a reference in field 20 or 21 must not begin or end with a slash
 * and must not contain two consecutive slashes.
 */
function validateReferences(
  message: MtMessage,
  diagnostics: DiagnosticCollector,
  rulesChecked: string[],
): void {
  rulesChecked.push('T26');
  for (const field of message.block4) {
    if (field.number !== '20' && field.number !== '21') continue;
    const value = field.value.trim();
    if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
      diagnostics.error({
        code: 'MT.RULE.T26',
        mtTag: field.tag,
        message: `Reference '${value}' must not start or end with '/' nor contain '//'.`,
      });
    }
  }
}

/** Field numbers whose option A carries a BIC. */
const PARTY_FIELD_NUMBERS = new Set(['41', '42', '50', '51', '52', '53', '54', '55', '56', '57', '58', '59', '82', '83', '87']);

/** Rules T27 / T28: a BIC in an option A party field must be a real BIC. */
function validateBics(
  message: MtMessage,
  diagnostics: DiagnosticCollector,
  rulesChecked: string[],
): void {
  rulesChecked.push('T27');
  for (const field of message.block4) {
    // Option A means "identifier code" only on the party fields; elsewhere the
    // letter is just part of the tag (32A is an amount, 71A a charge code).
    if (field.option !== 'A' || !PARTY_FIELD_NUMBERS.has(field.number)) continue;
    const candidate = (field.lines[field.lines.length - 1] ?? '').trim();
    if (candidate === '') continue;
    const check = validateBic(candidate);
    if (!check.valid) {
      diagnostics.error({
        code: 'MT.RULE.T27',
        mtTag: field.tag,
        message: `'${candidate}' is not a valid BIC: ${check.reason ?? 'malformed'}.`,
      });
    } else if (check.test) {
      diagnostics.warn({
        code: 'MT.BIC.TEST',
        mtTag: field.tag,
        message: `${check.normalised} is a test and training BIC.`,
      });
    }
  }
}

/** Mandatory fields present, and nothing the message definition does not allow. */
function validateAgainstSchema(
  message: MtMessage,
  schema: MtSchema,
  diagnostics: DiagnosticCollector,
): void {
  const present = new Set(message.block4.map((f) => f.number));
  const presentTags = new Set(message.block4.map((f) => f.tag));

  for (const entry of schema.entries) {
    if (!entry.mandatory) continue;
    if (!present.has(tagNumber(entry.tag))) {
      diagnostics.error({
        code: 'MT.SCHEMA.MISSING_MANDATORY',
        mtTag: entry.tag,
        message: `Field ${entry.tag} is mandatory in MT${schema.type} but is not present.`,
      });
    }
  }

  const allowedNumbers = new Set(schema.entries.map((entry) => tagNumber(entry.tag)));
  const allowedTags = new Set(schema.entries.flatMap((entry) => expandTag(entry.tag)));

  for (const field of message.block4) {
    if (!allowedNumbers.has(field.number)) {
      diagnostics.warn({
        code: 'MT.SCHEMA.UNEXPECTED_FIELD',
        mtTag: field.tag,
        message: `Field ${field.tag} is not part of the MT${schema.type} message definition.`,
      });
      continue;
    }
    if (!allowedTags.has(field.tag) && !presentTags.has(field.number)) {
      diagnostics.warn({
        code: 'MT.SCHEMA.UNEXPECTED_OPTION',
        mtTag: field.tag,
        message: `Option ${field.option ?? '(none)'} of field ${field.number} is not allowed in MT${schema.type}.`,
      });
    }
  }
}

/** Message specific network validated rules. */
function applyNetworkRules(
  message: MtMessage,
  schema: MtSchema,
  diagnostics: DiagnosticCollector,
  rulesChecked: string[],
): void {
  const get = (tag: string): MtField | undefined => message.block4.find((f) => f.tag === tag);
  const byNumber = (number: string): MtField[] => message.block4.filter((f) => f.number === number);
  const has = (number: string): boolean => message.block4.some((f) => f.number === number);

  switch (schema.type) {
    case '103': {
      rulesChecked.push('C1', 'C2', 'C3', 'C13', 'C14');

      const settlement = get('32A');
      const instructed = get('33B');
      const rate = get('36');

      if (settlement && instructed) {
        const settlementCurrency = parseValueDateAmount(settlement.value).amount.currency;
        const instructedCurrency = parseCurrencyAmount(instructed.value.trim()).currency;
        if (settlementCurrency !== instructedCurrency && !rate) {
          diagnostics.error({
            code: 'MT.RULE.C1',
            mtTag: '36',
            message: `Fields 32A (${settlementCurrency}) and 33B (${instructedCurrency}) are in different currencies, so field 36 (exchange rate) is mandatory.`,
          });
        }
        if (settlementCurrency === instructedCurrency && rate) {
          diagnostics.error({
            code: 'MT.RULE.C1',
            mtTag: '36',
            message: 'Fields 32A and 33B are in the same currency, so field 36 must not be present.',
          });
        }
      }

      const chargeBearer = get('71A')?.value.trim().toUpperCase();
      const senderCharges = byNumber('71').filter((f) => f.option === 'F');
      const receiverCharges = byNumber('71').filter((f) => f.option === 'G');

      if (chargeBearer === 'OUR' && senderCharges.length > 0) {
        diagnostics.error({
          code: 'MT.RULE.C2',
          mtTag: '71F',
          message: "Field 71A is OUR, so sender's charges (71F) must not be present.",
        });
      }
      if (chargeBearer === 'BEN') {
        if (senderCharges.length === 0) {
          diagnostics.error({
            code: 'MT.RULE.C2',
            mtTag: '71F',
            message: "Field 71A is BEN, so at least one sender's charges field (71F) is mandatory.",
          });
        }
        if (receiverCharges.length > 0) {
          diagnostics.error({
            code: 'MT.RULE.C2',
            mtTag: '71G',
            message: "Field 71A is BEN, so receiver's charges (71G) must not be present.",
          });
        }
      }
      if (chargeBearer === 'SHA' && receiverCharges.length > 0) {
        diagnostics.error({
          code: 'MT.RULE.C2',
          mtTag: '71G',
          message: "Field 71A is SHA, so receiver's charges (71G) must not be present.",
        });
      }
      if ((senderCharges.length > 0 || receiverCharges.length > 0) && !instructed) {
        diagnostics.error({
          code: 'MT.RULE.C3',
          mtTag: '33B',
          message: 'Charges fields 71F or 71G are present, so field 33B is mandatory.',
        });
      }

      const operation = get('23B')?.value.trim().toUpperCase();
      if (operation && !(operation in BANK_OPERATION_CODES)) {
        diagnostics.error({
          code: 'MT.CODE.UNKNOWN_23B',
          mtTag: '23B',
          message: `Bank operation code '${operation}' is not one of ${Object.keys(BANK_OPERATION_CODES).join(', ')}.`,
        });
      }
      const instructionCodes = byNumber('23')
        .filter((f) => f.option === 'E')
        .map((f) => f.value.trim().slice(0, 4).toUpperCase());

      if (operation === 'SPRI') {
        const allowed = new Set(['SDVA', 'TELB', 'PHOB', 'INTC']);
        for (const code of instructionCodes) {
          if (!allowed.has(code)) {
            diagnostics.error({
              code: 'MT.RULE.C13',
              mtTag: '23E',
              message: `Field 23B is SPRI, so field 23E may only contain SDVA, TELB, PHOB or INTC, not ${code}.`,
            });
          }
        }
      }
      if ((operation === 'SSTD' || operation === 'SPAY') && instructionCodes.length > 0) {
        diagnostics.error({
          code: 'MT.RULE.C13',
          mtTag: '23E',
          message: `Field 23B is ${operation}, so field 23E must not be present.`,
        });
      }
      if (operation && ['SPRI', 'SSTD', 'SPAY'].includes(operation) && has('56')) {
        diagnostics.error({
          code: 'MT.RULE.C14',
          mtTag: '56a',
          message: `Field 23B is ${operation}, so an intermediary institution (56a) is not allowed.`,
        });
      }
      break;
    }

    case '202': {
      rulesChecked.push('COV.C1');
      const hasSequenceB = has('50') || has('59');
      if (hasSequenceB && !(has('50') && has('59'))) {
        diagnostics.error({
          code: 'MT.RULE.COV_INCOMPLETE',
          mtTag: has('50') ? '59a' : '50a',
          message: 'A COV sequence must carry both the ordering customer (50a) and the beneficiary customer (59a).',
        });
      }
      break;
    }

    case '940':
    case '942': {
      rulesChecked.push('C1');
      const currencies = new Set<string>();
      for (const field of message.block4) {
        if (!['60F', '60M', '62F', '62M', '64', '65'].includes(field.tag)) continue;
        const match = /^[CD](\d{6})([A-Z]{3})/.exec(field.value.trim());
        if (match) currencies.add(match[2] as string);
      }
      if (currencies.size > 1) {
        diagnostics.error({
          code: 'MT.RULE.C1',
          mtTag: '60a/62a',
          message: `All balance fields must share one currency, found ${[...currencies].join(', ')}.`,
        });
      }
      break;
    }

    case '210': {
      rulesChecked.push('C1', 'C2');
      const sequences = byNumber('21').length;
      if (sequences > 10) {
        diagnostics.error({
          code: 'MT.RULE.C2',
          mtTag: '21',
          message: `MT210 allows at most ten sequences, found ${sequences}.`,
        });
      }
      const currencies = new Set(
        byNumber('32').map((field) => parseCurrencyAmount(field.value.trim()).currency),
      );
      if (currencies.size > 1) {
        diagnostics.error({
          code: 'MT.RULE.C1',
          mtTag: '32B',
          message: `All amounts in an MT210 must share one currency, found ${[...currencies].join(', ')}.`,
        });
      }
      if (!has('50') && !has('52')) {
        diagnostics.error({
          code: 'MT.RULE.C3',
          mtTag: '50a/52a',
          message: 'Each MT210 sequence needs either an ordering customer (50a) or an ordering institution (52a).',
        });
      }
      break;
    }

    default:
      break;
  }

  validateAmountDecimals(message, diagnostics, rulesChecked);
}

/** Rule C03: an amount may not carry more decimals than its currency allows. */
function validateAmountDecimals(
  message: MtMessage,
  diagnostics: DiagnosticCollector,
  rulesChecked: string[],
): void {
  rulesChecked.push('C03');
  for (const field of message.block4) {
    let parsed;
    if (field.tag === '32A') parsed = parseValueDateAmount(field.value).amount;
    else if (['32B', '33B', '71F', '71G'].includes(field.tag)) {
      parsed = parseCurrencyAmount(field.value.trim());
    } else continue;

    if (!parsed.valid && parsed.problem) {
      diagnostics.error({
        code: 'MT.RULE.C03',
        mtTag: field.tag,
        message: parsed.problem,
      });
    }
  }
}
