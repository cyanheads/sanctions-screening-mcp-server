# sanctions-screening-mcp-server — Design

Entity screening and resolution as one workflow over the world's open sanctions data plus the global legal-entity registry. Screens names against the consolidated US (OFAC), EU, UK, and UN sanctions lists, and resolves legal entities against the GLEIF LEI database with corporate-ownership tracing. All sources are bulk, keyless, freely redistributable, and mirrored to a local SQLite + FTS5 index — the server answers "is this entity on a watchlist?" and "who is this legal entity, and who owns it?" offline, fuzzy-matched.

> **This server is a screening *aid*, not a compliance determination.** Every tool returns *potential matches* with a transparent score and source provenance — never a verdict. A hit means "review this candidate against the official source"; an empty result never means "cleared." Real sanctions compliance is a legal process this server feeds, not one it performs.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `sanctions_screen_name` | The 80% entry point. Screens a name (person, company, vessel, aircraft) against all loaded watchlists (OFAC SDN + Consolidated, EU, UK, UN) at once, alias- and fuzzy-aware. Returns scored potential matches with source list, program, designation date, and the matched alias. Decision support — a hit is a candidate to verify, not a determination. | `name` (string), `entityType` (enum: any/person/organization/vessel/aircraft), `matchMode` (enum: strict/fuzzy, default strict), `minScore` (0–1, fuzzy only), `sources` (array of list codes, default all), `limit` (default 25), `offset` (default 0) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_screen_identifier` | The identifier-first entry point. Looks up a vessel IMO number, SWIFT/BIC code, digital-currency wallet address, passport or national ID number — or any other identifier a list publishes — against every loaded list at once. Exact match after normalization, never fuzzy and never scored; one hit per designation with the identifiers that matched, as published. Decision support — a hit is a candidate to verify, an empty result is not a clearance. | `value` (string), `type` (enum: any/imo/swift_bic/digital_currency_address/passport/national_id, default any), `sources` (array of list codes, default all) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_get_designation` | Full record for one sanctions entry by source list + entry ID or the list's published reference number (UN `REFERENCE_NUMBER`, EU `euReferenceNumber`, UK OFSI Group ID), matched trimmed and case-insensitive, entry ID first. All aliases, identifiers (identity documents plus published SWIFT/BIC codes, digital-currency addresses, vessel and aircraft identifiers, phone numbers, emails, websites), addresses, dates/places of birth at published precision, nationalities, sanctioning program, legal basis, and designation date. The drill-in after `sanctions_screen_name` surfaces a candidate. | `source` (enum: ofac_sdn/ofac_consolidated/eu/uk/un), `entryId` (string) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_resolve_entity` | Resolves a company/organization name (+ optional jurisdiction) to candidate GLEIF LEIs, ranked, one per LEI. Name → canonical global identifier. The bridge from a free-text counterparty name to a stable LEI other tools key off. Matches every name GLEIF publishes — legal, previous, trading, alternative-language, and ASCII-transliterated — and reports the matched name with its type. | `name` (string), `jurisdiction` (optional: a country code, which includes its ISO 3166-2 subdivisions, or a subdivision code, matched exactly), `matchMode` (enum: strict/fuzzy, default strict), `status` (enum: any/issued/lapsed, default issued; `lapsed` is exactly `LAPSED`, other non-issued states need `any`), `limit` (default 10), `offset` (default 0) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_get_entity` | Full GLEIF Level 1 record for one LEI: legal name, other names (plain, and typed beside the transliterated names in `alternateNames`), legal + headquarters address, registration status, jurisdiction, registration authority and ID, last-update date — plus any sanctions hits screened against the same name. | `lei` (20-char LEI, regex-validated) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_trace_ownership` | GLEIF Level 2 ownership graph for an LEI: direct and ultimate parents and children, with relationship type and accounting basis. Each node whose parents were walked reports what GLEIF publishes about its direct and ultimate parent: a relationship, a reporting exception with its reasons, none, or unknown when exceptions are not loaded. Optionally screens every node against the watchlists, an ownership-chain cross-reference that single-list tools can't do. | `lei` (20-char LEI), `direction` (enum: parents/children/both, default both), `depth` (1–5, default 3), `screenNodes` (boolean, default false) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_list_sources` | The watchlists and GLEIF datasets currently loaded, each with record count, source URL, and license, plus each mirror's readiness and as-of timestamp (one for the sanctions mirror, one for GLEIF), and whether GLEIF reporting exceptions are loaded, with their count once they are. Provenance and freshness for any result. | *(none)* | `readOnlyHint`, `openWorldHint: false` |

Seven tools. No write tools (the corpus is upstream-owned and read-only), no app tools, no catastrophically-irreversible operations.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `sanctions://designation/{source}/{entryId}` | One sanctions entry by source + entry ID or published reference number, resolved as the tool resolves it; the `entryId` variable is percent-decoded once before lookup. Read-only mirror of `sanctions_get_designation` for clients that inject context by URI. | None (single record) |
| `sanctions://entity/{lei}` | One GLEIF Level 1 entity by LEI. Read-only mirror of `sanctions_get_entity`'s entity payload (without the screening cross-reference). | None (single record) |
| `sanctions://sources` | Loaded lists + GLEIF datasets with counts, plus each mirror's readiness and as-of timestamp. Read-only mirror of `sanctions_list_sources`. | None (small fixed list) |

All resource data is fully reachable through the tool surface — resources are a convenience for resource-capable clients only.

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `sanctions_vet_counterparty` | Structures a full counterparty due-diligence pass: resolve the name to an LEI, pull its GLEIF ownership graph, screen the named entity and every parent and subsidiary in it against all lists, and summarize hits with provenance and the decision-support caveat. GLEIF parents are accounting-consolidation parents, not beneficial owners, and the prompt says so. Frames the multi-tool workflow the moonshot describes. | `name` (string), `jurisdiction` (optional: a country code, which includes its subdivisions, or an ISO 3166-2 subdivision code) |

One prompt. It orchestrates the existing tools — no new capability, just a reusable framing of the cross-tool workflow.

---

## Overview

The fleet has deep US financial/government data — `secedgar` (public companies), `usaspending` (federal awards), `openfec` (campaign finance), `nonprofit-explorer` (501(c)s) — but no way to **screen** an entity against sanctions or resolve it to a canonical **global identifier**. This server is the compliance / due-diligence layer those feed into.

It aggregates five upstream sources behind one screening-and-resolution workflow. The agent sees screening verbs (`screen_name`, `resolve_entity`, `trace_ownership`), never which list was queried — sources are service-layer details. All five are bulk-downloadable, keyless, and clear for redistribution, so the server mirrors them to a local index and serves matches offline.

**Audience:** compliance / AML / KYC analysts, fintech and payments builders, journalists and OSINT researchers tracing entities, procurement teams, and agents asked to vet a counterparty.

**Sources behind the surface:**

