/**
 * @fileoverview SQLite schema specs and auxiliary-table DDL for the two mirrors
 * this server owns: the sanctions `designation` mirror (with a per-alias `name`
 * matching index + its own FTS) and the GLEIF `lei_entity` mirror (with a
 * per-name `lei_name` matching index + its own FTS, a `lei_relationship` aux table
 * for ownership traversal, and a `lei_reporting_exception` aux table for the
 * parents entities decline to report). The MirrorService owns
 * the primary tables + their FTS + sync state via `sqliteMirrorStore`; the
 * auxiliary tables below are created idempotently on the raw handle.
 *
 * Why not the store's `migrations` for the aux tables: they are standing
 * schema, not a one-time transformation of older data, and the mirror lifecycle
 * scripts reach the raw handle on paths the store's sync never runs. Owning the
 * DDL here gives both paths one definition — every statement is `CREATE … IF NOT
 * EXISTS`, so `ensureAuxSchema` is safe to run on every open. A new column on a
 * primary table is different: the store's generic upsert writes every declared
 * column, so a mirror written before the column existed must gain it before its
 * first write — that is what the designation spec's migration does.
 * @module services/screening/schema
 */

import type {
  SchemaSpec,
  SqliteHandle,
  SqliteMirrorStoreSpec,
} from '@cyanheads/mcp-ts-core/mirror';

/** Primary table name for the sanctions designation mirror. */
export const DESIGNATION_TABLE = 'designation';
/** Case-insensitive `(source, reference_number)` lookup index, created by the v2 migration. */
export const REFERENCE_NUMBER_INDEX = 'designation_source_reference_number_idx';
/** Per-name/alias matching index, projected from `designation.payload`. */
export const NAME_TABLE = 'name';
/** FTS5 contentless-external index over `name.normalized`. */
export const NAME_FTS_TABLE = 'name_fts';
/** Per-identifier exact-lookup index, projected from `designation.payload.identifiers`. */
export const IDENTIFIER_TABLE = 'designation_identifier';
/** One row: the sync-state stamp of the designation data the identifier index was built from. */
export const IDENTIFIER_STAMP_TABLE = 'designation_identifier_stamp';
/** Primary table name for the GLEIF Level 1 mirror. */
export const LEI_ENTITY_TABLE = 'lei_entity';
/** GLEIF Level 2 ownership relationships. */
export const LEI_RELATIONSHIP_TABLE = 'lei_relationship';
/** GLEIF reporting exceptions, one row per (LEI, category). */
export const LEI_EXCEPTION_TABLE = 'lei_reporting_exception';
/** Per-name GLEIF matching index: the legal name and every other and transliterated name. */
export const LEI_NAME_TABLE = 'lei_name';
/** FTS5 external-content index over `lei_name`, with a prefix index for fuzzy blocking. */
export const LEI_NAME_FTS_TABLE = 'lei_name_fts';
/** One row: the GLEIF sync-state `completedAt` the name index was last known complete under. */
export const LEI_NAME_STAMP_TABLE = 'lei_name_stamp';

/**
 * `sqliteMirrorStore` spec for the sanctions designation mirror. Columns mirror
 * the normalized designation row; `normalized_name` is FTS-indexed so the
 * primary-name path is searchable. The per-alias `name` index is created by
 * {@link ensureDesignationAuxSchema}.
 */
