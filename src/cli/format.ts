import { formatDiagnostic, type Diagnostic } from '../core/diagnostics.js';

/**
 * Terminal formatting helpers. Colour is only emitted when the stream is a TTY,
 * so piping the CLI into a file or another process yields clean text.
 */
const CSI = `${String.fromCharCode(27)}[`;
const RESET = `${CSI}0m`;

const SEVERITY_COLOUR: Readonly<Record<string, string>> = {
  fatal: `${CSI}41;97m`,
  error: `${CSI}31m`,
  warning: `${CSI}33m`,
  info: `${CSI}36m`,
};

export function bold(text: string): string {
  return process.stdout.isTTY ? `${CSI}1m${text}${RESET}` : text;
}

export function dim(text: string): string {
  return process.stdout.isTTY ? `${CSI}2m${text}${RESET}` : text;
}

export function colourDiagnostic(diagnostic: Diagnostic): string {
  const line = formatDiagnostic(diagnostic);
  if (!process.stderr.isTTY) return line;
  return `${SEVERITY_COLOUR[diagnostic.severity] ?? ''}${line}${RESET}`;
}
