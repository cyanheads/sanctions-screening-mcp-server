#!/usr/bin/env node
/**
 * @fileoverview sanctions-screening-mcp-server MCP server entry point. Wires the
 * screening service (which owns the local SQLite + FTS5 mirrors), registers the
 * seven screening/resolution tools, three URI resources, and the counterparty
 * vetting prompt, and schedules the mirror refresh on HTTP deployments. The
 * full-corpus mirror init runs out-of-band via `bun run mirror:init`.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { SERVER_INSTRUCTIONS } from './mcp-server/server-instructions.js';
import {
  scheduleSanctionsRefresh,
  stopSanctionsRefresh,
} from './services/screening/sanctions-refresh.js';
import {
  getScreeningService,
  initScreeningService,
} from './services/screening/screening-service.js';

const tools: typeof import('./mcp-server/tools/definitions/index.js').allToolDefinitions = [];
const resources: typeof import('./mcp-server/resources/definitions/index.js').allResourceDefinitions =
  [];

await createApp({
  name: 'sanctions-screening-mcp-server',
  title: 'sanctions-screening-mcp-server',
  // Every read is answered from the local mirror and no tool calls
  // `ctx.requestInput`, so nothing here needs a session to come back to.
  // `MCP_SESSION_MODE` still overrides this when a deployment sets it.
  sessionMode: 'stateless',
  tools,
  resources,
  prompts: allPromptDefinitions,
  skills: 'skills',
  instructions: SERVER_INSTRUCTIONS,
  // The tool, resource, and prompt surface is fixed at startup — nothing
  // registers or retires a definition at runtime — so a 2026-07-28 client may
  // hold the listings for an hour. Shared caches may too: the same listings are
  // already served unauthenticated on the landing page and the server card.
  // Per-record read lifetimes live on the resource definitions themselves.
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'prompts/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
  },
  landing: {
    requireAuth: false,
    tagline:
      'Screen eleven OFAC, EU, UK, UN, BIS, and State sanctions and export-control lists and resolve GLEIF entities offline. A screening aid, not a compliance determination. This product uses the International Trade Administration’s Data API but is not endorsed or certified by the International Trade Administration.',
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
  async setup() {
    // Core loads .env before setup and builds the registries after it. Import
    // the definitions here so the startup flag controls their advertised schemas.
    const [{ allToolDefinitions }, { allResourceDefinitions }] = await Promise.all([
      import('./mcp-server/tools/definitions/index.js'),
      import('./mcp-server/resources/definitions/index.js'),
    ]);
    tools.push(...allToolDefinitions);
    resources.push(...allResourceDefinitions);
    initScreeningService();
    // HTTP deployments refresh on a cron: the sanctions lists, then the GLEIF
    // deltas. stdio operators run `bun run mirror:refresh` out-of-band, where a
    // cron would be redundant and could collide with a manual run.
    if (config.mcpTransportType === 'http') await scheduleSanctionsRefresh();
  },
  // The service holds open SQLite handles for both mirrors. Releasing them here
  // closes prepared statements with the file rather than leaving it pinned
  // until garbage collection.
  async teardown() {
    await stopSanctionsRefresh();
    await getScreeningService().close();
  },
});
