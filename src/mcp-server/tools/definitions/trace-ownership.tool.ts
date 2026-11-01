/**
 * @fileoverview `sanctions_trace_ownership` — the GLEIF Level 2 ownership graph
 * for an LEI: direct and ultimate parents and children, with relationship type,
 * traversed breadth-first to a bounded depth — up from the root to its parents and
 * down to its children, never sideways, with ultimate-parent edges returned but
 * never counted as a hop. Each node whose parents the walk read also says what
 * GLEIF publishes about its direct and ultimate parent — a relationship, a
 * reporting exception with its reasons, or nothing — so "its parent is a natural
 * person" never reads as "it has no parent". Optionally cross-references every
 * node against the watchlists by the same rule as `sanctions_get_entity` — its
 * names strict, its LEI and country-matched registration number as identifiers,
 * a node with no Level 1 record by its LEI alone — the cross-source workflow that
 * justifies one server over two.
 * @module mcp-server/tools/definitions/trace-ownership.tool
 */

import { createHash } from 'node:crypto';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  type CrossReferenceResult,
  crossReferenceEntity,
} from '@/services/screening/cross-reference.js';
import { leiChecksumValid } from '@/services/screening/lei-checksum.js';
import type { ScreeningService } from '@/services/screening/screening-service.js';
import { getScreeningService } from '@/services/screening/screening-service.js';
import {
  type NormalizedLeiRelationship,
  SOURCE_CODES,
  SOURCE_LABELS,
} from '@/services/screening/types.js';
import {
  alsoListedText,
  crossReferencePointer,
  HitSourcesSchema,
  MatchedIdentifierSchema,
  matchedIdentifierText,
  SCREENING_CAVEAT,
  ScreenedInputSchema,
  screenedInputText,
} from './_shared.js';

const LEI_RE = /^[A-Z0-9]{18}[0-9]{2}$/;
const PAGE_BYTE_TARGET = 64 * 1024;
const PAGE_LIMIT = 100;

