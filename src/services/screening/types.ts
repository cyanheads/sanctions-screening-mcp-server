/**
 * @fileoverview Common normalized schema for sanctions designations and GLEIF
 * legal-entity records, plus the matching-engine vocabulary. Every upstream
 * source (OFAC, EU, UK, UN, GLEIF) collapses onto these shapes so the matching
 * engine and tools never see a source-specific structure.
 * @module services/screening/types
 */

/** Source list codes — the value stored in `designation.source`. */
export type SourceCode = 'ofac_sdn' | 'ofac_consolidated' | 'eu' | 'uk' | 'un';

/** All sanctions source codes, in display order. */
export const SOURCE_CODES: readonly SourceCode[] = [
  'ofac_sdn',
  'ofac_consolidated',
  'eu',
  'uk',
  'un',
] as const;

/** Human-facing label per source, used in provenance and `sanctions_list_sources`. */
export const SOURCE_LABELS: Record<SourceCode, string> = {
  ofac_sdn: 'OFAC Specially Designated Nationals (SDN) List',
  ofac_consolidated: 'OFAC Consolidated Sanctions List',
  eu: 'EU Consolidated Financial Sanctions List',
  uk: 'UK Sanctions List (FCDO)',
  un: 'UN Security Council Consolidated List',
};

/** Coarse entity classification shared across all sources. */
export type EntityType = 'person' | 'organization' | 'vessel' | 'aircraft' | 'unknown';

/** Name-record provenance within a designation. */
export type NameType = 'primary' | 'aka' | 'fka' | 'low-quality-aka';

/** One name or alias attached to a designation. */
export interface NameRecord {
  /** The name as published. */
  name: string;
  /** Provenance of this name. */
  nameType: NameType;
}

/**
 * A structured identifier: an identity document (passport, national ID, tax ID,
 * registration number, …), or a value a source publishes alongside them (SWIFT/BIC,
 * digital-currency address, vessel call sign, aircraft tail number, phone number,
 * email address, website).
 */
export interface IdentifierRecord {
  /** Issuing country/authority, when published. */
  country?: string;
  /** Identifier category as the source labels it (e.g. "Passport", "SWIFT/BIC", "Website"). */
  type: string;
  /** The identifier value, verbatim. */
  value: string;
}

/** A published address (free-form components — sources vary widely). */
export interface AddressRecord {
  /** ISO country or country name, when published. */
  country?: string;
  /** Single-line rendering of the address, joined from whatever components were published. */
  full: string;
}

/** Date + place of birth (persons only). */
export interface DobRecord {
  /** Set when the source flags the date approximate; never without {@link DobRecord.date}. */
  circa?: true;
  /**
   * ISO 8601 at the precision the source published — `YYYY-MM-DD`, `YYYY-MM`, or
   * `YYYY`, or an interval whose ends keep their own precision (`1955/1957`,
   * `../1980` when one end is open). A value with no ISO form stays as published.
   */
  date?: string;
  /** Place of birth, when published. */
  place?: string;
}

/**
 * The full normalized record for one designation, stored as JSON in
 * `designation.payload` and surfaced by `sanctions_get_designation`.
 */
export interface DesignationPayload {
  addresses: AddressRecord[];
  aliases: NameRecord[];
  datesOfBirth: DobRecord[];
  identifiers: IdentifierRecord[];
  nationalities: string[];
  /** Free-form remarks/title published by the source, when present. */
  remarks?: string;
}

/**
 * One normalized designation — the unit an ingester yields and the row stored
 * in the primary `designation` table (with `payload` JSON-stringified).
 */
export interface NormalizedDesignation {
  /** The source's own designation date, `YYYY-MM-DD`, when published. */
  designationDate?: string;
  entityType: EntityType;
  /** `{source}:{sourceEntryId}` composite primary key. */
  id: string;
  /** Statutory / regulatory basis, when published. */
  legalBasis?: string;
  /** Full normalized detail. */
  payload: DesignationPayload;
  /** Primary name as published. */
  primaryName: string;
  /** Sanctioning program / regime, when published. */
  program?: string;
  /**
   * The list's published reference number, when it publishes one distinct from
   * {@link NormalizedDesignation.sourceEntryId}: UN `REFERENCE_NUMBER`, EU
   * `euReferenceNumber`, UK OFSI Group ID. Trimmed. Not unique within a source —
   * a UK Group ID can cover two designations.
   */
  referenceNumber?: string;
  source: SourceCode;
  /** The list's own entry ID (for `get_designation`). */
  sourceEntryId: string;
}

