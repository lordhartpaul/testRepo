import { DiagnosticCollector, type Diagnostic } from '../core/diagnostics.js';
import { isKnownCurrency, minorUnits } from '../reference/currencies.js';
import { isCountryCode } from '../reference/countries.js';
import { find, textOf, walk, type XmlElement } from '../mx/xml.js';
import { validateBic } from './bic.js';
import { validateIban } from './iban.js';

/**
 * MX side validation.
 *
 * There is no XSD in this package (the ISO 20022 schemas are not redistributed),
 * so validation is rule based: element level datatype and length checks driven
 * by the table below, plus a required-path list per message definition. That
 * catches the failures a translation layer actually produces - a value too long
 * for its element, a malformed date, a missing mandatory branch - without
 * pulling in a schema processor.
 */

type ElementKind = 'text' | 'date' | 'dateTime' | 'time' | 'decimal' | 'bic' | 'iban' | 'code' | 'count';

interface ElementRule {
  readonly kind: ElementKind;
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly pattern?: RegExp;
}

/** Datatype rules keyed by element name, applied wherever the element appears. */
const ELEMENT_RULES: Readonly<Record<string, ElementRule>> = Object.freeze({
  MsgId: { kind: 'text', maxLength: 35, minLength: 1 },
  InstrId: { kind: 'text', maxLength: 35, minLength: 1 },
  EndToEndId: { kind: 'text', maxLength: 35, minLength: 1 },
  TxId: { kind: 'text', maxLength: 35 },
  UETR: { kind: 'code', pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/ },
  BizMsgIdr: { kind: 'text', maxLength: 35, minLength: 1 },
  MsgDefIdr: { kind: 'text', maxLength: 35, minLength: 1 },
  BizSvc: { kind: 'text', maxLength: 35 },
  CreDt: { kind: 'dateTime' },
  CreDtTm: { kind: 'dateTime' },
  OrgnlCreDtTm: { kind: 'dateTime' },
  IntrBkSttlmDt: { kind: 'date' },
  OrgnlIntrBkSttlmDt: { kind: 'date' },
  XpctdValDt: { kind: 'date' },
  BirthDt: { kind: 'date' },
  DbtDtTm: { kind: 'dateTime' },
  CdtDtTm: { kind: 'dateTime' },
  FrDtTm: { kind: 'dateTime' },
  CLSTm: { kind: 'time' },
  TillTm: { kind: 'time' },
  FrTm: { kind: 'time' },
  RjctTm: { kind: 'time' },
  BICFI: { kind: 'bic' },
  AnyBIC: { kind: 'bic' },
  IBAN: { kind: 'iban' },
  Nm: { kind: 'text', maxLength: 140, minLength: 1 },
  AdrLine: { kind: 'text', maxLength: 70, minLength: 1 },
  StrtNm: { kind: 'text', maxLength: 70 },
  TwnNm: { kind: 'text', maxLength: 35 },
  PstCd: { kind: 'text', maxLength: 16 },
  Ctry: { kind: 'code', pattern: /^[A-Z]{2}$/ },
  CtryOfRes: { kind: 'code', pattern: /^[A-Z]{2}$/ },
  CtryOfBirth: { kind: 'code', pattern: /^[A-Z]{2}$/ },
  CityOfBirth: { kind: 'text', maxLength: 35 },
  MmbId: { kind: 'text', maxLength: 35, minLength: 1 },
  Ustrd: { kind: 'text', maxLength: 140, minLength: 1 },
  AddtlInf: { kind: 'text', maxLength: 105 },
  AddtlTxInf: { kind: 'text', maxLength: 500 },
  AddtlNtryInf: { kind: 'text', maxLength: 500 },
  AddtlStmtInf: { kind: 'text', maxLength: 500 },
  AddtlRptInf: { kind: 'text', maxLength: 500 },
  InstrInf: { kind: 'text', maxLength: 140, minLength: 1 },
  Ref: { kind: 'text', maxLength: 35 },
  Id: { kind: 'text', maxLength: 35, minLength: 1 },
  NbOfTxs: { kind: 'count' },
  NbOfNtries: { kind: 'count' },
  XchgRate: { kind: 'decimal' },
  Sum: { kind: 'decimal' },
  ChrgBr: { kind: 'code', pattern: /^(DEBT|CRED|SHAR|SLEV)$/ },
  CdtDbtInd: { kind: 'code', pattern: /^(CRDT|DBIT)$/ },
  SttlmMtd: { kind: 'code', pattern: /^(INDA|INGA|COVE|CLRG)$/ },
  ClrChanl: { kind: 'code', pattern: /^(RTGS|RTNS|MPNS|BOOK)$/ },
});