| Source | Role | Format | Cadence |
|:-------|:-----|:-------|:--------|
| OFAC SDN + Consolidated (US Treasury) | Primary US sanctions/watchlist — individuals, entities, vessels, aircraft, with a.k.a. aliases | XML (standard + advanced) | Per-update (SDN and Consolidated on separate schedules) |
| EU Consolidated Financial Sanctions List | EU-designated persons/entities | XML (`xmlFullSanctionsList_1_1`) | Daily |
| UK Sanctions List (UKSL, FCDO) | UK sanctions targets — persons, entities, ships | XML / CSV | Per-update |
| UN Security Council Consolidated List | UN-designated individuals/entities (all regimes) | XML | Per-update (follows committee decisions) |
| GLEIF LEI Level 1 + Level 2 | Who-is-who (entity reference) + who-owns-whom (parent/child ownership) | XML / CSV / JSON golden copy + deltas | 3×/day (02:00 / 10:00 / 18:00 UTC) |

## Requirements

- **Read-only, keyless, offline-first.** No upstream API key for any source. The primary data path is the local mirror, not the live source. No write operations — the corpus is upstream-owned.
- **Screen a name against all four sanctions lists at once**, alias- and fuzzy-aware, with per-list provenance and a transparent match score.
- **Resolve a name to a canonical LEI** and pull the full entity record + corporate-ownership graph.
- **Screen the ownership chain**, not just the named counterparty: every GLEIF parent and subsidiary, and where GLEIF names no parent, the reason it gives. This is the workflow that justifies one server over two.
- **Match quality is the core requirement:** catch aliases, transliterations, name-order swaps, and partials. Strict token match by default; scored fuzzy fallback labeled `approximate`. Surface real signal (match type, matched alias, similarity score, source list) — never a fabricated confidence percentage.
- **Provenance and freshness on every result** — which list, designation date, and the mirror's as-of timestamp.
- **Decision-support framing is load-bearing** and must appear in tool descriptions and output: potential matches to verify, never a determination; a miss is never a clearance.
- **Licensing obligations:** attribute UK data under Open Government Licence v3.0; cite all sources. GLEIF is CC0 (no attribution required but cited anyway). No source carries an anti-AI or anti-redistribution clause.
- **Auth:** none (read-only, public data). stdio + HTTP; no per-tool scopes.

## Services

One service per source (each owns its own fetch + parse + normalize), plus one screening/index service that owns the shared mirror and the matching engine. Tools compose across services; the agent never sees the service boundary.

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ofac-service` | OFAC SLS XML (SDN + Consolidated, advanced schema) → normalized designations | mirror ingest |
| `eu-fsf-service` | EU consolidated XML (`xmlFullSanctionsList_1_1`, public token) → normalized designations | mirror ingest |
| `uk-sanctions-service` | UKSL XML/CSV (`sanctionslist.fcdo.gov.uk`) → normalized designations | mirror ingest |
| `un-sc-service` | UN SC Consolidated XML → normalized designations (HTTP client must send a browser-style `User-Agent` — bare requests return 404) | mirror ingest |
| `gleif-service` | GLEIF golden-copy + delta files (LEI-CDF L1, RR-CDF L2) → entity + relationship rows | mirror ingest |
| `screening-service` | The local mirror (MirrorService) + the normalization schema + the matching engine | all seven tools |

Each sanctions service is a `sync` ingester for the MirrorService: it fetches the source file, parses it (XML via a streaming parser to stay within memory on GLEIF's ~892 MB compressed L1), maps records onto the common normalized schema, and yields pages. `screening-service` owns `defineMirror`, query translation (free-text → FTS5 `MATCH`), and the strict/fuzzy match pipeline.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `SANCTIONS_MIRROR_PATH` | No (default `./data/sanctions.db`) | Filesystem path for the SQLite mirror. On a hosted deployment, a persistent volume. |
| `SANCTIONS_REFRESH_CRON` | No (default `0 4 * * *`) | Cron for the scheduled refresh (HTTP transport only): the sanctions lists + name and identifier indexes, then the GLEIF delta windows the checkpoint calls for, under one 4-hour bound. A GLEIF gap that needs `mirror:init` is logged, never loaded in-process. |
| `SANCTIONS_REFRESH_SKIP_GLEIF` | No | `1` skips the GLEIF leg of the scheduled refresh and of `mirror:refresh`. |
| `SANCTIONS_FUZZY_MIN_SCORE` | No (default `0.85`) | Default Jaro-Winkler similarity floor for fuzzy matches when the caller omits `minScore`. |
| `SANCTIONS_FUZZY_MAX_RESULTS` | No (default `50`) | Hard cap on fuzzy candidates scored per query, to bound work on short queries against many long names. |
| `OFAC_SDN_URL` | No (default official SLS URL) | Override for the OFAC SDN advanced-XML file. |
| `OFAC_CONSOLIDATED_URL` | No (default official SLS URL) | Override for the OFAC Consolidated advanced-XML file. |
| `EU_FSF_URL` | No (default official `webgate` URL incl. public token) | Override for the EU consolidated XML file. |
| `UK_SANCTIONS_URL` | No (default `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml`) | Override for the UKSL XML file. |
| `UN_SC_URL` | No (default official UN SC Consolidated XML URL) | Override for the UN consolidated XML file. |
| `GLEIF_GOLDEN_COPY_BASE_URL` | No (default `https://goldencopy.gleif.org` API) | Override for the GLEIF golden-copy / delta download API. |

All source URLs default to the verified official endpoints; overrides exist for testing and for pinning a mirror in restricted environments. No secret values — every source is keyless (the EU "token" is a static public path component, not a credential).

## Implementation Order

1. **Config + server setup** — `server-config.ts`, `createApp({ name: 'sanctions-screening-mcp-server', title: 'sanctions-screening-mcp-server', ... })`, wire the refresh cron in `setup()` (HTTP-gated; sanctions lists, then GLEIF deltas).
2. **Normalization schema + screening-service skeleton** — `defineMirror` + `sqliteMirrorStore` with the primary `designation` table, FTS over `normalized_name`, and the auxiliary `name`, `lei_entity`, `lei_relationship` tables (via the `raw()` handle + migrations). The matching engine (strict token match first; fuzzy + phonetic second).
3. **Sanctions ingesters** — `ofac-service`, `un-sc-service`, `uk-sanctions-service`, `eu-fsf-service` as `sync` generators. These re-harvest in full each refresh (small corpora, no delta logic). Independently testable against a captured sample file each.
4. **Read-only sanctions tools** — `sanctions_screen_name`, `sanctions_get_designation`, `sanctions_list_sources`. Testable against the mirror once sanctions ingest lands.
5. **GLEIF ingester** — `gleif-ingest` + `gleif-sync`: init from the golden-copy Level 1, Level 2, and reporting-exception files (streaming parse). Refresh from the delta window each dataset's checkpoint calls for (streaming, deletions applied). The heaviest leg; build it after the sanctions path proves the schema.
6. **LEI tools** — `sanctions_resolve_entity`, `sanctions_get_entity`, `sanctions_trace_ownership` (with optional per-node screening).
7. **Resources** — three URI-addressable read-only views.
8. **Prompt** — `sanctions_vet_counterparty`.

Each step is independently testable; a captured sample file per source lets ingesters and tools be tested without live downloads.

---

## Domain Mapping

