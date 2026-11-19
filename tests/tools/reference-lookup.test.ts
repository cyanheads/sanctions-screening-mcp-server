/**
 * @fileoverview Published list reference numbers (issues #42, #89) through the
 * tools and the designation resource: a designation is reachable by its
 * `sourceEntryId`, its `referenceNumber`, or — on uk and eu — the
 * `unReferenceNumber` it implements, in that order, trimmed and
 * case-insensitive, a UN reference also regardless of zero padding; both
 * surfaces carry each reference, and a reference held by more than one
 * designation fails `reference_ambiguous` rather than picking one.
 * The corpus is parsed from source-shaped documents, so each reference is the
 * ingest's own read.
 * @module tests/tools/reference-lookup.test
 */

import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { designationResource } from '@/mcp-server/resources/definitions/designation.resource.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { parseEu, parseUk, parseUn } from '@/services/screening/sanctions-ingest.js';
import type { NormalizedDesignation, SourceCode } from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';
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

// ─── UN reference numbers on uk and eu designations (issue #89) ───────────────

/**
 * Excerpts of the UK, EU, and UN publications, IDs and values as published:
 * AFG0001 implements UN `TAe.010`, which the UN list publishes on 2989469;
 * INU0276 and INU0279 both carry `IRi.012`, as do EU 112309 and 112314 `KPi.045`;
 * EU 118593 publishes `LYi.28` unpadded, which the UN list publishes as `LYi.028`
 * on 6908759; EU 176973 publishes `HTe.001` padded; SYR0200 publishes the `N/A`
 * placeholder.
 */
const UN_LINK_DOCUMENTS = {
  uk: `<?xml version="1.0" encoding="utf-8"?><Designations>
    <Designation><UniqueID>AFG0001</UniqueID><OFSIGroupID>12703</OFSIGroupID><UNReferenceNumber>TAe.010</UNReferenceNumber>
      <Names><Name><Name6>HAJI KHAIRULLAH HAJI SATTAR MONEY EXCHANGE</Name6><NameType>Primary Name</NameType></Name></Names>
      <IndividualEntityShip>Entity</IndividualEntityShip><DesignationSource>UN</DesignationSource><SanctionsImposed>Asset freeze</SanctionsImposed>
    </Designation>
    <Designation><UniqueID>INU0276</UniqueID><OFSIGroupID>16161</OFSIGroupID><UNReferenceNumber>IRi.012</UNReferenceNumber>
      <Names><Name><Name1>AHMAD</Name1><Name2>VAHID</Name2><Name6>DASTJERDI</Name6><NameType>Primary name</NameType></Name></Names>
      <IndividualEntityShip>Individual</IndividualEntityShip><DesignationSource>UK|UN</DesignationSource>
    </Designation>
    <Designation><UniqueID>INU0279</UniqueID><OFSIGroupID>16164</OFSIGroupID><UNReferenceNumber>IRi.012</UNReferenceNumber>
      <Names><Name><Name1>AZIM</Name1><Name6>AGHAJANI</Name6><NameType>Primary name</NameType></Name></Names>
      <IndividualEntityShip>Individual</IndividualEntityShip><DesignationSource>UK|UN</DesignationSource>
    </Designation>
    <Designation><UniqueID>SYR0200</UniqueID><OFSIGroupID>13410</OFSIGroupID><UNReferenceNumber>N/A</UNReferenceNumber>
      <Names><Name><Name6>Sa'ad</Name6><NameType>Primary name</NameType></Name></Names>
      <IndividualEntityShip>Individual</IndividualEntityShip><DesignationSource>UK</DesignationSource>
    </Designation>
  </Designations>`,
  eu: `<?xml version="1.0" encoding="UTF-8"?><export>
    <sanctionEntity unitedNationId="LYi.28" euReferenceNumber="EU.4801.12" logicalId="118593"><subjectType code="person"/><nameAlias wholeName="Salah Badi" strong="true"/></sanctionEntity>
    <sanctionEntity unitedNationId="KPi.045" euReferenceNumber="EU.4075.27" logicalId="112309"><subjectType code="person"/><nameAlias wholeName="Kyong Ok Kim" strong="true"/></sanctionEntity>
    <sanctionEntity unitedNationId="KPi.045" euReferenceNumber="EU.4076.89" logicalId="112314"><subjectType code="person"/><nameAlias wholeName="Tong-Ho Kim" strong="true"/></sanctionEntity>
    <sanctionEntity unitedNationId="HTe.001" euReferenceNumber="EU.13342.93" logicalId="176973"><subjectType code="enterprise"/><nameAlias wholeName="GRAN GRIF" strong="true"/></sanctionEntity>
  </export>`,
  un: `<?xml version="1.0" encoding="utf-8"?><CONSOLIDATED_LIST><INDIVIDUALS>
    <INDIVIDUAL><DATAID>6908759</DATAID><REFERENCE_NUMBER>LYi.028</REFERENCE_NUMBER><FIRST_NAME>Salah</FIRST_NAME><SECOND_NAME>Badi</SECOND_NAME></INDIVIDUAL>
  </INDIVIDUALS><ENTITIES>
    <ENTITY><DATAID>2989469</DATAID><REFERENCE_NUMBER>TAe.010</REFERENCE_NUMBER><FIRST_NAME>HAJI KHAIRULLAH HAJI SATTAR MONEY EXCHANGE</FIRST_NAME></ENTITY>
  </ENTITIES></CONSOLIDATED_LIST>`,
};

