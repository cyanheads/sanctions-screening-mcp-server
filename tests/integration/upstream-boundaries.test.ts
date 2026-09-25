/**
 * @fileoverview Offline integration tests for the external download boundary.
 * Every sanctions source and GLEIF endpoint is served by deterministic Response
 * fakes while the project's real fetch/retry/parse pipeline runs unchanged.
 * @module tests/integration/upstream-boundaries.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOURCE_URLS, resetServerConfig } from '@/config/server-config.js';
import { openGleifFile, resolveGleifPublication } from '@/services/screening/gleif-ingest.js';
import { buildSanctionsIngesters } from '@/services/screening/sanctions-ingest.js';
import type { NormalizedDesignation } from '@/services/screening/types.js';

const sourceBodies = new Map<string, string>([
  [
    DEFAULT_SOURCE_URLS.ofacSdn,
    '<sdnList><sdnEntry><uid>SDN-1</uid><firstName>Offline</firstName><lastName>SDN</lastName></sdnEntry></sdnList>',
  ],
  [
    DEFAULT_SOURCE_URLS.ofacConsolidated,
    '<sdnList><sdnEntry><uid>CONS-1</uid><firstName>Offline</firstName><lastName>Consolidated</lastName></sdnEntry></sdnList>',
  ],
  [
    DEFAULT_SOURCE_URLS.euFsf,
    '<export><sanctionEntity logicalId="EU-1"><subjectType code="person"/><nameAlias wholeName="Offline EU" strong="true"/></sanctionEntity></export>',
  ],
  [
    DEFAULT_SOURCE_URLS.ukSanctions,
    '<Designations><Designation><UniqueID>UK-1</UniqueID><IndividualEntityShip>Entity</IndividualEntityShip><Names><Name><Name6>Offline UK</Name6><NameType>Primary Name</NameType></Name></Names></Designation></Designations>',
  ],
  [
    DEFAULT_SOURCE_URLS.unSc,
    '<CONSOLIDATED_LIST><ENTITIES><ENTITY><DATAID>UN-1</DATAID><FIRST_NAME>Offline UN</FIRST_NAME></ENTITY></ENTITIES></CONSOLIDATED_LIST>',
  ],
]);

afterEach(() => {
  vi.unstubAllGlobals();
  resetServerConfig();
});

describe('sanctions source boundaries', () => {
  it('harvests all five sources through the external fetch boundary only', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = sourceBodies.get(url);
      if (!body) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
    });
    vi.stubGlobal('fetch', fetch);

    const ingesters = buildSanctionsIngesters();
    const harvested = await Promise.all(
      ingesters.map(async (ingester) => {
        const records: NormalizedDesignation[] = [];
        for await (const record of ingester.harvest(new AbortController().signal)) {
          records.push(record);
        }
        return { source: ingester.source, records };
      }),
    );

    expect(harvested.map((result) => result.source)).toEqual([
      'ofac_sdn',
      'ofac_consolidated',
      'eu',
      'uk',
      'un',
    ]);
    expect(harvested.every((result) => result.records.length === 1)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(
      new Set(
        fetch.mock.calls.map(([input]) =>
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        ),
      ),
    ).toEqual(new Set(sourceBodies.keys()));
  });
});

describe('GLEIF boundaries', () => {
  it.each(['lei2', 'rr', 'repex'] as const)(
    'resolves the %s golden copy and every delta window from one index request',
    async (dataset) => {
      const link = (name: string) => ({
        xml: { url: `https://offline.test/${dataset}-${name}.xml.zip` },
      });
      const index = {
        data: [
          {
            full_file: link('full'),
            delta_files: {
              IntraDay: link('intra-day'),
              LastDay: link('last-day'),
              LastWeek: link('last-week'),
              LastMonth: link('last-month'),
            },
          },
        ],
      };
      const fetch = vi.fn(async () => Response.json(index));
      vi.stubGlobal('fetch', fetch);

      await expect(resolveGleifPublication(dataset, new AbortController().signal)).resolves.toEqual(
        {
          full: `https://offline.test/${dataset}-full.xml.zip`,
          deltas: {
            IntraDay: `https://offline.test/${dataset}-intra-day.xml.zip`,
            LastDay: `https://offline.test/${dataset}-last-day.xml.zip`,
            LastWeek: `https://offline.test/${dataset}-last-week.xml.zip`,
            LastMonth: `https://offline.test/${dataset}-last-month.xml.zip`,
          },
        },
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
        `${DEFAULT_SOURCE_URLS.gleifGoldenCopyBase}/api/v2/golden-copies/publishes/${dataset}?format=xml`,
      );
    },
  );

  it('fails an index that publishes no golden copy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: [{ delta_files: {} }] })),
    );
    await expect(resolveGleifPublication('repex', new AbortController().signal)).rejects.toThrow(
      /repex/,
    );
  });

  it('streams a GLEIF file through a faked response: header first, then records', async () => {
    const xml = `<lei:LEIData xmlns:lei="http://www.gleif.org/data/schema/leidata/2016">
      <lei:LEIHeader><lei:ContentDate>2026-09-25T10:00:00Z</lei:ContentDate><lei:DeltaStart>2026-09-24T02:00:00Z</lei:DeltaStart></lei:LEIHeader>
      <lei:LEIRecords><lei:LEIRecord>
        <lei:LEI>5493001KJTIIGC8Y1R12</lei:LEI>
        <lei:Entity><lei:LegalName>Offline GLEIF Entity</lei:LegalName><lei:LegalJurisdiction>US</lei:LegalJurisdiction></lei:Entity>
        <lei:Registration><lei:RegistrationStatus>ISSUED</lei:RegistrationStatus></lei:Registration>
      </lei:LEIRecord></lei:LEIRecords></lei:LEIData>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(xml)),
    );

    const file = await openGleifFile(
      'lei2',
      'https://offline.test/lei.xml',
      new AbortController().signal,
    );
    const records = [];
    for await (const record of file.records) records.push(record);

    expect(file.header).toEqual({
      contentDate: '2026-09-25T10:00:00Z',
      deltaStart: '2026-09-24T02:00:00Z',
    });
    expect(records).toEqual([
      {
        lei: '5493001KJTIIGC8Y1R12',
        legalName: 'Offline GLEIF Entity',
        otherNames: [],
        jurisdiction: 'US',
        status: 'ISSUED',
      },
    ]);
  });
});
