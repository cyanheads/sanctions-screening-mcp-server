/**
 * @fileoverview Tool-level tests over the seeded global service: handler output,
 * format() parity (the caveat and key fields reach content[]), the
 * decision-support framing, and the mirror-not-ready error contract.
 * @module tests/tools/screening-tools.test
 */

import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import { parseEu, parseOfac, parseUk, parseUn } from '@/services/screening/sanctions-ingest.js';
import { parseXml } from '@/services/screening/xml.js';
import {
  emptyGlobalService,
  type SeededService,
  seededGlobalService,
} from '../services/_helpers.js';

/**
 * A mock context whose typed `ctx.fail` is wired against a tool's error
 * contract. `const E` keeps the reason union intact, so the returned context
 * satisfies the `HandlerContext<Reason>` the handler declares.
 */
const ctxFor = <const E extends readonly ErrorContract[] | undefined>(errors: E) =>
  createMockContext({ errors });

describe('screening tools (seeded)', () => {
  let seeded: SeededService;
  beforeEach(async () => {
    seeded = await seededGlobalService();
  });
  afterEach(async () => {
    await seeded.cleanup();
  });

  it('screen_name returns scored hits and the decision-support caveat', async () => {
    const input = screenNameTool.input.parse({ name: 'Ivan Testovich Volkov' });
    const result = await screenNameTool.handler(input, ctxFor(screenNameTool.errors));
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.caveat).toMatch(/screening aid|not a compliance determination/i);

    const text = renderFormat(screenNameTool, result);
    expect(text).toContain('Ivan Testovich Volkov');
    expect(text).toMatch(/not a compliance determination/i);
  });

  it('screen_name surfaces the raw JW score for approximate hits in format()', async () => {
    const input = screenNameTool.input.parse({ name: 'Ivan Volkow', matchMode: 'fuzzy' });
    const result = await screenNameTool.handler(input, ctxFor(screenNameTool.errors));
    const approx = result.hits.find((h) => h.matchType === 'approximate');
    expect(approx?.score).toBeDefined();
    const text = renderFormat(screenNameTool, result);
    expect(text).toMatch(/score/i);
  });

  it('get_designation returns the full record with the caveat', async () => {
    const input = getDesignationTool.input.parse({ source: 'ofac_sdn', entryId: 'FX-1001' });
    const result = await getDesignationTool.handler(input, ctxFor(getDesignationTool.errors));
    expect(result.primaryName).toBe('Ivan Testovich Volkov');
    expect(result.aliases.length).toBeGreaterThan(0);
    expect(result.caveat).toBeTruthy();
  });

  it('get_designation throws the typed not-found error for an unknown entry', async () => {
    const input = getDesignationTool.input.parse({ source: 'ofac_sdn', entryId: 'MISSING' });
    await expect(
      getDesignationTool.handler(input, ctxFor(getDesignationTool.errors)),
    ).rejects.toMatchObject({ data: { reason: 'designation_not_found' } });
  });

  it('list_sources reports counts, readiness, and licenses', async () => {
    const result = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      createMockContext(),
    );
    expect(result.sanctionsReady).toBe(true);
    expect(result.leiReady).toBe(true);
    const uk = result.sources.find((s) => s.code === 'uk');
    expect(uk?.license).toMatch(/Open Government Licence/i);
    expect(result.sources.find((s) => s.code === 'gleif')?.license).toMatch(/CC0/i);
  });

  it('resolve_entity returns ranked LEI candidates', async () => {
    const input = resolveEntityTool.input.parse({ name: 'Fictional Trading Company LLC' });
    const result = await resolveEntityTool.handler(input, ctxFor(resolveEntityTool.errors));
    expect(result.matches[0]?.lei).toBe('5493001KJTIIGC8Y1R12');
  });

  it('get_entity returns the GLEIF record plus a sanctions cross-reference', async () => {
    const input = getEntityTool.input.parse({ lei: '5493001KJTIIGC8Y1R12' });
    const result = await getEntityTool.handler(input, ctxFor(getEntityTool.errors));
    expect(result.legalName).toBe('Fictional Trading Company LLC');
    // Its legal name matches the OFAC consolidated fixture designation.
    expect(result.sanctionsHits.length).toBeGreaterThan(0);
    expect(result.caveat).toBeTruthy();
  });

  it('trace_ownership walks the graph and screens nodes when asked', async () => {
    const input = traceOwnershipTool.input.parse({
      lei: '5493001KJTIIGC8Y1R12',
      direction: 'both',
      screenNodes: true,
    });
    const result = await traceOwnershipTool.handler(input, ctxFor(traceOwnershipTool.errors));
    expect(result.nodes.length).toBeGreaterThanOrEqual(2); // root + parent
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.screenedNodeCount).toBe(result.nodes.length);
    // The root entity's name collides with a fixture designation → flagged.
    expect(result.flaggedNodeCount).toBeGreaterThan(0);
  });

  it('trace_ownership throws not-found for an unknown root LEI', async () => {
    const input = traceOwnershipTool.input.parse({ lei: '00000000000000000000' });
    await expect(
      traceOwnershipTool.handler(input, ctxFor(traceOwnershipTool.errors)),
    ).rejects.toMatchObject({ data: { reason: 'lei_not_found' } });
  });
});

