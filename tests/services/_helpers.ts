/**
 * @fileoverview Test helpers — build a ScreeningService backed by a fresh
 * temp-file SQLite mirror seeded with the synthetic fixture. Each call gets a
 * unique DB path so suites don't collide.
 * @module tests/services/_helpers
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetServerConfig } from '@/config/server-config.js';
import {
  FIXTURE_DESIGNATIONS,
  FIXTURE_LEI_ENTITIES,
  FIXTURE_LEI_RELATIONSHIPS,
} from '@/services/screening/fixtures.js';
import {
  buildScreeningService,
  getScreeningService,
  initScreeningService,
  resetScreeningService,
  type ScreeningService,
} from '@/services/screening/screening-service.js';

/** A seeded service plus its temp dir and a cleanup fn. */
export interface SeededService {
  cleanup: () => Promise<void>;
  service: ScreeningService;
}

/**
 * Build a ScreeningService against a fresh temp SQLite file and seed it with the
 * synthetic fixture (all sources marked ready). Resets the memoized server
 * config first so `SANCTIONS_MIRROR_PATH` takes effect.
 */
export async function seededService(): Promise<SeededService> {
  const dir = mkdtempSync(join(tmpdir(), 'sanctions-test-'));
  process.env.SANCTIONS_MIRROR_PATH = join(dir, 'test.db');
  resetServerConfig();

  const service = buildScreeningService();
  await service.seedFixtures({
    designations: FIXTURE_DESIGNATIONS,
    leiEntities: FIXTURE_LEI_ENTITIES,
    leiRelationships: FIXTURE_LEI_RELATIONSHIPS,
  });

  return {
    service,
    cleanup: async () => {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
      delete process.env.SANCTIONS_MIRROR_PATH;
      resetServerConfig();
    },
  };
}

/**
 * Seed the GLOBAL screening service (the one tool handlers reach via
 * `getScreeningService()`) against a fresh temp DB. Use for tool-level tests.
 */
export async function seededGlobalService(): Promise<SeededService> {
  const dir = mkdtempSync(join(tmpdir(), 'sanctions-test-'));
  process.env.SANCTIONS_MIRROR_PATH = join(dir, 'test.db');
  resetServerConfig();
  resetScreeningService();
  initScreeningService();

  const service = getScreeningService();
  await service.seedFixtures({
    designations: FIXTURE_DESIGNATIONS,
    leiEntities: FIXTURE_LEI_ENTITIES,
    leiRelationships: FIXTURE_LEI_RELATIONSHIPS,
  });

  return {
    service,
    cleanup: async () => {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
      delete process.env.SANCTIONS_MIRROR_PATH;
      resetServerConfig();
      resetScreeningService();
    },
  };
}

/**
 * Install an EMPTY (never-synced) global service against a fresh temp DB — for
 * testing the mirror-not-ready error contract. The mirror exists but has never
 * completed a sync, so `ready()` is false.
 */
export async function emptyGlobalService(): Promise<SeededService> {
  const dir = mkdtempSync(join(tmpdir(), 'sanctions-test-'));
  process.env.SANCTIONS_MIRROR_PATH = join(dir, 'empty.db');
  resetServerConfig();
  resetScreeningService();
  initScreeningService();
  const service = getScreeningService();
  // Touch the mirrors so the DB file + schema exist, but do not mark ready.
  await service.sourceCounts();
  return {
    service,
    cleanup: async () => {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
      delete process.env.SANCTIONS_MIRROR_PATH;
      resetServerConfig();
      resetScreeningService();
    },
  };
}
