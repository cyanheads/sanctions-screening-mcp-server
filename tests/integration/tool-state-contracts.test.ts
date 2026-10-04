/**
 * @fileoverview Integration coverage for public tool/resource state contracts:
 * empty-result notices, mirror readiness gating, freshness, source parity, and
 * capped-result disclosure and retrieval. Defects still open remain skipped with
 * issue links.
 * @module tests/integration/tool-state-contracts.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import type { ListExtra } from '@cyanheads/mcp-ts-core/resources';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { designationResource } from '@/mcp-server/resources/definitions/designation.resource.js';
import { entityResource } from '@/mcp-server/resources/definitions/entity.resource.js';
import { sourcesResource } from '@/mcp-server/resources/definitions/sources.resource.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import { FUZZY_POOL_BUDGET } from '@/services/screening/candidate-pool.js';
import { FIXTURE_LEI_ENTITIES, FIXTURE_LEI_RELATIONSHIPS } from '@/services/screening/fixtures.js';
import type { NormalizedDesignation } from '@/services/screening/types.js';
import {
  emptyGlobalService,
  type SeededService,
  seededGlobalService,
} from '../services/_helpers.js';

/**
 * A mock context whose typed `ctx.fail` is wired against a definition's error
 * contract. `const E` keeps the reason union intact, so the returned context
 * satisfies the `HandlerContext<Reason>` the handler declares.
 */
const ctxFor = <const E extends readonly ErrorContract[] | undefined>(errors: E) =>
  createMockContext({ errors });

/**
 * Parse a resource's declared params schema. `params` is optional on the
 * definition type; every resource under test declares one, so a missing schema
 * is a regression worth failing loudly on rather than typing around.
 */
function parseParams<P>(definition: { params?: { parse: (raw: unknown) => P } }, raw: unknown): P {
  if (!definition.params) throw new Error('resource declares no params schema');
  return definition.params.parse(raw);
}

/**
 * Minimal `ListExtra` for exercising a resource's `list()` provider. `ListExtra`
 * is the SDK v2 `ServerContext`, so the request scope lives under `mcpReq`; the
 * server-to-client channels throw because no client is attached in-process.
 */
const listExtra = (): ListExtra => ({
  mcpReq: {
    id: 'test-list',
    method: 'resources/list',
    signal: new AbortController().signal,
    requestState: () => undefined,
    notify: async () => {},
    send: async () => {
      throw new Error('send is not available in this test harness');
    },
    log: async () => {},
    elicitInput: async () => {
      throw new Error('elicitInput is not available in this test harness');
    },
    requestSampling: async () => {
      throw new Error('requestSampling is not available in this test harness');
    },
  },
});

const partialDesignation: NormalizedDesignation = {
  id: 'ofac_sdn:PARTIAL-1',
  source: 'ofac_sdn',
  sourceEntryId: 'PARTIAL-1',
  entityType: 'organization',
  primaryName: 'Partial Mirror Holdings',
  payload: {
    aliases: [],
    identifiers: [],
    addresses: [],
    datesOfBirth: [],
    nationalities: [],
  },
};

