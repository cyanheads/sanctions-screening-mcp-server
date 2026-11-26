/**
 * @fileoverview Integration coverage for high-risk screening semantics over a
 * real temporary SQLite mirror: transliteration, name-shape noise, ranking,
 * score floors, cross-source duplicates, and same-source replacement.
 * @module tests/integration/matching-correctness.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCREENING_CAVEAT } from '@/mcp-server/tools/definitions/_shared.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { parseUk, parseUn } from '@/services/screening/sanctions-ingest.js';
import type { ScreeningService } from '@/services/screening/screening-service.js';
import { tokenize } from '@/services/screening/text-matching.js';
import type { NormalizedDesignation, SourceCode } from '@/services/screening/types.js';
import { SOURCE_CODES } from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';
import {
  freshService,
  type SeededService,
  seededGlobalService,
  seededService,
} from '../services/_helpers.js';

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
    // `Mohammed Al-Testi` shares only `Mohammed` and the article `al` with the
    // query. It once ranked second at 2/4 coverage; an article no longer counts
    // toward admission (#55), so one shared word of three distinctive ones keeps it out.
    expect(weakerRank).toBe(-1);
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

  it('orders every approximate hit by score, then by coverage, then by words matched by sound, then by list and entry ID', async () => {
    const result = await service.screenName(
      { ...defaults, query: 'Nikolas Maduro Moros', matchMode: 'fuzzy' },
      createMockContext(),
    );
    const keys: RankKey[] = result.hits
      .filter((hit) => hit.matchType === 'approximate')
      .map((hit) => [
        -(hit.score ?? 0),
        -(hit.queryTokenCoverage?.covered ?? 0),
        hit.queryTokenCoverage?.phonetic ?? 0,
        hit.source,
        hit.sourceEntryId,
      ]);
    expect(keys).toEqual([...keys].sort(compareRankKeys));
  });
});

/**
 * One hit's ranking key, ascending: negated score, negated coverage, words
 * covered by sound alone, list, entry ID.
 */
type RankKey = [number, number, number, SourceCode, string];

const entryIdCollator = new Intl.Collator('en', { numeric: true });

/**
 * Score, coverage, and sound count, then identity: the list in `SOURCE_CODES` order, the entry
 * ID by numeric collation, then the entry ID by code units, which orders the
 * zero-padded variants numeric collation calls equal.
 */
const compareRankKeys = (a: RankKey, b: RankKey): number =>
  a[0] - b[0] ||
  a[1] - b[1] ||
  a[2] - b[2] ||
  SOURCE_CODES.indexOf(a[3]) - SOURCE_CODES.indexOf(b[3]) ||
  entryIdCollator.compare(a[4], b[4]) ||
  (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0);

/**
 * Nine designations under one name, spread over every list, with entry IDs whose
 * string order and numeric order disagree (`26079`/`2677`, `12`/`3`, `10`/`9`)
 * and a zero-padded pair that numeric collation calls equal (`RUS0251`/`RUS251`).
 * Every screen below ties them on match signal, so only identity orders them.
 */
const identityTies: NormalizedDesignation[] = (
  [
    ['un', '10'],
    ['uk', 'RUS251'],
    ['eu', '12'],
    ['ofac_sdn', '26079'],
    ['un', '9'],
    ['ofac_consolidated', '5'],
    ['uk', 'RUS0251'],
    ['eu', '3'],
    ['ofac_sdn', '2677'],
  ] as const
).map(
  ([source, sourceEntryId]): NormalizedDesignation => ({
    id: `${source}:${sourceEntryId}`,
    source,
    sourceEntryId,
    entityType: 'organization',
    primaryName: 'Lattice Probe Varnok',
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  }),
);

/** Lists in `SOURCE_CODES` order; entry IDs by numeric value, `RUS0251` before `RUS251`. */
const IDENTITY_ORDER = [
  'ofac_sdn:2677',
  'ofac_sdn:26079',
  'ofac_consolidated:5',
  'eu:3',
  'eu:12',
  'uk:RUS0251',
  'uk:RUS251',
  'un:9',
  'un:10',
];

describe('designation identity order for tied hits (issue #60)', () => {
  let standalone: SeededService;

  afterEach(async () => {
    await standalone.cleanup();
  });

  const ingest = async (designations: NormalizedDesignation[]): Promise<ScreeningService> => {
    standalone = await freshService();
    await standalone.service.ingestDesignations(designations);
    await standalone.service.markSanctionsReady(designations.length);
    return standalone.service;
  };

  it.each([
    ['as listed', identityTies],
    ['reversed', [...identityTies].reverse()],
  ])(
    'orders a strict tie by list, then entry ID by numeric value (stored %s)',
    async (_stored, designations) => {
      const service = await ingest(designations);
      const result = await service.screenName(
        { ...defaults, query: 'Lattice Probe Varnok' },
        createMockContext(),
      );
      expect(result.hits.map((hit) => hit.matchType)).toEqual(IDENTITY_ORDER.map(() => 'exact'));
      expect(result.hits.map((hit) => hit.designationId)).toEqual(IDENTITY_ORDER);
    },
  );

  it('orders a fuzzy tie on score and coverage by the same identity key', async () => {
    const service = await ingest(identityTies);
    const result = await service.screenName(
      { ...defaults, query: 'Latice Probe Varnok', matchMode: 'fuzzy' },
      createMockContext(),
    );
    const signals = result.hits.map((hit) => [
      hit.matchType,
      hit.score,
      hit.queryTokenCoverage?.covered,
    ]);
    expect(new Set(signals.map((signal) => JSON.stringify(signal))).size).toBe(1);
    expect(signals[0]?.[0]).toBe('approximate');
    expect(result.hits.map((hit) => hit.designationId)).toEqual(IDENTITY_ORDER);
  });

  it('walks disjoint strict pages that reassemble the identity order', async () => {
    const service = await ingest([...identityTies].reverse());
    const pages = await Promise.all(
      [0, 2, 4, 6, 8].map((offset) =>
        service.screenName(
          { ...defaults, query: 'Lattice Probe Varnok', limit: 2, offset },
          createMockContext(),
        ),
      ),
    );
    expect(pages.flatMap((page) => page.hits.map((hit) => hit.designationId))).toEqual(
      IDENTITY_ORDER,
    );
  });
});

describe('sanctions_screen_name identity order on both surfaces (issue #60)', () => {
  let harness: SeededService;

  afterEach(async () => {
    await harness.cleanup();
  });

  it('lists tied hits in the same identity order in structuredContent and content', async () => {
    harness = await seededGlobalService();
    await harness.service.ingestDesignations(identityTies);

    const result = await runToolContract(screenNameTool, { name: 'Lattice Probe Varnok' });
    expect(result.isError).toBeFalsy();
    const { hits } = result.structuredContent as {
      hits: { source: SourceCode; sourceEntryId: string }[];
    };
    expect(hits.map((hit) => `${hit.source}:${hit.sourceEntryId}`)).toEqual(IDENTITY_ORDER);

    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    const rendered = [...text.matchAll(/\(`([a-z_]+)`\) \| \*\*Entry ID:\*\* (\S+)/g)].map(
      ([, source, entryId]) => `${source}:${entryId}`,
    );
    expect(rendered).toEqual(IDENTITY_ORDER);
  });
});

