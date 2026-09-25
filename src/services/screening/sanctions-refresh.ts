/**
 * @fileoverview The mirror refresh — the sanctions lists, then the GLEIF delta
 * windows — that the HTTP server runs on a schedule and `mirror:refresh` runs by
 * hand, and the long-run time bound both share with `mirror:init`. Every run goes
 * through {@link refreshMirrors} under a {@link longRunSignal}, so a run that
 * stalls ends as a failure instead of holding the job open.
 * @module services/screening/sanctions-refresh
 */

import type { SyncResult } from '@cyanheads/mcp-ts-core/mirror';
import {
  logger,
  type RequestContext,
  requestContextService,
  schedulerService,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { type GleifRefreshOutcome, refreshGleif } from '@/services/screening/gleif-sync.js';
import {
  getScreeningService,
  type ScreeningService,
} from '@/services/screening/screening-service.js';

/** The scheduler job id of the HTTP server's mirror refresh. */
export const SANCTIONS_REFRESH_JOB = 'sanctions-mirror-refresh';

/** Hours a refresh run, scheduled or `mirror:refresh`, may run before it is aborted. */
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

/** Options for {@link refreshMirrors}. */
export interface RefreshMirrorsOptions {
  context: RequestContext;
  /**
   * Load the reporting-exceptions golden copy when no load of it is recorded.
   * `mirror:refresh` does; the schedule never loads a golden copy in-process.
   */
  loadMissingExceptions: boolean;
}

/** What one {@link refreshMirrors} run did. */
export interface RefreshMirrorsResult {
  /** The GLEIF leg's outcome; absent when `SANCTIONS_REFRESH_SKIP_GLEIF=1` skipped it. */
  gleif?: GleifRefreshOutcome;
  sanctions: SyncResult;
}

/**
 * One refresh run: re-harvest the sanctions lists (rebuilding the name and
 * identifier indexes), then bring the GLEIF mirror current from its checkpoint,
 * both under `signal`. `SANCTIONS_REFRESH_SKIP_GLEIF=1` skips the GLEIF leg.
 *
 * A sanctions failure does not stop the GLEIF leg: the datasets are independent,
 * and a list that stayed down for days would otherwise let the GLEIF mirror fall
 * past its one-month delta window into needing `mirror:init`. A run the signal
 * ended stops there. A gap that needs `mirror:init` is reported in the result and
 * logged, never attempted.
 *
 * @throws The sanctions failure once the GLEIF leg has run, the GLEIF failure, or
 *   both together as an `AggregateError`.
 */
export async function refreshMirrors(
  service: ScreeningService,
  signal: AbortSignal,
  options: RefreshMirrorsOptions,
): Promise<RefreshMirrorsResult> {
  const failures: unknown[] = [];
  let sanctions: SyncResult | undefined;
  try {
    sanctions = await service.syncSanctions('refresh', signal);
  } catch (err) {
    failures.push(err);
  }
  let gleif: GleifRefreshOutcome | undefined;
  if (process.env.SANCTIONS_REFRESH_SKIP_GLEIF === '1') {
    logger.notice(
      'Mirror refresh — SANCTIONS_REFRESH_SKIP_GLEIF set; skipping GLEIF',
      options.context,
    );
  } else if (!signal.aborted) {
    try {
      gleif = await refreshGleif(service, signal, options);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Both the sanctions refresh and the GLEIF refresh failed.');
  }
  if (failures.length === 1 || !sanctions) throw failures[0];
  return { sanctions, ...(gleif ? { gleif } : {}) };
}

/**
 * Register and start the mirror refresh on `SANCTIONS_REFRESH_CRON`. Each run is
 * one {@link refreshMirrors} — the sanctions lists, then the GLEIF deltas only
 * (never a golden copy) — under a fresh time bound, so a run that stalls ends as a
 * failure the scheduler logs at error level, and the next tick starts a new run
 * rather than being skipped as an overlap. A failure to register is logged, not
 * thrown: the server keeps serving the mirror it has.
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
        logger.info('Starting scheduled mirror refresh', ctx);
        await refreshMirrors(getScreeningService(), runSignal(), {
          context: ctx,
          loadMissingExceptions: false,
        });
        logger.info('Scheduled mirror refresh complete', ctx);
      },
      'Refreshes the sanctions watchlists, then applies the GLEIF deltas.',
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
