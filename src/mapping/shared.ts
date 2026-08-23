import type { XmlElement } from '../mx/xml.js';
import { el } from '../mx/xml.js';
import { agent, agentFromBic, amount, amountOf, cashAccount, unstructuredRemittance } from '../mx/components.js';
import { extract } from '../mt/pattern.js';
import { parseCurrencyAmount, parseValueDateAmount, type SemanticAmount } from '../semantic/amount.js';
import { isoDateTime, parseDate6, parseTime4, parseUtcOffset } from '../semantic/dates.js';
import {
  CHARGE_BEARER,
  INSTRUCTION_CODES,
  NARRATIVE_CODES,
  OPERATION_SERVICE_LEVEL,
  parseNarrative,
  parseRegulatoryReporting,
  transactionTypeToPurpose,
} from '../semantic/codes.js';
import type { MappingContext } from './context.js';

/**
 * Mapping steps shared by the payment messages (MT103, MT200, MT202, MT202 COV).
 * Each helper reads from the context - which records the fields it consumed -
 * and returns ISO 20022 fragments ready to be slotted into a message.
 */

/** Field 32A: interbank settlement date and amount. */
export interface SettlementAmount {
  readonly date?: string;
  readonly amount?: SemanticAmount;
}

export function settlementAmount(context: MappingContext): SettlementAmount {
  const field = context.field('32');
  if (!field) {
    context.diagnostics.error({
      code: 'MT.MISSING.32A',
      mtTag: '32A',
      mxPath: 'IntrBkSttlmAmt',
      message: 'Field 32A (value date, currency, amount) is missing.',
    });
    return {};
  }

  const parsed = parseValueDateAmount(field.value);
  const date = parsed.date6
    ? parseDate6(parsed.date6, { referenceYear: context.options.referenceYear })
    : undefined;

  if (!date) {
    context.diagnostics.error({
      code: 'MT.FIELD.VALUE_DATE',
      mtTag: field.tag,
      mxPath: 'IntrBkSttlmDt',
      message: `Value date '${parsed.date6 ?? field.value.slice(0, 6)}' is not a valid date.`,
    });
  }
  if (!parsed.amount.valid) {
    context.diagnostics.error({
      code: 'MT.FIELD.AMOUNT',
      mtTag: field.tag,
      mxPath: 'IntrBkSttlmAmt',
      message: `Settlement amount is not usable: ${parsed.amount.problem ?? 'unknown problem'}.`,
    });
  }

  return { ...(date ? { date } : {}), amount: parsed.amount };
}

/**
 * `SettlementInstruction7`.
 *
 * MT expresses settlement through the correspondents in fields 53a to 55a. The
 * method is inferred: a named reimbursement institution means the payment is
 * covered by a separate settlement (COVE), an account alone means settlement
 * happens on an account serviced by one of the two agents (INDA / INGA).
 */
export function settlementInformation(context: MappingContext): XmlElement {
  const sendersCorrespondent = context.party('53', 'institution');
  const receiversCorrespondent = context.party('54', 'institution');
  const thirdReimbursement = context.party('55', 'institution');

  const namedReimbursement =
    Boolean(sendersCorrespondent?.bic ?? sendersCorrespondent?.name) ||
    Boolean(receiversCorrespondent) ||
    Boolean(thirdReimbursement);

  let method: 'INDA' | 'INGA' | 'COVE' = 'INDA';
  if (namedReimbursement) {
    method = 'COVE';
  } else if (sendersCorrespondent?.account?.mark === 'C') {
    // A credit mark on the sender's correspondent points at an account the
    // sender services for the receiver.
    method = 'INGA';
  }

  context.diagnostics.info({
    code: 'MX.SETTLEMENT_METHOD',
    mxPath: 'GrpHdr/SttlmInf/SttlmMtd',
    message: `Settlement method resolved to ${method}.`,
    hint: namedReimbursement
      ? 'A reimbursement institution is named in field 53a/54a/55a.'
      : 'No reimbursement institution is named, so settlement runs over an account between the two agents.',
  });

  return el(
    'SttlmInf',
    el('SttlmMtd', method),
    method !== 'COVE'
      ? cashAccount('SttlmAcct', sendersCorrespondent?.account)
      : undefined,
    method === 'COVE' ? agent('InstgRmbrsmntAgt', sendersCorrespondent, context.options) : undefined,
    method === 'COVE'
      ? cashAccount('InstgRmbrsmntAgtAcct', sendersCorrespondent?.account)
      : undefined,
    agent('InstdRmbrsmntAgt', receiversCorrespondent, context.options),
    cashAccount('InstdRmbrsmntAgtAcct', receiversCorrespondent?.account),
    agent('ThrdRmbrsmntAgt', thirdReimbursement, context.options),
    cashAccount('ThrdRmbrsmntAgtAcct', thirdReimbursement?.account),
  );
}

