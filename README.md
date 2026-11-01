<div align="center">
  <h1>@cyanheads/sanctions-screening-mcp-server</h1>
  <p><b>Screen names against eleven OFAC, EU, UK, UN, BIS, and State sanctions and export-control lists and resolve legal entities against GLEIF, matched offline over a local SQLite + FTS5 mirror. A screening aid, not a compliance determination.</b>
  <div>7 Tools • 4 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.6.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/sanctions-screening-mcp-server/releases/latest/download/sanctions-screening-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=sanctions-screening-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc2FuY3Rpb25zLXNjcmVlbmluZy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22sanctions-screening-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fsanctions-screening-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://sanctions-screening.caseyjhand.com/mcp](https://sanctions-screening.caseyjhand.com/mcp)

</div>

---

## Overview

Sanctions and export-control screening over eleven lists plus the GLEIF LEI registry, matched offline against a local mirror. Screen a name or identifier for potential watchlist hits, resolve a company to its LEI, and trace its accounting-consolidation relationships.

| Source codes | Lists |
|:---|:---|
| `ofac_sdn`, `ofac_consolidated` | OFAC SDN and Consolidated |
| `eu`, `uk`, `un` | EU, UK Sanctions List, UN Security Council |
| `bis_el`, `bis_dpl`, `bis_uvl`, `bis_meu` | BIS Entity, Denied Persons, Unverified, Military End User |
| `state_dtc`, `state_acn` | State ITAR Debarred, Nonproliferation Sanctions |

The six BIS/State lists come from trade.gov's keyless Consolidated Screening List (CSL) bulk download. Treasury CSL copies are skipped; direct OFAC provenance and grouping remain unchanged.

> [!IMPORTANT]
> **A screening aid, not a compliance determination.** Every result is a potential match with a transparent score and source provenance, never a verdict. A hit is a candidate to verify against the official source; an empty result is never a clearance. Sanctions compliance needs human review and a qualified determination. This server feeds that process and does not perform it.

### Tools

| Tool | Description |
|:---|:---|
| `sanctions_screen_name` | Screen a person, company, vessel, or aircraft name against every loaded watchlist at once |
| `sanctions_screen_identifier` | Look up an IMO number, SWIFT/BIC code, wallet address, or passport or national ID number exactly across every loaded watchlist |
| `sanctions_get_designation` | Fetch the full record for one designation by source list and entry ID or published reference number |
| `sanctions_resolve_entity` | Resolve a company name, optionally within a jurisdiction, to ranked GLEIF LEI candidates |
| `sanctions_get_entity` | Fetch the GLEIF Level 1 record for an LEI, with a sanctions cross-reference of its names, LEI, and registration number |
| `sanctions_trace_ownership` | Trace an LEI's parents and children, optionally cross-referencing every entity in the graph |
| `sanctions_list_sources` | List the loaded sources with record counts, licenses, and mirror freshness |

### Resources

| Resource | Description |
|:---|:---|
| `sanctions://designation/{source}/{entryId}` | One sanctions designation by source and entry ID or published reference number |
| `sanctions://entity/{lei}` | One GLEIF Level 1 entity by LEI |
| `sanctions://sources` | Loaded sources with counts, plus each mirror's readiness and as-of timestamp |
| `skill://sanctions-screening-guide/SKILL.md` | Consumer guide for identity confirmation, ownership continuation, and screening uncertainty |

The three `sanctions://` data resources are also reachable through the tools, for clients that don't surface resources. The guide is also published in the plugin, npm package, and bundle under `skills/sanctions-screening-guide/`.

### Prompts

| Prompt | Description |
|:---|:---|
| `sanctions_vet_counterparty` | Run a counterparty due-diligence pass: screen, resolve, trace ownership, summarize |

## Capability reference

### `sanctions_screen_name` <sub>tool</sub>

