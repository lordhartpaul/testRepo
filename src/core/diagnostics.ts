/**
 * Diagnostics are the backbone of the converter's "explainability": every
 * inference, fallback, truncation and validation failure is recorded with a
 * stable code, the MT field it came from and the MX path it landed on.
 */

export type Severity = 'fatal' | 'error' | 'warning' | 'info';

export const SEVERITY_ORDER: Record<Severity, number> = {
  fatal: 3,
  error: 2,
  warning: 1,
  info: 0,
};

export interface Diagnostic {
  /** Stable, greppable identifier, e.g. `MT.PARSE.UNTERMINATED_BLOCK`. */
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  /** Source MT field tag including option, e.g. `50K`. */
  readonly mtTag?: string;
  /** Target MX element path, e.g. `CdtTrfTxInf/Dbtr/Nm`. */
  readonly mxPath?: string;
  /** What a human should do about it. */
  readonly hint?: string;
  /** How much confidence this costs, 0..1. */
  readonly confidenceCost?: number;
}

export interface DiagnosticInit extends Omit<Diagnostic, 'severity' | 'code'> {
  code: string;
}

/** Default confidence cost per severity when a diagnostic does not set one. */
const DEFAULT_COST: Record<Severity, number> = {
  fatal: 1,
  error: 0.35,
  warning: 0.08,
  info: 0,
};

export class DiagnosticCollector {
  private readonly items: Diagnostic[] = [];

  add(severity: Severity, init: DiagnosticInit): Diagnostic {
    const diagnostic: Diagnostic = {
      ...init,
      severity,
      confidenceCost: init.confidenceCost ?? DEFAULT_COST[severity],
    };
    this.items.push(diagnostic);
    return diagnostic;
  }

  fatal(init: DiagnosticInit): Diagnostic {
    return this.add('fatal', init);
  }

  error(init: DiagnosticInit): Diagnostic {
    return this.add('error', init);
  }

  warn(init: DiagnosticInit): Diagnostic {
    return this.add('warning', init);
  }

  info(init: DiagnosticInit): Diagnostic {
    return this.add('info', init);
  }

  /** Merge diagnostics produced by a nested stage. */
  absorb(other: readonly Diagnostic[]): void {
    this.items.push(...other);
  }

  all(): readonly Diagnostic[] {
    return this.items;
  }

  bySeverity(severity: Severity): Diagnostic[] {
    return this.items.filter((d) => d.severity === severity);
  }

  worst(): Severity | undefined {
    let worst: Severity | undefined;
    for (const item of this.items) {
      if (worst === undefined || SEVERITY_ORDER[item.severity] > SEVERITY_ORDER[worst]) {
        worst = item.severity;
      }
    }
    return worst;
  }

  hasBlocking(): boolean {
    return this.items.some((d) => d.severity === 'fatal' || d.severity === 'error');
  }

  hasFatal(): boolean {
    return this.items.some((d) => d.severity === 'fatal');
  }

  has(code: string): boolean {
    return this.items.some((d) => d.code === code);
  }

  get length(): number {
    return this.items.length;
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = [d.mtTag ? `:${d.mtTag}:` : undefined, d.mxPath].filter(Boolean).join(' -> ');
  const suffix = where ? ` (${where})` : '';
  const hint = d.hint ? ` Hint: ${d.hint}` : '';
  return `[${d.severity.toUpperCase()}] ${d.code}: ${d.message}${suffix}${hint}`;
}
