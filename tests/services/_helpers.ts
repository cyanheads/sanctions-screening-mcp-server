/**
 * @fileoverview Test helpers — build a ScreeningService backed by a fresh
 * temp-file SQLite mirror seeded with the synthetic fixture. Each call gets a
 * unique DB path so suites don't collide.
 * @module tests/services/_helpers
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  FIXTURE_DESIGNATIONS,
  FIXTURE_LEI_ENTITIES,
  FIXTURE_LEI_RELATIONSHIPS,
  FIXTURE_REPORTING_EXCEPTIONS,
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
    reportingExceptions: FIXTURE_REPORTING_EXCEPTIONS,
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
 * Build a ScreeningService against a fresh temp SQLite file WITHOUT seeding or
 * marking any mirror ready — a never-initialized mirror. Use for the delta/init
 * lifecycle tests that assert readiness-gated behavior.
 */
export async function freshService(): Promise<SeededService> {
  const dir = mkdtempSync(join(tmpdir(), 'sanctions-test-'));
  process.env.SANCTIONS_MIRROR_PATH = join(dir, 'fresh.db');
  resetServerConfig();

  const service = buildScreeningService();

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
    reportingExceptions: FIXTURE_REPORTING_EXCEPTIONS,
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

/**
 * Restart the GLOBAL service on its mirror, as a server process starting on a
 * mirror another process left: the new service opens the file afresh. The
 * returned cleanup closes it, then runs `previous`'s.
 */
export async function restartGlobalService(previous: SeededService): Promise<SeededService> {
  await previous.service.close();
  resetScreeningService();
  initScreeningService();
  const service = getScreeningService();
  return {
    service,
    cleanup: async () => {
      await service.close();
      await previous.cleanup();
    },
  };
}

/**
 * Hold `service`'s post-sync index rebuild until `release()`. `held` resolves once
 * a run has written its final sync state and reached the rebuild, which then runs
 * unchanged.
 */
export function holdRebuild(service: ScreeningService): {
  held: Promise<void>;
  release: () => void;
} {
  const rebuild = service.rebuildSearchIndexes.bind(service);
  let reached: () => void = () => {};
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(service, 'rebuildSearchIndexes').mockImplementation(async (outcomes) => {
    reached();
    await gate;
    return rebuild(outcomes);
  });
  return { held, release };
}
