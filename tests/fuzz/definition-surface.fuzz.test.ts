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
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import { type SeededService, seededGlobalService } from '../services/_helpers.js';

/** Fixed seed and modest run counts keep the lane deterministic and fast. */
const FUZZ = { numRuns: 40, numAdversarial: 25, seed: 0x5a17c0de } as const;

const tools = [
  ['sanctions_screen_name', screenNameTool],
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

  it('sanctions_vet_counterparty survives schema-derived and adversarial args', async () => {
    const report = await fuzzPrompt(vetCounterpartyPrompt, FUZZ);
    expect(report.crashes).toHaveLength(0);
    expect(report.leaks).toHaveLength(0);
    expect(report.prototypePollution).toBe(false);
  });
});
