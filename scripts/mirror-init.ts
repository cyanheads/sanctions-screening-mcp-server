/**
 * @fileoverview `mirror:init` — full out-of-band initialization of the local
 * mirror from the live upstream sources. Harvests all four sanctions lists in
 * full (via the MirrorService `init` sync), rebuilds the per-alias name index,
 * then streams the GLEIF golden copy (Level 1 entities + Level 2 relationships).
 * Hours-long and resumable; never run on the request path. Set
 * `SANCTIONS_INIT_SKIP_GLEIF=1` to load only the (small) sanctions lists.
 *
 * Usage: `bun run mirror:init`
 * @module scripts/mirror-init
 */

import {
  harvestLeiLevel1,
  harvestLeiLevel2,
  resolveGleifFileUrl,
} from '@/services/screening/gleif-ingest.js';
import { bootstrap, longRunSignal } from './_mirror-context.js';

async function main(): Promise<void> {
  const { service, log } = await bootstrap();
  const signal = longRunSignal(8);

  log.info('mirror:init — harvesting sanctions lists (full)');
  const sanctions = await service.designations.runSync({ mode: 'init', signal });
  log.info('mirror:init — sanctions harvest complete', {
    records: sanctions.recordsApplied,
    total: sanctions.total,
  });
  await service.rebuildNameIndex();
  log.info('mirror:init — name index rebuilt');

  if (process.env.SANCTIONS_INIT_SKIP_GLEIF === '1') {
    log.notice(
      'mirror:init — SANCTIONS_INIT_SKIP_GLEIF set; skipping GLEIF (sanctions-only mirror)',
    );
    await service.close();
    return;
  }

  log.info('mirror:init — resolving GLEIF golden-copy URLs');
  const [l1Url, l2Url] = await Promise.all([
    resolveGleifFileUrl('lei2-full', signal),
    resolveGleifFileUrl('rr-full', signal),
  ]);

  log.info('mirror:init — streaming GLEIF Level 1 (who-is-who, ~3.3M records)');
  const entities = await harvestLeiLevel1(l1Url, signal);
  await service.ingestLeiEntities(entities);
  log.info('mirror:init — GLEIF Level 1 loaded', { entities: entities.length });

  log.info('mirror:init — streaming GLEIF Level 2 (who-owns-whom)');
  const relationships = await harvestLeiLevel2(l2Url, signal);
  await service.ingestLeiRelationships(relationships);
  log.info('mirror:init — GLEIF Level 2 loaded', { relationships: relationships.length });

  await service.markLeiReady(entities.length);
  log.info('mirror:init — complete');
  await service.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('mirror:init failed:', err);
  process.exit(1);
});