| Noun | Operations | Becomes |
|:-----|:-----------|:--------|
| Sanctions designation | screen-by-name (all lists), look-up-by-identifier (all lists), get-by-id-or-reference, list-loaded-sources | `sanctions_screen_name`, `sanctions_screen_identifier`, `sanctions_get_designation`, `sanctions_list_sources` |
| Legal entity (LEI) | resolve-name-to-LEI, get-by-LEI, trace-ownership | `sanctions_resolve_entity`, `sanctions_get_entity`, `sanctions_trace_ownership` |
| Ownership relationship | direct/ultimate parents, children, per-node screen | folded into `sanctions_trace_ownership` |
| Alias / a.k.a. | indexed, searched | raw material — feeds `screen_name`/`resolve_entity` matching, not its own tool |

### Normalized schema (across all sanctions sources)

Primary `designation` table — one row per (source, entry):

| Column | Type | Notes |
|:-------|:-----|:------|
| `id` | TEXT (PK) | `{source}:{entry_id}` composite |
| `source` | TEXT | `ofac_sdn` / `ofac_consolidated` / `eu` / `uk` / `un` |
| `source_entry_id` | TEXT | The list's own entry ID (for `get_designation`) |
| `entity_type` | TEXT | `person` / `organization` / `vessel` / `aircraft` / `unknown` |
| `primary_name` | TEXT | As published |
| `normalized_name` | TEXT | Folded: NFKD, combining marks stripped, lowercased, `ς`→`σ`, Arabic tatweel dropped, every run outside `[\p{L}\p{N}]` (or inside the Spacing Modifier Letters block, whose `ʼ` `ʻ` `ʹ` `ˮ` stand in for an apostrophe or quote) collapsed to one space. Letters and digits of every script survive — FTS-indexed |
| `program` | TEXT | Sanctioning program / regime |
| `legal_basis` | TEXT | Statutory/regulatory basis where published |
| `designation_date` | TEXT | The source's own designation date, `YYYY-MM-DD`: OFAC `SanctionsEntry/EntryEvent/Date`, the EU entity's `@designationDate`, UK `DateDesignated`, UN `LISTED_ON` with any UTC offset dropped. NULL when unpublished — never a last-update or regulation date |
| `reference_number` | TEXT | The list's published reference number, trimmed: UN `REFERENCE_NUMBER` (`QDe.004`), the EU entity's `@euReferenceNumber` (`EU.27.28`), UK `OFSIGroupID` (the legacy OFSI Group ID — none for a designation made after 28 Jan 2026, and one ID can cover two designations). NULL for OFAC, whose `FixedRef` entry ID is its published number. Added by schema version 2's migration; indexed case-insensitively on `(source, reference_number)` |
| `payload` | TEXT (JSON) | Full normalized record — aliases[], identifiers[], addresses[], datesOfBirth[], nationalities[], remarks — for `get_designation` |

Where each `payload` detail group comes from:

