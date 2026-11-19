/**
 * @fileoverview `requireCompleteDocument` — the check that tells a complete
 * source document from one cut short. A document passes only when its root
 * element closed and nothing but whitespace, comments, and processing
 * instructions followed; it fails when the stream ends before the root closes,
 * or inside a comment, processing instruction, or CDATA section.
 *
 * Every verdict is asserted at chunk sizes from one character to 64 KiB, since
 * the scan carries its state across chunk boundaries rather than re-reading a
 * retained tail; and the scan is timed on inputs built to punish a scanner that
 * re-reads or backtracks.
 *
 * Also the reader for a date a document publishes on its root: the root start
 * tag the check hands over, and `startTagAttribute` over it, timed on worst-case
 * input (#88). `isoDocumentDate`, which reads that date, is tested with
 * `ingest-validation`.
 * @module tests/services/xml-stream.test
 */

import { describe, expect, it } from 'vitest';
import {
  type RecordFragment,
  requireCompleteDocument,
  scanRecordFragments,
  startTagAttribute,
} from '@/services/screening/xml-stream.js';
import { expectLinearTime } from './_linear-time.js';

/** Chunk sizes every verdict is checked at — one character up to 64 KiB. */
const CHUNK_SIZES = [1, 2, 3, 4, 5, 7, 9, 13, 64, 65_536];

async function* chunked(text: string, size: number): AsyncGenerator<string> {
  for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
}

/**
 * The verdict for `text` fed in `size`-character chunks: `'complete'`, or the
 * error message it failed with. The text itself must pass through unchanged.
 */
async function verdict(text: string, size = 65_536): Promise<string> {
  return verdictOfChunks(chunked(text, size), text);
}

/** The verdict for the given chunks, whose concatenation is `text`. */
async function verdictOfChunks(chunks: AsyncIterable<string>, text: string): Promise<string> {
  let seen = '';
  try {
    for await (const chunk of requireCompleteDocument(chunks, 'test')) seen += chunk;
  } catch (err) {
    return (err as Error).message;
  }
  expect(seen).toBe(text);
  return 'complete';
}

/** The verdict at every chunk size — they must all agree. */
async function verdictAtEveryChunking(text: string): Promise<string> {
  const verdicts = new Set<string>();
  for (const size of CHUNK_SIZES) verdicts.add(await verdict(text, size));
  expect([...verdicts], 'the verdict changed with the chunk size').toHaveLength(1);
  return [...verdicts][0] as string;
}

const TRUNCATED = /document ended before its closing <\/r> tag — the transfer was truncated/;

// Cases whose verdict is the same before and after the scan replaced the fixed
// 4,096-character tail: the characterization the rewrite is held to.
const STANDING_PASSES: [label: string, text: string][] = [
  ['a bare root', '<r>x</r>'],
  ['a prolog, then the root', '<?xml version="1.0"?>\n<!-- p --><!DOCTYPE r>\n<r>x</r>\n'],
  ['whitespace inside the end tag', '<r>x</r \n\t>\n'],
  ['a trailing comment that holds the root end tag', '<r>x</r><!-- </r> -->'],
  ['a trailing processing instruction', '<r>x</r><?pi </r> ?>\n'],
  ['a self-closing root', '<r a="1"/>\n'],
  ['a nested element of the root name', '<r><r>x</r></r>'],
  ['a root end tag in a content comment, then the real close', '<r>x<!-- </r> --></r>'],
  ['a root end tag in content CDATA, then the real close', '<r><![CDATA[</r>]]></r>'],
  ['a namespaced root', '<a.b-c:root>x</a.b-c:root>'],
];

const STANDING_FAILURES: [label: string, text: string][] = [
  ['a cut inside the root close', '<r>x</'],
  ['a cut inside the root close name', '<r>x</r'],
  ['a cut inside the end tag, before its >', '<r>x</r  '],
  ['a cut before the root close', '<r>x<a>y</a>'],
  ['a root end tag only inside a content comment', '<r>x<!-- </r> -->'],
  ['a root end tag only inside content CDATA', '<r>x<![CDATA[</r>]]>'],
  ['an element after the root close', '<r>x</r><a/>'],
  ['text after the root close', '<r>x</r>text'],
  ['CDATA after the root close', '<r>x</r><![CDATA[x]]>'],
  ['a stream ending inside a trailing comment', '<r>x</r><!-- cut'],
  ['a stream ending inside a trailing processing instruction', '<r>x</r><?pi cut'],
  ['an end tag of a longer name', '<r>x</rx>'],
  ['an end tag of another name', '<r>x</other>'],
  ['a partial tag after the root close', '<r>x</r><'],
];

