/**
 * @fileoverview The cross-reference merge and its count basis
 * (`src/services/screening/cross-reference.ts`): one hit per designation, every
 * producer attributed, identifiers each listed once, identifier hits ranked with
 * exact name hits, and the union count's basis a floor whenever one name
 * screen's was.
 * @module tests/services/cross-reference.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  crossReferenceEntity,
  type InputResult,
  mergeCrossReferenceHits,
  type ScreenedInput,
} from '@/services/screening/cross-reference.js';
import type {
  IdentifierHit,
  ScreenIdentifierOptions,
  ScreenNameOptions,
  ScreenNameResult,
} from '@/services/screening/screening-service.js';
import type { ScreeningHit, SourceCode } from '@/services/screening/types.js';

const nameHit = (
  source: SourceCode,
  sourceEntryId: string,
  matchType: 'exact' | 'strong',
  matchedName: string,
  sources: SourceCode[] = [source],
): ScreeningHit => ({
  designationId: `${source}:${sourceEntryId}`,
  source,
  sourceEntryId,
  entityType: 'organization',
  primaryName: `Primary ${sourceEntryId}`,
  matchedName,
  matchedNameType: 'aka',
  matchType,
  sources,
});

const identifierHit = (
  source: SourceCode,
  sourceEntryId: string,
  identifiers: IdentifierHit['matchedIdentifiers'],
): IdentifierHit => ({
  source,
  sourceEntryId,
  entityType: 'organization',
  primaryName: `Primary ${sourceEntryId}`,
  matchedIdentifiers: identifiers,
  sources: [source],
});

const LEI = '253400DYLWR5A6YAWJ69';
const legal: ScreenedInput = { input: 'legal_name', value: 'Legal Name' };
const leiInput: ScreenedInput = { input: 'lei', value: LEI };
const other: ScreenedInput = { input: 'other_name', value: 'Trade Name', nameType: 'TRADING' };
const registration: ScreenedInput = { input: 'registration_number', value: LEI };

describe('mergeCrossReferenceHits', () => {
  it('lists each identifier once when the LEI and the registration number are the same value', () => {
    const published = { type: 'Legal Entity Number', value: LEI };
    const results: InputResult[] = [
      { input: leiInput, identifierHits: [identifierHit('eu', '9', [published])] },
      { input: registration, identifierHits: [identifierHit('eu', '9', [published])] },
    ];
    expect(mergeCrossReferenceHits(results)).toEqual([
      {
        source: 'eu',
        sourceEntryId: '9',
        primaryName: 'Primary 9',
        matchedIdentifiers: [published],
        matchedOn: [leiInput, registration],
        sources: ['eu'],
      },
    ]);
  });

  it('keeps the first strongest name match and every producer, in input order', () => {
    const [merged] = mergeCrossReferenceHits([
      { input: legal, nameHits: [nameHit('uk', '5', 'strong', 'LEGAL NAME PJSC')] },
      { input: other, nameHits: [nameHit('uk', '5', 'exact', 'Trade Name')] },
    ]);
    expect(merged).toEqual({
      source: 'uk',
      sourceEntryId: '5',
      primaryName: 'Primary 5',
      matchedName: 'Trade Name',
      matchType: 'exact',
      matchedOn: [legal, other],
      sources: ['uk'],
    });
  });

  it('unions the lists every producer reached for one designation', () => {
    const both: SourceCode[] = ['ofac_sdn', 'ofac_consolidated'];
    const [merged] = mergeCrossReferenceHits([
      { input: legal, nameHits: [nameHit('ofac_sdn', '17', 'exact', 'x')] },
      { input: other, nameHits: [nameHit('ofac_sdn', '17', 'strong', 'y', both)] },
    ]);
    expect(merged?.sources).toEqual(both);
  });

  it("groups an OFAC party's two records, keeping the kept record's name match on a tie", () => {
    const merged = mergeCrossReferenceHits([
      { input: legal, nameHits: [nameHit('ofac_sdn', '9', 'strong', 'Legal Name Bank')] },
      { input: other, nameHits: [nameHit('ofac_consolidated', '9', 'strong', 'Trade Name Ltd')] },
    ]);
    expect(merged).toEqual([
      {
        source: 'ofac_sdn',
        sourceEntryId: '9',
        primaryName: 'Primary 9',
        matchedName: 'Legal Name Bank',
        matchType: 'strong',
        matchedOn: [legal, other],
        sources: ['ofac_sdn', 'ofac_consolidated'],
      },
    ]);
  });

  it('takes the stronger name match from the other OFAC record, behind an identifier-only kept record', () => {
    const merged = mergeCrossReferenceHits([
      {
        input: leiInput,
        identifierHits: [identifierHit('ofac_sdn', '9', [{ type: 'LEI', value: LEI }])],
      },
      { input: other, nameHits: [nameHit('ofac_consolidated', '9', 'strong', 'Trade Name Ltd')] },
      { input: legal, nameHits: [nameHit('un', '4', 'exact', 'Legal Name')] },
    ]);
    // Both rank exact (an identifier hit ranks with one), so identity orders them.
    expect(merged.map((hit) => `${hit.source}:${hit.sourceEntryId}`)).toEqual([
      'ofac_sdn:9',
      'un:4',
    ]);
    expect(merged[0]).toEqual({
      source: 'ofac_sdn',
      sourceEntryId: '9',
      primaryName: 'Primary 9',
      matchedName: 'Trade Name Ltd',
      matchType: 'strong',
      matchedIdentifiers: [{ type: 'LEI', value: LEI }],
      matchedOn: [leiInput, other],
      sources: ['ofac_sdn', 'ofac_consolidated'],
    });
  });

  it('ranks an identifier-only hit with exact name hits, ahead of strong ones, ties by designation identity', () => {
    const merged = mergeCrossReferenceHits([
      {
        input: legal,
        nameHits: [nameHit('ofac_sdn', '20', 'strong', 'x'), nameHit('un', '3', 'exact', 'y')],
      },
      {
        input: leiInput,
        identifierHits: [identifierHit('eu', '7', [{ type: 'LEI', value: LEI }])],
      },
    ]);
    expect(merged.map((hit) => `${hit.source}:${hit.sourceEntryId}`)).toEqual([
      'eu:7',
      'un:3',
      'ofac_sdn:20',
    ]);
  });

  it('returns nothing when no input reached a designation', () => {
    expect(mergeCrossReferenceHits([{ input: legal, nameHits: [] }])).toEqual([]);
    expect(mergeCrossReferenceHits([])).toEqual([]);
  });
});

describe('crossReferenceEntity', () => {
  /** A service answering every name screen from `screens`, every identifier lookup with nothing. */
  const fakeService = (screens: Record<string, Partial<ScreenNameResult>>) => {
    const calls: { identifiers: ScreenIdentifierOptions[]; names: ScreenNameOptions[] } = {
      identifiers: [],
      names: [],
    };
    return {
      calls,
      svc: {
        screenName: async (opts: ScreenNameOptions): Promise<ScreenNameResult> => {
          calls.names.push(opts);
          return {
            hits: [],
            totalAvailable: 0,
            totalAvailableBasis: 'exact',
            fuzzyFallbackTriggered: false,
            modeUsed: 'strict',
            normalizedQuery: opts.query,
            poolBounded: false,
            ...screens[opts.query],
          };
        },
        screenIdentifier: async (opts: ScreenIdentifierOptions): Promise<IdentifierHit[]> => {
          calls.identifiers.push(opts);
          return [];
        },
      },
    };
  };

  const entity = {
    lei: LEI,
    legalName: 'Legal Name',
    alternateNames: [{ name: 'Trade Name', type: 'TRADING_OR_OPERATING_NAME' }],
  };

  it('reports a lower-bound count when any name screen counted a bounded scan', async () => {
    const { svc } = fakeService({
      'Trade Name': {
        hits: [nameHit('uk', '1', 'strong', 'Trade Name Ltd')],
        totalAvailable: 1,
        totalAvailableBasis: 'lower_bound',
      },
    });
    const result = await crossReferenceEntity(svc, entity, 10, createMockContext());
    expect(result).toMatchObject({ totalAvailable: 1, totalAvailableBasis: 'lower_bound' });
  });

  it('screens strict with no fuzzy fallback and no cap, and looks up the LEI as a non-document identifier', async () => {
    const { svc, calls } = fakeService({});
    const result = await crossReferenceEntity(svc, entity, 10, createMockContext());
    expect(result.totalAvailableBasis).toBe('exact');
    expect(calls.names.map((opts) => opts.query)).toEqual(['Legal Name', 'Trade Name']);
    for (const opts of calls.names) {
      expect(opts).toMatchObject({
        matchMode: 'strict',
        autoFallback: false,
        limit: Number.POSITIVE_INFINITY,
      });
    }
    // No jurisdiction and no registration number: the LEI lookup alone.
    expect(calls.identifiers.map(({ value, type }) => ({ value, type }))).toEqual([
      { value: LEI, type: 'other' },
    ]);
  });

  it('groups an OFAC entry two inputs reached on different lists into the better-ranked record, keeping every producer', async () => {
    // The legal name reached both OFAC records, already one hit; the trade name
    // reached the Consolidated record alone, as it would were its aliases out of step.
    const { svc } = fakeService({
      'Legal Name': {
        hits: [nameHit('ofac_sdn', '17', 'exact', 'Legal Name', ['ofac_sdn', 'ofac_consolidated'])],
      },
      'Trade Name': { hits: [nameHit('ofac_consolidated', '17', 'strong', 'Trade Name Ltd')] },
    });
    const result = await crossReferenceEntity(svc, entity, 10, createMockContext());
    expect(result.totalAvailable).toBe(1);
    expect(result.hits).toEqual([
      {
        source: 'ofac_sdn',
        sourceEntryId: '17',
        primaryName: 'Primary 17',
        matchedName: 'Legal Name',
        matchType: 'exact',
        // The trade name produced the Consolidated record, so it produced the party.
        matchedOn: [
          legal,
          { input: 'other_name', value: 'Trade Name', nameType: 'TRADING_OR_OPERATING_NAME' },
        ],
        sources: ['ofac_sdn', 'ofac_consolidated'],
      },
    ]);
  });

  it("carries both OFAC records' producers, identifiers, and stronger name match when the records differ", async () => {
    // The legal name reaches only the Consolidated record, the LEI only the SDN
    // record, and the registration number the Consolidated record again.
    const REGISTRATION = '1027700043502';
    const leiId = { type: 'Legal Entity Number', value: LEI };
    const registrationId = { type: 'Registration Number', value: REGISTRATION, country: 'Russia' };
    const { svc } = fakeService({
      'Legal Name': { hits: [nameHit('ofac_consolidated', 'X1', 'exact', 'LEGAL NAME')] },
    });
    svc.screenIdentifier = async (opts) =>
      opts.value === LEI
        ? [identifierHit('ofac_sdn', 'X1', [leiId])]
        : opts.value === REGISTRATION
          ? [identifierHit('ofac_consolidated', 'X1', [registrationId, leiId])]
          : [];
    const result = await crossReferenceEntity(
      svc,
      {
        ...entity,
        alternateNames: [],
        jurisdiction: 'RU',
        registrationAuthorityEntityId: REGISTRATION,
      },
      10,
      createMockContext(),
    );
    expect(result.totalAvailable).toBe(1);
    expect(result.hits).toEqual([
      {
        source: 'ofac_sdn',
        sourceEntryId: 'X1',
        primaryName: 'Primary X1',
        matchedName: 'LEGAL NAME',
        matchType: 'exact',
        matchedIdentifiers: [leiId, registrationId],
        matchedOn: [legal, leiInput, { input: 'registration_number', value: REGISTRATION }],
        sources: ['ofac_sdn', 'ofac_consolidated'],
      },
    ]);
  });

  it('never looks up a not-available registration number, by the ingest placeholder rule', async () => {
    for (const placeholder of ['N/A', 'n.a.', 'UNKNOWN', '--']) {
      const { svc, calls } = fakeService({});
      const result = await crossReferenceEntity(
        svc,
        {
          ...entity,
          alternateNames: [],
          jurisdiction: 'GB',
          registrationAuthorityEntityId: placeholder,
        },
        10,
        createMockContext(),
      );
      expect(
        calls.identifiers.map(({ value }) => value),
        placeholder,
      ).toEqual([LEI]);
      expect(result.screenedInputs, placeholder).toEqual([]);
    }
  });

  it('screens no name for an entity with no Level 1 record: its LEI lookup alone', async () => {
    const { svc, calls } = fakeService({});
    svc.screenIdentifier = async (opts) => {
      calls.identifiers.push(opts);
      return [identifierHit('eu', '9', [{ type: 'Legal Entity Number', value: LEI }])];
    };
    const result = await crossReferenceEntity(svc, { lei: LEI }, 10, createMockContext());

    expect(calls.names).toEqual([]);
    expect(calls.identifiers.map(({ value, type }) => ({ value, type }))).toEqual([
      { value: LEI, type: 'other' },
    ]);
    expect(result).toEqual({
      hits: [
        {
          source: 'eu',
          sourceEntryId: '9',
          primaryName: 'Primary 9',
          matchedIdentifiers: [{ type: 'Legal Entity Number', value: LEI }],
          matchedOn: [leiInput],
          sources: ['eu'],
        },
      ],
      totalAvailable: 1,
      totalAvailableBasis: 'exact',
      screenedInputs: [],
    });
  });

  it('screens each distinct fold once and skips a name that folds to nothing', async () => {
    const { svc, calls } = fakeService({});
    const result = await crossReferenceEntity(
      svc,
      {
        ...entity,
        alternateNames: [
          { name: 'LEGAL  NAME', type: 'PREVIOUS_LEGAL_NAME' },
          { name: '--', type: 'TRADING_OR_OPERATING_NAME' },
        ],
      },
      10,
      createMockContext(),
    );
    expect(calls.names.map((opts) => opts.query)).toEqual(['Legal Name']);
    expect(result.screenedInputs).toEqual([
      { input: 'other_name', value: 'LEGAL  NAME', nameType: 'PREVIOUS_LEGAL_NAME' },
    ]);
  });
});
