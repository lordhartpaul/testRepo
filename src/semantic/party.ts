import { DiagnosticCollector, type Diagnostic } from '../core/diagnostics.js';
import { resolveCountry } from '../reference/countries.js';
import type { MtField } from '../mt/message.js';
import { fieldFormat } from '../mt/formats.js';
import { matchPattern } from '../mt/pattern.js';
import { isBic, toBic11, validateBic } from '../validation/bic.js';
import { parseAccountIdentification, type AccountIdentification } from './account.js';

export type PartyKind = 'customer' | 'institution';

export interface PartyIdentifier {
  /** Scheme code, e.g. `CCPT` (passport) or `TXID` (tax identifier). */
  readonly code: string;
  readonly country?: string;
  readonly value: string;
}

export interface SemanticParty {
  readonly sourceTag: string;
  readonly option?: string;
  readonly kind: PartyKind;
  readonly bic?: string;
  readonly bicValid?: boolean;
  readonly name?: string;
  readonly addressLines: readonly string[];
  readonly country?: string;
  readonly town?: string;
  readonly buildingNumber?: string;
  readonly streetName?: string;
  readonly postCode?: string;
  /** Free text location from option B. */
  readonly location?: string;
  readonly account?: AccountIdentification;
  /** ISO date, from option F line code 4. */
  readonly birthDate?: string;
  readonly birthPlace?: { readonly country?: string; readonly city?: string };
  readonly identifiers: readonly PartyIdentifier[];
  readonly additionalInfo: readonly string[];
  /** True when the party came from a structured option (F). */
  readonly structured: boolean;
  readonly empty: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** 0..1 measure of how unambiguously the field could be interpreted. */
  readonly confidence: number;
}

/** Party identifier scheme codes valid in the first line of field 50F. */
const IDENTIFIER_CODES = new Set([
  'ARNU', 'CCPT', 'CUST', 'DRLC', 'EMPL', 'NIDN', 'SOSE', 'TXID',
]);

/** Line codes used inside options F. */
const LINE_CODE_MEANING: Readonly<Record<string, string>> = {
  '1': 'name',
  '2': 'address',
  '3': 'country-and-town',
  '4': 'date-of-birth',
  '5': 'place-of-birth',
  '6': 'customer-identification',
  '7': 'national-identity',
  '8': 'additional-information',
};

export interface ResolvePartyOptions {
  readonly kind: PartyKind;
  /** Skip format validation, e.g. for fields rebuilt from a sequence. */
  readonly skipFormatCheck?: boolean;
}

/**
 * Turn a raw MT party field into a semantic party.
 *
 * The routine works from the physical line structure rather than from the
 * format specification alone, because senders routinely bend the specification
 * (a BIC dropped into option K, an account line without its slash). The format
 * pattern is still evaluated so deviations surface as diagnostics instead of
 * being silently swallowed.
 */
