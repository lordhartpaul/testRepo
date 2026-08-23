import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMt } from '../src/mt/parser.js';
import { field } from '../src/mt/message.js';
import { inferGeography, resolveParty } from '../src/semantic/party.js';
import { parseAccountIdentification, describeAccount } from '../src/semantic/account.js';
import { addDecimals, parseCurrencyAmount, parseValueDateAmount, normaliseScale } from '../src/semantic/amount.js';
import { parseDate6, parseTime4, resolveTwoDigitYear } from '../src/semantic/dates.js';
import { parseNarrative, parseRegulatoryReporting } from '../src/semantic/codes.js';
import { parseBalance, parseStatementLine, creditDebitIndicator } from '../src/semantic/statement.js';

function partyFrom(raw: string, tag: string, kind: 'customer' | 'institution' = 'customer') {
  const { message } = parseMt(raw);
  const found = field(message, tag);
  assert.ok(found, `field ${tag} not found`);
  return resolveParty(found, { kind });
}

describe('party resolution', () => {
  it('reads option A as a BIC with an optional account', () => {
    const party = partyFrom(':52A:/D/12345\nDEUTDEFFXXX\n', '52A', 'institution');
    assert.equal(party.bic, 'DEUTDEFFXXX');
    assert.equal(party.account?.other, '12345');
    assert.equal(party.account?.mark, 'D');
    assert.equal(party.confidence, 1);
  });

  it('expands a BIC8 to a BIC11', () => {
    assert.equal(partyFrom(':57A:DEUTDEFF\n', '57A', 'institution').bic, 'DEUTDEFFXXX');
  });

  it('splits a name and address block and infers the country', () => {
    const party = partyFrom(
      ':59:/DE89370400440532013000\nMUELLER GMBH\nHAUPTSTRASSE 12\n10115 BERLIN, GERMANY\n',
      '59',
    );
    assert.equal(party.name, 'MUELLER GMBH');
    assert.deepEqual(party.addressLines, ['HAUPTSTRASSE 12', '10115 BERLIN, GERMANY']);
    assert.equal(party.country, 'DE');
    assert.equal(party.account?.iban, 'DE89370400440532013000');
    assert.equal(party.account?.ibanValid, true);
  });

  it('reads the numbered lines of option F, including the date of birth', () => {
    const party = partyFrom(
      ':50F:/12345678\n1/SMITH JOHN\n3/US/SAN FRANCISCO\n4/19800315\n5/US/BOSTON\n',
      '50F',
    );
    assert.equal(party.structured, true);
    assert.equal(party.name, 'SMITH JOHN');
    assert.equal(party.country, 'US');
    assert.equal(party.town, 'SAN FRANCISCO');
    assert.equal(party.birthDate, '1980-03-15');
    assert.deepEqual(party.birthPlace, { country: 'US', city: 'BOSTON' });
  });

  it('reads a coded party identifier in option F', () => {
    const party = partyFrom(':50F:NIDN/DE/121231234342\n1/MUELLER HANS\n', '50F');
    assert.deepEqual(party.identifiers, [
      { code: 'NIDN', country: 'DE', value: '121231234342' },
    ]);
  });

  it('recognises a BIC that was put in a name and address option', () => {
    const party = partyFrom(':57D:DEUTDEFFXXX\n', '57D', 'institution');
    assert.equal(party.bic, 'DEUTDEFFXXX');
    assert.ok(party.diagnostics.some((d) => d.code === 'MT.PARTY.BIC_IN_NAME_OPTION'));
  });

  it('warns rather than fails when option A carries only a clearing code', () => {
    const party = partyFrom(':57A://FW021000021\n', '57A', 'institution');
    assert.equal(party.account?.clearing?.isoCode, 'USABA');
    assert.equal(party.account?.clearing?.memberId, '021000021');
    assert.ok(party.diagnostics.some((d) => d.code === 'MT.PARTY.BIC_ABSENT' && d.severity === 'warning'));
  });

  it('flags an IBAN that fails its checksum', () => {
    const party = partyFrom(':59:/DE89370400440532013001\nSOMEONE\n', '59');
    assert.equal(party.account?.ibanValid, false);
    assert.ok(party.diagnostics.some((d) => d.code === 'MT.PARTY.IBAN_INVALID'));
  });
});

