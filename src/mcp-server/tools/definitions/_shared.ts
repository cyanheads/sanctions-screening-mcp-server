/**
 * @fileoverview Shared constants for the sanctions screening surface, used by
 * tools and by the URI resources that mirror them. The decision-support caveat
 * is load-bearing — it appears in every screening tool's output so a consuming
 * model cannot present a fuzzy hit as a verdict. The sources payload is built
 * here, once, so `sanctions_list_sources` and `sanctions://sources` serve the
 * same object and cannot drift apart as sources are added or licenses change.
 * @module mcp-server/tools/definitions/_shared
 */

import { z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import type { ScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_LABELS, type SourceCode, UNKNOWN_NAME_TYPE } from '@/services/screening/types.js';
import type { SourcesPayloadSchema } from './list-sources.tool.js';

/**
 * The decision-support caveat carried in every screening tool's output. States
 * the three load-bearing facts: results are potential matches to verify, a hit
 * is not a finding of fact, and an empty result is not a clearance.
 */
export const SCREENING_CAVEAT =
  'Screening aid, not a compliance determination. Results are potential matches to verify against the official source — a hit is not a finding of fact, and an empty result is not a clearance. Real sanctions compliance is a legal process this server feeds, not one it performs.';

/**
 * The most characters and words `sanctions_screen_name` and
 * `sanctions_resolve_entity` match on. A fuzzy pass makes index lookups per
 * distinct word and scores every pooled candidate against every word, so its
 * work grows with the name (while a blocking lookup was a table scan, 2,000
 * distinct three-letter words took 79 s against the sanctions mirror alone). The longest
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
const GLEIF_LICENSE = 'CC0 1.0 Universal (public domain)';

/** Display label for the synthetic GLEIF row in the sources listing. */
const GLEIF_SOURCE_LABEL = 'GLEIF LEI (Level 1 entities + Level 2 ownership)';

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

/** The provenance payload: `sanctions_list_sources`' output, served unchanged by `sanctions://sources`. */
export type SourcesPayload = z.infer<typeof SourcesPayloadSchema>;

/**
 * Build the whole sources payload: one row per sanctions list, then the GLEIF
 * row, plus each mirror's readiness and freshness, whether GLEIF reporting
 * exceptions are loaded, and whether the GLEIF alternate-name index is built.
 * Every URL is the configured one, reported as is.
 */
export async function buildSourcesPayload(svc: ScreeningService): Promise<SourcesPayload> {
  const [counts, sanctions, lei, alternateNamesIndexed] = await Promise.all([
    svc.sourceCounts(),
    svc.sanctionsReadiness(),
    svc.leiReadiness(),
    svc.leiNamesIndexed(),
  ]);
  const urlFor = sourceUrls();
  return {
    sanctionsReady: sanctions.ready,
    ...(sanctions.completedAt ? { sanctionsAsOf: sanctions.completedAt } : {}),
    leiReady: lei.ready,
    ...(lei.completedAt ? { leiAsOf: lei.completedAt } : {}),
    reportingExceptionsLoaded: lei.exceptionsLoaded,
    alternateNamesIndexed,
    sources: [
      ...counts.map((s) => ({
        code: s.code,
        label: SOURCE_LABELS[s.code],
        recordCount: s.recordCount,
        url: urlFor[s.code],
        license: SOURCE_LICENSES[s.code],
      })),
      {
        code: 'gleif',
        label: GLEIF_SOURCE_LABEL,
        recordCount: lei.entityCount,
        relationshipCount: lei.relationshipCount,
        ...(lei.exceptionsLoaded ? { reportingExceptionCount: lei.exceptionCount } : {}),
        url: getServerConfig().gleifGoldenCopyBaseUrl,
        license: GLEIF_LICENSE,
      },
    ],
  };
}

/**
 * One published value of a GLEIF entity that the cross-reference in
 * `sanctions_get_entity` and `sanctions_trace_ownership` screened — the shape of
 * each hit's `matchedOn` and of `sanctionsScreen.screenedInputs`.
 */
export const ScreenedInputSchema = z
  .object({
    input: z
      .enum(['legal_name', 'other_name', 'lei', 'registration_number'])
      .describe(
        'Which value: legal_name, or other_name (an other or transliterated name), each screened as a name, strict; lei, or registration_number (the ID at the registration authority), each looked up as a non-document identifier.',
      ),
    value: z.string().describe('The value as GLEIF publishes it.'),
    nameType: z
      .string()
      .optional()
      .describe(
        "GLEIF's type for an other_name (e.g. TRADING_OR_OPERATING_NAME, AUTO_ASCII_TRANSLITERATED_LEGAL_NAME), or UNKNOWN for a name the mirror stored without one. Present on other_name only.",
      ),
  })
  .describe('One value of the entity the cross-reference screened.');

/** A designation's identifier, as its list publishes it, that the cross-reference matched. */
export const MatchedIdentifierSchema = z
  .object({
    type: z
      .string()
      .describe(
        'Identifier label as the list publishes it (e.g. Legal Entity Number, Registration Number).',
      ),
    value: z.string().describe('The identifier value, as published.'),
    country: z.string().optional().describe('Issuing country as published, when published.'),
  })
  .describe(
    "An identifier the designation publishes that equals the entity's LEI, or its registration number published for the country of its legal jurisdiction.",
  );

/**
 * A hit's `sources`, on every tool that returns sanctions hits. OFAC publishes a
 * party on the SDN List and a non-SDN list under one entry ID in both of its
 * files; a screen of both lists returns that party as one hit naming both.
 */
export const HitSourcesSchema = z
  .array(z.enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un']))
  .describe(
    'Every screened list this candidate is on, in list order: one list, or ofac_sdn and ofac_consolidated together for an OFAC party both OFAC lists publish under one entry ID — one hit, not two. Read this, not source, for every list; the entry ID resolves in sanctions_get_designation under each.',
  );

/** The lists beyond `source` a hit's party is on, as `format()` names them; undefined for a hit on one list. */
export function alsoListedText(
  source: SourceCode,
  sources: readonly SourceCode[],
): string | undefined {
  const others = sources.filter((code) => code !== source);
  return others.length > 0
    ? others.map((code) => `${SOURCE_LABELS[code]} (\`${code}\`)`).join(', ')
    : undefined;
}

/** A screened input as the tools' output carries it. */
type ScreenedInputOutput = z.infer<typeof ScreenedInputSchema>;

/** GLEIF's name type as `format()` shows it: a name stored without one reads "type not recorded". */
export function gleifNameTypeText(type: string): string {
  return type === UNKNOWN_NAME_TYPE ? 'type not recorded' : type;
}

/** One screened input as `format()` shows it: `other_name "Rosneft" (TRADING_OR_OPERATING_NAME)`, `lei 2534…`. */
export function screenedInputText({ input, value, nameType }: ScreenedInputOutput): string {
  if (input === 'lei' || input === 'registration_number') return `${input} ${value}`;
  return `${input} "${value}"${nameType ? ` (${gleifNameTypeText(nameType)})` : ''}`;
}

/** One matched identifier as `format()` shows it: `identifier Registration ID: 1027700043502 (Russia)`. */
export function matchedIdentifierText({
  type,
  value,
  country,
}: z.infer<typeof MatchedIdentifierSchema>): string {
  return `identifier ${type}: ${value}${country ? ` (${country})` : ''}`;
}

/**
 * The guidance for a capped cross-reference: every name it screened, to re-run
 * with `sanctions_screen_name`, and every identifier it looked up, for
 * `sanctions_screen_identifier`. A strict `sanctions_screen_name` also completes
 * each list it found nothing on with approximate matches, which the strict
 * cross-reference never counts, so the guidance says the re-screen can return
 * more. `legalName` is undefined for an ownership node with no Level 1 record,
 * which had no name screened: the guidance is its LEI lookup alone.
 */
export function crossReferencePointer(
  legalName: string | undefined,
  lei: string,
  screenedInputs: readonly ScreenedInputOutput[],
): string {
  const valuesOf = (input: ScreenedInputOutput['input']) =>
    screenedInputs.filter((screened) => screened.input === input).map((screened) => screened.value);
  const names = [
    ...new Set([...(legalName === undefined ? [] : [legalName]), ...valuesOf('other_name')]),
  ];
  const lookUp = `look up ${[lei, ...valuesOf('registration_number')].join(', ')} with sanctions_screen_identifier to see the rest`;
  return names.length > 0
    ? `re-screen ${names.map((name) => `"${name}"`).join(', ')} with sanctions_screen_name and ${lookUp}; the name re-screen can add approximate matches on lists with no strict match, which this count leaves out.`
    : `${lookUp}.`;
}
