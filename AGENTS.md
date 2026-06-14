# Developer Protocol

**Server:** sanctions-screening-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.10.6`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What This Server Is

Entity screening and resolution over the world's open sanctions data plus the global legal-entity registry, served offline. It screens a name against the consolidated OFAC (SDN + Consolidated), EU, UK (UKSL), and UN sanctions lists at once, and resolves legal entities against the GLEIF LEI database with corporate-ownership tracing.

**Screening aid, not a compliance determination.** Every tool returns *potential matches* with a transparent score and source provenance — never a verdict. This framing is load-bearing: it lives in `SCREENING_CAVEAT` (`src/mcp-server/tools/definitions/_shared.ts`), in every screening tool's description, and in its output. A hit is a candidate to verify against the official source; an empty result is never a clearance. Preserve it in any edit to the surface.

**The data path is a local mirror, not a live API.** All five sources are bulk, keyless, and clear for redistribution. They are normalized into two local SQLite + FTS5 mirrors via the framework `MirrorService` — a sanctions `designation` mirror with a per-alias `name` index (Double-Metaphone phonetic keys), and a GLEIF `lei_entity` mirror with a `lei_relationship` ownership table. The real corpus loads out-of-band via `bun run mirror:init`; the read path gates on mirror readiness. **Do not commit or modify the populated `data/` mirrors** — they are environment state, not source.

**Match signal is the raw Jaro-Winkler value (0–1) — never a fabricated confidence percentage.** Strict matching (exact-normalized → all-tokens-present via FTS5) is the default and the ~90% path; fuzzy (Jaro-Winkler + phonetic) is opt-in or auto-on-empty. Surface only real signal: `match_type` (`exact`/`strong`/`approximate`), the matched name and its type, and the raw score for approximate hits.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Real example: `sanctions_screen_name` (trimmed). Note the typed error contract (`ctx.fail` + `ctx.recoveryFor`), the load-bearing caveat in the output, and the `enrichment` block for non-result metadata (normalized query, mode used, empty-result notice).

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_CODES, SOURCE_LABELS } from '@/services/screening/types.js';
import { SCREENING_CAVEAT } from './_shared.js';

export const screenNameTool = tool('sanctions_screen_name', {
  title: 'sanctions-screening-mcp-server: screen name',
  description: 'Screen a name against all loaded sanctions watchlists at once … a screening AID, not a compliance determination.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    name: z.string().min(1).describe('The name to screen (person, organization, vessel, or aircraft).'),
    matchMode: z.enum(['strict', 'fuzzy']).default('strict').describe('strict: exact then all-tokens-present. fuzzy: also Jaro-Winkler + phonetic.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum number of potential matches to return.'),
    // … entityType, minScore, sources
  }),
  output: z.object({
    hits: z.array(HitSchema).describe('Scored potential matches, highest-confidence first.'),
    caveat: z.string().describe('Decision-support caveat — a screening aid, not a compliance determination.'),
  }),
  enrichment: {
    normalizedQuery: z.string().describe('The name as the server folded it for matching.'),
    matchModeUsed: z.string().describe('The match mode actually applied (strict may auto-upgrade to fuzzy on empty).'),
    totalCount: z.number().describe('Number of potential matches returned.'),
    notice: z.string().optional().describe('Guidance when no candidate matched.'),
  },
  errors: [
    { reason: 'mirror_not_ready', code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The sanctions mirror has never completed an initial sync.', retryable: true,
      recovery: 'Run the mirror:init lifecycle script to load the sanctions lists, then retry.' },
  ],

  async handler(input, ctx) {
    const svc = getScreeningService();
    if (!(await svc.sanctionsReady())) {
      throw ctx.fail('mirror_not_ready', 'The local sanctions mirror is not yet populated.', { ...ctx.recoveryFor('mirror_not_ready') });
    }
    const sources = input.sources?.length ? input.sources : [...SOURCE_CODES];
    const result = await svc.screenName({ query: input.name, matchMode: input.matchMode, sources, limit: input.limit }, ctx);
    ctx.enrich({ normalizedQuery: result.normalizedQuery, matchModeUsed: result.modeUsed });
    ctx.enrich.total(result.hits.length);
    return { hits: result.hits.map((h) => ({ ...h, sourceLabel: SOURCE_LABELS[h.source] })), caveat: SCREENING_CAVEAT };
  },

  // format() populates content[] — the markdown twin of structuredContent. Both
  // surfaces must carry the same data (lint-enforced). The caveat renders last.
  format: (result) => [{ type: 'text', text: renderHits(result) }],
});
```

### Resource

