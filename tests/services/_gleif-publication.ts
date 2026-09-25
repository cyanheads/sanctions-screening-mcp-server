/**
 * @fileoverview Test helpers for the GLEIF golden-copy and delta files: builders
 * for LEI-CDF (Level 1), RR-CDF (Level 2), and reporting-exception documents in
 * the namespace-prefixed shape GLEIF publishes, a timeline builder that cuts the
 * four delta windows out of one ordered change log the way GLEIF does, and a local
 * HTTP stand-in for `goldencopy.gleif.org` serving the publication index and files.
 * @module tests/services/_gleif-publication
 */

import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The header dates a GLEIF file states. Golden copies carry no `deltaStart`. */
export interface FileHeader {
  contentDate: string;
  deltaStart?: string;
}

/** A name GLEIF publishes beside the legal name, with its `type` attribute. */
export interface TypedName {
  name: string;
  type: string;
}

export interface EntityRecord {
  /** `LegalJurisdiction`; `GB` when omitted. */
  jurisdiction?: string;
  legalName: string;
  lei: string;
  /** `OtherEntityNames`, in document order. */
  otherNames?: readonly TypedName[];
  /** `RegistrationStatus`; `ISSUED` when omitted. */
  status?: string;
  /** `TransliteratedOtherEntityNames`, in document order. */
  transliteratedNames?: readonly TypedName[];
}

const nameList = (container: string, element: string, names?: readonly TypedName[]) =>
  names?.length
    ? `<lei:${container}>${names
        .map((n) => `<lei:${element} xml:lang="en" type="${n.type}">${n.name}</lei:${element}>`)
        .join('')}</lei:${container}>`
    : '';

export interface RelationshipRecord {
  childLei: string;
  deleted?: boolean;
  parentLei: string;
  relationshipType: string;
}

export interface ExceptionRecord {
  category: string;
  deleted?: boolean;
  lei: string;
  reasons: string[];
}

export type Dataset = 'lei2' | 'rr' | 'repex';
export type Window = 'IntraDay' | 'LastDay' | 'LastWeek' | 'LastMonth';
export const WINDOWS: readonly Window[] = ['IntraDay', 'LastDay', 'LastWeek', 'LastMonth'];

const deletion = (deleted?: boolean) =>
  deleted
    ? '<gleif:Deletion><gleif:DeletedAt>2026-09-24T18:50:35Z</gleif:DeletedAt></gleif:Deletion>'
    : '';

const headerBody = (prefix: string, h: FileHeader, count: number) =>
  `<${prefix}:ContentDate>${h.contentDate}</${prefix}:ContentDate>` +
  `<${prefix}:FileContent>${h.deltaStart ? 'GLEIF_DELTA_PUBLISHED' : 'GLEIF_FULL_PUBLISHED'}</${prefix}:FileContent>` +
  (h.deltaStart ? `<${prefix}:DeltaStart>${h.deltaStart}</${prefix}:DeltaStart>` : '') +
  `<${prefix}:RecordCount>${count}</${prefix}:RecordCount>`;

