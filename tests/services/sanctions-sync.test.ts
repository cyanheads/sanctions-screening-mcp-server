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
} from '@/services/screening/sanctions-ingest.js';
import { NAME_TABLE } from '@/services/screening/schema.js';
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

const EU_ENTITY = `<sanctionEntity logicalId="EU-1" euReferenceNumber="EU.1.1">
  <regulation programme="EUPROG" publicationDate="2020-05-06"/>
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

/** Drive a sync generator to exhaustion, keeping every page. */
async function drainSync(
  sync: ReturnType<typeof createSanctionsSync>,
  signal = new AbortController().signal,
): Promise<{ checkpoint?: string | undefined; records: Record<string, unknown>[] }[]> {
  const pages: { checkpoint?: string | undefined; records: Record<string, unknown>[] }[] = [];
  for await (const page of sync({ signal })) {
    pages.push({ records: page.records, checkpoint: page.checkpoint });
  }
  return pages;
}

/** The no-op deferred-field sink; the sanctions sync requires one. */
function noopSync(): ReturnType<typeof createSanctionsSync> {
  return createSanctionsSync({ applyDeferredFields: async () => {} });
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

    const reports: { accepted: number; rejected: object; source: SourceCode }[] = [];
    await drainSync(
      createSanctionsSync({
        applyDeferredFields: async () => {},
        onSourceReport: (report) => reports.push(report),
      }),
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
      rejected: { missingIdentifier: 1, unusableName: 1 },
    });
    expect(reports.find((r) => r.source === 'un')).toEqual({
      source: 'un',
      accepted: 1,
      rejected: { missingIdentifier: 0, unusableName: 0 },
    });
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
});

// ─── rebuildNameIndex: bounded read of the designation table ───────────────────

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

describe('rebuildNameIndex', () => {
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

    await service.rebuildNameIndex();
    expect(count()).toBe(ACROSS_SLICES * 2); // one primary + one alias per designation
    await service.rebuildNameIndex();
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
      await service.rebuildNameIndex();
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
