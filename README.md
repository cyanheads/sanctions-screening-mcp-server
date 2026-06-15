<div align="center">
  <h1>@cyanheads/sanctions-screening-mcp-server</h1>
  <p><b>Screen names against the consolidated OFAC, EU, UK, and UN sanctions lists and resolve legal entities against GLEIF, fuzzy-matched offline over a local SQLite + FTS5 mirror. A screening aid, not a compliance determination.</b>
  <div>6 Tools • 3 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/sanctions-screening-mcp-server/releases/latest/download/sanctions-screening-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=sanctions-screening-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc2FuY3Rpb25zLXNjcmVlbmluZy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22sanctions-screening-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fsanctions-screening-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://sanctions-screening.caseyjhand.com/mcp](https://sanctions-screening.caseyjhand.com/mcp)

</div>

---

> [!IMPORTANT]
> **This is a screening aid, not legal or compliance certification.** Every tool returns *potential matches* with a transparent score and source provenance — never a verdict. A hit means "review this candidate against the official source"; an empty result never means "cleared." Real sanctions compliance is a legal process — it requires human review and a qualified compliance determination. This server feeds that process; it does not perform it, and its output is not a compliance record.

## Overview

`sanctions-screening-mcp-server` turns the world's open sanctions data plus the global legal-entity registry into one screening-and-resolution workflow, answered offline and fuzzy-matched. It screens a name against the consolidated US (OFAC), EU, UK, and UN sanctions lists at once, and resolves legal entities against the GLEIF Legal Entity Identifier (LEI) database with corporate-ownership tracing.

All sources are bulk-downloadable, keyless, and clear for redistribution. The server mirrors them to a local SQLite + FTS5 index and serves matches from that mirror — no live API key, no per-request rate limit on the hot path. The agent sees screening verbs (`screen_name`, `resolve_entity`, `trace_ownership`); which list answered a query surfaces only as provenance on each hit.

The matching model is transparent by design: strict token matching first (exact-normalized, then all-tokens-present via FTS5), with a scored Jaro-Winkler + phonetic fuzzy fallback. Approximate hits carry the **raw Jaro-Winkler similarity (0–1)** — a real measurement, never a fabricated "confidence percentage."

## Tools

Six tools organized around two workflows — screen a name against the watchlists, and resolve a legal entity to its global identifier and ownership graph:

| Tool | Description |
|:---|:---|
| `sanctions_screen_name` | Screen a name (person, company, vessel, aircraft) against all loaded watchlists at once — OFAC SDN + Consolidated, EU, UK, UN — alias- and fuzzy-aware. Returns scored potential matches with source list, program, designation date, and the matched alias. |
| `sanctions_get_designation` | Fetch the full record for one sanctions designation by source list + entry ID: all aliases, identifiers, addresses, dates/places of birth, nationalities, program, legal basis, and designation date. |
| `sanctions_resolve_entity` | Resolve a company / organization name (+ optional jurisdiction) to ranked candidate GLEIF LEIs. Turns a free-text counterparty name into a stable global identifier. |
| `sanctions_get_entity` | Fetch the full GLEIF Level 1 record for one LEI — legal name, trading names, addresses, registration status, jurisdiction — plus a sanctions cross-reference screened on the legal name. |
| `sanctions_trace_ownership` | Trace the GLEIF Level 2 corporate-ownership graph for an LEI (parents and/or children, BFS to a bounded depth), optionally screening every node for beneficial-ownership screening. |
| `sanctions_list_sources` | List the loaded watchlists and GLEIF datasets with record counts, source URLs, licenses, and the mirror's readiness and as-of timestamps. |

### `sanctions_screen_name`

The 80% entry point — "is this entity on a watchlist?"

- Fans out across all four sanctions lists (OFAC SDN + Consolidated, EU, UK, UN) in one call; the source surfaces only as provenance per hit
- Alias-aware: matches against every published primary name, a.k.a., and f.k.a., not just the canonical name
- Strict mode (default): exact-normalized equality, then all-tokens-present via FTS5 — handles word-order swaps and missing interior words with no fuzzy library
- Fuzzy mode (opt-in, or automatic when strict finds nothing): adds Jaro-Winkler similarity and Double-Metaphone phonetic matching for transliteration-class misses
- Hits labeled `exact` / `strong` / `approximate`; approximate hits carry the raw Jaro-Winkler score (0–1)
- Filter by entity type, source list subset, similarity floor (`min_score`), and result limit
- On an empty result, returns guidance on how to broaden — and states explicitly that no match is **not** a clearance

---

### `sanctions_get_designation`

The drill-in after `sanctions_screen_name` surfaces a candidate.

- Full normalized record by `source` + `entry_id` (the `sourceEntryId` from a screen hit)
- All published aliases, structured identifiers (passport / national ID / tax / registration), addresses, dates and places of birth, nationalities, sanctioning program, legal basis, and designation date
- Preserves source sparsity — missing fields mean the source omitted them; the record is never padded with fabricated data

---

### `sanctions_resolve_entity`

