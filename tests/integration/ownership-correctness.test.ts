/**
 * @fileoverview Integration coverage for ownership traversal termination,
 * direction/depth bounds, missing Level 1 entities, completeness reporting, and
 * the per-node parent status a walk reports from Level 2 and GLEIF's reporting
 * exceptions.
 * @module tests/integration/ownership-correctness.test
 */

import { execFileSync } from 'node:child_process';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCREENING_CAVEAT } from '@/mcp-server/tools/definitions/_shared.js';
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
    // A direct ROOT → PARENT link: the fixture's own row is ultimate-only, and an
    // ultimate edge never extends a walk.
    await global.service.ingestLeiRelationships([
      relationship(ROOT, PARENT),
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
      relationship(ROOT, PARENT),
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
      relationship(ROOT, PARENT),
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
      screenedInputs: [
        { input: 'other_name', value: 'Testland Holdings', nameType: 'TRADING_OR_OPERATING_NAME' },
        { input: 'registration_number', value: 'TEST-REG-2' },
      ],
    });

    // Same call, a node whose whole match set fits: it must not read as capped.
    const root = result.nodes.find((node) => node.lei === ROOT);
    expect(root?.sanctionsHits).toHaveLength(1);
    expect(root?.sanctionsScreen).toEqual({
      totalAvailable: 1,
      totalAvailableBasis: 'exact',
      hasMore: false,
      screenedInputs: [
        { input: 'other_name', value: 'Fictional Trading Co', nameType: 'PREVIOUS_LEGAL_NAME' },
        { input: 'registration_number', value: 'TEST-REG-1' },
      ],
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
      screenedInputs: [],
    });
    expect(result.flaggedNodeCount).toBe(0);
    expect(render(result)).toContain(
      '· screen: no potential matches (not a clearance), 0 of 0 (count basis: exact)',
    );
    expect(render(result)).toContain('screened 1 node(s); 0 had potential matches; 0 capped.');
  });

  it('pins the graph shape of a multi-level walk in both directions (characterization)', async () => {
    await global.service.ingestLeiEntities([
      entity(GRANDPARENT, 'Grandparent Holdings'),
      entity(ULTIMATE, 'Ultimate Holdings'),
    ]);
    await global.service.ingestLeiRelationships([
      relationship(ROOT, PARENT),
      relationship(PARENT, GRANDPARENT),
      relationship(GRANDPARENT, ULTIMATE, 'IS_ULTIMATELY_CONSOLIDATED_BY'),
    ]);

    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: ROOT, direction: 'both', depth: 3 }),
      ctx(),
    );

    expect(
      result.nodes.map(({ lei, legalName, depth, role, jurisdiction, status, reachedVia }) => ({
        lei,
        legalName,
        depth,
        role,
        jurisdiction,
        status,
        reachedVia,
      })),
    ).toEqual([
      {
        lei: ROOT,
        legalName: 'Fictional Trading Company LLC',
        depth: 0,
        role: 'root',
        jurisdiction: 'US',
        status: 'ISSUED',
        reachedVia: undefined,
      },
      {
        lei: PARENT,
        legalName: 'Testland Holdings PLC',
        depth: 1,
        role: 'parent',
        jurisdiction: 'GB',
        status: 'ISSUED',
        reachedVia: undefined,
      },
      {
        lei: GRANDPARENT,
        legalName: 'Grandparent Holdings',
        depth: 2,
        role: 'parent',
        jurisdiction: undefined,
        status: 'ISSUED',
        reachedVia: undefined,
      },
      // Only GRANDPARENT's ultimate edge reaches it: a leaf, flagged, its depth that one hop.
      {
        lei: ULTIMATE,
        legalName: 'Ultimate Holdings',
        depth: 3,
        role: 'parent',
        jurisdiction: undefined,
        status: 'ISSUED',
        reachedVia: 'ultimate',
      },
    ]);
    expect(result.edges).toEqual([
      {
        childLei: GRANDPARENT,
        parentLei: ULTIMATE,
        relationshipType: 'IS_ULTIMATELY_CONSOLIDATED_BY',
        relationshipStatus: 'ACTIVE',
      },
      {
        childLei: PARENT,
        parentLei: GRANDPARENT,
        relationshipType: 'IS_DIRECTLY_CONSOLIDATED_BY',
        relationshipStatus: 'ACTIVE',
      },
      {
        childLei: ROOT,
        parentLei: PARENT,
        relationshipType: 'IS_DIRECTLY_CONSOLIDATED_BY',
        relationshipStatus: 'ACTIVE',
      },
      {
        childLei: ROOT,
        parentLei: PARENT,
        relationshipType: 'IS_ULTIMATELY_CONSOLIDATED_BY',
        relationshipStatus: 'ACTIVE',
      },
    ]);
    expect(result).toMatchObject({
      complete: true,
      truncated: false,
      missingEntityLeis: [],
      screeningStatus: 'not_requested',
      screenedNodeCount: 0,
      flaggedNodeCount: 0,
    });
  });

  it('rejects a malformed root LEI at the input boundary', () => {
    expect(() => traceOwnershipTool.input.parse({ lei: 'not-an-lei' })).toThrow();
    expect(() => traceOwnershipTool.input.parse({ lei: ROOT, depth: 9 })).toThrow();
  });
});

/** A synthetic 20-character LEI: the tag, zero-padded to 18 characters, then two digits. */
const lei = (tag: string): string => `${tag.padEnd(18, '0')}00`;
const ULT = 'IS_ULTIMATELY_CONSOLIDATED_BY';

