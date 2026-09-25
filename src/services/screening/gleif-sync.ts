/**
 * @fileoverview The GLEIF mirror's two lifecycles: the golden-copy load behind
 * `mirror:init`, and the checkpointed delta refresh behind `mirror:refresh` and
 * the HTTP server's scheduled refresh.
 *
 * The mirror records, per dataset, the header `ContentDate` of the last file it
 * applied — its checkpoint. A refresh picks each dataset's smallest delta window
 * whose `DeltaStart` is at or before that checkpoint, streams it in bounded
 * batches, and applies its records in document order: upsert on the record's key,
 * delete where GLEIF marked it removed. `leiAsOf` and the checkpoint advance
 * together, once, after every dataset has applied; a refresh cut short leaves both
 * where they were, and re-running it re-applies an overlapping window, which
 * converges on the same rows. A checkpoint no window reaches — or none at all, as
 * on every mirror written before checkpoints existed — cannot be caught up from
 * deltas: nothing is applied, and the caller is told `mirror:init` is required.
 * @module services/screening/gleif-sync
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { logger, requestContextService, withExtra } from '@cyanheads/mcp-ts-core/utils';
import {
  DELTA_WINDOWS,
  type DeltaWindow,
  type GleifFile,
  type GleifRecordOf,
  openGleifFile,
  resolveGleifPublication,
} from '@/services/screening/gleif-ingest.js';
import { createRejections, type IngestRejections } from '@/services/screening/ingest-validation.js';
import type { ScreeningService } from '@/services/screening/screening-service.js';
import type { GleifCheckpoint, GleifDataset } from '@/services/screening/types.js';

/** Records per ingest batch — the most any GLEIF leg holds in memory at once. */
export const GLEIF_INGEST_BATCH = 10_000;

/** What a refresh did with one dataset. */
export interface AppliedDataset {
  /** The header `ContentDate` the dataset now stands at. */
  contentDate: string;
  /** Records applied (upserts and deletions). */
  records: number;
  /** The delta window applied, the golden copy loaded, or `current` when nothing newer was published. */
  source: DeltaWindow | 'golden_copy' | 'current';
}

/** The outcome of {@link refreshGleif}. */
export interface GleifRefreshOutcome {
  /** Per dataset, what was applied. Empty when anything needs `mirror:init`. */
  applied: Partial<Record<GleifDataset, AppliedDataset>>;
  /**
   * Datasets whose stored checkpoint no delta window covers, or that have none —
   * `mirror:init` is required, and nothing was applied to any dataset.
   */
  needsInit: GleifDataset[];
  /** Datasets left as they were because their data was never loaded and loading was not asked for. */
  skipped: GleifDataset[];
}

/** The outcome of {@link loadGleifGoldenCopies}. */
export interface GleifLoadResult {
  checkpoint: GleifCheckpoint;
  entities: number;
  exceptions: number;
  rejections: IngestRejections;
  relationships: number;
}

/** How a refresh brings one dataset current. */
type Plan =
  | { dataset: GleifDataset; kind: 'current'; checkpoint: string }
  | { dataset: GleifDataset; kind: 'delta'; checkpoint: string; url: string; window: DeltaWindow }
  | { dataset: 'repex'; kind: 'golden_copy'; url: string };

/**
 * Drain a GLEIF file into `sink` in batches of {@link GLEIF_INGEST_BATCH},
 * releasing the download however the drain ends. Returns the records applied.
 */
async function drain<T>(
  file: GleifFile<T>,
  sink: (batch: T[]) => Promise<void>,
  onProgress?: (total: number) => void,
): Promise<number> {
  let total = 0;
  let batch: T[] = [];
  const flush = async () => {
    await sink(batch);
    total += batch.length;
    batch = [];
    onProgress?.(total);
  };
  try {
    for await (const record of file.records) {
      batch.push(record);
      if (batch.length >= GLEIF_INGEST_BATCH) await flush();
    }
    if (batch.length > 0) await flush();
    return total;
  } finally {
    await file.close();
  }
}

