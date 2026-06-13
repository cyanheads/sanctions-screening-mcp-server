/**
 * @fileoverview `sanctions_screen_name` — the 80% entry point. Screens a name
 * against all loaded watchlists (OFAC SDN + Consolidated, EU, UK, UN) at once,
 * alias- and fuzzy-aware, and returns scored potential matches with source
 * provenance. This is decision support, NOT a compliance determination: a hit is
 * a candidate to verify against the official source, and an empty result is
 * never a clearance.
 * @module mcp-server/tools/definitions/screen-name.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_CODES, SOURCE_LABELS } from '@/services/screening/types.js';
import { SCREENING_CAVEAT } from './_shared.js';

const SOURCE_ENUM = z.enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un']);

const HitSchema = z
  .object({
    source: SOURCE_ENUM.describe('Which watchlist this candidate is on — its provenance.'),
    sourceLabel: z.string().describe('Human-readable name of the source list.'),
    sourceEntryId: z
      .string()
      .describe("The list's own entry ID — pass to sanctions_get_designation for the full record."),
    entityType: z
      .enum(['person', 'organization', 'vessel', 'aircraft', 'unknown'])
      .describe('Entity classification as published by the source.'),
    primaryName: z.string().describe('Primary published name of the designated entity.'),
    matchedName: z.string().describe('The specific name or alias string that matched the query.'),
    matchedNameType: z
      .enum(['primary', 'aka', 'fka', 'low-quality-aka'])
      .describe('Provenance of the matched name: primary, a.k.a., f.k.a., or a low-quality a.k.a.'),
    matchType: z
      .enum(['exact', 'strong', 'approximate'])
      .describe(
        'exact = normalized name equality; strong = all query tokens present; approximate = fuzzy/phonetic.',
      ),
    score: z
      .number()
      .optional()
      .describe(
        'Raw Jaro-Winkler similarity (0–1) for approximate hits only — a real measurement, not a confidence verdict. Absent for exact/strong hits.',
      ),
    program: z
      .string()
      .optional()
      .describe('Sanctioning program / regime, when published by the source.'),
    designationDate: z
      .string()
      .optional()
      .describe('Designation date as published, when available.'),
  })
  .describe('One potential match — a candidate to verify, never a determination.');

export const screenNameTool = tool('sanctions_screen_name', {
  title: 'sanctions-screening-mcp-server: screen name',
  description:
    'Screen a name (person, company, vessel, aircraft) against all loaded sanctions watchlists at once — OFAC SDN + Consolidated, EU, UK, and UN — alias- and fuzzy-aware. Returns scored potential matches with the source list, sanctioning program, designation date, and the matched alias. Strict mode (default) matches exact-normalized then all-tokens-present; fuzzy mode (or auto when strict is empty) adds Jaro-Winkler and phonetic matching and labels hits approximate with a raw 0–1 similarity score. This is a screening AID for a human/compliance review, NOT a compliance determination: a hit means "review this candidate against the official source," and an empty result never means "cleared."',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    name: z
      .string()
      .min(1)
      .describe('The name to screen (person, organization, vessel, or aircraft).'),
    entityType: z
      .enum(['any', 'person', 'organization', 'vessel', 'aircraft'])
      .default('any')
      .describe('Restrict to one entity class, or "any" (default) to screen across all.'),
    matchMode: z
      .enum(['strict', 'fuzzy'])
      .default('strict')
      .describe(
        'strict (default): exact-normalized then all-tokens-present. fuzzy: also scored Jaro-Winkler + phonetic. Strict auto-falls-back to fuzzy when it finds nothing.',
      ),
    minScore: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Jaro-Winkler similarity floor for fuzzy hits (0–1). Applies to fuzzy mode only; defaults to the server's configured floor.",
      ),
    sources: z
      .array(SOURCE_ENUM)
      .optional()
      .describe('Restrict to specific source lists. Omit to screen all loaded lists.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum number of potential matches to return.'),
  }),
  output: z.object({
    hits: z.array(HitSchema).describe('Scored potential matches, highest-confidence first.'),
    caveat: z
      .string()
      .describe(
        'Decision-support caveat — this is a screening aid, not a compliance determination.',
      ),
  }),
  enrichment: {
    normalizedQuery: z.string().describe('The name as the server folded it for matching.'),
    matchModeUsed: z
      .string()
      .describe('The match mode actually applied (strict may auto-upgrade to fuzzy on empty).'),
    totalCount: z.number().describe('Number of potential matches returned.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no candidate matched — how to broaden, and what an empty result does NOT mean.',
      ),
  },
  errors: [
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
    const svc = getScreeningService();
    if (!(await svc.sanctionsReady())) {
      throw ctx.fail('mirror_not_ready', 'The local sanctions mirror is not yet populated.', {
        ...ctx.recoveryFor('mirror_not_ready'),
      });
    }

    const sources = input.sources && input.sources.length > 0 ? input.sources : [...SOURCE_CODES];
    const result = await svc.screenName(
      {
        query: input.name,
        entityType: input.entityType,
        matchMode: input.matchMode,
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        sources,
        limit: input.limit,
      },
      ctx,
    );

    ctx.enrich({ normalizedQuery: result.normalizedQuery, matchModeUsed: result.modeUsed });
    ctx.enrich.total(result.hits.length);
    if (result.hits.length === 0) {
      ctx.enrich.notice(
        `No potential match for "${input.name}" across the selected lists (mode: ${result.modeUsed}). ` +
          'This is NOT a clearance — the entity may be listed under a name variant the mirror does not index, ' +
          'or under a transliteration. Try matchMode:"fuzzy", a broader name, or verify directly against the official source.',
      );
    }

    return {
      hits: result.hits.map((h) => ({
        source: h.source,
        sourceLabel: SOURCE_LABELS[h.source],
        sourceEntryId: h.sourceEntryId,
        entityType: h.entityType,
        primaryName: h.primaryName,
        matchedName: h.matchedName,
        matchedNameType: h.matchedNameType,
        matchType: h.matchType,
        ...(h.score !== undefined ? { score: h.score } : {}),
        ...(h.program ? { program: h.program } : {}),
        ...(h.designationDate ? { designationDate: h.designationDate } : {}),
      })),
      caveat: SCREENING_CAVEAT,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.hits.length === 0) {
      lines.push('**No potential matches found.**');
    } else {
      lines.push(
        `**${result.hits.length} potential match(es)** — candidates to verify, not determinations:\n`,
      );
      for (const h of result.hits) {
        const scoreStr = h.score !== undefined ? ` · score ${h.score.toFixed(3)}` : '';
        lines.push(`### ${h.primaryName} — ${h.matchType}${scoreStr}`);
        lines.push(
          `**List:** ${h.sourceLabel} (\`${h.source}\`) | **Entry ID:** ${h.sourceEntryId} | **Type:** ${h.entityType}`,
        );
        lines.push(`**Matched on:** "${h.matchedName}" (${h.matchedNameType})`);
        if (h.program) lines.push(`**Program:** ${h.program}`);
        if (h.designationDate) lines.push(`**Designated:** ${h.designationDate}`);
        lines.push('');
      }
    }
    lines.push(`> ${result.caveat}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
