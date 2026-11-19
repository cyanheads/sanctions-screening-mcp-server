/**
 * @fileoverview The ingest rejection predicate shared by the sanctions and GLEIF
 * normalizers, plus the per-source drop tally that makes a rejection auditable.
 * A source record that cannot supply its own stable identity or a usable name is
 * dropped rather than repaired: the mirror's primary key is
 * `${source}:${sourceEntryId}`, so a minted identifier is never an update — each
 * harvest would store the entity under a new key and remove the last one, and
 * no id handed to a caller would survive the next refresh. A placeholder name is
 * worse still, since a screening hit must never carry a synthesized identity.
 *
 * A silent drop is its own failure mode: a source that started publishing
 * malformed records would be absorbed without a trace. Every normalizer counts
 * what it dropped and why, and each harvest reports the tally for its source.
 *
 * Also the field readers the XML and JSON ingesters share: `componentText` for a
 * published detail component, and `isoDocumentDate` for each source's own
 * publication date.
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

/**
 * A published detail component carrying a letter or digit, excluding the whole
 * placeholders UNKNOWN and N/A. Not for names or country codes (NA is Namibia).
 * XML scalar wrappers and numeric components retain their published text.
 */
export function componentText(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && '#text' in value)
    return componentText(value['#text']);
  const text =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number'
        ? String(value)
        : undefined;
  if (!text || ['na', 'unknown'].includes(text.toLowerCase().replace(/[./]/gu, ''))) return;
  return /[\p{L}\p{N}]/u.test(text) ? text : undefined;
}

/**
 * An ISO 8601 calendar date at any precision (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`), or
 * a date and time to minutes, seconds, or a fraction, with an optional `Z` or
 * `±HH:MM` offset. Captures year, month, day, hour, minute, second, and the
 * offset's hours and minutes.
 */
const ISO_DOCUMENT_DATE =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))?)?)?)?$/;

/** Longer than any value {@link ISO_DOCUMENT_DATE} accepts, which tops out at 35 characters. */
const MAX_ISO_DOCUMENT_DATE = 40;

/**
 * A publisher's date for its document — OFAC `DateOfIssue`, EU `generationDate`,
 * UK `DateGenerated`, UN `dateGenerated`, CSL `source_last_updated` — kept only
 * when it reads as ISO 8601, and then verbatim: at the precision it was
 * published, its fraction and offset as written, a local time never given a
 * zone. A value that is not an ISO 8601 date, or names a day, hour, or offset
 * that does not exist, is undefined.
 */
export function isoDocumentDate(text: string | undefined): string | undefined {
  const value = text?.trim();
  if (!value || value.length > MAX_ISO_DOCUMENT_DATE) return;
  const match = ISO_DOCUMENT_DATE.exec(value);
  if (!match) return;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => (part === undefined ? undefined : Number(part)));
  if (month !== undefined && (month < 1 || month > 12)) return;
  if (
    day !== undefined &&
    (day < 1 || day > new Date(Date.UTC(year as number, month as number, 0)).getUTCDate())
  ) {
    return;
  }
  if ((hour ?? 0) > 23 || (minute ?? 0) > 59 || (second ?? 0) > 59) return;
  if ((offsetHour ?? 0) > 23 || (offsetMinute ?? 0) > 59) return;
  return value;
}