/** Every write goes through the service's per-dataset ingest method. */
function sinkFor<D extends GleifDataset>(
  service: ScreeningService,
  dataset: D,
): (batch: GleifRecordOf[D][]) => Promise<void> {
  if (dataset === 'lei2') {
    return (batch) => service.ingestLeiEntities(batch as GleifRecordOf['lei2'][]);
  }
  if (dataset === 'rr') {
    return (batch) => service.ingestLeiRelationships(batch as GleifRecordOf['rr'][]);
  }
  return (batch) => service.ingestReportingExceptions(batch as GleifRecordOf['repex'][]);
}

const DATASET_LABELS: Record<GleifDataset, string> = {
  lei2: 'Level 1',
  rr: 'Level 2',
  repex: 'reporting exceptions',
};

/**
 * Pick the delta window that brings `dataset` current from `checkpoint`: read each
 * window's header, smallest span first, closing each file once its header is
 * read. A window whose `ContentDate` is not past the checkpoint means nothing newer
 * was published. Null when no window reaches back to the checkpoint.
 */
async function planDelta(
  dataset: GleifDataset,
  deltas: Partial<Record<DeltaWindow, string>>,
  checkpoint: string,
  signal: AbortSignal,
): Promise<Plan | null> {
  const at = Date.parse(checkpoint);
  for (const window of DELTA_WINDOWS) {
    const url = deltas[window];
    if (!url) continue;
    const file = await openGleifFile(dataset, url, signal);
    await file.close();
    const { contentDate, deltaStart } = file.header;
    if (Date.parse(contentDate) <= at) return { dataset, kind: 'current', checkpoint };
    if (!deltaStart) {
      throw serviceUnavailable(`The GLEIF ${dataset} ${window} delta states no DeltaStart.`, {
        url,
      });
    }
    if (Date.parse(deltaStart) <= at) return { dataset, kind: 'delta', checkpoint, url, window };
  }
  return null;
}

/**
 * Bring the GLEIF mirror current from its checkpoint.
 *
 * Nothing is applied — and nothing is downloaded — on a mirror that was never
 * loaded or whose Level 1 or Level 2 checkpoint is missing; those, and any dataset
 * whose checkpoint predates every delta window, are returned in `needsInit` with
 * no dataset applied. Reporting exceptions with no recorded load get their golden
 * copy when `loadMissingExceptions` is set (`mirror:refresh`) and are otherwise
 * left unloaded (the HTTP schedule, which never loads a golden copy in-process).
 *
 * @throws Whatever a download or file fails with. The checkpoint and `leiAsOf`
 *   are then untouched, and the next run re-applies from the same checkpoint.
 */
export async function refreshGleif(
  service: ScreeningService,
  signal: AbortSignal,
  options: { context?: RequestContext; loadMissingExceptions: boolean },
): Promise<GleifRefreshOutcome> {
  const ctx =
    options.context ?? requestContextService.createRequestContext({ operation: 'gleif.refresh' });
  const checkpoint = (await service.leiReady()) ? await service.gleifCheckpoint() : {};
  const outcome: GleifRefreshOutcome = { applied: {}, needsInit: [], skipped: [] };
  const needsInit = (datasets: GleifDataset[]): GleifRefreshOutcome => {
    logger.error(
      `GLEIF refresh — ${datasets.map((d) => DATASET_LABELS[d]).join(', ')}: no delta window reaches the last load this mirror recorded, so nothing was applied and leiAsOf was left as it was. Run mirror:init to reload the GLEIF golden copies.`,
      withExtra(ctx, { needsInit: datasets, checkpoint }),
    );
    return { ...outcome, needsInit: datasets };
  };

  const unrecorded = (['lei2', 'rr'] as const).filter((dataset) => !checkpoint[dataset]);
  if (unrecorded.length > 0) return needsInit(unrecorded);

  const plans: Plan[] = [];
  const uncovered: GleifDataset[] = [];
  for (const dataset of ['lei2', 'rr', 'repex'] as const) {
    const at = checkpoint[dataset];
    if (!at && !options.loadMissingExceptions) {
      outcome.skipped.push(dataset);
      logger.warning(
        'GLEIF refresh — reporting exceptions were never loaded, so they are left unloaded here; mirror:refresh loads their golden copy.',
        ctx,
      );
      continue;
    }
    const publication = await resolveGleifPublication(dataset, signal);
    if (!at) {
      plans.push({ dataset: 'repex', kind: 'golden_copy', url: publication.full });
      continue;
    }
    const plan = await planDelta(dataset, publication.deltas, at, signal);
    if (plan) plans.push(plan);
    else uncovered.push(dataset);
  }
  if (uncovered.length > 0) return needsInit(uncovered);

  const next: GleifCheckpoint = { ...checkpoint };
  for (const plan of plans) {
    if (plan.kind === 'current') {
      outcome.applied[plan.dataset] = {
        source: 'current',
        records: 0,
        contentDate: plan.checkpoint,
      };
      continue;
    }
    if (plan.kind === 'golden_copy') await service.clearReportingExceptions();
    const file = await openGleifFile(plan.dataset, plan.url, signal);
    const { deltaStart, contentDate } = file.header;
    if (
      plan.kind === 'delta' &&
      (!deltaStart || Date.parse(deltaStart) > Date.parse(plan.checkpoint))
    ) {
      await file.close();
      throw serviceUnavailable(
        `The GLEIF ${plan.dataset} ${plan.window} delta no longer covers the stored checkpoint.`,
        { url: plan.url, deltaStart, checkpoint: plan.checkpoint },
      );
    }
    const records = await drain(file, sinkFor(service, plan.dataset));
    next[plan.dataset] = contentDate;
    const source = plan.kind === 'delta' ? plan.window : 'golden_copy';
    outcome.applied[plan.dataset] = { source, records, contentDate };
    logger.info(
      `GLEIF refresh — ${DATASET_LABELS[plan.dataset]} applied`,
      withExtra(ctx, { source, records, contentDate }),
    );
  }

  await service.markLeiReady((await service.leiReadiness()).entityCount, next);
  return outcome;
}

