import { DiagnosticCollector } from '../core/diagnostics.js';
import { deterministicUuid, isUetr, sanitiseId } from '../core/ids.js';
import type { ResolvedOptions } from '../core/options.js';
import type { MtField, MtMessage } from '../mt/message.js';
import { fieldsByNumber, headerTag } from '../mt/message.js';
import { resolveParty, type PartyKind, type SemanticParty } from '../semantic/party.js';

/**
 * State shared by a mapper while it walks one MT message.
 *
 * Beyond carrying options and diagnostics, the context records every field a
 * mapper reads. Whatever is left over at the end is data the target message has
 * no home for, and gets reported instead of quietly disappearing - the single
 * most common failure mode of a translation layer.
 */
export class MappingContext {
  readonly diagnostics = new DiagnosticCollector();
  private readonly used = new Set<string>();
  private readonly partyCache = new Map<string, SemanticParty | undefined>();

  constructor(
    readonly message: MtMessage,
    readonly options: ResolvedOptions,
    /** Fields the mapper should look at; defaults to the whole text block. */
    readonly scope: readonly MtField[] = message.block4,
  ) {}

  /** A context restricted to a sequence or repeating group. */
  withScope(scope: readonly MtField[]): MappingContext {
    const child = new MappingContext(this.message, this.options, scope);
    return child;
  }

  /** First field with the given numeric tag, marked as consumed. */
  field(number: string): MtField | undefined {
    const found = this.scope.find((f) => f.number === number);
    if (found) this.used.add(found.tag + ':' + found.index);
    return found;
  }

  /** All fields with the given numeric tag, marked as consumed. */
  fields(number: string): MtField[] {
    const found = this.scope.filter((f) => f.number === number);
    for (const field of found) this.used.add(field.tag + ':' + field.index);
    return found;
  }

  /** Trimmed value of a field, or undefined. */
  value(number: string): string | undefined {
    const found = this.field(number);
    const value = found?.value.trim();
    return value === '' ? undefined : value;
  }

  /** Value shortened to an ISO identifier length. */
  id(number: string, max = 35): string | undefined {
    const value = this.value(number);
    return value === undefined ? undefined : sanitiseId(value, max);
  }

  /** Resolve a party field (50a, 52a, 57a, ...) into its semantic form. */
  party(number: string, kind: PartyKind): SemanticParty | undefined {
    const cacheKey = `${number}:${kind}`;
    if (this.partyCache.has(cacheKey)) return this.partyCache.get(cacheKey);

    const found = this.field(number);
    if (!found) {
      this.partyCache.set(cacheKey, undefined);
      return undefined;
    }

    const party = resolveParty(found, { kind });
    this.diagnostics.absorb(party.diagnostics);
    this.partyCache.set(cacheKey, party);
    return party;
  }

  /** Mark a field as intentionally handled elsewhere. */
  consume(...numbers: string[]): void {
    for (const number of numbers) {
      for (const field of this.scope.filter((f) => f.number === number)) {
        this.used.add(field.tag + ':' + field.index);
      }
    }
  }

  /** Fields in scope that no mapper step read. */
  unused(): MtField[] {
    return this.scope.filter((f) => !this.used.has(f.tag + ':' + f.index));
  }

  get senderBic(): string | undefined {
    const block2 = this.message.block2;
    if (block2?.direction === 'output') return block2.senderBic;
    return this.message.block1?.senderBic;
  }

  get receiverBic(): string | undefined {
    const block2 = this.message.block2;
    return block2?.direction === 'input' ? block2.receiverBic : this.message.block1?.senderBic;
  }

  /** Message priority from the FIN application header. */
  get priority(): string | undefined {
    return this.message.block2?.priority;
  }

  /** True when the FIN trailer flags a possible duplicate emission. */
  get possibleDuplicate(): boolean {
    return this.message.block5?.tags['PDE'] !== undefined;
  }

  /**
   * Unique end-to-end transaction reference.
   *
   * gpi traffic carries it in `{3:{121:}}`. When it is absent, one is derived
   * from the message content so that reprocessing the same MT yields the same
   * UETR rather than a fresh random one.
   */
  uetr(): string | undefined {
    const carried = headerTag(this.message.block3, '121');
    if (carried && isUetr(carried)) return carried;

    if (carried) {
      this.diagnostics.warn({
        code: 'MT.HEADER.UETR_MALFORMED',
        mtTag: '121',
        mxPath: 'PmtId/UETR',
        message: `Header field 121 '${carried}' is not a lower case UUIDv4.`,
      });
    }

    if (this.options.uetr === 'omit') {
      this.diagnostics.info({
        code: 'MX.UETR_OMITTED',
        mxPath: 'PmtId/UETR',
        message: 'No UETR in the source message and UETR derivation is switched off.',
      });
      return undefined;
    }

    const seed = [
      this.senderBic ?? '',
      this.receiverBic ?? '',
      this.message.messageType ?? '',
      this.scope.find((f) => f.number === '20')?.value ?? '',
      this.scope.find((f) => f.number === '32')?.value ?? '',
    ].join('|');

    const derived = deterministicUuid(seed);
    this.diagnostics.warn({
      code: 'MX.UETR_DERIVED',
      mxPath: 'PmtId/UETR',
      message: `The source carries no UETR; ${derived} was derived from the message content.`,
      hint: 'Derivation is deterministic, so a replay of the same MT produces the same UETR.',
      confidenceCost: 0.04,
    });
    return derived;
  }

  /** Fields of the whole message rather than the current scope. */
  allFields(number: string): MtField[] {
    return fieldsByNumber(this.message, number);
  }
}
