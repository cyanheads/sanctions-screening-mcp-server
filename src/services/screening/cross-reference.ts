/**
 * @fileoverview The GLEIF → sanctions cross-reference behind `sanctions_get_entity`
 * and, per node, `sanctions_trace_ownership` (`screenNodes: true`). It screens
 * the entity's legal name and every other and transliterated name strict —
 * exact, then all tokens present, never fuzzy — and looks up its LEI and its
 * registration-authority ID as non-document identifiers, the registration ID
 * matching only an identifier published for the country of the entity's legal
 * jurisdiction. An ownership node with no Level 1 record has only its LEI, which
 * is looked up and never screened as a name. Hits merge to one per designation,
 * an OFAC entry's SDN and Consolidated records to one, each naming every input
 * that produced it, and the cap applies after the merge.
 * @module services/screening/cross-reference
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { countryCodeOf } from '@/services/screening/country-codes.js';
import { componentText } from '@/services/screening/sanctions-ingest.js';
import {
  type CountBasis,
  compareDesignationIdentity,
  groupOfacCopies,
  type IdentifierHit,
  type ScreeningService,
} from '@/services/screening/screening-service.js';
import { fold } from '@/services/screening/text-matching.js';
import {
  type IdentifierRecord,
  type LeiEntityRecord,
  type MatchType,
  type ScreeningHit,
  SOURCE_CODES,
  type SourceCode,
} from '@/services/screening/types.js';

/** One published value of the entity the cross-reference screened. */
export interface ScreenedInput {
  input: 'legal_name' | 'other_name' | 'lei' | 'registration_number';
  /** GLEIF's type for an other name, or `UNKNOWN` where the mirror stored none. */
  nameType?: string;
  /** The value as GLEIF publishes it. */
  value: string;
}

/** One designation the cross-reference reached, with everything that reached it. */
export interface CrossReferenceHit {
  /** The identifiers that matched the LEI or the registration number, as published. */
  matchedIdentifiers?: IdentifierRecord[];
  /** The designation alias of the strongest name match; absent on an identifier-only hit. */
  matchedName?: string;
  /** Every input that produced the hit, in screening order. */
  matchedOn: ScreenedInput[];
  matchType?: MatchType;
  primaryName: string;
  score?: number;
  /**
   * The list whose record `primaryName` comes from. On an OFAC party both OFAC
   * lists publish, the match fields cover what either record matched.
   */
  source: SourceCode;
  sourceEntryId: string;
  /** Every list whose record of this entry an input reached — see `ScreeningHit.sources`. */
  sources: SourceCode[];
}

/** What the cross-reference found, capped, and what it screened. */
export interface CrossReferenceResult {
  hits: CrossReferenceHit[];
  /**
   * The inputs screened beyond the legal name and the LEI, which a Level 1
   * record always has screened; empty for an entity with no record, whose LEI
   * lookup is all that ran.
   */
  screenedInputs: ScreenedInput[];
  /** Distinct designations across every input, an OFAC entry on both OFAC lists once, before the cap. */
  totalAvailable: number;
  /**
   * `exact`: every name screen is strict, and a strict screen counts the whole
   * set its tokens reach. It reads `lower_bound` only if a constituent name
   * screen's own count ever were one.
   */
  totalAvailableBasis: CountBasis;
}

/** One input and what it reached: strict name hits, or gated identifier hits. */
export interface InputResult {
  identifierHits?: readonly IdentifierHit[];
  input: ScreenedInput;
  nameHits?: readonly ScreeningHit[];
}

/**
 * What the cross-reference reads: the fields of a Level 1 record, or the LEI
 * alone of an ownership node GLEIF publishes no Level 1 record for — an entity
 * without names, so its LEI lookup is all that runs.
 */
export type CrossReferenceEntity =
  | Pick<
      LeiEntityRecord,
      'alternateNames' | 'jurisdiction' | 'legalName' | 'lei' | 'registrationAuthorityEntityId'
    >
  | { legalName?: never; lei: string };

const MATCH_BAND: Record<MatchType, number> = { exact: 0, strong: 1, approximate: 2 };

/** An identifier match is as reliable as an exact name match, so it ranks with one. */
const bandOf = (hit: CrossReferenceHit): number =>
  hit.matchedIdentifiers ? MATCH_BAND.exact : MATCH_BAND[hit.matchType ?? 'approximate'];

