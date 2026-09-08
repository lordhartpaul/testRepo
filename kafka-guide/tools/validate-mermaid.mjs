import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
try { Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true }); } catch {}
globalThis.Element = dom.window.Element;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Text = dom.window.Text;
globalThis.self = dom.window;

const mermaid = (await import('mermaid')).default;
mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true });

function walk(dir, out=[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const root = process.argv[2];
const files = walk(root);
let total = 0, bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  let m; let idx = 0;
  while ((m = re.exec(src))) {
    idx++; total++;
    const line = src.slice(0, m.index).split('\n').length;
    try {
      await mermaid.parse(m[1]);
    } catch (err) {
      bad++;
      const msg = String(err.message || err).split('\n').slice(0, 3).join(' | ');
      console.log(`FAIL ${path.relative(root, f)}:${line} (diagram #${idx}): ${msg}`);
    }
  }
}
console.log(`Checked ${total} mermaid diagrams in ${files.length} files, ${bad} failed`);
process.exit(bad ? 1 : 0);
