/**
 * @fileoverview Real subprocess lifecycle coverage for scheduled refreshes:
 * abnormal exits, bounded forced teardown, overlap, retries and pipe closure.
 * @module tests/integration/refresh-process.test
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SANCTIONS_REFRESH_JOB,
  scheduleSanctionsRefresh,
} from '@/services/screening/sanctions-refresh.js';
import { ScheduledRefreshProcess } from '@/services/screening/scheduled-refresh-process.js';
import { type SeededService, seededGlobalService } from '../services/_helpers.js';

const ENTRY = fileURLToPath(new URL('./fixtures/refresh-child.mjs', import.meta.url));
const ctx = requestContextService.createRequestContext({ operation: 'refreshProcessTest' });
let harness: SeededService;
let writer: ScheduledRefreshProcess;

beforeEach(async () => {
  harness = await seededGlobalService();
  writer = new ScheduledRefreshProcess({ entry: ENTRY, graceMs: 50 });
});

afterEach(async () => {
  await writer.stop();
  if (schedulerService.listJobs().some((job) => job.id === SANCTIONS_REFRESH_JOB))
    schedulerService.remove(SANCTIONS_REFRESH_JOB);
  vi.restoreAllMocks();
  delete process.env.TEST_REFRESH_MODE;
  await harness.cleanup();
});

const alive = () => new AbortController().signal;
const marker = () => `${process.env.SANCTIONS_MIRROR_PATH}.child`;
const pid = () => (JSON.parse(readFileSync(marker(), 'utf8')) as { pid: number }).pid;
const reaped = (childPid: number) => expect(() => process.kill(childPid, 0)).toThrow();

describe('scheduled refresh child lifecycle', () => {
  it('drains more than a pipe buffer of child logging without holding exit open', async () => {
    process.env.TEST_REFRESH_MODE = 'logs';
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await writer.run(alive(), ctx);
    expect(output.mock.calls.reduce((size, [chunk]) => size + Buffer.byteLength(chunk), 0)).toBe(
      340_000,
    );
    reaped(pid());
  });
  it.each(['spawn', 'exit', 'signal'])(
    'logs %s failure at error level and releases the scheduler slot',
    async (mode) => {
      if (mode === 'spawn')
        writer = new ScheduledRefreshProcess({ runtime: '/no-such-refresh-runtime' });
      else process.env.TEST_REFRESH_MODE = mode;
      const errors = vi.spyOn(logger, 'error');
      await scheduleSanctionsRefresh(undefined, (signal, context) => writer.run(signal, context));
      const job = schedulerService.listJobs().find((item) => item.id === SANCTIONS_REFRESH_JOB);
      if (!job) throw new Error('No scheduled job.');
      await job.task.execute();
      expect(errors).toHaveBeenCalledWith(
        `Job '${SANCTIONS_REFRESH_JOB}' failed.`,
        expect.any(Error),
        expect.anything(),
      );
      expect(job.isRunning).toBe(false);
    },
  );
  it('serves real health and screen requests from complete committed indexes during a child write', async () => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('No loopback port.');
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${address.port}`;
    const serving = spawn(process.execPath, [...process.execArgv, 'dist/index.js'], {
      env: {
        ...process.env,
        MCP_TRANSPORT_TYPE: 'http',
        MCP_HTTP_HOST: '127.0.0.1',
        MCP_HTTP_PORT: String(address.port),
        MCP_AUTH_MODE: 'none',
        MCP_LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<void>((resolve) => serving.once('close', () => resolve()));
    let logs = '';
    serving.stdout.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });
    serving.stderr.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });
    const screen = async () => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'sanctions_screen_name', arguments: { name: 'Ivan Testovich Volkov' } },
        }),
        signal: AbortSignal.timeout(2_000),
      });
      const body = await response.text();
      const data =
        body.startsWith('event:') || body.startsWith('data:')
          ? body
              .split('\n')
              .find((line) => line.startsWith('data:'))
              ?.slice(5)
          : body;
      expect(response.ok, `${body}\n${logs}`).toBe(true);
      return JSON.parse(data ?? '') as {
        result: {
          structuredContent: { hits: unknown[]; caveat: string };
          content: { type: string; text?: string }[];
        };
      };
    };
    try {
      await vi.waitFor(async () => expect((await fetch(`${base}/healthz`)).ok).toBe(true), {
        timeout: 10_000,
      });
      const before = await screen();
      expect(before.result.structuredContent.hits.length).toBeGreaterThan(0);
      process.env.TEST_REFRESH_MODE = 'hold';
      let finished = false;
      const write = writer.run(alive(), ctx).finally(() => {
        finished = true;
      });
      void write.catch(() => undefined);
      await vi.waitFor(() => expect(existsSync(`${marker()}.locked`)).toBe(true), {
        timeout: 5_000,
      });
      const started = performance.now();
      expect((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1_000) })).ok).toBe(
        true,
      );
      const during = await screen();
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(finished).toBe(false);
      expect(during.result.structuredContent).toEqual(before.result.structuredContent);
      expect(during.result.content).toEqual(before.result.content);
      expect(during.result.content.map((block) => block.text ?? '').join('\n')).toContain(
        during.result.structuredContent.caveat,
      );
      await write;
      reaped(pid());
    } finally {
      await writer.stop();
      serving.kill('SIGTERM');
      const killer = setTimeout(() => serving.kill('SIGKILL'), 3_000);
      await closed;
      clearTimeout(killer);
    }
  });
  it('preserves runtime arguments and drains a successful child before retry', async () => {
    writer = new ScheduledRefreshProcess({
      entry: ENTRY,
      runtimeArgs: ['--conditions=refresh-test'],
    });
    await writer.run(alive(), ctx);
    expect(JSON.parse(readFileSync(marker(), 'utf8')).args).toContain('--conditions=refresh-test');
    reaped(pid());
    await writer.run(alive(), ctx);
    reaped(pid());
  });

  it('rejects spawn failure and clears the overlap slot for another attempt', async () => {
    writer = new ScheduledRefreshProcess({ runtime: '/no-such-refresh-runtime' });
    await expect(writer.run(alive(), ctx)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(writer.run(alive(), ctx)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['exit', 'code 7'],
    ['signal', 'SIGKILL'],
  ])('reaps %s and permits a successful retry', async (mode, diagnosis) => {
    process.env.TEST_REFRESH_MODE = mode;
    await expect(writer.run(alive(), ctx)).rejects.toThrow(diagnosis);
    reaped(pid());
    delete process.env.TEST_REFRESH_MODE;
    await writer.run(alive(), ctx);
    reaped(pid());
  });

  it('rejects overlap, forcibly reaps a noncooperative child on timeout, then retries', async () => {
    process.env.TEST_REFRESH_MODE = 'hang';
    const controller = new AbortController();
    const run = writer.run(controller.signal, ctx);
    const failure = expect(run).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'Test deadline elapsed. Child exited with SIGKILL.',
    });
    await vi.waitFor(() => expect(existsSync(marker())).toBe(true), { timeout: 5_000 });
    const childPid = pid();
    await expect(writer.run(alive(), ctx)).rejects.toThrow('already running');
    controller.abort(new DOMException('Test deadline elapsed.', 'TimeoutError'));
    await failure;
    reaped(childPid);
    delete process.env.TEST_REFRESH_MODE;
    await writer.run(alive(), ctx);
    reaped(pid());
  });

  it('awaits forced shutdown and open-transaction rollback before the reader closes', async () => {
    process.env.TEST_REFRESH_MODE = 'hold';
    const handle = await harness.service.designations.raw();
    const before = handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM name').get()?.n;
    expect(before).toBeGreaterThan(0);
    const run = writer.run(alive(), ctx);
    const failure = expect(run).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: 'The server is shutting down. Child exited with SIGKILL.',
    });
    await vi.waitFor(() => expect(existsSync(`${marker()}.locked`)).toBe(true), { timeout: 5_000 });
    const childPid = pid();
    const started = performance.now();
    await writer.stop();
    await failure;
    expect(performance.now() - started).toBeLessThan(1_000);
    reaped(childPid);
    expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM name').get()?.n).toBe(before);
  });
});
