/**
 * @fileoverview A sanctions refresh removes designations its source stopped
 * publishing (issue #30), and only when that source's document arrived and
 * parsed to completion; and a source that fails no longer stops the sources
 * after it (issue #32). Drives the real harvest → `runSync` → name-index path
 * (`syncSanctions`, the one every caller runs) with every source served by fake
 * responses at the fetch boundary, then reads the result back through the mirror
 * and through the `sanctions_get_designation`, `sanctions_screen_name`, and
 * `sanctions_list_sources` tools — `structuredContent` and `content[]` both.
 *
 * Each boundary case (a failing, truncated, or zero-record source) runs in the
 * same cycle as a source that does prune, so its "nothing removed" assertion is
 * measured against a sync that is demonstrably pruning.
 * @module tests/integration/refresh-pruning.test
 */

import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOURCE_URLS } from '@/config/server-config.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
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

/** Serve `bodies` at the fetch boundary; returns the URLs requested, in order. */
function serve(bodies: Map<string, Feed>): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      const body = bodies.get(url);
      if (body === undefined || body === 404) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
    }),
  );
  return requested;
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

/** One sync cycle over `bodies`, through the sync-then-rebuild path every caller runs. */
async function cycle(mode: 'init' | 'refresh', bodies: Map<string, Feed>): Promise<void> {
  serve(bodies);
  await harness.service.syncSanctions(mode, new AbortController().signal);
}

