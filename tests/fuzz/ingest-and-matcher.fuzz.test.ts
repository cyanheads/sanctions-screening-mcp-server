/**
 * @fileoverview Deterministic fuzz coverage for XML ingest and fuzzy matching.
 * Exercises hostile text, malformed/truncated records, invalid UTF-8, and
 * one-edit variants of public designation names without network access.
 * @module tests/fuzz/ingest-and-matcher.fuzz.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseLeiLevel1,
  streamLeiLevel1FromBytes,
  streamLeiLevel1FromText,
} from '@/services/screening/gleif-ingest.js';
import { parseEu, parseOfac, parseUk, parseUn } from '@/services/screening/sanctions-ingest.js';
import {
  buildFtsMatch,
  doubleMetaphone,
  fold,
  jaro,
  jaroWinkler,
} from '@/services/screening/text-matching.js';
import type { NormalizedDesignation } from '@/services/screening/types.js';
import { SOURCE_CODES } from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';
import { freshService, type SeededService } from '../services/_helpers.js';

const adversarialStrings = [
  '',
  '\0',
  '\u0000\u0001\u001f',
  '__proto__ constructor prototype',
  'NEAR OR NOT AND * " ^',
  '<!DOCTYPE x [<!ENTITY y "boom">]><x>&y;</x>',
  '../../../etc/passwd',
  'محمد Владимирович 李小龍',
  'A'.repeat(20_000),
  '\u202eabc\u202c',
] as const;

describe('text matcher fuzz invariants', () => {
  it('keeps folding, phonetics, and similarity bounded for hostile Unicode', () => {
    const random = mulberry32(0x5a17c0de);
    const values = [
      ...adversarialStrings,
      ...Array.from({ length: 400 }, () => randomUnicode(random, 80)),
    ];

    for (const value of values) {
      const normalized = fold(value);
      const reversed = [...normalized].reverse().join('');
      expect(normalized).toMatch(/^(?:[a-z0-9]+(?: [a-z0-9]+)*)?$/);
      expect(doubleMetaphone(normalized)).toMatch(/^(?:[A-Z]+(?: [A-Z]+)*)?$/);
      expect(jaro(normalized, reversed)).toBeGreaterThanOrEqual(0);
      expect(jaro(normalized, reversed)).toBeLessThanOrEqual(1);
      expect(jaroWinkler(normalized, reversed)).toBeGreaterThanOrEqual(0);
      expect(jaroWinkler(normalized, reversed)).toBeLessThanOrEqual(1);
      expect(jaro(normalized, reversed)).toBeCloseTo(jaro(reversed, normalized), 12);

      const match = buildFtsMatch(value);
      if (match)
        expect(match.split(' AND ').every((token) => /^"[a-z0-9]+"$/.test(token))).toBe(true);
    }
  });
});

describe('ingest parser fuzz invariants', () => {
  it('does not turn adversarial content under unknown roots into source records', () => {
    const random = mulberry32(0x1badb002);
    const values = [
      ...adversarialStrings,
      ...Array.from({ length: 200 }, () => randomUnicode(random, 120)),
    ];
    for (const value of values) {
      const doc = parseXml<Record<string, unknown>>(
        `<root><noise>${escapeXml(value)}</noise></root>`,
      );
      expect(parseOfac(doc, 'ofac_sdn')).toHaveLength(0);
      expect(parseEu(doc)).toHaveLength(0);
      expect(parseUk(doc)).toHaveLength(0);
      expect(parseUn(doc)).toHaveLength(0);
      expect(parseLeiLevel1(doc)).toHaveLength(0);
    }
  });

  it('drops truncated streaming records rather than emitting partial entities', async () => {
    const truncated =
      '<LEIData><LEIRecords><LEIRecord><LEI>5493001KJTIIGC8Y1R12</LEI><Entity><LegalName>Partial';
    expect(await collect(streamLeiLevel1FromText(chunks(truncated, 1)))).toHaveLength(0);
    expect(await collect(streamLeiLevel1FromText(chunks(truncated, 7)))).toHaveLength(0);
  });

  // Correct behavior is tracked by https://github.com/cyanheads/sanctions-screening-mcp-server/issues/14
  it.skip('rejects source-shaped records with missing IDs, names, or truncated XML', () => {
    const invalid = [
      '<sdnList><sdnEntry><firstName>Test</firstName><lastName>Person</lastName></sdnEntry></sdnList>',
      '<sdnList><sdnEntry><uid>42</uid></sdnEntry></sdnList>',
      '<sdnList><sdnEntry><uid>1</uid><firstName>Truncated',
    ];
    for (const xml of invalid) {
      expect(parseOfac(parseXml(xml), 'ofac_sdn')).toHaveLength(0);
    }
    expect(
      parseLeiLevel1(
        parseXml(
          '<LEIData><LEIRecords><LEIRecord><LEI>5493001KJTIIGC8Y1R12</LEI><Entity/></LEIRecord></LEIRecords></LEIData>',
        ),
      ),
    ).toHaveLength(0);
  });

  // Correct behavior is tracked by https://github.com/cyanheads/sanctions-screening-mcp-server/issues/14
  it.skip('rejects invalid UTF-8 instead of indexing replacement-character names', async () => {
    const prefix = new TextEncoder().encode(
      '<LEIData><LEIRecords><LEIRecord><LEI>5493001KJTIIGC8Y1R12</LEI><Entity><LegalName>',
    );
    const suffix = new TextEncoder().encode(
      '</LegalName></Entity></LEIRecord></LEIRecords></LEIData>',
    );
    async function* bytes(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.from([...prefix, 0xc3, 0x28, ...suffix]);
    }
    expect(await collect(streamLeiLevel1FromBytes(bytes()))).toHaveLength(0);
  });
});

describe('near-miss designation fuzzing', () => {
  let standalone: SeededService | undefined;

  afterEach(async () => {
    await standalone?.cleanup();
  });

  it('keeps one-edit variants above the floor and unrelated names out', async () => {
    standalone = await freshService();
    const designations: NormalizedDesignation[] = [
      designation('ofac_sdn', 'FUZZ-1', 'MADURO MOROS Nicolas'),
      designation('eu', 'FUZZ-2', 'Saddam Hussein Al-Tikriti'),
    ];
    await standalone.service.ingestDesignations(designations);
    await standalone.service.markSanctionsReady(designations.length);

    for (const [entryId, name] of [
      ['FUZZ-1', 'MADURO MOROS Nicolas'],
      ['FUZZ-2', 'Saddam Hussein Al-Tikriti'],
    ] as const) {
      for (const query of oneEditVariants(name).slice(0, 40)) {
        const result = await standalone.service.screenName(
          {
            query,
            entityType: 'any',
            matchMode: 'fuzzy',
            sources: [...SOURCE_CODES],
            limit: 10,
          },
          createMockContext(),
        );
        const hit = result.hits.find((candidate) => candidate.sourceEntryId === entryId);
        expect(hit, query).toBeDefined();
        expect(hit?.score, query).toBeGreaterThanOrEqual(0.85);
        expect(result.hits[0]?.sourceEntryId, query).toBe(entryId);
      }
    }

    const unrelated = await standalone.service.screenName(
      {
        query: 'Giorgi Ivanov',
        entityType: 'any',
        matchMode: 'fuzzy',
        sources: [...SOURCE_CODES],
        limit: 10,
      },
      createMockContext(),
    );
    expect(unrelated.hits).toHaveLength(0);
  });
});

function designation(
  source: NormalizedDesignation['source'],
  sourceEntryId: string,
  primaryName: string,
): NormalizedDesignation {
  return {
    id: `${source}:${sourceEntryId}`,
    source,
    sourceEntryId,
    entityType: 'person',
    primaryName,
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  };
}

function oneEditVariants(value: string): string[] {
  const alphabet = 'aeikmnorstuv';
  const variants: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!/[A-Za-z]/.test(value[index] ?? '')) continue;
    const replacement = alphabet[index % alphabet.length] ?? 'x';
    if (replacement.toLowerCase() === value[index]?.toLowerCase()) continue;
    variants.push(`${value.slice(0, index)}${replacement}${value.slice(index + 1)}`);
  }
  return variants;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomUnicode(random: () => number, maxLength: number): string {
  const length = Math.floor(random() * maxLength);
  const ranges = [
    [0x00, 0x7f],
    [0x300, 0x36f],
    [0x400, 0x4ff],
    [0x600, 0x6ff],
    [0x2000, 0x206f],
  ] as const;
  return Array.from({ length }, () => {
    const range = ranges[Math.floor(random() * ranges.length)] ?? ranges[0];
    const codePoint = range[0] + Math.floor(random() * (range[1] - range[0] + 1));
    return String.fromCodePoint(codePoint);
  }).join('');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function* chunks(value: string, size: number): AsyncGenerator<string> {
  for (let index = 0; index < value.length; index += size) {
    yield value.slice(index, index + size);
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
