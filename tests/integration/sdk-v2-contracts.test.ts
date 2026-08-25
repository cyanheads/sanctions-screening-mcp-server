/**
 * @fileoverview SDK v2 wire-contract coverage for the whole screening surface:
 * every tool driven through its public contract boundary (input parse → handler
 * → output parse → format → enrichment → error envelope), the strict root-input
 * rejection that now names an undeclared argument instead of stripping it, the
 * advertised 2020-12 input schemas, and the resource cache hints.
 * @module tests/integration/sdk-v2-contracts.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import { type SeededService, seededGlobalService } from '../services/_helpers.js';

/** The subsidiary in the GLEIF fixture — also published on the OFAC consolidated list. */
const SUBSIDIARY_LEI = '5493001KJTIIGC8Y1R12';
/** Its ultimate parent, carrying no watchlist entry of its own. */
const PARENT_LEI = '529900T8BM49AURSDO55';
/** Well-formed but absent from the mirror. */
const UNKNOWN_LEI = '00000000000000000000';

let seeded: SeededService | undefined;

beforeAll(async () => {
  seeded = await seededGlobalService();
});

afterAll(async () => {
  await seeded?.cleanup();
});

/** Minimal schema-valid input per tool, for the strict-root-input sweep. */
const MINIMAL_INPUTS: Record<string, Record<string, unknown>> = {
  sanctions_screen_name: { name: 'Ivan Testovich Volkov' },
  sanctions_get_designation: { source: 'ofac_sdn', entryId: 'FX-1001' },
  sanctions_list_sources: {},
  sanctions_resolve_entity: { name: 'Fictional Trading Company LLC' },
  sanctions_get_entity: { lei: SUBSIDIARY_LEI },
  sanctions_trace_ownership: { lei: SUBSIDIARY_LEI },
};

/** Concatenate a result's `content[]` text blocks — the non-structured surface. */
const renderContent = (blocks: readonly { type: string; text?: string }[]): string =>
  blocks.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');

toolContractSuite(screenNameTool, {
  success: [
    {
      name: 'returns a scored hit carrying the decision-support caveat on both surfaces',
      input: { name: 'Ivan Testovich Volkov' },
      assert: (result) => {
        const structured = result.structuredContent as {
          caveat: string;
          hits: { primaryName: string; source: string }[];
        };
        expect(structured.hits[0]).toMatchObject({
          primaryName: 'Ivan Testovich Volkov',
          source: 'ofac_sdn',
        });
        expect(structured.caveat).toContain('not a compliance determination');
        expect(renderContent(result.content)).toContain('Ivan Testovich Volkov');
      },
    },
    {
      name: 'returns an empty page past the end without calling it a clearance',
      input: { name: 'Ivan Testovich Volkov', offset: 500 },
      assert: (result) => {
        const structured = result.structuredContent as { hits: unknown[] };
        expect(structured.hits).toEqual([]);
        expect(renderContent(result.content)).toContain('past the end');
      },
    },
    {
      name: 'returns no potential match for an unlisted name and says so is not a clearance',
      input: { name: 'Zzzz Nonexistent Counterparty' },
      assert: (result) => {
        expect((result.structuredContent as { hits: unknown[] }).hits).toEqual([]);
        expect(renderContent(result.content)).toContain('NOT a clearance');
      },
    },
  ],
});

