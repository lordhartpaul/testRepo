import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMt } from '../src/mt/parser.js';
import { field, fieldsByNumber, hasField, logicalTerminalToBic } from '../src/mt/message.js';

const FULL = `{1:F01BANKBEBBAXXX0000000000}{2:I103DEUTDEFFXXXXN}{3:{108:REF108}{121:97ed4827-7b6f-4491-a06f-b548d5a7512d}}{4:
:20:REFERENCE123
:32A:240115EUR1234,56
:50K:/DE89370400440532013000
JOHN DOE
1 MAIN STREET
:71A:SHA
-}{5:{MAC:00000000}{CHK:123456789ABC}}`;

describe('FIN parser', () => {
  it('reads all five blocks', () => {
    const { message, diagnostics } = parseMt(FULL);
    assert.equal(diagnostics.length, 0);
    assert.equal(message.messageType, '103');
    assert.equal(message.block1?.senderBic, 'BANKBEBBXXX');
    assert.equal(message.block2?.direction, 'input');
    assert.equal(message.block3?.tags['121'], '97ed4827-7b6f-4491-a06f-b548d5a7512d');
    assert.equal(message.block5?.tags['CHK'], '123456789ABC');
    assert.equal(message.bareBody, false);
  });

  it('keeps multi-line field values as separate lines', () => {
    const { message } = parseMt(FULL);
    const ordering = field(message, '50K');
    assert.deepEqual(ordering?.lines, ['/DE89370400440532013000', 'JOHN DOE', '1 MAIN STREET']);
    assert.equal(ordering?.number, '50');
    assert.equal(ordering?.option, 'K');
  });

  it('parses an output header with its message input reference', () => {
    const raw = '{1:F01BANKBEBBAXXX0000000000}{2:O9401200240116DEUTDEFFAXXX00000000002401161200N}{4:\n:20:X\n-}';
    const { message } = parseMt(raw);
    assert.equal(message.block2?.direction, 'output');
    if (message.block2?.direction === 'output') {
      assert.equal(message.block2.inputTime, '1200');
      assert.equal(message.block2.senderBic, 'DEUTDEFFXXX');
      assert.equal(message.block2.inputReference?.date, '240116');
    }
  });

  it('accepts a bare text block with no FIN envelope', () => {
    const { message } = parseMt(':20:REF\n:32A:240115EUR1,00\n');
    assert.equal(message.bareBody, true);
    assert.equal(message.block4.length, 2);
    assert.equal(message.messageType, undefined);
  });

  it('normalises CRLF line endings and strips RJE separators', () => {
    const { message } = parseMt(':20:REF\r\n:32A:240115EUR1,00\r\n$\r\n');
    assert.equal(message.block4.length, 2);
    assert.equal(field(message, '32A')?.value, '240115EUR1,00');
  });

  it('reports an unterminated text block instead of failing', () => {
    const { message, diagnostics } = parseMt('{1:F01BANKBEBBAXXX0000000000}{4:\n:20:REF');
    assert.equal(message.block4.length, 1);
    assert.ok(diagnostics.some((d) => d.code === 'MT.PARSE.UNTERMINATED_TEXT_BLOCK'));
  });

  it('reports a message with no fields as fatal', () => {
    const { diagnostics } = parseMt('this is not a SWIFT message');
    assert.ok(diagnostics.some((d) => d.code === 'MT.PARSE.NO_FIELDS' && d.severity === 'fatal'));
  });

  it('finds repeated fields by their number', () => {
    const { message } = parseMt(':20:A\n:71F:EUR1,00\n:71G:EUR2,00\n:71A:SHA\n');
    assert.equal(fieldsByNumber(message, '71').length, 3);
    assert.equal(hasField(message, '71'), true);
    assert.equal(hasField(message, '99'), false);
  });

  it('derives a BIC11 from a logical terminal address', () => {
    assert.equal(logicalTerminalToBic('BANKBEBBAXXX'), 'BANKBEBBXXX');
    assert.equal(logicalTerminalToBic('SHORT'), undefined);
  });
});
