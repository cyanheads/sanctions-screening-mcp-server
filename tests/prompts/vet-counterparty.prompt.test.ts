/**
 * @fileoverview Test for the sanctions_vet_counterparty prompt — verifies it
 * sequences the tools and carries the decision-support framing.
 * @module tests/prompts/vet-counterparty.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { vetCounterpartyPrompt } from '@/mcp-server/prompts/definitions/vet-counterparty.prompt.js';

describe('vetCounterpartyPrompt', () => {
  it('generates a workflow message referencing the screening tools', async () => {
    const args = vetCounterpartyPrompt.args!.parse({ name: 'Acme Corp' });
    const messages = await vetCounterpartyPrompt.generate(args);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    expect(text).toContain('Acme Corp');
    expect(text).toContain('sanctions_resolve_entity');
    expect(text).toContain('sanctions_trace_ownership');
    expect(text).toContain('sanctions_screen_name');
    // The load-bearing framing must be present.
    expect(text).toMatch(/screening aid/i);
    expect(text).toMatch(/not a clearance/i);
  });

  it('never equates GLEIF parents and subsidiaries with beneficial owners', async () => {
    const args = vetCounterpartyPrompt.args!.parse({ name: 'Acme Corp' });
    const messages = await vetCounterpartyPrompt.generate(args);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    expect(text).not.toMatch(/beneficial owner/i);
    expect(vetCounterpartyPrompt.description).not.toMatch(/beneficial owner/i);
    expect(text).toMatch(/accounting-consolidation parents/i);
    // A parent GLEIF does not name is reported as such, not read as "no parent".
    expect(text).toMatch(/reporting exception/i);
  });

  it('summarizes what produced each match, a name or an identifier (#37, #56)', async () => {
    const args = vetCounterpartyPrompt.args!.parse({ name: 'Acme Corp' });
    const messages = await vetCounterpartyPrompt.generate(args);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    expect(text).toMatch(/every other and transliterated name/i);
    expect(text).toMatch(/LEI and registration number/i);
    expect(text).toMatch(/from matchedOn/);
    expect(text).toMatch(/matchedIdentifiers and no matchedName came from an identifier alone/);
  });

  it('asks for a match type and score only where a hit carries them', async () => {
    const args = vetCounterpartyPrompt.args!.parse({ name: 'Acme Corp' });
    const messages = await vetCounterpartyPrompt.generate(args);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    // An identifier-only hit has neither; a strict name match has a type and no score.
    expect(text).not.toMatch(/the match type and score,/);
    expect(text).toMatch(/for a name match its match type, and its score when approximate/);
    expect(text).toMatch(/an identifier match has neither/);
  });

  it('names every list of a hit in the summary, an OFAC party on both OFAC lists as one (#61)', async () => {
    const args = vetCounterpartyPrompt.args!.parse({ name: 'Acme Corp' });
    const messages = await vetCounterpartyPrompt.generate(args);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    expect(text).toMatch(/every list in the hit's sources/);
    expect(text).toMatch(/one hit, not two/);
  });

  it('never asks for a fuzzy retry the empty strict screen has already run (#36)', async () => {
    const args = vetCounterpartyPrompt.args!.parse({ name: 'Acme Corp' });
    const messages = await vetCounterpartyPrompt.generate(args);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    expect(text).not.toMatch(/retry with matchMode/i);
  });

  it('weaves the jurisdiction into the workflow when provided', async () => {
    const args = vetCounterpartyPrompt.args!.parse({ name: 'Acme Corp', jurisdiction: 'US' });
    const messages = await vetCounterpartyPrompt.generate(args);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    expect(text).toContain('US');
  });

  it('describes the jurisdiction argument as a country that includes its subdivisions (#36)', () => {
    const description = vetCounterpartyPrompt.args!.shape.jurisdiction.description ?? '';
    expect(description).toMatch(/subdivision/i);
    expect(description).toMatch(/US-DE/);
  });
});