/** Elements carrying an amount, which must also have a valid `Ccy` attribute. */
const AMOUNT_ELEMENTS = new Set([
  'IntrBkSttlmAmt', 'InstdAmt', 'Amt', 'OrgnlIntrBkSttlmAmt', 'OrgnlInstdAmt', 'TtlAmt',
]);

/** Mandatory paths per message definition, relative to the message root. */
const REQUIRED_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'pacs.008.001.08': [
    'GrpHdr/MsgId',
    'GrpHdr/CreDtTm',
    'GrpHdr/NbOfTxs',
    'GrpHdr/SttlmInf/SttlmMtd',
    'CdtTrfTxInf/PmtId/EndToEndId',
    'CdtTrfTxInf/IntrBkSttlmAmt',
    'CdtTrfTxInf/ChrgBr',
    'CdtTrfTxInf/Dbtr',
    'CdtTrfTxInf/Cdtr',
  ],
  'pacs.009.001.08': [
    'GrpHdr/MsgId',
    'GrpHdr/CreDtTm',
    'GrpHdr/NbOfTxs',
    'GrpHdr/SttlmInf/SttlmMtd',
    'CdtTrfTxInf/PmtId/EndToEndId',
    'CdtTrfTxInf/IntrBkSttlmAmt',
    'CdtTrfTxInf/Dbtr',
    'CdtTrfTxInf/Cdtr',
  ],
  'camt.052.001.08': ['GrpHdr/MsgId', 'GrpHdr/CreDtTm', 'Rpt/Id', 'Rpt/Acct'],
  'camt.053.001.08': ['GrpHdr/MsgId', 'GrpHdr/CreDtTm', 'Stmt/Id', 'Stmt/Acct', 'Stmt/Bal'],
  'camt.054.001.08': ['GrpHdr/MsgId', 'GrpHdr/CreDtTm', 'Ntfctn/Id'],
  'camt.056.001.08': ['Assgnmt/Id', 'Assgnmt/CreDtTm', 'Undrlyg'],
  'camt.057.001.06': ['GrpHdr/MsgId', 'GrpHdr/CreDtTm', 'Ntfctn/Id', 'Ntfctn/Itm'],
  'camt.029.001.09': ['Assgnmt/Id', 'Assgnmt/CreDtTm', 'Sts'],
});

export interface MxValidationResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly elementsChecked: number;
}

/**
 * Validate a generated message body.
 *
 * `root` is the message root (`FIToFICstmrCdtTrf`, `BkToCstmrStmt`, ...) rather
 * than the `Document` wrapper, so paths line up with the ISO documentation.
 */
export function validateMx(root: XmlElement, mxId: string): MxValidationResult {
  const diagnostics = new DiagnosticCollector();
  let elementsChecked = 0;

  walk(root, (element, path) => {
    elementsChecked += 1;
    const relative = path.slice(root.name.length + 1) || root.name;

    if (AMOUNT_ELEMENTS.has(element.name)) {
      validateAmount(element, relative, diagnostics);
    }

    const rule = ELEMENT_RULES[element.name];
    if (!rule) return;
    const hasElementChildren = element.children.some((child) => typeof child !== 'string');
    if (hasElementChildren) return; // a container that happens to share a name

    validateValue(textOf(element), rule, element.name, relative, diagnostics);
  });

  diagnostics.absorb(validateCountries(root));

  for (const required of REQUIRED_PATHS[mxId] ?? []) {
    if (!find(root, required)) {
      diagnostics.error({
        code: 'MX.MISSING_MANDATORY',
        mxPath: required,
        message: `${mxId} requires ${required}, which the conversion did not produce.`,
      });
    }
  }

  return { diagnostics: diagnostics.all(), elementsChecked };
}

