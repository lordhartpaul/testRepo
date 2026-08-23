import { formatDiagnostic, type Diagnostic } from '../core/diagnostics.js';
import { resolveOptions, type ConversionOptions, type ResolvedOptions } from '../core/options.js';
import { detect, type Detection } from '../intelligence/detector.js';
import { scoreConfidence, type ConfidenceReport } from '../intelligence/confidence.js';
import { MappingContext } from '../mapping/context.js';
import { selectMapper } from '../mapping/registry.js';
import type { Mapper } from '../mapping/mapper.js';
import type { MtMessage } from '../mt/message.js';
import { parseMt } from '../mt/parser.js';
import { businessApplicationHeader, businessMessage, document, priorityFromMt } from '../mx/documents.js';
import { serialise, type XmlElement } from '../mx/xml.js';
import { validateMt } from '../validation/mt-rules.js';
import { validateMx } from '../validation/mx-rules.js';

/**
 * The conversion pipeline.
 *
 *   parse -> detect -> validate MT -> map -> validate MX -> serialise
 *
 * Every stage contributes diagnostics to one list, and the pipeline keeps going
 * as far as it can: a message with an invalid IBAN still produces XML, marked
 * with the problem, because operations teams need to see what a message would
 * have become in order to fix it.
 */

export interface CoverageReport {
  readonly total: number;
  readonly mapped: number;
  /** Tags of fields the target message had no home for. */
  readonly unmapped: readonly string[];
}

export interface ConversionReport {
  /** True when nothing worse than a warning was raised (strict mode: nothing at all). */
  readonly ok: boolean;
  readonly xml?: string;
  readonly root?: XmlElement;
  readonly mxId?: string;
  readonly messageType?: string;
  readonly variant?: string;
  readonly detection: Detection;
  readonly message?: MtMessage;
  readonly diagnostics: readonly Diagnostic[];
  readonly confidence: ConfidenceReport;
  readonly coverage: CoverageReport;
  readonly rulesChecked: readonly string[];
}

export interface ConvertOptions extends ConversionOptions {
  /** Force a message type instead of detecting it. */
  readonly messageType?: string;
  /** Force a variant such as `COV`. */
  readonly variant?: string;
  /** Skip MT network rule validation. */
  readonly skipMtValidation?: boolean;
  /** Skip MX structural validation. */
  readonly skipMxValidation?: boolean;
}

export function convert(input: string, options: ConvertOptions = {}): ConversionReport {
  const resolved = resolveOptions(options);
  const diagnostics: Diagnostic[] = [];

  const parsed = parseMt(input);
  diagnostics.push(...parsed.diagnostics);
  const message = parsed.message;

  const detection = detect(message, {
    ...(options.messageType ? { messageType: options.messageType } : {}),
  });
  diagnostics.push(...detection.diagnostics);

  const emptyCoverage: CoverageReport = {
    total: message.block4.length,
    mapped: 0,
    unmapped: message.block4.map((f) => f.tag),
  };

  if (!detection.messageType) {
    return finish({ detection, diagnostics, coverage: emptyCoverage, message, resolved, rulesChecked: [] });
  }

  const variant = options.variant ?? detection.variant;
  const mapper = selectMapper(detection.messageType, variant);
  if (!mapper) {
    diagnostics.push({
      code: 'CONVERT.NO_MAPPER',
      severity: 'fatal',
      message: `MT${detection.messageType} has no mapping to an ISO 20022 message in this converter.`,
      hint: 'Run `mt2mx list` to see the supported conversions.',
      confidenceCost: 1,
    });
    return finish({
      detection,
      diagnostics,
      coverage: emptyCoverage,
      message,
      resolved,
      rulesChecked: [],
      messageType: detection.messageType,
      ...(variant ? { variant } : {}),
    });
  }

  let rulesChecked: readonly string[] = [];
  if (!options.skipMtValidation) {
    const validation = validateMt(message, detection.messageType);
    diagnostics.push(...validation.diagnostics);
    rulesChecked = validation.rulesChecked;
  }

  const context = new MappingContext(message, resolved);
  let root: XmlElement | undefined;
  try {
    root = mapper.map(context);
  } catch (error) {
    diagnostics.push({
      code: 'CONVERT.MAPPER_FAILED',
      severity: 'fatal',
      message: `The ${mapper.mxId} mapper failed: ${(error as Error).message}`,
      confidenceCost: 1,
    });
  }
  diagnostics.push(...context.diagnostics.all());

  const unmapped = context.unused();
  for (const field of unmapped) {
    diagnostics.push({
      code: 'MT.FIELD.UNMAPPED',
      severity: 'warning',
      mtTag: field.tag,
      message: `Field ${field.tag} has no equivalent in ${mapper.mxId} and was not carried over.`,
      confidenceCost: 0.05,
    });
  }

  const coverage: CoverageReport = {
    total: message.block4.length,
    mapped: message.block4.length - unmapped.length,
    unmapped: unmapped.map((f) => f.tag),
  };

  if (!root) {
    return finish({
      detection,
      diagnostics,
      coverage,
      message,
      resolved,
      rulesChecked,
      messageType: detection.messageType,
      ...(variant ? { variant } : {}),
      mxId: mapper.mxId,
    });
  }

  if (!options.skipMxValidation) {
    const validation = validateMx(root, mapper.mxId);
    diagnostics.push(...validation.diagnostics);
  }

  const xml = serialise(envelopeFor(root, mapper, context, resolved), { pretty: resolved.pretty });

  return finish({
    detection,
    diagnostics,
    coverage,
    message,
    resolved,
    rulesChecked,
    messageType: detection.messageType,
    ...(variant ? { variant } : {}),
    mxId: mapper.mxId,
    root,
    xml,
  });
}

