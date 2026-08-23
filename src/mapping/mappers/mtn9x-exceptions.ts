import { el } from '../../mx/xml.js';
import { agentFromBic, amount } from '../../mx/components.js';
import { sanitiseId } from '../../core/ids.js';
import { extract } from '../../mt/pattern.js';
import { schemaFor } from '../../mt/schemas.js';
import { parseValueDateAmount } from '../../semantic/amount.js';
import { parseDate6, isoDateTime } from '../../semantic/dates.js';
import type { MappingContext } from '../context.js';
import type { Mapper } from '../mapper.js';

/**
 * The n92 / n96 exception messages.
 *
 *   MT192, MT292, MT992 Request for Cancellation -> camt.056.001.08
 *   MT196, MT296, MT996 Answers                  -> camt.029.001.09
 *
 * Both are thin wrappers around a reference to an earlier message, so most of
 * the mapping work is reconstructing what the original message was from
 * field 11S and reading a reason code out of the narrative.
 */

/** ISO 20022 `ExternalCancellationReason1Code` values that MT senders use. */
const CANCELLATION_REASONS = new Set([
  'AGNT', 'AM09', 'COVR', 'CURR', 'CUST', 'CUTA', 'DUPL', 'FRAD', 'TECH', 'UPAY',
]);

/**
 * Field 11S: the message type and date of the message being referred to, as
 * `3!n6!n[4!n6!n]`.
 */
interface OriginalMessage {
  readonly messageType?: string;
  readonly messageName?: string;
  readonly date?: string;
}

function originalMessage(context: MappingContext): OriginalMessage {
  const field = context.fields('11').find((f) => f.option === 'S' || f.option === 'A');
  if (!field) return {};

  const components = extract('3!n6!n[4!n6!n]', field.value.replace(/\n/g, ''));
  if (!components) {
    context.diagnostics.warn({
      code: 'MT.FIELD.11S',
      mtTag: field.tag,
      mxPath: 'OrgnlGrpInf',
      message: `Field ${field.tag} does not match 3!n6!n[4!n6!n]; the original message cannot be identified.`,
    });
    return {};
  }

  const [type = '', date = ''] = components;
  const isoDate = parseDate6(date, { referenceYear: context.options.referenceYear });
  const schema = schemaFor(type);

  if (schema) {
    context.diagnostics.info({
      code: 'MX.ORIGINAL_MESSAGE_NAME',
      mtTag: field.tag,
      mxPath: 'OrgnlGrpInf/OrgnlMsgNmId',
      message: `The cancelled MT${type} is named as its ISO 20022 equivalent ${schema.mxTarget}.`,
    });
  } else {
    context.diagnostics.warn({
      code: 'MX.ORIGINAL_MESSAGE_UNKNOWN',
      mtTag: field.tag,
      mxPath: 'OrgnlGrpInf/OrgnlMsgNmId',
      message: `MT${type} has no ISO 20022 equivalent in the mapping table; the MT name is used instead.`,
    });
  }

  return {
    messageType: type,
    messageName: schema ? schema.mxTarget : `MT${type}`,
    ...(isoDate ? { date: isoDate } : {}),
  };
}

/** Case assignment: who is asking whom, and under which reference. */
function assignment(context: MappingContext, reference: string) {
  return el(
    'Assgnmt',
    el('Id', reference),
    el('Assgnr', agentFromBic('Agt', context.senderBic)),
    el('Assgne', agentFromBic('Agt', context.receiverBic)),
    el('CreDtTm', context.options.now),
  );
}

