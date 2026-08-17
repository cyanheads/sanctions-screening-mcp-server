# sanctions-screening-mcp-server - Directory Structure

Generated on: 2026-08-17 02:15:00

```text
sanctions-screening-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   └── design.md
├── scripts/
│   ├── _mirror-context.ts
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── mirror-init.ts
│   ├── mirror-refresh.ts
│   ├── mirror-seed.ts
│   ├── mirror-verify.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       ├── index.ts
│   │   │       └── vet-counterparty.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── designation.resource.ts
│   │   │       ├── entity.resource.ts
│   │   │       ├── index.ts
│   │   │       └── sources.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── _shared.ts
│   │           ├── get-designation.tool.ts
│   │           ├── get-entity.tool.ts
│   │           ├── index.ts
│   │           ├── list-sources.tool.ts
│   │           ├── resolve-entity.tool.ts
│   │           ├── screen-name.tool.ts
│   │           └── trace-ownership.tool.ts
│   ├── services/
│   │   └── screening/
│   │       ├── fixtures.ts
│   │       ├── gleif-ingest.ts
│   │       ├── ingest-validation.ts
│   │       ├── sanctions-ingest.ts
│   │       ├── schema.ts
│   │       ├── screening-service.ts
│   │       ├── text-matching.ts
│   │       ├── types.ts
│   │       ├── xml-stream.ts
│   │       └── xml.ts
│   └── index.ts
├── tests/
│   ├── fuzz/
│   │   ├── definition-surface.fuzz.test.ts
│   │   └── ingest-and-matcher.fuzz.test.ts
│   ├── integration/
│   │   ├── matching-correctness.test.ts
│   │   ├── ownership-correctness.test.ts
│   │   ├── tool-state-contracts.test.ts
│   │   └── upstream-boundaries.test.ts
│   ├── prompts/
│   │   └── vet-counterparty.prompt.test.ts
│   ├── resources/
│   │   └── resource-contracts.test.ts
│   ├── services/
│   │   ├── _helpers.ts
│   │   ├── ingest-parsers.test.ts
│   │   ├── sanctions-sync.test.ts
│   │   ├── screening-service.test.ts
│   │   └── text-matching.test.ts
│   ├── smoke/
│   │   └── surface.smoke.test.ts
│   └── tools/
│       ├── format-parity.test.ts
│       └── screening-tools.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
