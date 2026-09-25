/**
 * @fileoverview `mirror:init` — full out-of-band initialization of the local
 * mirror from the live upstream sources. Harvests all five sanctions lists in
 * full (via the MirrorService `init` sync), rebuilds the per-alias name index and
 * the identifier index, then streams the GLEIF golden copies (Level 1 entities,
 * Level 2 relationships, and reporting exceptions), recording each file's
 * `ContentDate` as the checkpoint `mirror:refresh` applies deltas from. Each
 * entity is written with its legal, other, and transliterated names, and the
 * load's commit records the GLEIF name index as built — the step that gives a
 * mirror an earlier release wrote its alternate-name resolution.
 * Hours-long and safe to re-run: an interrupted run starts over, and a re-run
 * over a populated mirror removes what each list no longer publishes, as a
 * refresh does. Never run on the request path. Set
 * `SANCTIONS_INIT_SKIP_GLEIF=1` to load the sanctions lists only.
 *
 * Both legs stream. The sanctions documents total ~172 MB — OFAC
 * `SDN_ADVANCED.XML` alone is ~120 MB — and the GLEIF golden copy is far larger
 * again, so neither is held whole: peak memory tracks the ingest batch, not the
 * size of any source document.
 *
 * Usage: `bun run mirror:init`
 * @module scripts/mirror-init
 */

import { withExtra } from '@cyanheads/mcp-ts-core/utils';
import { loadGleifGoldenCopies } from '@/services/screening/gleif-sync.js';
import { longRunSignal } from '@/services/screening/sanctions-refresh.js';
import { bootstrap, runScript } from './_mirror-context.js';

async function main(): Promise<void> {
  const { service, log, ctx } = await bootstrap('mirror:init');
  const signal = longRunSignal(8);

  log.info('mirror:init — harvesting sanctions lists (full)', ctx);
  const sanctions = await service.syncSanctions('init', signal);
  log.info(
    'mirror:init — sanctions harvest complete, name and identifier indexes rebuilt',
    withExtra(ctx, {
      records: sanctions.recordsApplied,
      removed: sanctions.tombstonesApplied,
      total: sanctions.total,
    }),
  );

  if (process.env.SANCTIONS_INIT_SKIP_GLEIF === '1') {
    log.notice(
      'mirror:init — SANCTIONS_INIT_SKIP_GLEIF set; skipping GLEIF (sanctions-only mirror)',
      ctx,
    );
    await service.close();
    return;
  }

  log.info('mirror:init — loading the GLEIF golden copies', ctx);
  const gleif = await loadGleifGoldenCopies(service, signal, ctx);
  log.info(
    'mirror:init — GLEIF loaded',
    withExtra(ctx, {
      entities: gleif.entities,
      relationships: gleif.relationships,
      reportingExceptions: gleif.exceptions,
      rejectedMissingIdentifier: gleif.rejections.missingIdentifier,
      rejectedUnusableName: gleif.rejections.unusableName,
      checkpoint: gleif.checkpoint,
    }),
  );
  log.info('mirror:init — complete', ctx);
  await service.close();
}

runScript('mirror:init', main);
