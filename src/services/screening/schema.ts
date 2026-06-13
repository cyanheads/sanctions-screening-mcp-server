/**
 * @fileoverview SQLite schema specs and auxiliary-table DDL for the two mirrors
 * this server owns: the sanctions `designation` mirror (with a per-alias `name`
 * matching index + its own FTS) and the GLEIF `lei_entity` mirror (with a
 * `lei_relationship` aux table for ownership traversal). The MirrorService owns
 * the primary tables + their FTS + sync state via `sqliteMirrorStore`; the
 * auxiliary tables below are created idempotently on the raw handle.
 *
 * Why not the store's `migrations`: the framework's migration runner skips ALL
 * migrations on a brand-new DB (it stamps the current version without running
 * them, since there is no older data to transform). Auxiliary DDL therefore must
 * be applied directly — every statement here is `CREATE … IF NOT EXISTS`, so
 * `ensureAuxSchema` is safe to run on every open.
 * @module services/screening/schema
 */

import type { SchemaSpec, SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';

/** Primary table name for the sanctions designation mirror. */
export const DESIGNATION_TABLE = 'designation';
/** Per-name/alias matching index, projected from `designation.payload`. */
export const NAME_TABLE = 'name';
/** FTS5 contentless-external index over `name.normalized`. */
export const NAME_FTS_TABLE = 'name_fts';
/** Primary table name for the GLEIF Level 1 mirror. */
export const LEI_ENTITY_TABLE = 'lei_entity';
/** GLEIF Level 2 ownership relationships. */
export const LEI_RELATIONSHIP_TABLE = 'lei_relationship';

/**
 * `sqliteMirrorStore` spec for the sanctions designation mirror. Columns mirror
 * the normalized designation row; `normalized_name` is FTS-indexed so the
 * primary-name path is searchable. The per-alias `name` index is created by
 * {@link ensureDesignationAuxSchema}.
 */
export const designationStoreSpec: SchemaSpec = {
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
    payload: 'TEXT',
  },
  fts: ['normalized_name'],
  indexes: [{ columns: ['source'] }, { columns: ['source', 'source_entry_id'] }],
};

/**
 * `sqliteMirrorStore` spec for the GLEIF Level 1 entity mirror. `normalized_name`
 * is FTS-indexed for name → LEI resolution. The `lei_relationship` table is
 * created by {@link ensureLeiAuxSchema}.
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
 * `name.normalized` kept in lockstep by triggers. Idempotent.
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
  `);
}

/**
 * Create the GLEIF mirror's auxiliary `lei_relationship` table, indexed on both
 * `child_lei` and `parent_lei` for bidirectional ownership traversal. Idempotent.
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
  `);
}
