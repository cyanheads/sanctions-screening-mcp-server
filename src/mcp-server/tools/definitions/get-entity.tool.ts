/**
 * @fileoverview `sanctions_get_entity` — the full GLEIF Level 1 record for one
 * LEI, plus the sanctions cross-reference of that entity: its legal name and
 * every other and transliterated name screened strict, and its LEI and
 * country-matched registration number looked up as identifiers. Combines the
 * who-is-who reference data with a cross-reference screen so an agent sees both
 * "who is this entity" and "is it on a watchlist" in one call. The
 * cross-reference says what it could not do: `screeningStatus` reports whether
 * it ran at all, and `sanctionsScreen` reports whether its hit list was capped.
 * @module mcp-server/tools/definitions/get-entity.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { crossReferenceEntity } from '@/services/screening/cross-reference.js';
import { leiChecksumValid } from '@/services/screening/lei-checksum.js';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_LABELS } from '@/services/screening/types.js';
import {
  alsoListedText,
  crossReferencePointer,
  gleifNameTypeText,
  HitSourcesSchema,
  MatchedIdentifierSchema,
  matchedIdentifierText,
  SCREENING_CAVEAT,
  ScreenedInputSchema,
  screenedInputText,
} from './_shared.js';

const LEI_RE = /^[A-Z0-9]{18}[0-9]{2}$/;

/**
 * Potential matches the cross-reference returns, after merging every input's
 * hits to one per designation. The cross-reference sits beside a Level 1 record
 * rather than replacing the screening surface, so its hit list is a preview, not
 * the whole set: `sanctionsScreen` reports `totalAvailable` / `hasMore`, and an
 * entity with more matches than this is re-screened in full with
 * `sanctions_screen_name` and `sanctions_screen_identifier`.
 */
const CROSS_REFERENCE_SCREEN_LIMIT = 25;

