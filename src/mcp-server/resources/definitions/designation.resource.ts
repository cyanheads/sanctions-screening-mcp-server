/**
 * @fileoverview `sanctions://designation/{source}/{entryId}` — read-only mirror
 * of sanctions_get_designation for clients that inject context by URI. All data
 * here is reachable via the tool, which is the primary path for tool-only
 * clients.
 * @module mcp-server/resources/definitions/designation.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { SCREENING_CAVEAT } from '@/mcp-server/tools/definitions/_shared.js';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_LABELS, type SourceCode } from '@/services/screening/types.js';

export const designationResource = resource('sanctions://designation/{source}/{entryId}', {
  name: 'sanctions-screening-mcp-server: designation',
  title: 'sanctions-screening-mcp-server: designation',
  description:
    'Fetch one sanctions designation by source list + entry ID — a read-only URI mirror of sanctions_get_designation. The record is what the source published; a screening aid, not a determination.',
  mimeType: 'application/json',
  params: z.object({
    source: z
      .enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un'])
      .describe('Source list the entry belongs to.'),
    entryId: z.string().min(1).describe("The source list's own entry ID."),
  }),
  errors: [
    {
      reason: 'designation_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No designation exists for the given source + entry ID in the mirror.',
      recovery: 'Use sanctions_screen_name to discover valid source/entryId pairs first.',
    },
  ],

  async handler(params, ctx) {
    const svc = getScreeningService();
    const d = await svc.getDesignation(params.source as SourceCode, params.entryId);
    if (!d) {
      throw ctx.fail(
        'designation_not_found',
        `No ${params.source} designation with entry ID "${params.entryId}".`,
        { ...ctx.recoveryFor('designation_not_found') },
      );
    }
    return {
      source: d.source,
      sourceLabel: SOURCE_LABELS[d.source],
      sourceEntryId: d.sourceEntryId,
      entityType: d.entityType,
      primaryName: d.primaryName,
      program: d.program,
      legalBasis: d.legalBasis,
      designationDate: d.designationDate,
      aliases: d.payload.aliases,
      identifiers: d.payload.identifiers,
      addresses: d.payload.addresses,
      datesOfBirth: d.payload.datesOfBirth,
      nationalities: d.payload.nationalities,
      remarks: d.payload.remarks,
      caveat: SCREENING_CAVEAT,
    };
  },
});