The bridge from a free-text counterparty name to a stable LEI that the entity tools key off.

- Resolves a company / organization name to ranked GLEIF LEI candidates
- Optional ISO 3166-1 alpha-2 jurisdiction filter and registration-status filter (`issued` default, `lapsed`, or `any`)
- Same strict-then-fuzzy matching model as name screening; approximate hits carry the raw Jaro-Winkler score
- Matches against legal names and published other/trading names

---

### `sanctions_get_entity`

Who is this legal entity — plus a watchlist cross-reference in the same call.

- Full GLEIF Level 1 record: legal name, other/trading names, legal and headquarters addresses, registration status, jurisdiction, registration authority and ID, last-update date
- Cross-references the entity's legal name against all loaded watchlists (strict match only — auto-fuzzy on a generic legal name would flood the result with single-common-token false positives)
- LEI input is regex-validated (20 chars: 18 alphanumerics + 2 check digits)

---

### `sanctions_trace_ownership`

Beneficial-ownership screening — the cross-source workflow that single-list tools can't do.

- Traverses the GLEIF Level 2 ownership graph breadth-first to a bounded depth (1–5)
- `direction`: walk `parents` (who owns it), `children` (what it owns), or `both`
- Returns nodes (with role and depth) and directed ownership edges with relationship type
- `screen_nodes: true` screens every entity in the graph against all watchlists — "is anyone in this ownership chain sanctioned?"
- Per-node screen is strict-only and reports `screenedNodeCount` / `flaggedNodeCount` so a caller can see coverage at a glance

