/**
 * @fileoverview The GLEIF → sanctions cross-reference of `sanctions_get_entity`
 * and, per node, `sanctions_trace_ownership` (`screenNodes: true`) — issues #37
 * and #56. Each screens the legal name and every other and transliterated name
 * strict, with no fuzzy fallback, and looks up the LEI and the country-matched
 * registration number against non-document identifiers; hits merge to one per
 * designation, each naming every input that produced it, and the cap applies
 * after the merge. Driven through `runToolContract`, so the output schema
 * validates every new field, and through `format()`.
 * @module tests/tools/entity-cross-reference.test
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import type {
  IdentifierRecord,
  NormalizedDesignation,
  NormalizedLeiEntity,
  NormalizedLeiRelationship,
} from '@/services/screening/types.js';
import { type SeededService, seededGlobalService } from '../services/_helpers.js';

/** A synthetic 20-character LEI: the tag, zero-padded to 18 characters, then two digits. */
const lei = (tag: string): string => `${tag.padEnd(18, '0')}00`;

const ZORVAN = lei('ZORVANPAO');
const ZORVAN_REG = '1027700099999';

/** An oil company whose legal name is Cyrillic: Latin lists publish it under its other names. */
const zorvan: NormalizedLeiEntity = {
  lei: ZORVAN,
  legalName: 'Публичное акционерное общество "Нефтяная компания "Зорван"',
  otherNames: ['Zorvan', 'Zorvan Oil Company', 'ПАО "НК "Зорван"'],
  alternateNames: [
    { name: 'Zorvan', type: 'TRADING_OR_OPERATING_NAME' },
    { name: 'Zorvan Oil Company', type: 'ALTERNATIVE_LANGUAGE_LEGAL_NAME' },
    { name: 'ПАО "НК "Зорван"', type: 'ALTERNATIVE_LANGUAGE_LEGAL_NAME' },
  ],
  jurisdiction: 'RU',
  status: 'ISSUED',
  registrationAuthorityId: 'RA000499',
  registrationAuthorityEntityId: ZORVAN_REG,
};

