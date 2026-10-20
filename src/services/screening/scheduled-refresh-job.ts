/**
 * @fileoverview Compiled scheduled-refresh entry: deltas only, no golden-copy or
 * auxiliary GLEIF build. Stdin cancellation preserves refresh finally blocks.
 * @module services/screening/scheduled-refresh-job
 */

import { createInterface } from 'node:readline';
import { config } from '@cyanheads/mcp-ts-core/config';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { refreshMirrors } from './sanctions-refresh.js';
import type { RefreshJobResult } from './scheduled-refresh-process.js';
import { buildScreeningService } from './screening-service.js';

const controller = new AbortController();
const input = createInterface({ input: process.stdin });
input.once('line', (line) => {
  const reason = JSON.parse(line) as { message: string; name: string };
  controller.abort(new DOMException(reason.message, reason.name));
});
const terminate = () =>
  controller.abort(new DOMException('The refresh was cancelled.', 'AbortError'));
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
input.once('close', terminate);

let result: RefreshJobResult = {};
let exitCode = 0;
const service = buildScreeningService();
try {
  await logger.initialize(config.logLevel, 'stdio');
  const refreshed = await refreshMirrors(service, controller.signal, {
    context: requestContextService.createRequestContext({ operation: 'scheduledMirrorRefresh' }),
    loadMissingExceptions: false,
  });
  result = { needsInit: refreshed.gleif?.needsInit ?? [] };
} catch (error) {
  result = {
    error: {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof McpError ? { code: error.code } : {}),
    },
  };
  exitCode = 1;
} finally {
  await service.close();
  input.close();
  await logger.close();
}
/** Flush the result before explicitly exiting to release Bun's logger workers. */
process.stdout.write(JSON.stringify(result), () => process.exit(exitCode));
