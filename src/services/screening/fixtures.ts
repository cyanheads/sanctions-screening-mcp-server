/**
 * @fileoverview Small synthetic fixture mirror — a handful of designations (one
 * per source, with aliases and transliteration-class variants) plus a couple of
 * GLEIF entities and an ownership relationship. Lets `bun run test` exercise the
 * matching engine, the tools, and ownership tracing WITHOUT downloading the real
 * multi-source corpus (which loads out-of-band via `mirror:init`). The names
 * here are invented for testing — they are NOT real sanctions designations.
 * @module services/screening/fixtures
 */

import type {
  NormalizedDesignation,
  NormalizedLeiEntity,
  NormalizedLeiRelationship,
} from '@/services/screening/types.js';

/** Invented designations spanning all five sources, with aliases for fuzzy tests. */
export const FIXTURE_DESIGNATIONS: NormalizedDesignation[] = [
  {
    id: 'ofac_sdn:FX-1001',
    source: 'ofac_sdn',
    sourceEntryId: 'FX-1001',
    entityType: 'person',
    primaryName: 'Ivan Testovich Volkov',
    program: 'TEST-PROGRAM',
    designationDate: '2021-03-15',
    payload: {
      // 'Volkov' / 'Wolkow' is a transliteration-class pair for the phonetic test.
      aliases: [
        { name: 'Ivan Wolkow', nameType: 'aka' },
        { name: 'I. T. Volkov', nameType: 'aka' },
        { name: 'Vanya Volkov', nameType: 'low-quality-aka' },
      ],
      identifiers: [{ type: 'Passport', value: 'X1234567', country: 'Testland' }],
      addresses: [{ full: '1 Test Street, Testograd, Testland', country: 'Testland' }],
      datesOfBirth: [{ date: '1970-01-01', place: 'Testograd' }],
      nationalities: ['Testland'],
      remarks: 'Synthetic test designation — not a real person.',
    },
  },
  {
    id: 'ofac_consolidated:FX-2002',
    source: 'ofac_consolidated',
    sourceEntryId: 'FX-2002',
    entityType: 'organization',
    primaryName: 'Fictional Trading Company LLC',
    program: 'TEST-CONS',
    designationDate: '2022-06-01',
    payload: {
      aliases: [
        { name: 'Fictional Trading Co', nameType: 'aka' },
        { name: 'FTC LLC', nameType: 'aka' },
      ],
      identifiers: [],
      addresses: [{ full: '99 Commerce Way, Testopolis', country: 'Testland' }],
      datesOfBirth: [],
      nationalities: [],
    },
  },
  {
    id: 'eu:FX-3003',
    source: 'eu',
    sourceEntryId: 'FX-3003',
    entityType: 'person',
    primaryName: 'Katarina Beispiel',
    program: 'EU-TEST-REGIME',
    designationDate: '2023-02-20',
    payload: {
      aliases: [{ name: 'Katarina Example', nameType: 'aka' }],
      identifiers: [],
      addresses: [],
      datesOfBirth: [{ date: '1985-05-05' }],
      nationalities: ['Beispielland'],
    },
  },
  {
    id: 'uk:FX-4004',
    source: 'uk',
    sourceEntryId: 'FX-4004',
    entityType: 'vessel',
    primaryName: 'MV Phantom Voyager',
    program: 'UK-TEST-SHIPPING',
    designationDate: '2024-09-10',
    payload: {
      aliases: [{ name: 'Phantom Voyager', nameType: 'aka' }],
      identifiers: [{ type: 'IMO', value: '1234567' }],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  },
  {
    // Transliteration-class case: published as "Mohammed", queryable as
    // "Muhammad" — the two share a Double-Metaphone key (MHMT), which is how the
    // phonetic fallback catches a romanization the strict/JW paths would miss.
    id: 'un:FX-6006',
    source: 'un',
    sourceEntryId: 'FX-6006',
    entityType: 'person',
    primaryName: 'Mohammed Al-Testi',
    program: 'UN-TEST-1267',
    designationDate: '2019-04-12',
    payload: {
      aliases: [{ name: 'Mohammed Testi', nameType: 'aka' }],
      identifiers: [],
      addresses: [],
      datesOfBirth: [{ date: '1975-07-07' }],
      nationalities: ['Testland'],
    },
  },
  {
    id: 'un:FX-5005',
    source: 'un',
    sourceEntryId: 'FX-5005',
    entityType: 'organization',
    primaryName: 'Imaginary Front Organisation',
    program: 'UN-TEST-1267',
    designationDate: '2020-11-30',
    payload: {
      aliases: [
        { name: 'Imaginary Front Org', nameType: 'aka' },
        { name: 'IFO', nameType: 'low-quality-aka' },
      ],
      identifiers: [],
      addresses: [{ full: 'PO Box 1, Nowhere City' }],
      datesOfBirth: [],
      nationalities: [],
      remarks: 'Synthetic UN test entry.',
    },
  },
];

/** Two invented GLEIF entities — a parent and a subsidiary — for resolution + tracing. */
export const FIXTURE_LEI_ENTITIES: NormalizedLeiEntity[] = [
  {
    lei: '5493001KJTIIGC8Y1R12',
    legalName: 'Fictional Trading Company LLC',
    otherNames: ['Fictional Trading Co'],
    jurisdiction: 'US',
    status: 'ISSUED',
    legalAddress: '99 Commerce Way, Testopolis, US',
    headquartersAddress: '99 Commerce Way, Testopolis, US',
    registrationAuthorityId: 'RA000665',
    registrationAuthorityEntityId: 'TEST-REG-1',
    lastUpdate: '2026-01-15T10:00:00Z',
  },
  {
    lei: '529900T8BM49AURSDO55',
    legalName: 'Testland Holdings PLC',
    otherNames: ['Testland Holdings'],
    jurisdiction: 'GB',
    status: 'ISSUED',
    legalAddress: '1 Holding Square, London, GB',
    headquartersAddress: '1 Holding Square, London, GB',
    registrationAuthorityId: 'RA000585',
    registrationAuthorityEntityId: 'TEST-REG-2',
    lastUpdate: '2026-01-10T10:00:00Z',
  },
];

/** Testland Holdings PLC ultimately consolidates Fictional Trading Company LLC. */
export const FIXTURE_LEI_RELATIONSHIPS: NormalizedLeiRelationship[] = [
  {
    childLei: '5493001KJTIIGC8Y1R12',
    parentLei: '529900T8BM49AURSDO55',
    relationshipType: 'IS_ULTIMATELY_CONSOLIDATED_BY',
    relationshipStatus: 'ACTIVE',
    relationshipPeriod: '2020-01-01',
  },
];
