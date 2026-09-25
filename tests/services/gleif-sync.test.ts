/**
 * @fileoverview The GLEIF load and refresh lifecycles against a local stand-in for
 * the Golden Copy API, over a real temp-file mirror. The refresh picks each
 * dataset's delta window from the stored checkpoint, streams it in bounded
 * batches, applies records in document order (upsert, or delete on the marker),
 * and advances `leiAsOf` and the checkpoint once, after every dataset applied. An
 * uncovered gap applies nothing. The load records each golden copy's `ContentDate`.
 * @module tests/services/gleif-sync.test
 */

import type { ServerResponse } from 'node:http';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLEIF_INGEST_BATCH,
  loadGleifGoldenCopies,
  refreshGleif,
} from '@/services/screening/gleif-sync.js';
import type { ScreeningService } from '@/services/screening/screening-service.js';
import {
  type Change,
  type DatasetFiles,
  deltaFiles,
  type EntityRecord,
  type GleifStandIn,
  leiFile,
  repexFile,
  rrFile,
  startGleifStandIn,
} from './_gleif-publication.js';
import { freshService, type SeededService } from './_helpers.js';

const A = '213800AAAAAAAAAAAA11';
const B = '213800BBBBBBBBBBBB22';
const C = '213800CCCCCCCCCCCC33';
const X = '213800XXXXXXXXXXXX44';
const Y = '213800YYYYYYYYYYYY55';
const Z = '213800ZZZZZZZZZZZZ66';
const E = '0292001156F2T0UFG565';
const DIRECT = 'IS_DIRECTLY_CONSOLIDATED_BY';
const ULTIMATE = 'IS_ULTIMATELY_CONSOLIDATED_BY';
const DIRECT_EXC = 'DIRECT_ACCOUNTING_CONSOLIDATION_PARENT';
const ULTIMATE_EXC = 'ULTIMATE_ACCOUNTING_CONSOLIDATION_PARENT';

const CONTENT_DATE = '2026-09-25T10:00:00Z';
const STARTS = {
  IntraDay: '2026-09-25T02:00:00Z',
  LastDay: '2026-09-24T02:00:00Z',
  LastWeek: '2026-09-18T02:00:00Z',
  LastMonth: '2026-08-25T02:00:00Z',
};
const GOLDEN = {
  lei2: '2026-09-25T08:08:49Z',
  rr: '2026-09-25T09:17:31Z',
  repex: '2026-09-25T09:01:50Z',
};

const CHANGES: Change[] = [
  { at: '2026-09-01T12:00:00Z', dataset: 'lei2', record: { lei: C, legalName: 'C RENAMED' } },
  { at: '2026-09-21T12:00:00Z', dataset: 'lei2', record: { lei: B, legalName: 'B RENAMED' } },
  {
    at: '2026-09-21T13:00:00Z',
    dataset: 'repex',
    record: { lei: E, category: DIRECT_EXC, reasons: ['NON_PUBLIC'] },
  },
  {
    at: '2026-09-24T18:00:00Z',
    dataset: 'rr',
    record: { childLei: X, parentLei: Y, relationshipType: DIRECT, deleted: true },
  },
  // Removed, re-added with new reasons: the last record wins.
  {
    at: '2026-09-24T19:00:00Z',
    dataset: 'repex',
    record: { lei: E, category: ULTIMATE_EXC, reasons: ['NO_KNOWN_PERSON'], deleted: true },
  },
  {
    at: '2026-09-24T20:00:00Z',
    dataset: 'repex',
    record: { lei: E, category: ULTIMATE_EXC, reasons: ['NATURAL_PERSONS', 'NON_CONSOLIDATING'] },
  },
  { at: '2026-09-25T05:00:00Z', dataset: 'lei2', record: { lei: A, legalName: 'A RENAMED' } },
];

const SEEDED_AS_OF = '2026-09-19T09:00:00.000Z';

let standIn: GleifStandIn;
let harness: SeededService;
let svc: ScreeningService;
const signal = () => new AbortController().signal;
const ctx = createMockContext();

