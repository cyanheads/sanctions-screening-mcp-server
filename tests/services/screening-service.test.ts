/**
 * @fileoverview Integration tests for the matching engine over a seeded
 * synthetic-fixture mirror: exact / strong / approximate classification,
 * Jaro-Winkler fuzzy fallback, phonetic transliteration hits, source + type
 * filters, LEI resolution, ownership traversal, and the empty-result contract.
 * @module tests/services/screening-service.test
 */

import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FUZZY_POOL_BUDGET } from '@/services/screening/candidate-pool.js';
import { parseOfac } from '@/services/screening/sanctions-ingest.js';
import type { ScreeningService } from '@/services/screening/screening-service.js';
import { doubleMetaphone } from '@/services/screening/text-matching.js';
import {
  type NormalizedDesignation,
  type NormalizedLeiEntity,
  SOURCE_CODES,
  type SourceCode,
} from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';
import { freshService, type SeededService, seededService } from './_helpers.js';

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

const screenDefaults = {
  entityType: 'any' as const,
  matchMode: 'strict' as const,
  sources: [...SOURCE_CODES],
  limit: 25,
};

describe('screenName — strict matching', () => {
  it('returns an exact hit for a normalized primary-name match', async () => {
    const res = await svc.screenName({ ...screenDefaults, query: 'Ivan Testovich Volkov' }, ctx);
    expect(res.modeUsed).toBe('strict');
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit?.matchType).toBe('exact');
    expect(hit?.score).toBeUndefined(); // exact hits are unscored
  });

  it('returns a strong hit when all query tokens are present (word-order swap)', async () => {
    const res = await svc.screenName({ ...screenDefaults, query: 'Volkov Ivan' }, ctx);
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit?.matchType).toBe('strong');
  });

  it('matches on an alias, not just the primary name', async () => {
    const res = await svc.screenName({ ...screenDefaults, query: 'FTC LLC' }, ctx);
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-2002');
    expect(hit).toBeDefined();
    expect(hit?.matchedNameType).toBe('aka');
  });

  it('does not fabricate a score on exact/strong hits', async () => {
    const res = await svc.screenName({ ...screenDefaults, query: 'Katarina Beispiel' }, ctx);
    for (const hit of res.hits.filter((h) => h.matchType !== 'approximate')) {
      expect(hit.score).toBeUndefined();
    }
  });
});

describe('screenName — fuzzy fallback', () => {
  it('auto-falls-back to fuzzy when strict finds nothing, surfacing a raw JW score', async () => {
    // "Volkow" is a one-character near-miss of the primary name "Volkov".
    const res = await svc.screenName({ ...screenDefaults, query: 'Ivan Volkow' }, ctx);
    expect(res.modeUsed).toBe('fuzzy');
    expect(res.fuzzyFallbackTriggered).toBe(true);
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit?.matchType).toBe('approximate');
    expect(typeof hit?.score).toBe('number');
    expect(hit!.score!).toBeGreaterThan(0);
    expect(hit!.score!).toBeLessThanOrEqual(1);
  });

  it('catches transliteration-class variants at the default floor', async () => {
    // "Muhammad" phonetically collides with the published "Mohammed" (DM key MHMT),
    // which seeds "Mohammed Al-Testi" into the candidate pool. The shared exact
    // tokens "al"/"testi" then drive bestTokenScore to 1.0, so it clears the
    // default fuzzy floor (0.85) without any floor exemption — default-floor recall
    // for transliteration variants is preserved.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Muhammad Al-Testi', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-6006');
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe('approximate');
  });

  it('returns an empty result (not a guess) for a name nothing resembles', async () => {
    // The fixture now carries FX-8008, whose short low-quality-aka "Noni" scores
    // 0.8515 against "nonexistent" (above the 0.85 floor). This query must still
    // return nothing: the coverage gate rejects a candidate that explains only 1 of
    // 3 query tokens (issue #4). Before the gate, that single token pair leaked.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Zzqxwv Nonexistent Qqpzm', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
  });
});

describe('screenName — single-token false-positive gate (issue #4)', () => {
  // A multi-token query must not be carried by ONE token pair that clears the fuzzy
  // floor. FX-8008 ("Mateo Restrepo Cardoza") has the short low-quality-aka "Noni";
  // "nonexistent" scores 0.8515 against "noni" — above the 0.85 floor — yet the
  // whole 3-token nonsense query is otherwise unrelated (coverage 1/3).
  it('rejects a candidate that clears the floor on a single query token (coverage 1/3)', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Zzqxwv Nonexistent Qqpzm', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.hits.find((h) => h.sourceEntryId === 'FX-8008')).toBeUndefined();
  });

  it('still admits a legitimate partial match that covers 2 of 3 query tokens', async () => {
    // "Ivan" + "Volkov" both match FX-1001 exactly (coverage 2/3); the trailing
    // "Qqzzxw" is noise. Enough of the query is explained → the candidate admits.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkov Qqzzxw', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe('approximate');
  });

  it('leaves single-token queries unchanged — the floor alone governs', async () => {
    // One token, coverage is trivially the whole query; a near-miss above the floor
    // still surfaces (the gate only tightens 3+-token queries).
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Volkow', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit?.matchType).toBe('approximate');
    expect(hit!.score!).toBeGreaterThanOrEqual(0.85);
  });

  it('still admits a fuzzy word-order swap with a near-miss token', async () => {
    // "Volkow Ivan" — swapped order, "Volkow" ≈ "Volkov"; both tokens covered.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Volkow Ivan', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit?.matchType).toBe('approximate');
  });
});

describe('screenName — whole-string prefix-inflation gate (issue #8)', () => {
  // The whole-string admission arm must not admit a SHORT candidate that is merely a
  // (near-)prefix of a much LONGER multi-token query. Jaro-Winkler's shared-prefix
  // boost inflates such pairs above the floor; a folded-length-ratio guard on the
  // whole-string arm blocks them without touching the spacing/concatenation recall
  // that arm exists for.
  it('rejects a bare short alias that only prefixes a longer multi-token query', async () => {
    // FX-9009 ("Aurelio Ferdinand Castellanos") carries the bare low-quality-aka
    // "Ferdinand". Against "Ferdinand Aquino Delgado", the whole-string JW of
    // "ferdinand aquino delgado" vs "ferdinand" is 0.875 — above the 0.85 floor — but
    // the length ratio is 0.375 (< 0.5) and token coverage is 1/3. Before the guard,
    // the inflated whole-string score admitted it; now it must not surface.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Ferdinand Aquino Delgado', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.hits.find((h) => h.sourceEntryId === 'FX-9009')).toBeUndefined();
  });

  it('still admits a spacing/concatenation variant via the whole-string arm', async () => {
    // FX-1010 ("Van Der Berg Shipping") queried as its space-stripped concatenation
    // "vanderbergshipping": whole-string JW is 0.9667 but the best token pair is only
    // 0.806, so the token arm cannot admit it — ONLY the whole-string arm can. The
    // length ratio (0.857) clears the guard, so this concatenation recall survives.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'vanderbergshipping', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1010');
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe('approximate');
  });
});

describe('screenName — minScore floor enforced uniformly (issue #1)', () => {
  // The floor binds every fuzzy candidate, regardless of match strategy
  // (exact-normalized / token / phonetic). A phonetic-key candidate is seeded into
  // the pool but admitted ONLY when its computed score clears the floor — there is
  // no phonetic bypass. Before the fix, `score >= minScore || phoneticHit` admitted
  // a sub-floor phonetic-only hit, so a caller asking minScore:0.99 still saw a hit
  // scored e.g. 0.78. FX-7007 ("Catherine Pyotrov") is a purpose-built case: the
  // query "Katharina Petrov" shares its whole phonetic key (K0RN PTRF) but no exact
  // token, so its score (~0.78) is sub-floor — it reaches the pool only via the
  // phonetic key.
  const PHONETIC_QUERY = 'Katharina Petrov';

  it('excludes a phonetic-only hit whose score is below an explicit high minScore', async () => {
    const { result: res, ...trace } = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName(
        { ...screenDefaults, query: PHONETIC_QUERY, matchMode: 'fuzzy', minScore: 0.99 },
        ctx,
      ),
    );
    // The phonetic arm pooled the candidate, so the floor — not blocking — withholds it.
    expect(phoneticallyPooled(trace, 'un:FX-7007')).toBe(true);
    expect(res.hits.find((h) => h.sourceEntryId === 'FX-7007')).toBeUndefined();
    // No returned hit may sit below the requested floor — the bypass is gone.
    for (const hit of res.hits) {
      if (hit.score !== undefined) expect(hit.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('also excludes that phonetic-only sub-floor hit at the default floor', async () => {
    // The same candidate scores ~0.78 — below the default floor (0.85) too. Under
    // the old bypass it surfaced regardless; now it is correctly withheld. This is
    // the intended fix, not a recall loss: a genuine variant that scores ABOVE the
    // floor still surfaces (covered by the transliteration test above, which lands
    // at 1.0 via shared exact tokens).
    const { result: res, ...trace } = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName({ ...screenDefaults, query: PHONETIC_QUERY, matchMode: 'fuzzy' }, ctx),
    );
    expect(phoneticallyPooled(trace, 'un:FX-7007')).toBe(true);
    expect(res.hits.find((h) => h.sourceEntryId === 'FX-7007')).toBeUndefined();
  });

  it('floors a strict screen’s fuzzy passes too: the completion of a list strict missed, and the fallback', async () => {
    await svc.ingestDesignations([
      listed('un', 'MS-EXACT', 'Zorbek Kalandar'),
      listed('eu', 'MS-NEAR', 'Zorbek Kalandarov'),
    ]);
    const strict = async (query: string, minScore?: number) =>
      (
        await svc.screenName(
          { ...screenDefaults, query, ...(minScore === undefined ? {} : { minScore }) },
          ctx,
        )
      ).hits.map((hit) => hit.designationId);

    // `kalandarov` covers `kalandar` at 0.96: over the default floor, under 0.99.
    expect(await strict('Zorbek Kalandar')).toEqual(['un:MS-EXACT', 'eu:MS-NEAR']);
    expect(await strict('Zorbek Kalandar', 0.99)).toEqual(['un:MS-EXACT']);
    // Strict finds nothing; every token pair of the fallback scores under 0.99.
    expect(await strict('Zorbex Kalandarr')).toContain('un:MS-EXACT');
    expect(await strict('Zorbex Kalandarr', 0.99)).toEqual([]);
  });
});

describe('screenName — query-token coverage ranking (issue #15)', () => {
  // Coverage is a literal count of query tokens the candidate explains, surfaced
  // as its own field and used as the ranking key BETWEEN score and the terminal
  // designation-id key. It never enters `score`, which stays raw Jaro-Winkler.
  it('omits queryTokenCoverage on exact and strong hits', async () => {
    const exact = await svc.screenName({ ...screenDefaults, query: 'Ivan Testovich Volkov' }, ctx);
    const strong = await svc.screenName({ ...screenDefaults, query: 'Volkov Ivan' }, ctx);
    for (const res of [exact, strong]) {
      for (const hit of res.hits) {
        expect(hit.matchType).not.toBe('approximate');
        expect(hit.queryTokenCoverage).toBeUndefined();
      }
    }
  });

  it('counts coverage at the applied minScore floor, not a fixed threshold', async () => {
    // "volkow" ~ "volkov" is 0.9556: covered at the default 0.85 floor, uncovered
    // at 0.99. The exact "ivan" pair carries admission either way, so the same
    // candidate surfaces with a different, honest coverage count per floor.
    const atDefault = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkow', matchMode: 'fuzzy' },
      ctx,
    );
    expect(atDefault.hits.find((h) => h.sourceEntryId === 'FX-1001')?.queryTokenCoverage).toEqual({
      covered: 2,
      total: 2,
    });

    const atHighFloor = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkow', matchMode: 'fuzzy', minScore: 0.99 },
      ctx,
    );
    expect(atHighFloor.hits.find((h) => h.sourceEntryId === 'FX-1001')?.queryTokenCoverage).toEqual(
      { covered: 1, total: 2 },
    );
  });

  it('keeps the designation id as the terminal key when score and coverage tie', async () => {
    // Offset pagination needs a total order. Coverage is inserted BETWEEN score
    // and the id — it must not displace the id as the final tie-break.
    await svc.ingestDesignations(
      (['TIE-B', 'TIE-A'] as const).map((entryId, index) => ({
        id: `un:${entryId}`,
        source: 'un' as const,
        sourceEntryId: entryId,
        entityType: 'person' as const,
        primaryName: `Rikardo Almeyda ${index === 0 ? 'Sorel' : 'Torres'}`,
        payload: {
          aliases: [],
          identifiers: [],
          addresses: [],
          datesOfBirth: [],
          nationalities: [],
        },
      })),
    );

    const res = await svc.screenName(
      { ...screenDefaults, query: 'Rikardo Almeyda Zzqx', matchMode: 'fuzzy' },
      ctx,
    );
    const a = res.hits.find((h) => h.sourceEntryId === 'TIE-A');
    const b = res.hits.find((h) => h.sourceEntryId === 'TIE-B');
    expect(a?.score).toBe(b?.score);
    expect(a?.queryTokenCoverage).toEqual(b?.queryTokenCoverage);
    expect(res.hits.findIndex((h) => h.sourceEntryId === 'TIE-A')).toBeLessThan(
      res.hits.findIndex((h) => h.sourceEntryId === 'TIE-B'),
    );
  });
});

