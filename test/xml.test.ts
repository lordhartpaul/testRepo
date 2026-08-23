import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { el, elA, find, findAll, prune, serialise, textOf } from '../src/mx/xml.js';
import { businessApplicationHeader, businessMessage, document, priorityFromMt } from '../src/mx/documents.js';

describe('XML builder', () => {
  it('drops branches that end up with no content', () => {
    const root = el('Dbtr', el('Nm', undefined), el('PstlAdr', el('Ctry', undefined)));
    assert.equal(prune(root), undefined);
  });

  it('keeps a branch as soon as one leaf has content', () => {
    const root = el('Dbtr', el('Nm', undefined), el('PstlAdr', el('Ctry', 'DE')));
    const pruned = prune(root);
    assert.equal(pruned?.children.length, 1);
    assert.equal(textOf(pruned as never), 'DE');
  });

  it('escapes text and attribute values', () => {
    const xml = serialise(el('Nm', 'A & B <C>'), { declaration: false });
    assert.equal(xml, '<Nm>A &amp; B &lt;C&gt;</Nm>');
    const attr = serialise(elA('Amt', { Ccy: 'E"UR' }, '1.00'), { declaration: false });
    assert.match(attr, /Ccy="E&quot;UR"/);
  });

  it('keeps children in the order they were written', () => {
    const xml = serialise(el('P', el('A', '1'), el('B', '2'), el('C', '3')), {
      declaration: false,
      pretty: false,
    });
    assert.equal(xml, '<P><A>1</A><B>2</B><C>3</C></P>');
  });

  it('finds elements by path', () => {
    const root = el('R', el('A', el('B', 'x'), el('B', 'y')));
    assert.equal(textOf(find(root, 'A/B') as never), 'x');
    assert.equal(findAll(root, 'A/B').length, 2);
    assert.equal(find(root, 'A/Z'), undefined);
  });

  it('wraps a body in the right target namespace', () => {
    const doc = document('pacs.008.001.08', el('FIToFICstmrCdtTrf', el('GrpHdr', el('MsgId', 'X'))));
    assert.equal(doc.attributes['xmlns'], 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08');
  });

  it('builds a business message envelope with a header', () => {
    const header = businessApplicationHeader({
      fromBic: 'BANKBEBBXXX',
      toBic: 'DEUTDEFFXXX',
      businessMessageId: 'REF',
      messageDefinitionId: 'pacs.008.001.08',
      creationDate: '2024-01-15T10:00:00Z',
      possibleDuplicate: true,
      priority: 'HIGH',
    });
    const xml = serialise(businessMessage(header, document('pacs.008.001.08', el('FIToFICstmrCdtTrf', el('GrpHdr', el('MsgId', 'REF'))))));
    assert.match(xml, /<Envelope xmlns="urn:swift:xsd:envelope">/);
    assert.match(xml, /<AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head\.001\.001\.02">/);
    assert.match(xml, /<PssblDplct>true<\/PssblDplct>/);
    assert.match(xml, /<Prty>HIGH<\/Prty>/);
  });

  it('maps the FIN priority onto the header priority', () => {
    assert.equal(priorityFromMt('U'), 'HIGH');
    assert.equal(priorityFromMt('N'), 'NORM');
    assert.equal(priorityFromMt(undefined), undefined);
  });
});