describe('empty result versus unavailable screening', () => {
  let global: SeededService | undefined;

  afterEach(async () => {
    await global?.cleanup();
  });

  it('marks a completed zero-hit screen as not a clearance', async () => {
    global = await seededGlobalService();
    const ctx = ctxFor(screenNameTool.errors);
    const result = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Zzqxwv Qqpzm Unlisted' }),
      ctx,
    );

    expect(result.hits).toHaveLength(0);
    expect(result.caveat).toMatch(/not a compliance determination/i);
    expect(getEnrichment(ctx)).toMatchObject({
      totalCount: 0,
      matchModeUsed: 'fuzzy',
    });
    expect(getEnrichment(ctx).notice).toMatch(/not a clearance/i);
    expect(render(screenNameTool, result)).toMatch(/no potential matches|not a clearance/i);
  });

  it('returns mirror_not_ready instead of a zero-hit screen when screening never ran', async () => {
    global = await emptyGlobalService();
    await expect(
      screenNameTool.handler(
        screenNameTool.input.parse({ name: 'Zzqxwv Qqpzm Unlisted' }),
        ctxFor(screenNameTool.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
  });

  it('gates designation, entity, and ownership reads on their required mirrors', async () => {
    global = await emptyGlobalService();
    await expect(
      getDesignationTool.handler(
        getDesignationTool.input.parse({ source: 'ofac_sdn', entryId: '22790' }),
        ctxFor(getDesignationTool.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
    await expect(
      getEntityTool.handler(
        getEntityTool.input.parse({ lei: '5493001KJTIIGC8Y1R12' }),
        ctxFor(getEntityTool.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
    await expect(
      traceOwnershipTool.handler(
        traceOwnershipTool.input.parse({ lei: '5493001KJTIIGC8Y1R12' }),
        ctxFor(traceOwnershipTool.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
  });

  it('marks an unmatched LEI resolution as a failed lookup, not proof no LEI exists', async () => {
    global = await seededGlobalService();
    const ctx = ctxFor(resolveEntityTool.errors);
    const result = await resolveEntityTool.handler(
      resolveEntityTool.input.parse({ name: 'Zzqxwv Qqpzm Holdings', status: 'any' }),
      ctx,
    );
    expect(result.matches).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toMatch(/not proof.*no LEI/i);
  });

  it('never suggests a fuzzy retry after the fuzzy pass both empty results come from (#36)', async () => {
    global = await seededGlobalService();
    const resolveCtx = ctxFor(resolveEntityTool.errors);
    const resolved = await resolveEntityTool.handler(
      resolveEntityTool.input.parse({ name: 'Zzqxwv Qqpzm Xkwqj', jurisdiction: 'US' }),
      resolveCtx,
    );
    expect(getEnrichment(resolveCtx)).toMatchObject({ matchModeUsed: 'fuzzy', totalCount: 0 });
    expect(resolved.matches).toHaveLength(0);
    expect(getEnrichment(resolveCtx).notice).toMatch(/not proof.*no LEI/i);
    expect(getEnrichment(resolveCtx).notice).not.toMatch(/matchMode/);
    expect(getEnrichment(resolveCtx).notice).toMatch(/drop the jurisdiction filter/);
    expect(getEnrichment(resolveCtx).notice).toMatch(/status:"any"/);

    // Only the filters actually applied are offered as ways to broaden.
    const unfilteredCtx = ctxFor(resolveEntityTool.errors);
    await resolveEntityTool.handler(
      resolveEntityTool.input.parse({ name: 'Zzqxwv Qqpzm Xkwqj', status: 'any' }),
      unfilteredCtx,
    );
    expect(getEnrichment(unfilteredCtx).notice).toMatch(/not proof.*no LEI/i);
    expect(getEnrichment(unfilteredCtx).notice).not.toMatch(/jurisdiction|status:"any"/);

    const screenCtx = ctxFor(screenNameTool.errors);
    await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Zzqxwv Qqpzm Xkwqj' }),
      screenCtx,
    );
    expect(getEnrichment(screenCtx)).toMatchObject({ matchModeUsed: 'fuzzy', totalCount: 0 });
    expect(getEnrichment(screenCtx).notice).toMatch(/not a clearance/i);
    expect(getEnrichment(screenCtx).notice).not.toMatch(/matchMode/);
  });

  it('carries search enrichment onto both response surfaces', async () => {
    global = await seededGlobalService();
    // `format()` only ever sees the tool's `output`, so enrichment reaches
    // `content[]` through the framework's trailer block appended after the
    // formatter's own output — assert the WHOLE array, not `content[0]`.
    const result = await runToolContract(screenNameTool, { name: 'Zzqxwv Qqpzm Unlisted' });
    const structured = result.structuredContent as Record<string, unknown>;
    const text = contentText(result);

    expect(result.isError).toBeFalsy();
    expect(text).toContain('**No potential matches found.**');
    expect(structured).toMatchObject({
      totalCount: 0,
      totalAvailable: 0,
      hasMore: false,
      matchModeUsed: 'fuzzy',
    });
    for (const field of ['normalizedQuery', 'matchModeUsed', 'notice'] as const) {
      expect(text).toContain(String(structured[field]));
    }
  });
});

describe('per-list fuzzy completion on both surfaces (#59)', () => {
  let global: SeededService | undefined;

  afterEach(async () => {
    await global?.cleanup();
  });

  const person = (id: string, primaryName: string): NormalizedDesignation => {
    const [source, sourceEntryId] = id.split(':') as [NormalizedDesignation['source'], string];
    return { ...partialDesignation, id, source, sourceEntryId, entityType: 'person', primaryName };
  };
  const screen = async (input: Record<string, unknown>) => {
    global = await seededGlobalService();
    await global.service.ingestDesignations([
      person('eu:POU-1', 'Vladimir Vladimirovich POUTINE'),
      person('ofac_sdn:PUT-1', 'Putin Vladimir Vladimirovich'),
      person('uk:PUT-UK', 'Vladimir Vladimirovich PUTIN'),
    ]);
    const result = await runToolContract(screenNameTool, input as never);
    expect(result.isError).toBeFalsy();
    return {
      structured: result.structuredContent as Record<string, unknown> & {
        hits: { matchType: string; source: string; sourceEntryId: string }[];
      },
      text: contentText(result),
    };
  };

  it('completes the lists strict missed, reporting strict mode, the lists searched, and a lower bound', async () => {
    const { structured, text } = await screen({ name: 'Vladimir Poutine' });
    expect(
      structured.hits.map((hit) => `${hit.source}:${hit.sourceEntryId} ${hit.matchType}`),
    ).toEqual(['eu:POU-1 strong', 'ofac_sdn:PUT-1 approximate', 'uk:PUT-UK approximate']);
    expect(structured).toMatchObject({
      matchModeUsed: 'strict',
      fuzzySources: ['ofac_sdn', 'ofac_consolidated', 'uk', 'un'],
      totalAvailable: 3,
      totalAvailableBasis: 'lower_bound',
    });
    expect(text).toContain('**fuzzySources:** ofac_sdn, ofac_consolidated, uk, un');
    expect(text).toContain('### Putin Vladimir Vladimirovich — approximate');
  });

  it('carries no fuzzySources when strict hit every selected list', async () => {
    const { structured } = await screen({ name: 'Vladimir Poutine', sources: ['eu'] });
    expect(structured).toMatchObject({ matchModeUsed: 'strict', totalAvailableBasis: 'exact' });
    expect(structured).not.toHaveProperty('fuzzySources');
  });

  it('names every selected list after a full fallback', async () => {
    const { structured } = await screen({ name: 'Zzqxwv Qqpzm Unlisted', sources: ['un', 'eu'] });
    expect(structured).toMatchObject({ matchModeUsed: 'fuzzy', fuzzySources: ['eu', 'un'] });
  });

  it('states the per-list rule in the tool and matchMode descriptions', () => {
    expect(screenNameTool.description).toMatch(/each selected list strict finds nothing on/);
    expect(screenNameTool.input.shape.matchMode.description).toMatch(
      /each selected list strict finds nothing on/,
    );
  });
});

describe('ready detail and resource reads', () => {
  let global: SeededService | undefined;

  afterEach(async () => {
    await global?.cleanup();
  });

  it('renders the full designation detail and caveat', async () => {
    global = await seededGlobalService();
    const result = await getDesignationTool.handler(
      getDesignationTool.input.parse({ source: 'ofac_sdn', entryId: 'FX-1001' }),
      ctxFor(getDesignationTool.errors),
    );
    const text = render(getDesignationTool, result);
    expect(text).toContain('Ivan Testovich Volkov');
    expect(text).toContain('X1234567');
    expect(text).toContain('Ivan Wolkow');
    expect(text).toMatch(/not a compliance determination/i);
  });

  it('hydrates designation and entity URI resources from the ready mirrors', async () => {
    global = await seededGlobalService();
    const designation = await designationResource.handler(
      parseParams(designationResource, { source: 'ofac_sdn', entryId: 'FX-1001' }),
      ctxFor(designationResource.errors),
    );
    const entity = await entityResource.handler(
      parseParams(entityResource, { lei: '5493001KJTIIGC8Y1R12' }),
      ctxFor(entityResource.errors),
    );
    expect(designation).toMatchObject({
      primaryName: 'Ivan Testovich Volkov',
      caveat: expect.stringMatching(/screening aid/i),
    });
    expect(entity).toMatchObject({
      lei: '5493001KJTIIGC8Y1R12',
      legalName: 'Fictional Trading Company LLC',
    });
  });

  it('lists the fixed sources URI', async () => {
    global = await seededGlobalService();
    expect(sourcesResource.list?.(listExtra())).toEqual({
      resources: [{ uri: 'sanctions://sources', name: 'Loaded sanctions sources' }],
    });
  });
});

describe('source state and freshness', () => {
  let global: SeededService | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await global?.cleanup();
  });

  it('surfaces a partially loaded mirror without treating it as ready', async () => {
    global = await emptyGlobalService();
    await global.service.ingestDesignations([partialDesignation]);

    const result = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      createMockContext(),
    );
    expect(result.sanctionsReady).toBe(false);
    expect(result.sanctionsAsOf).toBeUndefined();
    expect(result.sources.find((source) => source.code === 'ofac_sdn')?.recordCount).toBe(1);
    expect(result.sources.find((source) => source.code === 'eu')?.recordCount).toBe(0);
    expect(render(listSourcesTool, result)).toMatch(/sanctions mirror:\*\* NOT ready/i);
  });

  it('surfaces a stale as-of timestamp and zero-count missing sources', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    global = await emptyGlobalService();
    await global.service.ingestDesignations([partialDesignation]);
    await global.service.markSanctionsReady(1);

    const result = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      createMockContext(),
    );
    expect(result.sanctionsReady).toBe(true);
    expect(result.sanctionsAsOf).toBe('2026-06-01T12:00:00.000Z');
    expect(result.leiReady).toBe(false);
    expect(result.sources.find((source) => source.code === 'uk')?.recordCount).toBe(0);
    expect(render(listSourcesTool, result)).toContain('2026-06-01T12:00:00.000Z');
  });
});

/** Three designations sharing a name stem, so a strict screen matches all three. */
const overflowDesignations: NormalizedDesignation[] = ['Alpha', 'Bravo', 'Charlie'].map(
  (suffix, index): NormalizedDesignation => ({
    id: `un:PAGE-${index}`,
    source: 'un',
    sourceEntryId: `PAGE-${index}`,
    entityType: 'organization',
    primaryName: `Overflow Candidate ${suffix}`,
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  }),
);

/** Three GLEIF entities sharing a name stem, so a strict resolution matches all three. */
const overflowEntities = ['Alpha', 'Bravo', 'Charlie'].map((suffix, index) => ({
  lei: `OVERFLOWPAGE00000${index}01`,
  legalName: `Overflow Candidate ${suffix} Ltd`,
  otherNames: [],
  jurisdiction: 'US',
  status: 'ISSUED',
}));

/** The fixture LEI whose legal name a fixture designation already matches exactly. */
const LISTED_ENTITY_LEI = '5493001KJTIIGC8Y1R12';

/** The fixture LEI whose legal name no fixture designation matches. */
const UNLISTED_ENTITY_LEI = '529900T8BM49AURSDO55';

/**
 * `count` designations published under `Fictional Trading Company LLC` — the
 * exact legal name of {@link LISTED_ENTITY_LEI} — so `sanctions_get_entity`'s
 * cross-reference screen on that LEI matches every one of them, on top of the
 * fixture's own designation of the same name.
 */
const crossReferenceDesignations = (count: number): NormalizedDesignation[] =>
  Array.from(
    { length: count },
    (_unused, index): NormalizedDesignation => ({
      id: `un:XREF-${index}`,
      source: 'un',
      sourceEntryId: `XREF-${index}`,
      entityType: 'organization',
      primaryName: 'Fictional Trading Company LLC',
      payload: {
        aliases: [],
        identifiers: [],
        addresses: [],
        datesOfBirth: [],
        nationalities: [],
      },
    }),
  );

describe('capped result disclosure and retrieval', () => {
  let global: SeededService | undefined;

  afterEach(async () => {
    await global?.cleanup();
  });

  it('discloses overflow and retrieves every capped screen page', async () => {
    global = await seededGlobalService();
    await global.service.ingestDesignations(overflowDesignations);

    // The one list the three are on: a list strict found nothing on would be fuzzy-completed (#59).
    const firstCtx = ctxFor(screenNameTool.errors);
    const first = await screenNameTool.handler(
      screenNameTool.input.parse({
        name: 'Overflow Candidate',
        sources: ['un'],
        limit: 1,
        offset: 0,
      }),
      firstCtx,
    );
    expect(getEnrichment(firstCtx)).toMatchObject({
      totalCount: 1,
      totalAvailable: 3,
      totalAvailableBasis: 'exact',
      hasMore: true,
      nextOffset: 1,
    });

    const second = await screenNameTool.handler(
      screenNameTool.input.parse({
        name: 'Overflow Candidate',
        sources: ['un'],
        limit: 1,
        offset: 1,
      }),
      ctxFor(screenNameTool.errors),
    );
    expect(second.hits[0]?.sourceEntryId).not.toBe(first.hits[0]?.sourceEntryId);
  });

  it('walks the whole capped screen set as disjoint pages', async () => {
    global = await seededGlobalService();
    await global.service.ingestDesignations(overflowDesignations);

    const seen: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const ctx = ctxFor(screenNameTool.errors);
      const page = await screenNameTool.handler(
        screenNameTool.input.parse({ name: 'Overflow Candidate', limit: 1, offset }),
        ctx,
      );
      seen.push(...page.hits.map((hit) => hit.sourceEntryId));
      const enrichment = getEnrichment(ctx);
      offset = enrichment.hasMore === true ? (enrichment.nextOffset as number) : undefined;
    }
    expect(seen).toEqual(['PAGE-0', 'PAGE-1', 'PAGE-2']);
  });

  it('stays silent about overflow when the whole set fits inside the limit', async () => {
    global = await seededGlobalService();
    await global.service.ingestDesignations(overflowDesignations);

    const ctx = ctxFor(screenNameTool.errors);
    await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Overflow Candidate', limit: 25 }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ totalCount: 3, totalAvailable: 3, hasMore: false });
    expect(enrichment.nextOffset).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns an empty page past the end without claiming the entity is unlisted', async () => {
    global = await seededGlobalService();
    await global.service.ingestDesignations(overflowDesignations);

    const ctx = ctxFor(screenNameTool.errors);
    const result = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Overflow Candidate', limit: 1, offset: 9 }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);
    expect(result.hits).toHaveLength(0);
    expect(enrichment).toMatchObject({ totalCount: 0, totalAvailable: 3, hasMore: false });
    expect(enrichment.notice).toMatch(/past the end/i);
    expect(enrichment.notice).not.toMatch(/not a clearance/i);
  });

  it('labels a fuzzy-mode total as a bound rather than an exact count', async () => {
    global = await seededGlobalService();
    const ctx = ctxFor(screenNameTool.errors);
    await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Ivan Volkow', matchMode: 'fuzzy' }),
      ctx,
    );
    expect(getEnrichment(ctx)).toMatchObject({
      matchModeUsed: 'fuzzy',
      totalAvailableBasis: 'lower_bound',
    });
  });

  it('discloses overflow and retrieves every capped LEI page on the same contract', async () => {
    global = await seededGlobalService();
    await global.service.ingestLeiEntities(overflowEntities);

    const firstCtx = ctxFor(resolveEntityTool.errors);
    const first = await resolveEntityTool.handler(
      resolveEntityTool.input.parse({ name: 'Overflow Candidate', limit: 1, offset: 0 }),
      firstCtx,
    );
    expect(getEnrichment(firstCtx)).toMatchObject({
      totalCount: 1,
      totalAvailable: 3,
      totalAvailableBasis: 'exact',
      hasMore: true,
      nextOffset: 1,
    });

    const secondCtx = ctxFor(resolveEntityTool.errors);
    const second = await resolveEntityTool.handler(
      resolveEntityTool.input.parse({ name: 'Overflow Candidate', limit: 1, offset: 1 }),
      secondCtx,
    );
    expect(second.matches[0]?.lei).not.toBe(first.matches[0]?.lei);
    expect(getEnrichment(secondCtx)).toMatchObject({ nextOffset: 2, hasMore: true });

    const lastCtx = ctxFor(resolveEntityTool.errors);
    const last = await resolveEntityTool.handler(
      resolveEntityTool.input.parse({ name: 'Overflow Candidate', limit: 1, offset: 2 }),
      lastCtx,
    );
    expect(getEnrichment(lastCtx)).toMatchObject({ hasMore: false });
    expect(new Set([first, second, last].map((page) => page.matches[0]?.lei)).size).toBe(3);
  });

  it('discloses a capped get_entity cross-reference on both surfaces', async () => {
    global = await seededGlobalService();
    // Twenty-six under the entity's exact legal name plus the fixture's own, so
    // the twenty-five-hit cross-reference cap binds with two matches left behind.
    await global.service.ingestDesignations(crossReferenceDesignations(26));

    const result = await runToolContract(getEntityTool, { lei: LISTED_ENTITY_LEI });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(structured.sanctionsHits).toHaveLength(25);
    expect(structured).toMatchObject({
      screeningStatus: 'screened',
      sanctionsScreen: { totalAvailable: 27, totalAvailableBasis: 'exact', hasMore: true },
    });

    const text = contentText(result);
    expect(text).toContain('showing 25 of 27 potential match(es) (count basis: exact)');
    // The guidance names every screened name and identifier, not the legal name alone.
    expect(text).toContain(
      `re-screen "Fictional Trading Company LLC", "Fictional Trading Co" with sanctions_screen_name and look up ${LISTED_ENTITY_LEI}, TEST-REG-1 with sanctions_screen_identifier to see the rest; the name re-screen can add approximate matches on lists with no strict match, which this count leaves out.`,
    );
  });

  it('leaves an uncapped get_entity cross-reference reading as complete', async () => {
    global = await seededGlobalService();
    // Twenty-four plus the fixture's own is exactly the cap: the whole match set
    // fits, so a complete cross-reference must not read as capped.
    await global.service.ingestDesignations(crossReferenceDesignations(24));

    const result = await getEntityTool.handler(
      getEntityTool.input.parse({ lei: LISTED_ENTITY_LEI }),
      ctxFor(getEntityTool.errors),
    );

    expect(result.sanctionsHits).toHaveLength(25);
    expect(result.sanctionsScreen).toEqual({
      totalAvailable: 25,
      totalAvailableBasis: 'exact',
      hasMore: false,
      screenedInputs: [
        { input: 'other_name', value: 'Fictional Trading Co', nameType: 'PREVIOUS_LEGAL_NAME' },
        { input: 'registration_number', value: 'TEST-REG-1' },
      ],
    });
    const text = render(getEntityTool, result);
    expect(text).toContain('showing 25 of 25 potential match(es) (count basis: exact)');
    expect(text).not.toContain('sanctions_screen_name');
  });

  it('reads a zero-match get_entity cross-reference as screened, not capped', async () => {
    global = await seededGlobalService();
    const result = await getEntityTool.handler(
      getEntityTool.input.parse({ lei: UNLISTED_ENTITY_LEI }),
      ctxFor(getEntityTool.errors),
    );

    expect(result).toMatchObject({ screeningStatus: 'screened', sanctionsHits: [] });
    expect(result.sanctionsScreen).toEqual({
      totalAvailable: 0,
      totalAvailableBasis: 'exact',
      hasMore: false,
      screenedInputs: [
        { input: 'other_name', value: 'Testland Holdings', nameType: 'TRADING_OR_OPERATING_NAME' },
        { input: 'registration_number', value: 'TEST-REG-2' },
      ],
    });
    const text = render(getEntityTool, result);
    expect(text).toContain(
      'No potential watchlist matches on any screened name or identifier (NOT a clearance).',
    );
    expect(text).toContain('showing 0 of 0 potential match(es) (count basis: exact)');
  });

  it('keeps the empty-result guidance when nothing matched at all', async () => {
    global = await seededGlobalService();
    const ctx = ctxFor(screenNameTool.errors);
    await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Zzqxwv Qqpzm Unlisted', limit: 1 }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ totalCount: 0, totalAvailable: 0, hasMore: false });
    expect(enrichment.notice).toMatch(/not a clearance/i);
  });

  /** `count` UN organizations named `${stem} Zx<i>`, entry IDs `${tag}-<i>`. */
  const designations = (count: number, tag: string, stem: string): NormalizedDesignation[] =>
    Array.from({ length: count }, (_, i) => ({
      ...partialDesignation,
      id: `un:${tag}-${i}`,
      source: 'un',
      sourceEntryId: `${tag}-${i}`,
      primaryName: `${stem} Zx${i}`,
    }));
  /** `count` ISSUED US entities named `${stem} Zx<i>`, LEIs tagged `tag`. */
  const entities = (count: number, tag: string, stem: string) =>
    Array.from({ length: count }, (_, i) => ({
      lei: `${tag}${String(i).padStart(5, '0')}`.padEnd(18, '0').concat('42'),
      legalName: `${stem} Zx${i}`,
      otherNames: [],
      jurisdiction: 'US',
      status: 'ISSUED',
    }));

  it('walks every candidate a fuzzy pass admits through nextOffset, on both tools', async () => {
    global = await seededGlobalService();
    await global.service.ingestDesignations(designations(80, 'ZEL', 'Zelvanora'));
    await global.service.ingestLeiEntities(entities(80, 'ZELV', 'Zelvanora'));

    /** The enrichment of one page, checked against the whole set, and the next offset. */
    const nextOf = (ctx: Parameters<typeof getEnrichment>[0]): number | undefined => {
      const enrichment = getEnrichment(ctx);
      expect(enrichment).toMatchObject({ totalAvailable: 80, totalAvailableBasis: 'lower_bound' });
      return enrichment.hasMore === true ? (enrichment.nextOffset as number) : undefined;
    };

    const screened: string[] = [];
    for (let offset: number | undefined = 0; offset !== undefined; ) {
      const ctx = ctxFor(screenNameTool.errors);
      const page = await screenNameTool.handler(
        screenNameTool.input.parse({ name: 'Zelvanorra', matchMode: 'fuzzy', limit: 25, offset }),
        ctx,
      );
      screened.push(...page.hits.map((hit) => hit.sourceEntryId));
      offset = nextOf(ctx);
    }
    expect(screened).toHaveLength(80);
    expect(new Set(screened)).toEqual(
      new Set(designations(80, 'ZEL', '').map((d) => d.sourceEntryId)),
    );

    const resolved: string[] = [];
    for (let offset: number | undefined = 0; offset !== undefined; ) {
      const ctx = ctxFor(resolveEntityTool.errors);
      const page = await resolveEntityTool.handler(
        resolveEntityTool.input.parse({
          name: 'Zelvanorra',
          matchMode: 'fuzzy',
          limit: 25,
          offset,
        }),
        ctx,
      );
      resolved.push(...page.matches.map((match) => match.lei));
      offset = nextOf(ctx);
    }
    expect(resolved).toHaveLength(80);
    expect(new Set(resolved)).toEqual(new Set(entities(80, 'ZELV', '').map((e) => e.lei)));
  });

  it('names the count past the end, and says more may exist only under a lower bound', async () => {
    global = await seededGlobalService();
    await global.service.ingestDesignations([
      ...overflowDesignations,
      ...designations(80, 'ZEL', 'Zelvanora'),
    ]);
    await global.service.ingestLeiEntities([
      ...overflowEntities,
      ...entities(80, 'ZELV', 'Zelvanora'),
    ]);
    /** The notice on both surfaces of one result. */
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>): string => {
      const notice = String((result.structuredContent as Record<string, unknown>).notice);
      expect(contentText(result)).toContain(notice);
      return notice;
    };

    const fuzzyScreen = noticeOf(
      await runToolContract(screenNameTool, {
        name: 'Zelvanorra',
        matchMode: 'fuzzy',
        offset: 500,
      }),
    );
    expect(fuzzyScreen).toMatch(/past the end of this result set, which holds 80 potential match/);
    expect(fuzzyScreen).toMatch(/lower bound.*more may exist/i);

    // A strict hit on every selected list: no fuzzy completion, so the count is exact (#59).
    const strictScreen = noticeOf(
      await runToolContract(screenNameTool, {
        name: 'Overflow Candidate',
        sources: ['un'],
        offset: 9,
      }),
    );
    expect(strictScreen).toMatch(/past the end of this result set, which holds 3 potential match/);
    expect(strictScreen).not.toMatch(/more may exist/i);

    const fuzzyResolve = noticeOf(
      await runToolContract(resolveEntityTool, {
        name: 'Zelvanorra',
        matchMode: 'fuzzy',
        offset: 500,
      }),
    );
    expect(fuzzyResolve).toMatch(/past the end of this result set, which holds 80 LEI candidate/);
    expect(fuzzyResolve).toMatch(/lower bound.*more may exist/i);

    const strictResolve = noticeOf(
      await runToolContract(resolveEntityTool, { name: 'Overflow Candidate', offset: 9 }),
    );
    expect(strictResolve).toMatch(/past the end of this result set, which holds 3 LEI candidate/);
    expect(strictResolve).not.toMatch(/more may exist/i);
  });

  it('tells the caller to narrow with a more distinctive word when the candidate budget left a block out', async () => {
    global = await seededGlobalService();
    // `vla`, `kes`, and the phonetic key of `Vladimir` each reach more names than the budget.
    await global.service.ingestDesignations([
      ...designations(FUZZY_POOL_BUDGET + 1, 'VLA', 'Vladimir'),
      {
        ...partialDesignation,
        id: 'un:PET-1',
        sourceEntryId: 'PET-1',
        primaryName: 'Vladimir Petrenkov',
      },
    ]);
    await global.service.ingestLeiEntities([
      ...entities(FUZZY_POOL_BUDGET + 1, 'KESB', 'Kestrel'),
      { ...overflowEntities[0]!, lei: 'KESTRELBANK0000000042', legalName: 'Kestrel Bank' },
    ]);

    for (const [definition, bounded, fits] of [
      [screenNameTool, 'Vladimir Petrenkox', 'Petrenkox'],
      [resolveEntityTool, 'Kestrel Bnak', 'Banko'],
    ] as const) {
      const result = await runToolContract(definition, { name: bounded, matchMode: 'fuzzy' });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured, definition.name).toMatchObject({ totalAvailableBasis: 'lower_bound' });
      expect(structured.notice, definition.name).toMatch(/narrow with a more distinctive word/i);
      expect(contentText(result)).toContain(String(structured.notice));

      const fitted = await runToolContract(definition, { name: fits, matchMode: 'fuzzy' });
      expect((fitted.structuredContent as Record<string, unknown>).notice ?? '').not.toMatch(
        /distinctive word/,
      );
    }
  });

  it('discloses query words the pre-index fuzzy pass left unsearched, without calling them common (#71)', async () => {
    global = await seededGlobalService();
    // A completion the GLEIF name index did not follow: resolution takes the legal-name path.
    await global.service.leiEntities.store.writeState({
      status: 'complete',
      completedAt: '2027-01-01T00:00:00.000Z',
      total: FIXTURE_LEI_ENTITIES.length,
    });

    // Five distinctive words, none common: the ones past the scan cap are skipped, not crowded out.
    const over = await runToolContract(resolveEntityTool, {
      name: 'Vexmira Quindel Jarnwik Oswynd Pyxtal',
      matchMode: 'fuzzy',
    });
    const structured = over.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ totalAvailableBasis: 'lower_bound' });
    expect(structured.notice).toMatch(/fuzzy pass reached its candidate bound/i);
    expect(structured.notice).toMatch(/narrow with a more distinctive word/i);
    expect(structured.notice).not.toMatch(/common word/i);
    expect(structured.notice).toMatch(/alternate names .* are not yet indexed/i);
    expect(contentText(over)).toContain(String(structured.notice));

    const within = await runToolContract(resolveEntityTool, {
      name: 'Vexmira Quindel Jarnwik',
      matchMode: 'fuzzy',
    });
    expect(String((within.structuredContent as Record<string, unknown>).notice)).not.toMatch(
      /candidate bound/,
    );
  });

  it('lists exact LEIs first and tells the caller to narrow when the strict scan bound binds', async () => {
    global = await seededGlobalService();
    // Fourteen entities named exactly `Quorvane`, written after 2,100 strong names.
    await global.service.ingestLeiEntities([
      ...entities(2100, 'QCROWD', 'Quorvane'),
      ...Array.from({ length: 14 }, (_, i) => ({
        ...overflowEntities[0]!,
        lei: `QEXACT${String(i).padStart(2, '0')}`.padEnd(18, '0').concat('42'),
        legalName: 'Quorvane',
      })),
    ]);

    const bound = await runToolContract(resolveEntityTool, { name: 'Quorvane', limit: 20 });
    const structured = bound.structuredContent as {
      matches: { matchType: string }[];
      notice?: string;
    };
    expect(structured.matches.slice(0, 14).every((m) => m.matchType === 'exact')).toBe(true);
    expect(structured.matches[14]?.matchType).toBe('strong');
    expect(structured).toMatchObject({ totalAvailableBasis: 'lower_bound', hasMore: true });
    expect(structured.notice).toMatch(/narrow with another word from the name or a jurisdiction/i);
    expect(contentText(bound)).toContain(String(structured.notice));

    const under = await runToolContract(resolveEntityTool, { name: 'Quorvane Zx7' });
    expect(under.structuredContent).toMatchObject({
      totalAvailable: 1,
      totalAvailableBasis: 'exact',
    });
    expect((under.structuredContent as Record<string, unknown>).notice).toBeUndefined();
  });
});

