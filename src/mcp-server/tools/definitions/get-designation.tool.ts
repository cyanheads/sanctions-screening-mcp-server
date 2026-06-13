/**
 * @fileoverview `sanctions_get_designation` — the full record for one sanctions
 * entry by source list + entry ID. The drill-in after sanctions_screen_name
 * surfaces a candidate: all aliases, identifiers, addresses, dates/places of
 * birth, nationalities, program, legal basis, and designation date. Still a
 * screening aid — the record is what the source published, not a determination.
 * @module mcp-server/tools/definitions/get-designation.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_LABELS, type SourceCode } from '@/services/screening/types.js';
import { SCREENING_CAVEAT } from './_shared.js';

export const getDesignationTool = tool('sanctions_get_designation', {
  title: 'sanctions-screening-mcp-server: get designation',
  description:
    'Fetch the full record for one sanctions designation by source list + entry ID — the drill-in after sanctions_screen_name surfaces a candidate. Returns all published aliases, identifiers (passport/national-ID/tax), addresses, dates and places of birth, nationalities, sanctioning program, legal basis, and designation date. The record reflects exactly what the source published; missing fields mean the source omitted them. This is a screening aid — the designation record supports a compliance review, it is not itself a determination.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    source: z
      .enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un'])
      .describe('Which source list the entry belongs to.'),
    entryId: z
      .string()
      .min(1)
      .describe("The source list's own entry ID (the sourceEntryId from sanctions_screen_name)."),
  }),
  output: z.object({
    source: z
      .enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un'])
      .describe('Source list the entry belongs to.'),
    sourceLabel: z.string().describe('Human-readable name of the source list.'),
    sourceEntryId: z.string().describe("The source list's own entry ID."),
    entityType: z
      .enum(['person', 'organization', 'vessel', 'aircraft', 'unknown'])
      .describe('Entity classification as published.'),
    primaryName: z.string().describe('Primary published name.'),
    program: z.string().optional().describe('Sanctioning program / regime, when published.'),
    legalBasis: z.string().optional().describe('Statutory / regulatory basis, when published.'),
    designationDate: z.string().optional().describe('Designation date, when published.'),
    aliases: z
      .array(
        z
          .object({
            name: z.string().describe('Alias as published.'),
            nameType: z
              .enum(['primary', 'aka', 'fka', 'low-quality-aka'])
              .describe('Alias provenance: a.k.a., f.k.a., or a low-quality a.k.a.'),
          })
          .describe('One published alias.'),
      )
      .describe('All published aliases / name variants.'),
    identifiers: z
      .array(
        z
          .object({
            type: z.string().describe('Identifier category (e.g. Passport, National ID, Tax ID).'),
            value: z.string().describe('Identifier value as published.'),
            country: z.string().optional().describe('Issuing country/authority, when published.'),
          })
          .describe('One structured identifier.'),
      )
      .describe('Published identifiers (passport, national ID, tax, registration, …).'),
    addresses: z
      .array(
        z
          .object({
            full: z.string().describe('Single-line rendering of the address.'),
            country: z.string().optional().describe('Country, when published.'),
          })
          .describe('One published address.'),
      )
      .describe('Published addresses.'),
    datesOfBirth: z
      .array(
        z
          .object({
            date: z.string().optional().describe('Date of birth as published.'),
            place: z.string().optional().describe('Place of birth, when published.'),
          })
          .describe('One date/place of birth.'),
      )
      .describe('Published dates and places of birth (persons).'),
    nationalities: z.array(z.string()).describe('Published nationalities / citizenships.'),
    remarks: z
      .string()
      .optional()
      .describe('Free-form remarks published by the source, when present.'),
    caveat: z
      .string()
      .describe(
        'Decision-support caveat — this is a screening aid, not a compliance determination.',
      ),
  }),
  errors: [
    {
      reason: 'designation_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No designation exists for the given source + entry ID in the mirror.',
      recovery:
        'Verify the source and entryId via sanctions_screen_name, which returns the exact sourceEntryId for each hit.',
    },
    {
      reason: 'mirror_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The sanctions mirror has never completed an initial sync.',
      retryable: true,
      recovery: 'Run the mirror:init lifecycle script to load the sanctions lists, then retry.',
    },
  ],

  async handler(input, ctx) {
    const svc = getScreeningService();
    if (!(await svc.sanctionsReady())) {
      throw ctx.fail('mirror_not_ready', 'The local sanctions mirror is not yet populated.', {
        ...ctx.recoveryFor('mirror_not_ready'),
      });
    }

    const d = await svc.getDesignation(input.source as SourceCode, input.entryId);
    if (!d) {
      throw ctx.fail(
        'designation_not_found',
        `No ${input.source} designation with entry ID "${input.entryId}".`,
        { ...ctx.recoveryFor('designation_not_found') },
      );
    }

    return {
      source: d.source,
      sourceLabel: SOURCE_LABELS[d.source],
      sourceEntryId: d.sourceEntryId,
      entityType: d.entityType,
      primaryName: d.primaryName,
      ...(d.program ? { program: d.program } : {}),
      ...(d.legalBasis ? { legalBasis: d.legalBasis } : {}),
      ...(d.designationDate ? { designationDate: d.designationDate } : {}),
      aliases: d.payload.aliases,
      identifiers: d.payload.identifiers,
      addresses: d.payload.addresses,
      datesOfBirth: d.payload.datesOfBirth,
      nationalities: d.payload.nationalities,
      ...(d.payload.remarks ? { remarks: d.payload.remarks } : {}),
      caveat: SCREENING_CAVEAT,
    };
  },

  format: (r) => {
    const lines = [`# ${r.primaryName}`, ''];
    lines.push(`**List:** ${r.sourceLabel} (\`${r.source}\`) | **Entry ID:** ${r.sourceEntryId}`);
    lines.push(`**Type:** ${r.entityType}`);
    if (r.program) lines.push(`**Program:** ${r.program}`);
    if (r.legalBasis) lines.push(`**Legal basis:** ${r.legalBasis}`);
    if (r.designationDate) lines.push(`**Designated:** ${r.designationDate}`);

    if (r.aliases.length > 0) {
      lines.push('\n## Aliases');
      for (const a of r.aliases) lines.push(`- ${a.name} (${a.nameType})`);
    }
    if (r.identifiers.length > 0) {
      lines.push('\n## Identifiers');
      for (const i of r.identifiers) {
        lines.push(`- **${i.type}:** ${i.value}${i.country ? ` (${i.country})` : ''}`);
      }
    }
    if (r.addresses.length > 0) {
      lines.push('\n## Addresses');
      for (const a of r.addresses) lines.push(`- ${a.full}${a.country ? ` — ${a.country}` : ''}`);
    }
    if (r.datesOfBirth.length > 0) {
      lines.push('\n## Dates of birth');
      for (const d of r.datesOfBirth) {
        lines.push(`- ${d.date ?? 'Unknown date'}${d.place ? ` at ${d.place}` : ''}`);
      }
    }
    if (r.nationalities.length > 0)
      lines.push(`\n**Nationalities:** ${r.nationalities.join(', ')}`);
    if (r.remarks) lines.push(`\n**Remarks:** ${r.remarks}`);
    lines.push(`\n> ${r.caveat}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
