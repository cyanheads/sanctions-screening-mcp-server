/**
 * @fileoverview The ingest rejection predicate shared by the sanctions and GLEIF
 * normalizers, plus the per-source drop tally that makes a rejection auditable.
 * A source record that cannot supply its own stable identity or a usable name is
 * dropped rather than repaired: the mirror's primary key is
 * `${source}:${sourceEntryId}` and the sync yields no tombstones, so a minted
 * identifier is never an update — it is one extra row per harvest, forever. A
 * placeholder name is worse still, since a screening hit must never carry a
 * synthesized identity.
 *
 * A silent drop is its own failure mode: a source that started publishing
 * malformed records would be absorbed without a trace. Every normalizer counts
 * what it dropped and why, and each harvest reports the tally for its source.
 * @module services/screening/ingest-validation
 */

/** U+FFFD — what a lossy UTF-8 decode substitutes for bytes it cannot decode. */
const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * A name is usable when the source published one and it survived decoding
 * intact. A name carrying U+FFFD is a decode artifact rather than a name;
 * indexing it puts an unmatchable string into the screening corpus under the
 * appearance of a real alias.
 */
export function isUsableName(name: string | undefined): name is string {
  return !!name && !name.includes(REPLACEMENT_CHARACTER);
}

/**
 * Records dropped during one source's harvest, by reason. The two reasons are
 * the two drop predicates: a record the source published with no stable entry
 * identifier, and a record with no usable name.
 */
export interface IngestRejections {
  /** Records the source published without a stable entry identifier. */
  missingIdentifier: number;
  /** Records whose name was absent, empty, or a lossy-decode artifact. */
  unusableName: number;
}

/** A zeroed tally. Normalizers increment it in place as they drop records. */
export function createRejections(): IngestRejections {
  return { missingIdentifier: 0, unusableName: 0 };
}
