/**
 * @fileoverview `sanctions_screen_identifier` — the identifier-first entry point.
 * Maritime, payment, and crypto screening start from an IMO number, a SWIFT/BIC
 * code, a wallet address, or a document number rather than a name; this looks
 * one up exactly, after normalization, against every loaded list's published
 * identifiers. No score: two identifiers are equal or they are not. Still
 * decision support, NOT a compliance determination — a hit is a candidate to
 * verify, and an empty result is never a clearance.
 * @module mcp-server/tools/definitions/screen-identifier.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { identifierProbes } from '@/services/screening/identifier-matching.js';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_CODES, SOURCE_LABELS } from '@/services/screening/types.js';
import { SCREENING_CAVEAT } from './_shared.js';

const SOURCE_ENUM = z.enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un']);

const MatchedIdentifierSchema = z
  .object({
    type: z
      .string()
      .describe(
        'Identifier label as the list publishes it (e.g. Vessel Registration Identification, IMO Number, SWIFT BIC, Digital Currency Address - ETH, Passport).',
      ),
    value: z.string().describe('Identifier value exactly as published, letter case included.'),
    country: z.string().optional().describe('Issuing country/authority, when published.'),
  })
  .describe('One published identifier that matched the lookup.');

const HitSchema = z
  .object({
    source: SOURCE_ENUM.describe('Which watchlist this candidate is on — its provenance.'),
    sourceLabel: z.string().describe('Human-readable name of the source list.'),
    sourceEntryId: z
      .string()
      .describe("The list's own entry ID — pass to sanctions_get_designation for the full record."),
    primaryName: z.string().describe('Primary published name of the designated entity.'),
    entityType: z
      .enum(['person', 'organization', 'vessel', 'aircraft', 'unknown'])
      .describe('Entity classification as published by the source.'),
    program: z
      .string()
      .optional()
      .describe('Sanctioning program / regime, when published by the source.'),
    matchedIdentifiers: z
      .array(MatchedIdentifierSchema)
      .describe(
        'Every identifier this designation publishes that matched, as published — several when the list prints one number more than one way.',
      ),
  })
  .describe('One designation that publishes a matching identifier — a candidate to verify.');

export const screenIdentifierTool = tool('sanctions_screen_identifier', {
  title: 'sanctions-screening-mcp-server: screen identifier',
  description:
    'Look up an identifier — a vessel IMO number, a SWIFT/BIC code, a digital-currency wallet address, a passport or national ID number, or any other identifier a list publishes — against all loaded sanctions watchlists at once: OFAC SDN + Consolidated, EU, UK, and UN. Exact match after normalization, with no fuzzy or partial matching and no score: spacing, letter case, and the separators - . / are ignored, an IMO number matches with or without its IMO prefix, a SWIFT/BIC code compares on its first eight characters so a branch code matches its institution, and a wallet address folds case only where its encoding is case-insensitive (hex, bech32, cashaddr — never base58). Returns every designation that publishes a matching identifier, one per designation, with the identifiers that matched as published; sanctions_get_designation pulls the full record. This is a screening AID for a human/compliance review, NOT a compliance determination: a hit means "review this candidate against the official source," and an empty result never means "cleared" — an identifier a list prints only in free-text remarks, or bundled with other numbers in one field, does not match.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    value: z
      .string()
      .min(1)
      .describe(
        'The identifier to look up, as you hold it (e.g. "IMO 7406784", "DCBKKPPY", a wallet address, a passport number). Must contain at least one character other than whitespace and - . /',
      ),
    type: z
      .enum(['any', 'imo', 'swift_bic', 'digital_currency_address', 'passport', 'national_id'])
      .default('any')
      .describe(
        'Restrict to one identifier category, matched on the label each list publishes, or "any" (default) to search every published identifier, including categories with no name here (MMSI, call signs, tail numbers, tax and registration numbers, email, websites).',
      ),
    sources: z
      .array(SOURCE_ENUM)
      .optional()
      .describe('Restrict to specific source lists. Omit to search all loaded lists.'),
  }),
  output: z.object({
    hits: z
      .array(HitSchema)
      .describe(
        'Designations that publish a matching identifier, one per designation, ordered by source list then entry ID. Not paged — the most widely shared published identifiers map to about a dozen designations.',
      ),
    caveat: z
      .string()
      .describe(
        'Decision-support caveat — this is a screening aid, not a compliance determination.',
      ),
  }),
  enrichment: {
    totalCount: z.number().describe('Number of designations returned.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no designation matched — what to try next, and what an empty result does NOT mean.',
      ),
  },
  errors: [
    {
      reason: 'identifier_not_searchable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The value is left with nothing to compare once whitespace and the separators - . / are removed (or, for type imo, a bare IMO prefix).',
      recovery:
        'Pass the identifier itself — letters or digits, not only spaces and separators such as - . /',
    },
    {
      reason: 'mirror_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The sanctions mirror has never completed an initial sync.',
      retryable: true,
      recovery:
        'Run the mirror:init lifecycle script to load the sanctions lists, then retry; check sanctions_list_sources for readiness.',
    },
  ],

  async handler(input, ctx) {
    if (identifierProbes(input.value, input.type).length === 0) {
      throw ctx.fail(
        'identifier_not_searchable',
        `"${input.value}" has nothing left to compare once whitespace and separators are removed${input.type === 'any' ? '' : ` (type: ${input.type})`}.`,
        { ...ctx.recoveryFor('identifier_not_searchable') },
      );
    }
    const svc = getScreeningService();
    if (!(await svc.sanctionsReady())) {
      throw ctx.fail('mirror_not_ready', 'The local sanctions mirror is not yet populated.', {
        ...ctx.recoveryFor('mirror_not_ready'),
      });
    }

    const sources = input.sources && input.sources.length > 0 ? input.sources : [...SOURCE_CODES];
    const hits = await svc.screenIdentifier({ value: input.value, type: input.type, sources });
    ctx.enrich.total(hits.length);
    if (hits.length === 0) {
      ctx.enrich.notice(
        `No designation on the selected lists publishes an identifier matching "${input.value}" (type: ${input.type}). ` +
          'This is NOT a clearance — a list may print the identifier only in free-text remarks, bundle it with other numbers in one field, or file it under another label' +
          `${input.type === 'any' ? '' : ' (retry with type "any")'}. ` +
          "Screen the holder's name with sanctions_screen_name, or verify directly against the official source.",
      );
    }

    return {
      hits: hits.map((h) => ({
        source: h.source,
        sourceLabel: SOURCE_LABELS[h.source],
        sourceEntryId: h.sourceEntryId,
        primaryName: h.primaryName,
        entityType: h.entityType,
        ...(h.program ? { program: h.program } : {}),
        matchedIdentifiers: h.matchedIdentifiers,
      })),
      caveat: SCREENING_CAVEAT,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.hits.length === 0) {
      lines.push('**No designation publishes a matching identifier.**');
    } else {
      lines.push(
        `**${result.hits.length} designation(s) publish a matching identifier** — candidates to verify, not determinations:\n`,
      );
      for (const h of result.hits) {
        lines.push(`### ${h.primaryName}`);
        lines.push(
          `**List:** ${h.sourceLabel} (\`${h.source}\`) | **Entry ID:** ${h.sourceEntryId} | **Type:** ${h.entityType}`,
        );
        if (h.program) lines.push(`**Program:** ${h.program}`);
        lines.push('**Matched identifiers:**');
        for (const i of h.matchedIdentifiers) {
          lines.push(`- **${i.type}:** ${i.value}${i.country ? ` (${i.country})` : ''}`);
        }
        lines.push('');
      }
    }
    lines.push(`> ${result.caveat}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