describe('resolveEntity — query-token coverage ranking (issue #15)', () => {
  // runLeiFuzzy shares runFuzzy's `Math.max(tokenScore, wholeScore)` shape and so
  // shares the tie: two candidates each holding one exact query token both score
  // 1.0. The weaker LEI sorts first alphabetically, so the terminal LEI tie-break
  // ranks it ahead until coverage separates them.
  const FULL_LEI = 'ZZZZFULLCOVERAGE0011';
  const WEAK_LEI = 'AAAAWEAKCOVERAGE0011';

  beforeEach(async () => {
    await svc.ingestLeiEntities([
      {
        lei: FULL_LEI,
        legalName: 'Testland Maritime Holdings Group PLC',
        otherNames: [],
        jurisdiction: 'GB',
        status: 'ISSUED',
      },
      {
        lei: WEAK_LEI,
        legalName: 'Aurora Holdings Group Ltd',
        otherNames: [],
        jurisdiction: 'GB',
        status: 'ISSUED',
      },
    ]);
  });

  const resolveFuzzy = () =>
    svc.resolveEntity(
      {
        query: 'Testlandia Maritime Holdings Group',
        matchMode: 'fuzzy',
        status: 'any',
        limit: 25,
      },
      ctx,
    );

  it('ranks the full-coverage candidate above a weaker one tied at the same score', async () => {
    const res = await resolveFuzzy();
    const full = res.matches.findIndex((m) => m.lei === FULL_LEI);
    const weak = res.matches.findIndex((m) => m.lei === WEAK_LEI);
    expect(full).toBe(0);
    expect(weak).toBeGreaterThan(full);
    expect(res.matches[full]?.score).toBe(res.matches[weak]?.score);
  });

  it('surfaces the literal coverage count for each candidate', async () => {
    const res = await resolveFuzzy();
    expect(res.matches.find((m) => m.lei === FULL_LEI)?.queryTokenCoverage).toEqual({
      covered: 4,
      total: 4,
    });
    expect(res.matches.find((m) => m.lei === WEAK_LEI)?.queryTokenCoverage).toEqual({
      covered: 2,
      total: 4,
    });
  });

  it('keeps the LEI as the terminal key when score and coverage tie', async () => {
    const res = await resolveFuzzy();
    const tied = res.matches.filter((m) => m.score === 1 && m.queryTokenCoverage?.covered === 2);
    expect(tied.length).toBeGreaterThan(1);
    expect(tied.map((m) => m.lei)).toEqual([...tied.map((m) => m.lei)].sort());
  });

  it('reports the coverage of the same name it reports the score for', async () => {
    // FX-2002's LEI carries both a legal name and a shorter trading name. Both
    // hold the exact token "trading" and so tie at score 1.0; the legal name
    // covers "compny" too, so it is the name surfaced — and the coverage on the
    // match describes that name, not a different one.
    const res = await svc.resolveEntity(
      { query: 'Fictionel Trading Compny', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === '5493001KJTIIGC8Y1R12');
    expect(match?.matchedName).toBe('Fictional Trading Company LLC');
    expect(match?.queryTokenCoverage).toEqual({ covered: 3, total: 3 });
  });

  it('omits queryTokenCoverage on strict matches', async () => {
    const res = await svc.resolveEntity(
      {
        query: 'Testland Maritime Holdings Group PLC',
        matchMode: 'strict',
        status: 'any',
        limit: 10,
      },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === FULL_LEI);
    expect(match?.matchType).toBe('exact');
    expect(match?.queryTokenCoverage).toBeUndefined();
  });
});

describe('screenName — candidate-pool fairness', () => {
  it('surfaces a fuzzy match whose distinctive token is not the first query token', async () => {
    // Every query token contributes candidates to the fuzzy pool (not just the
    // first / not a single OR clause that the leading token can exhaust). Here the
    // leading token "Vanya" is a near-miss nickname; the real signal is in the
    // later tokens "Volkof" ≈ "Volkov".
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Vanya Volkof', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe('approximate');
  });
});

describe('screenName — autoFallback control', () => {
  it('auto-upgrades strict→fuzzy by default when strict is empty', async () => {
    const res = await svc.screenName({ ...screenDefaults, query: 'Ivan Volkow' }, ctx);
    expect(res.modeUsed).toBe('fuzzy');
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it('does NOT auto-fall-back to fuzzy when autoFallback is false', async () => {
    // The internal cross-reference screens (get_entity / trace_ownership) pass
    // this so a generic name does not fuzzy-flood with single-common-token hits.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkow', autoFallback: false },
      ctx,
    );
    expect(res.modeUsed).toBe('strict');
    expect(res.hits).toHaveLength(0); // strict miss stays a miss — the honest answer
  });

  it('still runs fuzzy when explicitly requested even with autoFallback false', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkow', matchMode: 'fuzzy', autoFallback: false },
      ctx,
    );
    expect(res.modeUsed).toBe('fuzzy');
  });
});

describe('screenName — filters', () => {
  it('honors the source filter', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Imaginary Front Organisation', sources: ['un'] },
      ctx,
    );
    expect(res.hits.every((h) => h.source === 'un')).toBe(true);
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it('honors the entity-type filter', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Phantom Voyager', entityType: 'vessel' },
      ctx,
    );
    expect(res.hits.every((h) => h.entityType === 'vessel')).toBe(true);
  });

  it('excludes hits when the type filter does not match', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Phantom Voyager', entityType: 'person' },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
  });
});

describe('source filter — a repeated list counts once (issue #73)', () => {
  /** As many entries as there are lists, every one the same list. */
  const repeated = (source: SourceCode): SourceCode[] => SOURCE_CODES.map(() => source);

  beforeEach(async () => {
    await svc.ingestDesignations(
      (['eu', 'uk'] as const).map((source) => ({
        ...listed(source, 'REP-73', 'Repeated Filter Holding', 'organization'),
        payload: {
          aliases: [],
          identifiers: [{ type: 'Tax ID No.', value: '7706000073', country: 'Russia' }],
          addresses: [],
          datesOfBirth: [],
          nationalities: [],
        },
      })),
    );
  });

  it.each(['strict', 'fuzzy'] as const)(
    'screens a name on the named list alone: %s',
    async (matchMode) => {
      const res = await svc.screenName(
        { ...screenDefaults, matchMode, query: 'Repeated Filter Holding', sources: repeated('eu') },
        ctx,
      );
      expect(res.hits.map((hit) => hit.designationId)).toEqual(['eu:REP-73']);
      expect(res.totalAvailable).toBe(1);
      if (matchMode === 'fuzzy') expect(res.fuzzySources).toEqual(['eu']);
    },
  );

  it('looks an identifier up on the named list alone', async () => {
    const hits = await svc.screenIdentifier({
      value: '7706000073',
      type: 'any',
      sources: repeated('eu'),
    });
    expect(hits.map((hit) => [hit.source, hit.sources])).toEqual([['eu', ['eu']]]);
  });
});

