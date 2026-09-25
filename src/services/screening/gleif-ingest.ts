/**
 * @fileoverview GLEIF ingester. Resolves a publication's golden-copy and delta
 * download URLs from the GLEIF Golden Copy API and streams any of its files —
 * LEI-CDF Level 1 (who-is-who), RR-CDF Level 2 (who-owns-whom), and reporting
 * exceptions (why an entity reports no parent) — onto
 * {@link NormalizedLeiEntity} / {@link LeiRelationshipChange} /
 * {@link ReportingExceptionChange}.
 *
 * Every file goes through one streaming path ({@link openGleifFile}): a ZIP/gzip →
 * UTF-8 → root-close check → record-boundary scan that never holds the decompressed
 * document, so peak memory tracks the ingest batch, not the file. The Level 1
 * golden copy is ~3.4M records / ~890 MB compressed, and even the one-month delta
 * decompresses to ~1.3 GB. The scan lifts the file's header first — its
 * `ContentDate`, and for a delta its `DeltaStart` — so a caller learns the span a
 * file covers before it reads a record, and can close it unread.
 *
 * Level 2 and exception deltas publish only what changed and mark a removal with
 * `<Extension><gleif:Deletion>`; each record is surfaced as-is, marker included,
 * for the caller to apply on its own key in document order.
 *
 * The buffered DOM parse ({@link parseLeiLevel1} / {@link parseLeiLevel2}) is kept
 * as the equivalence oracle the streaming normalizers are tested against.
 * @module services/screening/gleif-ingest
 */

import { Readable, type Transform } from 'node:stream';
import { createGunzip, createInflateRaw } from 'node:zlib';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  createRejections,
  type IngestRejections,
  isUsableName,
} from '@/services/screening/ingest-validation.js';
import { fetchSourceDownload } from '@/services/screening/source-fetch.js';
import {
  type GleifDataset,
  type LeiAlternateName,
  type LeiRelationshipChange,
  type NormalizedLeiEntity,
  type ReportingExceptionChange,
  UNKNOWN_NAME_TYPE,
} from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';
import {
  decodeUtf8Stream,
  type RecordFragment,
  requireCompleteDocument,
  scanRecordFragments,
} from '@/services/screening/xml-stream.js';

/** A delta window GLEIF publishes with every publication. */
export type DeltaWindow = 'IntraDay' | 'LastDay' | 'LastWeek' | 'LastMonth';

/** The delta windows, smallest span first — each restates everything the one before it does. */
export const DELTA_WINDOWS: readonly DeltaWindow[] = [
  'IntraDay',
  'LastDay',
  'LastWeek',
  'LastMonth',
];

/** One publication's download URLs for a dataset. */
export interface GleifPublication {
  /** Every delta window the index lists. */
  deltas: Partial<Record<DeltaWindow, string>>;
  /** The golden copy (full file). */
  full: string;
}

/** The span a GLEIF file states in its header. */
export interface GleifFileHeader {
  /** When the file's content was cut — the state it brings the data to. */
  contentDate: string;
  /** A delta's start: it restates every change after this instant. Absent on a golden copy. */
  deltaStart?: string;
}

/** The record each dataset's files carry. */
export interface GleifRecordOf {
  lei2: NormalizedLeiEntity;
  repex: ReportingExceptionChange;
  rr: LeiRelationshipChange;
}

/** A GLEIF file opened for streaming: its header, read already, then its records. */
export interface GleifFile<T> {
  /**
   * Stop reading and release the download. Safe at any point, and after the
   * records are drained; a file closed before its records are read is never
   * downloaded further.
   */
  close(): Promise<void>;
  header: GleifFileHeader;
  /** The records in document order. Fails if the file ends before its root closes. */
  records: AsyncGenerator<T>;
}

