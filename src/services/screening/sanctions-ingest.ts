/**
 * @fileoverview Sanctions ingesters — one per source (OFAC SDN, OFAC
 * Consolidated, EU FSF, UK Sanctions List, UN SC Consolidated). Each streams its
 * source file, lifts out one record element at a time, and maps it onto the
 * common {@link NormalizedDesignation} schema. The {@link createSanctionsSync}
 * factory wires them into the MirrorService `sync` generator: each refresh
 * re-harvests every source in full (the combined corpus is tens of thousands of
 * rows — no delta logic needed), yielding bounded pages as records arrive, then
 * removes each source's stored designations its complete document no longer
 * published.
 *
 * **Why streaming.** `SDN_ADVANCED.XML` is ~120 MiB of the ~172 MiB sanctions
 * corpus. Buffering a document and DOM-parsing it held the XML string, the
 * parsed tree, the normalized array, and the row array at once, peaking past
 * 2 GiB and OOM-killing `mirror:init` before GLEIF started (#13). Each source is
 * now scanned for complete record fragments (`xml-stream`) and each fragment
 * parsed on its own, so peak memory tracks the largest single record and one
 * page, not the document.
 *
 * **The OFAC deferred join.** OFAC advanced is not a flat repeating document:
 * `<ReferenceValueSets>` opens it, but `<SanctionsEntries>` — which supplies
 * `program` and `designationDate` — is published *after* every
 * `<DistinctParty>`. A single forward pass cannot attach those fields inline.
 * Both columns are nullable, so parties stream out as they are read and the
 * programme fields are collected behind them into {@link DeferredDesignationFields},
 * applied by the sync as an UPDATE once the source's rows have landed. The other
 * direction is forward: a party's addresses, nationalities, and identity
 * documents point back into `<Locations>` and `<IDRegDocuments>`, which the
 * schema publishes before the parties, so those blocks fold into a small index of
 * rendered strings as they stream past.
 *
 * The XML shapes differ wildly across sources; each parser is defensive about
 * sparsity and arrays-of-one (fast-xml-parser collapses single children to
 * objects), and preserves absence rather than fabricating fields. A record whose
 * source published no stable entry id, or no usable name, is dropped and counted
 * — see `ingest-validation` for why an identifier is never minted.
 * @module services/screening/sanctions-ingest
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  createRejections,
  type IngestRejections,
  isUsableName,
} from '@/services/screening/ingest-validation.js';
import { fold } from '@/services/screening/text-matching.js';
import type {
  AddressRecord,
  DobRecord,
  EntityType,
  IdentifierRecord,
  NameRecord,
  NormalizedDesignation,
  SourceCode,
} from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';
import {
  decodeUtf8Stream,
  requireCompleteDocument,
  scanRecordFragments,
} from '@/services/screening/xml-stream.js';

/**
 * Columns a source can only publish after the records they belong to — keyed by
 * `sourceEntryId`. Applied as an UPDATE once the source's rows are in the
 * mirror; see the OFAC deferred join in this module's overview. Empty for every
 * source whose document is a flat repeating sequence.
 */
export type DeferredDesignationFields = ReadonlyMap<
  string,
  { designationDate?: string; program?: string }
>;

/** What one source's harvest accepted and dropped. */
export interface SourceHarvestReport {
  /** Normalized designations the harvest emitted. */
  accepted: number;
  /** Records dropped during the harvest, by reason. */
  rejected: IngestRejections;
  source: SourceCode;
}

/** A source ingester: streams normalized designations for one list. */
export interface SanctionsIngester {
  /**
   * Columns discovered after the record stream drained — filled only by OFAC
   * advanced, and only meaningful once {@link harvest} has completed.
   */
  deferredFields(): DeferredDesignationFields;
  /** Stream the full list, one normalized designation at a time. */
  harvest(signal: AbortSignal): AsyncGenerator<NormalizedDesignation>;
  /** What the last {@link harvest} accepted and dropped. */
  report(): SourceHarvestReport;
  source: SourceCode;
  /** Source file URL (for provenance). */
  url(): string;
}

/** Browser-style UA — the UN SC domain returns 404 to bare requests. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Bounds only time-to-response-headers. `fetchWithTimeout` clears its own timer
 * once the `Response` is returned; the body is then drained lazily by the record
 * scanner, bounded by the caller's `signal` (the lifecycle script's long-run
 * signal). A 120 MiB document legitimately takes longer to transfer than any
 * fixed fetch timeout, so this guards a stalled connection, not the transfer.
 */
const HEADERS_TIMEOUT_MS = 120_000;

/** Designations accumulated per yielded sync page — bounds one page's memory. */
const SYNC_PAGE_SIZE = 2500;

/** Head characters the HTML rate-limit guard classifies a response body on. */
const HTML_GUARD_CHARS = 64;

/** Coerce fast-xml-parser's "single child → object, many → array" into an array. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The body of a parsed one-record fragment. An element with no children parses
 * to an empty string rather than an object; normalizing that as an empty record
 * keeps it a *counted* rejection instead of a silent skip.
 */
function recordBody(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  const body = doc[name];
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

/** Coerce a scalar XML node (string/number/object-with-#text) to a trimmed string. */
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
 * non-empty, else `{}`. Keeps the normalized objects honest under
 * `exactOptionalPropertyTypes` (absent rather than `undefined`) without a
 * double `asText` call or a non-null assertion.
 */
function opt<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value ? { [key]: value } : {};
}

// ─── Detail groups ──────────────────────────────────────────────────────────────
//
// Shared by every normalizer's identifiers, addresses, dates and places of birth,
// and nationalities. Absence stays absence: a component that carries no letter or
// digit, or that is a placeholder, is not published; an entry with no published
// component is skipped; and nothing is inferred from another group.

/**
 * Whole values the sources write where they have nothing to publish: the EU's
 * `UNKNOWN` country and the UN's `na`. Matched case-insensitively against the
 * whole component only. Names never pass through here, so a name part such as the
 * surname `Na` is untouched; and no detail read takes a country *code* (every
 * country is read by name), so Namibia's ISO code `NA` never reaches this test.
 */
const PLACEHOLDER_VALUES = new Set(['na', 'unknown']);

/**
 * One published detail component: text carrying a letter or digit that is not a
 * placeholder, so a lone `-`, `UNKNOWN`, or `na` reads as absent.
 */
function componentText(value: unknown): string | undefined {
  const text = asText(value);
  if (!text || PLACEHOLDER_VALUES.has(text.toLowerCase())) return;
  return /[\p{L}\p{N}]/u.test(text) ? text : undefined;
}

/**
 * The elements at `path` below `node` (one element, or an array of them),
 * flattened into one array. Any step may be a single element, a repeated one, or
 * absent, as fast-xml-parser shapes it.
 */
function elementsAt(node: unknown, ...path: string[]): unknown[] {
  let current = asArray(node);
  for (const key of path) {
    current = current.flatMap((n) =>
      typeof n === 'object' && n !== null ? asArray((n as Record<string, unknown>)[key]) : [],
    );
  }
  return current;
}

/** The published text of every element at `path` below `node`. */
function textsAt(node: unknown, ...path: string[]): string[] {
  return elementsAt(node, ...path)
    .map(componentText)
    .filter((x): x is string => Boolean(x));
}

/** Collapse exact duplicates within one group, keeping first-published order. */
function dedupe<T>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Published components joined with `, `, most specific first; undefined when none. */
function joinParts(parts: readonly (string | undefined)[]): string | undefined {
  const published = parts.filter((p): p is string => Boolean(p));
  return published.length ? published.join(', ') : undefined;
}

/**
 * Render one address: its components most specific first, the country last, and
 * `country` set when published. Undefined when the source published neither.
 */
function toAddress(
  parts: readonly (string | undefined)[],
  country: string | undefined,
): AddressRecord | undefined {
  const full = joinParts([...parts, country]);
  return full ? { full, ...opt('country', country) } : undefined;
}

