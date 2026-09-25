/**
 * @fileoverview The source-download timeouts (issue #47), over a real local HTTP
 * server. The headers bound ends a download whose server never answers, as a
 * timeout naming the source; once headers arrive it is spent, and the body
 * drains for as long as the transfer runs, until it ends or the caller's signal
 * aborts it.
 *
 * `fetchSourceDownload` is driven with a short headers bound in real time. The
 * two call sites — a sanctions harvest and a GLEIF golden-copy stream — run at
 * the production bound under fake timers, with the body held open across it.
 * @module tests/services/source-fetch.test
 */

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { streamLeiLevel1 } from '@/services/screening/gleif-ingest.js';
import { buildSanctionsIngesters } from '@/services/screening/sanctions-ingest.js';
import {
  fetchSourceDownload,
  SOURCE_HEADERS_TIMEOUT_MS,
} from '@/services/screening/source-fetch.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let handler: Handler;
/** Interval timers a handler started — real timers, cleared after each test. */
const intervals: NodeJS.Timeout[] = [];

beforeEach(async () => {
  server = createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const interval of intervals.splice(0)) clearInterval(interval);
  server.closeAllConnections();
  server.close();
});

/** Send `chunks` one per `everyMs` after the headers, then end the response. */
function trickle(chunks: readonly string[], everyMs: number): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml' });
    let next = 0;
    const interval = setInterval(() => {
      const chunk = chunks[next++];
      if (chunk === undefined) {
        clearInterval(interval);
        res.end();
        return;
      }
      res.write(chunk);
    }, everyMs);
    intervals.push(interval);
  };
}

/** A small document split into `count` chunks. */
function trickledDocument(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    i === 0 ? '<doc>' : i === count - 1 ? '</doc>' : `<a>${i}</a>`,
  );
}

const PENDING = Symbol('pending');

/** Resolve `promise`, or PENDING if it has not settled within `ms` of real time. */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  return Promise.race([
    promise,
    new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms)),
  ]);
}

function download(
  path: string,
  signal: AbortSignal = new AbortController().signal,
  headersTimeoutMs = 300,
): Promise<Response> {
  return fetchSourceDownload(`${base}${path}`, {
    source: 'test-list',
    signal,
    headersTimeoutMs,
    context: requestContextService.createRequestContext({ operation: 'source-fetch-test' }),
  });
}

async function failureOf(promise: Promise<unknown>): Promise<Error & { code?: number }> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (err: Error & { code?: number }) => err,
  );
}

describe('fetchSourceDownload', () => {
  it('drains a body that keeps arriving long after the headers bound', async () => {
    const chunks = trickledDocument(24);
    handler = trickle(chunks, 50);

    const started = performance.now();
    const response = await download('/doc.xml');
    const text = await response.text();

    expect(text).toBe(chunks.join(''));
    // The transfer ran well past the 300 ms bound.
    expect(performance.now() - started).toBeGreaterThan(1000);
  });

  it('fails a download whose headers never arrive as a timeout naming the source', async () => {
    handler = () => {
      // The request is read; nothing is ever sent back.
    };

    const started = performance.now();
    const error = await failureOf(download('/doc.xml'));

    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe('test-list sent no response headers within 0.3 s.');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('keeps a caller abort during the headers wait a cancellation', async () => {
    handler = () => {
      // Never answers.
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const error = await failureOf(download('/doc.xml', controller.signal));

    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('ends the body read at a caller abort, as a cancellation', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.write('<doc><a>1</a>');
      // The transfer stalls here, the connection held open.
    };
    const controller = new AbortController();

    const response = await download('/doc.xml', controller.signal, 60_000);
    const body = response.text();
    expect(await settledWithin(body, 400)).toBe(PENDING);
    controller.abort();

    const error = await failureOf(body);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it("keeps the framework's status mapping for a non-2xx answer", async () => {
    handler = (_req, res) => {
      res.writeHead(404).end('gone');
    };

    const error = await failureOf(download('/doc.xml'));

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
  });
});

describe('source downloads past the production headers bound', () => {
  /** Resolves when the server has sent the headers and the first chunk. */
  let firstChunkSent: Promise<void>;
  /** Sends the rest of the document and ends the response. */
  let finish: () => void;

  /** Serve `head`, hold the transfer open, then send `tail` on `finish()`. */
  function holdOpen(head: string, tail: string): void {
    let sent: () => void = () => undefined;
    firstChunkSent = new Promise((resolve) => {
      sent = resolve;
    });
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.write(head, () => sent());
      finish = () => res.end(tail);
    };
  }

  /**
   * The real `fetch`, reporting when a response's headers have arrived — so the
   * clock is advanced only once the download is past its headers wait.
   */
  function watchHeaders(): Promise<void> {
    const realFetch = globalThis.fetch;
    return new Promise((resolve) => {
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await realFetch(...args);
        resolve();
        return response;
      });
    });
  }

  /**
   * Drain `source` to the key of each item, or to the error that ended it —
   * settled either way, so a failure mid-drain waits for the assertion.
   */
  async function outcome<T>(
    source: AsyncIterable<T>,
    key: (item: T) => string,
  ): Promise<{ items: string[] } | { error: unknown }> {
    const items: string[] = [];
    try {
      for await (const item of source) items.push(key(item));
      return { items };
    } catch (error) {
      return { error };
    }
  }

  /** Let the download settle what follows its headers — real time, not faked. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    delete process.env.UN_SC_URL;
    resetServerConfig();
  });

  it('lets a sanctions harvest drain a transfer that outlasts the headers bound', async () => {
    const document =
      '<?xml version="1.0"?><CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL><DATAID>UN-47</DATAID><FIRST_NAME>SLOW</FIRST_NAME><SECOND_NAME>TRANSFER</SECOND_NAME></INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>';
    const split = document.indexOf('<SECOND_NAME>');
    holdOpen(document.slice(0, split), document.slice(split));
    process.env.UN_SC_URL = `${base}/un.xml`;
    resetServerConfig();
    const un = buildSanctionsIngesters().find((ingester) => ingester.source === 'un');
    if (!un) throw new Error('no UN ingester');
    const headersArrived = watchHeaders();

    const harvested = outcome(un.harvest(new AbortController().signal), (d) => d.id);
    await Promise.all([headersArrived, firstChunkSent]);
    await flush();
    await vi.advanceTimersByTimeAsync(SOURCE_HEADERS_TIMEOUT_MS + 60_000);
    finish();

    expect(await harvested).toEqual({ items: ['un:UN-47'] });
  });

  it('lets a GLEIF golden-copy stream drain a transfer that outlasts the headers bound', async () => {
    const record = (lei: string, name: string) =>
      `<LEIRecord><LEI>${lei}</LEI><Entity><LegalName>${name}</LegalName></Entity></LEIRecord>`;
    holdOpen(
      `<?xml version="1.0"?><LEIData><LEIRecords>${record('5493001KJTIIGC8Y1R12', 'First Slow Holdings')}`,
      `${record('5493001KJTIIGC8Y1R13', 'Second Slow Holdings')}</LEIRecords></LEIData>`,
    );
    const headersArrived = watchHeaders();

    const streamed = outcome(
      streamLeiLevel1(`${base}/lei2.xml`, new AbortController().signal),
      (entity) => entity.lei,
    );
    await Promise.all([headersArrived, firstChunkSent]);
    await flush();
    await vi.advanceTimersByTimeAsync(SOURCE_HEADERS_TIMEOUT_MS + 60_000);
    finish();

    expect(await streamed).toEqual({ items: ['5493001KJTIIGC8Y1R12', '5493001KJTIIGC8Y1R13'] });
  });
});