describe('cross-script comparison on both tool surfaces', () => {
  let harness: SeededService;
  afterEach(async () => {
    await harness.cleanup();
  });

  it('pages published names with approximate scores and retains strict list completion and score floors', async () => {
    harness = await seededGlobalService();
    const native: NormalizedDesignation = {
      id: 'eu:CYRILLIC',
      source: 'eu',
      sourceEntryId: 'CYRILLIC',
      entityType: 'organization',
      primaryName: 'Совкомфлот',
      payload: { aliases: [], identifiers: [], addresses: [], datesOfBirth: [], nationalities: [] },
    };
    await harness.service.ingestDesignations([
      native,
      {
        ...native,
        id: 'uk:LATIN',
        source: 'uk',
        sourceEntryId: 'LATIN',
        primaryName: 'Sovcomflot',
      },
      { ...native, id: 'eu:SAME-LIST', sourceEntryId: 'SAME-LIST', primaryName: 'Sovcomflot' },
      {
        ...native,
        id: 'un:ALIAS',
        source: 'un',
        sourceEntryId: 'ALIAS',
        primaryName: 'Published Holding',
        payload: { ...native.payload, aliases: [{ name: 'Sovcomflot', nameType: 'fka' }] },
      },
    ]);
    const screen = (extra: Record<string, unknown> = {}) =>
      runToolContract(screenNameTool, {
        name: 'Совкомфлот',
        sources: ['eu', 'uk', 'un'],
        ...extra,
      });
    const completed = await screen();
    expect(completed.isError).toBeFalsy();
    const data = completed.structuredContent as {
      hits: {
        sourceEntryId: string;
        matchedName: string;
        matchedNameType: string;
        matchType: string;
        score?: number;
      }[];
      caveat: string;
    };
    expect(data.hits.map((hit) => hit.sourceEntryId)).toEqual(['CYRILLIC', 'LATIN', 'ALIAS']);
    expect(data.hits[0]?.matchType).toBe('exact');
    expect(data.hits[1]).toMatchObject({
      matchedName: 'Sovcomflot',
      matchType: 'approximate',
      score: 0.9533,
    });
    expect(data.hits[2]).toMatchObject({ matchedName: 'Sovcomflot', matchedNameType: 'fka' });
    expect(data.caveat).toBe(SCREENING_CAVEAT);
    const text = completed.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('**Matched on:** "Sovcomflot" (fka)');
    expect(text).toContain('approximate · score 0.9533 · covers 1/1 query tokens');
    expect(text).toContain(SCREENING_CAVEAT);

    const pages = [];
    for (const offset of [0, 1, 2, 3, 4]) {
      const page = await screen({ matchMode: 'fuzzy', limit: 1, offset });
      expect(page.isError).toBeFalsy();
      const content = page.structuredContent as typeof data;
      const rendered = page.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      for (const hit of content.hits)
        expect(rendered).toContain(`**Entry ID:** ${hit.sourceEntryId}`);
      expect(rendered).toContain(SCREENING_CAVEAT);
      pages.push(...content.hits.map((hit) => hit.sourceEntryId));
    }
    expect(pages).toEqual(['CYRILLIC', 'SAME-LIST', 'LATIN', 'ALIAS']);
    const high = await screen({ minScore: 0.99 });
    expect((high.structuredContent as typeof data).hits.map((hit) => hit.sourceEntryId)).toEqual([
      'CYRILLIC',
    ]);
    const empty = await screen({ name: 'Unrelated Qzqw' });
    expect((empty.structuredContent as typeof data).hits).toEqual([]);
    expect(empty.content.map((block) => ('text' in block ? block.text : '')).join('\n')).toContain(
      'NOT a clearance',
    );
    const invalid = await screen({ name: '---' });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({
      error: {
        code: -32602,
        data: {
          reason: 'name_not_searchable',
          recovery: { hint: expect.stringContaining('letter or digit') },
        },
      },
    });
  });
});

describe('legal-form spellings on both tool surfaces (issue #90)', () => {
  let harness: SeededService;
  afterEach(async () => {
    await harness.cleanup();
  });

  const organization = (id: string, primaryName: string): NormalizedDesignation => {
    const [source, sourceEntryId] = id.split(':') as [SourceCode, string];
    return {
      id,
      source,
      sourceEntryId,
      entityType: 'organization',
      primaryName,
      payload: { aliases: [], identifiers: [], addresses: [], datesOfBirth: [], nationalities: [] },
    };
  };
  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>): string =>
    result.content.map((block) => ('text' in block ? block.text : '')).join('\n');

  it('reports a name equal up to legal-form spelling as strong in structuredContent and content', async () => {
    harness = await seededGlobalService();
    await harness.service.ingestDesignations([
      organization('ofac_sdn:16830', 'STG HOLDINGS LIMITED'),
      organization('eu:SPEC-1', 'Limited Liability Company Spectrum'),
    ]);
    const result = await runToolContract(screenNameTool, {
      name: 'STG Holdings Ltd.',
      sources: ['ofac_sdn', 'eu'],
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      hits: { sourceEntryId: string; matchedName: string; matchType: string; score?: number }[];
    };
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0]).toMatchObject({
      sourceEntryId: '16830',
      matchedName: 'STG HOLDINGS LIMITED',
      matchType: 'strong',
    });
    expect(data.hits[0]?.score).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('### STG HOLDINGS LIMITED — strong\n');
    expect(text).toContain('**Matched on:** "STG HOLDINGS LIMITED" (primary)');
    expect(text).toContain(SCREENING_CAVEAT);

    // The same words under another form match nothing strict.
    const crossForm = await runToolContract(screenNameTool, {
      name: 'Spectrum Ltd',
      sources: ['eu'],
    });
    const crossHits = (crossForm.structuredContent as typeof data).hits;
    expect(crossHits.filter((hit) => hit.matchType !== 'approximate')).toEqual([]);
  });

  it('cross-references a GLEIF entity whose legal name differs only in legal-form spelling', async () => {
    harness = await seededGlobalService();
    await harness.service.ingestDesignations([
      organization('ofac_sdn:44269', 'BUOYANT HOLDINGS LIMITED'),
    ]);
    const lei = '2549009T6MXOLIE32077';
    await harness.service.ingestLeiEntities([
      {
        lei,
        legalName: 'BUOYANT HOLDINGS LTD.',
        otherNames: [],
        jurisdiction: 'KY',
        status: 'ISSUED',
      },
    ]);
    const result = await runToolContract(getEntityTool, { lei });
    expect(result.isError).toBeFalsy();
    const { sanctionsHits } = result.structuredContent as {
      sanctionsHits: { sourceEntryId: string; matchedName?: string; matchType?: string }[];
    };
    expect(sanctionsHits).toEqual([
      expect.objectContaining({
        sourceEntryId: '44269',
        matchedName: 'BUOYANT HOLDINGS LIMITED',
        matchType: 'strong',
      }),
    ]);
    expect(textOf(result)).toContain('matched "BUOYANT HOLDINGS LIMITED"');
  });
});