describe('query-token coverage on both client surfaces (issue #15)', () => {
  let seeded: SeededService;
  beforeEach(async () => {
    seeded = await seededGlobalService();
  });
  afterEach(async () => {
    await seeded.cleanup();
  });

  it('screen_name carries coverage in structuredContent and renders it in format()', async () => {
    const input = screenNameTool.input.parse({ name: 'Ivan Volkow', matchMode: 'fuzzy' });
    const result = await screenNameTool.handler(input, ctxFor(screenNameTool.errors));
    const approx = result.hits.find((h) => h.matchType === 'approximate');
    expect(approx?.queryTokenCoverage).toEqual({ covered: 2, total: 2 });
    expect(renderFormat(screenNameTool, result)).toContain('covers 2/2 query tokens');
  });

  it('screen_name omits coverage for an exact hit on both surfaces', async () => {
    const input = screenNameTool.input.parse({ name: 'Ivan Testovich Volkov' });
    const result = await screenNameTool.handler(input, ctxFor(screenNameTool.errors));
    expect(result.hits.every((h) => h.queryTokenCoverage === undefined)).toBe(true);
    expect(renderFormat(screenNameTool, result)).not.toContain('query tokens');
  });

  it('screen_name renders no coverage for an empty result or a page past the end', async () => {
    const empty = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Zzqxwv Qqpzm Unlisted' }),
      ctxFor(screenNameTool.errors),
    );
    expect(empty.hits).toHaveLength(0);
    expect(renderFormat(screenNameTool, empty)).not.toContain('query tokens');

    const pastEnd = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Ivan Volkow', matchMode: 'fuzzy', offset: 99 }),
      ctxFor(screenNameTool.errors),
    );
    expect(pastEnd.hits).toHaveLength(0);
    expect(renderFormat(screenNameTool, pastEnd)).not.toContain('query tokens');
  });

  it('screen_name keeps coverage on every hit of a capped page', async () => {
    // Three designations tie at score 1.0 on the exact token "marenko" and each
    // cover 2 of 3 query tokens, so the page cap binds with the tie still live.
    await seeded.service.ingestDesignations(
      ['Sorel', 'Torres', 'Vasquez'].map((surname) => ({
        id: `un:CAP-${surname}`,
        source: 'un' as const,
        sourceEntryId: `CAP-${surname}`,
        entityType: 'person' as const,
        primaryName: `Ludvik Marenko ${surname}`,
        payload: {
          aliases: [],
          identifiers: [],
          addresses: [],
          datesOfBirth: [],
          nationalities: [],
        },
      })),
    );

    const input = screenNameTool.input.parse({
      name: 'Ludvig Marenko Qqzz',
      matchMode: 'fuzzy',
      limit: 2,
    });
    const result = await screenNameTool.handler(input, ctxFor(screenNameTool.errors));
    expect(result.hits).toHaveLength(2);
    for (const hit of result.hits) {
      expect(hit.queryTokenCoverage).toEqual({ covered: 2, total: 3 });
    }
    expect(renderFormat(screenNameTool, result)).toContain('covers 2/3 query tokens');
  });

  it('rejects an out-of-range minScore before the handler ever runs', () => {
    expect(() => screenNameTool.input.parse({ name: 'Ivan Volkow', minScore: 2 })).toThrow();
    expect(() => resolveEntityTool.input.parse({ name: 'Fictional', minScore: -1 })).toThrow();
  });

  it('resolve_entity carries coverage in structuredContent and renders it in format()', async () => {
    const input = resolveEntityTool.input.parse({
      name: 'Fictionel Trading Compny',
      matchMode: 'fuzzy',
      status: 'any',
    });
    const result = await resolveEntityTool.handler(input, ctxFor(resolveEntityTool.errors));
    const approx = result.matches.find((m) => m.matchType === 'approximate');
    expect(approx?.queryTokenCoverage?.total).toBe(3);
    expect(approx!.queryTokenCoverage!.covered).toBeGreaterThan(0);
    expect(approx!.queryTokenCoverage!.covered).toBeLessThanOrEqual(3);
    expect(renderFormat(resolveEntityTool, result)).toContain(
      `covers ${approx!.queryTokenCoverage!.covered}/3 query tokens`,
    );
  });

  it('resolve_entity omits coverage for an exact match on both surfaces', async () => {
    const input = resolveEntityTool.input.parse({ name: 'Fictional Trading Company LLC' });
    const result = await resolveEntityTool.handler(input, ctxFor(resolveEntityTool.errors));
    expect(result.matches[0]?.matchType).toBe('exact');
    expect(result.matches[0]?.queryTokenCoverage).toBeUndefined();
    expect(renderFormat(resolveEntityTool, result)).not.toContain('query tokens');
  });
});

