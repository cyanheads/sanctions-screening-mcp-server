/**
 * @fileoverview Unit tests for the pure text-matching primitives: folding,
 * tokenization, FTS match building, the legal-form fold and its widened match,
 * Jaro-Winkler, and Double-Metaphone. These
 * are the source of the real signal the matching engine surfaces.
 * @module tests/services/text-matching.test
 */

import { describe, expect, it } from 'vitest';
import {
  bestTokenScore,
  buildFtsMatch,
  buildLegalFormFtsMatch,
  comparisonForms,
  deletionSignatures,
  doubleMetaphone,
  FUZZY_STOPLIST,
  fold,
  foldLegalForms,
  hasOtherScriptLetter,
  isStoplistToken,
  jaro,
  jaroWinkler,
  LEGAL_FORM_SPELLINGS,
  lengthRatio,
  scoreTokenPairs,
  scoringQuery,
  soundKeys,
  splitOnStoplist,
  tokenCoverage,
  tokenize,
} from '@/services/screening/text-matching.js';
import { expectLinearTime } from './_linear-time.js';

/**
 * Asserts `run`'s thread CPU time (µs per call) over `make(size)` stays under
 * 100 ms and grows under 256-fold against the 5,000-character baseline, doubling
 * `size` from 10,000 to `largest`. Each size takes the least of five baseline/size
 * pairs, so a descheduled sample never reads as slow code.
 */
function expectBoundedCpuGrowth(
  run: (input: string) => unknown,
  make: (size: number) => string,
  largest: number,
): void {
  const baseline = make(5_000);
  const measure = (input: string, repeats: number): number => {
    const start = process.threadCpuUsage();
    for (let i = 0; i < repeats; i++) run(input);
    const elapsed = process.threadCpuUsage(start);
    return (elapsed.user + elapsed.system) / repeats;
  };
  measure(baseline, 64);
  for (let size = 10_000; size <= largest; size *= 2) {
    const input = make(size);
    const samples = Array.from({ length: 5 }, () => {
      const small = Math.max(measure(baseline, 32), 1);
      const large = measure(input, 4);
      return { large, growth: large / small };
    });
    const least = (key: 'growth' | 'large') => Math.min(...samples.map((sample) => sample[key]));
    expect(least('large'), `µs at ${size}`).toBeLessThan(100_000);
    expect(least('growth'), `growth at ${size}`).toBeLessThan(256);
  }
}

describe('fuzzy comparison forms and deletion signatures', () => {
  it('maps the Russian alphabet before folding and preserves unknown letters', () => {
    expect(comparisonForms('АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ')).toEqual([
      'абвгдеежзииклмнопрстуфхцчшщъыьэюя',
      'abvgdeyozhziyklmnoprstufkhtschshshchyeyuya',
    ]);
    expect(comparisonForms('Роснефть')).toEqual(['роснефть', 'rosneft']);
    expect(comparisonForms('Совкомфлот')).toEqual(['совкомфлот', 'sovkomflot']);
    expect(comparisonForms('Ї東京')).toEqual(['і東京']);
    expect(comparisonForms('Rosneft')).toEqual(['rosneft']);
    expect(comparisonForms('ъь')).toEqual(['ъь']);
  });

  it('keeps useful two-point signatures and whole supplementary-plane letters', () => {
    expect(deletionSignatures(['a', 'ab', 'abc', 'abc'])).toEqual(['ab', 'abc', 'bc', 'ac']);
    expect(deletionSignatures(['𠀀𠀁𠀂𠀃x'])).toEqual([
      '𠀀𠀁𠀂𠀃',
      '𠀁𠀂𠀃',
      '𠀀𠀂𠀃',
      '𠀀𠀁𠀃',
      '𠀀𠀁𠀂',
    ]);
    expect(deletionSignatures([])).toEqual([]);
  });

  it.each(['line', 'breaks'] as const)(
    'bounds comparison/signature scanner CPU across a 64-fold span: %s',
    (shape) => {
      const make = (size: number) =>
        shape === 'line' ? `${'я'.repeat(size)}\n` : 'я\n'.repeat(size / 2);
      const cpuMs = (input: string): number => {
        const start = process.threadCpuUsage();
        for (let repeat = 0; repeat < 8; repeat++) {
          comparisonForms(input);
          deletionSignatures(tokenize(fold(input)));
        }
        const elapsed = process.threadCpuUsage(start);
        return (elapsed.user + elapsed.system) / 1000;
      };
      for (let warm = 0; warm < 8; warm++) cpuMs(make(1250));
      const times: number[] = [];
      for (let size = 1250; size <= 80_000; size *= 2) {
        const time = cpuMs(make(size));
        expect(time, `CPU at ${size}`).toBeLessThan(500);
        times.push(Math.max(time, 0.05));
      }
      expect(times.at(-1)! / times[0]!).toBeLessThan(256);
    },
  );
});

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

  it.each(shapes)(
    'grows linearly on %s',
    async (_label, make) => {
      await expectLinearTime(fold, make, 80_000, 250);
    },
    0,
  );
});

