import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
const EXAMPLES = fileURLToPath(new URL('../../examples/', import.meta.url));

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], input?: string): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('command line interface', () => {
  it('lists the supported conversions', () => {
    const result = run(['list']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /MT103\s+pacs\.008\.001\.08/);
  });

  it('converts a file to stdout', () => {
    const result = run(['convert', `${EXAMPLES}mt103.txt`, '--document', '--now', '2024-01-15T10:00:00Z']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /<FIToFICstmrCdtTrf>/);
  });

  it('reads from standard input', () => {
    const result = run(['convert', '-', '--document'], ':20:R\n:23B:CRED\n:32A:240115EUR1,00\n:50K:A\n:59:B\n:71A:SHA\n');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /pacs\.008\.001\.08/);
  });

  it('emits machine readable output', () => {
    const result = run(['convert', `${EXAMPLES}mt940.txt`, '--json']);
    const report = JSON.parse(result.stdout) as { ok: boolean; mxId: string; coverage: { total: number } };
    assert.equal(report.ok, true);
    assert.equal(report.mxId, 'camt.053.001.08');
    assert.ok(report.coverage.total > 0);
  });

  it('reports detection candidates', () => {
    const result = run(['detect', `${EXAMPLES}mt202cov.txt`]);
    assert.match(result.stdout, /MT202 COV from header/);
  });

  it('validates and exits non-zero on an error', () => {
    const result = run(['validate', '-'], ':20:/BAD/\n:23B:CRED\n:32A:240115EUR1,00\n:50K:A\n:59:B\n:71A:SHA\n');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MT\.RULE\.T26/);
  });

  it('converts a batch and counts the results', () => {
    const result = run(['batch', `${EXAMPLES}batch.txt`, '--now', '2024-01-15T10:00:00Z']);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /3\/3 converted/);
  });

  it('exits with a usage error for an unknown command or missing input', () => {
    assert.equal(run(['frobnicate']).status, 2);
    assert.equal(run(['convert']).status, 2);
    assert.equal(run([]).status, 2);
  });

  it('rejects an invalid option value', () => {
    const result = run(['convert', '-', '--address-format', 'sideways'], ':20:R\n');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /address-format/);
  });

  it('prints its version', () => {
    assert.match(run(['--version']).stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});