/** The publication under test, optionally with some files replaced. */
function publication(
  golden: {
    lei2?: EntityRecord[];
    rr?: Parameters<typeof rrFile>[1];
    repex?: Parameters<typeof repexFile>[1];
  } = {},
): Record<'lei2' | 'rr' | 'repex', DatasetFiles> {
  const deltas = deltaFiles(CHANGES, CONTENT_DATE, STARTS);
  return {
    lei2: { full: leiFile({ contentDate: GOLDEN.lei2 }, golden.lei2 ?? []), deltas: deltas.lei2 },
    rr: { full: rrFile({ contentDate: GOLDEN.rr }, golden.rr ?? []), deltas: deltas.rr },
    repex: {
      full: repexFile({ contentDate: GOLDEN.repex }, golden.repex ?? []),
      deltas: deltas.repex,
    },
  };
}

/** Seed a ready mirror as its last load left it, stamped with `checkpoint`. */
async function seed(target: ScreeningService, checkpoint: Record<string, string>): Promise<void> {
  const names: [string, string][] = [
    [A, 'A OLD'],
    [B, 'B OLD'],
    [C, 'C OLD'],
    [X, 'X HOLDINGS'],
    [Y, 'Y HOLDINGS'],
    [Z, 'Z HOLDINGS'],
  ];
  await target.ingestLeiEntities(
    names.map(([lei, legalName]) => ({ lei, legalName, otherNames: [] })),
  );
  await target.ingestLeiRelationships([
    { childLei: X, parentLei: Y, relationshipType: DIRECT, relationshipStatus: 'ACTIVE' },
    { childLei: X, parentLei: Z, relationshipType: ULTIMATE, relationshipStatus: 'ACTIVE' },
  ]);
  await target.ingestReportingExceptions([
    { lei: E, category: ULTIMATE_EXC, reasons: ['NO_KNOWN_PERSON'] },
  ]);
  await target.leiEntities.store.writeState({
    status: 'complete',
    completedAt: SEEDED_AS_OF,
    total: names.length,
    checkpoint: JSON.stringify(checkpoint),
  });
}

/** Every row the refresh can touch, for before/after comparison. */
async function dump(target: ScreeningService) {
  const handle = await target.leiEntities.raw();
  return {
    entities: handle
      .prepare<{ lei: string; legal_name: string }>(
        'SELECT lei, legal_name FROM lei_entity ORDER BY lei',
      )
      .all(),
    relationships: handle
      .prepare<{ child_lei: string; parent_lei: string; relationship_type: string }>(
        'SELECT child_lei, parent_lei, relationship_type FROM lei_relationship ORDER BY 1, 2, 3',
      )
      .all(),
    exceptions: handle
      .prepare<{ lei: string; category: string; reasons: string }>(
        'SELECT lei, category, reasons FROM lei_reporting_exception ORDER BY 1, 2',
      )
      .all(),
  };
}

const names = async () =>
  Object.fromEntries((await svc.getLeiEntitiesBatch([A, B, C])).map((e) => [e.lei, e.legalName]));

beforeEach(async () => {
  standIn = await startGleifStandIn();
  standIn.serve(publication());
  process.env.GLEIF_GOLDEN_COPY_BASE_URL = standIn.base;
  harness = await freshService();
  svc = harness.service;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.cleanup();
  await standIn.close();
  delete process.env.GLEIF_GOLDEN_COPY_BASE_URL;
});

