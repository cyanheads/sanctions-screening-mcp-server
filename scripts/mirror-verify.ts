/**
 * @fileoverview `mirror:verify` — readiness + freshness report for both mirrors.
 * Prints per-source record counts, the sanctions/GLEIF readiness flags, and the
 * last-completed timestamps. Read-only; safe to run anytime.
 *
 * Usage: `bun run mirror:verify`
 * @module scripts/mirror-verify
 */

import { bootstrap } from './_mirror-context.js';

async function main(): Promise<void> {
  const { service, log } = bootstrap();
  const [counts, sanctions, lei] = await Promise.all([
    service.sourceCounts(),
    service.sanctionsReadiness(),
    service.leiReadiness(),
  ]);

  log.info('mirror:verify — sanctions mirror', {
    ready: sanctions.ready,
    total: sanctions.total,
    completedAt: sanctions.completedAt ?? 'never',
    status: sanctions.status,
  });
  for (const s of counts) {
    log.info(`  source ${s.code}`, { records: s.recordCount });
  }
  log.info('mirror:verify — GLEIF mirror', {
    ready: lei.ready,
    entities: lei.entityCount,
    relationships: lei.relationshipCount,
    completedAt: lei.completedAt ?? 'never',
    status: lei.status,
  });

  await service.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('mirror:verify failed:', err);
  process.exit(1);
});
