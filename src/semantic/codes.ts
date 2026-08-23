import { isCountryCode } from '../reference/countries.js';
import { isBic, toBic11 } from '../validation/bic.js';

/** Field 71A: who pays the charges. */
export const CHARGE_BEARER: Readonly<Record<string, string>> = Object.freeze({
  OUR: 'DEBT',
  BEN: 'CRED',
  SHA: 'SHAR',
});

/** Where a field 23E instruction code belongs in the ISO 20022 model. */
export type InstructionTarget =
  | 'serviceLevel'
  | 'categoryPurpose'
  | 'localInstrument'
  | 'instructionForCreditorAgent'
  | 'instructionForNextAgent'
  | 'clearingChannel'
  | 'unstructured';

export interface InstructionMapping {
  readonly target: InstructionTarget;
  /** ISO code to emit; absent for `unstructured`. */
  readonly code?: string;
  readonly note?: string;
}

/**
 * Field 23E instruction codes.
 *
 * ISO 20022 splits what MT keeps in one field: some codes are service levels,
 * some are category purposes and some are agent instructions, with separate
 * code lists for the creditor agent (`Instruction3Code`) and the next agent
 * (`Instruction4Code`). Codes without a clean ISO equivalent are carried as
 * unstructured instruction text rather than being force-fitted.
 */
export const INSTRUCTION_CODES: Readonly<Record<string, InstructionMapping>> = Object.freeze({
  CHQB: { target: 'instructionForCreditorAgent', code: 'CHQB', note: 'pay beneficiary by cheque' },
  HOLD: { target: 'instructionForCreditorAgent', code: 'HOLD', note: 'hold at disposal of beneficiary' },
  PHOB: { target: 'instructionForCreditorAgent', code: 'PHOB', note: 'telephone the beneficiary' },
  TELB: { target: 'instructionForCreditorAgent', code: 'TELB', note: 'telecommunication to beneficiary' },
  PHON: { target: 'instructionForNextAgent', code: 'PHOA', note: 'telephone the next agent' },
  PHOI: { target: 'instructionForNextAgent', code: 'PHOA', note: 'telephone the intermediary' },
  TELE: { target: 'instructionForNextAgent', code: 'TELA', note: 'telecommunication to next agent' },
  TELI: { target: 'instructionForNextAgent', code: 'TELA', note: 'telecommunication to intermediary' },
  SDVA: { target: 'serviceLevel', code: 'SDVA', note: 'same day value' },
  URGP: { target: 'serviceLevel', code: 'URGP', note: 'urgent payment' },
  INTC: { target: 'categoryPurpose', code: 'INTC', note: 'intra-company payment' },
  CORT: { target: 'categoryPurpose', code: 'CORT', note: 'settlement of a trade' },
  NETS: { target: 'clearingChannel', code: 'MPNS', note: 'net settlement system' },
  RTGS: { target: 'clearingChannel', code: 'RTGS', note: 'real time gross settlement' },
  BONL: { target: 'unstructured', note: 'book transfer only' },
  REPA: { target: 'unstructured', note: 'related payment reference' },
  OTHR: { target: 'unstructured' },
});

/** Field 23B bank operation codes. */
export const BANK_OPERATION_CODES: Readonly<Record<string, string>> = Object.freeze({
  CRED: 'Normal credit transfer',
  CRTS: 'Test message',
  SPAY: 'SWIFTPay service level',
  SPRI: 'Priority service level',
  SSTD: 'Standard service level',
});

/** 23B codes that carry a service level into ISO 20022. */
export const OPERATION_SERVICE_LEVEL: Readonly<Record<string, string>> = Object.freeze({
  SPAY: 'SEPA',
  SPRI: 'PRPT',
  SSTD: 'NURG',
});

export interface NarrativeEntry {
  /** Code word without slashes, e.g. `ACC`. */
  readonly code?: string;
  readonly text: string;
  /** Raw lines the entry was built from. */
  readonly lines: readonly string[];
  /** BIC found immediately after the code word, e.g. `/INS/DEUTDEFF`. */
  readonly bic?: string;
}

/**
 * Parse a narrative field (72, 77B, 79) into code-word entries.
 *
 * The convention is `/CODE/text` to open an entry and `//text` to continue it;
 * anything else is free narrative.
 */
