/**
 * @fileoverview Integration coverage for high-risk screening semantics over a
 * real temporary SQLite mirror: transliteration, name-shape noise, ranking,
 * score floors, cross-source duplicates, and same-source replacement.
 * @module tests/integration/matching-correctness.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScreeningService } from '@/services/screening/screening-service.js';
import type { NormalizedDesignation } from '@/services/screening/types.js';
import { SOURCE_CODES } from '@/services/screening/types.js';
import { freshService, type SeededService, seededService } from '../services/_helpers.js';

const matchingDesignations: NormalizedDesignation[] = [
  {
    id: 'ofac_sdn:TM-1001',
    source: 'ofac_sdn',
    sourceEntryId: 'TM-1001',
    entityType: 'person',
    primaryName: 'Aleksandr Nikolayevich Petrov',
    payload: {
      aliases: [
        { name: 'Alexander Nikolaevich Petrov', nameType: 'aka' },
        { name: 'A. N. Petrov', nameType: 'aka' },
      ],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  },
  {
    id: 'un:TM-1002',
    source: 'un',
    sourceEntryId: 'TM-1002',
    entityType: 'person',
    primaryName: 'Muhammad Abdallah Al-Qadir',
    payload: {
      aliases: [{ name: 'Mohammed Abdullah al Kader', nameType: 'aka' }],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  },
  {
    id: 'eu:TM-1003',
    source: 'eu',
    sourceEntryId: 'TM-1003',
    entityType: 'person',
    primaryName: "Dr. José María O'Neill-Santos",
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  },
  {
    id: 'uk:TM-1004',
    source: 'uk',
    sourceEntryId: 'TM-1004',
    entityType: 'organization',
    primaryName: 'Atlas Handel GmbH',
    payload: {
      aliases: [{ name: 'Atlas-Handel Gesellschaft', nameType: 'aka' }],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  },
  {
    id: 'ofac_consolidated:TM-1005',
    source: 'ofac_consolidated',
    sourceEntryId: 'TM-1005',
    entityType: 'person',
    primaryName: 'Giorgi Ivanov',
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  },
  // TM-1006 sorts lexicographically before TM-1007, so the terminal designation-id
  // tie-break puts the WEAKER candidate first whenever the two tie on score.
  {
    id: 'ofac_sdn:TM-1006',
    source: 'ofac_sdn',
    sourceEntryId: 'TM-1006',
    entityType: 'person',
    primaryName: 'Nicolas Maduro Guerra',
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  },
  {
    id: 'ofac_sdn:TM-1007',
    source: 'ofac_sdn',
    sourceEntryId: 'TM-1007',
    entityType: 'person',
    primaryName: 'MADURO MOROS Nicolas',
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  },
];

const defaults = {
  entityType: 'any' as const,
  matchMode: 'strict' as const,
  sources: [...SOURCE_CODES],
  limit: 25,
};

describe('screenName name-shape correctness', () => {
  let seeded: SeededService;
  let service: ScreeningService;

  beforeEach(async () => {
    seeded = await seededService();
    service = seeded.service;
    await service.ingestDesignations(matchingDesignations);
    await service.markSanctionsReady(matchingDesignations.length);
  });

  afterEach(async () => {
    await seeded.cleanup();
  });

  it.each([
    ['Aleksander Nikolayevich Petrov', 'TM-1001'],
    ['Jose Maria ONeill Santos', 'TM-1003'],
    ['Atlas Handel LLC', 'TM-1004'],
    ['Atlas Handel Ltd', 'TM-1004'],
    ['Atlas Handel OAO', 'TM-1004'],
  ])('matches the fuzzy variant %j above the configured floor', async (query, entryId) => {
    const result = await service.screenName(
      { ...defaults, query, matchMode: 'fuzzy' },
      createMockContext(),
    );
    const hit = result.hits.find((candidate) => candidate.sourceEntryId === entryId);
    expect(hit?.matchType).toBe('approximate');
    expect(hit?.score).toBeGreaterThanOrEqual(0.85);
    expect(result.hits.findIndex((candidate) => candidate.sourceEntryId === entryId)).toBe(0);
  });

  it('matches an Arabic romanization variant above the configured floor', async () => {
    const result = await service.screenName(
      { ...defaults, query: 'Mohamad Abdulla Al Qadir', matchMode: 'fuzzy' },
      createMockContext(),
    );
    const hit = result.hits.find((candidate) => candidate.sourceEntryId === 'TM-1002');
    expect(hit?.matchType).toBe('approximate');
    expect(hit?.score).toBeGreaterThanOrEqual(0.85);
  });

  it.each([
    ['Petrov Aleksandr', 'strong'],
    ['Aleksandr Petrov', 'strong'],
    ['Jose Maria O Neill Santos', 'strong'],
    ['Atlas Handel', 'strong'],
    ["Dr. José María O'Neill-Santos", 'exact'],
  ] as const)(
    'treats order, patronymic, title, punctuation, and suffix noise: %j',
    async (query, kind) => {
      const result = await service.screenName({ ...defaults, query }, createMockContext());
      expect(result.hits[0]?.matchType).toBe(kind);
    },
  );

  it('matches initials through a published alias without outranking a full exact name', async () => {
    const initials = await service.screenName(
      { ...defaults, query: 'A N Petrov' },
      createMockContext(),
    );
    expect(initials.hits[0]).toMatchObject({
      sourceEntryId: 'TM-1001',
      matchedName: 'A. N. Petrov',
      matchedNameType: 'aka',
      matchType: 'exact',
    });

    const full = await service.screenName(
      { ...defaults, query: 'Aleksandr Nikolayevich Petrov', matchMode: 'fuzzy' },
      createMockContext(),
    );
    expect(full.hits[0]).toMatchObject({ sourceEntryId: 'TM-1001', matchType: 'exact' });
  });

  it('admits a close spelling while rejecting a genuinely different name', async () => {
    const result = await service.screenName(
      { ...defaults, query: 'Aleksander Petrov', matchMode: 'fuzzy' },
      createMockContext(),
    );
    expect(
      result.hits.find((hit) => hit.sourceEntryId === 'TM-1001')?.score,
    ).toBeGreaterThanOrEqual(0.85);
    expect(result.hits.find((hit) => hit.sourceEntryId === 'TM-1005')).toBeUndefined();

    const approximateScores = result.hits
      .filter((hit) => hit.matchType === 'approximate')
      .map((hit) => hit.score ?? 0);
    expect(approximateScores).toEqual([...approximateScores].sort((a, b) => b - a));
  });

  // Both candidates share an exact query token, so both surface score 1.0. Rank —
  // not score — is what separates them: the candidate covering all three query
  // tokens outranks the one covering two.
  it('ranks the full transliteration match above a weaker two-token candidate', async () => {
    const result = await service.screenName(
      { ...defaults, query: 'Nikolas Maduro Moros', matchMode: 'fuzzy' },
      createMockContext(),
    );
    const intendedRank = result.hits.findIndex((hit) => hit.sourceEntryId === 'TM-1007');
    const weakerRank = result.hits.findIndex((hit) => hit.sourceEntryId === 'TM-1006');
    expect(intendedRank).toBe(0);
    expect(weakerRank).toBeGreaterThan(intendedRank);
  });

  it('ranks the Arabic full-name variant above a weaker shared-token fixture', async () => {
    const result = await service.screenName(
      { ...defaults, query: 'Mohamad Abdulla Al Qadir', matchMode: 'fuzzy' },
      createMockContext(),
    );
    const intendedRank = result.hits.findIndex((hit) => hit.sourceEntryId === 'TM-1002');
    const weakerRank = result.hits.findIndex((hit) => hit.sourceEntryId === 'FX-6006');
    expect(intendedRank).toBe(0);
    expect(weakerRank).toBeGreaterThan(intendedRank);
  });

  it('separates the tied candidates by coverage while leaving both scores raw', async () => {
    // The doctrine constraint: coverage orders the hits, it is never folded into
    // `score`. Both candidates keep the raw Jaro-Winkler 1.0 their shared exact
    // token earns — the ranking rationale lives in its own field.
    const result = await service.screenName(
      { ...defaults, query: 'Nikolas Maduro Moros', matchMode: 'fuzzy' },
      createMockContext(),
    );
    const intended = result.hits.find((hit) => hit.sourceEntryId === 'TM-1007');
    const weaker = result.hits.find((hit) => hit.sourceEntryId === 'TM-1006');
    expect(intended?.score).toBe(1);
    expect(weaker?.score).toBe(1);
    expect(intended?.queryTokenCoverage).toEqual({ covered: 3, total: 3 });
    expect(weaker?.queryTokenCoverage).toEqual({ covered: 2, total: 3 });
  });

  it('orders every approximate hit by score, then by coverage, then by designation id', async () => {
    const result = await service.screenName(
      { ...defaults, query: 'Nikolas Maduro Moros', matchMode: 'fuzzy' },
      createMockContext(),
    );
    const keys: RankKey[] = result.hits
      .filter((hit) => hit.matchType === 'approximate')
      .map((hit) => [
        -(hit.score ?? 0),
        -(hit.queryTokenCoverage?.covered ?? 0),
        hit.designationId,
      ]);
    expect(keys).toEqual([...keys].sort(compareRankKeys));
  });
});

/** One hit's ranking key, ascending: negated score, negated coverage, designation id. */
type RankKey = [number, number, string];