toolContractSuite(getDesignationTool, {
  success: [
    {
      name: 'returns the full designation record for a known source + entry ID',
      input: { source: 'ofac_sdn', entryId: 'FX-1001' },
    },
  ],
  errors: [
    {
      name: 'returns the not-found envelope for an unknown entry ID',
      input: { source: 'ofac_sdn', entryId: 'NO-SUCH-ENTRY' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'designation_not_found',
    },
  ],
});

toolContractSuite(listSourcesTool, {
  success: [{ name: 'reports every loaded source with its provenance', input: {} }],
});

toolContractSuite(resolveEntityTool, {
  success: [
    {
      name: 'ranks LEI candidates for a known legal name',
      input: { name: 'Fictional Trading Company LLC' },
      assert: (result) => {
        const structured = result.structuredContent as { matches: { lei: string }[] };
        expect(structured.matches[0]?.lei).toBe(SUBSIDIARY_LEI);
      },
    },
    {
      name: 'returns no candidate for an unresolvable name',
      input: { name: 'Zzzz Nonexistent Holdings' },
      assert: (result) => {
        expect((result.structuredContent as { matches: unknown[] }).matches).toEqual([]);
      },
    },
  ],
});

toolContractSuite(getEntityTool, {
  success: [
    {
      name: 'returns the GLEIF record plus its sanctions cross-reference',
      input: { lei: SUBSIDIARY_LEI },
    },
  ],
  errors: [
    {
      name: 'returns the not-found envelope for a well-formed but absent LEI',
      input: { lei: UNKNOWN_LEI },
      code: JsonRpcErrorCode.NotFound,
      reason: 'lei_not_found',
    },
  ],
});

toolContractSuite(traceOwnershipTool, {
  success: [
    {
      name: 'walks past the root and screens every node when asked',
      input: { lei: SUBSIDIARY_LEI, direction: 'both', depth: 3, screenNodes: true },
      assert: (result) => {
        const structured = result.structuredContent as {
          edges: { childLei: string; parentLei: string }[];
          nodes: {
            depth: number;
            lei: string;
            sanctionsHits?: { primaryName: string }[];
          }[];
        };
        // The traversal must reach the parent, not stop at the root.
        expect(structured.nodes.map((node) => node.lei).sort()).toEqual(
          [SUBSIDIARY_LEI, PARENT_LEI].sort(),
        );
        expect(structured.nodes.find((node) => node.lei === PARENT_LEI)?.depth).toBe(1);
        expect(structured.edges).toContainEqual(
          expect.objectContaining({ childLei: SUBSIDIARY_LEI, parentLei: PARENT_LEI }),
        );
        // Per-node screening ran on the whole graph: the subsidiary is listed,
        // the parent is not, and neither absence is rendered as a clearance.
        const root = structured.nodes.find((node) => node.lei === SUBSIDIARY_LEI);
        expect(root?.sanctionsHits?.[0]?.primaryName).toBe('Fictional Trading Company LLC');
        expect(structured.nodes.find((node) => node.lei === PARENT_LEI)?.sanctionsHits).toEqual([]);
        expect(renderContent(result.content)).toContain('not a compliance determination');
      },
    },
    {
      name: 'stops at the root when depth 1 is requested in one direction only',
      input: { lei: PARENT_LEI, direction: 'parents', depth: 1 },
      assert: (result) => {
        const structured = result.structuredContent as { edges: unknown[]; nodes: unknown[] };
        expect(structured.nodes).toHaveLength(1);
        expect(structured.edges).toEqual([]);
      },
    },
  ],
  errors: [
    {
      name: 'returns the not-found envelope for an absent root LEI',
      input: { lei: UNKNOWN_LEI },
      code: JsonRpcErrorCode.NotFound,
      reason: 'lei_not_found',
    },
  ],
});

describe('strict root inputs', () => {
  for (const definition of allToolDefinitions) {
    it(`${definition.name} rejects an undeclared argument by name`, async () => {
      const result = await runToolContract(definition, {
        ...MINIMAL_INPUTS[definition.name],
        // The shape a caller lands on from a snake_case reading of the surface.
        min_score: 0.9,
      } as never);

      expect(result.isError).toBe(true);
      const envelope = result.structuredContent as { error: { code: number; message: string } };
      expect(envelope.error.code).toBe(JsonRpcErrorCode.ValidationError);
      // Named, not silently stripped — the caller can see which key was wrong.
      expect(envelope.error.message).toContain('min_score');
    });
  }

  it('still accepts every declared argument on the tool that owns the rejected name', async () => {
    const result = await runToolContract(screenNameTool, {
      name: 'Ivan Testovich Volkov',
      matchMode: 'fuzzy',
      minScore: 0.9,
    });
    expect(result.isError).toBeFalsy();
  });
});

describe('advertised tool schemas', () => {
  it('closes every root input and reserves `error` for the failure envelope', () => {
    for (const definition of allToolDefinitions) {
      const inputSchema = z.toJSONSchema(definition.input) as Record<string, unknown>;
      expect(inputSchema).toMatchObject({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        type: 'object',
      });
      expect(definition.output.shape).not.toHaveProperty('error');
      expect(definition.enrichment ?? {}).not.toHaveProperty('error');
    }
  });
});

describe('resource cache hints', () => {
  const hintFor = (uriTemplate: string) =>
    allResourceDefinitions.find((definition) => definition.uriTemplate.toString() === uriTemplate)
      ?.cacheHint;

  it('lets a client hold a designation and an entity record for an hour, privately', () => {
    expect(hintFor('sanctions://designation/{source}/{entryId}')).toEqual({
      ttlMs: 3_600_000,
      cacheScope: 'private',
    });
    expect(hintFor('sanctions://entity/{lei}')).toEqual({
      ttlMs: 3_600_000,
      cacheScope: 'private',
    });
  });

  it('never lets the freshness resource be cached', () => {
    // Mirror readiness and the as-of timestamps ARE this resource's payload.
    expect(hintFor('sanctions://sources')).toEqual({ ttlMs: 0 });
  });
});
