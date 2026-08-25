/**
 * @fileoverview `sanctions://entity/{lei}` — read-only mirror of
 * sanctions_get_entity's GLEIF Level 1 payload (without the screening
 * cross-reference, which is tool-only). For clients that inject context by URI.
 * @module mcp-server/resources/definitions/entity.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getScreeningService } from '@/services/screening/screening-service.js';

export const entityResource = resource('sanctions://entity/{lei}', {
  name: 'sanctions-screening-mcp-server: entity',
  title: 'sanctions-screening-mcp-server: entity',
  description:
    "Fetch one GLEIF Level 1 legal-entity record by LEI — a read-only URI mirror of sanctions_get_entity's entity payload. The sanctions cross-reference is available only via the tool.",
  mimeType: 'application/json',
  // GLEIF Level 1 records change only when a delta is applied out-of-band.
  // Private for the same reason as the designation resource.
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'private' },
  params: z.object({
    lei: z
      .string()
      .regex(/^[A-Z0-9]{18}[0-9]{2}$/, 'LEI must be 20 chars: 18 alphanumerics + 2 check digits.')
      .describe('The 20-character GLEIF Legal Entity Identifier.'),
  }),
  errors: [
    {
      reason: 'lei_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No GLEIF entity exists for the given LEI in the mirror.',
      recovery:
        'Resolve the entity name with sanctions_resolve_entity to obtain a valid LEI first.',
    },
    {
      reason: 'mirror_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The GLEIF (LEI) mirror has never completed an initial sync.',
      retryable: true,
      recovery: 'Run the mirror:init lifecycle script to load the GLEIF golden copy, then retry.',
    },
  ],

  async handler(params, ctx) {
    const svc = getScreeningService();
    // Readiness first, mirroring sanctions_get_entity, and gated on the GLEIF
    // mirror alone — the two mirrors sync independently.
    if (!(await svc.leiReady())) {
      throw ctx.fail('mirror_not_ready', 'The local GLEIF (LEI) mirror is not yet populated.', {
        ...ctx.recoveryFor('mirror_not_ready'),
      });
    }
    const entity = await svc.getLeiEntity(params.lei);
    if (!entity) {
      throw ctx.fail('lei_not_found', `No GLEIF entity with LEI "${params.lei}".`, {
        ...ctx.recoveryFor('lei_not_found'),
      });
    }
    return entity;
  },
});
