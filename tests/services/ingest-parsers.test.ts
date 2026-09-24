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

// ─── Detail groups already populated (pinned before issue #22) ─────────────────
//
// The groups each normalizer read before the detail-group fix, in the shape it
// read them. The fix widens what each group reads; none of these must change.

describe('sanctions detail groups — shapes that were already read', () => {
  it('OFAC advanced: one Birthdate and one Place of Birth stay one paired entry', () => {
    const [d] = parseOfac(
      parseXml(`<Sanctions>
        <ReferenceValueSets>
          <AliasTypeValues><AliasType ID="1403">Name</AliasType></AliasTypeValues>
          <FeatureTypeValues><FeatureType ID="8">Birthdate</FeatureType><FeatureType ID="9">Place of Birth</FeatureType></FeatureTypeValues>
        </ReferenceValueSets>
        <DistinctParties><DistinctParty FixedRef="1"><Profile ID="1"><Identity ID="1">
          <Alias AliasTypeID="1403" Primary="true"><DocumentedName><DocumentedNamePart><NamePartValue>One Person</NamePartValue></DocumentedNamePart></DocumentedName></Alias>
          </Identity>
          <Feature ID="1" FeatureTypeID="8"><FeatureVersion ID="1"><DatePeriod><Start><From><Year>1962</Year><Month>11</Month><Day>23</Day></From></Start></DatePeriod></FeatureVersion></Feature>
          <Feature ID="2" FeatureTypeID="9"><FeatureVersion ID="2"><VersionDetail DetailTypeID="1432">Caracas, Venezuela</VersionDetail></FeatureVersion></Feature>
        </Profile></DistinctParty></DistinctParties>
      </Sanctions>`),
      'ofac_sdn',
    );
    expect(d?.payload.datesOfBirth).toEqual([{ date: '1962-11-23', place: 'Caracas, Venezuela' }]);
  });

  it('OFAC standard: identifiers, the address order, dates, and nationalities', () => {
    const [d] = parseOfac(
      parseXml(`<sdnList><sdnEntry><uid>9</uid><lastName>ORDER CO</lastName>
        <idList><id><idType>Cedula No.</idType><idNumber>5892464</idNumber><idCountry>Venezuela</idCountry></id></idList>
        <addressList><address><address1>1 Main</address1><address2>Unit 2</address2><city>Caracas</city><stateOrProvince>Capital District</stateOrProvince><postalCode>1010</postalCode><country>Venezuela</country></address></addressList>
        <dateOfBirthList><dateOfBirthItem><dateOfBirth>23 Nov 1962</dateOfBirth></dateOfBirthItem></dateOfBirthList>
        <nationalityList><nationality><country>Venezuela</country></nationality></nationalityList>
      </sdnEntry></sdnList>`),
      'ofac_sdn',
    );
    expect(d?.payload).toMatchObject({
      identifiers: [{ type: 'Cedula No.', value: '5892464', country: 'Venezuela' }],
      addresses: [
        {
          full: '1 Main, Unit 2, Caracas, Capital District, 1010, Venezuela',
          country: 'Venezuela',
        },
      ],
      datesOfBirth: [{ date: '23 Nov 1962' }],
      nationalities: ['Venezuela'],
    });
  });

  it('EU: a full birthdate and the citizenship country', () => {
    const [d] = parseEu(
      parseXml(`<export><sanctionEntity logicalId="1"><subjectType code="person"/>
        <nameAlias wholeName="Full Date Person" strong="true"/>
        <birthdate birthdate="1960-04-10" year="1960"/>
        <citizenship countryIso2Code="US" countryDescription="UNITED STATES"/>
      </sanctionEntity></export>`),
    );
    expect(d?.payload.datesOfBirth).toEqual([{ date: '1960-04-10' }]);
    expect(d?.payload.nationalities).toEqual(['UNITED STATES']);
  });

  it('UN: a document with its issuing country, DATE and YEAR births, and nationalities', () => {
    const [d] = parseUn(
      parseXml(`<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL>
        <DATAID>1</DATAID><FIRST_NAME>DOC</FIRST_NAME><SECOND_NAME>PERSON</SECOND_NAME>
        <NATIONALITY><VALUE>Oman</VALUE><VALUE>Yemen</VALUE></NATIONALITY>
        <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1965-12-28</DATE></INDIVIDUAL_DATE_OF_BIRTH>
        <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>APPROXIMATELY</TYPE_OF_DATE><YEAR>1966</YEAR></INDIVIDUAL_DATE_OF_BIRTH>
        <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>Passport</TYPE_OF_DOCUMENT><NUMBER>03824970</NUMBER><ISSUING_COUNTRY>Oman</ISSUING_COUNTRY></INDIVIDUAL_DOCUMENT>
      </INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>`),
    );
    expect(d?.payload).toMatchObject({
      identifiers: [{ type: 'Passport', value: '03824970', country: 'Oman' }],
      datesOfBirth: [{ date: '1965-12-28' }, { date: '1966' }],
      nationalities: ['Oman', 'Yemen'],
    });
  });
});

// ─── Published designation details (issue #22) ─────────────────────────────────
//
// Each source publishes identifiers, addresses, dates and places of birth, and
// nationalities; each normalizer must carry them. Absence stays absence: no
// empty, `UNKNOWN`, or `undetermined` value, no group inferred from another, and
// no date paired with a place unless the record publishes exactly one of each.

/**
 * OFAC advanced in the published cross-reference shape. `<Locations>` and
 * `<IDRegDocuments>` sit between the reference sets and the parties, and every
 * link is a numeric id resolved through `<ReferenceValueSets>`: a `Location`
 * feature's `VersionLocation` → `<Location>` parts + `LocationCountry`; a
 * Nationality/Citizenship feature → a `<Location>` whose only part is the
 * type-1 country name; an `<IDRegDocument IdentityID>` → the party's
 * `<Identity ID>`. Location 500 lists its parts out of address order and
 * carries original-script variants; Location 80 is OFAC's `undetermined`
 * placeholder; Location 424242 is never published (a dangling reference).
 */