- `name` in any script (at most 64 words and 1,024 characters) plus optional `sources`, `entityType`, and `minScore` filters; `matchMode` is `strict` (default) or `fuzzy`. Strict runs a fuzzy pass over each selected list it finds nothing on: a full pass when it finds nothing on any list, otherwise one that adds, after the strict hits, only candidates covering every word of the name other than legal forms, articles and other function words, and the jurisdiction codes `uk`, `usa`, `uae`, and `rf`. `fuzzySources` names the lists a fuzzy pass searched; up to 100 hits per page (`limit`, default 25) with `offset`
- Hits carry `source`, `sourceEntryId`, the list's published `referenceNumber` where it has one, `matchedName` with its `matchedNameType`, and `matchType` (`exact` / `strong` / `approximate`); approximate hits add the raw Jaro-Winkler `score` (0–1) and `queryTokenCoverage`
- Approximate screening compares native forms and deterministic Russian-alphabet romanizations in both directions, always keeping the name and alias type exactly as published. Derived equality remains approximate; it is neither an official alias nor an identity determination. Native candidates take priority within each list's independent 2,000-name fuzzy pool; romanized forms and first-four-code-point deletion signatures supplement remaining capacity, so typo recall is bounded
- `sources` names every selected list a hit's party is on. OFAC publishes a party on the SDN List and a non-SDN list under one entry ID in both of its files; with both OFAC lists selected that party is one hit, counted once, naming both even when the screen matched one record. Its other fields, the designation date included, come from the `source` record: `ofac_sdn`, unless the Consolidated record matched alone or better
- `totalAvailable`, `hasMore`, and `nextOffset` page the rest, and paging reaches every match counted; `totalAvailableBasis` marks the count `exact` (strict matched on every selected list) or a `lower_bound` (a fuzzy pass ran), and a `notice` asks for a more distinctive word when a list's fuzzy candidate pool reached its budget

---

### `sanctions_screen_identifier` <sub>tool</sub>

- `value` (an identifier as you hold it) plus optional `type` (`any` default, `imo`, `swift_bic`, `digital_currency_address`, `passport`, `national_id`) and `sources`
- Exact match after normalization, never fuzzy and never scored: spacing, letter case, and `-` `.` `/` are ignored; an IMO number matches with or without its `IMO` prefix; a SWIFT/BIC compares on its first eight characters, so a branch BIC11 matches its institution's BIC8; a wallet address folds case only for hex (`0x…`), bech32 (`bc1…`, `ltc1…`, `bnb1…`), and cashaddr encodings, while base58 addresses compare exactly
- `type` matches on each list's published label: `imo` is OFAC `Vessel Registration Identification`, UK `IMO Number`, and EU `IMO (vessel identification)`; `swift_bic` is `SWIFT/BIC` and `SWIFT BIC`; `digital_currency_address` is OFAC `Digital Currency Address - <code>`; `passport` and `national_id` cover the lists' passport and national-ID labels. `any` also reaches every label with no category (MMSI, call signs, tail numbers, tax and registration numbers, email, websites)
- One hit per designation, ordered by list then entry ID, each with the `matchedIdentifiers` that matched as published and its `sources`, an OFAC party on both OFAC lists being one hit naming both; not paged. An identifier a list prints only in free-text remarks, or bundled with other numbers in one field, does not match

---

### `sanctions_get_designation` <sub>tool</sub>

- `source` (one of the eleven codes above) and `entryId`: the `sourceEntryId` from a screening hit, or the reference number the list publishes (UN `QDe.004`, EU `EU.27.28`, UK OFSI Group ID `14196`). Matched trimmed and case-insensitive, entry ID first; a reference number two designations share fails as `reference_ambiguous`, naming both. CSL records retain the provider's opaque `id`; missing entity type remains `unknown`
- Returns `referenceNumber` beside `sourceEntryId` where the list publishes one; OFAC publishes none, its entry ID being its published number
- All published aliases, identifiers, addresses, dates and places of birth, nationalities, descriptive features, program, legal basis, and designation date; a field the source omitted is absent, never filled in
- Identifiers cover identity documents plus the SWIFT/BIC codes, digital-currency addresses, vessel call signs, aircraft tail and serial numbers, phone numbers, email addresses, and websites a list publishes, each typed with the list's own label and its value verbatim
- Dates of birth are ISO 8601 at the precision the source published (`1952-10-07`, `1946-08`, `1938`, or an interval such as `1955/1957`), with `circa: true` where the source marks one approximate; `designationDate` is the source's own designation date as `YYYY-MM-DD`
- An OFAC party is dated from its entries on the lists its file publishes: the SDN List for `ofac_sdn`, the non-SDN lists for `ofac_consolidated`, earliest first. A party on both files can carry a different date on each
- `legalBasis` is the instrument the list cites, verbatim: OFAC's legal-basis references (`Executive Order 14024 (Russia)`), the EU regulation title (`2024/1488 (OJ L27052024)`), or the UK regime's regulations (`The Russia (Sanctions) (EU Exit) Regulations 2019`), several joined with `; `. The UN list publishes none
- `features` carries what a list publishes to describe the party rather than identify it, each typed with the list's own label, in published order: OFAC's vessel flag, type, owner, and tonnage, aircraft model, operator, and manufacture date, title, gender, and sanctions notes (`Secondary sanctions risk:` `See Section 11 of Executive Order 14024.`), and the UK list's ship details (`CurrentBelievedFlagOfShip`, `TypeOfShip`, `YearBuilt`, …). A date is ISO 8601 at published precision, with `circa: true` where OFAC marks it approximate. The EU and UN lists contribute none, and no screening tool matches a feature value. CSL features also retain published restrictions, order flags, end dates, country, notices, and provenance URLs without legal interpretation.

