/**
 * @fileoverview Shared constants for the sanctions screening surface, used by
 * tools and by the URI resources that mirror them. The decision-support caveat
 * is load-bearing — it appears in every screening tool's output so a consuming
 * model cannot present a fuzzy hit as a verdict. The provenance table is shared
 * so `sanctions_list_sources` and `sanctions://sources` cannot drift apart as
 * sources are added or licenses change.
 * @module mcp-server/tools/definitions/_shared
 */

import { DEFAULT_SOURCE_URLS, getServerConfig } from '@/config/server-config.js';
import type { SourceCode } from '@/services/screening/types.js';

/**
 * The decision-support caveat carried in every screening tool's output. States
 * the three load-bearing facts: results are potential matches to verify, a hit
 * is not a finding of fact, and an empty result is not a clearance.
 */
export const SCREENING_CAVEAT =
  'Screening aid, not a compliance determination. Results are potential matches to verify against the official source — a hit is not a finding of fact, and an empty result is not a clearance. Real sanctions compliance is a legal process this server feeds, not one it performs.';

/**
 * The most characters and words `sanctions_screen_name` and
 * `sanctions_resolve_entity` match on. A fuzzy pass runs one blocking scan per
 * distinct word and scores every pooled candidate against every word, so a
 * caller-sized name would otherwise hold a request for minutes (2,000 distinct
 * three-letter words took 79 s against the sanctions mirror alone). The longest
 * published sanctions name is 245 characters and 34 words. Checked in the
 * handlers rather than as a schema `.max()`, which would change the input schema
 * clients already validate against.
 */
export const MAX_NAME_CHARS = 1024;
/** See {@link MAX_NAME_CHARS}. */
export const MAX_NAME_WORDS = 64;

/** Redistribution terms per sanctions source, surfaced for attribution. */
export const SOURCE_LICENSES: Record<SourceCode, string> = {
  ofac_sdn: 'US Government public domain',
  ofac_consolidated: 'US Government public domain',
  eu: 'EU consolidated list — freely redistributable',
  uk: 'Open Government Licence v3.0 (attribution required)',
  un: 'Freely redistributable',
};

/** GLEIF golden copy is CC0 — cited but no attribution required. */
export const GLEIF_LICENSE = 'CC0 1.0 Universal (public domain)';

/** Display label for the synthetic GLEIF row in the sources listing. */
export const GLEIF_SOURCE_LABEL = 'GLEIF LEI (Level 1 entities + Level 2 ownership)';

/**
 * The upstream URL each sanctions source is harvested from. Read from config
 * rather than a static table so an operator's own mirror endpoint is what gets
 * reported, not always the public default.
 */
export function sourceUrls(): Record<SourceCode, string> {
  const cfg = getServerConfig();
  return {
    ofac_sdn: cfg.ofacSdnUrl,
    ofac_consolidated: cfg.ofacConsolidatedUrl,
    eu: cfg.euFsfUrl,
    uk: cfg.ukSanctionsUrl,
    un: cfg.unScUrl,
  };
}

/** The configured GLEIF golden-copy endpoint, alongside the public default it may override. */
export function gleifSourceUrl(): string {
  const base = getServerConfig().gleifGoldenCopyBaseUrl.replace(/\/$/, '');
  return `${base} (golden copy) — default ${DEFAULT_SOURCE_URLS.gleifGoldenCopyBase}`;
}