const DETAIL_OFAC_ADVANCED_XML = `<?xml version="1.0" encoding="utf-8"?>
<Sanctions xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML">
  <DateOfIssue CalendarTypeID="1"><Year>2026</Year><Month>9</Month><Day>23</Day></DateOfIssue>
  <ReferenceValueSets>
    <AliasTypeValues><AliasType ID="1400">A.K.A.</AliasType><AliasType ID="1403">Name</AliasType></AliasTypeValues>
    <AreaCodeValues>
      <AreaCode ID="11216" CountryID="11216" Description="Venezuela" AreaCodeTypeID="1">VE</AreaCode>
      <AreaCode ID="11291" CountryID="11291" Description="undetermined" AreaCodeTypeID="1" />
    </AreaCodeValues>
    <CountryValues>
      <Country ID="11115" ISO2="JP">Japan</Country>
      <Country ID="11216" ISO2="VE">Venezuela</Country>
      <Country ID="11291">undetermined</Country>
    </CountryValues>
    <FeatureTypeValues>
      <FeatureType ID="8" FeatureTypeGroupID="1">Birthdate</FeatureType>
      <FeatureType ID="9" FeatureTypeGroupID="1">Place of Birth</FeatureType>
      <FeatureType ID="10" FeatureTypeGroupID="1">Nationality Country</FeatureType>
      <FeatureType ID="11" FeatureTypeGroupID="1">Citizenship Country</FeatureType>
      <FeatureType ID="25" FeatureTypeGroupID="1">Location</FeatureType>
      <FeatureType ID="224" FeatureTypeGroupID="1">Gender</FeatureType>
    </FeatureTypeValues>
    <IDRegDocTypeValues>
      <IDRegDocType ID="1570">Cedula No.</IDRegDocType>
      <IDRegDocType ID="1571">Passport</IDRegDocType>
    </IDRegDocTypeValues>
    <LocPartTypeValues>
      <LocPartType ID="1">Unknown</LocPartType>
      <LocPartType ID="1450">REGION</LocPartType>
      <LocPartType ID="1451">ADDRESS1</LocPartType>
      <LocPartType ID="1452">ADDRESS2</LocPartType>
      <LocPartType ID="1453">ADDRESS3</LocPartType>
      <LocPartType ID="1454">CITY</LocPartType>
      <LocPartType ID="1455">STATE/PROVINCE</LocPartType>
      <LocPartType ID="1456">POSTAL CODE</LocPartType>
    </LocPartTypeValues>
    <PartySubTypeValues><PartySubType ID="4" PartyTypeID="1">Unknown</PartySubType></PartySubTypeValues>
  </ReferenceValueSets>
  <Locations>
    <Location ID="80">
      <LocationAreaCode AreaCodeID="11291" />
      <FeatureVersionReference FeatureVersionID="200080" />
    </Location>
    <Location ID="34442">
      <LocationAreaCode AreaCodeID="11216" />
      <LocationCountry CountryID="11216" CountryRelevanceID="1413" />
      <LocationPart LocPartTypeID="1454">
        <LocationPartValue Primary="true" LocPartValueTypeID="1" LocPartValueStatusID="1"><Comment /><Value>Caracas</Value></LocationPartValue>
      </LocationPart>
      <LocationPart LocPartTypeID="1455">
        <LocationPartValue Primary="true" LocPartValueTypeID="1" LocPartValueStatusID="1"><Comment /><Value>Capital District</Value></LocationPartValue>
      </LocationPart>
      <FeatureVersionReference FeatureVersionID="234442" />
    </Location>
    <Location ID="186216">
      <LocationPart LocPartTypeID="1">
        <LocationPartValue Primary="true" LocPartValueTypeID="1" LocPartValueStatusID="1"><Comment /><Value>Venezuela</Value></LocationPartValue>
      </LocationPart>
      <FeatureVersionReference FeatureVersionID="22000" />
      <FeatureVersionReference FeatureVersionID="31000" />
      <FeatureVersionReference FeatureVersionID="31001" />
    </Location>
    <Location ID="186300">
      <LocationPart LocPartTypeID="1">
        <LocationPartValue Primary="true" LocPartValueTypeID="1" LocPartValueStatusID="1"><Comment /><Value>Japan</Value></LocationPartValue>
      </LocationPart>
    </Location>
    <Location ID="500">
      <LocationAreaCode AreaCodeID="11115" />
      <LocationCountry CountryID="11115" CountryRelevanceID="1413" />
      <LocationPart LocPartTypeID="1456">
        <LocationPartValue Primary="true" LocPartValueTypeID="1" LocPartValueStatusID="1"><Comment /><Value>453-0015</Value></LocationPartValue>
      </LocationPart>
      <LocationPart LocPartTypeID="1454">
        <LocationPartValue Primary="false" LocPartValueTypeID="1" LocPartValueStatusID="1"><Comment>Japanese</Comment><Value>名古屋市</Value></LocationPartValue>
        <LocationPartValue Primary="true" LocPartValueTypeID="1" LocPartValueStatusID="1"><Comment /><Value>Nagoya</Value></LocationPartValue>
      </LocationPart>
      <LocationPart LocPartTypeID="1452">
        <LocationPartValue Primary="true" LocPartValueTypeID="1" LocPartValueStatusID="1"><Comment /><Value>Suzuki &amp; Sons Building</Value></LocationPartValue>
      </LocationPart>
      <LocationPart LocPartTypeID="1451">
        <LocationPartValue Primary="true" LocPartValueTypeID="1" LocPartValueStatusID="1"><Comment /><Value>1-117 Shukuatocho, Nakamura Ward</Value></LocationPartValue>
        <LocationPartValue Primary="false" LocPartValueTypeID="1" LocPartValueStatusID="1"><Comment>Japanese</Comment><Value>1-117 宿跡町中村区</Value></LocationPartValue>
      </LocationPart>
    </Location>
  </Locations>
  <IDRegDocuments>
    <IDRegDocument ID="14375" IDRegDocTypeID="1570" IdentityID="14494" IssuedBy-CountryID="11216" ValidityID="1">
      <Comment />
      <IDRegistrationNo>5892464</IDRegistrationNo>
      <IssuingAuthority />
      <DocumentedNameReference DocumentedNameID="29345" />
    </IDRegDocument>
    <IDRegDocument ID="20001" IDRegDocTypeID="1571" IdentityID="7000" ValidityID="1">
      <Comment />
      <IDRegistrationNo>TZ0981234</IDRegistrationNo>
    </IDRegDocument>
    <IDRegDocument ID="20002" IDRegDocTypeID="1571" IdentityID="7000" ValidityID="2">
      <Comment />
      <IDRegistrationNo>TZ0981234</IDRegistrationNo>
    </IDRegDocument>
    <IDRegDocument ID="20003" IDRegDocTypeID="1570" IdentityID="7000" IssuedBy-CountryID="11115" ValidityID="1">
      <Comment />
      <IDRegistrationNo>JP-44</IDRegistrationNo>
    </IDRegDocument>
    <IDRegDocument ID="20004" IDRegDocTypeID="1570" IdentityID="99999" IssuedBy-CountryID="11216" ValidityID="1">
      <Comment />
      <IDRegistrationNo>ORPHAN-1</IDRegistrationNo>
    </IDRegDocument>
  </IDRegDocuments>
  <DistinctParties>
    <DistinctParty FixedRef="22790">
      <Comment />
      <Profile ID="22790" PartySubTypeID="4">
        <Identity ID="14494" FixedRef="22790" Primary="true" False="false">
          <Alias FixedRef="22790" AliasTypeID="1403" Primary="true" LowQuality="false">
            <DocumentedName ID="29345" FixedRef="22790" DocNameStatusID="1">
              <DocumentedNamePart><NamePartValue NamePartGroupID="57052">MADURO MOROS</NamePartValue></DocumentedNamePart>
              <DocumentedNamePart><NamePartValue NamePartGroupID="57053">Nicolas</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
        </Identity>
        <Feature ID="24258" FeatureTypeID="224">
          <FeatureVersion ID="21997" ReliabilityID="1"><Comment /><VersionDetail DetailTypeID="1431" DetailReferenceID="91526" /></FeatureVersion>
          <IdentityReference IdentityID="14494" IdentityFeatureLinkTypeID="1" />
        </Feature>
        <Feature ID="24259" FeatureTypeID="8">
          <FeatureVersion ID="21998" ReliabilityID="1">
            <Comment />
            <DatePeriod CalendarTypeID="1">
              <Start Approximate="false"><From><Year>1962</Year><Month>11</Month><Day>23</Day></From><To><Year>1962</Year><Month>11</Month><Day>23</Day></To></Start>
              <End Approximate="false"><From><Year>1962</Year><Month>11</Month><Day>23</Day></From><To><Year>1962</Year><Month>11</Month><Day>23</Day></To></End>
            </DatePeriod>
            <VersionDetail DetailTypeID="1430" />
          </FeatureVersion>
          <IdentityReference IdentityID="14494" IdentityFeatureLinkTypeID="1" />
        </Feature>
        <Feature ID="24260" FeatureTypeID="9">
          <FeatureVersion ID="21999" ReliabilityID="1"><Comment /><VersionDetail DetailTypeID="1432">Caracas, Venezuela</VersionDetail></FeatureVersion>
          <IdentityReference IdentityID="14494" IdentityFeatureLinkTypeID="1" />
        </Feature>
        <Feature ID="24261" FeatureTypeID="11">
          <FeatureVersion ID="22000" ReliabilityID="1"><Comment /><VersionDetail DetailTypeID="1433" /><VersionLocation LocationID="186216" /></FeatureVersion>
          <IdentityReference IdentityID="14494" IdentityFeatureLinkTypeID="1" />
        </Feature>
        <Feature ID="184442" FeatureTypeID="25">
          <FeatureVersion ID="234442" ReliabilityID="1"><Comment /><VersionLocation LocationID="34442" /></FeatureVersion>
          <IdentityReference IdentityID="14494" IdentityFeatureLinkTypeID="1" />
        </Feature>
      </Profile>
    </DistinctParty>
    <DistinctParty FixedRef="30001">
      <Comment />
      <Profile ID="30001" PartySubTypeID="4">
        <Identity ID="7000" FixedRef="30001" Primary="true" False="false">
          <Alias FixedRef="30001" AliasTypeID="1403" Primary="true" LowQuality="false">
            <DocumentedName ID="1"><DocumentedNamePart><NamePartValue>TANAKA Hiro</NamePartValue></DocumentedNamePart></DocumentedName>
          </Alias>
        </Identity>
        <Feature ID="30" FeatureTypeID="8">
          <FeatureVersion ID="30"><DatePeriod><Start><From><Year>1970</Year><Month>1</Month><Day>2</Day></From></Start></DatePeriod></FeatureVersion>
        </Feature>
        <Feature ID="31" FeatureTypeID="8">
          <FeatureVersion ID="31"><DatePeriod><Start><From><Year>1971</Year></From></Start></DatePeriod></FeatureVersion>
        </Feature>
        <Feature ID="32" FeatureTypeID="9">
          <FeatureVersion ID="32"><VersionDetail DetailTypeID="1432">Nagoya, Japan</VersionDetail></FeatureVersion>
        </Feature>
        <Feature ID="33" FeatureTypeID="10">
          <FeatureVersion ID="31000"><VersionLocation LocationID="186216" /></FeatureVersion>
        </Feature>
        <Feature ID="34" FeatureTypeID="11">
          <FeatureVersion ID="31001"><VersionLocation LocationID="186216" /></FeatureVersion>
        </Feature>
        <Feature ID="35" FeatureTypeID="10">
          <FeatureVersion ID="35"><VersionLocation LocationID="186300" /></FeatureVersion>
        </Feature>
        <Feature ID="36" FeatureTypeID="25">
          <FeatureVersion ID="36"><VersionLocation LocationID="500" /></FeatureVersion>
        </Feature>
        <Feature ID="37" FeatureTypeID="25">
          <FeatureVersion ID="37"><VersionLocation LocationID="80" /></FeatureVersion>
        </Feature>
        <Feature ID="38" FeatureTypeID="25">
          <FeatureVersion ID="38"><VersionLocation LocationID="424242" /></FeatureVersion>
        </Feature>
        <Feature ID="39" FeatureTypeID="25">
          <FeatureVersion ID="39"><VersionLocation LocationID="34442" /></FeatureVersion>
        </Feature>
      </Profile>
    </DistinctParty>
    <DistinctParty FixedRef="30002">
      <Comment />
      <Profile ID="30002" PartySubTypeID="4">
        <Identity ID="7001" FixedRef="30002" Primary="true" False="false">
          <Alias FixedRef="30002" AliasTypeID="1403" Primary="true" LowQuality="false">
            <DocumentedName ID="2"><DocumentedNamePart><NamePartValue>SPARSE Party</NamePartValue></DocumentedNamePart></DocumentedName>
          </Alias>
        </Identity>
      </Profile>
    </DistinctParty>
  </DistinctParties>
  <ProfileRelationships><ProfileRelationship ID="1" From-ProfileID="30001" To-ProfileID="22790" /></ProfileRelationships>
  <SanctionsEntries>
    <SanctionsEntry ID="1" ProfileID="22790" ListID="1550">
      <EntryEvent ID="1"><Date><Year>2017</Year><Month>7</Month><Day>31</Day></Date></EntryEvent>
      <SanctionsMeasure ID="1"><Comment>VENEZUELA</Comment></SanctionsMeasure>
    </SanctionsEntry>
  </SanctionsEntries>
</Sanctions>`;