---

### `sanctions_resolve_entity` <sub>tool</sub>

- `name` in any script (same bound as `sanctions_screen_name`) plus optional `jurisdiction`, `status`, and `minScore`; `matchMode` is `strict` (default), which falls back to a fuzzy pass only when strict finds nothing, or `fuzzy`; up to 50 candidates per page (`limit`, default 10) with `offset`
- `jurisdiction` is a country code, which matches the country and every subdivision under it (`US` matches `US-DE` and `US-CA`), or an ISO 3166-2 subdivision code (`US-DE`), matched exactly; case-insensitive
- `status`: `issued` (default) matches `ISSUED`, `lapsed` matches exactly `LAPSED`, and `any` applies no filter — the only way to reach `RETIRED`, `DUPLICATE`, `ANNULLED`, `PENDING_TRANSFER`, `PENDING_ARCHIVAL`, or `MERGED` records, each candidate's `status` naming its state
- Searches every name GLEIF publishes: the legal name, previous legal names, trading names, alternative-language legal names, and ASCII transliterations of a legal name in another script
- Candidates carry `lei`, `legalName`, the `matchedName` and its `matchedNameType` (`LEGAL_NAME`, `PREVIOUS_LEGAL_NAME`, `TRADING_OR_OPERATING_NAME`, …, or `UNKNOWN` for a name stored without a type), and `matchType`, with `score` and `queryTokenCoverage` on approximate matches; one candidate per LEI, paged by the same `totalAvailable` / `totalAvailableBasis` / `hasMore` / `nextOffset` fields

---

### `sanctions_get_entity` <sub>tool</sub>

- One 20-character `lei`; returns the legal name, `otherNames`, legal and headquarters addresses, `status`, `jurisdiction`, registration authority, and `lastUpdate`
- `alternateNames` lists every other and transliterated name with its GLEIF type; a name the mirror stored before types were kept reads as `UNKNOWN`
- `sanctionsHits` cross-references the entity against every watchlist: the legal name and every `alternateNames` entry screened strict (exact, then all tokens present, never fuzzy), and the LEI and `registrationAuthorityEntityId` looked up exactly as non-document identifiers (never passports, national IDs, IMO numbers, SWIFT/BIC codes, or wallets). The registration number matches only an identifier published for the country of the entity's `jurisdiction`, and is skipped when the entity publishes no jurisdiction or a not-available placeholder (`N/A`, `n.a.`) in place of a number
- One hit per designation, an OFAC party on both OFAC lists being one hit whose `sources` names both, exact name and identifier matches first, then strong name matches, capped at 25 after the merge. `matchedOn` lists every input that produced a hit (`legal_name`, `other_name` with its GLEIF type, `lei`, `registration_number`); an identifier match adds `matchedIdentifiers` as the list publishes them, and a hit no name produced carries no `matchedName` or `matchType`. No hit carries a `score`: only an approximate (fuzzy) match has one, and every screen here is strict
- `screeningStatus` (`screened` / `not_ready`) says whether the cross-reference ran; `sanctionsScreen` counts distinct designations across every input (`totalAvailable`), flags a capped list (`hasMore`), and lists in `screenedInputs` what was screened beyond the always-screened legal name and LEI

---

