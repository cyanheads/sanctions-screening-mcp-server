/**
 * @fileoverview `isoDocumentDate` — the shared reader for each source's own
 * publication date (#88): which ISO 8601 values it keeps verbatim, which it reads
 * as nothing, and its cost on worst-case input.
 * @module tests/services/ingest-validation.test
 */

import { describe, expect, it } from 'vitest';
import { isoDocumentDate } from '@/services/screening/ingest-validation.js';
import { expectLinearTime } from './_linear-time.js';

describe('isoDocumentDate', () => {
  it.each([
    ['an OFAC date of issue, zero-padded by the parser', '2026-11-04'],
    ['a year and month', '2026-11'],
    ['a year', '2026'],
    ['a leap day', '2024-02-29'],
    ['an EU offset datetime with milliseconds', '2026-10-23T17:05:43.888+02:00'],
    ['a UN UTC datetime with milliseconds', '2026-11-19T00:00:03.388Z'],
    ['a CSL offset datetime to seconds', '2026-07-24T00:00:00+00:00'],
    ['a negative offset', '2026-07-24T00:00:00-05:30'],
    ['a local datetime, which gains no zone', '2026-11-19T10:15:30'],
    ['a local datetime to minutes', '2026-11-19T10:15'],
  ])('keeps %s verbatim', (_label, value) => {
    expect(isoDocumentDate(value)).toBe(value);
  });

  it('trims surrounding whitespace', () => {
    expect(isoDocumentDate('\n  2026-11-04 \t')).toBe('2026-11-04');
  });

  it.each([
    ['a UK DD/MM/YYYY date', '17/11/2026'],
    ['month 13', '2026-13-01'],
    ['month 00', '2026-00-10'],
    ['30 February', '2026-02-30'],
    ['29 February outside a leap year', '2025-02-29'],
    ['hour 24', '2026-11-04T24:00'],
    ['minute 60', '2026-11-04T10:60'],
    ['second 60', '2026-11-04T10:00:60Z'],
    ['an offset of 24 hours', '2026-11-04T10:00:00+24:00'],
    ['a basic-format offset', '2026-11-04T10:00:00+0200'],
    ['a space for the time separator', '2026-11-04 10:00:00'],
    ['a two-digit year', '26-11-04'],
    ['an empty value', ''],
    ['whitespace only', '   '],
    ['an ISO date followed by text', '2026-11-04 (revised)'],
  ])('reads nothing from %s', (_label, value) => {
    expect(isoDocumentDate(value)).toBeUndefined();
  });

  it('reads nothing from no value', () => {
    expect(isoDocumentDate(undefined)).toBeUndefined();
  });
});

/** Worst cases for the date read, each a run its pattern's quantifiers could chew on. */
const DATE_WORST_CASES: [label: string, build: (length: number) => string, max: number][] = [
  ['a long digit run', (n) => '1'.repeat(n), 320_000],
  ['a long fraction', (n) => `2026-11-04T10:00:00.${'1'.repeat(n)}`, 80_000],
  ['repeated date prefixes', (n) => '2026-'.repeat(n / 5), 80_000],
  ['one long line ending in a break', (n) => `${'x'.repeat(n)}\ny`, 80_000],
  ['breaks throughout', (n) => '  \r\n'.repeat(n / 4), 80_000],
];

describe('isoDocumentDate — linear on worst-case input', () => {
  it.each(DATE_WORST_CASES)(
    'reads %s in time linear in its length',
    async (_label, build, max) => {
      await expectLinearTime(isoDocumentDate, build, max, 50);
    },
    0,
  );
});
