/**
 * @fileoverview The block-and-budget pooling rule the fuzzy passes share: blocks
 * are pooled whole or not at all, smallest first, under one budget; pair lookups
 * for the blocks that did not fit are bounded, and run in the order the blocks
 * were measured — the sized ones smallest first, then those past the whole
 * budget, never sized, in key order; the pool depends only on what the lookups
 * match, never on key or row order; and the result says whether the budget
 * left a block out.
 * @module tests/services/candidate-pool.test
 */

import { describe, expect, it } from 'vitest';
import {
  FUZZY_POOL_BUDGET,
  FUZZY_POOL_PAIR_LOOKUPS,
  poolCandidates,
} from '@/services/screening/candidate-pool.js';

/** `count` consecutive ids from `start`. */
const range = (start: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => start + i);

/**
 * A lookup over a fixed corpus: each key matches the ids listed for it, a pair
 * matches the ids both of its keys list. Records every call it answers.
 */
function corpus(blocks: Record<string, readonly number[]>) {
  const calls: string[][] = [];
  const lookup = (keys: readonly string[], limit: number): number[] | undefined => {
    calls.push([...keys]);
    const [first, ...rest] = keys.map((key) => blocks[key] ?? []);
    const ids = (first ?? []).filter((id) => rest.every((block) => block.includes(id)));
    return ids.length > limit ? undefined : ids;
  };
  return { calls, lookup };
}

describe('poolCandidates', () => {
  it('pools every block whole when they fit, and reports nothing left out', () => {
    const { lookup } = corpus({ a: [1, 2], b: [2, 3], c: [] });
    const pool = poolCandidates(['a', 'b', 'c'], lookup);
    expect([...pool.ids].sort()).toEqual([1, 2, 3]);
    expect(pool.bounded).toBe(false);
  });

  it('pools smallest first and leaves out whole the block that no longer fits', () => {
    const { lookup } = corpus({
      small: range(0, 10),
      middle: range(100, 1000),
      large: range(5000, 1500),
    });
    const pool = poolCandidates(['large', 'middle', 'small'], lookup);
    // small (10) and middle (1,000) fit; large (1,500) would take the pool past the budget.
    expect(pool.ids.size).toBe(1010);
    expect(pool.ids.has(5000)).toBe(false);
    expect(pool.bounded).toBe(true);
  });

  it('pools a block larger than the remaining budget when only its new ids must fit', () => {
    const { lookup } = corpus({ first: range(0, 1500), overlapping: range(0, 1600) });
    const pool = poolCandidates(['first', 'overlapping'], lookup);
    expect(pool.ids.size).toBe(1600);
    expect(pool.bounded).toBe(false);
  });

  it('leaves out a block with more ids than the whole budget, at no cost to the others', () => {
    const { lookup } = corpus({ huge: range(0, FUZZY_POOL_BUDGET + 1), rare: [7, 9_000_000] });
    const pool = poolCandidates(['huge', 'rare'], lookup);
    expect([...pool.ids].sort((a, b) => a - b)).toEqual([7, 9_000_000]);
    expect(pool.bounded).toBe(true);
  });

  it('never pools more than the budget', () => {
    const blocks = Object.fromEntries(
      range(0, 64).map((word) => [`w${word}`, range(word * 1000, 300)]),
    );
    const pool = poolCandidates(Object.keys(blocks), corpus(blocks).lookup);
    expect(pool.ids.size).toBeLessThanOrEqual(FUZZY_POOL_BUDGET);
    expect(pool.bounded).toBe(true);
  });

  it('pools the same ids whatever order the keys arrive in or the rows come back in', () => {
    const blocks = {
      bb: range(0, 900),
      aa: range(1000, 900),
      cc: range(2000, 900), // ties with aa and bb on size: the key decides
      dd: [...range(0, 50), ...range(3000, 50)],
    };
    const reversed = Object.fromEntries(
      Object.entries(blocks).map(([key, ids]) => [key, [...ids].reverse()]),
    );
    const forward = poolCandidates(['aa', 'bb', 'cc', 'dd'], corpus(blocks).lookup);
    const backward = poolCandidates(['dd', 'cc', 'bb', 'aa'], corpus(reversed).lookup);
    expect(new Set(backward.ids)).toEqual(new Set(forward.ids));
    // dd (100) first, then aa and bb of the three tied 900s: cc, last by key, is left out.
    expect(forward.ids.has(2000)).toBe(false);
    expect(forward.ids.has(1000) && forward.ids.has(0)).toBe(true);
  });

  it('orders tied blocks by code unit, not by locale', () => {
    // 'Z' (U+005A) sorts before 'a' (U+0061) by code unit; a locale collation puts it after.
    const { lookup } = corpus({ a: range(0, 1500), Z: range(5000, 1500) });
    const pool = poolCandidates(['a', 'Z'], lookup);
    expect(pool.ids.has(5000)).toBe(true);
    expect(pool.ids.has(0)).toBe(false);
  });

  it('looks each distinct key up once', () => {
    const { calls, lookup } = corpus({ a: [1] });
    poolCandidates(['a', 'a', 'a'], lookup);
    expect(calls).toEqual([['a']]);
  });

  it('pools the rows two left-out blocks share, rarest blocks paired first', () => {
    const { calls, lookup } = corpus({
      rare: [...range(0, 1200), 42_000],
      common: [...range(10_000, 1900), 42_000],
      filler: range(20_000, 1000),
    });
    const pool = poolCandidates(['common', 'filler', 'rare'], lookup);
    // filler (1,000) fits first; rare (1,201) and common (1,901) then do not.
    expect(pool.ids.has(42_000)).toBe(true);
    expect(pool.ids.size).toBe(1001);
    expect(pool.bounded).toBe(true);
    expect(calls.slice(3)).toEqual([['rare', 'common']]);
  });

  it('pairs the sized blocks that did not fit smallest first, then the blocks past the budget in key order, never by their size', () => {
    const { calls, lookup } = corpus({
      filler: range(0, 1000),
      m: range(10_000, 1201),
      b: range(20_000, 1901),
      // Both past the whole budget: `a` holds more ids than `c`, yet pairs first.
      a: range(30_000, FUZZY_POOL_BUDGET + 999),
      c: range(40_000, FUZZY_POOL_BUDGET + 1),
    });
    poolCandidates(['a', 'b', 'c', 'filler', 'm'], lookup);
    expect(calls.filter((call) => call.length === 2)).toEqual([
      ['m', 'b'],
      ['m', 'a'],
      ['m', 'c'],
      ['b', 'a'],
      ['b', 'c'],
      ['a', 'c'],
    ]);
  });

  it('makes at most the bounded number of pair lookups, pairing blocks past the budget in key order', () => {
    const keys = range(0, 12).map((i) => `k${String(i).padStart(2, '0')}`);
    const { calls, lookup } = corpus(
      Object.fromEntries(keys.map((key) => [key, range(0, FUZZY_POOL_BUDGET + 1)])),
    );
    const pool = poolCandidates(keys, lookup);
    const pairs = calls.filter((call) => call.length === 2);
    expect(pairs).toHaveLength(FUZZY_POOL_PAIR_LOOKUPS);
    expect(pairs.slice(0, 3)).toEqual([
      ['k00', 'k01'],
      ['k00', 'k02'],
      ['k00', 'k03'],
    ]);
    expect(pairs.at(-1)).toEqual(['k02', 'k09']);
    expect(pool.ids.size).toBe(0);
    expect(pool.bounded).toBe(true);
  });

  it('pools nothing and leaves nothing out for no keys', () => {
    const pool = poolCandidates([], corpus({}).lookup);
    expect(pool.ids.size).toBe(0);
    expect(pool.bounded).toBe(false);
  });
});