### `sanctions_trace_ownership` <sub>tool</sub>

- Root `lei`, `direction` (`parents` / `children` / `both`, default `both`), and `depth` 1–5 (default 3); `screenNodes: true` cross-references every node as `sanctions_get_entity` does (its names strict, its LEI and country-matched registration number as identifiers), up to 10 merged hits per node; a node with no Level 1 record has no name to screen and is looked up by its LEI alone. `both` is a parents walk plus a children walk from the root, each to `depth`; it never reaches siblings or co-parents
- `limit` defaults to 50 and clamps above 100 records across `nodes`, then `edges`, then `boundaries`. Drain `nextCursor` while `hasMore` is true; `totalAvailable` counts those segment records exactly. Edges reference nodes in the assembled segment across pages. Only returned nodes are hydrated and screened
- Pages append intact records until the count cap or a soft 64-KiB serialized text-and-structured target; `byteTargetExceeded` discloses an oversized final payload. Cursors bind the effective query and topology fingerprint; invalid or stale cursors require restarting the segment. Entity and screening values remain current between pages, without an immutable snapshot
- `role` and `depth` retain segment placement; ultimate-parent shortcuts are unwalked leaves flagged `reachedVia: "ultimate"`. After draining a segment, re-root each boundary with its supplied direction and depth; deduplicate queued `(lei, direction)` roots and edge identities because segments overlap. Depth restarts per segment; a missing Level 1 root is accepted only if Level 2 references it
- `truncationReasons` distinguishes remaining pages, depth limits, and ultimate leaves. `complete` requires no remaining page or omitted branch and no missing Level 1 record anywhere in the segment (`missingEntityCount`); `missingEntityLeis` is page-local. This covers loaded accounting-consolidation relationships only, never beneficial ownership
- Each node whose parents the walk read carries `parentStatus.direct` / `.ultimate`: `relationship`, `exception` (a GLEIF reporting exception, with every reason, such as `NATURAL_PERSONS`), `none`, or `unknown`. `unknown` means exception data is not loaded, which `reportingExceptionsLoaded: false` states.
- `screeningStatus` (`screened` / `not_requested` / `not_ready`), `screenedNodeCount`, and `flaggedNodeCount`; each screened node carries its own `sanctionsScreen` (`hasMore`, `screenedInputs`) and hits with `matchedOn` and `matchedIdentifiers`, in the `sanctions_get_entity` shape

---

### `sanctions_list_sources` <sub>tool</sub>

- No input; one row per sanctions list plus `gleif`, each with `recordCount`, `url` (the configured source URL), and `license`; the `gleif` row's `recordCount` is Level 1 entities and its `relationshipCount` Level 2 ownership relationships
- `sanctionsReady` / `sanctionsAsOf` and `leiReady` / `leiAsOf` report whether each mirror has synced and when; `sanctionsAsOf` is the last successful local sync in which every sanctions list refreshed, never upstream publication freshness. Not gated on readiness, so it reports an empty mirror instead of failing
- `reportingExceptionsLoaded`, and on the `gleif` row a `reportingExceptionCount` once the reporting exceptions are loaded
- `alternateNamesIndexed`: whether GLEIF's trading, previous, alternative-language, and transliterated names are indexed; until `mirror:init` builds the index, `sanctions_resolve_entity` searches legal names only

---

### `sanctions://designation/{source}/{entryId}` <sub>resource</sub>

- `source` is one of the eleven list codes, `entryId` the list's own ID or its published reference number, resolved as `sanctions_get_designation` resolves it and decoded once when percent-encoded; returns the `sanctions_get_designation` payload as `application/json`
- Cached for an hour, scoped `private`

---

### `sanctions://entity/{lei}` <sub>resource</sub>

- The `sanctions_get_entity` Level 1 payload for one `lei`, without the sanctions cross-reference, which is tool-only
- Cached for an hour, scoped `private`

---

### `sanctions://sources` <sub>resource</sub>

- The `sanctions_list_sources` payload, unchanged
- `ttlMs: 0`: never cached, because readiness and the as-of timestamps are the payload

---

### `sanctions_vet_counterparty` <sub>prompt</sub>