export interface InstructionParts {
  readonly serviceLevels: string[];
  readonly categoryPurposes: string[];
  readonly localInstruments: string[];
  readonly clearingChannels: string[];
  readonly instructionForCreditorAgent: Array<{ code?: string; info?: string }>;
  readonly instructionForNextAgent: Array<{ code?: string; info?: string }>;
  readonly extraRemittance: string[];
  previousInstructingAgentBic?: string;
  previousInstructingAgentName?: string;
  returnReason?: string;
}

function emptyInstructions(): InstructionParts {
  return {
    serviceLevels: [],
    categoryPurposes: [],
    localInstruments: [],
    clearingChannels: [],
    instructionForCreditorAgent: [],
    instructionForNextAgent: [],
    extraRemittance: [],
  };
}

/**
 * Collect fields 23B, 23E and 72 into the ISO 20022 slots they belong to.
 *
 * This is where a single MT field fans out: MT keeps instructions in one place,
 * ISO 20022 splits them across service level, category purpose, clearing
 * channel and two different agent instruction elements.
 */
export function collectInstructions(context: MappingContext): InstructionParts {
  const parts = emptyInstructions();

  const operation = context.value('23');
  if (operation) {
    const level = OPERATION_SERVICE_LEVEL[operation];
    if (level) parts.serviceLevels.push(level);
  }

  for (const field of context.fields('23')) {
    if (field.option !== 'E') continue;
    const components = extract('4!c[/30x]', field.value.trim());
    const code = (components?.[0] ?? field.value.trim().slice(0, 4)).toUpperCase();
    const additional = components?.[1];
    const mapping = INSTRUCTION_CODES[code];

    if (!mapping) {
      parts.instructionForNextAgent.push({ info: [code, additional].filter(Boolean).join(' ') });
      context.diagnostics.warn({
        code: 'MT.CODE.UNKNOWN_23E',
        mtTag: field.tag,
        mxPath: 'InstrForNxtAgt/InstrInf',
        message: `Instruction code '${code}' is not in the reference table; carried as instruction text.`,
      });
      continue;
    }

    switch (mapping.target) {
      case 'serviceLevel':
        parts.serviceLevels.push(mapping.code as string);
        break;
      case 'categoryPurpose':
        parts.categoryPurposes.push(mapping.code as string);
        break;
      case 'localInstrument':
        parts.localInstruments.push(mapping.code as string);
        break;
      case 'clearingChannel':
        parts.clearingChannels.push(mapping.code as string);
        break;
      case 'instructionForCreditorAgent':
        parts.instructionForCreditorAgent.push({
          code: mapping.code as string,
          ...(additional ? { info: additional } : {}),
        });
        break;
      case 'instructionForNextAgent':
        parts.instructionForNextAgent.push({
          code: mapping.code as string,
          ...(additional ? { info: additional } : {}),
        });
        break;
      default:
        parts.instructionForNextAgent.push({
          info: [code, additional].filter(Boolean).join(' '),
        });
    }
  }

  const narrativeField = context.field('72');
  if (narrativeField) {
    for (const entry of parseNarrative(narrativeField.lines)) {
      if (!entry.code) {
        parts.instructionForNextAgent.push({ info: entry.text.slice(0, 140) });
        continue;
      }
      const mapping = NARRATIVE_CODES[entry.code];
      if (!mapping) {
        parts.instructionForNextAgent.push({ info: `/${entry.code}/ ${entry.text}`.slice(0, 140) });
        context.diagnostics.info({
          code: 'MT.CODE.UNKNOWN_72',
          mtTag: '72',
          mxPath: 'InstrForNxtAgt/InstrInf',
          message: `Code word '/${entry.code}/' has no ISO 20022 equivalent; carried as instruction text.`,
        });
        continue;
      }

      switch (mapping.target) {
        case 'instructionForCreditorAgent':
          parts.instructionForCreditorAgent.push({
            ...(mapping.code ? { code: mapping.code } : {}),
            ...(entry.text ? { info: entry.text.slice(0, 140) } : {}),
          });
          break;
        case 'instructionForNextAgent':
          parts.instructionForNextAgent.push({
            ...(mapping.code ? { code: mapping.code } : {}),
            ...(entry.text ? { info: entry.text.slice(0, 140) } : {}),
          });
          break;
        case 'previousInstructingAgent':
          if (entry.bic) parts.previousInstructingAgentBic = entry.bic;
          else parts.previousInstructingAgentName = entry.text.slice(0, 140);
          break;
        case 'remittanceInformation':
          parts.extraRemittance.push(entry.text);
          break;
        case 'clearingChannel':
          if (mapping.code) parts.clearingChannels.push(mapping.code);
          break;
        case 'returnReason':
          parts.returnReason = entry.text;
          context.diagnostics.warn({
            code: 'MT.NARRATIVE.RETURN',
            mtTag: '72',
            message: `Field 72 carries '/${entry.code}/', which marks this as a return or reject.`,
            hint: 'A returned payment is normally expressed as pacs.004 rather than pacs.008/pacs.009.',
          });
          break;
        default:
          parts.instructionForNextAgent.push({ info: entry.text.slice(0, 140) });
      }
    }
  }

  return parts;
}

