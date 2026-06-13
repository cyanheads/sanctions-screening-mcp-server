/**
 * @fileoverview `mirror:seed` — load the small synthetic fixture into the local
 * mirror and mark it ready, for a quick local smoke run without downloading the
 * real corpus. The fixture names are invented, NOT real sanctions designations.
 * For production data use `mirror:init`.
 *
 * Usage: `bun run mirror:seed`
 * @module scripts/mirror-seed
 */

import {
  FIXTURE_DESIGNATIONS,
  FIXTURE_LEI_ENTITIES,
  FIXTURE_LEI_RELATIONSHIPS,
} from '@/services/screening/fixtures.js';
import { bootstrap } from './_mirror-context.js';

async function main(): Promise<void> {
  const { service, log } = bootstrap();
  await service.seedFixtures({
    designations: FIXTURE_DESIGNATIONS,
    leiEntities: FIXTURE_LEI_ENTITIES,
    leiRelationships: FIXTURE_LEI_RELATIONSHIPS,
  });
  log.notice('mirror:seed — synthetic fixture loaded (NOT real sanctions data)', {
    designations: FIXTURE_DESIGNATIONS.length,
    leiEntities: FIXTURE_LEI_ENTITIES.length,
  });
  await service.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('mirror:seed failed:', err);
  process.exit(1);
});