- Arguments: `name` required; `jurisdiction` optional (a country code, which includes its subdivisions, or an ISO 3166-2 subdivision code)
- Returns one user message that screens the name (and any identifier the caller holds, with `sanctions_screen_identifier`), resolves it to an LEI, traces ownership with `screenNodes: true`, pulls each hit's designation record, and asks for a summary that treats every match as a candidate to verify and says, from `matchedOn`, which of the entity's names or identifiers produced it. It names GLEIF parents as accounting-consolidation parents, not beneficial owners, and reports a reporting exception's reasons rather than reading it as "no parent"

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Sanctions-screening-specific:

- One screen covers the eleven sanctions and export-control lists above; the matching list shows up as per-hit provenance
- Offline and keyless, with no per-request upstream rate limit: all lists are normalized into local SQLite + FTS5 mirrors via the framework `MirrorService`
- Per-alias name index, so a query matches any of an entity's names in one FTS scan, and a per-identifier index for exact lookup by IMO number, SWIFT/BIC, wallet address, or document number
- Strict-then-fuzzy matching: exact-normalized, then all tokens present (FTS5), then Jaro-Winkler + Double-Metaphone over a 2,000-candidate pool per list, so adding a list never pushes another list's candidates out, with every admitted candidate reachable by paging
- GLEIF Level 1 (who is who) and Level 2 (who owns whom) for entity resolution and ownership tracing

Agent-friendly output:

- Real signal with provenance: approximate hits carry the raw Jaro-Winkler `score` and a literal `queryTokenCoverage` count, never a blended confidence; every hit names its list, program, designation date, and the name that matched, typed `primary` / `aka` / `fka` / `low-quality-aka`
- Decision-support `caveat` in the output of `sanctions_screen_name`, `sanctions_screen_identifier`, `sanctions_get_designation`, `sanctions_get_entity`, and `sanctions_trace_ownership`
- Disclosed gaps: `totalAvailableBasis`, `screeningStatus`, `complete` / `truncated` / `missingEntityLeis`, and each node's `parentStatus` say what a response did not cover
- Typed errors: every data tool and `sanctions://` resource except the sources listing fails as `mirror_not_ready` (retryable) until its mirror is loaded; unknown IDs fail as `designation_not_found` or `lei_not_found`, an LEI the mirror lacks whose ISO 17442 check digits fail as `invalid_lei_checksum` (a mistyped character), and a reference number two designations share as `reference_ambiguous`; a name with no letter or digit fails as `name_not_searchable`, one past the length bound as `name_too_long`, and an identifier with nothing left once spacing and separators are removed as `identifier_not_searchable`

## Getting started

### Public Hosted Instance

