/**
 * @fileoverview A mistyped LEI on every LEI-keyed surface (issue #62). After a
 * mirror miss, an LEI whose ISO 17442 check digits fail is reported as
 * `invalid_lei_checksum`, and one whose digits pass as `lei_not_found`; the
 * check never runs at the input edge, so a held record whose LEI fails it — an
 * annulled registration GLEIF still publishes — keeps returning on every surface.
 * @module tests/tools/lei-checksum.test
 */

import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entityResource } from '@/mcp-server/resources/definitions/entity.resource.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import type { NormalizedLeiEntity } from '@/services/screening/types.js';
import { type SeededService, seededGlobalService } from '../services/_helpers.js';

/** Apple Inc. — a held LEI whose check digits pass. */
const APPLE = 'HWUPKR0MPOU8FGXBT394';
/** {@link APPLE} with its last digit mistyped: fails the check, held by no entity. */
const APPLE_TYPO = 'HWUPKR0MPOU8FGXBT395';
/** An ANNULLED registration GLEIF publishes under an LEI that fails the check. */
const ANNULLED = '0292001629A3Q7XJ0D13';
/** Check digits pass; no entity in the mirror carries it. */
const UNKNOWN_VALID = '529900UNKNOWNLEI0009';

const held: NormalizedLeiEntity[] = [
  {
    lei: APPLE,
    legalName: 'Apple Inc.',
    otherNames: [],
    jurisdiction: 'US-CA',
    status: 'ISSUED',
  },
  {
    lei: ANNULLED,
    legalName: 'Annulled Registration Holdings S.A.',
    otherNames: [],
    jurisdiction: 'MX',
    status: 'ANNULLED',
  },
];

const ctxFor = <const E extends readonly ErrorContract[] | undefined>(errors: E) =>
  createMockContext({ errors });

/** The resource's params, parsed by its own schema as the framework does. */
const resourceParams = (lei: string) => {
  if (!entityResource.params) throw new Error('resource declares no params schema');
  return entityResource.params.parse({ lei });
};

/** The `structuredContent.error` envelope a failed tool call carries on the wire. */
const envelopeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.structuredContent as { error?: { code: number; data?: Record<string, unknown> } }).error;

describe('LEI check digits on a mirror miss (issue #62)', () => {
  let seeded: SeededService;

  beforeEach(async () => {
    seeded = await seededGlobalService();
    await seeded.service.ingestLeiEntities(held);
  });

  afterEach(async () => {
    await seeded.cleanup();
  });

  const tools = [
    ['sanctions_get_entity', getEntityTool],
    ['sanctions_trace_ownership', traceOwnershipTool],
  ] as const;

  it.each(tools)(
    '%s fails a mistyped LEI as invalid_lei_checksum with its recovery on the wire',
    async (_name, tool) => {
      const result = await runToolContract(tool, { lei: APPLE_TYPO });

      expect(result.isError).toBe(true);
      expect(envelopeOf(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'invalid_lei_checksum',
          recovery: { hint: expect.stringMatching(/mistyped or transposed character/) },
        },
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain(APPLE_TYPO);
      expect(text).toMatch(/check digits/);
      expect(text).toMatch(/Recovery: .*sanctions_resolve_entity/);
    },
  );

  it.each(tools)('%s still resolves the LEI the typo was made from', async (_name, tool) => {
    const result = await runToolContract(tool, { lei: APPLE });
    expect(result.isError).toBeFalsy();
  });

  it.each(tools)(
    '%s keeps lei_not_found for an LEI whose check digits pass (characterization)',
    async (_name, tool) => {
      const result = await runToolContract(tool, { lei: UNKNOWN_VALID });
      expect(envelopeOf(result)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'lei_not_found' },
      });
    },
  );

  it('returns a held record whose LEI fails the check on both tools (characterization)', async () => {
    const entity = await getEntityTool.handler(
      getEntityTool.input.parse({ lei: ANNULLED }),
      ctxFor(getEntityTool.errors),
    );
    expect(entity).toMatchObject({ lei: ANNULLED, status: 'ANNULLED' });

    const graph = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: ANNULLED }),
      ctxFor(traceOwnershipTool.errors),
    );
    expect(graph.nodes.map((node) => node.lei)).toEqual([ANNULLED]);
  });

  it('fails a mistyped LEI as invalid_lei_checksum on sanctions://entity/{lei}', async () => {
    await expect(
      entityResource.handler(resourceParams(APPLE_TYPO), ctxFor(entityResource.errors)),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_lei_checksum' },
    });
  });

  it('keeps lei_not_found and the held checksum-failing record on sanctions://entity/{lei} (characterization)', async () => {
    await expect(
      entityResource.handler(resourceParams(UNKNOWN_VALID), ctxFor(entityResource.errors)),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'lei_not_found' } });
    await expect(
      entityResource.handler(resourceParams(ANNULLED), ctxFor(entityResource.errors)),
    ).resolves.toMatchObject({ lei: ANNULLED, status: 'ANNULLED' });
    await expect(
      entityResource.handler(resourceParams(APPLE), ctxFor(entityResource.errors)),
    ).resolves.toMatchObject({ lei: APPLE, legalName: 'Apple Inc.' });
  });

  it('declares invalid_lei_checksum as InvalidParams with a recovery on every LEI-keyed surface', () => {
    for (const definition of [getEntityTool, traceOwnershipTool, entityResource]) {
      const entry = definition.errors?.find((e) => e.reason === 'invalid_lei_checksum');
      expect(entry?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(entry?.recovery).toMatch(/mistyped or transposed character/);
      expect(entry?.recovery).toMatch(/sanctions_resolve_entity/);
    }
  });

  it('leaves the input schemas accepting a checksum-failing LEI', () => {
    for (const lei of [APPLE_TYPO, ANNULLED]) {
      expect(getEntityTool.input.safeParse({ lei }).success).toBe(true);
      expect(traceOwnershipTool.input.safeParse({ lei }).success).toBe(true);
      expect(entityResource.params?.safeParse({ lei }).success).toBe(true);
    }
  });
});
