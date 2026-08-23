/** Structural model of a parsed SWIFT FIN (MT) message. */

export interface MtField {
  /** Full tag including option letter, e.g. `50K`. */
  readonly tag: string;
  /** Numeric part of the tag, e.g. `50`. */
  readonly number: string;
  /** Option letter when present, e.g. `K`. */
  readonly option?: string;
  /** Raw value with lines joined by `\n`. */
  readonly value: string;
  /** Value split into physical lines. */
  readonly lines: readonly string[];
  /** Zero based position within block 4, used for sequence detection. */
  readonly index: number;
}

export interface Block1 {
  readonly raw: string;
  readonly applicationId: string;
  readonly serviceId: string;
  readonly logicalTerminal: string;
  readonly sessionNumber: string;
  readonly sequenceNumber: string;
  /** BIC11 derived from the logical terminal address. */
  readonly senderBic?: string;
}

export interface MessageInputReference {
  readonly date: string;
  readonly logicalTerminal: string;
  readonly sessionNumber: string;
  readonly sequenceNumber: string;
}

export interface Block2Input {
  readonly raw: string;
  readonly direction: 'input';
  readonly messageType: string;
  readonly receiverAddress: string;
  readonly receiverBic?: string;
  readonly priority?: string;
  readonly deliveryMonitoring?: string;
  readonly obsolescencePeriod?: string;
}

export interface Block2Output {
  readonly raw: string;
  readonly direction: 'output';
  readonly messageType: string;
  readonly inputTime: string;
  readonly inputReference?: MessageInputReference;
  readonly senderBic?: string;
  readonly outputDate?: string;
  readonly outputTime?: string;
  readonly priority?: string;
}

export type Block2 = Block2Input | Block2Output;

export interface TaggedBlock {
  readonly raw: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface MtMessage {
  readonly raw: string;
  readonly block1?: Block1;
  readonly block2?: Block2;
  readonly block3?: TaggedBlock;
  readonly block4: readonly MtField[];
  readonly block5?: TaggedBlock;
  /** Three digit message type, resolved from block 2 when available. */
  readonly messageType?: string;
  /** True when the input carried no `{4:...}` envelope and was read as a bare field list. */
  readonly bareBody: boolean;
}

/** First field carrying `tag` (full tag, option included). */
export function field(message: MtMessage, tag: string): MtField | undefined {
  return message.block4.find((f) => f.tag === tag);
}

/** All fields whose numeric part is `number`, regardless of option. */
export function fieldsByNumber(message: MtMessage, number: string): MtField[] {
  return message.block4.filter((f) => f.number === number);
}

/**
 * First field whose numeric part is `number`. MT documentation writes these as
 * `50a`, meaning "field 50 in any of its options".
 */
export function fieldByNumber(message: MtMessage, number: string): MtField | undefined {
  return message.block4.find((f) => f.number === number);
}

export function hasField(message: MtMessage, number: string): boolean {
  return message.block4.some((f) => f.number === number);
}

/** Value of a `{3:}` or `{5:}` tag, e.g. `121` for the UETR. */
export function headerTag(block: TaggedBlock | undefined, tag: string): string | undefined {
  return block?.tags[tag];
}

/** Convert a 12 character logical terminal address into a BIC11. */
export function logicalTerminalToBic(address: string): string | undefined {
  if (address.length < 12) return undefined;
  const bic8 = address.slice(0, 8);
  const branch = address.slice(9, 12);
  return /^[A-Z]{6}[A-Z0-9]{2}$/.test(bic8) ? `${bic8}${branch}` : undefined;
}
