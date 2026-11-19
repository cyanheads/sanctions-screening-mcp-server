/**
 * @fileoverview `mirror:verify` — readiness + freshness report for both mirrors.
 * Prints per-source record counts, each sanctions list's last recorded harvest
 * and the date its publisher put on that document, the lists that failed in the
 * last sanctions refresh, the sanctions/GLEIF readiness flags, the GLEIF
 * Level 1 / Level 2 / reporting-exception counts and per-dataset checkpoint,
 * whether GLEIF's other and transliterated names are indexed for resolution,
 * whether the last completed golden-copy load wrote entity status and successors
 * for every entity in that copy, whether the exact-name index strict resolution
 * reads first is built, and the
 * last-completed timestamps. Safe to run anytime, and it loads nothing, but it
 * opens both mirrors as the server does: a mirror an earlier release wrote is
 * upgraded in place on that first open (the sanctions name and identifier
 * indexes rebuilt, the GLEIF store migration applied). Point it at a copy to
 * inspect such a mirror unchanged.
 *
 * Usage: `bun run mirror:verify`
 * @module scripts/mirror-verify
 */

import { withExtra } from '@cyanheads/mcp-ts-core/utils';
import { bootstrap, runScript } from './_mirror-context.js';

async function main(): Promise<void> {
  const { service, log, ctx } = await bootstrap('mirror:verify');
  const [counts, sanctions, lei] = await Promise.all([
    service.sourceCounts(),
    service.sanctionsReadiness(),
    service.leiReadiness(),
  ]);

  log.info(
    'mirror:verify — sanctions mirror',
    withExtra(ctx, {
      ready: sanctions.ready,
      total: sanctions.total,
      completedAt: sanctions.completedAt ?? 'never',
      // A run reads in_progress until its index rebuild records its outcomes, as sanctions_list_sources reports it.
      status: sanctions.lastRefresh.status,
      ...(sanctions.error ? { lastError: sanctions.error } : {}),
      ...(sanctions.lastRefresh.status === 'error' && sanctions.lastRefresh.failedSources
        ? { failedSources: sanctions.lastRefresh.failedSources }
        : {}),
    }),
  );
  const harvests = new Map(sanctions.sources.map((s) => [s.code, s]));
  for (const s of counts) {
    const harvest = harvests.get(s.code);
    log.info(
      `  source ${s.code}`,
      withExtra(ctx, {
        records: s.recordCount,
        // A list this server has not harvested yet has no recorded time: unknown, not old.
        lastHarvestedAt: harvest?.lastHarvestedAt ?? 'not recorded',
        ...(harvest?.publishedAt ? { publishedAt: harvest.publishedAt } : {}),
      }),
    );
  }
  log.info(
    'mirror:verify — GLEIF mirror',
    withExtra(ctx, {
      ready: lei.ready,
      entities: lei.entityCount,
      relationships: lei.relationshipCount,
      reportingExceptions: lei.exceptionsLoaded ? lei.exceptionCount : 'not loaded',
      alternateNamesIndexed: await service.leiNamesIndexed(),
      entityStatusLoaded: await service.leiEntityStatusLoaded(),
      exactNamesIndexed: await service.leiExactNamesIndexed(),
      checkpoint: await service.gleifCheckpoint(),
      completedAt: lei.completedAt ?? 'never',
      status: lei.status,
      ...(lei.error ? { lastError: lei.error } : {}),
    }),
  );

  await service.close();
}

runScript('mirror:verify', main);
