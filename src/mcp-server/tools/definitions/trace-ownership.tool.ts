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

/**
 * Breadth-first traversal over the relationship table to `depth`, in the
 * requested direction(s). Returns nodes (deduped) and edges. The traversal is
 * bounded by `depth` and by the relationship table itself (the mirror's corpus),
 * so it terminates even on cyclic ownership structures via the visited set.
 */
async function traverse(
  svc: ScreeningService,
  rootLei: string,
  direction: 'parents' | 'children' | 'both',
  depth: number,
): Promise<{ nodes: Map<string, GraphNode>; edges: GraphEdge[] }> {
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
        const edgeKey = `${rel.childLei}|${rel.parentLei}|${rel.relationshipType}`;
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
  return { nodes, edges };
}

export const traceOwnershipTool = tool('sanctions_trace_ownership', {
  title: 'sanctions-screening-mcp-server: trace ownership',
  description:
    'Trace the GLEIF Level 2 corporate-ownership graph for an LEI: direct and ultimate parents and/or children, traversed breadth-first to a bounded depth, with relationship type for each edge. Set screenNodes to also screen every entity in the graph against all loaded watchlists — beneficial-ownership screening that resolves "is anyone in this ownership chain sanctioned." Each per-node screen is a screening AID: hits are candidates to verify, and an empty result for a node is not a clearance of that node. Requires a valid 20-character LEI (use sanctions_resolve_entity to obtain one).',
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

    const { nodes, edges } = await traverse(svc, input.lei, input.direction, input.depth);

    // Hydrate node names/jurisdictions in one batch.
    const hydrated = await svc.getLeiEntitiesBatch([...nodes.keys()]);
    const byLei = new Map(hydrated.map((e) => [e.lei, e]));
    for (const node of nodes.values()) {
      const e = byLei.get(node.lei);
      if (e) {
        node.legalName = e.legalName;
        if (e.jurisdiction) node.jurisdiction = e.jurisdiction;
        if (e.status) node.status = e.status;
      }
    }

    const sanctionsReady = await svc.sanctionsReady();
    let screenedNodeCount = 0;
    let flaggedNodeCount = 0;
    const screensByLei = new Map<string, Awaited<ReturnType<typeof svc.screenName>>['hits']>();

    if (input.screenNodes && sanctionsReady) {
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
            limit: 10,
          },
          ctx,
        );
        screenedNodeCount++;
        if (screen.hits.length > 0) flaggedNodeCount++;
        screensByLei.set(node.lei, screen.hits);
      }
    }

    const orderedNodes = [...nodes.values()].sort((a, b) => a.depth - b.depth);

    return {
      rootLei: input.lei,
      nodes: orderedNodes.map((node) => {
        const hits = screensByLei.get(node.lei);
        return {
          lei: node.lei,
          legalName: node.legalName,
          ...(node.jurisdiction ? { jurisdiction: node.jurisdiction } : {}),
          ...(node.status ? { status: node.status } : {}),
          depth: node.depth,
          role: node.role,
          ...(input.screenNodes && sanctionsReady
            ? {
                sanctionsHits: (hits ?? []).map((h) => ({
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
      screenedNodeCount,
      flaggedNodeCount,
      caveat: SCREENING_CAVEAT,
    };
  },

  format: (r) => {
    const lines = [`# Ownership graph for \`${r.rootLei}\``, ''];
    lines.push(`**${r.nodes.length} node(s), ${r.edges.length} edge(s).**`);
    if (r.screenedNodeCount > 0) {
      lines.push(
        `**Screened ${r.screenedNodeCount} node(s); ${r.flaggedNodeCount} had potential matches.**`,
      );
    }
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
