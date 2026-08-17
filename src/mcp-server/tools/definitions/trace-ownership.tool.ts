/**
 * @fileoverview `sanctions_trace_ownership` — the GLEIF Level 2 ownership graph
 * for an LEI: direct and ultimate parents and children, with relationship type,
 * traversed breadth-first to a bounded depth. Optionally screens every node
 * against the watchlists — beneficial-ownership screening that single-list tools
 * can't do, and the cross-source workflow that justifies one server over two.
 * @module mcp-server/tools/definitions/trace-ownership.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { ScreeningService } from '@/services/screening/screening-service.js';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_CODES, SOURCE_LABELS } from '@/services/screening/types.js';
import { SCREENING_CAVEAT } from './_shared.js';

const LEI_RE = /^[A-Z0-9]{18}[0-9]{2}$/;

/**
 * Potential matches returned per node by the cross-reference screen. A graph of
 * ten nodes would otherwise carry ten full screening result sets, so the per-node
 * list is a preview, not the whole set: every screened node reports its own
 * `sanctionsScreen.totalAvailable` / `hasMore`, and a node with more matches than
 * this is re-screened in full with `sanctions_screen_name` on its legal name.
 */
const PER_NODE_SCREEN_LIMIT = 10;

interface GraphNode {
  /** BFS depth from the root (root = 0). */
  depth: number;
  jurisdiction?: string;
  legalName: string;
  lei: string;
  /** 'root', 'parent', or 'child' relative to the traversal. */
  role: 'root' | 'parent' | 'child';
  status?: string;
}

interface GraphEdge {
  childLei: string;
  parentLei: string;
  relationshipStatus?: string;
  relationshipType: string;
}

/** Stable identity for a relationship row — the traversal's edge dedup key. */
const edgeKeyOf = (rel: {
  childLei: string;
  parentLei: string;
  relationshipType: string;
}): string => `${rel.childLei}|${rel.parentLei}|${rel.relationshipType}`;

/**
 * Breadth-first traversal over the relationship table to `depth`, in the
 * requested direction(s). Returns nodes (deduped), edges, and whether the walk
 * was cut off. The traversal is bounded by `depth` and by the relationship table
 * itself (the mirror's corpus), so it terminates even on cyclic ownership
 * structures via the visited set.
 *
 * `truncated` distinguishes a graph cut off by `depth` from one that simply ran
 * out of relationships. Frontier-emptiness alone cannot: a node discovered
 * exactly at the boundary may publish no further relationships, in which case the
 * graph is honestly complete there. So the boundary nodes are probed one hop
 * further and the result is used only as a yes/no — the probed relationships are
 * never materialized into the returned graph, which stays bounded by `depth`. A
 * probe that finds only already-collected edges (the cycle case) is not
 * truncation.
 */
async function traverse(
  svc: ScreeningService,
  rootLei: string,
  direction: 'parents' | 'children' | 'both',
  depth: number,
): Promise<{ edges: GraphEdge[]; nodes: Map<string, GraphNode>; truncated: boolean }> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  nodes.set(rootLei, { lei: rootLei, legalName: rootLei, depth: 0, role: 'root' });

  let frontier = [rootLei];
  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const lei of frontier) {
      const rels = await svc.getRelationships(lei, direction);
      for (const rel of rels) {
        const edgeKey = edgeKeyOf(rel);
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          edges.push({
            childLei: rel.childLei,
            parentLei: rel.parentLei,
            relationshipType: rel.relationshipType,
            ...(rel.relationshipStatus ? { relationshipStatus: rel.relationshipStatus } : {}),
          });
        }
        // The neighbor is whichever end of the edge isn't `lei`.
        const neighbor = rel.childLei === lei ? rel.parentLei : rel.childLei;
        const role: GraphNode['role'] = rel.childLei === lei ? 'parent' : 'child';
        if (!nodes.has(neighbor)) {
          nodes.set(neighbor, { lei: neighbor, legalName: neighbor, depth: level + 1, role });
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }

  let truncated = false;
  for (const lei of frontier) {
    const rels = await svc.getRelationships(lei, direction);
    if (rels.some((rel) => !seenEdges.has(edgeKeyOf(rel)))) {
      truncated = true;
      break;
    }
  }
  return { nodes, edges, truncated };
}

