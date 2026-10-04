/**
 * @fileoverview `sanctions_vet_counterparty` — frames the full counterparty
 * due-diligence workflow over the existing tools: resolve the name to an LEI,
 * pull the GLEIF ownership graph, screen the named entity and every parent and
 * subsidiary it names against all lists, and summarize hits with provenance and
 * the decision-support caveat. GLEIF records accounting-consolidation parents,
 * not beneficial owners, and the prompt names them as such. No new
 * capability — a reusable framing of the cross-tool workflow.
 * @module mcp-server/prompts/definitions/vet-counterparty.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const vetCounterpartyPrompt = prompt('sanctions_vet_counterparty', {
  title: 'sanctions-screening-mcp-server: vet counterparty',
  description:
    'Structure a full counterparty due-diligence pass: resolve the name to an LEI, pull its GLEIF ownership graph, screen the named entity and every parent and subsidiary in that graph against all sanctions lists, and summarize hits with provenance and the decision-support caveat.',
  args: z.object({
    name: z.string().describe('The counterparty name to vet (person or organization).'),
    jurisdiction: z
      .string()
      .optional()
      .describe(
        'Optional jurisdiction to disambiguate the entity: an ISO 3166-1 alpha-2 country code, which also matches every subdivision under it ("US" matches US-DE and US-CA), or an ISO 3166-2 subdivision code ("US-DE").',
      ),
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
            `1. Screen the name directly with sanctions_screen_name (matchMode "strict", which runs a fuzzy pass on its own over every list with no strict match: all of them when nothing matches strictly, otherwise adding only spelling variants that cover the whole name). If you also hold an identifier for the counterparty — a vessel IMO number, a SWIFT/BIC code, a wallet address, or a passport or national ID number — look each one up exactly with sanctions_screen_identifier.\n` +
            `2. Resolve "${args.name}" to a GLEIF LEI with sanctions_resolve_entity. If there are multiple candidates, pick the best match and note the alternatives.\n` +
            '3. If an LEI is found, call sanctions_trace_ownership on it with screenNodes set to true and direction "both" — this screens every parent and subsidiary GLEIF publishes within the depth against all watchlists, never the siblings or co-parents beside them; a node flagged reachedVia "ultimate" is a group member reached only through its ultimate-parent link. Each node is screened by its legal name and every other and transliterated name (strict, never fuzzy) and looked up by its LEI and registration number; each hit\'s matchedOn names which of those produced it, and a hit with matchedIdentifiers and no matchedName came from an identifier alone. These are accounting-consolidation parents and subsidiaries, not natural-person owners: GLEIF does not name the people behind an entity. Where a node\'s parentStatus is a reporting exception (e.g. NATURAL_PERSONS or NON_CONSOLIDATING), the entity filed a reason instead of naming that parent, so nothing at that level was screened — report the reasons rather than reading it as having no parent; unknown means the exception data is not loaded.\n' +
            "4. For any potential match surfaced in steps 1–3, call sanctions_get_designation to pull the full record (aliases, identifiers, descriptive features such as a vessel's flag and type, program, designation date) so it can be verified.\n\n" +
            "Then write a summary that, for each potential match, names the entity, every list in the hit's sources (an OFAC party published on both the SDN and the Consolidated list is one hit, not two, naming both) and the program, what produced it (from matchedOn: which of the entity's names, with its GLEIF name type, or which identifier), for a name match its match type, and its score when approximate (an identifier match has neither: its matchedIdentifiers say what matched), and the exact name or identifier that matched. Group by the entity in the ownership chain that was flagged.\n\n" +
            'Critically: present every result as a POTENTIAL MATCH TO VERIFY against the official source, never as a determination. State explicitly that this is a screening aid, not sanctions-compliance certification, and that an absence of matches is NOT a clearance — it only means nothing matched the names the mirror indexes as of its last refresh. Call sanctions_list_sources if the freshness of the data matters to the conclusion.',
        },
      },
    ];
  },
});