export const designationStoreSpec: Omit<SqliteMirrorStoreSpec, 'path'> = {
  table: DESIGNATION_TABLE,
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
    reference_number: 'TEXT',
    payload: 'TEXT',
  },
  fts: ['normalized_name'],
  // `reference_number` is indexed by its migration, never here: the store runs
  // this list before its migrations, and a mirror written before the column
  // existed would fail to open on an index over a column it does not have yet.
  indexes: [{ columns: ['source'] }, { columns: ['source', 'source_entry_id'] }],
  version: 2,
  migrations: [
    {
      // v2 adds `reference_number`. A mirror created at v2 already has it from the
      // declarative DDL, and the store runs pending migrations on a fresh database
      // too, so the column is added only where it is missing. Existing rows stay
      // NULL until the next sanctions sync rewrites them.
      version: 2,
      up(handle) {
        const hasColumn = handle
          .prepare<{ n: number }>(
            `SELECT COUNT(*) AS n FROM pragma_table_info('${DESIGNATION_TABLE}') WHERE name = 'reference_number'`,
          )
          .get()?.n;
        if (!hasColumn) {
          handle.exec(`ALTER TABLE ${DESIGNATION_TABLE} ADD COLUMN reference_number TEXT`);
        }
        handle.exec(
          `CREATE INDEX IF NOT EXISTS ${REFERENCE_NUMBER_INDEX}
             ON ${DESIGNATION_TABLE}(source, reference_number COLLATE NOCASE)`,
        );
      },
    },
  ],
};

/**
 * `sqliteMirrorStore` spec for the GLEIF Level 1 entity mirror. The legal-name
 * FTS on `normalized_name` serves resolution until a mirror's `lei_name` index is
 * built (see {@link ensureLeiAuxSchema}), and keeps an earlier release working
 * after a rollback. The auxiliary tables are created by {@link ensureLeiAuxSchema}.
 */
