/**
 * @fileoverview `sanctions://sources` — read-only mirror of
 * sanctions_list_sources: loaded lists + GLEIF datasets with counts, upstream
 * URL, license, and refresh timestamps. A small fixed list; no pagination.
 * @module mcp-server/resources/definitions/sources.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import {
  GLEIF_LICENSE,
  GLEIF_SOURCE_LABEL,
  gleifSourceUrl,
  SOURCE_LICENSES,
  sourceUrls,
} from '@/mcp-server/tools/definitions/_shared.js';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_LABELS, type SourceCode } from '@/services/screening/types.js';

export const sourcesResource = resource('sanctions://sources', {
  name: 'sanctions-screening-mcp-server: sources',
  title: 'sanctions-screening-mcp-server: sources',
  description:
    "List the sanctions watchlists and GLEIF datasets currently loaded in the local mirror, each with its record count and the mirror's as-of timestamp — a read-only URI mirror of sanctions_list_sources.",
  mimeType: 'application/json',
  // Never cached: mirror readiness and the as-of timestamps ARE the payload, so
  // a cached copy would report a stale mirror state as current.
  cacheHint: { ttlMs: 0 },
  params: z.object({}),

  async handler(_params, _ctx) {
    const svc = getScreeningService();
    const cfg = getServerConfig();
    const [counts, sanctions, lei] = await Promise.all([
      svc.sourceCounts(),
      svc.sanctionsReadiness(),
      svc.leiReadiness(),
    ]);
    // Provenance (url + license) comes from the same shared table
    // sanctions_list_sources reads, so the mirror cannot drop fields the tool
    // reports — the resource claims to mirror the tool, so it must carry its data.
    const urlFor = sourceUrls();
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
          url: urlFor[s.code as SourceCode],
          license: SOURCE_LICENSES[s.code as SourceCode],
        })),
        {
          code: 'gleif',
          label: GLEIF_SOURCE_LABEL,
          recordCount: lei.entityCount,
          relationshipCount: lei.relationshipCount,
          url: gleifSourceUrl(),
          license: GLEIF_LICENSE,
        },
      ],
      gleifBaseUrl: cfg.gleifGoldenCopyBaseUrl,
    };
  },

  list: () => ({
    resources: [{ uri: 'sanctions://sources', name: 'Loaded sanctions sources' }],
  }),
});