const BoundarySchema = z
  .object({
    lei: z.string().describe('Re-root this LEI to retrieve the omitted branch.'),
    direction: z.enum(['parents', 'children']).describe('Walk only this side in the new segment.'),
    reason: z
      .enum(['depth_limit', 'ultimate_leaf'])
      .describe('Why the original segment stopped this branch.'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe('Depth to pass to the new trace; its root restarts at depth zero.'),
  })
  .describe('One omitted same-side branch, with executable inputs for a new trace segment.');
type Boundary = z.infer<typeof BoundarySchema>;

const CursorSchema = z.object({
  version: z.literal(1),
  query: z.object({
    lei: z.string(),
    direction: z.enum(['parents', 'children', 'both']),
    depth: z.number().int(),
    screenNodes: z.boolean(),
    limit: z.number().int(),
  }),
  offset: z.number().int().nonnegative(),
  topology: z.string(),
});

/** Code-unit lexical ordering is stable across hosts and process restarts. */
const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Only JSON decoding may fail here; cursor shape and query/topology checks stay explicit. */
function decodeCursor(cursor: string): z.infer<typeof CursorSchema> | undefined {
  let value: unknown;
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) return undefined;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  const parsed = CursorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const ParentLevelSchema = z.object({
  status: z
    .enum(['relationship', 'exception', 'none', 'unknown'])
    .describe(
      "relationship = a Level 2 relationship at this level is published — it is in edges when that parent is also a node of this graph (a flagged leaf's parents and a children-side node's other parents are read for this status, never walked); exception = the entity filed a GLEIF reporting exception instead of naming this parent; none = GLEIF publishes neither; unknown = no relationship is published and reporting exceptions are not loaded in the mirror, so whether one was filed is unknown.",
    ),
  exceptionReasons: z
    .array(z.string())
    .optional()
    .describe(
      'Every reason given in the reporting exception (e.g. NATURAL_PERSONS, NON_CONSOLIDATING, NO_KNOWN_PERSON). Present only when status is exception.',
    ),
});

/** Measure both public surfaces, including continuation and disclosure overhead. */
function pageBytes(page: unknown, notice?: string): number {
  const result = traceOwnershipTool.output.parse(page);
  const content = traceOwnershipTool.format?.(result) ?? [];
  if (notice !== undefined)
    content.push({ type: 'text', text: `\n\n${renderLimitNotice(notice)}` });
  return Buffer.byteLength(
    JSON.stringify({
      structuredContent: notice === undefined ? result : { ...result, notice },
      content,
    }),
  );
}

/** Shared with the framework enrichment trailer so byte accounting uses the emitted notice. */
function renderLimitNotice(notice: unknown): string {
  return `> ${String(notice)}`;
}

/**
 * Potential matches returned per node by the cross-reference, after its merge. A
 * graph of ten nodes would otherwise carry ten full screening result sets, so the
 * per-node list is a preview, not the whole set: every screened node reports its
 * own `sanctionsScreen.totalAvailable` / `hasMore`, and a node with more matches
 * than this is re-screened in full with `sanctions_screen_name` and
 * `sanctions_screen_identifier`.
 */
const PER_NODE_SCREEN_LIMIT = 10;

/** The Level 2 relationship type, and the reporting-exception category, of each parent level. */
const PARENT_LEVELS = {
  direct: {
    relationshipType: 'IS_DIRECTLY_CONSOLIDATED_BY',
    exceptionCategory: 'DIRECT_ACCOUNTING_CONSOLIDATION_PARENT',
  },
  ultimate: {
    relationshipType: 'IS_ULTIMATELY_CONSOLIDATED_BY',
    exceptionCategory: 'ULTIMATE_ACCOUNTING_CONSOLIDATION_PARENT',
  },
} as const;

type ParentLevel = keyof typeof PARENT_LEVELS;

/** What GLEIF publishes about one parent level of a node. */
interface ParentLevelStatus {
  exceptionReasons?: string[] | undefined;
  status: 'relationship' | 'exception' | 'none' | 'unknown';
}

/**
 * GLEIF's shortcut from an entity to the top of its group. It is returned as an
 * edge but never counts as a hop: following it would put every group member one
 * level below its head, whatever the direct chain between them.
 */
const ULTIMATE_TYPE = PARENT_LEVELS.ultimate.relationshipType;

interface GraphNode {
  /** Depth from the root (root = 0), counted over every relationship type but {@link ULTIMATE_TYPE}. */
  depth: number;
  jurisdiction?: string;
  legalName: string;
  lei: string;
  /** Set when only an ultimate-parent edge reaches the node within the depth: a leaf, never walked. */
  reachedVia?: 'ultimate';
  /** 'root', or the side of the walk that reached the node: parents → 'parent', children → 'child'. */
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

/** Each walk side: the end of a row it moves to, and the role it gives what it reaches. */
const SIDES = {
  parents: { far: (rel: NormalizedLeiRelationship) => rel.parentLei, role: 'parent' },
  children: { far: (rel: NormalizedLeiRelationship) => rel.childLei, role: 'child' },
} as const;

type Side = keyof typeof SIDES;

/**
 * Breadth-first walk over the relationship table to `depth`. `both` is a parents
 * walk plus a children walk from the root, each to `depth`: the parents walk
 * never reads an ancestor's children and the children walk never follows a
 * descendant's other parents, so siblings and co-parents are never reached. Each
 * side keeps its own visited set, so a node both sides reach (a cycle) is still
 * walked on each; it appears once, with the parents walk's placement, since that
 * side runs first.
 *
 * {@link ULTIMATE_TYPE} rows never extend a walk. Their far ends are resolved
 * after both walks, so a node any other edge reaches within `depth` is placed by
 * that edge whatever order the rows arrive in; a node only an ultimate row
 * reaches becomes a leaf flagged `reachedVia: 'ultimate'`, its depth that one hop.
 *
 * On a parents or both walk, every node short of the depth limit — a flagged leaf
 * and a children-side node included — has its own parent rows read for its
 * parent status; those rows never extend the walk. Edges are the rows read whose
 * two ends are both returned nodes.
 *
 * `truncated` distinguishes a graph that leaves relationships out from one that
 * simply ran out of them. Frontier-emptiness alone cannot: a node discovered
 * exactly at the boundary may publish no further relationships, in which case the
 * graph is honestly complete there. So each side's boundary nodes are probed one
 * hop further on that side, and the result is used only as a yes/no — the probed
 * relationships are never materialized into the returned graph, which stays
 * bounded by `depth`. A flagged leaf is never walked, so it is probed the same
 * way on the side that reached it: a leaf whose own direct parent (or child) the
 * graph does not show leaves it a partial view at any depth. A probed row the
 * graph already shows (the cycle case) is not truncation. An ultimate row is
 * truncation only when it leads to an entity the graph does not return, which
 * one more hop would add as a flagged leaf; one leading to a returned node is a
 * shortcut to an entity already shown.
 */
async function traverse(
  svc: ScreeningService,
  rootLei: string,
  direction: 'parents' | 'children' | 'both',
  depth: number,
  signal: AbortSignal,
): Promise<{
  edges: GraphEdge[];
  nodes: Map<string, GraphNode>;
  parentTypesByLei: Map<string, Set<string>>;
  boundaries: Boundary[];
}> {
  const nodes = new Map<string, GraphNode>([
    [rootLei, { lei: rootLei, legalName: rootLei, depth: 0, role: 'root' }],
  ]);
  const rowsRead = new Map<string, NormalizedLeiRelationship>();
  const parentRows = new Map<string, NormalizedLeiRelationship[]>();
  const readParents = async (lei: string): Promise<NormalizedLeiRelationship[]> => {
    const cached = parentRows.get(lei);
    if (cached) return cached;
    const rows = (await svc.getRelationships(lei, 'parents')).sort((a, b) =>
      lexical(edgeKeyOf(a), edgeKeyOf(b)),
    );
    parentRows.set(lei, rows);
    return rows;
  };
  const readSide = (lei: string, side: Side) =>
    side === 'parents'
      ? readParents(lei)
      : svc
          .getRelationships(lei, 'children')
          .then((rows) => rows.sort((a, b) => lexical(edgeKeyOf(a), edgeKeyOf(b))));
  const ultimateLeaves: { depth: number; lei: string; role: 'parent' | 'child' }[] = [];
  /** The nodes probed one hop further on their side: each side's boundary, and every flagged leaf. */
  const probes: { lei: string; side: Side; reason: Boundary['reason'] }[] = [];

  const sides: Side[] = direction === 'both' ? ['parents', 'children'] : [direction];
  for (const side of sides) {
    const { far, role } = SIDES[side];
    const visited = new Set([rootLei]);
    let frontier = [rootLei];
    for (let level = 0; level < depth && frontier.length > 0; level++) {
      const next: string[] = [];
      for (const lei of frontier) {
        signal.throwIfAborted();
        for (const rel of await readSide(lei, side)) {
          rowsRead.set(edgeKeyOf(rel), rel);
          const neighbor = far(rel);
          if (rel.relationshipType === ULTIMATE_TYPE) {
            ultimateLeaves.push({ lei: neighbor, depth: level + 1, role });
          } else if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
            if (!nodes.has(neighbor)) {
              nodes.set(neighbor, { lei: neighbor, legalName: neighbor, depth: level + 1, role });
            }
          }
        }
      }
      frontier = next;
    }
    probes.push(...frontier.map((lei) => ({ lei, side, reason: 'depth_limit' as const })));
  }

  const leafProbes = new Set<string>();
  for (const leaf of ultimateLeaves) {
    if (!nodes.has(leaf.lei)) {
      nodes.set(leaf.lei, { ...leaf, legalName: leaf.lei, reachedVia: 'ultimate' });
    }
    const side = leaf.role === 'parent' ? 'parents' : 'children';
    const probeKey = `${leaf.lei}|${side}`;
    // Placement belongs to the parents walk; omitted branches belong to each side independently.
    if (nodes.get(leaf.lei)?.reachedVia === 'ultimate' && !leafProbes.has(probeKey)) {
      leafProbes.add(probeKey);
      probes.push({
        lei: leaf.lei,
        side,
        reason: 'ultimate_leaf',
      });
    }
  }

  const parentTypesByLei = new Map<string, Set<string>>();
  if (direction !== 'children') {
    for (const node of nodes.values()) {
      signal.throwIfAborted();
      if (node.depth >= depth) continue;
      const rows = await readParents(node.lei);
      for (const rel of rows) rowsRead.set(edgeKeyOf(rel), rel);
      parentTypesByLei.set(node.lei, new Set(rows.map((rel) => rel.relationshipType)));
    }
  }

  const shown = (rel: NormalizedLeiRelationship): boolean =>
    rowsRead.has(edgeKeyOf(rel)) && nodes.has(rel.childLei) && nodes.has(rel.parentLei);
  const edges: GraphEdge[] = [...rowsRead.values()].filter(shown).map((rel) => ({
    childLei: rel.childLei,
    parentLei: rel.parentLei,
    relationshipType: rel.relationshipType,
    ...(rel.relationshipStatus ? { relationshipStatus: rel.relationshipStatus } : {}),
  }));

  const boundaries: Boundary[] = [];
  for (const { lei, side, reason } of probes) {
    signal.throwIfAborted();
    const { far } = SIDES[side];
    const rels = await readSide(lei, side);
    if (
      rels.some(
        (rel) => !shown(rel) && (rel.relationshipType !== ULTIMATE_TYPE || !nodes.has(far(rel))),
      )
    ) {
      boundaries.push({ lei, direction: side, reason, depth });
    }
  }
  edges.sort((a, b) => lexical(edgeKeyOf(a), edgeKeyOf(b)));
  boundaries.sort((a, b) =>
    lexical(`${a.lei}|${a.direction}|${a.reason}`, `${b.lei}|${b.direction}|${b.reason}`),
  );
  return { nodes, edges, parentTypesByLei, boundaries };
}

/**
 * What GLEIF publishes about each parent level of every node whose parents the
 * walk read: a relationship row of that level's type, else a reporting exception
 * with its reasons, else nothing. With no recorded exception load, a level with no
 * relationship row is `unknown` — never `none`, which would claim GLEIF publishes
 * nothing. An exception never supplies a parent; it explains a missing one.
 */
async function parentStatuses(
  svc: ScreeningService,
  parentTypesByLei: Map<string, Set<string>>,
  exceptionsLoaded: boolean,
): Promise<Map<string, Record<ParentLevel, ParentLevelStatus>>> {
  const exceptions = exceptionsLoaded
    ? await svc.getReportingExceptions([...parentTypesByLei.keys()])
    : new Map<string, { category: string; reasons: string[] }[]>();
  const statuses = new Map<string, Record<ParentLevel, ParentLevelStatus>>();
  for (const [lei, parentTypes] of parentTypesByLei) {
    const level = (name: ParentLevel): ParentLevelStatus => {
      const { relationshipType, exceptionCategory } = PARENT_LEVELS[name];
      if (parentTypes.has(relationshipType)) return { status: 'relationship' };
      if (!exceptionsLoaded) return { status: 'unknown' };
      const exception = exceptions.get(lei)?.find((e) => e.category === exceptionCategory);
      return exception
        ? { status: 'exception', exceptionReasons: exception.reasons }
        : { status: 'none' };
    };
    statuses.set(lei, { direct: level('direct'), ultimate: level('ultimate') });
  }
  return statuses;
}

/**
 * How each parent-level status reads in the markdown: in the expanded block of a
 * node with potential matches, and on the one line of a node without.
 */
const PARENT_STATUS_TEXT: Record<ParentLevelStatus['status'], Record<'block' | 'line', string>> = {
  relationship: { block: 'relationship published', line: 'relationship' },
  exception: { block: 'reporting exception', line: 'reporting exception' },
  none: { block: 'none published', line: 'none published' },
  unknown: { block: 'unknown — reporting exceptions not loaded', line: 'unknown' },
};

/**
 * One parent level of a node — the exception's reasons included. A published
 * relationship says whether its edge is in this graph: a flagged leaf's parents
 * and a children-side node's other parents are read for status, never walked.
 */
function parentLevelText(
  level: ParentLevelStatus,
  form: 'block' | 'line',
  edgeShown: boolean,
  pagedSegment = false,
): string {
  const reasons = level.exceptionReasons?.length ? ` (${level.exceptionReasons.join(', ')})` : '';
  const where =
    level.status !== 'relationship'
      ? ''
      : pagedSegment && !edgeShown
        ? ' (edge may be elsewhere in the assembled graph; if absent after all pages, parent outside segment)'
        : !edgeShown
          ? ' (parent not in this graph)'
          : form === 'block'
            ? ' (see edges)'
            : '';
  return `${PARENT_STATUS_TEXT[level.status][form]}${reasons}${where}`;
}

export const traceOwnershipTool = tool('sanctions_trace_ownership', {
  title: 'sanctions-screening-mcp-server: trace ownership',
  description:
    'Trace a paged GLEIF Level 2 ownership segment from a 20-character LEI (use sanctions_resolve_entity to obtain one). Direction both walks parents and children separately from the root, never sideways into siblings or co-parents; parents-side placement wins cycles. Ultimate-parent edges are shortcuts, never walked hops; ultimate-only nodes are flagged reachedVia: ultimate. Drain nextCursor with the same query, then re-root each boundary with its LEI, same-side direction and depth, including at depth five; deduplicate branch roots and edges across segments. Pages emit nodes, then edges, then boundaries, up to limit records (50 default, 100 maximum), stopping after an intact record reaches the soft 64-KiB target. Edges reference nodes across assembled pages. Cursors bind query and topology; changed topology requires restarting without a cursor. Entity and screening values read current mirrors, not an immutable snapshot. Set screenNodes to cross-reference only this page of nodes as sanctions_get_entity does: legal, other and transliterated names strict (exact then all tokens present, never fuzzy), LEI and country-matched registration number as exact non-document identifiers, with merged designation hits and matchedOn inputs. A node missing Level 1 is screened by LEI alone. Every hit is a candidate to verify; no hit is a clearance. Each eligible node retains direct and ultimate parentStatus: relationship, reporting exception and its reasons, none, or unknown when exceptions are not loaded. Read hasMore and truncationReasons separately from segment-wide missingEntityCount and page-local missingEntityLeis, screening counts and per-node ten-hit cap disclosures. A screening aid, not a compliance determination; a finished segment never proves full beneficial ownership.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    lei: z
      .string()
      .regex(LEI_RE, 'LEI must be 20 chars: 18 alphanumerics + 2 check digits.')
      .describe('The 20-character GLEIF LEI at the root of the ownership graph.'),
    direction: z
      .enum(['parents', 'children', 'both'])
      .default('both')
      .describe(
        'Walk parents (who owns it), children (what it owns), or both (default): a parents walk plus a children walk from the root, each to depth, never into siblings or co-parents.',
      ),
    depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe(
        'Maximum traversal depth from the root entity (1–5), on each side of a both walk. Ultimate-parent edges do not count as hops.',
      ),
    screenNodes: z
      .boolean()
      .default(false)
      .describe(
        'When true, cross-reference every returned node on this page against all watchlists: legal, other and transliterated names strict, LEI and country-matched registration number as identifiers. A node missing Level 1 has only its LEI lookup. Edge/boundary-only pages screen zero nodes.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(50)
      .describe(
        'Maximum records across nodes, edges and boundaries per page (default 50, requests above 100 clamp with notice).',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'nextCursor from the preceding page, with the same query parameters. Omit to start a new segment.',
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
            depth: z
              .number()
              .describe(
                'Breadth-first depth from the root (root = 0), counted over every relationship type except IS_ULTIMATELY_CONSOLIDATED_BY. On a node flagged reachedVia: ultimate it counts that one ultimate hop instead, so it can be shallower than the direct chain to the node.',
              ),
            role: z
              .enum(['root', 'parent', 'child'])
              .describe(
                'root = the traced entity; parent = an ancestor, reached by walking parents; child = a descendant, reached by walking children. On a both walk, the side that reached the node — siblings and co-parents are never walked.',
              ),
            reachedVia: z
              .enum(['ultimate'])
              .optional()
              .describe(
                'Present (ultimate) when only an IS_ULTIMATELY_CONSOLIDATED_BY edge reaches this node within the depth. That edge is a shortcut to the top of the group, not a hop, so the node is a leaf: its own parents (on the parents side) or children (on the children side) are never walked, and truncated is true when any of them is not in this graph. A higher depth places it by direct links only when a direct chain from the root reaches it; where that chain is broken (a parent reported by exception, or not at all), no depth does.',
              ),
            parentStatus: z
              .object({
                direct: ParentLevelSchema.describe('What GLEIF publishes about the direct parent.'),
                ultimate: ParentLevelSchema.describe(
                  'What GLEIF publishes about the ultimate parent.',
                ),
              })
              .optional()
              .describe(
                "What GLEIF publishes about this node's direct and ultimate accounting-consolidation parents. Present only on nodes whose parents the traversal read — every node short of the depth limit when direction is parents or both; absent on a children walk.",
              ),
            sanctionsScreen: z
              .object({
                totalAvailable: z
                  .number()
                  .int()
                  .describe(
                    "Distinct designations this node's cross-reference found across every screened name and identifier, an OFAC party both OFAC lists publish counted once, before the per-node cap was applied.",
                  ),
                totalAvailableBasis: z
                  .enum(['exact', 'lower_bound'])
                  .describe(
                    "How to read totalAvailable. Always exact here: every name is screened strict, never fuzzy, and a strict screen counts every designation it reaches, so totalAvailable is the whole set across this node's screened names and identifiers.",
                  ),
                hasMore: z
                  .boolean()
                  .describe(
                    "True when this node's potential matches were capped — re-screen its names with sanctions_screen_name and look up its LEI and registration number with sanctions_screen_identifier to see the rest. A node in missingEntityLeis has no names: look up its LEI.",
                  ),
                screenedInputs: z
                  .array(ScreenedInputSchema)
                  .describe(
                    'What the cross-reference screened beyond the legal name and the LEI, which it screens on every node with a Level 1 record: every other and transliterated name, then the registration number when the node publishes one (a not-available placeholder such as N/A is none) and a legal jurisdiction to match it by. Empty when there is nothing beyond those two, and always on a node in missingEntityLeis, which has no name and is looked up by its LEI alone.',
                  ),
              })
              .optional()
              .describe(
                "Disclosure for this node's cross-reference: how many potential matches existed before the per-node cap, whether sanctionsHits is the complete set, and what was screened. Present only when the node was screened.",
              ),
            sanctionsHits: z
              .array(
                z
                  .object({
                    source: z
                      .enum(SOURCE_CODES)
                      .describe(
                        'Watchlist whose record this hit is attributed to: primaryName comes from it. For an OFAC party both OFAC lists publish, ofac_sdn unless the Consolidated record matched alone or better, and matchedName, matchedIdentifiers, and matchedOn cover what either record matched; sources names every list.',
                      ),
                    sourceLabel: z.string().describe('Human-readable source list name.'),
                    sourceEntryId: z
                      .string()
                      .describe('Source entry ID — pass to sanctions_get_designation.'),
                    sources: HitSourcesSchema,
                    primaryName: z.string().describe('Primary published name of the designation.'),
                    matchedName: z
                      .string()
                      .optional()
                      .describe(
                        "The designation's name or alias that matched one of this node's screened names — the strongest match. Absent when only an identifier produced the hit.",
                      ),
                    matchType: z
                      .enum(['exact', 'strong', 'approximate'])
                      .optional()
                      .describe(
                        'Match classification of matchedName: exact or strong, never approximate (the cross-reference screens strict, never fuzzy). Absent when only an identifier produced the hit.',
                      ),
                    score: z
                      .number()
                      .optional()
                      .describe(
                        'Never set by this cross-reference: only an approximate (fuzzy) match carries a raw Jaro-Winkler score, and the cross-reference screens strict.',
                      ),
                    matchedIdentifiers: z
                      .array(MatchedIdentifierSchema)
                      .optional()
                      .describe(
                        "Every identifier the designation publishes that equals this node's LEI or its country-matched registration number, as published. Present only when an identifier produced the hit.",
                      ),
                    matchedOn: z
                      .array(ScreenedInputSchema)
                      .describe(
                        'Every input of this node that produced the hit — its legal name, an other or transliterated name, its LEI, or its registration number — in screening order. Only its LEI on a node in missingEntityLeis.',
                      ),
                  })
                  .describe('A potential watchlist match on this node — verify, do not assume.'),
              )
              .optional()
              .describe(
                'Per-node cross-reference results, one hit per designation (an OFAC party both OFAC lists publish once) — exact name and identifier matches first, then strong name matches. Present only when screenNodes is true.',
              ),
          })
          .describe('One entity in the ownership graph.'),
      )
      .describe(
        'This page of entities, ordered by depth then LEI. The root appears once, on the initial page.',
      ),
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
      .describe(
        'This page of directed edges. Endpoints refer to nodes in the assembled segment across pages, not necessarily this page.',
      ),
    boundaries: z
      .array(BoundarySchema)
      .describe(
        'This page of omitted branch roots; trace each LEI with its direction and depth after draining this segment.',
      ),
    totalAvailable: z
      .number()
      .int()
      .describe(
        'Exact number of stream records in this segment: nodes plus edges plus boundaries.',
      ),
    totalAvailableBasis: z
      .literal('exact')
      .describe('The entire segment topology was enumerated to count its records.'),
    hasMore: z
      .boolean()
      .describe('More records remain in this segment; false does not imply complete ownership.'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Continue this segment with the same query and this cursor; absent on its last page.',
      ),
    truncationReasons: z
      .array(z.enum(['page_limit', 'depth_limit', 'ultimate_leaf']))
      .describe(
        'Independent reasons the current response is partial: remaining pages or omitted branches.',
      ),
    missingEntityCount: z
      .number()
      .int()
      .describe(
        'Number of nodes absent from Level 1 across the entire segment, including earlier and later pages.',
      ),
    byteTargetExceeded: z
      .boolean()
      .describe(
        'Serialized structuredContent plus content exceeds the soft 64-KiB target; indivisible records are retained intact.',
      ),
    complete: z
      .boolean()
      .describe(
        "True only on the last page when no depth or ultimate-leaf boundary remains and every node in the entire segment has a Level 1 record (missingEntityCount is zero). It does not say every parent is known: read each node's parentStatus. A finished segment is never proof of full beneficial ownership.",
      ),
    truncated: z
      .boolean()
      .describe(
        'True while this segment has more pages or has omitted depth-limit or ultimate-leaf branches; read truncationReasons. Drain nextCursor pages, then trace each boundary with its LEI, same-side direction and depth, including at depth five. An ultimate edge counts as a boundary only when its far node is absent. Siblings and co-parents are never walked and never count.',
      ),
    reportingExceptionsLoaded: z
      .boolean()
      .describe(
        "Whether GLEIF reporting exceptions are loaded in the mirror. When false, a node's parent level with no published relationship reads unknown rather than exception or none.",
      ),
    missingEntityLeis: z
      .array(z.string())
      .describe(
        'This page of nodes absent from Level 1; missingEntityCount covers the whole segment. Their nodes carry the LEI in place of a legal name and no jurisdiction/status — never read that LEI as a legal name. A per-node screen is the LEI looked up as an identifier, nothing else: screenedInputs is empty and every hit is matchedOn their lei.',
      ),
    screeningStatus: z
      .enum(['screened', 'not_requested', 'not_ready'])
      .describe(
        'Screening status for this page: screened = every returned node was screened (an edge-only page screens zero nodes); not_requested = screenNodes was false; not_ready = screening was requested but the sanctions mirror has never synced, so NO node was screened and an absence of hits says nothing about any node.',
      ),
    screenedNodeCount: z
      .number()
      .describe('How many nodes on this page were screened (zero on edge/boundary-only pages).'),
    flaggedNodeCount: z
      .number()
      .describe('How many screened nodes on this page had at least one potential watchlist match.'),
    caveat: z
      .string()
      .describe('Decision-support caveat — node screening is an aid, not a determination.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Input normalization notice when limit was clamped.'),
  },
  enrichmentTrailer: { notice: { render: renderLimitNotice } },
  errors: [
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The cursor is corrupt, outside the stream, or belongs to different query parameters.',
      recovery:
        'Restart sanctions_trace_ownership with the original query and no cursor, then drain its new pages.',
    },
    {
      reason: 'stale_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The recomputed segment topology differs from the cursor topology.',
      recovery:
        'Restart sanctions_trace_ownership with the original query and no cursor, then drain its new pages.',
    },
    {
      reason: 'lei_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No GLEIF entity in the mirror carries the root LEI, and its check digits are valid.',
      recovery:
        'Resolve the entity name with sanctions_resolve_entity to obtain a valid root LEI first.',
    },
    {
      reason: 'invalid_lei_checksum',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No GLEIF entity in the mirror carries the root LEI, and its ISO 17442 check digits fail.',
      recovery:
        'Re-check the root LEI for a mistyped or transposed character, or resolve the entity name with sanctions_resolve_entity to obtain a valid LEI.',
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
      throw ctx.fail('mirror_not_ready', 'The local GLEIF (LEI) mirror is not yet populated.');
    }

    const rootExists = (await svc.existingLeiEntities([input.lei])).has(input.lei);
    if (!rootExists && !(await svc.hasRelationshipReference(input.lei))) {
      throw leiChecksumValid(input.lei)
        ? ctx.fail('lei_not_found', `No GLEIF entity with LEI "${input.lei}".`)
        : ctx.fail(
            'invalid_lei_checksum',
            `LEI "${input.lei}" fails its ISO 17442 check digits, and no GLEIF entity carries it.`,
          );
    }

    const { nodes, edges, parentTypesByLei, boundaries } = await traverse(
      svc,
      input.lei,
      input.direction,
      input.depth,
      ctx.signal,
    );
    const orderedNodes = [...nodes.values()].sort(
      (a, b) => a.depth - b.depth || lexical(a.lei, b.lei),
    );
    const limit = Math.min(input.limit, PAGE_LIMIT);
    const limitNotice =
      input.limit > PAGE_LIMIT
        ? `Requested limit ${input.limit} clamped to ${PAGE_LIMIT} records.`
        : undefined;
    if (limitNotice !== undefined) ctx.enrich.notice(limitNotice);
    const query = {
      lei: input.lei,
      direction: input.direction,
      depth: input.depth,
      screenNodes: input.screenNodes,
      limit,
    };
    const topology = createHash('sha256')
      .update(JSON.stringify({ nodes: orderedNodes, edges, boundaries }))
      .digest('hex');
    const totalAvailable = orderedNodes.length + edges.length + boundaries.length;
    let offset = 0;
    if (input.cursor?.trim()) {
      // Decode is deliberately separate from validation: malformed JSON is caller input.
      const decoded = decodeCursor(input.cursor);
      if (!decoded || JSON.stringify(decoded.query) !== JSON.stringify(query)) {
        throw ctx.fail('invalid_cursor', 'The ownership cursor is invalid for this query.');
      }
      if (decoded.topology !== topology)
        throw ctx.fail('stale_cursor', 'The ownership topology changed between pages.');
      if (decoded.offset > totalAvailable)
        throw ctx.fail('invalid_cursor', 'The ownership cursor lies outside this segment.');
      offset = decoded.offset;
    }
    const existing = await svc.existingLeiEntities(orderedNodes.map((node) => node.lei));
    const missingEntityCount = orderedNodes.length - existing.size;
    const reportingExceptionsLoaded = await svc.reportingExceptionsLoaded();
    const statusByLei = new Map<string, Record<ParentLevel, ParentLevelStatus>>();
    const missingEntityLeis: string[] = [];

    const sanctionsReady = await svc.sanctionsReady();
    const screened = input.screenNodes && sanctionsReady;
    const screeningStatus: 'screened' | 'not_requested' | 'not_ready' = screened
      ? 'screened'
      : input.screenNodes
        ? 'not_ready'
        : 'not_requested';
    let screenedNodeCount = 0;
    let flaggedNodeCount = 0;
    const screensByLei = new Map<string, CrossReferenceResult>();

    const pageNodes: GraphNode[] = [];
    const pageEdges: GraphEdge[] = [];
    const pageBoundaries: Boundary[] = [];
    const buildPage = (nextOffset: number, byteTargetExceeded = false) => ({
      rootLei: input.lei,
      nodes: pageNodes.map((node) => {
        const screen = screensByLei.get(node.lei);
        const parentStatus = statusByLei.get(node.lei);
        return {
          lei: node.lei,
          legalName: node.legalName,
          ...(node.jurisdiction ? { jurisdiction: node.jurisdiction } : {}),
          ...(node.status ? { status: node.status } : {}),
          depth: node.depth,
          role: node.role,
          ...(node.reachedVia ? { reachedVia: node.reachedVia } : {}),
          ...(parentStatus ? { parentStatus } : {}),
          ...(screen
            ? {
                sanctionsScreen: {
                  totalAvailable: screen.totalAvailable,
                  totalAvailableBasis: screen.totalAvailableBasis,
                  // The per-node screen never pages, so whatever the cap left
                  // behind is everything past the hits returned here.
                  hasMore: screen.hits.length < screen.totalAvailable,
                  screenedInputs: screen.screenedInputs,
                },
                sanctionsHits: screen.hits.map((h) => ({
                  source: h.source,
                  sourceLabel: SOURCE_LABELS[h.source],
                  sourceEntryId: h.sourceEntryId,
                  sources: h.sources,
                  primaryName: h.primaryName,
                  ...(h.matchedName !== undefined ? { matchedName: h.matchedName } : {}),
                  ...(h.matchType !== undefined ? { matchType: h.matchType } : {}),
                  ...(h.score !== undefined ? { score: h.score } : {}),
                  ...(h.matchedIdentifiers ? { matchedIdentifiers: h.matchedIdentifiers } : {}),
                  matchedOn: h.matchedOn,
                })),
              }
            : {}),
        };
      }),
      edges: pageEdges,
      boundaries: pageBoundaries,
      totalAvailable,
      totalAvailableBasis: 'exact' as const,
      hasMore: nextOffset < totalAvailable,
      ...(nextOffset < totalAvailable
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ version: 1, query, topology, offset: nextOffset }),
            ).toString('base64url'),
          }
        : {}),
      truncationReasons: [
        ...(nextOffset < totalAvailable ? ['page_limit' as const] : []),
        ...(['depth_limit', 'ultimate_leaf'] as const).filter((reason) =>
          boundaries.some((b) => b.reason === reason),
        ),
      ],
      missingEntityCount,
      byteTargetExceeded,
      complete:
        nextOffset === totalAvailable && boundaries.length === 0 && missingEntityCount === 0,
      truncated: nextOffset < totalAvailable || boundaries.length > 0,
      reportingExceptionsLoaded,
      missingEntityLeis,
      screeningStatus,
      screenedNodeCount,
      flaggedNodeCount,
      caveat: SCREENING_CAVEAT,
    });
    const stream = [
      ...orderedNodes.map((node) => ({ kind: 'node' as const, node })),
      ...edges.map((edge) => ({ kind: 'edge' as const, edge })),
      ...boundaries.map((boundary) => ({ kind: 'boundary' as const, boundary })),
    ];
    let nextOffset = offset;
    for (const record of stream.slice(offset, offset + limit)) {
      ctx.signal.throwIfAborted();
      if (record.kind === 'node') {
        const node = record.node;
        // Hydrate only the record being appended. A screened node is never discarded.
        const [e] = await svc.getLeiEntitiesBatch([node.lei]);
        if (e) {
          node.legalName = e.legalName;
          if (e.jurisdiction) node.jurisdiction = e.jurisdiction;
          if (e.status) node.status = e.status;
        } else missingEntityLeis.push(node.lei);
        const parentTypes = parentTypesByLei.get(node.lei);
        if (parentTypes) {
          const statuses = await parentStatuses(
            svc,
            new Map([[node.lei, parentTypes]]),
            reportingExceptionsLoaded,
          );
          for (const [lei, status] of statuses) statusByLei.set(lei, status);
        }
        if (screened) {
          const screen = await crossReferenceEntity(
            svc,
            e ?? { lei: node.lei },
            PER_NODE_SCREEN_LIMIT,
            ctx,
          );
          screensByLei.set(node.lei, screen);
          screenedNodeCount++;
          if (screen.hits.length > 0) flaggedNodeCount++;
        }
        pageNodes.push(node);
      } else if (record.kind === 'edge') pageEdges.push(record.edge);
      else pageBoundaries.push(record.boundary);
      nextOffset++;
      if (pageBytes(buildPage(nextOffset), limitNotice) >= PAGE_BYTE_TARGET) break;
    }
    const page = buildPage(nextOffset);
    page.byteTargetExceeded = pageBytes(page, limitNotice) > PAGE_BYTE_TARGET;
    return page;
  },

  format: (r) => {
    const lines = [`# Ownership graph for \`${r.rootLei}\``, ''];
    lines.push(`**${r.nodes.length} node(s), ${r.edges.length} edge(s).**`);
    lines.push(
      `**Segment page:** totalAvailable: ${r.totalAvailable} records (nodes + edges + boundaries); totalAvailableBasis: ${r.totalAvailableBasis}; hasMore: ${r.hasMore}; byteTargetExceeded: ${r.byteTargetExceeded}${r.byteTargetExceeded ? ' (soft target exceeded; records retained intact)' : ''}; missingEntityCount: ${r.missingEntityCount}; truncationReasons: ${JSON.stringify(r.truncationReasons)}.`,
    );
    lines.push(
      'Pages read current mirrors, not an immutable snapshot. Assemble nodes and edges across pages; a finished segment is not proof of full beneficial ownership.',
    );
    if (r.nextCursor)
      lines.push(
        `Continue sanctions_trace_ownership with the same lei, direction, depth, screenNodes and limit, and cursor: ${r.nextCursor}`,
      );

    lines.push(
      r.complete
        ? "**Graph coverage:** complete within the loaded relationship data — nothing was truncated at the requested depth, and every node resolved to a GLEIF Level 1 record. Each walked node's parent status says what GLEIF publishes about its direct and ultimate parents."
        : '**Graph coverage:** incomplete — the relationship graph below is a partial view of what the mirror holds.',
    );
    if (r.truncationReasons.some((reason) => reason !== 'page_limit')) {
      lines.push(
        r.truncationReasons.includes('ultimate_leaf')
          ? '- Truncated: the loaded relationships hold ownership links on the walked side that this graph does not show — past the requested depth, or of a node reached only via an ultimate-parent edge, which is never walked. Drain all pages, then use the boundary trace calls to retrieve omitted branches with depth reset.'
          : '- Truncated at the requested depth: further ownership relationships exist beyond it. Drain all pages, then use the boundary trace calls to retrieve omitted branches with depth reset, including at depth five.',
      );
    }
    if (r.boundaries.length) {
      lines.push('\n## Omitted branches');
      for (const boundary of r.boundaries) {
        lines.push(
          `- ${boundary.reason}: sanctions_trace_ownership ${JSON.stringify({ lei: boundary.lei, direction: boundary.direction, depth: boundary.depth })}. Preserve screenNodes to screen this branch. The new segment resets depth and role; deduplicate queued (lei, direction) roots and edge identities across segments.`,
        );
      }
    }
    if (r.missingEntityLeis.length > 0) {
      lines.push(
        `- Absent from the GLEIF Level 1 entity mirror (${r.missingEntityLeis.length}): ${r.missingEntityLeis
          .map((lei) => `\`${lei}\``)
          .join(
            ', ',
          )}. Those nodes show their LEI where a legal name would be; a per-node screen of one is its LEI lookup alone, since with no record there is no name to screen.`,
      );
    }

    if (!r.reportingExceptionsLoaded) {
      lines.push(
        '**Reporting exceptions:** not loaded — a parent level with no published relationship reads unknown, never "no parent". mirror:refresh loads them, or mirror:init on a mirror loaded before they existed.',
      );
    }

    lines.push(
      r.screeningStatus === 'not_ready'
        ? '**Node screening:** requested but NOT run — the sanctions mirror has never synced, so no node was screened. That is not a clearance for any node.'
        : r.screeningStatus === 'not_requested'
          ? '**Node screening:** not requested — no node was cross-referenced against the watchlists (set screenNodes: true).'
          : `**Node screening:** screened ${r.screenedNodeCount} node(s); ${r.flaggedNodeCount} had potential matches; ${r.nodes.filter((node) => node.sanctionsScreen?.hasMore).length} capped.`,
    );

    // Which parent levels have their relationship edge in this graph.
    const shownParentEdges = new Set(r.edges.map((e) => `${e.childLei}|${e.relationshipType}`));
    const recordless = new Set(r.missingEntityLeis);
    lines.push('\n## Entities');
    for (const node of r.nodes) {
      const meta = [node.jurisdiction, node.status].filter(Boolean).join(', ');
      const via = node.reachedVia
        ? ', reached only via an ultimate-parent edge (leaf, not walked)'
        : '';
      const entity = `- **${node.legalName}** \`${node.lei}\` — ${node.role}, depth ${node.depth}${meta ? ` (${meta})` : ''}${via}`;
      const levelText = (name: ParentLevel, form: 'block' | 'line'): string =>
        node.parentStatus
          ? parentLevelText(
              node.parentStatus[name],
              form,
              shownParentEdges.has(`${node.lei}|${PARENT_LEVELS[name].relationshipType}`),
              r.totalAvailable > r.nodes.length + r.edges.length + r.boundaries.length,
            )
          : '';
      const hits = node.sanctionsHits ?? [];
      const hasRecord = !recordless.has(node.lei);
      // What a screen ran beyond the legal name and LEI; a node with no Level 1
      // record had no name screened, only its LEI looked up.
      const screenedInputs = node.sanctionsScreen?.screenedInputs ?? [];
      const screenedNote = !hasRecord
        ? ': the LEI lookup only (no Level 1 record, so no name was screened)'
        : screenedInputs.length > 0
          ? ` beyond the legal name and LEI: ${screenedInputs.map(screenedInputText).join('; ')}`
          : undefined;

      // A node with no potential matches — screened or not — is one line carrying
      // every field it has, so the nodes with matches stand out below the fold.
      if (hits.length === 0) {
        const parts = [entity];
        if (node.parentStatus) {
          parts.push(
            `parents — direct: ${levelText('direct', 'line')}; ultimate: ${levelText('ultimate', 'line')}`,
          );
        }
        if (node.sanctionsScreen) {
          parts.push(
            `screen: no potential matches (not a clearance), 0 of ${node.sanctionsScreen.totalAvailable} (count basis: ${node.sanctionsScreen.totalAvailableBasis})`,
          );
          if (screenedNote) parts.push(`screened${screenedNote}`);
        }
        lines.push(parts.join(' · '));
        continue;
      }

      lines.push(entity);
      if (node.parentStatus) {
        lines.push(`  - direct parent: ${levelText('direct', 'block')}`);
        lines.push(`  - ultimate parent: ${levelText('ultimate', 'block')}`);
      }
      for (const h of hits) {
        const scoreStr = h.score !== undefined ? ` · score ${h.score.toFixed(3)}` : '';
        const matched = [
          ...(h.matchedName !== undefined
            ? [`matched "${h.matchedName}" — ${h.matchType}${scoreStr}`]
            : []),
          ...(h.matchedIdentifiers ?? []).map(matchedIdentifierText),
        ];
        const also = alsoListedText(h.source, h.sources);
        lines.push(
          `  - ⚠ ${h.primaryName} — ${h.sourceLabel} (\`${h.source}\`, entry ${h.sourceEntryId}${also ? `; also listed on ${also}` : ''}): ${matched.join('; ')} — matched on: ${h.matchedOn.map(screenedInputText).join('; ')}`,
        );
      }
      if (node.sanctionsScreen) {
        const s = node.sanctionsScreen;
        lines.push(
          `  - Screen coverage: showing ${hits.length} of ${s.totalAvailable} potential match(es) (count basis: ${s.totalAvailableBasis}); more available: ${s.hasMore}${
            s.hasMore
              ? ` — ${crossReferencePointer(hasRecord ? node.legalName : undefined, node.lei, s.screenedInputs)}`
              : ''
          }`,
        );
        if (screenedNote) lines.push(`  - Screened${screenedNote}`);
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
