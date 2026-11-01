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
          text: `Run a counterparty due-diligence pass on "${args.name}".${jurisdictionClause}\n\nFollow this workflow with the sanctions-screening tools, then summarize:\n\n1. Screen the name directly with sanctions_screen_name (matchMode "strict", which completes each strict-empty list with a fuzzy pass). Screen all eleven loaded sanctions and export-control lists, including BIS and State CSL lists; do not exclude unknown entity types. If you hold identifiers, look each up exactly with sanctions_screen_identifier. Drain every name-screen page before treating the result set as exhausted.\n\n2. Resolve "${args.name}" to a GLEIF LEI with sanctions_resolve_entity. Confirm identity using jurisdiction, addresses, and registry details from sanctions_get_entity; rank alone does not identify the counterparty. If unresolved, report the uncertainty rather than choosing silently.\n\n3. For a confirmed LEI, call sanctions_trace_ownership with screenNodes:true and direction "both". Drain nextCursor while hasMore is true using the same effective query. Assemble nodes, edges, and boundaries across pages; an edge can reference a node on another page. Then re-root every boundary with its supplied lei, direction, and depth, preserving screenNodes:true. Deduplicate queued (lei, direction) roots and edge identities because branch segments can overlap. Re-rooting resets local depth and role; retain original segment placement. On invalid_cursor or stale_cursor, restart that segment without a cursor. Entity and screening values are current between pages, not an immutable snapshot. A byteTargetExceeded page retains its intact records; a finished page or segment never proves complete ownership.\n\n4. The walk reaches accounting-consolidation parents and subsidiaries, never siblings or co-parents. An ultimate-only leaf requires boundary continuation if its own links are omitted. Each returned node is screened by its legal name and every other and transliterated name (strict, never fuzzy) and looked up by its LEI and registration number. A hit's matchedOn names which inputs produced it; matchedIdentifiers and no matchedName came from an identifier alone. Missing Level 1 records are unresolved and screened by LEI alone. Where parentStatus is a reporting exception (e.g. NATURAL_PERSONS or NON_CONSOLIDATING), report every reason; it does not name a parent to screen. Unknown means exception data is not loaded. screeningStatus:not_ready is unavailable screening, never a clean screen.\n\n5. If sanctionsScreen.hasMore is true, recover capped cross-reference hits by screening the legal name and every screenedInputs name with sanctions_screen_name and paging those results, and looking up the LEI and published registration number with sanctions_screen_identifier. Keep registry-country context and deduplicate by source and sourceEntryId, preserving the existing OFAC grouping. Standalone strict name screening can add approximate matches from strict-empty lists; those extras are not necessarily omitted strict cross-reference hits.\n\n6. For every potential match, call sanctions_get_designation for full aliases, identifiers, features, programs, dates, restrictions, notices, and provenance URLs. Verify CSL candidates against official agency lists and Federal Register publications. Missing type stays unknown; a published end_date or standard_order flag supplies no inferred legal conclusion.\n\nThen write a summary that names every list in the hit's sources (an OFAC party on both files is one hit, not two), the program, and what produced it from matchedOn, for a name match its match type, and its score when approximate (an identifier match has neither); quote the exact matched name or identifier. Group by the flagged entity in its accounting-consolidation chain, retaining unresolved identity, missing records, reporting exceptions, incomplete branches and capped retrieval limits.\n\nCritically: present every result as a POTENTIAL MATCH TO VERIFY, never a determination. State that this is a screening aid, not sanctions-compliance certification; an absence of matches is NOT a clearance. Call sanctions_list_sources and report successful local sync timestamps, not purported upstream publication freshness. This product uses the International Trade Administration’s Data API but is not endorsed or certified by the International Trade Administration.`,
        },
      },
    ];
  },
});
