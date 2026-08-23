import type { MtField, MtMessage } from './message.js';

/**
 * MT messages express structure by field order rather than by nesting, so the
 * converter reconstructs sequences and repeating groups from the flat field
 * list in block 4.
 */

export interface SplitSequences {
  readonly sequenceA: readonly MtField[];
  readonly sequenceB: readonly MtField[];
}

/**
 * Split a message at the first occurrence of `startNumber`.
 *
 * This is how an MT202 COV is separated into the bank-to-bank transfer
 * (sequence A) and the underlying customer credit transfer details
 * (sequence B, opened by field 50a).
 */
export function splitAt(message: MtMessage, startNumber: string): SplitSequences {
  const at = message.block4.findIndex((f) => f.number === startNumber);
  if (at === -1) return { sequenceA: message.block4, sequenceB: [] };
  return {
    sequenceA: message.block4.slice(0, at),
    sequenceB: message.block4.slice(at),
  };
}

/**
 * Collect repeating groups: a new group opens at every `startNumber` field and
 * absorbs the following fields whose numbers appear in `memberNumbers`.
 */
export function repeatingGroups(
  fields: readonly MtField[],
  startNumber: string,
  memberNumbers: readonly string[],
): MtField[][] {
  const groups: MtField[][] = [];
  let current: MtField[] | undefined;

  for (const field of fields) {
    if (field.number === startNumber) {
      current = [field];
      groups.push(current);
      continue;
    }
    if (current && memberNumbers.includes(field.number)) {
      current.push(field);
      continue;
    }
    current = undefined;
  }
  return groups;
}