Real example: `sanctions://entity/{lei}` — a URI mirror of `sanctions_get_entity`'s entity payload (the screening cross-reference is tool-only). Resources mirror tool data for resource-capable clients; tools are the primary path.

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getScreeningService } from '@/services/screening/screening-service.js';

export const entityResource = resource('sanctions://entity/{lei}', {
  name: 'sanctions-screening-mcp-server: entity',
  title: 'sanctions-screening-mcp-server: entity',
  description: "Fetch one GLEIF Level 1 legal-entity record by LEI — a read-only URI mirror of sanctions_get_entity's entity payload.",
  mimeType: 'application/json',
  params: z.object({
    lei: z.string().regex(/^[A-Z0-9]{18}[0-9]{2}$/, 'LEI must be 20 chars: 18 alphanumerics + 2 check digits.').describe('The 20-character GLEIF Legal Entity Identifier.'),
  }),
  errors: [
    { reason: 'lei_not_found', code: JsonRpcErrorCode.NotFound,
      when: 'No GLEIF entity exists for the given LEI in the mirror.',
      recovery: 'Resolve the entity name with sanctions_resolve_entity to obtain a valid LEI first.' },
  ],
  async handler(params, ctx) {
    const entity = await getScreeningService().getLeiEntity(params.lei);
    if (!entity) throw ctx.fail('lei_not_found', `No GLEIF entity with LEI "${params.lei}".`, { ...ctx.recoveryFor('lei_not_found') });
    return entity;
  },
});
```

### Prompt

Real example: `sanctions_vet_counterparty` — sequences the existing tools into a due-diligence workflow. No new capability; a reusable framing.

```ts
import { prompt, z } from '@cyanheads/mcp-ts-core';

