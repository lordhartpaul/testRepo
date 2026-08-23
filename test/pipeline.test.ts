import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convert, formatReport } from '../src/pipeline/converter.js';
import { convertBatch, splitMessages } from '../src/pipeline/batch.js';
import { deterministicUuid, isUetr, sanitiseId } from '../src/core/ids.js';

const MT103 = `{1:F01BANKBEBBAXXX0000000000}{2:I103DEUTDEFFXXXXN}{4:
:20:PIPE001
:23B:CRED
:32A:240115EUR100,00
:50K:/BE68539007547034
SENDER NAME
:59:/DE89370400440532013000
BENEFICIARY NAME
:71A:SHA
-}`;

const OPTIONS = { now: '2024-01-15T10:00:00Z', referenceYear: 2024 } as const;

describe('conversion pipeline', () => {
  it('produces a business message envelope by default', () => {
    const report = convert(MT103, OPTIONS);
    assert.equal(report.ok, true);
    assert.match(report.xml ?? '', /<Envelope xmlns="urn:swift:xsd:envelope">/);
    assert.match(report.xml ?? '', /<AppHdr/);
  });

  it('produces a bare document on request', () => {
    const xml = convert(MT103, { ...OPTIONS, envelope: 'document' }).xml ?? '';
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<Document /);
    assert.doesNotMatch(xml, /<AppHdr/);
  });

  it('is reproducible: the same input and options give byte identical output', () => {
    assert.equal(convert(MT103, OPTIONS).xml, convert(MT103, OPTIONS).xml);
  });

  it('derives a stable UETR when the source has none', () => {
    const first = convert(MT103, OPTIONS);
    const second = convert(MT103, OPTIONS);
    const uetr = /<UETR>([^<]+)<\/UETR>/.exec(first.xml ?? '')?.[1] as string;
    assert.ok(isUetr(uetr));
    assert.equal(uetr, /<UETR>([^<]+)<\/UETR>/.exec(second.xml ?? '')?.[1]);
    assert.ok(first.diagnostics.some((d) => d.code === 'MX.UETR_DERIVED'));
  });

  it('omits the UETR when derivation is switched off', () => {
    const report = convert(MT103, { ...OPTIONS, uetr: 'omit' });
    assert.doesNotMatch(report.xml ?? '', /<UETR>/);
    assert.ok(report.diagnostics.some((d) => d.code === 'MX.UETR_OMITTED'));
  });

  it('honours the address format option', () => {
    const raw = MT103.replace('BENEFICIARY NAME', 'BENEFICIARY NAME\nSTRASSE 1\n10115 BERLIN, GERMANY');
    assert.match(convert(raw, OPTIONS).xml ?? '', /<Ctry>DE<\/Ctry>/);
    assert.doesNotMatch(
      convert(raw, { ...OPTIONS, addressFormat: 'unstructured' }).xml ?? '',
      /<Ctry>DE<\/Ctry>/,
    );
    assert.match(
      convert(raw, { ...OPTIONS, addressFormat: 'structured' }).xml ?? '',
      /<TwnNm>BERLIN<\/TwnNm>/,
    );
  });

  it('treats warnings as failures in strict mode only', () => {
    assert.equal(convert(MT103, OPTIONS).ok, true);
    assert.equal(convert(MT103, { ...OPTIONS, strict: true }).ok, false);
  });

  it('reports fields the target message has no home for', () => {
    const raw = MT103.replace(':71A:SHA', ':71A:SHA\n:77T:/NARR/EXTENDED REMITTANCE');
    const report = convert(raw, OPTIONS);
    assert.ok(report.diagnostics.some((d) => d.code === 'MX.REMIT_SUPPLEMENTARY'));
    assert.match(report.xml ?? '', /<SplmtryData>/);
  });

  it('still returns diagnostics when the message cannot be recognised', () => {
    const report = convert('not a swift message at all');
    assert.equal(report.ok, false);
    assert.equal(report.xml, undefined);
    assert.ok(report.diagnostics.some((d) => d.severity === 'fatal'));
    assert.equal(report.confidence.band, 'low');
  });

  it('refuses a message type it has no mapper for', () => {
    const raw = '{1:F01BANKBEBBAXXX0000000000}{2:I798DEUTDEFFXXXXN}{4:\n:20:REF\n-}';
    const report = convert(raw, OPTIONS);
    assert.equal(report.ok, false);
    assert.ok(report.diagnostics.some((d) => d.code === 'CONVERT.NO_MAPPER'));
  });

  it('lets the caller force a message type', () => {
    const bare = ':20:REF\n:21:REL\n:32A:240115EUR1,00\n:58A:DEUTDEFFXXX\n';
    assert.equal(convert(bare, { ...OPTIONS, messageType: '202' }).mxId, 'pacs.009.001.08');
  });

  it('can skip either validation stage', () => {
    const broken = MT103.replace(':20:PIPE001', ':20:/BROKEN/');
    assert.ok(convert(broken, OPTIONS).diagnostics.some((d) => d.code === 'MT.RULE.T26'));
    assert.ok(
      !convert(broken, { ...OPTIONS, skipMtValidation: true }).diagnostics.some(
        (d) => d.code === 'MT.RULE.T26',
      ),
    );
  });

  it('formats a readable report', () => {
    const text = formatReport(convert(MT103, OPTIONS));
    assert.match(text, /converted: MT103 -> pacs\.008\.001\.08/);
    assert.match(text, /coverage \d+\/\d+ fields/);
  });
});

describe('batch processing', () => {
  const rje = `${MT103}\n$\n${MT103.replace('PIPE001', 'PIPE002')}`;

  it('splits an RJE file on its separators', () => {
    assert.equal(splitMessages(rje).length, 2);
  });

  it('splits concatenated FIN blocks', () => {
    assert.equal(splitMessages(`${MT103}\n${MT103}`).length, 2);
  });

  it('treats a single message as a batch of one', () => {
    assert.equal(splitMessages(MT103).length, 1);
    assert.equal(splitMessages('   ').length, 0);
  });

  it('summarises a batch', () => {
    const summary = convertBatch(`${rje}\n$\nnot a swift message`, OPTIONS);
    assert.equal(summary.total, 3);
    assert.equal(summary.converted, 2);
    assert.equal(summary.failed, 1);
    assert.ok(summary.averageConfidence > 0 && summary.averageConfidence < 1);
    assert.ok(summary.topDiagnostics.length > 0);
  });
});

describe('identifier helpers', () => {
  it('derives a UUIDv4 shaped identifier from a seed', () => {
    const id = deterministicUuid('seed');
    assert.ok(isUetr(id));
    assert.equal(id, deterministicUuid('seed'));
    assert.notEqual(id, deterministicUuid('other seed'));
  });

  it('collapses whitespace and trims identifiers to their limit', () => {
    assert.equal(sanitiseId('  A   B  '), 'A B');
    assert.equal(sanitiseId('X'.repeat(50)).length, 35);
  });
});