export const leiStoreSpec: SchemaSpec = {
  table: LEI_ENTITY_TABLE,
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

/**
 * Create the designation mirror's auxiliary objects: the per-alias `name` index
 * (one row per published name/alias, carrying a Double-Metaphone `phonetic` key
 * for transliteration-class fuzzy hits) plus a contentless FTS over
 * `name.normalized` kept in lockstep by triggers, and the per-identifier
 * `designation_identifier` index (one row per published identifier, keyed by its
 * category's normalized form, with the label and value as published) with the
 * one-row stamp of the sync run it was built from. Idempotent.
 */
export function ensureDesignationAuxSchema(handle: SqliteHandle): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS ${NAME_TABLE} (
      designation_id TEXT NOT NULL,
      name           TEXT NOT NULL,
      normalized     TEXT NOT NULL,
      phonetic       TEXT NOT NULL,
      name_type      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_name_designation ON ${NAME_TABLE}(designation_id);
    CREATE INDEX IF NOT EXISTS idx_name_phonetic ON ${NAME_TABLE}(phonetic);
    CREATE INDEX IF NOT EXISTS idx_name_normalized ON ${NAME_TABLE}(normalized);

    CREATE VIRTUAL TABLE IF NOT EXISTS ${NAME_FTS_TABLE}
      USING fts5(normalized, content='${NAME_TABLE}', content_rowid='rowid',
                 tokenize = 'unicode61 remove_diacritics 2');

    CREATE TRIGGER IF NOT EXISTS ${NAME_TABLE}_ai AFTER INSERT ON ${NAME_TABLE} BEGIN
      INSERT INTO ${NAME_FTS_TABLE}(rowid, normalized) VALUES (new.rowid, new.normalized);
    END;
    CREATE TRIGGER IF NOT EXISTS ${NAME_TABLE}_ad AFTER DELETE ON ${NAME_TABLE} BEGIN
      INSERT INTO ${NAME_FTS_TABLE}(${NAME_FTS_TABLE}, rowid, normalized)
        VALUES ('delete', old.rowid, old.normalized);
    END;

    CREATE TABLE IF NOT EXISTS ${IDENTIFIER_TABLE} (
      designation_id TEXT NOT NULL,
      category       TEXT NOT NULL,
      key            TEXT NOT NULL,
      type           TEXT NOT NULL,
      value          TEXT NOT NULL,
      country        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_identifier_key ON ${IDENTIFIER_TABLE}(key, category);
    CREATE INDEX IF NOT EXISTS idx_identifier_designation ON ${IDENTIFIER_TABLE}(designation_id);

    CREATE TABLE IF NOT EXISTS ${IDENTIFIER_STAMP_TABLE} (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      stamp TEXT NOT NULL
    );
  `);
}

/**
 * Create the GLEIF mirror's auxiliary tables. Idempotent.
 *
 * - `lei_relationship`, indexed on both `child_lei` and `parent_lei` for
 *   bidirectional ownership traversal.
 * - `lei_reporting_exception`, one row per (LEI, category) with the reasons as a
 *   JSON array. Whether its data is loaded is read from the sync-state
 *   checkpoint, never from the table.
 * - `lei_name`, one row per distinct folded name of an entity — the legal name
 *   and every other and transliterated name, with its type — and `lei_name_fts`
 *   over it, kept in lockstep by triggers. The FTS indexes three columns:
 *   `normalized` (the name's fold tokens), `suffix_terms` (every proper suffix of
 *   a token in a script written without word separators, so a prefix lookup
 *   reaches it mid-name), and `jurisdiction_terms` (`jc<country>` and
 *   `jx<code>`, so a country and a subdivision each match one whole token —
 *   unicode61 would split `US-CA` into `us` and `ca`). `prefix='2 3'` makes the
 *   fuzzy pass's two- and three-code-point blocking prefixes index lookups.
 * - `lei_name_stamp`, the record of a completed build. A mirror written before
 *   the index existed gains these tables empty on open, and an empty index read
 *   as "no alternate names" would hide the legal names too — so whether the
 *   index serves resolution is read from the stamp, never from the table.
 */
export function ensureLeiAuxSchema(handle: SqliteHandle): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS ${LEI_RELATIONSHIP_TABLE} (
      child_lei           TEXT NOT NULL,
      parent_lei          TEXT NOT NULL,
      relationship_type   TEXT NOT NULL,
      relationship_status TEXT,
      relationship_period TEXT,
      PRIMARY KEY (child_lei, parent_lei, relationship_type)
    );
    CREATE INDEX IF NOT EXISTS idx_rel_child ON ${LEI_RELATIONSHIP_TABLE}(child_lei);
    CREATE INDEX IF NOT EXISTS idx_rel_parent ON ${LEI_RELATIONSHIP_TABLE}(parent_lei);

    CREATE TABLE IF NOT EXISTS ${LEI_EXCEPTION_TABLE} (
      lei      TEXT NOT NULL,
      category TEXT NOT NULL,
      reasons  TEXT NOT NULL,
      PRIMARY KEY (lei, category)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ${LEI_NAME_TABLE} (
      lei                TEXT NOT NULL,
      name               TEXT NOT NULL,
      normalized         TEXT NOT NULL,
      name_type          TEXT NOT NULL,
      suffix_terms       TEXT NOT NULL,
      jurisdiction_terms TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lei_name_lei ON ${LEI_NAME_TABLE}(lei);

    CREATE VIRTUAL TABLE IF NOT EXISTS ${LEI_NAME_FTS_TABLE}
      USING fts5(normalized, suffix_terms, jurisdiction_terms,
                 content='${LEI_NAME_TABLE}', content_rowid='rowid',
                 tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');

    CREATE TRIGGER IF NOT EXISTS ${LEI_NAME_TABLE}_ai AFTER INSERT ON ${LEI_NAME_TABLE} BEGIN
      INSERT INTO ${LEI_NAME_FTS_TABLE}(rowid, normalized, suffix_terms, jurisdiction_terms)
        VALUES (new.rowid, new.normalized, new.suffix_terms, new.jurisdiction_terms);
    END;
    CREATE TRIGGER IF NOT EXISTS ${LEI_NAME_TABLE}_ad AFTER DELETE ON ${LEI_NAME_TABLE} BEGIN
      INSERT INTO ${LEI_NAME_FTS_TABLE}(${LEI_NAME_FTS_TABLE}, rowid, normalized, suffix_terms, jurisdiction_terms)
        VALUES ('delete', old.rowid, old.normalized, old.suffix_terms, old.jurisdiction_terms);
    END;

    CREATE TABLE IF NOT EXISTS ${LEI_NAME_STAMP_TABLE} (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      stamp TEXT NOT NULL
    );
  `);
}