describe('requireCompleteDocument — standing verdicts', () => {
  it.each(STANDING_PASSES)('passes %s', async (_label, text) => {
    expect(await verdictAtEveryChunking(text)).toBe('complete');
  });

  it.each(STANDING_FAILURES)('fails %s', async (_label, text) => {
    expect(await verdictAtEveryChunking(text)).toMatch(TRUNCATED);
  });

  it('fails a stream that never opens a root element, or ends before it does', async () => {
    expect(await verdict('{"error":"unavailable"}')).toMatch(/ended before its XML root element/);
    expect(await verdict('x'.repeat(70_000))).toMatch(/did not open an XML root element/);
    expect(await verdict('<?xml version="1.0"?>\n<!-- only a prolog -->')).toMatch(
      /ended before its XML root element/,
    );
  });
});

describe('requireCompleteDocument — the root close is found by a forward scan (#34)', () => {
  it('passes a complete document whatever length of misc follows the root close', async () => {
    // Issue #34, repro 1: an 18,001-character epilog of comments and instructions.
    const repro = `<r>x</r>${'<!-- c --><?pi x?>'.repeat(1000)}\n`;
    expect(await verdictAtEveryChunking(repro)).toBe('complete');

    for (const epilog of [
      ' '.repeat(80_000),
      `<!--${'c'.repeat(80_000)}-->`,
      '<?pi x?>\n'.repeat(10_000),
      `${'<!-- </r> -->'.repeat(6_000)}\n`,
    ]) {
      expect(await verdict(`<r>x</r>${epilog}`, 1)).toBe('complete');
      expect(await verdict(`<r>x</r>${epilog}`)).toBe('complete');
    }
  });

  it('fails a stream cut inside a content comment or CDATA section right after a literal root end tag', async () => {
    // Issue #34, repro 2: the literal </r> sits inside a section opened in content.
    expect(await verdictAtEveryChunking('<r>x<!-- </r>')).toMatch(TRUNCATED);
    expect(await verdictAtEveryChunking('<r>x<![CDATA[ </r>')).toMatch(TRUNCATED);
    expect(await verdictAtEveryChunking('<r>x<?pi </r>')).toMatch(TRUNCATED);
  });

  it('fails anything but misc after a self-closing root', async () => {
    expect(await verdictAtEveryChunking('<r/><!-- c -->\n<?pi x?>')).toBe('complete');
    expect(await verdictAtEveryChunking('<r/>text')).toMatch(TRUNCATED);
    expect(await verdictAtEveryChunking('<r/><a/>')).toMatch(TRUNCATED);
    expect(await verdictAtEveryChunking('<r/><!-- cut')).toMatch(TRUNCATED);
  });

  it('fails a long epilog that ends in text or an open comment', async () => {
    expect(await verdict(`<r>x</r>${' '.repeat(80_000)}x`)).toMatch(TRUNCATED);
    expect(await verdict(`<r>x</r>${'<!-- c -->'.repeat(8_000)}<!-- cut`)).toMatch(TRUNCATED);
  });

  it('reads the root end tag at every split point of the tag', async () => {
    const doc = '<?xml version="1.0"?>\n<export a="1"><e/></export \n>\n<!-- end -->\n';
    const close = doc.indexOf('</export');
    for (let split = close; split <= doc.indexOf('<!-- end'); split += 1) {
      const halves = (async function* () {
        yield doc.slice(0, split);
        yield doc.slice(split);
      })();
      expect(await verdictOfChunks(halves, doc), `split at ${split}`).toBe('complete');
      // Cut at the same point instead: everything before the tag's > is a truncation.
      if (split < doc.indexOf('>', close) + 1) {
        expect(await verdict(doc.slice(0, split)), `cut at ${split}`).toMatch(
          /closing <\/export> tag/,
        );
      }
    }
  });
});

// ─── Timing ────────────────────────────────────────────────────────────────────

/**
 * Inputs built to punish a scan that re-reads retained text or backtracks, each
 * grown to `n` characters by repeating its unit.
 */
