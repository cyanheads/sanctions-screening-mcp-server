/**
 * @fileoverview GLEIF ingester — the heaviest leg. Resolves the latest
 * golden-copy (full) or delta download URLs from the GLEIF Golden Copy API and
 * normalizes LEI-CDF Level 1 (who-is-who) and RR-CDF Level 2 (who-owns-whom)
 * records onto {@link NormalizedLeiEntity} / {@link NormalizedLeiRelationship}.
 *
 * Two ingest paths share the same per-record normalization
 * ({@link parseOneLei} / {@link parseOneRelationship}):
 * - Golden-copy init ({@link streamLeiLevel1} / {@link streamLeiLevel2}): a
 *   streaming ZIP/gzip → record-boundary scan → normalize pipeline that never
 *   holds the whole decompressed document in memory. Level 1 is ~3.3M records /
 *   ~892 MB compressed (L2 ~32.5 MB) as of 2026 — decompressed it exceeds V8's
 *   maximum string length, so the buffered whole-document parse below cannot load
 *   it. Init runs out-of-band via `mirror:init`, never on the request path.
 * - Delta refresh + fixtures ({@link harvestLeiLevel1} / {@link harvestLeiLevel2}):
 *   the buffered whole-document parse — small enough to hold in memory, and the
 *   equivalence oracle the streaming path is tested against. Refresh uses the
 *   8-hour deltas.
 * @module services/screening/gleif-ingest
 */

import { Readable, type Transform } from 'node:stream';
import { createGunzip, createInflateRaw, gunzipSync, inflateRawSync } from 'node:zlib';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { NormalizedLeiEntity, NormalizedLeiRelationship } from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';

/** Bounds the buffered delta / fixture download (see {@link downloadGleifXml}). */
const FETCH_TIMEOUT_MS = 600_000;

/**
 * Bounds only time-to-response-headers on a streaming golden-copy download.
 * `fetchWithTimeout` clears its own timeout the moment the `Response` is returned
 * (headers received) — the body is then consumed lazily as the ingest drains it,
 * bounded solely by the external `signal` (the lifecycle script's `longRunSignal`).
 * A multi-GB golden-copy ingest legitimately runs far longer than any fixed fetch
 * timeout, so this value guards a stalled connection, not the transfer itself.
 */
const STREAM_HEADERS_TIMEOUT_MS = 120_000;

/**
 * Max characters the record scanner retains between records when no open tag is
 * buffered — enough to reassemble a record's open tag split across a chunk
 * boundary, bounded so inter-record whitespace can't grow the buffer unboundedly.
 */
const MAX_RETAINED_TAIL = 4096;

/** Which GLEIF dataset + window to fetch. */
export type GleifFileKind = 'lei2-full' | 'lei2-delta' | 'rr-full' | 'rr-delta';

/** Coerce single-child→object / many→array (fast-xml-parser behavior). */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value: unknown): string | undefined {
  if (value == null) return;
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return asText((value as Record<string, unknown>)['#text']);
  }
  return;
}

/**
 * Conditional-spread fragment: `{ [key]: value }` when `value` is defined and
 * non-empty, else `{}`. Keeps normalized objects honest under
 * `exactOptionalPropertyTypes` without a non-null assertion.
 */
function opt<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value ? { [key]: value } : {};
}

/**
 * Resolve the download URL for a GLEIF golden-copy or delta file. The Golden
 * Copy API exposes a JSON index of the latest publications; we read it and return
 * the matching `.xml.zip` download link (both the golden copy and the deltas are
 * ZIP containers).
 *
 * @param kind Which dataset (LEI-CDF L1 / RR-CDF L2) + full-or-delta variant.
 * @param delta Delta window when `kind` is a delta variant. The index nests file
 *   entries under the window, so this selects `delta_files[window].xml`.
 */
