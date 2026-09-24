/**
 * @fileoverview Deterministic fuzz coverage for XML ingest and fuzzy matching.
 * Exercises hostile text, malformed/truncated records, invalid UTF-8, and
 * one-edit variants of public designation names without network access.
 * @module tests/fuzz/ingest-and-matcher.fuzz.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseLeiLevel1,
  streamLeiLevel1FromBytes,
  streamLeiLevel1FromText,
} from '@/services/screening/gleif-ingest.js';
import { createRejections } from '@/services/screening/ingest-validation.js';
import {
  createHarvestState,
  parseEu,
  parseOfac,
  parseUk,
  parseUn,
  streamOfacFromText,
} from '@/services/screening/sanctions-ingest.js';
import {
  buildFtsMatch,
  doubleMetaphone,
  fold,
  jaro,
  jaroWinkler,
} from '@/services/screening/text-matching.js';
import type {
  AddressRecord,
  DesignationPayload,
  IdentifierRecord,
  NormalizedDesignation,
} from '@/services/screening/types.js';
import { SOURCE_CODES } from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';
import { freshService, type SeededService } from '../services/_helpers.js';

const adversarialStrings = [
  '',
  '\0',
  '\u0000\u0001\u001f',
  '__proto__ constructor prototype',
  'NEAR OR NOT AND * " ^',
  '<!DOCTYPE x [<!ENTITY y "boom">]><x>&y;</x>',
  '../../../etc/passwd',
  'محمد Владимирович 李小龍',
  'A'.repeat(20_000),
  '\u202eabc\u202c',
] as const;

describe('text matcher fuzz invariants', () => {
  it('keeps folding, phonetics, and similarity bounded for hostile Unicode', () => {
    const random = mulberry32(0x5a17c0de);
    const values = [
      ...adversarialStrings,
      ...Array.from({ length: 400 }, () => randomUnicode(random, 80)),
    ];

    for (const value of values) {
      const normalized = fold(value);
      const reversed = [...normalized].reverse().join('');
      // Letters and digits of any script, single-spaced — no marks, no case, no final sigma.
      expect(normalized).toMatch(/^(?:[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*)?$/u);
      expect(normalized).not.toMatch(/[\p{M}ς]/u);
      expect(normalized).toBe(normalized.toLowerCase());
      expect(doubleMetaphone(normalized)).toMatch(/^(?:[A-Z]+(?: [A-Z]+)*)?$/);
      expect(jaro(normalized, reversed)).toBeGreaterThanOrEqual(0);
      expect(jaro(normalized, reversed)).toBeLessThanOrEqual(1);
      expect(jaroWinkler(normalized, reversed)).toBeGreaterThanOrEqual(0);
      expect(jaroWinkler(normalized, reversed)).toBeLessThanOrEqual(1);
      expect(jaro(normalized, reversed)).toBeCloseTo(jaro(reversed, normalized), 12);

      const match = buildFtsMatch(value);
      if (match)
        expect(match.split(' AND ').every((token) => /^"[\p{L}\p{N}]+"$/u.test(token))).toBe(true);
    }
  });
});

/** A `<DocumentedName>` body — the smallest advanced-schema name a party can carry. */
const OFAC_NAME_PART =
  '<DocumentedNamePart><NamePartValue>No Ref</NamePartValue></DocumentedNamePart>';

/** Matches a `crypto.randomUUID()` value anywhere in a designation id. */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/*
 * One well-formed record beside a sibling with no stable source identifier, per
 * source. The valid record must survive every parse unchanged; the sibling must
 * never contribute a record — a minted id would differ on each harvest.
 */
const MIXED_OFAC_STANDARD_XML = `<sdnList>
  <sdnEntry><uid>77</uid><firstName>Valid</firstName><lastName>Person</lastName><sdnType>Individual</sdnType></sdnEntry>
  <sdnEntry><firstName>Missing</firstName><lastName>Identifier</lastName></sdnEntry>
</sdnList>`;

