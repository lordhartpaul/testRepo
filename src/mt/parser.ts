import { DiagnosticCollector, type Diagnostic } from '../core/diagnostics.js';
import {
  logicalTerminalToBic,
  type Block1,
  type Block2,
  type MtField,
  type MtMessage,
  type TaggedBlock,
} from './message.js';

export interface ParseResult {
  readonly message: MtMessage;
  readonly diagnostics: readonly Diagnostic[];
}

const FIELD_START = /^:(\d{2})([A-Z])?:/;

/**
 * Parse a SWIFT FIN message.
 *
 * The parser is deliberately forgiving: real traffic arrives with missing
 * trailers, CRLF or LF endings, RJE `$` separators and sometimes with nothing
 * but the text block. Anything unusual becomes a diagnostic rather than an
 * exception, so an operator always sees a partially parsed message.
 */
export function parseMt(input: string): ParseResult {
  const diagnostics = new DiagnosticCollector();
  const raw = normalise(input);

  const blocks = splitBlocks(raw, diagnostics);
  const bareBody = blocks.size === 0;

  const block1 = blocks.has('1') ? parseBlock1(blocks.get('1') as string, diagnostics) : undefined;
  const block2 = blocks.has('2') ? parseBlock2(blocks.get('2') as string, diagnostics) : undefined;
  const block3 = blocks.has('3') ? parseTaggedBlock(blocks.get('3') as string) : undefined;
  const block5 = blocks.has('5') ? parseTaggedBlock(blocks.get('5') as string) : undefined;

  const body = bareBody ? raw : (blocks.get('4') ?? '');
  if (!bareBody && !blocks.has('4')) {
    diagnostics.error({
      code: 'MT.PARSE.NO_TEXT_BLOCK',
      message: 'Message has header blocks but no text block {4:}.',
      hint: 'The text block carries every business field; without it nothing can be mapped.',
    });
  }

  const block4 = parseFields(body, diagnostics);
  if (block4.length === 0) {
    diagnostics.fatal({
      code: 'MT.PARSE.NO_FIELDS',
      message: 'No SWIFT fields (`:tag:value`) were found in the message.',
      hint: 'Check that the input is a FIN message and not, for example, an MX document.',
    });
  }

  const message: MtMessage = {
    raw,
    ...(block1 ? { block1 } : {}),
    ...(block2 ? { block2 } : {}),
    ...(block3 ? { block3 } : {}),
    block4,
    ...(block5 ? { block5 } : {}),
    ...(block2 ? { messageType: block2.messageType } : {}),
    bareBody,
  };

  return { message, diagnostics: diagnostics.all() };
}

function normalise(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^﻿/, '')
    .trim();
}

/**
 * Split the top level `{n:...}` blocks. Blocks 3 and 5 contain nested braces
 * and block 4 is terminated by the `-}` sentinel rather than a bare `}`.
 */
function splitBlocks(raw: string, diagnostics: DiagnosticCollector): Map<string, string> {
  const blocks = new Map<string, string>();
  let index = 0;

  while (index < raw.length) {
    if (raw[index] !== '{') {
      index += 1;
      continue;
    }
    const colon = raw.indexOf(':', index);
    if (colon === -1) break;
    const id = raw.slice(index + 1, colon);
    if (!/^[1-5S]$/.test(id)) {
      index += 1;
      continue;
    }

    const contentStart = colon + 1;
    let contentEnd: number;
    let nextIndex: number;

    if (id === '4') {
      const terminator = raw.indexOf('-}', contentStart);
      if (terminator === -1) {
        diagnostics.warn({
          code: 'MT.PARSE.UNTERMINATED_TEXT_BLOCK',
          message: 'Text block {4:} is not terminated by `-}`; parsed to end of input.',
        });
        const fallback = findMatchingBrace(raw, contentStart);
        contentEnd = fallback ?? raw.length;
        nextIndex = fallback === undefined ? raw.length : fallback + 1;
      } else {
        contentEnd = terminator;
        nextIndex = terminator + 2;
      }
    } else {
      const close = findMatchingBrace(raw, contentStart);
      if (close === undefined) {
        diagnostics.warn({
          code: 'MT.PARSE.UNTERMINATED_BLOCK',
          message: `Block {${id}:} is not closed; parsed to end of input.`,
        });
        contentEnd = raw.length;
        nextIndex = raw.length;
      } else {
        contentEnd = close;
        nextIndex = close + 1;
      }
    }

    const key = id === 'S' ? '5' : id;
    if (blocks.has(key)) {
      diagnostics.warn({
        code: 'MT.PARSE.DUPLICATE_BLOCK',
        message: `Block {${id}:} appears more than once; the first occurrence is used.`,
      });
    } else {
      blocks.set(key, raw.slice(contentStart, contentEnd));
    }
    index = nextIndex;
  }

  return blocks;
}