/** Narrative fields 79 / 76 / 77A, joined and scanned for a leading code. */
function narrative(context: MappingContext, numbers: readonly string[]): {
  readonly text: string;
  readonly code?: string;
} {
  const lines: string[] = [];
  for (const number of numbers) {
    for (const field of context.fields(number)) lines.push(...field.lines);
  }
  const text = lines.map((line) => line.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const coded = /^\/([A-Z0-9]{2,4})\/\s*(.*)$/.exec(lines[0]?.trim() ?? '');
  return {
    text: coded ? `${coded[2] ?? ''} ${lines.slice(1).join(' ')}`.trim() || text : text,
    ...(coded ? { code: coded[1] as string } : {}),
  };
}

export const mt192ToCamt056: Mapper = {
  mtTypes: ['192', '292', '992'],
  mxId: 'camt.056.001.08',
  description: 'Request for cancellation',

  map(context: MappingContext) {
    const reference = context.id('20') ?? 'NOTPROVIDED';
    const original = context.id('21');
    const source = originalMessage(context);
    const reason = narrative(context, ['79', '77']);

    if (!original) {
      context.diagnostics.error({
        code: 'MT.MISSING.21',
        mtTag: '21',
        mxPath: 'Undrlyg/TxInf/OrgnlInstrId',
        message: 'Field 21 must carry the reference of the message to be cancelled.',
      });
    }

    const reasonCode =
      reason.code && CANCELLATION_REASONS.has(reason.code) ? reason.code : undefined;
    if (reason.code && !reasonCode) {
      context.diagnostics.info({
        code: 'MX.CANCELLATION_REASON_TEXT',
        mtTag: '79',
        mxPath: 'CxlRsnInf/AddtlInf',
        message: `'${reason.code}' is not an ISO cancellation reason code; the narrative is carried as additional information.`,
      });
    }

    const settlement = context.field('32');
    const parsed = settlement ? parseValueDateAmount(settlement.value) : undefined;
    const settlementDate = parsed?.date6
      ? parseDate6(parsed.date6, { referenceYear: context.options.referenceYear })
      : undefined;

    return el(
      'FIToFIPmtCxlReq',
      assignment(context, reference),
      el(
        'Undrlyg',
        el(
          'TxInf',
          el('CxlId', reference),
          el(
            'Case',
            el('Id', original ?? reference),
            el('Cretr', agentFromBic('Agt', context.senderBic)),
          ),
          el(
            'OrgnlGrpInf',
            el('OrgnlMsgId', original ?? 'NOTPROVIDED'),
            source.messageName ? el('OrgnlMsgNmId', source.messageName) : undefined,
            source.date ? el('OrgnlCreDtTm', isoDateTime(source.date)) : undefined,
          ),
          original ? el('OrgnlInstrId', original) : undefined,
          original ? el('OrgnlEndToEndId', original) : undefined,
          amount('OrgnlIntrBkSttlmAmt', parsed?.amount),
          settlementDate ? el('OrgnlIntrBkSttlmDt', settlementDate) : undefined,
          el(
            'CxlRsnInf',
            el('Orgtr', el('Nm', context.senderBic ?? 'SENDER')),
            reasonCode ? el('Rsn', el('Cd', reasonCode)) : undefined,
            reason.text ? el('AddtlInf', reason.text.slice(0, 105)) : undefined,
          ),
        ),
      ),
    );
  },
};

/**
 * MT196 answers a query or a cancellation request. ISO 20022 states the outcome
 * as a confirmation code, which is read out of the answer narrative.
 */
const CONFIRMATION_KEYWORDS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\bCNCL\b|CANCELL?ED|ACCEPTED/, 'CNCL', 'the cancellation was carried out'],
  [/\bRJCR\b|REJECT/, 'RJCR', 'the cancellation was rejected'],
  [/\bPDCR\b|PENDING/, 'PDCR', 'the cancellation is pending'],
  [/\bACNR\b|NOT\s+RECEIVED/, 'ACNR', 'the original was not received'],
];

export const mt196ToCamt029: Mapper = {
  mtTypes: ['196', '296', '996'],
  mxId: 'camt.029.001.09',
  description: 'Answer to a query or cancellation request',

  map(context: MappingContext) {
    const reference = context.id('20') ?? 'NOTPROVIDED';
    const original = context.id('21');
    const answers = narrative(context, ['76', '77', '79']);

    let confirmation = 'PDCR';
    let explanation = 'no recognisable outcome in the answer, so a pending status is reported';
    for (const [pattern, code, note] of CONFIRMATION_KEYWORDS) {
      if (pattern.test(answers.text.toUpperCase())) {
        confirmation = code;
        explanation = note;
        break;
      }
    }

    context.diagnostics.info({
      code: 'MX.INVESTIGATION_STATUS',
      mtTag: '76',
      mxPath: 'Sts/Conf',
      message: `Investigation status resolved to ${confirmation}: ${explanation}.`,
      hint: 'The MT answer is free text, so the status is inferred from its wording.',
    });

    if (confirmation === 'PDCR') {
      context.diagnostics.warn({
        code: 'MX.INVESTIGATION_STATUS_UNCERTAIN',
        mtTag: '76',
        mxPath: 'Sts/Conf',
        message: 'The answer text did not state an outcome; review the status before sending.',
      });
    }

    return el(
      'RsltnOfInvstgtn',
      assignment(context, reference),
      el(
        'RslvdCase',
        el('Id', original ?? reference),
        el('Cretr', agentFromBic('Agt', context.receiverBic)),
      ),
      el('Sts', el('Conf', confirmation)),
      el(
        'CxlDtls',
        el(
          'TxInfAndSts',
          original ? el('OrgnlInstrId', sanitiseId(original)) : undefined,
          original ? el('OrgnlEndToEndId', sanitiseId(original)) : undefined,
          answers.text
            ? el('CxlStsRsnInf', el('AddtlInf', answers.text.slice(0, 105)))
            : undefined,
        ),
      ),
    );
  },
};
