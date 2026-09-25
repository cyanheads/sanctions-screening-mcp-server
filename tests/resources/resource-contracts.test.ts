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
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import {
  FIXTURE_DESIGNATIONS,
  FIXTURE_LEI_ENTITIES,
  FIXTURE_LEI_RELATIONSHIPS,
} from '@/services/screening/fixtures.js';
import { parseOfac } from '@/services/screening/sanctions-ingest.js';
import { parseXml } from '@/services/screening/xml.js';
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
  reportingExceptionsLoaded: z.boolean(),
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

  it('declares the readiness, not-found, and ambiguous-reference reasons in its error contract', () => {
    expect(designationResource.errors?.map((entry) => entry.reason).sort()).toEqual([
      'designation_not_found',
      'mirror_not_ready',
      'reference_ambiguous',
    ]);
  });

  it('returns the same published detail groups as sanctions_get_designation', async () => {
    global = await seededGlobalService();
    // An OFAC advanced party whose groups resolve through the cross-referenced blocks.
    await global.service.ingestDesignations(
      parseOfac(
        parseXml(`<Sanctions>
          <ReferenceValueSets>
            <AliasTypeValues><AliasType ID="1403">Name</AliasType></AliasTypeValues>
            <CountryValues><Country ID="11216">Venezuela</Country></CountryValues>
            <FeatureTypeValues>
              <FeatureType ID="8">Birthdate</FeatureType><FeatureType ID="10">Nationality Country</FeatureType>
              <FeatureType ID="13">SWIFT/BIC</FeatureType><FeatureType ID="25">Location</FeatureType>
            </FeatureTypeValues>
            <IDRegDocTypeValues><IDRegDocType ID="1570">Cedula No.</IDRegDocType></IDRegDocTypeValues>
            <LocPartTypeValues><LocPartType ID="1">Unknown</LocPartType><LocPartType ID="1454">CITY</LocPartType></LocPartTypeValues>
          </ReferenceValueSets>
          <Locations>
            <Location ID="1"><LocationCountry CountryID="11216" CountryRelevanceID="1413" />
              <LocationPart LocPartTypeID="1454"><LocationPartValue Primary="true"><Value>Caracas</Value></LocationPartValue></LocationPart>
            </Location>
            <Location ID="2"><LocationPart LocPartTypeID="1"><LocationPartValue Primary="true"><Value>Venezuela</Value></LocationPartValue></LocationPart></Location>
          </Locations>
          <IDRegDocuments>
            <IDRegDocument ID="1" IDRegDocTypeID="1570" IdentityID="14494" IssuedBy-CountryID="11216"><IDRegistrationNo>5892464</IDRegistrationNo></IDRegDocument>
          </IDRegDocuments>
          <DistinctParties><DistinctParty FixedRef="22790"><Profile ID="22790"><Identity ID="14494">
            <Alias AliasTypeID="1403" Primary="true"><DocumentedName><DocumentedNamePart><NamePartValue>MADURO MOROS Nicolas</NamePartValue></DocumentedNamePart></DocumentedName></Alias>
            </Identity>
            <Feature FeatureTypeID="25"><FeatureVersion ID="1"><VersionLocation LocationID="1" /></FeatureVersion></Feature>
            <Feature FeatureTypeID="10"><FeatureVersion ID="2"><VersionLocation LocationID="2" /></FeatureVersion></Feature>
            <Feature FeatureTypeID="13"><FeatureVersion ID="3"><VersionDetail DetailTypeID="1432">BCVEVECA</VersionDetail></FeatureVersion></Feature>
            <Feature FeatureTypeID="8"><FeatureVersion ID="4"><DatePeriod CalendarTypeID="1">
              <Start Approximate="true"><From><Year>1962</Year><Month>1</Month><Day>1</Day></From><To><Year>1962</Year><Month>1</Month><Day>1</Day></To></Start>
              <End Approximate="true"><From><Year>1962</Year><Month>12</Month><Day>31</Day></From><To><Year>1962</Year><Month>12</Month><Day>31</Day></To></End>
            </DatePeriod></FeatureVersion></Feature>
          </Profile></DistinctParty></DistinctParties>
        </Sanctions>`),
        'ofac_sdn',
      ),
    );
    const params = { source: 'ofac_sdn', entryId: '22790' } as const;
    const payload = (await designationResource.handler(
      parseParams(designationResource, params),
      ctxFor(designationResource.errors),
    )) as Record<string, unknown>;
    const tool = await getDesignationTool.handler(
      getDesignationTool.input.parse(params),
      ctxFor(getDesignationTool.errors),
    );

    const groups = {
      identifiers: [
        { type: 'Cedula No.', value: '5892464', country: 'Venezuela' },
        { type: 'SWIFT/BIC', value: 'BCVEVECA' },
      ],
      addresses: [{ full: 'Caracas, Venezuela', country: 'Venezuela' }],
      datesOfBirth: [{ date: '1962', circa: true }],
      nationalities: ['Venezuela'],
    };
    expect(payload).toMatchObject(groups);
    expect(tool).toMatchObject(groups);
  });
});