/** The header and record element each dataset's files use (namespace prefix aside). */
const FILE_SHAPES: Record<GleifDataset, { header: string; record: string }> = {
  lei2: { header: 'LEIHeader', record: 'LEIRecord' },
  rr: { header: 'Header', record: 'RelationshipRecord' },
  repex: { header: 'Header', record: 'Exception' },
};

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
 * Resolve a dataset's latest publication from the GLEIF Golden Copy API index:
 * the golden copy and every delta window, from one request. The index at
 * `/api/v2/golden-copies/publishes/{dataset}?format=xml` returns `data[0]` with
 * `full_file.xml.url` and `delta_files.{window}.xml.url` — all `.xml.zip`.
 *
 * @throws ServiceUnavailable when the index names no golden copy.
 */
export async function resolveGleifPublication(
  dataset: GleifDataset,
  signal: AbortSignal,
): Promise<GleifPublication> {
  const base = getServerConfig().gleifGoldenCopyBaseUrl.replace(/\/$/, '');
  const url = `${base}/api/v2/golden-copies/publishes/${dataset}?format=xml`;
  const operation = `gleif:index:${dataset}`;
  const reqCtx = requestContextService.createRequestContext({ operation });
  const index = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url, 60_000, reqCtx, { signal });
      return (await res.json()) as Record<string, unknown>;
    },
    { operation, baseDelayMs: 2000, signal },
  );

  const data = asArray((index.data ?? index) as unknown)[0] as Record<string, unknown> | undefined;
  const fileUrl = (node: unknown): string | undefined => {
    const xml = (node as Record<string, unknown> | undefined)?.xml as
      | Record<string, unknown>
      | undefined;
    return asText(xml?.url) ?? asText(xml?.download_link);
  };
  const full = fileUrl(data?.full_file);
  if (!full) {
    throw serviceUnavailable(
      `The GLEIF Golden Copy index for ${dataset} did not contain a golden-copy download URL.`,
      { url },
    );
  }
  const deltaFiles = data?.delta_files as Record<string, unknown> | undefined;
  const deltas: Partial<Record<DeltaWindow, string>> = {};
  for (const window of DELTA_WINDOWS) {
    const delta = fileUrl(deltaFiles?.[window]);
    if (delta) deltas[window] = delta;
  }
  return { full, deltas };
}

function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * Parse an LEI-CDF Level 1 XML document into normalized entity records. The
 * record root is `<LEIRecords><LEIRecord>`; each carries an `<LEI>`, an
 * `<Entity>` (legal name, other names, addresses, jurisdiction, status), and a
 * `<Registration>` (registration status, last-update, RA). The whole-document
 * oracle the streaming path is tested against.
 */
export function parseLeiLevel1(
  doc: Record<string, unknown>,
  rejections: IngestRejections = createRejections(),
): NormalizedLeiEntity[] {
  const root = (doc.LEIData ?? doc) as Record<string, unknown>;
  const records = asArray((root.LEIRecords as Record<string, unknown> | undefined)?.LEIRecord);
  return records
    .map((raw) => parseOneLei(raw as Record<string, unknown>, rejections))
    .filter(Boolean) as NormalizedLeiEntity[];
}

/**
 * The usable names of one `OtherEntityNames` or `TransliteratedOtherEntityNames`
 * container, each with its `type` attribute — {@link UNKNOWN_NAME_TYPE} when the
 * element carries none.
 */
function typedNames(
  container: unknown,
  element: 'OtherEntityName' | 'TransliteratedOtherEntityName',
): LeiAlternateName[] {
  return asArray((container as Record<string, unknown> | undefined)?.[element]).flatMap((node) => {
    const name = asText((node as Record<string, unknown>)?.['#text'] ?? node);
    if (!isUsableName(name)) return [];
    const type =
      typeof node === 'object' ? asText((node as Record<string, unknown>)['@_type']) : '';
    return [{ name, type: type || UNKNOWN_NAME_TYPE }];
  });
}

/**
 * Normalize one `<LEIRecord>`. Null when the record publishes no LEI or no
 * usable legal name — the mirror key and the searchable name respectively.
 *
 * `status` is `RegistrationStatus` alone. `EntityStatus` is a different
 * vocabulary (ACTIVE / INACTIVE / NULL), so a record without a registration
 * status stores none rather than borrowing it.
 */
