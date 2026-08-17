/**
 * @fileoverview `mirror:init` — full out-of-band initialization of the local
 * mirror from the live upstream sources. Harvests all five sanctions lists in
 * full (via the MirrorService `init` sync), rebuilds the per-alias name index,
 * then streams the GLEIF golden copy (Level 1 entities + Level 2 relationships).
 * Hours-long and resumable; never run on the request path. Set
 * `SANCTIONS_INIT_SKIP_GLEIF=1` to load the sanctions lists only.
 *
 * Both legs stream. The sanctions documents total ~172 MB — OFAC
 * `SDN_ADVANCED.XML` alone is ~120 MB — and the GLEIF golden copy is far larger
 * again, so neither is held whole: peak memory tracks the ingest batch, not the
 * size of any source document.
 *
 * Usage: `bun run mirror:init`
 * @module scripts/mirror-init
 */

import {
  resolveGleifFileUrl,
  streamLeiLevel1,
  streamLeiLevel2,
} from '@/services/screening/gleif-ingest.js';
import { createRejections } from '@/services/screening/ingest-validation.js';
import { bootstrap, ingestInBatches, longRunSignal } from './_mirror-context.js';

/** Records per ingest batch for the streaming golden-copy load. */
const GLEIF_INGEST_BATCH = 10_000;

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

  // Stream both golden copies: decompress + scan + normalize incrementally and
  // ingest in bounded batches, so the ~892 MB compressed L1 file never has to be
  // held decompressed in memory. L1 entities upsert by LEI (idempotent per batch).
  log.info('mirror:init — streaming GLEIF Level 1 (who-is-who, ~3.3M records)');
  const leiRejections = createRejections();
  const entityCount = await ingestInBatches(
    streamLeiLevel1(l1Url, signal, leiRejections),
    GLEIF_INGEST_BATCH,
    (batch) => service.ingestLeiEntities(batch),
    (total) => log.info('mirror:init — GLEIF Level 1 ingest progress', { entities: total }),
  );
  log.info('mirror:init — GLEIF Level 1 loaded', {
    entities: entityCount,
    rejectedMissingIdentifier: leiRejections.missingIdentifier,
    rejectedUnusableName: leiRejections.unusableName,
  });

  // L2 is a full replace: wipe the relationship table ONCE, then insert-only
  // batches (no per-child delete) so a child whose relationships straddle a batch
  // boundary keeps every row.
  log.info('mirror:init — streaming GLEIF Level 2 (who-owns-whom)');
  await service.clearLeiRelationships();
  const relationshipCount = await ingestInBatches(
    streamLeiLevel2(l2Url, signal),
    GLEIF_INGEST_BATCH,
    (batch) => service.ingestLeiRelationships(batch, { replaceByChild: false }),
    (total) => log.info('mirror:init — GLEIF Level 2 ingest progress', { relationships: total }),
  );
  log.info('mirror:init — GLEIF Level 2 loaded', { relationships: relationshipCount });

  await service.markLeiReady(entityCount);
  log.info('mirror:init — complete');
  await service.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('mirror:init failed:', err);
  process.exit(1);
});