export const traceOwnershipTool = tool('sanctions_trace_ownership', {
  title: 'sanctions-screening-mcp-server: trace ownership',
  description:
    'Trace the GLEIF Level 2 corporate-ownership graph for an LEI: direct and ultimate parents and/or children, traversed breadth-first to a bounded depth, with relationship type for each edge. Set screenNodes to also screen every entity in the graph against all loaded watchlists — beneficial-ownership screening that resolves "is anyone in this ownership chain sanctioned." Each per-node screen is a screening AID: hits are candidates to verify, and an empty result for a node is not a clearance of that node. The response says what it could not do: complete/truncated/missingEntityLeis report whether the graph is the full known picture, screeningStatus reports whether the cross-reference actually ran, and each screened node reports whether its own hit list was capped. Requires a valid 20-character LEI (use sanctions_resolve_entity to obtain one).',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    lei: z
      .string()
      .regex(LEI_RE, 'LEI must be 20 chars: 18 alphanumerics + 2 check digits.')
      .describe('The 20-character GLEIF LEI at the root of the ownership graph.'),
    direction: z
      .enum(['parents', 'children', 'both'])
      .default('both')
      .describe('Walk parents (who owns it), children (what it owns), or both (default).'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe('Maximum traversal depth from the root entity (1–5).'),
    screenNodes: z
      .boolean()
      .default(false)
      .describe(
        "When true, screen every node's legal name against all watchlists for beneficial-ownership screening.",
      ),
  }),
  output: z.object({
    rootLei: z.string().describe('The LEI the traversal started from.'),
    nodes: z
      .array(
        z
          .object({
            lei: z.string().describe("The node's LEI."),
            legalName: z
              .string()
              .describe("The node's legal name (the LEI itself if not hydrated)."),
            jurisdiction: z.string().optional().describe('Jurisdiction (ISO code), when known.'),
            status: z.string().optional().describe('GLEIF registration status, when known.'),
            depth: z.number().describe('Breadth-first depth from the root (root = 0).'),
            role: z
              .enum(['root', 'parent', 'child'])
              .describe('Position relative to the traversal.'),
            sanctionsScreen: z
              .object({
                totalAvailable: z
                  .number()
                  .int()
                  .describe(
                    "Potential matches this node's screen found before the per-node cap was applied.",
                  ),
                totalAvailableBasis: z
                  .enum(['exact', 'lower_bound'])
                  .describe(
                    'How to read totalAvailable: exact = the complete strict match set for this node; lower_bound = a bounded scan produced it, so more may exist.',
                  ),
                hasMore: z
                  .boolean()
                  .describe(
                    "True when this node's potential matches were capped — screen its legal name with sanctions_screen_name to page through the rest.",
                  ),
              })
              .optional()
              .describe(
                "Disclosure for this node's cross-reference screen: how many potential matches existed before the per-node cap, and whether sanctionsHits is the complete set. Present only when the node was screened.",
              ),
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
                    matchedName: z.string().describe('The name/alias that matched this node.'),
                    matchType: z
                      .enum(['exact', 'strong', 'approximate'])
                      .describe('Match classification.'),
                    score: z
                      .number()
                      .optional()
                      .describe('Raw Jaro-Winkler similarity (0–1) for approximate hits only.'),
                  })
                  .describe('A potential watchlist match on this node — verify, do not assume.'),
              )
              .optional()
              .describe('Per-node screening results, present only when screenNodes is true.'),
          })
          .describe('One entity in the ownership graph.'),
      )
      .describe('All entities reached in the traversal, including the root.'),
    edges: z
      .array(
        z
          .object({
            childLei: z.string().describe('LEI of the owned (child) entity.'),
            parentLei: z.string().describe('LEI of the owning (parent) entity.'),
            relationshipType: z
              .string()
              .describe('GLEIF relationship type (e.g. IS_DIRECTLY_CONSOLIDATED_BY).'),
            relationshipStatus: z
              .string()
              .optional()
              .describe('Relationship status, when published.'),
          })
          .describe('One directed ownership edge (child is consolidated by parent).'),
      )
      .describe('Directed ownership edges between the nodes.'),
    complete: z
      .boolean()
      .describe(
        'True only when this is the full known ownership picture: nothing was cut off by the requested depth AND every node resolved to a GLEIF Level 1 record. False means the graph below is a partial view — read truncated and missingEntityLeis for which.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when further ownership relationships exist beyond the requested depth — re-run with a higher depth to see them. False means the traversal reached the edge of the loaded relationship corpus.',
      ),
    missingEntityLeis: z
      .array(z.string())
      .describe(
        'LEIs published in the relationship corpus but absent from the GLEIF Level 1 entity mirror. Their nodes carry the LEI in place of a legal name and no jurisdiction/status — never read that LEI as a legal name, and note any per-node screen for them ran against the LEI string.',
      ),
    screeningStatus: z
      .enum(['screened', 'not_requested', 'not_ready'])
      .describe(
        'Whether the per-node cross-reference ran: screened = every node was screened; not_requested = screenNodes was false; not_ready = screening was requested but the sanctions mirror has never synced, so NO node was screened and the absence of hits says nothing about any node.',
      ),
    screenedNodeCount: z
      .number()
      .describe('How many nodes were screened (0 when screenNodes is false).'),
    flaggedNodeCount: z
      .number()
      .describe('How many screened nodes had at least one potential watchlist match.'),
    caveat: z
      .string()
      .describe('Decision-support caveat — node screening is an aid, not a determination.'),
  }),
  errors: [
    {
      reason: 'lei_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No GLEIF entity exists for the root LEI in the mirror.',
      recovery:
        'Resolve the entity name with sanctions_resolve_entity to obtain a valid root LEI first.',
    },
    {
      reason: 'mirror_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The GLEIF (LEI) mirror has never completed an initial sync.',
      retryable: true,
      recovery:
        'Run the mirror:init lifecycle script to load the GLEIF golden copy + relationships, then retry.',
    },
  ],

  async handler(input, ctx) {
    const svc = getScreeningService();
    if (!(await svc.leiReady())) {
      throw ctx.fail('mirror_not_ready', 'The local GLEIF (LEI) mirror is not yet populated.', {
        ...ctx.recoveryFor('mirror_not_ready'),
      });
    }

    const root = await svc.getLeiEntity(input.lei);
    if (!root) {
      throw ctx.fail('lei_not_found', `No GLEIF entity with LEI "${input.lei}".`, {
        ...ctx.recoveryFor('lei_not_found'),
      });
    }

    const { nodes, edges, truncated } = await traverse(
      svc,
      input.lei,
      input.direction,
      input.depth,
    );

    // Hydrate node names/jurisdictions in one batch. A node the Level 1 mirror
    // does not carry keeps the LEI as its `legalName`; that is recorded here by
    // hydration outcome, never inferred later by comparing the name to the LEI.
    const hydrated = await svc.getLeiEntitiesBatch([...nodes.keys()]);
    const byLei = new Map(hydrated.map((e) => [e.lei, e]));
    const missingEntityLeis: string[] = [];
    for (const node of nodes.values()) {
      const e = byLei.get(node.lei);
      if (!e) {
        missingEntityLeis.push(node.lei);
        continue;
      }
      node.legalName = e.legalName;
      if (e.jurisdiction) node.jurisdiction = e.jurisdiction;
      if (e.status) node.status = e.status;
    }

    const sanctionsReady = await svc.sanctionsReady();
    const screened = input.screenNodes && sanctionsReady;
    const screeningStatus: 'screened' | 'not_requested' | 'not_ready' = screened
      ? 'screened'
      : input.screenNodes
        ? 'not_ready'
        : 'not_requested';
    let screenedNodeCount = 0;
    let flaggedNodeCount = 0;
    const screensByLei = new Map<string, Awaited<ReturnType<typeof svc.screenName>>>();

    if (screened) {
      for (const node of nodes.values()) {
        const screen = await svc.screenName(
          {
            query: node.legalName,
            entityType: 'any',
            matchMode: 'strict',
            // Per-node cross-reference: strict only. Auto-fuzzy would flag nearly
            // every node on a single shared common token, defeating the signal.
            autoFallback: false,
            sources: [...SOURCE_CODES],
            limit: PER_NODE_SCREEN_LIMIT,
          },
          ctx,
        );
        screenedNodeCount++;
        if (screen.hits.length > 0) flaggedNodeCount++;
        screensByLei.set(node.lei, screen);
      }
    }

    const orderedNodes = [...nodes.values()].sort((a, b) => a.depth - b.depth);

    return {
      rootLei: input.lei,
      nodes: orderedNodes.map((node) => {
        const screen = screensByLei.get(node.lei);
        return {
          lei: node.lei,
          legalName: node.legalName,
          ...(node.jurisdiction ? { jurisdiction: node.jurisdiction } : {}),
          ...(node.status ? { status: node.status } : {}),
          depth: node.depth,
          role: node.role,
          ...(screen
            ? {
                sanctionsScreen: {
                  totalAvailable: screen.totalAvailable,
                  totalAvailableBasis: screen.totalAvailableBasis,
                  // The per-node screen never pages, so whatever the cap left
                  // behind is everything past the hits returned here.
                  hasMore: screen.hits.length < screen.totalAvailable,
                },
                sanctionsHits: screen.hits.map((h) => ({
                  source: h.source,
                  sourceLabel: SOURCE_LABELS[h.source],
                  sourceEntryId: h.sourceEntryId,
                  primaryName: h.primaryName,
                  matchedName: h.matchedName,
                  matchType: h.matchType,
                  ...(h.score !== undefined ? { score: h.score } : {}),
                })),
              }
            : {}),
        };
      }),
      edges,
      complete: !truncated && missingEntityLeis.length === 0,
      truncated,
      missingEntityLeis,
      screeningStatus,
      screenedNodeCount,
      flaggedNodeCount,
      caveat: SCREENING_CAVEAT,
    };
  },

  format: (r) => {
    const lines = [`# Ownership graph for \`${r.rootLei}\``, ''];
    lines.push(`**${r.nodes.length} node(s), ${r.edges.length} edge(s).**`);

    lines.push(
      r.complete
        ? '**Graph coverage:** complete — nothing was truncated at the requested depth, and every node resolved to a GLEIF Level 1 record.'
        : '**Graph coverage:** incomplete — what follows is NOT the full known ownership picture.',
    );
    if (r.truncated) {
      lines.push(
        '- Truncated at the requested depth: further ownership relationships exist beyond it. Re-run with a higher depth (max 5).',
      );
    }
    if (r.missingEntityLeis.length > 0) {
      lines.push(
        `- Absent from the GLEIF Level 1 entity mirror (${r.missingEntityLeis.length}): ${r.missingEntityLeis
          .map((lei) => `\`${lei}\``)
          .join(
            ', ',
          )}. Those nodes show their LEI where a legal name would be, and any screen for them ran against that LEI.`,
      );
    }

    lines.push(
      r.screeningStatus === 'not_ready'
        ? '**Node screening:** requested but NOT run — the sanctions mirror has never synced, so no node was screened. That is not a clearance for any node.'
        : r.screeningStatus === 'not_requested'
          ? '**Node screening:** not requested — no node was cross-referenced against the watchlists (set screenNodes: true).'
          : `**Node screening:** screened ${r.screenedNodeCount} node(s); ${r.flaggedNodeCount} had potential matches.`,
    );

    lines.push('\n## Entities');
    for (const node of r.nodes) {
      const meta = [node.jurisdiction, node.status].filter(Boolean).join(', ');
      lines.push(
        `- **${node.legalName}** \`${node.lei}\` — ${node.role}, depth ${node.depth}${meta ? ` (${meta})` : ''}`,
      );
      if (node.sanctionsHits && node.sanctionsHits.length > 0) {
        for (const h of node.sanctionsHits) {
          const scoreStr = h.score !== undefined ? ` · score ${h.score.toFixed(3)}` : '';
          lines.push(
            `  - ⚠ ${h.primaryName} — ${h.sourceLabel} (\`${h.source}\`, entry ${h.sourceEntryId}): matched "${h.matchedName}" — ${h.matchType}${scoreStr}`,
          );
        }
      } else if (node.sanctionsHits) {
        lines.push('  - No potential matches (not a clearance).');
      }
      if (node.sanctionsScreen) {
        const s = node.sanctionsScreen;
        lines.push(
          `  - Screen coverage: showing ${node.sanctionsHits?.length ?? 0} of ${s.totalAvailable} potential match(es) (count basis: ${s.totalAvailableBasis}); more available: ${s.hasMore}${
            s.hasMore
              ? ` — screen "${node.legalName}" with sanctions_screen_name to page through the rest.`
              : ''
          }`,
        );
      }
    }
    if (r.edges.length > 0) {
      lines.push('\n## Ownership edges');
      for (const e of r.edges) {
        lines.push(
          `- \`${e.childLei}\` ${e.relationshipType} \`${e.parentLei}\`${e.relationshipStatus ? ` (${e.relationshipStatus})` : ''}`,
        );
      }
    }
    lines.push(`\n> ${r.caveat}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