const sameIdentifier = (a: IdentifierRecord, b: IdentifierRecord): boolean =>
  a.type === b.type && a.value === b.value && a.country === b.country;

/** Append each identifier `held` does not already list, in order. */
function addIdentifiers(held: IdentifierRecord[], more: readonly IdentifierRecord[]): void {
  for (const identifier of more) {
    if (!held.some((kept) => sameIdentifier(kept, identifier))) held.push(identifier);
  }
}

/** A hit's name match: the alias that matched, its band, and an approximate match's score. */
type NameMatch = Pick<CrossReferenceHit, 'matchedName' | 'matchType' | 'score'>;

/** The name match to keep: `next` only when strictly stronger, so the first strongest stays. */
function strongerName<T extends NameMatch>(held: T | undefined, next: T): T | undefined {
  if (next.matchType === undefined) return held;
  return held?.matchType === undefined || MATCH_BAND[next.matchType] < MATCH_BAND[held.matchType]
    ? next
    : held;
}

/** One merged hit: the record it is attributed to, the name match kept, and what produced it. */
function crossReferenceHit(
  record: Pick<CrossReferenceHit, 'primaryName' | 'source' | 'sourceEntryId' | 'sources'>,
  named: NameMatch | undefined,
  identifiers: IdentifierRecord[],
  matchedOn: ScreenedInput[],
): CrossReferenceHit {
  const matchedName = named?.matchedName;
  const matchType = named?.matchType;
  const score = named?.score;
  return {
    source: record.source,
    sourceEntryId: record.sourceEntryId,
    primaryName: record.primaryName,
    ...(matchedName !== undefined && matchType !== undefined
      ? { matchedName, matchType, ...(score !== undefined ? { score } : {}) }
      : {}),
    ...(identifiers.length > 0 ? { matchedIdentifiers: identifiers } : {}),
    matchedOn,
    sources: record.sources,
  };
}

/**
 * Merge every input's hits to one per designation (`source:sourceEntryId`),
 * then an OFAC party's two records to one ({@link groupOfacCopies}):
 * `matchedOn` lists each input that reached the designation (either record of
 * an OFAC party), in screening order, `matchedName` / `matchType` / `score`
 * come from the first strongest name match, `matchedIdentifiers` unions the
 * identifiers that matched, each once, and `sources` unions the lists each
 * producer's hit names. Ordered exact (an identifier hit included) before
 * strong, then by designation identity.
 */
export function mergeCrossReferenceHits(results: readonly InputResult[]): CrossReferenceHit[] {
  interface Producers {
    bestName?: ScreeningHit | undefined;
    identifiers: IdentifierRecord[];
    matchedOn: ScreenedInput[];
    primaryName: string;
    source: SourceCode;
    sourceEntryId: string;
    sources: SourceCode[];
  }
  const byDesignation = new Map<string, Producers>();
  const producersOf = (
    hit: Pick<Producers, 'primaryName' | 'source' | 'sourceEntryId' | 'sources'>,
  ) => {
    const key = `${hit.source}:${hit.sourceEntryId}`;
    const held = byDesignation.get(key);
    if (!held) {
      const { primaryName, source, sourceEntryId, sources } = hit;
      const fresh: Producers = {
        primaryName,
        source,
        sourceEntryId,
        sources,
        identifiers: [],
        matchedOn: [],
      };
      byDesignation.set(key, fresh);
      return fresh;
    }
    held.sources = SOURCE_CODES.filter(
      (code) => held.sources.includes(code) || hit.sources.includes(code),
    );
    return held;
  };

  for (const { input, nameHits = [], identifierHits = [] } of results) {
    for (const hit of nameHits) {
      const held = producersOf(hit);
      held.matchedOn.push(input);
      held.bestName = strongerName(held.bestName, hit);
    }
    for (const hit of identifierHits) {
      const held = producersOf(hit);
      held.matchedOn.push(input);
      addIdentifiers(held.identifiers, hit.matchedIdentifiers);
    }
  }

  const ranked = [...byDesignation.values()]
    .map(({ bestName, identifiers, matchedOn, ...record }) =>
      crossReferenceHit(record, bestName, identifiers, matchedOn),
    )
    .sort((a, b) => bandOf(a) - bandOf(b) || compareDesignationIdentity(a, b));

  // Each screen and lookup already returns one hit per OFAC entry; two inputs
  // can still reach an entry's two records apart when the records' names or
  // identifiers differ. The grouped hit keeps what both records matched, so
  // every input that produced the party stays in matchedOn.
  const inputs = results.map(({ input }) => input);
  return groupOfacCopies(ranked, (kept, other) => {
    const identifiers = [...(kept.matchedIdentifiers ?? [])];
    addIdentifiers(identifiers, other.matchedIdentifiers ?? []);
    return crossReferenceHit(
      kept,
      strongerName(kept, other),
      identifiers,
      inputs.filter((input) => kept.matchedOn.includes(input) || other.matchedOn.includes(input)),
    );
  });
}