A public instance is available at `https://sanctions-screening.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "sanctions-screening-mcp-server": {
      "type": "streamable-http",
      "url": "https://sanctions-screening.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. The mirror is not bundled, and the npm package cannot build it: run `bun run mirror:init` from a clone ([Installation](#installation)) or inside the [Docker](#docker) image, then point `SANCTIONS_MIRROR_PATH` at the result (see [Mirror lifecycle](#mirror-lifecycle)).

```json
{
  "mcpServers": {
    "sanctions-screening-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/sanctions-screening-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "sanctions-screening-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/sanctions-screening-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Disk for the local mirror; GLEIF Level 1 takes most of it. No source needs an API key.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/sanctions-screening-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd sanctions-screening-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if you need to override defaults (all optional)
```

5. **Populate the mirror:**

```sh
bun run mirror:init
```

## Configuration

Every source is keyless, so nothing here is required.

| Variable | Description | Default |
|:---|:---|:---|
| `SANCTIONS_MIRROR_PATH` | Filesystem path for the SQLite mirror; use a persistent volume when hosted. | `./data/sanctions.db` |
| `SANCTIONS_REFRESH_CRON` | Cron for the scheduled refresh (HTTP transport only). A supervised child refreshes the sanctions lists and their indexes, then applies GLEIF deltas under one fresh 4-hour bound. A gap that needs `mirror:init` is logged; the schedule never loads golden copies. | `0 4 * * *` |
| `SANCTIONS_REFRESH_SKIP_GLEIF` | Set to `1` to skip the GLEIF leg of the scheduled refresh and of `mirror:refresh`. | unset |
| `SANCTIONS_FUZZY_MIN_SCORE` | Jaro-Winkler floor for fuzzy matches when `minScore` is omitted. | `0.85` |
| `OFAC_SDN_URL` | OFAC SDN advanced-XML URL. | official OFAC URL |
| `OFAC_CONSOLIDATED_URL` | OFAC Consolidated advanced-XML URL. | official OFAC URL |
| `EU_FSF_URL` | EU consolidated XML URL. Its `token` query value is a static public path component, not a credential. | official EU URL |
| `UK_SANCTIONS_URL` | UK Sanctions List (UKSL) XML URL. | official FCDO URL |
| `UN_SC_URL` | UN Security Council consolidated XML URL. | official UN URL |
| `CSL_URL` | Mirror-download override for the shared BIS/State CSL bulk JSON; no search API key. | `https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json` |
| `GLEIF_GOLDEN_COPY_BASE_URL` | GLEIF golden-copy and delta download API. | `https://goldencopy.gleif.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. `createApp()` declares `stateless`; setting the variable overrides it. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Mirror lifecycle

Upgrading from 0.5.1 or earlier: run `bun run mirror:refresh` to load the six BIS/State CSL lists; optionally set `SANCTIONS_REFRESH_SKIP_GLEIF=1`. Existing readiness does not prove those lists are populated. `sanctions_list_sources` reports configured lists and stored counts, with refresh guidance for zero-row CSL sources.

The mirror loads out-of-band, never on the request path: `bun run mirror:init` does the full load once, `bun run mirror:refresh` keeps it current (HTTP deployments also refresh on `SANCTIONS_REFRESH_CRON`), and `bun run mirror:verify` reports readiness and counts. When upgrading from an earlier release, run `mirror:refresh` once (from 0.3.0 or earlier, `mirror:init`). Failure handling, upgrade and rollback behavior, and disk sizing are in [docs/mirror.md](./docs/mirror.md).

### Docker

```sh
docker build -t sanctions-screening-mcp-server .
docker run --rm -p 3010:3010 -v sanctions-data:/usr/src/app/data sanctions-screening-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/sanctions-screening-mcp-server`. Mount a volume at `/usr/src/app/data` so the mirror survives restarts, and populate it with `bun run mirror:init` via `docker exec`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the surface, inits the screening service, schedules the HTTP refresh. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and the shared screening caveat. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). |
| `src/services/screening` | Screening service: mirrors, normalized schema, OFAC/EU/UK/UN/CSL/GLEIF ingesters, matching engine. |
| `skills/sanctions-screening-guide/` | Consumer workflow guide, published through MCP, plugins, npm, and the bundle. |
| `scripts/mirror-*.ts` | Mirror lifecycle CLI: init, refresh, verify, seed. |
| `tests/` | Tool, resource, prompt, service, integration, fuzz, and smoke tests. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging; the mirror is reached through `getScreeningService()`, not `ctx.state`
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external sources: validate raw → normalize to the common schema → return the output schema; never fabricate fields a source omits, and never synthesize a confidence score

## Attribution

This server redistributes open data from these sources, cited per their terms:

| Source | Publisher | License |
|:---|:---|:---|
| OFAC SDN and Consolidated lists | US Department of the Treasury, Office of Foreign Assets Control | US Government public domain |
| BIS Entity, Denied Persons, Unverified, Military End User; State ITAR Debarred and Nonproliferation Sanctions | US Departments of Commerce and State, via [ITA CSL](https://www.trade.gov/consolidated-screening-list) | US Government public domain; [ITA terms](https://developer.trade.gov/terms-of-service) |
| EU Consolidated Financial Sanctions List | European Commission / EEAS | Freely redistributable |
| UK Sanctions List (UKSL) | UK Foreign, Commonwealth & Development Office | [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) (attribution required) |
| UN Security Council Consolidated List | United Nations Security Council | Freely redistributable |
| GLEIF LEI data (Level 1 + Level 2) | Global Legal Entity Identifier Foundation | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) |

UKSL has been the single authoritative UK source since the OFSI Consolidated List closed on 28 January 2026.

This product uses the International Trade Administration’s Data API but is not endorsed or certified by the International Trade Administration.

Verify CSL candidates and their published restrictions against the official agency lists and Federal Register publications. A published end date or order flag is retained as source data, never interpreted as clearance or a legal-status determination. Mirror timestamps report successful local synchronization, not the publication time or freshness of each upstream list.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
