/**
 * @fileoverview The scheduled sanctions refresh the HTTP server runs, and the
 * long-run time bound it shares with the mirror lifecycle scripts. Every run —
 * scheduled or scripted — goes through `ScreeningService.syncSanctions()` under
 * a {@link longRunSignal}, so a run that stalls ends as a failure instead of
 * holding the job open.
 * @module services/screening/sanctions-refresh
 */

import { logger, requestContextService, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getScreeningService } from '@/services/screening/screening-service.js';

/** The scheduler job id of the HTTP server's sanctions refresh. */
export const SANCTIONS_REFRESH_JOB = 'sanctions-mirror-refresh';

/** Hours a sanctions refresh, scheduled or `mirror:refresh`, may run before it is aborted. */
export const REFRESH_HOURS = 4;

/**
 * An abort signal that fires after `hours` — the time bound a lifecycle run
 * (a sanctions sync, the GLEIF load) runs under, so a run that stalls ends as a
 * failure instead of holding its caller open. Its reason is a `TimeoutError`
 * saying the bound was exceeded, which the sanctions sync records in place of
 * the aborted fetch it interrupted. The timer never holds the process open on
 * its own.
 */
export function longRunSignal(hours: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `The run exceeded its ${hours}-hour time bound and was stopped.`,
          'TimeoutError',
        ),
      ),
    hours * 60 * 60 * 1000,
  ).unref();
  return controller.signal;
}

/**
 * Register and start the sanctions refresh on `SANCTIONS_REFRESH_CRON`. Each run
 * syncs the sanctions lists and rebuilds the name and identifier indexes under a
 * fresh time bound, so a run that stalls ends as a failure the scheduler logs at
 * error level, and the next tick starts a new run rather than being skipped as
 * an overlap. A failure to register is logged, not thrown: the server keeps
 * serving the mirror it has.
 *
 * @param runSignal The time bound of one run: {@link longRunSignal} of
 *   {@link REFRESH_HOURS}, unless a caller needs a shorter one.
 */
export async function scheduleSanctionsRefresh(
  runSignal: () => AbortSignal = () => longRunSignal(REFRESH_HOURS),
): Promise<void> {
  try {
    await schedulerService.schedule(
      SANCTIONS_REFRESH_JOB,
      getServerConfig().refreshCron,
      async (ctx) => {
        logger.info('Starting scheduled sanctions mirror refresh', ctx);
        await getScreeningService().syncSanctions('refresh', runSignal());
        logger.info('Scheduled sanctions mirror refresh complete', ctx);
      },
      'Refreshes the sanctions watchlists from their upstream sources.',
    );
    schedulerService.start(SANCTIONS_REFRESH_JOB);
  } catch (err) {
    logger.error(
      'Failed to schedule sanctions mirror refresh',
      err as Error,
      requestContextService.createRequestContext({ operation: 'scheduleSanctionsRefresh' }),
    );
  }
}