describe('sound-alike surnames on both tool surfaces (issue #92)', () => {
  let harness: SeededService;
  afterEach(async () => {
    await harness.cleanup();
  });

  const person = (id: string, primaryName: string): NormalizedDesignation => {
    const [source, sourceEntryId] = id.split(':') as [SourceCode, string];
    return {
      id,
      source,
      sourceEntryId,
      entityType: 'person',
      primaryName,
      payload: { aliases: [], identifiers: [], addresses: [], datesOfBirth: [], nationalities: [] },
    };
  };

  it('completes a strict hit with a sound-alike record and reports its sound count in structuredContent and content', async () => {
    harness = await seededGlobalService();
    await harness.service.ingestDesignations([
      person('ofac_sdn:12627', 'Hannibal Muammar GADDAFI'),
      person('un:690771', 'Hannibal Muammar Qadhafi'),
    ]);
    const result = await runToolContract(screenNameTool, {
      name: 'Hannibal Gaddafi',
      sources: ['ofac_sdn', 'un'],
    });
    expect(result.isError).toBeFalsy();
    const { hits } = result.structuredContent as {
      hits: {
        source: SourceCode;
        sourceEntryId: string;
        matchType: string;
        score?: number;
        queryTokenCoverage?: { covered: number; phonetic?: number; total: number };
      }[];
    };
    expect(
      hits.map((hit) => [hit.source, hit.sourceEntryId, hit.matchType, hit.queryTokenCoverage]),
    ).toEqual([
      ['ofac_sdn', '12627', 'strong', undefined],
      ['un', '690771', 'approximate', { covered: 2, total: 2, phonetic: 1 }],
    ]);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(
      '### Hannibal Muammar Qadhafi — approximate · score 1 · covers 2/2 query tokens (1 by sound)\n',
    );
    expect(text).toContain('### Hannibal Muammar GADDAFI — strong\n');
  });
});

describe('strict completion gives each query word a word of its own (issue #98)', () => {
  let harness: SeededService;
  afterEach(async () => {
    await harness.cleanup();
  });

  /** A published record: its primary name, then aliases, as the lists carry them. */
  const record = (
    id: string,
    entityType: NormalizedDesignation['entityType'],
    primaryName: string,
    aliases: string[] = [],
  ): NormalizedDesignation => {
    const [source, sourceEntryId] = id.split(':') as [SourceCode, string];
    return {
      id,
      source,
      sourceEntryId,
      entityType,
      primaryName,
      payload: {
        aliases: aliases.map((name) => ({ name, nameType: 'aka' as const })),
        identifiers: [],
        addresses: [],
        datesOfBirth: [],
        nationalities: [],
      },
    };
  };
  const WONG_YUNG_FAI = 'bis_el:17d40f9e1dad307fb1e50519fe8bef47d1b8172a65c4efc62ea2a0bb';
  const RECORDS = [
    record('ofac_sdn:52347', 'vessel', 'PING AN'),
    record('eu:178426', 'organization', 'Bank of Industry and Mine'),
    record('ofac_consolidated:18283', 'organization', 'SME BANK', [
      'JSC RUSSIAN BANK FOR SMALL AND MEDIUM ENTERPRISES SUPPORT',
    ]),
    record('eu:183321', 'organization', 'Banca Finservice S.A.', ['JSC “Bank Finservice”']),
    record('uk:INU0342', 'organization', 'BANCO INTERNACIONAL DE DESARROLLO CA', [
      'Banco Internacional De Desarrollo, C.A.',
    ]),
    record('ofac_sdn:39693', 'vessel', 'SAINT LIGHT', ['STELLAR ORACLE', 'YOUNG YONG']),
    record('eu:5597', 'person', 'RYOM Yong'),
    record('eu:6847', 'person', 'Yong Chol KIM', ['Young-chul KIM', 'Yong-Chol KIM']),
    record(WONG_YUNG_FAI, 'person', 'Wong Yung Fai'),
    record('ofac_sdn:24514', 'person', 'Qasim Naim', ['Qassem Naim', 'Kassem Naim']),
    record('eu:3361', 'person', 'Musa Hilal Abdalla ALNSIEM', ['Al Nasim', 'AlNasim']),
    record('uk:AQD0276', 'person', 'NESSIM BEN ROMDHANE SAHRAOUI', ['Nasim al-Sahrawi']),
    record('ofac_sdn:12627', 'person', 'GADDAFI Hannibal', ['QADHAFI Hannibal Muammar']),
    record('eu:6093', 'person', 'Hannibal Muammar QADHAFI'),
    record('uk:LIB0051', 'person', 'HANNIBAL MUAMMAR QADHAFI'),
    record('un:690771', 'person', 'HANNIBAL MUAMMAR QADHAFI'),
    record('ofac_sdn:12608', 'person', 'QADHAFI Saif al-Islam', ['GADDAFI Saif al-Islam']),
    record('eu:6097', 'person', 'Saif al-Islam QADHAFI'),
    record('uk:LIB0064', 'person', 'SAIF AL-ISLAM QADHAFI'),
    record('un:690778', 'person', 'SAIF AL-ISLAM QADHAFI'),
    record('eu:128875', 'organization', 'Kaniyat Militia', ['Brygada Kani', 'Brigade Kani']),
    record('ofac_sdn:29368', 'organization', 'Kaniyat militia', ['Kani Brigade']),
    record('uk:LIB0074', 'organization', 'al-Kaniyat', ['Kani Brigade']),
    record('eu:131805', 'person', 'Saleh Mesfer Saleh Al Shaer', ['Saleh Mosfer Saleh al Shaer']),
    record('uk:YEM0009', 'person', 'Saleh Mesfer Saleh Al Shaer', ['Saleh Mosfer Saleh al Shaer']),
    record('un:6908863', 'person', 'SALEH MESFER SALEH AL SHAER', ['Saleh Mosfer Saleh al Shaer']),
    record('ofac_sdn:31192', 'person', 'Alshaer Saleh Mesfer', ['Al-Shaer Salih Misfer']),
    record('eu:150199', 'organization', 'Alfa-Bank JSC', ['Альфа-Банк']),
    record('ofac_sdn:34682', 'organization', 'JOINT STOCK COMPANY ALFA-BANK', [
      'АКЦИОНЕРНОЕ ОБЩЕСТВО АЛЬФА-БАНК',
    ]),
    record('uk:BEL0166', 'organization', 'CJSC Alfa Bank Belarus', ['ЗАО Альфа-Банк']),
    record('uk:RUS1074', 'organization', 'Alfa-Bank JSC', ['Альфа-Банка']),
    record('uk:AQD0158', 'person', 'BOUBEKEUR BOULGHITI', ['Abou Bakr Al Djazairi']),
    record('uk:LIB0006', 'organization', 'Libyan Agricultural Bank', [
      'Al Masraf Al Zirae Agricultural Bank',
    ]),
  ];

  beforeEach(async () => {
    harness = await seededGlobalService();
    await harness.service.ingestDesignations(RECORDS);
  });

  /** One screen through the tool: each hit as `list:id matchType covered/total phonetic`, and the text. */
  const screen = async (name: string, matchMode: 'strict' | 'fuzzy' = 'strict') => {
    const result = await runToolContract(screenNameTool, { name, matchMode, limit: 100 });
    expect(result.isError).toBeFalsy();
    const { hits } = result.structuredContent as {
      hits: {
        source: SourceCode;
        sourceEntryId: string;
        matchType: string;
        queryTokenCoverage?: { covered: number; phonetic?: number; total: number };
      }[];
    };
    return {
      rows: hits.map(({ source, sourceEntryId, matchType, queryTokenCoverage: cov }) =>
        [
          `${source}:${sourceEntryId}`,
          matchType,
          cov && `${cov.covered}/${cov.total}`,
          cov?.phonetic,
        ]
          .filter((part) => part !== undefined)
          .join(' '),
      ),
      ids: hits.map((hit) => `${hit.source}:${hit.sourceEntryId}`),
      text: result.content.map((block) => ('text' in block ? block.text : '')).join('\n'),
    };
  };

  it('PING AN returns ofac_sdn 52347 alone', async () => {
    const { rows, text } = await screen('PING AN');
    expect(rows).toEqual(['ofac_sdn:52347 exact']);
    expect(text).not.toContain('Bank of Industry and Mine');
  });

  it('YOUNG YONG returns no record with one word covering both query words', async () => {
    const { rows, text } = await screen('YOUNG YONG');
    expect(rows).toEqual(['ofac_sdn:39693 exact', `${WONG_YUNG_FAI} approximate 2/2`]);
    expect(text).not.toContain('RYOM Yong');
    expect(text).not.toContain('Yong Chol KIM');
  });

  it('Naim Qasim returns no Al Nasim or Nasim al-Sahrawi', async () => {
    const { ids } = await screen('Naim Qasim');
    expect(ids).toEqual(['ofac_sdn:24514']);
  });

  it('Hannibal Gaddafi returns eu 6093, uk LIB0051, un 690771 at 2/2 with one word by sound', async () => {
    const { rows, text } = await screen('Hannibal Gaddafi');
    expect(rows).toEqual([
      'ofac_sdn:12627 strong',
      'eu:6093 approximate 2/2 1',
      'uk:LIB0051 approximate 2/2 1',
      'un:690771 approximate 2/2 1',
    ]);
    expect(text).toContain(
      '### Hannibal Muammar QADHAFI — approximate · score 1 · covers 2/2 query tokens (1 by sound)\n',
    );
  });

  it('Saif al-Islam Gaddafi returns eu 6097, uk LIB0064, un 690778 at 4/4 with one word by sound', async () => {
    const { rows } = await screen('Saif al-Islam Gaddafi');
    expect(rows).toEqual([
      'ofac_sdn:12608 strong',
      'eu:6097 approximate 4/4 1',
      'uk:LIB0064 approximate 4/4 1',
      'un:690778 approximate 4/4 1',
    ]);
  });

  it('Brygada Kani returns Kani Brigade on ofac_sdn 29368 and uk LIB0074 (0.8476 by sound)', async () => {
    const { rows } = await screen('Brygada Kani');
    expect(rows).toEqual([
      'eu:128875 exact',
      'ofac_sdn:29368 approximate 2/2 1',
      'uk:LIB0074 approximate 2/2 1',
    ]);
  });

  it('Saleh Mosfer Saleh al Shaer still returns ofac_sdn 31192', async () => {
    const { rows } = await screen('Saleh Mosfer Saleh al Shaer');
    expect(rows).toEqual([
      'eu:131805 exact',
      'uk:YEM0009 exact',
      'un:6908863 exact',
      'ofac_sdn:31192 approximate 5/5',
    ]);
  });

  it('Saleh Mosfer Saleh al Shaer gives its repeated saleh one name word: no Saleh Saleh Mosfer', async () => {
    // Synthetic: `saleh` twice and `mosfer`, but no `shaer`.
    await harness.service.ingestDesignations([
      record('ofac_sdn:SYN-98', 'person', 'Saleh Saleh Mosfer'),
    ]);
    const { rows, text } = await screen('Saleh Mosfer Saleh al Shaer');
    expect(rows).toEqual([
      'eu:131805 exact',
      'uk:YEM0009 exact',
      'un:6908863 exact',
      'ofac_sdn:31192 approximate 5/5',
    ]);
    expect(text).not.toContain('Saleh Saleh Mosfer');
  });

  it('Альфа-Банк returns no uk AQD0158 or LIB0006, and still uk RUS1074 and BEL0166', async () => {
    const { ids, text } = await screen('Альфа-Банк');
    expect(ids).toEqual(['eu:150199', 'ofac_sdn:34682', 'uk:BEL0166', 'uk:RUS1074']);
    expect(text).not.toContain('Abou Bakr Al Djazairi');
    expect(text).not.toContain('Al Masraf Al Zirae Agricultural Bank');
  });

  it('PING AN in fuzzy mode returns the bank names it returned before (characterization)', async () => {
    const { rows } = await screen('PING AN', 'fuzzy');
    expect(rows).toEqual(
      expect.arrayContaining([
        'ofac_sdn:52347 exact',
        'eu:178426 approximate 2/2 1',
        'eu:183321 approximate 2/2 1',
        'uk:INU0342 approximate 2/2 1',
        'ofac_consolidated:18283 approximate 2/2 1',
      ]),
    );
  });
});

