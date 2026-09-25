/**
 * @fileoverview `sanctions_screen_identifier` (issue #41) over a mirror holding
 * the synthetic fixture plus a source-shaped corpus, so each stored identifier is
 * the ingest's own read. Driven through `runToolContract` — input parse, handler,
 * output validation, `format()`, enrichment, error envelope — against the real
 * service and store, nothing stubbed but the upstream fetch in the sync case.
 * @module tests/tools/screen-identifier.test
 */

import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screenIdentifierTool } from '@/mcp-server/tools/definitions/screen-identifier.tool.js';
import { IDENTIFIER_TABLE } from '@/services/screening/schema.js';
import type { NormalizedDesignation } from '@/services/screening/types.js';
import {
  emptyGlobalService,
  type SeededService,
  seededGlobalService,
} from '../services/_helpers.js';
import {
  ETH_CHECKSUMMED,
  LOOKUP_DOCUMENTS,
  lookupDesignations,
  serveLookupCorpus,
  XBT_BASE58,
  XBT_BECH32,
} from '../services/_lookup-corpus.js';

interface Hit {
  matchedIdentifiers: { country?: string; type: string; value: string }[];
  primaryName: string;
  source: string;
  sourceEntryId: string;
}

interface Screened {
  caveat: string;
  hits: Hit[];
  ids: string[];
  notice?: string;
  text: string;
  totalCount: number;
}

/** Run the tool through its contract and return both surfaces. */
async function screen(input: Record<string, unknown>): Promise<Screened> {
  const result = await runToolContract(screenIdentifierTool, input as never);
  expect(result.isError).toBeFalsy();
  const structured = result.structuredContent as {
    caveat: string;
    hits: Hit[];
    notice?: string;
    totalCount: number;
  };
  return {
    ...structured,
    ids: structured.hits.map((hit) => `${hit.source}:${hit.sourceEntryId}`),
    text: result.content.map((c) => ('text' in c ? c.text : '')).join('\n'),
  };
}

const ctxFor = <const E extends readonly ErrorContract[] | undefined>(errors: E) =>
  createMockContext({ errors });

