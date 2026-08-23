import { CHARSET_BODY, isCharsetCode, type CharsetCode } from './charsets.js';

/**
 * A compiler for SWIFT field format specifications such as:
 *
 *   `6!n3!a15d`                    value date / currency / amount  (field 32A)
 *   `[[/1!a][/34x]\n]4!a2!a2!c[3!c]` party identifier               (field 52A)
 *   `4*35x`                        four lines of up to 35 chars    (field 70)
 *
 * Grammar:
 *   node       := group | multiline | fixed | variable | decimal | literal
 *   group      := '[' node+ ']'          -- optional, may nest
 *   multiline  := digits '*' digits charset
 *   fixed      := digits '!' charset
 *   variable   := digits charset
 *   decimal    := digits 'd'
 *   literal    := any other character, `\n` standing for the CRLF separator
 *
 * Groups nest, which matters: `[/1!a][/34x]` has to accept `/D/1234`, `/1234`
 * and the empty string, so the two optional parts cannot collapse into one
 * all-or-nothing group.
 *
 * The compiler emits an anchored regular expression whose capture groups line
 * up with the pattern's value-bearing tokens, so one pass both validates a
 * field and slices it into components.
 */

export type TokenKind = 'fixed' | 'variable' | 'multiline' | 'decimal' | 'literal';

export interface PatternToken {
  readonly kind: TokenKind;
  readonly charset?: CharsetCode;
  /** Exact length for `fixed`, maximum length otherwise. */
  readonly length?: number;
  /** Maximum number of lines for `multiline`. */
  readonly lines?: number;
  readonly literal?: string;
}

interface GroupNode {
  readonly kind: 'group';
  readonly children: readonly PatternNode[];
}

type PatternNode = PatternToken | GroupNode;

function isGroup(node: PatternNode): node is GroupNode {
  return (node as GroupNode).kind === 'group';
}

export interface CompiledPattern {
  readonly source: string;
  readonly regex: RegExp;
  readonly nodes: readonly PatternNode[];
  /** Value-bearing tokens in capture order. */
  readonly captures: readonly PatternToken[];
}

export interface PatternMatch {
  readonly ok: boolean;
  /** Captured components in pattern order; absent optional parts yield ''. */
  readonly components: readonly string[];
  readonly error?: string;
}

const CACHE = new Map<string, CompiledPattern>();

export class PatternSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternSyntaxError';
  }
}

function parseNodes(pattern: string): readonly PatternNode[] {
  let index = 0;

  const readNumber = (): number => {
    let digits = '';
    while (index < pattern.length && /[0-9]/.test(pattern[index] as string)) {
      digits += pattern[index++];
    }
    if (digits.length === 0) throw new PatternSyntaxError(`expected a length at offset ${index}`);
    return Number(digits);
  };

  const readCharset = (): CharsetCode => {
    const charset = pattern[index++];
    if (charset === undefined || !isCharsetCode(charset)) {
      throw new PatternSyntaxError(`unknown character set '${charset ?? ''}' at offset ${index - 1}`);
    }
    return charset;
  };

  const parseSequence = (stopAtBracket: boolean): PatternNode[] => {
    const nodes: PatternNode[] = [];
    while (index < pattern.length) {
      const char = pattern[index] as string;

      if (char === ']') {
        if (!stopAtBracket) throw new PatternSyntaxError(`unbalanced ] at offset ${index}`);
        return nodes;
      }

      if (char === '[') {
        index += 1;
        const children = parseSequence(true);
        if (pattern[index] !== ']') throw new PatternSyntaxError('unbalanced [ in pattern');
        index += 1;
        nodes.push({ kind: 'group', children });
        continue;
      }

      if (/[0-9]/.test(char)) {
        const first = readNumber();
        if (pattern[index] === '*') {
          index += 1;
          const lineLength = readNumber();
          nodes.push({ kind: 'multiline', charset: readCharset(), length: lineLength, lines: first });
          continue;
        }
        const fixed = pattern[index] === '!';
        if (fixed) index += 1;
        const charset = readCharset();
        nodes.push({
          kind: charset === 'd' ? 'decimal' : fixed ? 'fixed' : 'variable',
          charset,
          length: first,
        });
        continue;
      }

      nodes.push({ kind: 'literal', literal: char });
      index += 1;
    }
    if (stopAtBracket) throw new PatternSyntaxError('unbalanced [ in pattern');
    return nodes;
  };

  const nodes = parseSequence(false);
  if (index !== pattern.length) throw new PatternSyntaxError('trailing characters in pattern');
  return nodes;
}

