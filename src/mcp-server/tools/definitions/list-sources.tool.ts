/**
 * @fileoverview `sanctions_list_sources` — provenance and freshness for any
 * result. Lists the sanctions watchlists and GLEIF datasets currently loaded in
 * the local mirror, each with its record count, source URL, license, and the
 * mirror's readiness + as-of timestamp. Lets an agent judge staleness before
 * trusting (or distrusting) a screen. The payload comes from the shared
 * `buildSourcesPayload()`, which `sanctions://sources` serves unchanged.
 * @module mcp-server/tools/definitions/list-sources.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { buildSourcesPayload } from './_shared.js';

/**
 * The tool's output schema — named so `buildSourcesPayload()` can type the payload
 * it builds against exactly the fields declared here.
 */
export const SourcesPayloadSchema = z.object({
  sanctionsReady: z
    .boolean()
    .describe('True once the sanctions mirror has completed at least one full sync.'),
  sanctionsAsOf: z
    .string()
    .optional()
    .describe('ISO 8601 timestamp of the last completed sanctions sync, when available.'),
  leiReady: z
    .boolean()
    .describe('True once the GLEIF (LEI) mirror has completed at least one full sync.'),
  leiAsOf: z
    .string()
    .optional()
    .describe('ISO 8601 timestamp of the last completed GLEIF sync, when available.'),
  reportingExceptionsLoaded: z
    .boolean()
    .describe(
      'Whether GLEIF reporting exceptions are loaded. When false, sanctions_trace_ownership reads a parent level with no published relationship as unknown.',
    ),
  alternateNamesIndexed: z
    .boolean()
    .describe(
      'Whether the GLEIF alternate-name index — trading, previous, alternative-language, and transliterated names — is built. When false, sanctions_resolve_entity searches legal names only until mirror:init reloads the GLEIF golden copy. True on a GLEIF mirror that has never loaded (leiReady false): its empty index is complete, and the first load builds it with the entities.',
    ),
  sources: z
    .array(
      z
        .object({
          code: z.string().describe('Source code (ofac_sdn, eu, …, or gleif).'),
          label: z.string().describe('Human-readable source name.'),
          recordCount: z
            .number()
            .describe(
              'Records currently loaded for this source — for gleif, Level 1 entity records.',
            ),
          relationshipCount: z
            .number()
            .optional()
            .describe('GLEIF Level 2 ownership relationships loaded (gleif only).'),
          reportingExceptionCount: z
            .number()
            .optional()
            .describe(
              'GLEIF reporting-exception records loaded (gleif only). Absent when the dataset has never been loaded — never read as zero.',
            ),
          url: z
            .string()
            .describe(
              'Upstream URL the mirror harvests this source from, as configured — for gleif, the golden-copy API base.',
            ),
          license: z.string().describe('Redistribution license / terms for this source.'),
        })
        .describe('One loaded source with count, provenance, and license.'),
    )
    .describe('All loaded sources, sanctions lists then the GLEIF dataset.'),
});

export const listSourcesTool = tool('sanctions_list_sources', {
  title: 'sanctions-screening-mcp-server: list sources',
  description:
    "List the sanctions watchlists (OFAC SDN + Consolidated, EU, UK, UN) and GLEIF datasets currently loaded in the local mirror, each with its record count, source URL, license, and the mirror's readiness and as-of timestamp — for GLEIF, also its Level 2 ownership relationship count, whether its reporting exceptions are loaded and how many, and whether its alternate-name index is built. Use this for provenance and freshness on any result — results are only as current as the last mirror refresh, and a not-ready mirror means screening cannot run yet. Attribution: UK data is under the Open Government Licence v3.0; all sources are cited here.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({}),
  output: SourcesPayloadSchema,

  async handler(_input, ctx) {
    const payload = await buildSourcesPayload(getScreeningService());
    ctx.log.debug('Listed sources', {
      sanctionsReady: payload.sanctionsReady,
      leiReady: payload.leiReady,
    });
    return payload;
  },

  format: (r) => {
    const lines = ['# Loaded sources', ''];
    lines.push(
      `**Sanctions mirror:** ${r.sanctionsReady ? 'ready' : 'NOT ready'}${r.sanctionsAsOf ? ` (as of ${r.sanctionsAsOf})` : ''}`,
    );
    lines.push(
      `**GLEIF mirror:** ${r.leiReady ? 'ready' : 'NOT ready'}${r.leiAsOf ? ` (as of ${r.leiAsOf})` : ''}`,
    );
    if (!r.reportingExceptionsLoaded) {
      lines.push(
        '**GLEIF reporting exceptions:** not loaded — ownership traces read an unpublished parent as unknown. mirror:refresh loads them, or mirror:init on a mirror loaded before they existed.',
      );
    }
    lines.push(
      !r.leiReady
        ? '**GLEIF alternate-name index:** none yet — the GLEIF mirror has never completed a load. mirror:init loads the golden copy and builds the index with it.'
        : r.alternateNamesIndexed
          ? '**GLEIF alternate-name index:** built'
          : '**GLEIF alternate-name index:** not built — sanctions_resolve_entity searches legal names only, so an entity published only under a trading, previous, alternative-language, or transliterated name cannot be found. mirror:init reloads the GLEIF golden copy and builds it.',
    );
    lines.push('');
    for (const s of r.sources) {
      lines.push(`### ${s.label} (\`${s.code}\`)`);
      const records =
        s.relationshipCount === undefined
          ? `${s.recordCount}`
          : `${s.recordCount} Level 1 entities · ${s.relationshipCount} Level 2 relationships`;
      lines.push(`**Records:** ${records} | **License:** ${s.license}`);
      if (s.reportingExceptionCount !== undefined) {
        lines.push(`**Reporting exceptions:** ${s.reportingExceptionCount}`);
      }
      lines.push(`**Source:** ${s.url}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
