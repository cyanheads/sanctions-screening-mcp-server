/**
 * @fileoverview Synthetic CSL publication shared by fetch-boundary fixtures.
 * @module tests/services/_csl-fixture
 */
import { CSL_SOURCE_CODES } from '@/services/screening/csl-ingest.js';
import { SOURCE_LABELS } from '@/services/screening/types.js';

/** One sparse record per export-control source; no identifiers or type invented. */
export const CSL_RECORDS = CSL_SOURCE_CODES.map((source) => ({
  source: SOURCE_LABELS[source],
  id: `CSL-${source}`,
  name: `Synthetic Export ${source}`,
}));

/** Complete CSL envelope, with overrideable records/metadata for lifecycle tests. */
export function cslDocument(
  results: unknown[] = CSL_RECORDS,
  sources: string[] = CSL_SOURCE_CODES.map((source) => SOURCE_LABELS[source]),
): string {
  return JSON.stringify({
    results,
    offset: 0,
    total: results.length,
    sources_used: sources.map((source) => ({ source })),
  });
}
