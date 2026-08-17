/**
 * @fileoverview Offline smoke checks for the registered MCP surface. Verifies
 * every tool, resource, and prompt remains exported with its public name and a
 * parseable minimal input contract.
 * @module tests/smoke/surface.smoke.test
 */

import { describe, expect, it } from 'vitest';
import { allPromptDefinitions } from '@/mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

describe('registered MCP surface', () => {
  it('exports all six tools exactly once', () => {
    const names = allToolDefinitions.map((definition) => definition.name);
    expect(names).toEqual([
      'sanctions_screen_name',
      'sanctions_get_designation',
      'sanctions_list_sources',
      'sanctions_resolve_entity',
      'sanctions_get_entity',
      'sanctions_trace_ownership',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('accepts the minimal documented input for every tool', () => {
    const inputs = new Map<string, Record<string, unknown>>([
      ['sanctions_screen_name', { name: 'Example Name' }],
      ['sanctions_get_designation', { source: 'ofac_sdn', entryId: '123' }],
      ['sanctions_list_sources', {}],
      ['sanctions_resolve_entity', { name: 'Example Holdings' }],
      ['sanctions_get_entity', { lei: '5493001KJTIIGC8Y1R12' }],
      ['sanctions_trace_ownership', { lei: '5493001KJTIIGC8Y1R12' }],
    ]);

    for (const definition of allToolDefinitions) {
      expect(definition.input.safeParse(inputs.get(definition.name)).success).toBe(true);
    }
  });

  it('exports all resource and prompt definitions exactly once', () => {
    expect(allResourceDefinitions.map((definition) => definition.uriTemplate.toString())).toEqual([
      'sanctions://designation/{source}/{entryId}',
      'sanctions://entity/{lei}',
      'sanctions://sources',
    ]);
    expect(allPromptDefinitions.map((definition) => definition.name)).toEqual([
      'sanctions_vet_counterparty',
    ]);
  });
});
