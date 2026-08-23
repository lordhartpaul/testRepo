import { DiagnosticCollector, type Diagnostic } from '../core/diagnostics.js';
import { headerTag, type MtMessage } from '../mt/message.js';
import { MT_SCHEMAS, expandTag, schemaFor, tagNumber, type MtSchema } from '../mt/schemas.js';

/**
 * Message type detection.
 *
 * The application header normally states the message type, but it is missing
 * from files exported without their FIN envelope, from test harnesses, and from
 * anything that has been through a text editor. When it is absent - or when it
 * disagrees with what the message actually contains - the type is worked out
 * from the field composition instead.
 */

export interface DetectionCandidate {
  readonly messageType: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface Detection {
  readonly messageType?: string;
  /** Variant discriminator such as `COV`, `STP` or `REMIT`. */
  readonly variant?: string;
  readonly source: 'header' | 'content' | 'caller';
  readonly confidence: number;
  readonly candidates: readonly DetectionCandidate[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Field combinations that identify a message type on their own. `require` must
 * all be present and `forbid` must all be absent for the signature to fire.
 */
interface Signature {
  readonly messageType: string;
  readonly require: readonly string[];
  readonly forbid?: readonly string[];
  readonly weight: number;
  readonly description: string;
}

const SIGNATURES: readonly Signature[] = [
  {
    messageType: '103',
    require: ['23', '32', '50', '59', '71'],
    weight: 1,
    description: 'bank operation code with an ordering and a beneficiary customer',
  },
  {
    messageType: '202',
    require: ['21', '32', '58'],
    forbid: ['23', '71'],
    weight: 1,
    description: 'related reference with a beneficiary institution and no customer fields',
  },
  {
    messageType: '200',
    require: ['20', '32', '57'],
    forbid: ['21', '58', '59', '50'],
    weight: 0.9,
    description: 'value date and an account with institution but no counterparty',
  },
  {
    messageType: '210',
    require: ['20', '30', '21', '32'],
    forbid: ['71', '59'],
    weight: 1,
    description: 'a date field with repeating reference and amount sequences',
  },
  {
    messageType: '900',
    require: ['21', '25', '32'],
    forbid: ['50', '56', '28'],
    weight: 0.85,
    description: 'account identification with a single settlement amount',
  },
  {
    messageType: '910',
    require: ['21', '25', '32', '52'],
    forbid: ['28'],
    weight: 0.9,
    description: 'account identification with an ordering party',
  },
  {
    messageType: '940',
    require: ['25', '28', '60', '62'],
    weight: 1,
    description: 'statement number with opening and closing balances',
  },
  {
    messageType: '942',
    require: ['25', '28', '34', '13'],
    weight: 1,
    description: 'statement number with a floor limit and a cut-off time',
  },
  {
    messageType: '192',
    require: ['20', '21', '11'],
    weight: 1,
    description: 'a reference to the message type and date of an earlier message',
  },
  {
    messageType: '196',
    require: ['20', '21', '76'],
    weight: 1,
    description: 'an answers field referring to an earlier query',
  },
];

export interface DetectOptions {
  /** Message type supplied by the caller; overrides everything else. */
  readonly messageType?: string;
  /** Skip the cross-check of the header against the message content. */
  readonly trustHeader?: boolean;
}

export function detect(message: MtMessage, options: DetectOptions = {}): Detection {
  const diagnostics = new DiagnosticCollector();
  const candidates = scoreCandidates(message);
  const variant = detectVariant(message, diagnostics);

  if (options.messageType) {
    return {
      messageType: options.messageType,
      ...(variant ? { variant } : {}),
      source: 'caller',
      confidence: 1,
      candidates,
      diagnostics: diagnostics.all(),
    };
  }

  const headerType = message.messageType;
  if (headerType && /^\d{3}$/.test(headerType)) {
    const best = candidates[0];
    const supported = schemaFor(headerType) !== undefined;

    if (!supported) {
      diagnostics.warn({
        code: 'DETECT.UNSUPPORTED_TYPE',
        message: `The application header declares MT${headerType}, which this converter has no mapping for.`,
        hint: best ? `The field composition resembles MT${best.messageType}.` : undefined,
      });
    } else if (!options.trustHeader && best && best.messageType !== headerType && best.score > 0.8) {
      const declared = candidates.find((c) => c.messageType === headerType);
      if (!declared || best.score - declared.score > 0.25) {
        diagnostics.warn({
          code: 'DETECT.HEADER_CONTENT_MISMATCH',
          message: `The header declares MT${headerType} but the fields look like MT${best.messageType} (${best.reasons.join('; ')}).`,
          hint: 'The header is authoritative and was used; check the sending system if this is unexpected.',
        });
      }
    }

    return {
      messageType: headerType,
      ...(variant ? { variant } : {}),
      source: 'header',
      confidence: supported ? 1 : 0.5,
      candidates,
      diagnostics: diagnostics.all(),
    };
  }

  const best = candidates[0];
  const runnerUp = candidates[1];

  if (!best || best.score < 0.5) {
    diagnostics.fatal({
      code: 'DETECT.UNKNOWN',
      message: 'The message has no application header and its fields match no known message type.',
      hint: 'Pass the message type explicitly if it is known.',
    });
    return { source: 'content', confidence: 0, candidates, diagnostics: diagnostics.all() };
  }

  // Confidence reflects how far ahead the winner is: a clear win is trusted, a
  // near tie is reported so an operator can intervene.
  const margin = runnerUp ? best.score - runnerUp.score : best.score;
  const confidence = Math.max(0, Math.min(1, best.score * 0.7 + Math.min(margin, 0.3)));

  diagnostics.warn({
    code: 'DETECT.FROM_CONTENT',
    message: `No application header; MT${best.messageType} was inferred from the fields (${best.reasons.join('; ')}).`,
    hint: runnerUp
      ? `Next best match was MT${runnerUp.messageType} at ${(runnerUp.score * 100).toFixed(0)}%.`
      : undefined,
    confidenceCost: Math.max(0, 0.25 - margin),
  });

  return {
    messageType: best.messageType,
    ...(variant ? { variant } : {}),
    source: 'content',
    confidence,
    candidates,
    diagnostics: diagnostics.all(),
  };
}

/** Score every known schema against the fields actually present. */
export function scoreCandidates(message: MtMessage): DetectionCandidate[] {
  const present = new Set(message.block4.map((f) => f.number));

  const candidates = Object.values(MT_SCHEMAS).map((schema) => {
    const reasons: string[] = [];
    const coverage = mandatoryCoverage(schema, present, reasons);
    const signature = signatureScore(schema.type, present, reasons);
    const foreign = foreignFieldPenalty(schema, present, reasons);
    const score = Math.max(0, coverage * 0.55 + signature * 0.45 - foreign);
    return { messageType: schema.type, score: Number(score.toFixed(3)), reasons };
  });

  return candidates.sort((a, b) => b.score - a.score);
}

function mandatoryCoverage(
  schema: MtSchema,
  present: ReadonlySet<string>,
  reasons: string[],
): number {
  const mandatory = schema.entries.filter((entry) => entry.mandatory);
  if (mandatory.length === 0) return 0;

  const found = mandatory.filter((entry) => present.has(tagNumber(entry.tag)));
  const missing = mandatory.filter((entry) => !present.has(tagNumber(entry.tag)));
  if (missing.length > 0 && missing.length <= 3) {
    reasons.push(`missing mandatory ${missing.map((entry) => entry.tag).join(', ')}`);
  }
  return found.length / mandatory.length;
}

function signatureScore(
  messageType: string,
  present: ReadonlySet<string>,
  reasons: string[],
): number {
  const signature = SIGNATURES.find((s) => s.messageType === messageType);
  if (!signature) return 0;

  const required = signature.require.every((number) => present.has(number));
  const forbidden = (signature.forbid ?? []).some((number) => present.has(number));

  if (required && !forbidden) {
    reasons.push(signature.description);
    return signature.weight;
  }
  if (required && forbidden) {
    const clash = (signature.forbid ?? []).filter((number) => present.has(number));
    reasons.push(`carries ${clash.map((n) => `field ${n}`).join(', ')}, which this type does not use`);
    return signature.weight * 0.35;
  }
  return 0;
}

/** Fields the schema has no entry for, which argue against the candidate. */
function foreignFieldPenalty(
  schema: MtSchema,
  present: ReadonlySet<string>,
  reasons: string[],
): number {
  const allowed = new Set(schema.entries.flatMap((entry) => expandTag(entry.tag).map(tagNumber)));
  const foreign = [...present].filter((number) => !allowed.has(number));
  if (foreign.length === 0) return 0;
  if (foreign.length <= 2) reasons.push(`unexpected field ${foreign.join(', ')}`);
  return Math.min(0.4, foreign.length * 0.12);
}

/**
 * Variant detection.
 *
 * `{3:{119:}}` states the variant explicitly when the sender set it; otherwise
 * the message content decides - a sequence B in an MT202 makes it a COV, and
 * field 77T makes an MT103 a REMIT.
 */
export function detectVariant(
  message: MtMessage,
  diagnostics: DiagnosticCollector,
): string | undefined {
  const declared = headerTag(message.block3, '119')?.toUpperCase();
  const type = message.messageType;

  if (declared) {
    diagnostics.info({
      code: 'DETECT.VARIANT_FROM_HEADER',
      mtTag: '119',
      message: `The user header declares the ${declared} variant.`,
    });
    return declared;
  }

  const numbers = new Set(message.block4.map((f) => f.number));

  if ((type === '202' || type === '205' || type === undefined) && numbers.has('58') && numbers.has('50')) {
    diagnostics.info({
      code: 'DETECT.VARIANT_COV',
      message: 'A customer sequence (field 50a) follows the institution transfer, so this is a COV message.',
    });
    return 'COV';
  }

  if ((type === '103' || type === undefined) && numbers.has('77')) {
    const remit = message.block4.some((f) => f.tag === '77T');
    if (remit) {
      diagnostics.info({
        code: 'DETECT.VARIANT_REMIT',
        message: 'Field 77T is present, so this is an MT103 REMIT.',
      });
      return 'REMIT';
    }
  }

  return undefined;
}
