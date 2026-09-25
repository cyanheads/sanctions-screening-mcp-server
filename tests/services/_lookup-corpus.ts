/**
 * @fileoverview A small published corpus in each source's own schema, shaped on
 * the records the lookup paths key on: list reference numbers (UN
 * `REFERENCE_NUMBER`, EU `euReferenceNumber`, UK `OFSIGroupID`, including one UK
 * Group ID held by two designations and a UN value published with trailing
 * whitespace) and published identifiers (IMO numbers, SWIFT/BIC codes, a
 * passport and a national ID shared across lists, a label published with a line
 * break). Every record but one is an excerpt of the 2026-09-25 publication, IDs
 * and values as published; the `FX-WALLET` entry is synthetic, carrying wallet
 * addresses in case-folding and case-significant shapes. Served at the fetch
 * boundary so a sync runs the real harvest, or parsed directly for an ingest.
 * @module tests/services/_lookup-corpus
 */

import { vi } from 'vitest';
import { DEFAULT_SOURCE_URLS } from '@/config/server-config.js';
import { parseEu, parseOfac, parseUk, parseUn } from '@/services/screening/sanctions-ingest.js';
import type { NormalizedDesignation, SourceCode } from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';

/** An EIP-55 mixed-case Ethereum address (the checksum example from EIP-55). */
export const ETH_CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
/** A base58 address — its letter case is significant. Synthetic. */
export const XBT_BASE58 = '1FixtureWa11etAddressXyzQ9mNpKt';
/** A bech32 address (the BIP-173 test vector). */
export const XBT_BECH32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const PROLOG = '<?xml version="1.0" encoding="utf-8"?>\n';

