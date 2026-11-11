/**
 * @fileoverview Input normalization through the MCP tool and resource contracts.
 * @module tests/integration/input-normalization.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { entityResource } from '@/mcp-server/resources/definitions/entity.resource.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import type { NormalizedDesignation } from '@/services/screening/types.js';
import { type SeededService, seededGlobalService } from '../services/_helpers.js';

const ROOT = '5493001KJTIIGC8Y1R12';
const MIXED = '5493001kjtiigc8Y1r12';
const TracePage = z.object({ nextCursor: z.string(), nodes: z.array(z.unknown()) });
let seeded: SeededService;

beforeEach(async () => {
  seeded = await seededGlobalService();
});
afterEach(async () => {
  await seeded.cleanup();
});

it('keeps the canonical entity and ownership root for uppercase input', async () => {
  const entity = await runToolContract(getEntityTool, { lei: ROOT });
  expect(entity.structuredContent).toMatchObject({ lei: ROOT });
  const trace = await runToolContract(traceOwnershipTool, { lei: ROOT, limit: 1 });
  expect(trace.structuredContent).toMatchObject({ rootLei: ROOT, nextCursor: expect.any(String) });
});

it('looks up the canonical LEI on the tool and resource', async () => {
  const entity = await runToolContract(getEntityTool, { lei: MIXED });
  expect(entity.structuredContent).toMatchObject({ lei: ROOT });
  expect(entity.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(ROOT) })]),
  );
  const params = entityResource.params?.parse({ lei: MIXED });
  if (!params) throw new Error('Expected resource params');
  const ctx = createMockContext({ errors: entityResource.errors });
  await expect(entityResource.handler(params, ctx)).resolves.toMatchObject({ lei: ROOT });
});

it.each([
  [MIXED, ROOT],
  [ROOT, MIXED],
])('continues an ownership cursor from %s with %s', async (firstLei, nextLei) => {
  const first = await runToolContract(traceOwnershipTool, { lei: firstLei, limit: 1 });
  expect(first.structuredContent).toMatchObject({ rootLei: ROOT, nextCursor: expect.any(String) });
  const firstPage = TracePage.parse(first.structuredContent);
  const next = await runToolContract(traceOwnershipTool, {
    lei: nextLei,
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  expect(next.structuredContent).toMatchObject({ rootLei: ROOT, nextCursor: expect.any(String) });
  expect(TracePage.parse(next.structuredContent).nodes).not.toEqual(firstPage.nodes);
});

it.each([
  [screenNameTool, 101, 100],
  [resolveEntityTool, 51, 50],
] as const)(
  'clamps an oversized name limit and keeps the empty-result notice',
  async (tool, requested, effective) => {
    const result = await runToolContract(tool, { name: 'ZZZQXZVQQ', limit: requested });
    expect(result.structuredContent).toMatchObject({
      totalAvailable: 0,
      hasMore: false,
      notice: expect.stringContaining(`Requested limit ${requested} clamped to ${effective}`),
    });
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringMatching(/No (potential match|LEI candidate)/),
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining(`Requested limit ${requested} clamped to ${effective}`),
        }),
      ]),
    );
  },
);

it('uses the effective limits to page name and LEI results', async () => {
  const name = 'Xerqom Paging Works';
  await seeded.service.ingestDesignations(
    Array.from(
      { length: 102 },
      (_, index): NormalizedDesignation => ({
        id: `un:PAGE-${index}`,
        source: 'un',
        sourceEntryId: `PAGE-${index}`,
        entityType: 'organization',
        primaryName: name,
        payload: {
          aliases: [],
          identifiers: [],
          addresses: [],
          datesOfBirth: [],
          nationalities: [],
        },
      }),
    ),
  );
  await seeded.service.ingestLeiEntities(
    Array.from({ length: 52 }, (_, index) => ({
      lei: `XERQOMPAGINGWORK${String(index).padStart(4, '0')}`,
      legalName: name,
      otherNames: [],
      status: 'ISSUED',
    })),
  );
  for (const [tool, filters, cap] of [
    [screenNameTool, { sources: ['un'] }, 100],
    [resolveEntityTool, {}, 50],
  ] as const) {
    const first = await runToolContract(tool, { name, ...filters, limit: cap + 10 });
    expect(first.structuredContent).toMatchObject({
      totalCount: cap,
      hasMore: true,
      nextOffset: cap,
    });
    const second = await runToolContract(tool, { name, ...filters, limit: 2, offset: cap });
    expect(second.structuredContent).toMatchObject({ totalCount: 2, hasMore: false });
    const pastEnd = await runToolContract(tool, {
      name,
      ...filters,
      limit: cap + 10,
      offset: cap + 3,
    });
    expect(pastEnd.structuredContent).toMatchObject({
      totalCount: 0,
      hasMore: false,
      notice: expect.stringMatching(/clamped.*past the end/),
    });
  }
});

it('rejects malformed LEIs and non-positive, fractional, or string limits', async () => {
  for (const tool of [getEntityTool, traceOwnershipTool]) {
    const result = await runToolContract(tool, { lei: `${MIXED.slice(0, -1)}z` });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_arguments' } },
    });
  }
  expect(entityResource.params?.safeParse({ lei: `${MIXED}a` }).success).toBe(false);
  for (const tool of [screenNameTool, resolveEntityTool]) {
    for (const limit of [0, -1, 1.25]) {
      const result = await runToolContract(tool, { name: 'Xerqom Paging Works', limit });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_arguments' } },
      });
    }
    expect(tool.input.safeParse({ name: 'Xerqom Paging Works', limit: '100' }).success).toBe(false);
  }
});
