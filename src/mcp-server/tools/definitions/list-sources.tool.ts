/**
 * @fileoverview `sanctions_list_sources` — provenance and freshness for any
 * result. Lists the sanctions watchlists and GLEIF datasets currently loaded in
 * the local mirror, each with its record count, source URL, license, and the
 * mirror's readiness + as-of timestamp. Lets an agent judge staleness before
 * trusting (or distrusting) a screen.
 * @module mcp-server/tools/definitions/list-sources.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_LABELS, type SourceCode } from '@/services/screening/types.js';
import {
  GLEIF_LICENSE,
  GLEIF_SOURCE_LABEL,
  gleifSourceUrl,
  SOURCE_LICENSES,
  sourceUrls,
} from './_shared.js';

export const listSourcesTool = tool('sanctions_list_sources', {
  title: 'sanctions-screening-mcp-server: list sources',
  description:
    "List the sanctions watchlists (OFAC SDN + Consolidated, EU, UK, UN) and GLEIF datasets currently loaded in the local mirror, each with its record count, source URL, license, and the mirror's readiness and as-of timestamp. Use this for provenance and freshness on any result — results are only as current as the last mirror refresh, and a not-ready mirror means screening cannot run yet. Attribution: UK data is under the Open Government Licence v3.0; all sources are cited here.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({}),
  output: z.object({
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
    sources: z
      .array(
        z
          .object({
            code: z.string().describe('Source code (ofac_sdn, eu, …, or gleif).'),
            label: z.string().describe('Human-readable source name.'),
            recordCount: z.number().describe('Records currently loaded for this source.'),
            url: z.string().describe('Upstream source URL the mirror harvests from.'),
            license: z.string().describe('Redistribution license / terms for this source.'),
          })
          .describe('One loaded source with count, provenance, and license.'),
      )
      .describe('All loaded sources, sanctions lists then the GLEIF dataset.'),
  }),

  async handler(_input, ctx) {
    const svc = getScreeningService();
    const [counts, sanctions, lei] = await Promise.all([
      svc.sourceCounts(),
      svc.sanctionsReadiness(),
      svc.leiReadiness(),
    ]);

    const urlFor = sourceUrls();
    const sources = counts.map((s) => ({
      code: s.code,
      label: SOURCE_LABELS[s.code as SourceCode],
      recordCount: s.recordCount,
      url: urlFor[s.code as SourceCode],
      license: SOURCE_LICENSES[s.code as SourceCode],
    }));
    sources.push({
      code: 'gleif',
      label: GLEIF_SOURCE_LABEL,
      recordCount: lei.entityCount,
      url: gleifSourceUrl(),
      license: GLEIF_LICENSE,
    });

    ctx.log.debug('Listed sources', { sanctionsReady: sanctions.ready, leiReady: lei.ready });

    return {
      sanctionsReady: sanctions.ready,
      ...(sanctions.completedAt ? { sanctionsAsOf: sanctions.completedAt } : {}),
      leiReady: lei.ready,
      ...(lei.completedAt ? { leiAsOf: lei.completedAt } : {}),
      sources,
    };
  },

  format: (r) => {
    const lines = ['# Loaded sources', ''];
    lines.push(
      `**Sanctions mirror:** ${r.sanctionsReady ? 'ready' : 'NOT ready'}${r.sanctionsAsOf ? ` (as of ${r.sanctionsAsOf})` : ''}`,
    );
    lines.push(
      `**GLEIF mirror:** ${r.leiReady ? 'ready' : 'NOT ready'}${r.leiAsOf ? ` (as of ${r.leiAsOf})` : ''}`,
    );
    lines.push('');
    for (const s of r.sources) {
      lines.push(`### ${s.label} (\`${s.code}\`)`);
      lines.push(`**Records:** ${s.recordCount} | **License:** ${s.license}`);
      lines.push(`**Source:** ${s.url}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
