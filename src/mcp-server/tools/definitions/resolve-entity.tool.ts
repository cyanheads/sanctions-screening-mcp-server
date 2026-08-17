/**
 * @fileoverview `sanctions_resolve_entity` — resolves a company/organization
 * name (+ optional jurisdiction) to candidate GLEIF LEIs, ranked. The bridge
 * from a free-text counterparty name to a stable global identifier other tools
 * key off. Decision support: candidates to confirm, not an authoritative
 * identification.
 * @module mcp-server/tools/definitions/resolve-entity.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getScreeningService } from '@/services/screening/screening-service.js';

export const resolveEntityTool = tool('sanctions_resolve_entity', {
  title: 'sanctions-screening-mcp-server: resolve entity',
  description:
    'Resolve a company or organization name (with an optional ISO 3166-1 alpha-2 jurisdiction) to candidate GLEIF Legal Entity Identifiers (LEIs), ranked. This turns a free-text counterparty name into a stable global identifier that sanctions_get_entity and sanctions_trace_ownership key off. Strict mode (default) matches exact-normalized then all-tokens-present; fuzzy mode (or auto when strict is empty) adds Jaro-Winkler scoring labeled approximate with a raw 0–1 score. Results are paged: totalAvailable and hasMore report candidates beyond the returned page, and nextOffset retrieves them. Returns potential matches to confirm against the GLEIF record — name resolution is a candidate ranking, not an authoritative identification.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    name: z.string().min(1).describe('The company / organization name to resolve to an LEI.'),
    jurisdiction: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2 code (e.g. US, GB)')
          .describe('ISO 3166-1 alpha-2 jurisdiction code (e.g. US, GB).'),
      ])
      .optional()
      .describe(
        'Optional ISO 3166-1 alpha-2 jurisdiction filter (e.g. "US", "GB"). Empty string disables it.',
      ),
    matchMode: z
      .enum(['strict', 'fuzzy'])
      .default('strict')
      .describe(
        'strict (default): exact then all-tokens-present. fuzzy: also scored Jaro-Winkler.',
      ),
    status: z
      .enum(['any', 'issued', 'lapsed'])
      .default('issued')
      .describe('Registration status filter: issued (default), lapsed, or any.'),
    minScore: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Jaro-Winkler floor for fuzzy hits (0–1); defaults to the server's configured floor.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum LEI candidates to return in one page.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first LEI candidate to return. Re-call with the returned nextOffset to page through every candidate when hasMore is true; an offset past the end returns an empty page, not an error.',
      ),
  }),
  output: z.object({
    matches: z
      .array(
        z
          .object({
            lei: z.string().describe('20-character GLEIF Legal Entity Identifier.'),
            legalName: z.string().describe('Registered legal name of the entity.'),
            matchedName: z
              .string()
              .describe('The name (legal or other/trading) that matched the query.'),
            matchType: z
              .enum(['exact', 'strong', 'approximate'])
              .describe(
                'exact = normalized equality; strong = all tokens present; approximate = fuzzy.',
              ),
            score: z
              .number()
              .optional()
              .describe(
                'Raw Jaro-Winkler similarity (0–1) for approximate hits only — a real measurement.',
              ),
            jurisdiction: z
              .string()
              .optional()
              .describe('Legal jurisdiction (ISO code), when published.'),
            status: z.string().optional().describe('Registration status (e.g. ISSUED, LAPSED).'),
          })
          .describe('One LEI candidate — confirm against the GLEIF record before relying on it.'),
      )
      .describe('Ranked LEI candidates, highest-confidence first.'),
  }),
  enrichment: {
    normalizedQuery: z.string().describe('The name as the server folded it for matching.'),
    matchModeUsed: z
      .string()
      .describe('The match mode actually applied (strict may upgrade to fuzzy).'),
    totalCount: z.number().describe('Number of LEI candidates returned in this page.'),
    totalAvailable: z
      .number()
      .describe('LEI candidates available across all pages, before limit and offset were applied.'),
    totalAvailableBasis: z
      .enum(['exact', 'lower_bound'])
      .describe(
        'How to read totalAvailable: exact = the complete strict candidate set; lower_bound = a bounded scan produced it (every fuzzy pass, and any strict pass that hit the raw-row scan cap), so more may exist.',
      ),
    hasMore: z
      .boolean()
      .describe('True when LEI candidates remain beyond this page — re-call with nextOffset.'),
    nextOffset: z
      .number()
      .optional()
      .describe('The offset to request next. Present only when hasMore is true.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no LEI matched and how to broaden, or when the requested offset sits past the end of the result set.',
      ),
  },
  errors: [
    {
      reason: 'mirror_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The GLEIF (LEI) mirror has never completed an initial sync.',
      retryable: true,
      recovery:
        'Run the mirror:init lifecycle script to load the GLEIF golden copy, then retry; check sanctions_list_sources for readiness.',
    },
  ],

  async handler(input, ctx) {
    const svc = getScreeningService();
    if (!(await svc.leiReady())) {
      throw ctx.fail('mirror_not_ready', 'The local GLEIF (LEI) mirror is not yet populated.', {
        ...ctx.recoveryFor('mirror_not_ready'),
      });
    }

    const jurisdiction = input.jurisdiction ? input.jurisdiction.toUpperCase() : undefined;
    const result = await svc.resolveEntity(
      {
        query: input.name,
        ...(jurisdiction ? { jurisdiction } : {}),
        matchMode: input.matchMode,
        status: input.status,
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );

    const hasMore = input.offset + result.matches.length < result.totalAvailable;
    ctx.enrich({
      normalizedQuery: result.normalizedQuery,
      matchModeUsed: result.modeUsed,
      totalAvailable: result.totalAvailable,
      totalAvailableBasis: result.totalAvailableBasis,
      hasMore,
      ...(hasMore ? { nextOffset: input.offset + result.matches.length } : {}),
    });
    ctx.enrich.total(result.matches.length);
    // An empty page has two very different causes; conflating them would either
    // hide an out-of-range offset or read a paging artifact as "no LEI exists".
    if (result.totalAvailable === 0) {
      ctx.enrich.notice(
        `No LEI candidate for "${input.name}"${jurisdiction ? ` in ${jurisdiction}` : ''} (mode: ${result.modeUsed}). ` +
          'Try matchMode:"fuzzy", drop the jurisdiction/status filter, or set status:"any" — an unmatched name is not proof the entity has no LEI.',
      );
    } else if (result.matches.length === 0) {
      ctx.enrich.notice(
        `Offset ${input.offset} is past the end of this result set — ${result.totalAvailable} LEI candidate(s) are available. Re-request from offset 0 and page forward with nextOffset.`,
      );
    }

    return {
      matches: result.matches.map((m) => ({
        lei: m.lei,
        legalName: m.legalName,
        matchedName: m.matchedName,
        matchType: m.matchType,
        ...(m.score !== undefined ? { score: m.score } : {}),
        ...(m.jurisdiction ? { jurisdiction: m.jurisdiction } : {}),
        ...(m.status ? { status: m.status } : {}),
      })),
    };
  },

  format: (r) => {
    if (r.matches.length === 0) return [{ type: 'text', text: '**No LEI candidates found.**' }];
    const lines = [`**${r.matches.length} LEI candidate(s)** — confirm before relying on:\n`];
    for (const m of r.matches) {
      const scoreStr = m.score !== undefined ? ` · score ${m.score.toFixed(3)}` : '';
      lines.push(`### ${m.legalName} — ${m.matchType}${scoreStr}`);
      lines.push(`**LEI:** \`${m.lei}\``);
      lines.push(`**Matched on:** "${m.matchedName}"`);
      const meta = [
        m.jurisdiction ? `Jurisdiction: ${m.jurisdiction}` : null,
        m.status ? `Status: ${m.status}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      if (meta) lines.push(`**${meta}**`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