describe('screenName — offset pagination and overflow disclosure (issue #9)', () => {
  /** Six designations sharing a name stem, so one strict screen matches all six. */
  const pageDesignations = Array.from({ length: 6 }, (_, index) => ({
    id: `un:PAGE-${index}`,
    source: 'un' as const,
    sourceEntryId: `PAGE-${index}`,
    entityType: 'organization' as const,
    primaryName: `Overflow Candidate ${String.fromCharCode(65 + index)}`,
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  }));

  beforeEach(async () => {
    await svc.ingestDesignations(pageDesignations);
  });

  // The one list the six are on: a list strict found nothing on would be fuzzy-completed (#59).
  const screenPage = (offset: number, limit: number) =>
    svc.screenName(
      { ...screenDefaults, query: 'Overflow Candidate', sources: ['un'], limit, offset },
      ctx,
    );

  it('reports the pre-slice total as exact and returns only the requested page', async () => {
    const res = await screenPage(0, 2);
    expect(res.hits).toHaveLength(2);
    expect(res.totalAvailable).toBe(6);
    expect(res.totalAvailableBasis).toBe('exact');
  });

  it('walks disjoint pages that reassemble the complete set in order', async () => {
    const pages = await Promise.all([screenPage(0, 2), screenPage(2, 2), screenPage(4, 2)]);
    const ids = pages.flatMap((page) => page.hits.map((hit) => hit.designationId));
    expect(ids).toEqual([
      'un:PAGE-0',
      'un:PAGE-1',
      'un:PAGE-2',
      'un:PAGE-3',
      'un:PAGE-4',
      'un:PAGE-5',
    ]);
  });

  it('orders same-band ties deterministically across repeated identical queries', async () => {
    // Every hit here is `strong`, so matchRank cannot separate them — without an
    // explicit secondary key the order is incidental Map-insertion order and the
    // pages above could overlap or drop rows.
    const first = await screenPage(0, 6);
    const second = await screenPage(0, 6);
    expect(second.hits.map((hit) => hit.designationId)).toEqual(
      first.hits.map((hit) => hit.designationId),
    );
  });

  it('returns an empty page past the end while still reporting the true total', async () => {
    const res = await screenPage(99, 2);
    expect(res.hits).toHaveLength(0);
    expect(res.totalAvailable).toBe(6);
  });

  it('labels a fuzzy-mode total as a bound, never an exact corpus count', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkow', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.modeUsed).toBe('fuzzy');
    expect(res.totalAvailableBasis).toBe('lower_bound');
  });

  it('counts every strict match exactly and pages to the last one, past 5,000 alias rows', async () => {
    // A strict pass once read at most 5,000 alias rows in no set order, so a token
    // this common left designations that no offset reached.
    const count = 5100;
    await svc.ingestDesignations(
      Array.from({ length: count }, (_, index) =>
        listed('un', `CAP-${index}`, `Capped Candidate ${index}`, 'organization'),
      ),
    );
    const walked: string[] = [];
    for (let offset = 0; offset < count; offset += 1000) {
      const res = await svc.screenName(
        { ...screenDefaults, query: 'Capped', sources: ['un'], limit: 1000, offset },
        ctx,
      );
      expect(res).toMatchObject({
        modeUsed: 'strict',
        totalAvailable: count,
        totalAvailableBasis: 'exact',
        poolBounded: false,
      });
      walked.push(...res.hits.map((hit) => hit.designationId));
    }
    expect(walked).toEqual(Array.from({ length: count }, (_, index) => `un:CAP-${index}`));
  });

  it('pages every candidate a fuzzy pass admits, past the fifty it once kept', async () => {
    await svc.ingestDesignations(
      Array.from({ length: 80 }, (_, i) =>
        listed('un', `ZEL-${i}`, `Zelvanora Zx${i}`, 'organization'),
      ),
    );
    const screen = (offset: number, limit: number) =>
      svc.screenName(
        { ...screenDefaults, query: 'Zelvanorra', matchMode: 'fuzzy', limit, offset },
        ctx,
      );
    const whole = await screen(0, 100);
    expect(whole).toMatchObject({ totalAvailable: 80, totalAvailableBasis: 'lower_bound' });
    expect(new Set(whole.hits.map((hit) => hit.designationId))).toEqual(
      new Set(Array.from({ length: 80 }, (_, i) => `un:ZEL-${i}`)),
    );

    const walked: string[] = [];
    for (let offset = 0; offset < whole.totalAvailable; offset += 7) {
      walked.push(...(await screen(offset, 7)).hits.map((hit) => hit.designationId));
    }
    expect(walked).toEqual(whole.hits.map((hit) => hit.designationId));
  });

  it('says when the candidate budget left a block out, and only then', async () => {
    // `vla` and the phonetic key of `Vladimir` each reach 2,002 names, past the budget.
    await svc.ingestDesignations([
      ...Array.from({ length: FUZZY_POOL_BUDGET + 1 }, (_, i) =>
        listed('ofac_sdn', `VLA-${i}`, `Vladimir Zx${i}`),
      ),
      listed('uk', 'PET-UK', 'Vladimir Petrenkov'),
    ]);
    const fuzzy = (query: string) =>
      svc.screenName({ ...screenDefaults, query, matchMode: 'fuzzy' }, ctx);

    const bounded = await fuzzy('Vladimir Petrenkox');
    expect(bounded.poolBounded).toBe(true);
    expect(bounded.hits.map((hit) => hit.designationId)).toContain('uk:PET-UK');
    expect((await fuzzy('Petrenkox')).poolBounded).toBe(false);
  });
});