| Group | OFAC advanced (`SDN_ADVANCED.XML` / `CONS_ADVANCED.XML`) | OFAC standard (`<sdnEntry>`) | EU `sanctionEntity` | UK `Designation` | UN `INDIVIDUAL` / `ENTITY` |
|:--|:--|:--|:--|:--|:--|
| `identifiers` `{type, value, country?}` | `<IDRegDocument>` joined on `IdentityID` = the party's `<Identity ID>`: `IDRegDocType` label, `IDRegistrationNo`, `IssuedBy-CountryID` name; then each identifier-class text `<Feature>` — `SWIFT/BIC`, `Website`, `Email Address`, `Phone Number`, `Vessel Call Sign`, `Other Vessel Call Sign`, `Aircraft Tail Number`, `Previous Aircraft Tail Number`, `Aircraft Manufacturer's Serial Number (MSN)`, `Aircraft Construction Number (also called L/N or S/N or F/N)`, `Aircraft Mode S Transponder Code`, `D-U-N-S Number`, `BIK (RU)`, `ISIN`, `Equity Ticker`, `MICEX Code`, `UN/LOCODE`, and every `Digital Currency Address - <code>` — typed by its label verbatim, the `VersionDetail` text as value, no country | `idList/id` whose `idType` is one of the advanced schema's identifier classes — an identity-document type or an identifier-class feature label — with `idCountry`; then `vesselInfo/callSign` as `Vessel Call Sign` | `identification`: `identificationTypeDescription`, `number`, `countryDescription` | `PassportNumber`, `NationalIdentifierNumber`, `BusinessRegistrationNumber`, `IMONumber`, then `PhoneNumbers/PhoneNumber`, `EmailAddresses/EmailAddress`, `Websites/Website` typed `Phone Number`, `Email Address`, `Website` (OFAC's labels); typed by element, no country | `INDIVIDUAL_DOCUMENT`: `TYPE_OF_DOCUMENT`, `NUMBER`, `ISSUING_COUNTRY`, else `COUNTRY_OF_ISSUE` |
| `addresses` `{full, country?}` | `Location` feature → `<VersionLocation LocationID>` → `<Location>` | `addressList/address` incl. `address3` | `address`: `street`, `poBox`, `place`, `city`, `region`, `zipCode`, `countryDescription` | `Addresses/Address`: `AddressLine1`–`6`, `AddressPostalCode`, `AddressCountry` | `INDIVIDUAL_ADDRESS` / `ENTITY_ADDRESS`: `STREET`, `CITY`, `STATE_PROVINCE`, `ZIP_CODE`, `COUNTRY` |
| `datesOfBirth` `{date?, circa?, place?}` | `Birthdate` feature: the whole `DatePeriod` (`Start`/`End` × `From`/`To`), circa from `Approximate`; place from the `Place of Birth` feature's `VersionDetail` | `dateOfBirthList` display text (`26 Aug 1988`, `Aug 1946`, `circa 1951`, `1955 to 1957`) + `placeOfBirthList` | `birthdate`, else `year` (plus `monthOfYear` when published), else `yearRangeFrom`/`yearRangeTo`; circa from `circa`; place from `place`, `city`, `region`, `countryDescription` of the same element | `IndividualDetails/Individual/DOBs/DOB` (`DD/MM/YYYY`, a `dd`/`mm`/`00` placeholder component absent); place from `BirthDetails/Location` (`TownOfBirth`, `CountryOfBirth`) | `DATE`, else `YEAR`, else `FROM_YEAR/TO_YEAR`; circa from `TYPE_OF_DATE` `APPROXIMATELY`; place from `INDIVIDUAL_PLACE_OF_BIRTH` |
| `nationalities` | `Nationality Country` and `Citizenship Country` features → the target `<Location>`'s text | `nationalityList` + `citizenshipList` | `citizenship/@countryDescription` | `IndividualDetails/Individual/Nationalities/Nationality` | `NATIONALITY/VALUE` |

Rules every normalizer follows:

- **`full` address** — the published components most specific first, the country last, joined with `, `; `country` is set when published. OFAC advanced renders parts in `ADDRESS1`, `ADDRESS2`, `ADDRESS3`, `CITY`, `STATE/PROVINCE`, `POSTAL CODE`, `REGION` order, each from its `Primary="true"` value (original-script variants are non-primary), then the `LocationCountry` name. A nationality target carries no `LocationCountry`; its one `Unknown`-typed part is the country name.
- **Absence stays absence** — a component with no letter or digit, a whole-value placeholder (EU `UNKNOWN`, UN `na`, matched case-insensitively), and OFAC's `undetermined` country or area-code-only `<Location>` are not published values; an entry with no published component is skipped. The placeholder test never sees a name (the surname `Na` stands) or a country code (every country is read by name, so Namibia's `NA` code never reaches it). Nothing is inferred across groups (an address country is never a nationality).
- **Duplicates** — exact duplicates within one group collapse, first-published order kept.
- **Dates at published precision** — a date of birth is ISO 8601 at the precision the source published: `YYYY-MM-DD`, `YYYY-MM`, or `YYYY`, or an interval whose ends keep their own precision (`1955/1957`, `1946-09-26/1946-12-07`, `../1980` for an open end). OFAC advanced reads the whole `DatePeriod`: a period spanning exactly one day, month, or year is that unit; otherwise each end takes the precision of its own `From`…`To` window. `circa: true` marks a date its source flags approximate and never appears without `date`; a circa year and the same exact year are two entries. A value with no ISO form (UK `15/08/19yy`) stays as published.
- **Birth pairing** — where dates and places are separate lists (OFAC, UK, UN), a date is paired with a place only when the record publishes exactly one of each; otherwise each is its own entry. EU birthplaces come from the same `<birthdate>` element as the date, so they stay paired.
- **OFAC lookups** — feature, location-part, document-type, and country IDs resolve by label through `<ReferenceValueSets>`. A reference to an ID the document never published (a `LocationID`, an `IdentityID`, a document type) drops that one entry; the party still ingests and nothing counts as a rejection.

Auxiliary `name` table (the matching index) — one row **per name and per alias**, so a query matches across all of an entity's names at once:

| Column | Type | Notes |
|:-------|:-----|:------|
| `designation_id` | TEXT | FK → `designation.id` |
| `name` | TEXT | One primary name or alias as published |
| `normalized` | TEXT | Folded form, same fold as `normalized_name` — FTS-indexed (`unicode61 remove_diacritics 2`) |
| `phonetic` | TEXT | Double-Metaphone key of `normalized`'s all-Latin tokens (empty for a name with none) — indexed, for transliteration-class fuzzy hits |
| `name_type` | TEXT | `primary` / `aka` / `fka` / `low-quality-aka` |

Auxiliary `designation_identifier` table (the exact-lookup index) — one row per published identifier, rewritten with `name` by every ingest and every post-sync rebuild; the one-row `designation_identifier_stamp` beside it records the sync run the index was last rebuilt after:

| Column | Type | Notes |
|:-------|:-----|:------|
| `designation_id` | TEXT | FK → `designation.id`; lookups join `designation`, so a removed designation never surfaces |
| `category` | TEXT | `imo` / `swift_bic` / `digital_currency_address` / `passport` / `national_id` / `other`, from the published label (whitespace-collapsed, case-insensitive) |
| `key` | TEXT | The value under its category's rule — indexed with `category` |
| `type`, `value`, `country` | TEXT | The identifier as published, returned in `matchedIdentifiers` |

| Category | Published labels |
|:--|:--|
| `imo` | OFAC `Vessel Registration Identification`, UK `IMO Number`, EU `IMO (vessel identification)` |
| `swift_bic` | OFAC `SWIFT/BIC`, EU `SWIFT BIC` |
| `digital_currency_address` | OFAC `Digital Currency Address - <code>` |
| `passport` | `Passport`, `Diplomatic Passport`, `British National Overseas Passport`, `Stateless Person Passport`, EU `National passport`, UN `Número de pasaporte`, `Numéro de passeport` |
| `national_id` | OFAC `National ID No.`, `Tazkira National ID Card`, EU `National identification card`, UK `National Identifier`, UN `National Identification Number` |
| `other` | Every other label (MMSI, call signs, tail numbers, tax and registration numbers, email, websites, …) |

Key rules: NFKC, uppercase, whitespace and `-./` dropped; `imo` also drops a leading `IMO`; `swift_bic` keeps the first eight characters, so a branch BIC11 matches its institution's BIC8; `digital_currency_address` keeps case, dropping only whitespace and `-./`, and folds to lowercase only a hex (`0x…`), single-case bech32 (`bc1…`, `ltc1…`, `bnb1…`), or single-case cashaddr (optional `bitcoincash:` prefix) address — base58 stays case-significant. A caller's value is keyed under every category's rule for `type: any`, or under the named one.

GLEIF `lei_entity` (Level 1) and `lei_relationship` (Level 2) tables are separate (different lifecycle, far larger): `lei_entity(lei PK, legal_name, normalized_name [FTS], other_names, jurisdiction, status, legal_address, hq_address, registration_authority_id, registration_authority_entity_id, last_update, payload)`; `lei_relationship(child_lei, parent_lei, relationship_type, relationship_status, relationship_period)` indexed on both `child_lei` and `parent_lei` for bidirectional traversal. `status` is `RegistrationStatus` alone, never the `EntityStatus` vocabulary. The payload keeps `otherNames` as plain strings and adds `alternateNames` — each `OtherEntityName` and `TransliteratedOtherEntityName` with its GLEIF `type`.

Resolution reads a per-name index, `lei_name`, on the `name` table's pattern: one row per distinct folded name of an entity — the legal name (`LEGAL_NAME`), then each other and transliterated name with its type — written in the same transaction as the entity's upsert on every Level 1 write. Its FTS5 index `lei_name_fts` (`unicode61 remove_diacritics 2`, `prefix='2 3'`) covers three columns:

| Column | Holds | Serves |
|:-------|:------|:-------|
| `normalized` | The name's fold tokens | Strict all-tokens match; fuzzy token-prefix blocking |
| `suffix_terms` | Every proper suffix (≥2 code points) of each token in a script written without word separators (Han, Kana, Thai, Lao, Khmer, Myanmar) | Fuzzy blocking that reaches such a name mid-token |
| `jurisdiction_terms` | `jc<country> jx<code>` (`US-CA` → `jcus jxusca`) | The jurisdiction filter, intersected inside the lookup: a country matches `jc`, a subdivision its own `jx` |

`lei_name_stamp` records a completed build as the GLEIF sync state's `completedAt`. The index serves resolution only while the stamp matches, so a mirror an earlier release wrote, which gains the tables empty on open, keeps resolving over the legal-name `lei_entity_fts` until `mirror:init` loads the golden copy.

## Workflow Analysis

Two tools make multiple internal calls; the rest are single mirror reads.

`sanctions_trace_ownership` (1 + N reads, optional screen per node):

| # | Call | Purpose | Gate |
|:--|:-----|:--------|:-----|
| 1 | `lei_entity` lookup | Resolve root entity, confirm LEI exists | always |
| 2 | `lei_relationship` traversal (BFS to `depth`) | Walk parents and/or children | `direction` |
| 3 | `lei_entity` batch (`getByIds`) | Hydrate each node's name/jurisdiction | always |
| 4 | `name` FTS match per node | Screen each owner against the watchlists | `screenNodes: true` |

`sanctions_vet_counterparty` prompt → orchestrates `resolve_entity` → `trace_ownership(screenNodes: true)` → `screen_name` on the root → summary. No new upstream calls; it sequences existing tools.

The matching engine inside `screen_name` / `resolve_entity`:

| Step | Mechanism | Output label |
|:-----|:----------|:-------------|
| 0 | Normalize query (fold + tokenize) | — |
| 1 | Exact normalized equality against `name.normalized` | `exact` |
| 2 | Strict token match — every query token present (FTS5 `MATCH`, AND of tokens) | `strong` |
| 3 | *(fuzzy only)* Jaro-Winkler ≥ `minScore` against the best-matching alias token, capped at `SANCTIONS_FUZZY_MAX_RESULTS` | `approximate` |
| 3b | *(fuzzy only)* Phonetic-key equality (Double Metaphone) for transliteration misses | `approximate` |

Steps 1–2 are the ~90% path and need no fuzzy library. Step 3 fires only when strict returns nothing (or when `matchMode: 'fuzzy'` is explicit). Every result carries `matchType` and the `matchedName` string, and — for `approximate` — the raw `score` and the `queryTokenCoverage` count. When fuzzy also returns nothing, the tool says so and points the caller to browse via a broader query rather than guessing.

## Design Decisions

- **Multi-source, workflow-organized surface — not per-source tools.** The agent's goal is "screen this entity" / "resolve this entity," not "query OFAC" + "query EU." `sanctions_screen_name` fans out across all four sanctions lists internally; sources surface only as provenance on each hit and via `sanctions_list_sources`. This is the difference between a screening server and four list-wrapper servers.

- **UK source is the UK Sanctions List (UKSL), not the OFSI Consolidated List.** The OFSI Consolidated List **closed on 28 January 2026**; UKSL (FCDO, `sanctionslist.fcdo.gov.uk`, OGL v3.0) is now the single authoritative UK source. The original idea brief and the catalog frontmatter both said "OFSI Consolidated List" — that source is retired and must not be the ingest target. (Catalog/idea wording should be corrected to UKSL.)

- **All sources mirrored to one local index, via the framework `MirrorService` — including GLEIF.** The idea brief floated skipping the GLEIF mirror and hitting the live keyless API (its option *b*). This design takes option *a* (full local mirror) for two reasons: (1) the brief's own size estimate is stale — GLEIF Level 1 is now **~3.3M LEI records at ~892 MB compressed** (2026), squarely in the MirrorService tier (10⁴–10⁷ rows, embedded SQLite + FTS5), not the >10⁸ external-store tier; (2) a single normalized on-disk index is what makes all-at-once offline fuzzy matching and ownership-chain screening coherent — a live-API leg would split the data path and reintroduce rate limits and a runtime dependency on the screening hot path. Sanctions lists ride the same mirror but re-harvest in full each refresh (tens of thousands of rows combined — no delta logic needed); GLEIF uses `init` (golden copies) + `refresh` (checkpointed delta windows). `mirror:init` (hours-long, streaming, safe to re-run — an interrupted run starts over) runs out-of-band only. The HTTP cron runs the same refresh, GLEIF deltas only. The read path gates on `mirror.ready()`. *Fallback if disk/ops constraints bite: drop GLEIF to live `api.gleif.org` and mirror only the small sanctions lists — the brief's option b, preserved as a retreat, not the default.*

- **GLEIF refreshes from a per-dataset checkpoint, never from the clock.** The mirror stores, per dataset (`lei2`, `rr`, `repex`), the header `ContentDate` of the last file applied, as JSON in its sync-state `checkpoint`. A refresh reads each delta window's header, smallest first, and applies the first whose `DeltaStart` is at or before that date. A daily `LastDay` refresh silently skipped any gap longer than a day and still stamped `leiAsOf` current. Records apply in document order on their own key (upsert, or delete on `gleif:Deletion`). Replacing every row of a child named in the delta dropped relationships the delta never restated, and deltas carry only what changed. `leiAsOf` and the checkpoint advance in one write after every dataset applied, so an interrupted run changes neither, and re-running converges. No checkpoint, or one older than `LastMonth`, applies nothing and asks for `mirror:init`. A checkpoint was not guessed from `leiAsOf`: that stamp is later than the data's `ContentDate`, so it would pick too narrow a window. `mirror:init` clears the checkpoint before loading, so a load that dies part-way leaves no checkpoint to apply deltas onto.

- **Every GLEIF file streams, and the HTTP cron applies deltas only.** The buffered parse peaks at 12–16× the decompressed document, about 15 GiB for a `LastMonth` Level 1 delta. The streaming path reads the same file at about 150 MiB, bounded by the 10,000-record ingest batch, which is what makes an in-process GLEIF leg safe on the schedule. The cron never loads a golden copy: a gap that needs `mirror:init`, or reporting exceptions never loaded, is logged and left alone. A sanctions-list failure does not stop the GLEIF leg, because a list down for days would otherwise push GLEIF past its one-month window.

- **A reporting exception is a per-node parent status; `complete` keeps its meaning.** In the 2026-09-25 golden copies, 3,192,697 of 3,442,078 entities filed a direct-parent exception, and an exception never coexists with a same-level relationship. Each walked node reports `relationship`, `exception` (with every reason), `none`, or `unknown` for its direct and ultimate parent. Flipping `complete` to false for every node without a parent row was rejected: ~96% of traces would read incomplete, erasing the depth and hydration signal it carries. Exceptions count as loaded only once the checkpoint records a load. An old mirror gains the table empty on open, and an empty table read as "no exception" is the failure this avoids. `ExceptionReference` (filer free text) is not relayed.

- **A re-harvest removes what its source stopped publishing, and only on a whole document.** Each source's harvest collects the ids of the records it accepted; once that harvest returns, the source's stored designations outside the set are deleted through the mirror's tombstones, and the name-index rebuild that follows drops their names. This runs on `init` as well as `refresh`, since a re-init over a populated mirror would otherwise keep the same stale rows. The guard is per source, because a wrongly-emptied list is the worst failure a screening aid can have: a harvest that fails, a document that ends before its root element closes, and a document that yields no accepted record all prune nothing. The root-close check exists because a truncated transfer can end cleanly at the transport, and the record scanner then reads it as a complete, shorter list — a half-length UN feed yielded 479 of 1,011 records and returned normally. The check reads the document once, forward, carrying a few scalars across chunks: a document passes when its last root end tag outside a comment, processing instruction, or CDATA section is followed only by whitespace, comments, and instructions, of any length, and fails when the stream ends inside one of them. A fixed window over the stream's tail rejected a complete document with a long epilog and accepted one cut inside a content comment right after a literal root end tag. A designation still published but in a form the ingest rejects is removed like a delisted one: the mirror holds what the latest document supports.

- **A failing source is passed over, not fatal to the run.** A source whose harvest fails — a failed request, a truncated document — is reported per source and passed over: it keeps its rows, prunes nothing, and every source after it still refreshes and prunes. OFAC's committed pages carry the programme fields already stored for their parties until the source's trailing `<SanctionsEntries>` block is applied, so a harvest cut before that block leaves them as they were rather than blank. After the last source the run fails with one error naming each failed source by its code. The runner then records the run as failed, so the sanctions mirror's as-of (`sanctionsAsOf`, its completion time) stays at the last run in which every source refreshed, and a first `mirror:init` with a failed source leaves the mirror not ready; the scripts exit non-zero and the HTTP cron logs the failure at error level. The name and identifier indexes are rebuilt after every run, completed or not, because a failed run has still committed rows — `syncSanctions()` is the one sync-then-rebuild path all three callers share. A caller abort is not a source failure: it ends the whole run at once, decided by the signal because the fetch reports it as an ordinary error. Freshness stays mirror-wide rather than per source.

- **Every sync runs under a time bound.** `mirror:init` runs under 8 hours, and `mirror:refresh` and the HTTP cron under 4 (`REFRESH_HOURS`). Without a run-level bound a run that stalls holds the scheduled job open, and the scheduler skips every later tick as an overlap — the hosted mirror stops refreshing without an error. A run the bound ends fails as a timeout that says so and names the source it stopped in (`Sanctions harvest of un did not finish. The run exceeded its 4-hour time bound and was stopped.`), rather than as the aborted fetch it interrupted; a caller's abort stays a cancellation. Each streamed source download also bounds its wait for response headers at 120 seconds and fails as a timeout naming the source (`un sent no response headers within 120 s.`); once headers arrive, the body drains until it ends or the run's bound stops it. A healthy transfer can outlast any fixed per-download deadline — `SDN_ADVANCED.XML` is ~127 MB, and the GLEIF golden copy is read at ingest speed for far longer — so the run's bound is the only limit on the body. `fetchWithTimeout`'s own timeout covers the body as well, so `fetchSourceDownload` (`source-fetch.ts`) passes it a deadline out of reach and runs its own headers timer.

- **One run removes at most half of a source (`MAX_PRUNE_SHARE`).** The root-close check proves a document arrived whole, not that it is the whole list. A well-formed file that publishes a fraction of the list (a delta or test file behind a URL override, a partial upstream publication), or an upstream schema change that makes the ingest reject most records, would otherwise empty the source — and the rejected-form rule would help it do so. Real delistings move a small share of a list per update. A run over the bound removes nothing for that source, keeps the records it did upsert, and logs a warning with the withheld count; a document that yields no accepted record is the extreme case and is held back and reported the same way. A genuine mass delisting is applied by rebuilding the sanctions mirror from scratch — remove its database file with its `-wal` and `-shm` companions (the GLEIF mirror is the separate sibling `.gleif.db` file) and run `mirror:init` with `SANCTIONS_INIT_SKIP_GLEIF=1` — since an empty mirror has nothing to prune.

- **Normalized common schema with a denormalized alias index.** The four sanctions lists have wildly different XML/CSV shapes (OFAC advanced schema is the richest; UK XML is famously messy). They collapse onto one `designation` row + a full normalized `payload` JSON for detail. The matching index is a separate `name` table with **one row per name and per alias**, so a query matches any of an entity's names in a single FTS scan — OFAC/UN ship romanized a.k.a. data, and indexing every alias is how transliteration and name-variant hits are caught without inventing transliterations ourselves.

- **Matching: strict token match default, scored fuzzy fallback, transparent signal only.** Default is exact-normalized then strict all-tokens-present (FTS5 `MATCH`) — the ~90% path, handling word-order swaps and missing interior words, no fuzzy library, no synthesized score. Fuzzy is opt-in (`matchMode: 'fuzzy'`) or auto only when strict is empty: **Jaro-Winkler** similarity (good for the short, prefix-weighted name strings sanctions screening deals in) against the best-matching alias *token*, plus a **Double-Metaphone** phonetic key for transliteration-class misses, capped to bound work on short queries against many long names. The surfaced score is the **raw Jaro-Winkler value (0–1)** — a real measurement — never a composite "confidence %." Hits are labeled `exact` / `strong` / `approximate`; an empty fuzzy result returns "no match, browse with a broader query" rather than a misleading low-confidence guess. (The index and the query are both folded before the FTS tokenizer sees them, and `unicode61 remove_diacritics 2` splits every folded name into exactly its fold tokens — the fold maps final sigma `ς` to `σ` because unicode61 folds it too. A name that folds to no token is rejected by the two name tools as `name_not_searchable` rather than answered with an empty screen, and one past 64 words or 1,024 characters as `name_too_long`: the fuzzy pass costs one blocking lookup per distinct word and scores what each pools, and on the sanctions `name` table a blocking lookup is a `LIKE '%prefix%'` scan, so an unbounded name held a request for minutes. On the GLEIF name index each lookup is an FTS prefix query instead. The bound is checked in the handlers, not as a schema `.max()`, so the advertised input schema is unchanged.)

- **GLEIF resolution reads one per-name index, blocked by token prefix.** Other and transliterated names never took part in retrieval while strict matched `lei_entity.normalized_name` and fuzzy blocked on it with `LIKE '%prefix%'`. In a 2026-09-25 LastWeek Level 1 delta, 5,359 of the 18,314 alternate names that differ from their legal name shared no token and no blocking trigram with it. That `LIKE` also read the whole ~3.4M-row table for every query word that matched fewer rows than the per-prefix limit. One table with a row per name, and one FTS over it, fixes both: strict is an AND of tokens, fuzzy is one prefix lookup per word, and neither scans. A name table blocked by `LIKE` would have scanned more rows than before (~4M), which is why the prefix index and not the table is the performance fix.
  - Token-prefix blocking trades the `%prefix%` scan's mid-word hits for index lookups. On 120,176 real names it pooled the target more often for every perturbation tested (typos, dropped, merged, split, and swapped words), because mid-word hits no longer fill the row limit. It loses only a query word that is the tail of a concatenated token (`geois` in `BOURGEOIS`).
  - Names in scripts written without word separators fold to one token. Their suffixes are indexed as well, so a Han name queried without its leading characters still pools, as `%prefix%` pooled it.
  - The jurisdiction is an FTS column intersected inside the lookup. A filter applied to joined rows walked every name matching a common prefix before discarding them, taking 12–15 s at GLEIF scale for a jurisdiction with few entities or none.
- **The status filter never becomes the access path.** `lapsed` matches exactly `LAPSED` (it once admitted every non-issued state, 18% of which are not lapsed). The predicate keeps its `UPPER(e.status)` form, which is non-sargable on purpose: `ISSUED` is 57% of the corpus, and with a bare equality the planner picked `lei_entity_status_idx` over the jurisdiction index and ran ~45× slower. The index path applies the predicate to the joined entity row after the FTS lookup has driven the query.
- **The GLEIF name index is built by `mirror:init`, never backfilled from stored rows.** A 0.3.0 mirror stores other names as bare strings, with no type and no transliterated names. Those arrive only with a golden copy, since a delta rewrites only the records it carries, and such a mirror needs `mirror:init` before its next GLEIF refresh anyway (the checkpoint). A build inside a request would hold bun:sqlite's synchronous handle for a full pass plus an FTS build at GLEIF scale. Until the recorded build exists, resolution answers as 0.3.0 did, never errors, and says alternate names are not yet indexed. The legal-name `lei_entity_fts` stays in the store spec: that fallback reads it, and so does an earlier release after a rollback.

- **Entity references are decoded once, at parse time.** The sources escape `&` and `"` as XML requires. The server-local parser decodes the five predefined entities and numeric character references through fast-xml-parser's value processors, with `processEntities` off so a document's own DOCTYPE entities never expand; stored text is never decoded again, so a double-escaped `&amp;lt;` stays `&lt;`. It lives in the parser rather than the ingesters' `asText()` because GLEIF's copy of that helper also reads the Golden Copy JSON index, which must not be entity-decoded.