describe('sanctions_screen_identifier (seeded)', () => {
  let seeded: SeededService;
  beforeEach(async () => {
    seeded = await seededGlobalService();
    await seeded.service.ingestDesignations(lookupDesignations());
  });
  afterEach(async () => {
    await seeded.cleanup();
  });

  it.each([
    ['7406784', 'any'],
    ['IMO 7406784', 'any'],
    ['imo7406784', 'any'],
    ['7406784', 'imo'],
    ['IMO 7406784', 'imo'],
    ['imo7406784', 'imo'],
  ])('finds the vessel publishing IMO 7406784 from %j (type %s)', async (value, type) => {
    const result = await screen({ value, type });
    expect(result.ids).toEqual(['ofac_sdn:4243']);
    expect(result.hits[0]?.matchedIdentifiers).toEqual([
      { type: 'Vessel Registration Identification', value: 'IMO 7406784' },
    ]);
    expect(result.text).toContain('- **Vessel Registration Identification:** IMO 7406784');
  });

  it('does not match an IMO number filed under another category', async () => {
    expect((await screen({ value: '7406784', type: 'passport' })).hits).toEqual([]);
  });

  it('matches one passport number across three lists, each spelling as published', async () => {
    const result = await screen({ value: 'L191609', type: 'passport' });
    expect(result.ids).toEqual(['ofac_sdn:7203', 'eu:927', 'uk:AQD0239']);
    expect(result.hits.map((hit) => hit.matchedIdentifiers)).toEqual([
      [{ type: 'Passport', value: 'L 191609' }],
      [{ type: 'National passport', value: 'L191609', country: 'TUNISIA' }],
      [{ type: 'Passport', value: 'L 191609' }],
    ]);
    expect(result.totalCount).toBe(3);
    expect(result.text).toContain('3 designation(s) publish a matching identifier');
    for (const line of ['**Passport:** L 191609\n', '**National passport:** L191609 (TUNISIA)']) {
      expect(result.text).toContain(line);
    }
  });

  it('matches one national ID across two lists, and the same person under an OFAC fiscal code via type any', async () => {
    expect((await screen({ value: '04643632', type: 'national_id' })).ids).toEqual([
      'eu:927',
      'uk:AQD0239',
    ]);
    // Only the UK files the Italian fiscal code as a national identifier.
    expect((await screen({ value: 'daommd74t11z352z', type: 'national_id' })).ids).toEqual([
      'uk:AQD0239',
    ]);
    expect((await screen({ value: 'daommd74t11z352z' })).ids).toEqual([
      'ofac_sdn:7203',
      'uk:AQD0239',
    ]);
  });

  it('restricts hits to the requested sources', async () => {
    const result = await screen({ value: 'L191609', type: 'passport', sources: ['eu', 'uk'] });
    expect(result.ids).toEqual(['eu:927', 'uk:AQD0239']);
  });

  it('matches a SWIFT/BIC published with a space, from either list that publishes it', async () => {
    expect((await screen({ value: 'dcbkkppy' })).ids).toEqual(['ofac_sdn:16085', 'eu:107842']);
    expect((await screen({ value: 'DCBK-KPPY', type: 'swift_bic' })).ids).toEqual([
      'ofac_sdn:16085',
      'eu:107842',
    ]);
  });

  it('matches a branch BIC11 to every BIC of the institution, in one hit per designation', async () => {
    const result = await screen({ value: 'SCERIRTHXXX' });
    expect(result.ids).toEqual(['eu:180078']);
    expect(result.hits[0]?.matchedIdentifiers).toEqual([
      { type: 'SWIFT BIC', value: 'SCERIRTHKSH', country: 'IRAN (ISLAMIC REPUBLIC OF)' },
      { type: 'SWIFT BIC', value: 'SCERIRTH', country: 'IRAN (ISLAMIC REPUBLIC OF)' },
    ]);
  });

  it('matches an ETH address in lowercase and in its EIP-55 mixed case', async () => {
    for (const value of [ETH_CHECKSUMMED, ETH_CHECKSUMMED.toLowerCase()]) {
      const result = await screen({ value, type: 'digital_currency_address' });
      expect(result.ids).toEqual(['ofac_sdn:FX-WALLET']);
      expect(result.hits[0]?.matchedIdentifiers).toEqual([
        { type: 'Digital Currency Address - ETH', value: ETH_CHECKSUMMED },
      ]);
    }
  });

  it('matches a bech32 address in either case', async () => {
    expect((await screen({ value: XBT_BECH32.toUpperCase() })).ids).toEqual(['ofac_sdn:FX-WALLET']);
  });

  it('matches a base58 address exactly and not with one letter case-flipped', async () => {
    expect((await screen({ value: ` ${XBT_BASE58} ` })).ids).toEqual(['ofac_sdn:FX-WALLET']);
    const flipped = XBT_BASE58.replace('Wa', 'WA');
    expect(flipped).not.toBe(XBT_BASE58);
    expect((await screen({ value: flipped })).hits).toEqual([]);
    expect((await screen({ value: flipped, type: 'digital_currency_address' })).hits).toEqual([]);
  });

  it('matches a national ID whose published label breaks across a line', async () => {
    const result = await screen({ value: '00278640', type: 'national_id' });
    expect(result.ids).toEqual(['un:6908841']);
    expect(result.hits[0]?.matchedIdentifiers).toEqual([
      { type: 'National Identification\nNumber', value: '00278640' },
    ]);
  });

  it('reaches a label the category table does not map through type any', async () => {
    expect((await screen({ value: 'WWW.VTB.AM' })).ids).toEqual(['ofac_consolidated:18722']);
  });

  it('finds the fixture vessel by its UK IMO number', async () => {
    expect((await screen({ value: 'IMO1234567', type: 'imo' })).ids).toEqual(['uk:FX-4004']);
  });

  it('returns an empty result with the caveat and a not-a-clearance notice on both surfaces', async () => {
    const result = await screen({ value: 'ZZ9999999', type: 'passport' });
    expect(result.hits).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.caveat).toMatch(/an empty result is not a clearance/i);
    expect(result.notice).toContain('NOT a clearance');
    expect(result.notice).toContain('retry with type "any"');
    expect(result.text).toContain('**No designation publishes a matching identifier.**');
    expect(result.text).toContain('NOT a clearance');
  });

  it.each([
    ['---', 'any'],
    ['   ', 'any'],
    ['. / -', 'swift_bic'],
    ['IMO', 'imo'],
  ])('fails identifier_not_searchable for %j (type %s)', async (value, type) => {
    const result = await runToolContract(screenIdentifierTool, { value, type } as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'identifier_not_searchable', recovery: { hint: expect.any(String) } },
      },
    });
    await expect(
      screenIdentifierTool.handler(
        screenIdentifierTool.input.parse({ value, type }),
        ctxFor(screenIdentifierTool.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'identifier_not_searchable' } });
  });

  it('rejects an empty value at the schema', async () => {
    const result = await runToolContract(screenIdentifierTool, { value: '' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
  });

  it('keeps the identifier index in step with ingestDesignations re-stating a designation', async () => {
    const [ebano] = lookupDesignations().filter((d) => d.id === 'ofac_sdn:4243');
    if (!ebano) throw new Error('corpus lost EBANO');
    await seeded.service.ingestDesignations([
      {
        ...ebano,
        payload: {
          ...ebano.payload,
          identifiers: [{ type: 'Vessel Registration Identification', value: 'IMO 9999999' }],
        },
      },
    ]);
    expect((await screen({ value: '7406784' })).hits).toEqual([]);
    expect((await screen({ value: '9999999' })).ids).toEqual(['ofac_sdn:4243']);
  });

  it('orders hits within one source by entry ID numerically, on both surfaces', async () => {
    /** Two UN entries sharing a passport, stored 10 before 9. */
    const entry = (sourceEntryId: string, primaryName: string): NormalizedDesignation => ({
      id: `un:${sourceEntryId}`,
      source: 'un',
      sourceEntryId,
      entityType: 'person',
      primaryName,
      payload: {
        aliases: [],
        addresses: [],
        datesOfBirth: [],
        nationalities: [],
        identifiers: [{ type: 'Passport', value: 'ORD 4410' }],
      },
    });
    await seeded.service.ingestDesignations([
      entry('10', 'Tenth Holder'),
      entry('9', 'Ninth Holder'),
    ]);

    const result = await screen({ value: 'ORD4410', type: 'passport' });
    expect(result.ids).toEqual(['un:9', 'un:10']);
    expect(result.text.indexOf('**Entry ID:** 9 ')).toBeGreaterThan(-1);
    expect(result.text.indexOf('**Entry ID:** 9 ')).toBeLessThan(
      result.text.indexOf('**Entry ID:** 10 '),
    );
  });
});

