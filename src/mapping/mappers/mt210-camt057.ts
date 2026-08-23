import { el } from '../../mx/xml.js';
import { agent, amount, party } from '../../mx/components.js';
import { repeatingGroups } from '../../mt/sequences.js';
import { parseCurrencyAmount } from '../../semantic/amount.js';
import { parseDate6 } from '../../semantic/dates.js';
import { statementAccount } from '../cash.js';
import type { MappingContext } from '../context.js';
import type { Mapper } from '../mapper.js';

/**
 * MT210 Notice to Receive -> camt.057.001.06 Notification to Receive.
 *
 * MT210 repeats a small sequence (21, 32B and the paying parties) up to ten
 * times; each repetition becomes one notification item.
 */
export const mt210ToCamt057: Mapper = {
  mtTypes: ['210'],
  mxId: 'camt.057.001.06',
  description: 'Notice to receive',

  map(context: MappingContext) {
    const reference = context.id('20') ?? 'NOTPROVIDED';
    const valueDateRaw = context.value('30');
    const valueDate = valueDateRaw
      ? parseDate6(valueDateRaw, { referenceYear: context.options.referenceYear })
      : undefined;

    if (valueDateRaw && !valueDate) {
      context.diagnostics.error({
        code: 'MT.FIELD.30',
        mtTag: '30',
        mxPath: 'Ntfctn/XpctdValDt',
        message: `Value date '${valueDateRaw}' is not a valid YYMMDD date.`,
      });
    }

    const groups = repeatingGroups(context.scope, '21', ['32', '50', '52', '56']);
    if (groups.length === 0) {
      context.diagnostics.error({
        code: 'MT.MISSING.21',
        mtTag: '21',
        mxPath: 'Ntfctn/Itm',
        message: 'MT210 must carry at least one sequence starting with field 21.',
      });
    }
    context.consume('21', '32', '50', '52', '56');

    const items = groups.map((group) => {
      const itemContext = context.withScope(group);
      const itemReference = itemContext.id('21') ?? 'NOTPROVIDED';
      const amountField = itemContext.field('32');
      const parsed = amountField ? parseCurrencyAmount(amountField.value.trim()) : undefined;

      if (!parsed?.valid) {
        context.diagnostics.error({
          code: 'MT.FIELD.32B',
          mtTag: '32B',
          mxPath: 'Ntfctn/Itm/Amt',
          message: parsed
            ? `Item amount is not usable: ${parsed.problem ?? 'unknown problem'}.`
            : `Sequence '${itemReference}' has no field 32B.`,
        });
      }

      const orderingCustomer = itemContext.party('50', 'customer');
      const orderingInstitution = itemContext.party('52', 'institution');
      const intermediary = itemContext.party('56', 'institution');
      context.diagnostics.absorb(itemContext.diagnostics.all());

      return el(
        'Itm',
        el('Id', itemReference),
        el('EndToEndId', itemReference),
        amount('Amt', parsed),
        valueDate ? el('XpctdValDt', valueDate) : undefined,
        orderingCustomer
          ? el('Dbtr', party('Pty', orderingCustomer, context.options))
          : orderingInstitution
            ? el('Dbtr', agent('Agt', orderingInstitution, context.options))
            : undefined,
        orderingCustomer ? agent('DbtrAgt', orderingInstitution, context.options) : undefined,
        agent('IntrmyAgt', intermediary, context.options),
      );
    });

    const { account } = statementAccount(context);

    return el(
      'NtfctnToRcv',
      el(
        'GrpHdr',
        el('MsgId', reference),
        el('CreDtTm', context.options.now),
      ),
      el(
        'Ntfctn',
        el('Id', reference),
        account,
        valueDate ? el('XpctdValDt', valueDate) : undefined,
        ...items,
      ),
    );
  },
};