- **OFAC cross-references resolve during the stream, from an index of rendered strings.** An advanced party's addresses, nationalities, and identity documents point into `<Locations>` and `<IDRegDocuments>`, which the schema's root `xsd:sequence` publishes before `<DistinctParties>`. The streaming scan lifts each `<Location>` and `<IDRegDocument>` as its own record and folds it into an index local to one harvest, holding only the rendered address or identifier strings. For the 2026-09-23 SDN file that is about 9.5 MiB of retained heap (Bun 1.4.0), which scales with those two blocks rather than with the party count. The buffered `parseOfac()` oracle folds both blocks through the same helpers before it parses parties, so the two paths stay equivalent.

- **"Decision support, not determination" is load-bearing, stated in the surface.** Every screening tool's description and output carries the caveat: results are *potential matches to verify against the official source*, a hit is not a finding of fact, and an empty result is not a clearance. This is a deliberate guard against a smaller consuming model presenting a fuzzy hit as a verdict — it lives in the tool contract, not just the README.

- **No DataCanvas.** Screening is match-and-drill-in over categorical records (names, IDs, programs), not analytical rows an agent runs SQL over. The MirrorService FTS index is the backend; matches return inline with scores. (Per the design skill, a discovery/search surface of categorical metadata doesn't earn a canvas regardless of row count.)

- **LEI as the entity backbone is why sanctions and GLEIF share one server.** Resolving to an LEI disambiguates "Acme Corp" across jurisdictions and unlocks ownership tracing, and AML screening looks past the named counterparty. `sanctions_trace_ownership` with `screenNodes: true` screens its GLEIF accounting-consolidation parents and subsidiaries, which is the cross-source workflow that justifies one server over two separate ones. GLEIF does not name natural-person beneficial owners; a reporting exception such as `NATURAL_PERSONS` says one exists without naming them.

- **Seven tools, no writes, no app tools.** The corpus is upstream-owned and read-only, so there are no mutators and no catastrophically-irreversible operations to keep out of the surface. No human-in-the-loop real-time UI need, so no app tools. The one prompt (`sanctions_vet_counterparty`) reuses existing tools rather than adding capability.

- **Identifier lookup is its own tool, exact and unscored.** Maritime, payment, and crypto screening start from an IMO number, a SWIFT/BIC code, or a wallet address; passed to the name tool, an identifier matches nothing or unrelated fuzzy candidates. An `identifier` mode on `sanctions_screen_name` would have changed a name tool's contract and scoring vocabulary, so `sanctions_screen_identifier` is separate, with no score because two keys are equal or not. It returns one hit per designation (a list can print one number several ways) and is not paged: the most widely shared values in the 2026-09-25 lists (a phone number and a website) map to 12 designations each. BIC compares on eight characters so a wire's branch code surfaces its listed institution; wallet case folds by address shape, not by chain code, because USDT and USDC appear both as case-significant base58 (TRON) and case-insensitive hex (EVM).

- **The identifier index is built before the tool can answer from it, from the data it answers for.** A release before the index existed (0.2.0) writes designations and the name index but never the identifier index, so a mirror it wrote — or synced after a rollback — would answer lookups from missing or stale rows until the next sync: for a screening aid, an empty answer that reads as a clearance. The index carries a one-row stamp of the sync run it was built after (that run's `startedAt` and `completedAt`, which every run and seed of any release rewrites), and the first open rebuilds it from the stored payloads, which hold every identifier, when the stamp differs from the mirror's sync state — or, while a run is in progress (its own rebuild follows), only when the index holds nothing while a stored designation publishes an identifier. No download is needed; on the full corpus the rebuild takes well under a second.

- **Published reference numbers resolve like entry IDs, and never pick among several.** Notices cite UN (`QDe.004`) and EU (`EU.27.28`) designations by reference number, not by the `DATAID` / `logicalId` entry ID, and older UK material by OFSI Group ID. `entryId` resolves against `source_entry_id` first, then `reference_number`, both trimmed and case-insensitive; no reference number equals another entry's ID in its source, so the second pass redirects nothing the first resolves. Eleven UK Group IDs each cover two designations (one person under two regimes), so a shared reference fails as `reference_ambiguous`, naming both entry IDs, rather than returning one.

- **A new `designation` column arrives through the store's migration, its index after it.** The store runs its declarative DDL (`CREATE … IF NOT EXISTS`, then `spec.indexes`) before its migrations, and its generic upsert writes every declared column, so on a hosted mirror written by an earlier release a column listed in the spec alone would leave the table unchanged and an index over it would fail the store open. Schema version 2 adds `reference_number` in a migration that checks `pragma_table_info` first (a fresh database already has the column from the DDL, and runs pending migrations too) and creates its index; existing rows gain values at the next sanctions refresh.

- **Resource template variables are decoded in the handler.** The framework hands a template variable to the handler exactly as it appeared in the URI (cyanheads/mcp-ts-core#490), so an entry ID a client percent-encoded would miss. The designation resource decodes `entryId` once, and a malformed escape resolves to `designation_not_found` rather than a thrown `URIError`. `source` is validated by the params schema before the handler runs, and its values never need encoding.

## Known Limitations

- **Match quality is bounded by source data quality.** UK XML has documented data-quality issues; lists vary in how completely they publish aliases, identifiers, and dates of birth. The server normalizes and indexes what's published — it can't recover fields a source omits, and `format()`/output must preserve that uncertainty rather than fabricate it.
- **Detail groups carry each source's published values.** Dates are ISO 8601 at the precision each source published, but a date written only in free text (UN `NOTE`: `Nov. 1973`, `Approximately`) is not read. No normalized field carries document validity (OFAC `Fraudulent`, EU `knownFalse` / `knownExpired`), gender, or titles, and identifiers are never parsed out of free text (UN `NOTE`, UK `PassportAdditionalInformation`), so UK identifiers carry no issuing country. OFAC's descriptive features — vessel flag, owner, and tonnage; aircraft model, operator, and manufacture date; `Nationality of Registration`; `Registration Country`; sanctions and organization notes — have no normalized field. The standard projection (`SDN.XML` / `CONSOLIDATED.XML`, reachable only through a URL override) carries no reference sets, so it classifies `idList` against a fixed list of the identity-document types OFAC's advanced files published as of the 2026-09-23 publication: a document type OFAC adds later is dropped on that path until it is listed, rather than a descriptive note being taken for an identifier. Its files publish no designation date, so it sets none. On the 2026-09-23 publication the two projections carry the same identifiers for every party but one, where the advanced file publishes a vessel's flag as a second `Vessel Call Sign`. Identifier labels are each list's own, so the same kind can carry two spellings across lists (OFAC `SWIFT/BIC`, EU `SWIFT BIC`). An OFAC advanced `REGION` part renders as its bare value (`Gaza`), where the standard projection writes `Region: Gaza`. A record that publishes several dates and places of birth returns them unpaired, because the source never says which place goes with which date.
- **Transliteration coverage depends on published romanizations.** The server indexes every published name in its own script, so a native-script query matches a native-script name, plus the romanized aliases OFAC/UN ship, with phonetic + fuzzy matching over the Latin ones. It does not transliterate between scripts, and it does not fold Latin letters that have no decomposition (`ł`, `ø`, `ı`, `ß`, `æ`) to ASCII — `Łukasz` is indexed as `łukasz`. An ASCII-typed `Lukasz` misses it in strict mode, and fuzzy mode reaches it only through the name's other words: the letter changes both the trigram prefix and the Double-Metaphone key the fuzzy pass blocks on, so a one-word ASCII query (`Poludniowoazjatycka` for `Południowoazjatycka`) finds nothing. A name published with its romanization and its native form in one string (`Haji Gulab Gul (حاجی گلاب گل …)`) is indexed whole, so a query for the romanized part alone matches it as `strong`, not `exact`. A target whose only romanization differs from all published aliases can be missed by strict match and is the case fuzzy is meant to catch. On the GLEIF side, GLEIF's own `PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME` and `AUTO_ASCII_TRANSLITERATED_LEGAL_NAME` are indexed. A Latin query therefore reaches a legal name in another script only when GLEIF published a transliteration for it (about 4,300 records in a 2026-09-25 weekly delta), or when the entity also lists a Latin other name.
- **A fuzzy-mode result count is a floor, not a total.** `sanctions_screen_name` and `sanctions_resolve_entity` page over their results (`offset` + `totalAvailable` / `hasMore` / `nextOffset`), but only strict mode can report an exact available count. The fuzzy candidate pool comes from bounded blocking queries and is capped at `SANCTIONS_FUZZY_MAX_RESULTS` before it merges with the strict hits, and even a strict pass caps the raw alias rows it scans — so `totalAvailableBasis` marks such a count `lower_bound` rather than presenting a bound as a total.
- **An ownership graph can be a partial view, and says so.** `sanctions_trace_ownership` returns `complete` / `truncated` / `missingEntityLeis`: the traversal is bounded by the requested `depth`, and a node published in the Level 2 relationship corpus may have no Level 1 entity record to hydrate from (it then carries its LEI where a legal name would be, and any per-node screen for it ran against that LEI). Truncation is decided by probing the boundary nodes one hop further, so a graph that simply ran out of relationships reports `truncated: false` and a cycle terminated by dedup stays complete. `complete` covers the loaded relationships only. Most entities publish no parent relationship: in the 2026-09-25 golden copies, 3,192,697 of 3,442,078 entities filed a direct-parent reporting exception. So each walked node's `parentStatus` says what GLEIF publishes about its direct and ultimate parent, and `unknown` marks a mirror whose exceptions are not loaded. An exception explains an unreported parent; it never supplies one, so nothing behind it is screened.
- **A cross-reference screen that could not run is not a clean screen.** `sanctions_get_entity` and `sanctions_trace_ownership` read the GLEIF mirror and the sanctions mirror independently, so the entity lookup can succeed while screening is unavailable. Both report `screeningStatus` (`screened` / `not_ready`, plus `not_requested` on the ownership tool) instead of returning the empty hit list a completed screen would produce. A completed cross-reference also carries `sanctionsScreen.totalAvailable` / `totalAvailableBasis` / `hasMore` on the same contract as `sanctions_screen_name`, since its hit list is capped — at twenty-five for the entity's own screen, at ten per ownership node — so re-screen that legal name with `sanctions_screen_name` for the full set.
- **Freshness is mirror-bounded.** Results are only as current as the last refresh; `sanctions_list_sources` surfaces the sanctions mirror's as-of timestamp — the last sync in which every sanctions source refreshed — beside each source's record count, so the agent can judge staleness. A source that failed on a later run keeps its earlier rows without its own timestamp. Sanctions lists update on the source's schedule (often same-day on a designation); GLEIF updates 3×/day.
- **Not legal compliance certification.** Restated as a constraint, not a feature: this server surfaces open data for a compliance process; it does not perform sanctions compliance, and its output is not a compliance record.

## API Reference

- **OFAC** — Sanctions List Service. Standard `SDN.XML` / `CONSOLIDATED.XML` and advanced `SDN_ADVANCED.XML` / `CONS_ADVANCED.XML` (UN 1267/1988 advanced data standard — richer alias/identifier structure; prefer for ingest). Download base: `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/{filename}`. The `CONS_ADVANCED.XML` path redirects (302) to a presigned S3 URL — follow redirects in the HTTP client. The advanced-format schema is served from the same base as `ADVANCED_XML.xsd`; its root `xsd:sequence` places `<ReferenceValueSets>`, `<Locations>`, and `<IDRegDocuments>` before `<DistinctParties>`. Public domain (US Government work). SDN and Consolidated update on independent schedules.
- **EU** — Consolidated Financial Sanctions List (EEAS/Commission). XML v1.1: `https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw` (the token is a **static public path component**, base64 `token-2017`, not a per-user credential — effectively keyless). `GLOBAL`/`DELTA`/`ANNUAL` variants exist; ingest the full snapshot. Updated daily.
- **UK** — UK Sanctions List (FCDO). XML: `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml` (also `.csv`). Open Government Licence v3.0 — redistribution + commercial use **with attribution**. Replaced the retired OFSI Consolidated List on 2026-01-28.
- **UN** — Security Council Consolidated List. XML from `https://scsanctions.un.org/resources/xml/en/consolidated.xml` (landing page: `https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list`). The domain requires a valid `User-Agent` header — bare curl HEAD returns 404, but a browser-style UA returns the XML. Freely redistributable; updates follow committee decisions.
- **GLEIF** — Golden Copy + Delta download API (`goldencopy.gleif.org`). LEI-CDF Level 1 (who-is-who), RR-CDF Level 2 (who-owns-whom), Reporting Exceptions. XML / JSON / CSV, ZIP-compressed. Published 3×/day (02:00 / 10:00 / 18:00 UTC). Each publication has a golden copy per dataset (`lei2`, `rr`, `repex` at `/api/v2/golden-copies/publishes/{dataset}?format=xml`) and four delta windows, `IntraDay` (8 h), `LastDay`, `LastWeek`, and `LastMonth`. Each file's header states its span (`DeltaStart` → `ContentDate`). Level 2 and reporting-exception deltas carry only changed records, mark removals with `<Extension><gleif:Deletion>`, and can repeat a key, where the last record in document order holds. Reporting exceptions: one record per (LEI, `DIRECT_…` / `ULTIMATE_ACCOUNTING_CONSOLIDATION_PARENT`), `ExceptionReason` repeating (up to eight). ~6.4M records, 66 MB zipped / 1.94 GB decompressed (2026-09-25). **CC0 1.0 Universal** — public domain, free, no registration, commercial use, no attribution required. L1 ≈ 3.3M records / ~892 MB compressed; L2 ≈ 646K records / ~32.5 MB compressed (2026).

### Licensing summary

Clean for redistribution — none of the five carries an anti-AI or anti-redistribution clause. OFAC = US Government public domain; UN/EU consolidated lists = published for screening, freely redistributable; UK = OGL v3.0 (attribution required); GLEIF = CC0 1.0. Obligations: attribute UK (OGL) and cite all sources in the README/output provenance.