/** `PaymentTypeInformation28`. */
export function paymentTypeInformation(
  parts: InstructionParts,
  priority: string | undefined,
): XmlElement | undefined {
  const instructionPriority =
    priority && (priority.toUpperCase() === 'U' || priority.toUpperCase() === 'S')
      ? 'HIGH'
      : undefined;

  return el(
    'PmtTpInf',
    instructionPriority ? el('InstrPrty', instructionPriority) : undefined,
    parts.clearingChannels[0] ? el('ClrChanl', parts.clearingChannels[0]) : undefined,
    ...unique(parts.serviceLevels).map((code) => el('SvcLvl', el('Cd', code))),
    parts.localInstruments[0] ? el('LclInstrm', el('Cd', parts.localInstruments[0])) : undefined,
    parts.categoryPurposes[0] ? el('CtgyPurp', el('Cd', parts.categoryPurposes[0])) : undefined,
  );
}

export function instructionElements(parts: InstructionParts): XmlElement[] {
  const creditorAgent = parts.instructionForCreditorAgent.map((item) =>
    el('InstrForCdtrAgt', item.code ? el('Cd', item.code) : undefined, item.info ? el('InstrInf', item.info) : undefined),
  );
  const nextAgent = parts.instructionForNextAgent.map((item) =>
    el('InstrForNxtAgt', item.code ? el('Cd', item.code) : undefined, item.info ? el('InstrInf', item.info) : undefined),
  );
  return [...creditorAgent, ...nextAgent];
}