describe('refreshGleif — window selection from the stored checkpoint', () => {
  it.each([
    ['within the IntraDay span', '2026-09-25T03:00:00Z', 'IntraDay', 'B OLD', 'C OLD'],
    ["exactly at LastDay's DeltaStart", STARTS.LastDay, 'LastDay', 'B OLD', 'C OLD'],
    ['six days back', '2026-09-19T08:00:00Z', 'LastWeek', 'B RENAMED', 'C OLD'],
    ['twenty days back', '2026-09-05T08:00:00Z', 'LastMonth', 'B RENAMED', 'C RENAMED'],
  ])('applies %s → %s', async (_label, at, window, bName, cName) => {
    await seed(svc, { lei2: at, rr: at, repex: at });

    const outcome = await refreshGleif(svc, signal(), { loadMissingExceptions: true });

    expect(outcome.needsInit).toEqual([]);
    expect(outcome.applied.lei2?.source).toBe(window);
    expect(outcome.applied.rr?.source).toBe(window);
    expect(await names()).toEqual({ [A]: 'A RENAMED', [B]: bName, [C]: cName });
    // Nothing larger than the chosen window was downloaded.
    const larger = ['IntraDay', 'LastDay', 'LastWeek', 'LastMonth'].slice(
      ['IntraDay', 'LastDay', 'LastWeek', 'LastMonth'].indexOf(window) + 1,
    );
    for (const w of larger) expect(standIn.requested).not.toContain(`/files/lei2-${w}.xml`);
    expect(await svc.gleifCheckpoint()).toEqual({
      lei2: CONTENT_DATE,
      rr: CONTENT_DATE,
      repex: CONTENT_DATE,
    });
    const readiness = await svc.leiReadiness();
    expect(readiness.completedAt).not.toBe(SEEDED_AS_OF);
    expect(readiness.total).toBe(readiness.entityCount);
  });

  it('applies deletions and document order on Level 2 and the exceptions', async () => {
    await seed(svc, { lei2: STARTS.LastWeek, rr: STARTS.LastWeek, repex: STARTS.LastWeek });
    await refreshGleif(svc, signal(), { loadMissingExceptions: true });

    expect((await svc.getRelationships(X, 'parents')).map((r) => r.relationshipType)).toEqual([
      ULTIMATE,
    ]);
    expect(await svc.getReportingExceptions([E])).toEqual(
      new Map([
        [
          E,
          [
            { category: DIRECT_EXC, reasons: ['NON_PUBLIC'] },
            { category: ULTIMATE_EXC, reasons: ['NATURAL_PERSONS', 'NON_CONSOLIDATING'] },
          ],
        ],
      ]),
    );
  });

  it('treats a dataset already at the publication as current and applies nothing to it', async () => {
    await seed(svc, { lei2: CONTENT_DATE, rr: CONTENT_DATE, repex: CONTENT_DATE });
    await svc.ingestLeiEntities([{ lei: A, legalName: 'A NEWER', otherNames: [] }]);

    const outcome = await refreshGleif(svc, signal(), { loadMissingExceptions: true });

    expect(outcome.applied.lei2).toMatchObject({ source: 'current', records: 0 });
    expect((await names())[A]).toBe('A NEWER');
    expect(await svc.gleifCheckpoint()).toEqual({
      lei2: CONTENT_DATE,
      rr: CONTENT_DATE,
      repex: CONTENT_DATE,
    });
  });
});

describe('refreshGleif — a gap that needs mirror:init', () => {
  it('applies nothing and moves nothing when no window covers the checkpoint', async () => {
    const old = '2026-08-01T00:00:00Z';
    await seed(svc, { lei2: old, rr: old, repex: old });
    const before = await dump(svc);

    const outcome = await refreshGleif(svc, signal(), { loadMissingExceptions: true });

    expect(outcome.needsInit).toEqual(['lei2', 'rr', 'repex']);
    expect(await dump(svc)).toEqual(before);
    expect((await svc.leiReadiness()).completedAt).toBe(SEEDED_AS_OF);
    expect(await svc.gleifCheckpoint()).toEqual({ lei2: old, rr: old, repex: old });
  });

  it('applies no dataset when any one of Level 1 and Level 2 is uncovered', async () => {
    await seed(svc, { lei2: STARTS.LastWeek, rr: '2026-08-01T00:00:00Z', repex: STARTS.LastWeek });
    const before = await dump(svc);

    const outcome = await refreshGleif(svc, signal(), { loadMissingExceptions: true });

    expect(outcome.needsInit).toEqual(['rr']);
    expect(await dump(svc)).toEqual(before);
    expect((await svc.leiReadiness()).completedAt).toBe(SEEDED_AS_OF);
  });

  it('never touches a never-initialized mirror, and leaves it not ready (#5)', async () => {
    const outcome = await refreshGleif(svc, signal(), { loadMissingExceptions: true });

    expect(outcome.needsInit).toEqual(['lei2', 'rr']);
    expect(standIn.requested).toEqual([]);
    expect(await svc.leiReady()).toBe(false);
  });
});

