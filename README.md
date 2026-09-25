<div align="center">
  <h1>@cyanheads/sanctions-screening-mcp-server</h1>
  <p><b>Screen names against the consolidated OFAC, EU, UK, and UN sanctions lists and resolve legal entities against GLEIF, fuzzy-matched offline over a local SQLite + FTS5 mirror. A screening aid, not a compliance determination.</b>
  <div>7 Tools • 3 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Sanctions screening and legal-entity resolution over the consolidated OFAC, EU, UK, and UN lists plus the GLEIF LEI registry, matched offline against a local mirror. Screen a name for potential watchlist hits, resolve a company to its LEI, and trace its ownership chain. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

> [!IMPORTANT]
> **A screening aid, not a compliance determination.** Every result is a potential match with a transparent score and source provenance, never a verdict. A hit is a candidate to verify against the official source; an empty result is never a clearance. Sanctions compliance needs human review and a qualified determination. This server feeds that process and does not perform it.

### Tools

| Tool | Description |
|:---|:---|
| `sanctions_screen_name` | Screen a person, company, vessel, or aircraft name against every loaded watchlist at once |
| `sanctions_screen_identifier` | Look up an IMO number, SWIFT/BIC code, wallet address, or passport or national ID number exactly across every loaded watchlist |
| `sanctions_get_designation` | Fetch the full record for one designation by source list and entry ID or published reference number |
| `sanctions_resolve_entity` | Resolve a company name, optionally within a jurisdiction, to ranked GLEIF LEI candidates |
| `sanctions_get_entity` | Fetch the GLEIF Level 1 record for an LEI, with a sanctions screen of its legal name |
| `sanctions_trace_ownership` | Trace an LEI's parents and children, optionally screening every entity in the graph |
| `sanctions_list_sources` | List the loaded sources with record counts, licenses, and mirror freshness |

### Resources

| Resource | Description |
|:---|:---|
| `sanctions://designation/{source}/{entryId}` | One sanctions designation by source and entry ID or published reference number |
| `sanctions://entity/{lei}` | One GLEIF Level 1 entity by LEI |
| `sanctions://sources` | Loaded sources with counts, plus each mirror's readiness and as-of timestamp |

All resource data is also reachable through the tools, for clients that don't surface resources.

### Prompts

| Prompt | Description |
|:---|:---|
| `sanctions_vet_counterparty` | Run a counterparty due-diligence pass: screen, resolve, trace ownership, summarize |

## Capability reference

### `sanctions_screen_name` <sub>tool</sub>

- `name` in any script (at most 64 words and 1,024 characters) plus optional `sources`, `entityType`, and `minScore` filters; `matchMode` is `strict` (default) or `fuzzy`, and strict falls back to fuzzy when it finds nothing; up to 100 hits per page (`limit`, default 25) with `offset`
- Hits carry `source`, `sourceEntryId`, the list's published `referenceNumber` where it has one, `matchedName` with its `matchedNameType`, and `matchType` (`exact` / `strong` / `approximate`); approximate hits add the raw Jaro-Winkler `score` (0–1) and `queryTokenCoverage`
- `totalAvailable`, `hasMore`, and `nextOffset` page the rest; `totalAvailableBasis` marks the count `exact` or a `lower_bound`

---

### `sanctions_screen_identifier` <sub>tool</sub>

- `value` (an identifier as you hold it) plus optional `type` (`any` default, `imo`, `swift_bic`, `digital_currency_address`, `passport`, `national_id`) and `sources`
- Exact match after normalization, never fuzzy and never scored: spacing, letter case, and `-` `.` `/` are ignored; an IMO number matches with or without its `IMO` prefix; a SWIFT/BIC compares on its first eight characters, so a branch BIC11 matches its institution's BIC8; a wallet address folds case only for hex (`0x…`), bech32 (`bc1…`, `ltc1…`, `bnb1…`), and cashaddr encodings, while base58 addresses compare exactly
- `type` matches on each list's published label: `imo` is OFAC `Vessel Registration Identification`, UK `IMO Number`, and EU `IMO (vessel identification)`; `swift_bic` is `SWIFT/BIC` and `SWIFT BIC`; `digital_currency_address` is OFAC `Digital Currency Address - <code>`; `passport` and `national_id` cover the lists' passport and national-ID labels. `any` also reaches every label with no category (MMSI, call signs, tail numbers, tax and registration numbers, email, websites)
- One hit per designation, ordered by list then entry ID, each with the `matchedIdentifiers` that matched as published; not paged. An identifier a list prints only in free-text remarks, or bundled with other numbers in one field, does not match

---

### `sanctions_get_designation` <sub>tool</sub>

