import type { ResolvedOptions } from '../core/options.js';
import { sanitiseId } from '../core/ids.js';
import type { AccountIdentification } from '../semantic/account.js';
import type { SemanticAmount } from '../semantic/amount.js';
import type { SemanticParty } from '../semantic/party.js';
import { toBic11 } from '../validation/bic.js';
import { el, elA, type XmlElement } from './xml.js';

/**
 * Reusable ISO 20022 building blocks.
 *
 * Element order matters: the schemas are `xs:sequence`, so each builder below
 * emits its children in the order the ISO 20022 message definition lists them.
 * Empty branches are removed later by the XML serialiser, which is why the
 * builders can emit a full shape unconditionally.
 */

/** Person identification schemes; the rest are treated as organisation ids. */
const PRIVATE_SCHEMES = new Set(['ARNU', 'CCPT', 'DRLC', 'NIDN', 'SOSE']);

/** ISO 20022 `Max140Text` used by name elements. */
const MAX_NAME = 140;
/** `Max70Text`, the limit on a single address line. */
const MAX_ADDRESS_LINE = 70;

/** `<Nm>` with the ISO length limit applied. */
export function name(value: string | undefined): XmlElement | undefined {
  if (!value) return undefined;
  return el('Nm', value.slice(0, MAX_NAME));
}

/**
 * `PostalAddress24`.
 *
 * MT carries an address as up to four free text lines. `hybrid` keeps those
 * lines and adds the country code the converter could infer, which is what most
 * MT to MX translation rulebooks produce; `structured` additionally promotes the
 * town and post code, and `unstructured` emits address lines only.
 */
export function postalAddress(
  party: SemanticParty,
  options: ResolvedOptions,
): XmlElement | undefined {
  const lines = party.addressLines.filter((line) => line.trim() !== '');
  if (lines.length === 0 && !party.country && !party.town) return undefined;

  if (options.addressFormat === 'unstructured') {
    return el('PstlAdr', ...lines.map((line) => el('AdrLine', line.slice(0, MAX_ADDRESS_LINE))));
  }

  if (options.addressFormat === 'structured') {
    // The last address line usually held the town, which was lifted out during
    // party resolution, so it is not repeated as an address line.
    const structuralLines = party.town
      ? lines.slice(0, Math.max(0, lines.length - 1))
      : lines;
    return el(
      'PstlAdr',
      structuralLines[0] ? el('StrtNm', (structuralLines[0] as string).slice(0, MAX_ADDRESS_LINE)) : undefined,
      party.buildingNumber ? el('BldgNb', party.buildingNumber) : undefined,
      party.postCode ? el('PstCd', party.postCode) : undefined,
      party.town ? el('TwnNm', party.town) : undefined,
      party.country ? el('Ctry', party.country) : undefined,
      ...structuralLines.slice(1).map((line) => el('AdrLine', line.slice(0, MAX_ADDRESS_LINE))),
    );
  }

  // Hybrid: keep the original lines, and promote whatever the source itself
  // stated in a structured way (option F) rather than throwing it away.
  return el(
    'PstlAdr',
    party.structured && party.postCode ? el('PstCd', party.postCode) : undefined,
    party.structured && party.town ? el('TwnNm', party.town) : undefined,
    party.country ? el('Ctry', party.country) : undefined,
    ...lines.map((line) => el('AdrLine', line.slice(0, MAX_ADDRESS_LINE))),
  );
}

/** `Party38Choice`: organisation or private identification. */
export function partyIdentificationChoice(party: SemanticParty): XmlElement | undefined {
  const isPrivate =
    Boolean(party.birthDate ?? party.birthPlace) ||
    party.identifiers.some((id) => PRIVATE_SCHEMES.has(id.code));

  if (isPrivate) {
    return el(
      'Id',
      el(
        'PrvtId',
        party.birthDate || party.birthPlace
          ? el(
              'DtAndPlcOfBirth',
              party.birthDate ? el('BirthDt', party.birthDate) : undefined,
              party.birthPlace?.city ? el('CityOfBirth', party.birthPlace.city) : undefined,
              party.birthPlace?.country ? el('CtryOfBirth', party.birthPlace.country) : undefined,
            )
          : undefined,
        ...party.identifiers.map((id) =>
          el(
            'Othr',
            el('Id', sanitiseId(id.value)),
            el('SchmeNm', el('Cd', id.code)),
            id.country ? el('Issr', id.country) : undefined,
          ),
        ),
      ),
    );
  }

  const organisationIds = party.identifiers;
  if (!party.bic && organisationIds.length === 0) return undefined;

  return el(
    'Id',
    el(
      'OrgId',
      party.bic ? el('AnyBIC', toBic11(party.bic)) : undefined,
      ...organisationIds.map((id) =>
        el(
          'Othr',
          el('Id', sanitiseId(id.value)),
          el('SchmeNm', el('Cd', id.code)),
          id.country ? el('Issr', id.country) : undefined,
        ),
      ),
    ),
  );
}

