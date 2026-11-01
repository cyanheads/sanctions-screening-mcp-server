/**
 * @fileoverview CSL source contracts, streaming preparation and normalization.
 * @module tests/services/csl-ingest.test
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOURCE_URLS } from '@/config/server-config.js';
import { designationResource } from '@/mcp-server/resources/definitions/designation.resource.js';
import { sourcesResource } from '@/mcp-server/resources/definitions/sources.resource.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import { screenIdentifierTool } from '@/mcp-server/tools/definitions/screen-identifier.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { CSL_SOURCE_CODES, createCslPreparation } from '@/services/screening/csl-ingest.js';
import {
  createSanctionsSync,
  type SourceSyncReport,
} from '@/services/screening/sanctions-ingest.js';
import { type NormalizedDesignation, SOURCE_LABELS } from '@/services/screening/types.js';
import { CSL_RECORDS, cslDocument } from './_csl-fixture.js';
import { emptyGlobalService } from './_helpers.js';
import { serveLookupCorpus } from './_lookup-corpus.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdtempSync: vi.fn(actual.mkdtempSync) };
});

function createdSpools(from: number): string[] {
  return vi
    .mocked(mkdtempSync)
    .mock.results.slice(from)
    .flatMap((result) =>
      result.type === 'return' &&
      typeof result.value === 'string' &&
      result.value.includes('sanctions-csl-')
        ? [result.value]
        : [],
    );
}

afterEach(() => vi.unstubAllGlobals());

function serve(body: string, size = 65536) {
  const bytes = new TextEncoder().encode(body);
  const fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let at = 0; at < bytes.length; at += size)
              controller.enqueue(bytes.subarray(at, at + size));
            controller.close();
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = [];
  for await (const value of values) rows.push(value);
  return rows;
}

async function harvest(body: string, size = 65536): Promise<NormalizedDesignation[]> {
  serve(body, size);
  const run = createCslPreparation();
  try {
    const records: NormalizedDesignation[] = [];
    for (const ingester of run.ingesters)
      records.push(...(await collect(ingester.harvest(new AbortController().signal))));
    return records;
  } finally {
    run.dispose();
  }
}

describe('CSL source contracts', () => {
  it.each(['bis_el', 'bis_dpl', 'bis_uvl', 'bis_meu', 'state_dtc', 'state_acn'])(
    'accepts %s in name screening',
    (source) => {
      expect(screenNameTool.input.safeParse({ name: 'Example', sources: [source] }).success).toBe(
        true,
      );
    },
  );
});

describe('CSL preparation and normalization', () => {
  it('replays unchanged identities, delists within the guard, and preserves last successful as-of after a shared CSL failure', async () => {
    const state = await emptyGlobalService();
    try {
      serveLookupCorpus();
      const originalFetch = globalThis.fetch;
      let csl = cslDocument([...CSL_RECORDS, { ...CSL_RECORDS[0], id: 'removed' }]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
          String(input) === DEFAULT_SOURCE_URLS.csl
            ? new Response(csl)
            : originalFetch(input, init),
        ),
      );
      const signal = new AbortController().signal;
      await state.service.syncSanctions('init', signal);
      const counts = await state.service.sourceCounts();
      expect(
        counts
          .filter((source) => CSL_SOURCE_CODES.some((code) => code === source.code))
          .map((source) => [source.code, source.recordCount]),
      ).toEqual([
        ['bis_el', 2],
        ['bis_dpl', 1],
        ['bis_uvl', 1],
        ['bis_meu', 1],
        ['state_dtc', 1],
        ['state_acn', 1],
      ]);
      await state.service.syncSanctions('refresh', signal);
      expect(await state.service.sourceCounts()).toEqual(counts);
      csl = cslDocument();
      await state.service.syncSanctions('refresh', signal);
      expect(await state.service.getDesignation('bis_el', 'removed')).toBeNull();
      const completedAt = (await state.service.sanctionsReadiness()).completedAt;
      csl = csl.slice(0, -1);
      await expect(state.service.syncSanctions('refresh', signal)).rejects.toThrow(
        /bis_el, bis_dpl, bis_uvl, bis_meu, state_dtc, state_acn/,
      );
      expect((await state.service.sanctionsReadiness()).completedAt).toBe(completedAt);
      expect(
        (await state.service.sourceCounts())
          .filter((source) => CSL_SOURCE_CODES.some((code) => code === source.code))
          .map((source) => source.recordCount),
      ).toEqual([1, 1, 1, 1, 1, 1]);
      expect(await state.service.getDesignation('un', '111923')).toBeDefined();
    } finally {
      await state.cleanup();
    }
  });
  it('does not infer a birth-date/place relationship from singleton independent arrays', async () => {
    const rows = await harvest(
      cslDocument([
        { ...CSL_RECORDS[0], dates_of_birth: ['1980'], places_of_birth: ['Place A'] },
        ...CSL_RECORDS.slice(1),
      ]),
    );
    expect(rows[0]?.payload.datesOfBirth).toEqual([{ date: '1980' }, { place: 'Place A' }]);
  });
  it('preserves Namibia country codes and published place names that resemble placeholders', async () => {
    const rows = await harvest(
      cslDocument([
        {
          ...CSL_RECORDS[0],
          nationalities: [' NA ', '', 'NA'],
          citizenships: ['US', 'NA'],
          places_of_birth: ['Na', ' '],
        },
        { ...CSL_RECORDS[1], citizenships: ['NA'] },
        ...CSL_RECORDS.slice(2),
      ]),
    );
    expect(rows[0]?.payload.nationalities).toEqual(['NA', 'US']);
    expect(rows[1]?.payload.nationalities).toEqual(['NA']);
    expect(rows[0]?.payload.datesOfBirth).toEqual([{ place: 'Na' }]);
  });
  it('discloses an upgraded ready mirror with unloaded CSL lists while existing default screening still works', async () => {
    const state = await emptyGlobalService();
    try {
      await state.service.seedFixtures({
        designations: [
          {
            id: 'eu:old',
            source: 'eu',
            sourceEntryId: 'old',
            primaryName: 'Existing Counterparty',
            entityType: 'unknown',
            payload: {
              aliases: [],
              identifiers: [],
              addresses: [],
              datesOfBirth: [],
              nationalities: [],
            },
          },
        ],
        leiEntities: [],
        leiRelationships: [],
        reportingExceptions: [],
      });
      const sources = await runToolContract(listSourcesTool, {});
      expect(sources.structuredContent).toMatchObject({
        sanctionsReady: true,
        coverageNotice: expect.stringContaining('bis_el'),
      });
      expect(JSON.stringify(sources.content)).toContain(
        'SANCTIONS_REFRESH_SKIP_GLEIF=1 bun run mirror:refresh',
      );
      const uri = await sourcesResource.handler({}, createMockContext());
      expect(uri).toEqual(sources.structuredContent);
      const screen = await runToolContract(screenNameTool, { name: 'Existing Counterparty' });
      expect(screenNameTool.output.parse(screen.structuredContent).hits).toHaveLength(1);
      expect(screenNameTool.output.parse(screen.structuredContent).caveat).toContain(
        'zero-record CSL lists',
      );
    } finally {
      await state.cleanup();
    }
  });
  it.each([1, 7, 64, 65536])(
    'preserves escaped UTF-8 strings across %i-byte chunks and fetches once',
    async (size) => {
      const fetch = serve(
        cslDocument(
          CSL_RECORDS.map((record) => ({ ...record, name: '中文 "Name" \\ escaped\nline' })),
        ),
        size,
      );
      const run = createCslPreparation();
      try {
        for (const ingester of run.ingesters) {
          const rows = await collect(ingester.harvest(new AbortController().signal));
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            source: ingester.source,
            primaryName: '中文 "Name" \\ escaped\nline',
            entityType: 'unknown',
          });
        }
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        run.dispose();
      }
    },
  );

  it('retains every meaningful group and sparse uncertainty without inferring type or legal status', async () => {
    const full = {
      ...CSL_RECORDS[0],
      id: 'opaque-id',
      name: 'A Person',
      alt_names: ['Alias One', '别名', ''],
      addresses: [
        { address: 'One Street', city: 'City', state: null, postal_code: '', country: 'US' },
        {},
      ],
      ids: [
        { type: 'Passport', number: 'P-123', country: 'US' },
        { type: 'LEI', number: '5493001KJTIIGC8Y1R12' },
        { type: 'Passport', number: 'N/A' },
      ],
      call_sign: 'CQ123',
      vessel_imo: '1234567',
      programs: ['Program A', 'Program B'],
      dates_of_birth: ['1980', '1981-03'],
      places_of_birth: ['Place A', 'Place B'],
      nationalities: ['US'],
      citizenships: ['GB', 'US'],
      start_date: '1999-01-02',
      end_date: '2000-01-01',
      standard_order: 'Y',
      license_requirement: 'All items\nSee notice',
      license_policy: 'Presumption of denial',
      federal_register_notice: 'Notice 42',
      source_list_url: 'https://example.gov/list',
      source_information_url: 'https://example.gov/info',
      country: 'TH',
      remarks: 'Published remark',
    };
    const rows = await harvest(cslDocument([full, ...CSL_RECORDS.slice(1)]));
    expect(rows[0]).toEqual({
      id: 'bis_el:opaque-id',
      source: 'bis_el',
      sourceEntryId: 'opaque-id',
      primaryName: 'A Person',
      entityType: 'unknown',
      program: 'Program A; Program B',
      designationDate: '1999-01-02',
      payload: {
        aliases: [
          { name: 'Alias One', nameType: 'aka' },
          { name: '别名', nameType: 'aka' },
        ],
        addresses: [{ full: 'One Street, City, US', country: 'US' }],
        identifiers: [
          { type: 'Passport', value: 'P-123', country: 'US' },
          { type: 'LEI', value: '5493001KJTIIGC8Y1R12' },
          { type: 'Call Sign', value: 'CQ123' },
          { type: 'IMO Number', value: '1234567' },
        ],
        datesOfBirth: [
          { date: '1980' },
          { date: '1981-03' },
          { place: 'Place A' },
          { place: 'Place B' },
        ],
        nationalities: ['US', 'GB'],
        features: [
          { type: 'license_requirement', value: 'All items\nSee notice' },
          { type: 'license_policy', value: 'Presumption of denial' },
          { type: 'federal_register_notice', value: 'Notice 42' },
          { type: 'standard_order', value: 'Y' },
          { type: 'end_date', value: '2000-01-01' },
          { type: 'country', value: 'TH' },
          { type: 'source_list_url', value: 'https://example.gov/list' },
          { type: 'source_information_url', value: 'https://example.gov/info' },
        ],
        remarks: 'Published remark',
      },
    });
    expect(rows[1]?.payload).toEqual({
      aliases: [],
      addresses: [],
      identifiers: [],
      datesOfBirth: [],
      nationalities: [],
      features: [],
    });
  });

  it('retains large published alias/address arrays, uses id verbatim, and counts unusable records', async () => {
    const fetch = serve(
      cslDocument([
        {
          ...CSL_RECORDS[0],
          id: ' id with spaces ',
          alt_names: Array.from({ length: 40 }, (_, i) => `Alias ${i}`),
          addresses: Array.from({ length: 40 }, (_, i) => ({ address: `Street ${i}` })),
        },
        { source: SOURCE_LABELS.bis_el, _id: 'not-an-id', name: 'Missing Id' },
        { source: SOURCE_LABELS.bis_el, id: 'no-name', name: '\uFFFD' },
        { source: 'Ignored Treasury Source', id: 'ignored', name: 'Duplicate' },
        ...CSL_RECORDS.slice(1),
      ]),
    );
    const run = createCslPreparation();
    try {
      const ingester = run.ingesters[0]!;
      const rows = await collect(ingester.harvest(new AbortController().signal));
      expect(rows[0]?.sourceEntryId).toBe(' id with spaces ');
      expect(rows[0]?.payload.aliases).toHaveLength(40);
      expect(rows[0]?.payload.addresses).toHaveLength(40);
      expect(ingester.report()).toEqual({
        source: 'bis_el',
        accepted: 1,
        rejected: { missingIdentifier: 1, unusableName: 1 },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      run.dispose();
    }
  });

  const good = cslDocument();
  it.each([
    ['truncated', good.slice(0, -1)],
    ['trailing invalid', `${good}garbage`],
    ['second root', `${good}{}`],
    ['wrong total', good.replace('"total":6', '"total":7')],
    ['offset', good.replace('"offset":0', '"offset":1')],
    ['missing results', '{"offset":0,"total":0,"sources_used":[]}'],
    ['object results', '{"results":{},"offset":0,"total":0,"sources_used":[]}'],
    ['wrong root', '[]'],
    ['duplicate root field', good.replace('"offset":0', '"offset":0,"offset":0')],
    [
      'malformed record',
      cslDocument([{ ...CSL_RECORDS[0], addresses: 'not-an-array' }, ...CSL_RECORDS.slice(1)]),
    ],
    ['duplicate identity', cslDocument([...CSL_RECORDS, CSL_RECORDS[0]])],
    ['primitive result', cslDocument([false, ...CSL_RECORDS])],
    ['trailing comma', good.replace(/}$/, ',}')],
  ])(
    'rejects %s for all six lists before yielding any row, caching failure',
    async (_label, body) => {
      const fetch = serve(body, 7);
      const run = createCslPreparation();
      try {
        for (const ingester of run.ingesters) {
          await expect(collect(ingester.harvest(new AbortController().signal))).rejects.toThrow(
            /completely validated/,
          );
          expect(ingester.report().accepted).toBe(0);
        }
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        run.dispose();
      }
    },
  );

  it('missing metadata and an empty list fail only those adapters', async () => {
    serve(
      cslDocument(
        CSL_RECORDS.slice(1),
        CSL_SOURCE_CODES.filter((source) => source !== 'bis_dpl').map(
          (source) => SOURCE_LABELS[source],
        ),
      ),
    );
    const run = createCslPreparation();
    try {
      await expect(
        collect(run.ingesters[0]!.harvest(new AbortController().signal)),
      ).rejects.toThrow(/no accepted records/);
      await expect(
        collect(run.ingesters[1]!.harvest(new AbortController().signal)),
      ).rejects.toThrow(/metadata/);
      expect(await collect(run.ingesters[2]!.harvest(new AbortController().signal))).toHaveLength(
        1,
      );
    } finally {
      run.dispose();
    }
  });

  it('replays bounded pages and retains per-source removal-share guards', async () => {
    serve(
      cslDocument([
        ...CSL_RECORDS,
        { ...CSL_RECORDS[0], id: 'second' },
        { ...CSL_RECORDS[0], id: 'third' },
      ]),
    );
    const run = createCslPreparation();
    const reports: SourceSyncReport[] = [];
    try {
      const sync = createSanctionsSync({
        ingesters: run.ingesters,
        pageSize: 2,
        applyDeferredFields: async () => {},
        storedDeferredFields: async () => new Map(),
        staleDesignationIds: async (source) =>
          source === 'bis_el'
            ? ['bis_el:gone']
            : source === 'bis_dpl'
              ? ['bis_dpl:gone1', 'bis_dpl:gone2']
              : [],
        onSourceReport: (report) => reports.push(report),
      });
      const pages = await collect(sync({ signal: new AbortController().signal }));
      expect(
        pages.every((page) => page.records.length <= 2 && (page.tombstones?.length ?? 0) <= 2),
      ).toBe(true);
      expect(pages.flatMap((page) => page.tombstones ?? [])).toEqual(['bis_el:gone']);
      expect(reports.find((report) => report.source === 'bis_dpl')).toMatchObject({
        accepted: 1,
        pruned: 0,
        withheld: 2,
      });
    } finally {
      run.dispose();
    }
  });

  it('disposes only its owned scratch after success and early replay return; new runs fetch independently', async () => {
    const before = vi.mocked(mkdtempSync).mock.calls.length;
    const fetch = serve(cslDocument());
    for (let i = 0; i < 2; i++) {
      const run = createCslPreparation();
      const generator = run.ingesters[0]!.harvest(new AbortController().signal);
      try {
        expect((await generator.next()).value?.source).toBe('bis_el');
        expect(createdSpools(before).some((directory) => existsSync(directory))).toBe(true);
      } finally {
        await generator.return(undefined);
        run.dispose();
      }
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(createdSpools(before)).toHaveLength(2);
    for (const directory of createdSpools(before)) expect(existsSync(directory)).toBe(false);
  });

  it.each(['return', 'failure', 'cancel'] as const)(
    'sync finally removes its scratch on %s',
    async (ending) => {
      const before = vi.mocked(mkdtempSync).mock.calls.length;
      const controller = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).includes('consolidated.json')) {
            if (ending === 'cancel') {
              const response = new Response(
                new ReadableStream<Uint8Array>({
                  start(stream) {
                    stream.enqueue(new TextEncoder().encode('{"results":['));
                    init?.signal?.addEventListener(
                      'abort',
                      () => stream.error(init.signal?.reason),
                      { once: true },
                    );
                    controller.abort(new DOMException('Cancelled', 'AbortError'));
                  },
                }),
              );
              return response;
            }
            return new Response(ending === 'failure' ? '{' : cslDocument());
          }
          return new Response('not found', { status: 404 });
        }),
      );
      const sync = createSanctionsSync({
        applyDeferredFields: async () => {},
        storedDeferredFields: async () => new Map(),
        staleDesignationIds: async () => [],
        pageSize: 1,
      });
      const generator = sync({ signal: controller.signal });
      if (ending === 'return') {
        expect((await generator.next()).value?.records[0]?.source).toBe('bis_el');
        await generator.return(undefined);
      } else await expect(collect(generator)).rejects.toThrow();
      expect(createdSpools(before)).toHaveLength(1);
      for (const directory of createdSpools(before)) expect(existsSync(directory)).toBe(false);
    },
  );

  it('serves every new list through existing tools, URI resources, identifiers and GLEIF cross-reference with text parity', async () => {
    const records = await harvest(
      cslDocument(
        CSL_RECORDS.map((record) => ({
          ...record,
          name: 'CSL Counterparty',
          ids: [{ type: 'LEI', number: '5493001KJTIIGC8Y1R12' }],
          license_requirement: 'All items\nSee notice',
          license_policy: 'Review',
          federal_register_notice: 'Notice 42',
          standard_order: 'Y',
          end_date: '2000-01-01',
          source_list_url: 'https://example.gov/list',
          source_information_url: 'https://example.gov/info',
        })),
      ),
    );
    const state = await emptyGlobalService();
    try {
      await state.service.seedFixtures({
        designations: records,
        leiEntities: [
          { lei: '5493001KJTIIGC8Y1R12', legalName: 'CSL Counterparty', otherNames: [] },
        ],
        leiRelationships: [],
        reportingExceptions: [],
      });
      const defaultScreen = await runToolContract(screenNameTool, { name: 'CSL Counterparty' });
      expect(screenNameTool.output.parse(defaultScreen.structuredContent).hits).toHaveLength(6);
      for (const source of CSL_SOURCE_CODES) {
        const screen = await runToolContract(screenNameTool, {
          name: 'CSL Counterparty',
          sources: [source],
          limit: 1,
        });
        expect(screenNameTool.output.parse(screen.structuredContent).hits).toHaveLength(1);
        expect(JSON.stringify(screen.content)).toContain(source);
        const identifier = await runToolContract(screenIdentifierTool, {
          value: '5493001KJTIIGC8Y1R12',
          sources: [source],
        });
        expect(screenIdentifierTool.output.parse(identifier.structuredContent).hits).toHaveLength(
          1,
        );
        expect(JSON.stringify(identifier.content)).toContain(source);
        const entryId = `CSL-${source}`;
        const designation = await runToolContract(getDesignationTool, { source, entryId });
        const uri = await designationResource.handler(
          { source, entryId },
          createMockContext({ errors: designationResource.errors }),
        );
        const detail = getDesignationTool.output.parse(designation.structuredContent);
        expect(uri).toMatchObject({ source, features: detail.features });
        expect(detail.features).toHaveLength(7);
        const rendered = designation.content
          .map((block) => ('text' in block ? block.text : ''))
          .join('\n');
        for (const feature of records.find((record) => record.source === source)!.payload.features!)
          expect(rendered).toContain(feature.value);
      }
      const page = await runToolContract(screenNameTool, { name: 'CSL Counterparty', limit: 1 });
      expect(page.structuredContent).toMatchObject({
        totalAvailable: 6,
        hasMore: true,
        nextOffset: 1,
      });
      const past = await runToolContract(screenNameTool, { name: 'CSL Counterparty', offset: 6 });
      expect(screenNameTool.output.parse(past.structuredContent).hits).toEqual([]);
      const empty = await runToolContract(screenIdentifierTool, { value: 'not-in-any-list' });
      expect(screenIdentifierTool.output.parse(empty.structuredContent).hits).toEqual([]);
      const entity = await runToolContract(getEntityTool, { lei: '5493001KJTIIGC8Y1R12' });
      const entityPayload = getEntityTool.output.parse(entity.structuredContent);
      expect(entityPayload.sanctionsHits).toHaveLength(6);
      expect(entityPayload.sanctionsHits.map((hit) => hit.source)).toEqual([...CSL_SOURCE_CODES]);
      const sources = await runToolContract(listSourcesTool, {});
      const uriSources = await sourcesResource.handler({}, createMockContext());
      expect(uriSources).toEqual(sources.structuredContent);
      for (const source of CSL_SOURCE_CODES) {
        expect(listSourcesTool.output.parse(sources.structuredContent).sources).toContainEqual(
          expect.objectContaining({ code: source, recordCount: 1, label: SOURCE_LABELS[source] }),
        );
        expect(JSON.stringify(sources.content)).toContain(source);
      }
    } finally {
      await state.cleanup();
    }
  });
});
