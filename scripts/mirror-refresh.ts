/**
 * @fileoverview `mirror:refresh` — incremental out-of-band refresh. Re-harvests
 * the sanctions lists in full — streamed, so the ~120 MB OFAC SDN document is
 * never held whole — removing each list's designations its complete document no
 * longer publishes, and rebuilds the name and identifier indexes. Then it brings
 * the GLEIF mirror current from its checkpoint: per dataset, the smallest delta
 * window that reaches back to the last file applied, streamed in bounded batches,
 * deletions included. Reporting exceptions with no recorded load get their golden
 * copy. The HTTP server runs the same refresh on a cron, deltas only.
 *
 * Exits non-zero when a sanctions list failed, or when the GLEIF mirror cannot be
 * caught up from deltas — no checkpoint recorded (every mirror written before
 * checkpoints existed) or a gap longer than the one-month window — which needs
 * `mirror:init`; nothing is applied to GLEIF then, and `leiAsOf` stays put. Set
 * `SANCTIONS_REFRESH_SKIP_GLEIF=1` to refresh only the sanctions lists.
 *
 * Usage: `bun run mirror:refresh`
 * @module scripts/mirror-refresh
 */

import { withExtra } from '@cyanheads/mcp-ts-core/utils';
import {
  longRunSignal,
  REFRESH_HOURS,
  refreshMirrors,
} from '@/services/screening/sanctions-refresh.js';
import { bootstrap, runScript } from './_mirror-context.js';

async function main(): Promise<void> {
  const { service, log, ctx } = await bootstrap('mirror:refresh');
  try {
    log.info('mirror:refresh — re-harvesting sanctions lists, then GLEIF', ctx);
    const { sanctions, gleif } = await refreshMirrors(service, longRunSignal(REFRESH_HOURS), {
      context: ctx,
      loadMissingExceptions: true,
    });
    log.info(
      'mirror:refresh — sanctions refreshed, name and identifier indexes rebuilt',
      withExtra(ctx, {
        records: sanctions.recordsApplied,
        removed: sanctions.tombstonesApplied,
        total: sanctions.total,
      }),
    );
    if (gleif && gleif.needsInit.length > 0) {
      throw new Error(
        `GLEIF ${gleif.needsInit.join(', ')} cannot be caught up from delta files — nothing was applied and leiAsOf is unchanged. Run mirror:init to reload the GLEIF golden copies.`,
      );
    }
    log.info('mirror:refresh — complete', ctx);
  } finally {
    await service.close();
  }
}

runScript('mirror:refresh', main);
