/**
 * @fileoverview LEI resolution over the GLEIF name index: every published name
 * — legal, other, and transliterated — reaches strict and fuzzy retrieval and is
 * reported with its type (#24); blocking and strict lookups are index lookups
 * with the jurisdiction resolved inside them (#33, #36); and the status filter
 * matches exactly the registration state it names (#23).
 * @module tests/services/lei-resolution.test
 */

import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_LEI_ENTITIES } from '@/services/screening/fixtures.js';
import type {
  ResolveEntityOptions,
  ScreeningService,
} from '@/services/screening/screening-service.js';
import { fold, jaroWinkler, tokenCoverage, tokenize } from '@/services/screening/text-matching.js';
import type { NormalizedLeiEntity } from '@/services/screening/types.js';
import { type SeededService, seededService } from './_helpers.js';

let seeded: SeededService;
let svc: ScreeningService;
const ctx = createMockContext();

beforeEach(async () => {
  seeded = await seededService();
  svc = seeded.service;
});

afterEach(async () => {
  await seeded.cleanup();
});

/** A well-formed test LEI: the tag padded to 18 characters, then two digits. */
const lei = (tag: string): string => `${tag.padEnd(18, '0')}42`;

const resolve = (opts: Partial<ResolveEntityOptions> & { query: string }) =>
  svc.resolveEntity({ matchMode: 'strict', status: 'any', limit: 50, ...opts }, ctx);