describe('resolveEntity — offset pagination and overflow disclosure (issue #9)', () => {
  const pageEntities = Array.from({ length: 4 }, (_, index) => ({
    lei: `OVERFLOWSERVICE${index}0011`,
    legalName: `Overflow Candidate ${String.fromCharCode(65 + index)} Ltd`,
    otherNames: [],
    jurisdiction: 'US',
    status: 'ISSUED',
  }));

  beforeEach(async () => {
    await svc.ingestLeiEntities(pageEntities);
  });

  const resolvePage = (offset: number, limit: number) =>
    svc.resolveEntity(
      { query: 'Overflow Candidate', matchMode: 'strict', status: 'issued', limit, offset },
      ctx,
    );

  it('reports the pre-slice total as exact and returns only the requested page', async () => {
    const res = await resolvePage(0, 2);
    expect(res.matches).toHaveLength(2);
    expect(res.totalAvailable).toBe(4);
    expect(res.totalAvailableBasis).toBe('exact');
  });

  it('walks disjoint pages that reassemble the complete set in a stable order', async () => {
    const pages = await Promise.all([resolvePage(0, 2), resolvePage(2, 2)]);
    const leis = pages.flatMap((page) => page.matches.map((match) => match.lei));
    expect(leis).toEqual(pageEntities.map((entity) => entity.lei));
    expect((await resolvePage(0, 4)).matches.map((match) => match.lei)).toEqual(leis);
  });

  it('returns an empty page past the end while still reporting the true total', async () => {
    const res = await resolvePage(99, 2);
    expect(res.matches).toHaveLength(0);
    expect(res.totalAvailable).toBe(4);
  });

  it('labels a fuzzy-mode total as a bound, never an exact corpus count', async () => {
    const res = await svc.resolveEntity(
      { query: 'Fictionel Trading Compny', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    expect(res.modeUsed).toBe('fuzzy');
    expect(res.totalAvailableBasis).toBe('lower_bound');
  });

  it('pages every LEI a fuzzy pass admits, past the fifty it once kept', async () => {
    await svc.ingestLeiEntities(
      Array.from({ length: 80 }, (_, i) => registered(`ZELVANORA${i}`, `Zelvanora Zx${i}`)),
    );
    const fuzzy = (offset: number, limit: number) =>
      svc.resolveEntity(
        { query: 'Zelvanorra', matchMode: 'fuzzy', status: 'issued', limit, offset },
        ctx,
      );
    const whole = await fuzzy(0, 100);
    expect(whole).toMatchObject({ totalAvailable: 80, totalAvailableBasis: 'lower_bound' });
    expect(new Set(whole.matches.map((match) => match.lei))).toEqual(
      new Set(Array.from({ length: 80 }, (_, i) => testLei(`ZELVANORA${i}`))),
    );

    const walked: string[] = [];
    for (let offset = 0; offset < whole.totalAvailable; offset += 7) {
      walked.push(...(await fuzzy(offset, 7)).matches.map((match) => match.lei));
    }
    expect(walked).toEqual(whole.matches.map((match) => match.lei));
  });

  it('says when the candidate budget left a block of names out, and only then', async () => {
    await svc.ingestLeiEntities([
      ...Array.from({ length: FUZZY_POOL_BUDGET + 1 }, (_, i) =>
        registered(`KESBOUND${i}`, `Kestrel Zx${i}`),
      ),
      registered('KESTRELBANK', 'Kestrel Bank'),
    ]);
    const fuzzy = (query: string) =>
      svc.resolveEntity({ query, matchMode: 'fuzzy', status: 'any', limit: 10 }, ctx);

    // `kes` holds 2,002 names, past the budget; `ban` pools the target on its own.
    const bounded = await fuzzy('Kestrel Banko');
    expect(bounded.poolBounded).toBe(true);
    expect(bounded.matches.map((match) => match.lei)).toContain(testLei('KESTRELBANK'));
    expect((await fuzzy('Banko')).poolBounded).toBe(false);
  });
});

describe('getDesignation', () => {
  it('returns the full normalized record', async () => {
    const d = await svc.getDesignation('ofac_sdn', 'FX-1001');
    expect(d?.primaryName).toBe('Ivan Testovich Volkov');
    expect(d?.payload.aliases.length).toBeGreaterThan(0);
    expect(d?.payload.identifiers[0]?.type).toBe('Passport');
  });

  it('returns null for an unknown entry', async () => {
    expect(await svc.getDesignation('ofac_sdn', 'NOPE')).toBeNull();
  });
});

describe('resolveEntity', () => {
  it('resolves a company name to its LEI (strict)', async () => {
    const res = await svc.resolveEntity(
      { query: 'Fictional Trading Company LLC', matchMode: 'strict', status: 'issued', limit: 10 },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === '5493001KJTIIGC8Y1R12');
    expect(match).toBeDefined();
    expect(match?.matchType).toBe('exact');
  });

  it('honors the jurisdiction filter', async () => {
    const res = await svc.resolveEntity(
      {
        query: 'Testland Holdings',
        jurisdiction: 'GB',
        matchMode: 'strict',
        status: 'issued',
        limit: 10,
      },
      ctx,
    );
    expect(res.matches.every((m) => m.jurisdiction === 'GB')).toBe(true);
  });

  it('fuzzy-matches a misspelled company name with a raw score', async () => {
    const res = await svc.resolveEntity(
      { query: 'Fictionel Trading Compny', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === '5493001KJTIIGC8Y1R12');
    expect(match?.matchType).toBe('approximate');
    expect(typeof match?.score).toBe('number');
  });
});

describe('resolveEntity — single-token false-positive gate (issue #4)', () => {
  // runLeiFuzzy shares runFuzzy's admission gate: a legal/trading name must explain
  // enough of the query, not be carried by one strong token pair. "Testland
  // Holdings PLC" is pooled by any query token whose prefix matches its legal name.
  it('rejects an LEI whose legal name matches only one of three query tokens', async () => {
    // "Testlandia" ≈ "Testland" (JW ~0.96, above the floor); "Xyzzy"/"Qqpzm" are
    // noise. Coverage 1/3 → not admitted, even though the one pair clears the floor.
    const res = await svc.resolveEntity(
      { query: 'Testlandia Xyzzy Qqpzm', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    expect(res.matches.find((m) => m.lei === '529900T8BM49AURSDO55')).toBeUndefined();
  });

  it('still admits an LEI when 2 of 3 query tokens are covered', async () => {
    // "Testland" + "Holdings" both match the legal name exactly (coverage 2/3);
    // "Qqzz" is noise. Enough of the query is explained → admitted.
    const res = await svc.resolveEntity(
      { query: 'Testland Holdings Qqzz', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === '529900T8BM49AURSDO55');
    expect(match).toBeDefined();
    expect(match?.matchType).toBe('approximate');
  });
});

describe('ownership', () => {
  it('returns the direct parent relationship for a child LEI', async () => {
    const rels = await svc.getRelationships('5493001KJTIIGC8Y1R12', 'parents');
    expect(rels).toHaveLength(1);
    expect(rels[0]?.parentLei).toBe('529900T8BM49AURSDO55');
    expect(rels[0]?.relationshipType).toBe('IS_ULTIMATELY_CONSOLIDATED_BY');
  });

  it('returns the child relationship from the parent side', async () => {
    const rels = await svc.getRelationships('529900T8BM49AURSDO55', 'children');
    expect(rels).toHaveLength(1);
    expect(rels[0]?.childLei).toBe('5493001KJTIIGC8Y1R12');
  });
});

describe('sources + readiness', () => {
  it('reports per-source counts and readiness', async () => {
    const counts = await svc.sourceCounts();
    // FX-1001 (Ivan Testovich Volkov) + FX-8008 (the single-token false-positive guard).
    expect(counts.find((c) => c.code === 'ofac_sdn')?.recordCount).toBe(2);
    expect(await svc.sanctionsReady()).toBe(true);
    expect(await svc.leiReady()).toBe(true);
  });
});

describe('ingestLeiRelationships — per-record apply (issues #6, #49)', () => {
  const CHILD = '5493001KJTIIGC8Y1R12';
  const relA = {
    childLei: CHILD,
    parentLei: 'PARENTAAAAAAAAAAAAA1',
    relationshipType: 'IS_DIRECTLY_CONSOLIDATED_BY',
  };
  const relB = {
    childLei: CHILD,
    parentLei: 'PARENTBBBBBBBBBBBBB1',
    relationshipType: 'IS_ULTIMATELY_CONSOLIDATED_BY',
  };
  const parents = async () =>
    (await svc.getRelationships(CHILD, 'parents'))
      .map((r) => `${r.relationshipType}->${r.parentLei}`)
      .sort();

  it('keeps a child whose relationships span a batch boundary', async () => {
    // The streaming golden-copy hazard: one child's relationships arrive in two
    // separate batches, so batch 2 must not delete batch 1's rows.
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([relA]);
    await svc.ingestLeiRelationships([relB]);
    expect(await parents()).toEqual([
      `IS_DIRECTLY_CONSOLIDATED_BY->${relA.parentLei}`,
      `IS_ULTIMATELY_CONSOLIDATED_BY->${relB.parentLei}`,
    ]);
  });

  it("keeps a child's rows a delta does not restate", async () => {
    // A delta carries only changed relationships: restating relA says nothing about relB.
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([relA, relB]);
    await svc.ingestLeiRelationships([{ ...relA, relationshipStatus: 'INACTIVE' }]);
    const rows = await svc.getRelationships(CHILD, 'parents');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.parentLei === relA.parentLei)?.relationshipStatus).toBe('INACTIVE');
  });

  it('removes the row a change marks deleted, and only that row', async () => {
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([relA, relB]);
    await svc.ingestLeiRelationships([{ ...relA, deleted: true }]);
    expect(await parents()).toEqual([`IS_ULTIMATELY_CONSOLIDATED_BY->${relB.parentLei}`]);
    // Deleting a row that is not stored is a no-op, so a re-applied delta converges.
    await svc.ingestLeiRelationships([{ ...relA, deleted: true }]);
    expect(await parents()).toEqual([`IS_ULTIMATELY_CONSOLIDATED_BY->${relB.parentLei}`]);
  });

  it("leaves each key in its last record's state, in document order within one batch", async () => {
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([
      relA,
      { ...relA, deleted: true },
      relA,
      relB,
      { ...relB, deleted: true },
    ]);
    expect(await parents()).toEqual([`IS_DIRECTLY_CONSOLIDATED_BY->${relA.parentLei}`]);
  });

  it('clearLeiRelationships wipes the table', async () => {
    await svc.clearLeiRelationships();
    expect(await svc.getRelationships(CHILD, 'parents')).toHaveLength(0);
    expect((await svc.leiReadiness()).relationshipCount).toBe(0);
  });
});

describe('reporting exceptions — per-record apply and batched read (issue #26)', () => {
  const LEI = '0292001156F2T0UFG565';
  const OTHER = '097900BHKT0000085647';
  const DIRECT = 'DIRECT_ACCOUNTING_CONSOLIDATION_PARENT';
  const ULTIMATE = 'ULTIMATE_ACCOUNTING_CONSOLIDATION_PARENT';

  it('upserts by (LEI, category), deletes on the marker, and keeps the last record', async () => {
    await svc.clearReportingExceptions();
    await svc.ingestReportingExceptions([
      { lei: LEI, category: DIRECT, reasons: ['NON_PUBLIC'] },
      { lei: LEI, category: DIRECT, reasons: ['NATURAL_PERSONS'] },
      { lei: LEI, category: ULTIMATE, reasons: ['NATURAL_PERSONS', 'NO_KNOWN_PERSON'] },
      { lei: OTHER, category: DIRECT, reasons: ['NO_LEI'] },
      { lei: OTHER, category: DIRECT, reasons: ['NO_LEI'], deleted: true },
    ]);
    const byLei = await svc.getReportingExceptions([LEI, OTHER, '5493001KJTIIGC8Y1R12']);
    expect(byLei.get(LEI)).toEqual([
      { category: DIRECT, reasons: ['NATURAL_PERSONS'] },
      { category: ULTIMATE, reasons: ['NATURAL_PERSONS', 'NO_KNOWN_PERSON'] },
    ]);
    expect(byLei.has(OTHER)).toBe(false);
    expect(byLei.has('5493001KJTIIGC8Y1R12')).toBe(false);
    expect((await svc.leiReadiness()).exceptionCount).toBe(2);
  });

  it('reports the exception count of the committed state, re-counted after each commit', async () => {
    const before = (await svc.leiReadiness()).exceptionCount;
    await svc.ingestReportingExceptions([
      { lei: OTHER, category: DIRECT, reasons: ['NO_LEI'] },
      { lei: OTHER, category: ULTIMATE, reasons: ['NO_LEI'] },
    ]);
    // Rows a load or refresh is still applying are not counted until it commits.
    expect((await svc.leiReadiness()).exceptionCount).toBe(before);
    await svc.markLeiReady(3, { repex: '2026-09-25T10:00:00Z' });
    expect((await svc.leiReadiness()).exceptionCount).toBe(before + 2);
  });

  it('counts as loaded only once a load is recorded, never because rows exist', async () => {
    const fresh = await freshService();
    try {
      await fresh.service.ingestReportingExceptions([
        { lei: LEI, category: DIRECT, reasons: ['NON_PUBLIC'] },
      ]);
      expect(await fresh.service.reportingExceptionsLoaded()).toBe(false);
      await fresh.service.markLeiReady(0, { repex: '2026-09-25T09:01:50Z' });
      expect(await fresh.service.reportingExceptionsLoaded()).toBe(true);
    } finally {
      await fresh.cleanup();
    }
  });
});

describe('markLeiReady — the durable GLEIF checkpoint (issue #49)', () => {
  it('records the per-dataset checkpoint it is given, with the live entity count', async () => {
    await svc.markLeiReady(99, { lei2: '2026-09-25T08:08:49Z', rr: '2026-09-25T09:17:31Z' });
    expect(await svc.gleifCheckpoint()).toEqual({
      lei2: '2026-09-25T08:08:49Z',
      rr: '2026-09-25T09:17:31Z',
    });
    expect((await svc.leiReadiness()).total).toBe(99);
  });

  it('keeps the stored checkpoint when given none', async () => {
    await svc.markLeiReady(1, { lei2: '2026-09-25T08:08:49Z' });
    await svc.markLeiReady(2);
    expect(await svc.gleifCheckpoint()).toEqual({ lei2: '2026-09-25T08:08:49Z' });
  });

  it('reads no checkpoint from a mirror whose sync state carries none', async () => {
    const fresh = await freshService();
    try {
      expect(await fresh.service.gleifCheckpoint()).toEqual({});
    } finally {
      await fresh.cleanup();
    }
  });
});

describe('re-harvest idempotence (issue #14)', () => {
  const HARVEST_XML = `<sdnList>
    <sdnEntry><uid>RH-1</uid><firstName>Reharvest</firstName><lastName>Person</lastName></sdnEntry>
    <sdnEntry><firstName>Identifierless</firstName><lastName>Person</lastName></sdnEntry>
  </sdnList>`;

  it('re-ingesting the same source document updates rows instead of inserting new ones', async () => {
    const harvest = () => parseOfac(parseXml(HARVEST_XML), 'ofac_sdn');

    await svc.ingestDesignations(harvest());
    const afterFirst = await svc.sourceCounts();
    await svc.ingestDesignations(harvest());

    expect(await svc.sourceCounts()).toEqual(afterFirst);
  });

  it('never admits a record the source gave no identifier for', async () => {
    await svc.ingestDesignations(parseOfac(parseXml(HARVEST_XML), 'ofac_sdn'));

    const admitted = await svc.screenName({ ...screenDefaults, query: 'Reharvest Person' }, ctx);
    expect(admitted.hits.map((h) => h.sourceEntryId)).toContain('RH-1');

    const rejected = await svc.screenName(
      { ...screenDefaults, query: 'Identifierless Person', autoFallback: false },
      ctx,
    );
    expect(rejected.hits).toHaveLength(0);
  });
});

// ─── Fuzzy blocking prefixes (issue #31) ───────────────────────────────────────

/**
 * Every `LIKE` pattern the fuzzy paths bind during `run` — the blocking prefixes
 * as SQLite receives them, read at the statement boundary.
 */
async function likePatterns(handle: SqliteHandle, run: () => Promise<unknown>): Promise<string[]> {
  const original = handle.prepare.bind(handle);
  const patterns: string[] = [];
  handle.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!/\bLIKE \?/.test(sql)) return statement;
    return {
      ...statement,
      all: (...params: Parameters<typeof statement.all>) => {
        patterns.push(String(params[0]));
        return statement.all(...params);
      },
    };
  }) as typeof handle.prepare;
  try {
    await run();
  } finally {
    handle.prepare = original;
  }
  return patterns;
}

/**
 * Every FTS prefix term the fuzzy blocking lookups bind during `run` — the
 * blocking prefixes as the index receives them (`"fic"*`), read at the statement
 * boundary.
 */
async function indexPrefixes(handle: SqliteHandle, run: () => Promise<unknown>): Promise<string[]> {
  const original = handle.prepare.bind(handle);
  const prefixes: string[] = [];
  handle.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!/\bMATCH \?/.test(sql)) return statement;
    return {
      ...statement,
      all: (...params: Parameters<typeof statement.all>) => {
        for (const m of String(params[0]).matchAll(/"([^"]+)"\*/g)) prefixes.push(m[1] ?? '');
        return statement.all(...params);
      },
    };
  }) as typeof handle.prepare;
  try {
    await run();
  } finally {
    handle.prepare = original;
  }
  return prefixes;
}

/** What a screen read from the designation `name` index. */
interface NameIndexTrace {
  /** Each MATCH lookup: the expression it bound and the name rowids it returned. */
  lookups: { expression: string; rowids: number[] }[];
  /** The name rows the fuzzy pass scored — its candidate pool — rowid → designation id. */
  pooled: Map<number, string>;
  /** Every statement that read the name index, with the parameters it ran with. */
  statements: { params: unknown[]; sql: string }[];
}

/**
 * Trace what `run` reads from the name index, at the statement boundary. A row
 * read with its `rowid` and `normalized` columns is one the fuzzy pass scores;
 * the strict pass reads no `rowid`, so its rows never count as pooled.
 */
async function traceNameIndex<T>(
  handle: SqliteHandle,
  run: () => Promise<T>,
): Promise<NameIndexTrace & { result: T }> {
  const original = handle.prepare.bind(handle);
  const trace: NameIndexTrace = { lookups: [], pooled: new Map(), statements: [] };
  handle.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!/\b(FROM|JOIN) name(_fts|_blocking_fts)?\b/.test(sql)) return statement;
    return {
      ...statement,
      all: (...params: Parameters<typeof statement.all>) => {
        const rows = statement.all(...params) as Record<string, unknown>[];
        trace.statements.push({ sql, params });
        if (/\bMATCH \?/.test(sql)) {
          trace.lookups.push({
            expression: String(params[0]),
            rowids: rows.map((row) => Number(row.rowid)),
          });
        }
        for (const row of rows) {
          if ('rowid' in row && 'normalized' in row) {
            trace.pooled.set(Number(row.rowid), String(row.designation_id));
          }
        }
        return rows;
      },
    };
  }) as typeof handle.prepare;
  try {
    return { ...trace, result: await run() };
  } finally {
    handle.prepare = original;
  }
}

/** True when a phonetic lookup returned one of the designation's name rows and the pass scored it. */
function phoneticallyPooled(trace: NameIndexTrace, designationId: string): boolean {
  const rows = [...trace.pooled].filter(([, id]) => id === designationId).map(([rowid]) => rowid);
  return trace.lookups.some(
    ({ expression, rowids }) =>
      expression.includes('phonetic :') && rowids.some((rowid) => rows.includes(rowid)),
  );
}