describe('public-company spellings of PLC on both tool surfaces (issue #101)', () => {
  let harness: SeededService;
  afterEach(async () => {
    await harness.cleanup();
  });

  /** A published organization record: its primary name, then aliases, as the lists carry them. */
  const record = (
    id: string,
    primaryName: string,
    aliases: string[] = [],
  ): NormalizedDesignation => {
    const [source, sourceEntryId] = id.split(':') as [SourceCode, string];
    return {
      id,
      source,
      sourceEntryId,
      entityType: 'organization',
      primaryName,
      payload: {
        aliases: aliases.map((name) => ({ name, nameType: 'aka' as const })),
        identifiers: [],
        addresses: [],
        datesOfBirth: [],
        nationalities: [],
      },
    };
  };
  const MEHL = 'a90c8b8a90682c265b5f4fd4da267ace4ad1cb81adc2eb0fdf739c0a';
  const RECORDS = [
    record('ofac_sdn:58644', 'MERITWISE GROUP PUBLIC LTD'),
    record('ofac_sdn:31517', 'Myanma Economic Holdings Public Company Limited', [
      'Myanmar Economic Holding Limited',
      'MEHL',
    ]),
    record(
      'ofac_sdn:50005',
      'Scientific Research Institute for Optoelectronic Instrument Engineering',
      [
        'Public Limited Company Scientific Research Institute For Optoelectronic Instrument Engineering',
        'AO NII OEP',
      ],
    ),
    record('eu:129450', 'Myanmar  Economic  Holdings  Public  Company  Ltd'),
    record('eu:179619', 'Evraz PLC', ['Evraz Nyrt.']),
    record('uk:GHR0080', 'Myanmar Economic Holdings Public Company Ltd', [
      'MEHL',
      'Myanmar Economic Holdings Limited',
    ]),
    record('uk:RUS1027', 'Evraz PLC', ['Евраз']),
    record(`bis_el:${MEHL}`, 'Myanmar Economic Holdings Limited', [
      'MEHL',
      'Myanma Economic Holdings Limited',
      'Myanma Economic Holdings Public Company Limited',
      'Myanmar Business Holdings Public Company Limited',
      'Myanmar Economic Holdings Public Company Limited',
      'UMEH',
      'Union of Myanmar Economic Holdings Company Limited',
      'Union of Myanmar Economic Holdings Limited.',
    ]),
  ];

  beforeEach(async () => {
    harness = await seededGlobalService();
    await harness.service.ingestDesignations(RECORDS);
  });

  /** One screen through the tool: its strict hits as `list:id matchType "matched name"`, and the text. */
  const screen = async (name: string) => {
    const result = await runToolContract(screenNameTool, { name, limit: 100 });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      hits: { source: SourceCode; sourceEntryId: string; matchType: string; matchedName: string }[];
      matchModeUsed: string;
      normalizedQuery: string;
    };
    return {
      ...structured,
      strict: structured.hits
        .filter((hit) => hit.matchType !== 'approximate')
        .map((hit) => `${hit.source}:${hit.sourceEntryId} ${hit.matchType} "${hit.matchedName}"`),
      text: result.content.map((block) => ('text' in block ? block.text : '')).join('\n'),
    };
  };

  it('Meritwise Group PLC returns ofac_sdn 58644 as strong', async () => {
    const { strict, matchModeUsed, text } = await screen('Meritwise Group PLC');
    expect(strict).toEqual(['ofac_sdn:58644 strong "MERITWISE GROUP PUBLIC LTD"']);
    expect(matchModeUsed).toBe('strict');
    expect(text).toContain('### MERITWISE GROUP PUBLIC LTD — strong\n');
  });

  it('Myanmar Economic Holdings PLC returns eu 129450, uk GHR0080 and bis_el MEHL as strong', async () => {
    const { strict, text } = await screen('Myanmar Economic Holdings PLC');
    expect(strict).toEqual([
      'eu:129450 strong "Myanmar  Economic  Holdings  Public  Company  Ltd"',
      'uk:GHR0080 strong "Myanmar Economic Holdings Public Company Ltd"',
      `bis_el:${MEHL} strong "Myanmar Economic Holdings Public Company Limited"`,
    ]);
    expect(text).toContain('### Myanmar Economic Holdings Public Company Ltd — strong\n');
    expect(text).toContain(
      '**Matched on:** "Myanmar Economic Holdings Public Company Limited" (aka)',
    );
  });

  it('Evraz Public Ltd returns eu 179619 and uk RUS1027 as strong', async () => {
    const { strict, text } = await screen('Evraz Public Ltd');
    expect(strict).toEqual(['eu:179619 strong "Evraz PLC"', 'uk:RUS1027 strong "Evraz PLC"']);
    expect(text).toContain('### Evraz PLC — strong\n');
  });

  it('Myanma Economic Holdings Ltd still returns ofac_sdn 31517 as strong', async () => {
    const { strict, text } = await screen('Myanma Economic Holdings Ltd');
    expect(strict).toEqual([
      'ofac_sdn:31517 strong "Myanma Economic Holdings Public Company Limited"',
      `bis_el:${MEHL} strong "Myanma Economic Holdings Limited"`,
    ]);
    expect(text).toContain('### Myanma Economic Holdings Public Company Limited — strong\n');
  });

  it('Myanmar Economic Holdings Company Limited still returns eu 129450 and uk GHR0080 as strong', async () => {
    const { strict } = await screen('Myanmar Economic Holdings Company Limited');
    expect(strict).toEqual([
      'eu:129450 strong "Myanmar  Economic  Holdings  Public  Company  Ltd"',
      'uk:GHR0080 strong "Myanmar Economic Holdings Public Company Ltd"',
      `bis_el:${MEHL} strong "Myanmar Economic Holdings Public Company Limited"`,
    ]);
  });

  it('Myanma Economic Holdings Public Company Limited Ltd still returns ofac_sdn 31517 as strong', async () => {
    const { strict, matchModeUsed, text } = await screen(
      'Myanma Economic Holdings Public Company Limited Ltd',
    );
    expect(strict).toEqual([
      'ofac_sdn:31517 strong "Myanma Economic Holdings Public Company Limited"',
      `bis_el:${MEHL} strong "Myanma Economic Holdings Public Company Limited"`,
    ]);
    expect(matchModeUsed).toBe('strict');
    expect(text).toContain('### Myanma Economic Holdings Public Company Limited — strong\n');
    expect(text).toContain('### Myanmar Economic Holdings Limited — strong\n');
  });

  it('Meritwise Group Ltd still returns ofac_sdn 58644 as strong', async () => {
    const { strict } = await screen('Meritwise Group Ltd');
    expect(strict).toEqual(['ofac_sdn:58644 strong "MERITWISE GROUP PUBLIC LTD"']);
  });

  it('Scientific Research Institute … Ltd does not return ofac_sdn 50005 as strong, and that alias still screens exact', async () => {
    const ltd = await screen(
      'Scientific Research Institute For Optoelectronic Instrument Engineering Ltd',
    );
    expect(ltd.strict).toEqual([]);
    expect(ltd.text).not.toContain('— strong');
    const alias = await screen(
      'Public Limited Company Scientific Research Institute For Optoelectronic Instrument Engineering',
    );
    expect(alias.strict).toEqual([
      'ofac_sdn:50005 exact "Public Limited Company Scientific Research Institute For Optoelectronic Instrument Engineering"',
    ]);
    expect(alias.text).toContain(
      '### Scientific Research Institute for Optoelectronic Instrument Engineering — exact\n',
    );
  });

  it('leaves normalizedQuery and exact as they were', async () => {
    const plc = await screen('Meritwise Group PLC');
    expect(plc.normalizedQuery).toBe('meritwise group plc');
    expect(plc.text).toContain('meritwise group plc');
    const own = await screen('MERITWISE GROUP PUBLIC LTD');
    expect(own.normalizedQuery).toBe('meritwise group public ltd');
    expect(own.strict).toEqual(['ofac_sdn:58644 exact "MERITWISE GROUP PUBLIC LTD"']);
  });

  it('leaves GLEIF resolution as it was: a PLC query never resolves a public-company name strictly', async () => {
    const lei = '2549001MERITWISE0001';
    await harness.service.ingestLeiEntities([
      {
        lei,
        legalName: 'MERITWISE GROUP PUBLIC LTD',
        otherNames: [],
        jurisdiction: 'GB',
        status: 'ISSUED',
      },
    ]);
    const result = await runToolContract(resolveEntityTool, { name: 'Meritwise Group PLC' });
    expect(result.isError).toBeFalsy();
    const { matches, matchModeUsed } = result.structuredContent as {
      matches: { lei: string; matchType: string }[];
      matchModeUsed: string;
    };
    expect(matchModeUsed).toBe('fuzzy');
    expect(matches.filter((match) => match.lei === lei).map((match) => match.matchType)).toEqual([
      'approximate',
    ]);
  });
});

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

