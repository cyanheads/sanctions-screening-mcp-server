/**
 * @fileoverview A sanctions refresh removes designations its source stopped
 * publishing (issue #30), and only when that source's document arrived and
 * parsed to completion. Drives the real harvest → `runSync` → name-index path
 * with every source served by fake responses at the fetch boundary, then reads
 * the result back through the mirror and through the `sanctions_get_designation`
 * and `sanctions_screen_name` tools — `structuredContent` and `content[]` both.
 *
 * Each boundary case (a failing, truncated, or zero-record source) runs in the
 * same cycle as a source that does prune, so its "nothing removed" assertion is
 * measured against a sync that is demonstrably pruning.
 * @module tests/integration/refresh-pruning.test
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOURCE_URLS } from '@/config/server-config.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { NAME_TABLE } from '@/services/screening/schema.js';
import type { SourceCode } from '@/services/screening/types.js';
import { emptyGlobalService, type SeededService } from '../services/_helpers.js';

// ─── Feeds ─────────────────────────────────────────────────────────────────────

/** `[entryId, "Given Family"]` per published designation, by source. */
type Corpus = Record<SourceCode, [string, string][]>;

const BASELINE: Corpus = {
  ofac_sdn: [
    ['SDN-1', 'Alder Quill'],
    ['SDN-2', 'Birch Rook'],
  ],
  ofac_consolidated: [['CONS-1', 'Cedar Wren']],
  eu: [
    ['EU-1', 'Dahlia Finch'],
    ['EU-2', 'Elm Heron'],
  ],
  uk: [
    ['UK-1', 'Fern Lark'],
    ['UK-2', 'Gorse Kite'],
  ],
  un: [
    ['UN-1', 'Hazel Crane'],
    ['UN-2', 'Iris Plover'],
  ],
};

const URLS: Record<SourceCode, string> = {
  ofac_sdn: DEFAULT_SOURCE_URLS.ofacSdn,
  ofac_consolidated: DEFAULT_SOURCE_URLS.ofacConsolidated,
  eu: DEFAULT_SOURCE_URLS.euFsf,
  uk: DEFAULT_SOURCE_URLS.ukSanctions,
  un: DEFAULT_SOURCE_URLS.unSc,
};

function split(name: string): [string, string] {
  const at = name.indexOf(' ');
  return [name.slice(0, at), name.slice(at + 1)];
}

/** Render one source's published document, in that source's own schema. */
function document(source: SourceCode, entries: [string, string][]): string {
  const prolog = '<?xml version="1.0" encoding="utf-8"?>\n';
  switch (source) {
    case 'ofac_sdn':
    case 'ofac_consolidated':
      return `${prolog}<sdnList>${entries
        .map(([id, name]) => {
          const [first, last] = split(name);
          return `<sdnEntry><uid>${id}</uid><firstName>${first}</firstName><lastName>${last}</lastName><sdnType>Individual</sdnType></sdnEntry>`;
        })
        .join('')}</sdnList>`;
    case 'eu':
      return `${prolog}<export>${entries
        .map(
          ([id, name]) =>
            `<sanctionEntity logicalId="${id}"><subjectType code="person"/><nameAlias wholeName="${name}" strong="true"/></sanctionEntity>`,
        )
        .join('')}</export>`;
    case 'uk':
      return `${prolog}<Designations>${entries
        .map(
          ([id, name]) =>
            `<Designation><UniqueID>${id}</UniqueID><IndividualEntityShip>Individual</IndividualEntityShip><Names><Name><Name6>${name}</Name6><NameType>Primary Name</NameType></Name></Names></Designation>`,
        )
        .join('')}</Designations>`;
    case 'un':
      return `${prolog}<CONSOLIDATED_LIST><INDIVIDUALS>${entries
        .map(([id, name]) => {
          const [first, second] = split(name);
          return `<INDIVIDUAL><DATAID>${id}</DATAID><FIRST_NAME>${first}</FIRST_NAME><SECOND_NAME>${second}</SECOND_NAME></INDIVIDUAL>`;
        })
        .join('')}</INDIVIDUALS></CONSOLIDATED_LIST>`;
  }
}

/** A source's response body, or `404` for a source whose request fails. */
type Feed = string | 404;

/** Every source serving its baseline document, with `overrides` replacing some. */
function feeds(overrides: Partial<Record<SourceCode, Feed>> = {}): Map<string, Feed> {
  const out = new Map<string, Feed>();
  for (const source of Object.keys(URLS) as SourceCode[]) {
    out.set(URLS[source], overrides[source] ?? document(source, BASELINE[source]));
  }
  return out;
}

