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
import { createRejections } from '@/services/screening/ingest-validation.js';
import {
  createHarvestState,
  type HarvestState,
  parseEu,
  parseOfac,
  parseUk,
  parseUn,
  streamEuFromText,
  streamOfacFromText,
  streamUkFromText,
  streamUnFromText,
} from '@/services/screening/sanctions-ingest.js';
import type { NormalizedDesignation } from '@/services/screening/types.js';
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

  it('normalizes a sparse OFAC standard entry carrying only a uid and a surname', () => {
    const [designation] = parseOfac(
      parseXml(
        '<sdnList><sdnEntry><uid>777</uid><lastName>SOLENAME</lastName></sdnEntry></sdnList>',
      ),
      'ofac_sdn',
    );
    expect(designation).toMatchObject({
      id: 'ofac_sdn:777',
      sourceEntryId: '777',
      primaryName: 'SOLENAME',
      entityType: 'unknown',
    });
  });

  it('drops entries whose source published no stable identifier', () => {
    const ofacStandard = parseOfac(
      parseXml(
        '<sdnList><sdnEntry><firstName>No</firstName><lastName>Uid</lastName></sdnEntry></sdnList>',
      ),
      'ofac_sdn',
    );
    const ofacAdvanced = parseOfac(
      parseXml(
        '<Sanctions><DistinctParties><DistinctParty><Profile><Identity><Alias Primary="true"><DocumentedName><DocumentedNamePart><NamePartValue>No Ref</NamePartValue></DocumentedNamePart></DocumentedName></Alias></Identity></Profile></DistinctParty></DistinctParties></Sanctions>',
      ),
      'ofac_sdn',
    );
    const eu = parseEu(
      parseXml(
        '<export><sanctionEntity><nameAlias wholeName="Acme SA"/></sanctionEntity></export>',
      ),
    );
    const uk = parseUk(
      parseXml(
        '<Designations><Designation><Names><Name><Name6>Acme Ltd</Name6></Name></Names></Designation></Designations>',
      ),
    );
    const un = parseUn(
      parseXml(
        '<CONSOLIDATED_LIST><ENTITIES><ENTITY><FIRST_NAME>ACME UN</FIRST_NAME></ENTITY></ENTITIES></CONSOLIDATED_LIST>',
      ),
    );
    expect({ ofacStandard, ofacAdvanced, eu, uk, un }).toEqual({
      ofacStandard: [],
      ofacAdvanced: [],
      eu: [],
      uk: [],
      un: [],
    });
  });

  it('drops a name that decoded to a replacement character, and keeps it out of the aliases', () => {
    // What a lossy UTF-8 decode leaves behind for the invalid byte pair `c3 28`.
    const undecodable = '\uFFFD(';
    expect(
      parseOfac(
        parseXml(
          `<sdnList><sdnEntry><uid>801</uid><lastName>${undecodable}</lastName></sdnEntry></sdnList>`,
        ),
        'ofac_sdn',
      ),
    ).toHaveLength(0);

    const [designation] = parseOfac(
      parseXml(
        `<sdnList><sdnEntry><uid>802</uid><lastName>Readable Co</lastName><akaList><aka><lastName>${undecodable}</lastName></aka><aka><lastName>Readable Trading</lastName></aka></akaList></sdnEntry></sdnList>`,
      ),
      'ofac_sdn',
    );
    expect(designation?.payload.aliases).toEqual([{ name: 'Readable Trading', nameType: 'aka' }]);
  });

  it('drops nameless OFAC standard and GLEIF entries instead of naming them "Unknown"', () => {
    expect(
      parseOfac(parseXml('<sdnList><sdnEntry><uid>42</uid></sdnEntry></sdnList>'), 'ofac_sdn'),
    ).toEqual([]);
    expect(
      parseLeiLevel1(
        parseXml(
          '<LEIData><LEIRecords><LEIRecord><LEI>5493001KJTIIGC8Y1R12</LEI><Entity/></LEIRecord></LEIRecords></LEIData>',
        ),
      ),
    ).toEqual([]);
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

// ─── Sanctions streaming ingest (issue #13) ─────────────────────────────────────
//
// Each sanctions source now streams: the document is scanned for complete record
// elements and each is parsed alone, so a 120 MB OFAC document is never resident.
// The buffered whole-document parsers above are the equivalence oracle — a
// streamed parse must produce byte-identical normalized records, and the same
// per-source rejection tallies, for the same input. Documents are fed at awkward
// chunk sizes (down to 1) so every record boundary is split across chunks.

/**
 * A multi-record OFAC advanced document with the real element order: reference
 * sets, a large non-record region, parties, relationships, then the programme
 * block. Carries nesting depth (Profile → Identity → Alias → DocumentedName →
 * DocumentedNamePart, repeated at three levels), two dropped siblings, two
 * programme entries for one profile, and an orphan entry.
 */
const MULTI_OFAC_ADVANCED_XML = `<?xml version="1.0" encoding="utf-8"?>
<Sanctions xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML">
  <DateOfIssue><Year>2026</Year><Month>7</Month><Day>27</Day></DateOfIssue>
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
      <PartySubType ID="4" PartyTypeID="1">Unknown</PartySubType>
    </PartySubTypeValues>
  </ReferenceValueSets>
  <Locations>
    <Location ID="1"><LocationCountry><Country>US</Country></LocationCountry></Location>
    <Location ID="2"><LocationCountry><Country>CU</Country></LocationCountry></Location>
  </Locations>
  <IDRegDocuments><IDRegDocument ID="1"><IDRegistrationNo>X1</IDRegistrationNo></IDRegDocument></IDRegDocuments>
  <DistinctParties>
    <DistinctParty FixedRef="2674">
      <Profile ID="2674" PartySubTypeID="4">
        <Identity ID="4420" Primary="true">
          <Alias AliasTypeID="1403" Primary="true" LowQuality="false">
            <DocumentedName ID="2">
              <DocumentedNamePart><NamePartValue>ABBAS</NamePartValue></DocumentedNamePart>
              <DocumentedNamePart><NamePartValue>Abu</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
          <Alias AliasTypeID="1400" Primary="false" LowQuality="false">
            <DocumentedName ID="1">
              <DocumentedNamePart><NamePartValue>ZAYDAN</NamePartValue></DocumentedNamePart>
            </DocumentedName>
            <DocumentedName ID="3">
              <DocumentedNamePart><NamePartValue>Muhammad Abbas</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
          <Alias AliasTypeID="1401" Primary="false" LowQuality="true">
            <DocumentedName ID="4">
              <DocumentedNamePart><NamePartValue>Abu Abbas</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
        </Identity>
        <Feature FeatureTypeID="8">
          <FeatureVersion ID="1"><DatePeriod><Start><From>
            <Year>1948</Year><Month>12</Month><Day>10</Day>
          </From></Start></DatePeriod></FeatureVersion>
        </Feature>
        <Feature FeatureTypeID="9">
          <FeatureVersion ID="2"><VersionDetail DetailTypeID="1432">Safed, Israel</VersionDetail></FeatureVersion>
        </Feature>
      </Profile>
    </DistinctParty>
    <DistinctParty>
      <Profile PartySubTypeID="4"><Identity><Alias AliasTypeID="1403" Primary="true">
        <DocumentedName><DocumentedNamePart><NamePartValue>No Fixed Ref</NamePartValue></DocumentedNamePart></DocumentedName>
      </Alias></Identity></Profile>
    </DistinctParty>
    <DistinctParty FixedRef="4238">
      <Profile ID="4238" PartySubTypeID="1">
        <Identity ID="9001" Primary="true">
          <Alias AliasTypeID="1403" Primary="true" LowQuality="false">
            <DocumentedName ID="5"><DocumentedNamePart><NamePartValue>MAR AZUL</NamePartValue></DocumentedNamePart></DocumentedName>
          </Alias>
        </Identity>
      </Profile>
    </DistinctParty>
    <DistinctParty FixedRef="5000"><Profile ID="5000" PartySubTypeID="4"/></DistinctParty>
  </DistinctParties>
  <ProfileRelationships><ProfileRelationship ID="1" From="2674" To="4238"/></ProfileRelationships>
  <SanctionsEntries>
    <SanctionsEntry ID="1" ProfileID="2674" ListID="1550">
      <EntryEvent ID="1"><Date><Year>1995</Year><Month>1</Month><Day>23</Day></Date></EntryEvent>
      <SanctionsMeasure ID="1"><Comment>SDGT</Comment></SanctionsMeasure>
      <SanctionsMeasure ID="2"><Comment>SDT</Comment></SanctionsMeasure>
    </SanctionsEntry>
    <SanctionsEntry ID="2" ProfileID="4238" ListID="1550">
      <EntryEvent ID="2"><Date><Year>1989</Year><Month>1</Month><Day>5</Day></Date></EntryEvent>
      <SanctionsMeasure ID="3"><Comment>CUBA</Comment></SanctionsMeasure>
    </SanctionsEntry>
    <SanctionsEntry ID="3" ProfileID="2674" ListID="1551">
      <EntryEvent ID="3"><Date><Year>2001</Year><Month>9</Month><Day>11</Day></Date></EntryEvent>
    </SanctionsEntry>
    <SanctionsEntry ID="4" ProfileID="99999" ListID="1550">
      <SanctionsMeasure ID="4"><Comment>ORPHAN</Comment></SanctionsMeasure>
    </SanctionsEntry>
  </SanctionsEntries>
</Sanctions>`;

/** The OFAC standard schema, which a URL override can still point the ingest at. */
const MULTI_OFAC_STANDARD_XML = `<?xml version="1.0"?><sdnList>
  <sdnEntry>
    <uid>12345</uid><firstName>Example</firstName><lastName>Person</lastName><sdnType>Individual</sdnType>
    <program>SDGT</program>
    <akaList>
      <aka><category>strong</category><firstName>Example</firstName><lastName>Alias</lastName></aka>
      <aka><category>weak</category><lastName>Shortname</lastName></aka>
    </akaList>
    <idList><id><idType>Passport</idType><idNumber>P123</idNumber><idCountry>Testland</idCountry></id></idList>
    <addressList><address><address1>1 Test Way</address1><city>Test City</city><country>Testland</country></address></addressList>
    <dateOfBirthList><dateOfBirthItem><dateOfBirth>1980-01-02</dateOfBirth></dateOfBirthItem></dateOfBirthList>
    <nationalityList><nationality><country>Testland</country></nationality></nationalityList>
    <remarks>Designated on 2015-06-07 under the programme.</remarks>
  </sdnEntry>
  <sdnEntry><firstName>Missing</firstName><lastName>Uid</lastName></sdnEntry>
  <sdnEntry><uid>777</uid></sdnEntry>
  <sdnEntry><uid>778</uid><lastName>SOLENAME</lastName></sdnEntry>
</sdnList>`;

const MULTI_EU_XML = `<?xml version="1.0" encoding="UTF-8"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export">
  <sanctionEntity logicalId="13" euReferenceNumber="EU.27.28">
    <regulation regulationType="regulation" programme="IRQ" publicationDate="2003-07-08"/>
    <subjectType code="person" classificationCode="P"/>
    <nameAlias firstName="Saddam" lastName="Hussein Al-Tikriti" wholeName="Saddam Hussein Al-Tikriti" strong="true"/>
    <nameAlias wholeName="Abu Ali" strong="false"/>
    <nameAlias firstName="Saddam" lastName="Hussein"/>
    <birthdate birthdate="1937-04-28"/>
    <birthdate birthdate="1937-04-29"/>
    <citizenship countryDescription="Iraq"/>
    <citizenship countryDescription="Société Générale"/>
  </sanctionEntity>
  <sanctionEntity euReferenceNumber="EU.99.9">
    <subjectType code="enterprise"/>
    <nameAlias wholeName="Reference Number Only Ltd" strong="true"/>
  </sanctionEntity>
  <sanctionEntity><nameAlias wholeName="No Identifier SA"/></sanctionEntity>
  <sanctionEntity logicalId="77"><subjectType code="person"/></sanctionEntity>
</export>`;

const MULTI_UK_XML = `<?xml version="1.0" encoding="utf-8"?>
<Designations>
  <DateGenerated>10/06/2026</DateGenerated>
  <Designation>
    <LastUpdated>16/04/2026</LastUpdated><DateDesignated>29/06/2012</DateDesignated>
    <UniqueID>AFG0001</UniqueID><RegimeName>Afghanistan</RegimeName>
    <IndividualEntityShip>Entity</IndividualEntityShip>
    <Names>
      <Name><Name6>HAJI KHAIRULLAH MONEY EXCHANGE</Name6><NameType>Primary Name</NameType></Name>
      <Name><Name6>Haji Alim Hawala</Name6><NameType>Alias</NameType></Name>
      <Name><Name1>Abdul</Name1><Name2>Satar</Name2><Name6>Abdul Manan</Name6><NameType>Alias</NameType></Name>
    </Names>
    <Nationalities><Nationality>Afghanistan</Nationality><Nationality>Pakistan</Nationality></Nationalities>
    <OtherInformation>Money exchange business.</OtherInformation>
  </Designation>
  <Designation>
    <OFSIGroupID>UK-GRP-2</OFSIGroupID><GroupType>Ship</GroupType>
    <Names><Names><WholeName>Ignored Nested</WholeName></Names><Name><WholeName>MV Example</WholeName></Name></Names>
  </Designation>
  <Designation><Names><Name><Name6>No Identifier Ltd</Name6></Name></Names></Designation>
  <Designation><UniqueID>UK-EMPTY</UniqueID></Designation>
</Designations>`;

const MULTI_UN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CONSOLIDATED_LIST>
  <INDIVIDUALS>
    <INDIVIDUAL>
      <DATAID>6907993</DATAID>
      <FIRST_NAME>ERIC</FIRST_NAME><SECOND_NAME>BADEGE</SECOND_NAME>
      <UN_LIST_TYPE>DRC</UN_LIST_TYPE><LISTED_ON>2012-12-31</LISTED_ON>
      <COMMENTS1>Colonel in the armed forces.</COMMENTS1>
      <NATIONALITY><VALUE>Democratic Republic of the Congo</VALUE></NATIONALITY>
      <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Eric Badegé</ALIAS_NAME></INDIVIDUAL_ALIAS>
      <INDIVIDUAL_ALIAS><QUALITY>Low</QUALITY><ALIAS_NAME>E. Badege</ALIAS_NAME></INDIVIDUAL_ALIAS>
      <INDIVIDUAL_DATE_OF_BIRTH><DATE>1971-01-01</DATE></INDIVIDUAL_DATE_OF_BIRTH>
      <INDIVIDUAL_DATE_OF_BIRTH><YEAR>1972</YEAR></INDIVIDUAL_DATE_OF_BIRTH>
      <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>Passport</TYPE_OF_DOCUMENT><NUMBER>X1</NUMBER><ISSUING_COUNTRY>DRC</ISSUING_COUNTRY></INDIVIDUAL_DOCUMENT>
    </INDIVIDUAL>
    <INDIVIDUAL><FIRST_NAME>NO</FIRST_NAME><SECOND_NAME>DATAID</SECOND_NAME></INDIVIDUAL>
    <INDIVIDUAL><DATAID>6907994</DATAID></INDIVIDUAL>
  </INDIVIDUALS>
  <ENTITIES>
    <ENTITY>
      <DATAID>6908100</DATAID><FIRST_NAME>EXAMPLE UN ENTITY</FIRST_NAME>
      <UN_LIST_TYPE>DRC</UN_LIST_TYPE><LISTED_ON>2013-01-01</LISTED_ON>
      <ENTITY_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Example Trading</ALIAS_NAME></ENTITY_ALIAS>
    </ENTITY>
    <ENTITY><REFERENCE_NUMBER>UN-REF-9</REFERENCE_NUMBER><FIRST_NAME>REFERENCE ONLY</FIRST_NAME></ENTITY>
  </ENTITIES>
</CONSOLIDATED_LIST>`;

/** Chunk sizes that split every record boundary and multi-byte character. */
const CHUNK_SIZES = [1, 3, 7, 64, 1_000_000] as const;

async function streamAll(
  stream: (
    chunks: AsyncIterable<string>,
    state: HarvestState,
  ) => AsyncGenerator<NormalizedDesignation>,
  xml: string,
  size: number,
): Promise<{ records: NormalizedDesignation[]; state: HarvestState }> {
  const state = createHarvestState();
  const records = await collect(stream(chunkStr(xml, size), state));
  return { records, state };
}

/**
 * The streamed OFAC record as the mirror ends up holding it: the party as
 * emitted, plus the programme columns the deferred join applies afterwards.
 * Both columns are nullable, so absence stays absence.
 */
function withDeferred(
  records: NormalizedDesignation[],
  state: HarvestState,
): NormalizedDesignation[] {
  return records.map((record) => {
    const fields = state.deferredFields.get(record.sourceEntryId);
    return {
      ...record,
      ...(fields?.program ? { program: fields.program } : {}),
      ...(fields?.designationDate ? { designationDate: fields.designationDate } : {}),
    };
  });
}

describe('sanctions streaming ingest — equivalence with the buffered parsers', () => {
  it('OFAC advanced: streamed records match, once the deferred programme join lands', async () => {
    const rejections = createRejections();
    const oracle = parseOfac(parseXml(MULTI_OFAC_ADVANCED_XML), 'ofac_sdn', rejections);
    expect(oracle.map((d) => d.sourceEntryId)).toEqual(['2674', '4238']);
    expect(oracle[0]?.program).toBe('SDGT, SDT');
    // The second entry for profile 2674 publishes only a date, so it overrides
    // the date and leaves the earlier programme in place.
    expect(oracle[0]?.designationDate).toBe('2001-09-11');
    expect(rejections).toEqual({ missingIdentifier: 1, unusableName: 1 });

    for (const size of CHUNK_SIZES) {
      const { records, state } = await streamAll(
        (chunks, s) => streamOfacFromText(chunks, 'ofac_sdn', s),
        MULTI_OFAC_ADVANCED_XML,
        size,
      );
      expect(withDeferred(records, state), `chunk size ${size}`).toEqual(oracle);
      expect(state.rejections, `chunk size ${size}`).toEqual(rejections);
      // The orphan programme entry is carried, and patches nothing downstream.
      expect(state.deferredFields.get('99999')).toEqual({ program: 'ORPHAN' });
    }
  });

  it('OFAC standard: streamed records match the buffered parse', async () => {
    const rejections = createRejections();
    const oracle = parseOfac(parseXml(MULTI_OFAC_STANDARD_XML), 'ofac_sdn', rejections);
    expect(oracle.map((d) => d.sourceEntryId)).toEqual(['12345', '778']);
    expect(rejections).toEqual({ missingIdentifier: 1, unusableName: 1 });

    for (const size of CHUNK_SIZES) {
      const { records, state } = await streamAll(
        (chunks, s) => streamOfacFromText(chunks, 'ofac_sdn', s),
        MULTI_OFAC_STANDARD_XML,
        size,
      );
      expect(records, `chunk size ${size}`).toEqual(oracle);
      expect(state.rejections, `chunk size ${size}`).toEqual(rejections);
      expect(state.deferredFields.size).toBe(0);
    }
  });

  it.each([
    ['EU', MULTI_EU_XML, parseEu, streamEuFromText, ['13', 'EU.99.9']],
    ['UK', MULTI_UK_XML, parseUk, streamUkFromText, ['AFG0001', 'UK-GRP-2']],
    ['UN', MULTI_UN_XML, parseUn, streamUnFromText, ['6907993', '6908100', 'UN-REF-9']],
  ] as const)(
    '%s: streamed records match the buffered parse across chunk boundaries',
    async (_label, xml, parse, stream, expectedIds) => {
      const rejections = createRejections();
      const oracle = parse(parseXml(xml), rejections);
      expect(oracle.map((d) => d.sourceEntryId)).toEqual(expectedIds);
      expect(rejections.missingIdentifier + rejections.unusableName).toBeGreaterThan(0);

      for (const size of CHUNK_SIZES) {
        const { records, state } = await streamAll(stream, xml, size);
        expect(records, `chunk size ${size}`).toEqual(oracle);
        expect(state.rejections, `chunk size ${size}`).toEqual(rejections);
      }
    },
  );
});

describe('sanctions streaming ingest — document boundaries', () => {
  it.each([
    ['EU', streamEuFromText, '<export></export>'],
    [
      'UK',
      streamUkFromText,
      '<Designations><DateGenerated>10/06/2026</DateGenerated></Designations>',
    ],
    ['UN', streamUnFromText, '<CONSOLIDATED_LIST><INDIVIDUALS/><ENTITIES/></CONSOLIDATED_LIST>'],
  ] as const)('%s: an empty document yields nothing', async (_label, stream, xml) => {
    for (const size of [1, 4, 1_000_000]) {
      expect((await streamAll(stream, xml, size)).records).toHaveLength(0);
    }
  });

  it('an empty OFAC document yields nothing and defers nothing', async () => {
    const { records, state } = await streamAll(
      (chunks, s) => streamOfacFromText(chunks, 'ofac_sdn', s),
      '<Sanctions><ReferenceValueSets/><DistinctParties/><SanctionsEntries/></Sanctions>',
      4,
    );
    expect(records).toHaveLength(0);
    expect(state.deferredFields.size).toBe(0);
    expect(state.rejections).toEqual({ missingIdentifier: 0, unusableName: 0 });
  });

  it('a single record with no siblings is emitted whole', async () => {
    const xml =
      '<export><sanctionEntity logicalId="solo"><subjectType code="person"/><nameAlias wholeName="Solo Person"/></sanctionEntity></export>';
    for (const size of [1, 5, 1_000_000]) {
      const { records } = await streamAll(streamEuFromText, xml, size);
      expect(
        records.map((d) => d.primaryName),
        `chunk size ${size}`,
      ).toEqual(['Solo Person']);
    }
  });

  it('drops a truncated trailing record but keeps the complete ones before it', async () => {
    const truncated = `${MULTI_EU_XML.slice(0, MULTI_EU_XML.indexOf('<sanctionEntity euReferenceNumber'))}<sanctionEntity logicalId="cut"><nameAlias wholeName="Never Clo`;
    for (const size of [1, 9, 1_000_000]) {
      const { records } = await streamAll(streamEuFromText, truncated, size);
      expect(
        records.map((d) => d.sourceEntryId),
        `chunk size ${size}`,
      ).toEqual(['13']);
    }
  });

  it('drops an OFAC party whose closing tag never arrives', async () => {
    const cut = MULTI_OFAC_ADVANCED_XML.slice(
      0,
      MULTI_OFAC_ADVANCED_XML.indexOf('<DistinctParty>'),
    );
    const { records, state } = await streamAll(
      (chunks, s) => streamOfacFromText(chunks, 'ofac_sdn', s),
      `${cut}<DistinctParty FixedRef="9"><Profile ID="9"`,
      7,
    );
    expect(records.map((d) => d.sourceEntryId)).toEqual(['2674']);
    // Truncation is not a rejection — the record was never seen whole.
    expect(state.rejections).toEqual({ missingIdentifier: 0, unusableName: 0 });
  });

  it('never mistakes a container element for the record it contains', async () => {
    // <DistinctParties>, <SanctionsEntries>, <INDIVIDUALS>, <ENTITIES>, and the
    // <Designations> root all prefix a record name they must not match.
    const { records } = await streamAll(streamUnFromText, MULTI_UN_XML, 3);
    expect(records.map((d) => d.entityType)).toEqual(['person', 'organization', 'organization']);
    const uk = await streamAll(streamUkFromText, MULTI_UK_XML, 3);
    expect(uk.records.map((d) => d.sourceEntryId)).toEqual(['AFG0001', 'UK-GRP-2']);
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
