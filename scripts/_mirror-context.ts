/**
 * @fileoverview Shared bootstrap for the mirror lifecycle scripts
 * (`mirror:init`, `mirror:refresh`, `mirror:verify`, `mirror:seed`). Builds a
 * standalone ScreeningService outside the MCP request pipeline and exposes the
 * framework logger. Imported by the three named scripts, so it must travel with
 * them in the npm tarball / Docker image.
 * @module scripts/_mirror-context
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { buildScreeningService } from '@/services/screening/screening-service.js';

/**
 * Build a fresh, standalone screening service for a lifecycle script and
 * initialize the framework logger. The logger's `log()` calls are silently
 * dropped until `initialize()` has run — `createApp()` does this on the server
 * path, but the lifecycle scripts bypass `createApp()`, so it must happen here.
 * Honors `MCP_LOG_LEVEL` via the framework config; classifies as stdio (logs to
 * stderr, the honest transport for a CLI run).
 */
export async function bootstrap() {
  await logger.initialize(config.logLevel, 'stdio');
  return { service: buildScreeningService(), log: logger };
}

/** A long, abortable signal for hours-long init runs (caps a runaway harvest). */
export function longRunSignal(hours = 6): AbortSignal {
  return AbortSignal.timeout(hours * 60 * 60 * 1000);
}