/** The plan steps that read a table row by row rather than through an index. */
function tableScans(handle: SqliteHandle, statements: NameIndexTrace['statements']): string[] {
  return statements.flatMap(({ sql, params }) =>
    handle
      .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(params as never[]))
      .map((step) => step.detail)
      .filter((detail) => detail.startsWith('SCAN ') && !detail.includes('VIRTUAL TABLE')),
  );
}

/** One designation whose only name is `name`. */
function namedDesignation(entryId: string, name: string): NormalizedDesignation {
  return listed('un', entryId, name);
}

/** One designation on `source` whose only name is `name`. */
function listed(
  source: NormalizedDesignation['source'],
  entryId: string,
  name: string,
  entityType: NormalizedDesignation['entityType'] = 'person',
): NormalizedDesignation {
  return {
    id: `${source}:${entryId}`,
    source,
    sourceEntryId: entryId,
    entityType,
    primaryName: name,
    payload: { aliases: [], identifiers: [], addresses: [], datesOfBirth: [], nationalities: [] },
  };
}

describe('fuzzy blocking prefixes — BMP tokens', () => {
  it('blocks the designation path on each token’s leading three characters, dropping one-letter tokens, through the name index', async () => {
    const handle = await svc.designations.raw();
    const run = () =>
      svc.screenName(
        { ...screenDefaults, matchMode: 'fuzzy', query: 'Nikolas Ib Maduro X Moros' },
        ctx,
      );
    expect(await indexPrefixes(handle, run)).toEqual(['nik', 'ib', 'mad', 'mor']);
    expect(await likePatterns(handle, run)).toEqual([]);
  });

  it('blocks the LEI path on the same prefixes, through the name index', async () => {
    const handle = await svc.leiEntities.raw();
    const run = () =>
      svc.resolveEntity(
        { query: 'Fictionall Tradng Xu X', matchMode: 'fuzzy', limit: 10, status: 'any' },
        ctx,
      );
    expect(await indexPrefixes(handle, run)).toEqual(['fic', 'tra', 'xu']);
    expect(await likePatterns(handle, run)).toEqual([]);
  });
});

describe('fuzzy blocking prefixes — supplementary-plane letters (issue #31)', () => {
  // U+20000–U+20004 (CJK Extension B): each is one code point, two UTF-16 units.
  const STORED = '𠀀𠀁𠀂𠀃';
  const QUERY = '𠀀𠀁𠀂𠀄'; // shares its first three code points with STORED

  let astral: SeededService;
  afterEach(async () => {
    await astral.cleanup();
  });

  it('pools and admits a designation on its supplementary-plane prefix', async () => {
    astral = await freshService();
    const service = astral.service;
    await service.ingestDesignations([namedDesignation('ASTRAL-1', STORED)]);

    const handle = await service.designations.raw();
    const run = () =>
      service.screenName({ ...screenDefaults, matchMode: 'fuzzy', query: QUERY }, ctx);
    const prefixes = await indexPrefixes(handle, run);

    expect(prefixes).toEqual(['𠀀𠀁𠀂']);
    expect(prefixes.every((p) => p.isWellFormed())).toBe(true);
    expect(await likePatterns(handle, run)).toEqual([]);
    expect((await run()).hits.map((h) => h.designationId)).toEqual(['un:ASTRAL-1']);
  });

  it('pools and admits an LEI entity on its supplementary-plane prefix', async () => {
    astral = await freshService();
    const service = astral.service;
    await service.ingestLeiEntities([
      { lei: '5493001KJTIIGC8Y1R12', legalName: STORED, otherNames: [] },
    ]);

    const handle = await service.leiEntities.raw();
    let leis: string[] = [];
    const prefixes = await indexPrefixes(handle, async () => {
      const res = await service.resolveEntity(
        { query: QUERY, matchMode: 'fuzzy', limit: 10, status: 'any' },
        ctx,
      );
      leis = res.matches.map((m) => m.lei);
    });

    expect(prefixes).toEqual(['𠀀𠀁𠀂']);
    expect(prefixes.every((p) => p.isWellFormed())).toBe(true);
    expect(leis).toEqual(['5493001KJTIIGC8Y1R12']);
  });

  it('counts a token’s length in code points, so a lone supplementary letter blocks nothing', async () => {
    astral = await freshService();
    const service = astral.service;
    await service.ingestDesignations([namedDesignation('ASTRAL-2', 'ab𠀀xyz')]);

    const handle = await service.designations.raw();
    const prefixes = await indexPrefixes(handle, () =>
      service.screenName({ ...screenDefaults, matchMode: 'fuzzy', query: '𠀀 ab𠀀x' }, ctx),
    );

    // `𠀀` is one code point (two code units) — too short to block on, like any
    // one-letter token; `ab𠀀x` blocks on its first three code points, whole.
    expect(prefixes).toEqual(['ab𠀀']);
  });

  it('admits a supplementary-plane candidate exactly when its BMP twin is admitted', async () => {
    // `𠀀𠀁𠀂𠀃𠀄𠀅` / `𠀀𠀁𠀂𠀗𠀘𠀙` is the code-point image of `abcdef` / `abcxyz`: three
    // shared letters of six score 0.7667, under the 0.85 floor, in either plane.
    // Counted in UTF-16 code units, the shared high surrogates lift it to 0.90.
    astral = await freshService();
    const service = astral.service;
    await service.ingestDesignations([
      namedDesignation('BMP-TWIN', 'abcxyz'),
      namedDesignation('ASTRAL-TWIN', '𠀀𠀁𠀂𠀗𠀘𠀙'),
    ]);
    const screen = (query: string) =>
      service.screenName({ ...screenDefaults, matchMode: 'fuzzy', query }, ctx);

    expect((await screen('abcdef')).hits).toEqual([]);
    expect((await screen('𠀀𠀁𠀂𠀃𠀄𠀅')).hits).toEqual([]);

    // A genuine near-miss still admits in both planes, at the same score.
    const bmp = await screen('abcxyw');
    const sup = await screen('𠀀𠀁𠀂𠀗𠀘𠀖');
    expect(bmp.hits.map((h) => h.designationId)).toEqual(['un:BMP-TWIN']);
    expect(sup.hits.map((h) => h.designationId)).toEqual(['un:ASTRAL-TWIN']);
    expect(sup.hits[0]?.score).toBe(bmp.hits[0]?.score);
  });
});

// ─── Fuzzy blocking through the name index (issues #50, #54, #68) ─────────────

/** A designation with a Han alias whose leading characters a query can omit. */
const LIMBACH: NormalizedDesignation = {
  id: 'eu:171379',
  source: 'eu',
  sourceEntryId: '171379',
  entityType: 'organization',
  primaryName: 'Xiamen Limbach Aviation Engine Co., Ltd',
  payload: {
    aliases: [{ name: '厦门林巴贺航空发动机股份有限公司', nameType: 'aka' }],
    identifiers: [],
    addresses: [],
    datesOfBirth: [],
    nationalities: [],
  },
};

describe('fuzzy blocking — index lookups (issue #50)', () => {
  it.each([
    {},
    { entityType: 'person' as const },
    { sources: ['uk' as const] },
    { sources: ['uk' as const, 'eu' as const], entityType: 'person' as const },
  ])('plans every name-index read on an index, filters %j', async (filters) => {
    const handle = await svc.designations.raw();
    const trace = await traceNameIndex(handle, () =>
      svc.screenName(
        { ...screenDefaults, ...filters, query: 'Vladimir Poutine', matchMode: 'fuzzy' },
        ctx,
      ),
    );
    expect(trace.statements.length).toBeGreaterThan(1);
    expect(tableScans(handle, trace.statements)).toEqual([]);
  });

  it('reads only index lookups for a 64-word query whose words match nothing', async () => {
    const words = Array.from(
      { length: 64 },
      (_, i) => `q${'bcdfghjk'[i % 8]}${'lmnpqrst'[Math.floor(i / 8)]}zzv`,
    );
    const handle = await svc.designations.raw();
    const trace = await traceNameIndex(handle, () =>
      svc.screenName({ ...screenDefaults, query: words.join(' '), matchMode: 'fuzzy' }, ctx),
    );
    expect(trace.result.hits).toEqual([]);
    expect(trace.statements.filter(({ sql }) => /\bLIKE\b/.test(sql))).toEqual([]);
    expect(tableScans(handle, trace.statements)).toEqual([]);
  });

  it('pools a Han name queried without its leading characters, which no token prefix reaches', async () => {
    await svc.ingestDesignations([LIMBACH]);
    const res = await svc.screenName(
      { ...screenDefaults, query: '林巴贺航空发动机股份有限公司', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.hits[0]).toMatchObject({
      designationId: 'eu:171379',
      matchedName: '厦门林巴贺航空发动机股份有限公司',
      matchType: 'approximate',
    });
    const handle = await svc.designations.raw();
    const tokenPrefixRows = handle
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM name_fts WHERE name_fts MATCH ?')
      .get('normalized : "林巴贺"*')?.n;
    expect(tokenPrefixRows).toBe(0);
  });

  it.each([
    ['a mid-token run of a Han name', '林巴贺航空发动机股份有限公司'],
    ['the phonetic keys of a name', 'k0rn ptrf'],
  ])('never widens a strict hit to %s', async (_, query) => {
    await svc.ingestDesignations([LIMBACH]);
    const res = await svc.screenName({ ...screenDefaults, query, autoFallback: false }, ctx);
    expect(res.hits).toEqual([]);
  });
});

describe('fuzzy candidate pool — whole blocks under one budget (issue #54)', () => {
  const PUTIN = listed('uk', 'PUTIN-1', 'Vladimir Vladimirovich PUTIN');
  /** `count` OFAC persons whose names open with `stem`. */
  const namesakes = (count: number, stem: string): NormalizedDesignation[] =>
    Array.from({ length: count }, (_, i) => listed('ofac_sdn', `NS-${i}`, `${stem} Zx${i}`));
  const screenPutin = (service: ScreeningService, filters: { entityType?: 'person' } = {}) =>
    service.screenName(
      { ...screenDefaults, ...filters, query: 'Vladimir Poutine', matchMode: 'fuzzy', limit: 100 },
      ctx,
    );

  it('pools a later-listed match that shares its prefix with more rows than one lookup used to keep', async () => {
    await svc.ingestDesignations([...namesakes(250, 'Vladimir'), PUTIN]);
    const res = await screenPutin(svc, { entityType: 'person' });
    const rank = res.hits.findIndex((h) => h.designationId === 'uk:PUTIN-1');
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(5);
  });

  it.each([{}, { entityType: 'person' as const }])(
    'returns identical hits whichever order the lists were ingested in, filters %j',
    async (filters) => {
      const corpus = [...namesakes(250, 'Vladimir'), PUTIN];
      const screens: Awaited<ReturnType<typeof screenPutin>>[] = [];
      for (const order of [corpus, [...corpus].reverse()]) {
        const fresh = await freshService();
        try {
          await fresh.service.ingestDesignations(order);
          screens.push(await screenPutin(fresh.service, filters));
        } finally {
          await fresh.cleanup();
        }
      }
      expect(screens[1]).toEqual(screens[0]);
      expect(screens[0]?.hits.some((h) => h.designationId === 'uk:PUTIN-1')).toBe(true);
    },
  );

  it('never pools more than the budget, at the 64-word bound', async () => {
    const words = Array.from(
      { length: 64 },
      (_, i) => `${'bdfgklmp'[i % 8]}a${'bdfgklmp'[Math.floor(i / 8)]}ondo`,
    );
    await svc.ingestDesignations(
      words.flatMap((word, w) =>
        Array.from({ length: 40 }, (_, j) => listed('un', `BUDGET-${w}-${j}`, `${word} Zx${j}`)),
      ),
    );
    const trace = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName({ ...screenDefaults, query: words.join(' '), matchMode: 'fuzzy' }, ctx),
    );
    expect(trace.pooled.size).toBeGreaterThan(0);
    expect(trace.pooled.size).toBeLessThanOrEqual(FUZZY_POOL_BUDGET);
  });

  it.each([{ sources: ['uk' as const] }, { entityType: 'vessel' as const }])(
    'measures blocks under the request filters, pooling a match only they make fit: %j',
    async (filters) => {
      // Unfiltered, every block of the query holds 2,101 rows — past the budget.
      await svc.ingestDesignations([
        ...Array.from({ length: 2100 }, (_, i) =>
          listed('ofac_sdn', `PET-${i}`, `Vladimir Petrenko${i}`),
        ),
        listed('uk', 'PET-UK', 'Vladimir Petrenkov', 'vessel'),
      ]);
      const res = await svc.screenName(
        { ...screenDefaults, ...filters, query: 'Vladimir Petrenkox', matchMode: 'fuzzy' },
        ctx,
      );
      expect(res.hits.map((h) => h.designationId)).toContain('uk:PET-UK');
    },
  );
});

