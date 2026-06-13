/**
 * @fileoverview The screening service — owns the two local mirrors (sanctions
 * `designation` + GLEIF `lei_entity`, both SQLite + FTS5 via the framework
 * MirrorService), the normalized-schema write path that keeps the per-alias
 * `name` index and `lei_relationship` table in lockstep, and the matching
 * engine (exact → strict-token → scored Jaro-Winkler / phonetic fuzzy). All six
 * tools compose against this service; the agent never sees the source boundary.
 *
 * The matching engine surfaces only real signal: exact/strong hits are
 * deterministic and unscored; approximate hits carry the raw Jaro-Winkler
 * similarity (0–1). There is no fabricated composite "confidence".
 * @module services/screening/screening-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { Mirror, SqliteHandle, SyncPage } from '@cyanheads/mcp-ts-core/mirror';
import { defineMirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import {
  createSanctionsSync,
  type SanctionsIngester,
} from '@/services/screening/sanctions-ingest.js';
import {
  designationStoreSpec,
  ensureDesignationAuxSchema,
  ensureLeiAuxSchema,
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
  tokenize,
} from '@/services/screening/text-matching.js';
import type {
  DesignationPayload,
  EntityType,
  LeiMatch,
  MatchMode,
  NameRecord,
  NormalizedDesignation,
  NormalizedLeiEntity,
  NormalizedLeiRelationship,
  ScreeningHit,
  SourceCode,
} from '@/services/screening/types.js';
import { SOURCE_CODES } from '@/services/screening/types.js';

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
}

/** Options for {@link ScreeningService.resolveEntity}. */
export interface ResolveEntityOptions {
  jurisdiction?: string;
  limit: number;
  matchMode: MatchMode;
  minScore?: number;
  query: string;
  status: 'any' | 'issued' | 'lapsed';
}

/** Result of an LEI resolution pass. */
export interface ResolveEntityResult {
  fuzzyFallbackTriggered: boolean;
  matches: LeiMatch[];
  modeUsed: MatchMode;
  normalizedQuery: string;
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
  source: string;
  source_entry_id: string;
}

/** Raw row from the `lei_relationship` table. */
interface RelRow {
  child_lei: string;
  parent_lei: string;
  relationship_period: string | null;
  relationship_status: string | null;
  relationship_type: string;
}