export const getEntityTool = tool('sanctions_get_entity', {
  title: 'sanctions-screening-mcp-server: get entity',
  description:
    "Fetch the full GLEIF Level 1 record for one LEI: legal name, other/trading names, legal and headquarters addresses, registration status, jurisdiction, registration authority and ID, and last-update date — plus a sanctions cross-reference against all loaded watchlists. The cross-reference screens the legal name and every other and transliterated name strict (exact, then all tokens present — never fuzzy, unlike sanctions_screen_name), and looks up the LEI and the registration number as exact non-document identifiers, the registration number matching only an identifier published for the country of the entity's legal jurisdiction. Hits merge to one per designation, an OFAC party both OFAC lists publish to one hit whose sources names both: matchedOn names every input that produced each, and a hit only an identifier produced carries matchedIdentifiers and no matchedName. The screening cross-reference is a screening AID: a hit is a candidate to verify against the official source, and no hit is not a clearance. screeningStatus says whether that cross-reference actually ran — an empty sanctionsHits under not_ready means the sanctions mirror was unavailable, not that nothing matched. sanctionsScreen says whether the hit list is the whole set: it reports how many potential matches existed before the cap, so a capped cross-reference is distinguishable from a complete one. LEI must be a 20-character GLEIF identifier (18 alphanumerics + 2 check digits).",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    lei: z
      .string()
      .regex(
        LEI_RE,
        'LEI must be 20 chars: 18 alphanumerics + 2 check digits (e.g. 5493001KJTIIGC8Y1R12).',
      )
      .describe('The 20-character GLEIF Legal Entity Identifier to look up.'),
  }),
  output: z.object({
    lei: z.string().describe('The 20-character GLEIF Legal Entity Identifier.'),
    legalName: z.string().describe('Registered legal name.'),
    otherNames: z
      .array(z.string())
      .describe(
        'Other names published in the LEI record (trading, previous, and alternative-language legal names), as plain strings.',
      ),
    alternateNames: z
      .array(
        z
          .object({
            name: z.string().describe('The name as published.'),
            type: z
              .string()
              .describe(
                "GLEIF name type: PREVIOUS_LEGAL_NAME (a former legal name, not the current one), TRADING_OR_OPERATING_NAME, ALTERNATIVE_LANGUAGE_LEGAL_NAME, PREFERRED_ASCII_TRANSLITERATED_LEGAL_NAME, AUTO_ASCII_TRANSLITERATED_LEGAL_NAME, or UNKNOWN for a name the mirror stored without GLEIF's type.",
              ),
          })
          .describe('One name GLEIF publishes beside the legal name.'),
      )
      .describe(
        'Every other and transliterated name with its type, in the order published — the typed view of otherNames plus the ASCII transliterations of a legal name in another script.',
      ),
    jurisdiction: z.string().optional().describe('Legal jurisdiction (ISO code), when published.'),
    status: z.string().optional().describe('Registration status (e.g. ISSUED, LAPSED).'),
    legalAddress: z.string().optional().describe('Single-line legal address, when published.'),
    headquartersAddress: z
      .string()
      .optional()
      .describe('Single-line headquarters address, when published.'),
    registrationAuthorityId: z
      .string()
      .optional()
      .describe('Registration authority (RA) code, when published.'),
    registrationAuthorityEntityId: z
      .string()
      .optional()
      .describe("The entity's ID at its registration authority, when published."),
    lastUpdate: z
      .string()
      .optional()
      .describe('ISO 8601 last-update timestamp from the LEI record.'),
    sanctionsHits: z
      .array(
        z
          .object({
            source: z
              .enum(['ofac_sdn', 'ofac_consolidated', 'eu', 'uk', 'un'])
              .describe(
                'Watchlist whose record this hit is attributed to: primaryName comes from it. For an OFAC party both OFAC lists publish, ofac_sdn unless the Consolidated record matched alone or better, and matchedName, matchedIdentifiers, and matchedOn cover what either record matched; sources names every list.',
              ),
            sourceLabel: z.string().describe('Human-readable source list name.'),
            sourceEntryId: z
              .string()
              .describe('Source entry ID — pass to sanctions_get_designation.'),
            sources: HitSourcesSchema,
            primaryName: z.string().describe('Primary published name of the designation.'),
            matchedName: z
              .string()
              .optional()
              .describe(
                "The designation's name or alias that matched one of the entity's screened names — the strongest match. Absent when only an identifier produced the hit.",
              ),
            matchType: z
              .enum(['exact', 'strong', 'approximate'])
              .optional()
              .describe(
                'Match classification of matchedName: exact or strong, never approximate (the cross-reference screens strict, never fuzzy). Absent when only an identifier produced the hit.',
              ),
            score: z
              .number()
              .optional()
              .describe(
                'Never set by this cross-reference: only an approximate (fuzzy) match carries a raw Jaro-Winkler score, and the cross-reference screens strict.',
              ),
            matchedIdentifiers: z
              .array(MatchedIdentifierSchema)
              .optional()
              .describe(
                "Every identifier the designation publishes that equals the entity's LEI or its country-matched registration number, as published. Present only when an identifier produced the hit.",
              ),
            matchedOn: z
              .array(ScreenedInputSchema)
              .describe(
                'Every input of the entity that produced this hit — its legal name, an other or transliterated name, its LEI, or its registration number — in screening order.',
              ),
          })
          .describe(
            "A potential watchlist match on one or more of the entity's names or identifiers — verify, do not assume.",
          ),
      )
      .describe(
        'Sanctions screening cross-reference of the entity, one hit per designation (an OFAC party both OFAC lists publish once): exact name and identifier matches first, then strong name matches.',
      ),
    sanctionsScreen: z
      .object({
        totalAvailable: z
          .number()
          .int()
          .describe(
            'Distinct designations the cross-reference found across every screened name and identifier, an OFAC party both OFAC lists publish counted once, before the cap was applied.',
          ),
        totalAvailableBasis: z
          .enum(['exact', 'lower_bound'])
          .describe(
            'How to read totalAvailable. Always exact here: every name is screened strict, never fuzzy, and a strict screen counts every designation it reaches, so totalAvailable is the whole set across the screened names and identifiers.',
          ),
        hasMore: z
          .boolean()
          .describe(
            "True when the potential matches were capped — re-screen the entity's names with sanctions_screen_name and look up its LEI and registration number with sanctions_screen_identifier to see the rest.",
          ),
        screenedInputs: z
          .array(ScreenedInputSchema)
          .describe(
            'What the cross-reference screened beyond the legal name and the LEI, which it always screens: every other and transliterated name, then the registration number when the entity publishes one (a not-available placeholder such as N/A is none) and a legal jurisdiction to match it by. Empty when there is nothing beyond those two.',
          ),
      })
      .optional()
      .describe(
        "Disclosure for the cross-reference: how many potential matches existed before the cap, whether sanctionsHits is the complete set, and what was screened. Present only when screeningStatus is 'screened'.",
      ),
    screeningStatus: z
      .enum(['screened', 'not_ready'])
      .describe(
        "Whether the cross-reference ran: screened = the entity's names and identifiers were screened against every loaded watchlist; not_ready = the sanctions mirror has never synced, so no screening ran and the empty sanctionsHits says nothing about this entity. Read sanctionsHits only when this is 'screened'.",
      ),
    caveat: z
      .string()
      .describe(
        'Decision-support caveat — the screening cross-reference is an aid, not a determination.',
      ),
  }),
  errors: [
    {
      reason: 'lei_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No GLEIF entity in the mirror carries the LEI, and its check digits are valid.',
      recovery:
        'Resolve the entity name with sanctions_resolve_entity to obtain a valid LEI first.',
    },
    {
      reason: 'invalid_lei_checksum',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No GLEIF entity in the mirror carries the LEI, and its ISO 17442 check digits fail.',
      recovery:
        'Re-check the LEI for a mistyped or transposed character, or resolve the entity name with sanctions_resolve_entity to obtain a valid LEI.',
    },
    {
      reason: 'mirror_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The GLEIF (LEI) mirror has never completed an initial sync.',
      retryable: true,
      recovery: 'Run the mirror:init lifecycle script to load the GLEIF golden copy, then retry.',
    },
  ],

  async handler(input, ctx) {
    const svc = getScreeningService();
    if (!(await svc.leiReady())) {
      throw ctx.fail('mirror_not_ready', 'The local GLEIF (LEI) mirror is not yet populated.');
    }

    const entity = await svc.getLeiEntity(input.lei);
    if (!entity) {
      throw leiChecksumValid(input.lei)
        ? ctx.fail('lei_not_found', `No GLEIF entity with LEI "${input.lei}".`)
        : ctx.fail(
            'invalid_lei_checksum',
            `LEI "${input.lei}" fails its ISO 17442 check digits, and no GLEIF entity carries it.`,
          );
    }

    // The cross-reference runs only when the sanctions mirror is ready. When it
    // isn't, `screeningStatus` carries that: an empty `sanctionsHits` from a
    // screen that never ran must not read like a clean one.
    const sanctionsReady = await svc.sanctionsReady();
    const screeningStatus: 'screened' | 'not_ready' = sanctionsReady ? 'screened' : 'not_ready';
    const screen = sanctionsReady
      ? await crossReferenceEntity(svc, entity, CROSS_REFERENCE_SCREEN_LIMIT, ctx)
      : undefined;

    return {
      lei: entity.lei,
      legalName: entity.legalName,
      otherNames: entity.otherNames,
      alternateNames: entity.alternateNames,
      ...(entity.jurisdiction ? { jurisdiction: entity.jurisdiction } : {}),
      ...(entity.status ? { status: entity.status } : {}),
      ...(entity.legalAddress ? { legalAddress: entity.legalAddress } : {}),
      ...(entity.headquartersAddress ? { headquartersAddress: entity.headquartersAddress } : {}),
      ...(entity.registrationAuthorityId
        ? { registrationAuthorityId: entity.registrationAuthorityId }
        : {}),
      ...(entity.registrationAuthorityEntityId
        ? { registrationAuthorityEntityId: entity.registrationAuthorityEntityId }
        : {}),
      ...(entity.lastUpdate ? { lastUpdate: entity.lastUpdate } : {}),
      sanctionsHits: (screen?.hits ?? []).map((h) => ({
        source: h.source,
        sourceLabel: SOURCE_LABELS[h.source],
        sourceEntryId: h.sourceEntryId,
        sources: h.sources,
        primaryName: h.primaryName,
        ...(h.matchedName !== undefined ? { matchedName: h.matchedName } : {}),
        ...(h.matchType !== undefined ? { matchType: h.matchType } : {}),
        ...(h.score !== undefined ? { score: h.score } : {}),
        ...(h.matchedIdentifiers ? { matchedIdentifiers: h.matchedIdentifiers } : {}),
        matchedOn: h.matchedOn,
      })),
      ...(screen
        ? {
            sanctionsScreen: {
              totalAvailable: screen.totalAvailable,
              totalAvailableBasis: screen.totalAvailableBasis,
              // The cross-reference never pages, so whatever the cap left behind
              // is everything past the hits returned here.
              hasMore: screen.hits.length < screen.totalAvailable,
              screenedInputs: screen.screenedInputs,
            },
          }
        : {}),
      screeningStatus,
      caveat: SCREENING_CAVEAT,
    };
  },

  format: (r) => {
    const lines = [`# ${r.legalName}`, '', `**LEI:** \`${r.lei}\``];
    if (r.otherNames.length > 0) lines.push(`**Other names:** ${r.otherNames.join('; ')}`);
    if (r.alternateNames.length > 0) {
      lines.push(
        `**Names by type:** ${r.alternateNames.map((n) => `${n.name} (${gleifNameTypeText(n.type)})`).join('; ')}`,
      );
    }
    if (r.jurisdiction) lines.push(`**Jurisdiction:** ${r.jurisdiction}`);
    if (r.status) lines.push(`**Registration status:** ${r.status}`);
    if (r.legalAddress) lines.push(`**Legal address:** ${r.legalAddress}`);
    if (r.headquartersAddress) lines.push(`**HQ address:** ${r.headquartersAddress}`);
    if (r.registrationAuthorityId) {
      lines.push(
        `**Registration authority:** ${r.registrationAuthorityId}${r.registrationAuthorityEntityId ? ` (entity ${r.registrationAuthorityEntityId})` : ''}`,
      );
    }
    if (r.lastUpdate) lines.push(`**Last update:** ${r.lastUpdate}`);

    lines.push('\n## Sanctions screening cross-reference');
    if (r.screeningStatus === 'not_ready') {
      lines.push(
        'The sanctions mirror has never synced, so this cross-reference did not run. No screening was performed — this is NOT a clearance. Check sanctions_list_sources for mirror readiness and retry.',
      );
    } else if (r.sanctionsHits.length === 0) {
      lines.push(
        'No potential watchlist matches on any screened name or identifier (NOT a clearance).',
      );
    } else {
      for (const h of r.sanctionsHits) {
        const scoreStr = h.score !== undefined ? ` · score ${h.score.toFixed(3)}` : '';
        const matched = [
          ...(h.matchedName !== undefined
            ? [`${h.matchType}${scoreStr}, matched "${h.matchedName}"`]
            : []),
          ...(h.matchedIdentifiers ?? []).map(matchedIdentifierText),
        ];
        const also = alsoListedText(h.source, h.sources);
        lines.push(
          `- **${h.primaryName}** — ${h.sourceLabel} (\`${h.source}\`, entry ${h.sourceEntryId}${also ? `; also listed on ${also}` : ''}), ${matched.join('; ')} — matched on: ${h.matchedOn.map(screenedInputText).join('; ')}`,
        );
      }
    }
    if (r.sanctionsScreen) {
      const s = r.sanctionsScreen;
      lines.push(
        `Screen coverage: showing ${r.sanctionsHits.length} of ${s.totalAvailable} potential match(es) (count basis: ${s.totalAvailableBasis}); more available: ${s.hasMore}${
          s.hasMore ? ` — ${crossReferencePointer(r.legalName, r.lei, s.screenedInputs)}` : ''
        }`,
      );
      lines.push(
        `Screened: ${[
          screenedInputText({ input: 'legal_name', value: r.legalName }),
          screenedInputText({ input: 'lei', value: r.lei }),
          ...s.screenedInputs.map(screenedInputText),
        ].join('; ')}`,
      );
    }
    lines.push(`\n> ${r.caveat}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
