import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convert } from '../src/pipeline/converter.js';
import { find, findAll, textOf, type XmlElement } from '../src/mx/xml.js';

const OPTIONS = { now: '2024-01-15T10:00:00Z', referenceYear: 2024 } as const;

function converted(raw: string, extra: Record<string, unknown> = {}) {
  const report = convert(raw, { ...OPTIONS, ...extra });
  assert.ok(report.root, `conversion produced no document: ${report.diagnostics.map((d) => d.code).join(', ')}`);
  return report;
}

const at = (root: XmlElement, path: string): string | undefined => {
  const found = find(root, path);
  return found ? textOf(found) : undefined;
};

const example = (name: string): string => readFileSync(new URL(`../../examples/${name}`, import.meta.url), 'utf8');

describe('MT103 to pacs.008', () => {
  const report = converted(example('mt103.txt'));
  const root = report.root as XmlElement;

  it('targets pacs.008.001.08 and maps every field', () => {
    assert.equal(report.mxId, 'pacs.008.001.08');
    assert.equal(report.ok, true);
    assert.deepEqual(report.coverage.unmapped, []);
  });

  it('carries the references and the UETR from the FIN header', () => {
    assert.equal(at(root, 'CdtTrfTxInf/PmtId/InstrId'), 'REF20240115001');
    assert.equal(at(root, 'CdtTrfTxInf/PmtId/EndToEndId'), 'INV-2024-0042');
    assert.equal(at(root, 'CdtTrfTxInf/PmtId/UETR'), '97ed4827-7b6f-4491-a06f-b548d5a7512d');
  });

  it('converts the amount and value date', () => {
    const amount = find(root, 'CdtTrfTxInf/IntrBkSttlmAmt') as XmlElement;
    assert.equal(amount.attributes['Ccy'], 'EUR');
    assert.equal(textOf(amount), '12500.00');
    assert.equal(at(root, 'CdtTrfTxInf/IntrBkSttlmDt'), '2024-01-15');
  });

  it('maps the charge bearer', () => {
    assert.equal(at(root, 'CdtTrfTxInf/ChrgBr'), 'SHAR');
  });

  it('places the parties, their accounts and their agents', () => {
    assert.equal(at(root, 'CdtTrfTxInf/Dbtr/Nm'), 'ACME EXPORTS NV');
    assert.equal(at(root, 'CdtTrfTxInf/Dbtr/PstlAdr/Ctry'), 'BE');
    assert.equal(at(root, 'CdtTrfTxInf/DbtrAcct/Id/IBAN'), 'BE68539007547034');
    assert.equal(at(root, 'CdtTrfTxInf/DbtrAgt/FinInstnId/BICFI'), 'BANKBEBBXXX');
    assert.equal(at(root, 'CdtTrfTxInf/Cdtr/Nm'), 'MUELLER HANDELS GMBH');
    assert.equal(at(root, 'CdtTrfTxInf/CdtrAcct/Id/IBAN'), 'DE89370400440532013000');
    assert.equal(at(root, 'CdtTrfTxInf/CdtrAgt/FinInstnId/BICFI'), 'DEUTDEFFXXX');
  });

  it('names the sending and receiving institutions from the FIN header', () => {
    assert.equal(at(root, 'CdtTrfTxInf/InstgAgt/FinInstnId/BICFI'), 'BANKBEBBXXX');
    assert.equal(at(root, 'CdtTrfTxInf/InstdAgt/FinInstnId/BICFI'), 'DEUTDEFFXXX');
  });

  it('routes a field 72 code word to the creditor agent instruction', () => {
    assert.equal(
      at(root, 'CdtTrfTxInf/InstrForCdtrAgt/InstrInf'),
      'ADVISE BENEFICIARY ON CREDIT',
    );
  });

  it('splits remittance information into a structured reference and free text', () => {
    assert.equal(at(root, 'CdtTrfTxInf/RmtInf/Strd/CdtrRefInf/Ref'), 'INV-2024-0042');
    assert.equal(at(root, 'CdtTrfTxInf/RmtInf/Ustrd'), 'CONSULTING SERVICES Q4 2023');
  });
});

