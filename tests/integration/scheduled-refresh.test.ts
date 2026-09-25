/**
 * @fileoverview The HTTP server's scheduled sanctions refresh, run through the
 * real scheduler job against a real local HTTP server. Registering the job
 * proves `node-cron` resolves at runtime — the scheduler loads it lazily, so an
 * undeclared dependency surfaces only when a job is scheduled, never at build,
 * typecheck, or lint time. Running it proves the job body: the sanctions sync
 * under a time bound, then the name-index rebuild. A source whose transfer
 * stalls mid-body ends the run as a failure the scheduler logs, and the next
 * tick runs instead of being skipped as an overlap (issue #43).
 * @module tests/integration/scheduled-refresh.test
 */

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { logger, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import {
  longRunSignal,
  REFRESH_HOURS,
  SANCTIONS_REFRESH_JOB,
  scheduleSanctionsRefresh,
} from '@/services/screening/sanctions-refresh.js';
import { NAME_TABLE } from '@/services/screening/schema.js';
import { emptyGlobalService, type SeededService } from '../services/_helpers.js';

/** One small document per source, by path, with the env var that points at it. */
const FEEDS = {
  '/sdn.xml': [
    'OFAC_SDN_URL',
    '<?xml version="1.0"?><sdnList><sdnEntry><uid>SDN-1</uid><firstName>Alder</firstName><lastName>Quill</lastName><sdnType>Individual</sdnType></sdnEntry></sdnList>',
  ],
  '/cons.xml': [
    'OFAC_CONSOLIDATED_URL',
    '<?xml version="1.0"?><sdnList><sdnEntry><uid>CONS-1</uid><firstName>Cedar</firstName><lastName>Wren</lastName><sdnType>Individual</sdnType></sdnEntry></sdnList>',
  ],
  '/eu.xml': [
    'EU_FSF_URL',
    '<?xml version="1.0"?><export><sanctionEntity logicalId="EU-1"><subjectType code="person"/><nameAlias wholeName="Dahlia Finch" strong="true"/></sanctionEntity></export>',
  ],
  '/uk.xml': [
    'UK_SANCTIONS_URL',
    '<?xml version="1.0"?><Designations><Designation><UniqueID>UK-1</UniqueID><IndividualEntityShip>Individual</IndividualEntityShip><Names><Name><Name6>Fern Lark</Name6><NameType>Primary Name</NameType></Name></Names></Designation></Designations>',
  ],
  '/un.xml': [
    'UN_SC_URL',
    '<?xml version="1.0"?><CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL><DATAID>UN-1</DATAID><FIRST_NAME>Hazel</FIRST_NAME><SECOND_NAME>Crane</SECOND_NAME></INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>',
  ],
} as const;

let server: Server;
let harness: SeededService;
/** While true, the UN document is sent up to its first record's close, then the transfer stalls. */
let stallUn = true;
const requested: string[] = [];

beforeEach(async () => {
  stallUn = true;
  requested.length = 0;
  server = createServer((req, res) => {
    const path = req.url ?? '';
    requested.push(path);
    const feed = FEEDS[path as keyof typeof FEEDS];
    if (!feed) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/xml' });
    if (path === '/un.xml' && stallUn) {
      // Headers and part of the body, then silence — the connection stays open.
      res.write(feed[1].slice(0, feed[1].indexOf('</INDIVIDUAL>')));
      return;
    }
    res.end(feed[1]);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  for (const [path, [env]] of Object.entries(FEEDS)) {
    process.env[env] = `http://127.0.0.1:${port}${path}`;
  }
  harness = await emptyGlobalService();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  try {
    schedulerService.remove(SANCTIONS_REFRESH_JOB);
  } catch {
    // Scheduling failed, so there is no job; the assertions report that.
  }
  await harness.cleanup();
  server.closeAllConnections();
  server.close();
  for (const [env] of Object.values(FEEDS)) delete process.env[env];
});

function job() {
  const registered = schedulerService.listJobs().find((j) => j.id === SANCTIONS_REFRESH_JOB);
  if (!registered) throw new Error('the sanctions refresh job was not registered');
  return registered;
}

async function indexedDesignations(): Promise<string[]> {
  const handle = await harness.service.designations.raw();
  return handle
    .prepare<{ id: string }>(`SELECT DISTINCT designation_id AS id FROM ${NAME_TABLE} ORDER BY id`)
    .all()
    .map((r) => r.id);
}

describe('scheduled sanctions refresh', () => {
  it('registers the job on the configured cron expression', async () => {
    await scheduleSanctionsRefresh();
    expect(job().schedule).toBe(getServerConfig().refreshCron);
  });

  it(`bounds each run at ${REFRESH_HOURS} hours when no run signal is given`, async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(harness.service, 'syncSanctions').mockImplementation(async (_mode, signal) => {
      signals.push(signal);
      return {} as Awaited<ReturnType<SeededService['service']['syncSanctions']>>;
    });
    await scheduleSanctionsRefresh();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await job().task.execute();
    await job().task.execute();

    // Each run gets its own signal, armed when that run starts.
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    vi.advanceTimersByTime(REFRESH_HOURS * 3_600_000 - 1);
    expect(signals.map((s) => s.aborted)).toEqual([false, false]);
    vi.advanceTimersByTime(1);
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    expect(signals[0]?.reason).toMatchObject({
      name: 'TimeoutError',
      message: `The run exceeded its ${REFRESH_HOURS}-hour time bound and was stopped.`,
    });
  });

  it('ends a run whose transfer stalls as a logged failure, and runs the next tick', async () => {
    const errors = vi.spyOn(logger, 'error');
    await scheduleSanctionsRefresh(() => AbortSignal.timeout(500));

    // First tick: UN's transfer stalls after its headers. The time bound ends the run.
    const started = performance.now();
    await job().task.execute();
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(job().isRunning).toBe(false);
    expect(errors).toHaveBeenCalledWith(
      `Job '${SANCTIONS_REFRESH_JOB}' failed.`,
      expect.any(Error),
      expect.anything(),
    );
    expect(await harness.service.sanctionsReadiness()).toMatchObject({
      ready: false,
      status: 'error',
    });
    // The sources before the stall landed, and the name index was rebuilt from them.
    expect(await indexedDesignations()).toEqual([
      'eu:EU-1',
      'ofac_consolidated:CONS-1',
      'ofac_sdn:SDN-1',
      'uk:UK-1',
    ]);

    // Next tick: UN answers in full. The run starts rather than being skipped.
    stallUn = false;
    requested.length = 0;
    await job().task.execute();
    expect(requested).toEqual(['/sdn.xml', '/cons.xml', '/eu.xml', '/uk.xml', '/un.xml']);
    expect(await harness.service.sanctionsReadiness()).toMatchObject({
      ready: true,
      status: 'complete',
    });
    expect(await indexedDesignations()).toContain('un:UN-1');
  });

  it('records a run the time bound ended as exceeding it, naming the source it stopped in', async () => {
    const errors = vi.spyOn(logger, 'error');
    await scheduleSanctionsRefresh(() => longRunSignal(0.5 / 3600));

    await job().task.execute();

    const failure = errors.mock.calls.find(
      ([message]) => message === `Job '${SANCTIONS_REFRESH_JOB}' failed.`,
    )?.[1];
    expect(failure).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    const recorded = (await harness.service.sanctionsReadiness()).error;
    expect(recorded).toMatch(/^Sanctions harvest of un did not finish\. .*time bound/);
    expect(recorded).not.toMatch(/was aborted/);
    expect((failure as Error).message).toBe(recorded);
  });

  it('keeps a caller abort during a stalled transfer a cancellation, not a time bound', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const error = await harness.service.syncSanctions('refresh', controller.signal).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect((error as Error).message).not.toMatch(/time bound/);
  });
});