export function parseNarrative(lines: readonly string[]): NarrativeEntry[] {
  const entries: NarrativeEntry[] = [];
  let current: { code?: string; parts: string[]; lines: string[] } | undefined;

  const flush = (): void => {
    if (!current) return;
    const text = current.parts.join(' ').replace(/\s+/g, ' ').trim();
    const firstToken = text.split(/\s+/)[0] ?? '';
    entries.push({
      ...(current.code ? { code: current.code } : {}),
      text,
      lines: current.lines,
      ...(isBic(firstToken) ? { bic: toBic11(firstToken) } : {}),
    });
    current = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    const coded = /^\/([A-Z][A-Z0-9]{1,10})\/(.*)$/.exec(line);
    if (coded) {
      flush();
      current = {
        code: coded[1] as string,
        parts: [(coded[2] as string).trim()],
        lines: [line],
      };
      continue;
    }

    if (line.startsWith('//') && current) {
      current.parts.push(line.slice(2).trim());
      current.lines.push(line);
      continue;
    }

    if (current) {
      current.parts.push(line);
      current.lines.push(line);
      continue;
    }
    current = { parts: [line], lines: [line] };
  }
  flush();
  return entries;
}

/** Where a field 72 code word belongs in the ISO 20022 model. */
export type NarrativeTarget =
  | 'instructionForCreditorAgent'
  | 'instructionForNextAgent'
  | 'previousInstructingAgent'
  | 'remittanceInformation'
  | 'returnReason'
  | 'clearingChannel'
  | 'unstructured';

export interface NarrativeMapping {
  readonly target: NarrativeTarget;
  readonly code?: string;
  readonly note: string;
}

/** Field 72 code words and where they land in ISO 20022. */
export const NARRATIVE_CODES: Readonly<Record<string, NarrativeMapping>> = Object.freeze({
  ACC: { target: 'instructionForCreditorAgent', note: 'instruction for the account with institution' },
  INS: { target: 'previousInstructingAgent', note: 'instructing institution ahead of the sender' },
  INT: { target: 'instructionForNextAgent', note: 'instruction for the intermediary' },
  REC: { target: 'instructionForNextAgent', note: 'instruction for the receiver' },
  BNF: { target: 'remittanceInformation', note: 'information for the beneficiary' },
  TSU: { target: 'remittanceInformation', note: 'trade services utility reference' },
  PHONBEN: { target: 'instructionForCreditorAgent', code: 'PHOB', note: 'telephone the beneficiary' },
  TELEBEN: { target: 'instructionForCreditorAgent', code: 'TELB', note: 'telecommunication to beneficiary' },
  PHON: { target: 'instructionForNextAgent', code: 'PHOA', note: 'telephone the receiver' },
  TELE: { target: 'instructionForNextAgent', code: 'TELA', note: 'telecommunication to the receiver' },
  RETN: { target: 'returnReason', note: 'the payment is being returned' },
  REJT: { target: 'returnReason', note: 'the payment is being rejected' },
  RTGS: { target: 'clearingChannel', code: 'RTGS', note: 'settle through an RTGS system' },
});

export interface RegulatoryReport {
  readonly code: string;
  readonly country?: string;
  readonly details: readonly string[];
}

/**
 * Field 77B regulatory reporting, written as `/ORDERRES/BE//detail`.
 */
export function parseRegulatoryReporting(lines: readonly string[]): RegulatoryReport[] {
  const reports: RegulatoryReport[] = [];
  let current: { code: string; country?: string; details: string[] } | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    const header = /^\/([A-Z]{2,8})\/([A-Z]{2})?\/?\/?(.*)$/.exec(line);
    if (header) {
      if (current) reports.push({ ...current, details: current.details });
      const country = header[2];
      current = {
        code: header[1] as string,
        ...(country && isCountryCode(country) ? { country } : {}),
        details: (header[3] as string).trim() ? [(header[3] as string).trim()] : [],
      };
      continue;
    }
    if (current) current.details.push(line.replace(/^\/\//, '').trim());
  }
  if (current) reports.push(current);
  return reports;
}

/** Field 26T transaction type code, kept as an ISO purpose proprietary code. */
export function transactionTypeToPurpose(code: string): string | undefined {
  const trimmed = code.trim().toUpperCase();
  return /^[A-Z0-9]{3}$/.test(trimmed) ? trimmed : undefined;
}