function unLinkDesignations(): NormalizedDesignation[] {
  return [
    ...parseEu(parseXml(UN_LINK_DOCUMENTS.eu)),
    ...parseUk(parseXml(UN_LINK_DOCUMENTS.uk)),
    ...parseUn(parseXml(UN_LINK_DOCUMENTS.un)),
  ];
}

/** The way a release that never read the UN reference stored each record: the column NULL. */
function storedBeforeTheColumn(): NormalizedDesignation[] {
  return unLinkDesignations().map(({ unReferenceNumber: _dropped, ...d }) => d);
}

/** The failure a tool call returns on the wire, the declared recovery filled in. */
async function wireError(source: SourceCode, entryId: string) {
  const result = await runToolContract(getDesignationTool, { source, entryId });
  expect(result.isError).toBe(true);
  return {
    text: text(result),
    error: (result.structuredContent as { error: { code: number; data: Record<string, unknown> } })
      .error,
  };
}

describe('sanctions_get_designation by UN reference number (issue #89)', () => {
  beforeEach(async () => {
    await seeded.service.ingestDesignations(unLinkDesignations());
  });

  it.each(['TAe.010', 'tae.010', ' TAe.010 '])(
    'resolves uk %j to AFG0001, the designation that implements it',
    async (entryId) => {
      await expect(getDesignation('uk', entryId)).resolves.toMatchObject({
        source: 'uk',
        sourceEntryId: 'AFG0001',
        referenceNumber: '12703',
        unReferenceNumber: 'TAe.010',
      });
    },
  );

  it('resolves an EU UN reference published unpadded by either padding, returned as published', async () => {
    for (const entryId of ['LYi.28', 'lyi.28', 'LYi.028', 'lyi.028', ' LYI.0028 ']) {
      await expect(getDesignation('eu', entryId), entryId).resolves.toMatchObject({
        sourceEntryId: '118593',
        referenceNumber: 'EU.4801.12',
        unReferenceNumber: 'LYi.28',
      });
    }
  });

  it('answers every key the previous release resolved with the same record or error', async () => {
    await expect(getDesignation('uk', 'AFG0001')).resolves.toMatchObject({
      sourceEntryId: 'AFG0001',
    });
    await expect(getDesignation('uk', '12703')).resolves.toMatchObject({
      sourceEntryId: 'AFG0001',
    });
    await expect(getDesignation('un', 'QDe.004')).resolves.toMatchObject({
      sourceEntryId: '113458',
    });
    await expect(getDesignation('un', 'TAe.010')).resolves.toMatchObject({
      sourceEntryId: '2989469',
    });
    await expect(getDesignation('ofac_sdn', 'TAe.010')).rejects.toMatchObject({
      data: { reason: 'designation_not_found' },
    });
    const error = await Promise.resolve()
      .then(() => getDesignation('uk', '13923'))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      data: { reason: 'reference_ambiguous', sourceEntryIds: ['BEL0005', 'GHR0055'] },
    });
    expect((error as Error).message).toBe(
      'Reference number "13923" is published by 2 uk designations: BEL0005, GHR0055.',
    );
  });

  it('carries no UN reference for a record that publishes none or the N/A placeholder', async () => {
    for (const entryId of ['SYR0200', 'RUS0251']) {
      const record = await getDesignation('uk', entryId);
      expect(record, entryId).not.toHaveProperty('unReferenceNumber');
    }
    expect(await getDesignation('eu', '927')).not.toHaveProperty('unReferenceNumber');
    // The placeholder is no lookup key either.
    await expect(getDesignation('uk', 'N/A')).rejects.toMatchObject({
      data: { reason: 'designation_not_found' },
    });
  });

  it('renders the UN reference beside the entry ID and the reference number in content[]', async () => {
    const result = await runToolContract(getDesignationTool, { source: 'uk', entryId: 'tae.010' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      sourceEntryId: 'AFG0001',
      unReferenceNumber: 'TAe.010',
    });
    expect(text(result)).toContain(
      '**Entry ID:** AFG0001 | **Reference:** 12703 | **UN reference:** TAe.010',
    );
  });

  it.each([
    ['uk', 'IRi.012', ['INU0276', 'INU0279']],
    ['uk', ' iri.012 ', ['INU0276', 'INU0279']],
    ['eu', 'KPi.045', ['112309', '112314']],
  ] as const)(
    'fails %s %j reference_ambiguous, naming both designations that carry it',
    async (source, entryId, sourceEntryIds) => {
      const error = await Promise.resolve()
        .then(() => getDesignation(source, entryId))
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'reference_ambiguous', sourceEntryIds },
      });
      expect((error as Error).message).toBe(
        `UN reference number "${entryId.trim()}" is carried by 2 ${source} designations: ${sourceEntryIds.join(', ')}.`,
      );

      const wire = await wireError(source, entryId);
      expect(wire.error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'reference_ambiguous',
          sourceEntryIds,
          recovery: { hint: expect.stringContaining('sourceEntryIds') },
        },
      });
      for (const id of sourceEntryIds) expect(wire.text).toContain(id);
    },
  );

  it('still resolves each designation that shares an ambiguous UN reference by its own keys', async () => {
    await expect(getDesignation('uk', 'inu0279')).resolves.toMatchObject({
      sourceEntryId: 'INU0279',
      unReferenceNumber: 'IRi.012',
    });
    await expect(getDesignation('eu', 'EU.4076.89')).resolves.toMatchObject({
      sourceEntryId: '112314',
      unReferenceNumber: 'KPi.045',
    });
  });
});

