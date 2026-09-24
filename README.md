<div align="center">
  <h1>@cyanheads/sanctions-screening-mcp-server</h1>
  <p><b>Screen names against the consolidated OFAC, EU, UK, and UN sanctions lists and resolve legal entities against GLEIF, fuzzy-matched offline over a local SQLite + FTS5 mirror. A screening aid, not a compliance determination.</b>
  <div>6 Tools • 3 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
| `sanctions_get_designation` | Fetch the full record for one designation by source list and entry ID |
| `sanctions_resolve_entity` | Resolve a company name, optionally within a jurisdiction, to ranked GLEIF LEI candidates |
| `sanctions_get_entity` | Fetch the GLEIF Level 1 record for an LEI, with a sanctions screen of its legal name |
| `sanctions_trace_ownership` | Trace an LEI's parents and children, optionally screening every entity in the graph |
| `sanctions_list_sources` | List the loaded sources with record counts, licenses, and mirror freshness |

### Resources

| Resource | Description |
|:---|:---|
| `sanctions://designation/{source}/{entryId}` | One sanctions designation by source and entry ID |
| `sanctions://entity/{lei}` | One GLEIF Level 1 entity by LEI |
| `sanctions://sources` | Loaded sources with counts and refresh timestamps |

All resource data is also reachable through the tools, for clients that don't surface resources.

### Prompts

| Prompt | Description |
|:---|:---|
| `sanctions_vet_counterparty` | Run a counterparty due-diligence pass: screen, resolve, trace ownership, summarize |

## Capability reference

### `sanctions_screen_name` <sub>tool</sub>

- `name` in any script (at most 64 words and 1,024 characters) plus optional `sources`, `entityType`, and `minScore` filters; `matchMode` is `strict` (default) or `fuzzy`, and strict falls back to fuzzy when it finds nothing; up to 100 hits per page (`limit`, default 25) with `offset`
- Hits carry `source`, `sourceEntryId`, `matchedName` with its `matchedNameType`, and `matchType` (`exact` / `strong` / `approximate`); approximate hits add the raw Jaro-Winkler `score` (0–1) and `queryTokenCoverage`
- `totalAvailable`, `hasMore`, and `nextOffset` page the rest; `totalAvailableBasis` marks the count `exact` or a `lower_bound`

---

### `sanctions_get_designation` <sub>tool</sub>

- `source` (`ofac_sdn`, `ofac_consolidated`, `eu`, `uk`, `un`) and `entryId`, the `sourceEntryId` from a screening hit
- All published aliases, identifiers, addresses, dates and places of birth, nationalities, program, legal basis, and designation date; a field the source omitted is absent, never filled in

---

### `sanctions_resolve_entity` <sub>tool</sub>

- `name` in any script (same bound as `sanctions_screen_name`) plus optional ISO 3166-1 alpha-2 `jurisdiction`, `status` (`issued` default, `lapsed`, `any`), and `minScore`; same `matchMode` behavior as `sanctions_screen_name`; up to 50 candidates per page (`limit`, default 10) with `offset`
- Candidates carry `lei`, `legalName`, the `matchedName` (legal or other/trading name), and `matchType`, with `score` and `queryTokenCoverage` on approximate matches; paged by the same `totalAvailable` / `totalAvailableBasis` / `hasMore` / `nextOffset` fields

---

### `sanctions_get_entity` <sub>tool</sub>

- One 20-character `lei`; returns legal and other names, legal and headquarters addresses, `status`, `jurisdiction`, registration authority, and `lastUpdate`
- `sanctionsHits` screens the legal name against every watchlist, strict-only and capped at 25; `screeningStatus` (`screened` / `not_ready`) says whether that screen ran, and `sanctionsScreen.hasMore` flags a capped list

---

### `sanctions_trace_ownership` <sub>tool</sub>