/** EU `sanctionEntity` shapes: entity 507 as published, plus a sparse entity. */
const DETAIL_EU_XML = `<?xml version="1.0" encoding="UTF-8"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export">
  <sanctionEntity designationDetails="" unitedNationId="" euReferenceNumber="EU.513.75" logicalId="507">
    <regulation regulationType="amendment" publicationDate="2003-05-20" programme="TAQA" logicalId="732" />
    <subjectType code="person" classificationCode="P"/>
    <nameAlias firstName="Abdul Rahman" middleName="" lastName="Yasin" wholeName="Abdul Rahman Yasin" strong="true" logicalId="1190"/>
    <citizenship region="" countryIso2Code="US" countryDescription="UNITED STATES" logicalId="70"/>
    <birthdate circa="false" calendarType="GREGORIAN" city="Bloomington, Indiana" zipCode="" birthdate="1960-04-10" dayOfMonth="10" monthOfYear="4" year="1960" region="" place="" countryIso2Code="US" countryDescription="UNITED STATES" logicalId="223"/>
    <birthdate circa="false" calendarType="GREGORIAN" city="" zipCode="" year="1961" region="" place="" countryIso2Code="00" countryDescription="UNKNOWN" logicalId="224"/>
    <birthdate circa="false" calendarType="GREGORIAN" city="" zipCode="" region="" place="" countryIso2Code="00" countryDescription="UNKNOWN" logicalId="225"/>
    <address city="" street="" poBox="" zipCode="" region="" place="" asAtListingTime="false" countryIso2Code="00" countryDescription="UNKNOWN" logicalId="172">
      <remark>SSN 156-92-9858 (USA)</remark>
    </address>
    <address city="Yangon" street="Corner of Ahlone road &amp; Kannar road" poBox="" zipCode="11011" region="" place="" countryIso2Code="MM" countryDescription="MYANMAR" logicalId="173"/>
    <identification diplomatic="false" knownExpired="false" knownFalse="false" number="SSN 156-92-9858" identificationTypeCode="id" identificationTypeDescription="National identification card" countryIso2Code="US" countryDescription="UNITED STATES" logicalId="428">
      <remark>(usa national identification no)</remark>
    </identification>
    <identification number="M0887925" identificationTypeCode="other" identificationTypeDescription="Other identification number" countryIso2Code="00" countryDescription="UNKNOWN" logicalId="9"/>
    <identification number="27082171" identificationTypeCode="passport" identificationTypeDescription="National passport" countryIso2Code="US" countryDescription="UNITED STATES" logicalId="8"/>
    <identification number="27082171" identificationTypeCode="passport" identificationTypeDescription="National passport" countryIso2Code="US" countryDescription="UNITED STATES" logicalId="10"/>
  </sanctionEntity>
  <sanctionEntity euReferenceNumber="EU.1.2" logicalId="600">
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias wholeName="Sparse Enterprise" strong="true"/>
  </sanctionEntity>
  <sanctionEntity euReferenceNumber="EU.1.3" logicalId="601">
    <subjectType code="person" classificationCode="P"/>
    <nameAlias wholeName="Resident Without Citizenship" strong="true"/>
    <birthdate birthdate="" year="" city="Minsk" region="" place="" countryIso2Code="BY" countryDescription="BELARUS"/>
    <birthdate birthdate="" dayOfMonth="" monthOfYear="3" year="1965" city="" region="" place="" countryIso2Code="00" countryDescription="UNKNOWN"/>
    <address city="Vilnius" street="" poBox="" zipCode="" region="" place="" countryIso2Code="LT" countryDescription="LITHUANIA"/>
  </sanctionEntity>
</export>`;

/** UK `Designation` shapes: AFG0055 as published, an entity, a ship, and a sparse record. */
const DETAIL_UK_XML = `<?xml version="1.0" encoding="utf-8"?>
<Designations>
  <Designation>
    <LastUpdated>29/04/2026</LastUpdated>
    <DateDesignated>23/02/2001</DateDesignated>
    <UniqueID>AFG0055</UniqueID>
    <Names>
      <Name><Name1>NAJIBULLAH</Name1><Name2>HAQQANI</Name2><Name6>HIDAYATULLAH</Name6><NameType>Primary Name</NameType></Name>
    </Names>
    <RegimeName>The Afghanistan (Sanctions) (EU Exit) Regulations 2020</RegimeName>
    <IndividualEntityShip>Individual</IndividualEntityShip>
    <Addresses>
      <Address><AddressLine1>Kabul</AddressLine1><AddressCountry>Afghanistan</AddressCountry></Address>
    </Addresses>
    <IndividualDetails>
      <Individual>
        <DOBs><DOB>dd/mm/1971</DOB><DOB>24/10/1972</DOB><DOB>24/10/1972</DOB></DOBs>
        <PassportDetails>
          <Passport><PassportNumber>D0009871</PassportNumber><PassportAdditionalInformation>Afghanistan diplomatic passport</PassportAdditionalInformation></Passport>
          <Passport><PassportNumber>D0009871</PassportNumber></Passport>
        </PassportDetails>
        <Nationalities><Nationality>Afghanistan</Nationality></Nationalities>
        <NationalIdentifierDetails>
          <NationalIdentifier><NationalIdentifierNumber>545167</NationalIdentifierNumber><NationalIdentifierAdditionalInformation>Afghan national ID card (tazkira)</NationalIdentifierAdditionalInformation></NationalIdentifier>
        </NationalIdentifierDetails>
        <Genders><Gender>Male</Gender></Genders>
        <BirthDetails>
          <Location><TownOfBirth>Moni village, Shigal District, Kunar Province</TownOfBirth><CountryOfBirth>Afghanistan</CountryOfBirth></Location>
        </BirthDetails>
      </Individual>
    </IndividualDetails>
  </Designation>
  <Designation>
    <UniqueID>RUS1000</UniqueID>
    <Names><Name><Name6>EXAMPLE TRADING LLC</Name6><NameType>Primary Name</NameType></Name></Names>
    <IndividualEntityShip>Entity</IndividualEntityShip>
    <Addresses>
      <Address><AddressLine1>12 Tverskaya St</AddressLine1><AddressLine2>Office 4</AddressLine2><AddressLine6>Moscow</AddressLine6><AddressPostalCode>125009</AddressPostalCode><AddressCountry>Russia</AddressCountry></Address>
    </Addresses>
    <EntityDetails><Entity><BusinessRegistrationNumbers><BusinessRegistrationNumber>1027700132195</BusinessRegistrationNumber></BusinessRegistrationNumbers></Entity></EntityDetails>
  </Designation>
  <Designation>
    <UniqueID>RUS2000</UniqueID>
    <Names><Name><Name6>SEA EXAMPLE</Name6><NameType>Primary Name</NameType></Name></Names>
    <IndividualEntityShip>Ship</IndividualEntityShip>
    <ShipDetails><Ship><IMONumbers><IMONumber>9123456</IMONumber></IMONumbers></Ship></ShipDetails>
  </Designation>
  <Designation>
    <UniqueID>SPARSE01</UniqueID>
    <Names><Name><Name6>SPARSE PERSON</Name6><NameType>Primary Name</NameType></Name></Names>
    <IndividualEntityShip>Individual</IndividualEntityShip>
    <IndividualDetails><Individual><Genders><Gender>Male</Gender></Genders></Individual></IndividualDetails>
  </Designation>
</Designations>`;