function parseOneLei(
  r: Record<string, unknown>,
  rejections: IngestRejections,
): NormalizedLeiEntity | null {
  const lei = asText(r.LEI);
  if (!lei) {
    rejections.missingIdentifier += 1;
    return null;
  }
  const entity = r.Entity as Record<string, unknown> | undefined;
  const registration = r.Registration as Record<string, unknown> | undefined;

  const legalName = asText(
    (entity?.LegalName as Record<string, unknown> | undefined)?.['#text'] ?? entity?.LegalName,
  );
  if (!isUsableName(legalName)) {
    rejections.unusableName += 1;
    return null;
  }
  const other = typedNames(entity?.OtherEntityNames, 'OtherEntityName');
  const alternateNames = [
    ...other,
    ...typedNames(entity?.TransliteratedOtherEntityNames, 'TransliteratedOtherEntityName'),
  ];

  const legalAddr = renderAddress(entity?.LegalAddress as Record<string, unknown> | undefined);
  const hqAddr = renderAddress(entity?.HeadquartersAddress as Record<string, unknown> | undefined);
  const jurisdiction = asText(entity?.LegalJurisdiction);
  const ra = entity?.RegistrationAuthority as Record<string, unknown> | undefined;

  return {
    lei,
    legalName,
    otherNames: other.map((n) => n.name),
    ...(alternateNames.length > 0 ? { alternateNames } : {}),
    ...opt('jurisdiction', jurisdiction),
    ...opt('status', asText(registration?.RegistrationStatus)),
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
 * True when a Level 2 or exception record carries GLEIF's removal marker,
 * `<Extension><gleif:Deletion>` (the prefix is stripped at parse time). An empty
 * `<Extension/>` — every golden-copy record — parses to a string, not an object.
 */
function isDeleted(record: Record<string, unknown>): boolean {
  const extension = record.Extension;
  return typeof extension === 'object' && extension !== null && 'Deletion' in extension;
}

/**
 * Parse an RR-CDF Level 2 XML document into relationship records, removal markers
 * included. The record root is `<RelationshipRecords><RelationshipRecord>`; each
 * carries a `<Relationship>` with a start node (child), end node (parent), and
 * type. The whole-document oracle the streaming path is tested against.
 */
export function parseLeiLevel2(doc: Record<string, unknown>): LeiRelationshipChange[] {
  const root = (doc.RelationshipData ?? doc) as Record<string, unknown>;
  const records = asArray(
    (root.RelationshipRecords as Record<string, unknown> | undefined)?.RelationshipRecord,
  );
  return records
    .map((raw) => parseOneRelationship(raw as Record<string, unknown>))
    .filter(Boolean) as LeiRelationshipChange[];
}

function parseOneRelationship(r: Record<string, unknown>): LeiRelationshipChange | null {
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
    ...(isDeleted(r) ? { deleted: true as const } : {}),
  };
}

/**
 * Normalize one `<Exception>`: the LEI, the category (direct or ultimate parent),
 * and every `<ExceptionReason>`, which repeats. Null without an LEI or a category —
 * the row's key. The filer's free-text `<ExceptionReference>` is not read.
 */
function parseOneException(r: Record<string, unknown>): ReportingExceptionChange | null {
  const lei = asText(r.LEI);
  const category = asText(r.ExceptionCategory);
  if (!lei || !category) return null;
  const reasons = asArray(r.ExceptionReason as unknown)
    .map(asText)
    .filter((reason): reason is string => reason !== undefined);
  return { lei, category, reasons, ...(isDeleted(r) ? { deleted: true as const } : {}) };
}

// ─── Streaming ingest ──────────────────────────────────────────────────────────
//
// No GLEIF file is decompressed into one string. The streaming path decompresses
// incrementally and scans the decoded text for complete top-level fragments,
// feeding each through the SAME parseXml + per-record normalizers the buffered
// oracle uses — so both paths produce identical normalized records.
//
// ASSUMPTION (load-bearing, documented here because the scanner depends on it):
// GLEIF golden-copy and delta files are machine-generated, well-formed XML whose
// payload is a FLAT sequence of repeating <LEIRecord> / <RelationshipRecord> /
// <Exception> siblings under one root, after one header — a record never nests
// within itself and carries no same-named descendant. That flatness is what lets
// a byte-level <TAG>…</TAG> boundary scan stand in for a streaming parser; each
// matched fragment is still handed to the real parseXml.

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
 * ZIP file (single deflate/stored entry), a gzip file, or plain XML.
 *
 * For ZIP the 30-byte local file header is read from the buffered head to locate
 * the entry data and its compression method, then the rest of the stream is
 * inflated with `createInflateRaw`. GLEIF writes streaming ZIP entries
 * (general-purpose bit 3): the local header reports size 0 and a trailing data
 * descriptor + central directory follow the deflate stream. `createInflateRaw`
 * self-terminates at the deflate final block and ignores those trailing bytes, so
 * no compressed size is needed and no explicit stop is required.
 *
 * The rest of the source is delegated with `yield*`, so a consumer that stops early
 * returns the source iterator too — for a download, that cancels the body.
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
    if (!done) yield* { [Symbol.asyncIterator]: () => iter };
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
  // Plain — a rate-limit page arrives as HTML, not XML.
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(head.subarray(0, 64).toString('utf8'))) {
    throw serviceUnavailable('GLEIF returned HTML instead of XML — likely rate-limited.');
  }
  yield* restFrom(0);
}