export function resolveParty(field: MtField, options: ResolvePartyOptions): SemanticParty {
  const diagnostics = new DiagnosticCollector();
  const option = field.option;
  let confidence = 1;

  if (!options.skipFormatCheck) {
    const format = fieldFormat(field.tag);
    if (format) {
      const result = matchPattern(format.pattern, field.value);
      if (!result.ok) {
        confidence -= 0.15;
        diagnostics.warn({
          code: 'MT.FIELD.FORMAT',
          mtTag: field.tag,
          message: `Field ${field.tag} does not match its format ${format.pattern}: ${result.error ?? ''}`.trim(),
          hint: 'The value was still interpreted structurally; check the source system.',
        });
      }
    } else {
      diagnostics.info({
        code: 'MT.FIELD.UNKNOWN_FORMAT',
        mtTag: field.tag,
        message: `No format specification is registered for field ${field.tag}.`,
      });
    }
  }

  const lines = [...field.lines];
  let account: AccountIdentification | undefined;

  // Option C is nothing but a party identifier.
  if (option === 'C') {
    account = parseIdentifierLine(lines[0] ?? '');
    return finish({
      sourceTag: field.tag,
      option,
      kind: options.kind,
      account,
      confidence: account ? confidence : confidence - 0.3,
      diagnostics,
      addressLines: [],
      identifiers: [],
      additionalInfo: [],
      structured: false,
    });
  }

  if ((lines[0] ?? '').startsWith('/')) {
    account = parseIdentifierLine(lines[0] as string);
    lines.shift();
    if (account?.iban && account.ibanValid === false) {
      confidence -= 0.1;
      diagnostics.warn({
        code: 'MT.PARTY.IBAN_INVALID',
        mtTag: field.tag,
        message: `Account '${account.iban}' looks like an IBAN but is not valid: ${account.ibanProblem ?? ''}`.trim(),
        hint: 'It is carried through as a proprietary account identification.',
      });
    }
    if (account?.clearing && !account.clearing.memberIdPlausible) {
      diagnostics.warn({
        code: 'MT.PARTY.CLEARING_MEMBER_SHAPE',
        mtTag: field.tag,
        message: `Member id '${account.clearing.memberId}' does not have the expected shape for ${account.clearing.name}.`,
      });
    }
    if (account?.unknownClearingPrefix) {
      confidence -= 0.05;
      diagnostics.warn({
        code: 'MT.PARTY.UNKNOWN_CLEARING_PREFIX',
        mtTag: field.tag,
        message: `Clearing system prefix '//${account.unknownClearingPrefix}' is not in the reference table.`,
        hint: 'Carried through as a proprietary account identification.',
      });
    }
  }

  if (option === 'F') {
    return resolveStructured(field, lines, account, options.kind, diagnostics, confidence);
  }

  if (option === 'A') {
    const candidate = (lines[0] ?? '').trim();
    const check = validateBic(candidate);
    if (!check.valid) {
      // A party identified only by a clearing system member id is still usable,
      // so a missing BIC is a warning while a malformed one is an error.
      const identifiedAnyway = Boolean(account?.clearing ?? account?.other ?? account?.iban);
      if (candidate === '' && identifiedAnyway) {
        confidence -= 0.15;
        diagnostics.warn({
          code: 'MT.PARTY.BIC_ABSENT',
          mtTag: field.tag,
          message: `Option A carries no BIC; the party is identified by its party identifier line instead.`,
          hint: 'Options C or D are the correct options for a party without a BIC.',
        });
      } else {
        confidence -= 0.4;
        diagnostics.error({
          code: 'MT.PARTY.BIC_INVALID',
          mtTag: field.tag,
          message: `Option A expects a BIC but found '${candidate}': ${check.reason ?? 'malformed'}.`,
        });
      }
    }
    return finish({
      sourceTag: field.tag,
      option,
      kind: options.kind,
      ...(check.valid ? { bic: toBic11(check.normalised) } : {}),
      bicValid: check.valid,
      ...(account ? { account } : {}),
      addressLines: [],
      identifiers: [],
      additionalInfo: [],
      structured: false,
      confidence,
      diagnostics,
    });
  }

  if (option === 'B') {
    const location = (lines[0] ?? '').trim();
    return finish({
      sourceTag: field.tag,
      option,
      kind: options.kind,
      ...(location ? { location } : {}),
      ...(account ? { account } : {}),
      addressLines: [],
      identifiers: [],
      additionalInfo: [],
      structured: false,
      confidence,
      diagnostics,
    });
  }

  // Options D, K and the option-less field 59: name and address block.
  const payload = lines.map((line) => line.trim()).filter((line) => line !== '');

  // A BIC sometimes turns up in a name-and-address option; recognising it keeps
  // the agent identifiable instead of degrading it to free text.
  if (payload.length === 1 && isBic(payload[0] as string)) {
    diagnostics.info({
      code: 'MT.PARTY.BIC_IN_NAME_OPTION',
      mtTag: field.tag,
      message: `Field ${field.tag} carries a bare BIC in a name-and-address option; used as the party identification.`,
    });
    return finish({
      sourceTag: field.tag,
      option,
      kind: options.kind,
      bic: toBic11(payload[0] as string),
      bicValid: true,
      ...(account ? { account } : {}),
      addressLines: [],
      identifiers: [],
      additionalInfo: [],
      structured: false,
      confidence: confidence - 0.05,
      diagnostics,
    });
  }

  const [name, ...addressLines] = payload;
  const geo = inferGeography(addressLines);
  if (payload.length === 0) {
    confidence -= 0.5;
    diagnostics.warn({
      code: 'MT.PARTY.EMPTY',
      mtTag: field.tag,
      message: `Field ${field.tag} carries no name or address.`,
    });
  } else if (!geo.country) {
    confidence -= 0.05;
  }

  return finish({
    sourceTag: field.tag,
    option,
    kind: options.kind,
    ...(name ? { name } : {}),
    addressLines,
    ...geo,
    ...(account ? { account } : {}),
    identifiers: [],
    additionalInfo: [],
    structured: false,
    confidence,
    diagnostics,
  });
}