/** UN shapes: 6908002 as published, one with a `BETWEEN` range, an entity address, and a sparse record. */
const DETAIL_UN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CONSOLIDATED_LIST>
  <INDIVIDUALS>
    <INDIVIDUAL>
      <DATAID>6908002</DATAID>
      <FIRST_NAME>IRUTA DOUGLAS</FIRST_NAME>
      <SECOND_NAME>MPAMO</SECOND_NAME>
      <UN_LIST_TYPE>DRC</UN_LIST_TYPE>
      <LISTED_ON>2005-11-01</LISTED_ON>
      <NATIONALITY><VALUE>Democratic Republic of the Congo</VALUE></NATIONALITY>
      <INDIVIDUAL_ADDRESS><CITY>Gisenyi</CITY><COUNTRY>Rwanda</COUNTRY><NOTE>As of June 2011.</NOTE></INDIVIDUAL_ADDRESS>
      <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1965-12-28</DATE></INDIVIDUAL_DATE_OF_BIRTH>
      <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1965-12-29</DATE></INDIVIDUAL_DATE_OF_BIRTH>
      <INDIVIDUAL_PLACE_OF_BIRTH><CITY>Bashali</CITY><STATE_PROVINCE>Masisi</STATE_PROVINCE><COUNTRY>Democratic Republic of the Congo</COUNTRY></INDIVIDUAL_PLACE_OF_BIRTH>
      <INDIVIDUAL_PLACE_OF_BIRTH><CITY>Goma</CITY><COUNTRY>Democratic Republic of the Congo</COUNTRY></INDIVIDUAL_PLACE_OF_BIRTH>
      <INDIVIDUAL_PLACE_OF_BIRTH><CITY>Uvira</CITY><COUNTRY>Democratic Republic of the Congo</COUNTRY></INDIVIDUAL_PLACE_OF_BIRTH>
      <INDIVIDUAL_DOCUMENT/>
    </INDIVIDUAL>
    <INDIVIDUAL>
      <DATAID>6908500</DATAID>
      <FIRST_NAME>RANGE</FIRST_NAME>
      <SECOND_NAME>PERSON</SECOND_NAME>
      <INDIVIDUAL_ADDRESS/>
      <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>BETWEEN</TYPE_OF_DATE><FROM_YEAR>1973</FROM_YEAR><TO_YEAR>1974</TO_YEAR></INDIVIDUAL_DATE_OF_BIRTH>
      <INDIVIDUAL_PLACE_OF_BIRTH><STREET>12 Souk Road</STREET><CITY>Sanaa</CITY><COUNTRY>Yemen</COUNTRY></INDIVIDUAL_PLACE_OF_BIRTH>
      <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>Passport</TYPE_OF_DOCUMENT><NUMBER>00514146</NUMBER><CITY_OF_ISSUE>Sanaa</CITY_OF_ISSUE><COUNTRY_OF_ISSUE>Yemen</COUNTRY_OF_ISSUE></INDIVIDUAL_DOCUMENT>
      <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>Passport</TYPE_OF_DOCUMENT><NUMBER>03824970</NUMBER><ISSUING_COUNTRY>Oman</ISSUING_COUNTRY><COUNTRY_OF_ISSUE>Yemen</COUNTRY_OF_ISSUE></INDIVIDUAL_DOCUMENT>
    </INDIVIDUAL>
    <INDIVIDUAL>
      <DATAID>6908600</DATAID>
      <FIRST_NAME>SPARSE</FIRST_NAME>
      <INDIVIDUAL_ADDRESS/>
      <INDIVIDUAL_DATE_OF_BIRTH/>
      <INDIVIDUAL_PLACE_OF_BIRTH/>
      <INDIVIDUAL_DOCUMENT/>
    </INDIVIDUAL>
  </INDIVIDUALS>
  <ENTITIES>
    <ENTITY>
      <DATAID>6908402</DATAID>
      <FIRST_NAME>ADF</FIRST_NAME>
      <ENTITY_ADDRESS><STATE_PROVINCE>North Kivu </STATE_PROVINCE><COUNTRY>Democratic Republic of the Congo</COUNTRY></ENTITY_ADDRESS>
      <ENTITY_ADDRESS><STREET>Plot 4, Kampala Road</STREET><CITY>Kampala</CITY><ZIP_CODE>256</ZIP_CODE><COUNTRY>Uganda</COUNTRY><NOTE>Former office</NOTE></ENTITY_ADDRESS>
      <ENTITY_ADDRESS/>
    </ENTITY>
  </ENTITIES>
</CONSOLIDATED_LIST>`;

/** The OFAC standard projection of the same kind of record, with the lists the advanced read already carries. */
const DETAIL_OFAC_STANDARD_XML = `<?xml version="1.0" standalone="yes"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <sdnEntry>
    <uid>22790</uid>
    <firstName>Nicolas</firstName>
    <lastName>MADURO MOROS</lastName>
    <sdnType>Individual</sdnType>
    <programList><program>VENEZUELA</program><program>IRAN-CON-ARMS-EO</program></programList>
    <idList><id><uid>14375</uid><idType>Cedula No.</idType><idNumber>5892464</idNumber><idCountry>Venezuela</idCountry></id></idList>
    <addressList>
      <address><uid>34442</uid><address1>Edificio Uno</address1><address2>Piso 2</address2><address3>Oficina 3</address3><city>Caracas</city><stateOrProvince>Capital District</stateOrProvince><country>Venezuela</country></address>
    </addressList>
    <nationalityList><nationality><uid>1</uid><country>Venezuela</country><mainEntry>true</mainEntry></nationality></nationalityList>
    <citizenshipList>
      <citizenship><uid>24261</uid><country>Venezuela</country><mainEntry>true</mainEntry></citizenship>
      <citizenship><uid>24262</uid><country>Colombia</country><mainEntry>false</mainEntry></citizenship>
    </citizenshipList>
    <dateOfBirthList><dateOfBirthItem><uid>24259</uid><dateOfBirth>23 Nov 1962</dateOfBirth><mainEntry>true</mainEntry></dateOfBirthItem></dateOfBirthList>
    <placeOfBirthList><placeOfBirthItem><uid>24260</uid><placeOfBirth>Caracas, Venezuela</placeOfBirth><mainEntry>true</mainEntry></placeOfBirthItem></placeOfBirthList>
  </sdnEntry>
  <sdnEntry>
    <uid>30001</uid>
    <lastName>TWO BIRTHS</lastName>
    <dateOfBirthList>
      <dateOfBirthItem><dateOfBirth>1970</dateOfBirth></dateOfBirthItem>
      <dateOfBirthItem><dateOfBirth>1971</dateOfBirth></dateOfBirthItem>
    </dateOfBirthList>
    <placeOfBirthList><placeOfBirthItem><placeOfBirth>Nagoya, Japan</placeOfBirth></placeOfBirthItem></placeOfBirthList>
  </sdnEntry>
