/**
 * @fileoverview Supervise one compiled mirror-refresh child. Cancellation gives
 * its finally blocks time to rebuild indexes, then kills and reaps a stuck child.
 * @module services/screening/scheduled-refresh-process
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger, type RequestContext } from '@cyanheads/mcp-ts-core/utils';

/** The maximum time cancellation may spend finishing a refresh before SIGKILL. */
export const REFRESH_STOP_GRACE_MS = 5_000;

/** Internal child result, carried on stdout after its mirrors have closed. */
export interface RefreshJobResult {
  error?: { code?: number; message: string };
  needsInit?: string[];
}

/** Launch settings; the defaults run the compiled entry with the serving runtime. */
export interface RefreshProcessOptions {
  entry?: string;
  graceMs?: number;
  runtime?: string;
  runtimeArgs?: string[];
}

/** A single writer, owned by the HTTP server and awaited during teardown. */
export class ScheduledRefreshProcess {
  private active: { cancellation: AbortController; done: Promise<void> } | undefined;

  constructor(private readonly options: RefreshProcessOptions = {}) {}

  /** Start a refresh, rejecting failures only after the child and its pipes close. */
  async run(signal: AbortSignal, context: RequestContext): Promise<void> {
    if (this.active) throw new Error('A scheduled mirror refresh is already running.');
    signal.throwIfAborted();
    const cancellation = new AbortController();
    const runSignal = AbortSignal.any([signal, cancellation.signal]);
    const done = this.execute(runSignal, context);
    this.active = { cancellation, done };
    try {
      await done;
    } finally {
      this.active = undefined;
    }
  }

  /** Cancel and reap the current child before the serving mirrors are closed. */
  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.cancellation.abort(new DOMException('The server is shutting down.', 'AbortError'));
    await active.done.catch(() => undefined);
  }

  private execute(signal: AbortSignal, context: RequestContext): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(
          this.options.runtime ?? process.execPath,
          [
            ...(this.options.runtimeArgs ?? process.execArgv),
            this.options.entry ??
              fileURLToPath(
                new URL(
                  '../../../dist/services/screening/scheduled-refresh-job.js',
                  import.meta.url,
                ),
              ),
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
        );
      } catch (error) {
        reject(error);
        return;
      }
      let failure: Error | undefined;
      let output = '';
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        const reason = signal.reason;
        child.stdin.end(
          JSON.stringify({
            name: reason instanceof Error ? reason.name : 'AbortError',
            message: reason instanceof Error ? reason.message : 'The refresh was cancelled.',
          }) + '\n',
        );
        killTimer = setTimeout(
          () => child.kill('SIGKILL'),
          this.options.graceMs ?? REFRESH_STOP_GRACE_MS,
        );
      };
      /** A child may exit before stdin cancellation; EPIPE must not escape. */
      child.stdin.on('error', () => undefined);
      child.on('error', (error) => {
        failure = error;
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (output.length + chunk.length <= 65_536) output += chunk;
        else {
          failure = new Error('Scheduled mirror refresh returned an oversized result.');
          child.kill('SIGKILL');
        }
      });
      /** Drain continuously, preserving the child's logger severity and source fields. */
      child.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
      });
      child.once('close', (code, exitSignal) => {
        signal.removeEventListener('abort', cancel);
        if (killTimer) clearTimeout(killTimer);
        let result: RefreshJobResult | undefined;
        try {
          if (output.trim()) result = JSON.parse(output) as RefreshJobResult;
        } catch {
          failure ??= new Error('Scheduled mirror refresh returned an invalid result.');
        }
        if (result?.error) {
          failure ??=
            result.error.code === undefined
              ? new Error(result.error.message)
              : new McpError(result.error.code, result.error.message);
        }
        if (signal.aborted && !failure) {
          const reason = signal.reason as Error;
          failure = new McpError(
            reason.name === 'TimeoutError'
              ? JsonRpcErrorCode.Timeout
              : JsonRpcErrorCode.RequestCancelled,
            `${reason.message}${exitSignal ? ` Child exited with ${exitSignal}.` : ''}`,
          );
        }
        if (exitSignal || code !== 0) {
          failure ??= new Error(
            `Scheduled mirror refresh exited with ${exitSignal ?? `code ${code}`}.`,
          );
        }
        if (!failure && !result)
          failure = new Error('Scheduled mirror refresh returned no result.');
        if (failure) reject(failure);
        else {
          if (result?.needsInit?.length) {
            logger.warning(
              'Scheduled GLEIF refresh requires mirror:init; no golden copy was loaded.',
              context,
            );
          }
          resolve();
        }
      });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
}

/** The HTTP server's writer; shutdown awaits it before closing the read handles. */
export const scheduledRefreshProcess = new ScheduledRefreshProcess();