function validateValue(
  value: string,
  rule: ElementRule,
  elementName: string,
  path: string,
  diagnostics: DiagnosticCollector,
): void {
  if (rule.minLength !== undefined && value.trim().length < rule.minLength) {
    diagnostics.error({
      code: 'MX.VALUE_EMPTY',
      mxPath: path,
      message: `${elementName} must not be empty.`,
    });
    return;
  }
  if (rule.maxLength !== undefined && value.length > rule.maxLength) {
    diagnostics.error({
      code: 'MX.VALUE_TOO_LONG',
      mxPath: path,
      message: `${elementName} is ${value.length} characters, the limit is ${rule.maxLength}.`,
      hint: 'The source value has to be shortened or carried elsewhere.',
    });
  }

  switch (rule.kind) {
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        diagnostics.error({
          code: 'MX.VALUE_FORMAT',
          mxPath: path,
          message: `${elementName} '${value}' is not an ISO date (YYYY-MM-DD).`,
        });
      }
      break;
    case 'dateTime':
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value)) {
        diagnostics.error({
          code: 'MX.VALUE_FORMAT',
          mxPath: path,
          message: `${elementName} '${value}' is not an ISO date and time.`,
        });
      }
      break;
    case 'time':
      if (!/^\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(value)) {
        diagnostics.error({
          code: 'MX.VALUE_FORMAT',
          mxPath: path,
          message: `${elementName} '${value}' is not an ISO time.`,
        });
      }
      break;
    case 'decimal':
      if (!/^-?\d+(\.\d+)?$/.test(value)) {
        diagnostics.error({
          code: 'MX.VALUE_FORMAT',
          mxPath: path,
          message: `${elementName} '${value}' is not a decimal number.`,
        });
      }
      break;
    case 'count':
      if (!/^\d+$/.test(value)) {
        diagnostics.error({
          code: 'MX.VALUE_FORMAT',
          mxPath: path,
          message: `${elementName} '${value}' is not a whole number.`,
        });
      }
      break;
    case 'bic': {
      const check = validateBic(value);
      if (!check.valid) {
        diagnostics.error({
          code: 'MX.VALUE_FORMAT',
          mxPath: path,
          message: `${elementName} '${value}' is not a valid BIC: ${check.reason ?? 'malformed'}.`,
        });
      }
      break;
    }
    case 'iban': {
      const check = validateIban(value);
      if (!check.valid) {
        diagnostics.error({
          code: 'MX.VALUE_FORMAT',
          mxPath: path,
          message: `${elementName} '${value}' is not a valid IBAN: ${check.reason ?? 'malformed'}.`,
        });
      }
      break;
    }
    case 'code':
      if (rule.pattern && !rule.pattern.test(value)) {
        diagnostics.error({
          code: 'MX.VALUE_FORMAT',
          mxPath: path,
          message: `${elementName} '${value}' does not match ${rule.pattern.source}.`,
        });
      }
      break;
    case 'text':
      if (value.trim() !== value) {
        diagnostics.warn({
          code: 'MX.VALUE_WHITESPACE',
          mxPath: path,
          message: `${elementName} has leading or trailing whitespace, which the ISO 20022 text types forbid.`,
        });
      }
      break;
  }
}

/** An amount element needs a valid currency and the right number of decimals. */
function validateAmount(element: XmlElement, path: string, diagnostics: DiagnosticCollector): void {
  const value = textOf(element);
  const currency = element.attributes['Ccy'];

  if (!currency) {
    diagnostics.error({
      code: 'MX.AMOUNT_NO_CURRENCY',
      mxPath: path,
      message: `${element.name} has no Ccy attribute.`,
    });
    return;
  }
  if (!isKnownCurrency(currency)) {
    diagnostics.error({
      code: 'MX.AMOUNT_CURRENCY',
      mxPath: path,
      message: `'${currency}' is not an active ISO 4217 currency code.`,
    });
    return;
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    diagnostics.error({
      code: 'MX.AMOUNT_FORMAT',
      mxPath: path,
      message: `${element.name} '${value}' is not a positive decimal.`,
    });
    return;
  }

  const decimals = value.includes('.') ? (value.split('.')[1] as string).length : 0;
  const allowed = minorUnits(currency);
  if (allowed !== null && allowed !== undefined && decimals > allowed) {
    diagnostics.error({
      code: 'MX.AMOUNT_DECIMALS',
      mxPath: path,
      message: `${currency} allows ${allowed} decimal(s) but ${element.name} carries ${decimals}.`,
    });
  }
}

/** Country codes referenced anywhere in the document must be real ISO 3166 codes. */
function validateCountries(root: XmlElement): Diagnostic[] {
  const diagnostics = new DiagnosticCollector();
  walk(root, (element, path) => {
    if (element.name !== 'Ctry' && element.name !== 'CtryOfRes') return;
    const value = textOf(element);
    if (!isCountryCode(value)) {
      diagnostics.error({
        code: 'MX.COUNTRY_UNKNOWN',
        mxPath: path,
        message: `'${value}' is not an ISO 3166-1 alpha-2 country code.`,
      });
    }
  });
  return [...diagnostics.all()];
}
