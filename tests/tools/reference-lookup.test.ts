/**
 * @fileoverview Published list reference numbers (issue #42) through the tools
 * and the designation resource: a designation is reachable by its
 * `sourceEntryId` or its `referenceNumber`, trimmed and case-insensitive, both
 * surfaces carry the reference, and a reference held by more than one
 * designation fails `reference_ambiguous` rather than picking one. The corpus is
 * parsed from source-shaped documents, so each reference is the ingest's own read.
 * @module tests/tools/reference-lookup.test
 */

import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { designationResource } from '@/mcp-server/resources/definitions/designation.resource.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import type { SourceCode } from '@/services/screening/types.js';
import { type SeededService, seededGlobalService } from '../services/_helpers.js';
import { lookupDesignations } from '../services/_lookup-corpus.js';

const ctxFor = <const E extends readonly ErrorContract[] | undefined>(errors: E) =>
  createMockContext({ errors });

let seeded: SeededService;

beforeEach(async () => {
  seeded = await seededGlobalService();
  await seeded.service.ingestDesignations(lookupDesignations());
});

afterEach(async () => {
  await seeded.cleanup();
});

function getDesignation(source: SourceCode, entryId: string) {
  return getDesignationTool.handler(
    getDesignationTool.input.parse({ source, entryId }),
    ctxFor(getDesignationTool.errors),
  );
}

async function readResource(source: SourceCode, entryId: string) {
  const params = designationResource.params?.parse({ source, entryId });
  if (!params) throw new Error('the designation resource declares no params schema');
  return (await designationResource.handler(params, ctxFor(designationResource.errors))) as Record<
    string,
    unknown
  >;
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('sanctions_get_designation by published reference number', () => {
  it.each(['QDe.004', 'qde.004', ' QDe.004 '])(
    'resolves UN %j to the designation that publishes it',
    async (entryId) => {
      await expect(getDesignation('un', entryId)).resolves.toMatchObject({
        source: 'un',
        sourceEntryId: '113458',
        referenceNumber: 'QDe.004',
        primaryName: 'AL-QAIDA',
      });
    },
  );

  it.each(['RUS0251', 'rus0251', ' RUS0251 ', '14196'])(
    'resolves UK %j to RUS0251 by its entry ID or its OFSI Group ID',
    async (entryId) => {
      await expect(getDesignation('uk', entryId)).resolves.toMatchObject({
        sourceEntryId: 'RUS0251',
        referenceNumber: '14196',
      });
    },
  );

  it('resolves an EU reference number to its logical ID', async () => {
    await expect(getDesignation('eu', 'eu.3343.85')).resolves.toMatchObject({
      sourceEntryId: '927',
      referenceNumber: 'EU.3343.85',
    });
  });

  it('stores a reference number the feed publishes with trailing whitespace trimmed', async () => {
    await expect(getDesignation('un', '6908499')).resolves.toMatchObject({
      referenceNumber: 'KPe.023',
    });
    await expect(getDesignation('un', 'KPe.023')).resolves.toMatchObject({
      sourceEntryId: '6908499',
    });
  });

  it('carries no reference number on an OFAC record and on a UK record issued none', async () => {
    const ofac = await getDesignation('ofac_sdn', '4243');
    expect(ofac).not.toHaveProperty('referenceNumber');
    const uk = await getDesignation('uk', 'RUS3686');
    expect(uk).not.toHaveProperty('referenceNumber');
  });

  it('renders the reference number beside the entry ID in content[]', async () => {
    const result = await runToolContract(getDesignationTool, { source: 'un', entryId: 'qde.004' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      sourceEntryId: '113458',
      referenceNumber: 'QDe.004',
    });
    expect(text(result)).toContain('**Entry ID:** 113458 | **Reference:** QDe.004');
  });

  it('fails reference_ambiguous naming every designation that holds the reference', async () => {
    const error = await Promise.resolve()
      .then(() => getDesignation('uk', '13923'))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'reference_ambiguous', sourceEntryIds: ['BEL0005', 'GHR0055'] },
    });
    expect((error as Error).message).toContain('BEL0005');
    expect((error as Error).message).toContain('GHR0055');

    const result = await runToolContract(getDesignationTool, { source: 'uk', entryId: '13923' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('BEL0005');
    expect(text(result)).toContain('GHR0055');
  });

  it('still resolves each designation that shares an ambiguous reference by its own entry ID', async () => {
    await expect(getDesignation('uk', 'ghr0055')).resolves.toMatchObject({
      sourceEntryId: 'GHR0055',
      referenceNumber: '13923',
    });
  });

  it('reports an unknown ID, and a reference in another source, as designation_not_found', async () => {
    await expect(getDesignation('ofac_sdn', 'QDe.004')).rejects.toMatchObject({
      data: { reason: 'designation_not_found' },
    });
    await expect(getDesignation('un', 'QDe.999')).rejects.toMatchObject({
      data: { reason: 'designation_not_found' },
    });
  });

  it('rejects an entry ID that is only whitespace as not found, not as a wildcard', async () => {
    await expect(getDesignation('uk', '   ')).rejects.toMatchObject({
      data: { reason: 'designation_not_found' },
    });
  });
});