---

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `sanctions://designation/{source}/{entryId}` | One sanctions designation by source + entry ID (URI mirror of `sanctions_get_designation`). |
| Resource | `sanctions://entity/{lei}` | One GLEIF Level 1 entity by LEI (URI mirror of `sanctions_get_entity`'s entity payload, without the screening cross-reference). |
| Resource | `sanctions://sources` | Loaded lists + GLEIF datasets with counts and refresh timestamps (URI mirror of `sanctions_list_sources`). |
| Prompt | `sanctions_vet_counterparty` | Sequences the tools into a full counterparty due-diligence pass: resolve → trace ownership → screen the entity and every beneficial owner → summarize with provenance and the decision-support caveat. |

All resource data is also reachable via the tools, which are the primary path for tool-only MCP clients. The resources are a convenience for resource-capable clients only.

## Source lists

The server aggregates five upstream sources behind the screening surface. All are bulk, keyless, and clear for redistribution.

| Source | Role | License |
|:---|:---|:---|
| **OFAC SDN + Consolidated** (US Treasury) | Primary US sanctions/watchlist — individuals, entities, vessels, aircraft, with a.k.a. aliases | US Government public domain |
| **EU Consolidated Financial Sanctions List** | EU-designated persons and entities | Freely redistributable |
| **UK Sanctions List (UKSL, FCDO)** | UK sanctions targets — persons, entities, ships | Open Government Licence v3.0 |
| **UN Security Council Consolidated List** | UN-designated individuals and entities across all regimes | Freely redistributable |
| **GLEIF LEI (Level 1 + Level 2)** | Who-is-who (entity reference) and who-owns-whom (corporate ownership) | CC0 1.0 Universal |

The UK source is the **UK Sanctions List (UKSL)**, the single authoritative UK source since the OFSI Consolidated List closed on 28 January 2026.

### First run: populate the mirror

The mirror is **not bundled** — the sanctions lists and the GLEIF golden copy are downloaded and normalized on first run. Run the init lifecycle script out-of-band before screening:

```sh
bun run mirror:init
```

This harvests all four sanctions lists in full, rebuilds the per-alias name index, then streams the GLEIF golden copy (Level 1 entities + Level 2 ownership relationships). It is resumable and intended to run once, off the request path.

| Script | Purpose |
|:---|:---|
| `bun run mirror:init` | Full initial load of all sources (sanctions lists + GLEIF golden copy). |
| `bun run mirror:refresh` | Re-harvest the sanctions lists and apply GLEIF deltas. Also runs on a cron under HTTP transport. |
| `bun run mirror:verify` | Report mirror readiness and per-source record counts. |
| `bun run mirror:seed` | Load a small synthetic fixture for local smoke tests (no downloads). |

Set `SANCTIONS_INIT_SKIP_GLEIF=1` on `mirror:init` to load only the (small) sanctions lists and skip GLEIF.

> **GLEIF memory note:** the GLEIF Level 1 ingest is the memory-heavy leg — the full golden copy is roughly 3.3M LEI records (~490 MB compressed) and ~890 MB of resident memory during the streaming ingest. The four sanctions lists and the GLEIF deltas / Level 2 ownership data are light by comparison. Size the host accordingly for `mirror:init`, or skip GLEIF with `SANCTIONS_INIT_SKIP_GLEIF=1` if you only need watchlist screening.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Typed error contracts with recovery hints (`mirror_not_ready`, `designation_not_found`, `lei_not_found`)
- Pluggable auth: `none`, `jwt`, `oauth` (defaults to `none` — all data is public)
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Sanctions-specific:

- Multi-source, workflow-organized surface — one screen fans out across OFAC, EU, UK, and UN internally; sources surface only as provenance
- Local SQLite + FTS5 mirror via the framework `MirrorService` — offline, no live API key, no per-request rate limit
- Normalized common schema across the four sanctions lists, with a denormalized per-alias name index (one row per name and per alias) so a query matches any of an entity's names in one FTS scan
- Strict-then-fuzzy matching: exact-normalized → all-tokens-present (FTS5) → Jaro-Winkler + Double-Metaphone, capped to bound work on short queries
- GLEIF Level 1 + Level 2 ingest for entity resolution and beneficial-ownership tracing

Agent-friendly output:

- Real signal, not synthetic confidence — approximate hits carry the raw Jaro-Winkler similarity (0–1); strict hits carry a `match_type` (`exact` / `strong`), never a fabricated percentage
- Provenance on every hit — source list, sanctioning program, designation date, the exact name/alias that matched, and its type (`primary` / `aka` / `fka` / `low-quality-aka`)
- Decision-support caveat carried in every screening tool's output — a hit is a candidate to verify, an empty result is not a clearance
- Freshness surfaced via `sanctions_list_sources` — each source's record count and the mirror's as-of timestamp, so an agent can judge staleness

## Getting started

### Public Hosted Instance

A public instance is available at `https://sanctions-screening.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP, with this client config:

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

### Self-hosted / local

Add the following to your MCP client configuration file. The server is offline-first — populate the mirror with `bun run mirror:init` before screening (see [Source lists](#source-lists)).

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

- [Bun v1.3](https://bun.sh/) or higher (or Node.js v24+).
- Disk for the local mirror (the populated SQLite files; GLEIF Level 1 dominates). No API key for any source.

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

All sources are keyless — there is no required API key. Every variable below is optional with a sensible default.

| Variable | Description | Default |
|:---|:---|:---|
| `SANCTIONS_MIRROR_PATH` | Filesystem path for the SQLite mirror; a persistent volume on a hosted deployment. | `./data/sanctions.db` |
| `SANCTIONS_REFRESH_CRON` | Cron for the scheduled refresh of sanctions lists + GLEIF deltas (HTTP transport only). | `0 4 * * *` |
| `SANCTIONS_FUZZY_MIN_SCORE` | Default Jaro-Winkler similarity floor for fuzzy matches when `min_score` is omitted. | `0.85` |
| `SANCTIONS_FUZZY_MAX_RESULTS` | Hard cap on fuzzy candidates scored per query, to bound work on short queries. | `50` |
| `OFAC_SDN_URL` | Override for the OFAC SDN advanced-XML file. | official SLS URL |
| `OFAC_CONSOLIDATED_URL` | Override for the OFAC Consolidated advanced-XML file. | official SLS URL |
| `EU_FSF_URL` | Override for the EU consolidated XML file (includes the static public token path component). | official EU URL |
| `UK_SANCTIONS_URL` | Override for the UK Sanctions List (UKSL) XML file. | official FCDO URL |
| `UN_SC_URL` | Override for the UN Security Council consolidated XML file. | official UN URL |
| `GLEIF_GOLDEN_COPY_BASE_URL` | Override for the GLEIF golden-copy / delta download API. | `https://goldencopy.gleif.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |

Source URLs default to the verified official endpoints; overrides exist for testing and for pinning a mirror in restricted environments. The EU "token" is a static public path component, not a credential.

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

### Docker

```sh
docker build -t sanctions-screening-mcp-server .
docker run --rm -p 3010:3010 -v sanctions-data:/usr/src/app/data sanctions-screening-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/sanctions-screening-mcp-server`. The image runs under Bun, so the mirror uses `bun:sqlite` (no native build). Mount a volume at the mirror path (`/usr/src/app/data` by default) so the populated mirror survives container restarts, and run `bun run mirror:init` inside the container (`docker exec`) to populate it. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts, inits the screening service, schedules the HTTP refresh. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — the six screening/resolution tools. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`) — the three URI mirrors. |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`) — the counterparty vetting prompt. |
| `src/services/screening` | The screening service — local mirror, normalized schema, source ingesters (OFAC/EU/UK/UN/GLEIF), and the strict/fuzzy matching engine. |
| `scripts/mirror-*.ts` | Mirror lifecycle CLI — init, refresh, verify, seed. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external sources: validate raw → normalize to the common schema → return the output schema; never fabricate fields a source omits, and never synthesize a confidence score

## Attribution

This server redistributes open data from the following sources, cited here per their terms:

- **OFAC** SDN and Consolidated lists — US Department of the Treasury, Office of Foreign Assets Control (US Government public domain).
- **EU** Consolidated Financial Sanctions List — European Commission / EEAS (freely redistributable).
- **UK Sanctions List** — UK Foreign, Commonwealth & Development Office, licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) (attribution required).
- **UN** Security Council Consolidated List — United Nations Security Council (freely redistributable).
- **GLEIF** LEI data — Global Legal Entity Identifier Foundation, [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
