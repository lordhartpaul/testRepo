import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMt } from '../src/mt/parser.js';
import { detect, scoreCandidates } from '../src/intelligence/detector.js';
import { scoreConfidence } from '../src/intelligence/confidence.js';
import { selectMapper, supportedConversions, isConvertible } from '../src/mapping/registry.js';

const detectRaw = (raw: string) => detect(parseMt(raw).message);

const BODY: Readonly<Record<string, string>> = {
  '103': ':20:R\n:23B:CRED\n:32A:240115EUR1,00\n:50K:A\n:59:B\n:71A:SHA\n',
  '202': ':20:R\n:21:REL\n:32A:240115EUR1,00\n:58A:DEUTDEFFXXX\n',
  '940': ':20:R\n:25:ACC\n:28C:1/1\n:60F:C240114EUR1,00\n:62F:C240115EUR1,00\n',
  '942': ':20:R\n:25:ACC\n:28C:1/1\n:34F:EUR100,00\n:13D:2401151200+0100\n',
  '210': ':20:R\n:30:240116\n:21:E1\n:32B:EUR1,00\n:52A:DEUTDEFFXXX\n',
  '192': ':20:R\n:21:ORIG\n:11S:103240115\n:79:TEXT\n',
  '196': ':20:R\n:21:ORIG\n:76:ANSWER\n',
};

describe('message type detection', () => {
  it('reads the type from the application header', () => {
    const detection = detectRaw('{1:F01BANKBEBBAXXX0000000000}{2:I103DEUTDEFFXXXXN}{4:\n' + BODY['103'] + '-}');
    assert.equal(detection.messageType, '103');
    assert.equal(detection.source, 'header');
    assert.equal(detection.confidence, 1);
  });

  it('infers every supported type from the fields alone', () => {
    for (const [type, body] of Object.entries(BODY)) {
      const detection = detectRaw(body);
      assert.equal(detection.messageType, type, `expected MT${type}, got MT${detection.messageType}`);
      assert.equal(detection.source, 'content');
      assert.ok(detection.confidence > 0.5, `confidence too low for MT${type}`);
    }
  });

  it('warns when the header and the content disagree', () => {
    const detection = detectRaw('{1:F01BANKBEBBAXXX0000000000}{2:I202DEUTDEFFXXXXN}{4:\n' + BODY['940'] + '-}');
    assert.equal(detection.messageType, '202', 'the header stays authoritative');
    assert.ok(detection.diagnostics.some((d) => d.code === 'DETECT.HEADER_CONTENT_MISMATCH'));
  });

  it('gives up rather than guessing when nothing matches', () => {
    const detection = detectRaw(':99:SOMETHING\n:98:ELSE\n');
    assert.equal(detection.messageType, undefined);
    assert.equal(detection.confidence, 0);
    assert.ok(detection.diagnostics.some((d) => d.code === 'DETECT.UNKNOWN' && d.severity === 'fatal'));
  });

  it('lets the caller override detection', () => {
    const detection = detect(parseMt(BODY['103'] as string).message, { messageType: '202' });
    assert.equal(detection.messageType, '202');
    assert.equal(detection.source, 'caller');
  });

  it('warns about a message type it has no mapping for', () => {
    const detection = detectRaw('{1:F01BANKBEBBAXXX0000000000}{2:I798DEUTDEFFXXXXN}{4:\n:20:R\n-}');
    assert.ok(detection.diagnostics.some((d) => d.code === 'DETECT.UNSUPPORTED_TYPE'));
  });

  it('ranks candidates with reasons', () => {
    const candidates = scoreCandidates(parseMt(BODY['940'] as string).message);
    assert.equal(candidates[0]?.messageType, '940');
    assert.ok((candidates[0]?.score ?? 0) > (candidates[1]?.score ?? 1));
    assert.ok((candidates[0]?.reasons.length ?? 0) > 0);
  });
});

describe('variant detection', () => {
  it('recognises a COV from the customer sequence', () => {
    const raw = '{1:F01BANKBEBBAXXX0000000000}{2:I202DEUTDEFFXXXXN}{4:\n:20:R\n:21:REL\n:32A:240115EUR1,00\n:58A:DEUTDEFFXXX\n:50K:CUSTOMER\n:59:BENEFICIARY\n-}';
    assert.equal(detectRaw(raw).variant, 'COV');
  });

  it('takes an explicit variant from the user header', () => {
    const raw = '{1:F01BANKBEBBAXXX0000000000}{2:I103DEUTDEFFXXXXN}{3:{119:STP}}{4:\n' + BODY['103'] + '-}';
    assert.equal(detectRaw(raw).variant, 'STP');
  });

  it('recognises a REMIT from field 77T', () => {
    const raw = '{1:F01BANKBEBBAXXX0000000000}{2:I103DEUTDEFFXXXXN}{4:\n' + BODY['103'] + ':77T:/NARR/DETAIL\n-}';
    assert.equal(detectRaw(raw).variant, 'REMIT');
  });
});

describe('mapper registry', () => {
  it('prefers a variant specific mapper and falls back to the base one', () => {
    assert.equal(selectMapper('202', 'COV')?.variant, 'COV');
    assert.equal(selectMapper('202')?.variant, undefined);
    assert.equal(selectMapper('202', 'UNKNOWN')?.variant, undefined);
  });

  it('has no mapper for an unsupported type', () => {
    assert.equal(selectMapper('798'), undefined);
    assert.equal(isConvertible('798'), false);
    assert.equal(isConvertible('103'), true);
  });

  it('publishes a catalogue of conversions', () => {
    const catalogue = supportedConversions();
    assert.ok(catalogue.length >= 15);
    assert.ok(catalogue.every((entry) => /^\d{3}$/.test(entry.mt)));
    assert.ok(catalogue.some((entry) => entry.mt === '103' && entry.mx === 'pacs.008.001.08'));
  });
});

describe('confidence scoring', () => {
  const detection = { messageType: '103', source: 'header' as const, confidence: 1, candidates: [], diagnostics: [] };

  it('gives a clean conversion a high band', () => {
    const report = scoreConfidence({ detection, diagnostics: [], coverage: { total: 8, mapped: 8 } });
    assert.equal(report.score, 1);
    assert.equal(report.band, 'high');
  });

  it('drops to the low band as soon as an error is raised', () => {
    const report = scoreConfidence({
      detection,
      diagnostics: [{ code: 'X', severity: 'error', message: 'x', confidenceCost: 0.35 }],
      coverage: { total: 8, mapped: 8 },
    });
    assert.equal(report.band, 'low');
    assert.ok(report.score < 1);
  });

  it('charges for unmapped fields', () => {
    const report = scoreConfidence({ detection, diagnostics: [], coverage: { total: 10, mapped: 5 } });
    assert.ok(report.score < 1);
    assert.ok(report.factors.some((f) => f.label === 'field coverage'));
  });

  it('never leaves the 0..1 range', () => {
    const report = scoreConfidence({
      detection: { ...detection, confidence: 0 },
      diagnostics: Array.from({ length: 20 }, () => ({
        code: 'X', severity: 'error' as const, message: 'x', confidenceCost: 0.5,
      })),
      coverage: { total: 10, mapped: 0 },
    });
    assert.equal(report.score, 0);
  });
});