/**
 * Dates and places of birth a source publishes as two separate lists. The source
 * links a date to a place only when it publishes exactly one of each; any other
 * shape emits every date and every place as its own entry, since pairing them by
 * position would assert a link the source never made.
 */
function birthRecords(dates: readonly string[], places: readonly string[]): DobRecord[] {
  const uniqueDates = dedupe(dates);
  const uniquePlaces = dedupe(places);
  const [date] = uniqueDates;
  const [place] = uniquePlaces;
  if (date && place && uniqueDates.length === 1 && uniquePlaces.length === 1) {
    return [{ date, place }];
  }
  return [...uniqueDates.map((d) => ({ date: d })), ...uniquePlaces.map((p) => ({ place: p }))];
}

/**
 * Open a source document as a stream of decoded text chunks: browser UA, retry
 * around the request, and the HTML-error-page guard applied to the head of the
 * body rather than the whole document. The retry covers establishing the
 * response; a mid-transfer failure surfaces on the consuming iteration, as it
 * does on the GLEIF streaming path — and so does a document that ends before its
 * root element closes ({@link requireCompleteDocument}), so a harvest that
 * returns normally has read its whole document.
 */
function openSourceTextStream(
  url: string,
  signal: AbortSignal,
  source: string,
): Promise<AsyncIterable<string>> {
  const reqCtx = requestContextService.createRequestContext({ operation: `harvest:${source}` });
  return withRetry(
    async () => {
      const response = await fetchWithTimeout(url, HEADERS_TIMEOUT_MS, reqCtx, {
        signal,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/xml, text/xml, */*' },
        redirect: 'follow',
      });
      if (!response.body) {
        throw serviceUnavailable(`${source} returned an empty body.`);
      }
      // The HTML guard reads only enough of the head to classify the document,
      // and does so INSIDE the retry so a rate-limit page is retried rather than
      // surfacing later on the consuming iteration.
      const iterator = decodeUtf8Stream(response.body as AsyncIterable<Uint8Array>)[
        Symbol.asyncIterator
      ]();
      let head = '';
      let drained = false;
      while (head.length < HTML_GUARD_CHARS && !drained) {
        const next = await iterator.next();
        if (next.done) drained = true;
        else head += next.value;
      }
      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(head)) {
        throw serviceUnavailable(`${source} returned HTML instead of XML — likely rate-limited.`);
      }
      return requireCompleteDocument(replayTextStream(head, iterator, drained), source);
    },
    { operation: `harvest:${source}`, baseDelayMs: 2000, signal },
  );
}

/** Re-emit the head consumed by the HTML guard, then the rest of the stream. */
async function* replayTextStream(
  head: string,
  iterator: AsyncIterator<string>,
  drained: boolean,
): AsyncGenerator<string> {
  if (head) yield head;
  while (!drained) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}

// ─── Streaming spine ───────────────────────────────────────────────────────────

/**
 * Accounting a streaming harvest fills in as it runs — the two things a record
 * stream cannot express as yielded records: what it dropped, and the columns the
 * source published after the records they belong to.
 */
export interface HarvestState {
  /** Columns to apply once the source's rows have landed. Only OFAC fills this. */
  deferredFields: Map<string, { designationDate?: string; program?: string }>;
  rejections: IngestRejections;
}

/** Fresh, zeroed harvest accounting. */
export function createHarvestState(): HarvestState {
  return { deferredFields: new Map(), rejections: createRejections() };
}

/**
 * Scan a text stream for the named record elements and normalize each in turn —
 * the spine of every source whose payload is a flat repeating sequence (EU
 * `<sanctionEntity>`, UK `<Designation>`, UN `<INDIVIDUAL>`/`<ENTITY>`). OFAC
 * needs {@link streamOfacFromText} instead, for its reference-set head and its
 * deferred programme tail.
 */
async function* streamFlatRecords(
  textChunks: AsyncIterable<string>,
  tags: readonly string[],
  normalize: (record: Record<string, unknown>, tag: string) => NormalizedDesignation | null,
): AsyncGenerator<NormalizedDesignation> {
  for await (const fragment of scanRecordFragments(textChunks, tags)) {
    const doc = parseXml<Record<string, unknown>>(fragment.xml);
    const record = normalize(recordBody(doc, fragment.name), fragment.name);
    if (record) yield record;
  }
}

/** How to reach one source and normalize its stream. */
interface StreamingSourceSpec {
  source: SourceCode;
  stream(
    textChunks: AsyncIterable<string>,
    state: HarvestState,
  ): AsyncGenerator<NormalizedDesignation>;
  url(): string;
}

/**
 * Wire a source's normalizing stream to the network: open the document, feed the
 * decoded text through, and keep the run's accounting for {@link
 * SanctionsIngester.report} and {@link SanctionsIngester.deferredFields}. Each
 * harvest resets that accounting, so a re-harvest reports its own run.
 */
function buildStreamingIngester(spec: StreamingSourceSpec): SanctionsIngester {
  let state = createHarvestState();
  let accepted = 0;

  return {
    source: spec.source,
    url: spec.url,
    deferredFields: () => state.deferredFields,
    report: () => ({ source: spec.source, accepted, rejected: state.rejections }),
    async *harvest(signal) {
      state = createHarvestState();
      accepted = 0;
      const text = await openSourceTextStream(spec.url(), signal, spec.source);
      for await (const designation of spec.stream(text, state)) {
        accepted += 1;
        yield designation;
      }
    },
  };
}

// ─── OFAC (SDN + Consolidated, advanced UN 1267/1988 schema) ────────────────────

/**
 * Record elements the OFAC scanner lifts out, covering both published schemas.
 * `<ReferenceValueSets>` (the head of an advanced document) resolves the numeric
 * type ids every party carries; `<Location>` and `<IDRegDocument>` (the two
 * blocks between the head and the parties) are what a party's addresses,
 * nationalities, and identifiers point at; `<SanctionsEntry>` (the tail)
 * supplies the deferred programme fields.
 */
const OFAC_RECORD_TAGS = [
  'ReferenceValueSets',
  'Location',
  'IDRegDocument',
  'DistinctParty',
  'SanctionsEntry',
  'sdnEntry',
] as const;

/**
 * Normalize a decoded OFAC text stream, either published schema. The advanced
 * schema (`SDN_ADVANCED.XML` / `CONS_ADVANCED.XML`) is the configured default;
 * the standard `<sdnEntry>` shape rides the same scan, so a deployment that
 * overrides the URL to a standard-schema file streams too.
 *
 * Document order does the sequencing, and the schema fixes it: the root
 * `xsd:sequence` puts `<ReferenceValueSets>`, `<Locations>`, and
 * `<IDRegDocuments>` before `<DistinctParties>`, and `<SanctionsEntries>` after.
 * So the reference sets resolve every type id, then each location and document
 * folds into a cross-reference index as rendered strings, then each party
 * normalizes against both while its programme fields accumulate in
 * `state.deferredFields` for the sync to apply afterwards. The index lives only
 * for this call; it grows with the two cross-referenced blocks, not with the
 * party count.
 *
 * Shares {@link parseOfacAdvanced} / {@link parseOfacStandard} and the fold
 * helpers with the buffered {@link parseOfac}, so both paths normalize a record
 * identically.
 */
export async function* streamOfacFromText(
  textChunks: AsyncIterable<string>,
  source: SourceCode,
  state: HarvestState,
): AsyncGenerator<NormalizedDesignation> {
  let refs = emptyOfacReferenceSets();
  const xrefs = emptyOfacCrossReferences();
  for await (const fragment of scanRecordFragments(textChunks, OFAC_RECORD_TAGS)) {
    const body = recordBody(parseXml<Record<string, unknown>>(fragment.xml), fragment.name);
    switch (fragment.name) {
      case 'ReferenceValueSets':
        refs = buildOfacReferenceSets(body);
        continue;
      case 'Location':
        foldOfacLocation(body, refs, xrefs);
        continue;
      case 'IDRegDocument':
        foldOfacIdRegDocument(body, refs, xrefs);
        continue;
      case 'SanctionsEntry':
        foldOfacSanctionsEntry(body, state.deferredFields);
        continue;
    }
    const record =
      fragment.name === 'sdnEntry'
        ? parseOfacStandard(body, source, state.rejections)
        : parseOfacAdvanced(body, source, refs, xrefs, EMPTY_PROGRAM_INDEX, state.rejections);
    if (record) yield record;
  }
}

function buildOfacIngester(
  source: 'ofac_sdn' | 'ofac_consolidated',
  urlGetter: () => string,
): SanctionsIngester {
  return buildStreamingIngester({
    source,
    url: urlGetter,
    stream: (textChunks, state) => streamOfacFromText(textChunks, source, state),
  });
}

/**
 * Parse a whole OFAC document. The buffered counterpart of
 * {@link buildOfacIngester} — the equivalence oracle the streaming path is
 * tested against, and the entry point for fixtures and captured samples.
 */
export function parseOfac(
  doc: Record<string, unknown>,
  source: SourceCode,
  rejections: IngestRejections = createRejections(),
): NormalizedDesignation[] {
  // Standard schema: <sdnList><sdnEntry>. Advanced: <Sanctions><DistinctParties>.
  const sdnList = (doc.sdnList ?? doc.SDNList) as Record<string, unknown> | undefined;
  if (sdnList) {
    return asArray(sdnList.sdnEntry as unknown)
      .map((e) => parseOfacStandard(e as Record<string, unknown>, source, rejections))
      .filter(Boolean) as NormalizedDesignation[];
  }
  // Advanced schema (the configured default — SDN_ADVANCED.XML / CONS_ADVANCED.XML).
  const sanctions = (doc.Sanctions ?? doc.sanctions) as Record<string, unknown> | undefined;
  if (!sanctions) return [];
  const refs = buildOfacReferenceSets(
    (sanctions.ReferenceValueSets ?? {}) as Record<string, unknown>,
  );
  const xrefs = emptyOfacCrossReferences();
  for (const location of elementsAt(sanctions, 'Locations', 'Location')) {
    foldOfacLocation(location as Record<string, unknown>, refs, xrefs);
  }
  for (const document of elementsAt(sanctions, 'IDRegDocuments', 'IDRegDocument')) {
    foldOfacIdRegDocument(document as Record<string, unknown>, refs, xrefs);
  }
  const programsByProfile = buildOfacProgramIndex(sanctions);
  return elementsAt(sanctions, 'DistinctParties', 'DistinctParty')
    .map((p) =>
      parseOfacAdvanced(
        p as Record<string, unknown>,
        source,
        refs,
        xrefs,
        programsByProfile,
        rejections,
      ),
    )
    .filter(Boolean) as NormalizedDesignation[];
}

/**
 * The OFAC advanced schema encodes entity, alias, feature, country, location-part,
 * and identity-document types as numeric IDs that resolve through
 * `<ReferenceValueSets>`. This collects the lookups the fold helpers and the
 * party parser need; each resolves an ID to the label the document publishes,
 * so the parsers match on labels rather than on IDs.
 */
interface OfacReferenceSets {
  /** AliasType ID → label (1400 = A.K.A., 1401 = F.K.A., …). */
  aliasType: Map<string, string>;
  /**
   * Country ID → name (11216 = Venezuela). OFAC's `undetermined` placeholder
   * country is left out, so a reference to it reads as absence.
   */
  country: Map<string, string>;
  /** FeatureType ID → label (8 = Birthdate, 9 = Place of Birth, 25 = Location, …). */
  featureType: Map<string, string>;
  /** IDRegDocType ID → label (1570 = Cedula No., …). */
  idRegDocType: Map<string, string>;
  /** LocPartType ID → label (1451 = ADDRESS1, 1454 = CITY, 1 = Unknown, …). */
  locPartType: Map<string, string>;
  /** PartySubType ID → label (Vessel / Aircraft / Unknown). */
  subTypeLabel: Map<string, string>;
  /** PartySubType ID → its PartyType ID (1 = Individual, 2 = Entity, 4 = Transport). */
  subTypeToPartyType: Map<string, string>;
}

/** Reference sets before the head of a document has been read — every id unresolved. */
function emptyOfacReferenceSets(): OfacReferenceSets {
  return {
    aliasType: new Map(),
    country: new Map(),
    featureType: new Map(),
    idRegDocType: new Map(),
    locPartType: new Map(),
    subTypeToPartyType: new Map(),
    subTypeLabel: new Map(),
  };
}

/**
 * What an advanced party's addresses, nationalities, and identifiers point at,
 * held as rendered strings: the `<Location>` and `<IDRegDocument>` elements are
 * parsed one at a time and discarded, so the index never retains a parse tree.
 * A location that publishes no component has no entry, and a reference to it
 * resolves to nothing — as does a reference to an ID the document never
 * published.
 */
interface OfacCrossReferences {
  /** IdentityID → the identity documents published for it, in document order. */
  documents: Map<string, IdentifierRecord[]>;
  /** Location ID → the location rendered with the address rule. */
  locations: Map<string, AddressRecord>;
}

function emptyOfacCrossReferences(): OfacCrossReferences {
  return { documents: new Map(), locations: new Map() };
}

/**
 * The order an address's parts render in, most specific first, by
 * `LocPartType` label. A part type outside this list (the `Unknown` part that
 * names a nationality target's country) follows them in document order.
 */
const OFAC_ADDRESS_PART_ORDER = [
  'ADDRESS1',
  'ADDRESS2',
  'ADDRESS3',
  'CITY',
  'STATE/PROVINCE',
  'POSTAL CODE',
  'REGION',
];

/**
 * Fold one `<Location>` into the cross-reference index. Each part contributes its
 * `Primary="true"` value (original-script variants are non-primary), in
 * {@link OFAC_ADDRESS_PART_ORDER}, and the `LocationCountry` name comes last.
 * OFAC's no-address placeholder — a location holding only the `undetermined`
 * area code — renders to nothing and gets no entry. Shared by the buffered
 * {@link parseOfac} and the streaming scan.
 */
function foldOfacLocation(
  location: Record<string, unknown>,
  refs: OfacReferenceSets,
  index: OfacCrossReferences,
): void {
  const id = asText(location['@_ID']);
  if (!id) return;
  const rank = (label: string | undefined) => {
    const at = OFAC_ADDRESS_PART_ORDER.indexOf(label ?? '');
    return at === -1 ? OFAC_ADDRESS_PART_ORDER.length : at;
  };
  const parts = asArray(location.LocationPart as unknown)
    .map((raw) => {
      const part = raw as Record<string, unknown>;
      const primary = asArray(part.LocationPartValue as unknown).find(
        (v) => asText((v as Record<string, unknown>)['@_Primary']) === 'true',
      ) as Record<string, unknown> | undefined;
      return {
        rank: rank(refs.locPartType.get(asText(part['@_LocPartTypeID']) ?? '')),
        value: componentText(primary?.Value),
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .map((p) => p.value);
  const country = elementsAt(location, 'LocationCountry')
    .map((c) => refs.country.get(asText((c as Record<string, unknown>)['@_CountryID']) ?? ''))
    .find(Boolean);
  const address = toAddress(parts, country);
  if (address) index.locations.set(id, address);
}

/**
 * Fold one `<IDRegDocument>` into the cross-reference index under the
 * `IdentityID` it belongs to: its type label, `IDRegistrationNo`, and issuing
 * country name. A document whose type ID resolves to no label is a dangling
 * reference and is dropped, like a dangling location. Shared by the buffered
 * {@link parseOfac} and the streaming scan.
 */
function foldOfacIdRegDocument(
  document: Record<string, unknown>,
  refs: OfacReferenceSets,
  index: OfacCrossReferences,
): void {
  const identityId = asText(document['@_IdentityID']);
  const type = refs.idRegDocType.get(asText(document['@_IDRegDocTypeID']) ?? '');
  const value = componentText(document.IDRegistrationNo);
  if (!identityId || !type || !value) return;
  const country = refs.country.get(asText(document['@_IssuedBy-CountryID']) ?? '');
  const documents = index.documents.get(identityId) ?? [];
  documents.push({ type, value, ...opt('country', country) });
  index.documents.set(identityId, documents);
}

/**
 * The programme index a streaming party parse reads: always empty, because the
 * `<SanctionsEntries>` block that fills it is published after every party. The
 * fields arrive later, via {@link SanctionsIngester.deferredFields}.
 */
const EMPTY_PROGRAM_INDEX: DeferredDesignationFields = new Map();

function buildOfacReferenceSets(sets: Record<string, unknown>): OfacReferenceSets {
  const subTypeToPartyType = new Map<string, string>();
  const subTypeLabel = new Map<string, string>();
  for (const s of elementsAt(sets, 'PartySubTypeValues', 'PartySubType')) {
    const sub = s as Record<string, unknown>;
    const id = asText(sub['@_ID']);
    if (!id) continue;
    const partyTypeId = asText(sub['@_PartyTypeID']);
    if (partyTypeId) subTypeToPartyType.set(id, partyTypeId);
    const label = asText(sub['#text'] ?? sub);
    if (label) subTypeLabel.set(id, label);
  }
  const country = ofacLabels(sets, 'CountryValues', 'Country');
  for (const [id, name] of country) if (name.toLowerCase() === 'undetermined') country.delete(id);
  return {
    aliasType: ofacLabels(sets, 'AliasTypeValues', 'AliasType'),
    country,
    featureType: ofacLabels(sets, 'FeatureTypeValues', 'FeatureType'),
    idRegDocType: ofacLabels(sets, 'IDRegDocTypeValues', 'IDRegDocType'),
    locPartType: ofacLabels(sets, 'LocPartTypeValues', 'LocPartType'),
    subTypeToPartyType,
    subTypeLabel,
  };
}

/** One `<…Values>` reference set as an `ID → element text` map. */
function ofacLabels(
  sets: Record<string, unknown>,
  container: string,
  item: string,
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const raw of elementsAt(sets, container, item)) {
    const value = raw as Record<string, unknown>;
    const id = asText(value['@_ID']);
    const label = asText(value['#text'] ?? value);
    if (id && label) labels.set(id, label);
  }
  return labels;
}

/**
 * Build a `profileId → { program, designationDate }` index from the advanced
 * schema's `<SanctionsEntries>`. The programme name is published as a
 * `<SanctionsMeasure><Comment>` and the designation date as the `<EntryEvent>`
 * `<Date>` (Year/Month/Day elements). Keyed by `ProfileID` (== the DistinctParty
 * `FixedRef`).
 */
function buildOfacProgramIndex(
  sanctions: Record<string, unknown>,
): Map<string, { designationDate?: string; program?: string }> {
  const out = new Map<string, { designationDate?: string; program?: string }>();
  const entries = (sanctions.SanctionsEntries ?? {}) as Record<string, unknown>;
  for (const raw of asArray(entries.SanctionsEntry as unknown)) {
    foldOfacSanctionsEntry(raw as Record<string, unknown>, out);
  }
  return out;
}

/**
 * Fold one `<SanctionsEntry>` into a programme index, keyed by `ProfileID`.
 * Several entries can share a profile; a later entry overrides a field it
 * publishes and leaves the rest of the earlier entry's values in place. Shared
 * by the buffered {@link buildOfacProgramIndex} and the streaming scan, so both
 * derive the same index from the same document order.
 */
function foldOfacSanctionsEntry(
  entry: Record<string, unknown>,
  index: Map<string, { designationDate?: string; program?: string }>,
): void {
  const profileId = asText(entry['@_ProfileID']);
  if (!profileId) return;
  const programs = asArray(entry.SanctionsMeasure as unknown)
    .map((m) => asText((m as Record<string, unknown>).Comment))
    .filter((x): x is string => Boolean(x));
  const event = (entry.EntryEvent ?? {}) as Record<string, unknown>;
  const designationDate = composeOfacDate(event.Date as Record<string, unknown> | undefined);
  const existing = index.get(profileId) ?? {};
  index.set(profileId, {
    ...existing,
    ...(programs.length ? { program: programs.join(', ') } : {}),
    ...(designationDate ? { designationDate } : {}),
  });
}

/** Compose an OFAC `<Date><Year>/<Month>/<Day></Date>` node into an ISO-ish string. */
function composeOfacDate(date: Record<string, unknown> | undefined): string | undefined {
  if (!date) return;
  const y = asText(date.Year);
  if (!y) return;
  const m = asText(date.Month);
  const d = asText(date.Day);
  if (m && d) return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  if (m) return `${y}-${m.padStart(2, '0')}`;
  return y;
}

/**
 * Parse one standard-schema `<sdnEntry>`. Null when the entry publishes no `uid`
 * or no usable name — the two fields the mirror key and the name index are built
 * from.
 */
function parseOfacStandard(
  e: Record<string, unknown>,
  source: SourceCode,
  rejections: IngestRejections,
): NormalizedDesignation | null {
  const uid = asText(e.uid);
  if (!uid) {
    rejections.missingIdentifier += 1;
    return null;
  }
  const first = asText(e.firstName);
  const last = asText(e.lastName);
  const sdnType = asText(e.sdnType)?.toLowerCase();
  const primaryName = [first, last].filter(Boolean).join(' ').trim() || last || first;
  if (!isUsableName(primaryName)) {
    rejections.unusableName += 1;
    return null;
  }

  const aliases: NameRecord[] = asArray(
    (e.akaList as Record<string, unknown> | undefined)?.aka as unknown,
  )
    .map((aka) => {
      const a = aka as Record<string, unknown>;
      const an = [asText(a.firstName), asText(a.lastName)].filter(Boolean).join(' ').trim();
      const category = asText(a.category)?.toLowerCase();
      return {
        name: an || asText(a.lastName) || '',
        nameType: category === 'weak' ? ('low-quality-aka' as const) : ('aka' as const),
      };
    })
    .filter((a) => isUsableName(a.name));

  const identifiers = dedupe(
    elementsAt(e, 'idList', 'id').flatMap((id): IdentifierRecord[] => {
      const i = id as Record<string, unknown>;
      const value = componentText(i.idNumber);
      return value
        ? [{ type: asText(i.idType) ?? 'ID', value, ...opt('country', componentText(i.idCountry)) }]
        : [];
    }),
  );

  const addresses = dedupe(
    elementsAt(e, 'addressList', 'address').flatMap((addr) => {
      const a = addr as Record<string, unknown>;
      const address = toAddress(
        [a.address1, a.address2, a.address3, a.city, a.stateOrProvince, a.postalCode].map(
          componentText,
        ),
        componentText(a.country),
      );
      return address ? [address] : [];
    }),
  );

  const datesOfBirth = birthRecords(
    textsAt(e, 'dateOfBirthList', 'dateOfBirthItem', 'dateOfBirth'),
    textsAt(e, 'placeOfBirthList', 'placeOfBirthItem', 'placeOfBirth'),
  );

  const nationalities = dedupe([
    ...textsAt(e, 'nationalityList', 'nationality', 'country'),
    ...textsAt(e, 'citizenshipList', 'citizenship', 'country'),
  ]);

  const remarks = asText(e.remarks);
  const designationDate = remarks ? extractDateFromRemarks(remarks) : undefined;
  return {
    id: `${source}:${uid}`,
    source,
    sourceEntryId: uid,
    entityType: mapOfacType(sdnType),
    primaryName,
    // Every `programList/program`, joined as the advanced schema joins a
    // SanctionsEntry's measures.
    ...opt('program', joinParts(elementsAt(e, 'programList', 'program').map(asText))),
    ...(designationDate ? { designationDate } : {}),
    payload: {
      aliases,
      identifiers,
      addresses,
      datesOfBirth,
      nationalities,
      ...opt('remarks', remarks),
    },
  };
}

/** One name extracted from an advanced-schema `<Alias>`, with its provenance. */
interface OfacAliasName {
  isPrimary: boolean;
  name: string;
  nameType: NameRecord['nameType'];
}

/**
 * Parse one advanced-schema `<DistinctParty>`. With attributes available this
 * reads the stable `FixedRef` entry id, the entity type (via `PartySubTypeID` →
 * `PartyType`), the primary name and typed aliases (via `AliasTypeID` /
 * `LowQuality`), the detail groups (via `Feature` type labels and the
 * cross-reference index), and the identity documents joined on the party's
 * `<Identity ID>`. The programme + designation date come from the
 * `<SanctionsEntries>` index, keyed by profile id. Resilient to the deep nesting
 * and to sparse records; null when the party carries neither a `FixedRef` nor an
 * `ID`, or no usable name. A dangling cross-reference drops only the entry it
 * would have produced.
 */
function parseOfacAdvanced(
  p: Record<string, unknown>,
  source: SourceCode,
  refs: OfacReferenceSets,
  xrefs: OfacCrossReferences,
  programsByProfile: DeferredDesignationFields,
  rejections: IngestRejections,
): NormalizedDesignation | null {
  const profile = (p.Profile ?? p.profile) as Record<string, unknown> | undefined;
  const id = asText(p['@_FixedRef']) ?? asText(p['@_ID']);
  if (!id) {
    rejections.missingIdentifier += 1;
    return null;
  }

  const identities = asArray((profile?.Identity ?? profile?.identity) as unknown);
  const collected: OfacAliasName[] = [];
  for (const ident of identities) {
    for (const aliasRaw of asArray((ident as Record<string, unknown>).Alias as unknown)) {
      const alias = aliasRaw as Record<string, unknown>;
      const aliasLabel = refs.aliasType.get(asText(alias['@_AliasTypeID']) ?? '');
      const lowQuality = asText(alias['@_LowQuality']) === 'true';
      const aliasPrimary = asText(alias['@_Primary']) === 'true';
      for (const dn of asArray(alias.DocumentedName as unknown)) {
        const parts = asArray((dn as Record<string, unknown>).DocumentedNamePart as unknown)
          .map((np) =>
            asText(
              ((np as Record<string, unknown>).NamePartValue as Record<string, unknown>)?.[
                '#text'
              ] ?? (np as Record<string, unknown>).NamePartValue,
            ),
          )
          .filter(Boolean);
        const name = parts.join(' ').trim();
        if (!isUsableName(name)) continue;
        collected.push({
          name,
          isPrimary: aliasPrimary,
          nameType: ofacAliasNameType(aliasLabel, lowQuality, aliasPrimary),
        });
      }
    }
  }
  const firstName = collected[0];
  if (!firstName) {
    rejections.unusableName += 1;
    return null;
  }

  // Primary = the alias flagged Primary (AliasTypeID 1403 "Name"); fall back to first.
  const primaryEntry = collected.find((n) => n.isPrimary) ?? firstName;
  const aliases: NameRecord[] = collected
    .filter((n) => n !== primaryEntry)
    .map((n) => ({ name: n.name, nameType: n.nameType }));

  const features = extractOfacFeatures(profile, refs, xrefs);
  const identifiers = dedupe(
    identities.flatMap(
      (ident) =>
        xrefs.documents.get(asText((ident as Record<string, unknown>)['@_ID']) ?? '') ?? [],
    ),
  );
  const program = programsByProfile.get(id);

  return {
    id: `${source}:${id}`,
    source,
    sourceEntryId: id,
    entityType: mapOfacPartySubType(asText(profile?.['@_PartySubTypeID']), refs),
    primaryName: primaryEntry.name,
    ...(program?.program ? { program: program.program } : {}),
    ...(program?.designationDate ? { designationDate: program.designationDate } : {}),
    payload: {
      aliases,
      identifiers,
      addresses: dedupe(features.addresses),
      datesOfBirth: birthRecords(features.datesOfBirth, features.placesOfBirth),
      nationalities: dedupe(features.nationalities),
    },
  };
}

/** Map an advanced-schema alias to a normalized name type. */
function ofacAliasNameType(
  aliasLabel: string | undefined,
  lowQuality: boolean,
  isPrimary: boolean,
): NameRecord['nameType'] {
  if (isPrimary) return 'primary';
  if (lowQuality) return 'low-quality-aka';
  const label = aliasLabel?.toUpperCase().replace(/\./g, '');
  if (label === 'FKA') return 'fka';
  return 'aka';
}

/**
 * Map an advanced-schema `PartySubTypeID` to a coarse entity type. Vessel and
 * Aircraft are explicit sub-types; otherwise the parent `PartyType` distinguishes
 * Individual (person) from Entity (organization).
 */
function mapOfacPartySubType(subTypeId: string | undefined, refs: OfacReferenceSets): EntityType {
  if (!subTypeId) return 'unknown';
  const subLabel = refs.subTypeLabel.get(subTypeId)?.toLowerCase();
  if (subLabel === 'vessel') return 'vessel';
  if (subLabel === 'aircraft') return 'aircraft';
  const partyType = refs.subTypeToPartyType.get(subTypeId);
  if (partyType === '1') return 'person';
  if (partyType === '2' || partyType === '5') return 'organization';
  if (partyType === '4') return 'vessel'; // Transport without a specific sub-type
  return 'unknown';
}

/** The detail-group values a profile's `<Feature>`s publish, before dedupe and birth pairing. */
interface OfacFeatureValues {
  addresses: AddressRecord[];
  datesOfBirth: string[];
  nationalities: string[];
  placesOfBirth: string[];
}

/**
 * Pull the detail-group values out of a profile's `<Feature>`s, matched by
 * feature-type label. A birthdate is a `DatePeriod`; a place of birth is free
 * text in the `VersionDetail`; an address, nationality, or citizenship is a
 * `VersionLocation` resolved through the cross-reference index — a nationality
 * or citizenship target renders to its one country-name part. Every other
 * feature (gender, title, vessel flag, registration country, …) has no
 * normalized field.
 */
function extractOfacFeatures(
  profile: Record<string, unknown> | undefined,
  refs: OfacReferenceSets,
  xrefs: OfacCrossReferences,
): OfacFeatureValues {
  const values: OfacFeatureValues = {
    addresses: [],
    datesOfBirth: [],
    nationalities: [],
    placesOfBirth: [],
  };
  for (const featRaw of asArray(profile?.Feature as unknown)) {
    const feat = featRaw as Record<string, unknown>;
    const label = refs.featureType.get(asText(feat['@_FeatureTypeID']) ?? '')?.toLowerCase();
    for (const versionRaw of asArray(feat.FeatureVersion as unknown)) {
      const version = versionRaw as Record<string, unknown>;
      const locations = elementsAt(version, 'VersionLocation').flatMap((vl) => {
        const location = xrefs.locations.get(
          asText((vl as Record<string, unknown>)['@_LocationID']) ?? '',
        );
        return location ? [location] : [];
      });
      switch (label) {
        case 'birthdate': {
          const date = composeOfacDate(
            elementsAt(version, 'DatePeriod', 'Start', 'From')[0] as
              | Record<string, unknown>
              | undefined,
          );
          if (date) values.datesOfBirth.push(date);
          break;
        }
        case 'place of birth': {
          const place = componentText(version.VersionDetail);
          if (place) values.placesOfBirth.push(place);
          break;
        }
        case 'location':
          values.addresses.push(...locations);
          break;
        case 'nationality country':
        case 'citizenship country':
          values.nationalities.push(...locations.map((l) => l.full));
          break;
      }
    }
  }
  return values;
}

function mapOfacType(t: string | undefined): EntityType {
  switch (t) {
    case 'individual':
      return 'person';
    case 'entity':
      return 'organization';
    case 'vessel':
      return 'vessel';
    case 'aircraft':
      return 'aircraft';
    default:
      return 'unknown';
  }
}

/** OFAC remarks embed the designation date; pull an ISO-ish date if present. */
function extractDateFromRemarks(remarks: string): string | undefined {
  const m = remarks.match(/(\d{1,2}\s+\w+\s+\d{4})|(\d{4}-\d{2}-\d{2})/);
  return m ? m[0] : undefined;
}

// ─── EU (xmlFullSanctionsList_1_1) ──────────────────────────────────────────────

/** Normalize a decoded EU text stream. Shares {@link parseEuEntity} with {@link parseEu}. */
export function streamEuFromText(
  textChunks: AsyncIterable<string>,
  state: HarvestState,
): AsyncGenerator<NormalizedDesignation> {
  return streamFlatRecords(textChunks, ['sanctionEntity', 'SanctionEntity'], (record) =>
    parseEuEntity(record, state.rejections),
  );
}

function buildEuIngester(): SanctionsIngester {
  return buildStreamingIngester({
    source: 'eu',
    url: () => getServerConfig().euFsfUrl,
    stream: streamEuFromText,
  });
}

export function parseEu(
  doc: Record<string, unknown>,
  rejections: IngestRejections = createRejections(),
): NormalizedDesignation[] {
  const root = (doc.export ?? doc) as Record<string, unknown>;
  return asArray((root.sanctionEntity ?? root.SanctionEntity) as unknown)
    .map((raw) => parseEuEntity(raw as Record<string, unknown>, rejections))
    .filter(Boolean) as NormalizedDesignation[];
}

/**
 * Normalize one EU `<sanctionEntity>`. Null when the entity carries neither a
 * `logicalId` nor an `euReferenceNumber`, or no usable name.
 */
function parseEuEntity(
  e: Record<string, unknown>,
  rejections: IngestRejections,
): NormalizedDesignation | null {
  const id = asText(e['@_logicalId']) ?? asText(e['@_euReferenceNumber']);
  if (!id) {
    rejections.missingIdentifier += 1;
    return null;
  }
  const subjectType = (e.subjectType as Record<string, unknown> | undefined)?.['@_code'];
  const nameAliases = asArray(e.nameAlias as unknown)
    .map((n) => {
      const na = n as Record<string, unknown>;
      const whole = asText(na['@_wholeName']);
      const strong = asText(na['@_strong']);
      return {
        name:
          whole ?? [asText(na['@_firstName']), asText(na['@_lastName'])].filter(Boolean).join(' '),
        strong: strong !== 'false',
      };
    })
    .filter((n) => isUsableName(n.name));
  const primary = nameAliases[0]?.name;
  if (!primary) {
    rejections.unusableName += 1;
    return null;
  }
  const citizenships = asArray(e.citizenship as unknown).flatMap((c) => {
    const country = euText(c, 'countryDescription');
    return country ? [country] : [];
  });

  return {
    id: `eu:${id}`,
    source: 'eu',
    sourceEntryId: id,
    entityType: mapEuType(asText(subjectType)),
    primaryName: primary,
    ...opt(
      'program',
      asText((e.regulation as Record<string, unknown> | undefined)?.['@_programme']),
    ),
    ...opt(
      'designationDate',
      asText((e.regulation as Record<string, unknown> | undefined)?.['@_publicationDate']),
    ),
    payload: {
      aliases: nameAliases.slice(1).map((n) => ({
        name: n.name,
        nameType: (n.strong ? 'aka' : 'low-quality-aka') as NameRecord['nameType'],
      })),
      identifiers: dedupe(asArray(e.identification as unknown).flatMap(euIdentifier)),
      addresses: dedupe(asArray(e.address as unknown).flatMap(euAddress)),
      datesOfBirth: dedupe(asArray(e.birthdate as unknown).flatMap(euBirth)),
      nationalities: dedupe(citizenships),
    },
  };
}

/**
 * One EU attribute value as published. The list writes `UNKNOWN` (with country
 * code `00`) where it has no country; the shared placeholder rule reads that as
 * absence.
 */
function euText(element: unknown, attribute: string): string | undefined {
  return componentText((element as Record<string, unknown>)[`@_${attribute}`]);
}

/** An EU `<identification>`: its type description, number, and issuing country. */
function euIdentifier(element: unknown): IdentifierRecord[] {
  const type = euText(element, 'identificationTypeDescription');
  const value = euText(element, 'number');
  if (!type || !value) return [];
  return [{ type, value, ...opt('country', euText(element, 'countryDescription')) }];
}

/** An EU `<address>`, skipped when it publishes nothing but the `UNKNOWN` country. */
function euAddress(element: unknown): AddressRecord[] {
  const address = toAddress(
    ['street', 'poBox', 'place', 'city', 'region', 'zipCode'].map((a) => euText(element, a)),
    euText(element, 'countryDescription'),
  );
  return address ? [address] : [];
}

/**
 * An EU `<birthdate>`: the full date, else the year (with the month when the
 * list publishes one), and the birthplace published on the same element. The
 * date and place are one published fact, so they stay one entry.
 */
function euBirth(element: unknown): DobRecord[] {
  const year = euText(element, 'year');
  const month = euText(element, 'monthOfYear');
  const date =
    euText(element, 'birthdate') ?? (year && month ? `${year}-${month.padStart(2, '0')}` : year);
  const place = joinParts(
    ['place', 'city', 'region', 'countryDescription'].map((a) => euText(element, a)),
  );
  return date || place ? [{ ...opt('date', date), ...opt('place', place) } as DobRecord] : [];
}

function mapEuType(code: string | undefined): EntityType {
  if (code === 'P' || code?.toLowerCase() === 'person') return 'person';
  if (code === 'E' || code?.toLowerCase() === 'enterprise') return 'organization';
  return 'unknown';
}

// ─── UK Sanctions List (UKSL, FCDO) ─────────────────────────────────────────────

/** Normalize a decoded UK text stream. Shares {@link parseUkDesignation} with {@link parseUk}. */
export function streamUkFromText(
  textChunks: AsyncIterable<string>,
  state: HarvestState,
): AsyncGenerator<NormalizedDesignation> {
  return streamFlatRecords(textChunks, ['Designation', 'designation'], (record) =>
    parseUkDesignation(record, state.rejections),
  );
}

function buildUkIngester(): SanctionsIngester {
  return buildStreamingIngester({
    source: 'uk',
    url: () => getServerConfig().ukSanctionsUrl,
    stream: streamUkFromText,
  });
}

export function parseUk(
  doc: Record<string, unknown>,
  rejections: IngestRejections = createRejections(),
): NormalizedDesignation[] {
  // UKSL XML root is <Sanctions...><Designations><Designation>. Famously messy;
  // be defensive about every field.
  const root = (doc.Designations ?? doc.UKSanctionsList ?? doc) as Record<string, unknown>;
  const designations = asArray((root.Designation ?? root.designation) as unknown);
  const list = designations.length
    ? designations
    : asArray(
        ((doc as Record<string, unknown>).Designations as Record<string, unknown> | undefined)
          ?.Designation as unknown,
      );
  return list
    .map((raw) => parseUkDesignation(raw as Record<string, unknown>, rejections))
    .filter(Boolean) as NormalizedDesignation[];
}

/**
 * Normalize one UKSL `<Designation>`. Null when the designation carries none of
 * the three identifier spellings, or no usable name.
 */
function parseUkDesignation(
  d: Record<string, unknown>,
  rejections: IngestRejections,
): NormalizedDesignation | null {
  const id = asText(d.UniqueID) ?? asText(d.OFSIGroupID) ?? asText(d['@_UniqueID']);
  if (!id) {
    rejections.missingIdentifier += 1;
    return null;
  }
  const names = asArray((d.Names as Record<string, unknown> | undefined)?.Name as unknown)
    .map((n) => {
      const nm = n as Record<string, unknown>;
      const parts = [
        asText(nm.Name1),
        asText(nm.Name2),
        asText(nm.Name3),
        asText(nm.Name4),
        asText(nm.Name5),
        asText(nm.Name6),
      ].filter(Boolean);
      const whole =
        asText(nm.NameType) && parts.length
          ? parts.join(' ')
          : (asText(nm.WholeName) ?? parts.join(' '));
      return { name: whole, type: asText(nm.NameType) };
    })
    .filter((n): n is { name: string; type: string | undefined } => isUsableName(n.name));
  const fallbackName =
    asText(d.Name) ?? asText((d.Names as Record<string, unknown> | undefined)?.WholeName);
  const allNames = names.length
    ? names
    : isUsableName(fallbackName)
      ? [{ name: fallbackName, type: 'Primary name' as string | undefined }]
      : [];
  const primary = allNames[0]?.name;
  if (!primary) {
    rejections.unusableName += 1;
    return null;
  }
  // Person-only details (dates, birthplaces, nationalities, passports, national
  // IDs) are published under IndividualDetails, never directly on Designation.
  const individuals = elementsAt(d, 'IndividualDetails', 'Individual');

  return {
    id: `uk:${id}`,
    source: 'uk',
    sourceEntryId: id,
    entityType: mapUkType(asText(d.IndividualEntityShip ?? d.GroupType)),
    primaryName: primary,
    ...opt('program', asText(d.RegimeName)),
    ...opt('designationDate', asText(d.DateDesignated ?? d.LastUpdated)),
    payload: {
      aliases: allNames.slice(1).map((n) => ({
        name: n.name,
        nameType: 'aka' as NameRecord['nameType'],
      })),
      identifiers: dedupe([
        ...ukIdentifiers('Passport', individuals, 'PassportDetails', 'Passport', 'PassportNumber'),
        ...ukIdentifiers(
          'National Identifier',
          individuals,
          'NationalIdentifierDetails',
          'NationalIdentifier',
          'NationalIdentifierNumber',
        ),
        ...ukIdentifiers(
          'Business Registration Number',
          d,
          'EntityDetails',
          'Entity',
          'BusinessRegistrationNumbers',
          'BusinessRegistrationNumber',
        ),
        ...ukIdentifiers('IMO Number', d, 'ShipDetails', 'Ship', 'IMONumbers', 'IMONumber'),
      ]),
      addresses: dedupe(
        elementsAt(d, 'Addresses', 'Address').flatMap((raw) => {
          const a = raw as Record<string, unknown>;
          const address = toAddress(
            [
              a.AddressLine1,
              a.AddressLine2,
              a.AddressLine3,
              a.AddressLine4,
              a.AddressLine5,
              a.AddressLine6,
              a.AddressPostalCode,
            ].map(componentText),
            componentText(a.AddressCountry),
          );
          return address ? [address] : [];
        }),
      ),
      datesOfBirth: birthRecords(
        textsAt(individuals, 'DOBs', 'DOB'),
        elementsAt(individuals, 'BirthDetails', 'Location').flatMap((raw) => {
          const l = raw as Record<string, unknown>;
          const place = joinParts([componentText(l.TownOfBirth), componentText(l.CountryOfBirth)]);
          return place ? [place] : [];
        }),
      ),
      nationalities: dedupe(textsAt(individuals, 'Nationalities', 'Nationality')),
      ...opt('remarks', asText(d.OtherInformation)),
    },
  };
}

/**
 * UKSL identifiers carry no type field and no issuing country — each kind sits in
 * its own element, so the element names the type. The issuing country appears
 * only inside free-text `…AdditionalInformation`, which is not parsed.
 */
function ukIdentifiers(type: string, node: unknown, ...path: string[]): IdentifierRecord[] {
  return textsAt(node, ...path).map((value) => ({ type, value }));
}

function mapUkType(t: string | undefined): EntityType {
  const v = t?.toLowerCase();
  if (v === 'individual' || v === 'person') return 'person';
  if (v === 'entity' || v === 'organisation' || v === 'organization') return 'organization';
  if (v === 'ship' || v === 'vessel') return 'vessel';
  return 'unknown';
}

// ─── UN Security Council Consolidated List ───────────────────────────────────────

/**
 * Normalize a decoded UN text stream. The list carries its two entity kinds as
 * two record elements, so the tag that matched is what classifies the record.
 * Shares {@link parseUnEntry} with {@link parseUn}.
 */
export function streamUnFromText(
  textChunks: AsyncIterable<string>,
  state: HarvestState,
): AsyncGenerator<NormalizedDesignation> {
  return streamFlatRecords(textChunks, ['INDIVIDUAL', 'ENTITY'], (record, tag) =>
    parseUnEntry(record, tag === 'ENTITY' ? 'organization' : 'person', state.rejections),
  );
}

function buildUnIngester(): SanctionsIngester {
  return buildStreamingIngester({
    source: 'un',
    url: () => getServerConfig().unScUrl,
    stream: streamUnFromText,
  });
}

export function parseUn(
  doc: Record<string, unknown>,
  rejections: IngestRejections = createRejections(),
): NormalizedDesignation[] {
  const root = (doc.CONSOLIDATED_LIST ?? doc) as Record<string, unknown>;
  const individuals = asArray(
    (root.INDIVIDUALS as Record<string, unknown> | undefined)?.INDIVIDUAL as unknown,
  ).map((i) => parseUnEntry(i as Record<string, unknown>, 'person', rejections));
  const entities = asArray(
    (root.ENTITIES as Record<string, unknown> | undefined)?.ENTITY as unknown,
  ).map((e) => parseUnEntry(e as Record<string, unknown>, 'organization', rejections));
  return [...individuals, ...entities].filter(Boolean) as NormalizedDesignation[];
}

/**
 * Normalize one UN `<INDIVIDUAL>` / `<ENTITY>`. Null when the record carries
 * neither a `DATAID` nor a `REFERENCE_NUMBER`, or no usable name.
 */
function parseUnEntry(
  e: Record<string, unknown>,
  entityType: EntityType,
  rejections: IngestRejections,
): NormalizedDesignation | null {
  const id = asText(e.DATAID) ?? asText(e.REFERENCE_NUMBER);
  if (!id) {
    rejections.missingIdentifier += 1;
    return null;
  }
  const nameParts = [
    asText(e.FIRST_NAME),
    asText(e.SECOND_NAME),
    asText(e.THIRD_NAME),
    asText(e.FOURTH_NAME),
  ].filter(Boolean);
  const primary =
    entityType === 'organization'
      ? (asText(e.FIRST_NAME) ?? nameParts.join(' '))
      : nameParts.join(' ');
  if (!isUsableName(primary)) {
    rejections.unusableName += 1;
    return null;
  }

  const aliases: NameRecord[] = asArray(e.INDIVIDUAL_ALIAS ?? e.ENTITY_ALIAS)
    .map((a) => {
      const al = a as Record<string, unknown>;
      const quality = asText(al.QUALITY)?.toLowerCase();
      return {
        name: asText(al.ALIAS_NAME) ?? '',
        nameType: (quality === 'low' ? 'low-quality-aka' : 'aka') as NameRecord['nameType'],
      };
    })
    .filter((a) => isUsableName(a.name));

  // A BETWEEN date publishes only its year range; it renders as an ISO 8601
  // interval (`1973/1974`).
  const dates = asArray(e.INDIVIDUAL_DATE_OF_BIRTH).flatMap((d) => {
    const dd = d as Record<string, unknown>;
    const date =
      componentText(dd.DATE) ??
      componentText(dd.YEAR) ??
      [componentText(dd.FROM_YEAR), componentText(dd.TO_YEAR)].filter(Boolean).join('/');
    return date ? [date] : [];
  });
  const places = asArray(e.INDIVIDUAL_PLACE_OF_BIRTH).flatMap((p) => {
    const pp = p as Record<string, unknown>;
    const place = joinParts([pp.STREET, pp.CITY, pp.STATE_PROVINCE, pp.COUNTRY].map(componentText));
    return place ? [place] : [];
  });

  const nationalities = dedupe(textsAt(e, 'NATIONALITY', 'VALUE'));

  return {
    id: `un:${id}`,
    source: 'un',
    sourceEntryId: id,
    entityType,
    primaryName: primary,
    ...opt('program', asText(e.UN_LIST_TYPE)),
    ...opt('designationDate', asText(e.LISTED_ON)),
    payload: {
      aliases,
      identifiers: dedupe(
        asArray(e.INDIVIDUAL_DOCUMENT).flatMap((d): IdentifierRecord[] => {
          const dd = d as Record<string, unknown>;
          const value = componentText(dd.NUMBER);
          if (!value) return [];
          const country = componentText(dd.ISSUING_COUNTRY) ?? componentText(dd.COUNTRY_OF_ISSUE);
          return [
            { type: asText(dd.TYPE_OF_DOCUMENT) ?? 'Document', value, ...opt('country', country) },
          ];
        }),
      ),
      addresses: dedupe(
        [...asArray(e.INDIVIDUAL_ADDRESS), ...asArray(e.ENTITY_ADDRESS)].flatMap((a) => {
          const aa = a as Record<string, unknown>;
          const address = toAddress(
            [aa.STREET, aa.CITY, aa.STATE_PROVINCE, aa.ZIP_CODE].map(componentText),
            componentText(aa.COUNTRY),
          );
          return address ? [address] : [];
        }),
      ),
      datesOfBirth: birthRecords(dates, places),
      nationalities,
      ...opt('remarks', asText(e.COMMENTS1)),
    },
  };
}

// ─── Registry + sync factory ─────────────────────────────────────────────────

/** All five sanctions ingesters, configured from the current server config. */
export function buildSanctionsIngesters(): SanctionsIngester[] {
  const cfg = getServerConfig();
  return [
    buildOfacIngester('ofac_sdn', () => cfg.ofacSdnUrl),
    buildOfacIngester('ofac_consolidated', () => cfg.ofacConsolidatedUrl),
    buildEuIngester(),
    buildUkIngester(),
    buildUnIngester(),
  ];
}

/** One source's harvest report plus what the sync removed for it. */
export interface SourceSyncReport extends SourceHarvestReport {
  /** Stored designations of this source its document no longer published, removed. */
  pruned: number;
  /**
   * Stored designations its document no longer published but that the sync kept,
   * because removing them would have crossed {@link MAX_PRUNE_SHARE}.
   */
  withheld: number;
}

/**
 * The largest share of a source's stored designations one run may remove. The
 * completeness check proves a document arrived whole, not that it is the whole
 * list: a well-formed file that publishes a fraction of the list (a delta or test
 * file behind a URL override, a partial upstream publication) or an upstream
 * schema change that makes the ingest reject most records would otherwise empty
 * the source. Real delistings move a few percent of a list at a time. A run over
 * the bound removes nothing for that source, keeps its upserted records, and
 * reports the ids it withheld; a genuine mass delisting is then applied by
 * rebuilding the sanctions mirror from scratch.
 */
export const MAX_PRUNE_SHARE = 0.5;

/** Wiring {@link createSanctionsSync} needs from the service that owns the mirror. */
export interface SanctionsSyncOptions {
  /**
   * Apply a source's deferred columns once its rows have landed. The runner
   * persists each yielded page before resuming the generator, so by the time
   * this is called every row it patches is in the mirror.
   */
  applyDeferredFields(source: SourceCode, fields: DeferredDesignationFields): Promise<void>;
  /** Ingesters to harvest. Defaults to {@link buildSanctionsIngesters}. */
  ingesters?: SanctionsIngester[];
  /** Called once per source, after its records, deferred columns, and removals are applied. */
  onSourceReport?(report: SourceSyncReport): void;
  /** Designations (or removed ids) per yielded page. Defaults to {@link SYNC_PAGE_SIZE}. */
  pageSize?: number;
  /**
   * The ids of a source's stored designations that are not in `kept` — the rows
   * its current document no longer publishes.
   */
  staleDesignationIds(source: SourceCode, kept: ReadonlySet<string>): Promise<string[]>;
}

/**
 * The MirrorService `sync` generator for the sanctions designation mirror. Each
 * run re-harvests every source in full — these corpora are tens of thousands of
 * rows with no delta feed, so `init` and `refresh` behave identically — and
 * yields bounded pages of rows as records stream in, rather than one page per
 * whole source.
 *
 * After a source drains, its deferred columns (the OFAC programme fields, which
 * the source publishes after every party) are applied to the rows just written.
 * Then the source's stored designations its document no longer published are
 * yielded as tombstones, so a delisting leaves the mirror on the next run.
 *
 * Pruning is per source and guarded, because a wrongly-emptied list is the worst
 * failure a screening aid can have. It runs only once the source's harvest has
 * returned normally — which means the document was fetched, arrived whole (a
 * transfer cut short fails on its missing root close), and was parsed to its end
 * — and only when the removal stays within {@link MAX_PRUNE_SHARE} of the
 * source's stored rows, which also holds back a document that yielded no
 * accepted record. A harvest that throws ends the run before its source prunes.
 * The kept set is the ids the harvest accepted, so a designation the source now
 * publishes only in a form the ingest rejects is removed like a delisted one.
 * That set is the only state the loop keeps per source: one id per published
 * designation.
 *
 * The mirror upserts the `designation` rows and deletes the tombstoned ones; the
 * per-alias `name` index is rebuilt from `designation` afterwards by the
 * service's `rebuildNameIndex()`, which the lifecycle scripts and the refresh
 * cron call. Until then a removed designation's `name` rows join to no
 * `designation` row, so no screen can surface it.
 */
export function createSanctionsSync(options: SanctionsSyncOptions) {
  const pageSize = options.pageSize ?? SYNC_PAGE_SIZE;
  return async function* sync(ctx: { signal: AbortSignal }): AsyncGenerator<{
    checkpoint?: string;
    records: Record<string, string | number | null>[];
    tombstones?: string[];
  }> {
    const ingesters = options.ingesters ?? buildSanctionsIngesters();
    const stamp = new Date().toISOString();
    for (const ingester of ingesters) {
      if (ctx.signal.aborted) return;
      const kept = new Set<string>();
      let page: Record<string, string | number | null>[] = [];
      for await (const designation of ingester.harvest(ctx.signal)) {
        kept.add(designation.id);
        page.push(toDesignationRow(designation));
        if (page.length >= pageSize) {
          yield { records: page, checkpoint: stamp };
          page = [];
        }
      }
      // The trailing partial page must be yielded before the deferred columns
      // are applied — the runner persists a page before resuming this generator,
      // so this is what puts the source's last rows in reach of the UPDATE.
      if (page.length > 0) yield { records: page, checkpoint: stamp };

      const deferred = ingester.deferredFields();
      if (deferred.size > 0) await options.applyDeferredFields(ingester.source, deferred);

      const stale = await options.staleDesignationIds(ingester.source, kept);
      // Every kept id was just upserted, so the source now stores kept + stale rows.
      // A document that yielded no record would remove all of them, so it never passes.
      const withinBound = stale.length <= MAX_PRUNE_SHARE * (kept.size + stale.length);
      const pruned = withinBound ? stale : [];
      for (let at = 0; at < pruned.length; at += pageSize) {
        yield { records: [], tombstones: pruned.slice(at, at + pageSize), checkpoint: stamp };
      }
      options.onSourceReport?.({
        ...ingester.report(),
        pruned: pruned.length,
        withheld: stale.length - pruned.length,
      });
    }
  };
}

/** Map a normalized designation to its primary-table row (no aux fields). */
export function toDesignationRow(d: NormalizedDesignation): Record<string, string | number | null> {
  return {
    id: d.id,
    source: d.source,
    source_entry_id: d.sourceEntryId,
    entity_type: d.entityType,
    primary_name: d.primaryName,
    normalized_name: fold(d.primaryName),
    program: d.program ?? null,
    legal_basis: d.legalBasis ?? null,
    designation_date: d.designationDate ?? null,
    payload: JSON.stringify(d.payload),
  };
}