describe('names with no searchable token (issue #20)', () => {
  let seeded: SeededService;
  beforeEach(async () => {
    seeded = await seededGlobalService();
  });
  afterEach(async () => {
    await seeded.cleanup();
  });

  const unsearchable = ['   ', '---', '«»', '̖́'];

  it.each(unsearchable)(
    'screen_name rejects %j with the declared reason and recovery',
    async (name) => {
      await expect(
        screenNameTool.handler(screenNameTool.input.parse({ name }), ctxFor(screenNameTool.errors)),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'name_not_searchable',
          recovery: { hint: expect.stringMatching(/letter or digit/) },
        },
      });
    },
  );

  it.each(unsearchable)(
    'resolve_entity rejects %j with the declared reason and recovery',
    async (name) => {
      await expect(
        resolveEntityTool.handler(
          resolveEntityTool.input.parse({ name }),
          ctxFor(resolveEntityTool.errors),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'name_not_searchable',
          recovery: { hint: expect.stringMatching(/letter or digit/) },
        },
      });
    },
  );

  it('reports the rejection on the wire as an error, never as a zero-hit success', async () => {
    for (const tool of [screenNameTool, resolveEntityTool]) {
      const result = await runToolContract(tool, { name: '---' });
      expect(result.isError, tool.name).toBe(true);
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text, tool.name).toMatch(/letter or digit/);
      expect(JSON.stringify(result.structuredContent ?? {}), tool.name).not.toContain(
        '"normalizedQuery":""',
      );
    }
  });

  it('leaves the internal cross-reference screen of a symbol-only legal name to answer empty', async () => {
    await seeded.service.ingestLeiEntities([
      { lei: '529900SYMBOLONLY0001', legalName: '***', otherNames: [] },
    ]);
    const result = await getEntityTool.handler(
      getEntityTool.input.parse({ lei: '529900SYMBOLONLY0001' }),
      ctxFor(getEntityTool.errors),
    );
    expect(result.legalName).toBe('***');
    expect(result.sanctionsHits).toEqual([]);
  });

  it('declares the reason on both name tools', () => {
    for (const tool of [screenNameTool, resolveEntityTool]) {
      expect(tool.errors?.find((e) => e.reason === 'name_not_searchable')?.code, tool.name).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
    }
  });

  it('still screens a native-script name on both surfaces', async () => {
    await seeded.service.ingestDesignations([
      {
        id: 'eu:514',
        source: 'eu',
        sourceEntryId: '514',
        entityType: 'person',
        primaryName: 'عبد المنان آغا',
        payload: {
          aliases: [],
          identifiers: [],
          addresses: [],
          datesOfBirth: [],
          nationalities: [],
        },
      },
    ]);
    const ctx = ctxFor(screenNameTool.errors);
    const result = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'عبد المنان آغا' }),
      ctx,
    );
    expect(result.hits[0]).toMatchObject({ sourceEntryId: '514', matchType: 'exact' });
    expect(getEnrichment(ctx)).toMatchObject({ normalizedQuery: 'عبد المنان اغا' });
    expect(renderFormat(screenNameTool, result)).toContain('### عبد المنان آغا — exact');
  });

  it('keeps the not-a-clearance notice on a native-script query that matches nothing', async () => {
    const ctx = ctxFor(screenNameTool.errors);
    const result = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Несуществующий Человек', matchMode: 'fuzzy' }),
      ctx,
    );
    expect(result.hits).toHaveLength(0);
    expect(getEnrichment(ctx)).toMatchObject({
      matchModeUsed: 'fuzzy',
      normalizedQuery: 'несуществующии человек',
    });
    expect(getEnrichment(ctx).notice).toMatch(/NOT a clearance/);
  });
});

