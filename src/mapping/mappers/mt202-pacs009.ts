import { el, type XmlChild } from '../../mx/xml.js';
import { agent, agentFromBic, amount, cashAccount, party } from '../../mx/components.js';
import { splitAt } from '../../mt/sequences.js';
import type { MappingContext } from '../context.js';
import type { Mapper } from '../mapper.js';
import {
  collectInstructions,
  instructedAmount,
  instructionElements,
  paymentTypeInformation,
  remittanceInformation,
  settlementAmount,
  settlementInformation,
  timeIndications,
  type InstructionParts,
} from '../shared.js';

/**
 * MT202 / MT205 General Financial Institution Transfer -> pacs.009.001.08,
 * MT200 own account transfer -> pacs.009.001.08,
 * MT202 COV -> pacs.009.001.08 with an underlying customer credit transfer.
 *
 * In pacs.009 the debtor and creditor are financial institutions rather than
 * customers, so the same field numbers map to agent structures instead of party
 * structures.
 */

function buildCore(
  context: MappingContext,
  options: { readonly ownAccount: boolean; readonly trailing?: readonly XmlChild[] },
) {
  const reference = context.id('20') ?? 'NOTPROVIDED';
  const related = context.id('21');
  const settlement = settlementAmount(context);
  const instructions = collectInstructions(context);
  const times = timeIndications(context, settlement.date);

  const orderingInstitution = context.party('52', 'institution');
  const intermediary = context.party('56', 'institution');
  const accountWith = context.party('57', 'institution');
  const beneficiaryInstitution = context.party('58', 'institution');

  // MT200 moves the sender's own money, so both sides of the transfer are the
  // sender itself and the account with institution holds the receiving account.
  const debtor =
    agent('Dbtr', orderingInstitution, context.options) ??
    agentFromBic('Dbtr', context.senderBic);
  const creditor = options.ownAccount
    ? agentFromBic('Cdtr', context.senderBic)
    : agent('Cdtr', beneficiaryInstitution, context.options);

  if (!options.ownAccount && !beneficiaryInstitution) {
    context.diagnostics.error({
      code: 'MT.MISSING.58',
      mtTag: '58a',
      mxPath: 'CdtTrfTxInf/Cdtr',
      message: 'Field 58a (beneficiary institution) is missing.',
    });
  }
  if (!orderingInstitution) {
    context.diagnostics.info({
      code: 'MX.AGENT_INFERRED',
      mtTag: '52a',
      mxPath: 'CdtTrfTxInf/Dbtr',
      message: `Field 52a is absent; the debtor was taken from the sender (${context.senderBic ?? 'unknown'}).`,
    });
  }

  return {
    reference,
    settlement,
    instructions,
    transaction: el(
      'CdtTrfTxInf',
      el(
        'PmtId',
        el('InstrId', reference),
        el('EndToEndId', related ?? reference),
        maybe('UETR', context.uetr()),
      ),
      paymentTypeInformation(instructions, context.priority),
      amount('IntrBkSttlmAmt', settlement.amount),
      maybe('IntrBkSttlmDt', settlement.date),
      times.indication,
      times.request,
      previousInstructingAgent(instructions),
      agentFromBic('InstgAgt', context.senderBic),
      agentFromBic('InstdAgt', context.receiverBic),
      agent('IntrmyAgt1', intermediary, context.options),
      cashAccount('IntrmyAgt1Acct', intermediary?.account),
      debtor,
      cashAccount('DbtrAcct', orderingInstitution?.account),
      agent('CdtrAgt', accountWith, context.options),
      cashAccount('CdtrAgtAcct', accountWith?.account),
      creditor,
      cashAccount('CdtrAcct', options.ownAccount ? accountWith?.account : beneficiaryInstitution?.account),
      ...instructionElements(instructions),
      remittanceInformation(context, instructions.extraRemittance),
      ...(options.trailing ?? []),
    ),
  };
}

function maybe(name: string, value: string | undefined) {
  return value === undefined ? undefined : el(name, value);
}

function previousInstructingAgent(instructions: InstructionParts) {
  if (instructions.previousInstructingAgentBic) {
    return agentFromBic('PrvsInstgAgt1', instructions.previousInstructingAgentBic);
  }
  if (instructions.previousInstructingAgentName) {
    return el('PrvsInstgAgt1', el('FinInstnId', el('Nm', instructions.previousInstructingAgentName)));
  }
  return undefined;
}

