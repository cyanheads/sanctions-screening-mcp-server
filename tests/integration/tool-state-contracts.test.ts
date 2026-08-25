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

    const firstCtx = ctxFor(screenNameTool.errors);
    const first = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Overflow Candidate', limit: 1, offset: 0 }),
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
      screenNameTool.input.parse({ name: 'Overflow Candidate', limit: 1, offset: 1 }),
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
    expect(text).toContain('sanctions_screen_name');
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
    });
    const text = render(getEntityTool, result);
    expect(text).toContain('No potential watchlist matches on the legal name (NOT a clearance).');
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
    expect(text).not.toContain('No potential watchlist matches on the legal name');
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
      'No potential watchlist matches on the legal name (NOT a clearance).',
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