- Root `lei`, `direction` (`parents` / `children` / `both`, default `both`), and `depth` 1–5 (default 3); `screenNodes: true` screens every node's legal name, strict-only, up to 10 hits per node
- `nodes` (with `role` and `depth`) and `edges` (with `relationshipType`); `complete` is false when the graph is `truncated` at the depth limit or `missingEntityLeis` lists nodes with no Level 1 record
- `screeningStatus` (`screened` / `not_requested` / `not_ready`), `screenedNodeCount`, and `flaggedNodeCount`; each screened node reports its own `sanctionsScreen.hasMore`

---

### `sanctions_list_sources` <sub>tool</sub>

- No input; one row per sanctions list plus `gleif`, each with `recordCount`, `url`, and `license`
- `sanctionsReady` / `sanctionsAsOf` and `leiReady` / `leiAsOf` report whether each mirror has synced and when; not gated on readiness, so it reports an empty mirror instead of failing

---

### `sanctions://designation/{source}/{entryId}` <sub>resource</sub>

- `source` is one of the five list codes, `entryId` the list's own ID; returns the `sanctions_get_designation` payload as `application/json`
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

- Arguments: `name` required; `jurisdiction` (ISO 3166-1 alpha-2) optional
- Returns one user message that screens the name, resolves it to an LEI, traces ownership with `screenNodes: true`, pulls each hit's designation record, and asks for a summary that treats every match as a candidate to verify

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Sanctions-screening-specific:

- One screen covers OFAC SDN, OFAC Consolidated, EU, UK (UKSL), and UN; the matching list shows up as per-hit provenance
- Offline and keyless, with no per-request rate limit: all five sources are normalized into local SQLite + FTS5 mirrors via the framework `MirrorService`
- Per-alias name index, so a query matches any of an entity's names in one FTS scan
- Strict-then-fuzzy matching: exact-normalized, then all tokens present (FTS5), then Jaro-Winkler + Double-Metaphone, with fuzzy candidates capped by `SANCTIONS_FUZZY_MAX_RESULTS`
- GLEIF Level 1 (who is who) and Level 2 (who owns whom) for entity resolution and ownership tracing

Agent-friendly output:

- Real signal with provenance: approximate hits carry the raw Jaro-Winkler `score` and a literal `queryTokenCoverage` count, never a blended confidence; every hit names its list, program, designation date, and the name that matched, typed `primary` / `aka` / `fka` / `low-quality-aka`
- Decision-support `caveat` in the output of `sanctions_screen_name`, `sanctions_get_designation`, `sanctions_get_entity`, and `sanctions_trace_ownership`
- Disclosed gaps: `totalAvailableBasis`, `screeningStatus`, and `complete` / `truncated` / `missingEntityLeis` say what a response did not cover
- Typed errors: every tool and resource except the sources listing fails as `mirror_not_ready` (retryable) until its mirror is loaded; unknown IDs fail as `designation_not_found` or `lei_not_found`; a name with no letter or digit fails as `name_not_searchable`, and one past the length bound as `name_too_long`

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
| `SANCTIONS_REFRESH_CRON` | Cron for the scheduled sanctions-list refresh (HTTP transport only). GLEIF deltas are applied manually with `mirror:refresh`. | `0 4 * * *` |
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
| `bun run mirror:init` | Full load: all five sanctions lists, the name index, then the GLEIF golden copy (Level 1 + Level 2). Safe to re-run; an interrupted run starts over. Set `SANCTIONS_INIT_SKIP_GLEIF=1` to load the sanctions lists only. |
| `bun run mirror:refresh` | Re-harvest the sanctions lists, removing designations a list's complete document no longer publishes (at most half of a list per run), and apply the last day of GLEIF deltas. The sanctions half also runs on `SANCTIONS_REFRESH_CRON` under HTTP. Set `SANCTIONS_REFRESH_SKIP_GLEIF=1` to skip the deltas. |
| `bun run mirror:verify` | Report mirror readiness and per-source record counts. |
| `bun run mirror:seed` | Load a small synthetic fixture for local smoke tests, with no downloads. |

Every leg of `mirror:init` streams in bounded batches, so peak memory tracks the batch size, not the source size. The sanctions XML totals about 172 MB; the GLEIF Level 1 golden copy is about 3.3M records (~892 MB compressed) and dominates disk use.

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
