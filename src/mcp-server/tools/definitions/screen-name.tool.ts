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
import { fold, tokenize } from '@/services/screening/text-matching.js';
import { SOURCE_CODES, SOURCE_LABELS } from '@/services/screening/types.js';
import {
  alsoListedText,
  HitSourcesSchema,
  MAX_NAME_CHARS,
  MAX_NAME_WORDS,
  SCREENING_CAVEAT,
} from './_shared.js';

const SOURCE_ENUM = z.enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un']);

/** The query words a completion candidate need not cover — `FUZZY_STOPLIST` in words. */
const UNCOUNTED_WORDS =
  'legal forms, articles and other function words, and the jurisdiction codes uk, usa, uae, and rf';

const HitSchema = z
  .object({
    source: SOURCE_ENUM.describe(
      "The watchlist whose record this hit's fields come from — its provenance. For an OFAC party both OFAC lists publish, ofac_sdn unless the Consolidated record matched alone or better; sources names every list.",
    ),
    sourceLabel: z.string().describe('Human-readable name of the source list.'),
    sourceEntryId: z
      .string()
      .describe("The list's own entry ID — pass to sanctions_get_designation for the full record."),
    sources: HitSourcesSchema,
    referenceNumber: z
      .string()
      .optional()
      .describe(
        "The list's published reference number (UN, EU, UK OFSI Group ID); absent when the list publishes none for the entry.",
      ),
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
    queryTokenCoverage: z
      .object({
        covered: z
          .number()
          .int()
          .describe(
            "Query tokens individually matched by one of this candidate's tokens at the applied score floor.",
          ),
        total: z.number().int().describe('Total tokens in the normalized query.'),
      })
      .optional()
      .describe(
        'How much of the query this candidate explains, as a literal token count — a second real measurement, never folded into score. It is the tie-break applied after score, because one shared exact token pins several candidates at the same score. Absent for exact/strong hits.',
      ),
    program: z
      .string()
      .optional()
      .describe('Sanctioning program / regime, when published by the source.'),
    designationDate: z
      .string()
      .optional()
      .describe(
        "The source's own designation date as YYYY-MM-DD; absent when unpublished. For an OFAC party both OFAC lists publish, the date of the source record: each OFAC file dates the party from its own lists, so the two often differ, and sanctions_get_designation under the other list returns that record's date.",
      ),
  })
  .describe('One potential match — a candidate to verify, never a determination.');