// ─── Native-script names (issue #20) ────────────────────────────────────────────

const nativeScriptDesignation = (
  id: string,
  primaryName: string,
  aliases: string[],
): NormalizedDesignation => {
  const [source, sourceEntryId] = id.split(':') as [NormalizedDesignation['source'], string];
  return {
    id,
    source,
    sourceEntryId,
    entityType: 'organization',
    primaryName,
    payload: {
      aliases: aliases.map((name) => ({ name, nameType: 'aka' as const })),
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  };
};

const nativeScriptDesignations: NormalizedDesignation[] = [
  nativeScriptDesignation('eu:514', 'عبد المنان آغا', ['Abdul Manan Agha']),
  nativeScriptDesignation('eu:327', 'Comité de soutien afghan', ['Αφγανική Επιτροπή Στήριξης']),
  nativeScriptDesignation('ofac_sdn:16819', 'WANG, Guoying', ['王 国英']),
  nativeScriptDesignation('ofac_sdn:22986', 'Hwaryo Bank', ['화려은행']),
  // Each of the next three carries a Latin homoglyph or digit run inside another
  // script: a Latin `i` in `Валерiївна`, Latin `OOO`, and `2021`.
  nativeScriptDesignation('eu:118627', 'Ольга Валерiївна ПОЗДНЯКОВА', []),
  nativeScriptDesignation('eu:129952', 'OOO «Ромашка»', []),
  nativeScriptDesignation('eu:130001', 'Интер Трейд 2021', []),
];

describe('native-script names (issue #20)', () => {
  let standalone: SeededService;

  beforeEach(async () => {
    standalone = await freshService();
    await standalone.service.ingestDesignations(nativeScriptDesignations);
    await standalone.service.markSanctionsReady(nativeScriptDesignations.length);
  });

  afterEach(async () => {
    await standalone.cleanup();
  });

  it.each([
    ['عبد المنان آغا', 'eu:514'],
    ['Αφγανική Επιτροπή Στήριξης', 'eu:327'],
    ['ΑΦΓΑΝΙΚΉ ΕΠΙΤΡΟΠΉ ΣΤΉΡΙΞΗΣ', 'eu:327'],
    ['王 国英', 'ofac_sdn:16819'],
    ['화려은행', 'ofac_sdn:22986'],
  ])('matches %j exactly on its published name', async (query, designationId) => {
    const result = await standalone.service.screenName({ ...defaults, query }, createMockContext());
    expect(result.normalizedQuery).not.toBe('');
    expect(result.modeUsed).toBe('strict');
    expect(result.hits[0]).toMatchObject({ designationId, matchType: 'exact' });
  });

  it('indexes every published name, primaries and aliases alike', async () => {
    const handle = await standalone.service.designations.raw();
    const published = nativeScriptDesignations.reduce(
      (n, d) => n + 1 + d.payload.aliases.length,
      0,
    );
    expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM name').get()?.n).toBe(
      published,
    );
  });

  it('splits every folded name into exactly its fold tokens in the FTS5 index', async () => {
    const handle = await standalone.service.designations.raw();
    handle.exec(
      `CREATE VIRTUAL TABLE temp.name_terms USING fts5vocab(main, 'name_fts', 'instance')`,
    );
    // `name_fts` holds the `normalized` column alone, which strict matching reads.
    const terms = handle.prepare<{ term: string }>(
      `SELECT term FROM temp.name_terms WHERE doc = ? AND col = 'normalized' ORDER BY "offset"`,
    );
    const indexed = handle
      .prepare<{ rowid: number; normalized: string }>('SELECT rowid, normalized FROM name')
      .all();
    expect(indexed).toHaveLength(11);
    for (const row of indexed) {
      expect(
        terms.all(row.rowid).map((t) => t.term),
        row.normalized,
      ).toEqual(tokenize(row.normalized));
    }
  });

  it.each(['i', 'ooo', '2021'])(
    'never reports %j as an exact match on a name whose other letters were erased',
    async (query) => {
      const result = await standalone.service.screenName(
        { ...defaults, query, autoFallback: false },
        createMockContext(),
      );
      expect(result.hits.filter((hit) => hit.matchType === 'exact')).toEqual([]);
    },
  );

  it('keys no homoglyph residue: a mixed-script name carries no phonetic key', async () => {
    const handle = await standalone.service.designations.raw();
    const row = handle
      .prepare<{ phonetic: string }>(`SELECT phonetic FROM name WHERE designation_id = 'eu:118627'`)
      .get();
    expect(row?.phonetic).toBe('');
  });

  it('runs a native-script fuzzy query as fuzzy', async () => {
    const result = await standalone.service.screenName(
      { ...defaults, query: 'Αφγανική Επιτροπή Στηριξης', matchMode: 'fuzzy' },
      createMockContext(),
    );
    expect(result.modeUsed).toBe('fuzzy');
    expect(result.normalizedQuery).toBe('αφγανικη επιτροπη στηριξησ');
    expect(result.hits.some((hit) => hit.designationId === 'eu:327')).toBe(true);
  });
});

