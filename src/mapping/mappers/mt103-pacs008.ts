import { el } from '../../mx/xml.js';
import { agent, agentFromBic, amount, cashAccount, party } from '../../mx/components.js';
import { sanitiseId } from '../../core/ids.js';
import type { MappingContext } from '../context.js';
import type { Mapper } from '../mapper.js';
import type { InstructionParts } from '../shared.js';
import {
  chargeBearer,
  chargesInformation,
  collectInstructions,
  instructedAmount,
  instructionElements,
  paymentTypeInformation,
  purpose,
  regulatoryReporting,
  remittanceInformation,
  settlementAmount,
  settlementInformation,
  timeIndications,
} from '../shared.js';

/**
 * MT103 Single Customer Credit Transfer -> pacs.008.001.08.
 *
 * The three MT103 flavours (core, STP and REMIT) share this mapper: they differ
 * in which field options the sender may use, not in where the data belongs.
 * REMIT additionally carries field 77T, which has no pacs.008 element and is
 * placed in supplementary data.
 */
export const mt103ToPacs008: Mapper = {
  mtTypes: ['103'],
  mxId: 'pacs.008.001.08',
  description: 'Single customer credit transfer',

  map(context: MappingContext) {
    const reference = context.id('20') ?? 'NOTPROVIDED';
    const settlement = settlementAmount(context);
    const instructions = collectInstructions(context);
    const times = timeIndications(context, settlement.date);
    const instructed = instructedAmount(context);

    const debtor = context.party('50', 'customer');
    const debtorAgent = context.party('52', 'institution');
    const intermediary = context.party('56', 'institution');
    const creditorAgent = context.party('57', 'institution');
    const creditor = context.party('59', 'customer');

    if (!creditor) {
      context.diagnostics.error({
        code: 'MT.MISSING.59',
        mtTag: '59a',
        mxPath: 'CdtTrfTxInf/Cdtr',
        message: 'Field 59a (beneficiary customer) is missing.',
      });
    }
    if (!debtor) {
      context.diagnostics.error({
        code: 'MT.MISSING.50',
        mtTag: '50a',
        mxPath: 'CdtTrfTxInf/Dbtr',
        message: 'Field 50a (ordering customer) is missing.',
      });
    }

    // ISO 20022 always names both agents. When MT leaves them implicit the
    // sender is the debtor agent and the receiver the creditor agent.
    const debtorAgentElement =
      agent('DbtrAgt', debtorAgent, context.options) ??
      inferAgent(context, 'DbtrAgt', context.senderBic, '52a', 'the sender');
    const creditorAgentElement =
      agent('CdtrAgt', creditorAgent, context.options) ??
      inferAgent(context, 'CdtrAgt', context.receiverBic, '57a', 'the receiver');

    const endToEnd = endToEndId(context, reference);
    const envelope = remitEnvelope(context);

    return el(
      'FIToFICstmrCdtTrf',
      el(
        'GrpHdr',
        el('MsgId', reference),
        el('CreDtTm', context.options.now),
        el('NbOfTxs', '1'),
        settlementInformation(context),
      ),
      el(
        'CdtTrfTxInf',
        el(
          'PmtId',
          el('InstrId', reference),
          el('EndToEndId', endToEnd),
          maybe('UETR', context.uetr()),
        ),
        paymentTypeInformation(instructions, context.priority),
        amount('IntrBkSttlmAmt', settlement.amount),
        maybe('IntrBkSttlmDt', settlement.date),
        times.indication,
        times.request,
        instructed.amount,
        instructed.exchangeRate,
        chargeBearer(context),
        ...chargesInformation(context),
        previousInstructingAgent(instructions),
        agentFromBic('InstgAgt', context.senderBic),
        agentFromBic('InstdAgt', context.receiverBic),
        agent('IntrmyAgt1', intermediary, context.options),
        cashAccount('IntrmyAgt1Acct', intermediary?.account),
        party('Dbtr', debtor, context.options),
        cashAccount('DbtrAcct', debtor?.account),
        debtorAgentElement,
        cashAccount('DbtrAgtAcct', debtorAgent?.account),
        creditorAgentElement,
        cashAccount('CdtrAgtAcct', creditorAgent?.account),
        party('Cdtr', creditor, context.options),
        cashAccount('CdtrAcct', creditor?.account),
        ...instructionElements(instructions),
        purpose(context),
        ...regulatoryReporting(context),
        remittanceInformation(context, instructions.extraRemittance),
      ),
      envelope,
    );
  },
};

function maybe(name: string, value: string | undefined) {
  return value === undefined ? undefined : el(name, value);
}

/**
 * End to end identification.
 *
 * MT103 has no dedicated element, so the ordering customer's reference is taken
 * from a `/ROC/` code word in field 70 when present and falls back to field 20.
 */
function endToEndId(context: MappingContext, reference: string): string {
  const remittance = context.message.block4.find((f) => f.number === '70');
  const roc = remittance?.lines
    .map((line) => /^\/ROC\/(.+)$/.exec(line.trim())?.[1])
    .find((value): value is string => Boolean(value));

  if (roc) return sanitiseId(roc);

  context.diagnostics.info({
    code: 'MX.END_TO_END_FROM_20',
    mtTag: '20',
    mxPath: 'PmtId/EndToEndId',
    message: 'No ordering customer reference (/ROC/) in field 70; field 20 is used as the end to end identification.',
  });
  return reference;
}

function inferAgent(
  context: MappingContext,
  elementName: string,
  bic: string | undefined,
  mtTag: string,
  who: string,
) {
  if (!bic) {
    context.diagnostics.warn({
      code: 'MX.AGENT_UNRESOLVED',
      mtTag,
      mxPath: `CdtTrfTxInf/${elementName}`,
      message: `Field ${mtTag} is absent and ${who}'s BIC is not available from the FIN header, so ${elementName} cannot be populated.`,
    });
    return undefined;
  }
  context.diagnostics.info({
    code: 'MX.AGENT_INFERRED',
    mtTag,
    mxPath: `CdtTrfTxInf/${elementName}`,
    message: `Field ${mtTag} is absent; ${elementName} was taken from ${who} (${bic}).`,
  });
  return agentFromBic(elementName, bic);
}

/** Field 72 `/INS/` names an institution ahead of the sender in the chain. */
function previousInstructingAgent(instructions: InstructionParts) {
  if (instructions.previousInstructingAgentBic) {
    return agentFromBic('PrvsInstgAgt1', instructions.previousInstructingAgentBic);
  }
  if (instructions.previousInstructingAgentName) {
    return el(
      'PrvsInstgAgt1',
      el('FinInstnId', el('Nm', instructions.previousInstructingAgentName)),
    );
  }
  return undefined;
}

/**
 * MT103 REMIT carries extended remittance data in field 77T, which pacs.008
 * has no element for. It is preserved in supplementary data rather than lost.
 */
function remitEnvelope(context: MappingContext) {
  const field = context.fields('77').find((f) => f.option === 'T');
  if (!field) return undefined;

  context.diagnostics.warn({
    code: 'MX.REMIT_SUPPLEMENTARY',
    mtTag: '77T',
    mxPath: 'SplmtryData/Envlp',
    message: 'Field 77T (extended remittance) has no pacs.008 element; it is carried in supplementary data.',
    hint: 'Receivers that do not read supplementary data will not see this remittance information.',
  });

  return el(
    'SplmtryData',
    el('PlcAndNm', 'RmtInf'),
    el('Envlp', el('Prtry', field.value)),
  );
}
