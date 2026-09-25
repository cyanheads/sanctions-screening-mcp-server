/**
 * @fileoverview Opening a sanctions mirror written by the 0.2.0 release. Hosted
 * instances run on a populated mirror that deploys never re-initialize, so the
 * first open under new code is an upgrade in place. The file here is built the
 * way 0.2.0 built one — schema version 1, the store's own tables plus the `name`
 * index and nothing else, rows written through the store's generic upsert — and
 * then opened by the current service, which must serve every existing tool from
 * it unchanged. The GLEIF mirror 0.3.0 wrote records no checkpoint and no
 * reporting exceptions: the current service must degrade on it — parent status
 * `unknown`, a refresh that asks for `mirror:init` — never break.
 * @module tests/integration/mirror-upgrade.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import {
  type SchemaSpec,
  type SqliteHandle,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { designationResource } from '@/mcp-server/resources/definitions/designation.resource.js';
import { entityResource } from '@/mcp-server/resources/definitions/entity.resource.js';
import { getDesignationTool } from '@/mcp-server/tools/definitions/get-designation.tool.js';
import { getEntityTool } from '@/mcp-server/tools/definitions/get-entity.tool.js';
import { listSourcesTool } from '@/mcp-server/tools/definitions/list-sources.tool.js';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenIdentifierTool } from '@/mcp-server/tools/definitions/screen-identifier.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { traceOwnershipTool } from '@/mcp-server/tools/definitions/trace-ownership.tool.js';
import { FIXTURE_DESIGNATIONS } from '@/services/screening/fixtures.js';
import { loadGleifGoldenCopies, refreshGleif } from '@/services/screening/gleif-sync.js';
import { IDENTIFIER_TABLE, REFERENCE_NUMBER_INDEX } from '@/services/screening/schema.js';
import {
  buildScreeningService,
  getScreeningService,
  initScreeningService,
  resetScreeningService,
} from '@/services/screening/screening-service.js';
import { doubleMetaphone, fold } from '@/services/screening/text-matching.js';
import type { NormalizedDesignation } from '@/services/screening/types.js';
import {
  type GleifStandIn,
  leiFile,
  repexFile,
  rrFile,
  startGleifStandIn,
} from '../services/_gleif-publication.js';
import { lookupDesignations, serveLookupCorpus } from '../services/_lookup-corpus.js';

/** The designation store spec as 0.2.0 declared it: no `version`, no migrations. */
const V1_SPEC: Omit<SchemaSpec, 'path'> = {
  table: 'designation',
  primaryKey: 'id',
  columns: {
    id: 'TEXT',
    source: 'TEXT',
    source_entry_id: 'TEXT',
    entity_type: 'TEXT',
    primary_name: 'TEXT',
    normalized_name: 'TEXT',
    program: 'TEXT',
    legal_basis: 'TEXT',
    designation_date: 'TEXT',
    payload: 'TEXT',
  },
  fts: ['normalized_name'],
  indexes: [{ columns: ['source'] }, { columns: ['source', 'source_entry_id'] }],
};

/** 0.2.0's auxiliary DDL: the per-alias `name` index and its FTS, nothing more. */
const V1_AUX_DDL = `
  CREATE TABLE IF NOT EXISTS name (
    designation_id TEXT NOT NULL,
    name           TEXT NOT NULL,
    normalized     TEXT NOT NULL,
    phonetic       TEXT NOT NULL,
    name_type      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_name_designation ON name(designation_id);
  CREATE INDEX IF NOT EXISTS idx_name_phonetic ON name(phonetic);
  CREATE INDEX IF NOT EXISTS idx_name_normalized ON name(normalized);
  CREATE VIRTUAL TABLE IF NOT EXISTS name_fts
    USING fts5(normalized, content='name', content_rowid='rowid',
               tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER IF NOT EXISTS name_ai AFTER INSERT ON name BEGIN
    INSERT INTO name_fts(rowid, normalized) VALUES (new.rowid, new.normalized);
  END;
  CREATE TRIGGER IF NOT EXISTS name_ad AFTER DELETE ON name BEGIN
    INSERT INTO name_fts(name_fts, rowid, normalized) VALUES ('delete', old.rowid, old.normalized);
  END;
`;