/** The baseline corpus of `source` minus the named entry ids. */
function without(source: SourceCode, ...ids: string[]): string {
  return document(
    source,
    BASELINE[source].filter(([id]) => !ids.includes(id)),
  );
}

function serve(bodies: Map<string, Feed>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = bodies.get(url);
      if (body === undefined || body === 404) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
    }),
  );
}

// ─── Harness ───────────────────────────────────────────────────────────────────

let harness: SeededService;

beforeEach(async () => {
  harness = await emptyGlobalService();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.cleanup();
});

/** One sync cycle over `bodies`, then the name-index rebuild every caller runs. */
async function cycle(mode: 'init' | 'refresh', bodies: Map<string, Feed>): Promise<void> {
  serve(bodies);
  await harness.service.designations.runSync({ mode, signal: new AbortController().signal });
  await harness.service.rebuildNameIndex();
}

/** A cycle whose sync is expected to fail: the name index is left as the failure left it. */
async function failingCycle(bodies: Map<string, Feed>): Promise<void> {
  serve(bodies);
  await expect(
    harness.service.designations.runSync({
      mode: 'refresh',
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
}

async function storedIds(): Promise<string[]> {
  const handle = await harness.service.designations.raw();
  return handle
    .prepare<{ id: string }>('SELECT id FROM designation ORDER BY id')
    .all()
    .map((r) => r.id);
}

async function indexedNames(designationId: string): Promise<string[]> {
  const handle = await harness.service.designations.raw();
  return handle
    .prepare<{ name: string }>(`SELECT name FROM ${NAME_TABLE} WHERE designation_id = ?`)
    .all(designationId)
    .map((r) => r.name);
}

async function counts(): Promise<Record<string, number>> {
  return Object.fromEntries(
    (await harness.service.sourceCounts()).map((s) => [s.code, s.recordCount]),
  );
}

const BASELINE_COUNTS = { ofac_sdn: 2, ofac_consolidated: 1, eu: 2, uk: 2, un: 2 };

const ctxFor = <const E extends readonly ErrorContract[] | undefined>(errors: E) =>
  createMockContext({ errors });

/** Screen a name through the tool: its structured hits and its rendered text. */
async function screen(name: string): Promise<{ ids: string[]; text: string }> {
  const result = await screenNameTool.handler(
    screenNameTool.input.parse({ name }),
    ctxFor(screenNameTool.errors),
  );
  const text = (screenNameTool.format?.(result) ?? [])
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n');
  return { ids: result.hits.map((h) => `${h.source}:${h.sourceEntryId}`), text };
}

function getDesignation(source: SourceCode, entryId: string) {
  return getDesignationTool.handler(
    getDesignationTool.input.parse({ source, entryId }),
    ctxFor(getDesignationTool.errors),
  );
}

// ─── Pruning ───────────────────────────────────────────────────────────────────

describe('refresh removes designations a source stopped publishing', () => {
  it('drops a delisted designation from the mirror, the name index, and both tools', async () => {
    await cycle('init', feeds());
    expect((await screen('Iris Plover')).ids).toContain('un:UN-2');
    expect(await indexedNames('un:UN-2')).toEqual(['Iris Plover']);

    await cycle('refresh', feeds({ un: without('un', 'UN-2') }));

    expect(await storedIds()).not.toContain('un:UN-2');
    expect(await indexedNames('un:UN-2')).toEqual([]);
    await expect(getDesignation('un', 'UN-2')).rejects.toMatchObject({
      data: { reason: 'designation_not_found' },
    });
    const screened = await screen('Iris Plover');
    expect(screened.ids).not.toContain('un:UN-2');
    expect(screened.text).not.toContain('Iris Plover');
    expect(screened.text).not.toContain('UN-2');

    // Only the delisted row went: the source's other row and every other source stay.
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, un: 1 });
    expect((await getDesignation('un', 'UN-1')).primaryName).toBe('Hazel Crane');
    expect((await harness.service.sanctionsReadiness()).total).toBe(8);
  });

  it('never surfaces a pruned designation, even before the name index is rebuilt', async () => {
    await cycle('init', feeds());

    serve(feeds({ eu: without('eu', 'EU-2') }));
    await harness.service.designations.runSync({
      mode: 'refresh',
      signal: new AbortController().signal,
    });

    expect((await screen('Elm Heron')).ids).not.toContain('eu:EU-2');
  });

  it('removes a stored designation the source now publishes only in a form the ingest rejects', async () => {
    await cycle('init', feeds());

    // UK-2 is still published, but its name arrives as a lossy-decode artifact
    // (U+FFFD), which the ingest drops as unusable.
    const rejectedForm = document('uk', BASELINE.uk).replace(
      '<Name6>Gorse Kite</Name6>',
      `<Name6>Gorse K${String.fromCharCode(0xfffd)}te</Name6>`,
    );
    await cycle('refresh', feeds({ uk: rejectedForm }));

    expect(await storedIds()).not.toContain('uk:UK-2');
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, uk: 1 });
  });

  it('prunes, then re-admits the same id when a later cycle publishes it again', async () => {
    await cycle('init', feeds());

    await cycle('refresh', feeds({ ofac_sdn: without('ofac_sdn', 'SDN-2') }));
    expect(await storedIds()).not.toContain('ofac_sdn:SDN-2');
    expect((await screen('Birch Rook')).ids).not.toContain('ofac_sdn:SDN-2');

    await cycle('refresh', feeds());
    expect(await storedIds()).toContain('ofac_sdn:SDN-2');
    expect(await indexedNames('ofac_sdn:SDN-2')).toEqual(['Birch Rook']);
    expect((await screen('Birch Rook')).ids).toContain('ofac_sdn:SDN-2');
    expect(await counts()).toEqual(BASELINE_COUNTS);
  });

  it('prunes several sources in one cycle, each against its own document', async () => {
    await cycle('init', feeds());

    await cycle(
      'refresh',
      feeds({ ofac_sdn: without('ofac_sdn', 'SDN-1'), eu: without('eu', 'EU-1') }),
    );

    const ids = await storedIds();
    expect(ids).not.toContain('ofac_sdn:SDN-1');
    expect(ids).not.toContain('eu:EU-1');
    expect(ids).toContain('ofac_sdn:SDN-2');
    expect(ids).toContain('eu:EU-2');
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, ofac_sdn: 1, eu: 1 });
  });

  it('prunes on a re-init over a populated mirror too', async () => {
    await cycle('init', feeds());
    await cycle('init', feeds({ uk: without('uk', 'UK-1') }));

    expect(await storedIds()).not.toContain('uk:UK-1');
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, uk: 1 });
  });
});