/**
 * Load every GLEIF golden copy — Level 1, Level 2, and the reporting exceptions —
 * and record each file's header `ContentDate` as that dataset's checkpoint. The
 * checkpoint is cleared before anything loads, so a load that fails part-way
 * leaves no checkpoint for a refresh to apply deltas onto; the mirror stays ready
 * on its last completed load meanwhile. Level 2 and the exceptions are cleared
 * once and refilled; Level 1 upserts by LEI, each entity with its name-index rows,
 * and the final commit records the name index as built — the one place a mirror
 * an earlier release wrote gains it.
 */
export async function loadGleifGoldenCopies(
  service: ScreeningService,
  signal: AbortSignal,
  context?: RequestContext,
): Promise<GleifLoadResult> {
  const ctx = context ?? requestContextService.createRequestContext({ operation: 'gleif.load' });
  const [entityPub, relationshipPub, exceptionPub] = await Promise.all([
    resolveGleifPublication('lei2', signal),
    resolveGleifPublication('rr', signal),
    resolveGleifPublication('repex', signal),
  ]);
  await service.beginLeiLoad();

  const load = async <D extends GleifDataset>(
    dataset: D,
    url: string,
    rejections?: IngestRejections,
  ): Promise<{ contentDate: string; records: number }> => {
    logger.info(`GLEIF load — streaming the ${DATASET_LABELS[dataset]} golden copy`, ctx);
    const file = await openGleifFile(dataset, url, signal, rejections);
    const records = await drain(file, sinkFor(service, dataset), (total) =>
      logger.info(
        `GLEIF load — ${DATASET_LABELS[dataset]} progress`,
        withExtra(ctx, { records: total }),
      ),
    );
    return { contentDate: file.header.contentDate, records };
  };

  const rejections = createRejections();
  const entities = await load('lei2', entityPub.full, rejections);
  await service.clearLeiRelationships();
  const relationships = await load('rr', relationshipPub.full);
  await service.clearReportingExceptions();
  const exceptions = await load('repex', exceptionPub.full);

  const checkpoint: GleifCheckpoint = {
    lei2: entities.contentDate,
    rr: relationships.contentDate,
    repex: exceptions.contentDate,
  };
  // Every entity was just rewritten through ingestLeiEntities, names included, so
  // this commit is also the name index's recorded build.
  await service.markLeiReady((await service.leiReadiness()).entityCount, checkpoint, {
    namesIndexed: true,
  });
  return {
    checkpoint,
    entities: entities.records,
    relationships: relationships.records,
    exceptions: exceptions.records,
    rejections,
  };
}
