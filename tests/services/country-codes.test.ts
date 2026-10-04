/**
 * @fileoverview The published-country → ISO 3166-1 alpha-2 fold behind the
 * cross-reference's registration-number gate (`country-codes.ts`): list
 * spellings resolve, deprecated and unknown values never do, hostile text
 * yields a code or nothing, and the fold stays linear in its input.
 * @module tests/services/country-codes.test
 */

import { describe, expect, it } from 'vitest';
import { countryCodeOf } from '@/services/screening/country-codes.js';

describe('countryCodeOf', () => {
  it('resolves each spelling the lists publish to one code', () => {
    const spellings: [string, string][] = [
      ['Russia', 'RU'],
      ['RUSSIAN FEDERATION', 'RU'],
      ['IRAN (ISLAMIC REPUBLIC OF)', 'IR'],
      ['Iran, Islamic Republic of', 'IR'],
      ['Korea, North', 'KP'],
      ['Bahamas, The', 'BS'],
      ['Burma', 'MM'],
      ['UAE', 'AE'],
      ["Côte d'Ivoire", 'CI'],
      ['Kosovo', 'XK'],
    ];
    for (const [published, code] of spellings) {
      expect(countryCodeOf(published), published).toBe(code);
    }
  });

  it('never resolves to a deprecated code, whatever the runtime name data says', () => {
    expect(countryCodeOf('Germany')).toBe('DE');
    expect(countryCodeOf('Russia')).toBe('RU');
    expect(countryCodeOf('Turkey')).toBe('TR');
    expect(countryCodeOf('Türkiye')).toBe('TR');
  });

  it('reads a two-letter value as a code only when the table holds it', () => {
    expect(countryCodeOf(' ru ')).toBe('RU');
    for (const value of ['XX', 'SU', 'DD', 'UK']) {
      expect(countryCodeOf(value), value).toBeUndefined();
    }
  });

  it('returns nothing for a value it does not know, never a guess', () => {
    for (const value of ['', 'Region: Gaza', "CONGO, People's Republic of", 'Atlantis']) {
      expect(countryCodeOf(value), value).toBeUndefined();
    }
  });

  it('answers hostile text with a code or nothing', () => {
    const random = mulberry32(0xc0de2a);
    const values = [
      '\0',
      '__proto__',
      'constructor',
      'hasOwnProperty',
      '&&&&',
      `R${'́'.repeat(50)}ussia`,
      ...Array.from({ length: 300 }, () => randomText(random, 40)),
    ];
    for (const value of values) {
      const code = countryCodeOf(value);
      if (code !== undefined) expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('folds in time linear in the input, even a long run of combining marks', () => {
    // High-class marks then low-class ones: NFKD's canonical reordering of the run
    // is an insertion sort, so normalizing it before the marks are dropped is quadratic.
    const reversedMarks = (length: number) => `a${'́'.repeat(length / 2)}${'̖'.repeat(length / 2)}`;
    const cpuMs = (value: string): number => {
      const start = process.threadCpuUsage();
      countryCodeOf(value);
      const spent = process.threadCpuUsage(start);
      return Math.max((spent.user + spent.system) / 1000, 0.05);
    };
    cpuMs(reversedMarks(5_000));
    const ratio = cpuMs(reversedMarks(80_000)) / cpuMs(reversedMarks(5_000));
    expect(ratio).toBeLessThan(64);
  });
});

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomText(random: () => number, length: number): string {
  const ranges = [
    [0x20, 0x7e],
    [0xc0, 0x24f],
    [0x300, 0x36f],
    [0x400, 0x4ff],
    [0x600, 0x6ff],
  ] as const;
  return Array.from({ length }, () => {
    const range = ranges[Math.floor(random() * ranges.length)] ?? ranges[0];
    return String.fromCodePoint(range[0] + Math.floor(random() * (range[1] - range[0] + 1)));
  }).join('');
}
