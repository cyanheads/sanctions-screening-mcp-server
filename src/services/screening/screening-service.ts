/**
 * @fileoverview The screening service — owns the two local mirrors (sanctions
 * `designation` + GLEIF `lei_entity`, both SQLite + FTS5 via the framework
 * MirrorService), the normalized-schema write path that keeps the per-alias
 * `name` index, the per-name `lei_name` index, and the `lei_relationship` table
 * in lockstep, and the matching
 * engine (exact → strict-token → scored Jaro-Winkler / phonetic fuzzy) and the
 * exact identifier lookup. All seven tools compose against this service; the
 * agent never sees the source boundary.
 *
 * The matching engine surfaces only real signal: exact/strong hits are
 * deterministic and unscored; approximate hits carry the raw Jaro-Winkler
 * similarity (0–1). There is no fabricated composite "confidence".
 * @module services/screening/screening-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type {
  Mirror,
  SqliteHandle,
  SqliteStatement,
  SyncMode,
  SyncPage,
  SyncResult,
  SyncState,
} from '@cyanheads/mcp-ts-core/mirror';
import { defineMirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import {
  type IdentifierType,
  identifierCategory,
  identifierKey,
  identifierProbes,
} from '@/services/screening/identifier-matching.js';
import {
  createSanctionsSync,
  type DeferredColumns,
  type DeferredDesignationFields,
  type SanctionsIngester,
} from '@/services/screening/sanctions-ingest.js';
import {
  designationStoreSpec,
  ensureDesignationAuxSchema,
  ensureLeiAuxSchema,
  IDENTIFIER_STAMP_TABLE,
  IDENTIFIER_TABLE,
  LEI_EXCEPTION_TABLE,
  LEI_NAME_FTS_TABLE,
  LEI_NAME_STAMP_TABLE,
  LEI_NAME_TABLE,
  LEI_RELATIONSHIP_TABLE,
  leiStoreSpec,
  NAME_FTS_TABLE,
  NAME_TABLE,
} from '@/services/screening/schema.js';
import {
  bestTokenScore,
  buildFtsMatch,
  doubleMetaphone,
  fold,
  jaroWinkler,
  lengthRatio,
  tokenCoverage,
  tokenize,
} from '@/services/screening/text-matching.js';
import type {
  DesignationPayload,
  EntityType,
  GleifCheckpoint,
  IdentifierRecord,
  LeiAlternateName,
  LeiEntityRecord,
  LeiMatch,
  LeiRelationshipChange,
  MatchMode,
  NameRecord,
  NormalizedDesignation,
  NormalizedLeiEntity,
  NormalizedLeiRelationship,
  NormalizedReportingException,
  QueryTokenCoverage,
  ReportingExceptionChange,
  ScreeningHit,
  SourceCode,
} from '@/services/screening/types.js';
import { LEGAL_NAME_TYPE, SOURCE_CODES, UNKNOWN_NAME_TYPE } from '@/services/screening/types.js';

/** A loaded source's provenance + freshness, surfaced by `sanctions_list_sources`. */
export interface SourceStatus {
  /** Source code (`ofac_sdn`, `eu`, …) or the GLEIF dataset key. */
  code: string;
  /** Record count currently in the mirror for this source. */
  recordCount: number;
}

/** Mirror-level readiness + freshness for a dataset. */
export interface MirrorReadiness {
  completedAt?: string;
  error?: string;
  ready: boolean;
  status: string;
  total: number;
}

/**
 * How to read a `totalAvailable`. `exact` is the complete matching set the query
 * can reach; `lower_bound` means a bounded scan produced it and more matches may
 * exist beyond what was scanned — never present a bound as a total.
 */
export type CountBasis = 'exact' | 'lower_bound';

/** Options for {@link ScreeningService.screenName}. */
export interface ScreenNameOptions {
  /**
   * Whether a strict pass that finds nothing auto-upgrades to a fuzzy pass.
   * Defaults to `true` for the user-facing `sanctions_screen_name` tool (an empty
   * strict result there is unhelpful). The internal cross-reference screens in
   * `sanctions_get_entity` / `sanctions_trace_ownership` set this `false`: a
   * generic legal name ("… Trading Company LLC") that isn't on a list would
   * otherwise fuzzy-match dozens of unrelated designations on a single common
   * token ("company"), presenting a clean entity — or every ownership node — as
   * heavily flagged. There, no strict hit is the correct, honest answer.
   */
  autoFallback?: boolean;
  entityType: EntityType | 'any';
  limit: number;
  matchMode: MatchMode;
  /** Jaro-Winkler floor for fuzzy hits; defaults to config `fuzzyMinScore`. */
  minScore?: number;
  /** Zero-based index of the first hit to return; defaults to 0. */
  offset?: number;
  query: string;
  sources: SourceCode[];
}

/** Result of a screening pass — hits plus how matching ran. */
export interface ScreenNameResult {
  /** True when a strict pass returned nothing and fuzzy was attempted. */
  fuzzyFallbackTriggered: boolean;
  hits: ScreeningHit[];
  /** The match mode actually used (may upgrade strict→fuzzy on empty strict). */
  modeUsed: MatchMode;
  /** Folded query the server matched on. */
  normalizedQuery: string;
  /** Matching designations before `limit`/`offset` — read with `totalAvailableBasis`. */
  totalAvailable: number;
  /** Whether {@link totalAvailable} is the complete count or a scanned-set floor. */
  totalAvailableBasis: CountBasis;
}

/** Options for {@link ScreeningService.resolveEntity}. */
export interface ResolveEntityOptions {
  /**
   * Upper-case legal jurisdiction: a country (`US`), which also matches every
   * subdivision under it (`US-DE`, `US-CA`), or a subdivision, matched exactly.
   */
  jurisdiction?: string;
  limit: number;
  matchMode: MatchMode;
  minScore?: number;
  /** Zero-based index of the first candidate to return; defaults to 0. */
  offset?: number;
  query: string;
  /** `issued` matches ISSUED, `lapsed` exactly LAPSED; `any` applies no status predicate. */
  status: 'any' | 'issued' | 'lapsed';
}

/** Result of an LEI resolution pass. */
export interface ResolveEntityResult {
  /**
   * False on a mirror whose GLEIF name index was never built: only legal names
   * took part in retrieval, and a name published only as an other or
   * transliterated name could not be found.
   */
  alternateNamesIndexed: boolean;
  fuzzyFallbackTriggered: boolean;
  matches: LeiMatch[];
  modeUsed: MatchMode;
  normalizedQuery: string;
  /** Matching LEIs before `limit`/`offset` — read with `totalAvailableBasis`. */
  totalAvailable: number;
  /** Whether {@link totalAvailable} is the complete count or a scanned-set floor. */
  totalAvailableBasis: CountBasis;
}

/**
 * Where an entry ID resolved: to one designation, to several (a reference number
 * more than one designation publishes), or to none.
 */
export type DesignationLookup =
  | { designation: NormalizedDesignation; kind: 'found' }
  | { kind: 'ambiguous'; sourceEntryIds: string[] }
  | { kind: 'not_found' };

/** Options for {@link ScreeningService.screenIdentifier}. */
export interface ScreenIdentifierOptions {
  sources: SourceCode[];
  type: IdentifierType | 'any';
  value: string;
}

/** One designation that publishes an identifier matching the lookup. */
export interface IdentifierHit {
  entityType: EntityType;
  /** Every stored identifier of this designation that matched, as published. */
  matchedIdentifiers: IdentifierRecord[];
  primaryName: string;
  program?: string;
  source: SourceCode;
  sourceEntryId: string;
}

/** Internal row shape from the `name` join used during matching. */
interface NameJoinRow {
  designation_date: string | null;
  designation_id: string;
  entity_type: string;
  name: string;
  name_type: string;
  normalized: string;
  phonetic: string;
  primary_name: string;
  program: string | null;
  reference_number: string | null;
  source: string;
  source_entry_id: string;
}

/** Internal row shape from the `designation_identifier` join used by the identifier lookup. */
interface IdentifierJoinRow {
  country: string | null;
  designation_id: string;
  entity_type: string;
  primary_name: string;
  program: string | null;
  source: string;
  source_entry_id: string;
  type: string;
  value: string;
}

/** Raw row from the `lei_relationship` table. */
interface RelRow {
  child_lei: string;
  parent_lei: string;
  relationship_period: string | null;
  relationship_status: string | null;
  relationship_type: string;
}

/** An LEI candidate row read by the pre-index resolution path, straight off `lei_entity`. */
interface LeiCandidateRow {
  jurisdiction: string | null;
  legal_name: string;
  lei: string;
  normalized_name: string;
  other_names: string;
  status: string | null;
}

/** One `lei_name` row joined to its entity, as the indexed resolution path reads it. */
interface LeiNameRow {
  jurisdiction: string | null;
  legal_name: string;
  lei: string;
  name: string;
  name_type: string;
  normalized: string;
  rowid: number;
  status: string | null;
}

/**
 * Minimum folded-length ratio (shorter / longer) for a candidate to be admitted on
 * WHOLE-STRING Jaro-Winkler similarity alone — see {@link ScreeningService.admitFuzzy}.
 * Jaro-Winkler's shared-prefix boost inflates a short string that is a bare
 * (near-)prefix of a much longer one, so whole-string similarity is trustworthy on
 * its own only when the two strings are of comparable length. Grounded in the live
 * mirror: prefix-inflation false positives sit at ratio ≤ 0.375, genuine spacing/
 * concatenation variants (the recall the whole-string arm exists for) at ≥ 0.83 —
 * 0.5 sits in that gap with wide margin on both sides. A structural property of the
 * metric, not a per-deployment tuning surface, so it is a documented constant rather
 * than a config knob.
 */
const WHOLE_STRING_MIN_LENGTH_RATIO = 0.5;

/**
 * Cap on RAW (pre-dedup) alias rows the strict designation scan reads. A common
 * token can match far more alias rows than designations, so the scan is bounded
 * rather than unbounded. When the cap binds, the deduplicated designation count
 * derived from those rows is a floor, not a total — {@link ScreeningService.runStrict}
 * reports that so the caller can label it `lower_bound` instead of overclaiming.
 */
const STRICT_RAW_ROW_CAP = 5000;

/**
 * The same bound for the strict LEI scan. It counts name rows, about 1.2 per
 * entity across GLEIF, so a lower cap than the designation scan's suffices.
 */
const LEI_STRICT_RAW_ROW_CAP = 2000;

/**
 * Designation rows read per keyset slice by the index rebuilds
 * ({@link ScreeningService.rebuildSearchIndexes}, the identifier rebuild on open) and
 * {@link ScreeningService.staleDesignationIds}. Bounds the rows (and, for the
 * rebuilds, their JSON payloads) resident at once — the whole corpus was
 * previously materialized.
 */
const DESIGNATION_READ_SLICE = 2000;

/** A bounded strict scan: its ordered results plus whether the row cap bound. */
interface BoundedScan<T> {
  /** True when the raw scan hit its row cap, making `results` an incomplete set. */
  capped: boolean;
  results: T[];
}