/**
 * Field 13C time indications.
 *
 * `CLSTIME`, `TILTIME`, `FROTIME` and `REJTIME` are requests, so they become a
 * `SttlmTmReq`; `SNDTIME` and `RNCTIME` record what happened, so they become a
 * `SttlmTmIndctn` carrying a full date and time.
 */
export interface TimeIndications {
  readonly indication?: XmlElement;
  readonly request?: XmlElement;
}

export function timeIndications(
  context: MappingContext,
  settlementDate: string | undefined,
): TimeIndications {
  const fields = context.fields('13').filter((f) => f.option === 'C');
  if (fields.length === 0) return {};

  const requests: XmlElement[] = [];
  const indications: XmlElement[] = [];

  for (const field of fields) {
    const components = extract('/8c/4!n1!x4!n', field.value.trim());
    if (!components) {
      context.diagnostics.warn({
        code: 'MT.FIELD.TIME_INDICATION',
        mtTag: field.tag,
        message: `Time indication '${field.value}' does not match /8c/4!n1!x4!n.`,
      });
      continue;
    }

    const [code = '', time = '', sign = '', offset = ''] = components;
    const isoTime = parseTime4(time);
    const utcOffset = parseUtcOffset(sign, offset);
    if (!isoTime || !utcOffset) {
      context.diagnostics.warn({
        code: 'MT.FIELD.TIME_INDICATION',
        mtTag: field.tag,
        message: `Time indication '${field.value}' has an unusable time or UTC offset.`,
      });
      continue;
    }

    switch (code.toUpperCase()) {
      case 'CLSTIME':
        requests.push(el('CLSTm', `${isoTime}${utcOffset}`));
        break;
      case 'TILTIME':
        requests.push(el('TillTm', `${isoTime}${utcOffset}`));
        break;
      case 'FROTIME':
        requests.push(el('FrTm', `${isoTime}${utcOffset}`));
        break;
      case 'REJTIME':
        requests.push(el('RjctTm', `${isoTime}${utcOffset}`));
        break;
      case 'SNDTIME':
        if (settlementDate) indications.push(el('DbtDtTm', isoDateTime(settlementDate, isoTime, utcOffset)));
        break;
      case 'RNCTIME':
        if (settlementDate) indications.push(el('CdtDtTm', isoDateTime(settlementDate, isoTime, utcOffset)));
        break;
      default:
        context.diagnostics.warn({
          code: 'MT.CODE.UNKNOWN_13C',
          mtTag: field.tag,
          message: `Time indication code '${code}' is not recognised; it is dropped.`,
        });
    }
  }

  return {
    ...(indications.length > 0 ? { indication: el('SttlmTmIndctn', ...indications) } : {}),
    ...(requests.length > 0 ? { request: el('SttlmTmReq', ...requests) } : {}),
  };
}

/** Fields 71F and 71G: charges already taken and charges still to take. */
export function chargesInformation(context: MappingContext): XmlElement[] {
  const elements: XmlElement[] = [];

  for (const field of context.fields('71')) {
    if (field.option !== 'F' && field.option !== 'G') continue;
    const parsed = parseCurrencyAmount(field.value.trim());
    if (!parsed.valid) {
      context.diagnostics.warn({
        code: 'MT.FIELD.CHARGES',
        mtTag: field.tag,
        mxPath: 'ChrgsInf/Amt',
        message: `Charges amount is not usable: ${parsed.problem ?? 'unknown problem'}.`,
      });
      continue;
    }
    const bearerBic = field.option === 'F' ? context.senderBic : context.receiverBic;
    elements.push(
      el('ChrgsInf', amount('Amt', parsed), agentFromBic('Agt', bearerBic)),
    );
  }
  return elements;
}