// ─── UK and UN native-script names (issue #87) ──────────────────────────────────
//
// Parsed from published UK and UN record shapes, so the names under test are the
// ones the ingest reads. OFAC 47800 publishes the same Han name, typed primary.

const NATIVE_UK_SOURCE = `<Designations>
  <Designation><UniqueID>GAC0076</UniqueID><IndividualEntityShip>Individual</IndividualEntityShip>
    <Names><Name><Name1>Levan</Name1><Name6>Murusidze</Name6><NameType>Primary Name</NameType></Name></Names>
    <NonLatinNames><NonLatinName><NameNonLatinScript>ლევან მურუსიძე</NameNonLatinScript><NonLatinScriptType>Georgian</NonLatinScriptType></NonLatinName></NonLatinNames>
  </Designation>
  <Designation><UniqueID>GHR0179</UniqueID><IndividualEntityShip>Individual</IndividualEntityShip>
    <Names>
      <Name><Name1>Zhi</Name1><Name6>Chen</Name6><NameType>Primary Name</NameType></Name>
      <Name><Name6>Vincent</Name6><NameType>Alias</NameType></Name>
    </Names>
    <NonLatinNames>
      <NonLatinName><NameNonLatinScript>ចេន ហ្ស៊ី</NameNonLatinScript><NonLatinScriptType>Khmer</NonLatinScriptType></NonLatinName>
      <NonLatinName><NameNonLatinScript>陈志</NameNonLatinScript><NonLatinScriptType>Chinese</NonLatinScriptType></NonLatinName>
    </NonLatinNames>
  </Designation>
  <Designation><UniqueID>CYB0044</UniqueID><IndividualEntityShip>Entity</IndividualEntityShip>
    <Names><Name><Name6>WUHAN XIAORUIZHI SCIENCE AND TECHNOLOGY COMPANY LIMITED </Name6><NameType>Primary Name</NameType></Name></Names>
    <NonLatinNames><NonLatinName><NameNonLatinScript>武汉晓睿智科技有限责任公司</NameNonLatinScript></NonLatinName></NonLatinNames>
  </Designation>
  <Designation><UniqueID>AQD0007</UniqueID><IndividualEntityShip>Entity</IndividualEntityShip>
    <Names>
      <Name><Name6>AL MOULATHAMOUN</Name6><NameType>Primary name</NameType></Name>
      <Name><Name6>Les Enturbannes</Name6><NameType>Alias</NameType></Name>
    </Names>
    <NonLatinNames>
      <NonLatinName><NameNonLatinScript>الملثمون</NameNonLatinScript></NonLatinName>
      <NonLatinName><NameNonLatinScript>Les Enturbannés</NameNonLatinScript></NonLatinName>
    </NonLatinNames>
  </Designation>
</Designations>`;

