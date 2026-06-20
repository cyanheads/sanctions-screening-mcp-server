# sanctions-screening-mcp-server — Design

Entity screening and resolution as one workflow over the world's open sanctions data plus the global legal-entity registry. Screens names against the consolidated US (OFAC), EU, UK, and UN sanctions lists, and resolves legal entities against the GLEIF LEI database with corporate-ownership tracing. All sources are bulk, keyless, freely redistributable, and mirrored to a local SQLite + FTS5 index — the server answers "is this entity on a watchlist?" and "who is this legal entity, and who owns it?" offline, fuzzy-matched.

> **This server is a screening *aid*, not a compliance determination.** Every tool returns *potential matches* with a transparent score and source provenance — never a verdict. A hit means "review this candidate against the official source"; an empty result never means "cleared." Real sanctions compliance is a legal process this server feeds, not one it performs.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `sanctions_screen_name` | The 80% entry point. Screens a name (person, company, vessel, aircraft) against all loaded watchlists (OFAC SDN + Consolidated, EU, UK, UN) at once, alias- and fuzzy-aware. Returns scored potential matches with source list, program, designation date, and the matched alias. Decision support — a hit is a candidate to verify, not a determination. | `name` (string), `entity_type` (enum: any/person/organization/vessel/aircraft), `match_mode` (enum: strict/fuzzy, default strict), `min_score` (0–1, fuzzy only), `sources` (array of list codes, default all), `limit` (default 25) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_get_designation` | Full record for one sanctions entry by source list + entry ID. All aliases, identifiers (passport/national-ID/tax), addresses, dates/places of birth, nationalities, sanctioning program, legal basis, and designation date. The drill-in after `sanctions_screen_name` surfaces a candidate. | `source` (enum: ofac_sdn/ofac_consolidated/eu/uk/un), `entry_id` (string) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_resolve_entity` | Resolves a company/organization name (+ optional jurisdiction) to candidate GLEIF LEIs, ranked. Name → canonical global identifier. The bridge from a free-text counterparty name to a stable LEI other tools key off. | `name` (string), `jurisdiction` (ISO 3166-1 alpha-2, optional), `match_mode` (enum: strict/fuzzy, default strict), `status` (enum: any/issued/lapsed, default issued), `limit` (default 10) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_get_entity` | Full GLEIF Level 1 record for one LEI: legal name, other/trading names, legal + headquarters address, registration status, jurisdiction, registration authority and ID, last-update date — plus any sanctions hits screened against the same name. | `lei` (20-char LEI, regex-validated) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_trace_ownership` | GLEIF Level 2 ownership graph for an LEI: direct and ultimate parents and children, with relationship type and accounting basis. Optionally screens every node against the watchlists — beneficial-ownership screening that single-list tools can't do. | `lei` (20-char LEI), `direction` (enum: parents/children/both, default both), `depth` (1–5, default 3), `screenNodes` (boolean, default false) | `readOnlyHint`, `openWorldHint: false` |
| `sanctions_list_sources` | The watchlists and GLEIF datasets currently loaded, each with record count, source URL, and as-of / last-refresh timestamp, plus mirror readiness. Provenance and freshness for any result. | *(none)* | `readOnlyHint`, `openWorldHint: false` |

Six tools. No write tools (the corpus is upstream-owned and read-only), no app tools, no catastrophically-irreversible operations.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `sanctions://designation/{source}/{entryId}` | One sanctions entry by source + entry ID. Read-only mirror of `sanctions_get_designation` for clients that inject context by URI. | None (single record) |
| `sanctions://entity/{lei}` | One GLEIF Level 1 entity by LEI. Read-only mirror of `sanctions_get_entity`'s entity payload (without the screening cross-reference). | None (single record) |
| `sanctions://sources` | Loaded lists + GLEIF datasets with counts and refresh timestamps. Read-only mirror of `sanctions_list_sources`. | None (small fixed list) |

All resource data is fully reachable through the tool surface — resources are a convenience for resource-capable clients only.

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `sanctions_vet_counterparty` | Structures a full counterparty due-diligence pass: resolve the name to an LEI, pull the ownership tree, screen the named entity and every beneficial owner against all lists, and summarize hits with provenance and the decision-support caveat. Frames the multi-tool workflow the moonshot describes. | `name` (string), `jurisdiction` (optional) |

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
- **Screen beneficial owners**, not just the named counterparty — the workflow that justifies one server over two.
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
| `screening-service` | The local mirror (MirrorService) + the normalization schema + the matching engine | all six tools |