/** Field 71A. */
export function chargeBearer(context: MappingContext): XmlElement | undefined {
  const field = context.fields('71').find((f) => f.option === 'A');
  if (!field) return undefined;

  const code = field.value.trim().toUpperCase();
  const mapped = CHARGE_BEARER[code];
  if (!mapped) {
    context.diagnostics.error({
      code: 'MT.CODE.UNKNOWN_71A',
      mtTag: field.tag,
      mxPath: 'ChrgBr',
      message: `Charge bearer code '${code}' is not one of OUR, BEN or SHA.`,
    });
    return undefined;
  }
  return el('ChrgBr', mapped);
}

/** Field 70 plus anything field 72 routed to remittance information. */
export function remittanceInformation(
  context: MappingContext,
  extra: readonly string[] = [],
): XmlElement | undefined {
  const field = context.field('70');
  const lines = [...(field?.lines ?? []), ...extra];
  if (lines.length === 0) return undefined;

  const structuredCodes = ['RFB', 'ROC', 'TSU'];
  const first = (lines[0] ?? '').trim();
  const structured = /^\/([A-Z]{3})\/(.+)$/.exec(first);

  if (structured && structuredCodes.includes(structured[1] as string)) {
    return el(
      'RmtInf',
      el(
        'Strd',
        el(
          'CdtrRefInf',
          el('Tp', el('CdOrPrtry', el('Prtry', structured[1] as string))),
          el('Ref', (structured[2] as string).trim().slice(0, 35)),
        ),
      ),
      ...unstructuredRemittance(lines.slice(1)),
    );
  }

  return el('RmtInf', ...unstructuredRemittance(lines));
}

/** Field 77B. */
export function regulatoryReporting(context: MappingContext): XmlElement[] {
  const field = context.fields('77').find((f) => f.option === 'B');
  if (!field) return [];

  return parseRegulatoryReporting(field.lines).map((report) =>
    el(
      'RgltryRptg',
      report.country ? el('Authrty', el('Ctry', report.country)) : undefined,
      el(
        'Dtls',
        el('Cd', report.code),
        ...report.details.map((detail) => el('Inf', detail.slice(0, 35))),
      ),
    ),
  );
}

/** Field 26T. */
export function purpose(context: MappingContext): XmlElement | undefined {
  const value = context.value('26');
  if (!value) return undefined;
  const code = transactionTypeToPurpose(value);
  if (!code) {
    context.diagnostics.warn({
      code: 'MT.FIELD.26T',
      mtTag: '26T',
      mxPath: 'Purp',
      message: `Transaction type code '${value}' is not a 3 character code; it is dropped.`,
    });
    return undefined;
  }
  return el('Purp', el('Prtry', code));
}

/** Field 33B and field 36 - the amount as instructed by the ordering customer. */
export function instructedAmount(context: MappingContext): {
  readonly amount?: XmlElement;
  readonly exchangeRate?: XmlElement;
} {
  const field = context.fields('33').find((f) => f.option === 'B');
  const rate = context.value('36');

  const result: { amount?: XmlElement; exchangeRate?: XmlElement } = {};
  if (field) {
    const parsed = parseCurrencyAmount(field.value.trim());
    if (parsed.valid) {
      result.amount = amountOf('InstdAmt', parsed.currency, parsed.value);
    } else {
      context.diagnostics.warn({
        code: 'MT.FIELD.33B',
        mtTag: field.tag,
        mxPath: 'InstdAmt',
        message: `Instructed amount is not usable: ${parsed.problem ?? 'unknown problem'}.`,
      });
    }
  }
  if (rate) {
    const normalised = rate.replace(',', '.').replace(/\.$/, '');
    if (/^\d+(\.\d+)?$/.test(normalised)) result.exchangeRate = el('XchgRate', normalised);
    else {
      context.diagnostics.warn({
        code: 'MT.FIELD.36',
        mtTag: '36',
        mxPath: 'XchgRate',
        message: `Exchange rate '${rate}' is not a valid decimal; it is dropped.`,
      });
    }
  }
  return result;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
