/**
 * SWIFT field format specifications, keyed by full tag (option included).
 *
 * A field's format is a property of the tag rather than of the message, so this
 * registry is shared by every message schema. `\n` stands for the CRLF line
 * separator used inside a field value.
 */
export interface FieldFormat {
  readonly name: string;
  readonly pattern: string;
  /** Short note shown in validation output. */
  readonly note?: string;
}

export const FIELD_FORMATS: Readonly<Record<string, FieldFormat>> = Object.freeze({
  // -- references and instructions -----------------------------------------
  '20': { name: 'Transaction Reference Number', pattern: '16x' },
  '21': { name: 'Related Reference', pattern: '16x' },
  '21R': { name: 'Customer Specified Reference', pattern: '16x' },
  '11S': { name: 'MT and Date of the Original Message', pattern: '3!n6!n[4!n6!n]' },
  '11A': { name: 'MT and Date of the Original Message', pattern: '3!n6!n[4!n6!n]' },
  '13C': { name: 'Time Indication', pattern: '/8c/4!n1!x4!n' },
  '13D': { name: 'Date Time Indication', pattern: '6!n4!n1!x4!n' },
  '23B': { name: 'Bank Operation Code', pattern: '4!c' },
  '23E': { name: 'Instruction Code', pattern: '4!c[/30x]' },
  '26T': { name: 'Transaction Type Code', pattern: '3!c' },
  '30': { name: 'Date', pattern: '6!n' },
  '36': { name: 'Exchange Rate', pattern: '12d' },

  // -- amounts --------------------------------------------------------------
  '32A': { name: 'Value Date, Currency Code, Amount', pattern: '6!n3!a15d' },
  '32B': { name: 'Currency Code, Amount', pattern: '3!a15d' },
  '33B': { name: 'Currency/Instructed Amount', pattern: '3!a15d' },
  '34F': { name: 'Floor Limit Indicator', pattern: '3!a[1!a]15d' },
  '71A': { name: 'Details of Charges', pattern: '3!a' },
  '71F': { name: "Sender's Charges", pattern: '3!a15d' },
  '71G': { name: "Receiver's Charges", pattern: '3!a15d' },
  '90C': { name: 'Number and Sum of Credit Entries', pattern: '5n3!a15d' },
  '90D': { name: 'Number and Sum of Debit Entries', pattern: '5n3!a15d' },

  // -- ordering customer (50a) ---------------------------------------------
  '50A': { name: 'Ordering Customer', pattern: '[/34x\n]4!a2!a2!c[3!c]' },
  '50F': { name: 'Ordering Customer', pattern: '35x\n4*35x', note: 'structured party, coded lines 1-8' },
  '50K': { name: 'Ordering Customer', pattern: '[/34x\n]4*35x' },

  // -- financial institutions (52a..58a) ------------------------------------
  '51A': { name: 'Sending Institution', pattern: '[[/1!a][/34x]\n]4!a2!a2!c[3!c]' },
  '52A': { name: "Ordering Institution", pattern: '[[/1!a][/34x]\n]4!a2!a2!c[3!c]' },
  '52B': { name: "Ordering Institution", pattern: '[[/1!a][/34x]\n][35x]' },
  '52D': { name: "Ordering Institution", pattern: '[[/1!a][/34x]\n]4*35x' },
  '53A': { name: "Sender's Correspondent", pattern: '[[/1!a][/34x]\n]4!a2!a2!c[3!c]' },
  '53B': { name: "Sender's Correspondent", pattern: '[[/1!a][/34x]\n][35x]' },
  '53D': { name: "Sender's Correspondent", pattern: '[[/1!a][/34x]\n]4*35x' },
  '54A': { name: "Receiver's Correspondent", pattern: '[[/1!a][/34x]\n]4!a2!a2!c[3!c]' },
  '54B': { name: "Receiver's Correspondent", pattern: '[[/1!a][/34x]\n][35x]' },
  '54D': { name: "Receiver's Correspondent", pattern: '[[/1!a][/34x]\n]4*35x' },
  '55A': { name: 'Third Reimbursement Institution', pattern: '[[/1!a][/34x]\n]4!a2!a2!c[3!c]' },
  '55B': { name: 'Third Reimbursement Institution', pattern: '[[/1!a][/34x]\n][35x]' },
  '55D': { name: 'Third Reimbursement Institution', pattern: '[[/1!a][/34x]\n]4*35x' },
  '56A': { name: 'Intermediary Institution', pattern: '[[/1!a][/34x]\n]4!a2!a2!c[3!c]' },
  '56C': { name: 'Intermediary Institution', pattern: '/34x' },
  '56D': { name: 'Intermediary Institution', pattern: '[[/1!a][/34x]\n]4*35x' },
  '57A': { name: "Account With Institution", pattern: '[[/1!a][/34x]\n]4!a2!a2!c[3!c]' },
  '57B': { name: "Account With Institution", pattern: '[[/1!a][/34x]\n][35x]' },
  '57C': { name: "Account With Institution", pattern: '/34x' },
  '57D': { name: "Account With Institution", pattern: '[[/1!a][/34x]\n]4*35x' },
  '58A': { name: 'Beneficiary Institution', pattern: '[[/1!a][/34x]\n]4!a2!a2!c[3!c]' },
  '58D': { name: 'Beneficiary Institution', pattern: '[[/1!a][/34x]\n]4*35x' },

  // -- beneficiary customer (59a) -------------------------------------------
  '59': { name: 'Beneficiary Customer', pattern: '[/34x\n]4*35x' },
  '59A': { name: 'Beneficiary Customer', pattern: '[/34x\n]4!a2!a2!c[3!c]' },
  '59F': { name: 'Beneficiary Customer', pattern: '[/34x\n]4*35x', note: 'structured party, coded lines 1-3' },

  // -- narrative ------------------------------------------------------------
  '70': { name: 'Remittance Information', pattern: '4*35x' },
  '72': { name: 'Sender to Receiver Information', pattern: '6*35x' },
  '75': { name: 'Queries', pattern: '6*35x' },
  '76': { name: 'Answers', pattern: '6*35x' },
  '77A': { name: 'Narrative', pattern: '20*35x' },
  '77B': { name: 'Regulatory Reporting', pattern: '3*35x' },
  '77T': { name: 'Envelope Contents', pattern: '9000z' },
  '79': { name: 'Narrative Description of the Original Message', pattern: '35*50x' },

  // -- statements -----------------------------------------------------------
  '25': { name: 'Account Identification', pattern: '35x' },
  '25P': { name: 'Account Identification', pattern: '35x\n4!a2!a2!c[3!c]' },
  '28C': { name: 'Statement Number/Sequence Number', pattern: '5n[/5n]' },
  '28D': { name: 'Message Index/Total', pattern: '5n/5n' },
  '60F': { name: 'Opening Balance', pattern: '1!a6!n3!a15d' },
  '60M': { name: 'Intermediate Opening Balance', pattern: '1!a6!n3!a15d' },
  '61': {
    name: 'Statement Line',
    pattern: '6!n[4!n]2a[1!a]15d1!a3!c16x[//16x][\n34x]',
  },
  '62F': { name: 'Closing Balance', pattern: '1!a6!n3!a15d' },
  '62M': { name: 'Intermediate Closing Balance', pattern: '1!a6!n3!a15d' },
  '64': { name: 'Closing Available Balance', pattern: '1!a6!n3!a15d' },
  '65': { name: 'Forward Available Balance', pattern: '1!a6!n3!a15d' },
  '86': { name: 'Information to Account Owner', pattern: '6*65x' },
});

export function fieldFormat(tag: string): FieldFormat | undefined {
  return FIELD_FORMATS[tag];
}