describe('sanctions_screen_identifier over a synced mirror', () => {
  let harness: SeededService;
  beforeEach(async () => {
    harness = await emptyGlobalService();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await harness.cleanup();
  });

  it('fails mirror_not_ready before the sanctions mirror has ever synced', async () => {
    await expect(
      screenIdentifierTool.handler(
        screenIdentifierTool.input.parse({ value: 'IMO 7406784' }),
        ctxFor(screenIdentifierTool.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready', retryable: true } });
  });

  it('indexes what a sync harvests and never surfaces a designation a refresh removed', async () => {
    serveLookupCorpus();
    await harness.service.syncSanctions('init', new AbortController().signal);
    expect((await screen({ value: 'IMO 7406784' })).ids).toEqual(['ofac_sdn:4243']);

    // The next publication drops EBANO; everything else is unchanged.
    serveLookupCorpus({
      ofac_sdn: LOOKUP_DOCUMENTS.ofac_sdn.replace(
        /<sdnEntry><uid>4243<\/uid>[\s\S]*?<\/sdnEntry>/,
        '',
      ),
    });
    await harness.service.designations.runSync({
      mode: 'refresh',
      signal: new AbortController().signal,
    });
    // Before the rebuild the stale identifier row is still there; the join hides it.
    const handle = await harness.service.designations.raw();
    const stale = handle
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${IDENTIFIER_TABLE} WHERE designation_id = 'ofac_sdn:4243'`,
      )
      .get()?.n;
    expect(stale).toBe(1);
    expect((await screen({ value: 'IMO 7406784' })).hits).toEqual([]);

    await harness.service.rebuildSearchIndexes();
    expect(
      handle
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${IDENTIFIER_TABLE} WHERE designation_id = 'ofac_sdn:4243'`,
        )
        .get()?.n,
    ).toBe(0);
    expect((await screen({ value: 'L191609', type: 'passport' })).ids).toEqual([
      'ofac_sdn:7203',
      'eu:927',
      'uk:AQD0239',
    ]);
  });
});
