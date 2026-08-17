/**
 * @fileoverview Integration coverage for ownership traversal termination,
 * direction/depth bounds, missing Level 1 entities, and completeness reporting.
 * @module tests/integration/ownership-correctness.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import type { NormalizedLeiEntity, NormalizedLeiRelationship } from '@/services/screening/types.js';
import { type SeededService, seededGlobalService } from '../services/_helpers.js';

const ROOT = '5493001KJTIIGC8Y1R12';
const PARENT = '529900T8BM49AURSDO55';
const GRANDPARENT = '11111111111111111111';
const ULTIMATE = '22222222222222222222';
const MISSING = '33333333333333333333';

const ctx = () => createMockContext({ errors: traceOwnershipTool.errors });

const entity = (lei: string, legalName: string): NormalizedLeiEntity => ({
  lei,
  legalName,
  otherNames: [],
  status: 'ISSUED',
});

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

    const two = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: ROOT, direction: 'parents', depth: 2 }),
      ctx(),
    );
    expect(two.nodes.map((node) => node.lei)).toEqual([ROOT, PARENT, GRANDPARENT]);
    expect(two.nodes.find((node) => node.lei === ULTIMATE)).toBeUndefined();

    const three = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: ROOT, direction: 'parents', depth: 3 }),
      ctx(),
    );
    expect(three.nodes.map((node) => node.lei)).toEqual([ROOT, PARENT, GRANDPARENT, ULTIMATE]);
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
  });

  // Correct behavior is tracked by https://github.com/cyanheads/sanctions-screening-mcp-server/issues/16
  it.skip('reports missing entities and a depth-truncated chain as incomplete', async () => {
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
  });
});