const WORST_CASES: [label: string, build: (n: number) => string][] = [
  ['a run of <', (n) => `<r>${'<'.repeat(n)}</r>`],
  ['unterminated <!-- after the close', (n) => `<r>x</r>${'<!--'.repeat(n / 4)}`],
  ['unterminated <? after the close', (n) => `<r>x</r>${'<?'.repeat(n / 2)}`],
  ['unterminated <!-- in content', (n) => `<r>${'<!--'.repeat(n / 4)}`],
  ['repeated </r followed by a space', (n) => `<r>${'</r '.repeat(n / 4)}`],
  ['repeated </r>x', (n) => `<r>${'</r>x'.repeat(n / 5)}</r>`],
  ['a dash run inside a trailing comment', (n) => `<r>x</r><!--${'-'.repeat(n)}`],
  ['a dash run inside a content comment', (n) => `<r><!--${'-'.repeat(n)}--></r>`],
  ['a bracket run inside CDATA', (n) => `<r><![CDATA[${']'.repeat(n)}]]></r>`],
];

/** Thread CPU milliseconds for `runs` checks; descheduled time is not scanner work. */
async function timeChecks(text: string, size: number, runs: number): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let trial = 0; trial < 3; trial += 1) {
    const started = process.threadCpuUsage();
    for (let run = 0; run < runs; run += 1) await verdict(text, size);
    const elapsed = process.threadCpuUsage(started);
    best = Math.min(best, (elapsed.user + elapsed.system) / 1000);
  }
  return best;
}

/** Enough checks of `text` that one batch takes milliseconds, so timer noise stays small. */
async function calibrate(text: string, size: number): Promise<number> {
  let runs = 1;
  while (runs < 4096 && (await timeChecks(text, size, runs)) < 2) runs *= 2;
  return runs;
}

describe('requireCompleteDocument — linear on worst-case input', () => {
  it.each(
    WORST_CASES.flatMap(([label, build]) =>
      [1, 65_536].map((size) => [label, size, build] as const),
    ),
  )('scans %s in %i-character chunks in time linear in its length', async (_label, size, build) => {
    const runs = await calibrate(build(5_000), size);
    const t5k = (await timeChecks(build(5_000), size, runs)) / runs;
    const t20k = (await timeChecks(build(20_000), size, runs)) / runs;
    const t80k = (await timeChecks(build(80_000), size, runs)) / runs;
    const timings = `5k ${t5k.toFixed(4)}ms, 20k ${t20k.toFixed(4)}ms, 80k ${t80k.toFixed(4)}ms per check`;

    // Linear growth over 16× the input is ~16×; quadratic would be 256×.
    expect(t80k / t5k, timings).toBeLessThan(64);
    // One 80,000-character check, one character per chunk included, well inside a second.
    expect(t80k, timings).toBeLessThan(150);
  });
});

// ─── A document's own date (#88) ───────────────────────────────────────────────

/** The root start tags `requireCompleteDocument` hands over for `text` fed in `size`-character chunks. */
async function rootStartTags(text: string, size: number): Promise<string[]> {
  const tags: string[] = [];
  try {
    for await (const _chunk of requireCompleteDocument(chunked(text, size), 'test', (tag) =>
      tags.push(tag),
    ));
  } catch {
    /* A verdict is not what these cases assert. */
  }
  return tags;
}

describe('requireCompleteDocument — the root start tag', () => {
  const EU_ROOT =
    '<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-10-23T17:05:43.888+02:00" globalFileId="185833">';

  it('hands over the root start tag once, without its prolog, at every chunking', async () => {
    const text = `<?xml version="1.0"?>\n<!-- <decoy generationDate="x"> -->\n<!DOCTYPE export>\n${EU_ROOT}<sanctionEntity/></export>`;
    for (const size of CHUNK_SIZES) expect(await rootStartTags(text, size)).toEqual([EU_ROOT]);
  });

  it('hands over a self-closing root, and nothing for a stream that never opens one', async () => {
    expect(await rootStartTags('<r a="1"/>', 2)).toEqual(['<r a="1"/>']);
    expect(await rootStartTags('<?xml version="1.0"?>\n<!-- only a prolog -->', 3)).toEqual([]);
    expect(await rootStartTags('{"error":"unavailable"}', 64)).toEqual([]);
  });
});

