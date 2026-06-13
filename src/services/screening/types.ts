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

/** A structured identifier (passport, national ID, tax ID, registration number, …). */
export interface IdentifierRecord {
  /** Issuing country/authority, when published. */
  country?: string;
  /** Identifier category as published (e.g. "Passport", "National ID"). */
  type: string;
  /** The identifier value. */
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
  /** Date string as published (ISO 8601 where the source provides a clean date). */
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
  /** Designation date, ISO 8601 where available. */
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
  source: SourceCode;
  /** The list's own entry ID (for `get_designation`). */
  sourceEntryId: string;
}

/** A GLEIF Level 1 entity record (who-is-who). */
export interface NormalizedLeiEntity {
  /** Single-line headquarters address. */
  headquartersAddress?: string;
  /** ISO 3166-1 alpha-2 jurisdiction, when published. */
  jurisdiction?: string;
  /** ISO 8601 last-update timestamp from the LEI record. */
  lastUpdate?: string;
  /** Single-line legal address. */
  legalAddress?: string;
  legalName: string;
  lei: string;
  /** Trading / other names published in the LEI record. */
  otherNames: string[];
  /** The entity's ID at its registration authority. */
  registrationAuthorityEntityId?: string;
  /** Registration authority identifier (RA code). */
  registrationAuthorityId?: string;
  /** Registration status (e.g. ISSUED, LAPSED). */
  status?: string;
}

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

/** Match classification, in descending confidence. */
export type MatchType = 'exact' | 'strong' | 'approximate';

/** The two screening match modes. */
export type MatchMode = 'strict' | 'fuzzy';

/** A scored screening hit returned by the matching engine. */
export interface ScreeningHit {
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
  /** The name (legal or other) that matched the query. */
  matchedName: string;
  matchType: MatchType;
  /** Raw Jaro-Winkler similarity for `approximate` hits only. */
  score?: number;
  status?: string;
}