describe('MT103 with structured parties', () => {
  const report = converted(example('mt103-structured.txt'));
  const root = report.root as XmlElement;

  it('turns option F into a private identification with a date of birth', () => {
    assert.equal(at(root, 'CdtTrfTxInf/Dbtr/Nm'), 'SMITH JOHN ROBERT');
    assert.equal(at(root, 'CdtTrfTxInf/Dbtr/PstlAdr/TwnNm'), 'SAN FRANCISCO');
    assert.equal(at(root, 'CdtTrfTxInf/Dbtr/PstlAdr/Ctry'), 'US');
    assert.equal(at(root, 'CdtTrfTxInf/Dbtr/Id/PrvtId/DtAndPlcOfBirth/BirthDt'), '1980-03-15');
    assert.equal(at(root, 'CdtTrfTxInf/Dbtr/Id/PrvtId/DtAndPlcOfBirth/CityOfBirth'), 'BOSTON');
  });

  it('keeps a US account number out of the IBAN element', () => {
    assert.equal(at(root, 'CdtTrfTxInf/DbtrAcct/Id/Othr/Id'), 'US1234567890');
    assert.equal(find(root, 'CdtTrfTxInf/DbtrAcct/Id/IBAN'), undefined);
  });

  it('maps regulatory reporting with its authority country', () => {
    assert.equal(at(root, 'CdtTrfTxInf/RgltryRptg/Authrty/Ctry'), 'US');
    assert.equal(at(root, 'CdtTrfTxInf/RgltryRptg/Dtls/Cd'), 'ORDERRES');
  });

  it('maps the 23B service level onto a payment type', () => {
    assert.equal(at(root, 'CdtTrfTxInf/PmtTpInf/SvcLvl/Cd'), 'PRPT');
  });
});

describe('MT202 COV to pacs.009', () => {
  const report = converted(example('mt202cov.txt'));
  const root = report.root as XmlElement;

  it('detects the COV variant and keeps the underlying customer transfer', () => {
    assert.equal(report.variant, 'COV');
    assert.equal(report.mxId, 'pacs.009.001.08');
    assert.ok(find(root, 'CdtTrfTxInf/UndrlygCstmrCdtTrf'));
    assert.equal(at(root, 'CdtTrfTxInf/UndrlygCstmrCdtTrf/Dbtr/Nm'), 'ACME EXPORTS NV');
    assert.equal(at(root, 'CdtTrfTxInf/UndrlygCstmrCdtTrf/Cdtr/Nm'), 'GLOBAL IMPORTS INC');
  });

  it('treats the debtor and creditor as financial institutions', () => {
    assert.equal(at(root, 'CdtTrfTxInf/Dbtr/FinInstnId/BICFI'), 'BANKBEBBXXX');
    assert.equal(at(root, 'CdtTrfTxInf/Cdtr/FinInstnId/BICFI'), 'BOFAUS3NXXX');
  });

  it('chooses the cover settlement method when a correspondent is named', () => {
    assert.equal(at(root, 'GrpHdr/SttlmInf/SttlmMtd'), 'COVE');
    assert.equal(at(root, 'GrpHdr/SttlmInf/InstgRmbrsmntAgt/FinInstnId/BICFI'), 'CITIUS33XXX');
  });

  it('maps the field 72 /INS/ code word to the previous instructing agent', () => {
    assert.equal(at(root, 'CdtTrfTxInf/PrvsInstgAgt1/FinInstnId/BICFI'), 'DEUTDEFFXXX');
  });
});

describe('MT940 to camt.053', () => {
  const report = converted(example('mt940.txt'));
  const root = report.root as XmlElement;

  it('maps the account, sequence numbers and balances', () => {
    assert.equal(report.mxId, 'camt.053.001.08');
    assert.equal(at(root, 'Stmt/Acct/Id/IBAN'), 'BE68539007547034');
    assert.equal(at(root, 'Stmt/Acct/Ccy'), 'EUR');
    assert.equal(at(root, 'Stmt/LglSeqNb'), '00123');
    assert.equal(at(root, 'Stmt/ElctrncSeqNb'), '00001');
    const balances = findAll(root, 'Stmt/Bal');
    assert.deepEqual(
      balances.map((b) => textOf(find(b, 'Tp/CdOrPrtry/Cd') as XmlElement)),
      ['OPBD', 'CLBD', 'CLAV', 'FWAV'],
    );
  });

  it('creates one entry per field 61 with the account currency', () => {
    const entries = findAll(root, 'Stmt/Ntry');
    assert.equal(entries.length, 3);
    const first = entries[0] as XmlElement;
    assert.equal(textOf(find(first, 'Amt') as XmlElement), '15000.00');
    assert.equal((find(first, 'Amt') as XmlElement).attributes['Ccy'], 'EUR');
    assert.equal(textOf(find(first, 'CdtDbtInd') as XmlElement), 'CRDT');
    assert.equal(textOf(find(first, 'BkTxCd/Prtry/Cd') as XmlElement), 'NTRF');
    assert.equal(textOf(find(first, 'AcctSvcrRef') as XmlElement), 'BKREF889900');
  });

  it('flags a reversal entry', () => {
    const reversal = findAll(root, 'Stmt/Ntry')[2] as XmlElement;
    assert.equal(textOf(find(reversal, 'RvslInd') as XmlElement), 'true');
    assert.equal(textOf(find(reversal, 'CdtDbtInd') as XmlElement), 'DBIT');
  });

  it('keeps the trailing field 86 as statement level information', () => {
    assert.equal(at(root, 'Stmt/AddtlStmtInf'), 'STATEMENT PRODUCED BY OVERNIGHT BATCH');
  });
});