const MIXED_OFAC_ADVANCED_XML = `<Sanctions>
  <ReferenceValueSets><AliasTypeValues><AliasType ID="1403">Name</AliasType></AliasTypeValues></ReferenceValueSets>
  <DistinctParties>
    <DistinctParty FixedRef="2674">
      <Profile ID="2674"><Identity><Alias AliasTypeID="1403" Primary="true">
        <DocumentedName><DocumentedNamePart><NamePartValue>ABBAS Abu</NamePartValue></DocumentedNamePart></DocumentedName>
      </Alias></Identity></Profile>
    </DistinctParty>
    <DistinctParty>
      <Profile><Identity><Alias AliasTypeID="1403" Primary="true">
        <DocumentedName>${OFAC_NAME_PART}</DocumentedName>
      </Alias></Identity></Profile>
    </DistinctParty>
  </DistinctParties>
</Sanctions>`;

const MIXED_EU_XML = `<export>
  <sanctionEntity logicalId="13"><subjectType code="person"/><nameAlias wholeName="Saddam Hussein Al-Tikriti"/></sanctionEntity>
  <sanctionEntity><subjectType code="person"/><nameAlias wholeName="Acme SA"/></sanctionEntity>
</export>`;

const MIXED_UK_XML = `<Designations>
  <Designation><UniqueID>AFG0001</UniqueID><Names><Name><Name6>HAJI KHAIRULLAH MONEY EXCHANGE</Name6></Name></Names></Designation>
  <Designation><Names><Name><Name6>Acme Ltd</Name6></Name></Names></Designation>
</Designations>`;

const MIXED_UN_XML = `<CONSOLIDATED_LIST><INDIVIDUALS>
  <INDIVIDUAL><DATAID>6907993</DATAID><FIRST_NAME>ERIC</FIRST_NAME><SECOND_NAME>BADEGE</SECOND_NAME></INDIVIDUAL>
  <INDIVIDUAL><FIRST_NAME>NO</FIRST_NAME><SECOND_NAME>ID</SECOND_NAME></INDIVIDUAL>
</INDIVIDUALS></CONSOLIDATED_LIST>`;