describe('scanRecordFragments — a self-closing record', () => {
  async function fragments(text: string, size: number): Promise<RecordFragment[]> {
    const out: RecordFragment[] = [];
    for await (const fragment of scanRecordFragments(chunked(text, size), ['DateOfIssue', 'Party']))
      out.push(fragment);
    return out;
  }

  it('lifts it as a complete empty fragment, and every record after it still streams', async () => {
    const text =
      '<Sanctions><DateOfIssue CalendarTypeID="1"/><Party ID="1">a</Party><Party ID="2"/><Party ID="3">c</Party></Sanctions>';
    for (const size of CHUNK_SIZES) {
      expect(await fragments(text, size), `chunk size ${size}`).toEqual([
        { name: 'DateOfIssue', xml: '<DateOfIssue CalendarTypeID="1"/>' },
        { name: 'Party', xml: '<Party ID="1">a</Party>' },
        { name: 'Party', xml: '<Party ID="2"/>' },
        { name: 'Party', xml: '<Party ID="3">c</Party>' },
      ]);
    }
  });

  it('still drops a record whose closing tag never arrives', async () => {
    for (const size of CHUNK_SIZES) {
      expect(await fragments('<Sanctions><Party ID="1">a</Party><Party ID="2">b', size)).toEqual([
        { name: 'Party', xml: '<Party ID="1">a</Party>' },
      ]);
    }
  });
});

describe('scanRecordFragments — a record that spans many chunks', () => {
  async function fragments(
    chunks: AsyncIterable<string>,
    names: readonly string[] = ['Party'],
  ): Promise<RecordFragment[]> {
    const out: RecordFragment[] = [];
    for await (const fragment of scanRecordFragments(chunks, names)) out.push(fragment);
    return out;
  }

  /** `text` in 7-character chunks up to `at`, then everything after `at` as one chunk. */
  async function* splitAt(text: string, at: number): AsyncGenerator<string> {
    yield* chunked(text.slice(0, at), 7);
    yield text.slice(at);
  }

  const DECOYS = '</Part> </Partyx> </Party </lei:Party> <Party';

  it('finds the closing tag split across two chunks at every point of the tag', async () => {
    const record = `<Party ID="1">${'x'.repeat(200)}${DECOYS}${'y'.repeat(200)}</Party>`;
    const text = `<Sanctions>${record}<Party ID="2">b</Party></Sanctions>`;
    const closeAt = text.indexOf('</Party><Party ID="2">');
    for (let at = closeAt; at <= closeAt + '</Party>'.length; at += 1) {
      expect(await fragments(splitAt(text, at)), `split at ${at}`).toEqual([
        { name: 'Party', xml: record },
        { name: 'Party', xml: '<Party ID="2">b</Party>' },
      ]);
    }
  });

  it('lifts a long record, a long open tag, and a long self-closing tag at every chunking', async () => {
    const id = 'a'.repeat(300);
    const text = `<Sanctions><Party ID="1">${'x'.repeat(300)}${DECOYS}</Party><Party ID="${id}">b</Party><Party ID="${id}"/><Party ID="4">d</Party></Sanctions>`;
    for (const size of CHUNK_SIZES) {
      expect(await fragments(chunked(text, size)), `chunk size ${size}`).toEqual([
        { name: 'Party', xml: `<Party ID="1">${'x'.repeat(300)}${DECOYS}</Party>` },
        { name: 'Party', xml: `<Party ID="${id}">b</Party>` },
        { name: 'Party', xml: `<Party ID="${id}"/>` },
        { name: 'Party', xml: '<Party ID="4">d</Party>' },
      ]);
    }
  });

  it('closes a namespace-prefixed record only on its own prefixed tag', async () => {
    const record = `<lei:LEIRecord>${'x'.repeat(200)}</LEIRecord></rr:LEIRecord>${'y'.repeat(200)}</lei:LEIRecord>`;
    for (const size of CHUNK_SIZES) {
      expect(
        await fragments(chunked(`<lei:LEIRecords>${record}</lei:LEIRecords>`, size), ['LEIRecord']),
        `chunk size ${size}`,
      ).toEqual([{ name: 'LEIRecord', xml: record }]);
    }
  });

  it('drops a long record whose closing tag never arrives at every chunking', async () => {
    const text = `<Sanctions><Party ID="1">a</Party><Party ID="2">${'x'.repeat(300)}${DECOYS}`;
    for (const size of CHUNK_SIZES) {
      expect(await fragments(chunked(text, size)), `chunk size ${size}`).toEqual([
        { name: 'Party', xml: '<Party ID="1">a</Party>' },
      ]);
    }
  });
});

/**
 * One record grown to `n` characters, for the scanner fed in 64-character chunks:
 * a long body that closes, a record or open tag that never closes, repeated
 * openers, repeated prefixes of the closing tag, and the two line-break shapes,
 * each within 80,000 characters; a digit run carries the full 64× span.
 */