export async function resolveGleifFileUrl(
  kind: GleifFileKind,
  signal: AbortSignal,
  delta: 'IntraDay' | 'LastDay' | 'LastWeek' | 'LastMonth' = 'LastDay',
): Promise<string> {
  const base = getServerConfig().gleifGoldenCopyBaseUrl.replace(/\/$/, '');
  // GLEIF Golden Copy API publication index. Both queries return the same rich
  // `data[0]` carrying `full_file` and `delta_files.{window}`:
  //   /api/v2/golden-copies/publishes/lei2?format=xml                       (full)
  //   /api/v2/golden-copies/publishes/lei2?delta.period={window}&format=xml (delta)
  const dataset = kind.startsWith('lei2') ? 'lei2' : 'rr';
  const isDelta = kind.endsWith('delta');
  const url = isDelta
    ? `${base}/api/v2/golden-copies/publishes/${dataset}?delta.period=${delta}&format=xml`
    : `${base}/api/v2/golden-copies/publishes/${dataset}?format=xml`;

  const reqCtx = requestContextService.createRequestContext({ operation: `gleif:index:${kind}` });
  const index = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url, 60_000, reqCtx, { signal });
      return (await res.json()) as Record<string, unknown>;
    },
    { operation: `gleif:index:${kind}`, baseDelayMs: 2000, signal },
  );

  // `data[0].full_file.xml.url` for the golden copy; deltas nest under the window:
  // `data[0].delta_files.{window}.xml.url`.
  const data = asArray((index.data ?? index) as unknown)[0] as Record<string, unknown> | undefined;
  const deltaFiles = data?.delta_files as Record<string, unknown> | undefined;
  const fileNode = (isDelta ? deltaFiles?.[delta] : data?.full_file) as
    | Record<string, unknown>
    | undefined;
  const xmlNode = fileNode?.xml as Record<string, unknown> | undefined;
  const downloadUrl =
    asText(xmlNode?.url) ?? asText((xmlNode as Record<string, unknown>)?.download_link);
  if (!downloadUrl) {
    throw serviceUnavailable(
      `GLEIF Golden Copy index did not contain a download URL for ${kind}.`,
      { url },
    );
  }
  return downloadUrl;
}

/**
 * Download a GLEIF golden-copy / delta file and return the decompressed XML.
 * The golden-copy downloads are **ZIP** containers (`PK\x03\x04`) wrapping a
 * single XML entry — not gzip; the delta `.gz` files are gzip. Detection is by
 * magic bytes (the URL suffix is unreliable behind the storage redirect), with a
 * plain-XML fallback.
 *
 * NOTE (memory): this buffers and decompresses the whole file in memory, so it is
 * for the smaller files only — the GLEIF deltas and the synthetic fixture. The
 * full Level 1 golden copy (~3.3M records / ~892 MB compressed) exceeds V8's
 * maximum string length once decompressed and must NOT go through here;
 * `mirror:init` streams it via {@link streamLeiLevel1} / {@link streamLeiLevel2}.
 */
export function downloadGleifXml(url: string, signal: AbortSignal): Promise<string> {
  const reqCtx = requestContextService.createRequestContext({ operation: 'gleif:download' });
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, reqCtx, { signal });
      const buf = Buffer.from(await res.arrayBuffer());
      const xml = decompressGleifBuffer(buf);
      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(xml)) {
        throw serviceUnavailable('GLEIF returned HTML instead of XML — likely rate-limited.');
      }
      return xml;
    },
    { operation: 'gleif:download', baseDelayMs: 3000, signal },
  );
}

/** Decompress a downloaded GLEIF buffer by detecting ZIP / gzip / plain by magic bytes. */
export function decompressGleifBuffer(buf: Buffer): string {
  if (isZip(buf)) return extractFirstZipEntry(buf);
  if (isGzip(buf)) return gunzipSync(buf).toString('utf8');
  return buf.toString('utf8');
}

function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * Extract the first file entry from a ZIP buffer (stored or deflate). GLEIF
 * golden-copy ZIPs wrap exactly one XML file, so a single-entry reader is
 * sufficient — it reads the local file header, then inflates the entry's raw
 * deflate stream (or returns it verbatim when stored).
 */