function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenRegex(token: PatternToken): string {
  switch (token.kind) {
    case 'literal':
      return escapeLiteral(token.literal as string);
    case 'fixed':
      return `([${CHARSET_BODY[token.charset as CharsetCode]}]{${token.length}})`;
    case 'variable':
      return `([${CHARSET_BODY[token.charset as CharsetCode]}]{1,${token.length}})`;
    case 'decimal': {
      // The mandatory decimal comma counts towards the maximum length, which is
      // re-checked after matching.
      const max = token.length as number;
      return `([0-9]{1,${Math.max(1, max - 1)}},[0-9]{0,${Math.max(0, max - 2)}})`;
    }
    case 'multiline': {
      const body = CHARSET_BODY[token.charset as CharsetCode];
      const per = token.length as number;
      const lines = Math.max(1, token.lines as number);
      return `([${body}]{1,${per}}(?:\\n[${body}]{1,${per}}){0,${lines - 1}})`;
    }
  }
}

function compileNodes(nodes: readonly PatternNode[], captures: PatternToken[]): string {
  let source = '';
  for (const node of nodes) {
    if (isGroup(node)) {
      source += `(?:${compileNodes(node.children, captures)})?`;
      continue;
    }
    if (node.kind !== 'literal') captures.push(node);
    source += tokenRegex(node);
  }
  return source;
}

export function compilePattern(pattern: string): CompiledPattern {
  const cached = CACHE.get(pattern);
  if (cached) return cached;

  const nodes = parseNodes(pattern);
  const captures: PatternToken[] = [];
  const source = compileNodes(nodes, captures);
  const compiled: CompiledPattern = {
    source: pattern,
    regex: new RegExp(`^${source}$`),
    nodes,
    captures,
  };
  CACHE.set(pattern, compiled);
  return compiled;
}

/** Validate `value` against `pattern` and slice out its components. */
export function matchPattern(pattern: string, value: string): PatternMatch {
  let compiled: CompiledPattern;
  try {
    compiled = compilePattern(pattern);
  } catch (error) {
    return {
      ok: false,
      components: [],
      error: `invalid format specification '${pattern}': ${(error as Error).message}`,
    };
  }

  const match = compiled.regex.exec(value);
  if (!match) {
    return { ok: false, components: [], error: `value does not match format ${pattern}` };
  }

  const components = compiled.captures.map((_, i) => match[i + 1] ?? '');

  for (let i = 0; i < compiled.captures.length; i += 1) {
    const token = compiled.captures[i] as PatternToken;
    const component = components[i] as string;
    if (token.kind === 'decimal' && component.length > (token.length as number)) {
      return {
        ok: false,
        components,
        error: `amount '${component}' exceeds the ${token.length} characters allowed by ${pattern}`,
      };
    }
  }

  return { ok: true, components };
}

/** Components of `value`, or `undefined` when it does not match `pattern`. */
export function extract(pattern: string, value: string): readonly string[] | undefined {
  const result = matchPattern(pattern, value);
  return result.ok ? result.components : undefined;
}

/** True when `value` satisfies `pattern`. */
export function matches(pattern: string, value: string): boolean {
  return matchPattern(pattern, value).ok;
}
