/**
 * @fileoverview `mirror:refresh` — incremental out-of-band refresh. Re-harvests
 * the (small) sanctions lists in full and rebuilds the name index, then applies
 * the GLEIF 8-hour deltas. The HTTP server runs the sanctions half of this on a
 * cron automatically; stdio operators run this manually. Set
 * `SANCTIONS_REFRESH_SKIP_GLEIF=1` to refresh only the sanctions lists.
 *
 * Usage: `bun run mirror:refresh`
 * @module scripts/mirror-refresh
 */

import {
  harvestLeiLevel1,
  harvestLeiLevel2,
  resolveGleifFileUrl,
} from '@/services/screening/gleif-ingest.js';
import { bootstrap, longRunSignal } from './_mirror-context.js';

async function main(): Promise<void> {
  const { service, log } = bootstrap();
  const signal = longRunSignal(4);

  log.info('mirror:refresh — re-harvesting sanctions lists');
  const sanctions = await service.designations.runSync({ mode: 'refresh', signal });
  await service.rebuildNameIndex();
  log.info('mirror:refresh — sanctions refreshed', { records: sanctions.recordsApplied });

  if (process.env.SANCTIONS_REFRESH_SKIP_GLEIF === '1') {
    log.notice('mirror:refresh — SANCTIONS_REFRESH_SKIP_GLEIF set; skipping GLEIF deltas');
    await service.close();
    return;
  }

  log.info('mirror:refresh — applying GLEIF deltas (LastDay)');
  const [l1Url, l2Url] = await Promise.all([
    resolveGleifFileUrl('lei2-delta', signal, 'LastDay'),
    resolveGleifFileUrl('rr-delta', signal, 'LastDay'),
  ]);
  const entities = await harvestLeiLevel1(l1Url, signal);
  await service.ingestLeiEntities(entities);
  const relationships = await harvestLeiLevel2(l2Url, signal);
  await service.ingestLeiRelationships(relationships);
  log.info('mirror:refresh — GLEIF deltas applied', {
    entities: entities.length,
    relationships: relationships.length,
  });

  log.info('mirror:refresh — complete');
  await service.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('mirror:refresh failed:', err);
  process.exit(1);
});