export function extractFirstZipEntry(buf: Buffer): string {
  // Local file header: sig(4)=PK\x03\x04, method@8(2), compressedSize@18(4),
  // nameLen@26(2), extraLen@28(2), then [name][extra][data].
  if (!isZip(buf) || buf.length < 30) {
    throw serviceUnavailable('GLEIF download is not a valid ZIP archive.');
  }
  const method = buf.readUInt16LE(8);
  let compressedSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  // Streaming entries (general-purpose bit 3) report size 0 in the local header
  // and place sizes in a trailing data descriptor; the entry data then runs up
  // to the central-directory signature.
  if (compressedSize === 0) {
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataStart);
    compressedSize = (cd === -1 ? buf.length : cd) - dataStart;
  }
  const data = buf.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return data.toString('utf8');
  if (method === 8) return inflateRawSync(data).toString('utf8');
  throw serviceUnavailable(`Unsupported ZIP compression method ${method} in GLEIF download.`);
}

/**
 * Parse an LEI-CDF Level 1 XML document into normalized entity records. The
 * record root is `<LEIRecords><LEIRecord>`; each carries an `<LEI>`, an
 * `<Entity>` (legal name, other names, addresses, jurisdiction, status), and a
 * `<Registration>` (registration status, last-update, RA).
 */
export function parseLeiLevel1(doc: Record<string, unknown>): NormalizedLeiEntity[] {
  const root = (doc.LEIData ?? doc) as Record<string, unknown>;
  const records = asArray((root.LEIRecords as Record<string, unknown> | undefined)?.LEIRecord);
  return records
    .map((raw) => parseOneLei(raw as Record<string, unknown>))
    .filter(Boolean) as NormalizedLeiEntity[];
}

function parseOneLei(r: Record<string, unknown>): NormalizedLeiEntity | null {
  const lei = asText(r.LEI);
  if (!lei) return null;
  const entity = r.Entity as Record<string, unknown> | undefined;
  const registration = r.Registration as Record<string, unknown> | undefined;

  const legalName =
    asText(
      (entity?.LegalName as Record<string, unknown> | undefined)?.['#text'] ?? entity?.LegalName,
    ) ?? 'Unknown';
  const otherNames = asArray(
    (entity?.OtherEntityNames as Record<string, unknown> | undefined)?.OtherEntityName as unknown,
  )
    .map((n) => asText((n as Record<string, unknown>)?.['#text'] ?? n))
    .filter((x): x is string => Boolean(x));

  const legalAddr = renderAddress(entity?.LegalAddress as Record<string, unknown> | undefined);
  const hqAddr = renderAddress(entity?.HeadquartersAddress as Record<string, unknown> | undefined);
  const jurisdiction = asText(entity?.LegalJurisdiction);
  const ra = entity?.RegistrationAuthority as Record<string, unknown> | undefined;

  return {
    lei,
    legalName,
    otherNames,
    ...opt('jurisdiction', jurisdiction),
    ...opt('status', asText(registration?.RegistrationStatus) ?? asText(entity?.EntityStatus)),
    ...opt('legalAddress', legalAddr),
    ...opt('headquartersAddress', hqAddr),
    ...opt('registrationAuthorityId', asText(ra?.RegistrationAuthorityID)),
    ...opt('registrationAuthorityEntityId', asText(ra?.RegistrationAuthorityEntityID)),
    ...opt('lastUpdate', asText(registration?.LastUpdateDate)),
  };
}