/** The type the name index gives an entity's legal name. */
export const LEGAL_NAME_TYPE = 'LEGAL_NAME';

/**
 * The type of a name stored without one — a mirror written before names were
 * typed kept other names as bare strings. Never read as a trading name.
 */
export const UNKNOWN_NAME_TYPE = 'UNKNOWN';

/**
 * A name a GLEIF record publishes beside its legal name, with the `type` GLEIF
 * gives it: `PREVIOUS_LEGAL_NAME`, `TRADING_OR_OPERATING_NAME`, or
 * `ALTERNATIVE_LANGUAGE_LEGAL_NAME` for an `OtherEntityName`;
 * `PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME` or
 * `AUTO_ASCII_TRANSLITERATED_LEGAL_NAME` for a `TransliteratedOtherEntityName`;
 * {@link UNKNOWN_NAME_TYPE} when none was stored. Kept open: GLEIF adds codes.
 */
export interface LeiAlternateName {
  name: string;
  type: string;
}

/** A GLEIF Level 1 entity record (who-is-who). */
export interface NormalizedLeiEntity {
  /**
   * Every other and transliterated name with its type, in document order — other
   * names first. Absent on a record with none, and on a record stored before
   * names were typed; the read path then derives it from {@link otherNames}.
   */
  alternateNames?: LeiAlternateName[];
  /** Single-line headquarters address. */
  headquartersAddress?: string;
  /**
   * Legal jurisdiction as published: an ISO 3166-1 alpha-2 country (`US`) or an
   * ISO 3166-2 subdivision (`US-DE`).
   */
  jurisdiction?: string;
  /** ISO 8601 last-update timestamp from the LEI record. */
  lastUpdate?: string;
  /** Single-line legal address. */
  legalAddress?: string;
  legalName: string;
  lei: string;
  /** The `OtherEntityName` values (trading, previous, alternative-language legal names). */
  otherNames: string[];
  /** The entity's ID at its registration authority. */
  registrationAuthorityEntityId?: string;
  /** Registration authority identifier (RA code). */
  registrationAuthorityId?: string;
  /** `RegistrationStatus` (ISSUED, LAPSED, RETIRED, …); absent when the record states none. */
  status?: string;
}

/**
 * A stored entity as the read path returns it, in one shape whichever release
 * stored it: `alternateNames` always present, derived from bare `otherNames` as
 * {@link UNKNOWN_NAME_TYPE} for a record stored before names were typed.
 */
export type LeiEntityRecord = NormalizedLeiEntity & { alternateNames: LeiAlternateName[] };

/** A GLEIF Level 2 relationship record (who-owns-whom). */
export interface NormalizedLeiRelationship {
  childLei: string;
  parentLei: string;
  /** Relationship period summary, when published. */
  relationshipPeriod?: string;
  /** Accounting/relationship status (e.g. ACTIVE, INACTIVE). */
  relationshipStatus?: string;
  /** e.g. IS_DIRECTLY_CONSOLIDATED_BY, IS_ULTIMATELY_CONSOLIDATED_BY. */
  relationshipType: string;
}

/**
 * One GLEIF Level 2 record as a file publishes it: the relationship's current
 * state, or — `deleted` — its removal. A delta carries only changed relationships,
 * so each record is applied on its own (child, parent, type) key.
 */
export interface LeiRelationshipChange extends NormalizedLeiRelationship {
  /** The record carried `<Extension><gleif:Deletion>`: GLEIF removed it. */
  deleted?: true;
}

