/**
 * @fileoverview Unit coverage for the three URI resources: the per-mirror
 * readiness gate on `sanctions://designation/{source}/{entryId}` and
 * `sanctions://entity/{lei}`, and the provenance parity `sanctions://sources`
 * owes `sanctions_list_sources`. The two mirrors gate independently, so each
 * resource is exercised against a mirror state where only the OTHER one is
 * ready — a gate keyed to the wrong mirror passes a single-mirror test.
 * @module tests/resources/resource-contracts.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { designationResource } from '@/mcp-server/resources/definitions/designation.resource.js';
import { entityResource } from '@/mcp-server/resources/definitions/entity.resource.js';
import { sourcesResource } from '@/mcp-server/resources/definitions/sources.resource.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import {
  FIXTURE_DESIGNATIONS,
  FIXTURE_LEI_ENTITIES,
  FIXTURE_LEI_RELATIONSHIPS,
} from '@/services/screening/fixtures.js';
import {
  emptyGlobalService,
  type SeededService,
  seededGlobalService,
} from '../services/_helpers.js';

const ctxFor = <const E extends readonly ErrorContract[] | undefined>(errors: E) =>
  createMockContext({ errors });

function parseParams<P>(definition: { params?: { parse: (raw: unknown) => P } }, raw: unknown): P {
  if (!definition.params) throw new Error('resource declares no params schema');
  return definition.params.parse(raw);
}

/** Resource payloads are untyped (resources declare no output schema). */
const SourcesPayload = z.object({
  sanctionsReady: z.boolean(),
  sanctionsAsOf: z.string().optional(),
  leiReady: z.boolean(),
  leiAsOf: z.string().optional(),
  gleifBaseUrl: z.string(),
  sources: z.array(z.looseObject({ code: z.string() })),
});

let global: SeededService | undefined;

afterEach(async () => {
  await global?.cleanup();
  global = undefined;
});

/** Mirror state where GLEIF completed a sync but the sanctions lists never did. */
async function gleifOnlyService(): Promise<SeededService> {
  const state = await emptyGlobalService();
  await state.service.ingestLeiEntities(FIXTURE_LEI_ENTITIES);
  await state.service.ingestLeiRelationships(FIXTURE_LEI_RELATIONSHIPS);
  await state.service.markLeiReady(FIXTURE_LEI_ENTITIES.length);
  return state;
}

/** Mirror state where the sanctions lists completed a sync but GLEIF never did. */
async function sanctionsOnlyService(): Promise<SeededService> {
  const state = await emptyGlobalService();
  await state.service.ingestDesignations(FIXTURE_DESIGNATIONS);
  await state.service.markSanctionsReady(FIXTURE_DESIGNATIONS.length);
  return state;
}

describe('sanctions://designation/{source}/{entryId} readiness gate', () => {
  it('reports mirror_not_ready before the sanctions mirror has ever synced', async () => {
    global = await emptyGlobalService();
    await expect(
      designationResource.handler(
        parseParams(designationResource, { source: 'ofac_sdn', entryId: '22790' }),
        ctxFor(designationResource.errors),
      ),
    ).rejects.toMatchObject({
      data: { reason: 'mirror_not_ready', retryable: true, recovery: { hint: expect.any(String) } },
    });
  });

  it('gates on the sanctions mirror alone, not on GLEIF readiness', async () => {
    global = await gleifOnlyService();
    await expect(
      designationResource.handler(
        parseParams(designationResource, { source: 'ofac_sdn', entryId: 'FX-1001' }),
        ctxFor(designationResource.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
  });

  it('still reports designation_not_found for an unknown ID on a ready mirror', async () => {
    global = await seededGlobalService();
    await expect(
      designationResource.handler(
        parseParams(designationResource, { source: 'ofac_sdn', entryId: 'NO-SUCH-ENTRY' }),
        ctxFor(designationResource.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'designation_not_found' } });
  });

  it('declares both readiness and not-found reasons in its error contract', () => {
    expect(designationResource.errors?.map((entry) => entry.reason).sort()).toEqual([
      'designation_not_found',
      'mirror_not_ready',
    ]);
  });
});

describe('sanctions://entity/{lei} readiness gate', () => {
  it('reports mirror_not_ready before the GLEIF mirror has ever synced', async () => {
    global = await emptyGlobalService();
    await expect(
      entityResource.handler(
        parseParams(entityResource, { lei: '5493001KJTIIGC8Y1R12' }),
        ctxFor(entityResource.errors),
      ),
    ).rejects.toMatchObject({
      data: { reason: 'mirror_not_ready', retryable: true, recovery: { hint: expect.any(String) } },
    });
  });

  it('gates on the GLEIF mirror alone, not on sanctions readiness', async () => {
    global = await sanctionsOnlyService();
    await expect(
      entityResource.handler(
        parseParams(entityResource, { lei: '5493001KJTIIGC8Y1R12' }),
        ctxFor(entityResource.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
  });

  it('still reports lei_not_found for an unknown LEI on a ready mirror', async () => {
    global = await seededGlobalService();
    await expect(
      entityResource.handler(
        parseParams(entityResource, { lei: '999900XXXXXXXXXXXX99' }),
        ctxFor(entityResource.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'lei_not_found' } });
  });

  it('declares both readiness and not-found reasons in its error contract', () => {
    expect(entityResource.errors?.map((entry) => entry.reason).sort()).toEqual([
      'lei_not_found',
      'mirror_not_ready',
    ]);
  });
});

describe('sanctions://sources provenance parity', () => {
  it('carries the same url and license per source code as sanctions_list_sources', async () => {
    global = await seededGlobalService();
    const tool = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      createMockContext(),
    );
    const payload = SourcesPayload.parse(
      await sourcesResource.handler(parseParams(sourcesResource, {}), createMockContext()),
    );

    expect(payload.sources.map((source) => source.code)).toEqual(
      tool.sources.map((source) => source.code),
    );
    for (const expected of tool.sources) {
      expect(payload.sources.find((source) => source.code === expected.code)).toMatchObject({
        label: expected.label,
        recordCount: expected.recordCount,
        url: expected.url,
        license: expected.license,
      });
    }
    // The synthetic GLEIF row keeps its resource-only relationship count.
    expect(payload.sources.find((source) => source.code === 'gleif')).toMatchObject({
      relationshipCount: FIXTURE_LEI_RELATIONSHIPS.length,
    });
  });

  it('preserves the top-level readiness and freshness fields', async () => {
    global = await seededGlobalService();
    const payload = SourcesPayload.parse(
      await sourcesResource.handler(parseParams(sourcesResource, {}), createMockContext()),
    );
    expect(payload).toMatchObject({ sanctionsReady: true, leiReady: true });
    expect(payload.sanctionsAsOf).toEqual(expect.any(String));
    expect(payload.leiAsOf).toEqual(expect.any(String));
    expect(payload.gleifBaseUrl).toMatch(/^https?:\/\//);
  });

  it('reports an unsynced mirror as data instead of refusing to run', async () => {
    global = await emptyGlobalService();
    const payload = SourcesPayload.parse(
      await sourcesResource.handler(parseParams(sourcesResource, {}), createMockContext()),
    );
    expect(payload).toMatchObject({ sanctionsReady: false, leiReady: false });
    expect(payload.sanctionsAsOf).toBeUndefined();
    for (const source of payload.sources) {
      expect(source).toMatchObject({ recordCount: 0, url: expect.any(String) });
      expect(String(source.license)).not.toHaveLength(0);
    }
  });
});