describe('refreshGleif — the exceptions dataset with no recorded load', () => {
  it('loads the golden copy in place of stale rows when asked (mirror:refresh)', async () => {
    standIn.serve(
      publication({
        repex: [{ lei: E, category: DIRECT_EXC, reasons: ['NATURAL_PERSONS'] }],
      }),
    );
    await seed(svc, { lei2: STARTS.LastDay, rr: STARTS.LastDay });

    const outcome = await refreshGleif(svc, signal(), { loadMissingExceptions: true });

    expect(outcome.applied.repex).toEqual({
      source: 'golden_copy',
      records: 1,
      contentDate: GOLDEN.repex,
    });
    // The seeded ULTIMATE row came from no recorded load; the golden copy replaces it.
    expect(await svc.getReportingExceptions([E])).toEqual(
      new Map([[E, [{ category: DIRECT_EXC, reasons: ['NATURAL_PERSONS'] }]]]),
    );
    expect(await svc.gleifCheckpoint()).toEqual({
      lei2: CONTENT_DATE,
      rr: CONTENT_DATE,
      repex: GOLDEN.repex,
    });
    expect(await svc.reportingExceptionsLoaded()).toBe(true);
  });

  it('skips the dataset, and applies the rest, when not asked (the HTTP schedule)', async () => {
    await seed(svc, { lei2: STARTS.LastDay, rr: STARTS.LastDay });

    const outcome = await refreshGleif(svc, signal(), { loadMissingExceptions: false });

    expect(outcome.skipped).toEqual(['repex']);
    expect(outcome.applied.lei2?.source).toBe('LastDay');
    expect(standIn.requested.filter((path) => path.includes('repex'))).toEqual([]);
    expect(await svc.reportingExceptionsLoaded()).toBe(false);
    expect(await svc.gleifCheckpoint()).toEqual({ lei2: CONTENT_DATE, rr: CONTENT_DATE });
  });
});

describe('refreshGleif — bounded, restartable apply', () => {
  it('ingests a window in bounded batches while the file is still arriving', async () => {
    const total = GLEIF_INGEST_BATCH + 5;
    const entities = Array.from({ length: total }, (_unused, i) => ({
      lei: `5493${String(i).padStart(14, '0')}00`,
      legalName: `BULK ENTITY ${i}`,
    }));
    const xml = leiFile({ contentDate: CONTENT_DATE, deltaStart: STARTS.LastMonth }, entities);
    // Everything up to two records past the first full batch arrives; the rest waits.
    const split = xml.indexOf(`<lei:LEI>${entities[GLEIF_INGEST_BATCH + 2]!.lei}`);
    let releaseTail = () => {};
    const tailReleased = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    standIn.serve(publication(), {
      '/files/lei2-LastMonth.xml': (res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.write(xml.slice(0, split));
        void tailReleased.then(() => res.end(xml.slice(split)));
      },
    });
    const batches: number[] = [];
    const ingest = svc.ingestLeiEntities.bind(svc);
    vi.spyOn(svc, 'ingestLeiEntities').mockImplementation(async (batch) => {
      batches.push(batch.length);
      releaseTail(); // a buffered parse would never get here before the tail arrives
      await ingest(batch);
    });
    const at = '2026-09-05T08:00:00Z';
    await seed(svc, { lei2: at, rr: at, repex: at });
    batches.length = 0;

    await refreshGleif(svc, signal(), { loadMissingExceptions: true });

    expect(Math.max(...batches)).toBeLessThanOrEqual(GLEIF_INGEST_BATCH);
    expect(batches.reduce((sum, n) => sum + n, 0)).toBe(total);
    expect((await svc.getLeiEntitiesBatch([entities[total - 1]!.lei]))[0]?.legalName).toBe(
      `BULK ENTITY ${total - 1}`,
    );
  }, 60_000);

  it('leaves leiAsOf and the checkpoint where they were when interrupted, and a re-run converges', async () => {
    const at = STARTS.LastWeek;
    const checkpoint = { lei2: at, rr: at, repex: at };
    const full = publication();
    const rrWeek = full.rr.deltas.LastWeek ?? '';
    standIn.serve(full, {
      // Cut mid-document: the transfer ends cleanly before the root closes.
      '/files/rr-LastWeek.xml': rrWeek.slice(0, rrWeek.indexOf('</rr:RelationshipRecord>') + 10),
    });
    await seed(svc, checkpoint);

    await expect(refreshGleif(svc, signal(), { loadMissingExceptions: true })).rejects.toThrow();
    expect((await svc.leiReadiness()).completedAt).toBe(SEEDED_AS_OF);
    expect(await svc.gleifCheckpoint()).toEqual(checkpoint);

    standIn.serve(full);
    await refreshGleif(svc, signal(), { loadMissingExceptions: true });

    // A clean run over an identically seeded mirror ends in the same rows.
    const clean = await freshService();
    try {
      await seed(clean.service, checkpoint);
      await refreshGleif(clean.service, signal(), { loadMissingExceptions: true });
      expect(await dump(svc)).toEqual(await dump(clean.service));
      expect(await svc.gleifCheckpoint()).toEqual(await clean.service.gleifCheckpoint());
    } finally {
      await clean.cleanup();
    }
  });
});