describe('ingest parser fuzz invariants', () => {
  it('does not turn adversarial content under unknown roots into source records', () => {
    const random = mulberry32(0x1badb002);
    const values = [
      ...adversarialStrings,
      ...Array.from({ length: 200 }, () => randomUnicode(random, 120)),
    ];
    for (const value of values) {
      const doc = parseXml<Record<string, unknown>>(
        `<root><noise>${escapeXml(value)}</noise></root>`,
      );
      expect(parseOfac(doc, 'ofac_sdn')).toHaveLength(0);
      expect(parseEu(doc)).toHaveLength(0);
      expect(parseUk(doc)).toHaveLength(0);
      expect(parseUn(doc)).toHaveLength(0);
      expect(parseLeiLevel1(doc)).toHaveLength(0);
    }
  });

  it('drops truncated streaming records rather than emitting partial entities', async () => {
    const truncated =
      '<LEIData><LEIRecords><LEIRecord><LEI>5493001KJTIIGC8Y1R12</LEI><Entity><LegalName>Partial';
    expect(await collect(streamLeiLevel1FromText(chunks(truncated, 1)))).toHaveLength(0);
    expect(await collect(streamLeiLevel1FromText(chunks(truncated, 7)))).toHaveLength(0);
  });

  it('rejects source-shaped records with missing IDs, names, or truncated XML', () => {
    const invalid = [
      '<sdnList><sdnEntry><firstName>Test</firstName><lastName>Person</lastName></sdnEntry></sdnList>',
      '<sdnList><sdnEntry><uid>42</uid></sdnEntry></sdnList>',
      '<sdnList><sdnEntry><uid>1</uid><firstName>Truncated',
    ];
    for (const xml of invalid) {
      expect(parseOfac(parseXml(xml), 'ofac_sdn'), xml).toHaveLength(0);
    }
    // Advanced schema: a party carrying neither FixedRef nor ID.
    expect(
      parseOfac(
        parseXml(
          `<Sanctions><DistinctParties><DistinctParty><Profile><Identity><Alias Primary="true"><DocumentedName>${OFAC_NAME_PART}</DocumentedName></Alias></Identity></Profile></DistinctParty></DistinctParties></Sanctions>`,
        ),
        'ofac_sdn',
      ),
    ).toHaveLength(0);
    expect(
      parseEu(
        parseXml(
          '<export><sanctionEntity><nameAlias wholeName="Acme SA"/></sanctionEntity></export>',
        ),
      ),
    ).toHaveLength(0);
    expect(
      parseUk(
        parseXml(
          '<Designations><Designation><Names><Name><Name6>Acme Ltd</Name6></Name></Names></Designation></Designations>',
        ),
      ),
    ).toHaveLength(0);
    expect(
      parseUn(
        parseXml(
          '<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL><FIRST_NAME>NO</FIRST_NAME><SECOND_NAME>ID</SECOND_NAME></INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>',
        ),
      ),
    ).toHaveLength(0);
    expect(
      parseLeiLevel1(
        parseXml(
          '<LEIData><LEIRecords><LEIRecord><LEI>5493001KJTIIGC8Y1R12</LEI><Entity/></LEIRecord></LEIRecords></LEIData>',
        ),
      ),
    ).toHaveLength(0);
  });

  it('parses the same payload twice into identical records, entry ids included', () => {
    const cases: [label: string, expectedIds: string[], parse: () => NormalizedDesignation[]][] = [
      ['ofac standard', ['77'], () => parseOfac(parseXml(MIXED_OFAC_STANDARD_XML), 'ofac_sdn')],
      ['ofac advanced', ['2674'], () => parseOfac(parseXml(MIXED_OFAC_ADVANCED_XML), 'ofac_sdn')],
      ['eu', ['13'], () => parseEu(parseXml(MIXED_EU_XML))],
      ['uk', ['AFG0001'], () => parseUk(parseXml(MIXED_UK_XML))],
      ['un', ['6907993'], () => parseUn(parseXml(MIXED_UN_XML))],
    ];
    for (const [label, expectedIds, parse] of cases) {
      const first = parse();
      const second = parse();
      // The malformed sibling is dropped; the valid record beside it survives.
      expect(
        first.map((d) => d.sourceEntryId),
        label,
      ).toEqual(expectedIds);
      // A re-harvest must re-derive the same primary keys, or the mirror's
      // upsert-only apply inserts a duplicate row instead of updating.
      expect(second, label).toEqual(first);
      expect(
        first.every((d) => !UUID_PATTERN.test(d.id)),
        label,
      ).toBe(true);
    }
  });

  it('rejects invalid UTF-8 instead of indexing replacement-character names', async () => {
    const prefix = new TextEncoder().encode(
      '<LEIData><LEIRecords><LEIRecord><LEI>5493001KJTIIGC8Y1R12</LEI><Entity><LegalName>',
    );
    const suffix = new TextEncoder().encode(
      '</LegalName></Entity></LEIRecord></LEIRecords></LEIData>',
    );
    async function* bytes(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.from([...prefix, 0xc3, 0x28, ...suffix]);
    }
    expect(await collect(streamLeiLevel1FromBytes(bytes()))).toHaveLength(0);
  });

  it('resolves OFAC cross-references that exist and drops only the dangling or partial ones', async () => {
    const random = mulberry32(0x0fac22);
    for (let round = 0; round < 40; round++) {
      const doc = randomOfacCrossReferenceDocument(random);
      const rejections = createRejections();
      const buffered = parseOfac(parseXml(doc.xml), 'ofac_sdn', rejections);

      // Every party ingests; a bad reference is never a rejection.
      expect(
        buffered.map((d) => d.sourceEntryId),
        `round ${round}`,
      ).toEqual(doc.partyIds);
      expect(rejections, `round ${round}`).toEqual({ missingIdentifier: 0, unusableName: 0 });
      for (const [index, designation] of buffered.entries()) {
        const expected = doc.expected[index];
        expect(designation.payload.addresses, `round ${round} party ${index}`).toEqual(
          expected?.addresses,
        );
        expect(designation.payload.nationalities, `round ${round} party ${index}`).toEqual(
          expected?.nationalities,
        );
        expect(designation.payload.identifiers, `round ${round} party ${index}`).toEqual(
          expected?.identifiers,
        );
      }

      const streamed: NormalizedDesignation[] = [];
      const state = createHarvestState();
      for await (const record of streamOfacFromText(
        chunks(doc.xml, 1 + (round % 13)),
        'ofac_sdn',
        state,
      )) {
        streamed.push(record);
      }
      expect(streamed, `round ${round} streamed`).toEqual(buffered);
    }
  });

  it('keeps GLEIF Level 1 output identical across repeat parses, dropping unusable records', () => {
    const xml = `<LEIData><LEIRecords>
      <LEIRecord><LEI>5493001KJTIIGC8Y1R12</LEI><Entity><LegalName>Fictional Trading Company LLC</LegalName></Entity></LEIRecord>
      <LEIRecord><LEI>529900T8BM49AURSDO55</LEI><Entity/></LEIRecord>
      <LEIRecord><Entity><LegalName>No LEI Co</LegalName></Entity></LEIRecord>
    </LEIRecords></LEIData>`;
    const first = parseLeiLevel1(parseXml(xml));
    expect(first.map((e) => e.lei)).toEqual(['5493001KJTIIGC8Y1R12']);
    expect(parseLeiLevel1(parseXml(xml))).toEqual(first);
  });
});