- `source` (`ofac_sdn`, `ofac_consolidated`, `eu`, `uk`, `un`) and `entryId`: the `sourceEntryId` from a screening hit, or the reference number the list publishes (UN `QDe.004`, EU `EU.27.28`, UK OFSI Group ID `14196`). Matched trimmed and case-insensitive, entry ID first; a reference number two designations share fails as `reference_ambiguous`, naming both
- Returns `referenceNumber` beside `sourceEntryId` where the list publishes one; OFAC publishes none, its entry ID being its published number
- All published aliases, identifiers, addresses, dates and places of birth, nationalities, program, legal basis, and designation date; a field the source omitted is absent, never filled in
- Identifiers cover identity documents plus the SWIFT/BIC codes, digital-currency addresses, vessel call signs, aircraft tail and serial numbers, phone numbers, email addresses, and websites a list publishes, each typed with the list's own label and its value verbatim
- Dates of birth are ISO 8601 at the precision the source published (`1952-10-07`, `1946-08`, `1938`, or an interval such as `1955/1957`), with `circa: true` where the source marks one approximate; `designationDate` is the source's own designation date as `YYYY-MM-DD`

---

### `sanctions_resolve_entity` <sub>tool</sub>

- `name` in any script (same bound as `sanctions_screen_name`) plus optional `jurisdiction`, `status`, and `minScore`; same `matchMode` behavior as `sanctions_screen_name`; up to 50 candidates per page (`limit`, default 10) with `offset`
- `jurisdiction` is a country code, which matches the country and every subdivision under it (`US` matches `US-DE` and `US-CA`), or an ISO 3166-2 subdivision code (`US-DE`), matched exactly; case-insensitive
- `status`: `issued` (default) matches `ISSUED`, `lapsed` matches exactly `LAPSED`, and `any` applies no filter — the only way to reach `RETIRED`, `DUPLICATE`, `ANNULLED`, `PENDING_TRANSFER`, `PENDING_ARCHIVAL`, or `MERGED` records, each candidate's `status` naming its state
- Searches every name GLEIF publishes: the legal name, previous legal names, trading names, alternative-language legal names, and ASCII transliterations of a legal name in another script
- Candidates carry `lei`, `legalName`, the `matchedName` and its `matchedNameType` (`LEGAL_NAME`, `PREVIOUS_LEGAL_NAME`, `TRADING_OR_OPERATING_NAME`, …, or `UNKNOWN` for a name stored without a type), and `matchType`, with `score` and `queryTokenCoverage` on approximate matches; one candidate per LEI, paged by the same `totalAvailable` / `totalAvailableBasis` / `hasMore` / `nextOffset` fields

---

### `sanctions_get_entity` <sub>tool</sub>

- One 20-character `lei`; returns the legal name, `otherNames`, legal and headquarters addresses, `status`, `jurisdiction`, registration authority, and `lastUpdate`
- `alternateNames` lists every other and transliterated name with its GLEIF type; a name the mirror stored before types were kept reads as `UNKNOWN`
- `sanctionsHits` screens the legal name against every watchlist, strict-only and capped at 25; `screeningStatus` (`screened` / `not_ready`) says whether that screen ran, and `sanctionsScreen.hasMore` flags a capped list

---

### `sanctions_trace_ownership` <sub>tool</sub>

- Root `lei`, `direction` (`parents` / `children` / `both`, default `both`), and `depth` 1–5 (default 3); `screenNodes: true` screens every node's legal name, strict-only, up to 10 hits per node
- `nodes` (with `role` and `depth`) and `edges` (with `relationshipType`); `complete` is false when the graph is `truncated` at the depth limit or `missingEntityLeis` lists nodes with no Level 1 record. It covers the loaded relationships only, and most entities publish no parent relationship.
- Each node whose parents the walk read carries `parentStatus.direct` / `.ultimate`: `relationship`, `exception` (a GLEIF reporting exception, with every reason, such as `NATURAL_PERSONS`), `none`, or `unknown`. `unknown` means exception data is not loaded, which `reportingExceptionsLoaded: false` states.
- `screeningStatus` (`screened` / `not_requested` / `not_ready`), `screenedNodeCount`, and `flaggedNodeCount`; each screened node reports its own `sanctionsScreen.hasMore`

---

### `sanctions_list_sources` <sub>tool</sub>

- No input; one row per sanctions list plus `gleif`, each with `recordCount`, `url`, and `license`
- `sanctionsReady` / `sanctionsAsOf` and `leiReady` / `leiAsOf` report whether each mirror has synced and when; `sanctionsAsOf` is the last sync in which every sanctions list refreshed. Not gated on readiness, so it reports an empty mirror instead of failing
- `reportingExceptionsLoaded`, and on the `gleif` row a `reportingExceptionCount` once the reporting exceptions are loaded