/** Write a populated, ready 0.2.0-shaped sanctions mirror at `path`. */
async function writeV1Mirror(path: string, designations: NormalizedDesignation[]): Promise<void> {
  const store = sqliteMirrorStore({ path, ...V1_SPEC });
  await store.applyBatch(
    designations.map((d) => ({
      id: d.id,
      source: d.source,
      source_entry_id: d.sourceEntryId,
      entity_type: d.entityType,
      primary_name: d.primaryName,
      normalized_name: fold(d.primaryName),
      program: d.program ?? null,
      legal_basis: d.legalBasis ?? null,
      designation_date: d.designationDate ?? null,
      payload: JSON.stringify(d.payload),
    })),
    [],
  );
  const handle = await store.raw();
  handle.exec(V1_AUX_DDL);
  const insertName = handle.prepare(
    'INSERT INTO name (designation_id, name, normalized, phonetic, name_type) VALUES (?, ?, ?, ?, ?)',
  );
  handle.transaction(() => {
    for (const d of designations) {
      for (const rec of [{ name: d.primaryName, nameType: 'primary' }, ...d.payload.aliases]) {
        const normalized = fold(rec.name);
        if (normalized) {
          insertName.run(d.id, rec.name, normalized, doubleMetaphone(normalized), rec.nameType);
        }
      }
    }
  });
  await store.writeState({
    status: 'complete',
    completedAt: '2026-09-24T04:00:00.000Z',
    total: designations.length,
  });
  await store.close();
}

const ctxFor = <const E extends readonly ErrorContract[] | undefined>(errors: E) =>
  createMockContext({ errors });

let dir: string;
let path: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sanctions-upgrade-'));
  path = join(dir, 'sanctions.db');
  await writeV1Mirror(path, [...FIXTURE_DESIGNATIONS, ...lookupDesignations()]);
  process.env.SANCTIONS_MIRROR_PATH = path;
  resetServerConfig();
  resetScreeningService();
  initScreeningService();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await getScreeningService().close();
  resetScreeningService();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SANCTIONS_MIRROR_PATH;
  resetServerConfig();
});

describe('a 0.2.0 mirror opened by the current service', () => {
  it('serves sanctions_screen_name hits with the fields 0.2.0 returned', async () => {
    const result = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'Ivan Testovich Volkov' }),
      ctxFor(screenNameTool.errors),
    );
    expect(result.hits[0]).toEqual({
      source: 'ofac_sdn',
      sourceLabel: 'OFAC Specially Designated Nationals (SDN) List',
      sourceEntryId: 'FX-1001',
      entityType: 'person',
      primaryName: 'Ivan Testovich Volkov',
      matchedName: 'Ivan Testovich Volkov',
      matchedNameType: 'primary',
      matchType: 'exact',
      program: 'TEST-PROGRAM',
      designationDate: '2021-03-15',
    });
  });

  it('serves sanctions_get_designation and the designation resource by exact entry ID', async () => {
    const tool = await getDesignationTool.handler(
      getDesignationTool.input.parse({ source: 'uk', entryId: 'RUS0251' }),
      ctxFor(getDesignationTool.errors),
    );
    expect(tool).toMatchObject({
      source: 'uk',
      sourceEntryId: 'RUS0251',
      primaryName: 'Vladimir Vladimirovich PUTIN',
    });
    const params = designationResource.params?.parse({ source: 'ofac_sdn', entryId: 'FX-1001' });
    if (!params) throw new Error('the designation resource declares no params schema');
    const resource = (await designationResource.handler(
      params,
      ctxFor(designationResource.errors),
    )) as Record<string, unknown>;
    expect(resource).toMatchObject({
      sourceEntryId: 'FX-1001',
      primaryName: 'Ivan Testovich Volkov',
    });
  });

  it('reports the stored per-source counts and the as-of of the 0.2.0 sync', async () => {
    const result = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      createMockContext(),
    );
    expect(result.sanctionsAsOf).toBe('2026-09-24T04:00:00.000Z');
    expect(Object.fromEntries(result.sources.map((s) => [s.code, s.recordCount]))).toMatchObject({
      ofac_sdn: 6,
      ofac_consolidated: 2,
      eu: 5,
      uk: 7,
      un: 7,
    });
  });
});

/** The v2 schema facts a migration must leave behind, read off a raw handle. */
function schemaFacts(handle: SqliteHandle) {
  return {
    version: handle.prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version').get()?.v,
    referenceColumns:
      handle
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM pragma_table_info('designation') WHERE name = 'reference_number'",
        )
        .get()?.n ?? 0,
    referenceIndexes: handle
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'designation' AND sql LIKE '%reference_number%'",
      )
      .all()
      .map((row) => row.name),
  };
}

