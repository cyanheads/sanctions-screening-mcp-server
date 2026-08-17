/**
 * @fileoverview Integration coverage for ownership traversal termination,
 * direction/depth bounds, missing Level 1 entities, and completeness reporting.
 * @module tests/integration/ownership-correctness.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import type {
  NormalizedDesignation,
  NormalizedLeiEntity,
  NormalizedLeiRelationship,
} from '@/services/screening/types.js';
import { type SeededService, seededGlobalService } from '../services/_helpers.js';

const ROOT = '5493001KJTIIGC8Y1R12';
const PARENT = '529900T8BM49AURSDO55';
const GRANDPARENT = '11111111111111111111';
const ULTIMATE = '22222222222222222222';
const MISSING = '33333333333333333333';

const ctx = () => createMockContext({ errors: traceOwnershipTool.errors });

/** Render a result through the tool's own `format()` — the content[] surface. */
const render = (result: Parameters<NonNullable<typeof traceOwnershipTool.format>>[0]): string =>
  (traceOwnershipTool.format?.(result) ?? [])
    .map((block) => ('text' in block ? (block.text ?? '') : ''))
    .join('\n');

const entity = (lei: string, legalName: string): NormalizedLeiEntity => ({
  lei,
  legalName,
  otherNames: [],
  status: 'ISSUED',
});

/**
 * Twelve designations published under one graph node's exact legal name, so that
 * node's per-node cross-reference overflows the ten-hit cap while every other
 * node in the same call stays under it.
 */
const cappedNodeDesignations: NormalizedDesignation[] = Array.from(
  { length: 12 },
  (_unused, index): NormalizedDesignation => ({
    id: `un:NODE-CAP-${index}`,
    source: 'un',
    sourceEntryId: `NODE-CAP-${index}`,
    entityType: 'organization',
    primaryName: 'Testland Holdings PLC',
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  }),
);

const relationship = (
  childLei: string,
  parentLei: string,
  relationshipType = 'IS_DIRECTLY_CONSOLIDATED_BY',
): NormalizedLeiRelationship => ({
  childLei,
  parentLei,
  relationshipType,
  relationshipStatus: 'ACTIVE',
});