function groupHeader(context: MappingContext, reference: string) {
  return el(
    'GrpHdr',
    el('MsgId', reference),
    el('CreDtTm', context.options.now),
    el('NbOfTxs', '1'),
    settlementInformation(context),
  );
}

export const mt202ToPacs009: Mapper = {
  mtTypes: ['202', '205'],
  mxId: 'pacs.009.001.08',
  description: 'General financial institution transfer',

  map(context: MappingContext) {
    const core = buildCore(context, { ownAccount: false });
    return el('FinInstnCdtTrf', groupHeader(context, core.reference), core.transaction);
  },
};

export const mt200ToPacs009: Mapper = {
  mtTypes: ['200'],
  mxId: 'pacs.009.001.08',
  description: "Financial institution transfer for its own account",

  map(context: MappingContext) {
    const core = buildCore(context, { ownAccount: true });
    return el('FinInstnCdtTrf', groupHeader(context, core.reference), core.transaction);
  },
};

/**
 * MT202 COV / MT205 COV.
 *
 * Sequence B repeats the customer payment that the bank-to-bank transfer
 * covers. It is mapped into `UndrlygCstmrCdtTrf`, which is the whole point of
 * the COV variant: without it the underlying customer data would be invisible
 * to sanction screening downstream.
 */
export const mt202CovToPacs009: Mapper = {
  mtTypes: ['202', '205'],
  variant: 'COV',
  mxId: 'pacs.009.001.08',
  description: 'General financial institution transfer covering a customer credit transfer',

  map(context: MappingContext) {
    const { sequenceA, sequenceB } = splitAt(context.message, '50');

    const underlyingContext = context.withScope(sequenceB);
    const underlying = buildUnderlying(underlyingContext);
    context.diagnostics.absorb(underlyingContext.diagnostics.all());

    const headerContext = context.withScope(sequenceA);
    const core = buildCore(headerContext, { ownAccount: false, trailing: [underlying] });
    // The group header reads the correspondent fields, so it has to be built
    // before the leftover fields are counted.
    const header = groupHeader(headerContext, core.reference);
    context.diagnostics.absorb(headerContext.diagnostics.all());

    for (const field of [...headerContext.unused(), ...underlyingContext.unused()]) {
      context.diagnostics.warn({
        code: 'MT.FIELD.UNMAPPED',
        mtTag: field.tag,
        message: `Field ${field.tag} has no place in ${mt202CovToPacs009.mxId} and was not mapped.`,
      });
    }
    context.consume(...context.message.block4.map((f) => f.number));

    return el('FinInstnCdtTrf', header, core.transaction);
  },
};

/** Sequence B: the customer credit transfer being covered. */
function buildUnderlying(context: MappingContext) {
  const debtor = context.party('50', 'customer');
  const debtorAgent = context.party('52', 'institution');
  const intermediary = context.party('56', 'institution');
  const creditorAgent = context.party('57', 'institution');
  const creditor = context.party('59', 'customer');
  const instructions = collectInstructions(context);
  const instructed = instructedAmount(context);

  if (!debtor || !creditor) {
    context.diagnostics.error({
      code: 'MT.COV.INCOMPLETE',
      mtTag: '50a/59a',
      mxPath: 'UndrlygCstmrCdtTrf',
      message: 'The cover sequence must carry both an ordering customer (50a) and a beneficiary customer (59a).',
    });
  }

  return el(
    'UndrlygCstmrCdtTrf',
    party('Dbtr', debtor, context.options),
    cashAccount('DbtrAcct', debtor?.account),
    agent('DbtrAgt', debtorAgent, context.options),
    cashAccount('DbtrAgtAcct', debtorAgent?.account),
    agent('IntrmyAgt1', intermediary, context.options),
    cashAccount('IntrmyAgt1Acct', intermediary?.account),
    agent('CdtrAgt', creditorAgent, context.options),
    cashAccount('CdtrAgtAcct', creditorAgent?.account),
    party('Cdtr', creditor, context.options),
    cashAccount('CdtrAcct', creditor?.account),
    ...instructionElements(instructions),
    remittanceInformation(context, instructions.extraRemittance),
    instructed.amount,
  );
}
