import { el, elA, type XmlElement } from './xml.js';

/** An ISO 20022 message definition: its identifier, namespace and root element. */
export interface MxDefinition {
  readonly id: string;
  readonly namespace: string;
  /** Message root inside `<Document>`, e.g. `FIToFICstmrCdtTrf`. */
  readonly root: string;
  readonly name: string;
}

const NS = (id: string): string => `urn:iso:std:iso:20022:tech:xsd:${id}`;

export const MX_DEFINITIONS: Readonly<Record<string, MxDefinition>> = Object.freeze({
  'pacs.008.001.08': {
    id: 'pacs.008.001.08',
    namespace: NS('pacs.008.001.08'),
    root: 'FIToFICstmrCdtTrf',
    name: 'FI To FI Customer Credit Transfer',
  },
  'pacs.009.001.08': {
    id: 'pacs.009.001.08',
    namespace: NS('pacs.009.001.08'),
    root: 'FinInstnCdtTrf',
    name: 'Financial Institution Credit Transfer',
  },
  'pacs.004.001.09': {
    id: 'pacs.004.001.09',
    namespace: NS('pacs.004.001.09'),
    root: 'PmtRtr',
    name: 'Payment Return',
  },
  'camt.029.001.09': {
    id: 'camt.029.001.09',
    namespace: NS('camt.029.001.09'),
    root: 'RsltnOfInvstgtn',
    name: 'Resolution of Investigation',
  },
  'camt.052.001.08': {
    id: 'camt.052.001.08',
    namespace: NS('camt.052.001.08'),
    root: 'BkToCstmrAcctRpt',
    name: 'Bank to Customer Account Report',
  },
  'camt.053.001.08': {
    id: 'camt.053.001.08',
    namespace: NS('camt.053.001.08'),
    root: 'BkToCstmrStmt',
    name: 'Bank to Customer Statement',
  },
  'camt.054.001.08': {
    id: 'camt.054.001.08',
    namespace: NS('camt.054.001.08'),
    root: 'BkToCstmrDbtCdtNtfctn',
    name: 'Bank to Customer Debit Credit Notification',
  },
  'camt.056.001.08': {
    id: 'camt.056.001.08',
    namespace: NS('camt.056.001.08'),
    root: 'FIToFIPmtCxlReq',
    name: 'FI to FI Payment Cancellation Request',
  },
  'camt.057.001.06': {
    id: 'camt.057.001.06',
    namespace: NS('camt.057.001.06'),
    root: 'NtfctnToRcv',
    name: 'Notification to Receive',
  },
  'head.001.001.02': {
    id: 'head.001.001.02',
    namespace: NS('head.001.001.02'),
    root: 'AppHdr',
    name: 'Business Application Header',
  },
});

export const ENVELOPE_NAMESPACE = 'urn:swift:xsd:envelope';

export function definitionFor(id: string): MxDefinition | undefined {
  return MX_DEFINITIONS[id];
}

/** Wrap a message body in `<Document>` with the right target namespace. */
export function document(mxId: string, body: XmlElement): XmlElement {
  const definition = definitionFor(mxId);
  const namespace = definition?.namespace ?? NS(mxId);
  return elA('Document', { xmlns: namespace }, body);
}

export interface BusinessHeaderInput {
  readonly fromBic?: string;
  readonly toBic?: string;
  readonly businessMessageId: string;
  readonly messageDefinitionId: string;
  readonly businessService?: string;
  readonly creationDate: string;
  readonly possibleDuplicate?: boolean;
  readonly priority?: string;
  /** Reference to the message this one relates to (cancellations, answers). */
  readonly related?: { readonly businessMessageId: string; readonly messageDefinitionId: string };
}

/**
 * Build a head.001.001.02 Business Application Header.
 *
 * The BAH carries the routing that FIN kept in blocks 1 and 2: sender, receiver,
 * priority and the possible-duplicate flag from the `{5:{PDE:}}` trailer.
 */
export function businessApplicationHeader(input: BusinessHeaderInput): XmlElement {
  const head = MX_DEFINITIONS['head.001.001.02'] as MxDefinition;
  return elA(
    'AppHdr',
    { xmlns: head.namespace },
    input.fromBic ? el('Fr', el('FIId', el('FinInstnId', el('BICFI', input.fromBic)))) : undefined,
    input.toBic ? el('To', el('FIId', el('FinInstnId', el('BICFI', input.toBic)))) : undefined,
    el('BizMsgIdr', input.businessMessageId),
    el('MsgDefIdr', input.messageDefinitionId),
    input.businessService ? el('BizSvc', input.businessService) : undefined,
    el('CreDt', input.creationDate),
    input.possibleDuplicate ? el('PssblDplct', 'true') : undefined,
    input.priority ? el('Prty', input.priority) : undefined,
    input.related
      ? el(
          'Rltd',
          el('BizMsgIdr', input.related.businessMessageId),
          el('MsgDefIdr', input.related.messageDefinitionId),
        )
      : undefined,
  );
}

/** SWIFT style envelope holding a business application header and a document. */
export function businessMessage(header: XmlElement, doc: XmlElement): XmlElement {
  return elA('Envelope', { xmlns: ENVELOPE_NAMESPACE }, header, doc);
}

/** MT priority (`N`, `U`, `S`) as a business message priority code. */
export function priorityFromMt(priority: string | undefined): string | undefined {
  if (!priority) return undefined;
  return priority.toUpperCase() === 'U' || priority.toUpperCase() === 'S' ? 'HIGH' : 'NORM';
}
