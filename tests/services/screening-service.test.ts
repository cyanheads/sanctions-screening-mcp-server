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
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Zzqxwv Nonexistent Qqpzm', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
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
    expect(counts.find((c) => c.code === 'ofac_sdn')?.recordCount).toBe(1);
    expect(await svc.sanctionsReady()).toBe(true);
    expect(await svc.leiReady()).toBe(true);
  });
});