describe('sanctions_trace_ownership graph behavior', () => {
  let global: SeededService;

  beforeEach(async () => {
    global = await seededGlobalService();
  });

  afterEach(async () => {
    await global.cleanup();
  });

  it('terminates and deduplicates nodes and edges in a cycle', async () => {
    await global.service.ingestLeiRelationships([relationship(PARENT, ROOT)]);
    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({
        lei: ROOT,
        direction: 'both',
        depth: 5,
      }),
      ctx(),
    );

    expect(result.nodes.map((node) => node.lei)).toEqual([ROOT, PARENT]);
    expect(new Set(result.nodes.map((node) => node.lei)).size).toBe(result.nodes.length);
    expect(new Set(result.edges.map((edge) => `${edge.childLei}|${edge.parentLei}`)).size).toBe(
      result.edges.length,
    );
    expect(result.edges).toHaveLength(2);
    // A cycle terminated by dedup is fully explored — never incomplete by itself.
    expect(result).toMatchObject({ complete: true, truncated: false, missingEntityLeis: [] });
  });

  it('honors depth without leaking nodes beyond the requested boundary', async () => {
    await global.service.ingestLeiEntities([
      entity(GRANDPARENT, 'Grandparent Holdings'),
      entity(ULTIMATE, 'Ultimate Holdings'),
    ]);
    await global.service.ingestLeiRelationships([
      relationship(PARENT, GRANDPARENT),
      relationship(GRANDPARENT, ULTIMATE),
    ]);

    const one = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: ROOT, direction: 'parents', depth: 1 }),
      ctx(),
    );
    expect(one.nodes.map((node) => node.lei)).toEqual([ROOT, PARENT]);
    // A boundary node with further published parents is genuine truncation.
    expect(one).toMatchObject({ complete: false, truncated: true, missingEntityLeis: [] });

    const two = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: ROOT, direction: 'parents', depth: 2 }),
      ctx(),
    );
    expect(two.nodes.map((node) => node.lei)).toEqual([ROOT, PARENT, GRANDPARENT]);
    expect(two.nodes.find((node) => node.lei === ULTIMATE)).toBeUndefined();
    expect(two).toMatchObject({ complete: false, truncated: true });

    const three = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: ROOT, direction: 'parents', depth: 3 }),
      ctx(),
    );
    expect(three.nodes.map((node) => node.lei)).toEqual([ROOT, PARENT, GRANDPARENT, ULTIMATE]);
    // The deepest node publishes no further parents, so the chain ends honestly
    // at the boundary rather than reading as cut off.
    expect(three).toMatchObject({ complete: true, truncated: false, missingEntityLeis: [] });
    expect(render(three)).toContain('complete');
  });

  it('returns a root-only graph when no relationships are published', async () => {
    const isolated = '44444444444444444444';
    await global.service.ingestLeiEntities([entity(isolated, 'Isolated Entity')]);
    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: isolated, direction: 'both', depth: 5 }),
      ctx(),
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      lei: isolated,
      legalName: 'Isolated Entity',
      depth: 0,
    });
    expect(result.edges).toHaveLength(0);
    expect(result).toMatchObject({ complete: true, truncated: false, missingEntityLeis: [] });
  });

  it('reports missing entities and a depth-truncated chain as incomplete', async () => {
    await global.service.ingestLeiEntities([entity(ULTIMATE, 'Ultimate Holdings')]);
    await global.service.ingestLeiRelationships([
      relationship(PARENT, MISSING),
      relationship(MISSING, ULTIMATE),
    ]);

    const callCtx = ctx();
    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: ROOT, direction: 'parents', depth: 2 }),
      callCtx,
    );
    expect({ ...result, ...getEnrichment(callCtx) }).toMatchObject({
      complete: false,
      truncated: true,
      missingEntityLeis: [MISSING],
    });
    const text = render(result);
    expect(text).toContain(MISSING);
    expect(text).toMatch(/truncated/i);
  });

  it('reports a fully explored chain with an unhydrated node at depth 3 as incomplete', async () => {
    await global.service.ingestLeiEntities([entity(GRANDPARENT, 'Grandparent Holdings')]);
    await global.service.ingestLeiRelationships([
      relationship(PARENT, GRANDPARENT),
      relationship(GRANDPARENT, MISSING),
    ]);

    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: ROOT, direction: 'parents', depth: 5 }),
      ctx(),
    );

    expect(result.nodes.map((node) => node.lei)).toEqual([ROOT, PARENT, GRANDPARENT, MISSING]);
    expect(result.nodes.find((node) => node.lei === MISSING)?.depth).toBe(3);
    // Nothing lies beyond the traversal, so the only defect is the unhydrated
    // node — the two completeness axes are reported independently.
    expect(result).toMatchObject({
      complete: false,
      truncated: false,
      missingEntityLeis: [MISSING],
    });
    // The hydration outcome identifies the node, never a legalName === lei compare.
    expect(result.nodes.find((node) => node.lei === MISSING)?.legalName).toBe(MISSING);
  });

  it('discloses a per-node screen capped at ten beside an uncapped one', async () => {
    await global.service.ingestDesignations(cappedNodeDesignations);

    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({
        lei: ROOT,
        direction: 'parents',
        depth: 1,
        screenNodes: true,
      }),
      ctx(),
    );

    const parent = result.nodes.find((node) => node.lei === PARENT);
    expect(parent?.sanctionsHits).toHaveLength(10);
    expect(parent?.sanctionsScreen).toEqual({
      totalAvailable: 12,
      totalAvailableBasis: 'exact',
      hasMore: true,
    });

    // Same call, a node whose whole match set fits: it must not read as capped.
    const root = result.nodes.find((node) => node.lei === ROOT);
    expect(root?.sanctionsHits).toHaveLength(1);
    expect(root?.sanctionsScreen).toEqual({
      totalAvailable: 1,
      totalAvailableBasis: 'exact',
      hasMore: false,
    });

    const text = render(result);
    expect(text).toContain('showing 10 of 12 potential match(es)');
    expect(text).toContain('showing 1 of 1 potential match(es)');
    expect(text).toContain('count basis: exact');
  });

  it('leaves a node with no potential matches uncapped and unflagged', async () => {
    const isolated = '44444444444444444444';
    await global.service.ingestLeiEntities([entity(isolated, 'Zzqxwv Qqpzm Unlisted Ltd')]);

    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: isolated, screenNodes: true }),
      ctx(),
    );

    expect(result.nodes[0]?.sanctionsHits).toEqual([]);
    expect(result.nodes[0]?.sanctionsScreen).toEqual({
      totalAvailable: 0,
      totalAvailableBasis: 'exact',
      hasMore: false,
    });
    expect(result.flaggedNodeCount).toBe(0);
    expect(render(result)).toContain('No potential matches (not a clearance).');
  });

  it('rejects a malformed root LEI at the input boundary', () => {
    expect(() => traceOwnershipTool.input.parse({ lei: 'not-an-lei' })).toThrow();
    expect(() => traceOwnershipTool.input.parse({ lei: ROOT, depth: 9 })).toThrow();
  });
});