/** Parse the first line of a party field, which always starts with `/`. */
function parseIdentifierLine(line: string): AccountIdentification | undefined {
  const markMatch = /^\/([DC])\/(.*)$/.exec(line);
  if (markMatch) {
    return parseAccountIdentification(markMatch[2] as string, markMatch[1] as string);
  }
  return parseAccountIdentification(line.replace(/^\//, ''));
}

/** Option F: numbered lines carrying an explicitly typed party. */
function resolveStructured(
  field: MtField,
  lines: readonly string[],
  accountFromSlash: AccountIdentification | undefined,
  kind: PartyKind,
  diagnostics: DiagnosticCollector,
  startingConfidence: number,
): SemanticParty {
  let confidence = startingConfidence;
  let account = accountFromSlash;
  const identifiers: PartyIdentifier[] = [];
  const addressLines: string[] = [];
  const additionalInfo: string[] = [];
  let name: string | undefined;
  let country: string | undefined;
  let town: string | undefined;
  let birthDate: string | undefined;
  let birthPlace: { country?: string; city?: string } | undefined;

  const body = [...lines];

  // When the field did not open with `/`, line 1 is a coded party identifier
  // such as `NIDN/DE/121231234342`.
  if (!account && body.length > 0) {
    const first = body[0] as string;
    const coded = /^([A-Z]{4})\/([A-Z]{2})\/(.+)$/.exec(first.trim());
    if (coded && IDENTIFIER_CODES.has(coded[1] as string)) {
      identifiers.push({
        code: coded[1] as string,
        country: coded[2] as string,
        value: coded[3] as string,
      });
      body.shift();
    }
  }

  for (const rawLine of body) {
    const line = rawLine.trim();
    if (line === '') continue;
    const match = /^([1-8])\/(.*)$/.exec(line);
    if (!match) {
      confidence -= 0.05;
      diagnostics.warn({
        code: 'MT.PARTY.UNNUMBERED_LINE',
        mtTag: field.tag,
        message: `Option F line '${truncate(line, 30)}' is not prefixed with a 1-8 line code; treated as an address line.`,
      });
      addressLines.push(line);
      continue;
    }

    const code = match[1] as string;
    const value = (match[2] as string).trim();

    switch (LINE_CODE_MEANING[code]) {
      case 'name':
        name = name ? `${name} ${value}` : value;
        break;
      case 'address':
        addressLines.push(value);
        break;
      case 'country-and-town': {
        const split = /^([A-Z]{2})\/(.*)$/.exec(value);
        if (split) {
          country = resolveCountry(split[1] as string) ?? (split[1] as string);
          town = (split[2] as string).trim();
        } else {
          country = resolveCountry(value);
          if (!country) addressLines.push(value);
        }
        break;
      }
      case 'date-of-birth': {
        const iso = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
        if (iso) {
          birthDate = `${iso[1]}-${iso[2]}-${iso[3]}`;
        } else {
          diagnostics.warn({
            code: 'MT.PARTY.BIRTH_DATE',
            mtTag: field.tag,
            message: `Date of birth '${value}' is not in YYYYMMDD form; it is dropped.`,
          });
          confidence -= 0.05;
        }
        break;
      }
      case 'place-of-birth': {
        const split = /^([A-Z]{2})\/(.*)$/.exec(value);
        birthPlace = split
          ? { country: split[1] as string, city: (split[2] as string).trim() }
          : { city: value };
        break;
      }
      case 'customer-identification':
      case 'national-identity': {
        const split = /^([A-Z]{2})\/(.*)$/.exec(value);
        identifiers.push({
          code: code === '6' ? 'CUST' : 'NIDN',
          ...(split ? { country: split[1] as string } : {}),
          value: split ? (split[2] as string).trim() : value,
        });
        break;
      }
      case 'additional-information':
        additionalInfo.push(value);
        break;
      default:
        addressLines.push(value);
    }
  }

  if (!name) {
    confidence -= 0.2;
    diagnostics.warn({
      code: 'MT.PARTY.NO_NAME',
      mtTag: field.tag,
      message: `Structured party ${field.tag} has no name line (code 1).`,
    });
  }

  return finish({
    sourceTag: field.tag,
    option: 'F',
    kind,
    ...(name ? { name } : {}),
    addressLines,
    ...(country ? { country } : {}),
    ...(town ? { town } : {}),
    ...(account ? { account } : {}),
    ...(birthDate ? { birthDate } : {}),
    ...(birthPlace ? { birthPlace } : {}),
    identifiers,
    additionalInfo,
    structured: true,
    confidence,
    diagnostics,
  });
}

export interface Geography {
  readonly country?: string;
  readonly town?: string;
  readonly postCode?: string;
}

/**
 * Lift a country (and, when it can be told apart, a town and post code) out of
 * an unstructured address block. ISO 20022 wants `PstlAdr/Ctry` as an alpha-2
 * code, and MT carries it as whatever the sender typed.
 */
export function inferGeography(addressLines: readonly string[]): Geography {
  if (addressLines.length === 0) return {};
  const last = (addressLines[addressLines.length - 1] as string).trim();

  const segments = last.split(/\s*[,/]\s*/).filter((s) => s !== '');
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const country = resolveCountry(segments[i] as string);
    if (!country) continue;

    const before = segments.slice(0, i).join(', ');
    const postCodeMatch = /^([A-Z]{0,2}[\d][\dA-Z \-]{2,9})\s+(.*)$/.exec(before);
    return {
      country,
      ...(postCodeMatch
        ? { postCode: (postCodeMatch[1] as string).trim(), town: (postCodeMatch[2] as string).trim() }
        : before
          ? { town: before }
          : {}),
    };
  }

  // A trailing bare country code with no separator, e.g. "BERLIN DE".
  const words = last.split(/\s+/);
  const tail = words[words.length - 1] as string;
  if (words.length > 1) {
    const country = resolveCountry(tail);
    if (country) {
      return { country, town: words.slice(0, -1).join(' ') };
    }
  }
  return {};
}

interface PartyDraft extends Omit<SemanticParty, 'diagnostics' | 'empty'> {
  diagnostics: DiagnosticCollector;
}

function finish(draft: PartyDraft): SemanticParty {
  const empty =
    !draft.bic &&
    !draft.name &&
    draft.addressLines.length === 0 &&
    !draft.account &&
    !draft.location &&
    draft.identifiers.length === 0;
  return {
    ...draft,
    empty,
    diagnostics: draft.diagnostics.all(),
    confidence: clamp(draft.confidence),
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
