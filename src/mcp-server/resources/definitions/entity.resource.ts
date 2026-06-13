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
  ],

  async handler(params, ctx) {
    const svc = getScreeningService();
    const entity = await svc.getLeiEntity(params.lei);
    if (!entity) {
      throw ctx.fail('lei_not_found', `No GLEIF entity with LEI "${params.lei}".`, {
        ...ctx.recoveryFor('lei_not_found'),
      });
    }
    return entity;
  },
});