</sdnList>`;

/** Every detail group empty — the shape a record with none published must take. */
const NO_DETAILS = { identifiers: [], addresses: [], datesOfBirth: [], nationalities: [] };

function byEntryId(records: NormalizedDesignation[], entryId: string): NormalizedDesignation {
  const record = records.find((d) => d.sourceEntryId === entryId);
  if (!record) throw new Error(`no record ${entryId}`);
  return record;
}

describe('published designation details (issue #22)', () => {
  describe('OFAC advanced', () => {
    const records = () => parseOfac(parseXml(DETAIL_OFAC_ADVANCED_XML), 'ofac_sdn');

    it('resolves 22790 through <IDRegDocuments> and <Locations>', () => {
      expect(byEntryId(records(), '22790').payload).toMatchObject({
        identifiers: [{ type: 'Cedula No.', value: '5892464', country: 'Venezuela' }],
        addresses: [{ full: 'Caracas, Capital District, Venezuela', country: 'Venezuela' }],
        datesOfBirth: [{ date: '1962-11-23', place: 'Caracas, Venezuela' }],
        nationalities: ['Venezuela'],
      });
    });

    it('renders addresses in address order from the primary values, decoded', () => {
      expect(byEntryId(records(), '30001').payload.addresses).toEqual([
        {
          full: '1-117 Shukuatocho, Nakamura Ward, Suzuki & Sons Building, Nagoya, 453-0015, Japan',
          country: 'Japan',
        },
        { full: 'Caracas, Capital District, Venezuela', country: 'Venezuela' },
      ]);
    });

    it('drops the undetermined placeholder and a dangling LocationID, and keeps the party', () => {
      const party = byEntryId(records(), '30001');
      expect(party.payload.addresses).toHaveLength(2);
      expect(JSON.stringify(party.payload)).not.toMatch(/undetermined/i);
    });

    it('collapses a nationality published as both nationality and citizenship', () => {
      expect(byEntryId(records(), '30001').payload.nationalities).toEqual(['Venezuela', 'Japan']);
    });

    it("joins every document on the party's identity and collapses exact duplicates", () => {
      expect(byEntryId(records(), '30001').payload.identifiers).toEqual([
        { type: 'Passport', value: 'TZ0981234' },
        { type: 'Cedula No.', value: 'JP-44', country: 'Japan' },
      ]);
    });

    it('emits two dates and one place unpaired', () => {
      expect(byEntryId(records(), '30001').payload.datesOfBirth).toEqual([
        { date: '1970-01-02' },
        { date: '1971' },
        { place: 'Nagoya, Japan' },
      ]);
    });

    it('returns every group empty for a party that published none, beside one that published all', () => {
      const all = records();
      expect(byEntryId(all, '30002').payload).toMatchObject(NO_DETAILS);
      const full = byEntryId(all, '22790').payload;
      expect(
        [full.identifiers, full.addresses, full.datesOfBirth, full.nationalities].map(
          (g) => g.length,
        ),
      ).toEqual([1, 1, 1, 1]);
    });

    it('never counts a dangling reference or an orphan document as a rejection', () => {
      const rejections = createRejections();
      const all = parseOfac(parseXml(DETAIL_OFAC_ADVANCED_XML), 'ofac_sdn', rejections);
      expect(all.map((d) => d.sourceEntryId)).toEqual(['22790', '30001', '30002']);
      expect(rejections).toEqual({ missingIdentifier: 0, unusableName: 0 });
      // The orphan document (IdentityID 99999) reaches no party.
      expect(JSON.stringify(all)).not.toContain('ORPHAN-1');
      expect(byEntryId(all, '22790').payload.identifiers).toEqual([
        { type: 'Cedula No.', value: '5892464', country: 'Venezuela' },
      ]);
    });
  });

  describe('OFAC standard', () => {
    const records = () => parseOfac(parseXml(DETAIL_OFAC_STANDARD_XML), 'ofac_sdn');

    it('reads every programme from programList, joined as the advanced schema joins measures', () => {
      expect(byEntryId(records(), '22790').program).toBe('VENEZUELA, IRAN-CON-ARMS-EO');
      expect(byEntryId(records(), '30001').program).toBeUndefined();
    });

    it('reads address3, the citizenship list, and the place-of-birth list', () => {
      expect(byEntryId(records(), '22790').payload).toMatchObject({
        addresses: [
          {
            full: 'Edificio Uno, Piso 2, Oficina 3, Caracas, Capital District, Venezuela',
            country: 'Venezuela',
          },
        ],
        datesOfBirth: [{ date: '23 Nov 1962', place: 'Caracas, Venezuela' }],
        nationalities: ['Venezuela', 'Colombia'],
      });
    });

    it('emits two dates and one place unpaired', () => {
      expect(byEntryId(records(), '30001').payload.datesOfBirth).toEqual([
        { date: '1970' },
        { date: '1971' },
        { place: 'Nagoya, Japan' },
      ]);
    });
  });

  describe('EU', () => {
    const records = () => parseEu(parseXml(DETAIL_EU_XML));

    it('reads identification, address, and the birthplace of the same <birthdate>', () => {
      expect(byEntryId(records(), '507').payload).toMatchObject({
        identifiers: [
          {
            type: 'National identification card',
            value: 'SSN 156-92-9858',
            country: 'UNITED STATES',
          },
          { type: 'Other identification number', value: 'M0887925' },
          { type: 'National passport', value: '27082171', country: 'UNITED STATES' },
        ],
        addresses: [
          {
            full: 'Corner of Ahlone road & Kannar road, Yangon, 11011, MYANMAR',
            country: 'MYANMAR',
          },
        ],
        datesOfBirth: [
          { date: '1960-04-10', place: 'Bloomington, Indiana, UNITED STATES' },
          { date: '1961' },
        ],
        nationalities: ['UNITED STATES'],
      });
    });

    it('treats UNKNOWN as absence: no country, no placeholder-only address or birth entry', () => {
      const payload = byEntryId(records(), '507').payload;
      expect(payload.identifiers[1]).toEqual({
        type: 'Other identification number',
        value: 'M0887925',
      });
      expect(payload.addresses).toHaveLength(1);
      expect(payload.datesOfBirth).toHaveLength(2);
      expect(JSON.stringify(payload)).not.toMatch(/UNKNOWN|""/);
    });

    it('returns every group empty for an entity that published none, beside one that published all', () => {
      const all = records();
      expect(byEntryId(all, '600').payload).toMatchObject(NO_DETAILS);
      const full = byEntryId(all, '507').payload;
      expect(
        [full.identifiers, full.addresses, full.datesOfBirth, full.nationalities].map(
          (g) => g.length,
        ),
      ).toEqual([3, 1, 2, 1]);
    });
  });

  describe('UK', () => {
    const records = () => parseUk(parseXml(DETAIL_UK_XML));

    it('reads AFG0055 from the individual, address, and birth-detail paths', () => {
      expect(byEntryId(records(), 'AFG0055').payload).toMatchObject({
        identifiers: [
          { type: 'Passport', value: 'D0009871' },
          { type: 'National Identifier', value: '545167' },
        ],
        addresses: [{ full: 'Kabul, Afghanistan', country: 'Afghanistan' }],
        datesOfBirth: [
          { date: 'dd/mm/1971' },
          { date: '24/10/1972' },
          { place: 'Moni village, Shigal District, Kunar Province, Afghanistan' },
        ],
        nationalities: ['Afghanistan'],
      });
    });

    it('types entity and ship identifiers by element', () => {
      expect(byEntryId(records(), 'RUS1000').payload).toMatchObject({
        identifiers: [{ type: 'Business Registration Number', value: '1027700132195' }],
        addresses: [
          {
            full: '12 Tverskaya St, Office 4, Moscow, 125009, Russia',
            country: 'Russia',
          },
        ],
        nationalities: [],
      });
      expect(byEntryId(records(), 'RUS2000').payload.identifiers).toEqual([
        { type: 'IMO Number', value: '9123456' },
      ]);
    });

    it('returns every group empty for a designation that published none, beside one that published all', () => {
      const all = records();
      expect(byEntryId(all, 'SPARSE01').payload).toMatchObject(NO_DETAILS);
      const full = byEntryId(all, 'AFG0055').payload;
      expect(
        [full.identifiers, full.addresses, full.datesOfBirth, full.nationalities].map(
          (g) => g.length,
        ),
      ).toEqual([2, 1, 3, 1]);
    });
  });

  describe('UN', () => {
    const records = () => parseUn(parseXml(DETAIL_UN_XML));

    it('reads 6908002: an address and three birthplaces unpaired from two dates', () => {
      expect(byEntryId(records(), '6908002').payload).toMatchObject({
        identifiers: [],
        addresses: [{ full: 'Gisenyi, Rwanda', country: 'Rwanda' }],
        datesOfBirth: [
          { date: '1965-12-28' },
          { date: '1965-12-29' },
          { place: 'Bashali, Masisi, Democratic Republic of the Congo' },
          { place: 'Goma, Democratic Republic of the Congo' },
          { place: 'Uvira, Democratic Republic of the Congo' },
        ],
        nationalities: ['Democratic Republic of the Congo'],
      });
    });

    it('pairs a BETWEEN range with its one place, and falls back to COUNTRY_OF_ISSUE', () => {
      expect(byEntryId(records(), '6908500').payload).toMatchObject({
        identifiers: [
          { type: 'Passport', value: '00514146', country: 'Yemen' },
          { type: 'Passport', value: '03824970', country: 'Oman' },
        ],
        addresses: [],
        datesOfBirth: [{ date: '1973/1974', place: '12 Souk Road, Sanaa, Yemen' }],
      });
    });

    it('reads entity addresses, skipping an empty one', () => {
      expect(byEntryId(records(), '6908402').payload.addresses).toEqual([
        {
          full: 'North Kivu, Democratic Republic of the Congo',
          country: 'Democratic Republic of the Congo',
        },
        { full: 'Plot 4, Kampala Road, Kampala, 256, Uganda', country: 'Uganda' },
      ]);
    });

    it('returns every group empty for a record that published none, beside one that published all', () => {
      const all = records();
      expect(byEntryId(all, '6908600').payload).toMatchObject(NO_DETAILS);
      const full = byEntryId(all, '6908500').payload;
      expect([full.identifiers, full.datesOfBirth].map((g) => g.length)).toEqual([2, 1]);
    });
  });

  it('streams the same detail groups the buffered parsers produce, at every chunk size', async () => {
    const ofacOracle = parseOfac(parseXml(DETAIL_OFAC_ADVANCED_XML), 'ofac_sdn');
    const standardOracle = parseOfac(parseXml(DETAIL_OFAC_STANDARD_XML), 'ofac_sdn');
    const flat = [
      ['EU', DETAIL_EU_XML, parseEu, streamEuFromText],
      ['UK', DETAIL_UK_XML, parseUk, streamUkFromText],
      ['UN', DETAIL_UN_XML, parseUn, streamUnFromText],
    ] as const;
    expect(byEntryId(ofacOracle, '22790').payload.identifiers).toHaveLength(1);

    for (const size of CHUNK_SIZES) {
      const ofac = await streamAll(
        (chunks, s) => streamOfacFromText(chunks, 'ofac_sdn', s),
        DETAIL_OFAC_ADVANCED_XML,
        size,
      );
      expect(withDeferred(ofac.records, ofac.state), `OFAC advanced chunk ${size}`).toEqual(
        ofacOracle,
      );
      const standard = await streamAll(
        (chunks, s) => streamOfacFromText(chunks, 'ofac_sdn', s),
        DETAIL_OFAC_STANDARD_XML,
        size,
      );
      expect(standard.records, `OFAC standard chunk ${size}`).toEqual(standardOracle);
      for (const [label, xml, parse, stream] of flat) {
        const { records } = await streamAll(stream, xml, size);
        expect(records, `${label} chunk ${size}`).toEqual(parse(parseXml(xml)));
      }
    }
  });

  it('treats a published "na" as absence in every detail group, never in a name or a country name', () => {
    const [un] = parseUn(
      parseXml(`<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL>
        <DATAID>690784</DATAID><FIRST_NAME>NA</FIRST_NAME><SECOND_NAME>PLACEHOLDER</SECOND_NAME><FOURTH_NAME>na</FOURTH_NAME>
        <NATIONALITY><VALUE>na</VALUE><VALUE>Namibia</VALUE></NATIONALITY>
        <INDIVIDUAL_ADDRESS><CITY>na</CITY><COUNTRY>Namibia</COUNTRY></INDIVIDUAL_ADDRESS>
        <INDIVIDUAL_DATE_OF_BIRTH><DATE>NA</DATE></INDIVIDUAL_DATE_OF_BIRTH>
        <INDIVIDUAL_PLACE_OF_BIRTH><CITY>Na</CITY></INDIVIDUAL_PLACE_OF_BIRTH>
        <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>Passport</TYPE_OF_DOCUMENT><NUMBER>na</NUMBER></INDIVIDUAL_DOCUMENT>
      </INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>`),
    );
    const [uk] = parseUk(
      parseXml(`<Designations><Designation><UniqueID>UK-NA</UniqueID>
        <Names><Name><Name1>Kim</Name1><Name3>Na</Name3><NameType>Primary Name</NameType></Name></Names>
        <Addresses><Address><AddressLine1>NA</AddressLine1><AddressCountry>Namibia</AddressCountry></Address></Addresses>
        <IndividualDetails><Individual>
          <Nationalities><Nationality>NA</Nationality></Nationalities>
          <PassportDetails><Passport><PassportNumber>na</PassportNumber></Passport></PassportDetails>
        </Individual></IndividualDetails>
      </Designation></Designations>`),
    );
    const [eu] = parseEu(
      parseXml(`<export><sanctionEntity logicalId="1"><subjectType code="person"/>
        <nameAlias wholeName="Na Placeholder" strong="true"/>
        <citizenship countryIso2Code="NA" countryDescription="NAMIBIA"/>
        <citizenship countryIso2Code="00" countryDescription="na"/>
        <identification number="na" identificationTypeDescription="National passport" countryIso2Code="NA" countryDescription="NAMIBIA"/>
        <birthdate birthdate="" year="" city="NA" countryIso2Code="00" countryDescription="UNKNOWN"/>
      </sanctionEntity></export>`),
    );
    const [ofac] = parseOfac(
      parseXml(`<Sanctions>
        <ReferenceValueSets>
          <AliasTypeValues><AliasType ID="1403">Name</AliasType></AliasTypeValues>
          <CountryValues><Country ID="11199" ISO2="NA">Namibia</Country></CountryValues>
          <FeatureTypeValues><FeatureType ID="25">Location</FeatureType></FeatureTypeValues>
          <IDRegDocTypeValues><IDRegDocType ID="1571">Passport</IDRegDocType></IDRegDocTypeValues>
          <LocPartTypeValues><LocPartType ID="1454">CITY</LocPartType></LocPartTypeValues>
        </ReferenceValueSets>
        <Locations><Location ID="1"><LocationCountry CountryID="11199" />
          <LocationPart LocPartTypeID="1454"><LocationPartValue Primary="true"><Value>NA</Value></LocationPartValue></LocationPart>
        </Location></Locations>
        <IDRegDocuments><IDRegDocument IDRegDocTypeID="1571" IdentityID="1" IssuedBy-CountryID="11199"><IDRegistrationNo>na</IDRegistrationNo></IDRegDocument></IDRegDocuments>
        <DistinctParties><DistinctParty FixedRef="5"><Profile ID="5"><Identity ID="1">
          <Alias AliasTypeID="1403" Primary="true"><DocumentedName>
            <DocumentedNamePart><NamePartValue>Na</NamePartValue></DocumentedNamePart>
            <DocumentedNamePart><NamePartValue>Tae Ho</NamePartValue></DocumentedNamePart>
          </DocumentedName></Alias></Identity>
          <Feature FeatureTypeID="25"><FeatureVersion><VersionLocation LocationID="1" /></FeatureVersion></Feature>
        </Profile></DistinctParty></DistinctParties>
      </Sanctions>`),
      'ofac_sdn',
    );

    expect(un?.primaryName).toBe('NA PLACEHOLDER na');
    expect(un?.payload).toMatchObject({
      identifiers: [],
      addresses: [{ full: 'Namibia', country: 'Namibia' }],
      datesOfBirth: [],
      nationalities: ['Namibia'],
    });
    expect(uk?.primaryName).toBe('Kim Na');
    expect(uk?.payload).toMatchObject({
      identifiers: [],
      addresses: [{ full: 'Namibia', country: 'Namibia' }],
      nationalities: [],
    });
    expect(eu?.payload).toMatchObject({
      identifiers: [],
      datesOfBirth: [],
      nationalities: ['NAMIBIA'],
    });
    expect(ofac?.primaryName).toBe('Na Tae Ho');
    expect(ofac?.payload).toMatchObject({
      identifiers: [],
      addresses: [{ full: 'Namibia', country: 'Namibia' }],
    });
  });

  it('never infers a nationality from an address or a birthplace country', () => {
    const records = [
      byEntryId(parseEu(parseXml(DETAIL_EU_XML)), '601'),
      byEntryId(parseUk(parseXml(DETAIL_UK_XML)), 'RUS1000'),
      byEntryId(parseUn(parseXml(DETAIL_UN_XML)), '6908500'),
      byEntryId(parseUn(parseXml(DETAIL_UN_XML)), '6908402'),
    ];
    for (const record of records) {
      // Each publishes a country in an address or a birthplace, and no nationality.
      const countries = [
        ...record.payload.addresses.map((a) => a.full),
        ...record.payload.datesOfBirth.map((d) => d.place),
      ];
      expect(countries.length, record.sourceEntryId).toBeGreaterThan(0);
      expect(record.payload.nationalities, record.sourceEntryId).toEqual([]);
    }
    expect(byEntryId(parseEu(parseXml(DETAIL_EU_XML)), '601').payload).toMatchObject({
      addresses: [{ full: 'Vilnius, LITHUANIA', country: 'LITHUANIA' }],
      // A year and month with no full date keep the published month.
      datesOfBirth: [{ place: 'Minsk, BELARUS' }, { date: '1965-03' }],
    });
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
 * sets, the `<Locations>` and `<IDRegDocuments>` blocks the parties cross-
 * reference, parties, relationships, then the programme block. Carries nesting
 * depth (Profile → Identity → Alias → DocumentedName → DocumentedNamePart,
 * repeated at three levels), two dropped siblings, two programme entries for one
 * profile, an orphan entry, several locations per party, a location shared by
 * two parties, a dangling `LocationID`, and an orphan document.
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
    <CountryValues>
      <Country ID="11065" ISO2="CU">Cuba</Country>
      <Country ID="11126" ISO2="IL">Israel</Country>
      <Country ID="11291">undetermined</Country>
    </CountryValues>
    <FeatureTypeValues>
      <FeatureType ID="8">Birthdate</FeatureType>
      <FeatureType ID="9">Place of Birth</FeatureType>
      <FeatureType ID="10">Nationality Country</FeatureType>
      <FeatureType ID="25">Location</FeatureType>
      <FeatureType ID="3">Vessel Flag</FeatureType>
    </FeatureTypeValues>
    <IDRegDocTypeValues>
      <IDRegDocType ID="1571">Passport</IDRegDocType>
      <IDRegDocType ID="1626">Vessel Registration Identification</IDRegDocType>
    </IDRegDocTypeValues>
    <LocPartTypeValues>
      <LocPartType ID="1">Unknown</LocPartType>
      <LocPartType ID="1450">REGION</LocPartType>
      <LocPartType ID="1451">ADDRESS1</LocPartType>
      <LocPartType ID="1454">CITY</LocPartType>
    </LocPartTypeValues>
    <PartySubTypeValues>
      <PartySubType ID="1" PartyTypeID="4">Vessel</PartySubType>
      <PartySubType ID="4" PartyTypeID="1">Unknown</PartySubType>
    </PartySubTypeValues>
  </ReferenceValueSets>
  <Locations>
    <Location ID="1">
      <LocationAreaCode AreaCodeID="11065" />
      <LocationCountry CountryID="11065" CountryRelevanceID="1413" />
      <LocationPart LocPartTypeID="1454"><LocationPartValue Primary="true"><Comment /><Value>Havana</Value></LocationPartValue></LocationPart>
      <LocationPart LocPartTypeID="1451"><LocationPartValue Primary="true"><Comment /><Value>Calle 23 &amp; L</Value></LocationPartValue></LocationPart>
      <FeatureVersionReference FeatureVersionID="10" />
      <FeatureVersionReference FeatureVersionID="20" />
    </Location>
    <Location ID="2">
      <LocationCountry CountryID="11126" CountryRelevanceID="1413" />
      <LocationPart LocPartTypeID="1450"><LocationPartValue Primary="true"><Comment /><Value>Gaza</Value></LocationPartValue></LocationPart>
    </Location>
    <Location ID="3"><LocationAreaCode AreaCodeID="11291" /></Location>
    <Location ID="4">
      <LocationPart LocPartTypeID="1"><LocationPartValue Primary="true"><Comment /><Value>Cuba</Value></LocationPartValue></LocationPart>
    </Location>
  </Locations>
  <IDRegDocuments>
    <IDRegDocument ID="1" IDRegDocTypeID="1571" IdentityID="4420" IssuedBy-CountryID="11126" ValidityID="1"><Comment /><IDRegistrationNo>X1</IDRegistrationNo></IDRegDocument>
    <IDRegDocument ID="2" IDRegDocTypeID="1626" IdentityID="9001" ValidityID="1"><Comment /><IDRegistrationNo>IMO 7303803</IDRegistrationNo></IDRegDocument>
    <IDRegDocument ID="3" IDRegDocTypeID="1571" IdentityID="4420" IssuedBy-CountryID="11065" ValidityID="2"><Comment /><IDRegistrationNo>X2</IDRegistrationNo></IDRegDocument>
    <IDRegDocument ID="4" IDRegDocTypeID="1571" IdentityID="123456" ValidityID="1"><Comment /><IDRegistrationNo>ORPHAN</IDRegistrationNo></IDRegDocument>
  </IDRegDocuments>
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
        <Feature FeatureTypeID="25"><FeatureVersion ID="10"><VersionLocation LocationID="1" /></FeatureVersion></Feature>
        <Feature FeatureTypeID="25"><FeatureVersion ID="11"><VersionLocation LocationID="3" /></FeatureVersion></Feature>
        <Feature FeatureTypeID="25"><FeatureVersion ID="12"><VersionLocation LocationID="777" /></FeatureVersion></Feature>
        <Feature FeatureTypeID="25"><FeatureVersion ID="13"><VersionLocation LocationID="2" /></FeatureVersion></Feature>
        <Feature FeatureTypeID="10"><FeatureVersion ID="14"><VersionLocation LocationID="4" /></FeatureVersion></Feature>
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
        <Feature FeatureTypeID="25"><FeatureVersion ID="20"><VersionLocation LocationID="1" /></FeatureVersion></Feature>
        <Feature FeatureTypeID="3"><FeatureVersion ID="21"><VersionLocation LocationID="4" /></FeatureVersion></Feature>
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
    <programList><program>SDGT</program><program>SDT</program></programList>
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
    <Addresses>
      <Address><AddressLine1>Chaman</AddressLine1><AddressCountry>Pakistan</AddressCountry></Address>
      <Address><AddressLine1>Kandahar</AddressLine1><AddressCountry>Afghanistan</AddressCountry></Address>
    </Addresses>
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
    // The cross-referenced groups resolve on the oracle, so the equality below
    // compares populated groups rather than two empty ones.
    expect(oracle.map((d) => d.payload)).toMatchObject([
      {
        identifiers: [
          { type: 'Passport', value: 'X1', country: 'Israel' },
          { type: 'Passport', value: 'X2', country: 'Cuba' },
        ],
        addresses: [
          { full: 'Calle 23 & L, Havana, Cuba', country: 'Cuba' },
          { full: 'Gaza, Israel', country: 'Israel' },
        ],
        datesOfBirth: [{ date: '1948-12-10', place: 'Safed, Israel' }],
        nationalities: ['Cuba'],
      },
      {
        identifiers: [{ type: 'Vessel Registration Identification', value: 'IMO 7303803' }],
        addresses: [{ full: 'Calle 23 & L, Havana, Cuba', country: 'Cuba' }],
        datesOfBirth: [],
        // A Vessel Flag feature targets a country Location too, but is not a nationality.
        nationalities: [],
      },
    ]);

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
    expect(oracle.map((d) => d.program)).toEqual(['SDGT, SDT', undefined]);
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

// ─── XML entity references (issue #21) ──────────────────────────────────────────
//
// Every source escapes `&` and `"` as the XML spec requires, so a published
// `Greenland Oil & Gas` arrives as `Greenland Oil &amp; Gas`. The parser decodes
// the five predefined entities and numeric references once, in element text and
// attribute values alike; every ingester reads through it, so no reference can
// reach a stored name, alias, remark, or address.

