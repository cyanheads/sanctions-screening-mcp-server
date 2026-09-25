/**
 * @fileoverview The sanctions harvest loop and the name-index rebuild — the two
 * unbounded buffers of `mirror:init` (issue #13).
 *
 * Two kinds of test live here. The **characterization** blocks pin the contract
 * `createSanctionsSync` has always had — every source harvested in registry
 * order, one shared checkpoint stamp, `toDesignationRow` column shapes, an
 * aborted signal yielding nothing — so a restructuring of the loop is held to
 * the behavior it replaced. The **boundedness** blocks assert the property the
 * restructuring adds: a record reaches the consumer before its source document
 * has finished arriving, and the name-index rebuild reads the designation table
 * in bounded slices rather than materializing it.
 * @module tests/services/sanctions-sync.test
 */

import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOURCE_URLS, resetServerConfig } from '@/config/server-config.js';
import {
  buildSanctionsIngesters,
  createSanctionsSync,
  type SourceSyncFailure,
  type SourceSyncReport,
} from '@/services/screening/sanctions-ingest.js';
import { IDENTIFIER_TABLE, NAME_TABLE } from '@/services/screening/schema.js';
import type { NormalizedDesignation, SourceCode } from '@/services/screening/types.js';
import { freshService, type SeededService } from './_helpers.js';

// ─── Source fixtures, one record per source ────────────────────────────────────

/** The reference value sets an OFAC advanced document opens with. */
const OFAC_REFS = `<ReferenceValueSets>
  <AliasTypeValues><AliasType ID="1403">Name</AliasType><AliasType ID="1400">A.K.A.</AliasType></AliasTypeValues>
  <FeatureTypeValues><FeatureType ID="8">Birthdate</FeatureType></FeatureTypeValues>
  <PartySubTypeValues><PartySubType ID="4" PartyTypeID="1">Unknown</PartySubType></PartySubTypeValues>
</ReferenceValueSets>`;

function ofacParty(fixedRef: string, name: string): string {
  return `<DistinctParty FixedRef="${fixedRef}"><Profile ID="${fixedRef}" PartySubTypeID="4"><Identity>
    <Alias AliasTypeID="1403" Primary="true" LowQuality="false"><DocumentedName>
      <DocumentedNamePart><NamePartValue>${name}</NamePartValue></DocumentedNamePart>
    </DocumentedName></Alias>
  </Identity></Profile></DistinctParty>`;
}

function ofacEntry(profileId: string, program: string, year: string): string {
  return `<SanctionsEntry ID="${profileId}" ProfileID="${profileId}">
    <EntryEvent><Date><Year>${year}</Year><Month>3</Month><Day>4</Day></Date></EntryEvent>
    <SanctionsMeasure><Comment>${program}</Comment></SanctionsMeasure>
  </SanctionsEntry>`;
}

function ofacDocument(source: 'SDN' | 'CONS'): string {
  const ref = source === 'SDN' ? '900' : '901';
  return `<?xml version="1.0" encoding="utf-8"?><Sanctions>
  ${OFAC_REFS}
  <Locations><Location ID="1"><LocationCountry><Country>US</Country></LocationCountry></Location></Locations>
  <DistinctParties>${ofacParty(ref, `OFAC ${source} Person`)}</DistinctParties>
  <ProfileRelationships/>
  <SanctionsEntries>${ofacEntry(ref, `PROG-${source}`, '1999')}</SanctionsEntries>
</Sanctions>`;
}

const EU_ENTITY = `<sanctionEntity designationDate="2020-05-06" logicalId="EU-1" euReferenceNumber="EU.1.1">
  <regulation regulationType="amendment" programme="EUPROG" publicationDate="2023-11-14"/>
  <subjectType code="person"/>
  <nameAlias wholeName="Offline EU Person" strong="true"/>
  <nameAlias wholeName="EU Alias" strong="false"/>
</sanctionEntity>`;

const UK_DESIGNATION = `<Designation>
  <UniqueID>UK-1</UniqueID><RegimeName>UKPROG</RegimeName><DateDesignated>01/02/2021</DateDesignated>
  <IndividualEntityShip>Entity</IndividualEntityShip>
  <Names><Name><Name6>Offline UK Entity</Name6><NameType>Primary Name</NameType></Name>
         <Name><Name6>UK Alias Ltd</Name6><NameType>Alias</NameType></Name></Names>
</Designation>`;

const UN_INDIVIDUAL = `<INDIVIDUAL>
  <DATAID>UN-1</DATAID><FIRST_NAME>OFFLINE</FIRST_NAME><SECOND_NAME>UN</SECOND_NAME>
  <UN_LIST_TYPE>UNPROG</UN_LIST_TYPE><LISTED_ON>2015-06-07</LISTED_ON>
</INDIVIDUAL>`;

const SOURCE_BODIES = new Map<string, string>([
  [DEFAULT_SOURCE_URLS.ofacSdn, ofacDocument('SDN')],
  [DEFAULT_SOURCE_URLS.ofacConsolidated, ofacDocument('CONS')],
  [DEFAULT_SOURCE_URLS.euFsf, `<?xml version="1.0"?><export>${EU_ENTITY}</export>`],
  [
    DEFAULT_SOURCE_URLS.ukSanctions,
    `<?xml version="1.0"?><Designations>${UK_DESIGNATION}</Designations>`,
  ],
  [
    DEFAULT_SOURCE_URLS.unSc,
    `<?xml version="1.0"?><CONSOLIDATED_LIST><INDIVIDUALS>${UN_INDIVIDUAL}</INDIVIDUALS></CONSOLIDATED_LIST>`,
  ],
]);