describe('party identifier lines', () => {
  it('maps national clearing prefixes to ISO codes', () => {
    assert.equal(parseAccountIdentification('/SC401234')?.clearing?.isoCode, 'GBDSC');
    assert.equal(parseAccountIdentification('/BL12345678')?.clearing?.isoCode, 'DEBLZ');
    assert.equal(parseAccountIdentification('/CP0002')?.clearing?.isoCode, 'USPID');
  });

  it('checks the member id against the scheme shape', () => {
    assert.equal(parseAccountIdentification('/FW021000021')?.clearing?.memberIdPlausible, true);
    assert.equal(parseAccountIdentification('/FW21')?.clearing?.memberIdPlausible, false);
  });

  it('recognises an RTGS routing instruction', () => {
    assert.equal(parseAccountIdentification('/RT')?.rtgs, true);
  });

  it('keeps an unknown clearing prefix as a proprietary account', () => {
    const account = parseAccountIdentification('/ZZ12345');
    assert.equal(account?.unknownClearingPrefix, 'ZZ');
    assert.equal(account?.other, 'ZZ12345');
  });

  it('describes an account for diagnostics', () => {
    assert.equal(describeAccount(parseAccountIdentification('BE68539007547034')), 'IBAN BE68539007547034');
    assert.equal(describeAccount(undefined), '(none)');
  });
});

describe('geography inference', () => {
  it('reads a country name at the end of the last line', () => {
    assert.deepEqual(inferGeography(['1 MAIN ST', 'BERLIN, GERMANY']), {
      country: 'DE',
      town: 'BERLIN',
    });
  });

  it('reads a post code before the town', () => {
    assert.deepEqual(inferGeography(['10115 BERLIN, DE']), {
      country: 'DE',
      postCode: '10115',
      town: 'BERLIN',
    });
  });

  it('reads a trailing country code with no separator', () => {
    assert.deepEqual(inferGeography(['PARIS FR']), { country: 'FR', town: 'PARIS' });
  });

  it('returns nothing when no country can be told apart', () => {
    assert.deepEqual(inferGeography(['SOME STREET 1']), {});
  });
});

describe('amounts', () => {
  it('converts the SWIFT decimal comma to a point', () => {
    const amount = parseCurrencyAmount('EUR1234,56');
    assert.equal(amount.valid, true);
    assert.equal(amount.value, '1234.56');
    assert.equal(amount.decimals, 2);
  });

  it('rejects more decimals than the currency allows', () => {
    assert.equal(parseCurrencyAmount('JPY100,50').valid, false);
    assert.equal(parseCurrencyAmount('JPY100,').valid, true);
    assert.equal(parseCurrencyAmount('KWD1,234').valid, true);
    assert.equal(parseCurrencyAmount('EUR1,234').valid, false);
  });

  it('rejects an unknown currency', () => {
    const amount = parseCurrencyAmount('XYZ100,00');
    assert.equal(amount.valid, false);
    assert.match(amount.problem ?? '', /ISO 4217/);
  });

  it('splits the value date from the amount in field 32A', () => {
    const parsed = parseValueDateAmount('240115EUR1234,56');
    assert.equal(parsed.date6, '240115');
    assert.equal(parsed.amount.value, '1234.56');
  });

  it('adds decimals without binary float error', () => {
    assert.equal(addDecimals('0.1', '0.2', 2), '0.30');
    assert.equal(addDecimals('1500.00', '250.50', 2), '1750.50');
    assert.equal(addDecimals('100', '200', 0), '300');
  });

  it('pads an amount to the scale of its currency', () => {
    assert.equal(normaliseScale('12.5', 'EUR'), '12.50');
    assert.equal(normaliseScale('12.5', 'JPY'), '12');
  });
});