describe('poolCandidates — partner keys (issue #55)', () => {
  it('never looks a partner up alone, so it pools nothing by itself', () => {
    const { calls, lookup } = corpus({ word: [1], stop: [2, 3] });
    const pool = poolCandidates(['word'], lookup, ['stop']);
    expect([...pool.ids]).toEqual([1]);
    expect(pool.bounded).toBe(false);
    expect(calls).toEqual([['word']]);
  });

  it('pairs a partner with a block that did not fit, pooling the rows both hold', () => {
    const { calls, lookup } = corpus({
      common: [...range(0, FUZZY_POOL_BUDGET + 1), 42_000],
      stop: [42_000, ...range(50_000, FUZZY_POOL_BUDGET + 1)],
    });
    const pool = poolCandidates(['common'], lookup, ['stop']);
    expect([...pool.ids]).toEqual([42_000]);
    expect(pool.bounded).toBe(true);
    expect(calls).toEqual([['common'], ['common', 'stop']]);
  });

  it('pairs each left-out block with the later ones, then with every partner, and never two partners', () => {
    const huge = range(0, FUZZY_POOL_BUDGET + 1);
    const { calls, lookup } = corpus({ rare: huge, common: huge, s1: huge, s2: huge });
    poolCandidates(['common', 'rare'], lookup, ['s1', 's2']);
    expect(calls.filter((call) => call.length === 2)).toEqual([
      ['common', 'rare'],
      ['common', 's1'],
      ['common', 's2'],
      ['rare', 's1'],
      ['rare', 's2'],
    ]);
  });

  it('treats a partner that is also a block key as the block, and pairs each pair of keys once', () => {
    const huge = range(0, FUZZY_POOL_BUDGET + 1);
    const { calls, lookup } = corpus({ a: huge, b: huge });
    poolCandidates(['a', 'b'], lookup, ['b', 'b']);
    expect(calls).toEqual([['a'], ['b'], ['a', 'b']]);
  });
});
