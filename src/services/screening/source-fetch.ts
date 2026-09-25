/**
 * @fileoverview Opening a streamed source download — a sanctions list or a GLEIF
 * golden copy — whose body is drained at ingest speed. The wait for response
 * headers is bounded; the body is bounded only by the caller's signal, so a
 * healthy transfer runs as long as it takes.
 * @module services/screening/source-fetch
 */

import { timeout } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext } from '@cyanheads/mcp-ts-core/utils';

/** How long a source download may wait for its response headers. */
export const SOURCE_HEADERS_TIMEOUT_MS = 120_000;

/**
 * `fetchWithTimeout`'s timeout bounds the whole exchange, body included. It is
 * set to the longest delay a timer accepts (~24.8 days), out of reach of any
 * run, so the headers timer and the caller's signal are what bound a download.
 */
const NO_EXCHANGE_DEADLINE_MS = 2 ** 31 - 1;

/** Options for {@link fetchSourceDownload}. */
export interface SourceDownloadOptions {
  context: RequestContext;
  /** Overrides {@link SOURCE_HEADERS_TIMEOUT_MS}. */
  headersTimeoutMs?: number;
  init?: Omit<RequestInit, 'signal'>;
  /** Bounds the whole download: the run's time bound, or a caller's cancel. */
  signal: AbortSignal;
  /** What the download fetches, as named in a failure. */
  source: string;
}

/**
 * Fetch a source download whose body the caller streams. The response headers
 * must arrive within the headers bound, or the download fails as a `Timeout`
 * naming the source. Once they arrive the bound is spent: the body drains until
 * it ends or `signal` aborts it, and the read then rejects with the framework's
 * `RequestCancelled`. An abort of `signal` during the headers wait is likewise a
 * cancellation, and a non-2xx answer keeps the framework's status mapping.
 */
export async function fetchSourceDownload(
  url: string,
  options: SourceDownloadOptions,
): Promise<Response> {
  const { context, headersTimeoutMs = SOURCE_HEADERS_TIMEOUT_MS, init, signal, source } = options;
  const headers = new AbortController();
  const timer = setTimeout(() => headers.abort(), headersTimeoutMs);
  try {
    return await fetchWithTimeout(url, NO_EXCHANGE_DEADLINE_MS, context, {
      ...init,
      signal: AbortSignal.any([signal, headers.signal]),
    });
  } catch (err) {
    // The framework reports any abort of the signal it was given as a
    // cancellation; the headers timer's abort is this bound expiring instead.
    if (headers.signal.aborted && !signal.aborted) {
      throw timeout(
        `${source} sent no response headers within ${headersTimeoutMs / 1000} s.`,
        { source, headersTimeoutMs },
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