const NATIVE_UN_SOURCE = `<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL>
  <DATAID>6908048</DATAID><FIRST_NAME>SADDAM</FIRST_NAME><SECOND_NAME>HUSSEIN</SECOND_NAME><THIRD_NAME>AL-TIKRITI</THIRD_NAME>
  <REFERENCE_NUMBER>IQi.001</REFERENCE_NUMBER><NAME_ORIGINAL_SCRIPT>صدام حسين التكريتي</NAME_ORIGINAL_SCRIPT>
  <INDIVIDUAL_ALIAS><QUALITY>Low</QUALITY><ALIAS_NAME>Abu Ali</ALIAS_NAME></INDIVIDUAL_ALIAS>
</INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>`;

const ofacWuhan: NormalizedDesignation = {
  id: 'ofac_sdn:47800',
  source: 'ofac_sdn',
  sourceEntryId: '47800',
  entityType: 'organization',
  primaryName: 'WUHAN XIAORUIZHI SCIENCE AND TECHNOLOGY COMPANY LIMITED',
  payload: {
    aliases: [{ name: '武汉晓睿智科技有限责任公司', nameType: 'primary' }],
    identifiers: [],
    addresses: [],
    datesOfBirth: [],
    nationalities: [],
  },
};

describe('UK and UN native-script names (issue #87)', () => {
  let harness: SeededService;
  const parsed = () => [
    ...parseUk(parseXml(NATIVE_UK_SOURCE)),
    ...parseUn(parseXml(NATIVE_UN_SOURCE)),
  ];

  beforeEach(async () => {
    harness = await seededGlobalService();
    await harness.service.ingestDesignations([...parsed(), ofacWuhan]);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const screen = (query: string, matchMode: 'strict' | 'fuzzy' = 'strict') =>
    harness.service.screenName({ ...defaults, query, matchMode }, createMockContext());

  it.each([
    ['ლევან მურუსიძე', ['uk:GAC0076'], 'aka'],
    ['ចេន ហ្ស៊ី', ['uk:GHR0179'], 'aka'],
    ['صدام حسين التكريتي', ['un:6908048'], 'primary'],
    ['武汉晓睿智科技有限责任公司', ['ofac_sdn:47800', 'uk:CYB0044'], undefined],
  ])('screens %j exactly onto the record that publishes it', async (query, ids, nameType) => {
    const result = await screen(query);
    expect(result.modeUsed).toBe('strict');
    expect(result.hits.map((hit) => hit.designationId).sort()).toEqual(ids);
    for (const hit of result.hits) {
      expect(hit).toMatchObject({ matchType: 'exact', matchedName: query });
      if (nameType) expect(hit.matchedNameType).toBe(nameType);
    }
  });

  it('indexes a name row for every published native-script name', async () => {
    const handle = await harness.service.designations.raw();
    const rows = handle
      .prepare<{ designation_id: string; name: string; name_type: string }>(
        `SELECT designation_id, name, name_type FROM name WHERE designation_id IN ('uk:GAC0076', 'uk:GHR0179', 'uk:CYB0044', 'uk:AQD0007', 'un:6908048') ORDER BY rowid`,
      )
      .all();
    expect(rows.filter((row) => row.designation_id === 'uk:GHR0179')).toEqual([
      { designation_id: 'uk:GHR0179', name: 'Zhi Chen', name_type: 'primary' },
      { designation_id: 'uk:GHR0179', name: 'Vincent', name_type: 'aka' },
      { designation_id: 'uk:GHR0179', name: 'ចេន ហ្ស៊ី', name_type: 'aka' },
      { designation_id: 'uk:GHR0179', name: '陈志', name_type: 'aka' },
    ]);
    expect(rows).toHaveLength(parsed().reduce((n, d) => n + 1 + d.payload.aliases.length, 0));
  });

  it('keeps the primary name and the Latin match of each record', async () => {
    expect((await harness.service.getDesignation('uk', 'GAC0076'))?.primaryName).toBe(
      'Levan Murusidze',
    );
    expect((await harness.service.getDesignation('un', '6908048'))?.primaryName).toBe(
      'SADDAM HUSSEIN AL-TIKRITI',
    );
    // The Names block's `Les Enturbannes` and the published `Les Enturbannés` fold
    // alike; the earlier row stays the match.
    for (const [query, matchedName] of [
      ['Les Enturbannés', 'Les Enturbannes'],
      ['Levan Murusidze', 'Levan Murusidze'],
      ['Saddam Hussein Al-Tikriti', 'SADDAM HUSSEIN AL-TIKRITI'],
    ] as const) {
      const [hit] = (await screen(query)).hits;
      expect(hit, query).toMatchObject({ matchType: 'exact', matchedName });
    }
    const fuzzy = await screen('Levan Murusidse', 'fuzzy');
    expect(fuzzy.hits.find((hit) => hit.designationId === 'uk:GAC0076')).toMatchObject({
      matchType: 'approximate',
      matchedName: 'Levan Murusidze',
    });
  });

  it('carries the native-script match on both tool surfaces', async () => {
    const result = await runToolContract(screenNameTool, { name: 'ლევან მურუსიძე' });
    expect(result.isError).toBeFalsy();
    const { hits } = result.structuredContent as {
      hits: { matchedName: string; matchedNameType: string; sourceEntryId: string }[];
    };
    expect(hits).toMatchObject([
      { sourceEntryId: 'GAC0076', matchedName: 'ლევან მურუსიძე', matchedNameType: 'aka' },
    ]);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('"ლევან მურუსიძე" (aka)');
    expect(text).toContain('**Entry ID:** GAC0076');
  });
});

// ─── Transliterated-only records on a list a native-script name settled (issue #99) ──
//
// Published OFAC, EU, and UK records, names as the lists carry them (aliases trimmed),
// except ofac_sdn INT-1, which holds `ao` and `international`.

describe('transliterated-only records on a list a native-script strict hit settled (issue #99)', () => {
  let harness: SeededService;
  afterEach(async () => {
    await harness.cleanup();
  });

  const record = (
    id: string,
    primaryName: string,
    aliases: string[] = [],
  ): NormalizedDesignation => {
    const [source, sourceEntryId] = id.split(':') as [SourceCode, string];
    return {
      id,
      source,
      sourceEntryId,
      entityType: 'organization',
      primaryName,
      payload: {
        aliases: aliases.map((name) => ({ name, nameType: 'aka' as const })),
        identifiers: [],
        addresses: [],
        datesOfBirth: [],
        nationalities: [],
      },
    };
  };
  const RECORDS = [
    record(
      'ofac_sdn:35337',
      'IZHEVSK UNMANNED SYSTEMS RESEARCH AND PRODUCTION ASSOCIATED LIMITED LIABILITY COMPANY',
      [
        'OOO NAUCHNO-PROIZVODSTVENNOYE OBYEDINENIYE IZHEVSKIYE BESPILOTNYE SISTEMY',
        'ООО НАУЧНО-ПРОИЗВОДСТВЕННОЕ ОБЪЕДИНЕНИЕ ИЖЕВСКИЕ БЕСПИЛОТНЫЕ СИСТЕМЫ',
      ],
    ),
    record('ofac_sdn:49352', 'LIMITED LIABILITY COMPANY UNMANNED SYSTEMS', ['Bespilotnye Sistemy']),
    record('eu:160491', 'SuperCam Unmanned  Systems Group', ['Беспилотные системы', 'SuperCam']),
    record('eu:175107', 'Limited Liability Company Unmanned Systems', [
      'ООО “Беспилотные Системы”',
    ]),
    record(
      'ofac_sdn:38097',
      'JOINT STOCK COMPANY PROMISING INDUSTRIAL AND INFRASTRUCTURE TECHNOLOGIES',
      ['Акционерное Общество Перспективные Промышленные и Инфраструктурные Технологии'],
    ),
    record('ofac_sdn:46688', 'Aktsionernoe Obshchestvo Promyshlennye Tekhnologii', ['AO Promtekh']),
    record('eu:172742', 'Promtech Joint Stock Company', [
      'Акционерное общество “Промышленные Технологии”',
      'АО “Промтех”',
    ]),
    record('ofac_sdn:48483', 'JOINT STOCK COMPANY INTEGRAL ZAPAD', [
      'Aktsionernoe Obshchestvo Integral Zapad',
    ]),
    record('ofac_sdn:INT-1', 'AO International Trading'),
    record('ofac_sdn:49417', 'JOINT STOCK COMPANY RUSSKIE ELEKTRICHESKIE DVIGATELI', [
      'Red AO',
      'Рэд АО',
    ]),
    record('ofac_sdn:48492', 'RED DOLPHIN JOINT STOCK COMPANY', ['AO Krasnyi Delfin']),
    record('eu:150199', 'Alfa-Bank JSC', ['Альфа-Банк']),
    record('ofac_sdn:34682', 'JOINT STOCK COMPANY ALFA-BANK', [
      'АКЦИОНЕРНОЕ ОБЩЕСТВО АЛЬФА-БАНК',
      'AO ALFA-BANK',
    ]),
    record('uk:BEL0166', 'CJSC Alfa Bank Belarus', ['ЗАО Альфа-Банк']),
    record('uk:RUS1074', 'Alfa-Bank JSC', ['Альфа-Банка']),
  ];

  beforeEach(async () => {
    harness = await seededGlobalService();
    await harness.service.ingestDesignations(RECORDS);
  });

  /** One screen through the tool: each hit as `list:id matchType [score] [covered/total]`, the enrichment, and the text. */
  const screen = async (name: string, sources: SourceCode[] = [...SOURCE_CODES]) => {
    const result = await runToolContract(screenNameTool, { name, sources, limit: 100 });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      hits: {
        source: SourceCode;
        sourceEntryId: string;
        matchType: string;
        matchedName: string;
        score?: number;
        queryTokenCoverage?: { covered: number; total: number };
      }[];
      fuzzySources?: SourceCode[];
      matchModeUsed: string;
      totalAvailable: number;
      totalAvailableBasis: string;
    };
    return {
      structured,
      rows: structured.hits.map(
        ({ source, sourceEntryId, matchType, score, queryTokenCoverage: cov }) =>
          [`${source}:${sourceEntryId}`, matchType, score, cov && `${cov.covered}/${cov.total}`]
            .filter((part) => part !== undefined)
            .join(' '),
      ),
      text: result.content.map((block) => ('text' in block ? block.text : '')).join('\n'),
    };
  };

  it('Беспилотные системы returns ofac_sdn 49352 as approximate beside 35337 as strong, fuzzySources naming ofac_sdn', async () => {
    const { structured, rows, text } = await screen('Беспилотные системы');
    expect(rows).toEqual([
      'eu:160491 exact',
      'ofac_sdn:35337 strong',
      'eu:175107 strong',
      'ofac_sdn:49352 approximate 1 2/2',
    ]);
    expect(structured.hits[3]?.matchedName).toBe('Bespilotnye Sistemy');
    expect(structured).toMatchObject({
      matchModeUsed: 'strict',
      fuzzySources: [...SOURCE_CODES],
      totalAvailable: 4,
      totalAvailableBasis: 'lower_bound',
    });
    expect(text).toContain(
      '### LIMITED LIABILITY COMPANY UNMANNED SYSTEMS — approximate · score 1 · covers 2/2 query tokens\n',
    );
    expect(text).toContain('**Matched on:** "Bespilotnye Sistemy" (aka)');
    expect(text).toContain(`**fuzzySources:** ${SOURCE_CODES.join(', ')}`);
    expect(text.indexOf('**Entry ID:** 35337')).toBeLessThan(text.indexOf('**Entry ID:** 49352'));
    expect(text).toContain(SCREENING_CAVEAT);

    // On OFAC alone the read is the only pass: no candidate budget, so the count is exact.
    const alone = await screen('Беспилотные системы', ['ofac_sdn']);
    expect(alone.rows).toEqual(['ofac_sdn:35337 strong', 'ofac_sdn:49352 approximate 1 2/2']);
    expect(alone.structured).toMatchObject({
      fuzzySources: ['ofac_sdn'],
      totalAvailable: 2,
      totalAvailableBasis: 'exact',
    });
    expect(alone.text).toContain('**fuzzySources:** ofac_sdn');
  });

  it('Акционерное общество “Промышленные Технологии” returns ofac_sdn 46688 beside the 38097 strict hit', async () => {
    const { rows, text } = await screen('Акционерное общество “Промышленные Технологии”');
    expect(rows).toEqual([
      'eu:172742 exact',
      'ofac_sdn:38097 strong',
      'ofac_sdn:46688 approximate 1 4/4',
    ]);
    expect(text).toContain(
      '### Aktsionernoe Obshchestvo Promyshlennye Tekhnologii — approximate · score 1 · covers 4/4 query tokens\n',
    );
  });

  it('ао integral gains no hit matching only International, and Рэд АО no … Red … Joint Stock Company', async () => {
    // Each screen searched OFAC with the read, and found no name holding every word.
    const integral = await screen('ао integral', ['ofac_sdn']);
    expect(integral.rows).toEqual(['ofac_sdn:48483 strong']);
    expect(integral.structured.fuzzySources).toEqual(['ofac_sdn']);
    expect(integral.text).not.toContain('AO International Trading');
    const red = await screen('Рэд АО', ['ofac_sdn']);
    expect(red.rows).toEqual(['ofac_sdn:49417 exact']);
    expect(red.structured.fuzzySources).toEqual(['ofac_sdn']);
    expect(red.text).not.toContain('RED DOLPHIN JOINT STOCK COMPANY');
  });

  it('a Latin-script screen returns the same hits, match types, scores and totalAvailableBasis (characterization)', async () => {
    const { structured, rows } = await screen('Bespilotnye Sistemy');
    // 35337's own transliteration holds both words: strict. The EU publishes these
    // two only in Cyrillic, which the fuzzy completion compares by romanization (#57).
    expect(rows).toEqual([
      'ofac_sdn:49352 exact',
      'ofac_sdn:35337 strong',
      'eu:160491 approximate 1 2/2',
      'eu:175107 approximate 1 2/2',
    ]);
    expect(structured).toMatchObject({
      fuzzySources: SOURCE_CODES.filter((code) => code !== 'ofac_sdn'),
      totalAvailable: 4,
      totalAvailableBasis: 'lower_bound',
    });
  });

  it('Альфа-Банк still returns uk RUS1074 beside BEL0166', async () => {
    const { rows, text } = await screen('Альфа-Банк');
    expect(rows).toEqual([
      'eu:150199 exact',
      'ofac_sdn:34682 strong',
      'uk:BEL0166 strong',
      'uk:RUS1074 approximate 1 2/2',
    ]);
    expect(text).toContain('**Entry ID:** BEL0166');
    expect(text).toContain('**Entry ID:** RUS1074');
  });
});