function renderAddress(addr: Record<string, unknown> | undefined): string | undefined {
  if (!addr) return;
  const parts = [
    asText(
      (addr.FirstAddressLine as Record<string, unknown> | undefined)?.['#text'] ??
        addr.FirstAddressLine,
    ),
    asText(addr.AdditionalAddressLine),
    asText((addr.City as Record<string, unknown> | undefined)?.['#text'] ?? addr.City),
    asText(addr.Region),
    asText(addr.PostalCode),
    asText((addr.Country as Record<string, unknown> | undefined)?.['#text'] ?? addr.Country),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

/**
 * Parse an RR-CDF Level 2 XML document into normalized relationship records.
 * The record root is `<RelationshipRecords><RelationshipRecord>`; each carries a
 * `<Relationship>` with a start node (child), end node (parent), and type.
 */
export function parseLeiLevel2(doc: Record<string, unknown>): NormalizedLeiRelationship[] {
  const root = (doc.RelationshipData ?? doc) as Record<string, unknown>;
  const records = asArray(
    (root.RelationshipRecords as Record<string, unknown> | undefined)?.RelationshipRecord,
  );
  return records
    .map((raw) => parseOneRelationship(raw as Record<string, unknown>))
    .filter(Boolean) as NormalizedLeiRelationship[];
}

function parseOneRelationship(r: Record<string, unknown>): NormalizedLeiRelationship | null {
  const rel = r.Relationship as Record<string, unknown> | undefined;
  if (!rel) return null;
  const startNode = rel.StartNode as Record<string, unknown> | undefined;
  const endNode = rel.EndNode as Record<string, unknown> | undefined;
  const childLei = asText(
    startNode?.NodeID ?? (startNode as Record<string, unknown> | undefined)?.['#text'],
  );
  const parentLei = asText(
    endNode?.NodeID ?? (endNode as Record<string, unknown> | undefined)?.['#text'],
  );
  const relationshipType = asText(rel.RelationshipType);
  if (!childLei || !parentLei || !relationshipType) return null;

  const period = asArray(
    (rel.RelationshipPeriods as Record<string, unknown> | undefined)?.RelationshipPeriod as unknown,
  )[0] as Record<string, unknown> | undefined;

  return {
    childLei,
    parentLei,
    relationshipType,
    ...opt('relationshipStatus', asText(rel.RelationshipStatus)),
    ...opt('relationshipPeriod', asText(period?.StartDate)),
  };
}

/** Fetch + decompress + parse Level 1 from a resolved URL. */
export async function harvestLeiLevel1(
  url: string,
  signal: AbortSignal,
): Promise<NormalizedLeiEntity[]> {
  const xml = await downloadGleifXml(url, signal);
  const doc = parseXml<Record<string, unknown>>(xml);
  return parseLeiLevel1(doc);
}

/** Fetch + decompress + parse Level 2 from a resolved URL. */
export async function harvestLeiLevel2(
  url: string,
  signal: AbortSignal,
): Promise<NormalizedLeiRelationship[]> {
  const xml = await downloadGleifXml(url, signal);
  const doc = parseXml<Record<string, unknown>>(xml);
  return parseLeiLevel2(doc);
}

// ─── Streaming golden-copy ingest ──────────────────────────────────────────────
//
// The golden-copy files are too large to decompress into one string — the Level 1
// document exceeds V8's maximum string length. Rather than DOM-parse the whole
// file, the streaming path decompresses incrementally and scans the decoded text
// for complete top-level record fragments, feeding each through the SAME parseXml
// + per-record normalizers ({@link parseOneLei} / {@link parseOneRelationship}) the
// buffered path uses — so both paths produce identical normalized records.
//
// ASSUMPTION (load-bearing, documented here because the scanner depends on it):
// GLEIF golden-copy and delta files are machine-generated, well-formed XML whose
// payload is a FLAT sequence of repeating <LEIRecord> / <RelationshipRecord>
// siblings under one root — a record never nests within itself and carries no
// same-named descendant. That flatness is what lets a byte-level <TAG>…</TAG>
// boundary scan stand in for a streaming parser; each matched fragment is still
// handed to the real parseXml for attribute-aware parsing.

/** Open a GLEIF download as a stream of response-body byte chunks. The body is
 *  consumed lazily by the ingest and bounded by the caller's `signal`, not by a
 *  fetch timeout (see {@link STREAM_HEADERS_TIMEOUT_MS}). */
async function openGleifByteStream(
  url: string,
  signal: AbortSignal,
): Promise<AsyncIterable<Uint8Array>> {
  const reqCtx = requestContextService.createRequestContext({ operation: 'gleif:stream' });
  const res = await fetchWithTimeout(url, STREAM_HEADERS_TIMEOUT_MS, reqCtx, { signal });
  if (!res.body) throw serviceUnavailable('GLEIF streaming download returned an empty body.');
  return res.body as AsyncIterable<Uint8Array>;
}

/**
 * Pump a byte source through a zlib transform (gunzip / inflate-raw), yielding
 * decompressed chunks. `Readable.from(...).pipe()` handles backpressure and ends
 * the transform when the source drains; a source error destroys the transform so
 * it surfaces on the consuming iteration. The `finally` tears both down — for a
 * raw-inflate entry that self-terminates before the source drains (the trailing
 * ZIP central directory), this stops feeding the ignored tail.
 */
async function* pipeThrough(
  transform: Transform,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Buffer> {
  const readable = Readable.from(source);
  readable.on('error', (err) => transform.destroy(err));
  readable.pipe(transform);
  try {
    yield* transform as AsyncIterable<Buffer>;
  } finally {
    readable.destroy();
    transform.destroy();
  }
}

/**
 * Decompress a GLEIF byte stream, sniffing the container from its leading bytes: a
 * ZIP golden copy (single deflate/stored entry), a gzip delta, or plain XML.
 *
 * For ZIP the 30-byte local file header is read from the buffered head to locate
 * the entry data and its compression method, then the rest of the stream is
 * inflated with `createInflateRaw`. GLEIF writes streaming ZIP entries
 * (general-purpose bit 3): the local header reports size 0 and a trailing data
 * descriptor + central directory follow the deflate stream. `createInflateRaw`
 * self-terminates at the deflate final block and ignores those trailing bytes, so
 * no compressed size is needed and no explicit stop is required.
 */
async function* decompressGleifByteStream(
  byteChunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const iter = byteChunks[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  let done = false;
  const pull = async (): Promise<void> => {
    const next = await iter.next();
    if (next.done) done = true;
    else head = head.length === 0 ? Buffer.from(next.value) : Buffer.concat([head, next.value]);
  };
  // Rest of the stream from a byte offset into `head`, then the untouched tail.
  const restFrom = async function* (offset: number): AsyncGenerator<Uint8Array> {
    if (offset < head.length) yield head.subarray(offset);
    while (!done) {
      const next = await iter.next();
      if (next.done) break;
      yield next.value;
    }
  };

  // Enough bytes to classify the container and read the ZIP local file header.
  while (head.length < 30 && !done) await pull();
  if (head.length === 0) return;

  if (isZip(head)) {
    if (head.length < 30) throw serviceUnavailable('GLEIF download is a truncated ZIP archive.');
    const method = head.readUInt16LE(8);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = 30 + nameLen + extraLen;
    while (head.length < dataStart && !done) await pull();
    if (method === 8) {
      yield* pipeThrough(createInflateRaw(), restFrom(dataStart));
      return;
    }
    if (method === 0) {
      // Stored (uncompressed) — pass the entry bytes through. A trailing central
      // directory is binary and record-tag-free, so the scanner ignores it.
      yield* restFrom(dataStart);
      return;
    }
    throw serviceUnavailable(`Unsupported ZIP compression method ${method} in GLEIF download.`);
  }
  if (isGzip(head)) {
    yield* pipeThrough(createGunzip(), restFrom(0));
    return;
  }
  // Plain — same HTML rate-limit guard the buffered path applies.
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(head.subarray(0, 64).toString('utf8'))) {
    throw serviceUnavailable('GLEIF returned HTML instead of XML — likely rate-limited.');
  }
  yield* restFrom(0);
}

/** Decode a byte stream as UTF-8, honoring multi-byte characters split across
 *  chunk boundaries via the streaming `TextDecoder`. */
async function* decodeUtf8Stream(byteChunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of byteChunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/**
 * Scan a decoded-text stream for complete `<recordName>…</recordName>` fragments,
 * buffering across chunk boundaries. Matches unprefixed and namespace-prefixed
 * (`lei:` / `rr:`) tags, and never matches the plural container element
 * (`<LEIRecords>` / `<RelationshipRecords>`) — the boundary lookahead requires the
 * tag name to be followed by whitespace, `/`, or `>`.
 */
async function* scanRecordFragments(
  textChunks: AsyncIterable<string>,
  recordName: 'LEIRecord' | 'RelationshipRecord',
): AsyncGenerator<string> {
  const openRe = new RegExp(`<((?:[A-Za-z][\\w.-]*:)?${recordName})(?=[\\s/>])`);
  let buf = '';
  for await (const chunk of textChunks) {
    buf += chunk;
    for (;;) {
      const open = openRe.exec(buf);
      if (!open) {
        // No open tag yet — retain only a short tail so an open tag split across
        // chunks still matches once the rest arrives.
        if (buf.length > MAX_RETAINED_TAIL) buf = buf.slice(buf.length - MAX_RETAINED_TAIL);
        break;
      }
      const closeTag = `</${open[1]}>`;
      const closeIdx = buf.indexOf(closeTag, open.index + open[0].length);
      if (closeIdx === -1) {
        // Record not fully buffered — drop the pre-record prefix and read more.
        buf = buf.slice(open.index);
        break;
      }
      const end = closeIdx + closeTag.length;
      yield buf.slice(open.index, end);
      buf = buf.slice(end);
    }
  }
}

/** Normalize a decoded LEI-CDF text stream into Level 1 entity records. Shares
 *  {@link parseOneLei} with the buffered {@link parseLeiLevel1} path. */
export async function* streamLeiLevel1FromText(
  textChunks: AsyncIterable<string>,
): AsyncGenerator<NormalizedLeiEntity> {
  for await (const fragment of scanRecordFragments(textChunks, 'LEIRecord')) {
    // The scanner matched the (possibly `lei:`-prefixed) tag on raw text, but
    // parseXml strips the prefix, so the parsed root key is always `LEIRecord`.
    const doc = parseXml<Record<string, unknown>>(fragment);
    const record = doc.LEIRecord as Record<string, unknown> | undefined;
    const entity = record ? parseOneLei(record) : null;
    if (entity) yield entity;
  }
}

/** Normalize a decoded RR-CDF text stream into Level 2 relationship records.
 *  Shares {@link parseOneRelationship} with {@link parseLeiLevel2}. */
export async function* streamLeiLevel2FromText(
  textChunks: AsyncIterable<string>,
): AsyncGenerator<NormalizedLeiRelationship> {
  for await (const fragment of scanRecordFragments(textChunks, 'RelationshipRecord')) {
    // The scanner matched the (possibly `rr:`-prefixed) tag on raw text, but
    // parseXml strips the prefix, so the parsed root key is always `RelationshipRecord`.
    const doc = parseXml<Record<string, unknown>>(fragment);
    const record = doc.RelationshipRecord as Record<string, unknown> | undefined;
    const rel = record ? parseOneRelationship(record) : null;
    if (rel) yield rel;
  }
}

/** Decompress + decode + scan + normalize Level 1 entities from a raw
 *  (ZIP/gzip/plain) byte stream. The network-free seam under {@link streamLeiLevel1}. */
export function streamLeiLevel1FromBytes(
  byteChunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<NormalizedLeiEntity> {
  return streamLeiLevel1FromText(decodeUtf8Stream(decompressGleifByteStream(byteChunks)));
}

/** Decompress + decode + scan + normalize Level 2 relationships from a raw byte
 *  stream. The network-free seam under {@link streamLeiLevel2}. */
export function streamLeiLevel2FromBytes(
  byteChunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<NormalizedLeiRelationship> {
  return streamLeiLevel2FromText(decodeUtf8Stream(decompressGleifByteStream(byteChunks)));
}

/** Stream + decompress + scan + normalize Level 1 entities from a resolved
 *  golden-copy URL, without materializing the whole document. */
export async function* streamLeiLevel1(
  url: string,
  signal: AbortSignal,
): AsyncGenerator<NormalizedLeiEntity> {
  yield* streamLeiLevel1FromBytes(await openGleifByteStream(url, signal));
}

/** Stream + decompress + scan + normalize Level 2 relationships from a resolved
 *  golden-copy URL, without materializing the whole document. */
export async function* streamLeiLevel2(
  url: string,
  signal: AbortSignal,
): AsyncGenerator<NormalizedLeiRelationship> {
  yield* streamLeiLevel2FromBytes(await openGleifByteStream(url, signal));
}