const ENTITY_OFAC_ADVANCED_XML = `<Sanctions>
  <ReferenceValueSets>
    <AliasTypeValues><AliasType ID="1400">A.K.A.</AliasType><AliasType ID="1403">Name</AliasType></AliasTypeValues>
  </ReferenceValueSets>
  <DistinctParties>
    <DistinctParty FixedRef="40972">
      <Profile ID="40972">
        <Identity ID="1" Primary="true">
          <Alias AliasTypeID="1403" Primary="true" LowQuality="false">
            <DocumentedName ID="1">
              <DocumentedNamePart><NamePartValue>Greenland Oil &amp; Gas Trading FZE</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
          <Alias AliasTypeID="1400" Primary="false" LowQuality="false">
            <DocumentedName ID="2">
              <DocumentedNamePart><NamePartValue>جرينلاند اويل &amp; غاز تريدينغ م م ح</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
          <Alias AliasTypeID="1400" Primary="false" LowQuality="false">
            <DocumentedName ID="3">
              <DocumentedNamePart><NamePartValue>Greenland Oil &#38; Gas &#x22;GOG&#x22;</NamePartValue></DocumentedNamePart>
            </DocumentedName>
          </Alias>
        </Identity>
      </Profile>
    </DistinctParty>
  </DistinctParties>
  <SanctionsEntries>
    <SanctionsEntry ID="40972" ProfileID="40972" ListID="1550">
      <SanctionsMeasure ID="1" SanctionsTypeID="1"><Comment>SDGT &amp; IRGC</Comment></SanctionsMeasure>
    </SanctionsEntry>
  </SanctionsEntries>
</Sanctions>`;

