/**
 * @fileoverview Sanctions ingesters — one per source (OFAC SDN, OFAC
 * Consolidated, EU FSF, UK Sanctions List, UN SC Consolidated). Each fetches the
 * source file, parses the XML, and maps records onto the common
 * {@link NormalizedDesignation} schema. The {@link createSanctionsSync} factory
 * wires them into the MirrorService `sync` generator: each refresh re-harvests
 * all sources in full (the combined corpus is tens of thousands of rows — no
 * delta logic needed), yielding one page per source.
 *
 * The XML shapes differ wildly across sources; each parser is defensive about
 * sparsity and arrays-of-one (fast-xml-parser collapses single children to
 * objects), and preserves absence rather than fabricating fields.
 * @module services/screening/sanctions-ingest
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
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

/** A source ingester: yields a full set of normalized designations for one list. */
export interface SanctionsIngester {
  /** Fetch + parse + normalize the full list. */
  harvest(signal: AbortSignal): Promise<NormalizedDesignation[]>;
  source: SourceCode;
  /** Source file URL (for provenance). */
  url(): string;
}

/** Browser-style UA — the UN SC domain returns 404 to bare requests. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 120_000;

/** Coerce fast-xml-parser's "single child → object, many → array" into an array. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
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

/** Fetch text with a browser UA, retry, and HTML-error-page detection. */
function fetchXml(url: string, signal: AbortSignal, source: string): Promise<string> {
  const reqCtx = requestContextService.createRequestContext({ operation: `harvest:${source}` });
  return withRetry(
    async () => {
      const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, reqCtx, {
        signal,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/xml, text/xml, */*' },
        redirect: 'follow',
      });
      const text = await response.text();
      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
        throw serviceUnavailable(`${source} returned HTML instead of XML — likely rate-limited.`);
      }
      return text;
    },
    { operation: `harvest:${source}`, baseDelayMs: 2000, signal },
  );
}

// ─── OFAC (SDN + Consolidated, advanced UN 1267/1988 schema) ────────────────────

/**
 * Parse one OFAC advanced-schema `<distinctParty>` (or the standard fallback
 * `<sdnEntry>`) shape. The advanced schema is the richest; we read the common
 * fields and keep the rest in `payload`. Robust to the two shapes via duck typing.
 */
function buildOfacIngester(
  source: 'ofac_sdn' | 'ofac_consolidated',
  urlGetter: () => string,
): SanctionsIngester {
  return {
    source,
    url: urlGetter,
    async harvest(signal) {
      const xml = await fetchXml(urlGetter(), signal, source);
      const doc = parseXml<Record<string, unknown>>(xml);
      return parseOfac(doc, source);
    },
  };
}

export function parseOfac(
  doc: Record<string, unknown>,
  source: SourceCode,
): NormalizedDesignation[] {
  // Standard schema: <sdnList><sdnEntry>. Advanced: <Sanctions><DistinctParties>.
  const sdnList = (doc.sdnList ?? doc.SDNList) as Record<string, unknown> | undefined;
  if (sdnList) {
    return asArray(sdnList.sdnEntry as unknown).map((e) =>
      parseOfacStandard(e as Record<string, unknown>, source),
    );
  }
  // Advanced schema (the configured default — SDN_ADVANCED.XML / CONS_ADVANCED.XML).
  const sanctions = (doc.Sanctions ?? doc.sanctions) as Record<string, unknown> | undefined;
  if (!sanctions) return [];
  const refs = buildOfacReferenceSets(sanctions);
  const programsByProfile = buildOfacProgramIndex(sanctions);
  const parties = sanctions.DistinctParties as Record<string, unknown> | undefined;
  return asArray(parties?.DistinctParty as unknown)
    .map((p) => parseOfacAdvanced(p as Record<string, unknown>, source, refs, programsByProfile))
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

function buildOfacReferenceSets(sanctions: Record<string, unknown>): OfacReferenceSets {
  const sets = (sanctions.ReferenceValueSets ?? {}) as Record<string, unknown>;
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
): Map<string, { program?: string; designationDate?: string }> {
  const out = new Map<string, { program?: string; designationDate?: string }>();
  const entries = (sanctions.SanctionsEntries ?? {}) as Record<string, unknown>;
  for (const raw of asArray(entries.SanctionsEntry as unknown)) {
    const e = raw as Record<string, unknown>;
    const profileId = asText(e['@_ProfileID']);
    if (!profileId) continue;
    const programs = asArray(e.SanctionsMeasure as unknown)
      .map((m) => asText((m as Record<string, unknown>).Comment))
      .filter((x): x is string => Boolean(x));
    const event = (e.EntryEvent ?? {}) as Record<string, unknown>;
    const designationDate = composeOfacDate(event.Date as Record<string, unknown> | undefined);
    const existing = out.get(profileId) ?? {};
    out.set(profileId, {
      ...existing,
      ...(programs.length ? { program: programs.join(', ') } : {}),
      ...(designationDate ? { designationDate } : {}),
    });
  }
  return out;
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

function parseOfacStandard(e: Record<string, unknown>, source: SourceCode): NormalizedDesignation {
  const uid = asText(e.uid) ?? crypto.randomUUID();
  const first = asText(e.firstName);
  const last = asText(e.lastName);
  const sdnType = asText(e.sdnType)?.toLowerCase();
  const primaryName = [first, last].filter(Boolean).join(' ').trim() || last || first || 'Unknown';

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
    .filter((a) => a.name);

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
 * profile id. Resilient to the deep nesting and to sparse records.
 */
function parseOfacAdvanced(
  p: Record<string, unknown>,
  source: SourceCode,
  refs: OfacReferenceSets,
  programsByProfile: Map<string, { program?: string; designationDate?: string }>,
): NormalizedDesignation | null {
  const profile = (p.Profile ?? p.profile) as Record<string, unknown> | undefined;
  const id = asText(p['@_FixedRef']) ?? asText(p['@_ID']) ?? crypto.randomUUID();

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
        if (!name) continue;
        collected.push({
          name,
          isPrimary: aliasPrimary,
          nameType: ofacAliasNameType(aliasLabel, lowQuality, aliasPrimary),
        });
      }
    }
  }
  const firstName = collected[0];
  if (!firstName) return null;

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

function buildEuIngester(): SanctionsIngester {
  return {
    source: 'eu',
    url: () => getServerConfig().euFsfUrl,
    async harvest(signal) {
      const xml = await fetchXml(getServerConfig().euFsfUrl, signal, 'eu');
      const doc = parseXml<Record<string, unknown>>(xml);
      return parseEu(doc);
    },
  };
}

export function parseEu(doc: Record<string, unknown>): NormalizedDesignation[] {
  const root = (doc.export ?? doc) as Record<string, unknown>;
  const entities = asArray((root.sanctionEntity ?? root.SanctionEntity) as unknown);
  return entities
    .map((raw) => {
      const e = raw as Record<string, unknown>;
      const id =
        asText(e['@_logicalId']) ?? asText(e['@_euReferenceNumber']) ?? crypto.randomUUID();
      const subjectType = (e.subjectType as Record<string, unknown> | undefined)?.['@_code'];
      const nameAliases = asArray(e.nameAlias as unknown)
        .map((n) => {
          const na = n as Record<string, unknown>;
          const whole = asText(na['@_wholeName']);
          const strong = asText(na['@_strong']);
          return {
            name:
              whole ??
              [asText(na['@_firstName']), asText(na['@_lastName'])].filter(Boolean).join(' '),
            strong: strong !== 'false',
          };
        })
        .filter((n) => n.name);
      const primary = nameAliases[0]?.name;
      if (!primary) return null;
      const birthdates = asArray(e.birthdate as unknown)
        .map((b) => asText((b as Record<string, unknown>)['@_birthdate']))
        .filter((x): x is string => Boolean(x));
      const citizenships = asArray(e.citizenship as unknown)
        .map((c) => asText((c as Record<string, unknown>)['@_countryDescription']))
        .filter((x): x is string => Boolean(x));

      return {
        id: `eu:${id}`,
        source: 'eu' as const,
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
    })
    .filter(Boolean) as NormalizedDesignation[];
}

function mapEuType(code: string | undefined): EntityType {
  if (code === 'P' || code?.toLowerCase() === 'person') return 'person';
  if (code === 'E' || code?.toLowerCase() === 'enterprise') return 'organization';
  return 'unknown';
}

// ─── UK Sanctions List (UKSL, FCDO) ─────────────────────────────────────────────

function buildUkIngester(): SanctionsIngester {
  return {
    source: 'uk',
    url: () => getServerConfig().ukSanctionsUrl,
    async harvest(signal) {
      const xml = await fetchXml(getServerConfig().ukSanctionsUrl, signal, 'uk');
      const doc = parseXml<Record<string, unknown>>(xml);
      return parseUk(doc);
    },
  };
}

export function parseUk(doc: Record<string, unknown>): NormalizedDesignation[] {
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
    .map((raw) => {
      const d = raw as Record<string, unknown>;
      const id =
        asText(d.UniqueID) ??
        asText(d.OFSIGroupID) ??
        asText(d['@_UniqueID']) ??
        crypto.randomUUID();
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
        .filter((n): n is { name: string; type: string | undefined } => Boolean(n.name));
      const fallbackName =
        asText(d.Name) ?? asText((d.Names as Record<string, unknown> | undefined)?.WholeName);
      const allNames = names.length
        ? names
        : fallbackName
          ? [{ name: fallbackName, type: 'Primary name' as string | undefined }]
          : [];
      const primary = allNames[0]?.name;
      if (!primary) return null;

      return {
        id: `uk:${id}`,
        source: 'uk' as const,
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
    })
    .filter(Boolean) as NormalizedDesignation[];
}

function mapUkType(t: string | undefined): EntityType {
  const v = t?.toLowerCase();
  if (v === 'individual' || v === 'person') return 'person';
  if (v === 'entity' || v === 'organisation' || v === 'organization') return 'organization';
  if (v === 'ship' || v === 'vessel') return 'vessel';
  return 'unknown';
}

// ─── UN Security Council Consolidated List ───────────────────────────────────────

function buildUnIngester(): SanctionsIngester {
  return {
    source: 'un',
    url: () => getServerConfig().unScUrl,
    async harvest(signal) {
      const xml = await fetchXml(getServerConfig().unScUrl, signal, 'un');
      const doc = parseXml<Record<string, unknown>>(xml);
      return parseUn(doc);
    },
  };
}

export function parseUn(doc: Record<string, unknown>): NormalizedDesignation[] {
  const root = (doc.CONSOLIDATED_LIST ?? doc) as Record<string, unknown>;
  const individuals = asArray(
    (root.INDIVIDUALS as Record<string, unknown> | undefined)?.INDIVIDUAL as unknown,
  ).map((i) => parseUnEntry(i as Record<string, unknown>, 'person'));
  const entities = asArray(
    (root.ENTITIES as Record<string, unknown> | undefined)?.ENTITY as unknown,
  ).map((e) => parseUnEntry(e as Record<string, unknown>, 'organization'));
  return [...individuals, ...entities].filter(Boolean) as NormalizedDesignation[];
}

function parseUnEntry(
  e: Record<string, unknown>,
  entityType: EntityType,
): NormalizedDesignation | null {
  const id = asText(e.DATAID) ?? asText(e.REFERENCE_NUMBER) ?? crypto.randomUUID();
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
  if (!primary) return null;

  const aliases: NameRecord[] = asArray(e.INDIVIDUAL_ALIAS ?? e.ENTITY_ALIAS)
    .map((a) => {
      const al = a as Record<string, unknown>;
      const quality = asText(al.QUALITY)?.toLowerCase();
      return {
        name: asText(al.ALIAS_NAME) ?? '',
        nameType: (quality === 'low' ? 'low-quality-aka' : 'aka') as NameRecord['nameType'],
      };
    })
    .filter((a) => a.name);

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

/**
 * The MirrorService `sync` generator for the sanctions designation mirror. Each
 * run harvests every source in full and yields one page per source. The mirror
 * upserts the `designation` rows; the per-alias `name` index is rebuilt from
 * `designation.payload` after the sync by the service's `rebuildNameIndex()`
 * (the lifecycle scripts and the refresh cron call it). `init` and `refresh`
 * behave identically — these are small, fully re-harvested corpora.
 */
export function createSanctionsSync() {
  return async function* sync(ctx: {
    signal: AbortSignal;
  }): AsyncGenerator<{ records: Record<string, string | number | null>[]; checkpoint?: string }> {
    const ingesters = buildSanctionsIngesters();
    const stamp = new Date().toISOString();
    for (const ingester of ingesters) {
      if (ctx.signal.aborted) return;
      const designations = await ingester.harvest(ctx.signal);
      yield {
        records: designations.map(toDesignationRow),
        checkpoint: stamp,
      };
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