describe('fuzzy candidate pool — one budget per list (issues #54, #59)', () => {
  /**
   * Every blocking key of `Shihab Mohammed` (`shi`, `moh`, and both words'
   * phonetic keys) reaches 1,200 OFAC names and 901 EU names, each pair of keys
   * the same names: each list fits the budget alone, the two together do not.
   * None holds `mohammed`, so strict finds them nowhere; `un:EXACT` is the one
   * strict hit, for the completion case.
   */
  const crowd = (source: SourceCode, count: number, stem: string): NormalizedDesignation[] =>
    Array.from({ length: count }, (_, i) =>
      listed(source, `CROWD-${i}`, `Shihab Mohammad ${stem}${i}`),
    );

  beforeEach(async () => {
    await svc.ingestDesignations([
      ...crowd('ofac_sdn', 1200, 'Zx'),
      ...crowd('eu', 900, 'Qx'),
      listed('eu', 'TARGET', 'Mohammad Shihab'),
      listed('un', 'EXACT', 'Shihab Mohammed'),
    ]);
  });

  const screen = (matchMode: 'fuzzy' | 'strict', sources: SourceCode[]) =>
    svc.screenName(
      { ...screenDefaults, query: 'Shihab Mohammed', matchMode, sources, limit: 5000 },
      ctx,
    );
  const hitsOn = (res: Awaited<ReturnType<typeof screen>>, source: SourceCode) =>
    res.hits.filter((hit) => hit.source === source).map((hit) => hit.designationId);

  it.each([
    ['fuzzy mode', 'fuzzy', [], 'fuzzy'],
    ['the fallback when strict finds nothing', 'strict', [], 'fuzzy'],
    ['the completion of the lists strict found nothing on', 'strict', ['un'], 'strict'],
  ] as const)(
    'gives each list the candidates it has when screened without the other: %s',
    async (_, matchMode, others, modeUsed) => {
      const joined = await screen(matchMode, ['ofac_sdn', 'eu', ...others]);
      for (const source of ['ofac_sdn', 'eu'] as const) {
        const alone = await screen(matchMode, [source, ...others]);
        expect(hitsOn(joined, source), source).toEqual(hitsOn(alone, source));
      }
      expect(hitsOn(joined, 'eu')).toContain('eu:TARGET');
      expect(hitsOn(joined, 'eu')).toHaveLength(901);
      expect(hitsOn(joined, 'ofac_sdn')).toHaveLength(1200);
      expect(joined).toMatchObject({
        modeUsed,
        fuzzySources: ['ofac_sdn', 'eu'],
        poolBounded: false,
      });
    },
  );

  it('never pools more than the budget from one list, at the 64-word bound', async () => {
    const words = Array.from(
      { length: 64 },
      (_, i) => `${'bdfgklmp'[i % 8]}a${'bdfgklmp'[Math.floor(i / 8)]}ondo`,
    );
    const lists = ['eu', 'un'] as const;
    await svc.ingestDesignations(
      lists.flatMap((source) =>
        words.flatMap((word, w) =>
          Array.from({ length: 40 }, (_, j) =>
            listed(source, `BUDGET-${w}-${j}`, `${word} Zx${j}`),
          ),
        ),
      ),
    );
    const trace = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName({ ...screenDefaults, query: words.join(' '), matchMode: 'fuzzy' }, ctx),
    );
    const pooled = [...trace.pooled.values()];
    for (const source of lists) {
      const fromList = pooled.filter((id) => id.startsWith(`${source}:`)).length;
      expect(fromList, source).toBeGreaterThan(0);
      expect(fromList, source).toBeLessThanOrEqual(FUZZY_POOL_BUDGET);
    }
    expect(pooled.length).toBeGreaterThan(FUZZY_POOL_BUDGET);
    expect(trace.result.poolBounded).toBe(true);
  });
});

describe('fuzzy phonetic arm — per-word keys (issue #68)', () => {
  it('pools a multi-word name whose only word in common with the query is a phonetic variant', async () => {
    await svc.ingestDesignations([listed('un', 'PH-1', 'MOHAMMED Zarqawi Faisal')]);
    const trace = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName({ ...screenDefaults, query: 'Muhammad Qorbx', matchMode: 'fuzzy' }, ctx),
    );
    expect(phoneticallyPooled(trace, 'un:PH-1')).toBe(true);
  });

  it('looks each query word’s key up through the name index', async () => {
    const handle = await svc.designations.raw();
    const trace = await traceNameIndex(handle, () =>
      svc.screenName(
        { ...screenDefaults, query: 'Muhammad Qorbx', matchMode: 'fuzzy', entityType: 'person' },
        ctx,
      ),
    );
    const phonetic = trace.statements.filter(({ params }) =>
      String(params[0]).includes('phonetic :'),
    );
    expect(phonetic.map(({ params }) => params[0])).toEqual([
      '(phonetic : "MHMT")',
      '(phonetic : "KRPKS")',
    ]);
    expect(tableScans(handle, phonetic)).toEqual([]);
  });
});

// ─── LEI fuzzy pool (issue #51) ────────────────────────────────────────────────

/**
 * A well-formed test LEI: the tag padded to 18 characters with `X`, then two
 * digits. A digit pad would make `CROWD1` and `CROWD10` one LEI.
 */
const testLei = (tag: string): string => `${tag.padEnd(18, 'X')}42`;

/** One ISSUED entity whose only name is its legal name. */
function registered(tag: string, legalName: string, jurisdiction = 'US'): NormalizedLeiEntity {
  return { lei: testLei(tag), legalName, otherNames: [], jurisdiction, status: 'ISSUED' };
}

/**
 * The LEIs `run` pooled for scoring — the list the fuzzy pass reads every name
 * of, read at the statement boundary — or none when it pooled none.
 */
async function pooledLeis(handle: SqliteHandle, run: () => Promise<unknown>): Promise<string[]> {
  const original = handle.prepare.bind(handle);
  let pooled: string[] = [];
  handle.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!/\bn\.lei IN \(SELECT value FROM json_each\(\?\)\)/.test(sql)) return statement;
    return {
      ...statement,
      all: (...params: Parameters<typeof statement.all>) => {
        pooled = JSON.parse(String(params[0])) as string[];
        return statement.all(...params);
      },
    };
  }) as typeof handle.prepare;
  try {
    await run();
  } finally {
    handle.prepare = original;
  }
  return pooled;
}

describe('LEI fuzzy candidate pool — whole blocks under one budget (issue #51)', () => {
  const TARGET = registered('KESTRELOSTWIND', 'Kestrel Bank Ostwind', 'DE');
  /**
   * `count` entities per word, each sharing only that word with the target —
   * so `kes` and `ost` each hold one name more than the budget, and only the
   * target holds both.
   */
  const crowd = (count: number): NormalizedLeiEntity[] => [
    ...Array.from({ length: count }, (_, i) => registered(`KESCROWD${i}`, `Kestrel Zx${i}`)),
    ...Array.from({ length: count }, (_, i) => registered(`OSTCROWD${i}`, `Zy${i} Ostwind`)),
  ];
  const resolveTypo = (service: ScreeningService, extra: { jurisdiction?: string } = {}) =>
    service.resolveEntity(
      { query: 'Kestrel Bnak Ostwind', matchMode: 'fuzzy', status: 'any', limit: 100, ...extra },
      ctx,
    );

  it('pools a target only a pair of its words reaches, each word shared with more names than the budget', async () => {
    await svc.ingestLeiEntities([...crowd(FUZZY_POOL_BUDGET), TARGET]);
    const res = await resolveTypo(svc);
    expect(res.matches.map((m) => m.lei)).toContain(TARGET.lei);
    expect(res.matches.find((m) => m.lei === TARGET.lei)).toMatchObject({
      score: 1,
      queryTokenCoverage: { covered: 3, total: 3 },
    });
  });

  it('returns identical matches whichever order the entities were written in', async () => {
    const corpus = [...crowd(FUZZY_POOL_BUDGET), TARGET];
    const results: Awaited<ReturnType<typeof resolveTypo>>[] = [];
    for (const order of [corpus, [...corpus].reverse()]) {
      const fresh = await freshService();
      try {
        await fresh.service.ingestLeiEntities(order);
        results.push(await resolveTypo(fresh.service));
      } finally {
        await fresh.cleanup();
      }
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.matches.map((m) => m.lei)).toContain(TARGET.lei);
  });

  it('measures a block inside the jurisdiction, pooling a match only it makes fit', async () => {
    // Unfiltered, `kes` holds 2,101 names; under DE it holds the target alone.
    await svc.ingestLeiEntities([
      ...Array.from({ length: 2100 }, (_, i) => registered(`KESONLY${i}`, `Kestrel Zx${i}`)),
      TARGET,
    ]);
    const res = await svc.resolveEntity(
      { query: 'Kestrel Bnak', jurisdiction: 'DE', matchMode: 'fuzzy', status: 'any', limit: 100 },
      ctx,
    );
    expect(res.matches.map((m) => m.lei)).toEqual([TARGET.lei]);
  });

  it('never pools more LEIs than the budget, at the 64-word bound', async () => {
    const words = Array.from(
      { length: 64 },
      (_, i) => `${'bdfgklmp'[i % 8]}a${'bdfgklmp'[Math.floor(i / 8)]}ondo`,
    );
    await svc.ingestLeiEntities(
      words.flatMap((word, w) =>
        Array.from({ length: 40 }, (_, j) => registered(`BUDGET${w}X${j}`, `${word} Zx${j}`)),
      ),
    );
    const pooled = await pooledLeis(await svc.leiEntities.raw(), () =>
      svc.resolveEntity(
        { query: words.join(' '), matchMode: 'fuzzy', status: 'any', limit: 100 },
        ctx,
      ),
    );
    expect(pooled.length).toBeGreaterThan(0);
    expect(pooled.length).toBeLessThanOrEqual(FUZZY_POOL_BUDGET);
    expect(new Set(pooled).size).toBe(pooled.length);
  });
});

// ─── Fuzzy stoplist (issue #55) ────────────────────────────────────────────────

