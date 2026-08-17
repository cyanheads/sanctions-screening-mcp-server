/**
 * @fileoverview Tool-level tests over the seeded global service: handler output,
 * format() parity (the caveat and key fields reach content[]), the
 * decision-support framing, and the mirror-not-ready error contract.
 * @module tests/tools/screening-tools.test
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import {
  emptyGlobalService,
  type SeededService,
  seededGlobalService,
} from '../services/_helpers.js';

/**
 * A mock context whose typed `ctx.fail` is wired against a tool's error
 * contract. `const E` keeps the reason union intact, so the returned context
 * satisfies the `HandlerContext<Reason>` the handler declares.
 */
const ctxFor = <const E extends readonly ErrorContract[] | undefined>(errors: E) =>
  createMockContext({ errors });

describe('screening tools (seeded)', () => {
  let seeded: SeededService;
  beforeEach(async () => {
    seeded = await seededGlobalService();
  });
  afterEach(async () => {
    await seeded.cleanup();
  });

  it('screen_name returns scored hits and the decision-support caveat', async () => {
    const input = screenNameTool.input.parse({ name: 'Ivan Testovich Volkov' });
    const result = await screenNameTool.handler(input, ctxFor(screenNameTool.errors));
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.caveat).toMatch(/screening aid|not a compliance determination/i);

    const text = renderFormat(screenNameTool, result);
    expect(text).toContain('Ivan Testovich Volkov');
    expect(text).toMatch(/not a compliance determination/i);
  });

  it('screen_name surfaces the raw JW score for approximate hits in format()', async () => {
    const input = screenNameTool.input.parse({ name: 'Ivan Volkow', matchMode: 'fuzzy' });
    const result = await screenNameTool.handler(input, ctxFor(screenNameTool.errors));
    const approx = result.hits.find((h) => h.matchType === 'approximate');
    expect(approx?.score).toBeDefined();
    const text = renderFormat(screenNameTool, result);
    expect(text).toMatch(/score/i);
  });

  it('get_designation returns the full record with the caveat', async () => {
    const input = getDesignationTool.input.parse({ source: 'ofac_sdn', entryId: 'FX-1001' });
    const result = await getDesignationTool.handler(input, ctxFor(getDesignationTool.errors));
    expect(result.primaryName).toBe('Ivan Testovich Volkov');
    expect(result.aliases.length).toBeGreaterThan(0);
    expect(result.caveat).toBeTruthy();
  });

  it('get_designation throws the typed not-found error for an unknown entry', async () => {
    const input = getDesignationTool.input.parse({ source: 'ofac_sdn', entryId: 'MISSING' });
    await expect(
      getDesignationTool.handler(input, ctxFor(getDesignationTool.errors)),
    ).rejects.toMatchObject({ data: { reason: 'designation_not_found' } });
  });

  it('list_sources reports counts, readiness, and licenses', async () => {
    const result = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      createMockContext(),
    );
    expect(result.sanctionsReady).toBe(true);
    expect(result.leiReady).toBe(true);
    const uk = result.sources.find((s) => s.code === 'uk');
    expect(uk?.license).toMatch(/Open Government Licence/i);
    expect(result.sources.find((s) => s.code === 'gleif')?.license).toMatch(/CC0/i);
  });

  it('resolve_entity returns ranked LEI candidates', async () => {
    const input = resolveEntityTool.input.parse({ name: 'Fictional Trading Company LLC' });
    const result = await resolveEntityTool.handler(input, ctxFor(resolveEntityTool.errors));
    expect(result.matches[0]?.lei).toBe('5493001KJTIIGC8Y1R12');
  });

  it('get_entity returns the GLEIF record plus a sanctions cross-reference', async () => {
    const input = getEntityTool.input.parse({ lei: '5493001KJTIIGC8Y1R12' });
    const result = await getEntityTool.handler(input, ctxFor(getEntityTool.errors));
    expect(result.legalName).toBe('Fictional Trading Company LLC');
    // Its legal name matches the OFAC consolidated fixture designation.
    expect(result.sanctionsHits.length).toBeGreaterThan(0);
    expect(result.caveat).toBeTruthy();
  });

  it('trace_ownership walks the graph and screens nodes when asked', async () => {
    const input = traceOwnershipTool.input.parse({
      lei: '5493001KJTIIGC8Y1R12',
      direction: 'both',
      screenNodes: true,
    });
    const result = await traceOwnershipTool.handler(input, ctxFor(traceOwnershipTool.errors));
    expect(result.nodes.length).toBeGreaterThanOrEqual(2); // root + parent
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.screenedNodeCount).toBe(result.nodes.length);
    // The root entity's name collides with a fixture designation → flagged.
    expect(result.flaggedNodeCount).toBeGreaterThan(0);
  });

  it('trace_ownership throws not-found for an unknown root LEI', async () => {
    const input = traceOwnershipTool.input.parse({ lei: '00000000000000000000' });
    await expect(
      traceOwnershipTool.handler(input, ctxFor(traceOwnershipTool.errors)),
    ).rejects.toMatchObject({ data: { reason: 'lei_not_found' } });
  });
});