/** Each source's published document. */
export const LOOKUP_DOCUMENTS: Record<SourceCode, string> = {
  ofac_sdn: `${PROLOG}<sdnList>
    <sdnEntry><uid>4243</uid><lastName>EBANO</lastName><sdnType>Vessel</sdnType>
      <idList><id><idType>Vessel Registration Identification</idType><idNumber>IMO 7406784</idNumber></id></idList>
    </sdnEntry>
    <sdnEntry><uid>7203</uid><firstName>Mohamed Ben Belgacem</firstName><lastName>AOUADI</lastName><sdnType>Individual</sdnType>
      <idList>
        <id><idType>Italian Fiscal Code</idType><idNumber>DAOMMD74T11Z352Z</idNumber></id>
        <id><idType>Passport</idType><idNumber>L 191609</idNumber></id>
      </idList>
    </sdnEntry>
    <sdnEntry><uid>16085</uid><lastName>DAEDONG CREDIT BANK</lastName><sdnType>Entity</sdnType>
      <idList><id><idType>SWIFT/BIC</idType><idNumber>DCBKKPPY</idNumber></id></idList>
    </sdnEntry>
    <sdnEntry><uid>FX-WALLET</uid><firstName>Fixture</firstName><lastName>WALLETS</lastName><sdnType>Individual</sdnType>
      <idList>
        <id><idType>Digital Currency Address - ETH</idType><idNumber>${ETH_CHECKSUMMED}</idNumber></id>
        <id><idType>Digital Currency Address - XBT</idType><idNumber>${XBT_BASE58}</idNumber></id>
        <id><idType>Digital Currency Address - XBT</idType><idNumber>${XBT_BECH32}</idNumber></id>
      </idList>
    </sdnEntry>
  </sdnList>`,
  ofac_consolidated: `${PROLOG}<sdnList>
    <sdnEntry><uid>18722</uid><lastName>VTB BANK ARMENIA CLOSED JOINT STOCK COMPANY</lastName><sdnType>Entity</sdnType>
      <idList>
        <id><idType>Website</idType><idNumber>www.vtb.am</idNumber></id>
        <id><idType>SWIFT/BIC</idType><idNumber>ARMJAM22</idNumber></id>
      </idList>
    </sdnEntry>
  </sdnList>`,
  eu: `${PROLOG}<export>
    <sanctionEntity logicalId="927" euReferenceNumber="EU.3343.85">
      <subjectType code="person"/><nameAlias wholeName="Mohamed Ben Belkacem Aouadi" strong="true"/>
      <identification identificationTypeDescription="National identification card" number="04643632" countryDescription="TUNISIA"/>
      <identification identificationTypeDescription="National passport" number="L191609" countryDescription="TUNISIA"/>
    </sanctionEntity>
    <sanctionEntity logicalId="107842" euReferenceNumber="EU.4199.48">
      <subjectType code="enterprise"/><nameAlias wholeName="Dae-Dong Credit Bank" strong="true"/>
      <identification identificationTypeDescription="SWIFT BIC" number="DCBK KPPY"/>
    </sanctionEntity>
    <sanctionEntity logicalId="180078" euReferenceNumber="EU.13875.42">
      <subjectType code="enterprise"/><nameAlias wholeName="SCT Bankers" strong="true"/>
      <identification identificationTypeDescription="SWIFT BIC" number="SCERIRTHKSH" countryDescription="IRAN (ISLAMIC REPUBLIC OF)"/>
      <identification identificationTypeDescription="SWIFT BIC" number="SCTSAEA1" countryDescription="UNITED ARAB EMIRATES"/>
      <identification identificationTypeDescription="SWIFT BIC" number="SCERIRTH" countryDescription="IRAN (ISLAMIC REPUBLIC OF)"/>
    </sanctionEntity>
  </export>`,
  uk: `${PROLOG}<Designations>
    <Designation><UniqueID>RUS0251</UniqueID><OFSIGroupID>14196</OFSIGroupID><IndividualEntityShip>Individual</IndividualEntityShip>
      <Names><Name><Name1>Vladimir</Name1><Name2>Vladimirovich</Name2><Name6>PUTIN</Name6><NameType>Primary Name</NameType></Name></Names>
    </Designation>
    <Designation><UniqueID>BEL0005</UniqueID><OFSIGroupID>13923</OFSIGroupID><IndividualEntityShip>Individual</IndividualEntityShip>
      <Names><Name><Name1>Yuri</Name1><Name2>Khadzimuratovich</Name2><Name6>Karaev</Name6><NameType>Primary Name</NameType></Name></Names>
    </Designation>
    <Designation><UniqueID>GHR0055</UniqueID><OFSIGroupID>13923</OFSIGroupID><IndividualEntityShip>Individual</IndividualEntityShip>
      <Names><Name><Name1>Yuri</Name1><Name2>Khadzimuratovich</Name2><Name6>Karayev</Name6><NameType>Primary Name</NameType></Name></Names>
    </Designation>
    <Designation><UniqueID>AQD0239</UniqueID><OFSIGroupID>7024</OFSIGroupID><IndividualEntityShip>Individual</IndividualEntityShip>
      <Names><Name><Name1>MOHAMED BEN BELGACEM BEN ABDALLAH</Name1><Name6>AL-AOUADI</Name6><NameType>Primary Name</NameType></Name></Names>
      <IndividualDetails><Individual>
        <PassportDetails><Passport><PassportNumber>L 191609</PassportNumber></Passport></PassportDetails>
        <NationalIdentifierDetails>
          <NationalIdentifier><NationalIdentifierNumber>DAOMMD74T11Z352Z</NationalIdentifierNumber></NationalIdentifier>
          <NationalIdentifier><NationalIdentifierNumber>04643632</NationalIdentifierNumber></NationalIdentifier>
        </NationalIdentifierDetails>
      </Individual></IndividualDetails>
    </Designation>
    <Designation><UniqueID>RUS3686</UniqueID><IndividualEntityShip>Ship</IndividualEntityShip>
      <Names><Name><Name6>IMO 9274082 ("TM HAI HA 568")</Name6><NameType>Primary Name</NameType></Name></Names>
      <ShipDetails><Ship><IMONumbers><IMONumber>IMO9274082</IMONumber></IMONumbers></Ship></ShipDetails>
    </Designation>
  </Designations>`,
  un: `${PROLOG}<CONSOLIDATED_LIST>
    <INDIVIDUALS>
      <INDIVIDUAL><DATAID>111923</DATAID><REFERENCE_NUMBER>QDi.006</REFERENCE_NUMBER>
        <FIRST_NAME>AIMAN</FIRST_NAME><SECOND_NAME>MUHAMMED RABI</SECOND_NAME><THIRD_NAME>AL-ZAWAHIRI</THIRD_NAME>
        <COMMENTS1>Leader of Al-Qaida (QDe.004).</COMMENTS1>
        <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>Passport</TYPE_OF_DOCUMENT><NUMBER>1084010</NUMBER><ISSUING_COUNTRY>Egypt</ISSUING_COUNTRY></INDIVIDUAL_DOCUMENT>
      </INDIVIDUAL>
      <INDIVIDUAL><DATAID>6908841</DATAID><REFERENCE_NUMBER>QDi.426</REFERENCE_NUMBER>
        <FIRST_NAME>Amir</FIRST_NAME><SECOND_NAME>Muhammad Sa’id</SECOND_NAME><THIRD_NAME>Abdal-Rahman</THIRD_NAME><FOURTH_NAME>al-Salbi</FOURTH_NAME>
        <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>National Identification
Number</TYPE_OF_DOCUMENT><NUMBER>00278640</NUMBER></INDIVIDUAL_DOCUMENT>
      </INDIVIDUAL>
    </INDIVIDUALS>
    <ENTITIES>
      <ENTITY><DATAID>113458</DATAID><REFERENCE_NUMBER>QDe.004</REFERENCE_NUMBER><FIRST_NAME>AL-QAIDA</FIRST_NAME></ENTITY>
      <ENTITY><DATAID>6908499</DATAID><REFERENCE_NUMBER>KPe.023 </REFERENCE_NUMBER><FIRST_NAME>DAEDONG CREDIT BANK (DCB)</FIRST_NAME></ENTITY>
    </ENTITIES>
  </CONSOLIDATED_LIST>`,
};

/** The corpus as the ingest normalizes it, every source in display order. */
export function lookupDesignations(): NormalizedDesignation[] {
  const docs = LOOKUP_DOCUMENTS;
  return [
    ...parseOfac(parseXml(docs.ofac_sdn), 'ofac_sdn'),
    ...parseOfac(parseXml(docs.ofac_consolidated), 'ofac_consolidated'),
    ...parseEu(parseXml(docs.eu)),
    ...parseUk(parseXml(docs.uk)),
    ...parseUn(parseXml(docs.un)),
  ];
}

const URLS: Record<SourceCode, string> = {
  ofac_sdn: DEFAULT_SOURCE_URLS.ofacSdn,
  ofac_consolidated: DEFAULT_SOURCE_URLS.ofacConsolidated,
  eu: DEFAULT_SOURCE_URLS.euFsf,
  uk: DEFAULT_SOURCE_URLS.ukSanctions,
  un: DEFAULT_SOURCE_URLS.unSc,
};

/**
 * Serve each source's document at its default URL through a stubbed `fetch`,
 * with `overrides` replacing some. Undo with `vi.unstubAllGlobals()`.
 */
export function serveLookupCorpus(overrides: Partial<Record<SourceCode, string>> = {}): void {
  const bodies = new Map(
    (Object.keys(URLS) as SourceCode[]).map((source) => [
      URLS[source],
      overrides[source] ?? LOOKUP_DOCUMENTS[source],
    ]),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = bodies.get(url);
      return body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
    }),
  );
}
