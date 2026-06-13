/**
 * @fileoverview `sanctions_vet_counterparty` — frames the full counterparty
 * due-diligence workflow over the existing tools: resolve the name to an LEI,
 * pull the ownership tree, screen the named entity and every beneficial owner
 * against all lists, and summarize hits with provenance and the decision-support
 * caveat. No new capability — a reusable framing of the cross-tool workflow.
 * @module mcp-server/prompts/definitions/vet-counterparty.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const vetCounterpartyPrompt = prompt('sanctions_vet_counterparty', {
  title: 'sanctions-screening-mcp-server: vet counterparty',
  description:
    'Structure a full counterparty due-diligence pass: resolve the name to an LEI, pull the ownership tree, screen the named entity and every beneficial owner against all sanctions lists, and summarize hits with provenance and the decision-support caveat.',
  args: z.object({
    name: z.string().describe('The counterparty name to vet (person or organization).'),
    jurisdiction: z
      .string()
      .optional()
      .describe('Optional ISO 3166-1 alpha-2 jurisdiction to disambiguate the entity (e.g. "US").'),
  }),
  generate: (args) => {
    const jurisdictionClause = args.jurisdiction
      ? ` The entity is based in or registered in ${args.jurisdiction}; pass that as the jurisdiction filter when resolving.`
      : '';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Run a counterparty due-diligence pass on "${args.name}".${jurisdictionClause}\n\n` +
            'Follow this workflow with the sanctions-screening tools, then summarize:\n\n' +
            `1. Screen the name directly with sanctions_screen_name (matchMode "strict"; if it returns nothing, retry with matchMode "fuzzy").\n` +
            `2. Resolve "${args.name}" to a GLEIF LEI with sanctions_resolve_entity. If there are multiple candidates, pick the best match and note the alternatives.\n` +
            '3. If an LEI is found, call sanctions_trace_ownership on it with screen_nodes set to true and direction "both" — this screens every parent and subsidiary (the beneficial owners) against all watchlists.\n' +
            '4. For any potential match surfaced in steps 1–3, call sanctions_get_designation to pull the full record (aliases, identifiers, program, designation date) so it can be verified.\n\n' +
            'Then write a summary that, for each potential match, names the entity, the source list and program, the match type and score, and the exact name that matched. Group by the entity in the ownership chain that was flagged.\n\n' +
            'Critically: present every result as a POTENTIAL MATCH TO VERIFY against the official source, never as a determination. State explicitly that this is a screening aid, not sanctions-compliance certification, and that an absence of matches is NOT a clearance — it only means nothing matched the names the mirror indexes as of its last refresh. Call sanctions_list_sources if the freshness of the data matters to the conclusion.',
        },
      },
    ];
  },
});