const ENTITY_EU_XML = `<export>
  <sanctionEntity logicalId="140494" euReferenceNumber="EU.1.1">
    <regulation programme="UKR" publicationDate="2022-03-01"/>
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias wholeName="ПАО &quot;КАМАЗ&quot;" strong="true"/>
    <nameAlias wholeName="KAMAZ &#x26; Partners" strong="false"/>
    <nameAlias firstName="Anna &amp;" lastName="&quot;Co&quot;" strong="false"/>
  </sanctionEntity>
</export>`;

const ENTITY_UK_XML = `<Designations>
  <Designation>
    <UniqueID>AQD0011</UniqueID>
    <RegimeName>ISIL (Da&apos;esh) and Al-Qaida</RegimeName>
    <IndividualEntityShip>Entity</IndividualEntityShip>
    <Names>
      <Name><Name6>AL-HARAMAIN &amp; AL MASJED AL-AQSA CHARITY FOUNDATION</Name6><NameType>Primary Name</NameType></Name>
      <Name><Name6>Al Haramain &#38; Al Masjed</Name6><NameType>Alias</NameType></Name>
    </Names>
    <OtherInformation>Formerly A &amp; B; see &lt;link&gt;</OtherInformation>
  </Designation>
</Designations>`;

const ENTITY_UN_XML = `<CONSOLIDATED_LIST>
  <ENTITIES>
    <ENTITY>
      <DATAID>110</DATAID>
      <FIRST_NAME>AL-RASHID TRUST &amp; SONS</FIRST_NAME>
      <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE>
      <COMMENTS1>Review &quot;completed&quot; &#8212; 2020</COMMENTS1>
      <ENTITY_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Al Rasheed &amp; Co</ALIAS_NAME></ENTITY_ALIAS>
    </ENTITY>
  </ENTITIES>
</CONSOLIDATED_LIST>`;