const compareRankKeys = (a: RankKey, b: RankKey): number =>
  a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);

describe('designation merge and deduplication', () => {
  let standalone: SeededService;

  afterEach(async () => {
    await standalone.cleanup();
  });

  it('replaces one source ID while retaining the same entity from another list', async () => {
    standalone = await freshService();
    const shared = (source: 'eu' | 'ofac_sdn', alias: string): NormalizedDesignation => ({
      id: `${source}:DUP-1`,
      source,
      sourceEntryId: 'DUP-1',
      entityType: 'organization',
      primaryName: 'Shared Meridian Holdings',
      program: source === 'eu' ? 'EU-REGIME' : 'OFAC-PROGRAM',
      payload: {
        aliases: [{ name: alias, nameType: 'aka' }],
        identifiers: [],
        addresses: [{ full: `${source} published address` }],
        datesOfBirth: [],
        nationalities: [],
      },
    });

    await standalone.service.ingestDesignations([
      shared('eu', 'Old Meridian Alias'),
      shared('ofac_sdn', 'OFAC Meridian Alias'),
    ]);
    await standalone.service.ingestDesignations([shared('eu', 'Current Meridian Alias')]);
    await standalone.service.markSanctionsReady(2);

    const result = await standalone.service.screenName(
      { ...defaults, query: 'Shared Meridian Holdings' },
      createMockContext(),
    );
    expect(result.hits.filter((hit) => hit.sourceEntryId === 'DUP-1')).toHaveLength(2);
    expect(new Set(result.hits.map((hit) => hit.designationId)).size).toBe(2);

    const eu = await standalone.service.getDesignation('eu', 'DUP-1');
    expect(eu?.payload.aliases).toEqual([{ name: 'Current Meridian Alias', nameType: 'aka' }]);
    expect(eu?.payload.aliases).not.toContainEqual({ name: 'Old Meridian Alias', nameType: 'aka' });
    expect((await standalone.service.getDesignation('ofac_sdn', 'DUP-1'))?.program).toBe(
      'OFAC-PROGRAM',
    );
  });
});
