#!/usr/bin/env node
/**
 * @fileoverview sanctions-screening-mcp-server MCP server entry point. Wires the
 * screening service (which owns the local SQLite + FTS5 mirrors), registers the
 * six screening/resolution tools, three URI resources, and the counterparty
 * vetting prompt, and schedules the mirror refresh on HTTP deployments. The
 * full-corpus mirror init runs out-of-band via `bun run mirror:init`.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { logger, requestContextService, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from './config/server-config.js';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import {
  getScreeningService,
  initScreeningService,
} from './services/screening/screening-service.js';

await createApp({
  name: 'sanctions-screening-mcp-server',
  title: 'sanctions-screening-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions:
    'Screen names against the consolidated OFAC, EU, UK, and UN sanctions lists and resolve legal entities against GLEIF, all fuzzy-matched offline over a local mirror. Start with sanctions_screen_name for "is this entity on a watchlist"; sanctions_resolve_entity → sanctions_get_entity → sanctions_trace_ownership for "who is this legal entity and who owns it." Every result is a screening AID, not a compliance determination — a hit is a candidate to verify against the official source, and an empty result is never a clearance. Check sanctions_list_sources for which lists are loaded and how fresh the mirror is.',
  landing: {
    requireAuth: false,
    tagline:
      'Screen names against OFAC, EU, UK, and UN sanctions lists and resolve legal entities against GLEIF — offline, fuzzy-matched. A screening aid, not a compliance determination.',
    links: [
      {
        label: 'OFAC Sanctions List Service',
        href: 'https://sanctionslistservice.ofac.treas.gov/',
        external: true,
      },
      { label: 'UK Sanctions List', href: 'https://sanctionslist.fcdo.gov.uk/', external: true },
      {
        label: 'UN SC Consolidated List',
        href: 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list',
        external: true,
      },
      { label: 'GLEIF', href: 'https://www.gleif.org/', external: true },
    ],
  },
  setup() {
    initScreeningService();
    scheduleRefresh();
  },
});

/**
 * Schedule the daily mirror refresh on HTTP deployments only. stdio operators
 * run refresh out-of-band via `bun run mirror:refresh`, so a cron there would be
 * redundant and could collide with a manual run.
 */
function scheduleRefresh(): void {
  if (config.mcpTransportType !== 'http') return;
  const { refreshCron } = getServerConfig();
  void schedulerService
    .schedule(
      'sanctions-mirror-refresh',
      refreshCron,
      async (ctx) => {
        const svc = getScreeningService();
        logger.info('Starting scheduled sanctions mirror refresh', ctx);
        await svc.designations.runSync({ mode: 'refresh' });
        await svc.rebuildNameIndex();
        logger.info('Scheduled sanctions mirror refresh complete', ctx);
      },
      'Refreshes the sanctions watchlists from their upstream sources.',
    )
    .then(() => schedulerService.start('sanctions-mirror-refresh'))
    .catch((err) => {
      logger.error(
        'Failed to schedule sanctions mirror refresh',
        err as Error,
        requestContextService.createRequestContext({ operation: 'scheduleRefresh' }),
      );
    });
}