/** Normalize one scanned record fragment of `dataset`; null for a record the normalizer drops. */
function normalizeFragment<D extends GleifDataset>(
  dataset: D,
  fragment: RecordFragment,
  rejections: IngestRejections,
): GleifRecordOf[D] | null {
  // The scanner matched the (possibly prefixed) tag on raw text; parseXml strips
  // the prefix, so the parsed root key is always the bare record name.
  const record = parseXml<Record<string, unknown>>(fragment.xml)[FILE_SHAPES[dataset].record] as
    | Record<string, unknown>
    | undefined;
  if (!record) return null;
  if (dataset === 'lei2') return parseOneLei(record, rejections) as GleifRecordOf[D] | null;
  if (dataset === 'rr') return parseOneRelationship(record) as GleifRecordOf[D] | null;
  return parseOneException(record) as GleifRecordOf[D] | null;
}

/** Read a file's `ContentDate` and `DeltaStart` from its header fragment. */
function parseHeader(dataset: GleifDataset, fragment: RecordFragment): GleifFileHeader {
  const header = parseXml<Record<string, unknown>>(fragment.xml)[FILE_SHAPES[dataset].header] as
    | Record<string, unknown>
    | undefined;
  const contentDate = asText(header?.ContentDate);
  const deltaStart = asText(header?.DeltaStart);
  for (const [name, value] of [
    ['ContentDate', contentDate],
    ['DeltaStart', deltaStart],
  ] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw serviceUnavailable(`GLEIF ${dataset} file header states an unreadable ${name}.`, {
        [name]: value,
      });
    }
  }
  if (!contentDate) {
    throw serviceUnavailable(`GLEIF ${dataset} file header states no ContentDate.`);
  }
  return { contentDate, ...(deltaStart ? { deltaStart } : {}) };
}

/**
 * Open a GLEIF file from a raw (ZIP/gzip/plain) byte stream: read its header, then
 * hand back its records as a lazy stream. The network-free seam under
 * {@link openGleifFile}.
 *
 * @throws ServiceUnavailable when the file does not open with its header — without
 *   one its span is unknown, so it cannot be applied — or the header is unreadable.
 *   Draining `records` fails if the document ends before its root element closes.
 */
