/**
 * @fileoverview Bundle filtering keeps dependency runtime skill modules while stripping author documentation.
 * @module tests/scripts/bundle-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as cleanerEntry } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as linterEntry } from '../../scripts/lint-packaging.js';

describe('dependency agent documentation filtering', () => {
  it.each([
    'node_modules/example/skills/example/SKILL.md',
    'node_modules/@example/package/framework-skills/add-tool/SKILL.md',
    'node_modules/example/node_modules/other/.agents/skills/example/SKILL.md',
    'node_modules/@example/package/node_modules/@other/package/skills/example/SKILL.md',
  ])('strips package-root agent documentation: %s', (entry) => {
    expect(cleanerEntry.test(entry)).toBe(true);
    expect(linterEntry.test(entry)).toBe(true);
  });

  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
    'node_modules/example/dist/skills/runtime.js',
    'skills/screen-counterparty/SKILL.md',
  ])('retains runtime modules and the published tree: %s', (entry) => {
    expect(cleanerEntry.test(entry)).toBe(false);
    expect(linterEntry.test(entry)).toBe(false);
  });
});
