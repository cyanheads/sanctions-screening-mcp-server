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
    // Phonetic-only transliteration case for the minScore-floor regression:
    // the query "Katharina Petrov" shares this entry's whole Double-Metaphone
    // column ("K0RN PTRF") but no exact token, so its best score (~0.78) sits
    // below the default fuzzy floor. It is seeded into the candidate pool by the
    // phonetic key, then admitted ONLY when it clears `minScore` — before the
    // floor was enforced uniformly, the phonetic bypass surfaced it regardless.
    id: 'un:FX-7007',
    source: 'un',
    sourceEntryId: 'FX-7007',
    entityType: 'person',
    primaryName: 'Catherine Pyotrov',
    program: 'UN-TEST-1267',
    designationDate: '2018-08-08',
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [{ date: '1980-03-03' }],
      nationalities: ['Testland'],
      remarks: 'Synthetic transliteration-class test entry — not a real person.',
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
  {
    // Single-token false-positive guard (issue #4). A SHORT low-quality-aka whose
    // folded form ("noni") a longer, unrelated query token scores near — JW of
    // "nonexistent" vs "noni" is 0.8515, above the 0.85 fuzzy floor. Mirrors the
    // live OFAC low-quality-aka "Noni". The regression: a multi-token nonsense
    // query ("Zzqxwv Nonexistent Qqpzm") must NOT admit this entry on that one
    // token pair — only 1 of 3 query tokens is explained (coverage 1/3), below the
    // half-of-query admission gate — even though the pair itself clears the floor.
    id: 'ofac_sdn:FX-8008',
    source: 'ofac_sdn',
    sourceEntryId: 'FX-8008',
    entityType: 'person',
    primaryName: 'Mateo Restrepo Cardoza',
    program: 'TEST-PROGRAM',
    designationDate: '2021-11-05',
    payload: {
      aliases: [{ name: 'Noni', nameType: 'low-quality-aka' }],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
      remarks: 'Synthetic single-token false-positive test entry — not a real person.',
    },
  },
  {
    // Whole-string prefix-inflation guard (issue #8). A SHORT single-token
    // low-quality-aka ("Ferdinand") that is a bare prefix of a longer, unrelated
    // multi-token query. Jaro-Winkler's shared-prefix boost inflates the
    // whole-string similarity of "ferdinand aquino delgado" vs "ferdinand" to
    // 0.875 — above the 0.85 floor — even though token coverage is 1/3 and the
    // strings' length ratio is only 0.375. Mirrors the live OFAC first-name
    // low-quality-aka pattern (a bare "Nicolas" alias). The regression: such a
    // query must NOT admit this entry on the inflated whole-string score alone;
    // the length-ratio guard on the whole-string arm blocks it (0.375 < 0.5),
    // while the token arm rejects it for coverage 1/3. The primary name shares no
    // whole-string or ≥half-coverage support with the query, so the entry is
    // absent entirely.
    id: 'eu:FX-9009',
    source: 'eu',
    sourceEntryId: 'FX-9009',
    entityType: 'person',
    primaryName: 'Aurelio Ferdinand Castellanos',
    program: 'EU-TEST-REGIME',
    designationDate: '2023-07-19',
    payload: {
      aliases: [{ name: 'Ferdinand', nameType: 'low-quality-aka' }],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
      remarks: 'Synthetic whole-string prefix-inflation test entry — not a real person.',
    },
  },
  {
    // Spacing/concatenation recall the whole-string arm exists for (issue #8). The
    // folded name "van der berg shipping" queried as its space-stripped
    // concatenation "vanderbergshipping" scores 0.9667 whole-string but only 0.806
    // on the best token pair (no candidate token clears the floor against the
    // single concatenated query token), so the TOKEN arm cannot admit it — only the
    // whole-string arm can. The two strings keep near-equal length (ratio 0.857 ≥
    // 0.5), so the issue #8 length guard preserves this recall: a concatenated form
    // of a real multi-word name still admits.
    id: 'uk:FX-1010',
    source: 'uk',
    sourceEntryId: 'FX-1010',
    entityType: 'organization',
    primaryName: 'Van Der Berg Shipping',
    program: 'UK-TEST-SHIPPING',
    designationDate: '2024-04-02',
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
      remarks: 'Synthetic spacing/concatenation recall test entry — not a real organization.',
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