/** Index of the `}` matching the block opened before `from`, honouring nesting. */
function findMatchingBrace(raw: string, from: number): number | undefined {
  let depth = 0;
  for (let i = from; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return undefined;
}

function parseBlock1(raw: string, diagnostics: DiagnosticCollector): Block1 {
  const value = raw.trim();
  if (value.length < 25) {
    diagnostics.warn({
      code: 'MT.PARSE.BLOCK1_SHORT',
      message: `Basic header block is ${value.length} characters, expected 25.`,
    });
  }
  const logicalTerminal = value.slice(3, 15);
  const senderBic = logicalTerminalToBic(logicalTerminal);
  return {
    raw: value,
    applicationId: value.slice(0, 1),
    serviceId: value.slice(1, 3),
    logicalTerminal,
    sessionNumber: value.slice(15, 19),
    sequenceNumber: value.slice(19, 25),
    ...(senderBic ? { senderBic } : {}),
  };
}

function parseBlock2(raw: string, diagnostics: DiagnosticCollector): Block2 | undefined {
  const value = raw.trim();
  const direction = value.slice(0, 1).toUpperCase();
  const messageType = value.slice(1, 4);

  if (!/^\d{3}$/.test(messageType)) {
    diagnostics.warn({
      code: 'MT.PARSE.BLOCK2_MESSAGE_TYPE',
      message: `Application header does not carry a three digit message type (found '${messageType}').`,
      hint: 'The message type will be inferred from the field composition instead.',
    });
  }

  if (direction === 'I') {
    const receiverAddress = value.slice(4, 16);
    const receiverBic = logicalTerminalToBic(receiverAddress);
    const rest = value.slice(16);
    return {
      raw: value,
      direction: 'input',
      messageType,
      receiverAddress,
      ...(receiverBic ? { receiverBic } : {}),
      ...(rest.slice(0, 1) ? { priority: rest.slice(0, 1) } : {}),
      ...(rest.slice(1, 2) ? { deliveryMonitoring: rest.slice(1, 2) } : {}),
      ...(rest.slice(2, 5) ? { obsolescencePeriod: rest.slice(2, 5) } : {}),
    };
  }

  if (direction === 'O') {
    const inputTime = value.slice(4, 8);
    const mir = value.slice(8, 36);
    const senderBic = logicalTerminalToBic(mir.slice(6, 18));
    return {
      raw: value,
      direction: 'output',
      messageType,
      inputTime,
      ...(mir.length === 28
        ? {
            inputReference: {
              date: mir.slice(0, 6),
              logicalTerminal: mir.slice(6, 18),
              sessionNumber: mir.slice(18, 22),
              sequenceNumber: mir.slice(22, 28),
            },
          }
        : {}),
      ...(senderBic ? { senderBic } : {}),
      ...(value.slice(36, 42) ? { outputDate: value.slice(36, 42) } : {}),
      ...(value.slice(42, 46) ? { outputTime: value.slice(42, 46) } : {}),
      ...(value.slice(46, 47) ? { priority: value.slice(46, 47) } : {}),
    };
  }

  diagnostics.warn({
    code: 'MT.PARSE.BLOCK2_DIRECTION',
    message: `Application header direction '${direction}' is neither I nor O.`,
  });
  return undefined;
}

/** Parse `{108:REF}{121:uuid}` style blocks into a tag map. */
function parseTaggedBlock(raw: string): TaggedBlock {
  const tags: Record<string, string> = {};
  const pattern = /\{([0-9A-Z]{2,3}):([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    tags[match[1] as string] = (match[2] as string).trim();
  }
  return { raw: raw.trim(), tags: Object.freeze(tags) };
}

/**
 * Split a text block into fields. A field starts at a line matching
 * `:tag:`; every following line belongs to it until the next field starts.
 */
export function parseFields(body: string, diagnostics: DiagnosticCollector): MtField[] {
  const fields: MtField[] = [];
  const lines = body.split('\n');
  let current: { tag: string; number: string; option?: string; lines: string[] } | undefined;

  const flush = (): void => {
    if (!current) return;
    const valueLines = current.lines.map((line) => line.replace(/\s+$/, ''));
    while (valueLines.length > 1 && valueLines[valueLines.length - 1] === '') valueLines.pop();
    fields.push({
      tag: current.tag,
      number: current.number,
      ...(current.option ? { option: current.option } : {}),
      value: valueLines.join('\n'),
      lines: valueLines,
      index: fields.length,
    });
    current = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '-' || line === '$') continue; // RJE separators
    const match = FIELD_START.exec(line);
    if (match) {
      flush();
      const number = match[1] as string;
      const option = match[2];
      current = {
        tag: `${number}${option ?? ''}`,
        number,
        ...(option ? { option } : {}),
        lines: [line.slice((match[0] as string).length)],
      };
      continue;
    }
    if (current) {
      current.lines.push(line);
      continue;
    }
    if (line.trim() !== '') {
      diagnostics.info({
        code: 'MT.PARSE.ORPHAN_LINE',
        message: `Ignored text before the first field: '${truncate(line, 40)}'.`,
      });
    }
  }
  flush();
  return fields;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
