/**
 * @fileoverview Unit tests for the pure text-matching primitives: folding,
 * tokenization, FTS match building, Jaro-Winkler, and Double-Metaphone. These
 * are the source of the real signal the matching engine surfaces.
 * @module tests/services/text-matching.test
 */

import { describe, expect, it } from 'vitest';
import {
  bestTokenScore,
  buildFtsMatch,
  doubleMetaphone,
  fold,
  jaro,
  jaroWinkler,
  tokenize,
} from '@/services/screening/text-matching.js';

describe('fold', () => {
  it('lowercases, strips diacritics, and collapses punctuation', () => {
    expect(fold('Müller-Schmidt, GmbH')).toBe('muller schmidt gmbh');
    expect(fold('  José  Peña  ')).toBe('jose pena');
    expect(fold("O'Brien & Sons, Inc.")).toBe('o brien sons inc');
  });

  it('returns empty string for punctuation-only input', () => {
    expect(fold('---')).toBe('');
  });
});

describe('tokenize', () => {
  it('splits folded names into tokens', () => {
    expect(tokenize(fold('Ivan Volkov'))).toEqual(['ivan', 'volkov']);
  });
});

describe('buildFtsMatch', () => {
  it('ANDs quoted tokens', () => {
    expect(buildFtsMatch('Ivan Volkov')).toBe('"ivan" AND "volkov"');
  });

  it('neutralizes FTS operators by quoting', () => {
    // A name containing FTS syntax must not break the query.
    expect(buildFtsMatch('NEAR OR foo')).toBe('"near" AND "or" AND "foo"');
  });

  it('returns null when the query folds to nothing', () => {
    expect(buildFtsMatch('***')).toBeNull();
  });
});

describe('jaro / jaroWinkler', () => {
  it('returns 1 for identical strings', () => {
    expect(jaro('volkov', 'volkov')).toBe(1);
    expect(jaroWinkler('volkov', 'volkov')).toBe(1);
  });

  it('returns 0 for completely dissimilar strings', () => {
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('boosts a shared prefix above plain Jaro', () => {
    const a = 'martha';
    const b = 'marhta';
    expect(jaroWinkler(a, b)).toBeGreaterThan(jaro(a, b));
  });

  it('scores near-miss name variants high (0.8+)', () => {
    expect(jaroWinkler('volkov', 'volkow')).toBeGreaterThan(0.9);
    expect(jaroWinkler('katarina', 'katerina')).toBeGreaterThan(0.9);
  });

  it('is bounded to [0, 1]', () => {
    const score = jaroWinkler('fictional trading', 'fictional traiding');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('bestTokenScore', () => {
  it('finds the best per-token match across word-order swaps', () => {
    const q = tokenize(fold('Volkov Ivan'));
    const c = tokenize(fold('Ivan Volkov'));
    expect(bestTokenScore(q, c)).toBe(1);
  });
});

describe('doubleMetaphone', () => {
  it('produces matching keys for transliteration-class variants', () => {
    // Mohammed / Muhammad and Geoff / Jeff encode to the same primary key,
    // which is how the phonetic fallback catches a romanization the strict and
    // Jaro-Winkler paths would miss.
    expect(doubleMetaphone('mohammed')).toBe(doubleMetaphone('muhammad'));
    expect(doubleMetaphone('geoff')).toBe(doubleMetaphone('jeff'));
    expect(doubleMetaphone('katarina')).toBe(doubleMetaphone('katerina'));
  });

  it('produces a key per word', () => {
    const key = doubleMetaphone('ivan volkov');
    expect(key.split(' ')).toHaveLength(2);
  });

  it('returns empty string for empty input', () => {
    expect(doubleMetaphone('')).toBe('');
  });
});
