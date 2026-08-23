import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMt } from '../src/mt/parser.js';
import { validateMt } from '../src/validation/mt-rules.js';
import { validateMx } from '../src/validation/mx-rules.js';
import { validateBic, toBic11, toBic8, bicCountry } from '../src/validation/bic.js';
import { validateIban, looksLikeIban, normaliseIban } from '../src/validation/iban.js';
import { el, elA } from '../src/mx/xml.js';

const codes = (raw: string, type?: string): string[] =>
  validateMt(parseMt(raw).message, type).diagnostics.map((d) => d.code);

describe('BIC validation', () => {
  it('accepts 8 and 11 character BICs', () => {
    assert.equal(validateBic('DEUTDEFF').valid, true);
    assert.equal(validateBic('DEUTDEFFXXX').valid, true);
  });

  it('rejects a bad length, a bad country and a bad shape', () => {
    assert.match(validateBic('DEUTDE').reason ?? '', /8 or 11/);
    assert.match(validateBic('DEUTZZFF').reason ?? '', /country code/);
    assert.match(validateBic('DE1TDEFF').reason ?? '', /malformed/);
  });

  it('flags a test and training BIC', () => {
    assert.equal(validateBic('DEUTDEF0').test, true);
  });

  it('converts between BIC8 and BIC11', () => {
    assert.equal(toBic11('DEUTDEFF'), 'DEUTDEFFXXX');
    assert.equal(toBic8('DEUTDEFFXXX'), 'DEUTDEFF');
    assert.equal(toBic8('DEUTDEFF123'), 'DEUTDEFF123');
    assert.equal(bicCountry('DEUTDEFFXXX'), 'DE');
  });
});

describe('IBAN validation', () => {
  it('accepts registry IBANs that pass the checksum', () => {
    for (const iban of [
      'GB82WEST12345698765432',
      'DE89370400440532013000',
      'FR1420041010050500013M02606',
      'BE68539007547034',
      'NL91ABNA0417164300',
    ]) {
      assert.equal(validateIban(iban).valid, true, iban);
    }
  });

  it('rejects a failed checksum', () => {
    assert.match(validateIban('GB82WEST12345698765431').reason ?? '', /checksum/);
  });

  it('rejects a wrong length for the country', () => {
    assert.match(validateIban('DE8937040044053201300').reason ?? '', /length/);
  });

  it('rejects countries outside the IBAN registry even when the checksum passes', () => {
    const result = validateIban('US64SVBKUS6S3300958879');
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /IBAN registry/);
    assert.equal(looksLikeIban('US64SVBKUS6S3300958879'), false);
  });

  it('ignores spaces and hyphens', () => {
    assert.equal(normaliseIban('BE68 5390 0754 7034'), 'BE68539007547034');
    assert.equal(validateIban('BE68 5390 0754 7034').valid, true);
  });
});

describe('MT network rules', () => {
  const base = (extra: string) =>
    `{1:F01BANKBEBBAXXX0000000000}{2:I103DEUTDEFFXXXXN}{4:\n:20:REF\n:23B:CRED\n:32A:240115EUR100,00\n:50K:A\n:59:B\n:71A:SHA\n${extra}-}`;

  it('accepts a well formed MT103', () => {
    const result = codes(base(''));
    assert.equal(result.filter((c) => c.startsWith('MT.RULE')).length, 0);
  });

  it('C1: a currency change needs an exchange rate', () => {
    assert.ok(codes(base(':33B:USD120,00\n')).includes('MT.RULE.C1'));
    assert.ok(!codes(base(':33B:USD120,00\n:36:1,2\n')).includes('MT.RULE.C1'));
  });

  it('C1: the same currency forbids an exchange rate', () => {
    assert.ok(codes(base(':33B:EUR100,00\n:36:1,0\n')).includes('MT.RULE.C1'));
  });

  it('C2: charge bearer OUR forbids senders charges', () => {
    const raw = base(':71F:EUR5,00\n:33B:EUR100,00\n').replace(':71A:SHA', ':71A:OUR');
    assert.ok(codes(raw).includes('MT.RULE.C2'));
  });

  it('C2: charge bearer BEN requires senders charges', () => {
    assert.ok(codes(base('').replace(':71A:SHA', ':71A:BEN')).includes('MT.RULE.C2'));
  });

  it('C3: charges require the instructed amount', () => {
    const raw = base(':71F:EUR5,00\n').replace(':71A:SHA', ':71A:BEN');
    assert.ok(codes(raw).includes('MT.RULE.C3'));
  });

  it('C13: SPRI restricts the instruction codes', () => {
    const raw = base(':23E:CHQB\n').replace(':23B:CRED', ':23B:SPRI');
    assert.ok(codes(raw).includes('MT.RULE.C13'));
  });

  it('C14: a service level forbids an intermediary', () => {
    const raw = base(':56A:DEUTDEFFXXX\n').replace(':23B:CRED', ':23B:SPRI');
    assert.ok(codes(raw).includes('MT.RULE.C14'));
  });

  it('T26: a reference may not be wrapped in slashes', () => {
    assert.ok(codes(base('').replace(':20:REF', ':20:/REF/')).includes('MT.RULE.T26'));
  });

  it('T27: only party fields carry a BIC in option A', () => {
    // 32A and 71A must not be mistaken for identifier code fields.
    assert.ok(!codes(base('')).includes('MT.RULE.T27'));
    assert.ok(codes(base(':52A:NOTABIC\n')).includes('MT.RULE.T27'));
  });

  it('checks field 23B against the published bank operation codes', () => {
    assert.ok(codes(base('').replace(':23B:CRED', ':23B:XXXX')).includes('MT.CODE.UNKNOWN_23B'));
    assert.ok(!codes(base('')).includes('MT.CODE.UNKNOWN_23B'));
  });

  it('C03: an amount may not exceed the currency scale', () => {
    assert.ok(codes(base('').replace('EUR100,00', 'EUR100,005')).includes('MT.RULE.C03'));
  });

  it('reports a missing mandatory field', () => {
    const raw = '{1:F01BANKBEBBAXXX0000000000}{2:I103DEUTDEFFXXXXN}{4:\n:20:REF\n-}';
    assert.ok(codes(raw).includes('MT.SCHEMA.MISSING_MANDATORY'));
  });

  it('reports a field the message definition does not allow', () => {
    assert.ok(codes(base(':28C:1/1\n')).includes('MT.SCHEMA.UNEXPECTED_FIELD'));
  });

  it('checks that MT940 balances share one currency', () => {
    const raw = `{1:F01BANKBEBBAXXX0000000000}{2:I940BANKBEBBXXXXN}{4:
:20:S
:25:ACC
:28C:1/1
:60F:C240114EUR10,00
:62F:C240115USD10,00
-}`;
    assert.ok(codes(raw).includes('MT.RULE.C1'));
  });
});