/**
 * The screening service. Holds both mirrors and the matching engine. Initialized
 * once in `setup()`; tools access it via {@link getScreeningService}.
 */
export class ScreeningService {
  private readonly designationMirror: Mirror;
  private readonly leiMirror: Mirror;
  private designationAuxReady = false;
  private leiAuxReady = false;
  /**
   * The reporting-exception row count, keyed by the GLEIF sync state it was taken
   * under. The table holds millions of rows and SQLite keeps no row count, so a
   * `COUNT(*)` scans all of it — seconds cold — and `sanctions_list_sources` would
   * pay that per call. The rows change only as a load or refresh applies, and each
   * of those commits a new `completedAt` and checkpoint, so the key moves with them.
   */
  private exceptionCountByState: { count: number; state: string } | undefined;

  constructor(private readonly config: ServerConfig) {
    // The two mirrors use SEPARATE database files. `mirror_sync_state` is a
    // single-row table per database, so sharing one file would make the
    // sanctions and GLEIF readiness/sync-state clobber each other — and their
    // lifecycles are independent (sanctions re-harvests in full; GLEIF inits +
    // applies deltas, and is far larger). The GLEIF file is a sibling of the
    // configured sanctions path.
    this.designationMirror = defineMirror({
      name: 'sanctions-designations',
      store: sqliteMirrorStore({ path: config.mirrorPath, ...designationStoreSpec }),
      // The harvest streams, so a source's trailing columns (OFAC publishes its
      // programme block after every party) arrive after those rows are written —
      // the sync patches them through the service rather than re-stating rows.
      sync: createSanctionsSync({
        applyDeferredFields: (source, fields, kept) =>
          this.applyDeferredFields(source, fields, kept),
        storedDeferredFields: (ids) => this.storedDeferredFields(ids),
        staleDesignationIds: (source, kept) => this.staleDesignationIds(source, kept),
        onSourceFailed: (failure) => {
          logger.error(
            'Sanctions harvest — source failed; nothing was removed for it, and the run continues with the next source.',
            requestContextService.createRequestContext({
              operation: 'mirror.sync.source',
              additionalContext: { ...failure },
            }),
          );
        },
        onSourceReport: (report) => {
          const context = requestContextService.createRequestContext({
            operation: 'mirror.sync.source',
            additionalContext: {
              source: report.source,
              accepted: report.accepted,
              pruned: report.pruned,
              withheld: report.withheld,
              rejectedMissingIdentifier: report.rejected.missingIdentifier,
              rejectedUnusableName: report.rejected.unusableName,
            },
          });
          if (report.withheld > 0) {
            logger.warning(
              'Sanctions harvest — source complete; removal withheld: its document dropped more than half of the stored list. Check the source URL and the document, or rebuild the sanctions mirror if the delisting is real.',
              context,
            );
          } else {
            logger.info('Sanctions harvest — source complete', context);
          }
        },
      }),
    });

    this.leiMirror = defineMirror({
      name: 'gleif-entities',
      store: sqliteMirrorStore({ path: gleifPath(config.mirrorPath), ...leiStoreSpec }),
      // GLEIF ingest is driven directly through the ingest methods (golden-copy
      // load + checkpointed delta refresh, `gleif-sync.ts`), so the mirror's own
      // sync yields no pages.
      sync: emptySync,
    });
  }

  /**
   * Open the designation mirror's raw handle, ensuring the auxiliary `name` and
   * identifier indexes exist first. This service owns that DDL rather than the
   * store's `migrations` (see `schema.ts`), so it is applied here — idempotently —
   * on first use.
   *
   * The first open also rebuilds the identifier index from the stored payloads,
   * which hold every identifier, when the index was not built from the data now
   * stored: a release before the index existed (0.2.0) writes designations and
   * the name index but never touches the identifier index, so a mirror it wrote —
   * or synced after a rollback — would otherwise answer identifier lookups from
   * missing or stale rows, and for a screening aid an empty answer reads as a
   * clearance. The index carries the sync-state stamp of the run it followed; a
   * different stamp means a run it did not follow. While a run is in progress its
   * own rebuild follows, so only an index holding nothing is rebuilt then.
   */
  private async designationHandle(): Promise<SqliteHandle> {
    const raw = await this.designationMirror.raw();
    if (!this.designationAuxReady) {
      ensureDesignationAuxSchema(raw);
      const state = await this.designationMirror.store.readState();
      const stamp = syncStamp(state);
      const stale = state.status !== 'in_progress' && identifierStamp(raw) !== stamp;
      if (stale || identifierIndexUnbuilt(raw)) {
        raw.transaction(() => rebuildIdentifierIndex(raw, stamp));
        logger.info(
          'Sanctions mirror — identifier index rebuilt from the stored designations',
          requestContextService.createRequestContext({ operation: 'mirror.identifierBackfill' }),
        );
      }
      this.designationAuxReady = true;
    }
    return raw;
  }

  /**
   * Open the GLEIF mirror's raw handle, ensuring the auxiliary tables exist first.
   *
   * A mirror that holds no entity yet has its name index complete by definition,
   * and every write from here on keeps it so, so the first open records that
   * build. A mirror an earlier release populated gains the tables empty and no
   * record: its index is built by the next golden-copy load (`mirror:init`).
   */
  private async leiHandle(): Promise<SqliteHandle> {
    const raw = await this.leiMirror.raw();
    if (!this.leiAuxReady) {
      ensureLeiAuxSchema(raw);
      const empty = !raw.prepare(`SELECT 1 FROM ${leiStoreSpec.table} LIMIT 1`).get();
      if (empty && leiNameStamp(raw) === undefined) {
        writeLeiNameStamp(raw, leiStateStamp(await this.leiMirror.store.readState()));
      }
      this.leiAuxReady = true;
    }
    return raw;
  }

  /** The sanctions designation mirror (for sync lifecycle scripts). */
  get designations(): Mirror {
    return this.designationMirror;
  }

  /** The GLEIF entity mirror (for sync lifecycle scripts). */
  get leiEntities(): Mirror {
    return this.leiMirror;
  }

  /**
   * Run the sanctions sync, then rebuild the name and identifier indexes from what
   * the run left in `designation` — whether the sync resolved or rejected. A run
   * that fails part way (a source that could not be read, a caller abort) has
   * still committed the pages before the failure and, past a failed source, every
   * source after it; the indexes must follow those rows, not the ones they
   * replaced. The one entry point for `mirror:init`, `mirror:refresh`, and the
   * HTTP refresh cron.
   *
   * @throws The sync's failure, after the rebuild: one error naming every source
   *   that failed, or the caller's abort.
   */
  async syncSanctions(mode: SyncMode, signal: AbortSignal): Promise<SyncResult> {
    try {
      return await this.designationMirror.runSync({ mode, signal });
    } finally {
      await this.rebuildSearchIndexes();
    }
  }

  /** True once the sanctions mirror has ever completed a full sync. */
  sanctionsReady(): Promise<boolean> {
    return this.designationMirror.ready();
  }

  /** True once the GLEIF mirror has ever completed a full sync. */
  leiReady(): Promise<boolean> {
    return this.leiMirror.ready();
  }

  // ─── Ingest write path ───────────────────────────────────────────────────

  /**
   * Apply a batch of normalized designations. Writes the primary `designation`
   * rows via the mirror store, then refreshes the per-alias `name` index and the
   * identifier index for exactly those designations — all in one transaction.
   * Idempotent per id.
   */
  async ingestDesignations(designations: NormalizedDesignation[]): Promise<void> {
    if (designations.length === 0) return;
    const handle = await this.designationHandle();

    handle.transaction(() => {
      const upsert = handle.prepare(
        `INSERT INTO designation
           (id, source, source_entry_id, entity_type, primary_name, normalized_name,
            program, legal_basis, designation_date, reference_number, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source=excluded.source, source_entry_id=excluded.source_entry_id,
           entity_type=excluded.entity_type, primary_name=excluded.primary_name,
           normalized_name=excluded.normalized_name, program=excluded.program,
           legal_basis=excluded.legal_basis, designation_date=excluded.designation_date,
           reference_number=excluded.reference_number, payload=excluded.payload`,
      );
      const deleteNames = handle.prepare(`DELETE FROM ${NAME_TABLE} WHERE designation_id = ?`);
      const insertName = prepareNameInsert(handle);
      const deleteIdentifiers = handle.prepare(
        `DELETE FROM ${IDENTIFIER_TABLE} WHERE designation_id = ?`,
      );
      const insertIdentifier = prepareIdentifierInsert(handle);

      for (const d of designations) {
        upsert.run(
          d.id,
          d.source,
          d.sourceEntryId,
          d.entityType,
          d.primaryName,
          fold(d.primaryName),
          d.program ?? null,
          d.legalBasis ?? null,
          d.designationDate ?? null,
          d.referenceNumber ?? null,
          JSON.stringify(d.payload),
        );

        deleteNames.run(d.id);
        writeNames(insertName, d.id, d.primaryName, d.payload.aliases);
        deleteIdentifiers.run(d.id);
        writeIdentifiers(insertIdentifier, d.id, d.payload.identifiers);
      }
    });
  }

  /**
   * Apply the columns a source could only publish after the records they belong
   * to — the OFAC programme and designation date, which `SDN_ADVANCED.XML`
   * carries in a `<SanctionsEntries>` block after every `<DistinctParty>`. The
   * streaming harvest writes those parties first and hands the fields here once
   * the source drains, keyed by `source_entry_id`, with the designation ids it
   * kept (`{source}:{source_entry_id}`).
   *
   * Every kept party gets its programme entry, or neither column when the
   * document published none for it — its rows carried the previously stored
   * values while the harvest ran ({@link storedDeferredFields}). An UPDATE of kept
   * rows only: an entry with no kept party points at a party the document never
   * published, and inventing a row for it would put an entity with no identity
   * into the searchable corpus.
   */
  async applyDeferredFields(
    source: SourceCode,
    fields: DeferredDesignationFields,
    kept: ReadonlySet<string>,
  ): Promise<void> {
    const handle = await this.designationHandle();
    const prefix = `${source}:`;
    handle.transaction(() => {
      const update = handle.prepare(
        `UPDATE designation SET program = ?, designation_date = ? WHERE id = ?`,
      );
      for (const id of kept) {
        const value = fields.get(id.slice(prefix.length));
        update.run(value?.program ?? null, value?.designationDate ?? null, id);
      }
    });
  }