export async function openGleifFileFromBytes<D extends GleifDataset>(
  dataset: D,
  byteChunks: AsyncIterable<Uint8Array>,
  rejections: IngestRejections = createRejections(),
): Promise<GleifFile<GleifRecordOf[D]>> {
  const shape = FILE_SHAPES[dataset];
  const fragments = scanRecordFragments(
    requireCompleteDocument(
      decodeUtf8Stream(decompressGleifByteStream(byteChunks)),
      `GLEIF ${dataset} file`,
    ),
    [shape.header, shape.record],
  );
  const close = async () => {
    await fragments.return(undefined);
  };
  let header: GleifFileHeader;
  try {
    const first = await fragments.next();
    if (first.done || first.value.name !== shape.header) {
      throw serviceUnavailable(
        `GLEIF ${dataset} file did not open with its <${shape.header}> header, so the span it covers is unknown.`,
      );
    }
    header = parseHeader(dataset, first.value);
  } catch (err) {
    await close();
    throw err;
  }
  async function* records(): AsyncGenerator<GleifRecordOf[D]> {
    for await (const fragment of fragments) {
      const record = normalizeFragment(dataset, fragment, rejections);
      if (record) yield record;
    }
  }
  return { header, records: records(), close };
}

/**
 * Open a GLEIF file by URL for streaming. The download is bounded by `signal`;
 * `close()` also aborts it, so a file read only for its header stops downloading
 * there — the refresh reads each delta window's header to pick one.
 */
export async function openGleifFile<D extends GleifDataset>(
  dataset: D,
  url: string,
  signal: AbortSignal,
  rejections: IngestRejections = createRejections(),
): Promise<GleifFile<GleifRecordOf[D]>> {
  const stop = new AbortController();
  const res = await fetchSourceDownload(url, {
    source: `GLEIF ${dataset} file`,
    signal: AbortSignal.any([signal, stop.signal]),
    context: requestContextService.createRequestContext({ operation: `gleif:stream:${dataset}` }),
  });
  if (!res.body) throw serviceUnavailable(`GLEIF ${dataset} download returned an empty body.`);
  const file = await openGleifFileFromBytes(
    dataset,
    res.body as AsyncIterable<Uint8Array>,
    rejections,
  ).catch((err: unknown) => {
    stop.abort();
    throw err;
  });
  return {
    ...file,
    async close() {
      stop.abort();
      await file.close().catch(() => undefined);
    },
  };
}

/** Normalize a decoded LEI-CDF text stream into Level 1 entity records (no header read).
 *  Shares {@link parseOneLei} with the buffered {@link parseLeiLevel1} path. */
export async function* streamLeiLevel1FromText(
  textChunks: AsyncIterable<string>,
  rejections: IngestRejections = createRejections(),
): AsyncGenerator<NormalizedLeiEntity> {
  for await (const fragment of scanRecordFragments(textChunks, ['LEIRecord'])) {
    const entity = normalizeFragment('lei2', fragment, rejections);
    if (entity) yield entity;
  }
}

/** Normalize a decoded RR-CDF text stream into Level 2 records (no header read).
 *  Shares {@link parseOneRelationship} with {@link parseLeiLevel2}. */
export async function* streamLeiLevel2FromText(
  textChunks: AsyncIterable<string>,
): AsyncGenerator<LeiRelationshipChange> {
  for await (const fragment of scanRecordFragments(textChunks, ['RelationshipRecord'])) {
    const rel = normalizeFragment('rr', fragment, createRejections());
    if (rel) yield rel;
  }
}

/** Decompress + decode + scan + normalize Level 1 entities from a raw
 *  (ZIP/gzip/plain) byte stream, header unread. */
export function streamLeiLevel1FromBytes(
  byteChunks: AsyncIterable<Uint8Array>,
  rejections: IngestRejections = createRejections(),
): AsyncGenerator<NormalizedLeiEntity> {
  return streamLeiLevel1FromText(
    decodeUtf8Stream(decompressGleifByteStream(byteChunks)),
    rejections,
  );
}

/** Decompress + decode + scan + normalize Level 2 records from a raw byte stream, header unread. */
export function streamLeiLevel2FromBytes(
  byteChunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<LeiRelationshipChange> {
  return streamLeiLevel2FromText(decodeUtf8Stream(decompressGleifByteStream(byteChunks)));
}
