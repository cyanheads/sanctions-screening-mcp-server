/**
 * @fileoverview Test for the sanctions_vet_counterparty prompt — verifies it
 * sequences the tools and carries the decision-support framing.
 * @module tests/prompts/vet-counterparty.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { vetCounterpartyPrompt } from '@/mcp-server/prompts/definitions/vet-counterparty.prompt.js';

describe('vetCounterpartyPrompt', () => {
  it('generates a workflow message referencing the screening tools', () => {
    const args = vetCounterpartyPrompt.args!.parse({ name: 'Acme Corp' });
    const messages = vetCounterpartyPrompt.generate(args);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    expect(text).toContain('Acme Corp');
    expect(text).toContain('sanctions_resolve_entity');
    expect(text).toContain('sanctions_trace_ownership');
    expect(text).toContain('sanctions_screen_name');
    // The load-bearing framing must be present.
    expect(text).toMatch(/screening aid/i);
    expect(text).toMatch(/not a clearance/i);
  });

  it('weaves the jurisdiction into the workflow when provided', () => {
    const args = vetCounterpartyPrompt.args!.parse({ name: 'Acme Corp', jurisdiction: 'US' });
    const messages = vetCounterpartyPrompt.generate(args);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    expect(text).toContain('US');
  });
});
