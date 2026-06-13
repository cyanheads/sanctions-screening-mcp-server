/**
 * @fileoverview Parser tests for the sanctions + GLEIF ingesters against small
 * captured-shape XML samples. Exercises the normalization mapping (not the
 * network) so the parse path is covered without a live download.
 *
 * The samples here mirror the REAL source shapes, which are attribute-bearing
 * (OFAC advanced, EU) — so they go through the server-local `parseXml`
 * (`ignoreAttributes: false`), NOT the framework's attribute-dropping parser.
 * Element-based shapes (UK, UN, GLEIF) are covered too.
 * @module tests/services/ingest-parsers.test
 */

import { describe, expect, it } from 'vitest';
import {
  decompressGleifBuffer,
  parseLeiLevel1,
  parseLeiLevel2,
} from '@/services/screening/gleif-ingest.js';
import { parseEu, parseOfac, parseUk, parseUn } from '@/services/screening/sanctions-ingest.js';
import { parseXml } from '@/services/screening/xml.js';

// ─── OFAC advanced schema (attribute-driven) ────────────────────────────────────

/**
 * A trimmed but real-shaped OFAC advanced document: reference value sets +
 * one Individual DistinctParty (with a primary "Name" alias and an A.K.A.,
 * a Birthdate feature) + a matching SanctionsEntry carrying the programme and
 * designation date. All the load-bearing data is in XML attributes.
 */
const OFAC_ADVANCED_XML = `<?xml version="1.0" encoding="utf-8"?>
<Sanctions xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML">
  <ReferenceValueSets>
    <AliasTypeValues>
      <AliasType ID="1400">A.K.A.</AliasType>
      <AliasType ID="1401">F.K.A.</AliasType>
      <AliasType ID="1403">Name</AliasType>
    </AliasTypeValues>
    <FeatureTypeValues>
      <FeatureType ID="8">Birthdate</FeatureType>
      <FeatureType ID="9">Place of Birth</FeatureType>
    </FeatureTypeValues>
    <PartySubTypeValues>
      <PartySubType ID="1" PartyTypeID="4">Vessel</PartySubType>
      <PartySubType ID="2" PartyTypeID="4">Aircraft</PartySubType>
      <PartySubType ID="3" PartyTypeID="2">Unknown</PartySubType>
      <PartySubType ID="4" PartyTypeID="1">Unknown</PartySubType>
    </PartySubTypeValues>
  </ReferenceValueSets>
  <DistinctParties>
    <DistinctParty FixedRef="2674">
      <Profile ID="2674" PartySubTypeID="4">
        <Identity ID="4420" Primary="true">
          <Alias AliasTypeID="1400" Primary="false" LowQuality="false">
            <DocumentedName ID="1">
              <DocumentedNamePart><NamePartValue>ZAYDAN</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
          <Alias AliasTypeID="1403" Primary="true" LowQuality="false">
            <DocumentedName ID="2">
              <DocumentedNamePart><NamePartValue>ABBAS</NamePartValue></DocumentedNamePart>
              <DocumentedNamePart><NamePartValue>Abu</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
        </Identity>
        <Feature FeatureTypeID="8">
          <FeatureVersion ID="1">
            <DatePeriod>
              <Start>
                <From><Year>1948</Year><Month>12</Month><Day>10</Day></From>
              </Start>
            </DatePeriod>
          </FeatureVersion>
        </Feature>
      </Profile>
    </DistinctParty>
    <DistinctParty FixedRef="4238">
      <Profile ID="4238" PartySubTypeID="1">
        <Identity ID="9001" Primary="true">
          <Alias AliasTypeID="1403" Primary="true" LowQuality="false">
            <DocumentedName ID="3">
              <DocumentedNamePart><NamePartValue>MAR AZUL</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
        </Identity>
      </Profile>
    </DistinctParty>
  </DistinctParties>
  <SanctionsEntries>
    <SanctionsEntry ID="2674" ProfileID="2674" ListID="1550">
      <EntryEvent ID="1" EntryEventTypeID="1">
        <Date><Year>1995</Year><Month>1</Month><Day>23</Day></Date>
      </EntryEvent>
      <SanctionsMeasure ID="1" SanctionsTypeID="1"><Comment>SDGT</Comment></SanctionsMeasure>
    </SanctionsEntry>
    <SanctionsEntry ID="4238" ProfileID="4238" ListID="1550">
      <EntryEvent ID="2" EntryEventTypeID="1">
        <Date><Year>1989</Year><Month>1</Month><Day>5</Day></Date>
      </EntryEvent>
      <SanctionsMeasure ID="2" SanctionsTypeID="1"><Comment>CUBA</Comment></SanctionsMeasure>
    </SanctionsEntry>
  </SanctionsEntries>
</Sanctions>`;

