/**
 * @fileoverview Verifies the scheduled sanctions-mirror refresh can actually be
 * registered. `schedulerService` loads `node-cron` lazily, so an undeclared
 * dependency surfaces only when a job is scheduled at runtime — never at build,
 * typecheck, or lint time. `src/index.ts` schedules inside a `.catch()` that
 * logs and continues, so a missing dependency degrades silently to "the mirror
 * never refreshes on its own".
 * @module tests/integration/scheduled-refresh.test
 */

import { schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';

const JOB_ID = 'test-sanctions-mirror-refresh';

afterEach(() => {
  // Tolerant: when scheduling fails there is no job to remove, and the
  // assertion below is what should report that, not teardown.
  try {
    schedulerService.remove(JOB_ID);
  } catch {
    /* nothing registered */
  }
});

describe('scheduled mirror refresh', () => {
  it('registers a job on the configured cron expression', async () => {
    await expect(
      schedulerService.schedule(
        JOB_ID,
        getServerConfig().refreshCron,
        async () => {},
        'Refreshes the sanctions watchlists from their upstream sources.',
      ),
    ).resolves.not.toThrow();

    expect(schedulerService.listJobs().map((job) => job.id)).toContain(JOB_ID);
  });
});