describe('hasOtherScriptLetter', () => {
  it.each([
    ['Александр Бортников', true],
    ['武汉晓睿智科技有限责任公司', true],
    ['عبد المنان آغا', true],
    // Mixed scripts: one Cyrillic word beside a Latin one.
    ['АО Almaz', true],
    // A Latin homoglyph inside a Cyrillic name.
    ['Валерiївна', true],
    ['Almaz-2021 (UK) Ltd.', false],
    ['Société Générale', false],
    ['2021', false],
    ['---', false],
    // Script-neutral letters (Common) count for no script: the micro sign and the modifier apostrophe.
    ['µ', false],
    ['Saʼid', false],
  ])('reads %j as holding a letter of another script: %s', (text, expected) => {
    expect(hasOtherScriptLetter(text)).toBe(expected);
  });

  it('reads the micro sign as Greek once folded, as strict matching reads it', () => {
    expect(fold('µ')).toBe('μ');
    expect(hasOtherScriptLetter(fold('µ'))).toBe(true);
  });

  const worstCases: [label: string, build: (length: number) => string, max: number][] = [
    ['a long digit run', (n) => '1'.repeat(n), 320_000],
    ['a long Latin run', (n) => 'a'.repeat(n), 80_000],
    ['script-neutral letters', (n) => 'µ'.repeat(n), 80_000],
    ['a Latin run ending in another script', (n) => `${'a'.repeat(n - 1)}я`, 80_000],
    ['one long line ending in a break', (n) => `${'x'.repeat(n)}\ny`, 80_000],
    ['breaks throughout', (n) => '  \r\n'.repeat(n / 4), 80_000],
  ];

  it.each(worstCases)(
    'reads %s in time linear in its length',
    async (_label, build, max) => {
      await expectLinearTime(hasOtherScriptLetter, build, max, 50);
    },
    0,
  );
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

/** mulberry32: a seeded generator, so a failing case reproduces. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('scoreTokenPairs — one pass equals the separate helpers', () => {
  const random = seeded(71);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  // Name words, near variants, stoplisted words, short and supplementary-plane tokens.
  const VOCABULARY = [
    ...['volkov', 'volkow', 'ivan', 'ivanov', 'mohammed', 'muhammad', 'mohammad', 'nicolas'],
    ...['nikolas', 'maduro', 'moros', 'rosneft', 'oil', 'bank', 'banco', 'deutsche', 'x', 'ab'],
    ...['ltd', 'company', 'al', 'de', 'the', 'gmbh', 'uk', '𠀀𠀁𠀂', '𠀀𠀁𠀃', 'ab𠀀'],
  ];
  /** A vocabulary word, or a random word over a small alphabet, so near pairs are common. */
  const token = (): string =>
    random() < 0.6
      ? pick(VOCABULARY)
      : Array.from({ length: 1 + Math.floor(random() * 7) }, () => pick([...'abdeimnorv'])).join(
          '',
        );
  const tokens = (min: number, max: number): string[] =>
    Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, token);

  it('returns bestTokenScore and both coverages over 20,000 random token lists and thresholds', () => {
    const mismatches: unknown[] = [];
    const exercised = { allStoplisted: 0, astral: 0, bestOneCoveredMany: 0, distinctiveDiffers: 0 };
    for (let i = 0; i < 20_000; i++) {
      const queryTokens = tokens(1, 8);
      const candidateTokens = tokens(0, 6);
      // Fixed floors, random ones, and a floor equal to a real pair score, so `>=` meets equality.
      const threshold =
        i % 4 === 0
          ? pick([0, 0.5, 0.85, 0.9, 1])
          : i % 4 === 1 && candidateTokens.length > 0
            ? jaroWinkler(pick(queryTokens), pick(candidateTokens))
            : random();
      const expected = {
        best: bestTokenScore(queryTokens, candidateTokens),
        covered: tokenCoverage(queryTokens, candidateTokens, threshold),
        distinctiveCovered: tokenCoverage(
          splitOnStoplist(queryTokens).distinctive,
          candidateTokens,
          threshold,
        ),
      };
      const actual = scoreTokenPairs(scoringQuery(queryTokens), candidateTokens, threshold);
      if (
        !Object.is(actual.best, expected.best) ||
        actual.covered !== expected.covered ||
        actual.distinctiveCovered !== expected.distinctiveCovered
      ) {
        mismatches.push({ queryTokens, candidateTokens, threshold, expected, actual });
      }
      if (queryTokens.every(isStoplistToken)) exercised.allStoplisted++;
      if ([...queryTokens, ...candidateTokens].some((t) => /[\ud800-\udfff]/.test(t))) {
        exercised.astral++;
      }
      if (expected.best === 1 && expected.covered > 1) exercised.bestOneCoveredMany++;
      if (expected.distinctiveCovered !== expected.covered) exercised.distinctiveDiffers++;
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    for (const [shape, count] of Object.entries(exercised)) expect(count, shape).toBeGreaterThan(0);
  });

  it('marks the distinctive tokens as splitOnStoplist splits them', () => {
    const marks = (query: string[]) => scoringQuery(query).map((t) => t.distinctive);
    expect(marks(['rosneft', 'oil', 'company'])).toEqual([true, true, false]);
    expect(marks(['limited', 'liability', 'company'])).toEqual([true, true, true]);
    expect(marks([])).toEqual([]);
  });
});

