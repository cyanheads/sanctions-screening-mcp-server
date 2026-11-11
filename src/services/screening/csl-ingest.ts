/**
 * @fileoverview Prepare one complete CSL download in bounded per-list spools,
 * then replay each list through the ordinary sanctions harvest lifecycle.
 * @module services/screening/csl-ingest
 */
import { closeSync, createReadStream, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { JSONParser, TokenType } from '@streamparser/json';
import { getServerConfig } from '@/config/server-config.js';
import {
  componentText,
  createRejections,
  type IngestRejections,
  isUsableName,
} from '@/services/screening/ingest-validation.js';
import type { SanctionsIngester } from '@/services/screening/sanctions-ingest.js';
import { fetchSourceDownload } from '@/services/screening/source-fetch.js';
import {
  type DobRecord,
  type EntityType,
  type NormalizedDesignation,
  SOURCE_LABELS,
} from '@/services/screening/types.js';

/** The CSL sources harvested separately from direct Treasury feeds. */
export const CSL_SOURCE_CODES = [
  'bis_el',
  'bis_dpl',
  'bis_uvl',
  'bis_meu',
  'state_dtc',
  'state_acn',
] as const;
type CslSource = (typeof CSL_SOURCE_CODES)[number];
const optionalText = z.string().nullish();
const texts = z.array(z.string()).nullish();
const isoDate = z.iso.date();
const RecordSchema = z.object({
  source: z.string(),
  id: optionalText,
  name: optionalText,
  type: optionalText,
  alt_names: texts,
  programs: texts,
  dates_of_birth: texts,
  places_of_birth: texts,
  nationalities: texts,
  citizenships: texts,
  addresses: z
    .array(
      z.object({
        address: optionalText,
        city: optionalText,
        state: optionalText,
        postal_code: optionalText,
        country: optionalText,
      }),
    )
    .nullish(),
  ids: z
    .array(z.object({ type: optionalText, number: optionalText, country: optionalText }))
    .nullish(),
  start_date: optionalText,
  remarks: optionalText,
  call_sign: optionalText,
  vessel_registration: optionalText,
  vessel_imo: optionalText,
  aircraft_tail_number: optionalText,
  license_requirement: optionalText,
  license_policy: optionalText,
  federal_register_notice: optionalText,
  standard_order: optionalText,
  end_date: optionalText,
  country: optionalText,
  source_list_url: optionalText,
  source_information_url: optionalText,
  vessel_type: optionalText,
  vessel_flag: optionalText,
  vessel_owner: optionalText,
  gross_tonnage: optionalText,
  gross_registered_tonnage: optionalText,
  title: optionalText,
});
type CslRecord = z.infer<typeof RecordSchema>;
const MetadataSchema = z.array(
  z.object({
    source: z.string(),
    last_imported: optionalText,
    source_last_updated: optionalText,
    import_rate: optionalText,
  }),
);
const FEATURE_FIELDS = [
  'license_requirement',
  'license_policy',
  'federal_register_notice',
  'standard_order',
  'end_date',
  'country',
  'source_list_url',
  'source_information_url',
  'vessel_type',
  'vessel_flag',
  'vessel_owner',
  'gross_tonnage',
  'gross_registered_tonnage',
  'title',
] as const;

function published(values: readonly string[] | null | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function entityType(value: string | null | undefined): EntityType {
  switch (value?.toLowerCase()) {
    case 'individual':
    case 'person':
      return 'person';
    case 'entity':
    case 'organization':
    case 'organisation':
      return 'organization';
    case 'vessel':
    case 'ship':
      return 'vessel';
    case 'aircraft':
      return 'aircraft';
    default:
      return 'unknown';
  }
}

/** Convert calendar-valid CSL US dates; preserve other published text. */
function designationDate(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.replace(
    /^(\d{1,2})\/(\d{1,2})\/(?!0000)(\d{4})$/,
    (original, month: string, day: string, year: string) => {
      const candidate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      return isoDate.safeParse(candidate).success ? candidate : original;
    },
  );
}

function normalize(
  record: CslRecord,
  source: CslSource,
  rejected: IngestRejections,
): NormalizedDesignation | undefined {
  const id = record.id;
  if (!id?.trim()) {
    rejected.missingIdentifier++;
    return;
  }
  const name = record.name?.trim();
  if (!name || !isUsableName(name)) {
    rejected.unusableName++;
    return;
  }
  const dates = published(record.dates_of_birth);
  const places = published(record.places_of_birth);
  const births: DobRecord[] = [
    ...dates.map((date) => ({ date })),
    ...places.map((place) => ({ place })),
  ];
  const program = published(record.programs).join('; ');
  const startDate = designationDate(record.start_date);
  return {
    id: `${source}:${id}`,
    source,
    sourceEntryId: id,
    primaryName: name,
    entityType: entityType(record.type),
    ...(program ? { program } : {}),
    ...(startDate ? { designationDate: startDate } : {}),
    payload: {
      aliases: [...new Set((record.alt_names ?? []).map((name) => name.trim()))]
        .filter(isUsableName)
        .map((alias) => ({ name: alias, nameType: 'aka' })),
      addresses: (record.addresses ?? []).flatMap((address) => {
        const country = address.country?.trim();
        const full = [
          ...[address.address, address.city, address.state, address.postal_code]
            .map(componentText)
            .filter(Boolean),
          country,
        ]
          .filter(Boolean)
          .join(', ');
        return full ? [{ full, ...(country ? { country } : {}) }] : [];
      }),
      identifiers: [
        ...(record.ids ?? []).flatMap((identifier) => {
          const value = componentText(identifier.number);
          const type = componentText(identifier.type);
          const country = identifier.country?.trim();
          return value && type ? [{ type, value, ...(country ? { country } : {}) }] : [];
        }),
        ...(
          [
            ['call_sign', 'Call Sign'],
            ['vessel_registration', 'Vessel Registration'],
            ['vessel_imo', 'IMO Number'],
            ['aircraft_tail_number', 'Aircraft Tail Number'],
          ] as const
        ).flatMap(([key, type]) => {
          const value = componentText(record[key]);
          return value ? [{ type, value }] : [];
        }),
      ],
      datesOfBirth: births,
      nationalities: published([...(record.nationalities ?? []), ...(record.citizenships ?? [])]),
      features: FEATURE_FIELDS.flatMap((type) => {
        const value = record[type];
        return value?.trim() ? [{ type, value }] : [];
      }),
      ...(record.remarks?.trim() ? { remarks: record.remarks } : {}),
    },
  };
}

/** One run's lazy preparation and the six ordinary per-source adapters. Dispose in the sync's finally. */
export function createCslPreparation() {
  let directory: string | undefined;
  let prepared: Promise<string> | undefined;
  const metadata = new Set<string>();
  const states = CSL_SOURCE_CODES.map((source) => ({
    source,
    accepted: 0,
    rejected: createRejections(),
  }));
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  async function prepare(signal: AbortSignal): Promise<string> {
    directory = mkdtempSync(join(tmpdir(), 'sanctions-csl-'));
    let bodyDrained = false;
    const writers = new Map<string, { state: (typeof states)[number]; descriptor: number }>();
    try {
      for (const state of states) {
        const path = join(directory, `${state.source}.ndjson`);
        writers.set(SOURCE_LABELS[state.source], {
          state,
          descriptor: openSync(path, 'wx', 0o600),
        });
      }
      const parser = new JSONParser({
        paths: ['$.results.*', '$.sources_used', '$.offset', '$.total', '$.search_performed_at'],
        keepStack: false,
      });
      let count = 0;
      let total: number | undefined;
      let offset: number | undefined;
      let depth = 0;
      let rootKey: string | undefined;
      let expectsKey = false;
      let expectsValue = false;
      let complete = false;
      const rootKeys = new Set<string>();
      const seen = new Set<string>();
      parser.onToken = ({ token, value }) => {
        if (depth === 0 && token !== TokenType.LEFT_BRACE && !complete)
          throw new Error('CSL root must be an object.');
        if (depth === 1 && expectsKey && token === TokenType.STRING) {
          rootKey = z.string().parse(value);
          if (rootKeys.has(rootKey)) throw new Error('CSL contains a duplicate envelope field.');
          rootKeys.add(rootKey);
          expectsKey = false;
        } else if (depth === 1 && token === TokenType.COLON) expectsValue = true;
        else if (depth === 1 && expectsValue) {
          if (rootKey === 'results' && token !== TokenType.LEFT_BRACKET)
            throw new Error('CSL results must be an array.');
          expectsValue = false;
        }
        if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
          depth++;
          if (depth === 1) expectsKey = true;
        } else if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) depth--;
        else if (depth === 1 && token === TokenType.COMMA) expectsKey = true;
      };
      parser.onEnd = () => {
        complete = true;
      };
      parser.onValue = ({ value, key, stack, parent }) => {
        if (stack.length === 2 && stack[1]?.key === 'results') {
          if (!Array.isArray(parent)) throw new Error('CSL results must be an array.');
          count++;
          const head = z.object({ source: z.string() }).parse(value);
          const writer = writers.get(head.source);
          if (!writer) return;
          const record = RecordSchema.parse(value);
          const designation = normalize(record, writer.state.source, writer.state.rejected);
          if (!designation) return;
          if (seen.has(designation.id)) throw new Error('CSL repeats a selected source identity.');
          seen.add(designation.id);
          writeSync(writer.descriptor, `${JSON.stringify(designation)}\n`);
          writer.state.accepted++;
        } else if (stack.length === 1) {
          if (key === 'total') total = z.number().int().nonnegative().safe().parse(value);
          if (key === 'offset') offset = z.literal(0).parse(value);
          if (key === 'sources_used')
            for (const source of MetadataSchema.parse(value)) {
              if (metadata.has(source.source)) throw new Error('CSL repeats source metadata.');
              metadata.add(source.source);
            }
          if (key === 'search_performed_at') z.string().parse(value);
        }
      };
      const response = await fetchSourceDownload(getServerConfig().cslUrl, {
        source: 'CSL',
        signal,
        context: requestContextService.createRequestContext({ operation: 'harvest:csl' }),
        init: {
          headers: { 'User-Agent': 'sanctions-screening-mcp-server', Accept: 'application/json' },
        },
      });
      if (!response.body) throw new Error('CSL returned an empty body.');
      activeReader = response.body.getReader();
      while (true) {
        signal.throwIfAborted();
        const chunk = await activeReader.read();
        if (chunk.done) {
          bodyDrained = true;
          break;
        }
        for (let at = 0; at < chunk.value.length; at += 65536) {
          signal.throwIfAborted();
          parser.write(chunk.value.subarray(at, at + 65536));
        }
      }
      if (!parser.isEnded) parser.end();
      if (
        !complete ||
        depth !== 0 ||
        !rootKeys.has('results') ||
        !rootKeys.has('sources_used') ||
        offset !== 0 ||
        total === undefined ||
        total !== count
      )
        throw new Error('CSL envelope is incomplete or its total differs from its results.');
      return directory;
    } catch (cause) {
      // A reader whose read already rejected also rejects cancel with the same
      // error; keep the original failure while still closing its lock and files.
      if (activeReader && !bodyDrained) {
        try {
          await activeReader.cancel();
        } catch {
          /* Original cause remains authoritative. */
        }
      }
      if (signal.aborted) throw cause;
      throw serviceUnavailable(
        'CSL download could not be completely validated; no CSL lists were replayed.',
        {},
        { cause },
      );
    } finally {
      if (activeReader) {
        activeReader.releaseLock();
        activeReader = undefined;
      }
      for (const { descriptor } of writers.values()) closeSync(descriptor);
    }
  }

  const ingesters: SanctionsIngester[] = states.map((state) => {
    const { source } = state;
    let accepted = 0;
    return {
      source,
      url: () => getServerConfig().cslUrl,
      deferredFields: () => new Map(),
      defersFields: () => false,
      report: () => ({ source, accepted, rejected: state.rejected }),
      async *harvest(signal) {
        accepted = 0;
        prepared ??= prepare(signal);
        const spoolDirectory = await prepared;
        signal.throwIfAborted();
        if (!metadata.has(SOURCE_LABELS[source]))
          throw serviceUnavailable(
            `CSL metadata does not include ${source}; its stored list was retained.`,
          );
        if (state.accepted === 0)
          throw serviceUnavailable(
            `CSL yielded no accepted records for ${source}; its stored list was retained.`,
          );
        const stream = createReadStream(join(spoolDirectory, `${source}.ndjson`), {
          encoding: 'utf8',
          signal,
        });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            signal.throwIfAborted();
            // Only this run writes these spools, after schema validation above.
            const record: NormalizedDesignation = JSON.parse(line);
            accepted++;
            yield record;
          }
        } finally {
          lines.close();
          stream.destroy();
        }
      },
    };
  });
  return {
    ingesters,
    dispose() {
      if (directory) {
        rmSync(directory, { recursive: true, force: true });
        directory = undefined;
      }
    },
  };
}
