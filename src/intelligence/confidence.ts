import { SEVERITY_ORDER, type Diagnostic } from '../core/diagnostics.js';
import type { Detection } from './detector.js';

/**
 * Confidence scoring.
 *
 * A converted message is not simply valid or invalid: an MT103 whose type was
 * read from the header, whose every field mapped and which raised no
 * diagnostics deserves straight-through processing, while one whose type was
 * guessed and which dropped two fields needs a human. The score makes that
 * difference explicit and, importantly, shows which factors moved it.
 */

export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface ConfidenceFactor {
  readonly label: string;
  /** Signed contribution to the final score. */
  readonly impact: number;
  readonly detail: string;
}

export interface ConfidenceReport {
  readonly score: number;
  readonly band: ConfidenceBand;
  readonly factors: readonly ConfidenceFactor[];
}

export interface ConfidenceInput {
  readonly detection: Detection;
  readonly diagnostics: readonly Diagnostic[];
  readonly coverage: { readonly total: number; readonly mapped: number };
}

export function scoreConfidence(input: ConfidenceInput): ConfidenceReport {
  const factors: ConfidenceFactor[] = [];

  const detectionScore = input.detection.confidence;
  factors.push({
    label: 'message type detection',
    impact: detectionScore - 1,
    detail:
      input.detection.source === 'header'
        ? 'the type was read from the application header'
        : input.detection.source === 'caller'
          ? 'the type was supplied by the caller'
          : `the type was inferred from the field composition (${(detectionScore * 100).toFixed(0)}%)`,
  });

  let score = detectionScore;

  const bySeverity = new Map<string, { count: number; cost: number }>();
  for (const diagnostic of input.diagnostics) {
    const cost = diagnostic.confidenceCost ?? 0;
    const entry = bySeverity.get(diagnostic.severity) ?? { count: 0, cost: 0 };
    entry.count += 1;
    entry.cost += cost;
    bySeverity.set(diagnostic.severity, entry);
  }

  for (const severity of ['fatal', 'error', 'warning', 'info'] as const) {
    const entry = bySeverity.get(severity);
    if (!entry || entry.cost === 0) continue;
    score -= entry.cost;
    factors.push({
      label: `${severity} diagnostics`,
      impact: -entry.cost,
      detail: `${entry.count} ${severity}${entry.count === 1 ? '' : 's'} raised during conversion`,
    });
  }

  const coverage = input.coverage.total === 0 ? 1 : input.coverage.mapped / input.coverage.total;
  const coverageImpact = (coverage - 1) * 0.3;
  if (coverageImpact !== 0) {
    factors.push({
      label: 'field coverage',
      impact: coverageImpact,
      detail: `${input.coverage.mapped} of ${input.coverage.total} source fields were mapped`,
    });
  }
  score += coverageImpact;

  const bounded = Math.max(0, Math.min(1, Number(score.toFixed(3))));
  return { score: bounded, band: band(bounded, input.diagnostics), factors };
}

function band(score: number, diagnostics: readonly Diagnostic[]): ConfidenceBand {
  const worst = diagnostics.reduce(
    (acc, d) => (SEVERITY_ORDER[d.severity] > acc ? SEVERITY_ORDER[d.severity] : acc),
    0,
  );
  if (worst >= SEVERITY_ORDER.error) return 'low';
  if (score >= 0.9) return 'high';
  if (score >= 0.7) return 'medium';
  return 'low';
}
