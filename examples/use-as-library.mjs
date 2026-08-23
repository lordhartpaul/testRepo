// Run with:  node examples/use-as-library.mjs
// (from the project root, after `npm run build`)
import { readFileSync } from 'node:fs';
import { convert, convertBatch, detect, parseMt, validateMt } from '../dist/src/index.js';

const mt = readFileSync(new URL('./mt103.txt', import.meta.url), 'utf8');

// ---------------------------------------------------------------- convert ---
// `now` is fixed so the output is reproducible; leave it out in production.
const report = convert(mt, { now: '2024-01-15T10:00:00Z' });

console.log('ok           ', report.ok);
console.log('message type ', `MT${report.messageType}`, report.variant ?? '');
console.log('target       ', report.mxId);
console.log('confidence   ', `${(report.confidence.score * 100).toFixed(0)}% (${report.confidence.band})`);
console.log('coverage     ', `${report.coverage.mapped}/${report.coverage.total} fields`);
console.log('unmapped     ', report.coverage.unmapped.length ? report.coverage.unmapped : '(none)');

// Every decision the converter made, with where it came from and where it went.
for (const d of report.diagnostics) {
  console.log(`  [${d.severity}] ${d.code}: ${d.message}`);
}

// report.xml holds the serialised business message.
console.log('\nfirst lines of the document:');
console.log(report.xml.split('\n').slice(0, 6).join('\n'));

// ----------------------------------------------------------------- detect ---
// Detection works without the FIN envelope: the fields alone decide.
const headerless = readFileSync(new URL('./mt103-headerless.txt', import.meta.url), 'utf8');
const detection = detect(parseMt(headerless).message);
console.log('\ndetected     ', `MT${detection.messageType} from ${detection.source}`);
console.log('runner up    ', detection.candidates[1]
  ? `MT${detection.candidates[1].messageType} at ${(detection.candidates[1].score * 100).toFixed(0)}%`
  : '(none)');

// --------------------------------------------------------------- validate ---
// MT validation on its own, without converting.
const broken = readFileSync(new URL('./mt103-invalid.txt', import.meta.url), 'utf8');
const validation = validateMt(parseMt(broken).message, '103');
const errors = validation.diagnostics.filter((d) => d.severity === 'error');
console.log(`\n${errors.length} rule violations in mt103-invalid.txt:`);
for (const d of errors) console.log(`  ${d.code} (${d.mtTag}): ${d.message}`);

// ------------------------------------------------------------------ batch ---
const batch = readFileSync(new URL('./batch.txt', import.meta.url), 'utf8');
const summary = convertBatch(batch, { now: '2024-01-15T10:00:00Z' });
console.log(`\nbatch: ${summary.converted}/${summary.total} converted, ` +
  `average confidence ${(summary.averageConfidence * 100).toFixed(0)}%`);