describe('resolveEntity — result shape', () => {
  it('returns an exact strict match on the legal name with its record fields', async () => {
    const res = await svc.resolveEntity(
      { query: 'Fictional Trading Company LLC', matchMode: 'strict', status: 'issued', limit: 10 },
      ctx,
    );
    expect(res.matches[0]).toEqual({
      lei: '5493001KJTIIGC8Y1R12',
      legalName: 'Fictional Trading Company LLC',
      matchedName: 'Fictional Trading Company LLC',
      matchedNameType: 'LEGAL_NAME',
      matchType: 'exact',
      jurisdiction: 'US',
      status: 'ISSUED',
    });
    expect(res).toMatchObject({ modeUsed: 'strict', totalAvailableBasis: 'exact' });
  });

  it('returns an approximate match with its raw score and coverage', async () => {
    const res = await svc.resolveEntity(
      { query: 'Fictionel Trading Compny', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    expect(res.matches.find((m) => m.lei === '5493001KJTIIGC8Y1R12')).toEqual({
      lei: '5493001KJTIIGC8Y1R12',
      legalName: 'Fictional Trading Company LLC',
      matchedName: 'Fictional Trading Company LLC',
      matchedNameType: 'LEGAL_NAME',
      matchType: 'approximate',
      score: 1,
      queryTokenCoverage: { covered: 3, total: 3 },
      jurisdiction: 'US',
      status: 'ISSUED',
    });
  });
});

describe('getLeiEntity — stored payload', () => {
  it('returns the record as ingested, with its alternate names typed', async () => {
    expect(await svc.getLeiEntity('5493001KJTIIGC8Y1R12')).toEqual({
      ...FIXTURE_LEI_ENTITIES[0],
      alternateNames: [{ name: 'Fictional Trading Co', type: 'PREVIOUS_LEGAL_NAME' }],
    });
  });

  it('reads a record stored with bare-string other names in the same shape, type unknown', async () => {
    await svc.ingestLeiEntities([
      { lei: lei('UNTYPEDREAD'), legalName: 'Untyped Read Ltd', otherNames: ['Untyped Trading'] },
    ]);
    expect(await svc.getLeiEntity(lei('UNTYPEDREAD'))).toEqual({
      lei: lei('UNTYPEDREAD'),
      legalName: 'Untyped Read Ltd',
      otherNames: ['Untyped Trading'],
      alternateNames: [{ name: 'Untyped Trading', type: 'UNKNOWN' }],
    });
  });
});

// ─── #24: every published name takes part in retrieval ────────────────────────

const TRADING = lei('VERIDANEVACIB');
const PREVIOUS = lei('ZORNEFTPAO');
const TRANSLIT = lei('FENGRUIHK');
const ALT_LANGUAGE = lei('BRIGHTWATERHU');
const UNTYPED = lei('KESTRELNOM');
const MULTI = lei('HARBORLIGHT');

const ALTERNATE_ENTITIES: NormalizedLeiEntity[] = [
  {
    lei: TRADING,
    legalName: 'Veridane Agricole Corporate and Investment Bank',
    otherNames: ['CIB VACIB'],
    alternateNames: [{ name: 'CIB VACIB', type: 'TRADING_OR_OPERATING_NAME' }],
    jurisdiction: 'FR',
    status: 'ISSUED',
  },
  {
    lei: lei('VACIBPENSION'),
    legalName: 'VACIB Pension Limited Partnership',
    otherNames: [],
    jurisdiction: 'FR',
    status: 'ISSUED',
  },
  {
    lei: PREVIOUS,
    legalName: 'Публичное акционерное общество "Нефтяная компания "Зорвельт"',
    otherNames: ['Zorvelt Oil Company', 'Zorvelt'],
    alternateNames: [
      { name: 'Zorvelt Oil Company', type: 'PREVIOUS_LEGAL_NAME' },
      { name: 'Zorvelt', type: 'TRADING_OR_OPERATING_NAME' },
    ],
    jurisdiction: 'RU',
    status: 'ISSUED',
  },
  {
    lei: lei('OKOMUOILPALM'),
    legalName: 'Okomu Oil Palm Company PLC',
    otherNames: [],
    jurisdiction: 'NG',
    status: 'ISSUED',
  },
  {
    lei: TRANSLIT,
    legalName: '豐瑞國際證券有限公司',
    otherNames: [],
    alternateNames: [
      {
        name: 'FENGRUI INTERNATIONAL SECURITIES LIMITED',
        type: 'PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME',
      },
      {
        name: 'Feng Rui Guo Ji Zheng Quan You Xian Gong Si',
        type: 'AUTO_ASCII_TRANSLITERATED_LEGAL_NAME',
      },
    ],
    jurisdiction: 'HK',
    status: 'ISSUED',
  },
  {
    lei: ALT_LANGUAGE,
    legalName: 'Brightwater Kft',
    otherNames: ['Fényesvíz Korlátolt Felelősségű Társaság'],
    alternateNames: [
      {
        name: 'Fényesvíz Korlátolt Felelősségű Társaság',
        type: 'ALTERNATIVE_LANGUAGE_LEGAL_NAME',
      },
    ],
    jurisdiction: 'HU',
    status: 'ISSUED',
  },
  {
    lei: UNTYPED,
    legalName: 'Kestrel Nominees Ltd',
    otherNames: ['Falconry Trustees'],
    jurisdiction: 'GB',
    status: 'ISSUED',
  },
  {
    lei: MULTI,
    legalName: 'Harbor Light Shipping Ltd',
    otherNames: ['Harbor Light Shipping Limited', 'Harborlight Lines'],
    alternateNames: [
      { name: 'Harbor Light Shipping Limited', type: 'PREVIOUS_LEGAL_NAME' },
      { name: 'Harborlight Lines', type: 'TRADING_OR_OPERATING_NAME' },
    ],
    jurisdiction: 'GB',
    status: 'ISSUED',
  },
];

describe('alternate names in retrieval (#24)', () => {
  beforeEach(async () => {
    await svc.ingestLeiEntities(ALTERNATE_ENTITIES);
  });

  it('resolves an entity by a trading name its legal name does not contain, strict', async () => {
    const res = await resolve({ query: 'VACIB' });
    expect(res.modeUsed).toBe('strict');
    expect(res.matches.find((m) => m.lei === TRADING)).toMatchObject({
      legalName: 'Veridane Agricole Corporate and Investment Bank',
      matchedName: 'CIB VACIB',
      matchedNameType: 'TRADING_OR_OPERATING_NAME',
      matchType: 'strong',
    });
    expect(res.matches.map((m) => m.lei)).toContain(lei('VACIBPENSION'));
  });

  it('resolves the same entity by that trading name through the fuzzy pass', async () => {
    const res = await resolve({ query: 'VACIBB' });
    expect(res.modeUsed).toBe('fuzzy');
    expect(res.matches.find((m) => m.lei === TRADING)).toMatchObject({
      matchedName: 'CIB VACIB',
      matchedNameType: 'TRADING_OR_OPERATING_NAME',
      matchType: 'approximate',
    });
  });

  it('reports a previous legal name as a previous name and keeps the registered legal name', async () => {
    const strict = await resolve({ query: 'Zorvelt Oil Company' });
    expect(strict.matches.find((m) => m.lei === PREVIOUS)).toMatchObject({
      legalName: 'Публичное акционерное общество "Нефтяная компания "Зорвельт"',
      matchedName: 'Zorvelt Oil Company',
      matchedNameType: 'PREVIOUS_LEGAL_NAME',
      matchType: 'exact',
    });

    const fuzzy = await resolve({ query: 'Zorvelt Oil Compny' });
    expect(fuzzy.modeUsed).toBe('fuzzy');
    const match = fuzzy.matches.find((m) => m.lei === PREVIOUS);
    expect(match).toMatchObject({
      matchedName: 'Zorvelt Oil Company',
      matchedNameType: 'PREVIOUS_LEGAL_NAME',
      matchType: 'approximate',
      queryTokenCoverage: { covered: 3, total: 3 },
    });
    // Ranked by the previous name's own coverage, ahead of a legal name sharing one word.
    const okomu = fuzzy.matches.findIndex((m) => m.lei === lei('OKOMUOILPALM'));
    expect(okomu).toBeGreaterThan(fuzzy.matches.findIndex((m) => m.lei === PREVIOUS));
  });

  it('resolves a preferred ASCII transliteration of a legal name in another script', async () => {
    const res = await resolve({ query: 'Fengrui International Securities Limited' });
    expect(res.matches.find((m) => m.lei === TRANSLIT)).toMatchObject({
      legalName: '豐瑞國際證券有限公司',
      matchedName: 'FENGRUI INTERNATIONAL SECURITIES LIMITED',
      matchedNameType: 'PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME',
      matchType: 'exact',
    });
  });

  it.each([
    ['Harborlight Lines', MULTI, 'TRADING_OR_OPERATING_NAME'],
    ['Zorvelt Oil Company', PREVIOUS, 'PREVIOUS_LEGAL_NAME'],
    ['Fényesvíz Korlátolt Felelősségű Társaság', ALT_LANGUAGE, 'ALTERNATIVE_LANGUAGE_LEGAL_NAME'],
    ['Feng Rui Guo Ji Zheng Quan', TRANSLIT, 'AUTO_ASCII_TRANSLITERATED_LEGAL_NAME'],
    ['Fengrui Securities', TRANSLIT, 'PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME'],
    ['Falconry Trustees', UNTYPED, 'UNKNOWN'],
  ])('brings %j to retrieval under its type', async (query, target, type) => {
    const res = await resolve({ query });
    expect(res.matches.find((m) => m.lei === target)?.matchedNameType).toBe(type);
  });

  it('reports a name stored without a type as type unknown, never as a trading name', async () => {
    const res = await resolve({ query: 'Falconry Trustees' });
    const match = res.matches.find((m) => m.lei === UNTYPED);
    expect(match).toMatchObject({ matchedName: 'Falconry Trustees', matchedNameType: 'UNKNOWN' });
  });

  it('yields one candidate per LEI when several of its names match, preferring an exact name', async () => {
    const strong = await resolve({ query: 'Harbor Light Shipping' });
    expect(strong.matches.filter((m) => m.lei === MULTI)).toEqual([
      expect.objectContaining({
        matchedName: 'Harbor Light Shipping Ltd',
        matchedNameType: 'LEGAL_NAME',
        matchType: 'strong',
      }),
    ]);

    const exact = await resolve({ query: 'Harbor Light Shipping Limited' });
    expect(exact.matches.filter((m) => m.lei === MULTI)).toEqual([
      expect.objectContaining({
        matchedName: 'Harbor Light Shipping Limited',
        matchedNameType: 'PREVIOUS_LEGAL_NAME',
        matchType: 'exact',
      }),
    ]);
  });

  it('describes one name with matchedName, score, and coverage on a fuzzy candidate', async () => {
    const query = 'Harbor Lite Shipping Limited';
    const res = await resolve({ query, matchMode: 'fuzzy' });
    const matches = res.matches.filter((m) => m.lei === MULTI && m.matchType === 'approximate');
    expect(res.matches.filter((m) => m.lei === MULTI)).toHaveLength(1);
    expect(matches).toHaveLength(1);
    const [match] = matches;
    expect(match?.legalName).toBe('Harbor Light Shipping Ltd');
    expect(match?.matchedNameType).toBe('PREVIOUS_LEGAL_NAME');
    const folded = fold(match?.matchedName ?? '');
    const queryTokens = tokenize(fold(query));
    const nameTokens = tokenize(folded);
    const tokenBest = Math.max(
      ...queryTokens.flatMap((q) => nameTokens.map((n) => jaroWinkler(q, n))),
    );
    expect(match?.score).toBe(
      Number(Math.max(tokenBest, jaroWinkler(fold(query), folded)).toFixed(4)),
    );
    expect(match?.queryTokenCoverage).toEqual({
      covered: tokenCoverage(queryTokens, nameTokens, 0.85),
      total: queryTokens.length,
    });
  });

  it('pools a Han-script legal name queried without its leading characters', async () => {
    const res = await resolve({ query: '國際證券有限公司', matchMode: 'fuzzy' });
    expect(res.matches.find((m) => m.lei === TRANSLIT)).toMatchObject({
      matchedNameType: 'LEGAL_NAME',
      matchType: 'approximate',
    });
  });

  it('leaves legal-name resolution, its classification, and its count basis unchanged', async () => {
    const res = await resolve({ query: 'Okomu Oil Palm Company PLC', status: 'issued' });
    expect(res.matches).toEqual([
      expect.objectContaining({
        lei: lei('OKOMUOILPALM'),
        matchedNameType: 'LEGAL_NAME',
        matchType: 'exact',
      }),
    ]);
    expect(res).toMatchObject({ totalAvailable: 1, totalAvailableBasis: 'exact' });
  });

  it('reports the alternate-name index as built on a mirror the current release wrote', async () => {
    expect((await resolve({ query: 'VACIB' })).alternateNamesIndexed).toBe(true);
  });

  it('indexes a name that folds like the legal name once, reported as the legal name', async () => {
    await svc.ingestLeiEntities([
      {
        lei: lei('FOLDSAME'),
        legalName: 'Nordvik Shipping A/S',
        otherNames: ['NORDVIK SHIPPING A.S.', '***'],
        alternateNames: [
          { name: 'NORDVIK SHIPPING A.S.', type: 'PREVIOUS_LEGAL_NAME' },
          { name: '***', type: 'TRADING_OR_OPERATING_NAME' },
        ],
      },
    ]);
    const handle = await svc.leiEntities.raw();
    const rows = handle
      .prepare<{ name_type: string }>('SELECT name_type FROM lei_name WHERE lei = ?')
      .all(lei('FOLDSAME'));
    expect(rows.map((r) => r.name_type)).toEqual(['LEGAL_NAME']);
    expect((await resolve({ query: 'Nordvik Shipping A S' })).matches[0]).toMatchObject({
      lei: lei('FOLDSAME'),
      matchedName: 'Nordvik Shipping A/S',
      matchedNameType: 'LEGAL_NAME',
      matchType: 'exact',
    });
  });

  it('replaces an entity’s names when it is written again, leaving none of the old ones', async () => {
    await svc.ingestLeiEntities([
      { ...ALTERNATE_ENTITIES[0]!, alternateNames: [], otherNames: [] } as NormalizedLeiEntity,
    ]);
    const res = await resolve({ query: 'VACIB' });
    expect(res.matches.map((m) => m.lei)).not.toContain(TRADING);
  });

  it('counts one candidate per LEI against the strict row cap, and says when the cap binds', async () => {
    await svc.ingestLeiEntities(
      Array.from({ length: 1100 }, (_unused, i) => ({
        lei: lei(`CAPPED${String(i).padStart(4, '0')}X`),
        legalName: `Capstone Maritime ${i} Ltd`,
        otherNames: [`Capstone Maritime Trading ${i}`],
        alternateNames: [
          { name: `Capstone Maritime Trading ${i}`, type: 'TRADING_OR_OPERATING_NAME' },
        ],
      })),
    );
    const capped = await resolve({ query: 'Capstone Maritime', limit: 5 });
    expect(capped).toMatchObject({ totalAvailableBasis: 'lower_bound' });
    expect(new Set(capped.matches.map((m) => m.lei)).size).toBe(5);
    expect(capped.totalAvailable).toBeLessThanOrEqual(1100);

    // Under the cap, several matching names still count once per LEI, exactly.
    const narrow = await resolve({ query: 'Capstone Maritime 7' });
    expect(narrow).toMatchObject({ totalAvailable: 1, totalAvailableBasis: 'exact' });
    expect(narrow.matches[0]?.matchedNameType).toBe('LEGAL_NAME');
  });

  it('stops serving from the index after a write it did not follow, and says so', async () => {
    // What an earlier release does after a rollback: rows through the store's
    // generic upsert, then a new completion time — the name index never sees them.
    await svc.leiEntities.store.applyBatch(
      [
        {
          lei: lei('ROLLEDBACK'),
          legal_name: 'Rollback Writer Ltd',
          normalized_name: fold('Rollback Writer Ltd'),
          other_names: '[]',
          payload: JSON.stringify({
            lei: lei('ROLLEDBACK'),
            legalName: 'Rollback Writer Ltd',
            otherNames: [],
          }),
        },
      ],
      [],
    );
    await svc.leiEntities.store.writeState({
      status: 'complete',
      completedAt: '2027-01-01T00:00:00.000Z',
      total: 1,
    });

    const res = await resolve({ query: 'Rollback Writer Ltd' });
    expect(res.alternateNamesIndexed).toBe(false);
    expect(res.matches[0]).toMatchObject({ lei: lei('ROLLEDBACK'), matchedNameType: 'LEGAL_NAME' });
    // Only a golden-copy load records a build again.
    await svc.markLeiReady(1);
    expect((await resolve({ query: 'VACIB' })).alternateNamesIndexed).toBe(false);
    await svc.markLeiReady(1, undefined, { namesIndexed: true });
    expect((await resolve({ query: 'VACIB' })).alternateNamesIndexed).toBe(true);
  });
});

// ─── #23: status filters match exactly the state they name ────────────────────

const STATUSES = [
  'ISSUED',
  'LAPSED',
  'RETIRED',
  'DUPLICATE',
  'ANNULLED',
  'PENDING_TRANSFER',
  'PENDING_ARCHIVAL',
  'MERGED',
] as const;

const statusEntity = (status: (typeof STATUSES)[number]): NormalizedLeiEntity => ({
  lei: lei(`LANDOVER${status.replace(/_/g, '').slice(0, 10)}`),
  legalName: `Landover Holdings ${status.toLowerCase().replace(/_/g, ' ')} Limited`,
  otherNames: [],
  jurisdiction: 'GB',
  status,
});

describe('status filter (#23)', () => {
  beforeEach(async () => {
    await svc.ingestLeiEntities(STATUSES.map(statusEntity));
  });

  const statusesFor = async (opts: Partial<ResolveEntityOptions> & { query: string }) => {
    const res = await resolve(opts);
    return { res, statuses: [...new Set(res.matches.map((m) => m.status))].sort() };
  };

  it.each([
    ['strict', 'Landover Holdings'],
    ['fuzzy', 'Landovr Holdngs'],
  ] as const)('lapsed returns only LAPSED candidates on the %s path', async (mode, query) => {
    const { res, statuses } = await statusesFor({ query, status: 'lapsed', matchMode: mode });
    expect(statuses).toEqual(['LAPSED']);
    expect(res.modeUsed).toBe(mode);
  });

  it('applies the same predicate on the strict-to-fuzzy fallback', async () => {
    const { res, statuses } = await statusesFor({ query: 'Landovr Holdngs', status: 'lapsed' });
    expect(res.fuzzyFallbackTriggered).toBe(true);
    expect(statuses).toEqual(['LAPSED']);
  });

  it.each(['strict', 'fuzzy'] as const)(
    'issued returns only ISSUED on the %s path',
    async (mode) => {
      const { statuses } = await statusesFor({
        query: mode === 'strict' ? 'Landover Holdings' : 'Landovr Holdngs',
        status: 'issued',
        matchMode: mode,
      });
      expect(statuses).toEqual(['ISSUED']);
    },
  );

  it('any returns every registration state', async () => {
    const { statuses } = await statusesFor({ query: 'Landover Holdings', status: 'any' });
    expect(statuses).toEqual([...STATUSES].sort());
  });

  it('pages over the filtered set', async () => {
    const res = await resolve({ query: 'Landover Holdings', status: 'lapsed', limit: 1 });
    expect(res).toMatchObject({ totalAvailable: 1, totalAvailableBasis: 'exact' });
    expect(res.matches).toHaveLength(1);
  });
});

// ─── #36: a country includes its subdivisions ─────────────────────────────────

const APPLE_US_CA = 'HWUPKR0MPOU8FGXBT394';
const APPLE_CA_ON = '5493004SYPRAVRVNK561';

const JURISDICTION_ENTITIES: NormalizedLeiEntity[] = [
  {
    lei: APPLE_US_CA,
    legalName: 'Apple Inc.',
    otherNames: [],
    jurisdiction: 'US-CA',
    status: 'ISSUED',
  },
  {
    lei: APPLE_CA_ON,
    legalName: 'Apple Canada Inc.',
    otherNames: [],
    jurisdiction: 'CA-ON',
    status: 'ISSUED',
  },
  {
    lei: lei('APPLEDELAWARE'),
    legalName: 'Apple Delaware Inc.',
    otherNames: [],
    jurisdiction: 'US-DE',
    status: 'ISSUED',
  },
  {
    lei: lei('APPLEBAREUS'),
    legalName: 'Apple Orchard Inc.',
    otherNames: [],
    jurisdiction: 'US',
    status: 'ISSUED',
  },
  {
    lei: lei('CITCOTECH'),
    legalName: 'Citco Technology Management, Inc.',
    otherNames: [],
    jurisdiction: 'US',
    status: 'ISSUED',
  },
];

describe('jurisdiction filter (#36)', () => {
  beforeEach(async () => {
    await svc.ingestLeiEntities(JURISDICTION_ENTITIES);
  });

  it('matches a country and every subdivision under it, strict', async () => {
    const res = await resolve({ query: 'Apple Inc.', jurisdiction: 'US', status: 'issued' });
    expect(res.modeUsed).toBe('strict');
    expect(res.matches[0]).toMatchObject({ lei: APPLE_US_CA, matchType: 'exact' });
    expect(new Set(res.matches.map((m) => m.jurisdiction))).toEqual(
      new Set(['US-CA', 'US-DE', 'US']),
    );
  });

  it('matches a subdivision code exactly', async () => {
    const res = await resolve({ query: 'Apple Inc.', jurisdiction: 'US-DE' });
    expect(res.matches.map((m) => m.lei)).not.toContain(APPLE_US_CA);
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches.every((m) => m.jurisdiction === 'US-DE')).toBe(true);
  });

  it('never matches another country’s subdivision under a country code', async () => {
    const res = await resolve({ query: 'Apple Canada Inc.', jurisdiction: 'CA' });
    expect(res.matches.map((m) => m.lei)).toEqual([APPLE_CA_ON]);
    const apple = await resolve({ query: 'Apple', jurisdiction: 'CA' });
    expect(apple.matches.map((m) => m.jurisdiction)).toEqual(['CA-ON']);
  });

  it('applies the same jurisdiction rule on the fuzzy path', async () => {
    const res = await resolve({ query: 'Appel Inc', jurisdiction: 'US', matchMode: 'fuzzy' });
    expect(res.matches.map((m) => m.lei)).toContain(APPLE_US_CA);
    expect(res.matches.every((m) => m.jurisdiction?.split('-')[0] === 'US')).toBe(true);
  });
});

// ─── #33: every LEI lookup is an index lookup ─────────────────────────────────

interface Captured {
  params: unknown[];
  sql: string;
}

/** Every statement run on `handle` during `run`, with the parameters it was bound to. */
async function captureStatements(
  handle: SqliteHandle,
  run: () => Promise<unknown>,
): Promise<Captured[]> {
  const original = handle.prepare.bind(handle);
  const captured: Captured[] = [];
  handle.prepare = ((sql: string) => {
    const statement = original(sql);
    const wrap =
      (method: 'all' | 'get') =>
      (...params: unknown[]) => {
        captured.push({ sql, params });
        return (statement[method] as (...args: unknown[]) => unknown)(...params);
      };
    return { ...statement, all: wrap('all'), get: wrap('get') };
  }) as typeof handle.prepare;
  try {
    await run();
  } finally {
    handle.prepare = original;
  }
  return captured;
}

/** The query plan SQLite chose for one captured statement. */
function planOf(handle: SqliteHandle, statement: Captured): string[] {
  return handle
    .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...(statement.params as never[]))
    .map((row) => row.detail);
}