describe('near-miss designation fuzzing', () => {
  let standalone: SeededService | undefined;

  afterEach(async () => {
    await standalone?.cleanup();
  });

  it('keeps one-edit variants above the floor and unrelated names out', async () => {
    standalone = await freshService();
    const designations: NormalizedDesignation[] = [
      designation('ofac_sdn', 'FUZZ-1', 'MADURO MOROS Nicolas'),
      designation('eu', 'FUZZ-2', 'Saddam Hussein Al-Tikriti'),
    ];
    await standalone.service.ingestDesignations(designations);
    await standalone.service.markSanctionsReady(designations.length);

    for (const [entryId, name] of [
      ['FUZZ-1', 'MADURO MOROS Nicolas'],
      ['FUZZ-2', 'Saddam Hussein Al-Tikriti'],
    ] as const) {
      for (const query of oneEditVariants(name).slice(0, 40)) {
        const result = await standalone.service.screenName(
          {
            query,
            entityType: 'any',
            matchMode: 'fuzzy',
            sources: [...SOURCE_CODES],
            limit: 10,
          },
          createMockContext(),
        );
        const hit = result.hits.find((candidate) => candidate.sourceEntryId === entryId);
        expect(hit, query).toBeDefined();
        expect(hit?.score, query).toBeGreaterThanOrEqual(0.85);
        expect(result.hits[0]?.sourceEntryId, query).toBe(entryId);
      }
    }

    const unrelated = await standalone.service.screenName(
      {
        query: 'Giorgi Ivanov',
        entityType: 'any',
        matchMode: 'fuzzy',
        sources: [...SOURCE_CODES],
        limit: 10,
      },
      createMockContext(),
    );
    expect(unrelated.hits).toHaveLength(0);
  });
});

function designation(
  source: NormalizedDesignation['source'],
  sourceEntryId: string,
  primaryName: string,
): NormalizedDesignation {
  return {
    id: `${source}:${sourceEntryId}`,
    source,
    sourceEntryId,
    entityType: 'person',
    primaryName,
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  };
}

function oneEditVariants(value: string): string[] {
  const alphabet = 'aeikmnorstuv';
  const variants: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!/[A-Za-z]/.test(value[index] ?? '')) continue;
    const replacement = alphabet[index % alphabet.length] ?? 'x';
    if (replacement.toLowerCase() === value[index]?.toLowerCase()) continue;
    variants.push(`${value.slice(0, index)}${replacement}${value.slice(index + 1)}`);
  }
  return variants;
}