function envelopeFor(
  root: XmlElement,
  mapper: Mapper,
  context: MappingContext,
  options: ResolvedOptions,
): XmlElement {
  const doc = document(mapper.mxId, root);
  if (options.envelope === 'document') return doc;

  const header = businessApplicationHeader({
    ...(context.senderBic ? { fromBic: context.senderBic } : {}),
    ...(context.receiverBic ? { toBic: context.receiverBic } : {}),
    businessMessageId:
      context.message.block4.find((f) => f.number === '20')?.value.trim().slice(0, 35) ??
      'NOTPROVIDED',
    messageDefinitionId: mapper.mxId,
    ...(options.businessService ? { businessService: options.businessService } : {}),
    creationDate: options.now,
    possibleDuplicate: context.possibleDuplicate,
    ...(priorityFromMt(context.priority) ? { priority: priorityFromMt(context.priority) as string } : {}),
  });
  return businessMessage(header, doc);
}

interface FinishInput {
  detection: Detection;
  diagnostics: Diagnostic[];
  coverage: CoverageReport;
  message: MtMessage;
  resolved: ResolvedOptions;
  rulesChecked: readonly string[];
  messageType?: string;
  variant?: string;
  mxId?: string;
  root?: XmlElement;
  xml?: string;
}

function finish(input: FinishInput): ConversionReport {
  const confidence = scoreConfidence({
    detection: input.detection,
    diagnostics: input.diagnostics,
    coverage: input.coverage,
  });

  const blocking = input.diagnostics.some((d) => d.severity === 'fatal' || d.severity === 'error');
  const anyWarning = input.diagnostics.some((d) => d.severity === 'warning');

  return {
    ok: input.xml !== undefined && !blocking && !(input.resolved.strict && anyWarning),
    ...(input.xml ? { xml: input.xml } : {}),
    ...(input.root ? { root: input.root } : {}),
    ...(input.mxId ? { mxId: input.mxId } : {}),
    ...(input.messageType ? { messageType: input.messageType } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
    detection: input.detection,
    message: input.message,
    diagnostics: input.diagnostics,
    confidence,
    coverage: input.coverage,
    rulesChecked: input.rulesChecked,
  };
}

/** Human readable one line per diagnostic, for logs and the CLI. */
export function formatReport(report: ConversionReport): string {
  const lines = [
    `${report.ok ? 'converted' : 'not converted'}: MT${report.messageType ?? '???'}${
      report.variant ? ` ${report.variant}` : ''
    } -> ${report.mxId ?? '(no target)'}`,
    `confidence ${(report.confidence.score * 100).toFixed(0)}% (${report.confidence.band})`,
    `coverage ${report.coverage.mapped}/${report.coverage.total} fields`,
  ];
  for (const diagnostic of report.diagnostics) lines.push(`  ${formatDiagnostic(diagnostic)}`);
  return lines.join('\n');
}