async function screenIdentifier(value: string, type = 'any') {
  const result = await runToolContract(screenIdentifierTool, { value, type } as never);
  expect(result.isError).toBeFalsy();
  return (
    result.structuredContent as { hits: { source: string; sourceEntryId: string }[] }
  ).hits.map((hit) => `${hit.source}:${hit.sourceEntryId}`);
}

describe('the upgrade itself', () => {
  it('migrates the file to schema version 2 with the reference column and its one index', async () => {
    const handle = await getScreeningService().designations.raw();
    expect(schemaFacts(handle)).toEqual({
      version: 2,
      referenceColumns: 1,
      referenceIndexes: [REFERENCE_NUMBER_INDEX],
    });
    // Every row the release wrote is still there, with no reference yet.
    expect(
      handle
        .prepare<{ n: number; refs: number }>(
          'SELECT COUNT(*) AS n, COUNT(reference_number) AS refs FROM designation',
        )
        .get(),
    ).toEqual({ n: 27, refs: 0 });
  });

  it('serves sanctions_screen_identifier from the stored payloads on first open', async () => {
    // No sync has run: the identifier index exists only because the first open built it.
    expect(await screenIdentifier('IMO 7406784')).toEqual(['ofac_sdn:4243']);
    expect(await screenIdentifier('l191609', 'passport')).toEqual([
      'ofac_sdn:7203',
      'eu:927',
      'uk:AQD0239',
    ]);
    expect(await screenIdentifier('X1234567')).toEqual(['ofac_sdn:FX-1001']);
    const handle = await getScreeningService().designations.raw();
    const rows = (): number =>
      handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${IDENTIFIER_TABLE}`).get()?.n ?? 0;
    const built = rows();
    expect(built).toBeGreaterThan(0);

    // A second process opening the upgraded file finds the index built and keeps it.
    const second = buildScreeningService();
    try {
      await second.sourceCounts();
      expect(rows()).toBe(built);
    } finally {
      await second.close();
    }
  });

  it('rebuilds the identifier index on open when a 0.2.0 run wrote designations after it was built', async () => {
    expect(await screenIdentifier('X1234567')).toEqual(['ofac_sdn:FX-1001']);
    await getScreeningService().close();
    resetScreeningService();

    // Rolled back to 0.2.0, which syncs: rows land through the generic upsert and
    // the run is recorded in the sync state, but 0.2.0 knows no identifier index.
    const rolledBack = sqliteMirrorStore({ path, ...V1_SPEC });
    await rolledBack.applyBatch(
      [
        {
          id: 'un:RB-1',
          source: 'un',
          source_entry_id: 'RB-1',
          entity_type: 'person',
          primary_name: 'Rowan Birch',
          normalized_name: fold('Rowan Birch'),
          program: null,
          legal_basis: null,
          designation_date: null,
          payload: JSON.stringify({
            aliases: [],
            identifiers: [{ type: 'Passport', value: 'RB900100' }],
            addresses: [],
            datesOfBirth: [],
            nationalities: [],
          }),
        },
      ],
      [],
    );
    await rolledBack.writeState({
      status: 'complete',
      startedAt: '2026-09-26T04:00:00.000Z',
      completedAt: '2026-09-26T04:00:09.000Z',
      total: 28,
    });
    await rolledBack.close();

    // Upgraded again: the first open finds an index built before that run.
    initScreeningService();
    expect(await screenIdentifier('rb900100', 'passport')).toEqual(['un:RB-1']);
    expect(await screenIdentifier('X1234567')).toEqual(['ofac_sdn:FX-1001']);
  });

  it('gains reference numbers after one sanctions refresh, and resolves them', async () => {
    const lookup = (source: 'un' | 'uk', entryId: string) =>
      getDesignationTool.handler(
        getDesignationTool.input.parse({ source, entryId }),
        ctxFor(getDesignationTool.errors),
      );
    // Before the refresh the column is empty: an entry ID resolves, a reference does not.
    await expect(lookup('un', '113458')).resolves.not.toHaveProperty('referenceNumber');
    await expect(lookup('un', 'QDe.004')).rejects.toMatchObject({
      data: { reason: 'designation_not_found' },
    });

    serveLookupCorpus();
    await getScreeningService().syncSanctions('refresh', new AbortController().signal);

    await expect(lookup('un', 'qde.004')).resolves.toMatchObject({
      sourceEntryId: '113458',
      referenceNumber: 'QDe.004',
    });
    await expect(lookup('uk', 'rus0251')).resolves.toMatchObject({ referenceNumber: '14196' });
    const screened = await screenNameTool.handler(
      screenNameTool.input.parse({ name: 'AL-QAIDA', sources: ['un'] }),
      ctxFor(screenNameTool.errors),
    );
    expect(screened.hits[0]).toMatchObject({ sourceEntryId: '113458', referenceNumber: 'QDe.004' });
    // The refresh rebuilt the identifier index from what the lists now publish.
    expect(await screenIdentifier('X1234567')).toEqual([]);
    expect(await screenIdentifier('IMO 7406784')).toEqual(['ofac_sdn:4243']);
  });
});

describe('a mirror created by the current service', () => {
  it('gets the reference column and its index exactly once, however often it is reopened', async () => {
    const freshPath = join(dir, 'fresh.db');
    process.env.SANCTIONS_MIRROR_PATH = freshPath;
    resetServerConfig();
    for (let open = 0; open < 3; open++) {
      const service = buildScreeningService();
      try {
        await service.sourceCounts();
        expect(schemaFacts(await service.designations.raw())).toEqual({
          version: 2,
          referenceColumns: 1,
          referenceIndexes: [REFERENCE_NUMBER_INDEX],
        });
      } finally {
        await service.close();
      }
    }
  });
});

/** The GLEIF entity store as 0.3.0 declared it. */
const V030_LEI_SPEC: Omit<SchemaSpec, 'path'> = {
  table: 'lei_entity',
  primaryKey: 'lei',
  columns: {
    lei: 'TEXT',
    legal_name: 'TEXT',
    normalized_name: 'TEXT',
    other_names: 'TEXT',
    jurisdiction: 'TEXT',
    status: 'TEXT',
    legal_address: 'TEXT',
    headquarters_address: 'TEXT',
    registration_authority_id: 'TEXT',
    registration_authority_entity_id: 'TEXT',
    last_update: 'TEXT',
    payload: 'TEXT',
  },
  fts: ['normalized_name'],
  indexes: [{ columns: ['jurisdiction'] }, { columns: ['status'] }],
};

const CHILD = '5493001KJTIIGC8Y1R12';
const PARENT = '529900T8BM49AURSDO55';
const LONE = '254900QORVATHNOM0017';

/** Write a ready 0.3.0-shaped GLEIF mirror: entities, one relationship, no checkpoint. */
async function writeV030Gleif(gleifPath: string): Promise<void> {
  const store = sqliteMirrorStore({ path: gleifPath, ...V030_LEI_SPEC });
  const entity = (
    lei: string,
    legalName: string,
    extra: { jurisdiction?: string; otherNames?: string[]; status?: string } = {},
  ) => {
    const { jurisdiction, otherNames = [], status = 'ISSUED' } = extra;
    return {
      lei,
      legal_name: legalName,
      normalized_name: fold(legalName),
      other_names: JSON.stringify(otherNames),
      jurisdiction: jurisdiction ?? null,
      status,
      legal_address: null,
      headquarters_address: null,
      registration_authority_id: null,
      registration_authority_entity_id: null,
      last_update: null,
      payload: JSON.stringify({
        lei,
        legalName,
        otherNames,
        ...(jurisdiction ? { jurisdiction } : {}),
        status,
      }),
    };
  };
  await store.applyBatch(
    [
      entity(CHILD, 'Fictional Trading Company LLC', {
        jurisdiction: 'US-DE',
        otherNames: ['Qorlane Brands'],
      }),
      entity(PARENT, 'Testland Holdings PLC'),
      entity(LONE, 'Spring Trust Nominees Ltd', { status: 'RETIRED' }),
    ],
    [],
  );
  const handle = await store.raw();
  handle.exec(`
    CREATE TABLE IF NOT EXISTS lei_relationship (
      child_lei TEXT NOT NULL, parent_lei TEXT NOT NULL, relationship_type TEXT NOT NULL,
      relationship_status TEXT, relationship_period TEXT,
      PRIMARY KEY (child_lei, parent_lei, relationship_type));
    CREATE INDEX IF NOT EXISTS idx_rel_child ON lei_relationship(child_lei);
    CREATE INDEX IF NOT EXISTS idx_rel_parent ON lei_relationship(parent_lei);
  `);
  handle
    .prepare(
      'INSERT INTO lei_relationship (child_lei, parent_lei, relationship_type, relationship_status) VALUES (?, ?, ?, ?)',
    )
    .run(CHILD, PARENT, 'IS_ULTIMATELY_CONSOLIDATED_BY', 'ACTIVE');
  await store.writeState({
    status: 'complete',
    completedAt: '2026-07-17T12:37:20.000Z',
    total: 3,
  });
  await store.close();
}

describe('a 0.3.0 GLEIF mirror opened by the current service', () => {
  beforeEach(async () => {
    await getScreeningService().close();
    resetScreeningService();
    await writeV030Gleif(join(dir, 'sanctions.gleif.db'));
    initScreeningService();
  });

  const trace = (lei: string) =>
    traceOwnershipTool.handler(
      traceOwnershipTool.input.parse({ lei, direction: 'parents', depth: 2 }),
      ctxFor(traceOwnershipTool.errors),
    );

  it('reads parent status unknown where no relationship is published, and says why', async () => {
    const lone = await trace(LONE);
    expect(lone.reportingExceptionsLoaded).toBe(false);
    expect(lone.nodes[0]?.parentStatus).toEqual({
      direct: { status: 'unknown' },
      ultimate: { status: 'unknown' },
    });
    expect(lone).toMatchObject({ complete: true, truncated: false, missingEntityLeis: [] });

    const child = await trace(CHILD);
    expect(child.nodes.map((node) => node.lei)).toEqual([CHILD, PARENT]);
    expect(child.nodes[0]?.parentStatus).toEqual({
      direct: { status: 'unknown' },
      ultimate: { status: 'relationship' },
    });
  });

  it('lists GLEIF with no exception count and the stored as-of', async () => {
    const result = await listSourcesTool.handler(
      listSourcesTool.input.parse({}),
      createMockContext(),
    );
    expect(result).toMatchObject({
      leiReady: true,
      leiAsOf: '2026-07-17T12:37:20.000Z',
      reportingExceptionsLoaded: false,
    });
    expect(result.sources.find((source) => source.code === 'gleif')).toMatchObject({
      recordCount: 3,
    });
    expect(result.sources.find((source) => source.code === 'gleif')).not.toHaveProperty(
      'reportingExceptionCount',
    );
  });

  it('refreshes nothing and asks for mirror:init, leaving leiAsOf where it was', async () => {
    const fetch = vi.fn(async () => new Response('unreachable', { status: 500 }));
    vi.stubGlobal('fetch', fetch);

    const outcome = await refreshGleif(getScreeningService(), new AbortController().signal, {
      loadMissingExceptions: true,
    });

    expect(outcome.needsInit).toEqual(['lei2', 'rr']);
    expect(fetch).not.toHaveBeenCalled();
    expect((await getScreeningService().leiReadiness()).completedAt).toBe(
      '2026-07-17T12:37:20.000Z',
    );
  });

  const resolveWith = async (input: Record<string, unknown>) => {
    const ctx = ctxFor(resolveEntityTool.errors);
    const result = await resolveEntityTool.handler(resolveEntityTool.input.parse(input), ctx);
    return { result, notice: getEnrichment(ctx).notice };
  };

  it('resolves legal names as before, and says alternate names are not yet indexed (#24)', async () => {
    const { result, notice } = await resolveWith({ name: 'Fictional Trading Company LLC' });
    expect(result.matches[0]).toMatchObject({
      lei: CHILD,
      matchedName: 'Fictional Trading Company LLC',
      matchedNameType: 'LEGAL_NAME',
      matchType: 'exact',
    });
    expect(notice).toMatch(/alternate names/i);
    expect(notice).toMatch(/not yet indexed/i);
    expect(notice).toMatch(/mirror:init/);

    // The notice reaches both response surfaces.
    const wire = await runToolContract(resolveEntityTool, { name: 'Testland Holdings PLC' });
    expect(wire.isError).toBeFalsy();
    const text = wire.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect((wire.structuredContent as { notice?: string }).notice).toMatch(/not yet indexed/i);
    expect(text).toMatch(/not yet indexed/i);
    expect(text).toContain('(LEGAL_NAME)');
  });

  it('scores other names 0.3.0 stored for an entity its legal name pools, typed unknown', async () => {
    const { result } = await resolveWith({ name: 'Fictional Qorlane Brands', matchMode: 'fuzzy' });
    expect(result.matches.find((m) => m.lei === CHILD)).toMatchObject({
      matchedName: 'Qorlane Brands',
      matchedNameType: 'UNKNOWN',
      matchType: 'approximate',
      queryTokenCoverage: { covered: 2, total: 3 },
    });
  });

  it('applies the #23 status and #36 jurisdiction predicates before the index exists', async () => {
    const country = await resolveWith({ name: 'Fictional Trading Company', jurisdiction: 'us' });
    expect(country.result.matches.map((m) => m.lei)).toEqual([CHILD]);
    const subdivision = await resolveWith({
      name: 'Fictional Trading Company',
      jurisdiction: 'US-CA',
    });
    expect(subdivision.result.matches.map((m) => m.lei)).not.toContain(CHILD);
    const lapsed = await resolveWith({ name: 'Spring Trust Nominees', status: 'lapsed' });
    expect(lapsed.result.matches.map((m) => m.lei)).not.toContain(LONE);
    const retired = await resolveWith({ name: 'Spring Trust Nominees', status: 'any' });
    expect(retired.result.matches[0]).toMatchObject({ lei: LONE, status: 'RETIRED' });
  });

  it('serves a record 0.3.0 wrote in the current shape, its bare other names typed unknown', async () => {
    const tool = await getEntityTool.handler(
      getEntityTool.input.parse({ lei: CHILD }),
      ctxFor(getEntityTool.errors),
    );
    expect(tool).toMatchObject({
      otherNames: ['Qorlane Brands'],
      alternateNames: [{ name: 'Qorlane Brands', type: 'UNKNOWN' }],
    });
    const params = entityResource.params?.parse({ lei: CHILD });
    if (!params) throw new Error('the entity resource declares no params schema');
    expect(await entityResource.handler(params, ctxFor(entityResource.errors))).toMatchObject({
      otherNames: ['Qorlane Brands'],
      alternateNames: [{ name: 'Qorlane Brands', type: 'UNKNOWN' }],
    });
  });

  describe('once mirror:init loads the golden copies', () => {
    let standIn: GleifStandIn;
    const golden = (contentDate: string) => ({
      lei2: {
        full: leiFile({ contentDate }, [
          {
            lei: CHILD,
            legalName: 'Fictional Trading Company LLC',
            jurisdiction: 'US-DE',
            otherNames: [{ name: 'Qorlane Brands', type: 'TRADING_OR_OPERATING_NAME' }],
          },
          { lei: PARENT, legalName: 'Testland Holdings PLC' },
          { lei: LONE, legalName: 'Spring Trust Nominees Ltd', status: 'RETIRED' },
        ]),
        deltas: {},
      },
      rr: { full: rrFile({ contentDate }, []), deltas: {} },
      repex: { full: repexFile({ contentDate }, []), deltas: {} },
    });

    beforeEach(async () => {
      standIn = await startGleifStandIn();
      process.env.GLEIF_GOLDEN_COPY_BASE_URL = standIn.base;
      resetServerConfig();
    });

    afterEach(async () => {
      await standIn.close();
      delete process.env.GLEIF_GOLDEN_COPY_BASE_URL;
      resetServerConfig();
    });

    it('does not count the index as built while a load is only part-way through', async () => {
      const full = golden('2026-09-25T08:08:49Z').lei2.full;
      standIn.serve(golden('2026-09-25T08:08:49Z'), {
        '/files/lei2-full.xml': full.slice(0, full.indexOf('</lei:LEIRecord>') + 16),
      });
      await expect(
        loadGleifGoldenCopies(getScreeningService(), new AbortController().signal),
      ).rejects.toThrow();
      const { result, notice } = await resolveWith({ name: 'Qorlane Brands' });
      expect(notice).toMatch(/not yet indexed/i);
      expect(result.matches.map((m) => m.lei)).not.toContain(CHILD);
    });

    it('builds the index, after which alternate names resolve and the notice is gone', async () => {
      standIn.serve(golden('2026-09-25T08:08:49Z'));
      await loadGleifGoldenCopies(getScreeningService(), new AbortController().signal);

      const { result, notice } = await resolveWith({ name: 'Qorlane Brands' });
      expect(result.matches[0]).toMatchObject({
        lei: CHILD,
        legalName: 'Fictional Trading Company LLC',
        matchedName: 'Qorlane Brands',
        matchedNameType: 'TRADING_OR_OPERATING_NAME',
        matchType: 'exact',
      });
      expect(notice).toBeUndefined();

      // The index survives the process: a second service reads the recorded build.
      await getScreeningService().close();
      resetScreeningService();
      initScreeningService();
      expect((await resolveWith({ name: 'Qorlane Brands' })).notice).toBeUndefined();
    });
  });
});
