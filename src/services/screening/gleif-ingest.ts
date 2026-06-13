/**
 * @fileoverview GLEIF ingester — the heaviest leg. Resolves the latest
 * golden-copy (full) or delta download URLs from the GLEIF Golden Copy API,
 * streams the ZIP-compressed file, and normalizes LEI-CDF Level 1 (who-is-who)
 * and RR-CDF Level 2 (who-owns-whom) records onto {@link NormalizedLeiEntity} /
 * {@link NormalizedLeiRelationship}. Level 1 init is ~3.3M records / ~490 MB
 * compressed (May 2026) — it runs out-of-band via `mirror:init`, never on the
 * request path; refresh uses the 8-hour deltas keyed on a checkpoint.
 *
 * The normalization functions are the testable core (exercised by the synthetic
 * fixture). The download/decompress wiring is documented and resilient; the real
 * corpus loads out-of-band.
 * @module services/screening/gleif-ingest
 */

import { gunzipSync, inflateRawSync } from 'node:zlib';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { NormalizedLeiEntity, NormalizedLeiRelationship } from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';

const FETCH_TIMEOUT_MS = 600_000;

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
 * Copy API exposes a JSON index of the latest publications per file type and
 * delta window; we read it and return the matching `.xml.gz` download link.
 *
 * @param kind Which dataset + window.
 * @param delta Delta window when `kind` is a delta variant (e.g. `'LastDay'`, `'IntraDay'`).
 */
export async function resolveGleifFileUrl(
  kind: GleifFileKind,
  signal: AbortSignal,
  delta: 'IntraDay' | 'LastDay' | 'WeeklyFullFiles' = 'LastDay',
): Promise<string> {
  const base = getServerConfig().gleifGoldenCopyBaseUrl.replace(/\/$/, '');
  // GLEIF Golden Copy API publication index. The exact query shape:
  //   /api/v2/golden-copies/publishes/lei2?format=xml  (full)
  //   /api/v2/golden-copies/publishes/lei2/{window}     (delta)
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

  // The publication record carries a `data[].full_file.xml.url` (or delta_files).
  const data = asArray((index.data ?? index) as unknown)[0] as Record<string, unknown> | undefined;
  const fileNode = (isDelta ? data?.delta_files : data?.full_file) as
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
 * NOTE (memory): this buffers and decompresses the whole file in memory. The
 * Level 1 golden copy is ~3.3M records / ~900 MB compressed; decompressing and
 * DOM-parsing it whole needs multiple GB of heap. A production `mirror:init`
 * against the full L1 file requires a streaming ZIP → SAX pipeline; until then,
 * real L1 ingest is bounded by available memory. Deltas and L2 are far smaller
 * and fit comfortably.
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
  const root = (doc.LEIData ?? doc['lei:LEIData'] ?? doc) as Record<string, unknown>;
  const records = asArray(
    ((root.LEIRecords ?? root['lei:LEIRecords']) as Record<string, unknown> | undefined)
      ?.LEIRecord ?? (root.LEIRecords as Record<string, unknown> | undefined)?.['lei:LEIRecord'],
  );
  return records
    .map((raw) => parseOneLei(raw as Record<string, unknown>))
    .filter(Boolean) as NormalizedLeiEntity[];
}

function parseOneLei(r: Record<string, unknown>): NormalizedLeiEntity | null {
  const lei = asText(r.LEI ?? r['lei:LEI']);
  if (!lei) return null;
  const entity = (r.Entity ?? r['lei:Entity']) as Record<string, unknown> | undefined;
  const registration = (r.Registration ?? r['lei:Registration']) as
    | Record<string, unknown>
    | undefined;

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
  const root = (doc.RelationshipData ?? doc['rr:RelationshipData'] ?? doc) as Record<
    string,
    unknown
  >;
  const records = asArray(
    (
      (root.RelationshipRecords ?? root['rr:RelationshipRecords']) as
        | Record<string, unknown>
        | undefined
    )?.RelationshipRecord ??
      (root.RelationshipRecords as Record<string, unknown> | undefined)?.['rr:RelationshipRecord'],
  );
  return records
    .map((raw) => parseOneRelationship(raw as Record<string, unknown>))
    .filter(Boolean) as NormalizedLeiRelationship[];
}

function parseOneRelationship(r: Record<string, unknown>): NormalizedLeiRelationship | null {
  const rel = (r.Relationship ?? r['rr:Relationship']) as Record<string, unknown> | undefined;
  if (!rel) return null;
  const startNode = (rel.StartNode ?? rel['rr:StartNode']) as Record<string, unknown> | undefined;
  const endNode = (rel.EndNode ?? rel['rr:EndNode']) as Record<string, unknown> | undefined;
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
