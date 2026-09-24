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
  lengthRatio,
  tokenCoverage,
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

  /*
   * Every name whose fold is ASCII keeps its exact fold and phonetic key — the
   * index rows and blocking keys of the Latin corpus must not move.
   */
  it.each([
    ['MADURO MOROS, Nicolas', 'maduro moros nicolas', 'MTR MRS NKLS'],
    ['Saddam Hussein Al-Tikriti', 'saddam hussein al tikriti', 'STM HSN AL TKRT'],
    ["O'Brien & Sons, Inc.", 'o brien sons inc', 'A PRN SNS ANK'],
    ['Müller-Schmidt GmbH', 'muller schmidt gmbh', 'MLR XMT KMP'],
    ['  José  Peña  ', 'jose pena', 'JS PN'],
    ['BANCO NACIONAL DE CUBA', 'banco nacional de cuba', 'PNK NSNL T KP'],
    [
      'Greenland Oil and Gas Trading FZE',
      'greenland oil and gas trading fze',
      'KRNLNT AL ANT KS TRTNK FS',
    ],
    ['ﬁnancial ＡＢＣ ²nd', 'financial abc 2nd', 'FNNSL APK NT'],
    ['Mohammed Al-Rashid 1972', 'mohammed al rashid 1972', 'MHMT AL RXT'],
    ['Kim Jong Un', 'kim jong un', 'KM JNK AN'],
  ])('keeps the ASCII fold and phonetic key of %j', (raw, folded, phonetic) => {
    expect(fold(raw)).toBe(folded);
    expect(doubleMetaphone(fold(raw))).toBe(phonetic);
  });

  it('folds Müller to muller', () => {
    expect(fold('Müller')).toBe('muller');
  });

  it.each([
    ['Arabic', 'عبد المنان آغا', 'عبد المنان اغا'],
    ['Cyrillic', 'Лукашенко Александр Григорьевич', 'лукашенко александр григорьевич'],
    ['Cyrillic with brève', 'Сергей Шойгу', 'сергеи шоигу'],
    ['Greek, final sigma', 'Αφγανική Επιτροπή Στήριξης', 'αφγανικη επιτροπη στηριξησ'],
    ['Greek, upper case', 'ΑΦΓΑΝΙΚΉ ΕΠΙΤΡΟΠΉ ΣΤΉΡΙΞΗΣ', 'αφγανικη επιτροπη στηριξησ'],
    ['Han', '王 国英', '王 国英'],
    ['Hebrew with niqqud', 'שָׁלוֹם', 'שלום'],
  ])('keeps the letters of a %s name', (_script, raw, folded) => {
    expect(fold(raw)).toBe(folded);
  });

  it('keeps Hangul as its decomposed jamo, identical for the query and the index', () => {
    const folded = fold('화려은행');
    expect(folded).toBe('화려은행'.normalize('NFKD'));
    expect(tokenize(folded)).toHaveLength(1);
  });

  it('keeps every letter of a mixed-script name instead of its Latin fragment', () => {
    // A Latin `i` homoglyph inside Cyrillic used to fold the whole name to "i".
    expect(fold('Ольга Валерiївна ПОЗДНЯКОВА')).toBe('ольга валерiівна позднякова');
    expect(fold('Интер Трейд 2021')).toBe('интер треид 2021');
  });

  it('keeps Latin letters that have no decomposition as published', () => {
    expect(fold('Łukasz Straße')).toBe('łukasz straße');
  });

  it('splits on the modifier letters transliterations write for an apostrophe or quote', () => {
    // Published: EU 181035 `JSC ,Refineryʼ`, EU 162791 `…“Vympelˮ…`. These are
    // letters to Unicode but punctuation to the reader, who types an ASCII `'`.
    expect(fold('JSC ,Refineryʼ')).toBe('jsc refinery');
    expect(fold('Bureau “Vympelˮ”')).toBe('bureau vympel');
    expect(fold('Oʻzbekiston')).toBe(fold("O'zbekiston"));
    expect(fold('Ilʹich')).toBe(fold("Il'ich"));
  });

  it('drops Arabic tatweel, which only stretches the word it sits in', () => {
    // Published: OFAC SDN 53975 `الـجـبـري كـمـال حـسـيـن`.
    expect(fold('الـجـبـري كـمـال حـسـيـن')).toBe(fold('الجبري كمال حسين'));
    expect(fold('الـجـبـري')).toBe('الجبري');
  });

  it('folds whitespace-only and punctuation-only input to no token', () => {
    for (const raw of ['   ', '---', '«»', '̖́']) expect(tokenize(fold(raw))).toEqual([]);
  });
});

