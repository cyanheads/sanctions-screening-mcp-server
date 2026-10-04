/**
 * @fileoverview Schema-aware fuzz coverage across the whole public definition
 * surface. Where `ingest-and-matcher.fuzz.test.ts` fuzzes the parsing and
 * matching internals, this file drives every tool, resource, and prompt through
 * the framework's generator: valid inputs derived from each Zod schema plus
 * adversarial wrong-type variants, asserting no unhandled crash, no stack-trace
 * or filesystem-path leak, and no prototype pollution.
 *
 * A declared-contract throw (`mirror_not_ready`, `*_not_found`) is a handled
 * outcome, not a crash — the assertions below are on `crashes`/`leaks`, never on
 * a contract failing to fire.
 * @module tests/fuzz/definition-surface.fuzz.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { fuzzPrompt, fuzzResource, fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vetCounterpartyPrompt } from '@/mcp-server/prompts/definitions/vet-counterparty.prompt.js';
import { designationResource } from '@/mcp-server/resources/definitions/designation.resource.js';
import { entityResource } from '@/mcp-server/resources/definitions/entity.resource.js';
import { sourcesResource } from '@/mcp-server/resources/definitions/sources.resource.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenIdentifierTool } from '@/mcp-server/tools/definitions/screen-identifier.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import { type SeededService, seededGlobalService } from '../services/_helpers.js';

/** Fixed seed and modest run counts keep the lane deterministic and fast. */
const FUZZ = { numRuns: 40, numAdversarial: 25, seed: 0x5a17c0de } as const;

const tools = [
  ['sanctions_screen_name', screenNameTool],
  ['sanctions_screen_identifier', screenIdentifierTool],
  ['sanctions_get_designation', getDesignationTool],
  ['sanctions_resolve_entity', resolveEntityTool],
  ['sanctions_get_entity', getEntityTool],
  ['sanctions_trace_ownership', traceOwnershipTool],
  ['sanctions_list_sources', listSourcesTool],
] as const;

const resources = [
  ['sanctions://designation', designationResource],
  ['sanctions://entity', entityResource],
  ['sanctions://sources', sourcesResource],
] as const;

const LEI_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** `count` LEIs the input schemas accept (18 alphanumerics + 2 digits), from a fixed-seed LCG. */
function schemaValidLeis(count: number): string[] {
  let state = FUZZ.seed;
  const next = (bound: number) => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state % bound;
  };
  return Array.from({ length: count }, () => {
    const body = Array.from({ length: 18 }, () => LEI_ALPHABET[next(36)]).join('');
    return `${body}${next(10)}${next(10)}`;
  });
}

/** ISO 7064 MOD 97-10 over the base-36 expansion, as a BigInt — independent of the server's helper. */
const mod97 = (lei: string): bigint =>
  BigInt([...lei].map((char) => Number.parseInt(char, 36)).join('')) % 97n;

describe('definition surface fuzz (seeded mirror)', () => {
  let seeded: SeededService;

  beforeAll(async () => {
    seeded = await seededGlobalService();
  });

  afterAll(async () => {
    await seeded.cleanup();
  });

  it.each(tools)('%s survives schema-derived and adversarial input', async (_name, tool) => {
    const report = await fuzzTool(tool, FUZZ);
    expect(report.totalRuns).toBeGreaterThan(0);
    expect(report.crashes).toHaveLength(0);
    expect(report.leaks).toHaveLength(0);
    expect(report.prototypePollution).toBe(false);
  });

  it.each(resources)('%s survives schema-derived and adversarial params', async (_uri, res) => {
    // `fuzzResource` does not forward the definition's own `errors[]` into its
    // mock context the way `fuzzTool` does, so a `ctx.fail` throw would surface
    // as `TypeError: ctx.fail is not a function` and be filed as a crash.
    // Passing the contract through `options.ctx` restores the typed `fail`.
    // Tracked by cyanheads/mcp-ts-core#350.
    const report = await fuzzResource(res, { ...FUZZ, ctx: { errors: res.errors } });
    expect(report.crashes).toHaveLength(0);
    expect(report.leaks).toHaveLength(0);
    expect(report.prototypePollution).toBe(false);
  });

  it('lands every schema-valid LEI the mirror lacks on a declared reason, by its check digits (#62)', async () => {
    const leis = [...schemaValidLeis(60), '529900UNKNOWNLEI0009', '549300NOTINMIRROR077'];
    const seen = new Set<string>();
    for (const lei of leis) {
      const expected = mod97(lei) === 1n ? 'lei_not_found' : 'invalid_lei_checksum';
      seen.add(expected);
      for (const tool of [getEntityTool, traceOwnershipTool]) {
        const result = await runToolContract(tool, { lei });
        const envelope = result.structuredContent as {
          error?: { data?: { recovery?: { hint?: string }; reason?: string } };
        };
        expect(envelope.error?.data?.reason, `${tool.name} ${lei}`).toBe(expected);
        expect(envelope.error?.data?.recovery?.hint, `${tool.name} ${lei}`).toBeTruthy();
      }
      const failure = await Promise.resolve()
        .then(() =>
          entityResource.handler(
            entityResource.params!.parse({ lei }),
            createMockContext({ errors: entityResource.errors }),
          ),
        )
        .catch((error: unknown) => error);
      expect(failure, `sanctions://entity/${lei}`).toMatchObject({ data: { reason: expected } });
    }
    expect([...seen].sort()).toEqual(['invalid_lei_checksum', 'lei_not_found']);
  });

  it('sanctions_vet_counterparty survives schema-derived and adversarial args', async () => {
    const report = await fuzzPrompt(vetCounterpartyPrompt, FUZZ);
    expect(report.crashes).toHaveLength(0);
    expect(report.leaks).toHaveLength(0);
    expect(report.prototypePollution).toBe(false);
  });
});