function stubSourceFetch(bodies: Map<string, string> = SOURCE_BODIES): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = bodies.get(url);
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** A response body a test feeds by hand, so the tail can be held open. */
function pushStream(): {
  close: () => void;
  push: (text: string) => void;
  stream: ReadableStream<Uint8Array>;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    stream,
    push: (text) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  };
}

const PENDING = Symbol('pending');

/** Resolve `promise`, or the PENDING sentinel if it has not settled in `ms`. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  return Promise.race([
    promise,
    new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms)),
  ]);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

interface DrainedPage {
  checkpoint?: string | undefined;
  records: Record<string, unknown>[];
  tombstones?: string[] | undefined;
}

/** Drive a sync generator to exhaustion, keeping every page. */
async function drainSync(
  sync: ReturnType<typeof createSanctionsSync>,
  signal = new AbortController().signal,
): Promise<DrainedPage[]> {
  const pages: DrainedPage[] = [];
  for await (const page of sync({ signal })) {
    pages.push({ records: page.records, checkpoint: page.checkpoint, tombstones: page.tombstones });
  }
  return pages;
}

/** Mirror-side wiring that stores nothing: no deferred columns, no stored rows to prune. */
const NO_MIRROR = {
  applyDeferredFields: async () => {},
  storedDeferredFields: async () => new Map(),
  staleDesignationIds: async () => [],
};

function noopSync(): ReturnType<typeof createSanctionsSync> {
  return createSanctionsSync(NO_MIRROR);
}

/** The ids a harvest yielded, and the error that ended it (if any). */
async function harvestOutcome(source: SourceCode): Promise<{ error?: string; ids: string[] }> {
  const ingester = buildSanctionsIngesters().find((i) => i.source === source);
  const ids: string[] = [];
  try {
    for await (const d of ingester!.harvest(new AbortController().signal)) ids.push(d.id);
  } catch (err) {
    return { ids, error: (err as Error).message };
  }
  return { ids };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetServerConfig();
});

// ─── Characterization: the harvest loop's standing contract ────────────────────

