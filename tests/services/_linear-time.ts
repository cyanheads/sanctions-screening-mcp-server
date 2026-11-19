/**
 * @fileoverview Test helper — asserts a function's cost grows at most linearly in
 * its input, measured in the thread's own CPU time (`process.threadCpuUsage`), so
 * a loaded machine that deschedules the test never reads as slow code. Shared by
 * every suite that times a scanner or pattern over caller-sized text.
 * @module tests/services/_linear-time
 */

import { expect } from 'vitest';

/** Thread CPU milliseconds per call of `calls` calls of a function over `text`. */
type BatchTimer = (text: string, calls: number) => number | Promise<number>;

/** Thread CPU milliseconds since `started`. */
function cpuMsSince(started: NodeJS.CpuUsage): number {
  const spent = process.threadCpuUsage(started);
  return (spent.user + spent.system) / 1000;
}

/** Per-call thread CPU milliseconds of synchronous `fn(text)`: the least of five batches of `calls` calls. */
function syncBatchTimer(fn: (text: string) => unknown): BatchTimer {
  return (text, calls) => {
    let least = Number.POSITIVE_INFINITY;
    for (let trial = 0; trial < 5; trial += 1) {
      const started = process.threadCpuUsage();
      for (let call = 0; call < calls; call += 1) fn(text);
      least = Math.min(least, cpuMsSince(started));
    }
    return least / calls;
  };
}

/**
 * Per-call thread CPU milliseconds of awaited `fn(text)`: the least of five batches
 * of `calls` calls. The work runs on this thread's microtask queue, so thread CPU
 * time covers it; nothing in a batch waits on I/O.
 */
function asyncBatchTimer(fn: (text: string) => Promise<unknown>): BatchTimer {
  return async (text, calls) => {
    let least = Number.POSITIVE_INFINITY;
    for (let trial = 0; trial < 5; trial += 1) {
      const started = process.threadCpuUsage();
      for (let call = 0; call < calls; call += 1) await fn(text);
      least = Math.min(least, cpuMsSince(started));
    }
    return least / calls;
  };
}

/** Calls per batch so that one batch takes at least 2 ms of CPU. */
async function callsPerBatch(time: BatchTimer, text: string): Promise<number> {
  let calls = 1;
  while (calls < 1 << 20 && (await time(text, calls)) * calls < 2) calls *= 2;
  return calls;
}

const BASE_LENGTH = 5_000;

/**
 * Assert `fn` grows at most linearly over `build(length)`, doubling `length` from
 * 5,000 characters to `maxLength`. Each size is timed beside the 5,000-character
 * baseline three times; the least growth over those pairs stays under four times
 * the length ratio (linear growth is the ratio itself, quadratic its square), and
 * one call stays under `maxCallMs`. Both are checked at each size before the next,
 * so a quadratic regression fails at the first size it shows at.
 *
 * A `fn` that returns a promise is awaited on every call; one that does not is
 * timed without an await between calls.
 */
export async function expectLinearTime(
  fn: (text: string) => unknown,
  build: (length: number) => string,
  maxLength: number,
  maxCallMs: number,
): Promise<void> {
  const base = build(BASE_LENGTH);
  const probe = fn(base);
  if (probe instanceof Promise) await probe;
  const time =
    probe instanceof Promise
      ? asyncBatchTimer(fn as (text: string) => Promise<unknown>)
      : syncBatchTimer(fn);
  const baseCalls = await callsPerBatch(time, base);
  for (let length = BASE_LENGTH * 2; length <= maxLength; length *= 2) {
    const text = build(length);
    const calls = Math.max(1, Math.round((baseCalls * BASE_LENGTH) / length));
    let leastGrowth = Number.POSITIVE_INFINITY;
    let leastCallMs = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < 3; pair += 1) {
      const baseMs = await time(base, baseCalls);
      const sizeMs = await time(text, calls);
      leastCallMs = Math.min(leastCallMs, sizeMs);
      leastGrowth = Math.min(leastGrowth, sizeMs / baseMs);
    }
    const ratio = length / BASE_LENGTH;
    const timings = `${length} characters: ${leastCallMs.toFixed(4)} ms per call, ${leastGrowth.toFixed(1)}× the 5,000-character call`;
    expect(leastCallMs, timings).toBeLessThan(maxCallMs);
    expect(leastGrowth, timings).toBeLessThan(4 * ratio);
  }
}
