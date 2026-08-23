import { convert, type ConversionReport, type ConvertOptions } from './converter.js';

/**
 * Batch processing.
 *
 * MT traffic is usually stored many messages to a file, either in RJE format
 * (messages separated by a line containing `$`) or as concatenated FIN blocks.
 * Both layouts are recognised.
 */

export interface BatchItem {
  readonly index: number;
  readonly input: string;
  readonly report: ConversionReport;
}

export interface BatchSummary {
  readonly items: readonly BatchItem[];
  readonly total: number;
  readonly converted: number;
  readonly failed: number;
  readonly averageConfidence: number;
  /** Diagnostic codes ranked by how often they occurred. */
  readonly topDiagnostics: ReadonlyArray<{ readonly code: string; readonly count: number }>;
}

/** Split a file into individual MT messages. */
export function splitMessages(text: string): string[] {
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (normalised === '') return [];

  if (/^\$\s*$/m.test(normalised)) {
    return normalised
      .split(/^\$\s*$/m)
      .map((part) => part.trim())
      .filter((part) => part !== '');
  }

  const starts: number[] = [];
  const pattern = /(^|\n)\{1:/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalised)) !== null) {
    starts.push(match.index + (match[1] ? match[1].length : 0));
  }

  if (starts.length > 1) {
    return starts
      .map((start, i) => normalised.slice(start, starts[i + 1] ?? normalised.length).trim())
      .filter((part) => part !== '');
  }

  return [normalised];
}

export function convertBatch(text: string, options: ConvertOptions = {}): BatchSummary {
  const inputs = splitMessages(text);
  const items = inputs.map((input, index) => ({
    index,
    input,
    report: convert(input, options),
  }));

  const converted = items.filter((item) => item.report.ok).length;
  const totalConfidence = items.reduce((sum, item) => sum + item.report.confidence.score, 0);

  const counts = new Map<string, number>();
  for (const item of items) {
    for (const diagnostic of item.report.diagnostics) {
      counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
    }
  }

  return {
    items,
    total: items.length,
    converted,
    failed: items.length - converted,
    averageConfidence: items.length === 0 ? 0 : Number((totalConfidence / items.length).toFixed(3)),
    topDiagnostics: [...counts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}