/** An LEI-CDF (Level 1) document. */
export function leiFile(header: FileHeader, records: readonly EntityRecord[]): string {
  const body = records
    .map(
      (r) =>
        `<lei:LEIRecord xmlns:lei="http://www.gleif.org/data/schema/leidata/2016" xmlns:gleif="http://www.gleif.org/data/schema/golden-copy/extensions/1.0">
   <lei:LEI>${r.lei}</lei:LEI>
   <lei:Entity><lei:LegalName xml:lang="en">${r.legalName}</lei:LegalName>${nameList('OtherEntityNames', 'OtherEntityName', r.otherNames)}${nameList('TransliteratedOtherEntityNames', 'TransliteratedOtherEntityName', r.transliteratedNames)}<lei:LegalJurisdiction>${r.jurisdiction ?? 'GB'}</lei:LegalJurisdiction></lei:Entity>
   <lei:Registration><lei:RegistrationStatus>${r.status ?? 'ISSUED'}</lei:RegistrationStatus></lei:Registration>
   <lei:Extension><gleif:conformity><gleif:conformityflag>CONFORMING</gleif:conformityflag></gleif:conformity></lei:Extension>
</lei:LEIRecord>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><lei:LEIData xmlns:lei="http://www.gleif.org/data/schema/leidata/2016">
  <lei:LEIHeader>${headerBody('lei', header, records.length)}</lei:LEIHeader>
  <lei:LEIRecords>
${body}
  </lei:LEIRecords>
</lei:LEIData>
`;
}

/** An RR-CDF (Level 2) document; a `deleted` record carries the deletion marker. */
export function rrFile(header: FileHeader, records: readonly RelationshipRecord[]): string {
  const body = records
    .map(
      (r) =>
        `<rr:RelationshipRecord xmlns:rr="http://www.gleif.org/data/schema/rr/2016" xmlns:gleif="http://www.gleif.org/data/schema/golden-copy/extensions/1.0" xmlns:gleif_header="http://www.gleif.org/schema/golden-copy/header-extension/1.1">
   <rr:Relationship>
      <rr:StartNode><rr:NodeID>${r.childLei}</rr:NodeID><rr:NodeIDType>LEI</rr:NodeIDType></rr:StartNode>
      <rr:EndNode><rr:NodeID>${r.parentLei}</rr:NodeID><rr:NodeIDType>LEI</rr:NodeIDType></rr:EndNode>
      <rr:RelationshipType>${r.relationshipType}</rr:RelationshipType>
      <rr:RelationshipStatus>ACTIVE</rr:RelationshipStatus>
   </rr:Relationship>
   <rr:Registration><rr:RegistrationStatus>PUBLISHED</rr:RegistrationStatus></rr:Registration>
   <rr:Extension>${deletion(r.deleted)}</rr:Extension>
</rr:RelationshipRecord>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><rr:RelationshipData xmlns:rr="http://www.gleif.org/data/schema/rr/2016" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <rr:Header>${headerBody('rr', header, records.length)}</rr:Header>
  <rr:RelationshipRecords>
${body}
  </rr:RelationshipRecords>
</rr:RelationshipData>
`;
}

/** A reporting-exceptions document; a `deleted` record carries the deletion marker. */
export function repexFile(header: FileHeader, records: readonly ExceptionRecord[]): string {
  const body = records
    .map(
      (r) =>
        `<repex:Exception xmlns:repex="http://www.gleif.org/data/schema/repex/2016" xmlns:gleif="http://www.gleif.org/data/schema/golden-copy/extensions/1.0">
   <repex:LEI>${r.lei}</repex:LEI>
   <repex:ExceptionCategory>${r.category}</repex:ExceptionCategory>
${r.reasons.map((reason) => `   <repex:ExceptionReason>${reason}</repex:ExceptionReason>`).join('\n')}
   <repex:Extension>${deletion(r.deleted)}</repex:Extension>
</repex:Exception>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><repex:ReportingExceptionData xmlns:repex="http://www.gleif.org/data/schema/repex/2016">

  <repex:Header>${headerBody('repex', header, records.length)}</repex:Header>
  <repex:ReportingExceptions>
${body}
  </repex:ReportingExceptions>
</repex:ReportingExceptionData>
`;
}

/** One upstream change, stamped with when GLEIF recorded it. */
export type Change =
  | { at: string; dataset: 'lei2'; record: EntityRecord }
  | { at: string; dataset: 'rr'; record: RelationshipRecord }
  | { at: string; dataset: 'repex'; record: ExceptionRecord };

/** The four delta windows' `DeltaStart`, each ending at the publication's `ContentDate`. */
export interface WindowStarts {
  IntraDay: string;
  LastDay: string;
  LastMonth: string;
  LastWeek: string;
}

/**
 * The files of one publication, one per dataset and window: each window holds, in
 * recorded order, every change recorded after its `DeltaStart` — so a larger
 * window restates everything a smaller one does, as GLEIF's do.
 */
export function deltaFiles(
  changes: readonly Change[],
  contentDate: string,
  starts: WindowStarts,
): Record<Dataset, Record<Window, string>> {
  const cut = (dataset: Dataset, window: Window) => {
    const header = { contentDate, deltaStart: starts[window] };
    const since = Date.parse(starts[window]);
    const inWindow = changes.filter((c) => c.dataset === dataset && Date.parse(c.at) > since);
    if (dataset === 'lei2')
      return leiFile(
        header,
        inWindow.map((c) => c.record as EntityRecord),
      );
    if (dataset === 'rr')
      return rrFile(
        header,
        inWindow.map((c) => c.record as RelationshipRecord),
      );
    return repexFile(
      header,
      inWindow.map((c) => c.record as ExceptionRecord),
    );
  };
  const all = (dataset: Dataset) =>
    Object.fromEntries(WINDOWS.map((w) => [w, cut(dataset, w)])) as Record<Window, string>;
  return { lei2: all('lei2'), rr: all('rr'), repex: all('repex') };
}

/** What the stand-in serves for one dataset: its golden copy and its delta windows. */
export interface DatasetFiles {
  deltas: Partial<Record<Window, string>>;
  full: string;
}

/** A body the stand-in serves: a whole document, or a handler that writes one. */
export type Body = string | ((res: ServerResponse) => void);

/** A running stand-in for `goldencopy.gleif.org`. */
export interface GleifStandIn {
  base: string;
  close(): Promise<void>;
  /** Every request path, in arrival order (query strings stripped). */
  requested: string[];
  /** Replace what the stand-in serves. */
  serve(files: Partial<Record<Dataset, DatasetFiles>>, overrides?: Record<string, Body>): void;
}

/**
 * Start a local stand-in for the GLEIF Golden Copy API: the publication index at
 * `/api/v2/golden-copies/publishes/{dataset}` (any query answers with the whole
 * latest publication, as GLEIF's does) and each file at `/files/{dataset}-{window}.xml`.
 * An `overrides` entry replaces a file's body — a handler can stall or truncate it.
 */
export async function startGleifStandIn(): Promise<GleifStandIn> {
  let files: Partial<Record<Dataset, DatasetFiles>> = {};
  let overrides: Record<string, Body> = {};
  const requested: string[] = [];
  let base = '';
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    requested.push(path);
    const index = path.match(/^\/api\/v2\/golden-copies\/publishes\/(lei2|rr|repex)$/);
    if (index) {
      const dataset = index[1] as Dataset;
      const entry = files[dataset];
      if (!entry) {
        res.writeHead(404).end();
        return;
      }
      const link = (name: string) => ({ xml: { url: `${base}/files/${dataset}-${name}.xml` } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            {
              type: dataset,
              full_file: link('full'),
              delta_files: Object.fromEntries(
                Object.keys(entry.deltas).map((window) => [window, link(window)]),
              ),
            },
          ],
        }),
      );
      return;
    }
    const file = path.match(/^\/files\/(lei2|rr|repex)-(\w+)\.xml$/);
    const override = overrides[path];
    if (override) {
      if (typeof override === 'string') {
        res.writeHead(200, { 'content-type': 'application/xml' }).end(override);
      } else {
        override(res);
      }
      return;
    }
    const entry = file ? files[file[1] as Dataset] : undefined;
    const name = file?.[2];
    const body =
      entry && name
        ? name === 'full'
          ? entry.full
          : (entry.deltas as Record<string, string | undefined>)[name]
        : undefined;
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    requested,
    serve(next, nextOverrides = {}) {
      files = next;
      overrides = nextOverrides;
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
