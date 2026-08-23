#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { convert, type ConversionReport, type ConvertOptions } from '../pipeline/converter.js';
import { convertBatch, splitMessages } from '../pipeline/batch.js';
import { detect } from '../intelligence/detector.js';
import { parseMt } from '../mt/parser.js';
import { supportedConversions } from '../mapping/registry.js';
import { validateMt } from '../validation/mt-rules.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { bold, colourDiagnostic, dim } from './format.js';

/**
 * Command line interface.
 *
 *   mt2mx convert  <file|->   translate one message
 *   mt2mx batch    <file|->   translate a file of messages
 *   mt2mx detect   <file|->   report the detected type and the runners up
 *   mt2mx validate <file|->   run MT validation without converting
 *   mt2mx list                show the supported conversions
 */

const VERSION = '1.0.0';

const USAGE = `mt2mx ${VERSION} - SWIFT MT to ISO 20022 (MX) converter

Usage:
  mt2mx convert  <file|-> [options]
  mt2mx batch    <file|-> [options]
  mt2mx detect   <file|->
  mt2mx validate <file|-> [--type <mt>]
  mt2mx list

Options:
  --out <file>          write the XML to a file instead of stdout
  --out-dir <dir>       (batch) write one file per message into this directory
  --type <mt>           force the MT type, e.g. 103, instead of detecting it
  --variant <name>      force the variant, e.g. COV
  --document            emit a bare <Document> instead of a business message envelope
  --address-format <f>  hybrid (default), unstructured or structured
  --no-uetr             do not derive a UETR when the source has none
  --now <timestamp>     ISO timestamp for creation dates (makes output reproducible)
  --reference-year <y>  year used to resolve two digit dates
  --strict              treat warnings as failures
  --compact             do not indent the XML
  --json                machine readable output
  --quiet               only print errors
  -h, --help            show this help
  -v, --version         show the version

Exit codes: 0 success, 1 conversion problem, 2 usage error.
`;

interface ParsedArgs {
  readonly command?: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

const VALUE_FLAGS = ['out', 'out-dir', 'type', 'variant', 'address-format', 'now', 'reference-year'];

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i] as string;
    if (!argument.startsWith('-') || argument === '-') {
      positional.push(argument);
      continue;
    }
    const [name, inlineValue] = argument.replace(/^--?/, '').split('=', 2);
    const key = name as string;
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (VALUE_FLAGS.includes(key) && next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return {
    ...(positional[0] ? { command: positional[0] } : {}),
    positional: positional.slice(1),
    flags,
  };
}

function readInput(source: string | undefined): string {
  if (source === undefined) {
    fail('no input given; pass a file path or `-` to read standard input');
  }
  try {
    return source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  } catch (error) {
    return fail(`cannot read ${source === '-' ? 'standard input' : source}: ${(error as Error).message}`);
  }
}

function fail(message: string): never {
  process.stderr.write(`mt2mx: ${message}\n`);
  process.exit(2);
}

function conversionOptions(flags: ParsedArgs['flags']): ConvertOptions {
  const addressFormat = flags['address-format'];
  if (
    typeof addressFormat === 'string' &&
    !['hybrid', 'unstructured', 'structured'].includes(addressFormat)
  ) {
    fail('--address-format must be hybrid, unstructured or structured');
  }

  const referenceYear = flags['reference-year'];
  if (typeof referenceYear === 'string' && !/^\d{4}$/.test(referenceYear)) {
    fail('--reference-year must be a four digit year');
  }

  return {
    ...(typeof flags['type'] === 'string' ? { messageType: flags['type'] } : {}),
    ...(typeof flags['variant'] === 'string' ? { variant: flags['variant'] } : {}),
    ...(flags['document'] ? { envelope: 'document' as const } : {}),
    ...(typeof addressFormat === 'string'
      ? { addressFormat: addressFormat as 'hybrid' | 'unstructured' | 'structured' }
      : {}),
    ...(flags['no-uetr'] ? { uetr: 'omit' as const } : {}),
    ...(typeof flags['now'] === 'string' ? { now: flags['now'] } : {}),
    ...(typeof referenceYear === 'string' ? { referenceYear: Number(referenceYear) } : {}),
    ...(flags['strict'] ? { strict: true } : {}),
    ...(flags['compact'] ? { pretty: false } : {}),
  };
}

function printDiagnostics(diagnostics: readonly Diagnostic[], quiet: boolean): void {
  const shown = quiet
    ? diagnostics.filter((d) => d.severity === 'error' || d.severity === 'fatal')
    : diagnostics;
  for (const diagnostic of shown) process.stderr.write(`${colourDiagnostic(diagnostic)}\n`);
}

function summaryLine(report: ConversionReport): string {
  return dim(
    `MT${report.messageType ?? '???'}${report.variant ? ` ${report.variant}` : ''} -> ${
      report.mxId ?? '(no target)'
    }, confidence ${(report.confidence.score * 100).toFixed(0)}% (${report.confidence.band}), ` +
      `${report.coverage.mapped}/${report.coverage.total} fields mapped`,
  );
}

function commandConvert(args: ParsedArgs): number {
  const input = readInput(args.positional[0]);
  const report = convert(input, conversionOptions(args.flags));

  if (args.flags['json']) {
    process.stdout.write(`${JSON.stringify(reportToJson(report), null, 2)}\n`);
    return report.ok ? 0 : 1;
  }

  printDiagnostics(report.diagnostics, Boolean(args.flags['quiet']));

  if (!report.xml) {
    process.stderr.write('mt2mx: the message could not be converted\n');
    return 1;
  }

  const out = args.flags['out'];
  if (typeof out === 'string') {
    writeFileSync(out, `${report.xml}\n`);
    if (!args.flags['quiet']) {
      process.stderr.write(`${bold('written')} ${out} ${summaryLine(report)}\n`);
    }
  } else {
    process.stdout.write(`${report.xml}\n`);
    if (!args.flags['quiet']) process.stderr.write(`${summaryLine(report)}\n`);
  }

  return report.ok ? 0 : 1;
}

