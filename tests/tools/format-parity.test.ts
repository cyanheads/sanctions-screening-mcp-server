/**
 * @fileoverview `format()` coverage for every tool that renders one — the
 * markdown twin of `structuredContent`. Each tool is exercised twice: a rich
 * payload where every optional field and nested collection is populated, and a
 * sparse payload where each is omitted, so both arms of every conditional in
 * the renderer are pinned.
 *
 * Payloads are round-tripped through the tool's own `output` schema before
 * rendering, so a schema change that invalidates these shapes fails here rather
 * than silently drifting from what the handler can actually produce. The last
 * block tests the read-back harness itself against a fake tool.
 * @module tests/tools/format-parity.test
 */

import { type AnyToolDefinition, tool, z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import { crossReferencePointer, SCREENING_CAVEAT } from '@/mcp-server/tools/definitions/_shared.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenIdentifierTool } from '@/mcp-server/tools/definitions/screen-identifier.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import { expectLinearTime } from '../services/_linear-time.js';
import {
  CONSTRUCT_VALUES,
  expectByteIdentical,
  expectReadBack,
  type Fill,
  readBlocks,
  readText,
  render,
} from './_markdown-readback.js';

describe('sanctions_screen_name format()', () => {
  it('renders every hit field, including the optional score, program, and date', () => {
    const text = render(screenNameTool, {
      hits: [
        {
          source: 'ofac_sdn',
          sourceLabel: 'OFAC Specially Designated Nationals',
          sourceEntryId: 'FX-1001',
          sources: ['ofac_sdn'],
          entityType: 'person',
          primaryName: 'Ivan Testovich Volkov',
          matchedName: 'Ivan Wolkow',
          matchedNameType: 'aka',
          matchType: 'approximate',
          score: 0.912_345,
          queryTokenCoverage: { covered: 2, total: 3, phonetic: 1 },
          program: 'UKRAINE-EO13662',
          designationDate: '2019-03-15',
          birthDates: [{ date: '1968–1972', circa: true }, { date: '1970-07' }],
          nationalities: ['RU', '[go](https://example.invalid)'],
          addressCountries: ['GB', '*word* <b>x</b>'],
        },
      ],
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toContain('1 potential match(es)');
    expect(text).toContain('Ivan Testovich Volkov — approximate');
    expect(text).toContain('score 0.912345'); // the same raw value as structuredContent
    expect(text).toContain('covers 2/3 query tokens (1 by sound)'); // the secondary ranking key
    expect(text).toContain('OFAC Specially Designated Nationals');
    expect(text).toContain('Entry ID:** FX-1001');
    expect(text).toContain('Matched on:** "Ivan Wolkow" (aka)');
    expect(text).toContain('Program:** UKRAINE-EO13662');
    expect(text).toContain('Designated:** 2019-03-15');
    expect(text).toContain('Birth dates:** circa 1968–1972, 1970-07');
    expect(text).toContain(String.raw`Nationalities:** RU, \[go\](https://example.invalid)`);
    expect(text).toContain(String.raw`Address countries:** GB, \*word\* \<b>x\</b>`);
    expect(text).toMatch(/not a compliance determination/i);
  });

  it('omits score, program, and date for a hit that carries none', () => {
    const text = render(screenNameTool, {
      hits: [
        {
          source: 'un',
          sourceLabel: 'UN Security Council Consolidated List',
          sourceEntryId: 'UN-7',
          sources: ['un'],
          entityType: 'organization',
          primaryName: 'Sparse Holdings',
          matchedName: 'Sparse Holdings',
          matchedNameType: 'primary',
          matchType: 'exact',
        },
      ],
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toContain('Sparse Holdings — exact');
    expect(text).not.toContain('score');
    expect(text).not.toContain('query tokens');
    expect(text).not.toContain('Program:');
    expect(text).not.toContain('Designated:');
    expect(text).not.toContain('Birth dates:');
    expect(text).not.toContain('Nationalities:');
    expect(text).not.toContain('Address countries:');
    expect(text).not.toContain('Also listed on');
  });

  it('shows a sound-matched count exactly where the coverage carries one (issue #92)', () => {
    const hit = (sourceEntryId: string, queryTokenCoverage: Record<string, number>) => ({
      source: 'un',
      sourceLabel: 'UN Security Council Consolidated List',
      sourceEntryId,
      sources: ['un'],
      entityType: 'person',
      primaryName: `Hannibal Muammar Qadhafi ${sourceEntryId}`,
      matchedName: 'Hannibal Muammar Qadhafi',
      matchedNameType: 'primary',
      matchType: 'approximate',
      score: 1,
      queryTokenCoverage,
    });
    const payload = {
      hits: [
        hit('SOUND', { covered: 2, total: 2, phonetic: 1 }),
        hit('SPELL', { covered: 2, total: 2 }),
      ],
      caveat: SCREENING_CAVEAT,
    };
    const parsed = screenNameTool.output.parse(payload);
    expect(parsed.hits.map((h) => h.queryTokenCoverage)).toStrictEqual([
      { covered: 2, total: 2, phonetic: 1 },
      { covered: 2, total: 2 },
    ]);
    const text = render(screenNameTool, payload);
    expect(text).toContain(
      'Qadhafi SOUND — approximate · score 1 · covers 2/2 query tokens (1 by sound)\n',
    );
    expect(text).toContain('Qadhafi SPELL — approximate · score 1 · covers 2/2 query tokens\n');
    expect(text.match(/by sound/g)).toHaveLength(1);
  });

  it('names every list of a grouped OFAC hit, and whose record the date is (issue #61)', () => {
    const text = render(screenNameTool, {
      hits: [
        {
          source: 'ofac_sdn',
          sourceLabel: 'OFAC Specially Designated Nationals (SDN) List',
          sourceEntryId: '17022',
          sources: ['ofac_sdn', 'ofac_consolidated'],
          entityType: 'organization',
          primaryName: 'Rosneft Oil Company',
          matchedName: 'Rosneft',
          matchedNameType: 'aka',
          matchType: 'exact',
          program: 'UKRAINE-EO13662, RUSSIA-EO14024',
          designationDate: '2025-10-22',
        },
      ],
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toContain(
      '**List:** OFAC Specially Designated Nationals (SDN) List (`ofac_sdn`) | **Also listed on:** OFAC Consolidated Sanctions List (`ofac_consolidated`) | **Entry ID:** 17022 | **Type:** organization',
    );
    expect(text).toContain('**Designated:** 2025-10-22 (the `ofac_sdn` record)');
  });

  it('rejects a hit without sources', () => {
    const { sources: _sources, ...withoutSources } = {
      source: 'un',
      sourceLabel: 'UN Security Council Consolidated List',
      sourceEntryId: 'UN-7',
      sources: ['un'],
      entityType: 'organization',
      primaryName: 'Sparse Holdings',
      matchedName: 'Sparse Holdings',
      matchedNameType: 'primary',
      matchType: 'exact',
    };
    expect(() =>
      screenNameTool.output.parse({ hits: [withoutSources], caveat: SCREENING_CAVEAT }),
    ).toThrow();
  });

  it('renders the empty result as an absence of matches, never as a clearance', () => {
    const text = render(screenNameTool, { hits: [], caveat: SCREENING_CAVEAT });
    expect(text).toContain('**No potential matches found.**');
    expect(text).toMatch(/not a compliance determination/i);
  });
});

describe('sanctions_get_designation format()', () => {
  const base = {
    source: 'ofac_sdn',
    sourceLabel: 'OFAC Specially Designated Nationals',
    sourceEntryId: 'FX-1001',
    entityType: 'person',
    primaryName: 'Ivan Testovich Volkov',
    aliases: [],
    identifiers: [],
    addresses: [],
    datesOfBirth: [],
    nationalities: [],
    features: [],
    caveat: SCREENING_CAVEAT,
  };

  it('renders every published section of a fully populated record', () => {
    const text = render(getDesignationTool, {
      ...base,
      program: 'UKRAINE-EO13662',
      legalBasis: 'Executive Order 13662',
      designationDate: '2019-03-15',
      aliases: [
        { name: 'Ivan Wolkow', nameType: 'aka' },
        { name: 'I. T. Volkov', nameType: 'low-quality-aka' },
      ],
      identifiers: [
        { type: 'Passport', value: 'X1234567', country: 'RU' },
        { type: 'Tax ID', value: 'TIN-88' },
      ],
      addresses: [{ full: '1 Tverskaya St, Moscow', country: 'RU' }, { full: 'PO Box 9' }],
      datesOfBirth: [
        { date: '1971-04-02', place: 'Leningrad' },
        { date: '1972' },
        { place: 'Kazan, Tatarstan' },
      ],
      nationalities: ['RU', 'CY'],
      features: [
        { type: 'Gender', value: 'Male' },
        { type: 'Secondary sanctions risk:', value: 'See Section 11 of Executive Order 14024.' },
      ],
      remarks: 'Linked to a designated entity.',
    });

    expect(text).toContain('# Ivan Testovich Volkov');
    expect(text).toContain('Program:** UKRAINE-EO13662');
    expect(text).toContain('Legal basis:** Executive Order 13662');
    expect(text).toContain('Designated:** 2019-03-15');
    expect(text).toContain('- Ivan Wolkow (aka)');
    expect(text).toContain('- I. T. Volkov (low-quality-aka)');
    expect(text).toContain('**Passport:** X1234567 (RU)');
    expect(text).toContain('**Tax ID:** TIN-88');
    expect(text).not.toContain('TIN-88 (');
    expect(text).toContain('- 1 Tverskaya St, Moscow — RU');
    expect(text).toContain('- PO Box 9');
    expect(text).toContain('- 1971-04-02 at Leningrad');
    // A date alone and a place alone render as published, with no placeholder
    // for the half the source did not publish.
    expect(text.split('\n')).toContain('- 1972');
    expect(text.split('\n')).toContain('- Born in Kazan, Tatarstan');
    expect(text).not.toMatch(/unknown/i);
    expect(text).toContain('Nationalities:** RU, CY');
    expect(text).toContain('## Features');
    expect(text.split('\n')).toContain('- **Gender:** Male');
    // A label carrying its own colon is not given a second one.
    expect(text.split('\n')).toContain(
      '- **Secondary sanctions risk:** See Section 11 of Executive Order 14024.',
    );
    expect(text).toContain('Remarks:** Linked to a designated entity.');
  });

  it('names an address country once, whether or not the rendered address already ends with it', () => {
    const lines = render(getDesignationTool, {
      ...base,
      addresses: [
        { full: 'Kabul, Afghanistan', country: 'Afghanistan' },
        { full: 'Afghanistan', country: 'Afghanistan' },
        // A country that only ends the last component is not that component.
        { full: 'Port Moresby, Papua New Guinea', country: 'Guinea' },
        { full: '1 Tverskaya St, Moscow', country: 'RU' },
      ],
    }).split('\n');

    expect(lines).toContain('- Kabul, Afghanistan');
    expect(lines).toContain('- Afghanistan');
    expect(lines).toContain('- Port Moresby, Papua New Guinea — Guinea');
    expect(lines).toContain('- 1 Tverskaya St, Moscow — RU');
  });

  it('renders an approximate date as circa, and an interval at the precision published', () => {
    const lines = render(getDesignationTool, {
      ...base,
      datesOfBirth: [
        { date: '1951', circa: true, place: 'Mosul, Iraq' },
        { date: '1955/1957' },
        { date: '1946-09-26/1946-12-07' },
        { date: '../1980', circa: true },
        { date: '1966-07-07', circa: true },
      ],
      identifiers: [
        { type: 'SWIFT/BIC', value: 'HAVIGB2L' },
        { type: 'Digital Currency Address - XBT', value: '12aNKp2iDKuhEde2YfPdd4DFGenRUTKupL' },
      ],
      features: [
        { type: 'Organization Established Date', value: '2001-02-03', circa: true },
        { type: 'Organization Established Date', value: '1994' },
        { type: 'Additional Sanctions Information -', value: 'Subject to Secondary Sanctions' },
      ],
    }).split('\n');

    expect(lines).toContain('- **Organization Established Date:** circa 2001-02-03');
    expect(lines).toContain('- **Organization Established Date:** 1994');
    expect(lines).toContain(
      '- **Additional Sanctions Information -** Subject to Secondary Sanctions',
    );
    expect(lines).toContain('- circa 1951 at Mosul, Iraq');
    expect(lines).toContain('- 1955/1957');
    expect(lines).toContain('- 1946-09-26/1946-12-07');
    expect(lines).toContain('- circa ../1980');
    expect(lines).toContain('- circa 1966-07-07');
    expect(lines).toContain('- **SWIFT/BIC:** HAVIGB2L');
    expect(lines).toContain(
      '- **Digital Currency Address - XBT:** 12aNKp2iDKuhEde2YfPdd4DFGenRUTKupL',
    );
  });

  it('accepts circa only as true', () => {
    expect(() =>
      getDesignationTool.output.parse({ ...base, datesOfBirth: [{ date: '1951', circa: false }] }),
    ).toThrow();
    expect(() =>
      getDesignationTool.output.parse({
        ...base,
        features: [{ type: 'Aircraft Manufacture Date', value: '1990', circa: false }],
      }),
    ).toThrow();
  });

  it('requires the features group, empty when the source published none', () => {
    const withoutFeatures = Object.fromEntries(
      Object.entries(base).filter(([field]) => field !== 'features'),
    );
    expect(() => getDesignationTool.output.parse(withoutFeatures)).toThrow();
  });

  it('drops every optional section when the source published none', () => {
    const text = render(getDesignationTool, base);

    expect(text).toContain('# Ivan Testovich Volkov');
    expect(text).toContain('Type:** person');
    for (const heading of [
      '## Aliases',
      '## Identifiers',
      '## Addresses',
      '## Dates of birth',
      '## Features',
    ]) {
      expect(text).not.toContain(heading);
    }
    expect(text).not.toContain('Nationalities:');
    expect(text).not.toContain('Remarks:');
    expect(text).toMatch(/not a compliance determination/i);
  });
});

describe('sanctions_resolve_entity format()', () => {
  it('renders each candidate with its score and metadata line', () => {
    const text = render(resolveEntityTool, {
      matches: [
        {
          lei: '5493001KJTIIGC8Y1R12',
          legalName: 'Fictional Trading Company LLC',
          matchedName: 'Fictional Trading Co',
          matchedNameType: 'PREVIOUS_LEGAL_NAME',
          matchType: 'approximate',
          score: 0.887_777,
          queryTokenCoverage: { covered: 3, total: 3 },
          jurisdiction: 'US-DE',
          status: 'ISSUED',
        },
      ],
    });

    expect(text).toContain('1 LEI candidate(s)');
    expect(text).toContain('### Fictional Trading Company LLC — approximate');
    expect(text).toContain('score 0.887777');
    expect(text).toContain('covers 3/3 query tokens');
    expect(text).toContain('`5493001KJTIIGC8Y1R12`');
    expect(text).toContain('Matched on:** "Fictional Trading Co" (PREVIOUS_LEGAL_NAME)');
    expect(text).toContain('Jurisdiction: US-DE | Status: ISSUED');
  });

  it('labels a name stored without a type as type not recorded', () => {
    const text = render(resolveEntityTool, {
      matches: [
        {
          lei: '5493001KJTIIGC8Y1R12',
          legalName: 'Fictional Trading Company LLC',
          matchedName: 'FTC',
          matchedNameType: 'UNKNOWN',
          matchType: 'strong',
        },
      ],
    });

    expect(text).toContain('Matched on:** "FTC" (type not recorded)');
    expect(text).not.toContain('UNKNOWN');
  });

  it('omits the metadata line entirely when neither jurisdiction nor status is known', () => {
    const text = render(resolveEntityTool, {
      matches: [
        {
          lei: '5493001KJTIIGC8Y1R12',
          legalName: 'Bare Record Ltd',
          matchedName: 'Bare Record Ltd',
          matchedNameType: 'LEGAL_NAME',
          matchType: 'exact',
        },
      ],
    });

    expect(text).toContain('### Bare Record Ltd — exact');
    expect(text).not.toContain('score');
    expect(text).not.toContain('query tokens');
    expect(text).not.toContain('Jurisdiction:');
    expect(text).not.toContain('Status:');
  });

  it('renders no candidates as an explicit absence', () => {
    expect(render(resolveEntityTool, { matches: [] })).toBe('**No LEI candidates found.**');
  });
});

describe('sanctions_get_entity format()', () => {
  const base = {
    lei: '5493001KJTIIGC8Y1R12',
    legalName: 'Fictional Trading Company LLC',
    otherNames: [],
    alternateNames: [],
    entityStatus: 'ACTIVE',
    entityStatusLoaded: true,
    sanctionsHits: [],
    screeningStatus: 'screened',
    caveat: SCREENING_CAVEAT,
  };

  it('renders every GLEIF field and each sanctions cross-reference hit', () => {
    const text = render(getEntityTool, {
      ...base,
      otherNames: ['Fictional Trading Co', 'FTC'],
      alternateNames: [
        { name: 'Fictional Trading Co', type: 'PREVIOUS_LEGAL_NAME' },
        { name: 'FTC', type: 'TRADING_OR_OPERATING_NAME' },
        { name: 'FICTIONAL TRADING', type: 'PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME' },
      ],
      jurisdiction: 'US-DE',
      status: 'ISSUED',
      legalAddress: '1 Market St, Wilmington, DE',
      headquartersAddress: '500 Harbor Rd, Nassau',
      registrationAuthorityId: 'RA000602',
      registrationAuthorityEntityId: '4812291',
      lastUpdate: '2026-02-01T00:00:00.000Z',
      sanctionsHits: [
        {
          source: 'ofac_consolidated',
          sourceLabel: 'OFAC Consolidated Sanctions List',
          sourceEntryId: 'FX-2002',
          sources: ['ofac_consolidated'],
          primaryName: 'Fictional Trading Company LLC',
          matchedName: 'Fictional Trading Company LLC',
          matchType: 'exact',
          matchedIdentifiers: [{ type: 'Registration Number', value: '4812291', country: 'USA' }],
          matchedOn: [
            { input: 'legal_name', value: 'Fictional Trading Company LLC' },
            { input: 'registration_number', value: '4812291' },
          ],
        },
        {
          source: 'un',
          sourceLabel: 'UN Security Council Consolidated List',
          sourceEntryId: 'UN-7',
          sources: ['un'],
          primaryName: 'Harbor Front Co',
          matchedIdentifiers: [{ type: 'Legal Entity Number', value: '5493001KJTIIGC8Y1R12' }],
          matchedOn: [{ input: 'lei', value: '5493001KJTIIGC8Y1R12' }],
        },
        {
          source: 'eu',
          sourceLabel: 'EU Financial Sanctions Files',
          sourceEntryId: 'EU-31',
          sources: ['eu'],
          primaryName: 'Fictional Trading Co',
          matchedName: 'Fictional Trading Co',
          matchType: 'approximate',
          score: 0.934_21,
          matchedOn: [
            { input: 'other_name', value: 'Fictional Trading Co', nameType: 'PREVIOUS_LEGAL_NAME' },
          ],
        },
      ],
      sanctionsScreen: {
        totalAvailable: 31,
        totalAvailableBasis: 'exact',
        hasMore: true,
        screenedInputs: [
          { input: 'other_name', value: 'Fictional Trading Co', nameType: 'PREVIOUS_LEGAL_NAME' },
          { input: 'other_name', value: 'FTC', nameType: 'TRADING_OR_OPERATING_NAME' },
          {
            input: 'other_name',
            value: 'FICTIONAL TRADING',
            nameType: 'PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME',
          },
          { input: 'registration_number', value: '4812291' },
        ],
      },
    });

    expect(text).toContain('# Fictional Trading Company LLC');
    expect(text).toContain('Other names:** Fictional Trading Co; FTC');
    expect(text).toContain(
      'Names by type:** Fictional Trading Co (PREVIOUS_LEGAL_NAME); FTC (TRADING_OR_OPERATING_NAME); FICTIONAL TRADING (PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME)',
    );
    expect(text).toContain('Jurisdiction:** US-DE');
    expect(text).toContain('Registration status:** ISSUED');
    expect(text).toContain('Legal address:** 1 Market St, Wilmington, DE');
    expect(text).toContain('HQ address:** 500 Harbor Rd, Nassau');
    expect(text).toContain('Registration authority:** RA000602 (entity 4812291)');
    expect(text).toContain('Last update:** 2026-02-01T00:00:00.000Z');
    expect(text).toContain('## Sanctions screening cross-reference');
    expect(text).toContain(
      '- **Fictional Trading Company LLC** — OFAC Consolidated Sanctions List (`ofac_consolidated`, entry FX-2002), exact, matched "Fictional Trading Company LLC"; identifier Registration Number: 4812291 (USA) — matched on: legal_name "Fictional Trading Company LLC"; registration_number 4812291',
    );
    // An identifier-only hit names the identifier and no name match.
    expect(text).toContain(
      '- **Harbor Front Co** — UN Security Council Consolidated List (`un`, entry UN-7), identifier Legal Entity Number: 5493001KJTIIGC8Y1R12 — matched on: lei 5493001KJTIIGC8Y1R12',
    );
    expect(text).toContain(
      'approximate · score 0.934, matched "Fictional Trading Co" — matched on: other_name "Fictional Trading Co" (PREVIOUS_LEGAL_NAME)',
    );
    expect(text).toContain('showing 3 of 31 potential match(es) (count basis: exact)');
    expect(text).toContain(
      'more available: true — re-screen "Fictional Trading Company LLC", "Fictional Trading Co", "FTC", "FICTIONAL TRADING" with sanctions_screen_name and look up 5493001KJTIIGC8Y1R12, 4812291 with sanctions_screen_identifier to see the rest; the name re-screen can add approximate matches, which this count leaves out.',
    );
    expect(text).toContain(
      'Screened: legal_name "Fictional Trading Company LLC"; lei 5493001KJTIIGC8Y1R12; other_name "Fictional Trading Co" (PREVIOUS_LEGAL_NAME); other_name "FTC" (TRADING_OR_OPERATING_NAME); other_name "FICTIONAL TRADING" (PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME); registration_number 4812291',
    );
    expect(text).not.toContain('NOT a clearance');
  });

  it('discloses a complete cross-reference without pointing at a follow-up screen', () => {
    const text = render(getEntityTool, {
      ...base,
      sanctionsScreen: {
        totalAvailable: 0,
        totalAvailableBasis: 'exact',
        hasMore: false,
        screenedInputs: [],
      },
    });

    expect(text).toContain('showing 0 of 0 potential match(es) (count basis: exact)');
    expect(text).toContain('more available: false');
    expect(text).not.toContain('sanctions_screen_name');
    expect(text).toContain(
      'No potential watchlist matches on any screened name or identifier (NOT a clearance).',
    );
    // The legal name and the LEI are always screened, so even an empty list names them.
    expect(text).toContain(
      'Screened: legal_name "Fictional Trading Company LLC"; lei 5493001KJTIIGC8Y1R12',
    );
  });

  it('labels a bounded cross-reference count as a floor rather than a total', () => {
    const text = render(getEntityTool, {
      ...base,
      sanctionsScreen: {
        totalAvailable: 5000,
        totalAvailableBasis: 'lower_bound',
        hasMore: true,
        screenedInputs: [],
      },
    });

    expect(text).toContain('count basis: lower_bound');
  });

  it('renders a name stored without a GLEIF type as type not recorded, never UNKNOWN', () => {
    const untyped = { input: 'other_name', value: 'FTC', nameType: 'UNKNOWN' };
    const text = render(getEntityTool, {
      ...base,
      otherNames: ['FTC'],
      alternateNames: [{ name: 'FTC', type: 'UNKNOWN' }],
      sanctionsHits: [
        {
          source: 'uk',
          sourceLabel: 'UK Sanctions List',
          sourceEntryId: 'UK-9',
          sources: ['uk'],
          primaryName: 'FTC',
          matchedName: 'FTC',
          matchType: 'exact',
          matchedOn: [untyped],
        },
      ],
      sanctionsScreen: {
        totalAvailable: 1,
        totalAvailableBasis: 'exact',
        hasMore: false,
        screenedInputs: [untyped],
      },
    });

    expect(text).toContain('**Names by type:** FTC (type not recorded)');
    expect(text).toContain('matched on: other_name "FTC" (type not recorded)');
    expect(text).toContain('; other_name "FTC" (type not recorded)');
    expect(text).not.toContain('UNKNOWN');
    expect(text).not.toContain('also listed on');
  });

  it('names every list of a grouped OFAC hit (issue #61)', () => {
    const legal = { input: 'legal_name', value: base.legalName };
    const text = render(getEntityTool, {
      ...base,
      sanctionsHits: [
        {
          source: 'ofac_sdn',
          sourceLabel: 'OFAC Specially Designated Nationals (SDN) List',
          sourceEntryId: '17022',
          sources: ['ofac_sdn', 'ofac_consolidated'],
          primaryName: 'Fictional Trading Company LLC',
          matchedName: 'Fictional Trading Company LLC',
          matchType: 'exact',
          matchedOn: [legal],
        },
      ],
      sanctionsScreen: {
        totalAvailable: 1,
        totalAvailableBasis: 'exact',
        hasMore: false,
        screenedInputs: [],
      },
    });

    expect(text).toContain(
      '- **Fictional Trading Company LLC** — OFAC Specially Designated Nationals (SDN) List (`ofac_sdn`, entry 17022; also listed on OFAC Consolidated Sanctions List (`ofac_consolidated`)), exact, matched "Fictional Trading Company LLC" — matched on: legal_name "Fictional Trading Company LLC"',
    );
  });

  it('renders a registration authority with no entity ID and no hits', () => {
    const text = render(getEntityTool, { ...base, registrationAuthorityId: 'RA000602' });

    expect(text).toContain('Registration authority:** RA000602');
    expect(text).not.toContain('(entity');
    expect(text).not.toContain('Other names:');
    expect(text).not.toContain('Names by type:');
    expect(text).not.toContain('Jurisdiction:');
    expect(text).toContain(
      'No potential watchlist matches on any screened name or identifier (NOT a clearance).',
    );
    // No `sanctionsScreen` at all: an unscreened payload discloses no coverage.
    expect(text).not.toContain('count basis');
    expect(text).not.toContain('Screened:');
  });

  it('states that the cross-reference never ran when the sanctions mirror is unavailable', () => {
    const text = render(getEntityTool, { ...base, screeningStatus: 'not_ready' });

    expect(text).toMatch(/did not run/i);
    expect(text).toMatch(/not a clearance/i);
    expect(text).not.toContain('No potential watchlist matches');
    expect(text).not.toContain('count basis');
    expect(text).not.toContain('Screened:');
  });

  it('renders the entity status beside the registration status and every successor by LEI, name, or both (#94)', () => {
    const text = render(getEntityTool, {
      ...base,
      status: 'RETIRED',
      entityStatus: 'INACTIVE',
      successors: [
        { lei: '549300SZJ9VS8SGXAN81' },
        { name: 'Ｒ１株式会社' },
        { lei: '254900SPRNGTRUST0028', name: 'Acme *Star* Holdings' },
      ],
    });

    expect(text).toContain('**Registration status:** RETIRED\n**Entity status:** INACTIVE\n');
    expect(text).toContain(
      '**Successor entities:** `549300SZJ9VS8SGXAN81`; Ｒ１株式会社 (no LEI); `254900SPRNGTRUST0028` (Acme \\*Star\\* Holdings) — pass a successor LEI to sanctions_get_entity or sanctions_trace_ownership; successors are not screened here.',
    );
    expect(text).not.toContain('none published');
    expect(text).not.toContain('not loaded for this record');
  });

  it('renders a loaded record with no successor as none published (#94)', () => {
    const text = render(getEntityTool, base);

    expect(text).toContain('**Entity status:** ACTIVE');
    expect(text).toContain('**Successor entities:** none published');
    expect(text).not.toContain('not loaded for this record');
  });

  it('renders a record stored before entity status was read as not loaded, never as no successor (#94)', () => {
    const { entityStatus: _omitted, ...stored } = base;
    const text = render(getEntityTool, { ...stored, status: 'RETIRED', entityStatusLoaded: false });

    expect(text).toContain(
      '**Entity status and successors:** not loaded for this record — it was stored before they were read, so this does not mean no successor. A GLEIF refresh that updates the record, or mirror:init, loads them.',
    );
    expect(text).not.toContain('**Entity status:**');
    expect(text).not.toContain('Successor entities');
    expect(text).not.toContain('none published');
  });

  it('requires entityStatusLoaded and keeps a successor without its optional fields valid (#94)', () => {
    const { entityStatusLoaded: _omitted, ...withoutFlag } = base;
    expect(() => getEntityTool.output.parse(withoutFlag)).toThrow();
    expect(
      getEntityTool.output.parse({ ...base, successors: [{ name: 'Ｒ１株式会社' }] }).successors,
    ).toEqual([{ name: 'Ｒ１株式会社' }]);
  });

  it('escapes Markdown punctuation in every GLEIF name it renders, keeping the payload as written', () => {
    const payload = {
      ...base,
      legalName: 'Acme *Star* [Holdings] Ltd',
      otherNames: ['Star <Trading> Co'],
      alternateNames: [{ name: 'Star <Trading> Co', type: 'TRADING_OR_OPERATING_NAME' }],
    };
    const text = render(getEntityTool, payload);

    expect(text).toContain('# Acme \\*Star\\* \\[Holdings\\] Ltd\n');
    expect(text).toContain('**Other names:** Star \\<Trading> Co\n');
    expect(text).toContain('**Names by type:** Star \\<Trading> Co (TRADING_OR_OPERATING_NAME)\n');
    expect(text).not.toContain('*Star*');
    const parsed = getEntityTool.output.parse(payload);
    expect(parsed.legalName).toBe('Acme *Star* [Holdings] Ltd');
    expect(parsed.otherNames).toEqual(['Star <Trading> Co']);
  });

  it('escapes the other names as one joined string, so a name ending in an entity name reads back whole (#96)', () => {
    const otherNames = ['AT&amp', 'Tango &#35', 'B Ltd'];
    const text = render(getEntityTool, { ...base, otherNames });

    expect(readText(text).split('\n')).toContain('Other names: AT&amp; Tango &#35; B Ltd');
    expect(getEntityTool.output.parse({ ...base, otherNames }).otherNames).toEqual(otherNames);
  });

  it('closes the hit list before the screen coverage, so coverage never reads as part of the last hit (#96)', () => {
    const text = render(getEntityTool, {
      ...base,
      sanctionsHits: [
        {
          source: 'un',
          sourceLabel: 'UN Security Council Consolidated List',
          sourceEntryId: 'UN-7',
          sources: ['un'],
          primaryName: 'Harbor Front Co',
          matchedIdentifiers: [{ type: 'Legal Entity Number', value: base.lei }],
          matchedOn: [{ input: 'lei', value: base.lei }],
        },
      ],
      sanctionsScreen: {
        totalAvailable: 1,
        totalAvailableBasis: 'exact',
        hasMore: false,
        screenedInputs: [],
      },
    });
    const blocks = readBlocks(text);

    const hit = blocks.find((block) => block.text.startsWith('Harbor Front Co'));
    expect(hit?.containers).toEqual(['bullet_list']);
    expect(hit?.text).not.toContain('Screen coverage');
    const coverage = blocks.find((block) => block.text.startsWith('Screen coverage:'));
    expect(coverage?.containers).toEqual([]);
    expect(coverage?.text).toContain('\nScreened: legal_name');
  });
});

describe('sanctions_trace_ownership format()', () => {
  const root = {
    lei: '5493001KJTIIGC8Y1R12',
    legalName: 'Fictional Trading Company LLC',
    depth: 0,
    role: 'root',
  } as const;

  /** Unpaged fixture metadata; individual paging cases override these fields. */
  const segment = {
    boundaries: [],
    totalAvailable: 1,
    totalAvailableBasis: 'exact',
    hasMore: false,
    truncationReasons: [],
    missingEntityCount: 0,
  };

  /** A node's entity line in the Entities section, plus every indented line under it. */
  const nodeLines = (text: string, lei: string): string[] => {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.startsWith('- **') && line.includes(`\`${lei}\``));
    if (start === -1) return [];
    const end = lines.findIndex((line, index) => index > start && !line.startsWith('  - '));
    return lines.slice(start, end === -1 ? undefined : end);
  };

  it('renders nodes, per-node hits, edges, and the screened/flagged counts', () => {
    const text = render(traceOwnershipTool, {
      ...segment,
      rootLei: root.lei,
      complete: true,
      truncated: false,
      missingEntityLeis: [],
      reportingExceptionsLoaded: true,
      screeningStatus: 'screened',
      nodes: [
        {
          ...root,
          jurisdiction: 'US-DE',
          status: 'ISSUED',
          parentStatus: {
            direct: { status: 'relationship' },
            ultimate: { status: 'exception', exceptionReasons: ['NATURAL_PERSONS', 'NON_PUBLIC'] },
          },
          sanctionsHits: [
            {
              source: 'uk',
              sourceLabel: 'UK Sanctions List',
              sourceEntryId: 'UK-14',
              sources: ['uk'],
              primaryName: 'Fictional Trading Company LLC',
              matchedName: 'Fictional Trading Company LLC',
              matchType: 'approximate',
              score: 0.951,
              matchedOn: [
                { input: 'legal_name', value: 'Fictional Trading Company LLC' },
                { input: 'other_name', value: 'FTC', nameType: 'UNKNOWN' },
              ],
            },
            {
              source: 'un',
              sourceLabel: 'UN Security Council Consolidated List',
              sourceEntryId: 'UN-3',
              sources: ['un'],
              primaryName: 'Harbor Front Co',
              matchedIdentifiers: [
                { type: 'Registration Number', value: '4812291', country: 'United States' },
              ],
              matchedOn: [{ input: 'registration_number', value: '4812291' }],
            },
          ],
          sanctionsScreen: {
            totalAvailable: 7,
            totalAvailableBasis: 'exact',
            hasMore: true,
            screenedInputs: [
              { input: 'other_name', value: 'FTC', nameType: 'UNKNOWN' },
              { input: 'registration_number', value: '4812291' },
            ],
          },
        },
        {
          lei: '5493009BRIT0PARENT12',
          legalName: 'Parent Holdings PLC',
          depth: 1,
          role: 'parent',
          parentStatus: { direct: { status: 'none' }, ultimate: { status: 'relationship' } },
          sanctionsHits: [],
          sanctionsScreen: {
            totalAvailable: 0,
            totalAvailableBasis: 'exact',
            hasMore: false,
            screenedInputs: [],
          },
        },
      ],
      edges: [
        {
          childLei: root.lei,
          parentLei: '5493009BRIT0PARENT12',
          relationshipType: 'IS_DIRECTLY_CONSOLIDATED_BY',
          relationshipStatus: 'ACTIVE',
        },
        {
          childLei: '5493009BRIT0PARENT12',
          parentLei: '5493009ULTIMATE00099',
          relationshipType: 'IS_ULTIMATELY_CONSOLIDATED_BY',
        },
      ],
      screenedNodeCount: 2,
      flaggedNodeCount: 1,
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toContain('# Ownership graph for `5493001KJTIIGC8Y1R12`');
    expect(text).toContain('**2 node(s), 2 edge(s).**');
    expect(text).toContain('screened 2 node(s); 1 had potential matches; 1 capped.');
    expect(text).toContain('depth 0 (US-DE, ISSUED)');
    expect(text).toContain(
      '  - ⚠ Fictional Trading Company LLC — UK Sanctions List (`uk`, entry UK-14): matched "Fictional Trading Company LLC" — approximate · score 0.951 — matched on: legal_name "Fictional Trading Company LLC"; other_name "FTC" (type not recorded)',
    );
    // An identifier-only hit names the identifier and no name match.
    expect(text).toContain(
      '  - ⚠ Harbor Front Co — UN Security Council Consolidated List (`un`, entry UN-3): identifier Registration Number: 4812291 (United States) — matched on: registration_number 4812291',
    );
    expect(text).not.toContain('UNKNOWN');
    // A screened node with zero hits states the absence on its one line, rather than staying silent.
    expect(nodeLines(text, '5493009BRIT0PARENT12')).toEqual([
      '- **Parent Holdings PLC** `5493009BRIT0PARENT12` — parent, depth 1 · parents — direct: none published; ultimate: relationship · screen: no potential matches (not a clearance), 0 of 0 (count basis: exact)',
    ]);
    // Each screened node with matches discloses whether its own hit list was capped,
    // names everything to re-run, and lists what it screened beyond the legal name and LEI.
    expect(text).toContain(
      `showing 2 of 7 potential match(es) (count basis: exact); more available: true — re-screen "Fictional Trading Company LLC", "FTC" with sanctions_screen_name and look up ${root.lei}, 4812291 with sanctions_screen_identifier to see the rest; the name re-screen can add approximate matches, which this count leaves out.`,
    );
    expect(nodeLines(text, root.lei).at(-1)).toBe(
      '  - Screened beyond the legal name and LEI: other_name "FTC" (type not recorded); registration_number 4812291',
    );
    expect(text).toContain('## Ownership edges');
    expect(text).toContain('IS_DIRECTLY_CONSOLIDATED_BY `5493009BRIT0PARENT12` (ACTIVE)');
    expect(text).toContain('IS_ULTIMATELY_CONSOLIDATED_BY `5493009ULTIMATE00099`');
    expect(text).not.toContain('IS_ULTIMATELY_CONSOLIDATED_BY `5493009ULTIMATE00099` (');
    // A node with matches keeps its expanded block, parent statuses included.
    expect(text).toContain('direct parent: relationship published (see edges)');
    expect(text).toContain('ultimate parent: reporting exception (NATURAL_PERSONS, NON_PUBLIC)');
    expect(text).toMatch(/complete within the loaded relationship data/i);
    expect(text).not.toMatch(/reporting exceptions:\*\* not loaded/i);
    expect(text).not.toContain('also listed on');
  });

  it('names every list of a grouped OFAC hit on a node (issue #61)', () => {
    const legal = { input: 'legal_name', value: root.legalName };
    const text = render(traceOwnershipTool, {
      ...segment,
      rootLei: root.lei,
      complete: true,
      truncated: false,
      missingEntityLeis: [],
      reportingExceptionsLoaded: true,
      screeningStatus: 'screened',
      nodes: [
        {
          ...root,
          sanctionsHits: [
            {
              source: 'ofac_sdn',
              sourceLabel: 'OFAC Specially Designated Nationals (SDN) List',
              sourceEntryId: '17022',
              sources: ['ofac_sdn', 'ofac_consolidated'],
              primaryName: root.legalName,
              matchedName: root.legalName,
              matchType: 'exact',
              matchedOn: [legal],
            },
          ],
          sanctionsScreen: {
            totalAvailable: 1,
            totalAvailableBasis: 'exact',
            hasMore: false,
            screenedInputs: [],
          },
        },
      ],
      edges: [],
      screenedNodeCount: 1,
      flaggedNodeCount: 1,
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toContain(
      '  - ⚠ Fictional Trading Company LLC — OFAC Specially Designated Nationals (SDN) List (`ofac_sdn`, entry 17022; also listed on OFAC Consolidated Sanctions List (`ofac_consolidated`)): matched "Fictional Trading Company LLC" — exact — matched on: legal_name "Fictional Trading Company LLC"',
    );
  });

  it('renders every node without potential matches on one line carrying every field it has', () => {
    const capped = (lei: string, legalName: string, total: number) => ({
      lei,
      legalName,
      depth: 1,
      role: 'child',
      sanctionsHits: Array.from({ length: Math.min(total, 10) }, (_unused, index) => ({
        source: 'un',
        sourceLabel: 'UN Security Council Consolidated List',
        sourceEntryId: `UN-${lei}-${index}`,
        sources: ['un'],
        primaryName: legalName,
        matchedName: legalName,
        matchType: 'exact',
        matchedOn: [{ input: 'legal_name', value: legalName }],
      })),
      sanctionsScreen: {
        totalAvailable: total,
        totalAvailableBasis: 'exact',
        hasMore: total > 10,
        screenedInputs: [],
      },
    });
    const noMatches = (screenedInputs: unknown[] = []) => ({
      sanctionsHits: [],
      sanctionsScreen: {
        totalAvailable: 0,
        totalAvailableBasis: 'exact',
        hasMore: false,
        screenedInputs,
      },
    });
    const text = render(traceOwnershipTool, {
      ...segment,
      rootLei: root.lei,
      complete: true,
      truncated: false,
      missingEntityLeis: [],
      reportingExceptionsLoaded: true,
      screeningStatus: 'screened',
      nodes: [
        {
          ...root,
          jurisdiction: 'US-DE',
          status: 'ISSUED',
          parentStatus: {
            direct: { status: 'exception', exceptionReasons: ['NATURAL_PERSONS'] },
            ultimate: {
              status: 'exception',
              exceptionReasons: ['NATURAL_PERSONS', 'NO_KNOWN_PERSON'],
            },
          },
          ...noMatches(),
        },
        {
          lei: '5493009SUBSIDIARY012',
          legalName: 'Subsidiary Trading Ltd',
          jurisdiction: 'GB',
          status: 'LAPSED',
          depth: 1,
          role: 'child',
          parentStatus: { direct: { status: 'relationship' }, ultimate: { status: 'unknown' } },
          ...noMatches([
            {
              input: 'other_name',
              value: 'Subsidiary Trading',
              nameType: 'TRADING_OR_OPERATING_NAME',
            },
            { input: 'registration_number', value: '01234567' },
          ]),
        },
        {
          lei: '5493009GROUPMEMBER34',
          legalName: 'Group Member GmbH',
          jurisdiction: 'DE',
          status: 'ISSUED',
          depth: 1,
          role: 'child',
          reachedVia: 'ultimate',
          parentStatus: {
            direct: { status: 'relationship' },
            ultimate: { status: 'relationship' },
          },
          ...noMatches(),
        },
        capped('5493009CAPPEDNODE056', 'Capped Holdings Ltd', 12),
        capped('5493009LISTEDNODE078', 'Listed Holdings Ltd', 2),
      ],
      edges: [
        {
          childLei: '5493009SUBSIDIARY012',
          parentLei: root.lei,
          relationshipType: 'IS_DIRECTLY_CONSOLIDATED_BY',
        },
        {
          childLei: '5493009GROUPMEMBER34',
          parentLei: root.lei,
          relationshipType: 'IS_ULTIMATELY_CONSOLIDATED_BY',
        },
      ],
      screenedNodeCount: 5,
      flaggedNodeCount: 2,
      caveat: SCREENING_CAVEAT,
    });

    expect(nodeLines(text, root.lei)).toEqual([
      '- **Fictional Trading Company LLC** `5493001KJTIIGC8Y1R12` — root, depth 0 (US-DE, ISSUED) · parents — direct: reporting exception (NATURAL_PERSONS); ultimate: reporting exception (NATURAL_PERSONS, NO_KNOWN_PERSON) · screen: no potential matches (not a clearance), 0 of 0 (count basis: exact)',
    ]);
    // What was screened beyond the legal name and LEI closes the line, when anything was.
    expect(nodeLines(text, '5493009SUBSIDIARY012')).toEqual([
      '- **Subsidiary Trading Ltd** `5493009SUBSIDIARY012` — child, depth 1 (GB, LAPSED) · parents — direct: relationship; ultimate: unknown · screen: no potential matches (not a clearance), 0 of 0 (count basis: exact) · screened beyond the legal name and LEI: other_name "Subsidiary Trading" (TRADING_OR_OPERATING_NAME); registration_number 01234567',
    ]);
    // The flag, and a published parent this graph does not carry, each stated on the line.
    expect(nodeLines(text, '5493009GROUPMEMBER34')).toEqual([
      '- **Group Member GmbH** `5493009GROUPMEMBER34` — child, depth 1 (DE, ISSUED), reached only via an ultimate-parent edge (leaf, not walked) · parents — direct: relationship (parent not in this graph); ultimate: relationship · screen: no potential matches (not a clearance), 0 of 0 (count basis: exact)',
    ]);
    // A node with matches keeps its expanded block: each hit, its coverage, the capped pointer.
    const cappedBlock = nodeLines(text, '5493009CAPPEDNODE056');
    expect(cappedBlock[0]).toBe(
      '- **Capped Holdings Ltd** `5493009CAPPEDNODE056` — child, depth 1',
    );
    expect(cappedBlock.filter((line) => line.startsWith('  - ⚠ Capped Holdings Ltd'))).toHaveLength(
      10,
    );
    expect(cappedBlock.at(-1)).toBe(
      '  - Screen coverage: showing 10 of 12 potential match(es) (count basis: exact); more available: true — re-screen "Capped Holdings Ltd" with sanctions_screen_name and look up 5493009CAPPEDNODE056 with sanctions_screen_identifier to see the rest; the name re-screen can add approximate matches, which this count leaves out.',
    );
    expect(nodeLines(text, '5493009LISTEDNODE078').at(-1)).toBe(
      '  - Screen coverage: showing 2 of 2 potential match(es) (count basis: exact); more available: false',
    );
    // The summary counts the capped nodes beside the flagged ones.
    expect(text).toContain(
      '**Node screening:** screened 5 node(s); 2 had potential matches; 1 capped.',
    );
    expect(text.match(/no potential matches \(not a clearance\)/g)).toHaveLength(3);
    expect(text).not.toMatch(/\b(clean|cleared|clear)\b/i);
  });

  it('renders an unscreened node on one line with its parent statuses and no screen claim', () => {
    const text = render(traceOwnershipTool, {
      ...segment,
      rootLei: root.lei,
      complete: true,
      truncated: false,
      missingEntityLeis: [],
      reportingExceptionsLoaded: true,
      screeningStatus: 'not_requested',
      nodes: [
        {
          ...root,
          jurisdiction: 'US-DE',
          status: 'ISSUED',
          parentStatus: { direct: { status: 'none' }, ultimate: { status: 'none' } },
        },
        {
          lei: '5493009BRIT0PARENT12',
          legalName: 'Parent Holdings PLC',
          depth: 1,
          role: 'parent',
          reachedVia: 'ultimate',
        },
      ],
      edges: [
        {
          childLei: root.lei,
          parentLei: '5493009BRIT0PARENT12',
          relationshipType: 'IS_ULTIMATELY_CONSOLIDATED_BY',
        },
      ],
      screenedNodeCount: 0,
      flaggedNodeCount: 0,
      caveat: SCREENING_CAVEAT,
    });

    expect(nodeLines(text, root.lei)).toEqual([
      '- **Fictional Trading Company LLC** `5493001KJTIIGC8Y1R12` — root, depth 0 (US-DE, ISSUED) · parents — direct: none published; ultimate: none published',
    ]);
    expect(nodeLines(text, '5493009BRIT0PARENT12')).toEqual([
      '- **Parent Holdings PLC** `5493009BRIT0PARENT12` — parent, depth 1, reached only via an ultimate-parent edge (leaf, not walked)',
    ]);
    expect(text).not.toContain('not a clearance)');
  });

  it('renders an incomplete graph as truncated and names its unhydrated nodes', () => {
    const text = render(traceOwnershipTool, {
      ...segment,
      truncationReasons: ['depth_limit'],
      missingEntityCount: 1,
      rootLei: root.lei,
      complete: false,
      truncated: true,
      missingEntityLeis: ['33333333333333333333'],
      reportingExceptionsLoaded: false,
      screeningStatus: 'not_ready',
      nodes: [root],
      edges: [],
      screenedNodeCount: 0,
      flaggedNodeCount: 0,
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toMatch(/incomplete — the relationship graph below is a partial view/i);
    expect(text).toMatch(/truncated at the requested depth/i);
    expect(text).toMatch(/reporting exceptions:\*\* not loaded/i);
    expect(text).toContain('33333333333333333333');
    expect(text).toMatch(/not run/i);
  });

  it('renders a screened node with no Level 1 record as its LEI lookup alone', () => {
    const capped = '33333333333333333333';
    const quiet = '44444444444444444444';
    const leiHit = (index: number) => ({
      source: 'un',
      sourceLabel: 'UN Security Council Consolidated List',
      sourceEntryId: `UN-LEI-${index}`,
      sources: ['un'],
      primaryName: `Front Co ${index}`,
      matchedIdentifiers: [{ type: 'Legal Entity Number', value: capped }],
      matchedOn: [{ input: 'lei', value: capped }],
    });
    const screen = (totalAvailable: number) => ({
      totalAvailable,
      totalAvailableBasis: 'exact',
      hasMore: totalAvailable > 10,
      screenedInputs: [],
    });
    const text = render(traceOwnershipTool, {
      ...segment,
      missingEntityCount: 2,
      rootLei: root.lei,
      complete: false,
      truncated: false,
      missingEntityLeis: [capped, quiet],
      reportingExceptionsLoaded: true,
      screeningStatus: 'screened',
      nodes: [
        { ...root, sanctionsHits: [], sanctionsScreen: screen(0) },
        {
          lei: capped,
          legalName: capped,
          depth: 1,
          role: 'parent',
          sanctionsHits: Array.from({ length: 10 }, (_unused, index) => leiHit(index)),
          sanctionsScreen: screen(11),
        },
        {
          lei: quiet,
          legalName: quiet,
          depth: 1,
          role: 'child',
          sanctionsHits: [],
          sanctionsScreen: screen(0),
        },
      ],
      edges: [],
      screenedNodeCount: 3,
      flaggedNodeCount: 1,
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toContain(
      `- Absent from the GLEIF Level 1 entity mirror (2): \`${capped}\`, \`${quiet}\`. Those nodes show their LEI where a legal name would be; a per-node screen of one is its LEI lookup alone, since with no record there is no name to screen.`,
    );
    const block = nodeLines(text, capped);
    expect(block[1]).toBe(
      `  - ⚠ Front Co 0 — UN Security Council Consolidated List (\`un\`, entry UN-LEI-0): identifier Legal Entity Number: ${capped} — matched on: lei ${capped}`,
    );
    expect(block.slice(-2)).toEqual([
      `  - Screen coverage: showing 10 of 11 potential match(es) (count basis: exact); more available: true — look up ${capped} with sanctions_screen_identifier to see the rest.`,
      '  - Screened: the LEI lookup only (no Level 1 record, so no name was screened)',
    ]);
    expect(nodeLines(text, quiet)).toEqual([
      `- **${quiet}** \`${quiet}\` — child, depth 1 · screen: no potential matches (not a clearance), 0 of 0 (count basis: exact) · screened: the LEI lookup only (no Level 1 record, so no name was screened)`,
    ]);
    // A node with a record screened its legal name: no LEI-only note.
    expect(nodeLines(text, root.lei)).toEqual([
      `- **${root.legalName}** \`${root.lei}\` — root, depth 0 · screen: no potential matches (not a clearance), 0 of 0 (count basis: exact)`,
    ]);
    expect(text).not.toContain('re-screen');
  });

  it('drops the edges section and per-node hit lines when unscreened and isolated', () => {
    const text = render(traceOwnershipTool, {
      ...segment,
      rootLei: root.lei,
      complete: true,
      truncated: false,
      missingEntityLeis: [],
      reportingExceptionsLoaded: true,
      screeningStatus: 'not_requested',
      nodes: [root],
      edges: [],
      screenedNodeCount: 0,
      flaggedNodeCount: 0,
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toContain('**1 node(s), 0 edge(s).**');
    expect(text).toMatch(/screening:\*\* not requested/i);
    expect(text).not.toContain('had potential matches');
    expect(text).not.toContain('## Ownership edges');
    // A node with no `sanctionsHits` key at all was never screened, so it gets
    // no per-node line either way — unlike a screened node with zero hits.
    expect(text).not.toContain('No potential matches (not a clearance).');
    expect(text).not.toContain('potential match(es) (count basis');
    expect(text).toContain('depth 0');
    expect(text).not.toContain('depth 0 (');
    // A node whose parents were not walked gets no parent-status line.
    expect(text).not.toContain('parent:');
  });

  it('closes each list before the paragraph after it, so no status line reads as part of a list item (#96)', () => {
    const page = {
      ...segment,
      rootLei: root.lei,
      complete: false,
      truncated: true,
      screeningStatus: 'not_requested',
      nodes: [root],
      edges: [],
      screenedNodeCount: 0,
      flaggedNodeCount: 0,
      caveat: SCREENING_CAVEAT,
    };
    const withBranches = readBlocks(
      render(traceOwnershipTool, {
        ...page,
        boundaries: [
          { lei: '5493009BRIT0PARENT12', direction: 'parents', reason: 'depth_limit', depth: 3 },
        ],
        totalAvailable: 2,
        truncationReasons: ['depth_limit'],
        missingEntityCount: 1,
        missingEntityLeis: ['33333333333333333333'],
        reportingExceptionsLoaded: false,
      }),
    );
    const absent = withBranches.find((block) => block.text.startsWith('Absent from'));
    expect(absent?.containers).toEqual(['bullet_list']);
    expect(absent?.text).not.toContain('Reporting exceptions');
    const statuses = withBranches.find((block) => block.text.startsWith('Reporting exceptions:'));
    expect(statuses?.containers).toEqual([]);
    expect(statuses?.text).toContain('\nNode screening: not requested');

    // A truncation line alone is a list too.
    const truncatedOnly = readBlocks(
      render(traceOwnershipTool, {
        ...page,
        truncationReasons: ['ultimate_leaf'],
        missingEntityLeis: [],
        reportingExceptionsLoaded: true,
      }),
    );
    expect(truncatedOnly.find((block) => block.text.startsWith('Truncated:'))?.text).not.toContain(
      'Node screening',
    );
    expect(
      truncatedOnly.find((block) => block.text.startsWith('Node screening:'))?.containers,
    ).toEqual([]);
  });
});

describe('sanctions_list_sources format()', () => {
  const source = {
    code: 'ofac_sdn',
    label: 'OFAC Specially Designated Nationals',
    recordCount: 17_004,
    url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
    license: 'US Government work — public domain',
  };

  it('reports both mirrors as ready with their as-of timestamps', () => {
    const text = render(listSourcesTool, {
      sanctionsReady: true,
      sanctionsAsOf: '2026-06-01T12:00:00.000Z',
      leiReady: true,
      leiAsOf: '2026-06-01T13:00:00.000Z',
      reportingExceptionsLoaded: true,
      alternateNamesIndexed: true,
      entityStatusLoaded: true,
      sources: [
        source,
        {
          code: 'gleif',
          label: 'GLEIF LEI (Level 1 entities + Level 2 ownership)',
          recordCount: 3_375_797,
          relationshipCount: 489_224,
          reportingExceptionCount: 6_378_146,
          url: 'https://goldencopy.gleif.org',
          license: 'CC0 1.0 Universal (public domain)',
        },
      ],
    });

    expect(text).toContain('**Sanctions mirror:** ready (as of 2026-06-01T12:00:00.000Z)');
    expect(text).toContain('**GLEIF mirror:** ready (as of 2026-06-01T13:00:00.000Z)');
    expect(text).toContain('### OFAC Specially Designated Nationals (`ofac_sdn`)');
    expect(text).toContain('**Records:** 17004 | **License:** US Government work — public domain');
    expect(text).toContain(source.url);
    // GLEIF's Level 1 count and its Level 2 count, each named for its level.
    expect(text).toContain(
      '**Records:** 3375797 Level 1 entities · 489224 Level 2 relationships | **License:** CC0 1.0 Universal (public domain)',
    );
    expect(
      readBlocks(text)
        .filter((block) => block.text.includes('\nSource: '))
        .map((b) => b.links),
    ).toEqual([[source.url], ['https://goldencopy.gleif.org']]);
    expect(text).toContain('**Reporting exceptions:** 6378146');
    expect(text).not.toMatch(/reporting exceptions:\*\* not loaded/i);
    expect(text).toContain('**GLEIF alternate-name index:** built');
    expect(text).not.toContain('not built');
    expect(text).toContain(
      '**GLEIF entity status and successors:** loaded for every entity in the last full GLEIF load\n',
    );
  });

  it('reports an unsynced mirror as NOT ready with no timestamp', () => {
    const text = render(listSourcesTool, {
      sanctionsReady: false,
      leiReady: false,
      reportingExceptionsLoaded: false,
      alternateNamesIndexed: false,
      entityStatusLoaded: false,
      sources: [{ ...source, recordCount: 0 }],
    });

    expect(text).toContain('**Sanctions mirror:** NOT ready');
    expect(text).toContain('**GLEIF mirror:** NOT ready');
    expect(text).not.toContain('as of');
    expect(text).toContain('**Records:** 0 | ');
    expect(text).not.toContain('Level 2 relationships');
    // Unloaded exception data is stated as unloaded, never as a zero count.
    expect(text).toMatch(/reporting exceptions:\*\* not loaded/i);
    expect(text).not.toContain('**Reporting exceptions:** 0');
    // A mirror that never loaded has no index to report, built or not, and no
    // resolution to describe; what loads it is named.
    expect(text).toContain(
      '**GLEIF alternate-name index:** none yet — the GLEIF mirror has never completed a load. mirror:init loads the golden copy and builds the index with it.',
    );
    expect(text).not.toContain('not built');
    // The "NOT ready" line already says no entity is loaded; no status line repeats it.
    expect(text).not.toContain('entity status and successors');
  });

  it('states an unbuilt name index on a ready mirror, with what it costs resolution and what builds it', () => {
    const text = render(listSourcesTool, {
      sanctionsReady: true,
      leiReady: true,
      reportingExceptionsLoaded: true,
      alternateNamesIndexed: false,
      entityStatusLoaded: true,
      sources: [source],
    });
    expect(text).toContain(
      '**GLEIF alternate-name index:** not built — sanctions_resolve_entity searches legal names only',
    );
    expect(text).toContain('mirror:init');
  });

  it('states entity status not loaded on a ready mirror, pointing at each record and at mirror:init (#94)', () => {
    const text = render(listSourcesTool, {
      sanctionsReady: true,
      leiReady: true,
      reportingExceptionsLoaded: true,
      alternateNamesIndexed: true,
      entityStatusLoaded: false,
      sources: [source],
    });
    expect(text).toContain(
      '**GLEIF entity status and successors:** not loaded for every entity — a record stored before they were read says so in its own entityStatusLoaded. mirror:init reloads the GLEIF golden copy and loads them.',
    );
    expect(text).not.toContain('loaded for every entity in the last full GLEIF load');
  });

  it('rejects a sources payload without the entity-status flag (#94)', () => {
    expect(() =>
      render(listSourcesTool, {
        sanctionsReady: true,
        leiReady: true,
        reportingExceptionsLoaded: true,
        alternateNamesIndexed: true,
        sources: [source],
      }),
    ).toThrow();
  });

  /** A ready mirror's flags, for the per-list harvest and refresh cases (#88). */
  const ready = {
    sanctionsReady: true,
    sanctionsAsOf: '2026-11-18T04:00:00.000Z',
    leiReady: true,
    reportingExceptionsLoaded: true,
    alternateNamesIndexed: true,
    entityStatusLoaded: true,
  };
  const uk = {
    code: 'uk',
    label: 'UK Sanctions List (FCDO)',
    recordCount: 5_900,
    url: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml',
    license: 'Open Government Licence v3.0 (attribution required)',
  };
  const gleif = {
    code: 'gleif',
    label: 'GLEIF LEI (Level 1 entities + Level 2 ownership)',
    recordCount: 3,
    relationshipCount: 2,
    url: 'https://goldencopy.gleif.org',
    license: 'CC0 1.0 Universal (public domain)',
  };

  it("renders each list's last harvest and document date as stored, and no refresh line after a refresh that succeeded (#88)", () => {
    const text = render(listSourcesTool, {
      ...ready,
      sources: [
        { ...source, lastHarvestedAt: '2026-11-19T04:01:02.345Z' },
        { ...uk, lastHarvestedAt: '2026-11-19T04:01:03.000Z', publishedAt: '2026-11-17' },
        {
          ...source,
          code: 'eu',
          label: 'EU Consolidated Financial Sanctions List',
          lastHarvestedAt: '2026-11-19T04:01:04.000Z',
          publishedAt: '2026-10-23T17:05:43.888+02:00',
        },
        gleif,
      ],
    });

    // A date-only value stays a date; an offset and fraction are kept.
    expect(text).toContain(
      '**Last harvested:** 2026-11-19T04:01:03.000Z | **Document date:** 2026-11-17\n',
    );
    expect(text).toContain(
      '**Last harvested:** 2026-11-19T04:01:04.000Z | **Document date:** 2026-10-23T17:05:43.888+02:00\n',
    );
    // Harvested from a document that carried no date this server reads.
    expect(text).toContain(
      '**Last harvested:** 2026-11-19T04:01:02.345Z | **Document date:** none read from the document\n',
    );
    expect(text).not.toContain('**Last sanctions refresh:**');
    expect(text).not.toContain('**Per-list harvest:**');
    // The GLEIF row is not a harvested list.
    const gleifSection = text.slice(text.indexOf('(`gleif`)'));
    expect(gleifSection).not.toContain('Last harvested');
  });

  it('states how to read a list with no recorded harvest, never borrowing sanctionsAsOf as its date (#88)', () => {
    const none = render(listSourcesTool, { ...ready, sources: [source, uk, gleif] });
    expect(none).toContain(
      "**Per-list harvest:** not recorded yet for any list — this server records a list's harvest time and document date from its next successful harvest on, so an absent date is unknown, not old. sanctionsAsOf dates the whole mirror, not any one list.\n",
    );
    expect(none.match(/\*\*Last harvested:\*\* not recorded\n/g)).toHaveLength(2);
    expect(none).not.toContain(`**Last harvested:** ${ready.sanctionsAsOf}`);
    expect(none).not.toContain('**Document date:**');

    const some = render(listSourcesTool, {
      ...ready,
      sources: [source, { ...uk, lastHarvestedAt: '2026-11-19T04:01:03.000Z' }, gleif],
    });
    expect(some).toContain('**Per-list harvest:** not recorded yet for `ofac_sdn` — ');
  });

  it.each([
    [
      'running',
      { status: 'in_progress', startedAt: '2026-11-19T04:00:00.000Z' },
      '**Last sanctions refresh:** in_progress, started 2026-11-19T04:00:00.000Z — each list below shows its last finished harvest until this run ends; a run killed before it finished also reads as in_progress.\n',
    ],
    [
      'failed for named lists',
      {
        status: 'error',
        startedAt: '2026-11-19T04:00:00.000Z',
        failedSources: ['uk', 'bis_el'],
      },
      '**Last sanctions refresh:** error, started 2026-11-19T04:00:00.000Z — the harvest failed for `uk`, `bis_el`; each keeps its previous harvest below. sanctionsAsOf stays at the last refresh in which every list harvested.\n',
    ],
    [
      'failed with no list failed',
      { status: 'error', startedAt: '2026-11-19T04:00:00.000Z', failedSources: [] },
      "**Last sanctions refresh:** error, started 2026-11-19T04:00:00.000Z — no list's harvest failed: the run stopped before it finished (cancelled or out of time), and a list whose last harvest is earlier than that start was not refreshed by it. sanctionsAsOf stays at the last refresh in which every list harvested.\n",
    ],
    [
      'failed with no outcome recorded',
      { status: 'error', startedAt: '2026-11-19T04:00:00.000Z' },
      "**Last sanctions refresh:** error, started 2026-11-19T04:00:00.000Z — no list's outcome is recorded for this run, so which lists failed is unknown. sanctionsAsOf stays at the last refresh in which every list harvested.\n",
    ],
    [
      'failed with no recorded start',
      { status: 'error', failedSources: ['uk'] },
      '**Last sanctions refresh:** error — the harvest failed for `uk`; each keeps its previous harvest below. sanctionsAsOf stays at the last refresh in which every list harvested.\n',
    ],
  ] as const)('renders a %s refresh in words (#88)', (_state, lastRefresh, line) => {
    const text = render(listSourcesTool, {
      ...ready,
      lastRefresh,
      sources: [{ ...uk, lastHarvestedAt: '2026-11-18T04:01:03.000Z', publishedAt: '2026-11-17' }],
    });
    expect(text).toContain(line);
    expect(text.match(/\*\*Last sanctions refresh:\*\*/g)).toHaveLength(1);
  });

  it('rejects a lastRefresh state the payload never carries, and a failed list that is not a sanctions list (#88)', () => {
    for (const lastRefresh of [
      { status: 'complete', startedAt: '2026-11-19T04:00:00.000Z' },
      { status: 'pending' },
      { status: 'error', failedSources: ['gleif'] },
    ]) {
      expect(() => render(listSourcesTool, { ...ready, lastRefresh, sources: [uk] })).toThrow();
    }
  });
});

describe('published reference numbers in format() (issue #42)', () => {
  it('renders a screen_name hit reference beside its entry ID, and nothing when absent', () => {
    const hit = {
      source: 'uk',
      sourceLabel: 'UK Sanctions List (FCDO)',
      sourceEntryId: 'RUS0251',
      sources: ['uk'],
      entityType: 'person',
      primaryName: 'Vladimir Vladimirovich PUTIN',
      matchedName: 'Vladimir Vladimirovich PUTIN',
      matchedNameType: 'primary',
      matchType: 'exact',
    };
    const text = render(screenNameTool, {
      hits: [{ ...hit, referenceNumber: '14196' }],
      caveat: SCREENING_CAVEAT,
    });
    expect(text).toContain('**Entry ID:** RUS0251 | **Reference:** 14196 | **Type:** person');
    expect(render(screenNameTool, { hits: [hit], caveat: SCREENING_CAVEAT })).not.toContain(
      'Reference:',
    );
  });

  it('renders a designation reference beside its entry ID, and nothing when absent', () => {
    const record = {
      source: 'un',
      sourceLabel: 'UN Security Council Consolidated List',
      sourceEntryId: '113458',
      entityType: 'organization',
      primaryName: 'AL-QAIDA',
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
      features: [],
      caveat: SCREENING_CAVEAT,
    };
    expect(render(getDesignationTool, { ...record, referenceNumber: 'QDe.004' })).toContain(
      '**Entry ID:** 113458 | **Reference:** QDe.004',
    );
    expect(render(getDesignationTool, record)).not.toContain('Reference:');
  });
});

describe('UN reference numbers in format() (issue #89)', () => {
  const hit = {
    source: 'uk',
    sourceLabel: 'UK Sanctions List (FCDO)',
    sourceEntryId: 'AFG0001',
    sources: ['uk'],
    entityType: 'organization',
    primaryName: 'HAJI KHAIRULLAH HAJI SATTAR MONEY EXCHANGE',
    matchedName: 'HAJI KHAIRULLAH HAJI SATTAR MONEY EXCHANGE',
    matchedNameType: 'primary',
    matchType: 'exact',
  };
  const record = {
    source: 'uk',
    sourceLabel: 'UK Sanctions List (FCDO)',
    sourceEntryId: 'AFG0001',
    entityType: 'organization',
    primaryName: 'HAJI KHAIRULLAH HAJI SATTAR MONEY EXCHANGE',
    aliases: [],
    identifiers: [],
    addresses: [],
    datesOfBirth: [],
    nationalities: [],
    features: [],
    caveat: SCREENING_CAVEAT,
  };

  it('renders a screen_name hit UN reference after its reference number, alone, or not at all', () => {
    const both = { ...hit, referenceNumber: '12703', unReferenceNumber: 'TAe.010' };
    expect(render(screenNameTool, { hits: [both], caveat: SCREENING_CAVEAT })).toContain(
      '**Entry ID:** AFG0001 | **Reference:** 12703 | **UN reference:** TAe.010 | **Type:** organization',
    );
    const alone = { ...hit, unReferenceNumber: 'TAe.010' };
    expect(render(screenNameTool, { hits: [alone], caveat: SCREENING_CAVEAT })).toContain(
      '**Entry ID:** AFG0001 | **UN reference:** TAe.010 | **Type:** organization',
    );
    expect(render(screenNameTool, { hits: [hit], caveat: SCREENING_CAVEAT })).not.toContain(
      'UN reference',
    );
  });

  it('renders a designation UN reference after its reference number, alone, or not at all', () => {
    expect(
      render(getDesignationTool, {
        ...record,
        referenceNumber: '12703',
        unReferenceNumber: 'TAe.010',
      }),
    ).toContain('**Entry ID:** AFG0001 | **Reference:** 12703 | **UN reference:** TAe.010\n');
    expect(render(getDesignationTool, { ...record, unReferenceNumber: 'TAe.010' })).toContain(
      '**Entry ID:** AFG0001 | **UN reference:** TAe.010\n',
    );
    expect(render(getDesignationTool, record)).not.toContain('UN reference');
  });

  it('keeps the value on both surfaces exactly as published', () => {
    // Values the lists publish off the UN's own form: case, padding.
    for (const value of ['QDE.145', 'LYi.28']) {
      const parsed = getDesignationTool.output.parse({ ...record, unReferenceNumber: value });
      expect(parsed.unReferenceNumber).toBe(value);
      expect(render(getDesignationTool, parsed)).toContain(`**UN reference:** ${value}`);
      const hits = screenNameTool.output.parse({
        hits: [{ ...hit, unReferenceNumber: value }],
        caveat: SCREENING_CAVEAT,
      }).hits;
      expect(hits[0]?.unReferenceNumber).toBe(value);
    }
  });
});

describe('sanctions_screen_identifier format()', () => {
  it('renders every hit field and every matched identifier, country included', () => {
    const text = render(screenIdentifierTool, {
      hits: [
        {
          source: 'eu',
          sourceLabel: 'EU Consolidated Financial Sanctions List',
          sourceEntryId: 'FX-BIC-1',
          sources: ['eu'],
          primaryName: 'Fictional Clearing Bank',
          entityType: 'organization',
          program: 'EU-TEST-REGIME',
          matchedIdentifiers: [
            { type: 'SWIFT BIC', value: 'FCLBTLTTXXX' },
            { type: 'SWIFT BIC', value: 'FCLBTLTT', country: 'Testland' },
          ],
        },
      ],
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toContain('1 designation(s) publish a matching identifier');
    expect(text).toContain('### Fictional Clearing Bank');
    expect(text).toContain(
      '**List:** EU Consolidated Financial Sanctions List (`eu`) | **Entry ID:** FX-BIC-1 | **Type:** organization',
    );
    expect(text).toContain('**Program:** EU-TEST-REGIME');
    expect(text).toContain('- **SWIFT BIC:** FCLBTLTTXXX\n');
    expect(text).toContain('- **SWIFT BIC:** FCLBTLTT (Testland)');
    expect(text).toMatch(/not a compliance determination/i);
  });

  it('omits the program for a hit that carries none', () => {
    const text = render(screenIdentifierTool, {
      hits: [
        {
          source: 'ofac_sdn',
          sourceLabel: 'OFAC Specially Designated Nationals (SDN) List',
          sourceEntryId: '4243',
          sources: ['ofac_sdn'],
          primaryName: 'EBANO',
          entityType: 'vessel',
          matchedIdentifiers: [
            { type: 'Vessel Registration Identification', value: 'IMO 7406784' },
          ],
        },
      ],
      caveat: SCREENING_CAVEAT,
    });
    expect(text).toContain('- **Vessel Registration Identification:** IMO 7406784');
    expect(text).not.toContain('Program:');
    expect(text).not.toContain('Also listed on');
  });

  it('names every list of a grouped OFAC hit (issue #61)', () => {
    const text = render(screenIdentifierTool, {
      hits: [
        {
          source: 'ofac_sdn',
          sourceLabel: 'OFAC Specially Designated Nationals (SDN) List',
          sourceEntryId: '17022',
          sources: ['ofac_sdn', 'ofac_consolidated'],
          primaryName: 'Rosneft Oil Company',
          entityType: 'organization',
          matchedIdentifiers: [{ type: 'Tax ID No.', value: '7706107510', country: 'Russia' }],
        },
      ],
      caveat: SCREENING_CAVEAT,
    });
    expect(text).toContain(
      '**List:** OFAC Specially Designated Nationals (SDN) List (`ofac_sdn`) | **Also listed on:** OFAC Consolidated Sanctions List (`ofac_consolidated`) | **Entry ID:** 17022 | **Type:** organization',
    );
  });

  it('renders the empty result as an absence of matches, never as a clearance', () => {
    const text = render(screenIdentifierTool, { hits: [], caveat: SCREENING_CAVEAT });
    expect(text).toContain('**No designation publishes a matching identifier.**');
    expect(text).toMatch(/an empty result is not a clearance/i);
  });
});

describe('GLEIF tool text in content[] (issue #96)', () => {
  const LEI = '5493001KJTIIGC8Y1R12';
  const PARENT_LEI = '5493009BRIT0PARENT12';
  const GRANDPARENT_LEI = '5493009GRANDPARENT34';

  /**
   * Values an escaper reading the value alone leaves inert, but the authored text
   * after them can complete: an entity name or numeric reference closed by a `;`,
   * and a trailing backslash escaping the next character.
   */
  const JOIN_VALUES = [
    'Sierra &amp',
    'Tango &#35',
    'Uniform &#x2A',
    'Victor &lt',
    'Whiskey &quot',
    'Yankee \\',
  ];

  const VALUE_SETS = [
    ['every Markdown construct', CONSTRUCT_VALUES],
    ['a value the authored text after it could complete', JOIN_VALUES],
  ] as const;

  it.each(VALUE_SETS)(
    'sanctions_resolve_entity: %s reads back from content[] as published',
    (_set, values) => {
      expectReadBack(
        resolveEntityTool,
        (fill) => ({
          matches: [
            {
              lei: LEI,
              legalName: fill('heading'),
              matchedName: fill(),
              matchedNameType: fill(),
              matchType: 'approximate',
              score: 0.912,
              queryTokenCoverage: { covered: 2, total: 3 },
              jurisdiction: fill(),
              status: fill(),
            },
            {
              lei: PARENT_LEI,
              legalName: fill('heading'),
              matchedName: fill(),
              matchedNameType: fill(),
              matchType: 'strong',
              status: fill(),
            },
          ],
        }),
        values,
      );
    },
  );

  /** A grouped OFAC hit matched by name and two identifiers, on `matchedOn`. */
  const nameHit = (fill: Fill, matchedOn: unknown[]) => ({
    source: 'ofac_sdn',
    sourceLabel: 'OFAC Specially Designated Nationals (SDN) List',
    sourceEntryId: fill(),
    sources: ['ofac_sdn', 'ofac_consolidated'],
    primaryName: fill(),
    matchedName: fill(),
    matchType: 'exact',
    matchedIdentifiers: [
      { type: fill(), value: fill() },
      { type: fill(), value: fill(), country: fill() },
    ],
    matchedOn,
  });

  /** A hit only the LEI produced: no matched name. */
  const leiHit = (fill: Fill, lei: string) => ({
    source: 'un',
    sourceLabel: 'UN Security Council Consolidated List',
    sourceEntryId: fill(),
    sources: ['un'],
    primaryName: fill(),
    matchedIdentifiers: [{ type: fill(), value: lei }],
    matchedOn: [{ input: 'lei', value: lei }],
  });

  it.each(VALUE_SETS)(
    'sanctions_get_entity: %s reads back from content[] as published',
    (_set, values) => {
      expectReadBack(
        getEntityTool,
        (fill) => {
          const legalName = fill('heading');
          const otherNames = [fill(), fill(), fill()];
          const screenedNames = otherNames.map((value) => ({
            input: 'other_name',
            value,
            nameType: fill(),
          }));
          const registrationNumber = fill();
          return {
            lei: LEI,
            legalName,
            otherNames,
            alternateNames: screenedNames.map(({ value, nameType }) => ({
              name: value,
              type: nameType,
            })),
            jurisdiction: fill(),
            status: fill(),
            entityStatus: fill(),
            successors: [
              { lei: PARENT_LEI, name: fill() },
              { name: fill() },
              { lei: GRANDPARENT_LEI },
            ],
            entityStatusLoaded: true,
            legalAddress: fill(),
            headquartersAddress: fill(),
            registrationAuthorityId: fill(),
            registrationAuthorityEntityId: registrationNumber,
            lastUpdate: fill(),
            sanctionsHits: [
              nameHit(fill, [
                { input: 'legal_name', value: legalName },
                screenedNames[0],
                { input: 'registration_number', value: registrationNumber },
                { input: 'lei', value: LEI },
              ]),
              leiHit(fill, LEI),
            ],
            sanctionsScreen: {
              totalAvailable: 9,
              totalAvailableBasis: 'exact',
              hasMore: true,
              screenedInputs: [
                ...screenedNames,
                { input: 'registration_number', value: registrationNumber },
              ],
            },
            screeningStatus: 'screened',
            caveat: SCREENING_CAVEAT,
          };
        },
        values,
      );
    },
  );

  it.each(VALUE_SETS)(
    'sanctions_trace_ownership: %s on nodes to depth 2, their hits, and edges reads back as published',
    (_set, values) => {
      expectReadBack(
        traceOwnershipTool,
        (fill) => {
          /** A screened node's names and registration number, and its screen disclosure. */
          const screened = (legalName: string, hasMore: boolean) => {
            const other = { input: 'other_name', value: fill(), nameType: fill() };
            const registration = { input: 'registration_number', value: fill() };
            return {
              matchedOn: [{ input: 'legal_name', value: legalName }, other, registration],
              sanctionsScreen: {
                totalAvailable: hasMore ? 12 : 0,
                totalAvailableBasis: 'exact',
                hasMore,
                screenedInputs: [other, registration],
              },
            };
          };
          const rootName = fill();
          const root = screened(rootName, true);
          const parentName = fill();
          const parent = screened(parentName, false);
          const grandparentName = fill();
          const grandparent = screened(grandparentName, true);
          return {
            rootLei: LEI,
            nodes: [
              {
                lei: LEI,
                legalName: rootName,
                jurisdiction: fill(),
                status: fill(),
                depth: 0,
                role: 'root',
                parentStatus: {
                  direct: { status: 'relationship' },
                  ultimate: { status: 'exception', exceptionReasons: [fill(), fill()] },
                },
                sanctionsHits: [nameHit(fill, root.matchedOn)],
                sanctionsScreen: root.sanctionsScreen,
              },
              {
                lei: PARENT_LEI,
                legalName: parentName,
                jurisdiction: fill(),
                status: fill(),
                depth: 1,
                role: 'parent',
                parentStatus: {
                  direct: { status: 'exception', exceptionReasons: [fill()] },
                  ultimate: { status: 'relationship' },
                },
                sanctionsHits: [],
                sanctionsScreen: parent.sanctionsScreen,
              },
              {
                lei: GRANDPARENT_LEI,
                legalName: grandparentName,
                jurisdiction: fill(),
                depth: 2,
                role: 'parent',
                sanctionsHits: [
                  nameHit(fill, grandparent.matchedOn),
                  leiHit(fill, GRANDPARENT_LEI),
                ],
                sanctionsScreen: grandparent.sanctionsScreen,
              },
            ],
            edges: [
              {
                childLei: LEI,
                parentLei: PARENT_LEI,
                relationshipType: fill(),
                relationshipStatus: fill(),
              },
              {
                childLei: PARENT_LEI,
                parentLei: GRANDPARENT_LEI,
                relationshipType: fill(),
                relationshipStatus: fill(),
              },
              { childLei: LEI, parentLei: GRANDPARENT_LEI, relationshipType: fill() },
            ],
            boundaries: [],
            totalAvailable: 6,
            totalAvailableBasis: 'exact',
            hasMore: false,
            truncationReasons: [],
            missingEntityCount: 0,
            complete: true,
            truncated: false,
            reportingExceptionsLoaded: true,
            missingEntityLeis: [],
            screeningStatus: 'screened',
            screenedNodeCount: 3,
            flaggedNodeCount: 2,
            caveat: SCREENING_CAVEAT,
          };
        },
        values,
      );
    },
  );

  it('renders a value with no Markdown-active character byte-identically in every slot', () => {
    const lines = (tool: AnyToolDefinition, payload: unknown) => render(tool, payload).split('\n');

    expect(
      lines(resolveEntityTool, {
        matches: [
          {
            lei: LEI,
            legalName: 'AT&T C# 12 Holdings',
            matchedName: 'snake_case Trading',
            matchedNameType: 'TRADING_OR_OPERATING_NAME',
            matchType: 'exact',
            jurisdiction: 'US-DE',
            status: 'ISSUED',
          },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        '### AT&T C# 12 Holdings — exact',
        '**Matched on:** "snake_case Trading" (TRADING_OR_OPERATING_NAME)',
        '**Jurisdiction: US-DE | Status: ISSUED**',
      ]),
    );

    expect(
      lines(getEntityTool, {
        lei: LEI,
        legalName: 'AT&T C# 12 Holdings',
        otherNames: ['ACME LTD', 'snake_case'],
        alternateNames: [
          { name: 'ACME LTD', type: 'TRADING_OR_OPERATING_NAME' },
          { name: 'snake_case', type: 'PREVIOUS_LEGAL_NAME' },
        ],
        jurisdiction: 'US-DE',
        status: 'ISSUED',
        entityStatus: 'ACTIVE',
        successors: [{ lei: PARENT_LEI, name: 'AT&T Successor' }],
        entityStatusLoaded: true,
        legalAddress: '1 Market St #200, Wilmington, DE',
        headquartersAddress: 'C# 12 Tower, Nassau',
        registrationAuthorityId: 'RA000602',
        registrationAuthorityEntityId: 'HRB_14604',
        lastUpdate: '2026-02-01T00:00:00.000Z',
        sanctionsHits: [
          {
            source: 'ofac_sdn',
            sourceLabel: 'OFAC Specially Designated Nationals (SDN) List',
            sourceEntryId: 'FX-2002',
            sources: ['ofac_sdn', 'ofac_consolidated'],
            primaryName: 'AT&T C# 12 Holdings',
            matchedName: 'ACME LTD',
            matchType: 'exact',
            matchedOn: [
              { input: 'other_name', value: 'ACME LTD', nameType: 'TRADING_OR_OPERATING_NAME' },
            ],
          },
        ],
        screeningStatus: 'screened',
        caveat: SCREENING_CAVEAT,
      }),
    ).toEqual(
      expect.arrayContaining([
        '# AT&T C# 12 Holdings',
        '**Other names:** ACME LTD; snake_case',
        '**Names by type:** ACME LTD (TRADING_OR_OPERATING_NAME); snake_case (PREVIOUS_LEGAL_NAME)',
        '**Jurisdiction:** US-DE',
        '**Registration status:** ISSUED',
        '**Entity status:** ACTIVE',
        `**Successor entities:** \`${PARENT_LEI}\` (AT&T Successor) — pass a successor LEI to sanctions_get_entity or sanctions_trace_ownership; successors are not screened here.`,
        '**Legal address:** 1 Market St #200, Wilmington, DE',
        '**HQ address:** C# 12 Tower, Nassau',
        '**Registration authority:** RA000602 (entity HRB_14604)',
        '**Last update:** 2026-02-01T00:00:00.000Z',
        '- **AT&T C# 12 Holdings** — OFAC Specially Designated Nationals (SDN) List (`ofac_sdn`, entry FX-2002; also listed on OFAC Consolidated Sanctions List (`ofac_consolidated`)), exact, matched "ACME LTD" — matched on: other_name "ACME LTD" (TRADING_OR_OPERATING_NAME)',
      ]),
    );

    expect(
      lines(traceOwnershipTool, {
        rootLei: LEI,
        nodes: [
          {
            lei: LEI,
            legalName: 'AT&T C# 12 Holdings',
            jurisdiction: 'US-DE',
            status: 'ISSUED',
            depth: 0,
            role: 'root',
            parentStatus: {
              direct: { status: 'relationship' },
              ultimate: {
                status: 'exception',
                exceptionReasons: ['NATURAL_PERSONS', 'NON_CONSOLIDATING'],
              },
            },
            sanctionsHits: [
              {
                source: 'uk',
                sourceLabel: 'UK Sanctions List',
                sourceEntryId: 'FX-2002',
                sources: ['uk'],
                primaryName: 'AT&T C# 12 Holdings',
                matchedName: 'ACME LTD',
                matchType: 'exact',
                matchedOn: [
                  { input: 'other_name', value: 'ACME LTD', nameType: 'TRADING_OR_OPERATING_NAME' },
                ],
              },
            ],
            sanctionsScreen: {
              totalAvailable: 1,
              totalAvailableBasis: 'exact',
              hasMore: false,
              screenedInputs: [],
            },
          },
          {
            lei: PARENT_LEI,
            legalName: 'snake_case Parent PLC',
            jurisdiction: 'GB',
            depth: 1,
            role: 'parent',
          },
        ],
        edges: [
          {
            childLei: LEI,
            parentLei: PARENT_LEI,
            relationshipType: 'IS_DIRECTLY_CONSOLIDATED_BY',
            relationshipStatus: 'ACTIVE',
          },
        ],
        boundaries: [],
        totalAvailable: 3,
        totalAvailableBasis: 'exact',
        hasMore: false,
        truncationReasons: [],
        missingEntityCount: 0,
        complete: true,
        truncated: false,
        reportingExceptionsLoaded: true,
        missingEntityLeis: [],
        screeningStatus: 'screened',
        screenedNodeCount: 1,
        flaggedNodeCount: 1,
        caveat: SCREENING_CAVEAT,
      }),
    ).toEqual(
      expect.arrayContaining([
        `- **AT&T C# 12 Holdings** \`${LEI}\` — root, depth 0 (US-DE, ISSUED)`,
        '  - ultimate parent: reporting exception (NATURAL_PERSONS, NON_CONSOLIDATING)',
        '  - ⚠ AT&T C# 12 Holdings — UK Sanctions List (`uk`, entry FX-2002): matched "ACME LTD" — exact — matched on: other_name "ACME LTD" (TRADING_OR_OPERATING_NAME)',
        `- **snake_case Parent PLC** \`${PARENT_LEI}\` — parent, depth 1 (GB)`,
        `- \`${LEI}\` IS_DIRECTLY_CONSOLIDATED_BY \`${PARENT_LEI}\` (ACTIVE)`,
      ]),
    );
  });
});

describe('sanctions list text in content[] (issue #96)', () => {
  /**
   * Every Markdown construct, plus values the authored text after them could
   * complete (an entity name closed by a `;`, a trailing backslash before
   * authored punctuation).
   */
  const UPSTREAM_VALUES = [...CONSTRUCT_VALUES, 'Sierra &amp', 'Tango &#35', 'Yankee \\'];

  /** Values with no Markdown-active character, which render byte-identically to the unescaped template. */
  const PLAIN_VALUES = [
    'ACME LTD',
    'snake_case',
    'AT&T',
    'C# 12',
    'a # b',
    '<=50',
    'C:\\Users\\x',
    'ofac_sdn',
    'TRADING_OR_OPERATING_NAME',
    'Ivan Wolkow',
  ];

  const screenName = (fill: Fill) => ({
    hits: [
      {
        source: 'ofac_sdn',
        sourceLabel: 'OFAC Specially Designated Nationals (SDN) List',
        sourceEntryId: fill(),
        sources: ['ofac_sdn', 'ofac_consolidated'],
        referenceNumber: fill(),
        unReferenceNumber: fill(),
        entityType: 'person',
        primaryName: fill('heading'),
        matchedName: fill(),
        matchedNameType: 'aka',
        matchType: 'approximate',
        score: 0.912,
        queryTokenCoverage: { covered: 2, total: 3, phonetic: 1 },
        program: fill(),
        designationDate: fill(),
        birthDates: [{ date: fill(), circa: true }, { date: fill() }],
        nationalities: [fill(), fill(), fill()],
        addressCountries: [fill(), fill()],
      },
      {
        source: 'un',
        sourceLabel: 'UN Security Council Consolidated List',
        sourceEntryId: fill(),
        sources: ['un'],
        entityType: 'organization',
        primaryName: fill('heading'),
        matchedName: fill(),
        matchedNameType: 'primary',
        matchType: 'exact',
      },
    ],
    caveat: SCREENING_CAVEAT,
  });

  const screenIdentifier = (fill: Fill) => ({
    hits: [
      {
        source: 'ofac_sdn',
        sourceLabel: 'OFAC Specially Designated Nationals (SDN) List',
        sourceEntryId: fill(),
        sources: ['ofac_sdn', 'ofac_consolidated'],
        primaryName: fill('heading'),
        entityType: 'vessel',
        program: fill(),
        matchedIdentifiers: [
          { type: fill(), value: fill() },
          { type: fill(), value: fill(), country: fill() },
        ],
      },
      {
        source: 'eu',
        sourceLabel: 'EU Consolidated Financial Sanctions List',
        sourceEntryId: fill(),
        sources: ['eu'],
        primaryName: fill('heading'),
        entityType: 'organization',
        matchedIdentifiers: [{ type: fill(), value: fill() }],
      },
    ],
    caveat: SCREENING_CAVEAT,
  });

  const designation = (fill: Fill) => ({
    source: 'uk',
    sourceLabel: 'UK Sanctions List (FCDO)',
    sourceEntryId: fill(),
    referenceNumber: fill(),
    unReferenceNumber: fill(),
    entityType: 'person',
    primaryName: fill('heading'),
    program: fill(),
    legalBasis: fill(),
    designationDate: fill(),
    aliases: [
      { name: fill(), nameType: 'aka' },
      { name: fill(), nameType: 'fka' },
      { name: fill(), nameType: 'low-quality-aka' },
    ],
    identifiers: [
      { type: fill(), value: fill(), country: fill() },
      { type: fill(), value: fill() },
    ],
    addresses: [{ full: fill(), country: fill() }, { full: fill() }],
    datesOfBirth: [
      { date: fill(), place: fill() },
      { date: fill(), circa: true, place: fill() },
      { date: fill() },
      { place: fill() },
    ],
    nationalities: [fill(), fill(), fill()],
    features: [
      { type: fill(), value: fill() },
      { type: fill(), value: fill(), circa: true },
    ],
    remarks: fill(),
    caveat: SCREENING_CAVEAT,
  });

  const TOOLS = [
    ['sanctions_screen_name', screenNameTool, screenName],
    ['sanctions_screen_identifier', screenIdentifierTool, screenIdentifier],
    ['sanctions_get_designation', getDesignationTool, designation],
  ] as const;

  it('sanctions_list_sources: each configured URL renders as a link to itself', () => {
    const url = 'https://feeds.example.invalid/a_b*c~d/(list)?q=<1>&r=[2]';
    const text = render(listSourcesTool, {
      sanctionsReady: true,
      sanctionsAsOf: '2026-11-18T04:00:00.000Z',
      leiReady: false,
      reportingExceptionsLoaded: false,
      alternateNamesIndexed: false,
      entityStatusLoaded: false,
      sources: [
        {
          code: 'ofac_sdn',
          label: 'OFAC Specially Designated Nationals (SDN) List',
          recordCount: 17_004,
          lastHarvestedAt: '2026-11-19T04:01:02.345Z',
          url,
          license: 'US Government public domain',
        },
      ],
    });
    const source = readBlocks(text).find((block) => block.text.includes('\nSource: '));

    expect(source?.text.split('\n').at(-1)).toBe(`Source: ${url}`);
    expect(source?.links).toEqual([url]);
    expect(source?.marks.at(-1)).toBe('link');
  });

  it.each(TOOLS)(
    '%s: every upstream value reads back from content[] as published',
    (_name, tool, build) => {
      expectReadBack(tool, build, UPSTREAM_VALUES);
    },
  );

  it.each(TOOLS)(
    '%s: a value with no Markdown-active character renders byte-identically',
    (_name, tool, build) => {
      expectByteIdentical(tool, build, PLAIN_VALUES);
    },
  );

  it('sanctions_get_designation: a "7. " alias stays one list item and a "# " remark line stays in the remark', () => {
    // eu 128875 publishes the alias; un 110334 the remark, verbatim.
    const remarks =
      'SSSI is owned or controlled by, or acts on behalf of, DIO. [Old Reference\n# E.29.I.19]';
    const blocks = readBlocks(
      render(getDesignationTool, {
        ...designation(() => 'Kaniyat Militia'),
        aliases: [{ name: '7. Brigade', nameType: 'aka' }],
        remarks,
      }),
    );

    expect(blocks.find((block) => block.text.startsWith('7. Brigade'))).toMatchObject({
      kind: 'paragraph',
      containers: ['bullet_list'],
      text: '7. Brigade (aka)',
    });
    expect(blocks.find((block) => block.text.startsWith('Remarks:'))).toMatchObject({
      kind: 'paragraph',
      containers: [],
      text: `Remarks: ${remarks}`,
    });
    // The record's name and the section headings, nothing from the remark.
    expect(blocks.filter((block) => block.kind === 'heading').map((block) => block.text)).toEqual([
      'Kaniyat Militia',
      'Aliases',
      'Identifiers',
      'Addresses',
      'Dates of birth',
      'Features',
    ]);
  });

  it('crossReferencePointer escapes its whole clause as one string', () => {
    const pointer = crossReferencePointer('7. Brigade', '5493001KJTIIGC8Y1R12', [
      { input: 'other_name', value: '*Echo* Ltd', nameType: 'TRADING_OR_OPERATING_NAME' },
      { input: 'registration_number', value: 'Sierra &amp' },
    ]);
    const blocks = readBlocks(`Coverage — ${pointer}`);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'paragraph', containers: [], marks: [] });
    expect(blocks[0]?.text).toBe(
      'Coverage — re-screen "7. Brigade", "*Echo* Ltd" with sanctions_screen_name and look up 5493001KJTIIGC8Y1R12, Sierra &amp with sanctions_screen_identifier to see the rest; the name re-screen can add approximate matches, which this count leaves out.',
    );
  });

  it.each([
    ['one long line ending in a break', (length: number) => `${'§1 x'.repeat(length / 4)}\ny`],
    ['line breaks throughout', (length: number) => '  \r\n'.repeat(length / 4)],
  ])(
    'sanctions_get_designation: a remark of growing length renders in time that stays linear — %s',
    async (_shape, build) => {
      const record = getDesignationTool.output.parse(designation(() => 'Kaniyat Militia'));
      const format = (remarks: string) => getDesignationTool.format?.({ ...record, remarks });
      await expectLinearTime(format, build, 320_000, 200);
    },
    0,
  );
});

describe('the content[] read-back harness (_markdown-readback.ts)', () => {
  /** Where a format prints an upstream string: ending a heading, as a whole list item, and in a table cell. */
  const SLOTS = {
    heading: (text: string) => `# Record ${text}`,
    item: (text: string) => `- ${text}`,
    cell: (text: string) => `| Field | Value |\n| --- | --- |\n| Remarks | ${text} |`,
  };
  type Slot = keyof typeof SLOTS;
  const SLOT_NAMES = Object.keys(SLOTS) as Slot[];

  /** A format-only tool printing each slot through `escapeMarkdownInline`, except `raw`, printed as it came, and `omit`, left out. */
  const fakeTool = ({ raw, omit }: { raw?: Slot; omit?: Slot } = {}) =>
    tool('harness_self_test', {
      description: 'Prints one upstream string in a heading, a list item, and a table cell.',
      input: z.object({}),
      output: z.object({ heading: z.string(), item: z.string(), cell: z.string() }),
      handler() {
        throw new Error('The self-test renders format() alone.');
      },
      format: (result) => [
        {
          type: 'text',
          text: SLOT_NAMES.filter((slot) => slot !== omit)
            .map((slot) =>
              SLOTS[slot](slot === raw ? result[slot] : escapeMarkdownInline(result[slot])),
            )
            .join('\n\n'),
        },
      ],
    });

  // A table row ends at a line break, as a heading does, so the cell holds one line too.
  const build = (fill: Fill) => ({ heading: fill('heading'), item: fill(), cell: fill('heading') });

  /** Whether `expectReadBack` fails `definition` with `value` in every slot; any other error is rethrown. */
  const fails = (definition: AnyToolDefinition, value: string) => {
    try {
      expectReadBack(definition, build, [value]);
      return false;
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AssertionError')) throw error;
      return true;
    }
  };

  it('passes a format that escapes every slot, for every construct value', () => {
    expectReadBack(fakeTool(), build, CONSTRUCT_VALUES);
  });

  it('fails a format that prints one slot raw, for every construct value', () => {
    /**
     * A construct is syntax only in its own place (`Oscar #` ending a heading,
     * `Mike | November` in a table cell, `***` alone on a line), so each value
     * must fail in at least one slot. `<b>Hotel</b>` reads back as the same text
     * raw or escaped: only the structure comparison tells them apart.
     */
    const uncaught = CONSTRUCT_VALUES.filter(
      (value) => !SLOT_NAMES.some((raw) => fails(fakeTool({ raw }), value)),
    );
    expect(uncaught).toEqual([]);
  });

  it('fails a format that never prints a filled slot', () => {
    for (const omit of SLOT_NAMES) {
      expect(() => expectReadBack(fakeTool({ omit }), build, CONSTRUCT_VALUES), omit).toThrow(
        /never prints/,
      );
    }
  });
});