describe('query-token coverage on both client surfaces (issue #15)', () => {
  let seeded: SeededService;
  beforeEach(async () => {
    seeded = await seededGlobalService();
  });
  afterEach(async () => {
    await seeded.cleanup();
  });

  it('screen_name carries coverage in structuredContent and renders it in format()', async () => {
    const input = screenNameTool.input.parse({ name: 'Ivan Volkow', matchMode: 'fuzzy' });
    const result = await screenNameTool.handler(input, ctxFor(screenNameTool.errors));
    const approx = result.hits.find((h) => h.matchType === 'approximate');
    expect(approx?.queryTokenCoverage).toEqual({ covered: 2, total: 2 });
    expect(renderFormat(screenNameTool, result)).toContain('covers 2/2 query tokens');
  });

  it('screen_name omits coverage for an exact hit on both surfaces', async () => {
    const input = screenNameTool.input.parse({ name: 'Ivan Testovich Volkov' });
    const result = await screenNameTool.handler(input, ctxFor(screenNameTool.errors));
    expect(result.hits.every((h) => h.queryTokenCoverage === undefined)).toBe(true);
    expect(renderFormat(screenNameTool, result)).not.toContain('query tokens');
  });

  it('screen_name renders no coverage for an empty result or a page past the end', async () => {
    const empty = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Zzqxwv Qqpzm Unlisted' }),
      ctxFor(screenNameTool.errors),
    );
    expect(empty.hits).toHaveLength(0);
    expect(renderFormat(screenNameTool, empty)).not.toContain('query tokens');

    const pastEnd = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Ivan Volkow', matchMode: 'fuzzy', offset: 99 }),
      ctxFor(screenNameTool.errors),
    );
    expect(pastEnd.hits).toHaveLength(0);
    expect(renderFormat(screenNameTool, pastEnd)).not.toContain('query tokens');
  });

  it('screen_name keeps coverage on every hit of a capped page', async () => {
    // Three designations tie at score 1.0 on the exact token "marenko" and each
    // cover 2 of 3 query tokens, so the page cap binds with the tie still live.
    await seeded.service.ingestDesignations(
      ['Sorel', 'Torres', 'Vasquez'].map((surname) => ({
        id: `un:CAP-${surname}`,
        source: 'un' as const,
        sourceEntryId: `CAP-${surname}`,
        entityType: 'person' as const,
        primaryName: `Ludvik Marenko ${surname}`,
        payload: {
          aliases: [],
          identifiers: [],
          addresses: [],
          datesOfBirth: [],
          nationalities: [],
        },
      })),
    );

    const input = screenNameTool.input.parse({
      name: 'Ludvig Marenko Qqzz',
      matchMode: 'fuzzy',
      limit: 2,
    });
    const result = await screenNameTool.handler(input, ctxFor(screenNameTool.errors));
    expect(result.hits).toHaveLength(2);
    for (const hit of result.hits) {
      expect(hit.queryTokenCoverage).toEqual({ covered: 2, total: 3 });
    }
    expect(renderFormat(screenNameTool, result)).toContain('covers 2/3 query tokens');
  });

  it('rejects an out-of-range minScore before the handler ever runs', () => {
    expect(() => screenNameTool.input.parse({ name: 'Ivan Volkow', minScore: 2 })).toThrow();
    expect(() => resolveEntityTool.input.parse({ name: 'Fictional', minScore: -1 })).toThrow();
  });

  it('resolve_entity carries coverage in structuredContent and renders it in format()', async () => {
    const input = resolveEntityTool.input.parse({
      name: 'Fictionel Trading Compny',
      matchMode: 'fuzzy',
      status: 'any',
    });
    const result = await resolveEntityTool.handler(input, ctxFor(resolveEntityTool.errors));
    const approx = result.matches.find((m) => m.matchType === 'approximate');
    expect(approx?.queryTokenCoverage?.total).toBe(3);
    expect(approx!.queryTokenCoverage!.covered).toBeGreaterThan(0);
    expect(approx!.queryTokenCoverage!.covered).toBeLessThanOrEqual(3);
    expect(renderFormat(resolveEntityTool, result)).toContain(
      `covers ${approx!.queryTokenCoverage!.covered}/3 query tokens`,
    );
  });

  it('resolve_entity omits coverage for an exact match on both surfaces', async () => {
    const input = resolveEntityTool.input.parse({ name: 'Fictional Trading Company LLC' });
    const result = await resolveEntityTool.handler(input, ctxFor(resolveEntityTool.errors));
    expect(result.matches[0]?.matchType).toBe('exact');
    expect(result.matches[0]?.queryTokenCoverage).toBeUndefined();
    expect(renderFormat(resolveEntityTool, result)).not.toContain('query tokens');
  });
});

describe('screening tools (not ready)', () => {
  let empty: SeededService;
  beforeEach(async () => {
    empty = await emptyGlobalService();
  });
  afterEach(async () => {
    await empty.cleanup();
  });

  it('screen_name throws the mirror-not-ready contract before any sync', async () => {
    const input = screenNameTool.input.parse({ name: 'anyone' });
    await expect(
      screenNameTool.handler(input, ctxFor(screenNameTool.errors)),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
  });

  it('resolve_entity throws the mirror-not-ready contract before any sync', async () => {
    const input = resolveEntityTool.input.parse({ name: 'anyone' });
    await expect(
      resolveEntityTool.handler(input, ctxFor(resolveEntityTool.errors)),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
  });
});

/** Render a tool's format() output to a single string for content[] assertions. */
function renderFormat<T>(
  tool: { format?: (result: T) => Array<{ type: string; text?: string }> },
  result: T,
): string {
  if (!tool.format) return '';
  return tool
    .format(result)
    .map((c) => c.text ?? '')
    .join('\n');
}
