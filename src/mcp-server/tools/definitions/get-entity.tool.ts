/**
 * @fileoverview `sanctions_get_entity` — the full GLEIF Level 1 record for one
 * LEI, plus any sanctions hits screened against the same legal name. Combines
 * the who-is-who reference data with a cross-reference screen so an agent sees
 * both "who is this entity" and "is its name on a watchlist" in one call.
 * @module mcp-server/tools/definitions/get-entity.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_CODES, SOURCE_LABELS } from '@/services/screening/types.js';
import { SCREENING_CAVEAT } from './_shared.js';

const LEI_RE = /^[A-Z0-9]{18}[0-9]{2}$/;

export const getEntityTool = tool('sanctions_get_entity', {
  title: 'sanctions-screening-mcp-server: get entity',
  description:
    'Fetch the full GLEIF Level 1 record for one LEI: legal name, other/trading names, legal and headquarters addresses, registration status, jurisdiction, registration authority and ID, and last-update date — plus any sanctions hits screened against the same legal name across all loaded watchlists. The screening cross-reference is a screening AID: a hit is a candidate to verify against the official source, and no hit is not a clearance. LEI must be a 20-character GLEIF identifier (18 alphanumerics + 2 check digits).',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    lei: z
      .string()
      .regex(
        LEI_RE,
        'LEI must be 20 chars: 18 alphanumerics + 2 check digits (e.g. 5493001KJTIIGC8Y1R12).',
      )
      .describe('The 20-character GLEIF Legal Entity Identifier to look up.'),
  }),
  output: z.object({
    lei: z.string().describe('The 20-character GLEIF Legal Entity Identifier.'),
    legalName: z.string().describe('Registered legal name.'),
    otherNames: z.array(z.string()).describe('Other / trading names published in the LEI record.'),
    jurisdiction: z.string().optional().describe('Legal jurisdiction (ISO code), when published.'),
    status: z.string().optional().describe('Registration status (e.g. ISSUED, LAPSED).'),
    legalAddress: z.string().optional().describe('Single-line legal address, when published.'),
    headquartersAddress: z
      .string()
      .optional()
      .describe('Single-line headquarters address, when published.'),
    registrationAuthorityId: z
      .string()
      .optional()
      .describe('Registration authority (RA) code, when published.'),
    registrationAuthorityEntityId: z
      .string()
      .optional()
      .describe("The entity's ID at its registration authority, when published."),
    lastUpdate: z
      .string()
      .optional()
      .describe('ISO 8601 last-update timestamp from the LEI record.'),
    sanctionsHits: z
      .array(
        z
          .object({
            source: z
              .enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un'])
              .describe('Watchlist the candidate is on.'),
            sourceLabel: z.string().describe('Human-readable source list name.'),
            sourceEntryId: z
              .string()
              .describe('Source entry ID — pass to sanctions_get_designation.'),
            primaryName: z.string().describe('Primary published name of the designation.'),
            matchedName: z
              .string()
              .describe("The name/alias that matched the entity's legal name."),
            matchType: z
              .enum(['exact', 'strong', 'approximate'])
              .describe('exact / strong / approximate match classification.'),
            score: z
              .number()
              .optional()
              .describe('Raw Jaro-Winkler similarity (0–1) for approximate hits only.'),
          })
          .describe(
            "A potential watchlist match on the entity's legal name — verify, do not assume.",
          ),
      )
      .describe("Sanctions screening cross-reference on the entity's legal name."),
    caveat: z
      .string()
      .describe(
        'Decision-support caveat — the screening cross-reference is an aid, not a determination.',
      ),
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

  async handler(input, ctx) {
    const svc = getScreeningService();
    if (!(await svc.leiReady())) {
      throw ctx.fail('mirror_not_ready', 'The local GLEIF (LEI) mirror is not yet populated.', {
        ...ctx.recoveryFor('mirror_not_ready'),
      });
    }

    const entity = await svc.getLeiEntity(input.lei);
    if (!entity) {
      throw ctx.fail('lei_not_found', `No GLEIF entity with LEI "${input.lei}".`, {
        ...ctx.recoveryFor('lei_not_found'),
      });
    }

    // Cross-reference screen on the legal name — only when the sanctions mirror is ready.
    let sanctionsHits: Awaited<ReturnType<typeof svc.screenName>>['hits'] = [];
    if (await svc.sanctionsReady()) {
      const screen = await svc.screenName(
        {
          query: entity.legalName,
          entityType: 'any',
          matchMode: 'strict',
          // Cross-reference screen: strict only. Auto-fuzzy on a generic legal
          // name floods the result with single-common-token false positives.
          autoFallback: false,
          sources: [...SOURCE_CODES],
          limit: 25,
        },
        ctx,
      );
      sanctionsHits = screen.hits;
    }

    return {
      lei: entity.lei,
      legalName: entity.legalName,
      otherNames: entity.otherNames,
      ...(entity.jurisdiction ? { jurisdiction: entity.jurisdiction } : {}),
      ...(entity.status ? { status: entity.status } : {}),
      ...(entity.legalAddress ? { legalAddress: entity.legalAddress } : {}),
      ...(entity.headquartersAddress ? { headquartersAddress: entity.headquartersAddress } : {}),
      ...(entity.registrationAuthorityId
        ? { registrationAuthorityId: entity.registrationAuthorityId }
        : {}),
      ...(entity.registrationAuthorityEntityId
        ? { registrationAuthorityEntityId: entity.registrationAuthorityEntityId }
        : {}),
      ...(entity.lastUpdate ? { lastUpdate: entity.lastUpdate } : {}),
      sanctionsHits: sanctionsHits.map((h) => ({
        source: h.source,
        sourceLabel: SOURCE_LABELS[h.source],
        sourceEntryId: h.sourceEntryId,
        primaryName: h.primaryName,
        matchedName: h.matchedName,
        matchType: h.matchType,
        ...(h.score !== undefined ? { score: h.score } : {}),
      })),
      caveat: SCREENING_CAVEAT,
    };
  },

  format: (r) => {
    const lines = [`# ${r.legalName}`, '', `**LEI:** \`${r.lei}\``];
    if (r.otherNames.length > 0) lines.push(`**Other names:** ${r.otherNames.join('; ')}`);
    if (r.jurisdiction) lines.push(`**Jurisdiction:** ${r.jurisdiction}`);
    if (r.status) lines.push(`**Registration status:** ${r.status}`);
    if (r.legalAddress) lines.push(`**Legal address:** ${r.legalAddress}`);
    if (r.headquartersAddress) lines.push(`**HQ address:** ${r.headquartersAddress}`);
    if (r.registrationAuthorityId) {
      lines.push(
        `**Registration authority:** ${r.registrationAuthorityId}${r.registrationAuthorityEntityId ? ` (entity ${r.registrationAuthorityEntityId})` : ''}`,
      );
    }
    if (r.lastUpdate) lines.push(`**Last update:** ${r.lastUpdate}`);

    lines.push('\n## Sanctions screening cross-reference');
    if (r.sanctionsHits.length === 0) {
      lines.push('No potential watchlist matches on the legal name (NOT a clearance).');
    } else {
      for (const h of r.sanctionsHits) {
        const scoreStr = h.score !== undefined ? ` · score ${h.score.toFixed(3)}` : '';
        lines.push(
          `- **${h.primaryName}** — ${h.sourceLabel} (\`${h.source}\`, entry ${h.sourceEntryId}), ${h.matchType}${scoreStr}, matched "${h.matchedName}"`,
        );
      }
    }
    lines.push(`\n> ${r.caveat}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