describe('createSanctionsSync — harvest loop contract', () => {
  it('applies every source in registry order, under one checkpoint stamp', async () => {
    stubSourceFetch();
    const pages = await drainSync(noopSync());

    const records = pages.flatMap((p) => p.records);
    expect(records.map((r) => r.source)).toEqual([
      'ofac_sdn',
      'ofac_consolidated',
      'eu',
      'uk',
      'un',
    ]);
    expect(records.map((r) => r.id)).toEqual([
      'ofac_sdn:900',
      'ofac_consolidated:901',
      'eu:EU-1',
      'uk:UK-1',
      'un:UN-1',
    ]);

    // One run stamps one checkpoint across every page it yields.
    const stamps = new Set(pages.map((p) => p.checkpoint));
    expect(stamps.size).toBe(1);
    expect([...stamps][0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('yields rows in the designation column shape, nulls included', async () => {
    stubSourceFetch();
    const records = (await drainSync(noopSync())).flatMap((p) => p.records);

    const eu = records.find((r) => r.id === 'eu:EU-1');
    expect(eu).toEqual({
      id: 'eu:EU-1',
      source: 'eu',
      source_entry_id: 'EU-1',
      entity_type: 'person',
      primary_name: 'Offline EU Person',
      normalized_name: 'offline eu person',
      program: 'EUPROG',
      legal_basis: null,
      designation_date: '2020-05-06',
      reference_number: 'EU.1.1',
      payload: expect.any(String),
    });
    expect(JSON.parse(String(eu?.payload)).aliases).toEqual([
      { name: 'EU Alias', nameType: 'low-quality-aka' },
    ]);
  });

  it('yields nothing when the run is aborted before it starts', async () => {
    const fetch = stubSourceFetch();
    const controller = new AbortController();
    controller.abort();
    expect(await drainSync(noopSync(), controller.signal)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports what each source accepted and why it rejected the rest', async () => {
    // One good record beside a sibling with no identifier and one with no name.
    const bodies = new Map(SOURCE_BODIES);
    bodies.set(
      DEFAULT_SOURCE_URLS.euFsf,
      `<export>${EU_ENTITY}
        <sanctionEntity><nameAlias wholeName="No Identifier SA"/></sanctionEntity>
        <sanctionEntity logicalId="EU-9"><subjectType code="person"/></sanctionEntity>
      </export>`,
    );
    stubSourceFetch(bodies);

    const reports: SourceSyncReport[] = [];
    await drainSync(
      createSanctionsSync({ ...NO_MIRROR, onSourceReport: (report) => reports.push(report) }),
    );

    expect(reports.map((r) => r.source)).toEqual([
      'ofac_sdn',
      'ofac_consolidated',
      'eu',
      'uk',
      'un',
    ]);
    expect(reports.find((r) => r.source === 'eu')).toEqual({
      source: 'eu',
      accepted: 1,
      pruned: 0,
      withheld: 0,
      rejected: { missingIdentifier: 1, unusableName: 1 },
    });
    expect(reports.find((r) => r.source === 'un')).toEqual({
      source: 'un',
      accepted: 1,
      pruned: 0,
      withheld: 0,
      rejected: { missingIdentifier: 0, unusableName: 0 },
    });
  });
});

// ─── Pruning: stale ids become tombstones (issue #30) ──────────────────────────

describe('createSanctionsSync — pruning', () => {
  it("yields a source's stale ids as tombstone pages after its records, under the run's stamp", async () => {
    // EU publishes three records, so removing three stored ids stays within the prune bound.
    const bodies = new Map(SOURCE_BODIES);
    bodies.set(
      DEFAULT_SOURCE_URLS.euFsf,
      `<export>${['EU-1', 'EU-2', 'EU-3'].map((id) => EU_ENTITY.replace('EU-1', id)).join('')}</export>`,
    );
    stubSourceFetch(bodies);
    const asked: [SourceCode, string[]][] = [];
    const reports: SourceSyncReport[] = [];
    const pages = await drainSync(
      createSanctionsSync({
        ...NO_MIRROR,
        staleDesignationIds: async (source, kept) => {
          asked.push([source, [...kept]]);
          return source === 'eu' ? ['eu:GONE-1', 'eu:GONE-2', 'eu:GONE-3'] : [];
        },
        onSourceReport: (report) => reports.push(report),
        pageSize: 2,
      }),
    );

    // Each source is asked once, with exactly the ids its harvest accepted.
    expect(asked).toEqual([
      ['ofac_sdn', ['ofac_sdn:900']],
      ['ofac_consolidated', ['ofac_consolidated:901']],
      ['eu', ['eu:EU-1', 'eu:EU-2', 'eu:EU-3']],
      ['uk', ['uk:UK-1']],
      ['un', ['un:UN-1']],
    ]);
    // EU's tombstones follow its records, in bounded pages, before UK's records.
    expect(
      pages.map((p) => ({ records: p.records.map((r) => r.id), tombstones: p.tombstones ?? [] })),
    ).toEqual([
      { records: ['ofac_sdn:900'], tombstones: [] },
      { records: ['ofac_consolidated:901'], tombstones: [] },
      { records: ['eu:EU-1', 'eu:EU-2'], tombstones: [] },
      { records: ['eu:EU-3'], tombstones: [] },
      { records: [], tombstones: ['eu:GONE-1', 'eu:GONE-2'] },
      { records: [], tombstones: ['eu:GONE-3'] },
      { records: ['uk:UK-1'], tombstones: [] },
      { records: ['un:UN-1'], tombstones: [] },
    ]);
    expect(new Set(pages.map((p) => p.checkpoint)).size).toBe(1);
    expect(reports.map((r) => [r.source, r.pruned])).toEqual([
      ['ofac_sdn', 0],
      ['ofac_consolidated', 0],
      ['eu', 3],
      ['uk', 0],
      ['un', 0],
    ]);
  });

  it('withholds every removal for a source that accepted no record, and asks nothing of one that failed', async () => {
    const bodies = new Map(SOURCE_BODIES);
    bodies.set(DEFAULT_SOURCE_URLS.euFsf, '<export></export>');
    bodies.delete(DEFAULT_SOURCE_URLS.ukSanctions); // served as a 404
    stubSourceFetch(bodies);

    const asked: SourceCode[] = [];
    const reports: SourceSyncReport[] = [];
    const failures: SourceSyncFailure[] = [];
    const sync = createSanctionsSync({
      ...NO_MIRROR,
      staleDesignationIds: async (source) => {
        asked.push(source);
        return source === 'eu' ? ['eu:STORED-1'] : [];
      },
      onSourceReport: (report) => reports.push(report),
      onSourceFailed: (failure) => failures.push(failure),
    });
    await expect(drainSync(sync)).rejects.toThrow(/\buk: .*404/);

    // EU's empty document would remove all it stores, so the removal is withheld
    // and reported. UK never arrived, so it is asked nothing and reported as a
    // failure; the run moves on to UN.
    expect(asked).toEqual(['ofac_sdn', 'ofac_consolidated', 'eu', 'un']);
    expect(reports.find((r) => r.source === 'eu')).toMatchObject({
      accepted: 0,
      pruned: 0,
      withheld: 1,
    });
    expect(reports.map((r) => r.source)).toEqual(['ofac_sdn', 'ofac_consolidated', 'eu', 'un']);
    expect(failures).toEqual([{ source: 'uk', accepted: 0, error: expect.stringMatching(/404/) }]);
  });

  it('withholds a prune that would remove more than half of what a source stores', async () => {
    stubSourceFetch();
    const reports: SourceSyncReport[] = [];
    const pages = await drainSync(
      createSanctionsSync({
        ...NO_MIRROR,
        // Every source's document accepted one id. UK's one stale id is exactly half
        // of what it stores; EU's two stale ids are two thirds.
        staleDesignationIds: async (source) =>
          source === 'eu' ? ['eu:GONE-1', 'eu:GONE-2'] : source === 'uk' ? ['uk:GONE-1'] : [],
        onSourceReport: (report) => reports.push(report),
      }),
    );

    expect(pages.flatMap((p) => p.tombstones ?? [])).toEqual(['uk:GONE-1']);
    expect(reports.find((r) => r.source === 'uk')).toMatchObject({ pruned: 1, withheld: 0 });
    expect(reports.find((r) => r.source === 'eu')).toMatchObject({ pruned: 0, withheld: 2 });
    // The withheld source's own records still landed.
    expect(pages.flatMap((p) => p.records.map((r) => r.id))).toContain('eu:EU-1');
  });
});

// ─── A failing source: every other source still refreshes (issue #32) ─────────

describe('createSanctionsSync — a failing source does not stop the others', () => {
  /** Every source's baseline body, minus the listed ones (served as 404s). */
  function bodiesWithout(...urls: string[]): Map<string, string> {
    const bodies = new Map(SOURCE_BODIES);
    for (const url of urls) bodies.delete(url);
    return bodies;
  }

  it('harvests, prunes, and reports every source between a failing first and last', async () => {
    stubSourceFetch(bodiesWithout(DEFAULT_SOURCE_URLS.ofacSdn, DEFAULT_SOURCE_URLS.unSc));
    const asked: SourceCode[] = [];
    const reports: SourceSyncReport[] = [];
    const failures: SourceSyncFailure[] = [];
    const pages: DrainedPage[] = [];
    const sync = createSanctionsSync({
      ...NO_MIRROR,
      staleDesignationIds: async (source) => {
        asked.push(source);
        return source === 'eu' ? ['eu:GONE-1'] : [];
      },
      onSourceReport: (report) => reports.push(report),
      onSourceFailed: (failure) => failures.push(failure),
    });

    let error: Error | undefined;
    try {
      for await (const page of sync({ signal: new AbortController().signal })) {
        pages.push({ records: page.records, tombstones: page.tombstones });
      }
    } catch (err) {
      error = err as Error;
    }

    // One error after the last source, naming each failed source by its code.
    expect(error?.message).toMatch(/ofac_sdn: .*404[\s\S]*; un: .*404/);
    expect(failures.map((f) => f.source)).toEqual(['ofac_sdn', 'un']);
    // The failed sources are asked nothing, so they prune nothing.
    expect(asked).toEqual(['ofac_consolidated', 'eu', 'uk']);
    expect(reports.map((r) => r.source)).toEqual(['ofac_consolidated', 'eu', 'uk']);
    expect(pages.flatMap((p) => p.records.map((r) => r.id))).toEqual([
      'ofac_consolidated:901',
      'eu:EU-1',
      'uk:UK-1',
    ]);
    expect(pages.flatMap((p) => p.tombstones ?? [])).toEqual(['eu:GONE-1']);
  });

  it('names all five sources when every one fails', async () => {
    stubSourceFetch(new Map());
    const failures: SourceSyncFailure[] = [];
    const sync = createSanctionsSync({
      ...NO_MIRROR,
      onSourceFailed: (failure) => failures.push(failure),
    });
    const error = await drainSync(sync).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failures.map((f) => f.source)).toEqual([
      'ofac_sdn',
      'ofac_consolidated',
      'eu',
      'uk',
      'un',
    ]);
    for (const source of failures.map((f) => f.source)) {
      expect(error?.message).toContain(`${source}: `);
    }
  });

  it('ends the whole run at once on a caller abort, reporting no source as failed', async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested.push(url);
        if (url === DEFAULT_SOURCE_URLS.euFsf) {
          // The caller gives up while EU is being requested, as a real fetch sees it.
          controller.abort();
          init?.signal?.throwIfAborted();
        }
        const body = SOURCE_BODIES.get(url) as string;
        return new Response(body, { status: 200 });
      }),
    );
    const reports: SourceSyncReport[] = [];
    const failures: SourceSyncFailure[] = [];
    const sync = createSanctionsSync({
      ...NO_MIRROR,
      onSourceReport: (report) => reports.push(report),
      onSourceFailed: (failure) => failures.push(failure),
    });

    const error = await drainSync(sync, controller.signal).then(
      () => undefined,
      (err: Error) => err,
    );

    expect(error).toBeDefined();
    expect(error?.message).not.toMatch(/Sanctions harvest failed/);
    expect(failures).toEqual([]);
    expect(reports.map((r) => r.source)).toEqual(['ofac_sdn', 'ofac_consolidated']);
    expect(requested).not.toContain(DEFAULT_SOURCE_URLS.ukSanctions);
    expect(requested).not.toContain(DEFAULT_SOURCE_URLS.unSc);
  });

  it("carries an OFAC party's stored programme fields on its pages, and applies the deferred block only on success", async () => {
    // SDN is cut before its programme block; Consolidated arrives whole.
    const bodies = new Map(SOURCE_BODIES);
    bodies.set(
      DEFAULT_SOURCE_URLS.ofacSdn,
      `<Sanctions>${OFAC_REFS}<DistinctParties>${ofacParty('900', 'Stored Party')}${ofacParty('902', 'New Party')}</DistinctParties>`,
    );
    stubSourceFetch(bodies);
    const storedAsked: string[][] = [];
    const applied: [SourceCode, Record<string, unknown>, string[]][] = [];
    const pages: DrainedPage[] = [];
    const sync = createSanctionsSync({
      ...NO_MIRROR,
      pageSize: 1,
      // The mirror stores programme fields for 900 and nothing for the new 902.
      storedDeferredFields: async (ids) => {
        storedAsked.push([...ids]);
        return new Map(
          ids
            .filter((id) => id !== 'ofac_sdn:902')
            .map((id) => [id, { program: `STORED-${id}`, designationDate: '1990-01-02' }]),
        );
      },
      applyDeferredFields: async (source, fields, kept) => {
        applied.push([source, Object.fromEntries(fields), [...kept]]);
      },
    });
    try {
      for await (const page of sync({ signal: new AbortController().signal })) {
        pages.push({ records: page.records });
      }
    } catch {
      // SDN's truncation is the expected failure.
    }

    const rows = pages.flatMap((p) => p.records);
    expect(rows.filter((r) => r.source === 'ofac_sdn')).toMatchObject([
      { id: 'ofac_sdn:900', program: 'STORED-ofac_sdn:900', designation_date: '1990-01-02' },
      { id: 'ofac_sdn:902', program: null, designation_date: null },
    ]);
    // Only the deferring sources are asked for their stored fields, a page at a time.
    expect(storedAsked).toEqual([['ofac_sdn:900'], ['ofac_sdn:902'], ['ofac_consolidated:901']]);
    // The failed source applies no deferred block; the one that finished does,
    // over every party it kept.
    expect(applied).toEqual([
      [
        'ofac_consolidated',
        { '901': { program: 'PROG-CONS', designationDate: '1999-03-04' } },
        ['ofac_consolidated:901'],
      ],
    ]);
    // A source with no deferred block writes its own programme, untouched.
    expect(rows.find((r) => r.id === 'eu:EU-1')).toMatchObject({ program: 'EUPROG' });
  });
});

