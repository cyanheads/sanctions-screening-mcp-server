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

import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decompressGleifBuffer,
  parseLeiLevel1,
  parseLeiLevel2,
  streamLeiLevel1FromBytes,
  streamLeiLevel1FromText,
  streamLeiLevel2FromBytes,
  streamLeiLevel2FromText,
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

describe('sanctions parser sparsity and alias quality', () => {
  it('preserves multiple OFAC standard aliases and weak-alias provenance', () => {
    const doc = parseXml<Record<string, unknown>>(`
      <sdnList>
        <sdnEntry>
          <uid>12345</uid>
          <firstName>Example</firstName><lastName>Person</lastName>
          <sdnType>Individual</sdnType>
          <akaList>
            <aka><category>strong</category><firstName>Example</firstName><lastName>Alias</lastName></aka>
            <aka><category>weak</category><lastName>Shortname</lastName></aka>
          </akaList>
          <idList><id><idType>Passport</idType><idNumber>P123</idNumber></id></idList>
          <addressList><address><city>Test City</city><country>Testland</country></address></addressList>
          <dateOfBirthList><dateOfBirthItem><dateOfBirth>1980-01-02</dateOfBirth></dateOfBirthItem></dateOfBirthList>
          <nationalityList><nationality><country>Testland</country></nationality></nationalityList>
          <unexpected><nested>ignored</nested></unexpected>
        </sdnEntry>
      </sdnList>
    `);
    const [designation] = parseOfac(doc, 'ofac_sdn');
    expect(designation).toMatchObject({
      sourceEntryId: '12345',
      entityType: 'person',
      primaryName: 'Example Person',
    });
    expect(designation?.payload.aliases).toEqual([
      { name: 'Example Alias', nameType: 'aka' },
      { name: 'Shortname', nameType: 'low-quality-aka' },
    ]);
    expect(designation?.payload.identifiers).toEqual([{ type: 'Passport', value: 'P123' }]);
    expect(designation?.payload.addresses).toEqual([
      { full: 'Test City, Testland', country: 'Testland' },
    ]);
    expect(designation?.payload.datesOfBirth).toEqual([{ date: '1980-01-02' }]);
    expect(designation?.payload.nationalities).toEqual(['Testland']);
  });

  it('preserves UN high/low aliases and sparse document fields', () => {
    const doc = parseXml<Record<string, unknown>>(`
      <CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL>
        <DATAID>67890</DATAID><FIRST_NAME>PUBLIC</FIRST_NAME><SECOND_NAME>EXAMPLE</SECOND_NAME>
        <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Public Alias</ALIAS_NAME></INDIVIDUAL_ALIAS>
        <INDIVIDUAL_ALIAS><QUALITY>Low</QUALITY><ALIAS_NAME>P. Example</ALIAS_NAME></INDIVIDUAL_ALIAS>
        <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>Passport</TYPE_OF_DOCUMENT><NUMBER>X1</NUMBER></INDIVIDUAL_DOCUMENT>
        <UNEXPECTED_FIELD>ignored</UNEXPECTED_FIELD>
      </INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>
    `);
    const [designation] = parseUn(doc);
    expect(designation?.payload.aliases).toEqual([
      { name: 'Public Alias', nameType: 'aka' },
      { name: 'P. Example', nameType: 'low-quality-aka' },
    ]);
    expect(designation?.payload.identifiers).toEqual([{ type: 'Passport', value: 'X1' }]);
    expect(designation?.payload.addresses).toEqual([]);
    expect(designation?.payload.datesOfBirth).toEqual([]);
  });

  it('drops nameless OFAC advanced, EU, UK, and UN entries', () => {
    const ofac = parseOfac(
      parseXml(
        '<Sanctions><DistinctParties><DistinctParty FixedRef="1"><Profile/></DistinctParty></DistinctParties></Sanctions>',
      ),
      'ofac_sdn',
    );
    const eu = parseEu(
      parseXml(
        '<export><sanctionEntity logicalId="1"><subjectType code="person"/></sanctionEntity></export>',
      ),
    );
    const uk = parseUk(
      parseXml('<Designations><Designation><UniqueID>1</UniqueID></Designation></Designations>'),
    );
    const un = parseUn(
      parseXml(
        '<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL><DATAID>1</DATAID></INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>',
      ),
    );
    expect({ ofac, eu, uk, un }).toEqual({ ofac: [], eu: [], uk: [], un: [] });
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

// ─── GLEIF namespace-prefixed real-corpus shape (issue #7) ──────────────────────
//
// Real GLEIF golden-copy and delta files are namespace-prefixed on EVERY element —
// `lei:` (LEI-CDF) / `rr:` (RR-CDF), inner fields included — unlike the synthetic
// fixtures above. `removeNSPrefix: true` on the shared parser strips the prefix at
// parse time so the unprefixed reads in parseOneLei / parseOneRelationship still
// resolve. Before the fix these documents parsed to zero records, "Unknown" legal
// names, and dropped relationships. The fixtures are prefixed throughout, including
// `xml:lang` on the name/address elements (which removeNSPrefix folds to `lang`).

const LEI_L1_FULLY_PREFIXED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<lei:LEIData xmlns:lei="http://www.gleif.org/data/schema/leidata/2016">
  <lei:LEIRecords>
    <lei:LEIRecord>
      <lei:LEI>5493001KJTIIGC8Y1R12</lei:LEI>
      <lei:Entity>
        <lei:LegalName xml:lang="en">Fictional Trading Company LLC</lei:LegalName>
        <lei:OtherEntityNames>
          <lei:OtherEntityName xml:lang="en" type="PREVIOUS_LEGAL_NAME">Fictional Trading Co</lei:OtherEntityName>
          <lei:OtherEntityName xml:lang="en" type="TRADING_OR_OPERATING_NAME">FTC LLC</lei:OtherEntityName>
        </lei:OtherEntityNames>
        <lei:LegalAddress xml:lang="en">
          <lei:FirstAddressLine>99 Commerce Way</lei:FirstAddressLine>
          <lei:City>Testopolis</lei:City>
          <lei:Region>US-NY</lei:Region>
          <lei:Country>US</lei:Country>
          <lei:PostalCode>10001</lei:PostalCode>
        </lei:LegalAddress>
        <lei:HeadquartersAddress xml:lang="en">
          <lei:FirstAddressLine>1 HQ Plaza</lei:FirstAddressLine>
          <lei:City>Testopolis</lei:City>
          <lei:Country>US</lei:Country>
        </lei:HeadquartersAddress>
        <lei:RegistrationAuthority>
          <lei:RegistrationAuthorityID>RA000665</lei:RegistrationAuthorityID>
          <lei:RegistrationAuthorityEntityID>FTC-REG-1</lei:RegistrationAuthorityEntityID>
        </lei:RegistrationAuthority>
        <lei:LegalJurisdiction>US</lei:LegalJurisdiction>
        <lei:EntityStatus>ACTIVE</lei:EntityStatus>
      </lei:Entity>
      <lei:Registration>
        <lei:LastUpdateDate>2026-01-15T10:00:00Z</lei:LastUpdateDate>
        <lei:RegistrationStatus>ISSUED</lei:RegistrationStatus>
      </lei:Registration>
    </lei:LEIRecord>
    <lei:LEIRecord>
      <lei:LEI>529900T8BM49AURSDO55</lei:LEI>
      <lei:Entity>
        <lei:LegalName xml:lang="fr">Société Générale Placement SA</lei:LegalName>
        <lei:LegalAddress xml:lang="fr">
          <lei:FirstAddressLine>29 Boulevard Haussmann</lei:FirstAddressLine>
          <lei:City>Paris</lei:City>
          <lei:Country>FR</lei:Country>
          <lei:PostalCode>75009</lei:PostalCode>
        </lei:LegalAddress>
        <lei:LegalJurisdiction>FR</lei:LegalJurisdiction>
        <lei:EntityStatus>ACTIVE</lei:EntityStatus>
      </lei:Entity>
      <lei:Registration>
        <lei:LastUpdateDate>2026-02-01T08:00:00Z</lei:LastUpdateDate>
        <lei:RegistrationStatus>ISSUED</lei:RegistrationStatus>
      </lei:Registration>
    </lei:LEIRecord>
    <lei:LEIRecord>
      <lei:LEI>213800MINIMAL00000X1</lei:LEI>
      <lei:Entity>
        <lei:LegalName xml:lang="en">Minimal Holdings Ltd</lei:LegalName>
        <lei:LegalJurisdiction>GB</lei:LegalJurisdiction>
        <lei:EntityStatus>ACTIVE</lei:EntityStatus>
      </lei:Entity>
    </lei:LEIRecord>
  </lei:LEIRecords>
</lei:LEIData>`;

const RR_L2_FULLY_PREFIXED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rr:RelationshipData xmlns:rr="http://www.gleif.org/data/schema/rr/2016">
  <rr:RelationshipRecords>
    <rr:RelationshipRecord>
      <rr:Relationship>
        <rr:StartNode><rr:NodeID>5493001KJTIIGC8Y1R12</rr:NodeID><rr:NodeIDType>LEI</rr:NodeIDType></rr:StartNode>
        <rr:EndNode><rr:NodeID>529900T8BM49AURSDO55</rr:NodeID><rr:NodeIDType>LEI</rr:NodeIDType></rr:EndNode>
        <rr:RelationshipType>IS_ULTIMATELY_CONSOLIDATED_BY</rr:RelationshipType>
        <rr:RelationshipPeriods><rr:RelationshipPeriod><rr:StartDate>2020-01-01T00:00:00Z</rr:StartDate><rr:PeriodType>RELATIONSHIP_PERIOD</rr:PeriodType></rr:RelationshipPeriod></rr:RelationshipPeriods>
        <rr:RelationshipStatus>ACTIVE</rr:RelationshipStatus>
      </rr:Relationship>
    </rr:RelationshipRecord>
    <rr:RelationshipRecord>
      <rr:Relationship>
        <rr:StartNode><rr:NodeID>213800MINIMAL00000X1</rr:NodeID><rr:NodeIDType>LEI</rr:NodeIDType></rr:StartNode>
        <rr:EndNode><rr:NodeID>529900T8BM49AURSDO55</rr:NodeID><rr:NodeIDType>LEI</rr:NodeIDType></rr:EndNode>
        <rr:RelationshipType>IS_DIRECTLY_CONSOLIDATED_BY</rr:RelationshipType>
        <rr:RelationshipStatus>ACTIVE</rr:RelationshipStatus>
      </rr:Relationship>
    </rr:RelationshipRecord>
  </rr:RelationshipRecords>
</rr:RelationshipData>`;

describe('GLEIF namespace-prefixed corpus (issue #7)', () => {
  it('DOM parseLeiLevel1 yields complete records with real legal names (never "Unknown")', () => {
    const entities = parseLeiLevel1(parseXml(LEI_L1_FULLY_PREFIXED_XML));
    expect(entities).toHaveLength(3);
    expect(entities.every((e) => e.legalName !== 'Unknown')).toBe(true);

    const full = entities.find((e) => e.lei === '5493001KJTIIGC8Y1R12')!;
    expect(full.legalName).toBe('Fictional Trading Company LLC');
    expect(full.otherNames).toEqual(['Fictional Trading Co', 'FTC LLC']);
    expect(full.jurisdiction).toBe('US');
    expect(full.status).toBe('ISSUED');
    expect(full.legalAddress).toContain('99 Commerce Way');
    expect(full.headquartersAddress).toContain('1 HQ Plaza');
    expect(full.registrationAuthorityId).toBe('RA000665');
    expect(full.lastUpdate).toBe('2026-01-15T10:00:00Z');

    // xml:lang on the name element (folded to `lang` by removeNSPrefix) doesn't
    // disturb the multibyte legal-name text read.
    expect(entities.find((e) => e.lei === '529900T8BM49AURSDO55')?.legalName).toBe(
      'Société Générale Placement SA',
    );
    // Sparse record: status falls back to EntityStatus when Registration is absent.
    expect(entities.find((e) => e.lei === '213800MINIMAL00000X1')?.status).toBe('ACTIVE');
  });

  it('DOM parseLeiLevel2 retains relationships with correct child/parent LEIs', () => {
    const rels = parseLeiLevel2(parseXml(RR_L2_FULLY_PREFIXED_XML));
    expect(rels).toHaveLength(2);

    const ultimate = rels.find((r) => r.relationshipType === 'IS_ULTIMATELY_CONSOLIDATED_BY')!;
    expect(ultimate.childLei).toBe('5493001KJTIIGC8Y1R12');
    expect(ultimate.parentLei).toBe('529900T8BM49AURSDO55');
    expect(ultimate.relationshipStatus).toBe('ACTIVE');
    expect(ultimate.relationshipPeriod).toBe('2020-01-01T00:00:00Z');

    const direct = rels.find((r) => r.relationshipType === 'IS_DIRECTLY_CONSOLIDATED_BY')!;
    expect(direct.childLei).toBe('213800MINIMAL00000X1');
    expect(direct.parentLei).toBe('529900T8BM49AURSDO55');
  });

  it('parses to ZERO records when namespace prefixes are preserved (the pre-fix failure mode)', () => {
    // The GLEIF counterpart to the OFAC/EU attribute guards above: with prefixes
    // preserved, every element key stays `lei:`/`rr:`-prefixed, so the unprefixed
    // reads reach nothing and the record lists come back empty — exactly the bug
    // that `removeNSPrefix` fixes.
    const { XMLParser } = require('fast-xml-parser');
    const nsPreserved = new XMLParser({ ignoreAttributes: false, processEntities: false });
    expect(parseLeiLevel1(nsPreserved.parse(LEI_L1_FULLY_PREFIXED_XML))).toHaveLength(0);
    expect(parseLeiLevel2(nsPreserved.parse(RR_L2_FULLY_PREFIXED_XML))).toHaveLength(0);
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

// ─── GLEIF streaming ingest (issue #6) ──────────────────────────────────────────
//
// The streaming golden-copy path must emit the SAME normalized records as the
// buffered DOM parser (parseLeiLevel1 / parseLeiLevel2) — the DOM path is the
// equivalence oracle. Multi-record documents are fed at awkward chunk sizes (down
// to 1) to exercise record boundaries split across chunks and multi-byte UTF-8
// characters split across the streaming TextDecoder.

/** A multi-record L1 document: a full record (other names, both addresses), one
 *  carrying multi-byte UTF-8 in its legal name, and a minimal one (LEI + name). */
const MULTI_L1_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LEIData>
  <LEIRecords>
    <LEIRecord>
      <LEI>5493001KJTIIGC8Y1R12</LEI>
      <Entity>
        <LegalName>Fictional Trading Company LLC</LegalName>
        <OtherEntityNames>
          <OtherEntityName>Fictional Trading Co</OtherEntityName>
          <OtherEntityName>FTC LLC</OtherEntityName>
        </OtherEntityNames>
        <LegalAddress><FirstAddressLine>99 Commerce Way</FirstAddressLine><City>Testopolis</City><Country>US</Country></LegalAddress>
        <HeadquartersAddress><FirstAddressLine>1 HQ Plaza</FirstAddressLine><City>Testopolis</City><Country>US</Country></HeadquartersAddress>
        <LegalJurisdiction>US</LegalJurisdiction>
      </Entity>
      <Registration><RegistrationStatus>ISSUED</RegistrationStatus><LastUpdateDate>2026-01-15T10:00:00Z</LastUpdateDate></Registration>
    </LEIRecord>
    <LEIRecord>
      <LEI>529900T8BM49AURSDO55</LEI>
      <Entity>
        <LegalName>Société Générale Café Frères SA</LegalName>
        <LegalJurisdiction>FR</LegalJurisdiction>
      </Entity>
      <Registration><RegistrationStatus>LAPSED</RegistrationStatus></Registration>
    </LEIRecord>
    <LEIRecord>
      <LEI>213800MINIMAL00000X1</LEI>
      <Entity><LegalName>Minimal Co</LegalName></Entity>
    </LEIRecord>
  </LEIRecords>
</LEIData>`;

const MULTI_L2_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RelationshipData>
  <RelationshipRecords>
    <RelationshipRecord><Relationship>
      <StartNode><NodeID>5493001KJTIIGC8Y1R12</NodeID></StartNode>
      <EndNode><NodeID>529900T8BM49AURSDO55</NodeID></EndNode>
      <RelationshipType>IS_ULTIMATELY_CONSOLIDATED_BY</RelationshipType>
      <RelationshipStatus>ACTIVE</RelationshipStatus>
      <RelationshipPeriods><RelationshipPeriod><StartDate>2020-01-01</StartDate></RelationshipPeriod></RelationshipPeriods>
    </Relationship></RelationshipRecord>
    <RelationshipRecord><Relationship>
      <StartNode><NodeID>213800MINIMAL00000X1</NodeID></StartNode>
      <EndNode><NodeID>529900T8BM49AURSDO55</NodeID></EndNode>
      <RelationshipType>IS_DIRECTLY_CONSOLIDATED_BY</RelationshipType>
    </Relationship></RelationshipRecord>
  </RelationshipRecords>
</RelationshipData>`;

/** A `lei:`-prefixed record tag with unprefixed inner elements — the scanner must
 *  find the prefixed record boundary; parseOneLei normalizes the inner fields. */
const LEI_L1_PREFIXED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<lei:LEIData xmlns:lei="http://www.gleif.org/data/schema/leidata/2016">
  <lei:LEIRecords>
    <lei:LEIRecord>
      <LEI>PREFIX0000000000000X</LEI>
      <Entity><LegalName>Prefixed Record Co</LegalName><LegalJurisdiction>DE</LegalJurisdiction></Entity>
      <Registration><RegistrationStatus>ISSUED</RegistrationStatus></Registration>
    </lei:LEIRecord>
  </lei:LEIRecords>
</lei:LEIData>`;

const RR_L2_PREFIXED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rr:RelationshipData xmlns:rr="http://www.gleif.org/data/schema/rr/2016">
  <rr:RelationshipRecords>
    <rr:RelationshipRecord><Relationship>
      <StartNode><NodeID>PREFIX0000000000000X</NodeID></StartNode>
      <EndNode><NodeID>529900T8BM49AURSDO55</NodeID></EndNode>
      <RelationshipType>IS_DIRECTLY_CONSOLIDATED_BY</RelationshipType>
    </Relationship></rr:RelationshipRecord>
  </rr:RelationshipRecords>
</rr:RelationshipData>`;

async function* chunkStr(s: string, size: number): AsyncGenerator<string> {
  for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size);
}

async function* chunkBytes(b: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

/** Build a single-entry ZIP with a raw-deflate member in the streaming
 *  (data-descriptor, general-purpose bit 3) style the GLEIF golden copy uses:
 *  the local header reports size 0 and a data descriptor + central directory
 *  trail the deflate stream. */
function buildDeflateZip(data: Buffer): Buffer {
  const name = Buffer.from('lei.xml');
  const deflated = deflateRawSync(data);
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
  lfh.writeUInt16LE(0x0008, 6); // general-purpose bit flag: bit 3 (data descriptor)
  lfh.writeUInt16LE(8, 8); // method 8 = deflate
  lfh.writeUInt32LE(0, 18); // compressed size 0 → in the trailing data descriptor
  lfh.writeUInt32LE(0, 22); // uncompressed size 0
  lfh.writeUInt16LE(name.length, 26);
  lfh.writeUInt16LE(0, 28); // extra length
  const dd = Buffer.alloc(16);
  dd.writeUInt32LE(0x08074b50, 0); // data descriptor signature
  dd.writeUInt32LE(deflated.length, 8);
  dd.writeUInt32LE(data.length, 12);
  const cd = Buffer.alloc(4);
  cd.writeUInt32LE(0x02014b50, 0); // central directory signature (inflate ignores it)
  return Buffer.concat([lfh, name, deflated, dd, cd]);
}

describe('GLEIF streaming L1 — equivalence with the DOM parser', () => {
  it('emits identical records across awkward text chunk sizes', async () => {
    const oracle = parseLeiLevel1(parseXml(MULTI_L1_XML));
    expect(oracle.length).toBe(3);
    for (const size of [1, 3, 7, 64, 100_000]) {
      const streamed = await collect(streamLeiLevel1FromText(chunkStr(MULTI_L1_XML, size)));
      expect(streamed, `chunk size ${size}`).toEqual(oracle);
    }
  });

  it('emits identical records through gzip, ZIP-deflate, and plain byte streams', async () => {
    const oracle = parseLeiLevel1(parseXml(MULTI_L1_XML));
    const xml = Buffer.from(MULTI_L1_XML, 'utf8');
    expect(await collect(streamLeiLevel1FromBytes(chunkBytes(gzipSync(xml), 16)))).toEqual(oracle);
    expect(await collect(streamLeiLevel1FromBytes(chunkBytes(buildDeflateZip(xml), 16)))).toEqual(
      oracle,
    );
    // Plain XML at 1-byte chunks splits every multi-byte UTF-8 character across the
    // streaming TextDecoder boundary.
    expect(await collect(streamLeiLevel1FromBytes(chunkBytes(xml, 1)))).toEqual(oracle);
  });

  it('extracts a lei:-prefixed record tag', async () => {
    const streamed = await collect(streamLeiLevel1FromText(chunkStr(LEI_L1_PREFIXED_XML, 5)));
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.lei).toBe('PREFIX0000000000000X');
    expect(streamed[0]?.legalName).toBe('Prefixed Record Co');
  });

  it('emits records identical to the DOM parser on the fully namespace-prefixed corpus', async () => {
    const oracle = parseLeiLevel1(parseXml(LEI_L1_FULLY_PREFIXED_XML));
    expect(oracle).toHaveLength(3);
    for (const size of [1, 5, 64, 100_000]) {
      const streamed = await collect(
        streamLeiLevel1FromText(chunkStr(LEI_L1_FULLY_PREFIXED_XML, size)),
      );
      expect(streamed, `chunk size ${size}`).toEqual(oracle);
    }
    // …and decompressed from a ZIP-deflate byte stream (the golden-copy container).
    const zip = buildDeflateZip(Buffer.from(LEI_L1_FULLY_PREFIXED_XML, 'utf8'));
    expect(await collect(streamLeiLevel1FromBytes(chunkBytes(zip, 16)))).toEqual(oracle);
  });
});

describe('GLEIF streaming L2 — equivalence with the DOM parser', () => {
  it('emits identical records across awkward text chunk sizes', async () => {
    const oracle = parseLeiLevel2(parseXml(MULTI_L2_XML));
    expect(oracle.length).toBe(2);
    for (const size of [1, 3, 7, 64, 100_000]) {
      const streamed = await collect(streamLeiLevel2FromText(chunkStr(MULTI_L2_XML, size)));
      expect(streamed, `chunk size ${size}`).toEqual(oracle);
    }
  });

  it('emits identical records through a ZIP-deflate byte stream', async () => {
    const oracle = parseLeiLevel2(parseXml(MULTI_L2_XML));
    const zip = buildDeflateZip(Buffer.from(MULTI_L2_XML, 'utf8'));
    expect(await collect(streamLeiLevel2FromBytes(chunkBytes(zip, 16)))).toEqual(oracle);
  });

  it('extracts an rr:-prefixed record tag', async () => {
    const streamed = await collect(streamLeiLevel2FromText(chunkStr(RR_L2_PREFIXED_XML, 5)));
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.childLei).toBe('PREFIX0000000000000X');
    expect(streamed[0]?.relationshipType).toBe('IS_DIRECTLY_CONSOLIDATED_BY');
  });

  it('emits records identical to the DOM parser on the fully namespace-prefixed corpus', async () => {
    const oracle = parseLeiLevel2(parseXml(RR_L2_FULLY_PREFIXED_XML));
    expect(oracle).toHaveLength(2);
    for (const size of [1, 5, 64, 100_000]) {
      const streamed = await collect(
        streamLeiLevel2FromText(chunkStr(RR_L2_FULLY_PREFIXED_XML, size)),
      );
      expect(streamed, `chunk size ${size}`).toEqual(oracle);
    }
    const zip = buildDeflateZip(Buffer.from(RR_L2_FULLY_PREFIXED_XML, 'utf8'));
    expect(await collect(streamLeiLevel2FromBytes(chunkBytes(zip, 16)))).toEqual(oracle);
  });

  it('yields nothing for a document with only the empty container', async () => {
    const streamed = await collect(
      streamLeiLevel2FromText(
        chunkStr('<RelationshipData><RelationshipRecords/></RelationshipData>', 4),
      ),
    );
    expect(streamed).toHaveLength(0);
  });
});
