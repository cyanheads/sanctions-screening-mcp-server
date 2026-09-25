/**
 * @fileoverview Integration coverage for ownership traversal termination,
 * direction/depth bounds, missing Level 1 entities, completeness reporting, and
 * the per-node parent status a walk reports from Level 2 and GLEIF's reporting
 * exceptions.
 * @module tests/integration/ownership-correctness.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('pins the graph shape of a multi-level walk in both directions (characterization)', async () => {
    await global.service.ingestLeiEntities([
      entity(GRANDPARENT, 'Grandparent Holdings'),
      entity(ULTIMATE, 'Ultimate Holdings'),
    ]);
    await global.service.ingestLeiRelationships([
      relationship(PARENT, GRANDPARENT),
      relationship(GRANDPARENT, ULTIMATE, 'IS_ULTIMATELY_CONSOLIDATED_BY'),
    ]);

    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: ROOT, direction: 'both', depth: 3 }),
      ctx(),
    );

    expect(
      result.nodes.map(({ lei, legalName, depth, role, jurisdiction, status }) => ({
        lei,
        legalName,
        depth,
        role,
        jurisdiction,
        status,
      })),
    ).toEqual([
      {
        lei: ROOT,
        legalName: 'Fictional Trading Company LLC',
        depth: 0,
        role: 'root',
        jurisdiction: 'US',
        status: 'ISSUED',
      },
      {
        lei: PARENT,
        legalName: 'Testland Holdings PLC',
        depth: 1,
        role: 'parent',
        jurisdiction: 'GB',
        status: 'ISSUED',
      },
      {
        lei: GRANDPARENT,
        legalName: 'Grandparent Holdings',
        depth: 2,
        role: 'parent',
        jurisdiction: undefined,
        status: 'ISSUED',
      },
      {
        lei: ULTIMATE,
        legalName: 'Ultimate Holdings',
        depth: 3,
        role: 'parent',
        jurisdiction: undefined,
        status: 'ISSUED',
      },
    ]);
    expect(result.edges).toEqual([
      {
        childLei: ROOT,
        parentLei: PARENT,
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
        childLei: GRANDPARENT,
        parentLei: ULTIMATE,
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
    expect(text).toContain('direct parent: reporting exception (NATURAL_PERSONS)');
    expect(text).toContain(
      'ultimate parent: reporting exception (NATURAL_PERSONS, NO_KNOWN_PERSON)',
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
    expect(render(result)).toContain('direct parent: none published');
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

    const both = await trace({ lei: PARENT, direction: 'both', depth: 2 });
    expect(statusOf(both, ROOT)).toEqual({
      direct: { status: 'none' },
      ultimate: { status: 'relationship' },
    });
  });

  it('keeps an exception out of missingEntityLeis, and a missing node in it', async () => {
    await global.service.ingestLeiRelationships([relationship(PARENT, MISSING)]);
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