/** One designation on `source` named `primaryName`, with its aliases. */
function withAliases(
  source: NormalizedDesignation['source'],
  entryId: string,
  primaryName: string,
  aliases: string[],
  entityType: NormalizedDesignation['entityType'] = 'organization',
): NormalizedDesignation {
  const designation = listed(source, entryId, primaryName, entityType);
  designation.payload.aliases = aliases.map((name) => ({ name, nameType: 'aka' as const }));
  return designation;
}

describe('fuzzy stoplist — legal forms, articles, and codes carry no admission (issue #55)', () => {
  const SOVCOMFLOT = [
    withAliases('eu', 'SCF-EU', 'JSC Sovcomflot', ['PAO Sovcomflot']),
    withAliases('ofac_sdn', 'SCF-OFAC', 'Joint Stock Company Sovcomflot', ['PAO Sovcomflot']),
    listed('uk', 'SCF-UK', 'Sovcomflot', 'organization'),
  ];
  /** Organizations that share only a legal form, an article, or a code with the probes. */
  const LOOKALIKES = [
    listed('ofac_sdn', 'LTD-1', 'Arctic Shipping Ltd', 'organization'),
    listed('ofac_sdn', 'LTD-2', 'Baltic Ltd', 'organization'),
    listed('ofac_sdn', 'LTD-3', 'Delta (UK) Ltd', 'organization'),
    listed('eu', 'OIL-1', 'Gulf Oil Company', 'organization'),
    listed('eu', 'OIL-2', 'Caspian Oil', 'organization'),
    listed('eu', 'CO-1', 'Northern Trading Company', 'organization'),
  ];
  const screen = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, query, limit: 100, ...extra }, ctx);
  const ids = (hits: { designationId: string }[]) => hits.map((h) => h.designationId);

  beforeEach(async () => {
    await svc.ingestDesignations([...SOVCOMFLOT, ...LOOKALIKES]);
  });

  it('admits every match of a name’s one distinctive word, however many legal forms and codes wrap it', async () => {
    const res = await screen('SOVCOMFLOT (UK) LTD');
    expect(res.modeUsed).toBe('fuzzy');
    expect(ids(res.hits).sort()).toEqual(['eu:SCF-EU', 'ofac_sdn:SCF-OFAC', 'uk:SCF-UK']);
  });

  it('admits no candidate that shares only a legal form with the query', async () => {
    const res = await screen('Sovcomflot Ltd', { matchMode: 'fuzzy', sources: ['ofac_sdn'] });
    expect(ids(res.hits)).toEqual(['ofac_sdn:SCF-OFAC']);
  });

  it('admits no candidate that covers only `oil` or `company` of `Rosneft Oil Company`', async () => {
    await svc.ingestDesignations([
      listed('eu', 'ROSNEFT', 'Rosneft Oil Company PJSC', 'organization'),
    ]);
    const res = await screen('Rosneft Oil Company', { matchMode: 'fuzzy' });
    expect(ids(res.hits)).toEqual(['eu:ROSNEFT']);
  });

  it('keeps counting every query token in the surfaced coverage', async () => {
    const res = await screen('SOVCOMFLOT (UK) LTD');
    const hit = res.hits.find((h) => h.designationId === 'eu:SCF-EU');
    expect(hit).toMatchObject({ matchType: 'approximate', score: 1 });
    expect(hit?.queryTokenCoverage).toEqual({ covered: 1, total: 3 });
    expect(res.normalizedQuery).toBe('sovcomflot uk ltd');
  });

  it.each([
    ['Pae Won Uk', ['Kim Chang Uk', 'Pae Song Il']],
    ['Augusto Mario Co', ['Mario Trading Co', 'Augusto Holdings Co']],
    ['Iyad Ag Ghali', ['Ag Saleh Trading', 'Iyad Al Rashid']],
  ])('keeps a listed name with a stoplisted syllable first: %s', async (name, decoys) => {
    await svc.ingestDesignations([
      listed('un', 'SYLLABLE', name),
      ...decoys.map((decoy, i) => listed('un', `DECOY-${i}`, decoy)),
    ]);
    for (const matchMode of ['strict', 'fuzzy'] as const) {
      const res = await screen(name, { matchMode });
      expect(res.hits[0]?.designationId, matchMode).toBe('un:SYLLABLE');
    }
  });

  it('gates a query made only of stoplist tokens as it always has', async () => {
    await svc.ingestDesignations([
      listed('eu', 'LLC-FULL', 'Alpha Limited Liability Company', 'organization'),
      listed('eu', 'LLC-PART', 'Beta Limited', 'organization'),
    ]);
    const res = await screen('Limited Liability Company', { matchMode: 'fuzzy' });
    expect(ids(res.hits)).toContain('eu:LLC-FULL');
    // One token of three: under half, as before the stoplist.
    expect(ids(res.hits)).not.toContain('eu:LLC-PART');
  });

  it('applies the same gate to LEI resolution', async () => {
    await svc.ingestLeiEntities([
      registered('SOVCOMFLOTPAO', 'Sovcomflot PAO'),
      registered('ARCTICSHIP', 'Arctic Shipping Ltd'),
      registered('BALTICLTD', 'Baltic Ltd'),
    ]);
    const res = await svc.resolveEntity(
      { query: 'Sovcomflot Ltd', matchMode: 'fuzzy', status: 'any', limit: 100 },
      ctx,
    );
    expect(res.matches.map((m) => m.lei)).toEqual([testLei('SOVCOMFLOTPAO')]);
    expect(res.matches[0]?.queryTokenCoverage).toEqual({ covered: 1, total: 2 });
  });
});

describe('fuzzy stoplist — blocking (issue #55)', () => {
  it('blocks the designation path on no stoplisted word', async () => {
    const handle = await svc.designations.raw();
    const prefixes = await indexPrefixes(handle, () =>
      svc.screenName(
        { ...screenDefaults, matchMode: 'fuzzy', query: 'Nikolas al Maduro X Moros' },
        ctx,
      ),
    );
    expect(prefixes).toEqual(['nik', 'mad', 'mor']);
  });

  it('keys no phonetic lookup on a stoplisted word', async () => {
    const trace = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName({ ...screenDefaults, query: 'Sovcomflot Ltd', matchMode: 'fuzzy' }, ctx),
    );
    const phonetic = trace.lookups
      .map(({ expression }) => expression)
      .filter((expression) => expression.includes('phonetic :'));
    expect(phonetic).toEqual([`(phonetic : "${doubleMetaphone('sovcomflot')}")`]);
  });

  it('blocks a query made only of stoplist tokens on all of them', async () => {
    const handle = await svc.designations.raw();
    const prefixes = await indexPrefixes(handle, () =>
      svc.screenName(
        { ...screenDefaults, matchMode: 'fuzzy', query: 'Limited Liability Company' },
        ctx,
      ),
    );
    expect(prefixes).toEqual(['lim', 'lia', 'com']);
  });

  it('blocks the LEI path on no stoplisted word', async () => {
    const handle = await svc.leiEntities.raw();
    const prefixes = await indexPrefixes(handle, () =>
      svc.resolveEntity(
        { query: 'Fictionall Tradng Co X', matchMode: 'fuzzy', limit: 10, status: 'any' },
        ctx,
      ),
    );
    expect(prefixes).toEqual(['fic', 'tra']);
  });

  it('still narrows a block past the budget by a stoplisted word, through a pair', async () => {
    // `fle` holds 2,002 names; only the target also carries `gmbh`.
    await svc.ingestLeiEntities([
      ...Array.from({ length: FUZZY_POOL_BUDGET + 1 }, (_, i) =>
        registered(`FLEXCROWD${i}`, `Flexa Zx${i}`),
      ),
      registered('FLEXOPUSGMBH', 'Flexopus GmbH', 'DE'),
    ]);
    const handle = await svc.leiEntities.raw();
    let leis: string[] = [];
    const prefixes = await indexPrefixes(handle, async () => {
      const res = await svc.resolveEntity(
        { query: 'Fleoxpus GmbH', matchMode: 'fuzzy', status: 'any', limit: 100 },
        ctx,
      );
      leis = res.matches.map((m) => m.lei);
    });
    expect(leis).toEqual([testLei('FLEXOPUSGMBH')]);
    // One block lookup for `fle`, then the pair; `gmb` is never looked up alone.
    expect(prefixes).toEqual(['fle', 'fle', 'gmb']);
  });
});