describe('dates', () => {
  it('places a two digit year in the nearest century', () => {
    assert.equal(resolveTwoDigitYear(24, { referenceYear: 2024 }), 2024);
    assert.equal(resolveTwoDigitYear(98, { referenceYear: 2024 }), 1998);
    assert.equal(resolveTwoDigitYear(45, { referenceYear: 2024 }), 2045);
  });

  it('rejects a date that is not a real day', () => {
    assert.equal(parseDate6('240115', { referenceYear: 2024 }), '2024-01-15');
    assert.equal(parseDate6('240230', { referenceYear: 2024 }), undefined);
    assert.equal(parseDate6('241301', { referenceYear: 2024 }), undefined);
  });

  it('parses a four digit time', () => {
    assert.equal(parseTime4('1230'), '12:30:00');
    assert.equal(parseTime4('2460'), undefined);
  });
});

describe('narrative code words', () => {
  it('groups continuation lines into their code word entry', () => {
    const entries = parseNarrative(['/ACC/ADVISE BENEFICIARY', '//BY TELEPHONE', '/INS/DEUTDEFF']);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.code, 'ACC');
    assert.equal(entries[0]?.text, 'ADVISE BENEFICIARY BY TELEPHONE');
    assert.equal(entries[1]?.bic, 'DEUTDEFFXXX');
  });

  it('keeps uncoded narrative as a single entry', () => {
    const entries = parseNarrative(['FREE TEXT', 'SECOND LINE']);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.code, undefined);
  });

  it('parses regulatory reporting with its country', () => {
    const reports = parseRegulatoryReporting(['/ORDERRES/BE//MEILAAN 1, 9000 GENT']);
    assert.equal(reports[0]?.code, 'ORDERRES');
    assert.equal(reports[0]?.country, 'BE');
    assert.deepEqual(reports[0]?.details, ['MEILAAN 1, 9000 GENT']);
  });
});

describe('statement lines', () => {
  it('scans a full field 61', () => {
    const line = parseStatementLine('2401150115C1500,00NTRFREF12345//SERV6789\nEXTRA DETAIL', {
      referenceYear: 2024,
    });
    assert.equal(line.valueDate, '2024-01-15');
    assert.equal(line.entryDate, '2024-01-15');
    assert.equal(line.mark, 'C');
    assert.equal(line.amount, '1500.00');
    assert.equal(line.transactionType, 'NTRF');
    assert.equal(line.ownerReference, 'REF12345');
    assert.equal(line.servicingReference, 'SERV6789');
    assert.equal(line.supplementaryDetails, 'EXTRA DETAIL');
    assert.deepEqual(line.problems, []);
  });

  it('recognises a reversal', () => {
    const line = parseStatementLine('240115RD250,50NCHGFEE', { referenceYear: 2024 });
    assert.equal(line.mark, 'RD');
    assert.equal(line.reversal, true);
    assert.equal(creditDebitIndicator(line.mark), 'DBIT');
  });

  it('reads a funds code between the mark and the amount', () => {
    const line = parseStatementLine('240115CD1500,00NTRFREF', { referenceYear: 2024 });
    assert.equal(line.mark, 'C');
    assert.equal(line.fundsCode, 'D');
    assert.equal(line.amount, '1500.00');
  });

  it('moves an entry date across a year boundary', () => {
    const line = parseStatementLine('2401021231C10,00NTRFREF', { referenceYear: 2024 });
    assert.equal(line.valueDate, '2024-01-02');
    assert.equal(line.entryDate, '2023-12-31');
  });

  it('parses a balance field', () => {
    const balance = parseBalance('C240115EUR11249,50', { referenceYear: 2024 });
    assert.equal(balance.creditDebit, 'CRDT');
    assert.equal(balance.date, '2024-01-15');
    assert.equal(balance.amount.value, '11249.50');
  });
});