/**
 * Cross-reference one GLEIF entity against every loaded watchlist and return the
 * first `limit` merged hits. Each distinct name fold is screened once and its
 * hits attributed to every input with that fold; an other name that folds to
 * nothing cannot be screened and is not listed. The registration number is
 * looked up only when the entity publishes a jurisdiction to gate it by, and a
 * not-available placeholder (`N/A`, `n.a.`) is no number: never looked up or
 * listed, by the rule ingest applies to every list's detail values. An
 * entity with no Level 1 record has no name, other name, or registration number,
 * so it is looked up by its LEI alone.
 */
export async function crossReferenceEntity(
  svc: Pick<ScreeningService, 'screenIdentifier' | 'screenName'>,
  entity: CrossReferenceEntity,
  limit: number,
  ctx: Context,
): Promise<CrossReferenceResult> {
  const sources = [...SOURCE_CODES];
  const record = entity.legalName === undefined ? undefined : entity;
  const otherNames: ScreenedInput[] = [];
  for (const { name, type } of record?.alternateNames ?? []) {
    if (fold(name) === '') continue;
    if (otherNames.some((held) => held.value === name && held.nameType === type)) continue;
    otherNames.push({ input: 'other_name', value: name, nameType: type });
  }
  const country = record?.jurisdiction?.split('-')[0]?.toUpperCase();
  // GLEIF writes `N/A` and `n.a.` where an entity has no registry number.
  const registrationNumber = componentText(record?.registrationAuthorityEntityId);
  const registration: ScreenedInput | undefined =
    country && registrationNumber
      ? { input: 'registration_number', value: registrationNumber }
      : undefined;

  let totalAvailableBasis: CountBasis = 'exact';
  const screensByFold = new Map<string, readonly ScreeningHit[]>();
  const screen = async (input: ScreenedInput): Promise<InputResult> => {
    const key = fold(input.value);
    let nameHits = screensByFold.get(key);
    if (!nameHits) {
      const result = await svc.screenName(
        {
          query: input.value,
          entityType: 'any',
          matchMode: 'strict',
          // Strict only: a fuzzy pass fills its candidate cap with designations
          // that share no more than a legal-form token (PAO, Oil Company).
          autoFallback: false,
          sources,
          // Every strict hit: the cap applies after the merge.
          limit: Number.POSITIVE_INFINITY,
        },
        ctx,
      );
      if (result.totalAvailableBasis === 'lower_bound') totalAvailableBasis = 'lower_bound';
      nameHits = result.hits;
      screensByFold.set(key, nameHits);
    }
    return { input, nameHits };
  };
  const lookUp = async (input: ScreenedInput): Promise<InputResult> => {
    const hits = await svc.screenIdentifier({ value: input.value, type: 'other', sources });
    if (input.input !== 'registration_number') return { input, identifierHits: hits };
    // A registry number is unique within its registry only: keep the identifiers
    // a list publishes for the country of the entity's legal jurisdiction.
    const gated = hits.flatMap((hit) => {
      const kept = hit.matchedIdentifiers.filter(
        (identifier) =>
          identifier.country !== undefined && countryCodeOf(identifier.country) === country,
      );
      return kept.length > 0 ? [{ ...hit, matchedIdentifiers: kept }] : [];
    });
    return { input, identifierHits: gated };
  };

  const results: InputResult[] = record
    ? [await screen({ input: 'legal_name', value: record.legalName })]
    : [];
  results.push(await lookUp({ input: 'lei', value: entity.lei }));
  for (const input of otherNames) results.push(await screen(input));
  if (registration) results.push(await lookUp(registration));

  const merged = mergeCrossReferenceHits(results);
  return {
    hits: merged.slice(0, limit),
    totalAvailable: merged.length,
    totalAvailableBasis,
    screenedInputs: registration ? [...otherNames, registration] : otherNames,
  };
}
