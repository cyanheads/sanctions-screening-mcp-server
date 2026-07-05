/**
 * @fileoverview Integration tests for the matching engine over a seeded
 * synthetic-fixture mirror: exact / strong / approximate classification,
 * Jaro-Winkler fuzzy fallback, phonetic transliteration hits, source + type
 * filters, LEI resolution, ownership traversal, and the empty-result contract.
 * @module tests/services/screening-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_CODES } from '@/services/screening/types.js';
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
    const res = await svc.screenName(
      { ...screenDefaults, query: PHONETIC_QUERY, matchMode: 'fuzzy', minScore: 0.99 },
      ctx,
    );
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
    const res = await svc.screenName(
      { ...screenDefaults, query: PHONETIC_QUERY, matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.hits.find((h) => h.sourceEntryId === 'FX-7007')).toBeUndefined();
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

describe('ingestLeiRelationships — batch semantics (issue #6)', () => {
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

  it('init insert-only path keeps a child whose relationships span a batch boundary', async () => {
    // The streaming golden-copy hazard: one child's relationships arrive in two
    // separate batches. clearLeiRelationships() wipes once up front, then each
    // batch is insert-only — so batch 2 must NOT delete batch 1's rows.
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([relA], { replaceByChild: false });
    await svc.ingestLeiRelationships([relB], { replaceByChild: false });
    const rels = await svc.getRelationships(CHILD, 'parents');
    expect(rels).toHaveLength(2);
    expect(new Set(rels.map((r) => r.parentLei))).toEqual(
      new Set([relA.parentLei, relB.parentLei]),
    );
  });

  it('delta replace-by-child (default) restates a child per call', async () => {
    // The delta path keeps replace-by-child semantics: a later call re-stating the
    // same child replaces its rows (correct only when a child's full set is one call).
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([relA]);
    await svc.ingestLeiRelationships([relB]);
    const rels = await svc.getRelationships(CHILD, 'parents');
    expect(rels).toHaveLength(1);
    expect(rels[0]?.parentLei).toBe(relB.parentLei);
  });

  it('clearLeiRelationships wipes the table', async () => {
    await svc.clearLeiRelationships();
    expect(await svc.getRelationships(CHILD, 'parents')).toHaveLength(0);
    expect((await svc.leiReadiness()).relationshipCount).toBe(0);
  });
});

describe('advanceLeiFreshnessIfReady — GLEIF delta freshness (issue #5)', () => {
  it('advances completedAt + total to the LIVE entity count on a ready mirror', async () => {
    const before = await svc.leiReadiness();
    expect(before.ready).toBe(true);
    expect(before.total).toBe(2); // seeded L1 entity count
    expect(before.completedAt).toBeDefined();

    // Simulate a delta apply: one new LEI entity ingested (batch size 1).
    await svc.ingestLeiEntities([
      { lei: '5493001KJTIIGC8Y1R99', legalName: 'Delta Added Co', otherNames: [] },
    ]);

    const result = await svc.advanceLeiFreshnessIfReady();
    expect(result.advanced).toBe(true);
    // total is the live mirror count (3), NEVER the delta batch size (1).
    expect(result.entityCount).toBe(3);

    const after = await svc.leiReadiness();
    expect(after.ready).toBe(true);
    expect(after.total).toBe(3);
    expect(after.completedAt).toBeDefined();
    expect(after.completedAt! >= before.completedAt!).toBe(true);
  });

  it('does NOT flip a never-initialized mirror to ready (delta on empty is not completion)', async () => {
    const fresh = await freshService();
    try {
      const svc2 = fresh.service;
      expect(await svc2.leiReady()).toBe(false);

      // A delta lands rows on a mirror that never completed an init.
      await svc2.ingestLeiEntities([
        { lei: '5493001KJTIIGC8Y1R12', legalName: 'Orphan Delta Co', otherNames: [] },
      ]);

      const result = await svc2.advanceLeiFreshnessIfReady();
      expect(result.advanced).toBe(false);
      expect(result.entityCount).toBe(1); // reports the live count but does not mark ready

      expect(await svc2.leiReady()).toBe(false); // still not ready — run mirror:init
      expect((await svc2.leiReadiness()).completedAt).toBeUndefined(); // freshness left unset
    } finally {
      await fresh.cleanup();
    }
  });
});