describe('scoreTokenPairs — words that sound alike (issue #92)', () => {
  const both = (query: string[], candidate: string[], threshold = 0.85) => ({
    spelled: scoreTokenPairs(scoringQuery(query), candidate, threshold),
    sounded: scoreTokenPairs(scoringQuery(query), candidate, threshold, soundKeys()),
  });

  it('covers a word spelling misses when its primary key, three characters long, matches', () => {
    // Under the 0.85 floor by spelling, one key by sound.
    expect(jaroWinkler('gaddafi', 'qadhafi')).toBeCloseTo(0.8095, 4);
    expect([doubleMetaphone('gaddafi'), doubleMetaphone('qadhafi')]).toEqual(['KTF', 'KTF']);
    const { spelled, sounded } = both(['hannibal', 'gaddafi'], ['hannibal', 'muammar', 'qadhafi']);
    expect(spelled).toEqual({ best: 1, covered: 1, distinctiveCovered: 1, phonetic: 0 });
    expect(sounded).toEqual({ best: 1, covered: 2, distinctiveCovered: 1, phonetic: 1 });
  });

  it('counts a word by spelling first, never twice', () => {
    // `hassan` clears the floor against `hasan`, so its shared key with `hussein` adds nothing.
    const { sounded } = both(['ahmed', 'hassan'], ['hussein', 'hasan', 'ahmed']);
    expect(sounded).toEqual({ best: 1, covered: 2, distinctiveCovered: 2, phonetic: 0 });
  });

  it.each([
    ['a stoplisted candidate word', ['anita', 'rahimi'], ['rahimi', 'and', 'sons']],
    ['a stoplisted word of an all-stoplisted query', ['und', 'co'], ['anita', 'co']],
  ])('never counts %s by sound, though the keys match', (_label, query, candidate) => {
    expect(doubleMetaphone('anita')).toBe('ANT');
    expect([doubleMetaphone('and'), doubleMetaphone('und')]).toEqual(['ANT', 'ANT']);
    expect(both(query, candidate).sounded).toMatchObject({ covered: 1, phonetic: 0 });
  });

  it.each([
    ['a two-character key', ['wang', 'jun'], ['jin', 'wang'], 'JN'],
    ['a one-character key', ['zhang', 'wei'], ['yu', 'zhang'], 'A'],
  ])('never counts %s by sound', (_label, query, candidate, key) => {
    const [, word] = query as [string, string];
    expect(doubleMetaphone(word)).toBe(key);
    expect(doubleMetaphone(candidate[0] as string)).toBe(key);
    expect(both(query, candidate).sounded).toMatchObject({ covered: 1, phonetic: 0 });
  });

  it('keys a Latin token off the stoplist with a key of three characters or more, nothing else', () => {
    // `qadhafi` twice: the second read is the memo's.
    const key = soundKeys();
    expect(
      ['qadhafi', 'qadhafi', 'hussein', 'company', 'al', 'wei', 'jun', 'ромашка', '2021'].map(key),
    ).toEqual([
      'KTF',
      'KTF',
      'HSN',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('adds only sound-covered words over 20,000 random token lists, leaving best and the spelled counts alone', () => {
    const random = seeded(92);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    // Sound-alike families under the floor, stoplisted and short-key words, and a non-Latin one.
    const VOCABULARY = [
      ...['gaddafi', 'qadhafi', 'kaddafi', 'hassan', 'hussein', 'husain', 'zhang', 'xiong'],
      ...['anita', 'and', 'und', 'jun', 'jin', 'wei', 'yu', 'ali', 'el', 'al', 'ltd', 'company'],
      ...['ivan', 'ivanov', 'mohammed', 'muhammad', 'ромашка', 'x'],
    ];
    const tokens = (min: number, max: number): string[] =>
      Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, () => pick(VOCABULARY));
    const key = (token: string) => doubleMetaphone(token);
    const mismatches: unknown[] = [];
    let soundCovered = 0;
    for (let i = 0; i < 20_000; i++) {
      const queryTokens = tokens(1, 5);
      const candidateTokens = tokens(0, 5);
      const threshold = pick([0.5, 0.8, 0.85, 0.9, 1]);
      const spelled = scoreTokenPairs(scoringQuery(queryTokens), candidateTokens, threshold);
      const sounded = scoreTokenPairs(
        scoringQuery(queryTokens),
        candidateTokens,
        threshold,
        soundKeys(),
      );
      const expectedPhonetic = queryTokens.filter(
        (q) =>
          tokenCoverage([q], candidateTokens, threshold) === 0 &&
          !isStoplistToken(q) &&
          key(q).length >= 3 &&
          candidateTokens.some((c) => !isStoplistToken(c) && key(c) === key(q)),
      ).length;
      if (
        !Object.is(sounded.best, spelled.best) ||
        sounded.distinctiveCovered !== spelled.distinctiveCovered ||
        sounded.covered !== spelled.covered + expectedPhonetic ||
        sounded.phonetic !== expectedPhonetic ||
        spelled.phonetic !== 0
      ) {
        mismatches.push({ queryTokens, candidateTokens, threshold, spelled, sounded });
      }
      soundCovered += expectedPhonetic;
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(soundCovered).toBeGreaterThan(1_000);
  });

  it.each([
    { label: 'a long digit run', make: (n: number) => '1'.repeat(n), largest: 320_000 },
    {
      label: 'one long line ending in a break',
      make: (n: number) => `${'x'.repeat(n)}\ny`,
      largest: 80_000,
    },
    { label: 'breaks throughout', make: (n: number) => '  \r\n'.repeat(n / 4), largest: 80_000 },
    // Each G before N or LI re-tested the whole word for W, K, or CZ.
    { label: 'G before N', make: (n: number) => 'gn'.repeat(n / 2), largest: 320_000 },
    { label: 'G before LI', make: (n: number) => 'gli'.repeat(n / 3), largest: 320_000 },
    {
      label: 'a C that never opens CZ',
      make: (n: number) => 'gnc'.repeat(n / 3),
      largest: 320_000,
    },
    { label: 'one Latin word of vowels', make: (n: number) => 'a'.repeat(n), largest: 80_000 },
  ])(
    'bounds a sound key’s CPU across increasing input sizes: $label',
    ({ make, largest }) => {
      expectBoundedCpuGrowth((input) => soundKeys()(input), make, largest);
    },
    0,
  );
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

describe('fuzzy stoplist (issue #55)', () => {
  it('lists legal forms, articles, and the bare jurisdiction codes', () => {
    for (const token of ['ltd', 'company', 'jsc', 'общество', 'gmbh', 'sirketi', 'fze', 'pte']) {
      expect(isStoplistToken(token), token).toBe(true);
    }
    for (const token of ['al', 'el', 'de', 'la', 'the', 'of', 'and']) {
      expect(isStoplistToken(token), token).toBe(true);
    }
    for (const token of ['uk', 'usa', 'uae', 'rf'])
      expect(isStoplistToken(token), token).toBe(true);
  });

  it('leaves out country names, one-letter tokens, and person-name particles', () => {
    for (const token of ['iran', 'korea', 'china', 'russia', 'syria', 'air']) {
      expect(isStoplistToken(token), token).toBe(false);
    }
    for (const token of ['s', 'a', 'y', 'e']) expect(isStoplistToken(token), token).toBe(false);
    for (const token of ['bin', 'abu', 'ibn', 'ben', 'van']) {
      expect(isStoplistToken(token), token).toBe(false);
    }
  });

  it('holds only folded single tokens, so a folded query token can equal one', () => {
    expect(FUZZY_STOPLIST.size).toBeGreaterThan(0);
    for (const token of FUZZY_STOPLIST) expect(tokenize(fold(token)), token).toEqual([token]);
  });

  it('splits a query into its distinctive and stoplisted tokens, in query order', () => {
    expect(splitOnStoplist(tokenize(fold('SOVCOMFLOT (UK) LTD')))).toEqual({
      distinctive: ['sovcomflot'],
      stoplisted: ['uk', 'ltd'],
    });
    expect(splitOnStoplist(['rosneft', 'oil', 'company'])).toEqual({
      distinctive: ['rosneft', 'oil'],
      stoplisted: ['company'],
    });
  });

  it('keeps every token distinctive when the query has nothing else', () => {
    expect(splitOnStoplist(['limited', 'liability', 'company'])).toEqual({
      distinctive: ['limited', 'liability', 'company'],
      stoplisted: [],
    });
    expect(splitOnStoplist([])).toEqual({ distinctive: [], stoplisted: [] });
  });
});

describe('legal-form spellings (issue #90)', () => {
  it('keys each form by its canonical spelling, and every canonical is on the fuzzy stoplist', () => {
    expect([...LEGAL_FORM_SPELLINGS.keys()]).toEqual([
      ...['ltd', 'co', 'corp', 'inc', 'llp', 'lp', 'plc', 'ag'],
      ...['llc', 'jsc', 'pjsc', 'ojsc', 'cjsc'],
    ]);
    for (const [canonical, spellings] of LEGAL_FORM_SPELLINGS) {
      expect(spellings[0], canonical).toBe(canonical);
      expect(isStoplistToken(canonical), canonical).toBe(true);
    }
  });

  it('holds folded spellings, each in exactly one form', () => {
    const forms = new Map<string, string>();
    for (const [canonical, spellings] of LEGAL_FORM_SPELLINGS) {
      for (const spelling of spellings) {
        expect(tokenize(fold(spelling)).join(' '), spelling).toBe(spelling);
        expect(forms.get(spelling), spelling).toBeUndefined();
        forms.set(spelling, canonical);
      }
    }
  });

  it.each([
    ['OOO', 'llc'],
    ['ООО', 'llc'],
    ['Obshchestvo s Ogranichennoi Otvetstvennostyu', 'llc'],
    ['Общество с ограниченной ответственностью', 'llc'],
    ['L.L.C.', 'llc'],
    ['AO', 'jsc'],
    ['АО', 'jsc'],
    ['Aktsionernoe Obshchestvo', 'jsc'],
    ['Акционерное общество', 'jsc'],
    ['PAO', 'pjsc'],
    ['ПАО', 'pjsc'],
    ['Publichnoe Aktsionernoe Obschestvo', 'pjsc'],
    ['Publichnoye Joint-Stock Company', 'pjsc'],
    ['Публичное акционерное общество', 'pjsc'],
    ['OAO', 'ojsc'],
    ['ОАО', 'ojsc'],
    ['Otkrytoye Aktsionernoye Obshchestvo', 'ojsc'],
    ['ZAO', 'cjsc'],
    ['ЗАО', 'cjsc'],
    ['Zakrytoe Aktsionernoe Obshchestvo', 'cjsc'],
    ['Limited', 'ltd'],
    ['Company', 'co'],
    ['Corporation', 'corp'],
    ['Incorporated', 'inc'],
    ['Limited Liability Partnership', 'llp'],
    ['Aktiengesellschaft', 'ag'],
  ])('folds %j to its form %j', (raw, canonical) => {
    expect(foldLegalForms(fold(raw))).toEqual([canonical]);
  });

  it('keeps different forms apart: JSC, PJSC, OJSC, CJSC; LLC and Ltd; Company and Corporation', () => {
    const forms = [
      'JSC',
      'Joint Stock Company',
      'PJSC',
      'Public Joint Stock Company',
      'OJSC',
      'Open Joint-Stock Company',
      'CJSC',
      'Closed Joint Stock Company',
      'LLC',
      'Limited Liability Company',
      'Ltd',
      'Limited',
      'Co',
      'Company',
      'Corp',
      'Corporation',
    ].map((raw) => foldLegalForms(fold(raw)).join(' '));
    expect(forms).toEqual([
      ...['jsc', 'jsc', 'pjsc', 'pjsc', 'ojsc', 'ojsc', 'cjsc', 'cjsc'],
      ...['llc', 'llc', 'ltd', 'ltd', 'co', 'co', 'corp', 'corp'],
    ]);
  });

  it.each([
    // One form, spelled two ways.
    ['JSC', 'Non-Public Joint Stock Company', 'jsc', 'jsc'],
    ['JSC', 'Непубличное акционерное общество', 'jsc', 'jsc'],
    ['LLC', 'Limited Liability Corporation', 'llc', 'llc'],
    ['LLC', 'Limited Liability', 'llc', 'llc'],
    ['LP', 'Limited Partnership', 'lp', 'lp'],
    ['PLC', 'Public Limited Company', 'plc', 'plc'],
    // Two forms, the longer spelled with a word of the other.
    ['PJSC', 'Non-Public Joint Stock Company', 'pjsc', 'jsc'],
    ['Ltd', 'Limited Liability Corporation', 'ltd', 'llc'],
    ['Ltd', 'Limited Liability', 'ltd', 'llc'],
    ['Ltd', 'Limited Partnership', 'ltd', 'lp'],
    ['Ltd', 'Public Limited Company', 'ltd', 'plc'],
  ])('folds %j and %j to %j and %j, never a word of one form left loose', (a, b, foldA, foldB) => {
    const form = (raw: string) => foldLegalForms(fold(raw)).join(' ');
    expect([form(a), form(b)]).toEqual([foldA, foldB]);
  });

  it.each([
    [
      'NON PUBLIC JOINT STOCK  COMPANY  "KALMYK OIL  AND GAS  COMPANY',
      ['jsc', 'kalmyk', 'oil', 'and', 'gas', 'co'],
    ],
    [
      'Non-Public Joint Stock Company “Research and Production Center” Specialized  Devices and Systems',
      [
        'jsc',
        'research',
        'and',
        'production',
        'center',
        'specialized',
        'devices',
        'and',
        'systems',
      ],
    ],
    [
      'НЕПУБЛИЧНОЕ  АКЦИОНЕРНОЕ  ОБЩЕСТВО  "КАЛМЫЦКАЯ  НЕФТЕГАЗОВАЯ  КОМПАНИЯ"',
      ['jsc', 'калмыцкая', 'нефтегазовая', 'компания'],
    ],
    ['Limited Liability Corporation Baltech', ['llc', 'baltech']],
    ['LIMITED LIABILITY CORPORATION GELIOS', ['llc', 'gelios']],
    [
      'Al-Amer for Manufacture of Concrete, Flagstone, Limited Liability',
      ['al', 'amer', 'for', 'manufacture', 'of', 'concrete', 'flagstone', 'llc'],
    ],
    [
      'Beijing Qiji Chuangtan Phase I Venture Capital Center Limited Partnership',
      ['beijing', 'qiji', 'chuangtan', 'phase', 'i', 'venture', 'capital', 'center', 'lp'],
    ],
  ])('folds the published name %j to one form, not a word of another', (raw, expected) => {
    expect(foldLegalForms(fold(raw))).toEqual(expected);
  });

  it.each([
    ['limited liability company spectrum', ['llc', 'spectrum']],
    ['sky aviator company limited', ['sky', 'aviator', 'co', 'ltd']],
    [
      'subsidiary bank sberbank of russia public joint stock company',
      ['subsidiary', 'bank', 'sberbank', 'of', 'russia', 'pjsc'],
    ],
    [
      'open joint stock oil and gas company syzran',
      ['open', 'joint', 'stock', 'oil', 'and', 'gas', 'co', 'syzran'],
    ],
    ['joint public stock company nevskoe', ['joint', 'public', 'stock', 'co', 'nevskoe']],
    ['limited liability limited', ['llc', 'ltd']],
    ['limited liability limited partnership', ['llc', 'lp']],
    [
      'public limited company scientific research institute',
      ['plc', 'scientific', 'research', 'institute'],
    ],
    ['edm l l c fz', ['edm', 'llc', 'fz']],
    ['kim l c', ['kim', 'l', 'c']],
    ['ооо ромашка', ['llc', 'ромашка']],
    // ofac_sdn 37481 as published: the preposition is a Latin `c` (U+0063), not `с` (U+0441).
    ['общество c ограниченнои ответственностью гелиос', ['llc', 'гелиос']],
    ['общество с ограниченнои ответственностью гелиос', ['llc', 'гелиос']],
    ['', []],
  ])('folds %j longest spelling first, left to right', (normalized, expected) => {
    expect(foldLegalForms(normalized)).toEqual(expected);
  });

  it('widens each legal form of a fold to every spelling, quoted like the literal match', () => {
    expect(buildLegalFormFtsMatch(['stg', 'holdings', 'ltd'])).toBe(
      '"stg" AND "holdings" AND ("ltd" OR "limited")',
    );
    expect(buildLegalFormFtsMatch(['jsc', 'vtb', 'bank'])).toBe(
      '("jsc" OR "joint stock company" OR "non public joint stock company" OR "ao" OR "aktsionernoe obshchestvo" OR "aktsionernoye obshchestvo" OR "aktsionernoe obschestvo" OR "ао" OR "акционерное общество" OR "непубличное акционерное общество") AND "vtb" AND "bank"',
    );
  });

  it('quotes each repeated token once, and widens nothing without a legal form', () => {
    expect(buildLegalFormFtsMatch(['ltd', 'acme', 'ltd', 'ltd'])).toBe(
      '("ltd" OR "limited") AND "acme"',
    );
    expect(buildLegalFormFtsMatch(['ivan', 'volkov'])).toBeNull();
    expect(buildLegalFormFtsMatch([])).toBeNull();
  });

  it.each([
    { label: 'a long digit run', make: (n: number) => '1'.repeat(n), largest: 320_000 },
    {
      label: 'one long line ending in a break',
      make: (n: number) => `${'x'.repeat(n)}\ny`,
      largest: 80_000,
    },
    { label: 'breaks throughout', make: (n: number) => '  \r\n'.repeat(n / 4), largest: 80_000 },
    {
      label: 'a form opener with no closer',
      make: (n: number) => 'limited liability '.repeat(n / 18),
      largest: 80_000,
    },
    {
      label: 'overlapping openers',
      make: (n: number) => 'obshchestvo s ogranichennoi '.repeat(n / 28),
      largest: 80_000,
    },
    {
      label: 'nested openers',
      make: (n: number) => 'public open closed joint stock '.repeat(n / 31),
      largest: 80_000,
    },
    {
      label: 'the longest opener with no closer',
      make: (n: number) => 'non public joint stock '.repeat(n / 23),
      largest: 80_000,
    },
    { label: 'one-letter openers', make: (n: number) => 'l l '.repeat(n / 4), largest: 80_000 },
    {
      label: 'Cyrillic openers',
      make: (n: number) => 'общество с '.repeat(n / 11),
      largest: 80_000,
    },
    {
      label: 'whole spellings',
      make: (n: number) => 'ооо ltd company pao '.repeat(n / 20),
      largest: 80_000,
    },
  ])(
    'bounds the legal-form fold and its match CPU across increasing input sizes: $label',
    ({ make, largest }) => {
      expectBoundedCpuGrowth(
        (input) => buildLegalFormFtsMatch(foldLegalForms(input)),
        make,
        largest,
      );
    },
    0,
  );
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

  /**
   * Philips' rule for an inner `GN`: primary `N`, unless the word reads as
   * Slavo-Germanic (it holds `W`, `K`, `CZ`, or `WITZ`), where it stays `KN`.
   * `magnus` holds none of those letters and takes `N`.
   */
  it.each([
    ['wagner', 'AKNR'],
    ['magnitsky', 'MKNTSK'],
    ['sygnowski', 'SKNSK'],
    ['magnus', 'MNS'],
  ])('keys the inner GN of %s by whether the word is Slavo-Germanic: %s', (word, key) => {
    expect(doubleMetaphone(word)).toBe(key);
  });
});