// ─── Completeness: a document must arrive whole before its source can prune ────

describe('sanctions harvest — document completeness', () => {
  it.each([
    ['eu', DEFAULT_SOURCE_URLS.euFsf, `<export>${EU_ENTITY}`, '</export>', 'eu:EU-1'],
    [
      'uk',
      DEFAULT_SOURCE_URLS.ukSanctions,
      `<Designations>${UK_DESIGNATION}`,
      '</Designations>',
      'uk:UK-1',
    ],
    [
      'un',
      DEFAULT_SOURCE_URLS.unSc,
      `<CONSOLIDATED_LIST><INDIVIDUALS>${UN_INDIVIDUAL}</INDIVIDUALS>`,
      '</CONSOLIDATED_LIST>',
      'un:UN-1',
    ],
    [
      'ofac_sdn',
      DEFAULT_SOURCE_URLS.ofacSdn,
      `<Sanctions>${OFAC_REFS}<DistinctParties>${ofacParty('900', 'OFAC SDN Person')}</DistinctParties>`,
      '</Sanctions>',
      'ofac_sdn:900',
    ],
  ] as const)(
    'fails a %s harvest whose document ends before its root closes, after its whole records',
    async (source, url, body, rootClose, expectedId) => {
      const bodies = new Map(SOURCE_BODIES);
      bodies.set(url, `<?xml version="1.0"?>\n${body}${rootClose}`);
      stubSourceFetch(bodies);
      expect(await harvestOutcome(source)).toEqual({ ids: [expectedId] });

      bodies.set(url, `<?xml version="1.0"?>\n${body}`);
      const truncated = await harvestOutcome(source);
      expect(truncated.ids).toEqual([expectedId]);
      expect(truncated.error).toMatch(/truncated/i);
    },
  );

  /** Serve the EU document as the given chunks, in order. */
  function serveEuChunks(chunks: string[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const feed = pushStream();
        for (const chunk of chunks) feed.push(chunk);
        feed.close();
        return new Response(feed.stream, { status: 200 });
      }),
    );
  }

  it('reads the root close across chunk boundaries, past trailing comments and whitespace', async () => {
    const head = [
      '<?xml version="1.0"?>\n<!-- generated -->\n<!DOCTYPE export>\n<ex',
      'port xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-01-01">',
      EU_ENTITY,
      '</exp',
    ];
    serveEuChunks([...head, 'ort >', '\n<!-- end -->\n']);
    expect(await harvestOutcome('eu')).toEqual({ ids: ['eu:EU-1'] });

    serveEuChunks([...head, 'ort']);
    expect((await harvestOutcome('eu')).error).toMatch(/truncated/i);
  });

  it('accepts a self-closing root as a complete empty document, and fails an unclosed one', async () => {
    serveEuChunks(['<?xml version="1.0"?>\n<export generationDate="2026-01-01"/>\n']);
    expect(await harvestOutcome('eu')).toEqual({ ids: [] });

    serveEuChunks(['<?xml version="1.0"?>\n<export generationDate="2026-01-01">\n']);
    expect((await harvestOutcome('eu')).error).toMatch(/truncated/i);
  });

  it('closes the root only with an end tag of exactly its name', async () => {
    const open = '<?xml version="1.0"?>\n<a.b-c:root>';
    for (const end of ['</a.b-c:root>\n', '</a.b-c:root><!-- </other> -->']) {
      serveEuChunks([open, EU_ENTITY, end]);
      expect(await harvestOutcome('eu')).toEqual({ ids: ['eu:EU-1'] });
    }

    // A name that differs only where a pattern would be lenient (`.` as any
    // character), a longer name, and a root close written inside a trailing comment.
    for (const end of ['</aXb-c:root>', '</a.b-c:rootx>', '</other><!-- </a.b-c:root> -->']) {
      serveEuChunks([open, EU_ENTITY, end]);
      expect((await harvestOutcome('eu')).error).toMatch(/truncated/i);
    }
  });

  it('reads a prolog and an epilog of many comments without backtracking on them', async () => {
    // Each run is judged while it is still incomplete: the prolog before the root
    // tag has arrived, and an epilog cut inside a comment. A pattern that lets one
    // comment span several re-tries every split of the run, doubling per comment.
    const run = '<!-- c --><?pi x?>'.repeat(22);
    const doc = [`<?xml version="1.0"?>\n${run}`, `\n<export>${EU_ENTITY}</export>${run}`];

    serveEuChunks([...doc, '\n']);
    expect(await harvestOutcome('eu')).toEqual({ ids: ['eu:EU-1'] });

    serveEuChunks([...doc, '<!-- cut']);
    expect((await harvestOutcome('eu')).error).toMatch(/truncated/i);
  });

  it('accepts any length of trailing misc, and fails a cut inside a content section after a literal root close (#34)', async () => {
    const whole = `<?xml version="1.0"?>\n<export>${EU_ENTITY}</export>`;
    serveEuChunks([whole, '<!-- c --><?pi x?>'.repeat(1000), '\n']);
    expect(await harvestOutcome('eu')).toEqual({ ids: ['eu:EU-1'] });

    serveEuChunks([`<?xml version="1.0"?>\n<export>${EU_ENTITY}<!-- </export>`]);
    expect((await harvestOutcome('eu')).error).toMatch(/truncated/i);
  });

  it('fails a body that never opens an XML root element', async () => {
    serveEuChunks(['{"error":"service temporarily unavailable"}']);
    expect((await harvestOutcome('eu')).error).toMatch(/root element/i);
  });
});

