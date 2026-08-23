/**
 * A tiny XML document model tuned for ISO 20022.
 *
 * ISO 20022 messages are deeply optional: most of a mapper's work is "emit this
 * branch only if the source carried something". Rather than guarding every
 * element, mappers build the full shape and this module prunes any element that
 * ends up with no text and no surviving children, so `el('Dbtr', el('Nm', name))`
 * simply disappears when `name` is undefined.
 *
 * Child order is significant in ISO 20022 (the schemas use xs:sequence), so
 * children are kept exactly as written.
 */

export interface XmlElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | string;
export type XmlChild = XmlNode | number | undefined | null | false;

/** Build an element. Falsy children are dropped. */
export function el(name: string, ...children: XmlChild[]): XmlElement {
  return { kind: 'element', name, attributes: {}, children: compact(children) };
}

/** Build an element carrying attributes, e.g. `Amt Ccy="EUR"`. */
export function elA(
  name: string,
  attributes: Readonly<Record<string, string | undefined>>,
  ...children: XmlChild[]
): XmlElement {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== '') attrs[key] = value;
  }
  return { kind: 'element', name, attributes: attrs, children: compact(children) };
}

function compact(children: readonly XmlChild[]): XmlNode[] {
  const result: XmlNode[] = [];
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (typeof child === 'number') {
      result.push(String(child));
      continue;
    }
    if (typeof child === 'string') {
      if (child !== '') result.push(child);
      continue;
    }
    result.push(child);
  }
  return result;
}

/** Remove empty branches. Returns undefined when the whole element collapses. */
export function prune(node: XmlElement): XmlElement | undefined {
  const children: XmlNode[] = [];
  for (const child of node.children) {
    if (typeof child === 'string') {
      if (child.trim() !== '') children.push(child);
      continue;
    }
    const pruned = prune(child);
    if (pruned) children.push(pruned);
  }
  if (children.length === 0) return undefined;
  return { kind: 'element', name: node.name, attributes: node.attributes, children };
}

export interface SerialiseOptions {
  readonly pretty?: boolean;
  readonly indent?: string;
  readonly declaration?: boolean;
  /** Skip the empty-branch pruning pass (useful when debugging a mapper). */
  readonly keepEmpty?: boolean;
}

export function serialise(root: XmlElement, options: SerialiseOptions = {}): string {
  const { pretty = true, indent = '  ', declaration = true } = options;
  const tree = options.keepEmpty ? root : (prune(root) ?? el(root.name));
  const body = render(tree, pretty, indent, 0);
  return declaration ? `<?xml version="1.0" encoding="UTF-8"?>\n${body}` : body;
}

function render(node: XmlElement, pretty: boolean, indent: string, depth: number): string {
  const pad = pretty ? indent.repeat(depth) : '';
  const newline = pretty ? '\n' : '';
  const attributes = Object.entries(node.attributes)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join('');

  if (node.children.length === 0) {
    return `${pad}<${node.name}${attributes}/>`;
  }

  const onlyText = node.children.every((child) => typeof child === 'string');
  if (onlyText) {
    const text = node.children.map((child) => escapeText(child as string)).join('');
    return `${pad}<${node.name}${attributes}>${text}</${node.name}>`;
  }

  const inner = node.children
    .map((child) =>
      typeof child === 'string'
        ? `${pretty ? indent.repeat(depth + 1) : ''}${escapeText(child)}`
        : render(child, pretty, indent, depth + 1),
    )
    .join(newline);

  return `${pad}<${node.name}${attributes}>${newline}${inner}${newline}${pad}</${node.name}>`;
}

export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** Depth-first walk, used by the structural validator. */
export function walk(
  node: XmlElement,
  visit: (element: XmlElement, path: string) => void,
  parentPath = '',
): void {
  const path = parentPath === '' ? node.name : `${parentPath}/${node.name}`;
  visit(node, path);
  for (const child of node.children) {
    if (typeof child !== 'string') walk(child, visit, path);
  }
}

/** Concatenated text of an element, used for assertions and tests. */
export function textOf(node: XmlElement): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

/** First descendant matching a `/` separated path relative to `node`. */
export function find(node: XmlElement, path: string): XmlElement | undefined {
  const [head, ...rest] = path.split('/');
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.name !== head) continue;
    if (rest.length === 0) return child;
    const found = find(child, rest.join('/'));
    if (found) return found;
  }
  return undefined;
}

/** All descendants matching a `/` separated path relative to `node`. */
export function findAll(node: XmlElement, path: string): XmlElement[] {
  const [head, ...rest] = path.split('/');
  const result: XmlElement[] = [];
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.name !== head) continue;
    if (rest.length === 0) result.push(child);
    else result.push(...findAll(child, rest.join('/')));
  }
  return result;
}
