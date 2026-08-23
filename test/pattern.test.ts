import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compilePattern, extract, matchPattern, matches } from '../src/mt/pattern.js';
import { conformsTo, sanitiseToX } from '../src/mt/charsets.js';

describe('SWIFT field pattern engine', () => {
  it('splits a value date, currency and amount', () => {
    const result = matchPattern('6!n3!a15d', '240115EUR1234,56');
    assert.equal(result.ok, true);
    assert.deepEqual(result.components, ['240115', 'EUR', '1234,56']);
  });

  it('rejects a decimal point, because SWIFT requires a comma', () => {
    assert.equal(matches('3!a15d', 'EUR1234.56'), false);
    assert.equal(matches('3!a15d', 'EUR1234,56'), true);
  });

  it('requires the decimal comma to be present', () => {
    assert.equal(matches('3!a15d', 'EUR1234'), false);
  });

  it('enforces the total length of a decimal, comma included', () => {
    assert.equal(matches('3!a5d', 'EUR1,234'), true);
    assert.equal(matches('3!a5d', 'EUR12,345'), false);
  });

  it('treats bracketed groups as independently optional', () => {
    const pattern = '[[/1!a][/34x]\n]4!a2!a2!c[3!c]';
    assert.deepEqual(extract(pattern, '/D/1234567890\nDEUTDEFFXXX'), [
      'D', '1234567890', 'DEUT', 'DE', 'FF', 'XXX',
    ]);
    // Account line without the debit/credit mark.
    assert.deepEqual(extract(pattern, '/1234567890\nDEUTDEFFXXX'), [
      '', '1234567890', 'DEUT', 'DE', 'FF', 'XXX',
    ]);
    // No party identifier line at all, and a BIC8 rather than a BIC11.
    assert.deepEqual(extract(pattern, 'DEUTDEFF'), ['', '', 'DEUT', 'DE', 'FF', '']);
  });

  it('limits a multiline component to its line count and line length', () => {
    assert.equal(matches('4*35x', 'ONE\nTWO\nTHREE\nFOUR'), true);
    assert.equal(matches('4*35x', 'ONE\nTWO\nTHREE\nFOUR\nFIVE'), false);
    assert.equal(matches('4*3x', 'TOOLONG'), false);
  });

  it('reports an unusable format specification instead of throwing', () => {
    const result = matchPattern('6!q', '240115');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /character set/);
  });

  it('caches compiled patterns', () => {
    assert.equal(compilePattern('16x'), compilePattern('16x'));
  });

  it('knows the SWIFT X character set', () => {
    assert.equal(conformsTo("ABC 123 /-?:().,'+", 'x'), true);
    assert.equal(conformsTo('ABC#123', 'x'), false);
    assert.equal(sanitiseToX('ABC#123'), 'ABC 123');
  });
});