/** `PartyIdentification135`, used for debtor, creditor and their agents' clients. */
export function party(
  elementName: string,
  value: SemanticParty | undefined,
  options: ResolvedOptions,
): XmlElement | undefined {
  if (!value || value.empty) return undefined;
  return el(
    elementName,
    name(value.name),
    postalAddress(value, options),
    partyIdentificationChoice(value),
    value.country && !value.addressLines.length ? el('CtryOfRes', value.country) : undefined,
  );
}

/** `ClearingSystemMemberIdentification2` from a parsed party identifier. */
export function clearingMemberId(account: AccountIdentification | undefined): XmlElement | undefined {
  if (!account?.clearing) return undefined;
  return el(
    'ClrSysMmbId',
    el('ClrSysId', el('Cd', account.clearing.isoCode)),
    el('MmbId', account.clearing.memberId),
  );
}

/**
 * `BranchAndFinancialInstitutionIdentification6`.
 *
 * A financial institution in MT can be identified by BIC (option A), by a
 * national clearing code (options B, C and the identifier line of the others),
 * or by name and address (option D). All three land in the same ISO structure.
 */
export function agent(
  elementName: string,
  value: SemanticParty | undefined,
  options: ResolvedOptions,
): XmlElement | undefined {
  if (!value || value.empty) return undefined;

  const addressLines = value.location ? [value.location] : value.addressLines;
  const addressParty: SemanticParty = { ...value, addressLines };

  return el(
    elementName,
    el(
      'FinInstnId',
      value.bic ? el('BICFI', toBic11(value.bic)) : undefined,
      clearingMemberId(value.account),
      name(value.name),
      value.bic ? undefined : postalAddress(addressParty, options),
      value.bic || value.account?.clearing || value.name || addressLines.length > 0
        ? undefined
        : otherFinancialInstitutionId(value.account),
    ),
  );
}

function otherFinancialInstitutionId(
  account: AccountIdentification | undefined,
): XmlElement | undefined {
  const id = account?.other ?? account?.iban;
  if (!id) return undefined;
  return el('Othr', el('Id', sanitiseId(id, 35)));
}

/** An agent known only by its BIC, e.g. one taken from the FIN header. */
export function agentFromBic(elementName: string, bic: string | undefined): XmlElement | undefined {
  if (!bic) return undefined;
  return el(elementName, el('FinInstnId', el('BICFI', toBic11(bic))));
}

/** `CashAccount38`. */
export function cashAccount(
  elementName: string,
  account: AccountIdentification | undefined,
  currency?: string,
): XmlElement | undefined {
  if (!account) return undefined;

  const identification = account.iban && account.ibanValid !== false
    ? el('Id', el('IBAN', account.iban))
    : account.other || account.iban
      ? el('Id', el('Othr', el('Id', sanitiseId((account.other ?? account.iban) as string, 34))))
      : undefined;

  if (!identification) return undefined;
  return el(elementName, identification, currency ? el('Ccy', currency) : undefined);
}

/** `ActiveCurrencyAndAmount`, e.g. `<IntrBkSttlmAmt Ccy="EUR">1234.56</IntrBkSttlmAmt>`. */
export function amount(elementName: string, value: SemanticAmount | undefined): XmlElement | undefined {
  if (!value) return undefined;
  return elA(elementName, { Ccy: value.currency }, value.value);
}

/** Raw currency/amount pair when the value is already an ISO decimal string. */
export function amountOf(
  elementName: string,
  currency: string,
  value: string,
): XmlElement {
  return elA(elementName, { Ccy: currency }, value);
}

/**
 * Split remittance text into `Ustrd` occurrences.
 *
 * Four MT lines of 35 characters joined with spaces can reach 143 characters,
 * three past the ISO `Max140Text` limit, so the text is split on line
 * boundaries instead of being truncated.
 */
export function unstructuredRemittance(lines: readonly string[]): XmlElement[] {
  const chunks: string[] = [];
  let current = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const candidate = current === '' ? line : `${current} ${line}`;
    if (candidate.length <= 140) {
      current = candidate;
      continue;
    }
    if (current !== '') chunks.push(current);
    current = line.length <= 140 ? line : line.slice(0, 140);
  }
  if (current !== '') chunks.push(current);
  return chunks.map((chunk) => el('Ustrd', chunk));
}

/** `SupplementaryData` is never generated, but the helper documents the gap. */
export function proprietary(elementName: string, key: string, value: string): XmlElement {
  return el(elementName, el('Prtry', el('Id', key), el('Issr', 'MT2MX')), el('Nm', value));
}