describe('sanctions://designation/{source}/{entryId} percent-encoded entry IDs (#44)', () => {
  it.each(['%46X-1001', 'FX%2D1001', '%46%58%2D%31%30%30%31'])(
    'decodes %j once before the lookup',
    async (entryId) => {
      global = await seededGlobalService();
      await expect(
        designationResource.handler(
          parseParams(designationResource, { source: 'ofac_sdn', entryId }),
          ctxFor(designationResource.errors),
        ),
      ).resolves.toMatchObject({ sourceEntryId: 'FX-1001', primaryName: 'Ivan Testovich Volkov' });
    },
  );

  it('decodes once only — an escaped percent sign stays a literal percent sign', async () => {
    global = await seededGlobalService();
    // `%2546X-1001` decodes to `%46X-1001`; a second pass would reach FX-1001.
    await expect(
      designationResource.handler(
        parseParams(designationResource, { source: 'ofac_sdn', entryId: '%2546X-1001' }),
        ctxFor(designationResource.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'designation_not_found' } });
  });

  it.each(['%E0%A4%A', '%', 'FX-1001%'])(
    'answers the malformed escape %j as designation_not_found, not a URIError',
    async (entryId) => {
      global = await seededGlobalService();
      const error = await Promise.resolve()
        .then(() =>
          designationResource.handler(
            parseParams(designationResource, { source: 'ofac_sdn', entryId }),
            ctxFor(designationResource.errors),
          ),
        )
        .catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(URIError);
      expect(error).toMatchObject({ data: { reason: 'designation_not_found' } });
    },
  );
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

  it('returns the entity record for a known LEI', async () => {
    global = await seededGlobalService();
    const payload = await entityResource.handler(
      parseParams(entityResource, { lei: '5493001KJTIIGC8Y1R12' }),
      ctxFor(entityResource.errors),
    );
    expect(payload).toEqual(FIXTURE_LEI_ENTITIES[0]);
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

  it('reports the reporting-exception count on both surfaces once the dataset is loaded', async () => {
    global = await seededGlobalService();
    const tool = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      createMockContext(),
    );
    const payload = SourcesPayload.parse(
      await sourcesResource.handler(parseParams(sourcesResource, {}), createMockContext()),
    );

    const expected = (await global.service.leiReadiness()).exceptionCount;
    expect(expected).toBeGreaterThan(0);
    expect(tool.reportingExceptionsLoaded).toBe(true);
    expect(payload).toMatchObject({ reportingExceptionsLoaded: true });
    expect(tool.sources.find((source) => source.code === 'gleif')).toMatchObject({
      reportingExceptionCount: expected,
    });
    expect(payload.sources.find((source) => source.code === 'gleif')).toMatchObject({
      reportingExceptionCount: expected,
    });
  });

  it('omits the count on both surfaces, and says so, when the dataset has no recorded load', async () => {
    global = await gleifOnlyService();
    const tool = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      createMockContext(),
    );
    const payload = SourcesPayload.parse(
      await sourcesResource.handler(parseParams(sourcesResource, {}), createMockContext()),
    );

    expect(tool.reportingExceptionsLoaded).toBe(false);
    expect(payload).toMatchObject({ reportingExceptionsLoaded: false });
    expect(tool.sources.find((source) => source.code === 'gleif')).not.toHaveProperty(
      'reportingExceptionCount',
    );
    expect(payload.sources.find((source) => source.code === 'gleif')).not.toHaveProperty(
      'reportingExceptionCount',
    );
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
