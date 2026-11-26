/**
 * @fileoverview `sanctions_list_sources` — provenance and freshness for any
 * result. Lists the sanctions watchlists and GLEIF datasets currently loaded in
 * the local mirror, each with its record count, source URL, license, and — per
 * sanctions list — its last harvest and the publisher's document date, plus the
 * mirror's readiness + as-of timestamp and a refresh that is running or failed.
 * Lets an agent judge staleness before trusting (or distrusting) a screen. The
 * payload comes from the shared `buildSourcesPayload()`, which
 * `sanctions://sources` serves unchanged.
 * @module mcp-server/tools/definitions/list-sources.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { getScreeningService } from '@/services/screening/screening-service.js';
import { SOURCE_CODES } from '@/services/screening/types.js';
import { buildSourcesPayload } from './_shared.js';

/** A refresh as `lastRefresh` carries it: running, or failed. */
const LastRefreshSchema = z
  .discriminatedUnion('status', [
    z
      .object({
        status: z
          .literal('in_progress')
          .describe(
            'A sanctions refresh is running, until its index rebuild commits — or was killed before it finished, which reads the same way.',
          ),
        startedAt: z
          .string()
          .optional()
          .describe('When the running refresh started (UTC ISO 8601).'),
      })
      .describe('A sanctions refresh that is running.'),
    z
      .object({
        status: z.literal('error').describe('The last sanctions refresh failed.'),
        startedAt: z
          .string()
          .optional()
          .describe('When the failed refresh started (UTC ISO 8601).'),
        failedSources: z
          .array(z.enum(SOURCE_CODES))
          .optional()
          .describe(
            "The lists whose harvest failed in that refresh, in list order; each keeps its previous lastHarvestedAt and publishedAt. Empty when the run recorded its lists' outcomes and none failed: it stopped for another reason (cancelled or out of time). Absent when no list's outcome is recorded for that run — one an earlier server version made, one that stopped before any list finished, or one whose index rebuild failed — so which lists failed is unknown.",
          ),
      })
      .describe('A sanctions refresh that failed.'),
  ])
  .optional()
  .describe(
    'The last sanctions refresh, present only while one is running (in_progress) or after one failed (error); absent before any refresh and once the last one succeeded. While a refresh runs, each list keeps the values of the last run that finished it.',
  );

/** One payload `lastRefresh`. */
type LastRefresh = NonNullable<z.infer<typeof LastRefreshSchema>>;

