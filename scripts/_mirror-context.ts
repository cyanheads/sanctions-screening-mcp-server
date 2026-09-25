/**
 * @fileoverview Shared bootstrap for the mirror lifecycle scripts
 * (`mirror:init`, `mirror:refresh`, `mirror:verify`, `mirror:seed`). Builds a
 * standalone ScreeningService outside the MCP request pipeline and exposes the
 * framework logger, and ends each script's process once its work settles.
 * Imported by the lifecycle scripts, so it must travel with them in the npm
 * tarball / Docker image.
 * @module scripts/_mirror-context
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { buildScreeningService } from '@/services/screening/screening-service.js';

/**
 * Build a fresh, standalone screening service for a lifecycle script and
 * initialize the framework logger. The logger's `log()` calls are silently
 * dropped until `initialize()` has run — `createApp()` does this on the server
 * path, but the lifecycle scripts bypass `createApp()`, so it must happen here.
 * Honors `MCP_LOG_LEVEL` via the framework config; classifies as stdio (logs to
 * stderr, the honest transport for a CLI run).
 *
 * `ctx` is the run's request context — one `requestId` correlates every line of
 * the run. A line's fields go in through `withExtra(ctx, { … })`: the logger
 * prints a context's canonical keys and its `extra` bag, and drops any other key.
 */
export async function bootstrap(operation: string) {
  await logger.initialize(config.logLevel, 'stdio');
  return {
    service: buildScreeningService(),
    log: logger,
    ctx: requestContextService.createRequestContext({ operation }),
  };
}

/**
 * Run a lifecycle script's body, then end the process: exit 0 when it resolves,
 * or print its failure and exit 1. The logger is flushed and closed first either
 * way. The exit is explicit because the logger's transport runs on worker
 * threads that do not always stop when closed under Bun, and a left-over thread
 * holds the process open after its work is done — a script run by cron would
 * then never finish.
 */
export function runScript(name: string, main: () => Promise<void>): void {
  main().then(
    async () => {
      await logger.close();
      process.exit(0);
    },
    async (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`${name} failed:`, err);
      await logger.close();
      process.exit(1);
    },
  );
}