describe('MT210 to camt.057', () => {
  const report = converted(example('mt210.txt'));
  const root = report.root as XmlElement;

  it('creates one item per repeated sequence', () => {
    assert.equal(report.mxId, 'camt.057.001.06');
    const items = findAll(root, 'Ntfctn/Itm');
    assert.equal(items.length, 2);
    assert.equal(textOf(find(items[0] as XmlElement, 'Id') as XmlElement), 'EXPECT001');
    assert.equal(textOf(find(items[1] as XmlElement, 'Amt') as XmlElement), '22500.00');
  });

  it('distinguishes an ordering institution from an ordering customer', () => {
    const items = findAll(root, 'Ntfctn/Itm');
    assert.equal(textOf(find(items[0] as XmlElement, 'Dbtr/Agt/FinInstnId/BICFI') as XmlElement), 'CHASUS33XXX');
    assert.equal(textOf(find(items[1] as XmlElement, 'Dbtr/Pty/Nm') as XmlElement), 'NORTHWIND TRADING LLC');
  });

  it('carries the expected value date', () => {
    assert.equal(at(root, 'Ntfctn/XpctdValDt'), '2024-01-16');
  });
});

describe('MT900 and MT910 to camt.054', () => {
  const debit = converted(`{1:F01BANKBEBBAXXX0000000000}{2:I900DEUTDEFFXXXXN}{4:
:20:DEB001
:21:ORIG99
:25:BE68539007547034
:13D:2401151230+0100
:32A:240115EUR7500,00
:52A:DEUTDEFFXXX
-}`).root as XmlElement;

  const credit = converted(`{1:F01BANKBEBBAXXX0000000000}{2:I910DEUTDEFFXXXXN}{4:
:20:CRD001
:21:ORIG99
:25:BE68539007547034
:32A:240115EUR7500,00
:50K:/BE68539007547034
PAYING CUSTOMER
-}`).root as XmlElement;

  it('sets the credit/debit indicator from the message type', () => {
    assert.equal(textOf(find(debit, 'Ntfctn/Ntry/CdtDbtInd') as XmlElement), 'DBIT');
    assert.equal(textOf(find(credit, 'Ntfctn/Ntry/CdtDbtInd') as XmlElement), 'CRDT');
  });

  it('maps field 13D to a booking date and time with its offset', () => {
    assert.equal(
      textOf(find(debit, 'Ntfctn/Ntry/BookgDt/DtTm') as XmlElement),
      '2024-01-15T12:30:00+01:00',
    );
  });

  it('puts an ordering customer under the related parties', () => {
    assert.equal(
      textOf(find(credit, 'Ntfctn/Ntry/NtryDtls/TxDtls/RltdPties/Dbtr/Pty/Nm') as XmlElement),
      'PAYING CUSTOMER',
    );
  });
});

describe('MT192 to camt.056 and MT196 to camt.029', () => {
  const cancellation = converted(`{1:F01BANKBEBBAXXX0000000000}{2:I192DEUTDEFFXXXXN}{4:
:20:CANC001
:21:REF20240115001
:11S:103240115
:79:/DUPL/DUPLICATE PAYMENT SENT IN ERROR
-}`).root as XmlElement;

  const answer = converted(`{1:F01BANKBEBBAXXX0000000000}{2:I196DEUTDEFFXXXXN}{4:
:20:ANSW001
:21:CANC001
:76:/1/CANCELLED AS REQUESTED
-}`).root as XmlElement;

  it('names the original message by its ISO equivalent', () => {
    assert.equal(textOf(find(cancellation, 'Undrlyg/TxInf/OrgnlGrpInf/OrgnlMsgNmId') as XmlElement), 'pacs.008.001.08');
    assert.equal(textOf(find(cancellation, 'Undrlyg/TxInf/OrgnlGrpInf/OrgnlCreDtTm') as XmlElement), '2024-01-15T00:00:00Z');
  });

  it('reads an ISO cancellation reason out of the narrative', () => {
    assert.equal(textOf(find(cancellation, 'Undrlyg/TxInf/CxlRsnInf/Rsn/Cd') as XmlElement), 'DUPL');
  });

  it('infers the investigation status from the answer text', () => {
    assert.equal(textOf(find(answer, 'Sts/Conf') as XmlElement), 'CNCL');
  });

  it('assigns the case between the sender and the receiver', () => {
    assert.equal(textOf(find(cancellation, 'Assgnmt/Assgnr/Agt/FinInstnId/BICFI') as XmlElement), 'BANKBEBBXXX');
    assert.equal(textOf(find(cancellation, 'Assgnmt/Assgne/Agt/FinInstnId/BICFI') as XmlElement), 'DEUTDEFFXXX');
  });
});