// ─── Boundedness: records arrive before the document does ──────────────────────

describe('sanctions harvest — bounded memory', () => {
  it.each([
    ['eu', DEFAULT_SOURCE_URLS.euFsf, '<export>', EU_ENTITY, 'eu:EU-1'],
    ['uk', DEFAULT_SOURCE_URLS.ukSanctions, '<Designations>', UK_DESIGNATION, 'uk:UK-1'],
    ['un', DEFAULT_SOURCE_URLS.unSc, '<CONSOLIDATED_LIST><INDIVIDUALS>', UN_INDIVIDUAL, 'un:UN-1'],
    [
      'ofac_sdn',
      DEFAULT_SOURCE_URLS.ofacSdn,
      `<Sanctions>${OFAC_REFS}<DistinctParties>`,
      ofacParty('900', 'OFAC SDN Person'),
      'ofac_sdn:900',
    ],
  ] as const)(
    'emits a %s record before the response body ends',
    async (source, url, prologue, record, expectedId) => {
      const feed = pushStream();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const requested =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (requested !== url) return new Response('not found', { status: 404 });
          return new Response(feed.stream, { status: 200 });
        }),
      );

      const ingester = buildSanctionsIngesters().find((i) => i.source === source);
      expect(ingester).toBeDefined();
      const iterator = ingester!.harvest(new AbortController().signal)[Symbol.asyncIterator]();
      const pending = iterator.next();
      feed.push(prologue);
      feed.push(record);

      // The tail of the document is never sent. A buffered parse cannot produce
      // anything here; a streaming one already has a complete record.
      const settled = await settledWithin(pending, 500);
      expect(settled).not.toBe(PENDING);
      expect((settled as IteratorResult<NormalizedDesignation>).value?.id).toBe(expectedId);

      feed.close();
      await iterator.return?.(undefined);
    },
  );

  it('emits the OFAC party before its programme block, and defers those fields', async () => {
    stubSourceFetch();
    const ingester = buildSanctionsIngesters().find((i) => i.source === 'ofac_sdn');
    const streamed = await collect(ingester!.harvest(new AbortController().signal));

    // The party is emitted before <SanctionsEntries> is read, so the programme
    // fields arrive on the deferred side, not on the streamed record.
    expect(streamed.map((d) => d.sourceEntryId)).toEqual(['900']);
    expect(streamed[0]?.program).toBeUndefined();
    expect(ingester!.deferredFields?.()).toEqual(
      new Map([['900', { program: 'PROG-SDN', designationDate: '1999-03-04' }]]),
    );
  });
});