/** Internal LEI candidate row used during resolution. */
interface LeiCandidateRow {
  jurisdiction: string | null;
  legal_name: string;
  lei: string;
  normalized_name: string;
  other_names: string;
  status: string | null;
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
      sync: createSanctionsSync(),
    });

    this.leiMirror = defineMirror({
      name: 'gleif-entities',
      store: sqliteMirrorStore({ path: gleifPath(config.mirrorPath), ...leiStoreSpec }),
      // GLEIF ingest is driven directly via ingestLeiEntities/ingestLeiRelationships
      // (golden-copy init + delta refresh), so the mirror's own sync yields no
      // pages — the lifecycle scripts call the ingest methods.
      sync: emptySync,
    });
  }

  /**
   * Open the designation mirror's raw handle, ensuring the auxiliary `name` index
   * + FTS exist first. The framework's migration runner skips migrations on a
   * fresh DB, so the aux DDL is applied here (idempotently) on first use.
   */
  private async designationHandle(): Promise<SqliteHandle> {
    const raw = await this.designationMirror.raw();
    if (!this.designationAuxReady) {
      ensureDesignationAuxSchema(raw);
      this.designationAuxReady = true;
    }
    return raw;
  }

  /** Open the GLEIF mirror's raw handle, ensuring `lei_relationship` exists first. */
  private async leiHandle(): Promise<SqliteHandle> {
    const raw = await this.leiMirror.raw();
    if (!this.leiAuxReady) {
      ensureLeiAuxSchema(raw);
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
   * rows via the mirror store, then refreshes the per-alias `name` index for
   * exactly those designations — all in one transaction. Idempotent per id.
   */
  async ingestDesignations(designations: NormalizedDesignation[]): Promise<void> {
    if (designations.length === 0) return;
    const handle = await this.designationHandle();

    handle.transaction(() => {
      const upsert = handle.prepare(
        `INSERT INTO designation
           (id, source, source_entry_id, entity_type, primary_name, normalized_name,
            program, legal_basis, designation_date, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source=excluded.source, source_entry_id=excluded.source_entry_id,
           entity_type=excluded.entity_type, primary_name=excluded.primary_name,
           normalized_name=excluded.normalized_name, program=excluded.program,
           legal_basis=excluded.legal_basis, designation_date=excluded.designation_date,
           payload=excluded.payload`,
      );
      const deleteNames = handle.prepare(`DELETE FROM ${NAME_TABLE} WHERE designation_id = ?`);
      const insertName = handle.prepare(
        `INSERT INTO ${NAME_TABLE} (designation_id, name, normalized, phonetic, name_type)
         VALUES (?, ?, ?, ?, ?)`,
      );

      for (const d of designations) {
        const normalizedPrimary = fold(d.primaryName);
        upsert.run(
          d.id,
          d.source,
          d.sourceEntryId,
          d.entityType,
          d.primaryName,
          normalizedPrimary,
          d.program ?? null,
          d.legalBasis ?? null,
          d.designationDate ?? null,
          JSON.stringify(d.payload),
        );

        deleteNames.run(d.id);
        for (const rec of this.allNames(d)) {
          const normalized = fold(rec.name);
          if (!normalized) continue;
          insertName.run(d.id, rec.name, normalized, doubleMetaphone(normalized), rec.nameType);
        }
      }
    });
  }

  /**
   * Rebuild the per-alias `name` index from the current `designation` table.
   * The MirrorService `sync` path only writes the primary `designation` rows, so
   * after a `runSync` the lifecycle scripts (and the refresh cron) call this to
   * regenerate the matching index — including the Double-Metaphone phonetic keys
   * that can't be computed in SQL. Idempotent: clears and repopulates `name`.
   */
  async rebuildNameIndex(): Promise<void> {
    const handle = await this.designationHandle();
    const rows = handle
      .prepare<{ id: string; primary_name: string; payload: string }>(
        `SELECT id, primary_name, payload FROM designation`,
      )
      .all();

    handle.transaction(() => {
      handle.exec(`DELETE FROM ${NAME_TABLE}`);
      const insertName = handle.prepare(
        `INSERT INTO ${NAME_TABLE} (designation_id, name, normalized, phonetic, name_type)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as DesignationPayload;
        const names: NameRecord[] = [
          { name: row.primary_name, nameType: 'primary' },
          ...payload.aliases,
        ];
        for (const rec of names) {
          const normalized = fold(rec.name);
          if (!normalized) continue;
          insertName.run(row.id, rec.name, normalized, doubleMetaphone(normalized), rec.nameType);
        }
      }
    });
  }

  /** Apply a batch of GLEIF Level 1 entity records via the LEI mirror store. */
  async ingestLeiEntities(entities: NormalizedLeiEntity[]): Promise<void> {
    if (entities.length === 0) return;
    await this.leiMirror.store.applyBatch(
      entities.map((e) => ({
        lei: e.lei,
        legal_name: e.legalName,
        normalized_name: fold(e.legalName),
        other_names: JSON.stringify(e.otherNames),
        jurisdiction: e.jurisdiction ?? null,
        status: e.status ?? null,
        legal_address: e.legalAddress ?? null,
        headquarters_address: e.headquartersAddress ?? null,
        registration_authority_id: e.registrationAuthorityId ?? null,
        registration_authority_entity_id: e.registrationAuthorityEntityId ?? null,
        last_update: e.lastUpdate ?? null,
        payload: JSON.stringify(e),
      })),
      [],
    );
  }

  /**
   * Apply a batch of GLEIF Level 2 relationships. Replaces all rows for each
   * child LEI present in the batch (so a refresh that re-states a child's
   * relationships is idempotent).
   */
  async ingestLeiRelationships(relationships: NormalizedLeiRelationship[]): Promise<void> {
    if (relationships.length === 0) return;
    const handle = await this.leiHandle();
    const children = [...new Set(relationships.map((r) => r.childLei))];

    handle.transaction(() => {
      const clear = handle.prepare(`DELETE FROM ${LEI_RELATIONSHIP_TABLE} WHERE child_lei = ?`);
      for (const child of children) clear.run(child);
      const insert = handle.prepare(
        `INSERT OR REPLACE INTO ${LEI_RELATIONSHIP_TABLE}
           (child_lei, parent_lei, relationship_type, relationship_status, relationship_period)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const r of relationships) {
        insert.run(
          r.childLei,
          r.parentLei,
          r.relationshipType,
          r.relationshipStatus ?? null,
          r.relationshipPeriod ?? null,
        );
      }
    });
  }

  /** Primary name + aliases as one list, primary first. */
  private allNames(d: NormalizedDesignation): NameRecord[] {
    return [{ name: d.primaryName, nameType: 'primary' as const }, ...d.payload.aliases];
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

  /** Mark the GLEIF mirror's sync state complete — see {@link markSanctionsReady}. */
  async markLeiReady(total: number): Promise<void> {
    await this.leiMirror.store.writeState({
      status: 'complete',
      completedAt: new Date().toISOString(),
      total,
    });
  }

  /**
   * Load a synthetic fixture into both mirrors and mark them ready. For tests and
   * a quick local smoke run — NOT the real corpus, which loads via `mirror:init`.
   */
  async seedFixtures(fixtures: {
    designations: NormalizedDesignation[];
    leiEntities: NormalizedLeiEntity[];
    leiRelationships: NormalizedLeiRelationship[];
  }): Promise<void> {
    await this.ingestDesignations(fixtures.designations);
    await this.ingestLeiEntities(fixtures.leiEntities);
    await this.ingestLeiRelationships(fixtures.leiRelationships);
    await this.markSanctionsReady(fixtures.designations.length);
    await this.markLeiReady(fixtures.leiEntities.length);
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

    const sourceFilter = this.sourceFilterClause(opts.sources);
    // entityType is enum-constrained at the tool boundary; escape at the SQL sink
    // anyway so the service stays injection-safe for any future caller that
    // reaches it without re-validating (matches the jurisdiction handling below).
    const typeFilter =
      opts.entityType === 'any'
        ? ''
        : ` AND d.entity_type = '${this.escapeLiteral(opts.entityType)}'`;

    // Step 1+2: exact-normalized, then strict all-tokens-present (FTS5 AND).
    const strictHits = this.runStrict(handle, {
      normalizedQuery,
      queryTokens,
      sourceFilter,
      typeFilter,
      limit: opts.limit,
    });

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
        hits: strictHits.slice(0, opts.limit),
        modeUsed: 'strict',
        normalizedQuery,
        fuzzyFallbackTriggered: false,
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
      hits: merged.slice(0, opts.limit),
      modeUsed: 'fuzzy',
      normalizedQuery,
      fuzzyFallbackTriggered: opts.matchMode === 'strict' && strictHits.length === 0,
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
      queryTokens: string[];
      sourceFilter: string;
      typeFilter: string;
      limit: number;
    },
  ): ScreeningHit[] {
    const match = buildFtsMatch(args.normalizedQuery);
    if (!match) return [];

    // FTS over the name index; join back to name + designation. Classify each
    // matched name as exact (normalized equality) or strong (all tokens present).
    const rows = handle
      .prepare<NameJoinRow>(
        `SELECT n.designation_id, n.name, n.normalized, n.phonetic, n.name_type,
                d.source, d.source_entry_id, d.entity_type, d.primary_name,
                d.program, d.designation_date
         FROM ${NAME_FTS_TABLE} f
         JOIN ${NAME_TABLE} n ON n.rowid = f.rowid
         JOIN designation d ON d.id = n.designation_id
         WHERE ${NAME_FTS_TABLE} MATCH ?${args.sourceFilter}${args.typeFilter}
         LIMIT 5000`,
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
    // Exact hits first, then strong; stable within each band.
    return [...byDesignation.values()].sort(
      (a, b) => matchRank(b.matchType) - matchRank(a.matchType),
    );
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
    //  (a) phonetic-key equality — catches transliteration-class variants whose
    //      Jaro-Winkler similarity is below the floor (e.g. Mohammed/Muhammad).
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
                d.primary_name, d.program, d.designation_date
         FROM ${NAME_TABLE} n
         JOIN designation d ON d.id = n.designation_id`;
    const prefixes = [
      ...new Set(args.queryTokens.map((t) => t.slice(0, 3)).filter((p) => p.length >= 2)),
    ];
    // Per-strategy budget keeps total work bounded while guaranteeing fair
    // representation; the final scored set is still capped to `args.cap`.
    const perStrategyLimit = Math.max(args.cap * 4, 200);
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
          .all(...phoneticKeys, perStrategyLimit),
      );
    }
    for (const prefix of prefixes) {
      collect(
        handle
          .prepare<NameJoinRow & { rowid: number }>(
            `${select} WHERE n.normalized LIKE ?${args.sourceFilter}${args.typeFilter} LIMIT ?`,
          )
          .all(`%${prefix}%`, perStrategyLimit),
      );
    }
    if (byRowid.size === 0) return [];
    const rows = [...byRowid.values()];

    const phoneticSet = new Set(phoneticKeys);
    const scored: ScreeningHit[] = [];
    for (const row of rows) {
      const candidateTokens = tokenize(row.normalized);
      const tokenScore = bestTokenScore(args.queryTokens, candidateTokens);
      const wholeScore = jaroWinkler(args.normalizedQuery, row.normalized);
      const score = Math.max(tokenScore, wholeScore);
      const phoneticHit = row.phonetic.split(/\s+/).some((k) => k && phoneticSet.has(k));

      if (score >= args.minScore || phoneticHit) {
        const hit = this.rowToHit(row, 'approximate');
        hit.score = Number(score.toFixed(4));
        scored.push(hit);
      }
    }

    // Best score per designation, then sort by score desc, cap.
    const byDesignation = new Map<string, ScreeningHit>();
    for (const hit of scored) {
      const existing = byDesignation.get(hit.designationId);
      if (!existing || (hit.score ?? 0) > (existing.score ?? 0)) {
        byDesignation.set(hit.designationId, hit);
      }
    }
    return [...byDesignation.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, args.cap);
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
    };
  }

  // ─── Designation detail ────────────────────────────────────────────────────

  /** Full normalized designation by source + entry id, or null if absent. */
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
      payload: JSON.parse(String(row.payload)) as DesignationPayload,
    };
  }

  // ─── LEI resolution ──────────────────────────────────────────────────────

  /** Resolve a company name to ranked GLEIF LEI candidates. */
  async resolveEntity(opts: ResolveEntityOptions, ctx: Context): Promise<ResolveEntityResult> {
    const normalizedQuery = fold(opts.query);
    const queryTokens = tokenize(normalizedQuery);
    const handle = await this.leiHandle();

    const filters: string[] = [];
    if (opts.jurisdiction)
      filters.push(`e.jurisdiction = '${this.escapeLiteral(opts.jurisdiction)}'`);
    if (opts.status === 'issued') filters.push(`UPPER(e.status) = 'ISSUED'`);
    else if (opts.status === 'lapsed') filters.push(`UPPER(e.status) != 'ISSUED'`);
    const filterClause = filters.length ? ` AND ${filters.join(' AND ')}` : '';

    const strict = this.runLeiStrict(handle, { normalizedQuery, filterClause, limit: opts.limit });
    const wantFuzzy = opts.matchMode === 'fuzzy' || strict.length === 0;
    if (!wantFuzzy || queryTokens.length === 0) {
      return {
        matches: strict.slice(0, opts.limit),
        modeUsed: 'strict',
        normalizedQuery,
        fuzzyFallbackTriggered: false,
      };
    }

    const minScore = opts.minScore ?? this.config.fuzzyMinScore;
    const fuzzy = this.runLeiFuzzy(handle, {
      normalizedQuery,
      queryTokens,
      filterClause,
      minScore,
      cap: this.config.fuzzyMaxResults,
    });
    const seen = new Set(strict.map((m) => m.lei));
    const merged = [...strict, ...fuzzy.filter((m) => !seen.has(m.lei))];
    ctx.log.debug('LEI resolution complete', {
      normalizedQuery,
      strictCount: strict.length,
      fuzzyCount: fuzzy.length,
    });
    return {
      matches: merged.slice(0, opts.limit),
      modeUsed: 'fuzzy',
      normalizedQuery,
      fuzzyFallbackTriggered: opts.matchMode === 'strict' && strict.length === 0,
    };
  }

  private runLeiStrict(
    handle: SqliteHandle,
    args: { normalizedQuery: string; filterClause: string; limit: number },
  ): LeiMatch[] {
    const match = buildFtsMatch(args.normalizedQuery);
    if (!match) return [];
    const rows = handle
      .prepare<LeiCandidateRow>(
        `SELECT e.lei, e.legal_name, e.normalized_name, e.other_names, e.jurisdiction, e.status
         FROM ${leiStoreSpec.table}_fts f
         JOIN ${leiStoreSpec.table} e ON e.rowid = f.rowid
         WHERE ${leiStoreSpec.table}_fts MATCH ?${args.filterClause}
         LIMIT 2000`,
      )
      .all(match);
    return rows
      .map((row) => {
        const isExact = row.normalized_name === args.normalizedQuery;
        return this.leiRowToMatch(row, isExact ? 'exact' : 'strong', row.legal_name);
      })
      .sort((a, b) => matchRank(b.matchType) - matchRank(a.matchType));
  }

  private runLeiFuzzy(
    handle: SqliteHandle,
    args: {
      normalizedQuery: string;
      queryTokens: string[];
      filterClause: string;
      minScore: number;
      cap: number;
    },
  ): LeiMatch[] {
    // Block on EVERY query token's leading 3 chars, one bounded query each, then
    // merge deduped by LEI. Blocking on only the first token starved the pool
    // when the first token wasn't the entity's leading word (order swaps) or was
    // a common word that exhausted the cap before the distinctive token's rows.
    const prefixes = [
      ...new Set(args.queryTokens.map((t) => t.slice(0, 3)).filter((p) => p.length >= 2)),
    ];
    const perStrategyLimit = Math.max(args.cap * 4, 200);
    const byLei = new Map<string, LeiCandidateRow>();
    for (const prefix of prefixes) {
      const part = handle
        .prepare<LeiCandidateRow>(
          `SELECT e.lei, e.legal_name, e.normalized_name, e.other_names, e.jurisdiction, e.status
           FROM ${leiStoreSpec.table} e
           WHERE e.normalized_name LIKE ?${args.filterClause}
           LIMIT ?`,
        )
        .all(`%${prefix}%`, perStrategyLimit);
      for (const r of part) if (!byLei.has(r.lei)) byLei.set(r.lei, r);
    }
    const rows = [...byLei.values()];

    const scored: LeiMatch[] = [];
    for (const row of rows) {
      const names = [row.legal_name, ...(JSON.parse(row.other_names || '[]') as string[])];
      let best = 0;
      let bestName = row.legal_name;
      for (const name of names) {
        const folded = fold(name);
        const s = Math.max(
          jaroWinkler(args.normalizedQuery, folded),
          bestTokenScore(args.queryTokens, tokenize(folded)),
        );
        if (s > best) {
          best = s;
          bestName = name;
        }
      }
      if (best >= args.minScore) {
        const m = this.leiRowToMatch(row, 'approximate', bestName);
        m.score = Number(best.toFixed(4));
        scored.push(m);
      }
    }
    return scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, args.cap);
  }

  private leiRowToMatch(
    row: LeiCandidateRow,
    matchType: LeiMatch['matchType'],
    matchedName: string,
  ): LeiMatch {
    return {
      lei: row.lei,
      legalName: row.legal_name,
      matchedName,
      matchType,
      ...(row.jurisdiction ? { jurisdiction: row.jurisdiction } : {}),
      ...(row.status ? { status: row.status } : {}),
    };
  }

  /** Full GLEIF Level 1 entity by LEI, or null. */
  async getLeiEntity(lei: string): Promise<NormalizedLeiEntity | null> {
    const rows = await this.leiMirror.getByIds([lei]);
    const row = rows[0];
    if (!row?.payload) return null;
    return JSON.parse(String(row.payload)) as NormalizedLeiEntity;
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
  async getLeiEntitiesBatch(leis: string[]): Promise<NormalizedLeiEntity[]> {
    if (leis.length === 0) return [];
    const rows = await this.leiMirror.getByIds(leis);
    return rows
      .filter((r) => r.payload)
      .map((r) => JSON.parse(String(r.payload)) as NormalizedLeiEntity);
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

  /** GLEIF mirror readiness + freshness, plus L1/L2 counts. */
  async leiReadiness(): Promise<
    MirrorReadiness & { entityCount: number; relationshipCount: number }
  > {
    const status = this.toReadiness(await this.leiMirror.status());
    const handle = await this.leiHandle();
    const entityCount =
      handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${leiStoreSpec.table}`).get()?.n ??
      0;
    const relationshipCount =
      handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${LEI_RELATIONSHIP_TABLE}`).get()
        ?.n ?? 0;
    return { ...status, entityCount, relationshipCount };
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

/** Rank for sorting match types (exact > strong > approximate). */
function matchRank(type: ScreeningHit['matchType']): number {
  return type === 'exact' ? 3 : type === 'strong' ? 2 : 1;
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
 * A {@link SyncGenerator} that yields no pages — the GLEIF mirror's sync. GLEIF
 * data is ingested via the service's `ingestLeiEntities`/`ingestLeiRelationships`
 * methods (called by the lifecycle scripts), not through `runSync`.
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