---

### `sanctions://designation/{source}/{entryId}` <sub>resource</sub>

- `source` is one of the five list codes, `entryId` the list's own ID or its published reference number, resolved as `sanctions_get_designation` resolves it and decoded once when percent-encoded; returns the `sanctions_get_designation` payload as `application/json`
- Cached for an hour, scoped `private`

---

### `sanctions://entity/{lei}` <sub>resource</sub>

- The `sanctions_get_entity` Level 1 payload for one `lei`, without the sanctions cross-reference, which is tool-only
- Cached for an hour, scoped `private`

---

### `sanctions://sources` <sub>resource</sub>

- The `sanctions_list_sources` payload, plus the GLEIF `relationshipCount`
- `ttlMs: 0`: never cached, because readiness and the as-of timestamps are the payload

---

### `sanctions_vet_counterparty` <sub>prompt</sub>

- Arguments: `name` required; `jurisdiction` optional (a country code, which includes its subdivisions, or an ISO 3166-2 subdivision code)
- Returns one user message that screens the name (and any identifier the caller holds, with `sanctions_screen_identifier`), resolves it to an LEI, traces ownership with `screenNodes: true`, pulls each hit's designation record, and asks for a summary that treats every match as a candidate to verify. It names GLEIF parents as accounting-consolidation parents, not beneficial owners, and reports a reporting exception's reasons rather than reading it as "no parent"

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Sanctions-screening-specific:

- One screen covers OFAC SDN, OFAC Consolidated, EU, UK (UKSL), and UN; the matching list shows up as per-hit provenance
- Offline and keyless, with no per-request rate limit: all five sources are normalized into local SQLite + FTS5 mirrors via the framework `MirrorService`
- Per-alias name index, so a query matches any of an entity's names in one FTS scan, and a per-identifier index for exact lookup by IMO number, SWIFT/BIC, wallet address, or document number
- Strict-then-fuzzy matching: exact-normalized, then all tokens present (FTS5), then Jaro-Winkler + Double-Metaphone, with fuzzy candidates capped by `SANCTIONS_FUZZY_MAX_RESULTS`
- GLEIF Level 1 (who is who) and Level 2 (who owns whom) for entity resolution and ownership tracing

Agent-friendly output:

- Real signal with provenance: approximate hits carry the raw Jaro-Winkler `score` and a literal `queryTokenCoverage` count, never a blended confidence; every hit names its list, program, designation date, and the name that matched, typed `primary` / `aka` / `fka` / `low-quality-aka`
- Decision-support `caveat` in the output of `sanctions_screen_name`, `sanctions_screen_identifier`, `sanctions_get_designation`, `sanctions_get_entity`, and `sanctions_trace_ownership`
- Disclosed gaps: `totalAvailableBasis`, `screeningStatus`, `complete` / `truncated` / `missingEntityLeis`, and each node's `parentStatus` say what a response did not cover
- Typed errors: every tool and resource except the sources listing fails as `mirror_not_ready` (retryable) until its mirror is loaded; unknown IDs fail as `designation_not_found` or `lei_not_found`, and a reference number two designations share as `reference_ambiguous`; a name with no letter or digit fails as `name_not_searchable`, one past the length bound as `name_too_long`, and an identifier with nothing left once spacing and separators are removed as `identifier_not_searchable`

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