interface CrossReferenceDocument {
  /** Per party, the detail groups a correct resolution produces. */
  expected: Pick<DesignationPayload, 'addresses' | 'identifiers' | 'nationalities'>[];
  partyIds: string[];
  xml: string;
}

/**
 * An OFAC advanced document whose parties point at a random mix of published,
 * never-published, placeholder, and partial `<Location>`s and `<IDRegDocument>`s,
 * with the detail groups a correct resolution yields computed alongside it.
 */
function randomOfacCrossReferenceDocument(random: () => number): CrossReferenceDocument {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const countries = new Map([
    ['1', 'Aland'],
    ['2', 'Borduria'],
    ['3', 'Carpania'],
  ]);
  const part = (type: string, value: string, primary = true) =>
    `<LocationPart LocPartTypeID="${type}"><LocationPartValue Primary="${primary}"><Comment /><Value>${value}</Value></LocationPartValue></LocationPart>`;

  // Location IDs 1–6 may be published; 7 and 8 never are.
  const rendered = new Map<string, AddressRecord>();
  const locations: string[] = [];
  for (let id = 1; id <= 6; id++) {
    const lid = String(id);
    const countryId = pick(['1', '2', '3']);
    const country = countries.get(countryId) as string;
    switch (pick(['full', 'name', 'undetermined', 'partial', 'placeholder-country', 'absent'])) {
      case 'full':
        locations.push(
          `<Location ID="${lid}"><LocationCountry CountryID="${countryId}" />${part('1454', `City ${lid}`)}${part('1451', `${lid} Main St`)}</Location>`,
        );
        rendered.set(lid, { full: `${lid} Main St, City ${lid}, ${country}`, country });
        break;
      case 'name':
        locations.push(`<Location ID="${lid}">${part('1', country)}</Location>`);
        rendered.set(lid, { full: country });
        break;
      case 'undetermined':
        locations.push(`<Location ID="${lid}"><LocationAreaCode AreaCodeID="9" /></Location>`);
        break;
      case 'partial':
        locations.push(
          `<Location ID="${lid}"><LocationCountry CountryID="77" />${part('1454', 'Variant Only', false)}</Location>`,
        );
        break;
      case 'placeholder-country':
        locations.push(
          `<Location ID="${lid}"><LocationCountry CountryID="9" />${part('1456', `PC-${lid}`)}</Location>`,
        );
        rendered.set(lid, { full: `PC-${lid}` });
        break;
    }
  }

  const documents: string[] = [];
  const parties: string[] = [];
  const partyIds: string[] = [];
  const expected: CrossReferenceDocument['expected'] = [];
  for (let p = 1; p <= 4; p++) {
    const identityId = `70${p}`;
    const identifiers: IdentifierRecord[] = [];
    const documentCount = Math.floor(random() * 4);
    for (let d = 0; d < documentCount; d++) {
      const number = `N${p}-${Math.floor(random() * 3)}`;
      switch (pick(['good', 'good-no-country', 'no-number', 'unknown-type', 'orphan'])) {
        case 'good':
          documents.push(
            `<IDRegDocument IDRegDocTypeID="1570" IdentityID="${identityId}" IssuedBy-CountryID="2"><IDRegistrationNo>${number}</IDRegistrationNo></IDRegDocument>`,
          );
          identifiers.push({ type: 'Passport', value: number, country: 'Borduria' });
          break;
        case 'good-no-country':
          documents.push(
            `<IDRegDocument IDRegDocTypeID="1570" IdentityID="${identityId}" IssuedBy-CountryID="9"><IDRegistrationNo>${number}</IDRegistrationNo></IDRegDocument>`,
          );
          identifiers.push({ type: 'Passport', value: number });
          break;
        case 'no-number':
          documents.push(
            `<IDRegDocument IDRegDocTypeID="1570" IdentityID="${identityId}"><Comment /></IDRegDocument>`,
          );
          break;
        case 'unknown-type':
          documents.push(
            `<IDRegDocument IDRegDocTypeID="999" IdentityID="${identityId}"><IDRegistrationNo>${number}</IDRegistrationNo></IDRegDocument>`,
          );
          break;
        case 'orphan':
          documents.push(
            `<IDRegDocument IDRegDocTypeID="1570" IdentityID="9999"><IDRegistrationNo>${number}</IDRegistrationNo></IDRegDocument>`,
          );
          break;
      }
    }

    const features: string[] = [];
    const addresses: AddressRecord[] = [];
    const nationalities: string[] = [];
    const featureCount = Math.floor(random() * 5);
    for (let f = 0; f < featureCount; f++) {
      const lid = String(1 + Math.floor(random() * 8));
      const nationality = random() < 0.4;
      features.push(
        `<Feature FeatureTypeID="${nationality ? '10' : '25'}"><FeatureVersion><VersionLocation LocationID="${lid}" /></FeatureVersion></Feature>`,
      );
      const target = rendered.get(lid);
      if (target && nationality) nationalities.push(target.full);
      if (target && !nationality) addresses.push(target);
    }

    const fixedRef = `900${p}`;
    partyIds.push(fixedRef);
    parties.push(
      `<DistinctParty FixedRef="${fixedRef}"><Profile ID="${fixedRef}"><Identity ID="${identityId}"><Alias AliasTypeID="1403" Primary="true"><DocumentedName><DocumentedNamePart><NamePartValue>Party ${p}</NamePartValue></DocumentedNamePart></DocumentedName></Alias></Identity>${features.join('')}</Profile></DistinctParty>`,
    );
    expected.push({
      addresses: uniqueJson(addresses),
      identifiers: uniqueJson(identifiers),
      nationalities: uniqueJson(nationalities),
    });
  }

  const xml = `<Sanctions>
    <ReferenceValueSets>
      <AliasTypeValues><AliasType ID="1403">Name</AliasType></AliasTypeValues>
      <CountryValues>${[...countries].map(([id, name]) => `<Country ID="${id}">${name}</Country>`).join('')}<Country ID="9">undetermined</Country></CountryValues>
      <FeatureTypeValues><FeatureType ID="10">Nationality Country</FeatureType><FeatureType ID="25">Location</FeatureType></FeatureTypeValues>
      <IDRegDocTypeValues><IDRegDocType ID="1570">Passport</IDRegDocType></IDRegDocTypeValues>
      <LocPartTypeValues><LocPartType ID="1">Unknown</LocPartType><LocPartType ID="1451">ADDRESS1</LocPartType><LocPartType ID="1454">CITY</LocPartType><LocPartType ID="1456">POSTAL CODE</LocPartType></LocPartTypeValues>
    </ReferenceValueSets>
    <Locations>${locations.join('')}</Locations>
    <IDRegDocuments>${documents.join('')}</IDRegDocuments>
    <DistinctParties>${parties.join('')}</DistinctParties>
  </Sanctions>`;
  return { expected, partyIds, xml };
}

/** Exact-duplicate collapse in first-seen order — the expected-value side of the dedupe rule. */
function uniqueJson<T>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomUnicode(random: () => number, maxLength: number): string {
  const length = Math.floor(random() * maxLength);
  const ranges = [
    [0x00, 0x7f],
    [0x300, 0x36f],
    [0x400, 0x4ff],
    [0x600, 0x6ff],
    [0x2000, 0x206f],
  ] as const;
  return Array.from({ length }, () => {
    const range = ranges[Math.floor(random() * ranges.length)] ?? ranges[0];
    const codePoint = range[0] + Math.floor(random() * (range[1] - range[0] + 1));
    return String.fromCodePoint(codePoint);
  }).join('');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function* chunks(value: string, size: number): AsyncGenerator<string> {
  for (let index = 0; index < value.length; index += size) {
    yield value.slice(index, index + size);
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