describe('OFAC SDN + Consolidated grouping (issue #61)', () => {
  /**
   * One OFAC party as both OFAC files publish it: one entry ID on each list. The
   * two records carry their own designation dates, as each file dates the party
   * from its own lists.
   */
  const ofacPair = (
    entryId: string,
    name: string,
    copies: {
      consolidated?: Partial<NormalizedDesignation>;
      sdn?: Partial<NormalizedDesignation>;
    } = {},
  ): NormalizedDesignation[] => [
    { ...listed('ofac_sdn', entryId, name, 'organization'), ...copies.sdn },
    { ...listed('ofac_consolidated', entryId, name, 'organization'), ...copies.consolidated },
  ];
  const withIdentifier = (value: string): Partial<NormalizedDesignation> => ({
    payload: {
      aliases: [],
      identifiers: [{ type: 'Tax ID No.', value, country: 'Russia' }],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  });

  beforeEach(async () => {
    await svc.ingestDesignations([
      ...ofacPair('GRP-17', 'Grouped Petroleum Holding', {
        sdn: {
          designationDate: '2025-10-22',
          program: 'RUSSIA-EO14024',
          ...withIdentifier('7706999990'),
        },
        consolidated: {
          designationDate: '2014-07-16',
          program: 'RUSSIA-EO14024',
          ...withIdentifier('7706999990'),
        },
      }),
      ...ofacPair('GRP-18', 'Grouped Petroleum Trading'),
      listed('ofac_consolidated', 'GRP-19', 'Grouped Petroleum Services', 'organization'),
      // The same name on another regime's list is another hit, never grouped.
      listed('eu', 'GRP-17', 'Grouped Petroleum Holding', 'organization'),
    ]);
  });

  const screen = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, query, ...extra }, ctx);
  const ids = (hits: readonly { designationId: string }[]) => hits.map((hit) => hit.designationId);

  it('returns the Consolidated copy alone when only ofac_consolidated is selected (characterization)', async () => {
    const res = await screen('Grouped Petroleum Holding', { sources: ['ofac_consolidated'] });
    expect(ids(res.hits)).toEqual(['ofac_consolidated:GRP-17']);
    expect(res.hits[0]?.designationDate).toBe('2014-07-16');
  });

  it('names the one selected list in sources when only one OFAC list is selected', async () => {
    const res = await screen('Grouped Petroleum Holding', { sources: ['ofac_consolidated'] });
    expect(res.hits.map((hit) => [hit.source, hit.sources])).toEqual([
      ['ofac_consolidated', ['ofac_consolidated']],
    ]);
  });

  it('groups an entry both OFAC lists publish into one hit, counted once, naming both lists', async () => {
    const res = await screen('Grouped Petroleum');
    expect(res.hits.map((hit) => [hit.designationId, hit.sources])).toEqual([
      ['ofac_sdn:GRP-17', ['ofac_sdn', 'ofac_consolidated']],
      ['ofac_sdn:GRP-18', ['ofac_sdn', 'ofac_consolidated']],
      ['ofac_consolidated:GRP-19', ['ofac_consolidated']],
      ['eu:GRP-17', ['eu']],
    ]);
    expect(res.totalAvailable).toBe(4);
  });

  it('carries the SDN copy on a tie — its source, entry ID, program, and designation date', async () => {
    const [hit] = (await screen('Grouped Petroleum Holding')).hits;
    expect(hit).toMatchObject({
      source: 'ofac_sdn',
      sourceEntryId: 'GRP-17',
      matchType: 'exact',
      program: 'RUSSIA-EO14024',
      designationDate: '2025-10-22',
      sources: ['ofac_sdn', 'ofac_consolidated'],
    });
  });

  it('groups copies whose fields differ to the better-ranked copy, at its rank', async () => {
    await svc.ingestDesignations(
      ofacPair('GRP-20', 'Divergent Copy Holding', {
        sdn: { primaryName: 'Divergent Copy Holding Group', designationDate: '2022-02-24' },
        consolidated: { designationDate: '2014-09-12' },
      }),
    );
    // The SDN copy's only name holds every token (strong); the Consolidated copy's equals the query (exact).
    const res = await screen('Divergent Copy Holding');
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({
      designationId: 'ofac_consolidated:GRP-20',
      source: 'ofac_consolidated',
      matchType: 'exact',
      matchedName: 'Divergent Copy Holding',
      designationDate: '2014-09-12',
      sources: ['ofac_sdn', 'ofac_consolidated'],
    });
  });

  it('pages grouped hits disjointly, never splitting a pair across pages', async () => {
    const whole = await screen('Grouped Petroleum');
    const walked: string[] = [];
    for (let offset = 0; offset < whole.totalAvailable + 1; offset += 1) {
      const page = await screen('Grouped Petroleum', { limit: 1, offset });
      expect(page.totalAvailable).toBe(4);
      walked.push(...ids(page.hits));
    }
    expect(walked).toEqual(ids(whole.hits));
  });

  it('groups the copies a fuzzy pass admits', async () => {
    const res = await screen('Grouped Petrolium Holding', { matchMode: 'fuzzy' });
    const ofac = res.hits.filter((hit) => hit.sourceEntryId === 'GRP-17' && hit.source !== 'eu');
    expect(ofac.map((hit) => [hit.designationId, hit.sources])).toEqual([
      ['ofac_sdn:GRP-17', ['ofac_sdn', 'ofac_consolidated']],
    ]);
  });

  it('looks an identifier both copies publish up as one hit naming both lists', async () => {
    const lookUp = (sources: SourceCode[]) =>
      svc.screenIdentifier({ value: '7706999990', type: 'any', sources });
    expect((await lookUp([...SOURCE_CODES])).map((hit) => [hit.source, hit.sources])).toEqual([
      ['ofac_sdn', ['ofac_sdn', 'ofac_consolidated']],
    ]);
    expect((await lookUp(['ofac_consolidated'])).map((hit) => [hit.source, hit.sources])).toEqual([
      ['ofac_consolidated', ['ofac_consolidated']],
    ]);
  });

  it('names both OFAC lists on a hit whose screen reached one record of the party', async () => {
    await svc.ingestDesignations([
      // A strict hit on ofac_sdn, so the completion searches ofac_consolidated and not ofac_sdn.
      listed('ofac_sdn', 'GPN-AERO', 'Gazpromneft Aero Joint Stock Company', 'organization'),
      ...ofacPair('GPN-1', 'Public Joint Stock Company Gazprom Neft'),
    ]);
    const res = await screen('Gazpromneft Joint Stock Company');
    expect(res.hits.map((hit) => [hit.designationId, hit.matchType, hit.sources])).toEqual([
      ['ofac_sdn:GPN-AERO', 'strong', ['ofac_sdn']],
      ['ofac_consolidated:GPN-1', 'approximate', ['ofac_sdn', 'ofac_consolidated']],
    ]);
    const unselected = await screen('Gazpromneft Joint Stock Company', {
      sources: ['ofac_consolidated', 'eu'],
    });
    expect(unselected.hits.map((hit) => [hit.designationId, hit.sources])).toEqual([
      ['ofac_consolidated:GPN-1', ['ofac_consolidated']],
    ]);
  });

  it('names both OFAC lists on an identifier one record of the party publishes', async () => {
    await svc.ingestDesignations(
      ofacPair('GRP-21', 'Diverging Identifier Holding', { sdn: withIdentifier('7706999991') }),
    );
    const lookUp = (sources: SourceCode[]) =>
      svc.screenIdentifier({ value: '7706999991', type: 'any', sources });
    expect((await lookUp([...SOURCE_CODES])).map((hit) => [hit.source, hit.sources])).toEqual([
      ['ofac_sdn', ['ofac_sdn', 'ofac_consolidated']],
    ]);
    expect((await lookUp(['ofac_sdn', 'eu'])).map((hit) => [hit.source, hit.sources])).toEqual([
      ['ofac_sdn', ['ofac_sdn']],
    ]);
  });
});

describe('per-list strict→fuzzy completion (issue #59)', () => {
  beforeEach(async () => {
    await svc.ingestDesignations([
      // Strict for "Vladimir Poutine": every query token present.
      listed('eu', 'POU-1', 'Vladimir Vladimirovich POUTINE'),
      // A spelling variant on two other lists: both query tokens covered (poutine ~ putin).
      listed('ofac_sdn', 'PUT-1', 'Putin Vladimir Vladimirovich'),
      listed('uk', 'PUT-UK', 'Vladimir Vladimirovich PUTIN'),
      // Shares one query token only: a full fuzzy pass admits it, a completion never does.
      listed('ofac_sdn', 'ZHI-1', 'Vladimir Zhirinovsky'),
    ]);
  });

  const screen = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, query, ...extra }, ctx);
  const ids = (hits: readonly { designationId: string }[]) => hits.map((hit) => hit.designationId);
  const fuzzyLookups = async (run: () => Promise<unknown>) =>
    indexPrefixes(await svc.designations.raw(), run);

  it('runs no fuzzy pass when every selected list has a strict hit (characterization)', async () => {
    let res: Awaited<ReturnType<typeof screen>> | undefined;
    const prefixes = await fuzzyLookups(async () => {
      res = await screen('Vladimir Vladimirovich', { sources: ['eu', 'uk'] });
    });
    expect(prefixes).toEqual([]);
    expect(res).toMatchObject({ modeUsed: 'strict', totalAvailableBasis: 'exact' });
    expect(ids(res?.hits ?? [])).toEqual(['eu:POU-1', 'uk:PUT-UK']);
    expect(res?.fuzzySources).toBeUndefined();
  });

  it('runs no completion for a screen with autoFallback off (characterization)', async () => {
    const res = await screen('Vladimir Poutine', { autoFallback: false });
    expect(ids(res.hits)).toEqual(['eu:POU-1']);
    expect(res).toMatchObject({ modeUsed: 'strict', totalAvailableBasis: 'exact' });
    expect(res.fuzzySources).toBeUndefined();
  });

  it('completes the strict-empty lists with candidates covering every query token, after the strict hits', async () => {
    const res = await screen('Vladimir Poutine');
    expect(ids(res.hits)).toEqual(['eu:POU-1', 'ofac_sdn:PUT-1', 'uk:PUT-UK']);
    expect(res.hits.map((hit) => hit.matchType)).toEqual(['strong', 'approximate', 'approximate']);
    for (const hit of res.hits.slice(1)) {
      expect(hit.queryTokenCoverage).toEqual({ covered: 2, total: 2 });
    }
    expect(res).toMatchObject({
      modeUsed: 'strict',
      fuzzySources: ['ofac_sdn', 'ofac_consolidated', 'uk', 'un'],
      totalAvailable: 3,
      totalAvailableBasis: 'lower_bound',
      fuzzyFallbackTriggered: false,
    });
  });

  it('never removes a full-coverage candidate when another list joins the selection', async () => {
    const alone = await screen('Vladimir Poutine', { sources: ['ofac_sdn'] });
    expect(ids(alone.hits)).toContain('ofac_sdn:PUT-1');
    const joined = await screen('Vladimir Poutine', { sources: ['ofac_sdn', 'eu'] });
    expect(ids(joined.hits)).toEqual(['eu:POU-1', 'ofac_sdn:PUT-1']);
    expect(joined.fuzzySources).toEqual(['ofac_sdn']);
  });

  it('requires every distinctive query word of a completion candidate, never a stoplisted one', async () => {
    await svc.ingestDesignations([
      listed('eu', 'STP-1', 'Zelvan Rostok Marinsk LLC', 'organization'),
      // Covers every word but the stoplisted LLC.
      listed('ofac_sdn', 'STP-2', 'Zelvann Rostock Marinska', 'organization'),
      // Covers two of three distinctive words: the fuzzy gate's half, not the completion's whole.
      listed('ofac_sdn', 'STP-3', 'Zelvann Rostock Shipping', 'organization'),
    ]);
    const completed = await screen('Zelvan Rostok Marinsk LLC');
    expect(ids(completed.hits)).toEqual(['eu:STP-1', 'ofac_sdn:STP-2']);
    const fuzzy = await screen('Zelvan Rostok Marinsk LLC', { matchMode: 'fuzzy' });
    expect(ids(fuzzy.hits)).toContain('ofac_sdn:STP-3');
  });

  it('requires every token of a query made only of stoplisted words', async () => {
    await svc.ingestDesignations([
      listed('eu', 'LLC-1', 'Limited Liability Company', 'organization'),
      listed('ofac_sdn', 'LLC-2', 'Limitid Liability Compani', 'organization'),
      listed('ofac_sdn', 'LLC-3', 'Limited Liability Partnership', 'organization'),
    ]);
    const completed = await screen('Limited Liability Company');
    expect(ids(completed.hits)).toEqual(['eu:LLC-1', 'ofac_sdn:LLC-2']);
    const fuzzy = await screen('Limited Liability Company', { matchMode: 'fuzzy' });
    expect(ids(fuzzy.hits)).toContain('ofac_sdn:LLC-3');
  });

  it('falls back to a full fuzzy pass over every selected list when no list hits strict', async () => {
    const res = await screen('Vladimir Poutin');
    expect(ids(res.hits)).toEqual(
      expect.arrayContaining(['eu:POU-1', 'ofac_sdn:PUT-1', 'uk:PUT-UK', 'ofac_sdn:ZHI-1']),
    );
    expect(res).toMatchObject({
      modeUsed: 'fuzzy',
      fuzzyFallbackTriggered: true,
      fuzzySources: [...SOURCE_CODES],
      totalAvailableBasis: 'lower_bound',
    });
  });

  it('names every selected list as fuzzy-searched in explicit fuzzy mode', async () => {
    const res = await screen('Vladimir Poutine', { matchMode: 'fuzzy', sources: ['uk', 'eu'] });
    expect(res).toMatchObject({ modeUsed: 'fuzzy', fuzzySources: ['eu', 'uk'] });
    expect(ids(res.hits)).toEqual(['eu:POU-1', 'uk:PUT-UK']);
  });

  it('counts a grouped OFAC hit as a strict hit on both OFAC lists', async () => {
    await svc.ingestDesignations([
      listed('ofac_sdn', 'GRP-59', 'Vladimir Poutine Holding', 'organization'),
      listed('ofac_consolidated', 'GRP-59', 'Vladimir Poutine Holding', 'organization'),
    ]);
    const res = await screen('Vladimir Poutine');
    expect(res.fuzzySources).toEqual(['uk', 'un']);
    expect(ids(res.hits)).toEqual(['ofac_sdn:GRP-59', 'eu:POU-1', 'uk:PUT-UK']);
  });
});
