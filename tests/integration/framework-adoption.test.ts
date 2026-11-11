/**
 * @fileoverview Mirror lease contention and notice parity over the framework contracts.
 * @module tests/integration/framework-adoption.test
 */

import { conflict } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { expect, it, vi } from 'vitest';
import { resolveEntityTool } from '@/mcp-server/tools/definitions/resolve-entity.tool.js';
import { screenIdentifierTool } from '@/mcp-server/tools/definitions/screen-identifier.tool.js';
import { screenNameTool } from '@/mcp-server/tools/definitions/screen-name.tool.js';
import { ScheduledRefreshProcess } from '@/services/screening/scheduled-refresh-process.js';
import { freshService, seededGlobalService } from '../services/_helpers.js';

it.each(['sync_locked', 'sync_lease_lost'])(
  'preserves a %s rejection without rebuilding the auxiliary indexes',
  async (reason) => {
    const { service, cleanup } = await freshService();
    try {
      const refused = conflict('Another process owns the sync lease.', { reason });
      const sync = vi.spyOn(service.designations, 'runSync').mockRejectedValueOnce(refused);
      try {
        await expect(service.syncSanctions('refresh', new AbortController().signal)).rejects.toBe(
          refused,
        );
        const raw = await service.designations.raw();
        expect(
          raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'name_index_stamp'").get(),
        ).toBeUndefined();
      } finally {
        sync.mockRestore();
      }
    } finally {
      await cleanup();
    }
  },
);

it('skips the scheduled refresh while another process owns the lease', async () => {
  const { service, cleanup } = await freshService();
  const child = new ScheduledRefreshProcess();
  const store = service.designations.store.syncLease;
  try {
    if (!store) throw new Error('The SQLite store must provide a sync lease.');
    const lease = await store.claim('test-owner', 60_000);
    if (!lease) throw new Error('The scratch mirror must be unlocked.');
    try {
      const context = requestContextService.createRequestContext({
        operation: 'leaseContentionTest',
      });
      await expect(child.run(AbortSignal.timeout(10_000), context)).resolves.toBeUndefined();
      const raw = await service.designations.raw();
      expect(
        raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'name_index_stamp'").get(),
      ).toBeUndefined();
      expect(await store.claim('test-contender', 60_000)).toBeUndefined();
    } finally {
      await store.release(lease);
    }
  } finally {
    await child.stop();
    await cleanup();
  }
});

it('keeps echoed query markup literal in all three no-match notices', async () => {
  const { cleanup } = await seededGlobalService();
  try {
    const query = 'Varnok [go](https://example.invalid) *word*';
    const literal = String.raw`Varnok \[go\](https://example.invalid) \*word\*`;
    const results = await Promise.all([
      runToolContract(screenNameTool, { name: query }),
      runToolContract(resolveEntityTool, { name: query }),
      runToolContract(screenIdentifierTool, { value: query }),
    ]);
    for (const result of results) {
      expect(result.structuredContent).toMatchObject({
        notice: expect.stringContaining(`"${query}"`),
      });
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(`"${literal}"`);
      expect(text).not.toContain(query);
    }
  } finally {
    await cleanup();
  }
});