describe('fold cost on caller-sized text', () => {
  /*
   * NFKD reorders long runs of combining marks with an insertion sort, which is
   * quadratic in the run length (19 ms at 5k, 4.9 s at 80k before the fix). The
   * fold must stay linear on every shape a caller can send.
   */
  const shapes: [label: string, make: (n: number) => string][] = [
    ['alternating combining marks', (n) => `a${'̖́'.repeat(n / 2)}`],
    ['half-width voicing marks between combining marks', (n) => `ｶ${'ﾞ̖ﾟ́'.repeat(n / 4)}`],
    ['precomposed letters', (n) => 'ǖ'.repeat(n)],
    ['Greek with final sigma', (n) => 'ΣΑΣ '.repeat(n / 4)],
    ['punctuation', (n) => '-'.repeat(n)],
  ];

  it.each(shapes)('grows linearly on %s', (_label, make) => {
    const time = (n: number): number => {
      const input = make(n);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        fold(input);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    time(5_000); // warm the regex and normalizer paths
    const t5k = Math.max(time(5_000), 0.05);
    const t80k = time(80_000);
    expect(t80k / t5k).toBeLessThan(64);
    expect(t80k).toBeLessThan(250);
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

describe('tokenCoverage', () => {
  it('counts only query tokens that clear the threshold against some candidate token', () => {
    // The single-token false-positive shape: one query token is close to the short
    // candidate, the rest are noise. bestTokenScore would report the one high pair;
    // coverage reports that only 1 of 3 query tokens is actually explained.
    const q = tokenize(fold('Zzqxwv Nonexistent Qqpzm'));
    const c = tokenize(fold('Noni'));
    expect(bestTokenScore(q, c)).toBeGreaterThanOrEqual(0.85); // one strong pair
    expect(tokenCoverage(q, c, 0.85)).toBe(1); // but only one token covered
  });

  it('counts every token for a full match (word-order swap)', () => {
    const q = tokenize(fold('Volkov Ivan'));
    const c = tokenize(fold('Ivan Volkov'));
    expect(tokenCoverage(q, c, 0.85)).toBe(2);
  });

  it('counts a legitimate partial match (2 of 3 tokens)', () => {
    const q = tokenize(fold('Ivan Volkov Qqzzxw'));
    const c = tokenize(fold('Ivan Testovich Volkov'));
    expect(tokenCoverage(q, c, 0.85)).toBe(2);
  });

  it('returns 0 when nothing clears the threshold', () => {
    const q = tokenize(fold('Zzqxwv Qqpzm'));
    const c = tokenize(fold('Noni'));
    expect(tokenCoverage(q, c, 0.85)).toBe(0);
  });
});

describe('lengthRatio', () => {
  it('is 1 for equal-length strings and for two empty strings', () => {
    expect(lengthRatio('volkov', 'moros!')).toBe(1); // both 6 chars
    expect(lengthRatio('', '')).toBe(1);
  });

  it('is 0 when one string is empty and the other is not', () => {
    expect(lengthRatio('', 'volkov')).toBe(0);
  });

  it('is the shorter length over the longer, order-independent', () => {
    // "nicolas" (7) vs "nicolas maduroo moros" (21) → 7/21, either way round.
    expect(lengthRatio('nicolas', 'nicolas maduroo moros')).toBeCloseTo(7 / 21, 6);
    expect(lengthRatio('nicolas maduroo moros', 'nicolas')).toBeCloseTo(7 / 21, 6);
  });

  it('drops below the whole-string guard when a short token merely prefixes a long query', () => {
    // The issue #8 shape: Jaro-Winkler inflates this pair to 0.8667, but the length
    // ratio exposes that the candidate is a fragment of the query.
    expect(jaroWinkler('nicolas maduroo moros', 'nicolas')).toBeGreaterThan(0.85);
    expect(lengthRatio('nicolas maduroo moros', 'nicolas')).toBeLessThan(0.5);
  });

  it('stays high for spacing/concatenation variants (near-equal length)', () => {
    // The recall the whole-string arm exists for — the guard must not block these.
    expect(lengthRatio('van den berg', 'vandenberg')).toBeGreaterThan(0.8);
    expect(lengthRatio('vanderbergshipping', 'van der berg shipping')).toBeGreaterThan(0.8);
  });
});

describe('similarity over supplementary-plane letters', () => {
  /*
   * Map each lowercase ASCII letter onto its own CJK Extension B code point
   * (U+20000 + index). The image of a string has the same code-point structure
   * as the original, so every similarity measure must score the pair the same.
   * All 26 images share one high surrogate (U+D840), which is exactly what a
   * code-unit measure mistakes for matching characters.
   */
  const astral = (s: string): string =>
    [...s]
      .map((c) => (c === ' ' ? c : String.fromCodePoint(0x20000 + c.charCodeAt(0) - 97)))
      .join('');

  const PAIRS: [string, string][] = [
    ['abcdef', 'abcxyz'],
    ['abd', 'abc'],
    ['martha', 'marhta'],
    ['volkov', 'volkow'],
    ['katarina', 'katerina'],
    ['abc', 'xyz'],
    ['nicolas maduroo moros', 'nicolas'],
    ['van den berg', 'vandenberg'],
    ['dixon', 'dicksonx'],
  ];

  it.each(PAIRS)('scores %s / %s the same in either plane', (a, b) => {
    expect(jaro(astral(a), astral(b))).toBe(jaro(a, b));
    expect(jaroWinkler(astral(a), astral(b))).toBe(jaroWinkler(a, b));
    expect(lengthRatio(astral(a), astral(b))).toBe(lengthRatio(a, b));
    const [qa, qb] = [tokenize(a), tokenize(b)];
    const [xa, xb] = [tokenize(astral(a)), tokenize(astral(b))];
    expect(bestTokenScore(xa, xb)).toBe(bestTokenScore(qa, qb));
    expect(tokenCoverage(xa, xb, 0.85)).toBe(tokenCoverage(qa, qb, 0.85));
  });

  it('counts a supplementary-plane letter as one character beside BMP letters', () => {
    expect(jaroWinkler('ab𠀀', 'ab𠀁')).toBe(jaroWinkler('abc', 'abd'));
    expect(lengthRatio('𠀀𠀁', 'abcd')).toBe(0.5);
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

  it('keys only all-Latin tokens, so homoglyph residue never yields a blocking key', () => {
    // `валерiівна` carries one Latin `i`; keying it would emit the key `A`, the
    // most common key in the index.
    expect(doubleMetaphone(fold('Валерiївна'))).toBe('');
    expect(doubleMetaphone(fold('Ольга Валерiївна Ivanova'))).toBe(doubleMetaphone('ivanova'));
    expect(doubleMetaphone(fold('Лукашенко'))).toBe('');
    expect(doubleMetaphone(fold('王 国英'))).toBe('');
  });

  it('keys Latin tokens that keep a letter with no decomposition', () => {
    expect(doubleMetaphone(fold('Łukasz'))).toBe('AKS');
    expect(doubleMetaphone(fold('Straße'))).toBe('STRS');
  });
});