describe('OFAC advanced parser', () => {
  it('extracts id, entity type, primary name, alias, programme and date from attributes', () => {
    const doc = parseXml<Record<string, unknown>>(OFAC_ADVANCED_XML);
    const designations = parseOfac(doc, 'ofac_sdn');
    expect(designations).toHaveLength(2);

    const person = designations.find((d) => d.sourceEntryId === '2674');
    expect(person).toBeDefined();
    expect(person?.id).toBe('ofac_sdn:2674'); // stable FixedRef id, not a random UUID
    expect(person?.entityType).toBe('person'); // PartySubTypeID 4 → PartyType 1 (Individual)
    expect(person?.primaryName).toBe('ABBAS Abu'); // the Primary "Name" alias
    expect(person?.program).toBe('SDGT'); // from the SanctionsEntry measure comment
    expect(person?.designationDate).toBe('1995-01-23'); // composed from EntryEvent date
    // The non-primary alias is carried as an a.k.a.
    expect(person?.payload.aliases.some((a) => a.name === 'ZAYDAN' && a.nameType === 'aka')).toBe(
      true,
    );
    // Birthdate feature extracted.
    expect(person?.payload.datesOfBirth.some((d) => d.date === '1948-12-10')).toBe(true);
  });

  it('classifies a vessel from its PartySubTypeID', () => {
    const doc = parseXml<Record<string, unknown>>(OFAC_ADVANCED_XML);
    const designations = parseOfac(doc, 'ofac_sdn');
    const vessel = designations.find((d) => d.sourceEntryId === '4238');
    expect(vessel?.entityType).toBe('vessel'); // PartySubTypeID 1 → "Vessel"
    expect(vessel?.primaryName).toBe('MAR AZUL');
    expect(vessel?.program).toBe('CUBA');
  });

  it('drops attributes (and so finds nothing) under the framework default parser', () => {
    // Regression guard: this is exactly why the server needs its own parser. The
    // framework's xmlParser ignores attributes; parsing the same doc with
    // attributes stripped yields no usable entry ids / types.
    const { XMLParser } = require('fast-xml-parser');
    const attrsOff = new XMLParser({ processEntities: false }); // ignoreAttributes defaults true
    const doc = attrsOff.parse(OFAC_ADVANCED_XML) as Record<string, unknown>;
    const designations = parseOfac(doc, 'ofac_sdn');
    // Without attributes every entity type collapses to unknown (no PartySubTypeID).
    expect(designations.every((d) => d.entityType === 'unknown')).toBe(true);
  });
});

// ─── EU consolidated (attribute-driven) ─────────────────────────────────────────

const EU_XML = `<?xml version="1.0" encoding="UTF-8"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export">
  <sanctionEntity logicalId="13" euReferenceNumber="EU.27.28">
    <regulation regulationType="regulation" programme="IRQ" publicationDate="2003-07-08"/>
    <subjectType code="person" classificationCode="P"/>
    <nameAlias firstName="Saddam" lastName="Hussein Al-Tikriti" wholeName="Saddam Hussein Al-Tikriti" strong="true"/>
    <nameAlias wholeName="Abu Ali" strong="false"/>
    <birthdate birthdate="1937-04-28"/>
    <citizenship countryDescription="Iraq"/>
  </sanctionEntity>
  <sanctionEntity logicalId="99" euReferenceNumber="EU.99.1">
    <regulation programme="UKR" publicationDate="2022-03-01"/>
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias wholeName="Example Front LLC" strong="true"/>
  </sanctionEntity>
</export>`;

