/**
 * @fileoverview `format()` coverage for every tool that renders one — the
 * markdown twin of `structuredContent`. Each tool is exercised twice: a rich
 * payload where every optional field and nested collection is populated, and a
 * sparse payload where each is omitted, so both arms of every conditional in
 * the renderer are pinned.
 *
 * Payloads are round-tripped through the tool's own `output` schema before
 * rendering, so a schema change that invalidates these shapes fails here rather
 * than silently drifting from what the handler can actually produce.
 * @module tests/tools/format-parity.test
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { SCREENING_CAVEAT } from '@/mcp-server/tools/definitions/_shared.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';

/** Parse a payload against the tool's declared output schema, then render it. */
function render(tool: AnyToolDefinition, payload: unknown): string {
  const parsed = tool.output.parse(payload);
  const blocks = tool.format?.(parsed as never) ?? [];
  return blocks.map((block) => ('text' in block ? (block.text ?? '') : '')).join('\n');
}

describe('sanctions_screen_name format()', () => {
  it('renders every hit field, including the optional score, program, and date', () => {
    const text = render(screenNameTool, {
      hits: [
        {
          source: 'ofac_sdn',
          sourceLabel: 'OFAC Specially Designated Nationals',
          sourceEntryId: 'FX-1001',
          entityType: 'person',
          primaryName: 'Ivan Testovich Volkov',
          matchedName: 'Ivan Wolkow',
          matchedNameType: 'aka',
          matchType: 'approximate',
          score: 0.912_345,
          program: 'UKRAINE-EO13662',
          designationDate: '2019-03-15',
        },
      ],
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toContain('1 potential match(es)');
    expect(text).toContain('Ivan Testovich Volkov — approximate');
    expect(text).toContain('score 0.912'); // raw Jaro-Winkler, three decimals
    expect(text).toContain('OFAC Specially Designated Nationals');
    expect(text).toContain('Entry ID:** FX-1001');
    expect(text).toContain('Matched on:** "Ivan Wolkow" (aka)');
    expect(text).toContain('Program:** UKRAINE-EO13662');
    expect(text).toContain('Designated:** 2019-03-15');
    expect(text).toMatch(/not a compliance determination/i);
  });

  it('omits score, program, and date for a hit that carries none', () => {
    const text = render(screenNameTool, {
      hits: [
        {
          source: 'un',
          sourceLabel: 'UN Security Council Consolidated List',
          sourceEntryId: 'UN-7',
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
    expect(text).not.toContain('Program:');
    expect(text).not.toContain('Designated:');
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
      datesOfBirth: [{ date: '1971-04-02', place: 'Leningrad' }, { place: 'Unknown city' }],
      nationalities: ['RU', 'CY'],
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
    expect(text).toContain('- Unknown date at Unknown city');
    expect(text).toContain('Nationalities:** RU, CY');
    expect(text).toContain('Remarks:** Linked to a designated entity.');
  });

  it('drops every optional section when the source published none', () => {
    const text = render(getDesignationTool, base);

    expect(text).toContain('# Ivan Testovich Volkov');
    expect(text).toContain('Type:** person');
    for (const heading of ['## Aliases', '## Identifiers', '## Addresses', '## Dates of birth']) {
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
          matchType: 'approximate',
          score: 0.887_777,
          jurisdiction: 'US-DE',
          status: 'ISSUED',
        },
      ],
    });

    expect(text).toContain('1 LEI candidate(s)');
    expect(text).toContain('### Fictional Trading Company LLC — approximate');
    expect(text).toContain('score 0.888');
    expect(text).toContain('`5493001KJTIIGC8Y1R12`');
    expect(text).toContain('Matched on:** "Fictional Trading Co"');
    expect(text).toContain('Jurisdiction: US-DE | Status: ISSUED');
  });

  it('omits the metadata line entirely when neither jurisdiction nor status is known', () => {
    const text = render(resolveEntityTool, {
      matches: [
        {
          lei: '5493001KJTIIGC8Y1R12',
          legalName: 'Bare Record Ltd',
          matchedName: 'Bare Record Ltd',
          matchType: 'exact',
        },
      ],
    });

    expect(text).toContain('### Bare Record Ltd — exact');
    expect(text).not.toContain('score');
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
    sanctionsHits: [],
    caveat: SCREENING_CAVEAT,
  };

  it('renders every GLEIF field and each sanctions cross-reference hit', () => {
    const text = render(getEntityTool, {
      ...base,
      otherNames: ['Fictional Trading Co', 'FTC'],
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
          primaryName: 'Fictional Trading Company LLC',
          matchedName: 'Fictional Trading Company LLC',
          matchType: 'exact',
        },
        {
          source: 'eu',
          sourceLabel: 'EU Financial Sanctions Files',
          sourceEntryId: 'EU-31',
          primaryName: 'Fictional Trading Co',
          matchedName: 'Fictional Trading Co',
          matchType: 'approximate',
          score: 0.934_21,
        },
      ],
    });

    expect(text).toContain('# Fictional Trading Company LLC');
    expect(text).toContain('Other names:** Fictional Trading Co; FTC');
    expect(text).toContain('Jurisdiction:** US-DE');
    expect(text).toContain('Registration status:** ISSUED');
    expect(text).toContain('Legal address:** 1 Market St, Wilmington, DE');
    expect(text).toContain('HQ address:** 500 Harbor Rd, Nassau');
    expect(text).toContain('Registration authority:** RA000602 (entity 4812291)');
    expect(text).toContain('Last update:** 2026-02-01T00:00:00.000Z');
    expect(text).toContain('## Sanctions screening cross-reference');
    expect(text).toContain('entry FX-2002');
    expect(text).toContain('score 0.934');
    expect(text).not.toContain('NOT a clearance');
  });

  it('renders a registration authority with no entity ID and no hits', () => {
    const text = render(getEntityTool, { ...base, registrationAuthorityId: 'RA000602' });

    expect(text).toContain('Registration authority:** RA000602');
    expect(text).not.toContain('(entity');
    expect(text).not.toContain('Other names:');
    expect(text).not.toContain('Jurisdiction:');
    expect(text).toContain('No potential watchlist matches on the legal name (NOT a clearance).');
  });
});

describe('sanctions_trace_ownership format()', () => {
  const root = {
    lei: '5493001KJTIIGC8Y1R12',
    legalName: 'Fictional Trading Company LLC',
    depth: 0,
    role: 'root',
  } as const;

  it('renders nodes, per-node hits, edges, and the screened/flagged counts', () => {
    const text = render(traceOwnershipTool, {
      rootLei: root.lei,
      nodes: [
        {
          ...root,
          jurisdiction: 'US-DE',
          status: 'ISSUED',
          sanctionsHits: [
            {
              source: 'uk',
              sourceLabel: 'UK Sanctions List',
              sourceEntryId: 'UK-14',
              primaryName: 'Fictional Trading Company LLC',
              matchedName: 'Fictional Trading Company LLC',
              matchType: 'approximate',
              score: 0.951,
            },
          ],
        },
        {
          lei: '5493009BRIT0PARENT12',
          legalName: 'Parent Holdings PLC',
          depth: 1,
          role: 'parent',
          sanctionsHits: [],
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
    expect(text).toContain('**Screened 2 node(s); 1 had potential matches.**');
    expect(text).toContain('depth 0 (US-DE, ISSUED)');
    expect(text).toContain('⚠ Fictional Trading Company LLC');
    expect(text).toContain('score 0.951');
    // A screened node with zero hits states the absence rather than staying silent.
    expect(text).toContain('No potential matches (not a clearance).');
    expect(text).toContain('## Ownership edges');
    expect(text).toContain('IS_DIRECTLY_CONSOLIDATED_BY `5493009BRIT0PARENT12` (ACTIVE)');
    expect(text).toContain('IS_ULTIMATELY_CONSOLIDATED_BY `5493009ULTIMATE00099`');
    expect(text).not.toContain('IS_ULTIMATELY_CONSOLIDATED_BY `5493009ULTIMATE00099` (');
  });

  it('drops the screening line, the edges section, and per-node hit lines when unscreened and isolated', () => {
    const text = render(traceOwnershipTool, {
      rootLei: root.lei,
      nodes: [root],
      edges: [],
      screenedNodeCount: 0,
      flaggedNodeCount: 0,
      caveat: SCREENING_CAVEAT,
    });

    expect(text).toContain('**1 node(s), 0 edge(s).**');
    expect(text).not.toContain('Screened');
    expect(text).not.toContain('## Ownership edges');
    // A node with no `sanctionsHits` key at all was never screened, so it gets
    // no per-node line either way — unlike a screened node with zero hits.
    expect(text).not.toContain('No potential matches (not a clearance).');
    expect(text).toContain('depth 0');
    expect(text).not.toContain('depth 0 (');
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
      sources: [source],
    });

    expect(text).toContain('**Sanctions mirror:** ready (as of 2026-06-01T12:00:00.000Z)');
    expect(text).toContain('**GLEIF mirror:** ready (as of 2026-06-01T13:00:00.000Z)');
    expect(text).toContain('### OFAC Specially Designated Nationals (`ofac_sdn`)');
    expect(text).toContain('**Records:** 17004 | **License:** US Government work — public domain');
    expect(text).toContain(source.url);
  });

  it('reports an unsynced mirror as NOT ready with no timestamp', () => {
    const text = render(listSourcesTool, {
      sanctionsReady: false,
      leiReady: false,
      sources: [{ ...source, recordCount: 0 }],
    });

    expect(text).toContain('**Sanctions mirror:** NOT ready');
    expect(text).toContain('**GLEIF mirror:** NOT ready');
    expect(text).not.toContain('as of');
    expect(text).toContain('**Records:** 0');
  });
});
