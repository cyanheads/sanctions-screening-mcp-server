/**
 * @fileoverview The candidate-pool rule the fuzzy passes share. Each blocking key
 * (a query token's prefix, a query word's phonetic key) names one index lookup,
 * and the rows it matches form a block. Blocks are pooled whole or not at all,
 * smallest first, until the pool's budget is spent; for the blocks that did not
 * fit, the rows matching two of their keys are pooled the same way, through a
 * bounded number of pair lookups taken in the order the blocks were measured; a
 * stoplisted word's key takes part in that pair round only. Pool membership
 * therefore depends only on the keys and what each lookup matches — never on
 * the order rows were written in or an index returns them in.
 * @module services/screening/candidate-pool
 */

/**
 * The most candidates one pool holds for scoring; the designation fuzzy pass
 * pools each selected list under a budget of its own. Scoring is linear in
 * pooled candidates × query tokens, and what blocking matches is unbounded — the
 * sanctions lists' own primary names, used as queries, match up to ~29,000 name
 * rows — so the pool takes a fixed bound. At 2,000, pooling whole blocks pools a
 * perturbed list name's own record far more often than a per-key row limit,
 * which keeps whichever rows a lookup reads first. A property
 * of the pooling rule, not a per-deployment tuning surface, so a documented
 * constant rather than a config knob.
 */
export const FUZZY_POOL_BUDGET = 2000;

/**
 * The most pair lookups one pool makes for the blocks that did not fit: every
 * pair when eight or fewer were left out and no partner joins them (8 choose 2),
 * else the first pairs in the order the blocks were measured (see
 * {@link poolCandidates}) — which, among blocks past the whole budget, is key
 * order, not rarity. A pair lookup intersects two blocks, so it costs about what
 * two block lookups do; this bounds the extra work a long query of common words
 * can cause.
 */
export const FUZZY_POOL_PAIR_LOOKUPS = 28;

/**
 * The ids matching every one of `keys` — one key for a block, two for a pair —
 * distinct, or `undefined` when more than `limit` match.
 */
export type BlockLookup<Id> = (keys: readonly string[], limit: number) => readonly Id[] | undefined;

/** A fuzzy pass's candidate pool. */
export interface CandidatePool<Id> {
  /**
   * True when the budget left at least one block out: blocking matched more
   * candidates than were pooled, so the pool — and every count derived from
   * it — is a bounded subset of what the query reaches.
   */
  bounded: boolean;
  /** The pooled ids, in the order they were pooled. */
  ids: Set<Id>;
}

/**
 * Pool candidates for `keys` under {@link FUZZY_POOL_BUDGET}. Every block is
 * measured first; then, smallest first (ties in code-unit order of the key),
 * each is pooled when the ids it adds keep the pool within the budget, and left
 * out whole otherwise. A lookup answers a block with more ids than the whole
 * budget with `undefined` rather than its ids: it can never fit, so it is left
 * out unsized, tied with every other block past the budget. The left-out blocks
 * are then paired in the order they were measured — the sized ones smallest
 * first, then those past the budget in key order, whatever their size — each
 * with every later one, and each pair's shared ids pooled by the same rule, up
 * to {@link FUZZY_POOL_PAIR_LOOKUPS} lookups.
 *
 * `partners` are keys that never form a block of their own — a stoplist word's
 * prefix, whose block is every name with a legal form — but follow the left-out
 * blocks in the pair round, so `deu` × `akt` can still narrow `Deutsche` to the
 * names that also carry `Aktiengesellschaft`. They never pair with each other.
 */
export function poolCandidates<Id>(
  keys: readonly string[],
  lookup: BlockLookup<Id>,
  partners: readonly string[] = [],
): CandidatePool<Id> {
  const ids = new Set<Id>();
  const admit = (block: readonly Id[] | undefined): boolean => {
    if (!block) return false;
    const added = block.filter((id) => !ids.has(id));
    if (ids.size + added.length > FUZZY_POOL_BUDGET) return false;
    for (const id of added) ids.add(id);
    return true;
  };

  const blocks = [...new Set(keys)]
    .map((key) => ({ key, ids: lookup([key], FUZZY_POOL_BUDGET) }))
    .sort((a, b) => blockSize(a.ids) - blockSize(b.ids) || compareCodeUnits(a.key, b.key));
  const leftOut: string[] = [];
  for (const block of blocks) if (!admit(block.ids)) leftOut.push(block.key);
  const pairable = [
    ...leftOut,
    ...new Set(partners.filter((key) => !blocks.some((block) => block.key === key))),
  ];

  let pairLookups = 0;
  pairs: for (const [i, key] of leftOut.entries()) {
    for (const other of pairable.slice(i + 1)) {
      if (pairLookups === FUZZY_POOL_PAIR_LOOKUPS) break pairs;
      pairLookups++;
      admit(lookup([key, other], FUZZY_POOL_BUDGET));
    }
  }
  return { ids, bounded: leftOut.length > 0 };
}

/** A block's size for ordering: past the budget, every block ties. */
function blockSize(ids: readonly unknown[] | undefined): number {
  return ids?.length ?? FUZZY_POOL_BUDGET + 1;
}

/** Code-unit order — the same on every host, unlike a locale collation. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