describe('EU parser', () => {
  it('parses attribute-borne names, type, programme and date (zero rows when attrs are dropped)', () => {
    const doc = parseXml<Record<string, unknown>>(EU_XML);
    const designations = parseEu(doc);
    expect(designations).toHaveLength(2);

    const person = designations.find((d) => d.sourceEntryId === '13');
    expect(person?.primaryName).toBe('Saddam Hussein Al-Tikriti');
    expect(person?.entityType).toBe('person');
    expect(person?.program).toBe('IRQ');
    expect(person?.designationDate).toBe('2003-07-08');
    expect(person?.payload.aliases.some((a) => a.name === 'Abu Ali')).toBe(true);
    expect(person?.payload.nationalities).toContain('Iraq');

    const org = designations.find((d) => d.sourceEntryId === '99');
    expect(org?.entityType).toBe('organization'); // subjectType code "enterprise"
  });

  it('yields no designations when attributes are stripped (the bug this guards)', () => {
    const { XMLParser } = require('fast-xml-parser');
    const attrsOff = new XMLParser({ processEntities: false });
    const doc = attrsOff.parse(EU_XML) as Record<string, unknown>;
    expect(parseEu(doc)).toHaveLength(0);
  });
});

// ─── UK (element-based) ─────────────────────────────────────────────────────────

const UK_XML = `<?xml version="1.0" encoding="utf-8"?>
<Designations>
  <DateGenerated>10/06/2026</DateGenerated>
  <Designation>
    <LastUpdated>16/04/2026</LastUpdated>
    <DateDesignated>29/06/2012</DateDesignated>
    <UniqueID>AFG0001</UniqueID>
    <RegimeName>Afghanistan</RegimeName>
    <IndividualEntityShip>Entity</IndividualEntityShip>
    <Names>
      <Name><Name6>HAJI KHAIRULLAH MONEY EXCHANGE</Name6><NameType>Primary Name</NameType></Name>
      <Name><Name6>Haji Alim Hawala</Name6><NameType>Alias</NameType></Name>
    </Names>
  </Designation>
</Designations>`;

describe('UK parser', () => {
  it('normalizes an element-based designation with its alias', () => {
    const doc = parseXml<Record<string, unknown>>(UK_XML);
    const designations = parseUk(doc);
    expect(designations).toHaveLength(1);
    const d = designations[0]!;
    expect(d.sourceEntryId).toBe('AFG0001');
    expect(d.primaryName).toBe('HAJI KHAIRULLAH MONEY EXCHANGE');
    expect(d.entityType).toBe('organization');
    expect(d.program).toBe('Afghanistan');
    expect(d.payload.aliases.some((a) => a.name === 'Haji Alim Hawala')).toBe(true);
  });
});

// ─── UN (element-based) ─────────────────────────────────────────────────────────

const UN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CONSOLIDATED_LIST>
  <INDIVIDUALS>
    <INDIVIDUAL>
      <DATAID>6907993</DATAID>
      <FIRST_NAME>ERIC</FIRST_NAME>
      <SECOND_NAME>BADEGE</SECOND_NAME>
      <UN_LIST_TYPE>DRC</UN_LIST_TYPE>
      <LISTED_ON>2012-12-31</LISTED_ON>
      <NATIONALITY><VALUE>Democratic Republic of the Congo</VALUE></NATIONALITY>
    </INDIVIDUAL>
  </INDIVIDUALS>
  <ENTITIES>
    <ENTITY>
      <DATAID>6908100</DATAID>
      <FIRST_NAME>EXAMPLE UN ENTITY</FIRST_NAME>
      <UN_LIST_TYPE>DRC</UN_LIST_TYPE>
      <LISTED_ON>2013-01-01</LISTED_ON>
    </ENTITY>
  </ENTITIES>