describe('sanctions_get_designation when a UN reference collides with another key', () => {
  /** A bare UK designation with the given entry ID, reference number, and UN reference. */
  const uk = (sourceEntryId: string, referenceNumber?: string, unReferenceNumber?: string) => ({
    id: `uk:${sourceEntryId}`,
    source: 'uk' as const,
    sourceEntryId,
    entityType: 'person' as const,
    primaryName: `Holder ${sourceEntryId}`,
    ...(referenceNumber ? { referenceNumber } : {}),
    ...(unReferenceNumber ? { unReferenceNumber } : {}),
    payload: { aliases: [], identifiers: [], addresses: [], datesOfBirth: [], nationalities: [] },
  });

  it('resolves an entry ID before a UN reference another designation carries', async () => {
    await seeded.service.ingestDesignations([uk('ZZ0003'), uk('ZZ0004', undefined, 'zz0003')]);
    for (const entryId of ['ZZ0003', 'zz0003']) {
      await expect(getDesignation('uk', entryId), entryId).resolves.toMatchObject({
        sourceEntryId: 'ZZ0003',
      });
    }
  });

  it("resolves the list's own reference number before a UN reference, never as ambiguous", async () => {
    await seeded.service.ingestDesignations([
      uk('ZZ0005', '7777'),
      uk('ZZ0006', undefined, '7777'),
    ]);
    await expect(getDesignation('uk', '7777')).resolves.toMatchObject({
      sourceEntryId: 'ZZ0005',
    });
  });
});