describe('resource state contracts', () => {
  let global: SeededService | undefined;

  afterEach(async () => {
    await global?.cleanup();
  });

  it.each([
    ['designation', designationResource],
    ['entity', entityResource],
  ] as const)(
    'returns mirror_not_ready from the uninitialized %s resource',
    async (_name, resource) => {
      global = await emptyGlobalService();
      if (resource === designationResource) {
        await expect(
          designationResource.handler(
            parseParams(designationResource, { source: 'ofac_sdn', entryId: '22790' }),
            ctxFor(designationResource.errors),
          ),
        ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
        return;
      }
      await expect(
        entityResource.handler(
          parseParams(entityResource, { lei: '5493001KJTIIGC8Y1R12' }),
          ctxFor(entityResource.errors),
        ),
      ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
    },
  );

  it('keeps source URL and license parity between the tool and URI resource', async () => {
    global = await seededGlobalService();
    const tool = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      createMockContext(),
    );
    // The resource declares no output schema, so its payload arrives untyped —
    // shape it here rather than asserting against `unknown`.
    const resource = z
      .object({ sources: z.array(z.looseObject({ code: z.string() })) })
      .parse(await sourcesResource.handler(parseParams(sourcesResource, {}), createMockContext()));

    for (const expected of tool.sources) {
      expect(resource.sources.find((source) => source.code === expected.code)).toMatchObject({
        url: expected.url,
        license: expected.license,
      });
    }
  });
});

describe('degraded cross-reference status', () => {
  let global: SeededService | undefined;

  afterEach(async () => {
    await global?.cleanup();
  });

  async function gleifOnly(): Promise<SeededService> {
    const state = await emptyGlobalService();
    await state.service.ingestLeiEntities(FIXTURE_LEI_ENTITIES);
    await state.service.ingestLeiRelationships(FIXTURE_LEI_RELATIONSHIPS);
    await state.service.markLeiReady(FIXTURE_LEI_ENTITIES.length);
    return state;
  }

  it('marks get_entity screening as unavailable instead of returning no hits', async () => {
    global = await gleifOnly();
    const ctx = ctxFor(getEntityTool.errors);
    const result = await getEntityTool.handler(
      getEntityTool.input.parse({ lei: '5493001KJTIIGC8Y1R12' }),
      ctx,
    );
    expect({ ...result, ...getEnrichment(ctx) }).toMatchObject({ screeningStatus: 'not_ready' });
    // A screen that never ran discloses no coverage — there is nothing to cap.
    expect(result.sanctionsScreen).toBeUndefined();

    // The markdown surface must not present the unrun screen as a clean one.
    const text = render(getEntityTool, result);
    expect(text).not.toContain('No potential watchlist matches');
    expect(text).not.toContain('count basis');
    expect(text).toMatch(/did not run/i);
    expect(text).toMatch(/not a clearance/i);
  });

  it('marks requested ownership node screening as unavailable', async () => {
    global = await gleifOnly();
    const ctx = ctxFor(traceOwnershipTool.errors);
    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: '5493001KJTIIGC8Y1R12', screenNodes: true }),
      ctx,
    );
    expect({ ...result, ...getEnrichment(ctx) }).toMatchObject({ screeningStatus: 'not_ready' });
    expect(result.screenedNodeCount).toBe(0);
    expect(render(traceOwnershipTool, result)).toMatch(/not run/i);

    // Graph completeness is a separate axis: an unscreened node is still a fully
    // known node, so an unavailable screen must not report the graph incomplete.
    expect(result).toMatchObject({ complete: true, truncated: false, missingEntityLeis: [] });
  });

  it('leaves the ownership graph itself intact when screening is unavailable', async () => {
    global = await gleifOnly();
    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: '5493001KJTIIGC8Y1R12', screenNodes: true }),
      ctxFor(traceOwnershipTool.errors),
    );
    expect(result.nodes.map((node) => node.lei)).toEqual([
      '5493001KJTIIGC8Y1R12',
      '529900T8BM49AURSDO55',
    ]);
    for (const node of result.nodes) {
      expect(node.sanctionsHits).toBeUndefined();
      expect(node.sanctionsScreen).toBeUndefined();
    }
  });

  it('reports a healthy screen as completed on both tools, with no degradation signal', async () => {
    global = await seededGlobalService();

    const entity = await getEntityTool.handler(
      getEntityTool.input.parse({ lei: '5493001KJTIIGC8Y1R12' }),
      ctxFor(getEntityTool.errors),
    );
    expect(entity.screeningStatus).toBe('screened');
    expect(render(getEntityTool, entity)).not.toMatch(/did not run/i);

    // A completed screen that finds nothing still reads as completed.
    const unlisted = await getEntityTool.handler(
      getEntityTool.input.parse({ lei: '529900T8BM49AURSDO55' }),
      ctxFor(getEntityTool.errors),
    );
    expect(unlisted).toMatchObject({ screeningStatus: 'screened', sanctionsHits: [] });
    expect(render(getEntityTool, unlisted)).toContain(
      'No potential watchlist matches on any screened name or identifier (NOT a clearance).',
    );

    const graph = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: '5493001KJTIIGC8Y1R12', screenNodes: true }),
      ctxFor(traceOwnershipTool.errors),
    );
    expect(graph.screeningStatus).toBe('screened');
    expect(graph.screenedNodeCount).toBe(graph.nodes.length);
  });

  it('carries the ownership disclosure onto both response surfaces', async () => {
    global = await gleifOnly();
    const result = await runToolContract(traceOwnershipTool, {
      lei: '5493001KJTIIGC8Y1R12',
      screenNodes: true,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent as Record<string, unknown>).toMatchObject({
      screeningStatus: 'not_ready',
      complete: true,
      truncated: false,
      missingEntityLeis: [],
    });
    const text = contentText(result);
    expect(text).toMatch(/NOT run/);
    expect(text).toContain('**Graph coverage:** complete');
  });

  it('distinguishes screening never requested from screening unavailable', async () => {
    global = await seededGlobalService();
    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: '5493001KJTIIGC8Y1R12', screenNodes: false }),
      ctxFor(traceOwnershipTool.errors),
    );
    expect(result.screeningStatus).toBe('not_requested');
    expect(result.screenedNodeCount).toBe(0);
    for (const node of result.nodes) expect(node.sanctionsHits).toBeUndefined();
    expect(render(traceOwnershipTool, result)).toMatch(/not requested/i);
  });
});

function render<T>(
  definition: { format?: (result: T) => Array<{ type: string; text?: string }> },
  result: T,
): string {
  return (definition.format?.(result) ?? []).map((block) => block.text ?? '').join('\n');
}

/** Every text block of a full tool result — the formatter's output plus the trailer. */
function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}