const designation = (
  id: string,
  primaryName: string,
  extra: { aliases?: string[]; identifiers?: IdentifierRecord[] } = {},
): NormalizedDesignation => {
  const [source, sourceEntryId] = id.split(':') as [NormalizedDesignation['source'], string];
  return {
    id,
    source,
    sourceEntryId,
    entityType: 'organization',
    primaryName,
    payload: {
      aliases: (extra.aliases ?? []).map((name) => ({ name, nameType: 'aka' as const })),
      identifiers: extra.identifiers ?? [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  };
};

const listed: NormalizedDesignation[] = [
  // Two other names and the registration number all reach it.
  designation('ofac_sdn:XR-1', 'Zorvan Oil Company', {
    aliases: ['Zorvan'],
    identifiers: [{ type: 'Registration ID', value: ZORVAN_REG, country: 'Russia' }],
  }),
  // Every token of two other names present, never the whole name: strong.
  designation('uk:XR-2', 'ZORVAN OIL COMPANY PJSC'),
  // Reached by the Cyrillic other name only.
  designation('eu:XR-3', 'ПАО "НК "Зорван"'),
  // No name in common: reached by the published LEI alone.
  designation('un:XR-4', 'Zeta Fuel Holdings', {
    identifiers: [{ type: 'Legal Entity Number', value: ZORVAN }],
  }),
  // The registration number published for another country, for none, and as a passport.
  designation('ofac_sdn:XR-5', 'Unrelated Aviation Ltd', {
    identifiers: [{ type: 'Registration Number', value: ZORVAN_REG, country: 'Kazakhstan' }],
  }),
  designation('ofac_sdn:XR-6', 'Unrelated Shipping Ltd', {
    identifiers: [{ type: 'Registration Number', value: ZORVAN_REG }],
  }),
  designation('uk:XR-7', 'Unrelated Person', {
    identifiers: [{ type: 'Passport', value: ZORVAN_REG, country: 'Russia' }],
  }),
];

type Structured = {
  sanctionsHits: {
    matchedIdentifiers?: IdentifierRecord[];
    matchedName?: string;
    matchedOn: { input: string; nameType?: string; value: string }[];
    matchType?: string;
    score?: number;
    source: string;
    sourceEntryId: string;
    sources: string[];
  }[];
  sanctionsScreen?: {
    hasMore: boolean;
    screenedInputs: { input: string; nameType?: string; value: string }[];
    totalAvailable: number;
    totalAvailableBasis: string;
  };
  screeningStatus: string;
};

const ctxFor = <const E extends readonly ErrorContract[] | undefined>(errors: E) =>
  createMockContext({ errors });

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>): string =>
  result.content.map((block) => ('text' in block ? block.text : '')).join('\n');

const getEntity = async (id: string) => {
  const result = await runToolContract(getEntityTool, { lei: id });
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  return { structured: result.structuredContent as Structured, text: textOf(result) };
};

const otherName = (value: string, nameType: string) => ({ input: 'other_name', value, nameType });

describe('sanctions_get_entity cross-reference (issues #37, #56)', () => {
  let seeded: SeededService;

  beforeEach(async () => {
    seeded = await seededGlobalService();
    await seeded.service.ingestDesignations(listed);
    await seeded.service.ingestLeiEntities([zorvan]);
  });

  afterEach(async () => {
    await seeded.cleanup();
  });

  it('screens every other name and the identifiers, one hit per designation, exact first', async () => {
    const { structured } = await getEntity(ZORVAN);

    expect(structured.sanctionsHits.map((hit) => `${hit.source}:${hit.sourceEntryId}`)).toEqual([
      'ofac_sdn:XR-1',
      'eu:XR-3',
      'un:XR-4',
      'uk:XR-2',
    ]);
    const [sdn, eu, un, uk] = structured.sanctionsHits;
    expect(sdn).toMatchObject({
      matchedName: 'Zorvan',
      matchType: 'exact',
      matchedIdentifiers: [{ type: 'Registration ID', value: ZORVAN_REG, country: 'Russia' }],
      matchedOn: [
        otherName('Zorvan', 'TRADING_OR_OPERATING_NAME'),
        otherName('Zorvan Oil Company', 'ALTERNATIVE_LANGUAGE_LEGAL_NAME'),
        { input: 'registration_number', value: ZORVAN_REG },
      ],
    });
    expect(eu).toMatchObject({
      matchType: 'exact',
      matchedOn: [otherName('ПАО "НК "Зорван"', 'ALTERNATIVE_LANGUAGE_LEGAL_NAME')],
    });
    expect(eu?.matchedIdentifiers).toBeUndefined();
    expect(uk).toMatchObject({ matchType: 'strong', matchedName: 'ZORVAN OIL COMPANY PJSC' });
    expect(uk?.matchedOn.map((input) => input.value)).toEqual(['Zorvan', 'Zorvan Oil Company']);

    // An identifier-only hit carries what matched and no name-match fields.
    expect(un).toEqual({
      source: 'un',
      sourceLabel: expect.any(String),
      sourceEntryId: 'XR-4',
      primaryName: 'Zeta Fuel Holdings',
      matchedIdentifiers: [{ type: 'Legal Entity Number', value: ZORVAN }],
      matchedOn: [{ input: 'lei', value: ZORVAN }],
      sources: ['un'],
    });

    expect(structured.sanctionsScreen).toEqual({
      totalAvailable: 4,
      totalAvailableBasis: 'exact',
      hasMore: false,
      screenedInputs: [
        otherName('Zorvan', 'TRADING_OR_OPERATING_NAME'),
        otherName('Zorvan Oil Company', 'ALTERNATIVE_LANGUAGE_LEGAL_NAME'),
        otherName('ПАО "НК "Зорван"', 'ALTERNATIVE_LANGUAGE_LEGAL_NAME'),
        { input: 'registration_number', value: ZORVAN_REG },
      ],
    });
  });

  it('returns the OFAC party both OFAC lists publish as one hit naming both lists, counted once (issue #61)', async () => {
    await seeded.service.ingestDesignations([
      designation('ofac_consolidated:XR-1', 'Zorvan Oil Company', {
        aliases: ['Zorvan'],
        identifiers: [{ type: 'Registration ID', value: ZORVAN_REG, country: 'Russia' }],
      }),
    ]);
    const { structured, text } = await getEntity(ZORVAN);

    expect(
      structured.sanctionsHits.map((hit) => [`${hit.source}:${hit.sourceEntryId}`, hit.sources]),
    ).toEqual([
      ['ofac_sdn:XR-1', ['ofac_sdn', 'ofac_consolidated']],
      ['eu:XR-3', ['eu']],
      ['un:XR-4', ['un']],
      ['uk:XR-2', ['uk']],
    ]);
    expect(structured.sanctionsScreen?.totalAvailable).toBe(4);
    expect(text).toContain(
      '- **Zorvan Oil Company** — OFAC Specially Designated Nationals (SDN) List (`ofac_sdn`, entry XR-1; also listed on OFAC Consolidated Sanctions List (`ofac_consolidated`)), exact, matched "Zorvan"',
    );
  });

  it('never matches a registration number published for another country, for none, or as a document', async () => {
    const { structured } = await getEntity(ZORVAN);
    const ids = structured.sanctionsHits.map((hit) => hit.sourceEntryId);
    expect(ids).not.toContain('XR-5');
    expect(ids).not.toContain('XR-6');
    expect(ids).not.toContain('XR-7');
    // The gated identifiers of a hit that passed stay out of matchedIdentifiers too.
    for (const hit of structured.sanctionsHits) {
      for (const identifier of hit.matchedIdentifiers ?? []) {
        expect(identifier.country === undefined || identifier.country === 'Russia').toBe(true);
      }
    }
  });

  it('renders every producer, identifier, and screened input in format()', async () => {
    const { text } = await getEntity(ZORVAN);

    expect(text).toContain(
      '- **Zorvan Oil Company** — OFAC Specially Designated Nationals (SDN) List (`ofac_sdn`, entry XR-1), exact, matched "Zorvan"; identifier Registration ID: 1027700099999 (Russia) — matched on: other_name "Zorvan" (TRADING_OR_OPERATING_NAME); other_name "Zorvan Oil Company" (ALTERNATIVE_LANGUAGE_LEGAL_NAME); registration_number 1027700099999',
    );
    const unLine = text.split('\n').find((line) => line.includes('entry XR-4'));
    expect(unLine).toContain(
      `identifier Legal Entity Number: ${ZORVAN} — matched on: lei ${ZORVAN}`,
    );
    expect(unLine).not.toContain('matched "');
    expect(text).toContain(
      `Screened: legal_name "${zorvan.legalName}"; lei ${ZORVAN}; other_name "Zorvan" (TRADING_OR_OPERATING_NAME); other_name "Zorvan Oil Company" (ALTERNATIVE_LANGUAGE_LEGAL_NAME); other_name "ПАО "НК "Зорван"" (ALTERNATIVE_LANGUAGE_LEGAL_NAME); registration_number ${ZORVAN_REG}`,
    );
  });

  it('runs no fuzzy pass: an other name only a fuzzy screen would reach adds nothing', async () => {
    const typo = lei('ZORVANTYPO');
    await seeded.service.ingestLeiEntities([
      {
        lei: typo,
        legalName: 'Qqzx Holdings Unlisted',
        otherNames: ['Zorvann Oil Compani'],
        alternateNames: [{ name: 'Zorvann Oil Compani', type: 'TRADING_OR_OPERATING_NAME' }],
        status: 'ISSUED',
      },
    ]);
    const { structured, text } = await getEntity(typo);
    expect(structured.sanctionsHits).toEqual([]);
    expect(structured.sanctionsScreen).toMatchObject({ totalAvailable: 0, hasMore: false });
    expect(text).toContain(
      'No potential watchlist matches on any screened name or identifier (NOT a clearance).',
    );
  });

  describe('an entity with no other names and no registration number', () => {
    const plain = lei('ZORVANPLAIN');

    beforeEach(async () => {
      await seeded.service.ingestLeiEntities([
        { lei: plain, legalName: 'Zorvan Oil Company', otherNames: [], status: 'ISSUED' },
      ]);
    });

    it('keeps the legal-name screen hits and counts (characterization)', async () => {
      const { structured } = await getEntity(plain);
      expect(structured.sanctionsHits.map((hit) => [hit.sourceEntryId, hit.matchType])).toEqual([
        ['XR-1', 'exact'],
        ['XR-2', 'strong'],
      ]);
      expect(structured.sanctionsScreen).toMatchObject({
        totalAvailable: 2,
        totalAvailableBasis: 'exact',
        hasMore: false,
      });
    });

    it('lists nothing beyond the always-screened inputs and attributes each hit to the legal name', async () => {
      const { structured } = await getEntity(plain);
      expect(structured.sanctionsScreen?.screenedInputs).toEqual([]);
      expect(structured.sanctionsHits.map((hit) => hit.matchedOn)).toEqual([
        [{ input: 'legal_name', value: 'Zorvan Oil Company' }],
        [{ input: 'legal_name', value: 'Zorvan Oil Company' }],
      ]);
    });
  });

  it('screens a registration number only when the entity publishes a jurisdiction', async () => {
    const stateless = lei('ZORVANNOJUR');
    await seeded.service.ingestLeiEntities([
      {
        lei: stateless,
        legalName: 'Qqzx Holdings Unlisted',
        otherNames: [],
        registrationAuthorityEntityId: ZORVAN_REG,
      },
    ]);
    const { structured } = await getEntity(stateless);
    expect(structured.sanctionsHits).toEqual([]);
    expect(structured.sanctionsScreen?.screenedInputs).toEqual([]);
  });

  it('neither looks up nor lists a not-available placeholder registration number', async () => {
    // A placeholder a list stored as an identifier (one an earlier release ingested).
    await seeded.service.ingestDesignations([
      designation('uk:XR-NA', 'Placeholder Holdings Ltd', {
        identifiers: [{ type: 'Registration Number', value: 'N/A', country: 'United Kingdom' }],
      }),
    ]);
    const placeholders = ['N/A', 'n.a.', 'NA', '-'];
    await seeded.service.ingestLeiEntities(
      placeholders.map((value, index) => ({
        lei: lei(`QQPLACEHOLDER${index}`),
        legalName: 'Qqzx Holdings Unlisted',
        otherNames: [],
        jurisdiction: 'GB',
        registrationAuthorityEntityId: value,
      })),
    );
    for (const [index, value] of placeholders.entries()) {
      const id = lei(`QQPLACEHOLDER${index}`);
      const { structured, text } = await getEntity(id);
      expect(structured.sanctionsHits, value).toEqual([]);
      expect(structured.sanctionsScreen?.screenedInputs, value).toEqual([]);
      expect(text, value).toContain(`Screened: legal_name "Qqzx Holdings Unlisted"; lei ${id}\n`);
      expect(text, value).not.toContain('registration_number');
    }
  });

  it('still looks up and lists a published registration number (characterization)', async () => {
    const real = lei('QQREALNUMBER');
    await seeded.service.ingestLeiEntities([
      {
        lei: real,
        legalName: 'Qqzx Holdings Unlisted',
        otherNames: [],
        jurisdiction: 'RU',
        registrationAuthorityEntityId: ZORVAN_REG,
      },
    ]);
    const { structured } = await getEntity(real);
    expect(structured.sanctionsScreen?.screenedInputs).toEqual([
      { input: 'registration_number', value: ZORVAN_REG },
    ]);
    expect(structured.sanctionsHits.map((hit) => hit.sourceEntryId)).toEqual(['XR-1']);
  });

  it('reads untyped other names from the entity record as UNKNOWN, rendered as type not recorded', async () => {
    const untyped = lei('ZORVANUNTYPED');
    // A record a mirror stored before names were typed: bare otherNames only.
    await seeded.service.ingestLeiEntities([
      {
        lei: untyped,
        legalName: 'Qqzx Holdings Unlisted',
        otherNames: ['Zorvan'],
        status: 'ISSUED',
      },
    ]);
    const { structured, text } = await getEntity(untyped);

    expect(structured.sanctionsHits.map((hit) => hit.sourceEntryId)).toEqual(['XR-1', 'XR-2']);
    expect(structured.sanctionsHits[0]?.matchedOn).toEqual([otherName('Zorvan', 'UNKNOWN')]);
    expect(structured.sanctionsScreen?.screenedInputs).toEqual([otherName('Zorvan', 'UNKNOWN')]);
    expect(text).toContain('other_name "Zorvan" (type not recorded)');
    expect(text).toContain('**Names by type:** Zorvan (type not recorded)');
    expect(text).not.toContain('UNKNOWN');
  });

  it('caps after the merge, counts every distinct designation, and names every input to re-run', async () => {
    // Thirty designations under the trading name: past the twenty-five-hit cap.
    await seeded.service.ingestDesignations(
      Array.from({ length: 30 }, (_unused, index) =>
        designation(`un:XRCAP-${index}`, `Zorvan Trading ${index}`),
      ),
    );
    const { structured, text } = await getEntity(ZORVAN);

    expect(structured.sanctionsHits).toHaveLength(25);
    expect(structured.sanctionsScreen).toMatchObject({
      totalAvailable: 34,
      totalAvailableBasis: 'exact',
      hasMore: true,
    });
    // Exact hits — the identifier-only one included — survive the cap ahead of strong ones.
    expect(structured.sanctionsHits.slice(0, 3).map((hit) => hit.sourceEntryId)).toEqual([
      'XR-1',
      'XR-3',
      'XR-4',
    ]);
    expect(text).toContain(
      'showing 25 of 34 potential match(es) (count basis: exact); more available: true',
    );
    expect(text).toContain(
      `re-screen "${zorvan.legalName}", "Zorvan", "Zorvan Oil Company", "ПАО "НК "Зорван"" with sanctions_screen_name and look up ${ZORVAN}, ${ZORVAN_REG} with sanctions_screen_identifier to see the rest; the name re-screen can add approximate matches on lists with no strict match, which this count leaves out.`,
    );
  });

  it('describes the strict, no-fuzzy name screens and the identifier lookups', () => {
    for (const tool of [getEntityTool, traceOwnershipTool]) {
      expect(tool.description, tool.name).toMatch(/other and transliterated name/i);
      expect(tool.description, tool.name).toMatch(/never fuzzy/i);
      expect(tool.description, tool.name).toMatch(/registration number/i);
    }
  });

  it('describes a hit as never approximate and never scored: the cross-reference is strict', () => {
    const hitFields = {
      sanctions_get_entity: getEntityTool.output.shape.sanctionsHits.element.shape,
      sanctions_trace_ownership:
        traceOwnershipTool.output.shape.nodes.element.shape.sanctionsHits.unwrap().element.shape,
    };
    for (const [name, hit] of Object.entries(hitFields)) {
      expect(hit.matchType.description, name).toMatch(/never approximate/);
      expect(hit.score.description, name).toMatch(/^Never set/);
      expect(hit.score.description, name).not.toMatch(/for approximate hits only/);
    }
  });
});

describe('sanctions_trace_ownership per-node cross-reference (issues #37, #56)', () => {
  let seeded: SeededService;

  const PARENT = lei('XREFPARENT');
  const CHILD = lei('XREFCHILD');
  const MISSING = lei('XREFMISSING');

  const rel = (childLei: string, parentLei: string): NormalizedLeiRelationship => ({
    childLei,
    parentLei,
    relationshipType: 'IS_DIRECTLY_CONSOLIDATED_BY',
    relationshipStatus: 'ACTIVE',
  });

  beforeEach(async () => {
    seeded = await seededGlobalService();
    await seeded.service.ingestDesignations([
      ...listed,
      // Published under the missing node's LEI: only an LEI lookup reaches it.
      designation('ofac_sdn:XR-8', 'Missing Node Front Co', {
        identifiers: [{ type: 'Legal Entity Number', value: MISSING }],
      }),
      // Twelve under the child's trading name, past the ten-hit per-node cap.
      ...Array.from({ length: 12 }, (_unused, index) =>
        designation(`un:XRNODE-${index}`, `Qorlan Shipping ${index}`),
      ),
    ]);
    await seeded.service.ingestLeiEntities([
      zorvan,
      {
        lei: PARENT,
        legalName: 'Qqzx Parent Holdings',
        otherNames: ['Qqzx Parent Trading'],
        alternateNames: [{ name: 'Qqzx Parent Trading', type: 'TRADING_OR_OPERATING_NAME' }],
        status: 'ISSUED',
      },
      {
        lei: CHILD,
        legalName: 'Qqzx Child Holdings',
        otherNames: ['Qorlan Shipping'],
        alternateNames: [{ name: 'Qorlan Shipping', type: 'TRADING_OR_OPERATING_NAME' }],
        status: 'ISSUED',
      },
    ]);
    // PARENT → ZORVAN → CHILD → MISSING, walked down from PARENT.
    await seeded.service.ingestLeiRelationships([
      rel(ZORVAN, PARENT),
      rel(CHILD, ZORVAN),
      rel(MISSING, CHILD),
    ]);
  });

  afterEach(async () => {
    await seeded.cleanup();
  });

  const trace = async () => {
    const result = await runToolContract(traceOwnershipTool, {
      lei: PARENT,
      direction: 'children',
      depth: 3,
      screenNodes: true,
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const structured = result.structuredContent as {
      flaggedNodeCount: number;
      nodes: ({ lei: string } & Partial<Structured>)[];
    };
    const node = (id: string) => structured.nodes.find((entry) => entry.lei === id);
    return { structured, node, text: textOf(result) };
  };

  it('screens each node by the same rule, past the first level', async () => {
    const { structured, node } = await trace();

    // Depth 1: the Cyrillic-named entity, reached through its other names and identifiers.
    expect(node(ZORVAN)?.sanctionsHits?.map((hit) => hit.sourceEntryId)).toEqual([
      'XR-1',
      'XR-3',
      'XR-4',
      'XR-2',
    ]);
    expect(node(ZORVAN)?.sanctionsScreen?.screenedInputs).toHaveLength(4);

    // Depth 2: twelve hits on the trading name, capped at ten after the merge.
    expect(node(CHILD)?.sanctionsHits).toHaveLength(10);
    expect(node(CHILD)?.sanctionsScreen).toEqual({
      totalAvailable: 12,
      totalAvailableBasis: 'exact',
      hasMore: true,
      screenedInputs: [otherName('Qorlan Shipping', 'TRADING_OR_OPERATING_NAME')],
    });

    // Depth 3: a node with no Level 1 record is still looked up by its LEI.
    expect(node(MISSING)?.sanctionsHits).toEqual([
      expect.objectContaining({
        sourceEntryId: 'XR-8',
        matchedOn: [{ input: 'lei', value: MISSING }],
        matchedIdentifiers: [{ type: 'Legal Entity Number', value: MISSING }],
      }),
    ]);
    expect(node(MISSING)?.sanctionsHits?.[0]?.matchedName).toBeUndefined();

    expect(node(PARENT)?.sanctionsHits).toEqual([]);
    expect(node(PARENT)?.sanctionsScreen?.screenedInputs).toEqual([
      otherName('Qqzx Parent Trading', 'TRADING_OR_OPERATING_NAME'),
    ]);
    expect(structured.flaggedNodeCount).toBe(3);
  });

  it('renders each node hit with its producers, and every screened input on a no-match line', async () => {
    const { text } = await trace();
    expect(text).toContain(
      `  - ⚠ Zeta Fuel Holdings — UN Security Council Consolidated List (\`un\`, entry XR-4): identifier Legal Entity Number: ${ZORVAN} — matched on: lei ${ZORVAN}`,
    );
    expect(text).toContain(
      '  - ⚠ Zorvan Oil Company — OFAC Specially Designated Nationals (SDN) List (`ofac_sdn`, entry XR-1): matched "Zorvan" — exact; identifier Registration ID: 1027700099999 (Russia) — matched on: other_name "Zorvan" (TRADING_OR_OPERATING_NAME); other_name "Zorvan Oil Company" (ALTERNATIVE_LANGUAGE_LEGAL_NAME); registration_number 1027700099999',
    );
    expect(text).toContain(
      `re-screen "Qqzx Child Holdings", "Qorlan Shipping" with sanctions_screen_name and look up ${CHILD} with sanctions_screen_identifier to see the rest; the name re-screen can add approximate matches on lists with no strict match, which this count leaves out.`,
    );
    // A no-match node keeps its one line, naming what was screened beyond the legal name and LEI.
    const parentLine = text
      .split('\n')
      .find((line) => line.startsWith('- **') && line.includes(`\`${PARENT}\``));
    expect(parentLine).toMatch(
      / · screen: no potential matches \(not a clearance\), 0 of 0 \(count basis: exact\) · screened beyond the legal name and LEI: other_name "Qqzx Parent Trading" \(TRADING_OR_OPERATING_NAME\)$/,
    );
    // A node with matches lists the same beside its coverage line.
    expect(text).toContain(
      '  - Screened beyond the legal name and LEI: other_name "Qorlan Shipping" (TRADING_OR_OPERATING_NAME)',
    );
  });

  it('returns a node’s OFAC party both OFAC lists publish as one hit naming both lists (issue #61)', async () => {
    await seeded.service.ingestDesignations([
      designation('ofac_consolidated:XR-1', 'Zorvan Oil Company', { aliases: ['Zorvan'] }),
    ]);
    const { node, text } = await trace();
    expect(
      node(ZORVAN)?.sanctionsHits?.map((hit) => [
        `${hit.source}:${hit.sourceEntryId}`,
        hit.sources,
      ]),
    ).toEqual([
      ['ofac_sdn:XR-1', ['ofac_sdn', 'ofac_consolidated']],
      ['eu:XR-3', ['eu']],
      ['un:XR-4', ['un']],
      ['uk:XR-2', ['uk']],
    ]);
    expect(node(ZORVAN)?.sanctionsScreen?.totalAvailable).toBe(4);
    expect(text).toContain(
      '  - ⚠ Zorvan Oil Company — OFAC Specially Designated Nationals (SDN) List (`ofac_sdn`, entry XR-1; also listed on OFAC Consolidated Sanctions List (`ofac_consolidated`)): matched "Zorvan" — exact',
    );
  });

  it('looks a node with no Level 1 record up by its LEI alone, never screening the LEI as a name', async () => {
    await seeded.service.ingestDesignations([
      // A name carrying the LEI as a token: only a name screen of the LEI string reaches it.
      designation('eu:XR-9', `Front Co ${MISSING}`),
      // The LEI published as an alias and as an identifier: the identifier alone produces the hit.
      designation('uk:XR-10', 'Missing Node Alias Co', {
        aliases: [MISSING],
        identifiers: [{ type: 'Legal Entity Number', value: MISSING }],
      }),
    ]);
    const { node, text } = await trace();
    const missing = node(MISSING);

    expect(missing?.sanctionsHits?.map((hit) => [hit.sourceEntryId, hit.matchedOn])).toEqual([
      ['XR-8', [{ input: 'lei', value: MISSING }]],
      ['XR-10', [{ input: 'lei', value: MISSING }]],
    ]);
    for (const hit of missing?.sanctionsHits ?? []) {
      expect(hit.matchedName).toBeUndefined();
      expect(hit.matchType).toBeUndefined();
    }
    expect(missing?.sanctionsScreen).toEqual({
      totalAvailable: 2,
      totalAvailableBasis: 'exact',
      hasMore: false,
      screenedInputs: [],
    });
    expect(text).not.toContain(`legal_name "${MISSING}"`);
    expect(text).toContain(
      '  - Screened: the LEI lookup only (no Level 1 record, so no name was screened)',
    );
  });

  it('points a capped node with no Level 1 record at its LEI lookup alone', async () => {
    // Eleven more designations publishing the missing node's LEI: twelve, past the ten-hit cap.
    await seeded.service.ingestDesignations(
      Array.from({ length: 11 }, (_unused, index) =>
        designation(`un:XRLEI-${index}`, `Lei Front ${index}`, {
          identifiers: [{ type: 'Legal Entity Number', value: MISSING }],
        }),
      ),
    );
    const { node, text } = await trace();

    expect(node(MISSING)?.sanctionsHits).toHaveLength(10);
    expect(node(MISSING)?.sanctionsScreen).toEqual({
      totalAvailable: 12,
      totalAvailableBasis: 'exact',
      hasMore: true,
      screenedInputs: [],
    });
    expect(text).toContain(
      `showing 10 of 12 potential match(es) (count basis: exact); more available: true — look up ${MISSING} with sanctions_screen_identifier to see the rest.`,
    );
    expect(text).not.toContain(`re-screen "${MISSING}"`);
  });

  it('says a node with no Level 1 record has no name to screen, in format() and in missingEntityLeis', async () => {
    const { text } = await trace();
    expect(text).toContain(
      `- Absent from the GLEIF Level 1 entity mirror (1): \`${MISSING}\`. Those nodes show their LEI where a legal name would be; a per-node screen of one is its LEI lookup alone, since with no record there is no name to screen.`,
    );
    expect(text).not.toContain('ran against that LEI');

    const { description } = traceOwnershipTool.output.shape.missingEntityLeis;
    expect(description).not.toMatch(/as its name/);
    expect(description).toMatch(/looked up as an identifier, nothing else/);
  });

  it('runs no screen at all when screening is not requested', async () => {
    const result = await traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei: PARENT, direction: 'children', depth: 3 }),
      ctxFor(traceOwnershipTool.errors),
    );
    for (const node of result.nodes) {
      expect(node.sanctionsHits).toBeUndefined();
      expect(node.sanctionsScreen).toBeUndefined();
    }
  });
});