describe('a UN reference number regardless of zero padding', () => {
  beforeEach(async () => {
    await seeded.service.ingestDesignations(unLinkDesignations());
  });

  /** A bare designation of `source` with the given entry ID and references. */
  const bare = (
    source: SourceCode,
    sourceEntryId: string,
    refs: { referenceNumber?: string; unReferenceNumber?: string },
  ): NormalizedDesignation => ({
    id: `${source}:${sourceEntryId}`,
    source,
    sourceEntryId,
    entityType: 'person',
    primaryName: `Holder ${sourceEntryId}`,
    ...refs,
    payload: { aliases: [], identifiers: [], addresses: [], datesOfBirth: [], nationalities: [] },
  });

  /** Two designations per list whose UN references differ only in padding. */
  const paddingTwins = () => [
    bare('uk', 'ZZ0007', { unReferenceNumber: 'QDi.43' }),
    bare('uk', 'ZZ0008', { unReferenceNumber: 'QDi.043' }),
    bare('un', 'ZZ-UN-1', { referenceNumber: 'ZZi.7' }),
    bare('un', 'ZZ-UN-2', { referenceNumber: 'ZZi.007' }),
  ];

  it.each([
    ['eu', 'LYi.028', '118593', { unReferenceNumber: 'LYi.28' }],
    ['eu', 'HTe.1', '176973', { unReferenceNumber: 'HTe.001' }],
    ['eu', 'hte.01', '176973', { unReferenceNumber: 'HTe.001' }],
    ['un', 'LYi.28', '6908759', { referenceNumber: 'LYi.028' }],
    ['un', ' lyi.28 ', '6908759', { referenceNumber: 'LYi.028' }],
    ['uk', 'TAe.10', 'AFG0001', { unReferenceNumber: 'TAe.010' }],
  ] as const)(
    'resolves %s %j to %s, the reference returned as published on both surfaces',
    async (source, entryId, sourceEntryId, published) => {
      const result = await runToolContract(getDesignationTool, { source, entryId });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ source, sourceEntryId, ...published });
      expect(text(result)).toContain(`**Entry ID:** ${sourceEntryId}`);
      expect(text(result)).toContain(
        'unReferenceNumber' in published
          ? `**UN reference:** ${published.unReferenceNumber}`
          : `**Reference:** ${published.referenceNumber}`,
      );
      await expect(readResource(source, entryId)).resolves.toMatchObject({
        source,
        sourceEntryId,
        ...published,
      });
    },
  );

  it('follows the UN reference an EU record publishes to the UN record that pads it', async () => {
    const eu = await getDesignation('eu', '118593');
    expect(eu.unReferenceNumber).toBe('LYi.28');
    await expect(getDesignation('un', eu.unReferenceNumber ?? '')).resolves.toMatchObject({
      sourceEntryId: '6908759',
      referenceNumber: 'LYi.028',
    });
  });

  it.each([
    ['uk', '012703'],
    ['eu', 'EU.4801.012'],
    ['uk', 'AFG001'],
    ['ofac_sdn', 'TAe.10'],
  ] as const)(
    'keeps %s %j designation_not_found: a key not shaped like a UN reference keeps its zeros',
    async (source, entryId) => {
      const wire = await wireError(source, entryId);
      expect(wire.error.data.reason).toBe('designation_not_found');
      await expect(readResource(source, entryId)).rejects.toMatchObject({
        data: { reason: 'designation_not_found' },
      });
    },
  );

  it("never reinterprets a UK or EU list's own reference number shaped like a UN reference", async () => {
    await seeded.service.ingestDesignations([
      bare('eu', 'ZZ-EU-1', { referenceNumber: 'QDe.077' }),
    ]);
    await expect(getDesignation('eu', 'qde.077')).resolves.toMatchObject({
      sourceEntryId: 'ZZ-EU-1',
    });
    await expect(getDesignation('eu', 'QDe.77')).rejects.toMatchObject({
      data: { reason: 'designation_not_found' },
    });
  });

  it('resolves an exact match before a padding-insensitive match of another designation', async () => {
    await seeded.service.ingestDesignations(paddingTwins());
    for (const [source, entryId, sourceEntryId] of [
      ['uk', 'QDi.43', 'ZZ0007'],
      ['uk', 'qdi.043', 'ZZ0008'],
      ['un', 'ZZi.7', 'ZZ-UN-1'],
      ['un', 'zzi.007', 'ZZ-UN-2'],
    ] as const) {
      await expect(getDesignation(source, entryId), entryId).resolves.toMatchObject({
        sourceEntryId,
      });
      await expect(readResource(source, entryId), entryId).resolves.toMatchObject({
        sourceEntryId,
      });
    }
  });

  it.each([
    ['uk', 'QDi.0043', 'UN reference number "QDi.0043" is carried by', ['ZZ0007', 'ZZ0008']],
    ['un', 'ZZi.07', 'Reference number "ZZi.07" is published by', ['ZZ-UN-1', 'ZZ-UN-2']],
    ['eu', 'KPi.45', 'UN reference number "KPi.45" is carried by', ['112309', '112314']],
  ] as const)(
    'fails %s %j reference_ambiguous when two designations match it only through padding',
    async (source, entryId, held, sourceEntryIds) => {
      await seeded.service.ingestDesignations(paddingTwins());
      const message = `${held} 2 ${source} designations: ${sourceEntryIds.join(', ')}.`;
      const wire = await wireError(source, entryId);
      expect(wire.error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'reference_ambiguous', sourceEntryIds },
      });
      expect(wire.text).toContain(message);
      const error = await readResource(source, entryId).catch((e: unknown) => e);
      expect(error).toMatchObject({ data: { reason: 'reference_ambiguous', sourceEntryIds } });
      expect((error as Error).message).toBe(message);
    },
  );
});