Add the following to your MCP client configuration file. The mirror is not bundled: populate it with `bun run mirror:init` before screening (see [Mirror lifecycle](#mirror-lifecycle)).

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
| `SANCTIONS_REFRESH_CRON` | Cron for the scheduled refresh (HTTP transport only). It refreshes the sanctions lists, then applies the GLEIF delta windows the checkpoint calls for, under one 4-hour bound. A GLEIF gap that needs `mirror:init` is logged, never loaded in-process. | `0 4 * * *` |
| `SANCTIONS_REFRESH_SKIP_GLEIF` | Set to `1` to skip the GLEIF leg of the scheduled refresh and of `mirror:refresh`. | unset |
| `SANCTIONS_FUZZY_MIN_SCORE` | Jaro-Winkler floor for fuzzy matches when `minScore` is omitted. | `0.85` |
| `SANCTIONS_FUZZY_MAX_RESULTS` | Cap on fuzzy candidates scored per query. | `50` |
| `OFAC_SDN_URL` | OFAC SDN advanced-XML URL. | official OFAC URL |
| `OFAC_CONSOLIDATED_URL` | OFAC Consolidated advanced-XML URL. | official OFAC URL |
| `EU_FSF_URL` | EU consolidated XML URL. Its `token` query value is a static public path component, not a credential. | official EU URL |
| `UK_SANCTIONS_URL` | UK Sanctions List (UKSL) XML URL. | official FCDO URL |
| `UN_SC_URL` | UN Security Council consolidated XML URL. | official UN URL |
| `GLEIF_GOLDEN_COPY_BASE_URL` | GLEIF golden-copy and delta download API. | `https://goldencopy.gleif.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. `createApp()` declares `stateless`; setting the variable overrides it. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |

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

The mirror loads out-of-band, never on the request path.

| Script | Purpose |
|:---|:---|
| `bun run mirror:init` | Full load: all five sanctions lists, the name and identifier indexes, then the GLEIF golden copies (Level 1 with its name index, Level 2, and reporting exceptions), recording each file's `ContentDate` as the GLEIF checkpoint. Safe to re-run; an interrupted run starts over. Set `SANCTIONS_INIT_SKIP_GLEIF=1` to load the sanctions lists only. |
| `bun run mirror:refresh` | Re-harvest the sanctions lists, removing designations a list's complete document no longer publishes (at most half of a list per run). Then bring GLEIF current from its checkpoint: per dataset, the smallest delta window (`IntraDay` to `LastMonth`) that reaches back to the last file applied, deletions included. Reporting exceptions with no recorded load get their golden copy. The same refresh runs on `SANCTIONS_REFRESH_CRON` under HTTP (deltas only), bounded at 4 hours like this script. Set `SANCTIONS_REFRESH_SKIP_GLEIF=1` to skip GLEIF. |
| `bun run mirror:verify` | Report mirror readiness, per-source record counts, the GLEIF Level 1 / Level 2 / reporting-exception counts, whether GLEIF alternate names are indexed, and the GLEIF checkpoint. |
| `bun run mirror:seed` | Load a small synthetic fixture for local smoke tests, with no downloads. |

A list that fails to download or arrives truncated keeps its stored rows and removes nothing, while every other list still refreshes and the name and identifier indexes are rebuilt. GLEIF still refreshes after it, and the run then exits non-zero naming each failed list (`ofac_sdn`, `eu`, …). `sanctionsAsOf` advances only on a run in which every list refreshed, and a first `mirror:init` with a failed list leaves the mirror not ready.

GLEIF advances all at once or not at all. `leiAsOf` and the checkpoint move only after every dataset's covering delta has applied, so an interrupted refresh leaves both where they were, and the next run re-applies from the same point. Two cases apply nothing to GLEIF, leave `leiAsOf` unchanged, and exit non-zero naming `mirror:init`: a checkpoint older than the one-month window, and a mirror with no checkpoint. Every mirror written by 0.3.0 or earlier has no checkpoint, so run `mirror:init` once after upgrading. Until then, traces read unpublished parents as `unknown`, and `sanctions_resolve_entity` searches legal names only, with a notice saying alternate names are not yet indexed: 0.3.0 stored other names without their types and no transliterated names at all, so the name index is built from the golden copy `mirror:init` loads, never from the stored rows. Every GLEIF write after that keeps the index current. A GLEIF write by an earlier release, after a rollback, leaves it behind, and resolution returns to legal names and the notice until the next `mirror:init`.

A mirror written by an earlier release upgrades in place on first open: the `designation` table gains its `reference_number` column, and the identifier index is built from the stored records before the first lookup, so `sanctions_screen_identifier` answers from a populated mirror without a re-init. What the earlier release did not read — reference numbers, the OFAC and UK identifiers beyond identity documents, and dates at published precision — arrives with the next sanctions refresh, so run `mirror:refresh` after upgrading rather than waiting for the cron. The index is also rebuilt on open whenever a sync it did not follow has changed the stored records, such as one an earlier release ran after a rollback.

Every leg of `mirror:init` and `mirror:refresh` streams in bounded batches, so peak memory tracks the batch size, not the source size. The sanctions XML totals about 172 MB. The GLEIF Level 1 golden copy is about 3.4M records (~890 MB compressed) and dominates disk use; its name index (~4M names) adds about 0.8 GB of that. The reporting exceptions add about 6.4M rows (~525 MiB on disk).

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
| `src/services/screening` | Screening service: mirrors, normalized schema, OFAC/EU/UK/UN/GLEIF ingesters, matching engine. |
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
| EU Consolidated Financial Sanctions List | European Commission / EEAS | Freely redistributable |
| UK Sanctions List (UKSL) | UK Foreign, Commonwealth & Development Office | [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) (attribution required) |
| UN Security Council Consolidated List | United Nations Security Council | Freely redistributable |
| GLEIF LEI data (Level 1 + Level 2) | Global Legal Entity Identifier Foundation | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) |

UKSL has been the single authoritative UK source since the OFSI Consolidated List closed on 28 January 2026.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