/** The statements that read the entity or name tables — the resolution queries. */
const resolutionQueries = (captured: Captured[]) =>
  captured.filter((c) => /\blei_(entity|name)\b/.test(c.sql) && /^\s*SELECT/i.test(c.sql));

/** The FTS prefix terms bound across the blocking lookups, in order. */
const blockedPrefixes = (captured: Captured[]) =>
  captured.flatMap((c) =>
    c.params
      .filter((p): p is string => typeof p === 'string')
      .flatMap((p) => [...p.matchAll(/"([^"]+)"\*/g)].map((m) => m[1])),
  );

describe('index-only LEI lookups (#33, #23, #36)', () => {
  beforeEach(async () => {
    await svc.ingestLeiEntities([
      ...ALTERNATE_ENTITIES,
      ...STATUSES.map(statusEntity),
      ...JURISDICTION_ENTITIES,
    ]);
  });

  const cases: [string, Partial<ResolveEntityOptions>][] = [];
  for (const matchMode of ['strict', 'fuzzy'] as const) {
    for (const status of ['any', 'issued', 'lapsed'] as const) {
      for (const jurisdiction of [undefined, 'US', 'US-DE'] as const) {
        cases.push([
          `${matchMode} · status ${status} · jurisdiction ${jurisdiction ?? 'none'}`,
          { matchMode, status, ...(jurisdiction ? { jurisdiction } : {}) },
        ]);
      }
    }
  }

  it.each(cases)('plans %s as index lookups, never a table scan', async (_label, opts) => {
    const handle = await svc.leiEntities.raw();
    for (const query of ['Apple Inc', 'Landovr Holdngs Zzqx']) {
      const captured = resolutionQueries(
        await captureStatements(handle, () => resolve({ query, ...opts })),
      );
      expect(captured.length).toBeGreaterThan(0);
      for (const statement of captured) {
        const plan = planOf(handle, statement);
        const scans = plan.filter((line) => /^SCAN /.test(line) && !/VIRTUAL TABLE/.test(line));
        expect(scans, `${statement.sql}\n${plan.join('\n')}`).toEqual([]);
        expect(plan.join('\n')).not.toMatch(/lei_entity_status_idx/);
      }
    }
  });

  it('blocks a 64-word query whose words match nothing by index lookups only', async () => {
    const letters = 'qxzjvkw';
    const words: string[] = [];
    for (const a of letters)
      for (const b of letters)
        for (const c of letters) if (words.length < 64) words.push(`${a}${b}${c}q`);
    const handle = await svc.leiEntities.raw();
    let matches = -1;
    const captured = await captureStatements(handle, async () => {
      matches = (await resolve({ query: words.join(' '), matchMode: 'fuzzy' })).matches.length;
    });
    expect(matches).toBe(0);
    expect(captured.some((c) => /\bLIKE\b/.test(c.sql))).toBe(false);
    expect(new Set(blockedPrefixes(captured))).toEqual(new Set(words.map((w) => w.slice(0, 3))));
    for (const statement of resolutionQueries(captured)) {
      expect(planOf(handle, statement).some((line) => /VIRTUAL TABLE/.test(line))).toBe(true);
    }
  });

  it('resolves the jurisdiction inside the index lookup, not on joined rows', async () => {
    const handle = await svc.leiEntities.raw();
    const captured = resolutionQueries(
      await captureStatements(handle, () =>
        resolve({ query: 'Landovr Holdngs', jurisdiction: 'LI', matchMode: 'fuzzy' }),
      ),
    );
    const blocking = captured.filter((c) => /\bMATCH\b/.test(c.sql));
    expect(blocking.length).toBeGreaterThan(0);
    for (const statement of blocking) {
      expect(statement.sql).not.toMatch(/\bjurisdiction\s*(=|GLOB|LIKE|>=)/i);
      expect(String(statement.params[0])).toMatch(/jurisdiction_terms\s*:/);
    }
  });

  it('blocks two-code-point prefixes through the index', async () => {
    const handle = await svc.leiEntities.raw();
    const captured = await captureStatements(handle, () =>
      resolve({ query: 'Fictionall Tradng Co X', matchMode: 'fuzzy' }),
    );
    expect(blockedPrefixes(captured)).toEqual(['fic', 'tra', 'co']);
    expect(captured.some((c) => /\bLIKE\b/.test(c.sql))).toBe(false);
  });
});