describe('designation_not_found recovery on every source', () => {
  const TOOL_RECOVERY =
    'Verify the source and entryId via sanctions_screen_name, which returns the exact sourceEntryId for each hit; for a UN reference number on a source other than un, look it up with source un to get the party to screen.';
  const RESOURCE_RECOVERY =
    'Use sanctions_screen_name to discover valid source/entryId pairs first; for a UN reference number on a source other than un, read it with source un to get the party to screen.';

  it.each(['un', 'uk'] as const)(
    'sends a %s caller to source un only for a reference on another source',
    async (source) => {
      const { error, text: wireText } = await wireError(source, 'QDi.999');
      expect(error.data).toMatchObject({
        reason: 'designation_not_found',
        recovery: { hint: TOOL_RECOVERY },
      });
      expect(wireText).toContain(TOOL_RECOVERY);
      await expect(readResource(source, 'QDi.999')).rejects.toMatchObject({
        data: { reason: 'designation_not_found' },
      });
      expect(
        designationResource.errors?.find((e) => e.reason === 'designation_not_found')?.recovery,
      ).toBe(RESOURCE_RECOVERY);
    },
  );
});

describe('a UN reference before a refresh stores the column', () => {
  beforeEach(async () => {
    await seeded.service.ingestDesignations(storedBeforeTheColumn());
  });

  it('misses as any unknown key misses, with the declared recovery', async () => {
    const unknown = await wireError('uk', 'NO-SUCH-KEY');
    const pending = await wireError('uk', 'TAe.010');
    expect(pending.error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(pending.error.data).toEqual({
      ...unknown.error.data,
      requestId: pending.error.data.requestId,
    });
    const declared = getDesignationTool.errors?.find((e) => e.reason === 'designation_not_found');
    expect(pending.error.data).toMatchObject({
      reason: 'designation_not_found',
      recovery: { hint: declared?.recovery },
    });
    expect(pending.text).toContain(
      'No uk designation with entry ID, reference number, or UN reference number "TAe.010".',
    );
    // The two records that will share IRi.012 are not ambiguous until both carry it.
    expect((await wireError('uk', 'IRi.012')).error.data.reason).toBe('designation_not_found');
  });

  it('names a recovery the caller can follow from a UN reference alone', async () => {
    const { error } = await wireError('uk', 'TAe.010');
    expect(error.data.recovery).toMatchObject({ hint: expect.stringContaining('source un') });
    // The recovery's hop: the UN list resolves its own reference number to the party.
    await expect(getDesignation('un', 'TAe.010')).resolves.toMatchObject({
      sourceEntryId: '2989469',
      primaryName: 'HAJI KHAIRULLAH HAJI SATTAR MONEY EXCHANGE',
    });
    // And every other key of the record still answers.
    await expect(getDesignation('uk', '12703')).resolves.not.toHaveProperty('unReferenceNumber');
  });
});

describe('sanctions://designation/{source}/{entryId} by UN reference number (issue #89)', () => {
  beforeEach(async () => {
    await seeded.service.ingestDesignations(unLinkDesignations());
  });

  it('resolves and returns the UN reference the way the tool does', async () => {
    await expect(readResource('uk', ' tae.010 ')).resolves.toMatchObject({
      sourceEntryId: 'AFG0001',
      referenceNumber: '12703',
      unReferenceNumber: 'TAe.010',
    });
    await expect(readResource('eu', 'LYi.28')).resolves.toMatchObject({
      sourceEntryId: '118593',
      unReferenceNumber: 'LYi.28',
    });
    // Percent-encoded as a URI segment, decoded once.
    await expect(readResource('uk', 'TAe%2E010')).resolves.toMatchObject({
      sourceEntryId: 'AFG0001',
    });
  });

  it('omits the UN reference on the wire when the designation carries none', async () => {
    const payload = JSON.parse(JSON.stringify(await readResource('uk', 'SYR0200')));
    expect(payload).toMatchObject({ sourceEntryId: 'SYR0200' });
    expect(payload).not.toHaveProperty('unReferenceNumber');
  });

  it.each([
    ['uk', 'IRi.012', ['INU0276', 'INU0279']],
    ['eu', 'kpi.045', ['112309', '112314']],
  ] as const)(
    'fails %s %j reference_ambiguous with the same candidates as the tool',
    async (source, entryId, sourceEntryIds) => {
      const error = await Promise.resolve()
        .then(() => readResource(source, entryId))
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'reference_ambiguous', sourceEntryIds },
      });
      expect((error as Error).message).toBe(
        `UN reference number "${entryId}" is carried by 2 ${source} designations: ${sourceEntryIds.join(', ')}.`,
      );
    },
  );
});