const ENTITY_LEI_L1_XML = `<lei:LEIData xmlns:lei="http://www.gleif.org/data/schema/leidata/2016">
  <lei:LEIRecords>
    <lei:LEIRecord>
      <lei:LEI>5493001KJTIIGC8Y1R12</lei:LEI>
      <lei:Entity>
        <lei:LegalName xml:lang="en">Smith &amp; Wesson &#x26; Co</lei:LegalName>
        <lei:OtherEntityNames>
          <lei:OtherEntityName xml:lang="en" type="TRADING_OR_OPERATING_NAME">S&amp;W &quot;Arms&quot;</lei:OtherEntityName>
        </lei:OtherEntityNames>
        <lei:LegalAddress xml:lang="en">
          <lei:FirstAddressLine>1 &quot;Main&quot; St</lei:FirstAddressLine>
          <lei:City>Springfield</lei:City>
          <lei:Country>US</lei:Country>
        </lei:LegalAddress>
        <lei:LegalJurisdiction>US</lei:LegalJurisdiction>
      </lei:Entity>
      <lei:Registration><lei:RegistrationStatus>ISSUED</lei:RegistrationStatus></lei:Registration>
    </lei:LEIRecord>
  </lei:LEIRecords>
</lei:LEIData>`;

describe('XML entity references are decoded at parse time (issue #21)', () => {
  it('OFAC advanced: element text in every alias and the programme comment', () => {
    const [d] = parseOfac(parseXml(ENTITY_OFAC_ADVANCED_XML), 'ofac_sdn');
    expect(d?.primaryName).toBe('Greenland Oil & Gas Trading FZE');
    expect(d?.payload.aliases.map((a) => a.name)).toEqual([
      'جرينلاند اويل & غاز تريدينغ م م ح',
      'Greenland Oil & Gas "GOG"',
    ]);
    expect(d?.program).toBe('SDGT & IRGC');
  });

  it('EU: attribute values, whole names and first/last-name parts alike', () => {
    const [d] = parseEu(parseXml(ENTITY_EU_XML));
    expect(d?.primaryName).toBe('ПАО "КАМАЗ"');
    expect(d?.payload.aliases.map((a) => a.name)).toEqual(['KAMAZ & Partners', 'Anna & "Co"']);
  });

  it('UK: names, the regime, and the remarks', () => {
    const [d] = parseUk(parseXml(ENTITY_UK_XML));
    expect(d?.primaryName).toBe('AL-HARAMAIN & AL MASJED AL-AQSA CHARITY FOUNDATION');
    expect(d?.payload.aliases.map((a) => a.name)).toEqual(['Al Haramain & Al Masjed']);
    expect(d?.program).toBe("ISIL (Da'esh) and Al-Qaida");
    expect(d?.payload.remarks).toBe('Formerly A & B; see <link>');
  });

  it('UN: the name, a nested alias, and the comments', () => {
    const [d] = parseUn(parseXml(ENTITY_UN_XML));
    expect(d?.primaryName).toBe('AL-RASHID TRUST & SONS');
    expect(d?.payload.aliases.map((a) => a.name)).toEqual(['Al Rasheed & Co']);
    expect(d?.payload.remarks).toBe('Review "completed" — 2020');
  });

  it('GLEIF Level 1: attribute-bearing legal and other names, and the address', () => {
    const [e] = parseLeiLevel1(parseXml(ENTITY_LEI_L1_XML));
    expect(e?.legalName).toBe('Smith & Wesson & Co');
    expect(e?.otherNames).toEqual(['S&W "Arms"']);
    expect(e?.legalAddress).toBe('1 "Main" St, Springfield, US');
  });

  it('decodes one level only: an escaped reference stays a reference', () => {
    const doc = parseXml<{ r: { '#text': string; '@_a': string } }>(
      '<r a="&amp;lt; &amp;amp;">&amp;lt; &amp;#65;</r>',
    );
    expect(doc.r['#text']).toBe('&lt; &#65;');
    expect(doc.r['@_a']).toBe('&lt; &amp;');
  });

  it('decodes decimal and hexadecimal character references inside the XML Char range', () => {
    const doc = parseXml<{ r: { '#text': string; '@_a': string } }>(
      '<r a="&#65;&#x42;&#x1F600;">x&#9;y&#xA;z&#x10FFFF;</r>',
    );
    expect(doc.r['@_a']).toBe('AB😀');
    expect(doc.r['#text']).toBe('x\ty\nz\u{10FFFF}');
  });

  it.each([
    ['NUL', '&#0;'],
    ['a lone surrogate', '&#xD800;'],
    ['a reference past U+10FFFF', '&#x110000;'],
    ['an overlong reference', `&#${'9'.repeat(40)};`],
    ['a control character outside Char', '&#x1;'],
    ['U+FFFE', '&#xFFFE;'],
    ['an upper-case hex marker', '&#X41;'],
    ['an HTML entity', '&nbsp;'],
    ['an Object.prototype key', '&constructor;'],
    ['__proto__', '&__proto__;'],
    ['an unterminated reference', 'A &amp B'],
    ['a bare ampersand', 'A & B'],
  ])('leaves %s literal', (_label, raw) => {
    const doc = parseXml<{ r: { '#text': string; '@_a': string } }>(`<r a="${raw}">${raw}</r>`);
    expect(doc.r['#text']).toBe(raw);
    expect(doc.r['@_a']).toBe(raw);
  });

  it('never expands a DOCTYPE-declared entity', () => {
    const doc = parseXml<{ x: string }>('<!DOCTYPE x [<!ENTITY y "boom">]><x>&y; &amp;</x>');
    expect(doc.x).toBe('&y; &');
  });

  it('streams the same decoded records the buffered parsers produce', async () => {
    const ofacOracle = parseOfac(parseXml(ENTITY_OFAC_ADVANCED_XML), 'ofac_sdn');
    const cases = [
      ['EU', ENTITY_EU_XML, parseEu, streamEuFromText],
      ['UK', ENTITY_UK_XML, parseUk, streamUkFromText],
      ['UN', ENTITY_UN_XML, parseUn, streamUnFromText],
    ] as const;
    const leiOracle = parseLeiLevel1(parseXml(ENTITY_LEI_L1_XML));
    expect(leiOracle).toHaveLength(1);

    for (const size of CHUNK_SIZES) {
      const ofac = await streamAll(
        (chunks, s) => streamOfacFromText(chunks, 'ofac_sdn', s),
        ENTITY_OFAC_ADVANCED_XML,
        size,
      );
      expect(withDeferred(ofac.records, ofac.state), `OFAC chunk ${size}`).toEqual(ofacOracle);
      for (const [label, xml, parse, stream] of cases) {
        const { records } = await streamAll(stream, xml, size);
        expect(records, `${label} chunk ${size}`).toEqual(parse(parseXml(xml)));
      }
      expect(
        await collect(streamLeiLevel1FromText(chunkStr(ENTITY_LEI_L1_XML, size))),
        `GLEIF chunk ${size}`,
      ).toEqual(leiOracle);
    }
  });
});

describe('entity decoding cost on caller-sized text', () => {
  /*
   * The decoder scans every element text and attribute value of every record.
   * Shapes that start a reference and never finish it are the ones a backtracking
   * pattern would rescan; the whole-document cost must stay linear in them.
   */
  const shapes: [label: string, make: (n: number) => string][] = [
    ['repeated ampersands with no semicolon', (n) => '&'.repeat(n)],
    ['repeated numeric prefixes', (n) => '&#1'.repeat(n / 3)],
    ['repeated named prefixes', (n) => '&amp'.repeat(n / 4)],
    ['one reference that never terminates', (n) => `&#${'1'.repeat(n)}`],
    ['one name that never terminates', (n) => `&${'a'.repeat(n)}`],
    ['dense valid references', (n) => '&amp;'.repeat(n / 5)],
  ];

  it.each(shapes)('grows linearly on %s', (_label, make) => {
    const time = (n: number): number => {
      const text = make(n);
      const xml = `<r a="${text}">${text}</r>`;
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        parseXml(xml);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    time(5_000); // warm the parser
    const t5k = Math.max(time(5_000), 0.05);
    const t80k = time(80_000);
    expect(t80k / t5k).toBeLessThan(64);
    expect(t80k).toBeLessThan(250);
  });
});