describe('ownership segment pagination', () => {
  let global: SeededService;
  beforeEach(async () => {
    global = await seededGlobalService();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await global.cleanup();
  });
  const trace = (input: Record<string, unknown>) =>
    traceOwnershipTool.handler(traceOwnershipTool.input.parse(input), ctx());

  it('reconstructs a deterministic multi-level cycle without repeating nodes or edges', async () => {
    const a = lei('PAGEA');
    const b = lei('PAGEB');
    const c = lei('PAGEC');
    await global.service.ingestLeiEntities([
      entity(a, 'Page A'),
      entity(b, 'Page B'),
      entity(c, 'Page C'),
    ]);
    await global.service.ingestLeiRelationships([
      relationship(c, b),
      relationship(b, a),
      relationship(a, c),
      relationship(c, a),
    ]);
    const query = { lei: a, direction: 'both', depth: 5, screenNodes: true, limit: 2 };
    const nameScreens = vi.spyOn(global.service, 'screenName');
    const identifierScreens = vi.spyOn(global.service, 'screenIdentifier');
    const hydration = vi.spyOn(global.service, 'getLeiEntitiesBatch');
    const pages = [await trace(query)];
    while (pages.at(-1)?.hasMore) {
      const before = [
        nameScreens.mock.calls.length,
        identifierScreens.mock.calls.length,
        hydration.mock.calls.length,
      ];
      pages.push(await trace({ ...query, cursor: pages.at(-1)?.nextCursor }));
      if (!pages.at(-1)?.nodes.length) {
        expect([
          nameScreens.mock.calls.length,
          identifierScreens.mock.calls.length,
          hydration.mock.calls.length,
        ]).toEqual(before);
      }
      expect(pages.length).toBeLessThan(10);
    }
    expect(pages.map((p) => p.nodes.length + p.edges.length + p.boundaries.length)).toEqual([
      2, 2, 2, 1,
    ]);
    // Parents-side placement wins: c is one parent hop, b is two, even though children reaches b first.
    expect(pages.flatMap((p) => p.nodes.map((n) => n.lei))).toEqual([a, c, b]);
    expect(pages.flatMap((p) => p.edges)).toEqual([
      { ...relationship(a, c) },
      { ...relationship(b, a) },
      { ...relationship(c, a) },
      { ...relationship(c, b) },
    ]);
    expect(pages[0]).toMatchObject({
      totalAvailable: 7,
      totalAvailableBasis: 'exact',
      complete: false,
      truncated: true,
      truncationReasons: ['page_limit'],
    });
    expect(pages.at(-1)).toMatchObject({ hasMore: false, complete: true, truncated: false });
    expect(pages.at(-1)).not.toHaveProperty('nextCursor');
    expect(pages.reduce((n, p) => n + p.screenedNodeCount, 0)).toBe(3);
    expect(hydration.mock.calls.flatMap((call) => call[0])).toEqual([a, c, b]);
    for (const page of pages) {
      expect(page.caveat).toBe(SCREENING_CAVEAT);
      expect(render(page)).toContain('totalAvailable: 7');
      expect(render(page)).toContain(`hasMore: ${page.hasMore}`);
      if (page.nextCursor) expect(render(page)).toContain(page.nextCursor);
      if (!page.nodes.length)
        expect(page).toMatchObject({
          screenedNodeCount: 0,
          flaggedNodeCount: 0,
          screeningStatus: 'screened',
        });
    }
    expect(render(pages[0]!)).toContain('elsewhere in the assembled graph');
  });

  it('keeps segment-wide missing hydration on edge-only and empty terminal pages', async () => {
    await global.service.ingestLeiRelationships([relationship(MISSING, ROOT)]);
    const query = { lei: ROOT, direction: 'children', limit: 1 };
    const first = await trace(query);
    const second = await trace({ ...query, cursor: first.nextCursor });
    const last = await trace({ ...query, cursor: second.nextCursor });
    expect(second).toMatchObject({ missingEntityLeis: [MISSING], missingEntityCount: 1 });
    expect(last).toMatchObject({
      nodes: [],
      complete: false,
      missingEntityLeis: [],
      missingEntityCount: 1,
      hasMore: false,
    });
    const payload = JSON.parse(Buffer.from(second.nextCursor!, 'base64url').toString());
    payload.offset = last.totalAvailable;
    const terminal = await trace({
      ...query,
      cursor: Buffer.from(JSON.stringify(payload)).toString('base64url'),
    });
    expect(terminal).toMatchObject({
      nodes: [],
      edges: [],
      boundaries: [],
      hasMore: false,
      complete: false,
    });
    payload.offset++;
    await expect(
      trace({ ...query, cursor: Buffer.from(JSON.stringify(payload)).toString('base64url') }),
    ).rejects.toMatchObject({ data: { reason: 'invalid_cursor' } });
  });

  it('returns side-specific depth-five and ultimate-leaf recovery, including missing Level 1 roots', async () => {
    const chain = [ROOT, ...Array.from({ length: 6 }, (_, i) => lei(`DEPTH${i}`))];
    await global.service.ingestLeiRelationships(
      chain.slice(1).map((id, i) => relationship(chain[i]!, id)),
    );
    const result = await trace({ lei: ROOT, direction: 'parents', depth: 5 });
    expect(result.boundaries).toEqual([
      { lei: chain[5], direction: 'parents', reason: 'depth_limit', depth: 5 },
    ]);
    expect(result.truncationReasons).toEqual(['depth_limit']);
    const boundary = result.boundaries[0]!;
    const branch = await trace({
      lei: boundary.lei,
      direction: boundary.direction,
      depth: boundary.depth,
    });
    expect(branch.nodes.map((n) => n.lei)).toEqual([chain[5], chain[6]]);
    expect(branch.nodes[0]).toMatchObject({ depth: 0, role: 'root', legalName: chain[5] });
    expect(render(result)).toContain(
      JSON.stringify({ lei: chain[5], direction: 'parents', depth: 5 }),
    );
    await global.service.ingestLeiRelationships([relationship(PARENT, MISSING)]);
    const leaf = await trace({ lei: ROOT, direction: 'parents', depth: 1 });
    expect(leaf.boundaries).toContainEqual({
      lei: PARENT,
      direction: 'parents',
      reason: 'ultimate_leaf',
      depth: 1,
    });
    const resumed = await trace({ lei: PARENT, direction: 'parents', depth: 1 });
    expect(resumed.nodes.some((n) => n.lei === MISSING)).toBe(true);
  });

  it('rejects corrupt, query-mismatched and changed-topology cursors, but accepts current-value changes', async () => {
    const query = { lei: ROOT, limit: 1 };
    const first = await trace(query);
    await expect(trace({ ...query, cursor: 'broken' })).rejects.toMatchObject({
      data: { reason: 'invalid_cursor' },
    });
    await expect(trace({ ...query, depth: 4, cursor: first.nextCursor })).rejects.toMatchObject({
      data: { reason: 'invalid_cursor' },
    });
    await global.service.ingestLeiEntities([entity(PARENT, 'Renamed Parent')]);
    expect((await trace({ ...query, cursor: first.nextCursor })).nodes[0]?.legalName).toBe(
      'Renamed Parent',
    );
    await global.service.ingestLeiRelationships([relationship(ROOT, MISSING)]);
    await expect(trace({ ...query, cursor: first.nextCursor })).rejects.toMatchObject({
      data: { reason: 'stale_cursor' },
    });
  });

  it.each(['', ' \n\t'])(
    'treats a blank optional cursor %j as an initial request',
    async (cursor) => {
      const page = await trace({ lei: ROOT, limit: 1, cursor });
      expect(page.nodes.map((n) => n.lei)).toEqual([ROOT]);
      expect(page).toMatchObject({ hasMore: true, totalAvailable: 3 });
      expect(render(page)).toContain(page.nextCursor!);
      await expect(
        trace({ lei: ROOT, limit: 1, cursor: ` ${page.nextCursor} ` }),
      ).rejects.toMatchObject({ data: { reason: 'invalid_cursor' } });
    },
  );

  it('resumes the same topology in a fresh process without a signing key or cached snapshot', async () => {
    const query = { lei: ROOT, limit: 1 };
    const first = await trace(query);
    const input = { ...query, cursor: first.nextCursor };
    const script = `import {traceOwnershipTool as tool} from './src/mcp-server/tools/definitions/trace-ownership.tool.ts'; import {initScreeningService,getScreeningService} from './src/services/screening/screening-service.ts'; import {createMockContext} from '@cyanheads/mcp-ts-core/testing'; initScreeningService(); try {const page=await tool.handler(tool.input.parse(${JSON.stringify(input)}),createMockContext({errors:tool.errors})); process.stdout.write(JSON.stringify(page));} finally {await getScreeningService().close();}`;
    const page = JSON.parse(
      execFileSync('bun', ['--eval', script], { encoding: 'utf8', timeout: 10_000 }),
    );
    expect(page).toMatchObject({ rootLei: ROOT, totalAvailable: 3, hasMore: true });
    expect(page.nodes.map((node: { lei: string }) => node.lei)).toEqual([PARENT]);
    expect(render(page)).toContain(page.nextCursor);
  });

  it('paginates a dense cyclic graph in canonical order, including the edge-only tail', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => lei(`DENSE${String(i).padStart(2, '0')}`));
    await global.service.ingestLeiEntities(ids.map((id) => entity(id, id)));
    const rows = ids.flatMap((child) =>
      ids.filter((parent) => parent !== child).map((parent) => relationship(child, parent)),
    );
    await global.service.ingestLeiRelationships(rows.toReversed());
    const query = { lei: ids[0], direction: 'both', depth: 5, limit: 50 };
    const pages = [await trace(query)];
    while (pages.at(-1)?.hasMore)
      pages.push(await trace({ ...query, cursor: pages.at(-1)?.nextCursor }));
    expect(pages.map((p) => p.nodes.length + p.edges.length + p.boundaries.length)).toEqual([
      50, 50, 44,
    ]);
    expect(pages.flatMap((p) => p.nodes.map((n) => n.lei))).toEqual(ids);
    expect(pages.flatMap((p) => p.edges)).toEqual(rows);
    expect(pages.flatMap((p) => p.boundaries)).toEqual([]);
    expect(pages.at(-1)).toMatchObject({ complete: true, truncated: false, totalAvailable: 144 });
  });

  it('reports a root-only page and an empty continuation truthfully', async () => {
    const id = lei('ISOLATEDPAGE');
    await global.service.ingestLeiEntities([entity(id, 'Isolated Page')]);
    const first = await trace({ lei: id, limit: 1 });
    expect(first).toMatchObject({
      totalAvailable: 1,
      boundaries: [],
      hasMore: false,
      complete: true,
      byteTargetExceeded: false,
    });
    expect(render(first)).toContain('hasMore: false');
    // Obtain a well-shaped cursor for this topology by the public read-only cursor format.
    // A caller may request its terminal offset; there are no remaining records to repeat.
    const query = { lei: ROOT, limit: 1 };
    const initial = await trace(query);
    const cursor = JSON.parse(Buffer.from(initial.nextCursor!, 'base64url').toString());
    cursor.offset = initial.totalAvailable;
    const terminal = await trace({
      ...query,
      cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url'),
    });
    expect(terminal).toMatchObject({
      nodes: [],
      edges: [],
      boundaries: [],
      complete: true,
      hasMore: false,
      screenedNodeCount: 0,
    });
    expect(render(terminal)).toContain('**0 node(s), 0 edge(s).**');
  });

  it('emits an oversized screened record intact before stopping, never screening an omitted node', async () => {
    const name = 'Z'.repeat(40_000);
    await global.service.ingestLeiEntities([entity(ROOT, name)]);
    const batch = vi.spyOn(global.service, 'getLeiEntitiesBatch');
    const result = await trace({ lei: ROOT, screenNodes: true });
    expect(result).toMatchObject({ byteTargetExceeded: true, screenedNodeCount: 1, hasMore: true });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.legalName).toBe(name);
    expect(batch.mock.calls.flatMap((c) => c[0])).toEqual([ROOT]);
    expect(render(result)).toContain(name);
    expect(render(result)).toContain('byteTargetExceeded: true');
    const clamped = await runToolContract(traceOwnershipTool, {
      lei: ROOT,
      screenNodes: true,
      limit: 500,
    });
    expect(clamped.structuredContent).toMatchObject({
      byteTargetExceeded: true,
      screenedNodeCount: 1,
      notice: 'Requested limit 500 clamped to 100 records.',
    });
    expect(
      Buffer.byteLength(
        JSON.stringify({ structuredContent: clamped.structuredContent, content: clamped.content }),
      ),
    ).toBeGreaterThan(65536);
  });

  it('keeps ultimate-leaf recovery actionable on edge-only and boundary-only pages', async () => {
    await global.service.ingestLeiRelationships([relationship(PARENT, MISSING)]);
    const query = { lei: ROOT, direction: 'parents', depth: 5, limit: 1, screenNodes: true };
    const pages = [await trace(query)];
    while (pages.at(-1)?.hasMore)
      pages.push(await trace({ ...query, cursor: pages.at(-1)?.nextCursor }));
    expect(pages.map((p) => [p.nodes.length, p.edges.length, p.boundaries.length])).toEqual([
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    for (const page of pages) {
      const text = render(page);
      expect(text).toContain('ultimate-parent edge, which is never walked');
      expect(text).not.toContain('Re-run with a higher depth');
      expect(text).not.toContain('A higher depth');
      expect(page).toMatchObject({
        screeningStatus: 'screened',
        truncationReasons: expect.arrayContaining(['ultimate_leaf']),
      });
    }
    const boundary = pages.at(-1)!.boundaries[0]!;
    const branch = await trace({
      lei: boundary.lei,
      direction: boundary.direction,
      depth: boundary.depth,
      screenNodes: true,
    });
    expect(branch.nodes.some((n) => n.lei === MISSING)).toBe(true);
    expect(pages.at(-1)).toMatchObject({ hasMore: false, screenedNodeCount: 0 });
  });

  it('probes both sides of an ultimate-only leaf without changing parents-side placement', async () => {
    const root = lei('DUALROOT');
    const leaf = lei('DUALLEAF');
    const omitted = lei('DUALOMITTED');
    await global.service.ingestLeiEntities([entity(root, 'Dual Root'), entity(leaf, 'Dual Leaf')]);
    await global.service.ingestLeiRelationships([
      relationship(root, leaf, ULT),
      relationship(leaf, root, ULT),
      relationship(omitted, leaf),
    ]);
    const result = await trace({ lei: root, direction: 'both', depth: 3 });
    expect(
      result.nodes.map((n) => ({
        lei: n.lei,
        depth: n.depth,
        role: n.role,
        reachedVia: n.reachedVia,
      })),
    ).toEqual([
      { lei: root, depth: 0, role: 'root', reachedVia: undefined },
      { lei: leaf, depth: 1, role: 'parent', reachedVia: 'ultimate' },
    ]);
    expect(result.boundaries).toEqual([
      { lei: leaf, direction: 'children', reason: 'ultimate_leaf', depth: 3 },
    ]);
    expect(result).toMatchObject({ complete: false, truncated: true, hasMore: false });
    const boundary = result.boundaries[0]!;
    const resumed = await trace({
      lei: boundary.lei,
      direction: boundary.direction,
      depth: boundary.depth,
    });
    expect(resumed.nodes.map((n) => n.lei)).toEqual([leaf, omitted, root]);
    expect(resumed.missingEntityLeis).toEqual([omitted]);
  });

  it('enforces default and maximum record counts with a visible clamp notice', async () => {
    const children = Array.from({ length: 120 }, (_, i) =>
      lei(`CHILD${String(i).padStart(3, '0')}`),
    );
    await global.service.ingestLeiRelationships(children.map((id) => relationship(id, ROOT)));
    const initial = await trace({ lei: ROOT, direction: 'children' });
    expect(initial.nodes).toHaveLength(50);
    expect(initial.totalAvailable).toBe(241);
    const capped = await runToolContract(traceOwnershipTool, {
      lei: ROOT,
      direction: 'children',
      limit: 500,
    });
    const domain = traceOwnershipTool.output.parse(capped.structuredContent);
    expect(domain.nodes).toHaveLength(100);
    expect(capped.structuredContent).toMatchObject({
      notice: 'Requested limit 500 clamped to 100 records.',
    });
    const text = capped.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('Requested limit 500 clamped to 100 records.');
    expect(domain.byteTargetExceeded).toBe(
      Buffer.byteLength(
        JSON.stringify({ structuredContent: capped.structuredContent, content: capped.content }),
      ) > 65536,
    );
    expect(() => traceOwnershipTool.input.parse({ lei: ROOT, limit: 0 })).toThrow();
  });
});

