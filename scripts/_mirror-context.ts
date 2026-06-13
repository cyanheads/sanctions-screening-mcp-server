/**
 * @fileoverview Shared bootstrap for the mirror lifecycle scripts
 * (`mirror:init`, `mirror:refresh`, `mirror:verify`, `mirror:seed`). Builds a
 * standalone ScreeningService outside the MCP request pipeline and exposes the
 * framework logger. Imported by the three named scripts, so it must travel with
 * them in the npm tarball / Docker image.
 * @module scripts/_mirror-context
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { buildScreeningService } from '@/services/screening/screening-service.js';

/** Build a fresh, standalone screening service for a lifecycle script. */
export function bootstrap() {
  return { service: buildScreeningService(), log: logger };
}

/** A long, abortable signal for hours-long init runs (caps a runaway harvest). */
export function longRunSignal(hours = 6): AbortSignal {
  return AbortSignal.timeout(hours * 60 * 60 * 1000);
}