  /**
   * The programme fields stored for the given designation ids, keyed by id — what
   * a page of a deferring source carries until its own programme block arrives,
   * so a harvest that fails first leaves them as they were. Bounded by the page.
   */
  async storedDeferredFields(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, DeferredColumns>> {
    const handle = await this.designationHandle();
    const rows = handle
      .prepare<{ designation_date: string | null; id: string; program: string | null }>(
        `SELECT id, program, designation_date FROM designation
         WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids));
    return new Map(
      rows.map((row) => [
        row.id,
        {
          ...(row.program ? { program: row.program } : {}),
          ...(row.designation_date ? { designationDate: row.designation_date } : {}),
        },
      ]),
    );
  }

  /**
   * The ids of `source`'s stored designations absent from `kept` — the rows its
   * latest complete document no longer published, which the sanctions sync
   * removes. Walks the source's rows in keyset slices so only the stale ids are
   * retained; `kept` is the one full-size set, held by the caller.
   */
  async staleDesignationIds(source: SourceCode, kept: ReadonlySet<string>): Promise<string[]> {
    const handle = await this.designationHandle();
    const slice = handle.prepare<{ id: string }>(
      `SELECT id FROM designation WHERE source = ? AND id > ? ORDER BY id LIMIT ${DESIGNATION_READ_SLICE}`,
    );
    const stale: string[] = [];
    let cursor = '';
    for (;;) {
      const rows = slice.all(source, cursor);
      if (rows.length === 0) return stale;
      for (const { id } of rows) if (!kept.has(id)) stale.push(id);
      cursor = rows[rows.length - 1]?.id ?? cursor;
    }
  }

  /**
   * Rebuild the per-alias `name` index and the identifier index from the current
   * `designation` table. The MirrorService `sync` path only writes the primary
   * `designation` rows, so {@link syncSanctions} calls this after every run to
   * regenerate both — including the Double-Metaphone phonetic keys and the
   * per-category identifier keys that can't be computed in SQL. Idempotent: clears
   * and repopulates both tables, which is also what drops the names and
   * identifiers of a designation the sync removed.
   *
   * The designation table is walked in keyset slices ordered by `id` rather than
   * materialized: `SELECT … .all()` over the whole corpus, plus a `JSON.parse`
   * per row, is a second unbounded buffer in the same phase as the harvest, and
   * it scales with the corpus. The walk still runs inside ONE transaction — a
   * half-rebuilt index would silently narrow every screen — and nothing writes
   * `designation` during it, so the keyset cursor sees a stable table.
   */
  async rebuildSearchIndexes(): Promise<void> {
    const handle = await this.designationHandle();
    const stamp = syncStamp(await this.designationMirror.store.readState());
    handle.transaction(() => {
      handle.exec(`DELETE FROM ${NAME_TABLE}; DELETE FROM ${IDENTIFIER_TABLE};`);
      const insertName = prepareNameInsert(handle);
      const insertIdentifier = prepareIdentifierInsert(handle);
      walkDesignations(handle, (row, payload) => {
        writeNames(insertName, row.id, row.primary_name, payload.aliases);
        writeIdentifiers(insertIdentifier, row.id, payload.identifiers);
      });
      writeIdentifierStamp(handle, stamp);
    });
  }

  /**
   * Apply a batch of GLEIF Level 1 entity records, upserting by LEI in batch
   * order and replacing each entity's `lei_name` rows in the same transaction, so
   * no reader sees an entity without its names or with another version's. Every
   * Level 1 write — golden copy, delta, or fixture — goes through here, so the
   * name index follows every one of them. Level 1 files publish no deletion
   * marker, so there is no removal path.
   */
  async ingestLeiEntities(entities: NormalizedLeiEntity[]): Promise<void> {
    if (entities.length === 0) return;
    const handle = await this.leiHandle();
    handle.transaction(() => {
      const upsert = handle.prepare(
        `INSERT INTO ${leiStoreSpec.table}
           (lei, legal_name, normalized_name, other_names, jurisdiction, status, legal_address,
            headquarters_address, registration_authority_id, registration_authority_entity_id,
            last_update, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lei) DO UPDATE SET
           legal_name=excluded.legal_name, normalized_name=excluded.normalized_name,
           other_names=excluded.other_names, jurisdiction=excluded.jurisdiction,
           status=excluded.status, legal_address=excluded.legal_address,
           headquarters_address=excluded.headquarters_address,
           registration_authority_id=excluded.registration_authority_id,
           registration_authority_entity_id=excluded.registration_authority_entity_id,
           last_update=excluded.last_update, payload=excluded.payload`,
      );
      const deleteNames = handle.prepare(`DELETE FROM ${LEI_NAME_TABLE} WHERE lei = ?`);
      const insertName = handle.prepare(
        `INSERT INTO ${LEI_NAME_TABLE}
           (lei, name, normalized, name_type, suffix_terms, jurisdiction_terms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const e of entities) {
        upsert.run(
          e.lei,
          e.legalName,
          fold(e.legalName),
          JSON.stringify(e.otherNames),
          e.jurisdiction ?? null,
          e.status ?? null,
          e.legalAddress ?? null,
          e.headquartersAddress ?? null,
          e.registrationAuthorityId ?? null,
          e.registrationAuthorityEntityId ?? null,
          e.lastUpdate ?? null,
          JSON.stringify(e),
        );
        deleteNames.run(e.lei);
        writeLeiNames(insertName, e);
      }
    });
  }