describe('sanctions_trace_ownership walk sides and ultimate edges (issues #38, #58)', () => {
  let global: SeededService;

  beforeEach(async () => {
    global = await seededGlobalService();
  });

  afterEach(async () => {
    await global.cleanup();
  });

  const trace = (input: Record<string, unknown>) =>
    traceOwnershipTool.handler(traceOwnershipTool.input.parse(input), ctx());
  type Trace = Awaited<ReturnType<typeof trace>>;
  const nodeOf = (result: Trace, id: string) => result.nodes.find((node) => node.lei === id);
  /** depth, role, and the ultimate flag of every node, keyed by LEI. */
  const placement = (result: Trace) =>
    Object.fromEntries(
      result.nodes.map((node) => [
        node.lei,
        `${node.role} ${node.depth}${node.reachedVia ? ` ${node.reachedVia}` : ''}`,
      ]),
    );
  const expectEdgesJoinNodes = (result: Trace) => {
    const ids = new Set(result.nodes.map((node) => node.lei));
    for (const edge of result.edges) {
      expect([ids.has(edge.childLei), ids.has(edge.parentLei)]).toEqual([true, true]);
    }
  };
  const seed = async (names: Record<string, string>, rows: NormalizedLeiRelationship[]) => {
    await global.service.ingestLeiEntities(
      Object.entries(names).map(([id, name]) => entity(id, name)),
    );
    await global.service.ingestLeiRelationships(rows);
  };

  // Apple-shaped group: the head directly owns AOIL and CHILE, AOIL owns SOUTH
  // ASIA, SOUTH ASIA owns JAPAN, and every member's ultimate parent is the head.
  const HEAD = lei('APPLEINC');
  const AOIL = lei('AOIL');
  const CHILE = lei('APPLECHILE');
  const ASIA = lei('APPLESOUTHASIA');
  const JAPAN = lei('APPLEJAPAN');
  const seedGroup = () =>
    seed(
      {
        [HEAD]: 'Apple Inc.',
        [AOIL]: 'Apple Operations International Limited',
        [CHILE]: 'Apple Chile Comercial Limitada',
        [ASIA]: 'Apple South Asia Pte. Ltd.',
        [JAPAN]: 'Apple Japan',
      },
      [
        // Ultimate rows first, so a children query meets each one before the direct row.
        relationship(AOIL, HEAD, ULT),
        relationship(CHILE, HEAD, ULT),
        relationship(ASIA, HEAD, ULT),
        relationship(JAPAN, HEAD, ULT),
        relationship(AOIL, HEAD),
        relationship(CHILE, HEAD),
        relationship(ASIA, AOIL),
        relationship(JAPAN, ASIA),
      ],
    );

  it('walks only up from the root on the parents side of both, never into siblings', async () => {
    const CANADA = lei('APPLECANADA');
    const UK = lei('APPLEUK');
    await seedGroup();
    await seed({ [CANADA]: 'Apple Canada Inc.', [UK]: 'Apple (UK) Limited' }, [
      relationship(CANADA, HEAD),
      relationship(CANADA, HEAD, ULT),
      relationship(UK, AOIL),
      relationship(UK, HEAD, ULT),
    ]);

    for (const depth of [1, 2]) {
      const result = await trace({ lei: CANADA, direction: 'both', depth });
      expect(placement(result)).toEqual({ [CANADA]: 'root 0', [HEAD]: 'parent 1' });
      expect(result.edges).toHaveLength(2);
      expectEdgesJoinNodes(result);
      // The head's other children are beside the root, not past the depth.
      expect(result).toMatchObject({ complete: true, truncated: false, missingEntityLeis: [] });
    }

    const screened = await trace({ lei: CANADA, direction: 'both', depth: 2, screenNodes: true });
    expect(screened.screenedNodeCount).toBe(screened.nodes.length);
    expect(screened.nodes.every((node) => node.sanctionsScreen !== undefined)).toBe(true);
  });

  it("walks only down on the children side of both, never into a descendant's other parents", async () => {
    const UMBRELLA = lei('UMBRELLAFUND');
    const SUBFUND = lei('SUBFUND');
    const MANAGER = lei('FUNDMANAGER');
    const OTHER_FUND = lei('OTHERFUND');
    const CONSOLIDATOR = lei('CONSOLIDATOR');
    await seed(
      {
        [UMBRELLA]: 'Umbrella Fund SICAV',
        [SUBFUND]: 'Umbrella Fund SICAV - Global Equity',
        [MANAGER]: 'Fund Manager S.A.',
        [OTHER_FUND]: 'Other Managed Fund',
        [CONSOLIDATOR]: 'Consolidating Parent AG',
      },
      [
        relationship(SUBFUND, UMBRELLA, 'IS_SUBFUND_OF'),
        relationship(SUBFUND, MANAGER, 'IS_FUND-MANAGED_BY'),
        relationship(OTHER_FUND, MANAGER, 'IS_FUND-MANAGED_BY'),
        relationship(SUBFUND, CONSOLIDATOR),
      ],
    );

    const result = await trace({ lei: UMBRELLA, direction: 'both', depth: 2 });

    expect(placement(result)).toEqual({ [UMBRELLA]: 'root 0', [SUBFUND]: 'child 1' });
    expect(result.edges).toEqual([
      {
        childLei: SUBFUND,
        parentLei: UMBRELLA,
        relationshipType: 'IS_SUBFUND_OF',
        relationshipStatus: 'ACTIVE',
      },
    ]);
    expect(result).toMatchObject({ complete: true, truncated: false });
    // Its own parent rows are read for its status, without walking them.
    expect(nodeOf(result, SUBFUND)?.parentStatus).toEqual({
      direct: { status: 'relationship' },
      ultimate: { status: 'none' },
    });
    // That published direct parent is not in this graph, and content[] says so.
    expect(render(result)).toContain(
      '· parents — direct: relationship (parent not in this graph); ultimate: none published',
    );

    // The same fund's manager, umbrella, and consolidator are one hop up a parents walk.
    const up = await trace({ lei: SUBFUND, direction: 'parents', depth: 1 });
    expect(placement(up)).toEqual({
      [SUBFUND]: 'root 0',
      [UMBRELLA]: 'parent 1',
      [MANAGER]: 'parent 1',
      [CONSOLIDATOR]: 'parent 1',
    });
  });

  it('returns a node both walks reach once, with the parents role, whatever the row order', async () => {
    const A = lei('CYCLEA');
    const B = lei('CYCLEB');
    await seed({ [A]: 'Cycle A Holdings', [B]: 'Cycle B Holdings' }, [
      relationship(B, A),
      relationship(A, B),
    ]);
    for (const root of [A, B]) {
      const other = root === A ? B : A;
      const result = await trace({ lei: root, direction: 'both', depth: 3 });
      expect(placement(result)).toEqual({ [root]: 'root 0', [other]: 'parent 1' });
      expect(result.edges).toHaveLength(2);
      expect(result).toMatchObject({ complete: true, truncated: false });
    }
  });

  it('counts depth over every relationship type but the ultimate one, flagging what only it reaches', async () => {
    await seedGroup();

    const two = await trace({ lei: HEAD, direction: 'children', depth: 2 });
    expect(placement(two)).toEqual({
      [HEAD]: 'root 0',
      [AOIL]: 'child 1',
      [CHILE]: 'child 1',
      [ASIA]: 'child 2',
      // Two direct links below the depth; only its ultimate edge reaches it here.
      [JAPAN]: 'child 1 ultimate',
    });
    expectEdgesJoinNodes(two);
    expect(two.edges).toHaveLength(7);
    // JAPAN's direct link from ASIA lies past the depth, so the graph is cut off.
    expect(two).toMatchObject({ complete: false, truncated: true });

    const three = await trace({ lei: HEAD, direction: 'children', depth: 3 });
    expect(placement(three)).toEqual({
      [HEAD]: 'root 0',
      [AOIL]: 'child 1',
      [CHILE]: 'child 1',
      [ASIA]: 'child 2',
      [JAPAN]: 'child 3',
    });
    expect(three.edges).toHaveLength(8);
    expect(three).toMatchObject({ complete: true, truncated: false });
  });

  it('places the ultimate parent at its direct-chain depth on a parents walk', async () => {
    await seedGroup();

    const five = await trace({ lei: JAPAN, direction: 'parents', depth: 5 });
    expect(placement(five)).toEqual({
      [JAPAN]: 'root 0',
      [ASIA]: 'parent 1',
      [AOIL]: 'parent 2',
      [HEAD]: 'parent 3',
    });
    expect(five.edges).toHaveLength(6);
    expect(five).toMatchObject({ complete: true, truncated: false });
    expect(nodeOf(five, HEAD)?.parentStatus).toEqual({
      direct: { status: 'none' },
      ultimate: { status: 'none' },
    });

    const two = await trace({ lei: JAPAN, direction: 'parents', depth: 2 });
    expect(placement(two)).toEqual({
      [JAPAN]: 'root 0',
      [ASIA]: 'parent 1',
      [HEAD]: 'parent 1 ultimate',
      [AOIL]: 'parent 2',
    });
    expectEdgesJoinNodes(two);
    // AOIL's direct link to HEAD is beyond the depth, though HEAD is shown flagged.
    expect(two).toMatchObject({ complete: false, truncated: true });
    // A flagged node short of the depth limit still carries its parent status.
    expect(nodeOf(two, HEAD)?.parentStatus).toEqual({
      direct: { status: 'none' },
      ultimate: { status: 'none' },
    });
  });

  it('returns an ultimate-only parent as an unwalked leaf, and never reads that edge as truncation', async () => {
    // The fixture's ROOT → PARENT row is ultimate-only, like 13,675 real entities,
    // and PARENT publishes no parent of its own.
    for (const depth of [1, 3]) {
      const result = await trace({ lei: ROOT, direction: 'parents', depth });
      expect(placement(result)).toEqual({ [ROOT]: 'root 0', [PARENT]: 'parent 1 ultimate' });
      expect(result).toMatchObject({ complete: true, truncated: false });
    }
  });

  it("reports a boundary node's ultimate row to an entity the graph does not return as truncation", async () => {
    // The parent's direct chain is broken: only its ultimate row links it on.
    const START = lei('EDGEROOT');
    const MIDDLE = lei('EDGEPARENT');
    const TOP = lei('EDGEULTIMATE');
    await seed({ [START]: 'Edge Root', [MIDDLE]: 'Edge Parent', [TOP]: 'Edge Ultimate' }, [
      relationship(START, MIDDLE),
      relationship(MIDDLE, TOP, ULT),
    ]);

    const one = await trace({ lei: START, direction: 'parents', depth: 1 });
    expect(placement(one)).toEqual({ [START]: 'root 0', [MIDDLE]: 'parent 1' });
    expect(one).toMatchObject({ complete: false, truncated: true, missingEntityLeis: [] });

    // One hop more returns that entity, as a flagged leaf.
    const two = await trace({ lei: START, direction: 'parents', depth: 2 });
    expect(placement(two)).toEqual({
      [START]: 'root 0',
      [MIDDLE]: 'parent 1',
      [TOP]: 'parent 2 ultimate',
    });
    expectEdgesJoinNodes(two);
    expect(two).toMatchObject({ complete: true, truncated: false });
  });

  it("reads a boundary node's ultimate row to a returned node as no truncation", async () => {
    // The root's ultimate parent is shown already, so the parent's row to it adds no entity.
    const START = lei('SHORTROOT');
    const MIDDLE = lei('SHORTPARENT');
    const TOP = lei('SHORTULTIMATE');
    await seed({ [START]: 'Short Root', [MIDDLE]: 'Short Parent', [TOP]: 'Short Ultimate' }, [
      relationship(START, MIDDLE),
      relationship(START, TOP, ULT),
      relationship(MIDDLE, TOP, ULT),
    ]);

    const one = await trace({ lei: START, direction: 'parents', depth: 1 });
    expect(placement(one)).toEqual({
      [START]: 'root 0',
      [MIDDLE]: 'parent 1',
      [TOP]: 'parent 1 ultimate',
    });
    expect(one).toMatchObject({ complete: true, truncated: false });
  });

  it("reports a flagged parent's unwalked direct parent as truncation, at every depth", async () => {
    // JLT-shaped: the root's direct chain is broken (no direct-parent row), and
    // its ultimate parent has a direct parent of its own the walk never takes.
    await seed({ [GRANDPARENT]: 'Grandparent Holdings' }, [relationship(PARENT, GRANDPARENT)]);

    const three = await trace({ lei: ROOT, direction: 'parents', depth: 3, screenNodes: true });
    expect(placement(three)).toEqual({ [ROOT]: 'root 0', [PARENT]: 'parent 1 ultimate' });
    expect(three.edges).toEqual([
      {
        childLei: ROOT,
        parentLei: PARENT,
        relationshipType: ULT,
        relationshipStatus: 'ACTIVE',
      },
    ]);
    expectEdgesJoinNodes(three);
    // GRANDPARENT owns PARENT and is not shown: the graph is a partial view.
    expect(three).toMatchObject({ complete: false, truncated: true, missingEntityLeis: [] });
    // Its own parents are read for its status, never walked.
    expect(nodeOf(three, PARENT)?.parentStatus).toEqual({
      direct: { status: 'relationship' },
      ultimate: { status: 'none' },
    });
    // A flagged node is screened like any other.
    expect(nodeOf(three, PARENT)?.sanctionsScreen).toBeDefined();
    expect(three.screenedNodeCount).toBe(2);
    const text = render(three);
    expect(text).toMatch(/Testland Holdings PLC.*reached only via an ultimate-parent edge/);
    expect(text).toContain('**Graph coverage:** incomplete');
    expect(text).toContain(
      '- Truncated: the loaded relationships hold ownership links on the walked side that this graph does not show — past the requested depth, or of a node reached only via an ultimate-parent edge, which is never walked.',
    );
    expect(text).not.toContain('Truncated at the requested depth');

    // At the depth limit the flagged leaf carries no status, and still reports what it hides.
    const one = await trace({ lei: ROOT, direction: 'parents', depth: 1 });
    expect(placement(one)).toEqual({ [ROOT]: 'root 0', [PARENT]: 'parent 1 ultimate' });
    expect(nodeOf(one, PARENT)?.parentStatus).toBeUndefined();
    expect(one).toMatchObject({ complete: false, truncated: true });
  });

  it("reports a flagged child's unwalked children as truncation, and a flagged leaf's shown link as none", async () => {
    // HEAD's direct child AOIL; ORPHAN reaches HEAD only through its ultimate row
    // (its direct parent is outside the group) and owns ORPHAN_SUB directly.
    const ORPHAN = lei('ORPHAN');
    const ORPHAN_SUB = lei('ORPHANSUB');
    const OUTSIDER = lei('OUTSIDER');
    await seed(
      {
        [HEAD]: 'Apple Inc.',
        [AOIL]: 'Apple Operations International Limited',
        [ORPHAN]: 'Orphan Subsidiary',
        [ORPHAN_SUB]: 'Orphan Subsidiary Two',
        [OUTSIDER]: 'Outside Holdings',
      },
      [
        relationship(AOIL, HEAD),
        relationship(AOIL, HEAD, ULT),
        relationship(ORPHAN, HEAD, ULT),
        relationship(ORPHAN, OUTSIDER),
        relationship(ORPHAN_SUB, ORPHAN),
      ],
    );

    const down = await trace({ lei: HEAD, direction: 'children', depth: 3 });
    expect(placement(down)).toEqual({
      [HEAD]: 'root 0',
      [AOIL]: 'child 1',
      [ORPHAN]: 'child 1 ultimate',
    });
    expectEdgesJoinNodes(down);
    // AOIL owns nothing, so only ORPHAN's unwalked child cuts the graph off.
    expect(down).toMatchObject({ complete: false, truncated: true });

    // A flagged parent whose only parent link joins two shown nodes hides nothing.
    const UP = lei('UPROOT');
    const MID = lei('UPMID');
    const TOP = lei('UPTOP');
    const ULTIMATE_PARENT = lei('UPULTIMATE');
    await seed(
      {
        [UP]: 'Up Root',
        [MID]: 'Up Middle',
        [TOP]: 'Up Top',
        [ULTIMATE_PARENT]: 'Up Ultimate',
      },
      [
        relationship(UP, MID),
        relationship(MID, TOP),
        relationship(UP, ULTIMATE_PARENT, ULT),
        relationship(ULTIMATE_PARENT, MID),
      ],
    );
    const up = await trace({ lei: UP, direction: 'parents', depth: 2 });
    expect(placement(up)).toEqual({
      [UP]: 'root 0',
      [MID]: 'parent 1',
      [ULTIMATE_PARENT]: 'parent 1 ultimate',
      [TOP]: 'parent 2',
    });
    expect(up.edges.map((edge) => `${edge.childLei}>${edge.parentLei}`)).toContain(
      `${ULTIMATE_PARENT}>${MID}`,
    );
    expect(up).toMatchObject({ complete: true, truncated: false });
  });
});