</CONSOLIDATED_LIST>`;

describe('UN parser', () => {
  it('parses individuals and entities with programme, date and nationality', () => {
    const doc = parseXml<Record<string, unknown>>(UN_XML);
    const designations = parseUn(doc);
    expect(designations).toHaveLength(2);

    const person = designations.find((d) => d.sourceEntryId === '6907993');
    expect(person?.entityType).toBe('person');
    expect(person?.primaryName).toBe('ERIC BADEGE');
    expect(person?.program).toBe('DRC');
    expect(person?.designationDate).toBe('2012-12-31');
    expect(person?.payload.nationalities).toContain('Democratic Republic of the Congo');

    const org = designations.find((d) => d.sourceEntryId === '6908100');
    expect(org?.entityType).toBe('organization');
    expect(org?.primaryName).toBe('EXAMPLE UN ENTITY');
  });
});

// ─── GLEIF (element-based) ──────────────────────────────────────────────────────

const LEI_L1_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LEIData>
  <LEIRecords>
    <LEIRecord>
      <LEI>5493001KJTIIGC8Y1R12</LEI>
      <Entity>
        <LegalName>Fictional Trading Company LLC</LegalName>
        <LegalJurisdiction>US</LegalJurisdiction>
        <LegalAddress>
          <FirstAddressLine>99 Commerce Way</FirstAddressLine>
          <City>Testopolis</City>
          <Country>US</Country>
        </LegalAddress>
      </Entity>
      <Registration>
        <RegistrationStatus>ISSUED</RegistrationStatus>
        <LastUpdateDate>2026-01-15T10:00:00Z</LastUpdateDate>
      </Registration>
    </LEIRecord>
  </LEIRecords>
</LEIData>`;

const LEI_L2_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RelationshipData>
  <RelationshipRecords>
    <RelationshipRecord>
      <Relationship>
        <StartNode><NodeID>5493001KJTIIGC8Y1R12</NodeID></StartNode>
        <EndNode><NodeID>529900T8BM49AURSDO55</NodeID></EndNode>
        <RelationshipType>IS_ULTIMATELY_CONSOLIDATED_BY</RelationshipType>
        <RelationshipStatus>ACTIVE</RelationshipStatus>
      </Relationship>
    </RelationshipRecord>
  </RelationshipRecords>
</RelationshipData>`;

describe('GLEIF Level 1 parser', () => {
  it('normalizes an LEI record', () => {
    const doc = parseXml<Record<string, unknown>>(LEI_L1_XML);
    const entities = parseLeiLevel1(doc);
    expect(entities).toHaveLength(1);
    const e = entities[0]!;
    expect(e.lei).toBe('5493001KJTIIGC8Y1R12');
    expect(e.legalName).toBe('Fictional Trading Company LLC');
    expect(e.jurisdiction).toBe('US');
    expect(e.status).toBe('ISSUED');
    expect(e.legalAddress).toContain('99 Commerce Way');
  });
});

describe('GLEIF Level 2 parser', () => {
  it('normalizes a relationship record', () => {
    const doc = parseXml<Record<string, unknown>>(LEI_L2_XML);
    const rels = parseLeiLevel2(doc);
    expect(rels).toHaveLength(1);
    const r = rels[0]!;
    expect(r.childLei).toBe('5493001KJTIIGC8Y1R12');
    expect(r.parentLei).toBe('529900T8BM49AURSDO55');
    expect(r.relationshipType).toBe('IS_ULTIMATELY_CONSOLIDATED_BY');
    expect(r.relationshipStatus).toBe('ACTIVE');
  });

  it('returns an empty array for a document with no relationship records', () => {
    const doc = parseXml<Record<string, unknown>>(
      '<RelationshipData><RelationshipRecords></RelationshipRecords></RelationshipData>',
    );
    expect(parseLeiLevel2(doc)).toHaveLength(0);
  });
});

// ─── GLEIF download decompression (ZIP / gzip / plain) ──────────────────────────

describe('decompressGleifBuffer', () => {
  it('extracts the XML entry from a ZIP container (the golden-copy format)', () => {
    // Build a minimal ZIP (stored, no compression) wrapping one XML file, by hand:
    // local file header + filename + data + central directory + EOCD.
    const name = Buffer.from('lei.xml');
    const data = Buffer.from('<LEIData/>');
    const crc = 0; // stored entries still carry a CRC field; value is not validated here
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(0, 8); // method 0 = stored
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    const zip = Buffer.concat([lfh, name, data]);
    expect(decompressGleifBuffer(zip)).toBe('<LEIData/>');
  });

  it('passes through plain XML unchanged', () => {
    expect(decompressGleifBuffer(Buffer.from('<LEIData/>'))).toBe('<LEIData/>');
  });
});