// ─── The deferred join, end to end through the mirror ──────────────────────────

describe('OFAC deferred programme join', () => {
  let harness: SeededService | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  /** Run a full `init` sync against stubbed sources and read back a row. */
  async function syncAndRead(
    bodies: Map<string, string>,
  ): Promise<(id: string) => Record<string, unknown> | undefined> {
    stubSourceFetch(bodies);
    harness = await freshService();
    await harness.service.designations.runSync({
      mode: 'init',
      signal: new AbortController().signal,
    });
    const handle = await harness.service.designations.raw();
    const rows = handle
      .prepare<Record<string, unknown>>(
        `SELECT id, program, designation_date FROM designation ORDER BY id`,
      )
      .all();
    return (id) => rows.find((r) => r.id === id);
  }

  it('lands the programme fields on rows written before the block was read', async () => {
    const row = await syncAndRead(SOURCE_BODIES);
    expect(row('ofac_sdn:900')).toEqual({
      id: 'ofac_sdn:900',
      program: 'PROG-SDN',
      designation_date: '1999-03-04',
    });
    expect(row('ofac_consolidated:901')).toEqual({
      id: 'ofac_consolidated:901',
      program: 'PROG-CONS',
      designation_date: '1999-03-04',
    });
  });

  it('leaves a party with no programme entry null, and invents no row for an orphan entry', async () => {
    const bodies = new Map(SOURCE_BODIES);
    bodies.set(
      DEFAULT_SOURCE_URLS.ofacSdn,
      `<Sanctions>${OFAC_REFS}
        <DistinctParties>
          ${ofacParty('900', 'Party With Programme')}
          ${ofacParty('910', 'Party Without Programme')}
        </DistinctParties>
        <SanctionsEntries>
          ${ofacEntry('900', 'PROG-SDN', '1999')}
          ${ofacEntry('999', 'ORPHAN', '2001')}
        </SanctionsEntries>
      </Sanctions>`,
    );
    const row = await syncAndRead(bodies);

    expect(row('ofac_sdn:900')?.program).toBe('PROG-SDN');
    // Published with no SanctionsEntry — both columns stay null rather than
    // inheriting a neighbour's programme.
    expect(row('ofac_sdn:910')).toEqual({
      id: 'ofac_sdn:910',
      program: null,
      designation_date: null,
    });
    // A programme entry for a profile the document never published as a party
    // patches nothing; an UPDATE cannot mint an entity with no identity.
    expect(row('ofac_sdn:999')).toBeUndefined();
  });

  /** An SDN document of `count` parties from ref 1000 up, each with its programme entry. */
  function manyPartyDocument(count: number, programmes = true): string {
    const refs = Array.from({ length: count }, (_, i) => String(1000 + i));
    const parties = refs.map((ref) => ofacParty(ref, `Party ${ref}`)).join('');
    const entries = programmes
      ? refs.map((ref) => ofacEntry(ref, 'PROG-SDN', '1999')).join('')
      : '';
    return `<Sanctions>${OFAC_REFS}<DistinctParties>${parties}</DistinctParties><SanctionsEntries>${entries}</SanctionsEntries></Sanctions>`;
  }

  /** Every `ofac_sdn` row's programme fields. */
  async function sdnProgrammes(): Promise<{ designation_date: unknown; program: unknown }[]> {
    const handle = await harness!.service.designations.raw();
    return handle
      .prepare<{ designation_date: unknown; program: unknown }>(
        `SELECT program, designation_date FROM designation WHERE source = 'ofac_sdn'`,
      )
      .all();
  }

  it('keeps the stored programme fields of an OFAC source whose harvest fails after committing pages', async () => {
    // More parties than one sync page, so whole pages land before the cut.
    const bodies = new Map(SOURCE_BODIES);
    const complete = manyPartyDocument(2_600);
    bodies.set(DEFAULT_SOURCE_URLS.ofacSdn, complete);
    await syncAndRead(bodies);
    expect(new Set((await sdnProgrammes()).map((r) => r.program))).toEqual(new Set(['PROG-SDN']));

    // The same document, cut before its programme block.
    bodies.set(
      DEFAULT_SOURCE_URLS.ofacSdn,
      complete.slice(0, complete.indexOf('<SanctionsEntries>')),
    );
    stubSourceFetch(bodies);
    await expect(
      harness!.service.designations.runSync({
        mode: 'refresh',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/ofac_sdn/);

    const rows = await sdnProgrammes();
    expect(rows).toHaveLength(2_600);
    expect(
      rows.filter((r) => r.program !== 'PROG-SDN' || r.designation_date !== '1999-03-04'),
    ).toEqual([]);
  });

  it('clears the programme fields of a party whose programme entry is gone, once the harvest succeeds', async () => {
    const bodies = new Map(SOURCE_BODIES);
    bodies.set(DEFAULT_SOURCE_URLS.ofacSdn, manyPartyDocument(3));
    await syncAndRead(bodies);
    expect((await sdnProgrammes()).map((r) => r.program)).toEqual([
      'PROG-SDN',
      'PROG-SDN',
      'PROG-SDN',
    ]);

    bodies.set(DEFAULT_SOURCE_URLS.ofacSdn, manyPartyDocument(3, false));
    stubSourceFetch(bodies);
    await harness!.service.designations.runSync({
      mode: 'refresh',
      signal: new AbortController().signal,
    });
    expect(await sdnProgrammes()).toEqual([
      { program: null, designation_date: null },
      { program: null, designation_date: null },
      { program: null, designation_date: null },
    ]);
  });
});

// ─── rebuildSearchIndexes: bounded read of the designation table ───────────────────

function designation(
  source: SourceCode,
  entryId: string,
  primaryName: string,
  aliases: string[] = [],
): NormalizedDesignation {
  return {
    id: `${source}:${entryId}`,
    source,
    sourceEntryId: entryId,
    entityType: 'person',
    primaryName,
    payload: {
      aliases: aliases.map((name) => ({ name, nameType: 'aka' as const })),
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  };
}

describe('rebuildSearchIndexes', () => {
  let harness: SeededService | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  async function seed(count: number): Promise<SeededService> {
    harness = await freshService();
    await harness.service.ingestDesignations(
      Array.from({ length: count }, (_, i) =>
        designation('un', `R${String(i).padStart(4, '0')}`, `Person Number ${i}`, [`Alias ${i}`]),
      ),
    );
    return harness;
  }

  /**
   * More designations than one keyset slice holds, so the walk crosses slice
   * boundaries — where a cursor that failed to advance would loop, and one that
   * over-advanced would skip designations out of the index entirely.
   */
  const ACROSS_SLICES = 4500;

  it('reindexes every designation and alias across slice boundaries, and is idempotent', async () => {
    const { service } = await seed(ACROSS_SLICES);
    const handle = await service.designations.raw();
    const count = (): number =>
      handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${NAME_TABLE}`).get()?.n ?? 0;

    await service.rebuildSearchIndexes();
    expect(count()).toBe(ACROSS_SLICES * 2); // one primary + one alias per designation
    await service.rebuildSearchIndexes();
    expect(count()).toBe(ACROSS_SLICES * 2);

    // Every designation is indexed exactly twice — no slice skipped, none repeated.
    const perDesignation = handle
      .prepare<{ n: number; rows: number }>(
        `SELECT COUNT(*) AS rows, COUNT(DISTINCT designation_id) AS n FROM ${NAME_TABLE}`,
      )
      .get();
    expect(perDesignation).toEqual({ n: ACROSS_SLICES, rows: ACROSS_SLICES * 2 });

    const sample = handle
      .prepare<{ name: string; name_type: string }>(
        `SELECT name, name_type FROM ${NAME_TABLE} WHERE designation_id = 'un:R0007' ORDER BY name_type`,
      )
      .all();
    expect(sample).toEqual([
      { name: 'Alias 7', name_type: 'aka' },
      { name: 'Person Number 7', name_type: 'primary' },
    ]);
    // A designation from the last slice is indexed too.
    expect(
      handle
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${NAME_TABLE} WHERE designation_id = 'un:R${String(ACROSS_SLICES - 1).padStart(4, '0')}'`,
        )
        .get()?.n,
    ).toBe(2);
  });

  it('rebuilds the identifier index across slice boundaries, and is idempotent', async () => {
    harness = await freshService();
    await harness.service.ingestDesignations(
      Array.from({ length: ACROSS_SLICES }, (_, i) => {
        const d = designation('un', `R${String(i).padStart(4, '0')}`, `Person Number ${i}`);
        return {
          ...d,
          payload: { ...d.payload, identifiers: [{ type: 'Passport', value: `P-${i}` }] },
        };
      }),
    );
    const handle = await harness.service.designations.raw();
    const rows = (): { keys: number; n: number } | undefined =>
      handle
        .prepare<{ keys: number; n: number }>(
          `SELECT COUNT(*) AS n, COUNT(DISTINCT key) AS keys FROM ${IDENTIFIER_TABLE}`,
        )
        .get();
    handle.exec(`DELETE FROM ${IDENTIFIER_TABLE}`);

    await harness.service.rebuildSearchIndexes();
    expect(rows()).toEqual({ n: ACROSS_SLICES, keys: ACROSS_SLICES });
    await harness.service.rebuildSearchIndexes();
    expect(rows()).toEqual({ n: ACROSS_SLICES, keys: ACROSS_SLICES });
    expect(
      handle
        .prepare(
          `SELECT designation_id, category, key, type, value FROM ${IDENTIFIER_TABLE} WHERE key = 'P4499'`,
        )
        .get(),
    ).toEqual({
      designation_id: 'un:R4499',
      category: 'passport',
      key: 'P4499',
      type: 'Passport',
      value: 'P-4499',
    });
  });

  it('reads the designation table in bounded slices', async () => {
    const { service } = await seed(ACROSS_SLICES);
    const handle = (await service.designations.raw()) as SqliteHandle;
    const original = handle.prepare.bind(handle);
    const designationReads: string[] = [];
    handle.prepare = ((sql: string) => {
      if (/^\s*SELECT[\s\S]*FROM designation\b/i.test(sql)) designationReads.push(sql);
      return original(sql);
    }) as typeof handle.prepare;

    try {
      await service.rebuildSearchIndexes();
    } finally {
      handle.prepare = original;
    }

    // One prepared read, re-run per slice — so a single unbounded read would
    // have to be the only one, and the LIMIT assertion cannot pass trivially.
    expect(designationReads).toHaveLength(1);
    // An unbounded `SELECT … FROM designation` materializes the whole corpus.
    expect(designationReads.every((sql) => /\bLIMIT\b/i.test(sql))).toBe(true);
    expect(designationReads[0]).toMatch(/WHERE id > \?/);
  });
});