/** A cycle whose sync is expected to fail; the name index is rebuilt all the same. */
async function failingCycle(bodies: Map<string, Feed>): Promise<void> {
  serve(bodies);
  await expect(
    harness.service.syncSanctions('refresh', new AbortController().signal),
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
async function screen(name: string): Promise<{
  hits: { id: string; matchedName: string; matchType: string }[];
  ids: string[];
  text: string;
}> {
  const result = await screenNameTool.handler(
    screenNameTool.input.parse({ name }),
    ctxFor(screenNameTool.errors),
  );
  const text = (screenNameTool.format?.(result) ?? [])
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n');
  const hits = result.hits.map((h) => ({
    id: `${h.source}:${h.sourceEntryId}`,
    matchedName: h.matchedName,
    matchType: h.matchType,
  }));
  return { hits, ids: hits.map((h) => h.id), text };
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

// ─── A failing source does not stall the others (issue #32) ────────────────────

/** The Consolidated feed with CONS-1 published under one alias. */
function consolidatedWithAlias(alias: string): string {
  const [first, last] = split(alias);
  return `<?xml version="1.0" encoding="utf-8"?>\n<sdnList><sdnEntry><uid>CONS-1</uid><firstName>Cedar</firstName><lastName>Wren</lastName><sdnType>Individual</sdnType><akaList><aka><category>strong</category><firstName>${first}</firstName><lastName>${last}</lastName></aka></akaList></sdnEntry></sdnList>`;
}

describe('a failing source does not stop the sources after it', () => {
  it('refreshes every other source, rebuilds the name index, and names the failed source', async () => {
    await cycle('init', feeds({ ofac_consolidated: consolidatedWithAlias('Tayr Quillon') }));
    expect((await screen('Tayr Quillon')).hits).toContainEqual({
      id: 'ofac_consolidated:CONS-1',
      matchedName: 'Tayr Quillon',
      matchType: 'exact',
    });
    const initAsOf = (await harness.service.sanctionsReadiness()).completedAt;

    // Issue #32's repro: Consolidated renames an alias, EU's request fails, and UN
    // (harvested after EU) delists UN-2.
    const requested = serve(
      feeds({
        ofac_consolidated: consolidatedWithAlias('Zorvexkal Quillon'),
        eu: 404,
        un: without('un', 'UN-2'),
      }),
    );
    await expect(
      harness.service.syncSanctions('refresh', new AbortController().signal),
    ).rejects.toThrow(/Sanctions harvest failed for eu \(1 of 5 sources\)[\s\S]*eu: .*404/);

    // The sources after the failure were requested and refreshed.
    expect(requested).toEqual([URLS.ofac_sdn, URLS.ofac_consolidated, URLS.eu, URLS.uk, URLS.un]);
    expect(await storedIds()).not.toContain('un:UN-2');
    // The failed source kept every row and pruned nothing.
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, un: 1 });

    // The name index follows the committed rows: the added alias is an exact hit
    // and the removed one no longer matches anything.
    const added = await screen('Zorvexkal Quillon');
    expect(added.hits[0]).toEqual({
      id: 'ofac_consolidated:CONS-1',
      matchedName: 'Zorvexkal Quillon',
      matchType: 'exact',
    });
    expect(added.text).toContain('**Matched on:** "Zorvexkal Quillon"');
    const removed = await screen('Tayr Quillon');
    expect(removed.hits.map((h) => h.matchedName)).not.toContain('Tayr Quillon');
    expect(removed.text).not.toContain('**Matched on:** "Tayr Quillon"');
    expect(await indexedNames('ofac_consolidated:CONS-1')).toEqual([
      'Cedar Wren',
      'Zorvexkal Quillon',
    ]);

    // The run is recorded as failed, naming the source; the mirror's as-of stays
    // at the last run in which every source refreshed.
    const readiness = await harness.service.sanctionsReadiness();
    expect(readiness).toMatchObject({ ready: true, status: 'error', completedAt: initAsOf });
    expect(readiness.error).toMatch(/\beu: /);
    const sources = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      ctxFor(listSourcesTool.errors),
    );
    expect(sources.sanctionsAsOf).toBe(initAsOf);
    const sourcesText = (listSourcesTool.format?.(sources) ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');
    expect(sourcesText).toContain(`(as of ${initAsOf})`);

    // The next run in which every source refreshes advances it.
    await cycle(
      'refresh',
      feeds({ ofac_consolidated: consolidatedWithAlias('Zorvexkal Quillon') }),
    );
    const next = await harness.service.sanctionsReadiness();
    expect(next.status).toBe('complete');
    expect(next.completedAt).not.toBe(initAsOf);
  });

  it('names every failed source when the first and the last both fail', async () => {
    await cycle('init', feeds());

    await expect(
      (async () => {
        serve(feeds({ ofac_sdn: 404, uk: without('uk', 'UK-2'), un: 404 }));
        await harness.service.syncSanctions('refresh', new AbortController().signal);
      })(),
    ).rejects.toThrow(
      /failed for ofac_sdn, un \(2 of 5 sources\)[\s\S]*ofac_sdn: .*404[\s\S]*; un: .*404/,
    );

    // UK, between the two failures, refreshed and pruned; the failed sources kept everything.
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, uk: 1 });
  });

  it('leaves a first init with a failed source not ready, with every other source loaded and indexed', async () => {
    serve(feeds({ uk: 404 }));
    await expect(
      harness.service.syncSanctions('init', new AbortController().signal),
    ).rejects.toThrow(/\buk: /);

    expect(await harness.service.sanctionsReady()).toBe(false);
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, uk: 0 });
    expect(await indexedNames('un:UN-1')).toEqual(['Hazel Crane']);
    await expect(
      screenNameTool.handler(
        screenNameTool.input.parse({ name: 'Hazel Crane' }),
        ctxFor(screenNameTool.errors),
      ),
    ).rejects.toMatchObject({ data: { reason: 'mirror_not_ready' } });
  });

  it('ends the run at once on a caller abort, as a cancellation that names no source', async () => {
    await cycle('init', feeds());
    const initAsOf = (await harness.service.sanctionsReadiness()).completedAt;

    const controller = new AbortController();
    const requested: string[] = [];
    const bodies = feeds({ ofac_sdn: without('ofac_sdn', 'SDN-2') });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested.push(url);
        if (url === URLS.eu) {
          controller.abort();
          init?.signal?.throwIfAborted();
        }
        return new Response(bodies.get(url) as string, { status: 200 });
      }),
    );

    const error = await harness.service.syncSanctions('refresh', controller.signal).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(error?.message).not.toMatch(/Sanctions harvest failed/);
    expect(requested).toEqual([URLS.ofac_sdn, URLS.ofac_consolidated, URLS.eu]);
    // What landed before the abort stands, and the index was rebuilt from it.
    expect(await counts()).toEqual({ ...BASELINE_COUNTS, ofac_sdn: 1 });
    expect(await indexedNames('ofac_sdn:SDN-2')).toEqual([]);
    expect((await harness.service.sanctionsReadiness()).completedAt).toBe(initAsOf);
  });
});