describe('names past the matching bound', () => {
  let seeded: SeededService;
  beforeEach(async () => {
    seeded = await seededGlobalService();
  });
  afterEach(async () => {
    await seeded.cleanup();
  });

  /** `n` distinct words, so each one would cost its own fuzzy blocking scan. */
  const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}q`).join(' ');
  const tooLong: [label: string, name: string][] = [
    ['65 words', words(65)],
    ['1,025 characters', 'a'.repeat(1025)],
  ];
  const tooLongError = {
    code: JsonRpcErrorCode.InvalidParams,
    data: { reason: 'name_too_long', recovery: { hint: expect.stringMatching(/64 words/) } },
  };

  it.each(tooLong)(
    'screen_name rejects %s with the declared reason and recovery',
    async (_l, name) => {
      await expect(
        screenNameTool.handler(screenNameTool.input.parse({ name }), ctxFor(screenNameTool.errors)),
      ).rejects.toMatchObject(tooLongError);
    },
  );

  it.each(tooLong)(
    'resolve_entity rejects %s with the declared reason and recovery',
    async (_l, name) => {
      await expect(
        resolveEntityTool.handler(
          resolveEntityTool.input.parse({ name }),
          ctxFor(resolveEntityTool.errors),
        ),
      ).rejects.toMatchObject(tooLongError);
    },
  );

  it('matches a name at the bound on both tools', async () => {
    for (const name of [words(64), 'a'.repeat(1024)]) {
      const screened = await screenNameTool.handler(
        screenNameTool.input.parse({ name, matchMode: 'fuzzy' }),
        ctxFor(screenNameTool.errors),
      );
      expect(screened.caveat).toBeTruthy();
      const resolved = await resolveEntityTool.handler(
        resolveEntityTool.input.parse({ name, matchMode: 'fuzzy' }),
        ctxFor(resolveEntityTool.errors),
      );
      expect(resolved.matches).toBeInstanceOf(Array);
    }
  });

  it('reports the rejection on the wire as an error', async () => {
    for (const tool of [screenNameTool, resolveEntityTool]) {
      const result = await runToolContract(tool, { name: words(65) });
      expect(result.isError, tool.name).toBe(true);
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      expect(text, tool.name).toMatch(/64 words/);
    }
  });

  it('declares the reason on both name tools', () => {
    for (const tool of [screenNameTool, resolveEntityTool]) {
      expect(tool.errors?.find((e) => e.reason === 'name_too_long')?.code, tool.name).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
    }
  });
});

describe('decoded entity references on both surfaces (issue #21)', () => {
  let seeded: SeededService;
  beforeEach(async () => {
    seeded = await seededGlobalService();
    // Parsed from source-shaped XML, so the decode under test is the parser's own.
    await seeded.service.ingestDesignations([
      ...parseOfac(
        parseXml(`<Sanctions>
          <ReferenceValueSets><AliasTypeValues><AliasType ID="1403">Name</AliasType></AliasTypeValues></ReferenceValueSets>
          <DistinctParties><DistinctParty FixedRef="40972"><Profile ID="40972"><Identity ID="1">
            <Alias AliasTypeID="1403" Primary="true"><DocumentedName ID="1">
              <DocumentedNamePart><NamePartValue>Greenland Oil &amp; Gas Trading FZE</NamePartValue></DocumentedNamePart>
            </DocumentedName></Alias>
            <Alias AliasTypeID="1403" Primary="false"><DocumentedName ID="2">
              <DocumentedNamePart><NamePartValue>جرينلاند اويل &amp; غاز تريدينغ م م ح</NamePartValue></DocumentedNamePart>
            </DocumentedName></Alias>
          </Identity></Profile></DistinctParty></DistinctParties>
        </Sanctions>`),
        'ofac_sdn',
      ),
      ...parseEu(
        parseXml(`<export><sanctionEntity logicalId="140494">
          <subjectType code="enterprise"/><nameAlias wholeName="ПАО &quot;КАМАЗ&quot;" strong="true"/>
        </sanctionEntity></export>`),
      ),
      ...parseUk(
        parseXml(`<Designations><Designation><UniqueID>AQD0011</UniqueID>
          <Names><Name><Name6>AL-HARAMAIN &amp; AL MASJED AL-AQSA</Name6><NameType>Primary Name</NameType></Name></Names>
          <OtherInformation>Formerly A &amp; B</OtherInformation>
        </Designation></Designations>`),
      ),
    ]);
  });
  afterEach(async () => {
    await seeded.cleanup();
  });

  it.each([
    ['ofac_sdn', '40972', 'Greenland Oil & Gas Trading FZE'],
    ['eu', '140494', 'ПАО "КАМАЗ"'],
    ['uk', 'AQD0011', 'AL-HARAMAIN & AL MASJED AL-AQSA'],
  ] as const)(
    'get_designation returns %s/%s decoded on both surfaces',
    async (source, entryId, primaryName) => {
      const result = await getDesignationTool.handler(
        getDesignationTool.input.parse({ source, entryId }),
        ctxFor(getDesignationTool.errors),
      );
      expect(result.primaryName).toBe(primaryName);
      expect(JSON.stringify(result)).not.toMatch(/&(amp|quot);/);
      const text = renderFormat(getDesignationTool, result);
      expect(text).toContain(primaryName);
      expect(text).not.toMatch(/&(amp|quot);/);
    },
  );

  it('get_designation decodes the remarks on both surfaces', async () => {
    const result = await getDesignationTool.handler(
      getDesignationTool.input.parse({ source: 'uk', entryId: 'AQD0011' }),
      ctxFor(getDesignationTool.errors),
    );
    expect(result.remarks).toBe('Formerly A & B');
    expect(renderFormat(getDesignationTool, result)).toContain('**Remarks:** Formerly A & B');
  });

  it('screen_name reaches exact on the correctly spelled name', async () => {
    const result = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Greenland Oil & Gas Trading FZE' }),
      ctxFor(screenNameTool.errors),
    );
    expect(result.hits[0]).toMatchObject({
      sourceEntryId: '40972',
      matchType: 'exact',
      matchedName: 'Greenland Oil & Gas Trading FZE',
    });
    expect(renderFormat(screenNameTool, result)).toContain(
      'Matched on:** "Greenland Oil & Gas Trading FZE" (primary)',
    );
  });

  it.each(['amp', 'quot'])('screen_name %j matches no name through an entity', async (name) => {
    const result = await screenNameTool.handler(
      screenNameTool.input.parse({ name, matchMode: 'fuzzy' }),
      ctxFor(screenNameTool.errors),
    );
    const decodedIds = new Set(['40972', '140494', 'AQD0011']);
    expect(result.hits.filter((hit) => decodedIds.has(hit.sourceEntryId))).toEqual([]);
  });
});

describe('published designation details on both surfaces (issue #22)', () => {
  let seeded: SeededService;
  beforeEach(async () => {
    seeded = await seededGlobalService();
    // Parsed from source-shaped XML, so each group is the normalizer's own read.
    await seeded.service.ingestDesignations([
      ...parseOfac(
        parseXml(`<Sanctions>
          <ReferenceValueSets>
            <AliasTypeValues><AliasType ID="1403">Name</AliasType></AliasTypeValues>
            <CountryValues><Country ID="11216" ISO2="VE">Venezuela</Country></CountryValues>
            <FeatureTypeValues>
              <FeatureType ID="8">Birthdate</FeatureType><FeatureType ID="9">Place of Birth</FeatureType>
              <FeatureType ID="11">Citizenship Country</FeatureType><FeatureType ID="25">Location</FeatureType>
            </FeatureTypeValues>
            <IDRegDocTypeValues><IDRegDocType ID="1570">Cedula No.</IDRegDocType></IDRegDocTypeValues>
            <LocPartTypeValues>
              <LocPartType ID="1">Unknown</LocPartType><LocPartType ID="1454">CITY</LocPartType><LocPartType ID="1455">STATE/PROVINCE</LocPartType>
            </LocPartTypeValues>
          </ReferenceValueSets>
          <Locations>
            <Location ID="34442"><LocationCountry CountryID="11216" CountryRelevanceID="1413" />
              <LocationPart LocPartTypeID="1454"><LocationPartValue Primary="true"><Value>Caracas</Value></LocationPartValue></LocationPart>
              <LocationPart LocPartTypeID="1455"><LocationPartValue Primary="true"><Value>Capital District</Value></LocationPartValue></LocationPart>
            </Location>
            <Location ID="186216"><LocationPart LocPartTypeID="1"><LocationPartValue Primary="true"><Value>Venezuela</Value></LocationPartValue></LocationPart></Location>
          </Locations>
          <IDRegDocuments>
            <IDRegDocument ID="14375" IDRegDocTypeID="1570" IdentityID="14494" IssuedBy-CountryID="11216" ValidityID="1"><IDRegistrationNo>5892464</IDRegistrationNo></IDRegDocument>
          </IDRegDocuments>
          <DistinctParties>
            <DistinctParty FixedRef="22790"><Profile ID="22790"><Identity ID="14494">
              <Alias AliasTypeID="1403" Primary="true"><DocumentedName ID="1">
                <DocumentedNamePart><NamePartValue>MADURO MOROS</NamePartValue></DocumentedNamePart>
                <DocumentedNamePart><NamePartValue>Nicolas</NamePartValue></DocumentedNamePart>
              </DocumentedName></Alias></Identity>
              <Feature FeatureTypeID="8"><FeatureVersion ID="1"><DatePeriod CalendarTypeID="1">
                <Start Approximate="false"><From><Year>1962</Year><Month>11</Month><Day>23</Day></From><To><Year>1962</Year><Month>11</Month><Day>23</Day></To></Start>
                <End Approximate="false"><From><Year>1962</Year><Month>11</Month><Day>23</Day></From><To><Year>1962</Year><Month>11</Month><Day>23</Day></To></End>
              </DatePeriod></FeatureVersion></Feature>
              <Feature FeatureTypeID="9"><FeatureVersion ID="2"><VersionDetail DetailTypeID="1432">Caracas, Venezuela</VersionDetail></FeatureVersion></Feature>
              <Feature FeatureTypeID="11"><FeatureVersion ID="3"><VersionLocation LocationID="186216" /></FeatureVersion></Feature>
              <Feature FeatureTypeID="25"><FeatureVersion ID="4"><VersionLocation LocationID="34442" /></FeatureVersion></Feature>
            </Profile></DistinctParty>
            <DistinctParty FixedRef="30002"><Profile ID="30002"><Identity ID="7001">
              <Alias AliasTypeID="1403" Primary="true"><DocumentedName ID="2"><DocumentedNamePart><NamePartValue>SPARSE Party</NamePartValue></DocumentedNamePart></DocumentedName></Alias>
              </Identity>
              <Feature FeatureTypeID="25"><FeatureVersion ID="5"><VersionLocation LocationID="424242" /></FeatureVersion></Feature>
            </Profile></DistinctParty>
          </DistinctParties>
        </Sanctions>`),
        'ofac_sdn',
      ),
      ...parseEu(
        parseXml(`<export><sanctionEntity logicalId="507" euReferenceNumber="EU.513.75">
          <subjectType code="person" classificationCode="P"/>
          <nameAlias wholeName="Abdul Rahman Yasin" strong="true"/>
          <citizenship countryIso2Code="US" countryDescription="UNITED STATES"/>
          <birthdate city="Bloomington, Indiana" birthdate="1960-04-10" year="1960" region="" place="" countryIso2Code="US" countryDescription="UNITED STATES"/>
          <address city="" street="" poBox="" zipCode="" region="" place="" countryIso2Code="00" countryDescription="UNKNOWN"/>
          <identification number="27082171" identificationTypeDescription="National passport" countryIso2Code="US" countryDescription="UNITED STATES"/>
        </sanctionEntity></export>`),
      ),
      ...parseUk(
        parseXml(`<Designations><Designation><UniqueID>AFG0055</UniqueID>
          <Names><Name><Name1>NAJIBULLAH</Name1><Name2>HAQQANI</Name2><NameType>Primary Name</NameType></Name></Names>
          <IndividualEntityShip>Individual</IndividualEntityShip>
          <Addresses><Address><AddressLine1>Kabul</AddressLine1><AddressCountry>Afghanistan</AddressCountry></Address></Addresses>
          <IndividualDetails><Individual>
            <DOBs><DOB>dd/mm/1971</DOB><DOB>24/10/1972</DOB></DOBs>
            <PassportDetails><Passport><PassportNumber>D0009871</PassportNumber></Passport></PassportDetails>
            <Nationalities><Nationality>Afghanistan</Nationality></Nationalities>
            <BirthDetails><Location><TownOfBirth>Moni village</TownOfBirth><CountryOfBirth>Afghanistan</CountryOfBirth></Location></BirthDetails>
          </Individual></IndividualDetails>
        </Designation></Designations>`),
      ),
      ...parseUn(
        parseXml(`<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL>
          <DATAID>6908002</DATAID><FIRST_NAME>IRUTA DOUGLAS</FIRST_NAME><SECOND_NAME>MPAMO</SECOND_NAME>
          <NATIONALITY><VALUE>Democratic Republic of the Congo</VALUE></NATIONALITY>
          <INDIVIDUAL_ADDRESS><CITY>Gisenyi</CITY><COUNTRY>Rwanda</COUNTRY></INDIVIDUAL_ADDRESS>
          <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1965-12-28</DATE></INDIVIDUAL_DATE_OF_BIRTH>
          <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1965-12-29</DATE></INDIVIDUAL_DATE_OF_BIRTH>
          <INDIVIDUAL_PLACE_OF_BIRTH><CITY>Goma</CITY><COUNTRY>Democratic Republic of the Congo</COUNTRY></INDIVIDUAL_PLACE_OF_BIRTH>
          <INDIVIDUAL_DOCUMENT/>
        </INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>`),
      ),
    ]);
  });
  afterEach(async () => {
    await seeded.cleanup();
  });

  const getDesignation = (source: 'ofac_sdn' | 'eu' | 'uk' | 'un', entryId: string) =>
    getDesignationTool.handler(
      getDesignationTool.input.parse({ source, entryId }),
      ctxFor(getDesignationTool.errors),
    );

  it.each([
    [
      'ofac_sdn',
      '22790',
      {
        identifiers: [{ type: 'Cedula No.', value: '5892464', country: 'Venezuela' }],
        addresses: [{ full: 'Caracas, Capital District, Venezuela', country: 'Venezuela' }],
        datesOfBirth: [{ date: '1962-11-23', place: 'Caracas, Venezuela' }],
        nationalities: ['Venezuela'],
      },
      [
        '**Cedula No.:** 5892464 (Venezuela)',
        '- Caracas, Capital District, Venezuela\n',
        '- 1962-11-23 at Caracas, Venezuela',
        '**Nationalities:** Venezuela',
      ],
    ],
    [
      'eu',
      '507',
      {
        identifiers: [{ type: 'National passport', value: '27082171', country: 'UNITED STATES' }],
        addresses: [],
        datesOfBirth: [{ date: '1960-04-10', place: 'Bloomington, Indiana, UNITED STATES' }],
        nationalities: ['UNITED STATES'],
      },
      [
        '**National passport:** 27082171 (UNITED STATES)',
        '- 1960-04-10 at Bloomington, Indiana, UNITED STATES',
      ],
    ],
    [
      'uk',
      'AFG0055',
      {
        identifiers: [{ type: 'Passport', value: 'D0009871' }],
        addresses: [{ full: 'Kabul, Afghanistan', country: 'Afghanistan' }],
        datesOfBirth: [
          { date: '1971' },
          { date: '1972-10-24' },
          { place: 'Moni village, Afghanistan' },
        ],
        nationalities: ['Afghanistan'],
      },
      [
        '**Passport:** D0009871',
        '- Kabul, Afghanistan\n',
        '- 1971\n',
        '- 1972-10-24\n',
        '- Born in Moni village, Afghanistan',
        '**Nationalities:** Afghanistan',
      ],
    ],
    [
      'un',
      '6908002',
      {
        identifiers: [],
        addresses: [{ full: 'Gisenyi, Rwanda', country: 'Rwanda' }],
        datesOfBirth: [
          { date: '1965-12-28' },
          { date: '1965-12-29' },
          { place: 'Goma, Democratic Republic of the Congo' },
        ],
        nationalities: ['Democratic Republic of the Congo'],
      },
      ['- Gisenyi, Rwanda\n', '- 1965-12-29\n', '- Born in Goma, Democratic Republic of the Congo'],
    ],
  ] as const)(
    'get_designation returns %s/%s with every published group on both surfaces',
    async (source, entryId, groups, lines) => {
      const result = await getDesignation(source, entryId);
      expect({
        identifiers: result.identifiers,
        addresses: result.addresses,
        datesOfBirth: result.datesOfBirth,
        nationalities: result.nationalities,
      }).toEqual(groups);
      const text = renderFormat(getDesignationTool, result);
      for (const line of lines) expect(text).toContain(line);
      // content[] carries no placeholder the structured record does not.
      expect(text).not.toContain('Unknown date');
    },
  );

  it('get_designation returns every group empty for a sparse record, and format() renders none', async () => {
    const headings = ['## Identifiers', '## Addresses', '## Dates of birth', 'Nationalities:'];
    const sparse = await getDesignation('ofac_sdn', '30002');
    expect(sparse).toMatchObject({
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    });
    const text = renderFormat(getDesignationTool, sparse);
    for (const heading of headings) expect(text).not.toContain(heading);
    // The populated sibling from the same document renders every group.
    const full = renderFormat(getDesignationTool, await getDesignation('ofac_sdn', '22790'));
    for (const heading of headings) expect(full).toContain(heading);
  });
});

describe('published precision and feature identifiers on both surfaces (issues #39, #40, #45)', () => {
  let seeded: SeededService;
  beforeEach(async () => {
    seeded = await seededGlobalService();
    // Parsed from source-shaped XML, so each field is the normalizer's own read.
    const period = (start: string[], end: string[], approximate: boolean) => {
      const point = (tag: string, ymd: string) => {
        const [y, m, d] = ymd.split('-');
        return `<${tag}><Year>${y}</Year><Month>${Number(m)}</Month><Day>${Number(d)}</Day></${tag}>`;
      };
      return `<Feature FeatureTypeID="8"><FeatureVersion><DatePeriod CalendarTypeID="1">
        <Start Approximate="${approximate}">${point('From', start[0] ?? '')}${point('To', start[1] ?? '')}</Start>
        <End Approximate="${approximate}">${point('From', end[0] ?? '')}${point('To', end[1] ?? '')}</End>
      </DatePeriod></FeatureVersion></Feature>`;
    };
    await seeded.service.ingestDesignations([
      ...parseOfac(
        parseXml(`<Sanctions>
          <ReferenceValueSets>
            <AliasTypeValues><AliasType ID="1403">Name</AliasType></AliasTypeValues>
            <CountryValues><Country ID="11247">United Kingdom</Country></CountryValues>
            <FeatureTypeValues>
              <FeatureType ID="8">Birthdate</FeatureType><FeatureType ID="9">Place of Birth</FeatureType>
              <FeatureType ID="13">SWIFT/BIC</FeatureType><FeatureType ID="14">Website</FeatureType>
              <FeatureType ID="344">Digital Currency Address - XBT</FeatureType>
            </FeatureTypeValues>
            <IDRegDocTypeValues><IDRegDocType ID="1583">Company Number</IDRegDocType></IDRegDocTypeValues>
          </ReferenceValueSets>
          <IDRegDocuments>
            <IDRegDocument IDRegDocTypeID="1583" IdentityID="4267" IssuedBy-CountryID="11247"><IDRegistrationNo>01074897</IDRegistrationNo></IDRegDocument>
          </IDRegDocuments>
          <DistinctParties>
            <DistinctParty FixedRef="7782"><Profile ID="7782"><Identity ID="2186">
              <Alias AliasTypeID="1403" Primary="true"><DocumentedName><DocumentedNamePart><NamePartValue>CIRCA YEAR PERSON</NamePartValue></DocumentedNamePart></DocumentedName></Alias></Identity>
              ${period(['1951-01-01', '1951-01-01'], ['1951-12-31', '1951-12-31'], true)}
              <Feature FeatureTypeID="9"><FeatureVersion><VersionDetail DetailTypeID="1432">Mosul, Iraq</VersionDetail></FeatureVersion></Feature>
            </Profile></DistinctParty>
            <DistinctParty FixedRef="8868"><Profile ID="8868"><Identity ID="6593">
              <Alias AliasTypeID="1403" Primary="true"><DocumentedName><DocumentedNamePart><NamePartValue>YEAR RANGE PERSON</NamePartValue></DocumentedNamePart></DocumentedName></Alias></Identity>
              ${period(['1955-01-01', '1955-12-31'], ['1957-01-01', '1957-12-31'], false)}
              ${period(['1946-08-01', '1946-08-01'], ['1946-08-31', '1946-08-31'], false)}
            </Profile></DistinctParty>
            <DistinctParty FixedRef="906"><Profile ID="906"><Identity ID="4267">
              <Alias AliasTypeID="1403" Primary="true"><DocumentedName><DocumentedNamePart><NamePartValue>HAVANA INTERNATIONAL BANK LTD</NamePartValue></DocumentedNamePart></DocumentedName></Alias></Identity>
              <Feature FeatureTypeID="13"><FeatureVersion><VersionDetail DetailTypeID="1432">HAVIGB2L</VersionDetail></FeatureVersion></Feature>
              <Feature FeatureTypeID="14"><FeatureVersion><VersionDetail DetailTypeID="1432">www.havanaintbank.co.uk</VersionDetail></FeatureVersion></Feature>
              <Feature FeatureTypeID="344"><FeatureVersion><VersionDetail DetailTypeID="1432">12aNKp2iDKuhEde2YfPdd4DFGenRUTKupL</VersionDetail></FeatureVersion></Feature>
            </Profile></DistinctParty>
          </DistinctParties>
        </Sanctions>`),
        'ofac_sdn',
      ),
      ...parseUk(
        parseXml(`<Designations><Designation>
          <LastUpdated>09/04/2025</LastUpdated><DateDesignated>25/02/2022</DateDesignated>
          <UniqueID>RUS0251</UniqueID>
          <Names><Name><Name1>Vladimir</Name1><Name6>PUTIN</Name6><NameType>Primary Name</NameType></Name></Names>
          <IndividualEntityShip>Individual</IndividualEntityShip>
          <PhoneNumbers><PhoneNumber>+7 495 606 36 02</PhoneNumber></PhoneNumbers>
          <EmailAddresses><EmailAddress>info@example.test</EmailAddress></EmailAddresses>
          <Websites><Website>http://kremlin.example</Website></Websites>
          <IndividualDetails><Individual><DOBs><DOB>07/10/1952</DOB><DOB>dd/mm/1952</DOB></DOBs></Individual></IndividualDetails>
        </Designation></Designations>`),
      ),
      ...parseEu(
        parseXml(`<export><sanctionEntity designationDate="2002-06-18" logicalId="201">
          <regulation regulationType="amendment" publicationDate="2025-01-31" programme="TERR"/>
          <subjectType code="enterprise"/><nameAlias wholeName="Example Organisation 201" strong="true"/>
        </sanctionEntity></export>`),
      ),
      ...parseUn(
        parseXml(`<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL>
          <DATAID>6908457</DATAID><FIRST_NAME>OFFSET</FIRST_NAME><SECOND_NAME>LISTING</SECOND_NAME>
          <LISTED_ON>2015-07-01-04:00</LISTED_ON>
        </INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>`),
      ),
    ]);
  });
  afterEach(async () => {
    await seeded.cleanup();
  });

  const getDesignation = (source: 'ofac_sdn' | 'eu' | 'uk' | 'un', entryId: string) =>
    getDesignationTool.handler(
      getDesignationTool.input.parse({ source, entryId }),
      ctxFor(getDesignationTool.errors),
    );

  it('get_designation carries a circa year with its place, and renders it as circa', async () => {
    const result = await getDesignation('ofac_sdn', '7782');
    expect(result.datesOfBirth).toEqual([{ date: '1951', circa: true, place: 'Mosul, Iraq' }]);
    expect(renderFormat(getDesignationTool, result).split('\n')).toContain(
      '- circa 1951 at Mosul, Iraq',
    );
  });

  it('get_designation carries a range as an ISO interval and a month at month precision', async () => {
    const result = await getDesignation('ofac_sdn', '8868');
    expect(result.datesOfBirth).toEqual([{ date: '1955/1957' }, { date: '1946-08' }]);
    const lines = renderFormat(getDesignationTool, result).split('\n');
    expect(lines).toContain('- 1955/1957');
    expect(lines).toContain('- 1946-08');
    expect(lines.join('\n')).not.toContain('circa');
  });

  it('get_designation lists feature identifiers after the identity documents on both surfaces', async () => {
    const result = await getDesignation('ofac_sdn', '906');
    expect(result.identifiers).toEqual([
      { type: 'Company Number', value: '01074897', country: 'United Kingdom' },
      { type: 'SWIFT/BIC', value: 'HAVIGB2L' },
      { type: 'Website', value: 'www.havanaintbank.co.uk' },
      { type: 'Digital Currency Address - XBT', value: '12aNKp2iDKuhEde2YfPdd4DFGenRUTKupL' },
    ]);
    const text = renderFormat(getDesignationTool, result);
    expect(text).toContain('**Company Number:** 01074897 (United Kingdom)');
    expect(text).toContain('**SWIFT/BIC:** HAVIGB2L\n');
    expect(text).toContain('**Website:** www.havanaintbank.co.uk\n');
    expect(text).toContain(
      '**Digital Currency Address - XBT:** 12aNKp2iDKuhEde2YfPdd4DFGenRUTKupL',
    );
  });

  it('get_designation returns a UK record with ISO dates and its contact details as identifiers', async () => {
    const result = await getDesignation('uk', 'RUS0251');
    expect(result).toMatchObject({
      designationDate: '2022-02-25',
      datesOfBirth: [{ date: '1952-10-07' }, { date: '1952' }],
      identifiers: [
        { type: 'Phone Number', value: '+7 495 606 36 02' },
        { type: 'Email Address', value: 'info@example.test' },
        { type: 'Website', value: 'http://kremlin.example' },
      ],
    });
    const text = renderFormat(getDesignationTool, result);
    expect(text).toContain('**Designated:** 2022-02-25');
    expect(text).toContain('**Phone Number:** +7 495 606 36 02');
    expect(text).toContain('**Email Address:** info@example.test');
    expect(text).toContain('**Website:** http://kremlin.example');
  });

  it.each([
    ['eu', '201', '2002-06-18'],
    ['un', '6908457', '2015-07-01'],
  ] as const)('get_designation returns %s/%s designated %s', async (source, entryId, date) => {
    const result = await getDesignation(source, entryId);
    expect(result.designationDate).toBe(date);
    expect(renderFormat(getDesignationTool, result)).toContain(`**Designated:** ${date}`);
  });

  it('keeps circa and the feature identifiers in structuredContent through the output schema', async () => {
    const circa = await runToolContract(getDesignationTool, {
      source: 'ofac_sdn',
      entryId: '7782',
    });
    expect(circa.isError).toBeFalsy();
    expect(circa.structuredContent).toMatchObject({
      datesOfBirth: [{ date: '1951', circa: true, place: 'Mosul, Iraq' }],
    });
    const features = await runToolContract(getDesignationTool, {
      source: 'ofac_sdn',
      entryId: '906',
    });
    expect((features.structuredContent as { identifiers: unknown[] }).identifiers).toHaveLength(4);
    const content = features.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(content).toContain('**SWIFT/BIC:** HAVIGB2L');
  });

  it('screen_name reports the UK designation date as YYYY-MM-DD on both surfaces', async () => {
    const result = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Vladimir PUTIN', sources: ['uk'] }),
      ctxFor(screenNameTool.errors),
    );
    expect(result.hits[0]).toMatchObject({
      sourceEntryId: 'RUS0251',
      designationDate: '2022-02-25',
    });
    expect(renderFormat(screenNameTool, result)).toContain('**Designated:** 2022-02-25');
  });

  it('still rejects an empty entry ID and reports an unknown one as designation_not_found', async () => {
    const empty = await runToolContract(getDesignationTool, { source: 'uk', entryId: '' });
    expect(empty.isError).toBe(true);
    await expect(getDesignation('uk', 'RUS9999')).rejects.toMatchObject({
      data: { reason: 'designation_not_found' },
    });
  });
});

describe('screening tools (not ready)', () => {
  let empty: SeededService;
  beforeEach(async () => {
    empty = await emptyGlobalService();
  });
  afterEach(async () => {
    await empty.cleanup();
  });

  it('screen_name throws the mirror-not-ready contract before any sync', async () => {
    const input = screenNameTool.input.parse({ name: 'anyone' });
    await expect(
      screenNameTool.handler(input, ctxFor(screenNameTool.errors)),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
  });

  it('resolve_entity throws the mirror-not-ready contract before any sync', async () => {
    const input = resolveEntityTool.input.parse({ name: 'anyone' });
    await expect(
      resolveEntityTool.handler(input, ctxFor(resolveEntityTool.errors)),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
  });
});

/** Render a tool's format() output to a single string for content[] assertions. */
function renderFormat<T>(
  tool: { format?: (result: T) => Array<{ type: string; text?: string }> },
  result: T,
): string {
  if (!tool.format) return '';
  return tool
    .format(result)
    .map((c) => c.text ?? '')
    .join('\n');
}