describe('sanctions_trace_ownership parent status (issue #26)', () => {
  let global: SeededService;
  const DIRECT_EXC = 'DIRECT_ACCOUNTING_CONSOLIDATION_PARENT';
  const ULTIMATE_EXC = 'ULTIMATE_ACCOUNTING_CONSOLIDATION_PARENT';
  const FILER = '254900QORVATHNOM0017';

  beforeEach(async () => {
    global = await seededGlobalService();
  });

  afterEach(async () => {
    await global.cleanup();
  });

  const trace = (input: Record<string, unknown>) =>
    traceOwnershipTool.handler(traceOwnershipTool.input.parse(input), ctx());
  const statusOf = (result: Awaited<ReturnType<typeof trace>>, lei: string) =>
    result.nodes.find((node) => node.lei === lei)?.parentStatus;

  it('returns an exception root with its category and every reason, on both surfaces', async () => {
    await global.service.ingestLeiEntities([entity(FILER, 'Spring Trust Nominees Ltd')]);
    await global.service.ingestReportingExceptions([
      { lei: FILER, category: DIRECT_EXC, reasons: ['NATURAL_PERSONS'] },
      { lei: FILER, category: ULTIMATE_EXC, reasons: ['NATURAL_PERSONS', 'NO_KNOWN_PERSON'] },
    ]);

    const result = await trace({ lei: FILER, direction: 'parents', depth: 2 });

    expect(statusOf(result, FILER)).toEqual({
      direct: { status: 'exception', exceptionReasons: ['NATURAL_PERSONS'] },
      ultimate: { status: 'exception', exceptionReasons: ['NATURAL_PERSONS', 'NO_KNOWN_PERSON'] },
    });
    expect(result).toMatchObject({
      reportingExceptionsLoaded: true,
      complete: true,
      truncated: false,
      missingEntityLeis: [],
    });
    const text = render(result);
    expect(text).toContain(
      '· parents — direct: reporting exception (NATURAL_PERSONS); ultimate: reporting exception (NATURAL_PERSONS, NO_KNOWN_PERSON)',
    );
  });

  it('reads none, never exception, for a node with no parent row and no exception', async () => {
    const isolated = '44444444444444444444';
    await global.service.ingestLeiEntities([entity(isolated, 'Isolated Entity')]);

    const result = await trace({ lei: isolated, direction: 'parents' });

    expect(statusOf(result, isolated)).toEqual({
      direct: { status: 'none' },
      ultimate: { status: 'none' },
    });
    expect(render(result)).toContain(
      '· parents — direct: none published; ultimate: none published',
    );
  });

  it('reads unknown, and says so, on a mirror whose exception data was never loaded', async () => {
    const isolated = '44444444444444444444';
    await global.service.ingestLeiEntities([entity(isolated, 'Isolated Entity')]);
    await global.service.ingestReportingExceptions([
      { lei: isolated, category: DIRECT_EXC, reasons: ['NON_PUBLIC'] },
    ]);
    // Rows in the table, but no recorded load: they cannot be trusted as complete.
    await global.service.markLeiReady(3, {});

    const result = await trace({ lei: isolated, direction: 'parents' });

    expect(statusOf(result, isolated)).toEqual({
      direct: { status: 'unknown' },
      ultimate: { status: 'unknown' },
    });
    expect(result.reportingExceptionsLoaded).toBe(false);
    expect(render(result)).toMatch(/reporting exceptions:\*\* not loaded/i);
  });

  it('reports a relationship where a row exists, even with exception data unloaded', async () => {
    await global.service.markLeiReady(2, {});
    const result = await trace({ lei: ROOT, direction: 'parents', depth: 1 });
    expect(statusOf(result, ROOT)).toEqual({
      direct: { status: 'unknown' },
      ultimate: { status: 'relationship' },
    });
  });

  it('gives every walked node its status, and none to the boundary, past the first level', async () => {
    await global.service.ingestLeiEntities([
      entity(GRANDPARENT, 'Grandparent Holdings'),
      entity(ULTIMATE, 'Ultimate Holdings'),
    ]);
    await global.service.ingestLeiRelationships([
      relationship(ROOT, PARENT),
      relationship(PARENT, GRANDPARENT),
      relationship(GRANDPARENT, ULTIMATE),
    ]);
    await global.service.ingestReportingExceptions([
      { lei: PARENT, category: ULTIMATE_EXC, reasons: ['NON_CONSOLIDATING'] },
      { lei: GRANDPARENT, category: ULTIMATE_EXC, reasons: ['NO_LEI'] },
    ]);

    const two = await trace({ lei: ROOT, direction: 'parents', depth: 2 });
    expect(statusOf(two, ROOT)).toEqual({
      direct: { status: 'relationship' },
      ultimate: { status: 'relationship' },
    });
    expect(statusOf(two, PARENT)).toEqual({
      direct: { status: 'relationship' },
      ultimate: { status: 'exception', exceptionReasons: ['NON_CONSOLIDATING'] },
    });
    // Discovered at the depth limit: its parents were never walked.
    expect(statusOf(two, GRANDPARENT)).toBeUndefined();

    const four = await trace({ lei: ROOT, direction: 'parents', depth: 4 });
    expect(statusOf(four, GRANDPARENT)).toEqual({
      direct: { status: 'relationship' },
      ultimate: { status: 'exception', exceptionReasons: ['NO_LEI'] },
    });
    expect(statusOf(four, ULTIMATE)).toEqual({
      direct: { status: 'none' },
      ultimate: { status: 'none' },
    });
    expect(four).toMatchObject({ complete: true, truncated: false });
  });

  it("carries no parent status on a children walk, and walks children's parents on both", async () => {
    const children = await trace({ lei: PARENT, direction: 'children', depth: 2 });
    expect(children.nodes.map((node) => node.lei)).toEqual([PARENT, ROOT]);
    expect(children.nodes.every((node) => node.parentStatus === undefined)).toBe(true);
    expect(render(children)).not.toContain('direct parent:');
    expect(render(children)).not.toContain('parents —');

    const both = await trace({ lei: PARENT, direction: 'both', depth: 2 });
    expect(statusOf(both, ROOT)).toEqual({
      direct: { status: 'none' },
      ultimate: { status: 'relationship' },
    });
  });

  it('keeps an exception out of missingEntityLeis, and a missing node in it', async () => {
    await global.service.ingestLeiRelationships([
      relationship(ROOT, PARENT),
      relationship(PARENT, MISSING),
    ]);
    await global.service.ingestReportingExceptions([
      { lei: MISSING, category: DIRECT_EXC, reasons: ['NATURAL_PERSONS'] },
      { lei: MISSING, category: ULTIMATE_EXC, reasons: ['NATURAL_PERSONS'] },
    ]);

    const result = await trace({ lei: ROOT, direction: 'parents', depth: 5 });

    expect(result.missingEntityLeis).toEqual([MISSING]);
    expect(statusOf(result, MISSING)).toEqual({
      direct: { status: 'exception', exceptionReasons: ['NATURAL_PERSONS'] },
      ultimate: { status: 'exception', exceptionReasons: ['NATURAL_PERSONS'] },
    });
    expect(result).toMatchObject({ complete: false, truncated: false });
  });

  it('leaves the screening disclosure and the caveat unchanged', async () => {
    await global.service.ingestReportingExceptions([
      { lei: ROOT, category: DIRECT_EXC, reasons: ['NATURAL_PERSONS'] },
    ]);
    const result = await trace({ lei: ROOT, direction: 'parents', depth: 1, screenNodes: true });

    expect(result.screeningStatus).toBe('screened');
    expect(result.nodes.every((node) => node.sanctionsScreen !== undefined)).toBe(true);
    expect(result.caveat).toBe(SCREENING_CAVEAT);
    const text = render(result);
    expect(text).toContain('not a clearance');
    expect(text).toContain('direct parent: reporting exception (NATURAL_PERSONS)');
  });
});
