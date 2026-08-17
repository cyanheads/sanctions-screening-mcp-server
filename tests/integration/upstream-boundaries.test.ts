/**
 * @fileoverview Offline integration tests for the external download boundary.
 * Every sanctions source and GLEIF endpoint is served by deterministic Response
 * fakes while the project's real fetch/retry/parse pipeline runs unchanged.
 * @module tests/integration/upstream-boundaries.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOURCE_URLS, resetServerConfig } from '@/config/server-config.js';
import {
  downloadGleifXml,
  harvestLeiLevel1,
  resolveGleifFileUrl,
} from '@/services/screening/gleif-ingest.js';
import { buildSanctionsIngesters } from '@/services/screening/sanctions-ingest.js';

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
      ingesters.map(async (ingester) => ({
        source: ingester.source,
        records: await ingester.harvest(new AbortController().signal),
      })),
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
  it('resolves full and delta URLs from a faked Golden Copy index', async () => {
    const index = {
      data: [
        {
          full_file: { xml: { url: 'https://offline.test/lei-full.xml.zip' } },
          delta_files: {
            LastDay: { xml: { url: 'https://offline.test/lei-delta.xml.zip' } },
          },
        },
      ],
    };
    const fetch = vi.fn(async () => Response.json(index));
    vi.stubGlobal('fetch', fetch);

    await expect(resolveGleifFileUrl('lei2-full', new AbortController().signal)).resolves.toBe(
      'https://offline.test/lei-full.xml.zip',
    );
    await expect(
      resolveGleifFileUrl('lei2-delta', new AbortController().signal, 'LastDay'),
    ).resolves.toBe('https://offline.test/lei-delta.xml.zip');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('downloads and normalizes Level 1 XML through a faked response', async () => {
    const xml = `
      <LEIData><LEIRecords><LEIRecord>
        <LEI>5493001KJTIIGC8Y1R12</LEI>
        <Entity><LegalName>Offline GLEIF Entity</LegalName><LegalJurisdiction>US</LegalJurisdiction></Entity>
        <Registration><RegistrationStatus>ISSUED</RegistrationStatus></Registration>
      </LEIRecord></LEIRecords></LEIData>
    `;
    const fetch = vi.fn(async () => new Response(xml));
    vi.stubGlobal('fetch', fetch);

    await expect(
      downloadGleifXml('https://offline.test/lei.xml', new AbortController().signal),
    ).resolves.toContain('Offline GLEIF Entity');
    await expect(
      harvestLeiLevel1('https://offline.test/lei.xml', new AbortController().signal),
    ).resolves.toEqual([
      {
        lei: '5493001KJTIIGC8Y1R12',
        legalName: 'Offline GLEIF Entity',
        otherNames: [],
        jurisdiction: 'US',
        status: 'ISSUED',
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
