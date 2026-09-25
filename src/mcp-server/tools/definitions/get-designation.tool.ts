/**
 * @fileoverview `sanctions_get_designation` — the full record for one sanctions
 * entry by source list + entry ID or published reference number. The drill-in
 * after sanctions_screen_name surfaces a candidate: all aliases, identifiers,
 * addresses, dates/places of birth, nationalities, program, legal basis, and
 * designation date. Still a screening aid — the record is what the source
 * published, not a determination.
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
    "Fetch the full record for one sanctions designation by source list + entry ID or the list's published reference number — the drill-in after sanctions_screen_name or sanctions_screen_identifier surfaces a candidate, or the lookup for a reference a notice cites (UN QDe.004, EU EU.27.28, UK OFSI Group ID). Returns all published aliases, identifiers (passport, national ID, tax and registration numbers, SWIFT/BIC codes, digital-currency addresses, vessel call signs, aircraft tail and serial numbers, phone numbers, email addresses, websites), addresses, dates and places of birth at the precision the source published, nationalities, sanctioning program, legal basis, and designation date. The record reflects exactly what the source published; missing fields mean the source omitted them. This is a screening aid — the designation record supports a compliance review, it is not itself a determination.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    source: z
      .enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un'])
      .describe('Which source list the entry belongs to.'),
    entryId: z
      .string()
      .min(1)
      .describe(
        "The source list's own entry ID (the sourceEntryId from sanctions_screen_name), or the reference number the list publishes for the entry (UN QDe.004, EU EU.27.28, UK OFSI Group ID 14196). Matched trimmed and case-insensitive, entry ID first.",
      ),
  }),
  output: z.object({
    source: z
      .enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un'])
      .describe('Source list the entry belongs to.'),
    sourceLabel: z.string().describe('Human-readable name of the source list.'),
    sourceEntryId: z.string().describe("The source list's own entry ID."),
    referenceNumber: z
      .string()
      .optional()
      .describe(
        "The list's published reference number (UN, EU, UK OFSI Group ID); absent when the list publishes none for the entry. OFAC publishes none — its entry ID is its published number.",
      ),
    entityType: z
      .enum(['person', 'organization', 'vessel', 'aircraft', 'unknown'])
      .describe('Entity classification as published.'),
    primaryName: z.string().describe('Primary published name.'),
    program: z.string().optional().describe('Sanctioning program / regime, when published.'),
    legalBasis: z.string().optional().describe('Statutory / regulatory basis, when published.'),
    designationDate: z
      .string()
      .optional()
      .describe("The source's own designation date as YYYY-MM-DD; absent when unpublished."),
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
            type: z
              .string()
              .describe(
                'Identifier category as the source labels it (e.g. Passport, National ID, SWIFT/BIC, Digital Currency Address - XBT, Phone Number, Website).',
              ),
            value: z
              .string()
              .describe('Identifier value exactly as published, letter case included.'),
            country: z.string().optional().describe('Issuing country/authority, when published.'),
          })
          .describe('One structured identifier.'),
      )
      .describe(
        'Published identifiers: identity documents (passport, national ID, tax, registration) and, where the source publishes them, SWIFT/BIC codes, digital-currency addresses, vessel call signs, aircraft tail and serial numbers, phone numbers, email addresses, and websites.',
      ),
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
            date: z
              .string()
              .optional()
              .describe(
                'Date of birth in ISO 8601 at the precision the source published: YYYY-MM-DD, YYYY-MM, or YYYY. A range is an interval whose ends keep their own precision (1955/1957); an open end is .. (../1980). A value with no ISO form is kept as published.',
              ),
            circa: z
              .literal(true)
              .optional()
              .describe(
                'Present when the source flags the date as approximate; never without date.',
              ),
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
      when: 'No designation in the given source has that entry ID or reference number in the mirror.',
      recovery:
        'Verify the source and entryId via sanctions_screen_name, which returns the exact sourceEntryId for each hit.',
    },
    {
      reason: 'reference_ambiguous',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The entry ID is a reference number more than one designation in the source publishes.',
      recovery:
        'Call again with one of the sourceEntryIds this error names; each one identifies a single designation.',
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

    const lookup = await svc.resolveDesignation(input.source as SourceCode, input.entryId);
    if (lookup.kind === 'ambiguous') {
      throw ctx.fail(
        'reference_ambiguous',
        `Reference number "${input.entryId.trim()}" is published by ${lookup.sourceEntryIds.length} ${input.source} designations: ${lookup.sourceEntryIds.join(', ')}.`,
        { sourceEntryIds: lookup.sourceEntryIds, ...ctx.recoveryFor('reference_ambiguous') },
      );
    }
    if (lookup.kind === 'not_found') {
      throw ctx.fail(
        'designation_not_found',
        `No ${input.source} designation with entry ID or reference number "${input.entryId}".`,
        { ...ctx.recoveryFor('designation_not_found') },
      );
    }

    const d = lookup.designation;
    return {
      source: d.source,
      sourceLabel: SOURCE_LABELS[d.source],
      sourceEntryId: d.sourceEntryId,
      ...(d.referenceNumber ? { referenceNumber: d.referenceNumber } : {}),
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
    lines.push(
      `**List:** ${r.sourceLabel} (\`${r.source}\`) | **Entry ID:** ${r.sourceEntryId}${r.referenceNumber ? ` | **Reference:** ${r.referenceNumber}` : ''}`,
    );
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
      // A normalized address renders its country as its last component; name the
      // country separately only when it is not that component.
      for (const a of r.addresses) {
        const inFull = a.full === a.country || a.full.endsWith(`, ${a.country}`);
        lines.push(`- ${a.full}${a.country && !inFull ? ` — ${a.country}` : ''}`);
      }
    }
    if (r.datesOfBirth.length > 0) {
      lines.push('\n## Dates of birth');
      // Render only what the entry publishes: a source that lists dates and places
      // separately yields date-only and place-only entries.
      for (const d of r.datesOfBirth) {
        if (d.date) {
          lines.push(`- ${d.circa ? 'circa ' : ''}${d.date}${d.place ? ` at ${d.place}` : ''}`);
        } else if (d.place) lines.push(`- Born in ${d.place}`);
      }
    }
    if (r.nationalities.length > 0)
      lines.push(`\n**Nationalities:** ${r.nationalities.join(', ')}`);
    if (r.remarks) lines.push(`\n**Remarks:** ${r.remarks}`);
    lines.push(`\n> ${r.caveat}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