function commandBatch(args: ParsedArgs): number {
  const input = readInput(args.positional[0]);
  const summary = convertBatch(input, conversionOptions(args.flags));

  if (args.flags['json']) {
    process.stdout.write(
      `${JSON.stringify(
        {
          total: summary.total,
          converted: summary.converted,
          failed: summary.failed,
          averageConfidence: summary.averageConfidence,
          topDiagnostics: summary.topDiagnostics,
          items: summary.items.map((item) => reportToJson(item.report)),
        },
        null,
        2,
      )}\n`,
    );
    return summary.failed === 0 ? 0 : 1;
  }

  const outDir = args.flags['out-dir'];
  if (typeof outDir === 'string') mkdirSync(outDir, { recursive: true });

  for (const item of summary.items) {
    const status = item.report.ok ? 'ok  ' : 'FAIL';
    process.stderr.write(`${status} #${item.index + 1} ${summaryLine(item.report)}\n`);
    if (!item.report.ok) printDiagnostics(item.report.diagnostics, true);

    if (!item.report.xml) continue;
    if (typeof outDir === 'string') {
      const name = `${String(item.index + 1).padStart(4, '0')}-mt${item.report.messageType ?? 'unknown'}.xml`;
      writeFileSync(join(outDir, name), `${item.report.xml}\n`);
    } else {
      process.stdout.write(`${item.report.xml}\n`);
    }
  }

  process.stderr.write(
    `\n${bold(`${summary.converted}/${summary.total} converted`)}, average confidence ${(
      summary.averageConfidence * 100
    ).toFixed(0)}%\n`,
  );
  return summary.failed === 0 ? 0 : 1;
}

function commandDetect(args: ParsedArgs): number {
  const input = readInput(args.positional[0]);
  const results = splitMessages(input).map((raw, index) => {
    const { message } = parseMt(raw);
    return { index, detection: detect(message) };
  });

  if (args.flags['json']) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }

  for (const { index, detection } of results) {
    process.stdout.write(
      `${bold(`#${index + 1}`)} MT${detection.messageType ?? '???'}${
        detection.variant ? ` ${detection.variant}` : ''
      } from ${detection.source}, confidence ${(detection.confidence * 100).toFixed(0)}%\n`,
    );
    for (const candidate of detection.candidates.slice(0, 3)) {
      process.stdout.write(
        `   ${dim(
          `MT${candidate.messageType} ${(candidate.score * 100).toFixed(0).padStart(3)}%  ${
            candidate.reasons.join('; ') || 'no distinguishing fields'
          }`,
        )}\n`,
      );
    }
    printDiagnostics(detection.diagnostics, false);
  }
  return 0;
}

function commandValidate(args: ParsedArgs): number {
  const input = readInput(args.positional[0]);
  const { message, diagnostics } = parseMt(input);
  const forced = typeof args.flags['type'] === 'string' ? args.flags['type'] : undefined;
  const validation = validateMt(message, forced ?? detect(message).messageType);
  const all = [...diagnostics, ...validation.diagnostics];
  const errors = all.filter((d) => d.severity === 'error' || d.severity === 'fatal').length;

  if (args.flags['json']) {
    process.stdout.write(
      `${JSON.stringify({ errors, diagnostics: all, rulesChecked: validation.rulesChecked }, null, 2)}\n`,
    );
  } else {
    printDiagnostics(all, Boolean(args.flags['quiet']));
    process.stdout.write(
      `${errors === 0 ? 'valid' : `${errors} error(s)`} - checked network rules ${
        validation.rulesChecked.join(', ') || '(none)'
      }\n`,
    );
  }

  return errors === 0 ? 0 : 1;
}

function commandList(args: ParsedArgs): number {
  const conversions = supportedConversions();
  if (args.flags['json']) {
    process.stdout.write(`${JSON.stringify(conversions, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${bold('MT'.padEnd(12))}${bold('MX'.padEnd(20))}${bold('description')}\n`);
  for (const conversion of conversions) {
    const mt = `MT${conversion.mt}${conversion.variant ? ` ${conversion.variant}` : ''}`;
    process.stdout.write(`${mt.padEnd(12)}${conversion.mx.padEnd(20)}${conversion.description}\n`);
  }
  return 0;
}

function reportToJson(report: ConversionReport) {
  return {
    ok: report.ok,
    messageType: report.messageType,
    variant: report.variant,
    mxId: report.mxId,
    detection: {
      source: report.detection.source,
      confidence: report.detection.confidence,
      candidates: report.detection.candidates.slice(0, 3),
    },
    confidence: report.confidence,
    coverage: report.coverage,
    rulesChecked: report.rulesChecked,
    diagnostics: report.diagnostics,
    xml: report.xml,
  };
}

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);

  if (args.flags['version'] || args.flags['v']) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.flags['help'] || args.flags['h'] || !args.command) {
    process.stdout.write(USAGE);
    return args.command ? 0 : 2;
  }

  switch (args.command) {
    case 'convert':
      return commandConvert(args);
    case 'batch':
      return commandBatch(args);
    case 'detect':
      return commandDetect(args);
    case 'validate':
      return commandValidate(args);
    case 'list':
      return commandList(args);
    default:
      process.stderr.write(`mt2mx: unknown command '${args.command}'\n\n${USAGE}`);
      return 2;
  }
}

if (process.argv[1]?.endsWith('main.js') ?? false) {
  process.exitCode = run(process.argv.slice(2));
}