/** The `format()` line for a running or failed refresh. */
function lastRefreshLine(refresh: LastRefresh): string {
  const started = refresh.startedAt ? `, started ${refresh.startedAt}` : '';
  switch (refresh.status) {
    case 'in_progress':
      return `**Last sanctions refresh:** in_progress${started} — each list below shows its last finished harvest until this run ends; a run killed before it finished also reads as in_progress.`;
    case 'error': {
      const failed = refresh.failedSources;
      const which =
        failed === undefined
          ? "no list's outcome is recorded for this run, so which lists failed is unknown."
          : failed.length === 0
            ? "no list's harvest failed: the run stopped before it finished (cancelled or out of time), and a list whose last harvest is earlier than that start was not refreshed by it."
            : `the harvest failed for ${failed.map((code) => `\`${code}\``).join(', ')}; each keeps its previous harvest below.`;
      return `**Last sanctions refresh:** error${started} — ${which} sanctionsAsOf stays at the last refresh in which every list harvested.`;
    }
    default: {
      const unreachable: never = refresh;
      throw new Error(`Unknown refresh status ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The tool's output schema — named so `buildSourcesPayload()` can type the payload
 * it builds against exactly the fields declared here.
 */
export const SourcesPayloadSchema = z.object({
  coverageNotice: z
    .string()
    .optional()
    .describe(
      'Unloaded CSL list codes and refresh guidance. Present when any CSL list has zero mirrored records; prior sanctions readiness does not establish coverage of newly added lists.',
    ),
  sanctionsReady: z
    .boolean()
    .describe('True once the sanctions mirror has completed at least one full sync.'),
  sanctionsAsOf: z
    .string()
    .optional()
    .describe(
      "ISO 8601 timestamp of the last completed sanctions sync — the last refresh in which every list harvested — when available. A list that harvested in a later, partly failed refresh carries a later lastHarvestedAt; neither is a publisher's date.",
    ),
  lastRefresh: LastRefreshSchema,
  leiReady: z
    .boolean()
    .describe('True once the GLEIF (LEI) mirror has completed at least one full sync.'),
  leiAsOf: z
    .string()
    .optional()
    .describe('ISO 8601 timestamp of the last completed GLEIF sync, when available.'),
  reportingExceptionsLoaded: z
    .boolean()
    .describe(
      'Whether GLEIF reporting exceptions are loaded. When false, sanctions_trace_ownership reads a parent level with no published relationship as unknown.',
    ),
  alternateNamesIndexed: z
    .boolean()
    .describe(
      'Whether the GLEIF alternate-name index — trading, previous, alternative-language, and transliterated names — is built. When false, sanctions_resolve_entity searches legal names only until mirror:init reloads the GLEIF golden copy. True on a GLEIF mirror that has never loaded (leiReady false): its empty index is complete, and the first load builds it with the entities.',
    ),
  entityStatusLoaded: z
    .boolean()
    .describe(
      "Whether a completed mirror:init golden-copy load has written entity status and successors for every GLEIF entity in that copy. A sanctions_get_entity record's own entityStatusLoaded is the per-record answer in either state.",
    ),
  sources: z
    .array(
      z
        .object({
          code: z.string().describe('Source code (ofac_sdn, eu, …, or gleif).'),
          label: z.string().describe('Human-readable source name.'),
          recordCount: z
            .number()
            .describe(
              'Records currently loaded for this source — for gleif, Level 1 entity records.',
            ),
          relationshipCount: z
            .number()
            .optional()
            .describe('GLEIF Level 2 ownership relationships loaded (gleif only).'),
          reportingExceptionCount: z
            .number()
            .optional()
            .describe(
              'GLEIF reporting-exception records loaded (gleif only). Absent when the dataset has never been loaded — never read as zero.',
            ),
          lastHarvestedAt: z
            .string()
            .optional()
            .describe(
              "When this list's last successful harvest completed (UTC ISO 8601; sanctions lists only). Absent until this server records a successful harvest of the list — so on a mirror an earlier server version wrote, until its next refresh — which means unknown, not stale. sanctionsAsOf is the mirror-wide value, not this list's.",
            ),
          publishedAt: z
            .string()
            .optional()
            .describe(
              "The date the publisher put on the document that harvest read, ISO 8601 at the precision and offset published (a date-only value stays YYYY-MM-DD): OFAC DateOfIssue, EU generationDate, UK DateGenerated, UN dateGenerated, and each CSL list's source_last_updated. It dates the document, not the last change to the list's content: some publishers move it when nothing in the list changed (the UN file is regenerated daily). Absent with lastHarvestedAt, or when the document carried no date this server reads.",
            ),
          url: z
            .string()
            .describe(
              'Upstream URL the mirror harvests this source from, as configured — for gleif, the golden-copy API base.',
            ),
          license: z.string().describe('Redistribution license / terms for this source.'),
        })
        .describe(
          "One supported source with current mirrored count, provenance, and license, and for a sanctions list its last harvest and that document's date; zero-record CSL lists are not loaded.",
        ),
    )
    .describe(
      'All supported sources, sanctions lists then the GLEIF dataset. Check coverageNotice for unloaded CSL lists.',
    ),
});

export const listSourcesTool = tool('sanctions_list_sources', {
  title: 'sanctions-screening-mcp-server: list sources',
  description:
    "List supported watchlists (OFAC SDN + Consolidated, EU, UK, UN, BIS Entity/Denied Persons/Unverified/Military End User, State ITAR Debarred/Nonproliferation) and GLEIF datasets with current mirrored counts, source URLs, licenses, readiness, and as-of timestamps. Each sanctions list carries lastHarvestedAt, its last successful harvest, and publishedAt, the date its publisher put on that document (not when the list's content last changed); both are absent until this server records a harvest of the list. lastRefresh reports a sanctions refresh that is running or failed and names the lists that failed; sanctionsAsOf is the last refresh in which every list harvested. coverageNotice names unloaded CSL lists and how to refresh them; prior mirror readiness does not establish coverage of newly added lists. For GLEIF, reports Level 2 ownership relationships, reporting-exception coverage, alternate-name index readiness, and whether entity status and successors are loaded. Use this for provenance, freshness, and coverage on any result. Attribution: UK data is under the Open Government Licence v3.0; BIS and State CSL data is supplied by the International Trade Administration under its published terms. This product uses the International Trade Administration’s Data API but is not endorsed or certified by the International Trade Administration.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({}),
  output: SourcesPayloadSchema,

  async handler(_input, ctx) {
    const payload = await buildSourcesPayload(getScreeningService());
    ctx.log.debug('Listed sources', {
      sanctionsReady: payload.sanctionsReady,
      leiReady: payload.leiReady,
    });
    return payload;
  },

  format: (r) => {
    const lines = ['# Loaded sources', ''];
    if (r.coverageNotice) lines.push(`**Coverage:** ${r.coverageNotice}`, '');
    lines.push(
      `**Sanctions mirror:** ${r.sanctionsReady ? 'ready' : 'NOT ready'}${r.sanctionsAsOf ? ` (as of ${r.sanctionsAsOf})` : ''}`,
    );
    if (r.lastRefresh) lines.push(lastRefreshLine(r.lastRefresh));
    const listRows = r.sources.filter((s) => s.code !== 'gleif');
    const unrecorded = listRows.filter((s) => s.lastHarvestedAt === undefined);
    if (unrecorded.length > 0) {
      const which =
        unrecorded.length === listRows.length
          ? 'any list'
          : unrecorded.map((s) => `\`${s.code}\``).join(', ');
      lines.push(
        `**Per-list harvest:** not recorded yet for ${which} — this server records a list's harvest time and document date from its next successful harvest on, so an absent date is unknown, not old. sanctionsAsOf dates the whole mirror, not any one list.`,
      );
    }
    lines.push(
      `**GLEIF mirror:** ${r.leiReady ? 'ready' : 'NOT ready'}${r.leiAsOf ? ` (as of ${r.leiAsOf})` : ''}`,
    );
    if (!r.reportingExceptionsLoaded) {
      lines.push(
        '**GLEIF reporting exceptions:** not loaded — ownership traces read an unpublished parent as unknown. mirror:refresh loads them, or mirror:init on a mirror loaded before they existed.',
      );
    }
    lines.push(
      !r.leiReady
        ? '**GLEIF alternate-name index:** none yet — the GLEIF mirror has never completed a load. mirror:init loads the golden copy and builds the index with it.'
        : r.alternateNamesIndexed
          ? '**GLEIF alternate-name index:** built'
          : '**GLEIF alternate-name index:** not built — sanctions_resolve_entity searches legal names only, so an entity published only under a trading, previous, alternative-language, or transliterated name cannot be found. mirror:init reloads the GLEIF golden copy and builds it.',
    );
    if (r.leiReady) {
      lines.push(
        r.entityStatusLoaded
          ? '**GLEIF entity status and successors:** loaded for every entity in the last full GLEIF load'
          : '**GLEIF entity status and successors:** not loaded for every entity — a record stored before they were read says so in its own entityStatusLoaded. mirror:init reloads the GLEIF golden copy and loads them.',
      );
    }
    lines.push('');
    for (const s of r.sources) {
      lines.push(`### ${s.label} (\`${s.code}\`)`);
      const records =
        s.relationshipCount === undefined
          ? `${s.recordCount}`
          : `${s.recordCount} Level 1 entities · ${s.relationshipCount} Level 2 relationships`;
      lines.push(`**Records:** ${records} | **License:** ${s.license}`);
      if (s.code !== 'gleif') {
        lines.push(
          s.lastHarvestedAt === undefined
            ? '**Last harvested:** not recorded'
            : `**Last harvested:** ${s.lastHarvestedAt} | **Document date:** ${s.publishedAt ?? 'none read from the document'}`,
        );
      }
      if (s.reportingExceptionCount !== undefined) {
        lines.push(`**Reporting exceptions:** ${s.reportingExceptionCount}`);
      }
      lines.push(`**Source:** ${markdownLink(s.url, s.url)}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