const RECORD_WORST_CASES: [label: string, build: (n: number) => string, max: number][] = [
  ['a long record body', (n) => `<Party ID="1">${'x'.repeat(n)}</Party>`, 80_000],
  ['a record that never closes', (n) => `<Party ID="1">${'x'.repeat(n)}`, 80_000],
  ['an open tag that never ends', (n) => `<Party ID="${'x'.repeat(n)}`, 80_000],
  ['repeated openers with no closer', (n) => '<Party>'.repeat(n / 7), 80_000],
  ['repeated prefixes of the closing tag', (n) => `<Party>${'</Party'.repeat(n / 7)}`, 80_000],
  ['one long line ending in a break', (n) => `<Party>${'x'.repeat(n)}\ny`, 80_000],
  ['breaks throughout', (n) => `<Party>${'  \r\n'.repeat(n / 4)}`, 80_000],
  ['a long digit run', (n) => `<Party>${'1'.repeat(n)}</Party>`, 320_000],
];

/** Fragments `scanRecordFragments` lifts from `text` fed in 64-character chunks. */
async function scanIn64CharChunks(text: string): Promise<number> {
  let count = 0;
  for await (const _fragment of scanRecordFragments(chunked(text, 64), ['Party'])) count += 1;
  return count;
}

describe('scanRecordFragments — linear in the length of a record that spans many chunks', () => {
  it.each(RECORD_WORST_CASES)(
    'scans %s in time linear in its length',
    async (_label, build, max) => {
      await expectLinearTime(scanIn64CharChunks, build, max, 50);
    },
    0,
  );
});

describe('startTagAttribute', () => {
  it('reads a double- or single-quoted attribute as published', () => {
    expect(startTagAttribute('<export a="1" generationDate="2026-10-23">', 'generationDate')).toBe(
      '2026-10-23',
    );
    expect(startTagAttribute("<LIST\n  dateGenerated = '2026-11-19Z'>", 'dateGenerated')).toBe(
      '2026-11-19Z',
    );
    expect(startTagAttribute('<export generationDate="">', 'generationDate')).toBe('');
  });

  it('reads nothing for an absent attribute or one whose name only contains it', () => {
    expect(startTagAttribute('<export globalFileId="1">', 'generationDate')).toBeUndefined();
    expect(startTagAttribute('<export xgenerationDate="1">', 'generationDate')).toBeUndefined();
    expect(startTagAttribute('<export generationDateX="1">', 'generationDate')).toBeUndefined();
    expect(startTagAttribute('<export generationDate=1>', 'generationDate')).toBeUndefined();
  });
});

/**
 * Worst cases for the attribute read: an unclosed value under each quote, the
 * whitespace either side of a missing `=` or quote, repeated openers, overlapping
 * prefixes of the name, and the two line-break shapes. Each stays at or under
 * 80,000 characters, where Bun's regex engine can change mode on some shapes;
 * a digit run, which never does, carries the full 64× span.
 */
const ATTRIBUTE_WORST_CASES: [label: string, build: (length: number) => string, max: number][] = [
  ['an unclosed double-quoted value', (n) => `<export generationDate="${'x'.repeat(n)}`, 80_000],
  ['an unclosed single-quoted value', (n) => `<export generationDate='${'x'.repeat(n)}`, 80_000],
  ['whitespace before a missing =', (n) => `<export generationDate${' '.repeat(n)}`, 80_000],
  ['whitespace after = and no quote', (n) => `<export generationDate=${' '.repeat(n)}`, 80_000],
  ['repeated openers with no value', (n) => ' generationDate='.repeat(n / 16), 80_000],
  ['overlapping prefixes of the name', (n) => ' generationDat'.repeat(n / 14), 80_000],
  ['one long line ending in a break', (n) => `${'x'.repeat(n)}\ny`, 80_000],
  ['breaks throughout', (n) => '  \r\n'.repeat(n / 4), 80_000],
  ['a long digit run', (n) => '1'.repeat(n), 320_000],
];

describe('startTagAttribute — linear on worst-case input', () => {
  it.each(ATTRIBUTE_WORST_CASES)(
    'reads %s in time linear in its length',
    async (_label, build, max) => {
      await expectLinearTime((text) => startTagAttribute(text, 'generationDate'), build, max, 50);
    },
    0,
  );
});