// ─── Sources that must prune nothing ───────────────────────────────────────────

describe('a source whose document did not fully arrive prunes nothing', () => {
  it('keeps every row of a source whose request fails', async () => {
    await cycle('init', feeds());

    // SDN (harvested first) drops SDN-2 and prunes; UK then fails outright.
    await failingCycle(feeds({ ofac_sdn: without('ofac_sdn', 'SDN-2'), uk: 404 }));

    const ids = await storedIds();
    expect(ids).not.toContain('ofac_sdn:SDN-2');
    expect(ids).toContain('uk:UK-1');
    expect(ids).toContain('uk:UK-2');
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, ofac_sdn: 1 });
  });

  it('fails the harvest of a truncated document and keeps the rows it never reached', async () => {
    await cycle('init', feeds());

    // A cleanly closed response that ends mid-document: EU-1 arrives whole,
    // EU-2's record and the closing </export> never do.
    const euDocument = document('eu', BASELINE.eu);
    const truncated = euDocument.slice(0, euDocument.indexOf('Elm Heron'));
    await failingCycle(feeds({ ofac_sdn: without('ofac_sdn', 'SDN-1'), eu: truncated }));

    const ids = await storedIds();
    expect(ids).not.toContain('ofac_sdn:SDN-1');
    expect(ids).toContain('eu:EU-1');
    expect(ids).toContain('eu:EU-2');
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, ofac_sdn: 1 });
  });

  it('keeps every row of a source whose complete document yields no accepted record', async () => {
    await cycle('init', feeds());

    // A well-formed document whose only entry has no identifier — zero accepted.
    const noAccepted =
      '<?xml version="1.0"?><export><sanctionEntity><nameAlias wholeName="Nameless Only" strong="true"/></sanctionEntity></export>';
    await cycle(
      'refresh',
      feeds({ ofac_sdn: without('ofac_sdn', 'SDN-2'), eu: noAccepted, un: document('un', []) }),
    );

    expect(await counts()).toEqual({ ...BASELINE_COUNTS, ofac_sdn: 1 });
  });

  it('keeps every row of a source whose complete document collapsed below half its stored list', async () => {
    await cycle('init', feeds());

    // EU's whole, well-formed document now carries one new designation and
    // neither stored one: removing both would take two of its three rows.
    await cycle(
      'refresh',
      feeds({
        ofac_sdn: without('ofac_sdn', 'SDN-2'),
        eu: document('eu', [['EU-3', 'Juniper Stork']]),
      }),
    );

    const ids = await storedIds();
    expect(ids).not.toContain('ofac_sdn:SDN-2');
    expect(ids).toEqual(expect.arrayContaining(['eu:EU-1', 'eu:EU-2', 'eu:EU-3']));
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, ofac_sdn: 1, eu: 3 });
    expect((await screen('Elm Heron')).ids).toContain('eu:EU-2');
  });
});