describe('refreshGleif — the name index follows every Level 1 write (#24)', () => {
  const renamed: Change[] = [
    {
      at: '2026-09-24T12:00:00Z',
      dataset: 'lei2',
      record: {
        lei: A,
        legalName: 'AURORA RENAMED HOLDINGS',
        otherNames: [{ name: 'A OLD', type: 'PREVIOUS_LEGAL_NAME' }],
      },
    },
  ];

  const resolveName = (query: string) =>
    svc.resolveEntity({ query, matchMode: 'strict', status: 'any', limit: 10 }, ctx);

  beforeEach(async () => {
    await svc.ingestLeiEntities([
      { lei: A, legalName: 'A OLD', otherNames: [] },
      { lei: B, legalName: 'B OLD', otherNames: [] },
    ]);
    await svc.markLeiReady(2, {
      lei2: STARTS.LastWeek,
      rr: STARTS.LastWeek,
      repex: STARTS.LastWeek,
    });
    const deltas = deltaFiles(renamed, CONTENT_DATE, STARTS);
    standIn.serve({
      lei2: { full: leiFile({ contentDate: GOLDEN.lei2 }, []), deltas: deltas.lei2 },
      rr: { full: rrFile({ contentDate: GOLDEN.rr }, []), deltas: deltas.rr },
      repex: { full: repexFile({ contentDate: GOLDEN.repex }, []), deltas: deltas.repex },
    });
  });

  it('reindexes a renamed entity under its new legal name and its previous one', async () => {
    await refreshGleif(svc, signal(), { loadMissingExceptions: true });

    expect((await resolveName('Aurora Renamed Holdings')).matches[0]).toMatchObject({
      lei: A,
      matchedNameType: 'LEGAL_NAME',
      matchType: 'exact',
    });
    const previous = await resolveName('A OLD');
    expect(previous.matches.filter((m) => m.lei === A)).toEqual([
      expect.objectContaining({
        legalName: 'AURORA RENAMED HOLDINGS',
        matchedName: 'A OLD',
        matchedNameType: 'PREVIOUS_LEGAL_NAME',
      }),
    ]);
    // The refresh carried the recorded build forward with the new leiAsOf.
    expect(previous.alternateNamesIndexed).toBe(true);
  });

  it('writes an entity and its names in one transaction, so a failed batch leaves neither', async () => {
    const handle = await svc.leiEntities.raw();
    const original = handle.prepare.bind(handle);
    handle.prepare = ((sql: string) => {
      const statement = original(sql);
      if (!/INSERT INTO lei_name\b/.test(sql)) return statement;
      return {
        ...statement,
        run: (...params: unknown[]) => {
          if (params.includes('AURORA RENAMED HOLDINGS')) throw new Error('name write failed');
          return (statement.run as (...args: unknown[]) => unknown)(...params);
        },
      };
    }) as typeof handle.prepare;
    try {
      await expect(refreshGleif(svc, signal(), { loadMissingExceptions: true })).rejects.toThrow(
        'name write failed',
      );
    } finally {
      handle.prepare = original;
    }
    expect((await names())[A]).toBe('A OLD');
    expect((await resolveName('A OLD')).matches[0]).toMatchObject({
      lei: A,
      matchedNameType: 'LEGAL_NAME',
    });
  });
});

