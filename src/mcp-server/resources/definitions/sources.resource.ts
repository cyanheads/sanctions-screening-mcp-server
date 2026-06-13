/**
 * @fileoverview `sanctions://sources` — read-only mirror of
 * sanctions_list_sources: loaded lists + GLEIF datasets with counts and refresh
 * timestamps. A small fixed list; no pagination.
 * @module mcp-server/resources/definitions/sources.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_LABELS, type SourceCode } from '@/services/screening/types.js';

export const sourcesResource = resource('sanctions://sources', {
  name: 'sanctions-screening-mcp-server: sources',
  title: 'sanctions-screening-mcp-server: sources',
  description:
    "List the sanctions watchlists and GLEIF datasets currently loaded in the local mirror, each with its record count and the mirror's as-of timestamp — a read-only URI mirror of sanctions_list_sources.",
  mimeType: 'application/json',
  params: z.object({}),

  async handler(_params, _ctx) {
    const svc = getScreeningService();
    const cfg = getServerConfig();
    const [counts, sanctions, lei] = await Promise.all([
      svc.sourceCounts(),
      svc.sanctionsReadiness(),
      svc.leiReadiness(),
    ]);
    return {
      sanctionsReady: sanctions.ready,
      sanctionsAsOf: sanctions.completedAt,
      leiReady: lei.ready,
      leiAsOf: lei.completedAt,
      sources: [
        ...counts.map((s) => ({
          code: s.code,
          label: SOURCE_LABELS[s.code as SourceCode],
          recordCount: s.recordCount,
        })),
        {
          code: 'gleif',
          label: 'GLEIF LEI (Level 1 entities + Level 2 ownership)',
          recordCount: lei.entityCount,
          relationshipCount: lei.relationshipCount,
        },
      ],
      gleifBaseUrl: cfg.gleifGoldenCopyBaseUrl,
    };
  },

  list: () => ({
    resources: [{ uri: 'sanctions://sources', name: 'Loaded sanctions sources' }],
  }),
});