  /**
   * Apply a batch of GLEIF Level 2 records in document order, each on its own
   * (child, parent, type) key: a record GLEIF marked deleted removes its row, any
   * other replaces it. A child's rows the batch does not name are left alone —
   * a delta publishes only what changed, and a golden copy streams one child's
   * relationships across batches. A key named twice ends in its last record's
   * state. Deleting a row that is not stored is a no-op, so a re-applied delta
   * converges.
   */
  async ingestLeiRelationships(relationships: readonly LeiRelationshipChange[]): Promise<void> {
    if (relationships.length === 0) return;
    const handle = await this.leiHandle();

    handle.transaction(() => {
      const remove = handle.prepare(
        `DELETE FROM ${LEI_RELATIONSHIP_TABLE}
         WHERE child_lei = ? AND parent_lei = ? AND relationship_type = ?`,
      );
      const upsert = handle.prepare(
        `INSERT OR REPLACE INTO ${LEI_RELATIONSHIP_TABLE}
           (child_lei, parent_lei, relationship_type, relationship_status, relationship_period)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const r of relationships) {
        if (r.deleted) {
          remove.run(r.childLei, r.parentLei, r.relationshipType);
          continue;
        }
        upsert.run(
          r.childLei,
          r.parentLei,
          r.relationshipType,
          r.relationshipStatus ?? null,
          r.relationshipPeriod ?? null,
        );
      }
    });
  }

  /** Wipe every GLEIF Level 2 relationship — the single clear before a golden-copy load. */
  async clearLeiRelationships(): Promise<void> {
    const handle = await this.leiHandle();
    handle.exec(`DELETE FROM ${LEI_RELATIONSHIP_TABLE}`);
  }

  /**
   * Apply a batch of reporting-exception records in document order, each on its
   * (LEI, category) key: a record GLEIF marked deleted removes its row, any other
   * replaces it — the same per-record rule as {@link ingestLeiRelationships}.
   */
  async ingestReportingExceptions(exceptions: readonly ReportingExceptionChange[]): Promise<void> {
    if (exceptions.length === 0) return;
    const handle = await this.leiHandle();
    handle.transaction(() => {
      const remove = handle.prepare(
        `DELETE FROM ${LEI_EXCEPTION_TABLE} WHERE lei = ? AND category = ?`,
      );
      const upsert = handle.prepare(
        `INSERT OR REPLACE INTO ${LEI_EXCEPTION_TABLE} (lei, category, reasons) VALUES (?, ?, ?)`,
      );
      for (const e of exceptions) {
        if (e.deleted) remove.run(e.lei, e.category);
        else upsert.run(e.lei, e.category, JSON.stringify(e.reasons));
      }
    });
  }

  /** Wipe every reporting exception — the single clear before a golden-copy load. */
  async clearReportingExceptions(): Promise<void> {
    const handle = await this.leiHandle();
    handle.exec(`DELETE FROM ${LEI_EXCEPTION_TABLE}`);
  }

  /**
   * The reporting exceptions stored for each of `leis`, category-ordered; an LEI
   * with none is absent from the map. One query per call. Whether the dataset is
   * loaded at all is {@link reportingExceptionsLoaded}'s question, not this one's.
   */
  async getReportingExceptions(
    leis: readonly string[],
  ): Promise<Map<string, Omit<NormalizedReportingException, 'lei'>[]>> {
    const byLei = new Map<string, Omit<NormalizedReportingException, 'lei'>[]>();
    if (leis.length === 0) return byLei;
    const handle = await this.leiHandle();
    const rows = handle
      .prepare<{ category: string; lei: string; reasons: string }>(
        `SELECT lei, category, reasons FROM ${LEI_EXCEPTION_TABLE}
         WHERE lei IN (SELECT value FROM json_each(?))
         ORDER BY lei, category`,
      )
      .all(JSON.stringify(leis));
    for (const row of rows) {
      const entry = { category: row.category, reasons: JSON.parse(row.reasons) as string[] };
      const list = byLei.get(row.lei);
      if (list) list.push(entry);
      else byLei.set(row.lei, [entry]);
    }
    return byLei;
  }

  /** The GLEIF mirror's per-dataset checkpoint; empty when none is recorded. */
  async gleifCheckpoint(): Promise<GleifCheckpoint> {
    return parseGleifCheckpoint((await this.leiMirror.store.readState()).checkpoint);
  }

  /**
   * True once a reporting-exceptions load is recorded in the checkpoint. Never
   * inferred from the table: a mirror written before the dataset existed gains the
   * table empty, and an empty table read as "no exceptions" would claim an entity
   * reports its parents when nothing was ever loaded.
   */
  async reportingExceptionsLoaded(): Promise<boolean> {
    return (await this.gleifCheckpoint()).repex !== undefined;
  }

  /**
   * Mark the sanctions mirror's sync state complete (sets `completedAt`/`total`),
   * so the read path's `ready()` gate opens. The MirrorService `runSync` path
   * sets this automatically; the fixture-seed and lifecycle-rebuild paths call it
   * explicitly after a direct ingest.
   */
  async markSanctionsReady(total: number): Promise<void> {
    await this.designationMirror.store.writeState({
      status: 'complete',
      completedAt: new Date().toISOString(),
      total,
    });
  }

  /**
   * Mark the GLEIF mirror's sync state complete as of now — see
   * {@link markSanctionsReady} — recording `checkpoint` as its per-dataset
   * checkpoint, or keeping the stored one when none is given. The store writes
   * every non-durable field it is handed and clears the rest, so the checkpoint is
   * always passed explicitly here: a write that omitted it would erase it.
   */
  async markLeiReady(
    total: number,
    checkpoint?: GleifCheckpoint,
    options: { namesIndexed?: true } = {},
  ): Promise<void> {
    const kept = checkpoint ?? (await this.gleifCheckpoint());
    // The name index stays built across this commit when it was built before it —
    // every write since went through ingestLeiEntities — or when the caller just
    // rewrote every entity (a golden-copy load). The stamp follows the state write:
    // a crash between the two reads as unbuilt, the safe direction.
    const indexed = options.namesIndexed === true || (await this.leiNamesIndexed());
    const completedAt = new Date().toISOString();
    await this.leiMirror.store.writeState({
      status: 'complete',
      completedAt,
      total,
      ...(Object.keys(kept).length > 0 ? { checkpoint: JSON.stringify(kept) } : {}),
    });
    if (indexed) writeLeiNameStamp(await this.leiHandle(), completedAt);
  }

  /**
   * True when the GLEIF name index is known complete: its stamp is the sync
   * state's current `completedAt`. Never inferred from the table — a mirror an
   * earlier release wrote gains it empty. An earlier release's write after a
   * rollback moves `completedAt` without re-stamping, so its entities, whose
   * names the index never saw, read as unindexed too.
   */
  async leiNamesIndexed(): Promise<boolean> {
    const stamp = leiNameStamp(await this.leiHandle());
    return stamp !== undefined && stamp === leiStateStamp(await this.leiMirror.store.readState());
  }

  /**
   * Record that a GLEIF golden-copy load has started: the checkpoint is cleared, so
   * a load that never finishes leaves nothing for a refresh to apply deltas onto.
   * `completedAt` and `total` are durable in the store, so the mirror stays ready —
   * and queryable — on its last completed load while this one runs.
   */
  async beginLeiLoad(): Promise<void> {
    await this.leiMirror.store.writeState({
      status: 'in_progress',
      startedAt: new Date().toISOString(),
    });
  }

  /**
   * Load a synthetic fixture into both mirrors and mark them ready, reporting
   * exceptions recorded as loaded. For tests and a quick local smoke run — NOT the
   * real corpus, which loads via `mirror:init`.
   */
  async seedFixtures(fixtures: {
    designations: NormalizedDesignation[];
    leiEntities: NormalizedLeiEntity[];
    leiRelationships: NormalizedLeiRelationship[];
    reportingExceptions: NormalizedReportingException[];
  }): Promise<void> {
    await this.ingestDesignations(fixtures.designations);
    await this.ingestLeiEntities(fixtures.leiEntities);
    await this.ingestLeiRelationships(fixtures.leiRelationships);
    await this.ingestReportingExceptions(fixtures.reportingExceptions);
    await this.markSanctionsReady(fixtures.designations.length);
    await this.markLeiReady(fixtures.leiEntities.length, { repex: new Date().toISOString() });
  }

  // ─── Matching engine: screen a name against the sanctions lists ────────────

  /**
   * Screen a name against the loaded sanctions lists. Strict mode runs exact
   * then all-tokens-present (FTS5). Fuzzy mode (explicit, or auto when strict is
   * empty) adds Jaro-Winkler + phonetic scoring against the per-alias index.
   */
  async screenName(opts: ScreenNameOptions, ctx: Context): Promise<ScreenNameResult> {
    const normalizedQuery = fold(opts.query);
    const queryTokens = tokenize(normalizedQuery);
    const handle = await this.designationHandle();
    const offset = opts.offset ?? 0;

    const sourceFilter = this.sourceFilterClause(opts.sources);
    // entityType is enum-constrained at the tool boundary; escape at the SQL sink
    // anyway so the service stays injection-safe for any future caller that
    // reaches it without re-validating (matches the jurisdiction handling below).
    const typeFilter =
      opts.entityType === 'any'
        ? ''
        : ` AND d.entity_type = '${this.escapeLiteral(opts.entityType)}'`;

    // Step 1+2: exact-normalized, then strict all-tokens-present (FTS5 AND).
    const strict = this.runStrict(handle, {
      normalizedQuery,
      sourceFilter,
      typeFilter,
    });
    const strictHits = strict.results;

    // Explicit fuzzy always runs fuzzy; strict auto-upgrades to fuzzy on an empty
    // result ONLY when auto-fallback is enabled (the default — off for internal
    // cross-reference screens, see ScreenNameOptions.autoFallback).
    const wantFuzzy =
      opts.matchMode === 'fuzzy' || (opts.autoFallback !== false && strictHits.length === 0);
    if (!wantFuzzy || queryTokens.length === 0) {
      ctx.log.debug('Strict screening complete', {
        normalizedQuery,
        hitCount: strictHits.length,
      });
      return {
        hits: strictHits.slice(offset, offset + opts.limit),
        modeUsed: 'strict',
        normalizedQuery,
        fuzzyFallbackTriggered: false,
        totalAvailable: strictHits.length,
        totalAvailableBasis: strict.capped ? 'lower_bound' : 'exact',
      };
    }

    // Step 3/3b: fuzzy (Jaro-Winkler) + phonetic over the candidate pool.
    const minScore = opts.minScore ?? this.config.fuzzyMinScore;
    const fuzzyHits = this.runFuzzy(handle, {
      normalizedQuery,
      queryTokens,
      sourceFilter,
      typeFilter,
      minScore,
      cap: this.config.fuzzyMaxResults,
    });

    // Merge: keep strict hits (deterministic, unscored) ahead of fuzzy, dedup by id.
    const merged = this.mergeHits(strictHits, fuzzyHits);
    ctx.log.debug('Fuzzy screening complete', {
      normalizedQuery,
      strictCount: strictHits.length,
      fuzzyCount: fuzzyHits.length,
      minScore,
    });
    return {
      hits: merged.slice(offset, offset + opts.limit),
      modeUsed: 'fuzzy',
      normalizedQuery,
      fuzzyFallbackTriggered: opts.matchMode === 'strict' && strictHits.length === 0,
      totalAvailable: merged.length,
      // The fuzzy pool comes from bounded blocking queries and is truncated to
      // `fuzzyMaxResults` before the merge, so no fuzzy-mode count can be a
      // corpus-wide total — it is always a floor on what scoring actually saw.
      totalAvailableBasis: 'lower_bound',
    };
  }

  private sourceFilterClause(sources: SourceCode[]): string {
    if (sources.length === 0 || sources.length === SOURCE_CODES.length) return '';
    // Source codes are enum-constrained upstream; escape at the sink regardless
    // so the IN-list stays injection-safe independent of the caller.
    const list = sources.map((s) => `'${this.escapeLiteral(s)}'`).join(', ');
    return ` AND d.source IN (${list})`;
  }

  private runStrict(
    handle: SqliteHandle,
    args: {
      normalizedQuery: string;
      sourceFilter: string;
      typeFilter: string;
    },
  ): BoundedScan<ScreeningHit> {
    const match = buildFtsMatch(args.normalizedQuery);
    if (!match) return { results: [], capped: false };

    // FTS over the name index; join back to name + designation. Classify each
    // matched name as exact (normalized equality) or strong (all tokens present).
    const rows = handle
      .prepare<NameJoinRow>(
        `SELECT n.designation_id, n.name, n.normalized, n.phonetic, n.name_type,
                d.source, d.source_entry_id, d.entity_type, d.primary_name,
                d.program, d.designation_date, d.reference_number
         FROM ${NAME_FTS_TABLE} f
         JOIN ${NAME_TABLE} n ON n.rowid = f.rowid
         JOIN designation d ON d.id = n.designation_id
         WHERE ${NAME_FTS_TABLE} MATCH ?${args.sourceFilter}${args.typeFilter}
         LIMIT ${STRICT_RAW_ROW_CAP}`,
      )
      .all(match);

    const byDesignation = new Map<string, ScreeningHit>();
    for (const row of rows) {
      const isExact = row.normalized === args.normalizedQuery;
      const hit = this.rowToHit(row, isExact ? 'exact' : 'strong');
      const existing = byDesignation.get(row.designation_id);
      // Prefer the higher-confidence match type per designation.
      if (!existing || (isExact && existing.matchType !== 'exact')) {
        byDesignation.set(row.designation_id, hit);
      }
    }
    // Exact hits first, then strong; designation id breaks same-band ties. The
    // id is the total order pagination needs — without it, tied hits fall back to
    // incidental row-arrival/Map-insertion order and pages could overlap or drop rows.
    return {
      results: [...byDesignation.values()].sort(
        (a, b) =>
          matchRank(b.matchType) - matchRank(a.matchType) ||
          a.designationId.localeCompare(b.designationId),
      ),
      capped: rows.length >= STRICT_RAW_ROW_CAP,
    };
  }

  private runFuzzy(
    handle: SqliteHandle,
    args: {
      normalizedQuery: string;
      queryTokens: string[];
      sourceFilter: string;
      typeFilter: string;
      minScore: number;
      cap: number;
    },
  ): ScreeningHit[] {
    const queryPhonetic = doubleMetaphone(args.normalizedQuery);
    const phoneticKeys = [...new Set(queryPhonetic.split(/\s+/).filter(Boolean))];

    // Candidate pool from two blocking strategies, each query SEPARATELY so no
    // one strategy starves the others under the row cap:
    //  (a) phonetic-key equality — seeds the pool with transliteration-class
    //      variants (e.g. Mohammed/Muhammad share DM key MHMT) whose whole-string
    //      Jaro-Winkler is low; they still face the admission gate below, which
    //      their high-scoring significant token pairs (with coverage) clear.
    //  (b) a leading-trigram prefix shared with any query token — pulls the
    //      JW-near candidates whose phonetic key differs (e.g. Volkov/Volkow).
    // A single OR'd query with one shared LIMIT let the first clause (e.g. a
    // common given-name prefix) exhaust the cap before later tokens' rows were
    // scanned, dropping the true multi-token match from the pool entirely
    // (e.g. "nikolas maduro moros" never reaching "MADURO MOROS Nicolas"). Each
    // strategy now gets its own bounded query and the rows are merged, deduped by
    // rowid — every query token contributes candidates.
    const select = `SELECT n.rowid AS rowid, n.designation_id, n.name, n.normalized,
                n.phonetic, n.name_type, d.source, d.source_entry_id, d.entity_type,
                d.primary_name, d.program, d.designation_date, d.reference_number
         FROM ${NAME_TABLE} n
         JOIN designation d ON d.id = n.designation_id`;
    const prefixes = blockingPrefixes(args.queryTokens);
    const limit = perStrategyLimit(args.cap);
    const byRowid = new Map<number, NameJoinRow & { rowid: number }>();
    const collect = (rows: (NameJoinRow & { rowid: number })[]): void => {
      for (const r of rows) if (!byRowid.has(r.rowid)) byRowid.set(r.rowid, r);
    };

    if (phoneticKeys.length > 0) {
      const placeholders = phoneticKeys.map(() => '?').join(', ');
      collect(
        handle
          .prepare<NameJoinRow & { rowid: number }>(
            `${select} WHERE n.phonetic IN (${placeholders})${args.sourceFilter}${args.typeFilter} LIMIT ?`,
          )
          .all(...phoneticKeys, limit),
      );
    }
    for (const prefix of prefixes) {
      collect(
        handle
          .prepare<NameJoinRow & { rowid: number }>(
            `${select} WHERE n.normalized LIKE ?${args.sourceFilter}${args.typeFilter} LIMIT ?`,
          )
          .all(`%${prefix}%`, limit),
      );
    }
    if (byRowid.size === 0) return [];
    const rows = [...byRowid.values()];

    // The blocking SQL above *seeds the candidate pool* — phonetic-key equality
    // pulls transliteration-class variants (e.g. Mohammed/Muhammad share DM key
    // MHMT) whose whole-string Jaro-Winkler is low, the trigram prefix pulls the
    // JW-near variants. Both are only candidates; admission is decided here.
    //
    // The surfaced `score` stays a RAW Jaro-Winkler measurement — the max of the
    // whole-string similarity and the single best token-pair similarity — never a
    // blended/averaged composite. Admission is a SEPARATE gate (`admitFuzzy`): the
    // raw score must clear `minScore` AND the candidate must explain enough of the
    // query, so one strong token pair (e.g. `nonexistent` ~ a short `Noni` alias)
    // can't carry an otherwise-unrelated multi-token query. Transliteration
    // variants (their significant tokens each score high) and word-order swaps (all
    // tokens present) stay admitted; a high explicit `minScore` still suppresses
    // uniformly; single-token queries are unchanged (the floor alone governs).
    const scored: ScreeningHit[] = [];
    for (const row of rows) {
      const candidateTokens = tokenize(row.normalized);
      const tokenScore = bestTokenScore(args.queryTokens, candidateTokens);
      const wholeScore = jaroWinkler(args.normalizedQuery, row.normalized);
      // Coverage is computed for every candidate, not just the ones the token arm
      // gates: it is BOTH an admission input and the surfaced ranking key.
      const covered = tokenCoverage(args.queryTokens, candidateTokens, args.minScore);

      if (
        this.admitFuzzy(
          args.normalizedQuery,
          row.normalized,
          args.queryTokens.length,
          covered,
          wholeScore,
          tokenScore,
          args.minScore,
        )
      ) {
        const hit = this.rowToHit(row, 'approximate');
        hit.score = Number(Math.max(tokenScore, wholeScore).toFixed(4));
        hit.queryTokenCoverage = { covered, total: args.queryTokens.length };
        scored.push(hit);
      }
    }

    // Best alias per designation, then rank, cap. Two aliases of one designation
    // can tie on score, so coverage picks the one that explains the most of the
    // query — the surfaced matchedName/score/coverage then describe one alias.
    const byDesignation = new Map<string, ScreeningHit>();
    for (const hit of scored) {
      const existing = byDesignation.get(hit.designationId);
      if (!existing || compareFuzzyRank(hit, existing) < 0) {
        byDesignation.set(hit.designationId, hit);
      }
    }
    return [...byDesignation.values()]
      .sort((a, b) => compareFuzzyRank(a, b) || a.designationId.localeCompare(b.designationId))
      .slice(0, args.cap);
  }

  /**
   * Fuzzy admission gate, shared by {@link runFuzzy} and {@link rankFuzzy} so both
   * paths admit on one consistent rule. This is a SEPARATE predicate from the
   * surfaced score, which stays the raw Jaro-Winkler max of the whole-string and
   * best token-pair measurements (never a composite). A candidate is admitted when
   * it explains enough of the query, not merely one fragment of it — via either arm:
   *
   *  - WHOLE-STRING arm: the whole-string score clears `minScore` AND the two folded
   *    strings are of comparable length (ratio ≥ {@link WHOLE_STRING_MIN_LENGTH_RATIO}).
   *    This arm exists for matches token-pair scoring cannot see — spacing /
   *    concatenation variants ("van den berg" vs "vandenberg") and whole-name near-
   *    misses. The length guard is issue #8: Jaro-Winkler's shared-prefix boost
   *    inflates a short string that is a bare (near-)prefix of a much longer one
   *    (`jaroWinkler('nicolas maduroo moros', 'nicolas')` = 0.8667 ≥ the 0.85 floor
   *    at token coverage 1/3), so without the guard a short single-token alias clears
   *    admission against a long multi-token query on whole-string similarity alone.
   *    Real spacing/concatenation variants keep near-equal lengths (measured ratio ≥
   *    0.83 across the live mirror) — far above the prefix-inflation failures (≤ 0.375)
   *    — so the guard drops the false positive while preserving that recall. OR
   *
   *  - TOKEN-PAIR + coverage arm (issue #4): the best token pair clears `minScore` AND
   *    at least half the query tokens each individually clear it (`coveredTokens`) —
   *    so one strong token pair can't carry an otherwise-unrelated multi-token query.
   *
   * A candidate that fails the whole-string arm's length guard still admits through
   * the token arm when it genuinely covers the query. By construction the length
   * guard removes only whole-string-ONLY admissions where the two strings' lengths
   * diverge sharply, and the coverage arm only tightens queries of three or more
   * tokens (a one- or two-token query with a passing token score already has half-
   * or-more coverage, so the `minScore` floor alone governs, exactly as before).
   *
   * Every measurement arrives precomputed — the callers need `coveredTokens` for
   * ranking regardless (see {@link compareFuzzyRank}), so computing it once at the
   * call site keeps this a pure predicate over the candidate's measurements.
   */
  private admitFuzzy(
    normalizedQuery: string,
    candidateNormalized: string,
    queryTokenCount: number,
    coveredTokens: number,
    wholeScore: number,
    tokenScore: number,
    minScore: number,
  ): boolean {
    if (
      wholeScore >= minScore &&
      lengthRatio(normalizedQuery, candidateNormalized) >= WHOLE_STRING_MIN_LENGTH_RATIO
    ) {
      return true;
    }
    if (tokenScore < minScore) return false;
    return coveredTokens * 2 >= queryTokenCount;
  }

  private mergeHits(strict: ScreeningHit[], fuzzy: ScreeningHit[]): ScreeningHit[] {
    const seen = new Set(strict.map((h) => h.designationId));
    const out = [...strict];
    for (const hit of fuzzy) {
      if (!seen.has(hit.designationId)) {
        out.push(hit);
        seen.add(hit.designationId);
      }
    }
    return out;
  }

  private rowToHit(row: NameJoinRow, matchType: ScreeningHit['matchType']): ScreeningHit {
    return {
      designationId: row.designation_id,
      source: row.source as SourceCode,
      sourceEntryId: row.source_entry_id,
      entityType: row.entity_type as EntityType,
      primaryName: row.primary_name,
      matchedName: row.name,
      matchedNameType: row.name_type as NameRecord['nameType'],
      matchType,
      ...(row.program ? { program: row.program } : {}),
      ...(row.designation_date ? { designationDate: row.designation_date } : {}),
      ...(row.reference_number ? { referenceNumber: row.reference_number } : {}),
    };
  }

  // ─── Designation detail ────────────────────────────────────────────────────

  /** Full normalized designation by source + exact entry id, or null if absent. */
  async getDesignation(source: SourceCode, entryId: string): Promise<NormalizedDesignation | null> {
    const rows = await this.designationMirror.getByIds([`${source}:${entryId}`]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      source: String(row.source) as SourceCode,
      sourceEntryId: String(row.source_entry_id),
      entityType: String(row.entity_type) as EntityType,
      primaryName: String(row.primary_name),
      ...(row.program ? { program: String(row.program) } : {}),
      ...(row.legal_basis ? { legalBasis: String(row.legal_basis) } : {}),
      ...(row.designation_date ? { designationDate: String(row.designation_date) } : {}),
      ...(row.reference_number ? { referenceNumber: String(row.reference_number) } : {}),
      payload: JSON.parse(String(row.payload)) as DesignationPayload,
    };
  }

  /**
   * Resolve a caller's entry ID within one source: trimmed, and case-insensitive
   * on both sides, against `sourceEntryId` first and then the published
   * `referenceNumber`. No reference number equals another designation's entry ID
   * in its source, so the second pass never redirects an ID the first resolves; a
   * reference number more than one designation publishes (a UK Group ID covering
   * two regimes' designations of one person) resolves to all of them, and the
   * caller picks by entry ID.
   */
  async resolveDesignation(source: SourceCode, entryId: string): Promise<DesignationLookup> {
    const wanted = entryId.trim();
    if (!wanted) return { kind: 'not_found' };
    const handle = await this.designationHandle();

    // An exact-case match wins over a case-folded one, so an ID that resolves
    // today resolves to the same record.
    const byEntryId = handle
      .prepare<{ source_entry_id: string }>(
        `SELECT source_entry_id FROM designation
         WHERE source = ? AND source_entry_id = ? COLLATE NOCASE
         ORDER BY source_entry_id = ? DESC LIMIT 1`,
      )
      .get(source, wanted, wanted);
    // Sorted here rather than in SQL: an ORDER BY on the entry ID steers the
    // planner off the case-insensitive reference index onto a scan of the source.
    const matched = byEntryId
      ? [byEntryId.source_entry_id]
      : handle
          .prepare<{ source_entry_id: string }>(
            `SELECT source_entry_id FROM designation
             WHERE source = ? AND reference_number = ? COLLATE NOCASE`,
          )
          .all(source, wanted)
          .map((row) => row.source_entry_id)
          .sort();

    const [only, ...others] = matched;
    if (!only) return { kind: 'not_found' };
    if (others.length > 0) return { kind: 'ambiguous', sourceEntryIds: matched };
    const designation = await this.getDesignation(source, only);
    return designation ? { kind: 'found', designation } : { kind: 'not_found' };
  }

  // ─── Identifier lookup ─────────────────────────────────────────────────────

  /**
   * The designations that publish an identifier equal to `value` after
   * normalization — per category, as {@link identifierProbes} keys it — one hit
   * per designation carrying every stored identifier that matched, ordered by
   * source then entry ID. Joined to `designation`, so a designation a sync removed
   * never surfaces, even before the post-sync rebuild drops its identifier rows.
   */
  async screenIdentifier(opts: ScreenIdentifierOptions): Promise<IdentifierHit[]> {
    const probes = identifierProbes(opts.value, opts.type);
    if (probes.length === 0) return [];
    const handle = await this.designationHandle();
    const rows = handle
      .prepare<IdentifierJoinRow>(
        `SELECT i.designation_id, i.type, i.value, i.country,
                d.source, d.source_entry_id, d.entity_type, d.primary_name, d.program
         FROM ${IDENTIFIER_TABLE} i
         JOIN designation d ON d.id = i.designation_id
         WHERE (${probes.map(() => '(i.key = ? AND i.category = ?)').join(' OR ')})${this.sourceFilterClause(opts.sources)}
         ORDER BY i.rowid`,
      )
      .all(...probes.flatMap((probe) => [probe.key, probe.category]));

    const byDesignation = new Map<string, IdentifierHit>();
    for (const row of rows) {
      const matched: IdentifierRecord = {
        type: row.type,
        value: row.value,
        ...(row.country ? { country: row.country } : {}),
      };
      const hit = byDesignation.get(row.designation_id);
      if (hit) {
        hit.matchedIdentifiers.push(matched);
        continue;
      }
      byDesignation.set(row.designation_id, {
        source: row.source as SourceCode,
        sourceEntryId: row.source_entry_id,
        entityType: row.entity_type as EntityType,
        primaryName: row.primary_name,
        ...(row.program ? { program: row.program } : {}),
        matchedIdentifiers: [matched],
      });
    }
    return [...byDesignation.values()].sort(
      (a, b) =>
        SOURCE_CODES.indexOf(a.source) - SOURCE_CODES.indexOf(b.source) ||
        a.sourceEntryId.localeCompare(b.sourceEntryId, 'en', { numeric: true }),
    );
  }

  // ─── LEI resolution ──────────────────────────────────────────────────────

  /**
   * Resolve a company name to ranked GLEIF LEI candidates, one per LEI.
   *
   * On a mirror whose name index is built, every published name — legal, other,
   * and transliterated — takes part, and both passes are FTS lookups with the
   * jurisdiction resolved inside them. On a mirror an earlier release wrote, the
   * index does not exist yet: resolution runs over legal names as that release
   * did, under the same status and jurisdiction rules, and says so in
   * `alternateNamesIndexed`.
   *
   * The status predicate wraps the column in `UPPER()` on purpose. Non-sargable,
   * it cannot become the access path: ISSUED is 57% of the corpus, and the planner
   * choosing `lei_entity_status_idx` over the name lookup or the jurisdiction index
   * ran ~45× slower. Strict, fuzzy, and the strict→fuzzy fallback share it.
   */
  async resolveEntity(opts: ResolveEntityOptions, ctx: Context): Promise<ResolveEntityResult> {
    const normalizedQuery = fold(opts.query);
    const queryTokens = tokenize(normalizedQuery);
    const handle = await this.leiHandle();
    const offset = opts.offset ?? 0;
    const indexed = await this.leiNamesIndexed();

    const statusClause =
      opts.status === 'any'
        ? ''
        : ` AND UPPER(e.status) = '${opts.status === 'issued' ? 'ISSUED' : 'LAPSED'}'`;
    // The index path intersects the jurisdiction inside its FTS lookup; the
    // pre-index path filters the joined row, as it always has.
    const indexScope = {
      jurisdictionMatch: opts.jurisdiction ? jurisdictionMatch(opts.jurisdiction) : '',
      statusClause,
    };
    const legacyScope = {
      filterClause: `${opts.jurisdiction ? ` AND ${this.jurisdictionClause(opts.jurisdiction)}` : ''}${statusClause}`,
    };

    const strictScan = indexed
      ? this.runLeiStrict(handle, { normalizedQuery, queryTokens, ...indexScope })
      : this.runLegacyLeiStrict(handle, { normalizedQuery, ...legacyScope });
    const strict = strictScan.results;
    const wantFuzzy = opts.matchMode === 'fuzzy' || strict.length === 0;
    if (!wantFuzzy || queryTokens.length === 0) {
      return {
        alternateNamesIndexed: indexed,
        matches: strict.slice(offset, offset + opts.limit),
        modeUsed: 'strict',
        normalizedQuery,
        fuzzyFallbackTriggered: false,
        totalAvailable: strict.length,
        totalAvailableBasis: strictScan.capped ? 'lower_bound' : 'exact',
      };
    }

    const scoring = {
      normalizedQuery,
      queryTokens,
      minScore: opts.minScore ?? this.config.fuzzyMinScore,
      cap: this.config.fuzzyMaxResults,
    };
    const fuzzy = indexed
      ? this.runLeiFuzzy(handle, { ...scoring, ...indexScope })
      : this.runLegacyLeiFuzzy(handle, { ...scoring, ...legacyScope });
    const seen = new Set(strict.map((m) => m.lei));
    const merged = [...strict, ...fuzzy.filter((m) => !seen.has(m.lei))];
    ctx.log.debug('LEI resolution complete', {
      normalizedQuery,
      alternateNamesIndexed: indexed,
      strictCount: strict.length,
      fuzzyCount: fuzzy.length,
    });
    return {
      alternateNamesIndexed: indexed,
      matches: merged.slice(offset, offset + opts.limit),
      modeUsed: 'fuzzy',
      normalizedQuery,
      fuzzyFallbackTriggered: opts.matchMode === 'strict' && strict.length === 0,
      totalAvailable: merged.length,
      // Same bound as the screening path: the fuzzy candidate pool is blocked and
      // capped before the merge, so its count is a floor, never a corpus total.
      totalAvailableBasis: 'lower_bound',
    };
  }

  /**
   * Strict pass over the name index: every query token present in one name, the
   * jurisdiction intersected inside the same FTS lookup. An LEI several of whose
   * names match yields one candidate: its exact name if any, else its legal name,
   * else its first-written name — so matchedName and matchType describe one name.
   */
  private runLeiStrict(
    handle: SqliteHandle,
    args: {
      jurisdictionMatch: string;
      normalizedQuery: string;
      queryTokens: string[];
      statusClause: string;
    },
  ): BoundedScan<LeiMatch> {
    if (args.queryTokens.length === 0) return { results: [], capped: false };
    const match = [...args.queryTokens.map((t) => `normalized : "${t}"`), args.jurisdictionMatch]
      .filter(Boolean)
      .join(' AND ');
    const rows = handle
      .prepare<LeiNameRow>(
        `${LEI_NAME_SELECT}
         FROM ${LEI_NAME_FTS_TABLE} f
         JOIN ${LEI_NAME_TABLE} n ON n.rowid = f.rowid
         JOIN ${leiStoreSpec.table} e ON e.lei = n.lei
         WHERE ${LEI_NAME_FTS_TABLE} MATCH ?${args.statusClause}
         LIMIT ${LEI_STRICT_RAW_ROW_CAP}`,
      )
      .all(match);

    const byLei = new Map<string, { exact: boolean; row: LeiNameRow }>();
    for (const row of rows) {
      const exact = row.normalized === args.normalizedQuery;
      const held = byLei.get(row.lei);
      if (
        !held ||
        (exact && !held.exact) ||
        (exact === held.exact && compareNameRows(row, held.row) < 0)
      ) {
        byLei.set(row.lei, { exact, row });
      }
    }
    return {
      // LEI breaks same-band ties — the total order offset pagination requires.
      results: [...byLei.values()]
        .map(({ exact, row }) => leiMatch(row, exact ? 'exact' : 'strong', row))
        .sort(
          (a, b) => matchRank(b.matchType) - matchRank(a.matchType) || a.lei.localeCompare(b.lei),
        ),
      capped: rows.length >= LEI_STRICT_RAW_ROW_CAP,
    };
  }

  /**
   * Fuzzy pass over the name index. Each distinct query-token prefix is one FTS
   * prefix lookup against the names and the unsegmented-script suffix terms, with
   * the jurisdiction intersected inside it — so its cost follows the names that
   * match, not the table. The pooled LEIs' names are then read by LEI and scored.
   */
  private runLeiFuzzy(
    handle: SqliteHandle,
    args: LeiFuzzyArgs & { jurisdictionMatch: string; statusClause: string },
  ): LeiMatch[] {
    // Every query token blocks, one bounded lookup each: blocking on only the
    // first token starved the pool when it wasn't the entity's leading word
    // (order swaps) or was a common word that exhausted the cap.
    const block = handle.prepare<{ lei: string }>(
      `SELECT n.lei
       FROM ${LEI_NAME_FTS_TABLE} f
       JOIN ${LEI_NAME_TABLE} n ON n.rowid = f.rowid
       JOIN ${leiStoreSpec.table} e ON e.lei = n.lei
       WHERE ${LEI_NAME_FTS_TABLE} MATCH ?${args.statusClause}
       LIMIT ?`,
    );
    const within = args.jurisdictionMatch ? ` AND ${args.jurisdictionMatch}` : '';
    const pooled = new Set<string>();
    for (const prefix of blockingPrefixes(args.queryTokens)) {
      for (const { lei } of block.all(
        `{normalized suffix_terms} : "${prefix}"*${within}`,
        perStrategyLimit(args.cap),
      )) {
        pooled.add(lei);
      }
    }
    if (pooled.size === 0) return [];

    const rows = handle
      .prepare<LeiNameRow>(
        `${LEI_NAME_SELECT}
         FROM ${LEI_NAME_TABLE} n
         JOIN ${leiStoreSpec.table} e ON e.lei = n.lei
         WHERE n.lei IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify([...pooled]));
    const byLei = new Map<string, LeiNameRow[]>();
    for (const row of rows) {
      const names = byLei.get(row.lei);
      if (names) names.push(row);
      else byLei.set(row.lei, [row]);
    }
    return this.rankFuzzy(
      [...byLei.values()].map((names) => names.sort(compareNameRows)),
      args,
    );
  }

  /**
   * `(e.jurisdiction = 'US' OR e.jurisdiction GLOB 'US-*')` for a country, plain
   * equality for a subdivision — the pre-index path's predicate. Both forms stay
   * on `lei_entity_jurisdiction_idx`: `LIKE` would not (case-insensitive over a
   * BINARY column).
   */
  private jurisdictionClause(code: string): string {
    return COUNTRY_CODE.test(code)
      ? `(e.jurisdiction = '${code}' OR e.jurisdiction GLOB '${code}-*')`
      : `e.jurisdiction = '${this.escapeLiteral(code)}'`;
  }

  /** Strict pass of a mirror whose name index is not built: legal names only, as 0.3.0 ran it. */
  private runLegacyLeiStrict(
    handle: SqliteHandle,
    args: { filterClause: string; normalizedQuery: string },
  ): BoundedScan<LeiMatch> {
    const match = buildFtsMatch(args.normalizedQuery);
    if (!match) return { results: [], capped: false };
    const rows = handle
      .prepare<LeiCandidateRow>(
        `SELECT e.lei, e.legal_name, e.normalized_name, e.other_names, e.jurisdiction, e.status
         FROM ${leiStoreSpec.table}_fts f
         JOIN ${leiStoreSpec.table} e ON e.rowid = f.rowid
         WHERE ${leiStoreSpec.table}_fts MATCH ?${args.filterClause}
         LIMIT ${LEI_STRICT_RAW_ROW_CAP}`,
      )
      .all(match);
    return {
      results: rows
        .map((row) =>
          leiMatch(row, row.normalized_name === args.normalizedQuery ? 'exact' : 'strong', {
            name: row.legal_name,
            name_type: LEGAL_NAME_TYPE,
          }),
        )
        .sort(
          (a, b) => matchRank(b.matchType) - matchRank(a.matchType) || a.lei.localeCompare(b.lei),
        ),
      capped: rows.length >= LEI_STRICT_RAW_ROW_CAP,
    };
  }

  /**
   * Fuzzy pass of a mirror whose name index is not built, as 0.3.0 ran it: a
   * `LIKE '%prefix%'` scan of legal names per query token. Other names stored
   * with the record are scored for an entity the scan pools, but never pool one.
   */
  private runLegacyLeiFuzzy(
    handle: SqliteHandle,
    args: LeiFuzzyArgs & { filterClause: string },
  ): LeiMatch[] {
    const byLei = new Map<string, LeiCandidateRow>();
    for (const prefix of blockingPrefixes(args.queryTokens)) {
      const part = handle
        .prepare<LeiCandidateRow>(
          `SELECT e.lei, e.legal_name, e.normalized_name, e.other_names, e.jurisdiction, e.status
           FROM ${leiStoreSpec.table} e
           WHERE e.normalized_name LIKE ?${args.filterClause}
           LIMIT ?`,
        )
        .all(`%${prefix}%`, perStrategyLimit(args.cap));
      for (const r of part) if (!byLei.has(r.lei)) byLei.set(r.lei, r);
    }
    return this.rankFuzzy(
      [...byLei.values()].map((row) => [
        { ...row, name: row.legal_name, name_type: LEGAL_NAME_TYPE },
        ...(JSON.parse(row.other_names || '[]') as string[]).map((name) => ({
          ...row,
          name,
          name_type: UNKNOWN_NAME_TYPE,
        })),
      ]),
      args,
    );
  }

  /**
   * Score each pooled LEI's names — legal name first — and keep its best
   * admitted name, then rank and cap. The admission gate is runFuzzy's, applied
   * per name: a name is eligible only when it explains enough of the query (the
   * whole string clears the floor, or at least half the query tokens do), so one
   * strong token pair can't carry an unrelated multi-token query on a short name.
   * The surfaced score is the raw Jaro-Winkler max of that one name, and coverage
   * is the same name's, so matchedName / matchedNameType / score / coverage
   * describe one name. Ties on score go to higher coverage, then to the earlier name.
   */
  private rankFuzzy(candidates: LeiCandidateName[][], args: LeiFuzzyArgs): LeiMatch[] {
    const scored: LeiMatch[] = [];
    for (const names of candidates) {
      let best: { covered: number; name: (typeof names)[number]; score: number } | undefined;
      for (const name of names) {
        const folded = fold(name.name);
        const candidateTokens = tokenize(folded);
        const wholeScore = jaroWinkler(args.normalizedQuery, folded);
        const tokenScore = bestTokenScore(args.queryTokens, candidateTokens);
        const covered = tokenCoverage(args.queryTokens, candidateTokens, args.minScore);
        const admitted = this.admitFuzzy(
          args.normalizedQuery,
          folded,
          args.queryTokens.length,
          covered,
          wholeScore,
          tokenScore,
          args.minScore,
        );
        if (!admitted) continue;
        const score = Math.max(wholeScore, tokenScore);
        if (!best || score > best.score || (score === best.score && covered > best.covered)) {
          best = { name, score, covered };
        }
      }
      if (best) {
        scored.push({
          ...leiMatch(best.name, 'approximate', best.name),
          score: Number(best.score.toFixed(4)),
          queryTokenCoverage: { covered: best.covered, total: args.queryTokens.length },
        });
      }
    }
    return scored
      .sort((a, b) => compareFuzzyRank(a, b) || a.lei.localeCompare(b.lei))
      .slice(0, args.cap);
  }

  /** Full GLEIF Level 1 entity by LEI, or null — in one shape whichever release stored it. */
  async getLeiEntity(lei: string): Promise<LeiEntityRecord | null> {
    const rows = await this.leiMirror.getByIds([lei]);
    const row = rows[0];
    if (!row?.payload) return null;
    return readLeiPayload(String(row.payload));
  }

  /** Direct relationship edges for an LEI in the requested direction(s). */
  async getRelationships(
    lei: string,
    direction: 'parents' | 'children' | 'both',
  ): Promise<NormalizedLeiRelationship[]> {
    const handle = await this.leiHandle();
    const out: NormalizedLeiRelationship[] = [];
    const mapRel = (r: RelRow): NormalizedLeiRelationship => ({
      childLei: r.child_lei,
      parentLei: r.parent_lei,
      relationshipType: r.relationship_type,
      ...(r.relationship_status ? { relationshipStatus: r.relationship_status } : {}),
      ...(r.relationship_period ? { relationshipPeriod: r.relationship_period } : {}),
    });

    if (direction === 'parents' || direction === 'both') {
      out.push(
        ...handle
          .prepare<RelRow>(`SELECT * FROM ${LEI_RELATIONSHIP_TABLE} WHERE child_lei = ?`)
          .all(lei)
          .map(mapRel),
      );
    }
    if (direction === 'children' || direction === 'both') {
      out.push(
        ...handle
          .prepare<RelRow>(`SELECT * FROM ${LEI_RELATIONSHIP_TABLE} WHERE parent_lei = ?`)
          .all(lei)
          .map(mapRel),
      );
    }
    return out;
  }

  /** Hydrate multiple LEIs to name/jurisdiction/status, preserving order. */
  async getLeiEntitiesBatch(leis: string[]): Promise<LeiEntityRecord[]> {
    if (leis.length === 0) return [];
    const rows = await this.leiMirror.getByIds(leis);
    return rows.filter((r) => r.payload).map((r) => readLeiPayload(String(r.payload)));
  }

  // ─── Sources / freshness ───────────────────────────────────────────────────

  /** Per-source record counts in the sanctions mirror. */
  async sourceCounts(): Promise<SourceStatus[]> {
    const handle = await this.designationHandle();
    const rows = handle
      .prepare<{ source: string; n: number }>(
        `SELECT source, COUNT(*) AS n FROM designation GROUP BY source`,
      )
      .all();
    const bySource = new Map(rows.map((r) => [r.source, r.n]));
    return SOURCE_CODES.map((code) => ({ code, recordCount: bySource.get(code) ?? 0 }));
  }

  /** Sanctions mirror readiness + freshness. */
  async sanctionsReadiness(): Promise<MirrorReadiness> {
    return this.toReadiness(await this.designationMirror.status());
  }

  /**
   * GLEIF mirror readiness + freshness, the Level 1 / Level 2 / reporting-exception
   * row counts, and whether the exceptions are loaded — a count of an unloaded
   * dataset is not a count of zero exceptions.
   */
  async leiReadiness(): Promise<
    MirrorReadiness & {
      entityCount: number;
      exceptionCount: number;
      exceptionsLoaded: boolean;
      relationshipCount: number;
    }
  > {
    const status = this.toReadiness(await this.leiMirror.status());
    const handle = await this.leiHandle();
    const count = (table: string) =>
      handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
    const state = await this.leiMirror.store.readState();
    const stateKey = `${state.completedAt ?? ''}|${state.checkpoint ?? ''}`;
    if (this.exceptionCountByState?.state !== stateKey) {
      this.exceptionCountByState = { state: stateKey, count: count(LEI_EXCEPTION_TABLE) };
    }
    return {
      ...status,
      entityCount: count(leiStoreSpec.table),
      relationshipCount: count(LEI_RELATIONSHIP_TABLE),
      exceptionCount: this.exceptionCountByState.count,
      exceptionsLoaded: parseGleifCheckpoint(state.checkpoint).repex !== undefined,
    };
  }

  private toReadiness(s: {
    ready: boolean;
    total?: number | undefined;
    completedAt?: string | undefined;
    status: string;
    error?: string | undefined;
  }): MirrorReadiness {
    return {
      ready: s.ready,
      total: s.total ?? 0,
      status: s.status,
      ...(s.completedAt ? { completedAt: s.completedAt } : {}),
      ...(s.error ? { error: s.error } : {}),
    };
  }

  private escapeLiteral(value: string): string {
    return value.replace(/'/g, "''");
  }

  /** Close both mirrors (lifecycle scripts / shutdown). */
  async close(): Promise<void> {
    await Promise.allSettled([this.designationMirror.close(), this.leiMirror.close()]);
  }
}

/**
 * The distinct leading-trigram blocking prefixes of a query's tokens, shared by
 * both fuzzy paths. Counted in code points, not UTF-16 code units: a code-unit
 * slice cuts a supplementary-plane letter (CJK Extension B, e.g. `𠀀`) in half,
 * and the lone surrogate reaches SQLite as U+FFFD, a `LIKE` pattern or FTS prefix
 * term that matches nothing. A token shorter than two code points blocks nothing. For BMP tokens
 * code points and code units coincide, so their prefixes are unchanged.
 */
function blockingPrefixes(tokens: readonly string[]): string[] {
  const prefixes = tokens
    .map((token) => [...token].slice(0, 3))
    .filter((codePoints) => codePoints.length >= 2)
    .map((codePoints) => codePoints.join(''));
  return [...new Set(prefixes)];
}

/**
 * Rows each fuzzy blocking lookup may pool: the per-strategy budget keeps total
 * work bounded while every query token contributes; the scored set is still
 * capped to `cap` afterwards.
 */
function perStrategyLimit(cap: number): number {
  return Math.max(cap * 4, 200);
}

// ─── GLEIF name index ────────────────────────────────────────────────────────

/** The inputs of a fuzzy LEI pass that scoring needs. */
interface LeiFuzzyArgs {
  cap: number;
  minScore: number;
  normalizedQuery: string;
  queryTokens: string[];
}

/** One candidate name with the entity fields a match reports. */
interface LeiCandidateName {
  jurisdiction: string | null;
  legal_name: string;
  lei: string;
  name: string;
  name_type: string;
  status: string | null;
}

/** The columns every indexed resolution query reads: a name row and its entity. */
const LEI_NAME_SELECT = `SELECT n.rowid AS rowid, n.lei, n.name, n.normalized, n.name_type,
                e.legal_name, e.jurisdiction, e.status`;

/** A two-letter country code, as opposed to an ISO 3166-2 subdivision code. */
const COUNTRY_CODE = /^[A-Z]{2}$/;

/**
 * A token in a script written without word separators: its fold is one token
 * however many words it holds, so it is also indexed by its suffixes.
 */
const UNSEGMENTED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Build a {@link LeiMatch} from an entity row and the one name it matched on. */
function leiMatch(
  entity: { jurisdiction: string | null; legal_name: string; lei: string; status: string | null },
  matchType: LeiMatch['matchType'],
  matched: { name: string; name_type: string },
): LeiMatch {
  return {
    lei: entity.lei,
    legalName: entity.legal_name,
    matchedName: matched.name,
    matchedNameType: matched.name_type,
    matchType,
    ...(entity.jurisdiction ? { jurisdiction: entity.jurisdiction } : {}),
    ...(entity.status ? { status: entity.status } : {}),
  };
}

/** Order an entity's name rows: the legal name first, then the order they were written. */
function compareNameRows(a: LeiNameRow, b: LeiNameRow): number {
  return (
    Number(a.name_type !== LEGAL_NAME_TYPE) - Number(b.name_type !== LEGAL_NAME_TYPE) ||
    a.rowid - b.rowid
  );
}

/**
 * The FTS clause matching a jurisdiction filter against `jurisdiction_terms`
 * (see {@link jurisdictionTerms}): a country matches its `jc` term, which every
 * subdivision under it carries too; a subdivision matches its own `jx` term.
 */
function jurisdictionMatch(code: string): string {
  const term = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `jurisdiction_terms : "${COUNTRY_CODE.test(code) ? 'jc' : 'jx'}${term}"`;
}

/**
 * The index terms of a legal jurisdiction: `jc<country>` and `jx<code>`, each one
 * whole unicode61 token. `US-CA` → `jcus jxusca`; `US` → `jcus jxus`. A country
 * code is two letters and a subdivision code longer, so no two codes share a `jx`
 * term, and `CA` never reaches `US-CA`.
 */
function jurisdictionTerms(code: string | undefined): string {
  if (!code) return '';
  const upper = code.toUpperCase();
  const country = upper.split('-')[0] ?? '';
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `jc${clean(country)} jx${clean(upper)}`;
}

/**
 * Every proper suffix of two or more code points of each unsegmented-script
 * token in a folded name, space-separated — so a prefix lookup for `國際證`
 * reaches `交銀國際證券有限公司`. Empty for a name with no such token.
 */
function suffixTerms(normalized: string): string {
  const terms: string[] = [];
  for (const token of tokenize(normalized)) {
    if (!UNSEGMENTED_SCRIPT.test(token)) continue;
    const codePoints = [...token];
    for (let i = 1; i <= codePoints.length - 2; i++) terms.push(codePoints.slice(i).join(''));
  }
  return terms.join(' ');
}

/**
 * An entity's alternate names with their types. A record stored before names
 * were typed carries bare `otherNames` only; each reads as type unknown.
 */
function alternateNamesOf(entity: NormalizedLeiEntity): LeiAlternateName[] {
  return (
    entity.alternateNames ?? entity.otherNames.map((name) => ({ name, type: UNKNOWN_NAME_TYPE }))
  );
}

/**
 * Index an entity's legal name, then each alternate name, one row per distinct
 * fold — a name that folds to the legal name's (or an earlier one's) adds
 * nothing to retrieval, and the earlier row reports it. A name that folds to
 * nothing is skipped.
 */
function writeLeiNames(insert: SqliteStatement, entity: NormalizedLeiEntity): void {
  const jurisdiction = jurisdictionTerms(entity.jurisdiction);
  const seen = new Set<string>();
  for (const { name, type } of [
    { name: entity.legalName, type: LEGAL_NAME_TYPE },
    ...alternateNamesOf(entity),
  ]) {
    const normalized = fold(name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    insert.run(entity.lei, name, normalized, type, suffixTerms(normalized), jurisdiction);
  }
}

/** A stored entity payload in the current shape, whichever release wrote it. */
function readLeiPayload(payload: string): LeiEntityRecord {
  const entity = JSON.parse(payload) as NormalizedLeiEntity;
  return { ...entity, alternateNames: alternateNamesOf(entity) };
}

/** What the name-index stamp is compared against: the GLEIF sync state's `completedAt`. */
function leiStateStamp(state: SyncState): string {
  return state.completedAt ?? '';
}

/** The state the name index was last recorded complete under, or undefined when it never was. */
function leiNameStamp(handle: SqliteHandle): string | undefined {
  return handle
    .prepare<{ stamp: string }>(`SELECT stamp FROM ${LEI_NAME_STAMP_TABLE} WHERE id = 1`)
    .get()?.stamp;
}

function writeLeiNameStamp(handle: SqliteHandle, stamp: string): void {
  handle
    .prepare(`INSERT OR REPLACE INTO ${LEI_NAME_STAMP_TABLE} (id, stamp) VALUES (1, ?)`)
    .run(stamp);
}

/** A designation row as the index rebuilds read it. */
interface DesignationPayloadRow {
  id: string;
  payload: string;
  primary_name: string;
}

/**
 * Visit every stored designation with its parsed payload, in keyset slices of
 * {@link DESIGNATION_READ_SLICE} ordered by id, so only one slice of payloads is
 * resident at a time. Synchronous; the caller owns the transaction.
 */
function walkDesignations(
  handle: SqliteHandle,
  visit: (row: DesignationPayloadRow, payload: DesignationPayload) => void,
): void {
  const slice = handle.prepare<DesignationPayloadRow>(
    `SELECT id, primary_name, payload FROM designation
     WHERE id > ? ORDER BY id LIMIT ${DESIGNATION_READ_SLICE}`,
  );
  let cursor = '';
  for (;;) {
    const rows = slice.all(cursor);
    if (rows.length === 0) return;
    for (const row of rows) visit(row, JSON.parse(row.payload) as DesignationPayload);
    cursor = rows[rows.length - 1]?.id ?? cursor;
  }
}

function prepareNameInsert(handle: SqliteHandle): SqliteStatement {
  return handle.prepare(
    `INSERT INTO ${NAME_TABLE} (designation_id, name, normalized, phonetic, name_type)
     VALUES (?, ?, ?, ?, ?)`,
  );
}

function prepareIdentifierInsert(handle: SqliteHandle): SqliteStatement {
  return handle.prepare(
    `INSERT INTO ${IDENTIFIER_TABLE} (designation_id, category, key, type, value, country)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
}

/** Index a designation's primary name and aliases, primary first; a name that folds to nothing is skipped. */
function writeNames(
  insert: SqliteStatement,
  designationId: string,
  primaryName: string,
  aliases: readonly NameRecord[],
): void {
  for (const rec of [{ name: primaryName, nameType: 'primary' as const }, ...aliases]) {
    const normalized = fold(rec.name);
    if (!normalized) continue;
    insert.run(designationId, rec.name, normalized, doubleMetaphone(normalized), rec.nameType);
  }
}

/** Index a designation's identifiers under their categories' keys; one that normalizes to nothing is skipped. */
function writeIdentifiers(
  insert: SqliteStatement,
  designationId: string,
  identifiers: readonly IdentifierRecord[],
): void {
  for (const identifier of identifiers) {
    const category = identifierCategory(identifier.type);
    const key = identifierKey(category, identifier.value);
    if (!key) continue;
    insert.run(
      designationId,
      category,
      key,
      identifier.type,
      identifier.value,
      identifier.country ?? null,
    );
  }
}

/**
 * The stamp of the sync run a mirror's designation data came from: every run
 * records a fresh `startedAt`, and a seeded or completed one a fresh
 * `completedAt`, whichever release wrote it.
 */
function syncStamp(state: SyncState): string {
  return `${state.startedAt ?? ''}|${state.completedAt ?? ''}`;
}

/** The stamp the identifier index was last built under, or undefined when it never was. */
function identifierStamp(handle: SqliteHandle): string | undefined {
  return handle
    .prepare<{ stamp: string }>(`SELECT stamp FROM ${IDENTIFIER_STAMP_TABLE} WHERE id = 1`)
    .get()?.stamp;
}

function writeIdentifierStamp(handle: SqliteHandle, stamp: string): void {
  handle
    .prepare(`INSERT OR REPLACE INTO ${IDENTIFIER_STAMP_TABLE} (id, stamp) VALUES (1, ?)`)
    .run(stamp);
}

/** Rebuild the identifier index alone from the stored payloads. The caller owns the transaction. */
function rebuildIdentifierIndex(handle: SqliteHandle, stamp: string): void {
  handle.exec(`DELETE FROM ${IDENTIFIER_TABLE}`);
  const insert = prepareIdentifierInsert(handle);
  walkDesignations(handle, (row, payload) => writeIdentifiers(insert, row.id, payload.identifiers));
  writeIdentifierStamp(handle, stamp);
}

/**
 * True when the identifier index holds nothing although a stored designation
 * publishes an identifier — a mirror written before the index existed, or one
 * whose index was never built.
 */
function identifierIndexUnbuilt(handle: SqliteHandle): boolean {
  if (handle.prepare(`SELECT 1 FROM ${IDENTIFIER_TABLE} LIMIT 1`).get()) return false;
  return (
    handle
      .prepare(
        `SELECT 1 FROM designation WHERE json_array_length(payload, '$.identifiers') > 0 LIMIT 1`,
      )
      .get() !== undefined
  );
}

/** Rank for sorting match types (exact > strong > approximate). */
function matchRank(type: ScreeningHit['matchType']): number {
  return type === 'exact' ? 3 : type === 'strong' ? 2 : 1;
}

/**
 * Rank two admitted fuzzy candidates: raw score descending, then query-token
 * coverage descending. Shared by {@link ScreeningService.runFuzzy} and
 * {@link ScreeningService.rankFuzzy} so both surfaces order by the same rule.
 *
 * The score stays the primary key AND keeps its raw Jaro-Winkler value — coverage
 * is a separate real measurement that orders candidates, never a term blended into
 * the score. It earns the second key because `score` is a max over a whole-string
 * and a single best token-pair comparison, so every candidate sharing one exact
 * query token reports 1.0 regardless of how much of the rest of the query it
 * explains; without a second key those ties fall through to an identity key that
 * carries no quality signal at all.
 *
 * Callers append that identity key (designation id / LEI) as the terminal
 * tie-break, which is what makes the order total — the precondition offset
 * pagination depends on.
 */
function compareFuzzyRank(
  a: { queryTokenCoverage?: QueryTokenCoverage; score?: number },
  b: { queryTokenCoverage?: QueryTokenCoverage; score?: number },
): number {
  return (
    (b.score ?? 0) - (a.score ?? 0) ||
    (b.queryTokenCoverage?.covered ?? 0) - (a.queryTokenCoverage?.covered ?? 0)
  );
}

/**
 * Derive the GLEIF mirror's database path from the configured sanctions path by
 * inserting `.gleif` before the extension (`./data/sanctions.db` →
 * `./data/sanctions.gleif.db`). Keeps the two mirrors' sync-state independent.
 */
function gleifPath(sanctionsPath: string): string {
  const dot = sanctionsPath.lastIndexOf('.');
  const slash = Math.max(sanctionsPath.lastIndexOf('/'), sanctionsPath.lastIndexOf('\\'));
  return dot > slash
    ? `${sanctionsPath.slice(0, dot)}.gleif${sanctionsPath.slice(dot)}`
    : `${sanctionsPath}.gleif`;
}

/**
 * Read the GLEIF checkpoint the sync state stores as JSON (see {@link GleifCheckpoint}).
 * A mirror written before the checkpoint existed stores none, which reads as no
 * recorded load for any dataset — never as a guessed date.
 */
function parseGleifCheckpoint(stored: string | undefined): GleifCheckpoint {
  if (!stored) return {};
  const parsed = JSON.parse(stored) as Record<string, unknown>;
  const checkpoint: GleifCheckpoint = {};
  for (const dataset of ['lei2', 'rr', 'repex'] as const) {
    const value = parsed[dataset];
    if (typeof value === 'string') checkpoint[dataset] = value;
  }
  return checkpoint;
}

/**
 * A {@link SyncGenerator} that yields no pages — the GLEIF mirror's sync. GLEIF
 * data is ingested through the service's ingest methods, driven by the load and
 * refresh lifecycles in `gleif-sync.ts`, not through `runSync`.
 */
async function* emptySync(): AsyncGenerator<SyncPage> {
  yield* [];
}

// ─── Init / accessor ─────────────────────────────────────────────────────────

let _service: ScreeningService | undefined;

/** Initialize the screening service. Call from `createApp()` `setup()`. */
export function initScreeningService(_config?: AppConfig, _storage?: StorageService): void {
  _service = new ScreeningService(getServerConfig());
}

/** Access the screening service; throws if not initialized. */
export function getScreeningService(): ScreeningService {
  if (!_service) {
    throw new Error('ScreeningService not initialized — call initScreeningService() in setup()');
  }
  return _service;
}

/** Build a standalone instance (lifecycle scripts run outside createApp). */
export function buildScreeningService(): ScreeningService {
  return new ScreeningService(getServerConfig());
}

/** Reset — test isolation only. */
export function resetScreeningService(): void {
  _service = undefined;
}

/** Re-export ingester type for the sync wiring. */
export type { SanctionsIngester };

/** The framework logger, re-exported for lifecycle scripts. */
export { logger };
