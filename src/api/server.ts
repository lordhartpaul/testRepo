import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { convert, type ConversionReport, type ConvertOptions } from '../pipeline/converter.js';
import { convertBatch, splitMessages } from '../pipeline/batch.js';
import { detect } from '../intelligence/detector.js';
import { parseMt } from '../mt/parser.js';
import { supportedConversions } from '../mapping/registry.js';
import { validateMt } from '../validation/mt-rules.js';

/**
 * HTTP interface.
 *
 *   GET  /health        liveness probe
 *   GET  /conversions   the conversion catalogue
 *   POST /convert       one MT message in, one MX document out
 *   POST /batch         a file of MT messages in, a summary out
 *   POST /detect        message type detection only
 *   POST /validate      MT validation only
 *
 * A request body is either the raw MT text (`Content-Type: text/plain`) or JSON
 * of the form `{"message": "...", "options": { ... }}`. Responses are JSON
 * unless the client asks for `application/xml`, in which case a successful
 * conversion returns the document itself.
 */

export interface ServerOptions {
  readonly port?: number;
  readonly host?: string;
  /** Maximum accepted request body, in bytes. */
  readonly maxBodyBytes?: number;
  /** Options applied to every conversion unless the request overrides them. */
  readonly defaults?: ConvertOptions;
}

const DEFAULT_MAX_BODY = 5 * 1024 * 1024;

interface RequestPayload {
  readonly message: string;
  readonly options: ConvertOptions;
}

export function createApp(options: ServerOptions = {}): Server {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return createServer((request, response) => {
    handle(request, response, maxBody, options.defaults ?? {}).catch((error: unknown) => {
      sendJson(response, 500, {
        error: 'internal error',
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  maxBody: number,
  defaults: ConvertOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const route = `${request.method} ${url.pathname}`;

  if (route === 'GET /health') {
    sendJson(response, 200, { status: 'ok', conversions: supportedConversions().length });
    return;
  }

  if (route === 'GET /conversions') {
    sendJson(response, 200, { conversions: supportedConversions() });
    return;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: `${request.method} is not supported on ${url.pathname}` });
    return;
  }

  let payload: RequestPayload;
  try {
    payload = await readPayload(request, maxBody, defaults, url);
  } catch (error) {
    sendJson(response, 400, { error: (error as Error).message });
    return;
  }

  if (payload.message.trim() === '') {
    sendJson(response, 400, { error: 'the request body is empty' });
    return;
  }

  switch (url.pathname) {
    case '/convert': {
      const report = convert(payload.message, payload.options);
      if (wantsXml(request) && report.xml) {
        response.writeHead(report.ok ? 200 : 422, {
          'content-type': 'application/xml; charset=utf-8',
          'x-mt-type': report.messageType ?? 'unknown',
          'x-mx-id': report.mxId ?? 'unknown',
          'x-confidence': report.confidence.score.toFixed(3),
        });
        response.end(report.xml);
        return;
      }
      sendJson(response, report.ok ? 200 : 422, toJson(report));
      return;
    }

    case '/batch': {
      const summary = convertBatch(payload.message, payload.options);
      sendJson(response, summary.failed === 0 ? 200 : 422, {
        total: summary.total,
        converted: summary.converted,
        failed: summary.failed,
        averageConfidence: summary.averageConfidence,
        topDiagnostics: summary.topDiagnostics,
        items: summary.items.map((item) => ({ index: item.index, ...toJson(item.report) })),
      });
      return;
    }

    case '/detect': {
      const results = splitMessages(payload.message).map((raw, index) => {
        const { message } = parseMt(raw);
        const detection = detect(message);
        return {
          index,
          messageType: detection.messageType,
          variant: detection.variant,
          source: detection.source,
          confidence: detection.confidence,
          candidates: detection.candidates.slice(0, 5),
          diagnostics: detection.diagnostics,
        };
      });
      sendJson(response, 200, { results });
      return;
    }

    case '/validate': {
      const { message, diagnostics } = parseMt(payload.message);
      const forced = payload.options.messageType ?? detect(message).messageType;
      const validation = validateMt(message, forced);
      const all = [...diagnostics, ...validation.diagnostics];
      const errors = all.filter((d) => d.severity === 'error' || d.severity === 'fatal');
      sendJson(response, errors.length === 0 ? 200 : 422, {
        messageType: forced,
        valid: errors.length === 0,
        errorCount: errors.length,
        rulesChecked: validation.rulesChecked,
        diagnostics: all,
      });
      return;
    }

    default:
      sendJson(response, 404, { error: `no route for ${url.pathname}` });
  }
}

async function readPayload(
  request: IncomingMessage,
  maxBody: number,
  defaults: ConvertOptions,
  url: URL,
): Promise<RequestPayload> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBody) {
      request.destroy();
      throw new Error(`request body exceeds the ${maxBody} byte limit`);
    }
    chunks.push(chunk as Buffer);
  }

  const body = Buffer.concat(chunks).toString('utf8');
  const contentType = request.headers['content-type'] ?? '';
  const queryOptions = optionsFromQuery(url);

  if (contentType.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`the request body is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('the JSON body must be an object with a "message" property');
    }
    const record = parsed as { message?: unknown; options?: unknown };
    if (typeof record.message !== 'string') {
      throw new Error('the JSON body must carry the MT text in a "message" property');
    }
    return {
      message: record.message,
      options: { ...defaults, ...queryOptions, ...(record.options as ConvertOptions | undefined) },
    };
  }

  return { message: body, options: { ...defaults, ...queryOptions } };
}

/** A few conversion options can also be given as query parameters. */
function optionsFromQuery(url: URL): ConvertOptions {
  const type = url.searchParams.get('type');
  const variant = url.searchParams.get('variant');
  const envelope = url.searchParams.get('envelope');
  const addressFormat = url.searchParams.get('addressFormat');
  const now = url.searchParams.get('now');

  return {
    ...(type ? { messageType: type } : {}),
    ...(variant ? { variant } : {}),
    ...(envelope === 'document' || envelope === 'business-message' ? { envelope } : {}),
    ...(addressFormat === 'hybrid' || addressFormat === 'unstructured' || addressFormat === 'structured'
      ? { addressFormat }
      : {}),
    ...(now ? { now } : {}),
    ...(url.searchParams.get('strict') === 'true' ? { strict: true } : {}),
  };
}

function wantsXml(request: IncomingMessage): boolean {
  const accept = request.headers['accept'] ?? '';
  return accept.includes('application/xml') || accept.includes('text/xml');
}

function toJson(report: ConversionReport) {
  return {
    ok: report.ok,
    messageType: report.messageType,
    variant: report.variant,
    mxId: report.mxId,
    confidence: report.confidence,
    coverage: report.coverage,
    detection: {
      source: report.detection.source,
      confidence: report.detection.confidence,
      candidates: report.detection.candidates.slice(0, 3),
    },
    rulesChecked: report.rulesChecked,
    diagnostics: report.diagnostics,
    xml: report.xml,
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/** Start the server; used by `npm run serve` and by the Docker image. */
export function start(options: ServerOptions = {}): Server {
  const port = options.port ?? Number(process.env['PORT'] ?? 8080);
  const host = options.host ?? process.env['HOST'] ?? '0.0.0.0';
  const server = createApp(options);

  server.listen(port, host, () => {
    process.stdout.write(`mt2mx api listening on http://${host}:${port}\n`);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
  return server;
}

if (process.argv[1]?.endsWith('server.js') ?? false) {
  start();
}
