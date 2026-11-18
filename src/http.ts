import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestId = crypto.randomBytes(16).toString('hex');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

export interface Ctx {
  method: string;
  path: string;
  segments: string[];
  query: URLSearchParams;
  host: string;
  body: Buffer;
  json(): unknown;
}

export function makeCtx(req: IncomingMessage, body: Buffer): Ctx {
  const method = req.method ?? 'GET';
  let urlObj: URL;
  const hostHeader = req.headers.host;
  const host = typeof hostHeader === 'string' && hostHeader.length > 0 ? hostHeader : 'localhost';
  try {
    urlObj = new URL(req.url ?? '/', `http://${host}`);
  } catch {
    urlObj = new URL('/', 'http://localhost');
  }

  const path = urlObj.pathname;
  const rawSegments = path.split('/');
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg.length > 0) {
      try {
        segments.push(decodeURIComponent(seg));
      } catch {
        segments.push(seg);
      }
    }
  }

  const query = urlObj.searchParams;

  return {
    method,
    path,
    segments,
    query,
    host,
    body,
    json() {
      if (!body || body.length === 0) {
        throw new HttpError(400, 'Malformed JSON');
      }
      try {
        const text = body.toString('utf8');
        return JSON.parse(text);
      } catch {
        throw new HttpError(400, 'Malformed JSON');
      }
    },
  };
}

export function notFound(): never {
  throw new HttpError(404, 'Not Found');
}