describe('sanctions_get_designation when an entry ID and a reference number collide', () => {
  /** A bare UK designation with the given entry ID and, optionally, reference number. */
  const uk = (sourceEntryId: string, referenceNumber?: string) => ({
    id: `uk:${sourceEntryId}`,
    source: 'uk' as const,
    sourceEntryId,
    entityType: 'person' as const,
    primaryName: `Holder ${sourceEntryId}`,
    ...(referenceNumber ? { referenceNumber } : {}),
    payload: { aliases: [], identifiers: [], addresses: [], datesOfBirth: [], nationalities: [] },
  });

  it('resolves an entry ID before a reference number another designation publishes', async () => {
    await seeded.service.ingestDesignations([uk('ZZ0001'), uk('ZZ0002', 'zz0001')]);
    await expect(getDesignation('uk', 'ZZ0001')).resolves.toMatchObject({
      sourceEntryId: 'ZZ0001',
    });
    await expect(getDesignation('uk', 'Zz0001')).resolves.toMatchObject({
      sourceEntryId: 'ZZ0001',
    });
  });

  it('prefers the entry ID of exactly the case given over one that differs only by case', async () => {
    await seeded.service.ingestDesignations([uk('CASE-A'), uk('case-a')]);
    await expect(getDesignation('uk', 'case-a')).resolves.toMatchObject({
      sourceEntryId: 'case-a',
    });
    await expect(getDesignation('uk', 'CASE-A')).resolves.toMatchObject({
      sourceEntryId: 'CASE-A',
    });
  });
});

describe('sanctions://designation/{source}/{entryId} by published reference number', () => {
  it('resolves the same way the tool does', async () => {
    await expect(readResource('un', 'qde.004')).resolves.toMatchObject({
      sourceEntryId: '113458',
      referenceNumber: 'QDe.004',
    });
    await expect(readResource('uk', ' rus0251 ')).resolves.toMatchObject({
      sourceEntryId: 'RUS0251',
      referenceNumber: '14196',
    });
  });

  it('fails reference_ambiguous with the same candidates as the tool', async () => {
    await expect(readResource('uk', '13923')).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'reference_ambiguous', sourceEntryIds: ['BEL0005', 'GHR0055'] },
    });
  });
});

describe('sanctions_screen_name hits carry the reference number', () => {
  it('on both surfaces when the designation publishes one, and omit it when not', async () => {
    const result = await runToolContract(screenNameTool, { name: 'Vladimir PUTIN' });
    const hits = (result.structuredContent as { hits: Record<string, unknown>[] }).hits;
    expect(hits[0]).toMatchObject({ sourceEntryId: 'RUS0251', referenceNumber: '14196' });
    expect(text(result)).toContain('**Entry ID:** RUS0251 | **Reference:** 14196');

    const vessel = await runToolContract(screenNameTool, { name: 'EBANO' });
    const vesselHits = (vessel.structuredContent as { hits: Record<string, unknown>[] }).hits;
    expect(vesselHits[0]).toMatchObject({ sourceEntryId: '4243' });
    expect(vesselHits[0]).not.toHaveProperty('referenceNumber');
    expect(text(vessel)).not.toContain('**Reference:**');
  });
});
