/**
 * @fileoverview Sanctions ingesters — one per source (OFAC SDN, OFAC
 * Consolidated, EU FSF, UK Sanctions List, UN SC Consolidated). Each streams its
 * source file, lifts out one record element at a time, and maps it onto the
 * common {@link NormalizedDesignation} schema. The {@link createSanctionsSync}
 * factory wires them into the MirrorService `sync` generator: each refresh
 * re-harvests every source in full (the combined corpus is tens of thousands of
 * rows — no delta logic needed), yielding bounded pages as records arrive.
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
 * applied by the sync as an UPDATE once the source's rows have landed.
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
import { decodeUtf8Stream, scanRecordFragments } from '@/services/screening/xml-stream.js';

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

/**
 * Open a source document as a stream of decoded text chunks: browser UA, retry
 * around the request, and the HTML-error-page guard applied to the head of the
 * body rather than the whole document. The retry covers establishing the
 * response; a mid-transfer failure surfaces on the consuming iteration, as it
 * does on the GLEIF streaming path.
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
      return replayTextStream(head, iterator, drained);
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
 * type ids every party carries; `<SanctionsEntry>` (its tail) supplies the
 * deferred programme fields.
 */
const OFAC_RECORD_TAGS = [
  'ReferenceValueSets',
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
 * Document order does the sequencing: the reference sets arrive before the first
 * party and the programme entries after the last one, so a party normalizes with
 * its type ids resolved while its programme fields accumulate in
 * `state.deferredFields` for the sync to apply afterwards.
 *
 * Shares {@link parseOfacAdvanced} / {@link parseOfacStandard} with the buffered
 * {@link parseOfac}, so both paths normalize a record identically.
 */
export async function* streamOfacFromText(
  textChunks: AsyncIterable<string>,
  source: SourceCode,
  state: HarvestState,
): AsyncGenerator<NormalizedDesignation> {
  let refs = emptyOfacReferenceSets();
  for await (const fragment of scanRecordFragments(textChunks, OFAC_RECORD_TAGS)) {
    const body = recordBody(parseXml<Record<string, unknown>>(fragment.xml), fragment.name);
    if (fragment.name === 'ReferenceValueSets') {
      refs = buildOfacReferenceSets(body);
      continue;
    }
    if (fragment.name === 'SanctionsEntry') {
      foldOfacSanctionsEntry(body, state.deferredFields);
      continue;
    }
    const record =
      fragment.name === 'sdnEntry'
        ? parseOfacStandard(body, source, state.rejections)
        : parseOfacAdvanced(body, source, refs, EMPTY_PROGRAM_INDEX, state.rejections);
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
  const programsByProfile = buildOfacProgramIndex(sanctions);
  const parties = sanctions.DistinctParties as Record<string, unknown> | undefined;
  return asArray(parties?.DistinctParty as unknown)
    .map((p) =>
      parseOfacAdvanced(p as Record<string, unknown>, source, refs, programsByProfile, rejections),
    )
    .filter(Boolean) as NormalizedDesignation[];
}

/**
 * The OFAC advanced schema encodes entity type, alias type, and feature type as
 * numeric IDs that resolve through `<ReferenceValueSets>`. This collects the
 * three lookups the party parser needs.
 */
interface OfacReferenceSets {
  /** AliasType ID → label (1400 = A.K.A., 1401 = F.K.A., …). */
  aliasType: Map<string, string>;
  /** FeatureType ID → label (8 = Birthdate, 9 = Place of Birth, …). */
  featureType: Map<string, string>;
  /** PartySubType ID → label (Vessel / Aircraft / Unknown). */
  subTypeLabel: Map<string, string>;
  /** PartySubType ID → its PartyType ID (1 = Individual, 2 = Entity, 4 = Transport). */
  subTypeToPartyType: Map<string, string>;
}

/** Reference sets before the head of a document has been read — every id unresolved. */
function emptyOfacReferenceSets(): OfacReferenceSets {
  return {
    aliasType: new Map(),
    featureType: new Map(),
    subTypeToPartyType: new Map(),
    subTypeLabel: new Map(),
  };
}

/**
 * The programme index a streaming party parse reads: always empty, because the
 * `<SanctionsEntries>` block that fills it is published after every party. The
 * fields arrive later, via {@link SanctionsIngester.deferredFields}.
 */
const EMPTY_PROGRAM_INDEX: DeferredDesignationFields = new Map();

function buildOfacReferenceSets(sets: Record<string, unknown>): OfacReferenceSets {
  const aliasType = new Map<string, string>();
  for (const a of asArray(
    (sets.AliasTypeValues as Record<string, unknown> | undefined)?.AliasType as unknown,
  )) {
    const id = asText((a as Record<string, unknown>)['@_ID']);
    const label = asText((a as Record<string, unknown>)['#text'] ?? a);
    if (id && label) aliasType.set(id, label);
  }
  const featureType = new Map<string, string>();
  for (const f of asArray(
    (sets.FeatureTypeValues as Record<string, unknown> | undefined)?.FeatureType as unknown,
  )) {
    const id = asText((f as Record<string, unknown>)['@_ID']);
    const label = asText((f as Record<string, unknown>)['#text'] ?? f);
    if (id && label) featureType.set(id, label);
  }
  const subTypeToPartyType = new Map<string, string>();
  const subTypeLabel = new Map<string, string>();
  for (const s of asArray(
    (sets.PartySubTypeValues as Record<string, unknown> | undefined)?.PartySubType as unknown,
  )) {
    const sub = s as Record<string, unknown>;
    const id = asText(sub['@_ID']);
    if (!id) continue;
    const partyTypeId = asText(sub['@_PartyTypeID']);
    if (partyTypeId) subTypeToPartyType.set(id, partyTypeId);
    const label = asText(sub['#text'] ?? sub);
    if (label) subTypeLabel.set(id, label);
  }
  return { aliasType, featureType, subTypeToPartyType, subTypeLabel };
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

  const identifiers: IdentifierRecord[] = asArray(
    (e.idList as Record<string, unknown> | undefined)?.id as unknown,
  )
    .map((id) => {
      const i = id as Record<string, unknown>;
      return {
        type: asText(i.idType) ?? 'ID',
        value: asText(i.idNumber) ?? '',
        ...opt('country', asText(i.idCountry)),
      };
    })
    .filter((i) => i.value);

  const addresses: AddressRecord[] = asArray(
    (e.addressList as Record<string, unknown> | undefined)?.address as unknown,
  )
    .map((addr) => {
      const a = addr as Record<string, unknown>;
      const parts = [
        asText(a.address1),
        asText(a.address2),
        asText(a.city),
        asText(a.stateOrProvince),
        asText(a.postalCode),
        asText(a.country),
      ].filter(Boolean);
      return {
        full: parts.join(', '),
        ...opt('country', asText(a.country)),
      };
    })
    .filter((a) => a.full);

  const dobs: DobRecord[] = asArray(
    (e.dateOfBirthList as Record<string, unknown> | undefined)?.dateOfBirthItem as unknown,
  )
    .map((d) => {
      const dd = d as Record<string, unknown>;
      return opt('date', asText(dd.dateOfBirth)) as DobRecord;
    })
    .filter((d) => d.date);

  const nationalities = asArray(
    (e.nationalityList as Record<string, unknown> | undefined)?.nationality as unknown,
  )
    .map((n) => asText((n as Record<string, unknown>).country))
    .filter((x): x is string => Boolean(x));

  const remarks = asText(e.remarks);
  const designationDate = remarks ? extractDateFromRemarks(remarks) : undefined;
  return {
    id: `${source}:${uid}`,
    source,
    sourceEntryId: uid,
    entityType: mapOfacType(sdnType),
    primaryName,
    ...opt('program', asText(e.program)),
    ...(designationDate ? { designationDate } : {}),
    payload: {
      aliases,
      identifiers,
      addresses,
      datesOfBirth: dobs,
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
 * `LowQuality`), and dates/places of birth (via `Feature` type ids). The
 * programme + designation date come from the `<SanctionsEntries>` index, keyed by
 * profile id. Resilient to the deep nesting and to sparse records; null when the
 * party carries neither a `FixedRef` nor an `ID`, or no usable name.
 */
function parseOfacAdvanced(
  p: Record<string, unknown>,
  source: SourceCode,
  refs: OfacReferenceSets,
  programsByProfile: DeferredDesignationFields,
  rejections: IngestRejections,
): NormalizedDesignation | null {
  const profile = (p.Profile ?? p.profile) as Record<string, unknown> | undefined;
  const id = asText(p['@_FixedRef']) ?? asText(p['@_ID']);
  if (!id) {
    rejections.missingIdentifier += 1;
    return null;
  }

  const collected: OfacAliasName[] = [];
  for (const ident of asArray((profile?.Identity ?? profile?.identity) as unknown)) {
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

  const { datesOfBirth, placesOfBirth } = extractOfacFeatures(profile, refs);
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
      identifiers: [],
      addresses: [],
      datesOfBirth:
        datesOfBirth.length || placesOfBirth.length ? mergeDobPob(datesOfBirth, placesOfBirth) : [],
      nationalities: [],
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

/** Birthdate / place-of-birth feature values pulled from a profile's `<Feature>`s. */
function extractOfacFeatures(
  profile: Record<string, unknown> | undefined,
  refs: OfacReferenceSets,
): { datesOfBirth: string[]; placesOfBirth: string[] } {
  const datesOfBirth: string[] = [];
  const placesOfBirth: string[] = [];
  for (const featRaw of asArray(profile?.Feature as unknown)) {
    const feat = featRaw as Record<string, unknown>;
    const label = refs.featureType.get(asText(feat['@_FeatureTypeID']) ?? '')?.toLowerCase();
    if (label === 'birthdate') {
      const date = ofacFeatureDate(feat);
      if (date) datesOfBirth.push(date);
    } else if (label === 'place of birth') {
      const place = asText(
        (feat.FeatureVersion as Record<string, unknown> | undefined)?.VersionLocation,
      );
      // Place often lives as free text in the VersionDetail; capture what's there.
      const detail = asText(
        (
          (feat.FeatureVersion as Record<string, unknown> | undefined)?.VersionDetail as Record<
            string,
            unknown
          >
        )?.['#text'] ?? (feat.FeatureVersion as Record<string, unknown> | undefined)?.VersionDetail,
      );
      const pob = detail ?? place;
      if (pob) placesOfBirth.push(pob);
    }
  }
  return { datesOfBirth, placesOfBirth };
}

/** Pull an ISO-ish birthdate out of a `<Feature>`'s nested `DatePeriod`. */
function ofacFeatureDate(feat: Record<string, unknown>): string | undefined {
  const version = (feat.FeatureVersion ?? {}) as Record<string, unknown>;
  const period = (version.DatePeriod ?? {}) as Record<string, unknown>;
  const start = (period.Start ?? {}) as Record<string, unknown>;
  const from = (start.From ?? {}) as Record<string, unknown>;
  return composeOfacDate(from);
}

/** Zip parallel DOB and POB lists into DobRecords (best-effort pairing by index). */
function mergeDobPob(dates: string[], places: string[]): DobRecord[] {
  const len = Math.max(dates.length, places.length);
  const out: DobRecord[] = [];
  for (let i = 0; i < len; i++) {
    out.push({ ...opt('date', dates[i]), ...opt('place', places[i]) } as DobRecord);
  }
  return out.filter((d) => d.date || d.place);
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
  const birthdates = asArray(e.birthdate as unknown)
    .map((b) => asText((b as Record<string, unknown>)['@_birthdate']))
    .filter((x): x is string => Boolean(x));
  const citizenships = asArray(e.citizenship as unknown)
    .map((c) => asText((c as Record<string, unknown>)['@_countryDescription']))
    .filter((x): x is string => Boolean(x));

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
      identifiers: [],
      addresses: [],
      datesOfBirth: birthdates.map((d) => ({ date: d })),
      nationalities: citizenships,
    },
  };
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
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: asArray(
        (d.Nationalities as Record<string, unknown> | undefined)?.Nationality as unknown,
      )
        .map((x) => asText(x))
        .filter((x): x is string => Boolean(x)),
      ...opt('remarks', asText(d.OtherInformation)),
    },
  };
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

  const dobs: DobRecord[] = asArray(e.INDIVIDUAL_DATE_OF_BIRTH)
    .map((d) => {
      const dd = d as Record<string, unknown>;
      return opt('date', asText(dd.DATE) ?? asText(dd.YEAR)) as DobRecord;
    })
    .filter((d) => d.date);

  const nationalities = asArray(
    (e.NATIONALITY as Record<string, unknown> | undefined)?.VALUE as unknown,
  )
    .map((v) => asText(v))
    .filter((x): x is string => Boolean(x));

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
      identifiers: asArray(e.INDIVIDUAL_DOCUMENT)
        .map((d) => {
          const dd = d as Record<string, unknown>;
          return {
            type: asText(dd.TYPE_OF_DOCUMENT) ?? 'Document',
            value: asText(dd.NUMBER) ?? '',
            ...opt('country', asText(dd.ISSUING_COUNTRY)),
          };
        })
        .filter((x) => x.value),
      addresses: [],
      datesOfBirth: dobs,
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
  /** Called once per source, after its records and deferred columns are applied. */
  onSourceReport?(report: SourceHarvestReport): void;
  /** Designations per yielded page. Defaults to {@link SYNC_PAGE_SIZE}. */
  pageSize?: number;
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
 * The mirror upserts the `designation` rows; the per-alias `name` index is
 * rebuilt from `designation.payload` afterwards by the service's
 * `rebuildNameIndex()`, which the lifecycle scripts and the refresh cron call.
 */
export function createSanctionsSync(options: SanctionsSyncOptions) {
  const pageSize = options.pageSize ?? SYNC_PAGE_SIZE;
  return async function* sync(ctx: {
    signal: AbortSignal;
  }): AsyncGenerator<{ checkpoint?: string; records: Record<string, string | number | null>[] }> {
    const ingesters = options.ingesters ?? buildSanctionsIngesters();
    const stamp = new Date().toISOString();
    for (const ingester of ingesters) {
      if (ctx.signal.aborted) return;
      let page: Record<string, string | number | null>[] = [];
      for await (const designation of ingester.harvest(ctx.signal)) {
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
      options.onSourceReport?.(ingester.report());
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