export const screenNameTool = tool('sanctions_screen_name', {
  title: 'sanctions-screening-mcp-server: screen name',
  description: `Screen a name (person, company, vessel, aircraft) against all loaded sanctions watchlists at once — OFAC SDN + Consolidated, EU, UK, and UN — alias- and fuzzy-aware. Returns scored potential matches with the source list, sanctioning program, designation date, and the matched alias; an OFAC party both OFAC lists publish under one entry ID is one hit, its sources naming both lists. Strict mode (default) matches exact-normalized then all-tokens-present, then runs a fuzzy pass over each selected list strict finds nothing on: a full pass when strict finds nothing on any list, otherwise one that adds only candidates covering every word of the name other than ${UNCOUNTED_WORDS}, ranked after the strict hits. Fuzzy mode runs the fuzzy pass over every selected list. It adds Jaro-Winkler and phonetic matching and labels hits approximate with a raw 0–1 similarity score plus the count of query tokens the candidate covers, which orders candidates that tie on score; fuzzySources names the lists it searched. Results are paged: totalAvailable and hasMore report matches beyond the returned page, and nextOffset retrieves them. This is a screening AID for a human/compliance review, NOT a compliance determination: a hit means "review this candidate against the official source," and an empty result never means "cleared."`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    name: z
      .string()
      .min(1)
      .describe(
        `The name to screen (person, organization, vessel, or aircraft), in any script. It must contain at least one letter or digit, and at most ${MAX_NAME_WORDS} words and ${MAX_NAME_CHARS} characters.`,
      ),
    entityType: z
      .enum(['any', 'person', 'organization', 'vessel', 'aircraft'])
      .default('any')
      .describe('Restrict to one entity class, or "any" (default) to screen across all.'),
    matchMode: z
      .enum(['strict', 'fuzzy'])
      .default('strict')
      .describe(
        `strict (default): exact-normalized then all-tokens-present, then a fuzzy pass over each selected list strict finds nothing on — a full pass when strict finds nothing on any list, otherwise adding only candidates that cover every word of the name other than ${UNCOUNTED_WORDS}. fuzzy: a scored Jaro-Winkler + phonetic pass over every selected list.`,
      ),
    minScore: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Score floor for approximate hits (0–1), applied uniformly to every fuzzy candidate regardless of how it was matched (Jaro-Winkler, token, or phonetic); a query token counts toward queryTokenCoverage only when its match clears it too. It governs every fuzzy pass: fuzzy mode, and in strict mode the pass over the lists strict found nothing on, so raising it can remove approximate hits from a strict screen as well. Exact and strong hits are unaffected. Defaults to the server's configured floor.",
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
      .describe('Maximum number of potential matches to return in one page.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first potential match to return. Re-call with the returned nextOffset to page through every match when hasMore is true; an offset past the end returns an empty page, not an error.',
      ),
  }),
  output: z.object({
    hits: z
      .array(HitSchema)
      .describe(
        'Potential matches, ranked by match type, then score, then how much of the query each candidate explains. Candidates tied on all three are ordered by source list, then entry ID — not by relevance.',
      ),
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
      .describe(
        'fuzzy when every selected list was fuzzy-searched (fuzzy mode, or a strict screen that found nothing on any list); strict otherwise, including a strict screen whose strict-empty lists were completed by a fuzzy pass.',
      ),
    fuzzySources: z
      .array(SOURCE_ENUM)
      .optional()
      .describe(
        `The selected lists the fuzzy pass searched, in list order; absent when no fuzzy pass ran. Beside strict hits these are the lists strict found nothing on, and only their candidates covering every word of the name other than ${UNCOUNTED_WORDS} were added.`,
      ),
    totalCount: z.number().describe('Number of potential matches returned in this page.'),
    totalAvailable: z
      .number()
      .describe(
        'Potential matches in the result set across all pages, before limit and offset were applied — every one is reachable by paging. An OFAC party both OFAC lists publish counts once.',
      ),
    totalAvailableBasis: z
      .enum(['exact', 'lower_bound'])
      .describe(
        'How to read totalAvailable: exact = the complete strict match set, strict having found a match on every selected list; lower_bound = a fuzzy pass ran (fuzzySources is present), which scores only the candidates blocking pooled, so more matches may exist beyond the result set.',
      ),
    hasMore: z
      .boolean()
      .describe(
        'True when the result set holds matches beyond this page — re-call with nextOffset. It describes pages only: false on the last page, whatever totalAvailableBasis says.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe('The offset to request next. Present only when hasMore is true.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no candidate matched — how to broaden, and what an empty result does NOT mean — when the requested offset sits past the end of the result set, or when the fuzzy pass reached its candidate bound and a more distinctive word would narrow it.',
      ),
  },
  enrichmentTrailer: {
    fuzzySources: { render: (sources) => `**fuzzySources:** ${(sources ?? []).join(', ')}` },
  },
  errors: [
    {
      reason: 'name_not_searchable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The name contains no letter or digit, so nothing in it can be matched.',
      recovery:
        'Pass a name that contains at least one letter or digit; punctuation, symbols, and whitespace alone match nothing.',
    },
    {
      reason: 'name_too_long',
      code: JsonRpcErrorCode.InvalidParams,
      when: `The name is longer than ${MAX_NAME_WORDS} words or ${MAX_NAME_CHARS} characters.`,
      recovery: `Pass one name of at most ${MAX_NAME_WORDS} words and ${MAX_NAME_CHARS} characters; screen several names with one call each.`,
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
    const words = tokenize(fold(input.name)).length;
    if (words === 0) {
      throw ctx.fail('name_not_searchable', 'The name contains no letter or digit to match on.');
    }
    if (words > MAX_NAME_WORDS || input.name.length > MAX_NAME_CHARS) {
      throw ctx.fail(
        'name_too_long',
        `The name is past the ${MAX_NAME_WORDS}-word / ${MAX_NAME_CHARS}-character bound (words: ${words}, characters: ${input.name.length}).`,
      );
    }
    const svc = getScreeningService();
    if (!(await svc.sanctionsReady())) {
      throw ctx.fail('mirror_not_ready', 'The local sanctions mirror is not yet populated.');
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
        offset: input.offset,
      },
      ctx,
    );

    const hasMore = input.offset + result.hits.length < result.totalAvailable;
    ctx.enrich({
      normalizedQuery: result.normalizedQuery,
      matchModeUsed: result.modeUsed,
      ...(result.fuzzySources ? { fuzzySources: result.fuzzySources } : {}),
      totalAvailable: result.totalAvailable,
      totalAvailableBasis: result.totalAvailableBasis,
      hasMore,
      ...(hasMore ? { nextOffset: input.offset + result.hits.length } : {}),
    });
    ctx.enrich.total(result.hits.length);
    // An empty page has two very different causes; conflating them would either
    // hide an out-of-range offset or read a paging artifact as "nothing is listed".
    // An empty result always follows a fuzzy pass (an empty strict pass falls
    // back), so the notice never suggests one.
    const notices: string[] = [];
    if (result.totalAvailable === 0) {
      notices.push(
        `No potential match for "${input.name}" across the selected lists (mode: ${result.modeUsed}). ` +
          'This is NOT a clearance — the entity may be listed under a name variant the mirror does not index, ' +
          'or under a transliteration. Try a broader name, or verify directly against the official source.',
      );
    } else if (result.hits.length === 0) {
      notices.push(
        `Offset ${input.offset} is past the end of this result set, which holds ${result.totalAvailable} potential match(es)${result.totalAvailableBasis === 'lower_bound' ? ' — a lower bound: more may exist beyond it' : ''}. Re-request from offset 0 and page forward with nextOffset.`,
      );
    }
    if (result.poolBounded) {
      notices.push(
        'The fuzzy pass reached its candidate bound, so not every name sharing a common word with the query was scored, and more matches may exist. Narrow with a more distinctive word from the name.',
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      hits: result.hits.map((h) => ({
        source: h.source,
        sourceLabel: SOURCE_LABELS[h.source],
        sourceEntryId: h.sourceEntryId,
        sources: h.sources,
        ...(h.referenceNumber ? { referenceNumber: h.referenceNumber } : {}),
        entityType: h.entityType,
        primaryName: h.primaryName,
        matchedName: h.matchedName,
        matchedNameType: h.matchedNameType,
        matchType: h.matchType,
        ...(h.score !== undefined ? { score: h.score } : {}),
        ...(h.queryTokenCoverage ? { queryTokenCoverage: h.queryTokenCoverage } : {}),
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
        const cov = h.queryTokenCoverage;
        const coverStr = cov ? ` · covers ${cov.covered}/${cov.total} query tokens` : '';
        const also = alsoListedText(h.source, h.sources);
        lines.push(`### ${h.primaryName} — ${h.matchType}${scoreStr}${coverStr}`);
        lines.push(
          `**List:** ${h.sourceLabel} (\`${h.source}\`)${also ? ` | **Also listed on:** ${also}` : ''} | **Entry ID:** ${h.sourceEntryId}${h.referenceNumber ? ` | **Reference:** ${h.referenceNumber}` : ''} | **Type:** ${h.entityType}`,
        );
        lines.push(`**Matched on:** "${h.matchedName}" (${h.matchedNameType})`);
        if (h.program) lines.push(`**Program:** ${h.program}`);
        if (h.designationDate) {
          lines.push(
            `**Designated:** ${h.designationDate}${also ? ` (the \`${h.source}\` record)` : ''}`,
          );
        }
        lines.push('');
      }
    }
    lines.push(`> ${result.caveat}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