describe('MX structural validation', () => {
  it('reports a value that is too long for its element', () => {
    const root = el('FIToFICstmrCdtTrf', el('GrpHdr', el('MsgId', 'X'.repeat(40))));
    const codes = validateMx(root, 'pacs.008.001.08').diagnostics.map((d) => d.code);
    assert.ok(codes.includes('MX.VALUE_TOO_LONG'));
  });

  it('reports a malformed date and date-time', () => {
    const root = el(
      'FIToFICstmrCdtTrf',
      el('GrpHdr', el('CreDtTm', '15/01/2024')),
      el('CdtTrfTxInf', el('IntrBkSttlmDt', '15-01-2024')),
    );
    const diagnostics = validateMx(root, 'pacs.008.001.08').diagnostics;
    assert.equal(diagnostics.filter((d) => d.code === 'MX.VALUE_FORMAT').length, 2);
  });

  it('checks the currency and scale of an amount', () => {
    const root = el(
      'FIToFICstmrCdtTrf',
      el('CdtTrfTxInf', elA('IntrBkSttlmAmt', { Ccy: 'JPY' }, '100.50')),
    );
    const codes = validateMx(root, 'pacs.008.001.08').diagnostics.map((d) => d.code);
    assert.ok(codes.includes('MX.AMOUNT_DECIMALS'));
  });

  it('reports an amount with no currency attribute', () => {
    const root = el('FIToFICstmrCdtTrf', el('CdtTrfTxInf', el('IntrBkSttlmAmt', '100.00')));
    const codes = validateMx(root, 'pacs.008.001.08').diagnostics.map((d) => d.code);
    assert.ok(codes.includes('MX.AMOUNT_NO_CURRENCY'));
  });

  it('reports mandatory paths the mapper did not produce', () => {
    const root = el('FIToFICstmrCdtTrf', el('GrpHdr', el('MsgId', 'REF')));
    const missing = validateMx(root, 'pacs.008.001.08').diagnostics.filter(
      (d) => d.code === 'MX.MISSING_MANDATORY',
    );
    assert.ok(missing.some((d) => d.mxPath === 'CdtTrfTxInf/IntrBkSttlmAmt'));
  });

  it('rejects a country code that is not in ISO 3166', () => {
    const root = el('FIToFICstmrCdtTrf', el('CdtTrfTxInf', el('Dbtr', el('PstlAdr', el('Ctry', 'ZZ')))));
    const codes = validateMx(root, 'pacs.008.001.08').diagnostics.map((d) => d.code);
    assert.ok(codes.includes('MX.COUNTRY_UNKNOWN'));
  });

  it('validates a BIC carried in the document', () => {
    const root = el('FinInstnCdtTrf', el('CdtTrfTxInf', el('InstgAgt', el('FinInstnId', el('BICFI', 'NOTABIC')))));
    const codes = validateMx(root, 'pacs.009.001.08').diagnostics.map((d) => d.code);
    assert.ok(codes.includes('MX.VALUE_FORMAT'));
  });
});