export const vetCounterpartyPrompt = prompt('sanctions_vet_counterparty', {
  title: 'sanctions-screening-mcp-server: vet counterparty',
  description: 'Structure a full counterparty due-diligence pass: resolve the name to an LEI, pull the ownership tree, screen the named entity and every beneficial owner, and summarize hits with provenance and the decision-support caveat.',
  args: z.object({
    name: z.string().describe('The counterparty name to vet (person or organization).'),
    jurisdiction: z.string().optional().describe('Optional ISO 3166-1 alpha-2 jurisdiction to disambiguate (e.g. "US").'),
  }),
  generate: (args) => [
    { role: 'user', content: { type: 'text', text: `Run a counterparty due-diligence pass on "${args.name}". Screen the name, resolve it to an LEI, trace ownership with screen_nodes:true, then summarize every potential match as a candidate to verify — never a determination.` } },
  ],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config.
// All sources are keyless; there are no secret values here. Every field is
// optional with a default — the mirror path, fuzzy-match tuning, the refresh
// cron, and per-source URL overrides.
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  mirrorPath: z.string().default('./data/sanctions.db').describe('Filesystem path for the SQLite mirror.'),
  refreshCron: z.string().default('0 4 * * *').describe('Cron for the scheduled refresh (HTTP only).'),
  fuzzyMinScore: z.coerce.number().min(0).max(1).default(0.85).describe('Default Jaro-Winkler floor for fuzzy matches.'),
  fuzzyMaxResults: z.coerce.number().int().min(1).default(50).describe('Hard cap on fuzzy candidates scored per query.'),
  // … per-source URL overrides (ofacSdnUrl, euFsfUrl, ukSanctionsUrl, unScUrl, gleifGoldenCopyBaseUrl)
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    mirrorPath: 'SANCTIONS_MIRROR_PATH',
    refreshCron: 'SANCTIONS_REFRESH_CRON',
    fuzzyMinScore: 'SANCTIONS_FUZZY_MIN_SCORE',
    fuzzyMaxResults: 'SANCTIONS_FUZZY_MAX_RESULTS',
    // … OFAC_SDN_URL, EU_FSF_URL, UK_SANCTIONS_URL, UN_SC_URL, GLEIF_GOLDEN_COPY_BASE_URL
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`SANCTIONS_MIRROR_PATH`) not the path (`mirrorPath`). Throws `ConfigurationError`, which the framework prints as a clean startup banner.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

```ts
await createApp({
  name: 'my-mcp-server',
  title: 'My Server',                         // human-readable display name
  websiteUrl: 'https://github.com/owner/repo', // canonical homepage URL
  description: 'One-line description.',        // wins over MCP_SERVER_DESCRIPTION
  icons: [{ src: 'https://example.com/icon.png', sizes: ['48x48'], mimeType: 'image/png' }],
  instructions: 'Use shortcut alpha for the most common case.', // session-level context
});
```

`instructions` is optional server-level orientation, sent on every `initialize` as session-level context. Use it for deployment guidance (connection aliases, regional notes, scope hints) instead of repeating the same context across tool descriptions. Client adoption is uneven, but there's no downside when set.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.fail` / `ctx.recoveryFor` | Typed error contract — `ctx.fail(reason, msg, …)` against the tool's `errors[]` union; `ctx.recoveryFor(reason)` pulls the declared recovery metadata. Used by every read tool to throw `mirror_not_ready` / `*_not_found`. |
| `ctx.enrich` | Attach non-result metadata to the response — `ctx.enrich({ … })`, `ctx.enrich.total(n)`, `ctx.enrich.notice(text)`. Used by `screen_name` / `resolve_entity` for the normalized query, the mode actually applied, and the empty-result guidance. |
| `ctx.signal` | `AbortSignal` for cancellation (propagated into the mirror sync on the refresh path). |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

This server's persistence is the local SQLite mirror, owned by the screening service and reached via `getScreeningService()` — not `ctx.state`. The data is a shared global corpus, not tenant-scoped KV, so the service-accessor pattern replaces `ctx.state` here.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point; schedules HTTP mirror refresh
  config/
    server-config.ts                    # Server-specific env vars (Zod schema) — mirror path, fuzzy tuning, source URLs
  services/
    screening/
      screening-service.ts              # Owns the local mirrors + matching engine (init/accessor pattern)
      schema.ts                         # Normalized designation/name/lei_entity/lei_relationship schema + MirrorService defs
      sanctions-ingest.ts               # OFAC/EU/UK/UN sync ingesters (XML → normalized designations)
      gleif-ingest.ts                   # GLEIF golden-copy + delta harvest (L1 entities, L2 relationships)
      text-matching.ts                  # Fold/tokenize, Jaro-Winkler, Double-Metaphone
      types.ts                          # Source codes, labels, domain types
      fixtures.ts                       # Synthetic fixture for mirror:seed / tests
      xml.ts                            # Streaming XML parse helpers
  mcp-server/
    tools/definitions/
      *.tool.ts                         # Six tools (screen-name, get-designation, resolve-entity, get-entity, trace-ownership, list-sources)
      _shared.ts                        # SCREENING_CAVEAT (load-bearing decision-support caveat)
    resources/definitions/
      *.resource.ts                     # Three URI mirrors (designation, entity, sources)
    prompts/definitions/
      vet-counterparty.prompt.ts        # Counterparty due-diligence workflow prompt
scripts/
  mirror-init.ts / mirror-refresh.ts / mirror-verify.ts / mirror-seed.ts   # Mirror lifecycle CLI
  _mirror-context.ts                    # Shared bootstrap shim for the mirror scripts
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror` | MirrorService — persistent self-refreshing local mirror of a bulk upstream dataset (embedded SQLite + FTS5). The data path this server is built on. |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog/skills/docs sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `bun run tree` | Generate directory structure doc (`docs/tree.md`) |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run lint:mcp` | Validate MCP definitions against the linter rule catalog |
| `bun run lint:packaging` | Validate `manifest.json` ↔ `server.json` env-var consistency |
| `bun test` | Run the Vitest suite |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run mirror:init` | Full out-of-band initial load of all sources (sanctions lists + GLEIF golden copy). Hours-long, resumable; never on the request path. |
| `bun run mirror:refresh` | Re-harvest sanctions lists and apply GLEIF deltas. Also runs on a cron under HTTP. |
| `bun run mirror:verify` | Report mirror readiness and per-source record counts. |
| `bun run mirror:seed` | Load a small synthetic fixture for local smoke tests (no downloads). |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create the GitHub release from the changelog/tag. |

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips dependency-shipped agent docs (`node_modules/**` `skills/`, `.claude/`, `.agents/`, `SKILL.md`) that root-anchored `.mcpbignore` patterns cannot reach. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SCREENING_CAVEAT } from '@/mcp-server/tools/definitions/_shared.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Source normalization reviewed against real upstream sparsity/nullability before finalizing required vs optional fields (the four sanctions XML shapes differ widely; UK XML is the messiest)
- [ ] Normalization and `format()` preserve uncertainty; never fabricate facts from missing source data
- [ ] Tests include at least one sparse payload case with omitted source fields
- [ ] **Screening-aid framing preserved** — `SCREENING_CAVEAT` in every screening tool's output; descriptions say "candidate to verify," empty result is "not a clearance"
- [ ] **No fabricated confidence** — approximate hits surface the raw Jaro-Winkler score (0–1); never a composite/synthesized percentage
- [ ] **Read path gates on mirror readiness** — `svc.sanctionsReady()` / `svc.leiReady()` before querying; throw `mirror_not_ready` otherwise
- [ ] Display identity is `sanctions-screening-mcp-server` everywhere (`name`/`title`, manifest, docs) — never Title Case
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