/**
 * A GLEIF reporting exception: the entity's own statement of why it reports no
 * parent at one level — `DIRECT_ACCOUNTING_CONSOLIDATION_PARENT` or
 * `ULTIMATE_ACCOUNTING_CONSOLIDATION_PARENT` — with every reason it gave
 * (`NATURAL_PERSONS`, `NON_CONSOLIDATING`, `NO_KNOWN_PERSON`, …). An exception
 * explains an unreported parent; it never names one.
 */
export interface NormalizedReportingException {
  category: string;
  lei: string;
  /** The published reasons, in document order. Kept open: GLEIF adds codes. */
  reasons: string[];
}

/** One reporting-exception record as a file publishes it, or — `deleted` — its removal. */
export interface ReportingExceptionChange extends NormalizedReportingException {
  /** The record carried `<Extension><gleif:Deletion>`: GLEIF removed it. */
  deleted?: true;
}

/** The three GLEIF datasets the mirror holds, by their Golden Copy API names. */
export type GleifDataset = 'lei2' | 'rr' | 'repex';

/**
 * The GLEIF mirror's durable checkpoint: per dataset, the header `ContentDate` of
 * the last file applied to it (golden copy or delta). A dataset absent here has no
 * recorded load — for Level 1 and Level 2 that means `mirror:init`; for the
 * reporting exceptions, that its data is not loaded.
 */
export type GleifCheckpoint = Partial<Record<GleifDataset, string>>;

/** Match classification, in descending confidence. */
export type MatchType = 'exact' | 'strong' | 'approximate';

/**
 * How much of a multi-token query a candidate actually explains: a literal count
 * of query tokens that individually clear the applied score floor against one of
 * the candidate's tokens, alongside the query's total token count.
 *
 * This is a second real measurement, never a blend — `score` stays the raw
 * Jaro-Winkler value. It exists because `score` is the max over a whole-string
 * and a single best token-pair comparison, so any two candidates sharing one
 * exact query token both report 1.0 no matter how much of the rest of the query
 * they explain. Coverage separates those ties and is surfaced so a caller can
 * account for the resulting order.
 */
export interface QueryTokenCoverage {
  /** Query tokens individually matched by some candidate token, at the applied floor. */
  covered: number;
  /** Total tokens in the folded query. */
  total: number;
}

/** The two screening match modes. */
export type MatchMode = 'strict' | 'fuzzy';

/** A scored screening hit returned by the matching engine. */
export interface ScreeningHit {
  /** The source's own designation date, `YYYY-MM-DD`, when published. */
  designationDate?: string;
  /** `{source}:{sourceEntryId}` of the matched designation. */
  designationId: string;
  entityType: EntityType;
  /** The specific name/alias string that matched the query. */
  matchedName: string;
  /** Provenance of the matched name (primary / aka / fka / low-quality-aka). */
  matchedNameType: NameType;
  matchType: MatchType;
  /** Primary published name of the matched designation. */
  primaryName: string;
  program?: string;
  /**
   * Query-token coverage for `approximate` hits — the ranking key applied after
   * {@link ScreeningHit.score}. Omitted for exact/strong hits, which are ranked
   * by match type.
   */
  queryTokenCoverage?: QueryTokenCoverage;
  /** The list's published reference number, when it publishes one. */
  referenceNumber?: string;
  /**
   * Raw Jaro-Winkler similarity (0–1) for `approximate` hits — a real
   * measurement, never a fabricated composite. Omitted for exact/strong hits,
   * which are deterministic and not scored.
   */
  score?: number;
  source: SourceCode;
  sourceEntryId: string;
}

/** A scored LEI resolution candidate. */
export interface LeiMatch {
  jurisdiction?: string;
  legalName: string;
  lei: string;
  /** The name (legal, other, or transliterated) that matched the query. */
  matchedName: string;
  /** {@link LEGAL_NAME_TYPE}, a {@link LeiAlternateName} type, or {@link UNKNOWN_NAME_TYPE}. */
  matchedNameType: string;
  matchType: MatchType;
  /**
   * Query-token coverage of {@link LeiMatch.matchedName} for `approximate`
   * matches — the ranking key applied after {@link LeiMatch.score}.
   */
  queryTokenCoverage?: QueryTokenCoverage;
  /** Raw Jaro-Winkler similarity for `approximate` hits only. */
  score?: number;
  status?: string;
}
