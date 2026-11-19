/**
 * @fileoverview `sanctions://sources` — read-only mirror of
 * sanctions_list_sources: loaded lists + GLEIF datasets with counts, upstream
 * URL, license, refresh timestamps, each sanctions list's last harvest and
 * document date, and a running or failed refresh. A small fixed list; no
 * pagination.
 * @module mcp-server/resources/definitions/sources.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { buildSourcesPayload } from '@/mcp-server/tools/definitions/_shared.js';
import { getScreeningService } from '@/services/screening/screening-service.js';

export const sourcesResource = resource('sanctions://sources', {
  name: 'sanctions-screening-mcp-server: sources',
  title: 'sanctions-screening-mcp-server: sources',
  description:
    "List the sanctions watchlists and GLEIF datasets loaded in the local mirror, each with its record count, source URL, and license, and each sanctions list with its last successful harvest and the date its publisher put on that document; plus each mirror's readiness and as-of timestamp, a sanctions refresh that is running or failed with the lists that failed, the GLEIF Level 2 relationship count, whether GLEIF reporting exceptions are loaded and how many, whether the GLEIF alternate-name index is built, and whether the last full GLEIF load wrote entity status and successors — the sanctions_list_sources payload, unchanged, as a read-only URI.",
  mimeType: 'application/json',
  // Never cached: mirror readiness and the as-of timestamps ARE the payload, so
  // a cached copy would report a stale mirror state as current.
  cacheHint: { ttlMs: 0 },
  params: z.object({}),

  // The tool's own builder, returned unchanged: the resource claims to mirror the
  // tool, so it cannot add, drop, or reshape a field the tool reports.
  handler: (_params, _ctx) => buildSourcesPayload(getScreeningService()),

  list: () => ({
    resources: [{ uri: 'sanctions://sources', name: 'Loaded sanctions sources' }],
  }),
});