describe('loadGleifGoldenCopies — mirror:init', () => {
  it("loads all three golden copies and records each one's ContentDate as the checkpoint", async () => {
    standIn.serve(
      publication({
        lei2: [
          { lei: A, legalName: 'A GOLDEN' },
          { lei: X, legalName: 'X GOLDEN' },
        ],
        rr: [{ childLei: X, parentLei: A, relationshipType: DIRECT }],
        repex: [{ lei: A, category: DIRECT_EXC, reasons: ['NATURAL_PERSONS'] }],
      }),
    );

    const loaded = await loadGleifGoldenCopies(svc, signal());

    expect(loaded).toMatchObject({ entities: 2, relationships: 1, exceptions: 1 });
    expect(await svc.gleifCheckpoint()).toEqual(GOLDEN);
    expect(await svc.leiReady()).toBe(true);
    expect(await svc.reportingExceptionsLoaded()).toBe(true);
    expect(await svc.getReportingExceptions([A])).toEqual(
      new Map([[A, [{ category: DIRECT_EXC, reasons: ['NATURAL_PERSONS'] }]]]),
    );
  });

  it('indexes every legal, other, and transliterated name it loads (#24)', async () => {
    standIn.serve(
      publication({
        lei2: [
          {
            lei: A,
            legalName: 'ООО АЛЬФА',
            otherNames: [{ name: 'Alpha Trading House', type: 'TRADING_OR_OPERATING_NAME' }],
            transliteratedNames: [
              { name: 'OOO ALFA', type: 'PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME' },
            ],
          },
        ],
      }),
    );

    await loadGleifGoldenCopies(svc, signal());

    const resolveName = (query: string) =>
      svc.resolveEntity({ query, matchMode: 'strict', status: 'any', limit: 10 }, ctx);
    expect((await resolveName('Alpha Trading House')).matches[0]).toMatchObject({
      lei: A,
      legalName: 'ООО АЛЬФА',
      matchedNameType: 'TRADING_OR_OPERATING_NAME',
    });
    expect((await resolveName('OOO ALFA')).matches[0]).toMatchObject({
      lei: A,
      matchedNameType: 'PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME',
    });
    expect((await resolveName('ООО АЛЬФА')).alternateNamesIndexed).toBe(true);
  });

  it('clears the checkpoint first, so an interrupted load leaves nothing to refresh from', async () => {
    await seed(svc, { lei2: STARTS.LastDay, rr: STARTS.LastDay, repex: STARTS.LastDay });
    const rrFull = rrFile({ contentDate: GOLDEN.rr }, [
      { childLei: X, parentLei: A, relationshipType: DIRECT },
      { childLei: A, parentLei: X, relationshipType: DIRECT },
    ]);
    standIn.serve(publication(), {
      '/files/rr-full.xml': rrFull.slice(0, rrFull.indexOf('</rr:RelationshipRecord>') + 10),
    });

    await expect(loadGleifGoldenCopies(svc, signal())).rejects.toThrow();
    expect(await svc.gleifCheckpoint()).toEqual({});
    // Still queryable on the last completed load.
    expect(await svc.leiReady()).toBe(true);

    const outcome = await refreshGleif(svc, signal(), { loadMissingExceptions: true });
    expect(outcome.needsInit).toEqual(['lei2', 'rr']);
  });
});