Each sanctions service is a `sync` ingester for the MirrorService: it fetches the source file, parses it (XML via a streaming parser to stay within memory on GLEIF's ~490 MB compressed L1), maps records onto the common normalized schema, and yields pages. `screening-service` owns `defineMirror`, query translation (free-text → FTS5 `MATCH`), and the strict/fuzzy match pipeline.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `SANCTIONS_MIRROR_PATH` | No (default `./data/sanctions.db`) | Filesystem path for the SQLite mirror. On a hosted deployment, a persistent volume. |
| `SANCTIONS_REFRESH_CRON` | No (default `0 4 * * *`) | Cron for the scheduled refresh of sanctions lists + GLEIF deltas (HTTP transport only). |
| `SANCTIONS_FUZZY_MIN_SCORE` | No (default `0.85`) | Default Jaro-Winkler similarity floor for fuzzy matches when the caller omits `min_score`. |
| `SANCTIONS_FUZZY_MAX_RESULTS` | No (default `50`) | Hard cap on fuzzy candidates scored per query, to bound work on short queries against many long names. |
| `OFAC_SDN_URL` | No (default official SLS URL) | Override for the OFAC SDN advanced-XML file. |
| `OFAC_CONSOLIDATED_URL` | No (default official SLS URL) | Override for the OFAC Consolidated advanced-XML file. |
| `EU_FSF_URL` | No (default official `webgate` URL incl. public token) | Override for the EU consolidated XML file. |
| `UK_SANCTIONS_URL` | No (default `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml`) | Override for the UKSL XML file. |
| `UN_SC_URL` | No (default official UN SC Consolidated XML URL) | Override for the UN consolidated XML file. |
| `GLEIF_GOLDEN_COPY_BASE_URL` | No (default `https://goldencopy.gleif.org` API) | Override for the GLEIF golden-copy / delta download API. |

All source URLs default to the verified official endpoints; overrides exist for testing and for pinning a mirror in restricted environments. No secret values — every source is keyless (the EU "token" is a static public path component, not a credential).

## Implementation Order

1. **Config + server setup** — `server-config.ts`, `createApp({ name: 'sanctions-screening-mcp-server', title: 'sanctions-screening-mcp-server', ... })`, wire the mirror refresh cron in `setup()` (HTTP-gated).
2. **Normalization schema + screening-service skeleton** — `defineMirror` + `sqliteMirrorStore` with the primary `designation` table, FTS over `normalized_name`, and the auxiliary `name`, `lei_entity`, `lei_relationship` tables (via the `raw()` handle + migrations). The matching engine (strict token match first; fuzzy + phonetic second).
3. **Sanctions ingesters** — `ofac-service`, `un-sc-service`, `uk-sanctions-service`, `eu-fsf-service` as `sync` generators. These re-harvest in full each refresh (small corpora, no delta logic). Independently testable against a captured sample file each.
4. **Read-only sanctions tools** — `sanctions_screen_name`, `sanctions_get_designation`, `sanctions_list_sources`. Testable against the mirror once sanctions ingest lands.
5. **GLEIF ingester** — `gleif-service`: init from the golden-copy L1 + L2 files (streaming parse), refresh from the daily delta files keyed on a checkpoint. The heaviest leg; build it after the sanctions path proves the schema.
6. **LEI tools** — `sanctions_resolve_entity`, `sanctions_get_entity`, `sanctions_trace_ownership` (with optional per-node screening).
7. **Resources** — three URI-addressable read-only views.
8. **Prompt** — `sanctions_vet_counterparty`.

Each step is independently testable; a captured sample file per source lets ingesters and tools be tested without live downloads.

---

## Domain Mapping

| Noun | Operations | Becomes |
|:-----|:-----------|:--------|
| Sanctions designation | screen-by-name (all lists), get-by-id, list-loaded-sources | `sanctions_screen_name`, `sanctions_get_designation`, `sanctions_list_sources` |
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
| `normalized_name` | TEXT | Folded (lowercase, punctuation-stripped, NFKD, whitespace-collapsed) — FTS-indexed |
| `program` | TEXT | Sanctioning program / regime |
| `legal_basis` | TEXT | Statutory/regulatory basis where published |
| `designation_date` | TEXT | ISO 8601 where available |
| `payload` | TEXT (JSON) | Full normalized record — aliases[], identifiers[], addresses[], dobs[], nationalities[] — for `get_designation` |

Auxiliary `name` table (the matching index) — one row **per name and per alias**, so a query matches across all of an entity's names at once:

| Column | Type | Notes |
|:-------|:-----|:------|
| `designation_id` | TEXT | FK → `designation.id` |
| `name` | TEXT | One primary name or alias as published |
| `normalized` | TEXT | Folded form — FTS-indexed (`unicode61 remove_diacritics 2`) |
| `phonetic` | TEXT | Double-Metaphone key of `normalized` — indexed, for transliteration-class fuzzy hits |
| `name_type` | TEXT | `primary` / `aka` / `fka` / `low-quality-aka` |

GLEIF `lei_entity` (Level 1) and `lei_relationship` (Level 2) tables are separate (different lifecycle, far larger): `lei_entity(lei PK, legal_name, normalized_name [FTS], jurisdiction, status, legal_address, hq_address, registration_authority_id, registration_status, last_update)`; `lei_relationship(child_lei, parent_lei, relationship_type, relationship_period, level)` indexed on both `child_lei` and `parent_lei` for bidirectional traversal.

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
| 3 | *(fuzzy only)* Jaro-Winkler ≥ `min_score` against the best-matching alias token, capped at `SANCTIONS_FUZZY_MAX_RESULTS` | `approximate` |
| 3b | *(fuzzy only)* Phonetic-key equality (Double Metaphone) for transliteration misses | `approximate` |

Steps 1–2 are the ~90% path and need no fuzzy library. Step 3 fires only when strict returns nothing (or when `match_mode: 'fuzzy'` is explicit). Every result carries `match_type`, the `matched_name` string, the matched tokens, and — for `approximate` — the raw `score`. When fuzzy also returns nothing, the tool says so and points the caller to browse via a broader query rather than guessing.

## Design Decisions

- **Multi-source, workflow-organized surface — not per-source tools.** The agent's goal is "screen this entity" / "resolve this entity," not "query OFAC" + "query EU." `sanctions_screen_name` fans out across all four sanctions lists internally; sources surface only as provenance on each hit and via `sanctions_list_sources`. This is the difference between a screening server and four list-wrapper servers.

- **UK source is the UK Sanctions List (UKSL), not the OFSI Consolidated List.** The OFSI Consolidated List **closed on 28 January 2026**; UKSL (FCDO, `sanctionslist.fcdo.gov.uk`, OGL v3.0) is now the single authoritative UK source. The original idea brief and the catalog frontmatter both said "OFSI Consolidated List" — that source is retired and must not be the ingest target. (Catalog/idea wording should be corrected to UKSL.)

- **All sources mirrored to one local index, via the framework `MirrorService` — including GLEIF.** The idea brief floated skipping the GLEIF mirror and hitting the live keyless API (its option *b*). This design takes option *a* (full local mirror) for two reasons: (1) the brief's own size estimate is stale — GLEIF Level 1 is now **~3.3M LEI records at ~490 MB compressed** (May 2026), squarely in the MirrorService tier (10⁴–10⁷ rows, embedded SQLite + FTS5), not the >10⁸ external-store tier; (2) a single normalized on-disk index is what makes all-at-once offline fuzzy matching and beneficial-ownership screening coherent — a live-API leg would split the data path and reintroduce rate limits and a runtime dependency on the screening hot path. Sanctions lists ride the same mirror but re-harvest in full each refresh (tens of thousands of rows combined — no delta logic needed); GLEIF uses `init` (golden copy) + `refresh` (daily deltas, checkpoint-seeded). Init runs out-of-band (CLI/one-shot, hours-long, resumable); refresh runs on a cron in `setup()`, HTTP-gated. The read path gates on `mirror.ready()`. *Fallback if disk/ops constraints bite: drop GLEIF to live `api.gleif.org` and mirror only the small sanctions lists — the brief's option b, preserved as a retreat, not the default.*

- **Normalized common schema with a denormalized alias index.** The four sanctions lists have wildly different XML/CSV shapes (OFAC advanced schema is the richest; UK XML is famously messy). They collapse onto one `designation` row + a full normalized `payload` JSON for detail. The matching index is a separate `name` table with **one row per name and per alias**, so a query matches any of an entity's names in a single FTS scan — OFAC/UN ship romanized a.k.a. data, and indexing every alias is how transliteration and name-variant hits are caught without inventing transliterations ourselves.

- **Matching: strict token match default, scored fuzzy fallback, transparent signal only.** Default is exact-normalized then strict all-tokens-present (FTS5 `MATCH`) — the ~90% path, handling word-order swaps and missing interior words, no fuzzy library, no synthesized score. Fuzzy is opt-in (`match_mode: 'fuzzy'`) or auto only when strict is empty: **Jaro-Winkler** similarity (good for the short, prefix-weighted name strings sanctions screening deals in) against the best-matching alias *token*, plus a **Double-Metaphone** phonetic key for transliteration-class misses, capped to bound work on short queries against many long names. The surfaced score is the **raw Jaro-Winkler value (0–1)** — a real measurement — never a composite "confidence %." Hits are labeled `exact` / `strong` / `approximate`; an empty fuzzy result returns "no match, browse with a broader query" rather than a misleading low-confidence guess. (The framework's FTS tokenizer already strips diacritics — `unicode61 remove_diacritics 2` — so the fold layer and the index agree.)

- **"Decision support, not determination" is load-bearing, stated in the surface.** Every screening tool's description and output carries the caveat: results are *potential matches to verify against the official source*, a hit is not a finding of fact, and an empty result is not a clearance. This is a deliberate guard against a smaller consuming model presenting a fuzzy hit as a verdict — it lives in the tool contract, not just the README.

- **No DataCanvas.** Screening is match-and-drill-in over categorical records (names, IDs, programs), not analytical rows an agent runs SQL over. The MirrorService FTS index is the backend; matches return inline with scores. (Per the design skill, a discovery/search surface of categorical metadata doesn't earn a canvas regardless of row count.)

- **LEI as the entity backbone is why sanctions and GLEIF share one server.** Resolving to an LEI disambiguates "Acme Corp" across jurisdictions and unlocks ownership tracing — and AML requires screening *beneficial owners*, not just the named counterparty. `sanctions_trace_ownership` with `screenNodes: true` is the cross-source workflow that justifies one server over two separate ones.

- **Six tools, no writes, no app tools.** The corpus is upstream-owned and read-only, so there are no mutators and no catastrophically-irreversible operations to keep out of the surface. No human-in-the-loop real-time UI need, so no app tools. The one prompt (`sanctions_vet_counterparty`) reuses existing tools rather than adding capability.

## Known Limitations

- **Match quality is bounded by source data quality.** UK XML has documented data-quality issues; lists vary in how completely they publish aliases, identifiers, and dates of birth. The server normalizes and indexes what's published — it can't recover fields a source omits, and `format()`/output must preserve that uncertainty rather than fabricate it.
- **Transliteration coverage depends on published romanizations.** The server indexes the romanized aliases OFAC/UN ship and applies phonetic + fuzzy matching; it does not transliterate non-Latin scripts itself. A target whose only romanization differs from all published aliases can be missed by strict match and is the case fuzzy is meant to catch.
- **Freshness is mirror-bounded.** Results are only as current as the last refresh; `sanctions_list_sources` surfaces each source's as-of timestamp so the agent can judge staleness. Sanctions lists update on the source's schedule (often same-day on a designation); GLEIF updates 3×/day.
- **Not legal compliance certification.** Restated as a constraint, not a feature: this server surfaces open data for a compliance process; it does not perform sanctions compliance, and its output is not a compliance record.

## API Reference

- **OFAC** — Sanctions List Service. Standard `SDN.XML` / `CONSOLIDATED.XML` and advanced `SDN_ADVANCED.XML` / `CONS_ADVANCED.XML` (UN 1267/1988 advanced data standard — richer alias/identifier structure; prefer for ingest). Download base: `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/{filename}`. The `CONS_ADVANCED.XML` path redirects (302) to a presigned S3 URL — follow redirects in the HTTP client. The schema XSD path (`ADVANCED_XML.xsd`) returns HTTP 400 via the same API; use the XSD bundled in the SDN download or sourced from the OFAC developer documentation directly. Public domain (US Government work). SDN and Consolidated update on independent schedules.
- **EU** — Consolidated Financial Sanctions List (EEAS/Commission). XML v1.1: `https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw` (the token is a **static public path component**, base64 `token-2017`, not a per-user credential — effectively keyless). `GLOBAL`/`DELTA`/`ANNUAL` variants exist; ingest the full snapshot. Updated daily.
- **UK** — UK Sanctions List (FCDO). XML: `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml` (also `.csv`). Open Government Licence v3.0 — redistribution + commercial use **with attribution**. Replaced the retired OFSI Consolidated List on 2026-01-28.
- **UN** — Security Council Consolidated List. XML from `https://scsanctions.un.org/resources/xml/en/consolidated.xml` (landing page: `https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list`). The domain requires a valid `User-Agent` header — bare curl HEAD returns 404, but a browser-style UA returns the XML. Freely redistributable; updates follow committee decisions.
- **GLEIF** — Golden Copy + Delta download API (`goldencopy.gleif.org`). LEI-CDF Level 1 (who-is-who), RR-CDF Level 2 (who-owns-whom), Reporting Exceptions. XML / JSON / CSV, ZIP-compressed. Published 3×/day (02:00 / 10:00 / 18:00 UTC) with 8-hour and 7-day deltas. **CC0 1.0 Universal** — public domain, free, no registration, commercial use, no attribution required. L1 ≈ 3.3M records / ~490 MB compressed; L2 ≈ 646K records / ~35 MB compressed (May 2026).

### Licensing summary

Clean for redistribution — none of the five carries an anti-AI or anti-redistribution clause. OFAC = US Government public domain; UN/EU consolidated lists = published for screening, freely redistributable; UK = OGL v3.0 (attribution required); GLEIF = CC0 1.0. Obligations: attribute UK (OGL) and cite all sources in the README/output provenance.
