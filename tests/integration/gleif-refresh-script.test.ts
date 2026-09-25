/**
 * @fileoverview `mirror:refresh` run as the operator runs it — the script in a
 * child process, against a local stand-in for the sanctions feeds and the GLEIF
 * Golden Copy API — over a GLEIF mirror seeded as last loaded at a known
 * publication. Pins the GLEIF leg end to end: the delta window is chosen from the
 * stored checkpoint, deletions apply, rows a delta does not restate survive, and a
 * gap no window covers (or a mirror with no checkpoint at all) applies nothing,
 * leaves `leiAsOf` where it was, and exits non-zero naming `mirror:init` — after
 * the sanctions lists have refreshed.
 * @module tests/integration/gleif-refresh-script.test
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  buildScreeningService,
  type ScreeningService,
} from '@/services/screening/screening-service.js';
import {
  type Change,
  deltaFiles,
  type GleifStandIn,
  leiFile,
  repexFile,
  rrFile,
  startGleifStandIn,
} from '../services/_gleif-publication.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

const A = '213800AAAAAAAAAAAA11';
const B = '213800BBBBBBBBBBBB22';
const C = '213800CCCCCCCCCCCC33';
const X = '213800XXXXXXXXXXXX44';
const Y = '213800YYYYYYYYYYYY55';
const Z = '213800ZZZZZZZZZZZZ66';
const GAP_CHILD = '213800GCGCGCGCGCGC77';
const GAP_PARENT = '213800GPGPGPGPGPGP88';
const K_CHILD = '213800KCKCKCKCKCKC99';
const K_PARENT = '213800KPKPKPKPKPKP10';

const DIRECT = 'IS_DIRECTLY_CONSOLIDATED_BY';
const ULTIMATE = 'IS_ULTIMATELY_CONSOLIDATED_BY';

/** The publication under test and its four windows. */
const CONTENT_DATE = '2026-09-25T10:00:00Z';
const STARTS = {
  IntraDay: '2026-09-25T02:00:00Z',
  LastDay: '2026-09-24T02:00:00Z',
  LastWeek: '2026-09-18T02:00:00Z',
  LastMonth: '2026-08-25T02:00:00Z',
};
const EXCEPTIONS_GOLDEN_DATE = '2026-09-25T09:01:50Z';

/** What GLEIF recorded, in order, over the month before the publication. */
const CHANGES: Change[] = [
  { at: '2026-09-01T12:00:00Z', dataset: 'lei2', record: { lei: C, legalName: 'C RENAMED' } },
  {
    at: '2026-09-20T09:00:00Z',
    dataset: 'rr',
    record: { childLei: GAP_CHILD, parentLei: GAP_PARENT, relationshipType: DIRECT },
  },
  { at: '2026-09-21T12:00:00Z', dataset: 'lei2', record: { lei: B, legalName: 'B RENAMED' } },
  // One key added, removed, and added again inside the window: it ends present.
  {
    at: '2026-09-22T01:00:00Z',
    dataset: 'rr',
    record: { childLei: K_CHILD, parentLei: K_PARENT, relationshipType: DIRECT },
  },
  {
    at: '2026-09-22T02:00:00Z',
    dataset: 'rr',
    record: { childLei: K_CHILD, parentLei: K_PARENT, relationshipType: DIRECT, deleted: true },
  },
  {
    at: '2026-09-22T03:00:00Z',
    dataset: 'rr',
    record: { childLei: K_CHILD, parentLei: K_PARENT, relationshipType: DIRECT },
  },
  // Another key added then removed: it ends absent.
  {
    at: '2026-09-23T01:00:00Z',
    dataset: 'rr',
    record: { childLei: K_CHILD, parentLei: K_PARENT, relationshipType: ULTIMATE },
  },
  {
    at: '2026-09-23T02:00:00Z',
    dataset: 'rr',
    record: { childLei: K_CHILD, parentLei: K_PARENT, relationshipType: ULTIMATE, deleted: true },
  },
  // X's direct parent is removed; its ultimate parent is untouched and never restated.
  {
    at: '2026-09-24T18:00:00Z',
    dataset: 'rr',
    record: { childLei: X, parentLei: Y, relationshipType: DIRECT, deleted: true },
  },
  { at: '2026-09-25T05:00:00Z', dataset: 'lei2', record: { lei: A, legalName: 'A RENAMED' } },
];

const SEEDED_AS_OF = '2026-09-19T09:00:00.000Z';

/** One-record sanctions documents, so the sanctions leg of the script can run. */
const FEEDS: Record<string, [env: string, body: string]> = {
  '/sdn.xml': [
    'OFAC_SDN_URL',
    '<?xml version="1.0"?><sdnList><sdnEntry><uid>SDN-1</uid><firstName>Alder</firstName><lastName>Quill</lastName><sdnType>Individual</sdnType></sdnEntry></sdnList>',
  ],
  '/cons.xml': [
    'OFAC_CONSOLIDATED_URL',
    '<?xml version="1.0"?><sdnList><sdnEntry><uid>CONS-1</uid><firstName>Cedar</firstName><lastName>Wren</lastName><sdnType>Individual</sdnType></sdnEntry></sdnList>',
  ],
  '/eu.xml': [
    'EU_FSF_URL',
    '<?xml version="1.0"?><export><sanctionEntity logicalId="EU-1"><subjectType code="person"/><nameAlias wholeName="Dahlia Finch" strong="true"/></sanctionEntity></export>',
  ],
  '/uk.xml': [
    'UK_SANCTIONS_URL',
    '<?xml version="1.0"?><Designations><Designation><UniqueID>UK-1</UniqueID><IndividualEntityShip>Individual</IndividualEntityShip><Names><Name><Name6>Fern Lark</Name6><NameType>Primary Name</NameType></Name></Names></Designation></Designations>',
  ],
  '/un.xml': [
    'UN_SC_URL',
    '<?xml version="1.0"?><CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL><DATAID>UN-1</DATAID><FIRST_NAME>Hazel</FIRST_NAME><SECOND_NAME>Crane</SECOND_NAME></INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>',
  ],
};

let dir: string;
let mirrorPath: string;
let standIn: GleifStandIn;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gleif-refresh-script-'));
  mirrorPath = join(dir, 'sanctions.db');
  standIn = await startGleifStandIn();
  const files = deltaFiles(CHANGES, CONTENT_DATE, STARTS);
  standIn.serve(
    {
      lei2: { full: leiFile({ contentDate: '2026-09-25T08:08:49Z' }, []), deltas: files.lei2 },
      rr: { full: rrFile({ contentDate: '2026-09-25T09:17:31Z' }, []), deltas: files.rr },
      repex: {
        full: repexFile({ contentDate: EXCEPTIONS_GOLDEN_DATE }, [
          {
            lei: B,
            category: 'DIRECT_ACCOUNTING_CONSOLIDATION_PARENT',
            reasons: ['NATURAL_PERSONS'],
          },
        ]),
        deltas: files.repex,
      },
    },
    Object.fromEntries(Object.entries(FEEDS).map(([path, [, body]]) => [path, body])),
  );
});

afterEach(async () => {
  await standIn.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SANCTIONS_MIRROR_PATH;
  resetServerConfig();
});

/** Open the scratch mirror in this process. */
function openMirror(): ScreeningService {
  process.env.SANCTIONS_MIRROR_PATH = mirrorPath;
  resetServerConfig();
  return buildScreeningService();
}

/**
 * Seed a ready GLEIF mirror as its last load left it, then close it: the gap
 * entities under their pre-gap names, and X with both its parent rows. `checkpoint`
 * is the stored sync-state checkpoint, or none for a mirror an earlier release wrote.
 */
async function seed(checkpoint: Record<string, string> | undefined): Promise<void> {
  const svc = openMirror();
  const names: [string, string][] = [
    [A, 'A OLD'],
    [B, 'B OLD'],
    [C, 'C OLD'],
    [X, 'X HOLDINGS'],
    [Y, 'Y HOLDINGS'],
    [Z, 'Z HOLDINGS'],
    [GAP_CHILD, 'GAP CHILD'],
    [GAP_PARENT, 'GAP PARENT'],
  ];
  await svc.ingestLeiEntities(
    names.map(([lei, legalName]) => ({ lei, legalName, otherNames: [] })),
  );
  await svc.ingestLeiRelationships([
    { childLei: X, parentLei: Y, relationshipType: DIRECT, relationshipStatus: 'ACTIVE' },
    { childLei: X, parentLei: Z, relationshipType: ULTIMATE, relationshipStatus: 'ACTIVE' },
  ]);
  await svc.leiEntities.store.writeState({
    status: 'complete',
    completedAt: SEEDED_AS_OF,
    total: names.length,
    ...(checkpoint ? { checkpoint: JSON.stringify(checkpoint) } : {}),
  });
  await svc.close();
}

/** Run `mirror:refresh` in a child process against the stand-in. */
function runRefresh(): Promise<{ code: number; output: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SANCTIONS_MIRROR_PATH: mirrorPath,
    GLEIF_GOLDEN_COPY_BASE_URL: standIn.base,
    MCP_LOG_LEVEL: 'info',
  };
  delete env.SANCTIONS_REFRESH_SKIP_GLEIF;
  for (const [path, [name]] of Object.entries(FEEDS)) env[name] = `${standIn.base}${path}`;
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', 'scripts/mirror-refresh.ts'], {
      cwd: REPO,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45_000,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('close', (code, signal) => {
      resolve({ code: code ?? 1, output: signal ? `killed by ${signal}\n${output}` : output });
    });
  });
}

/** Read back what the tests assert on, then close the mirror. */
async function readBack() {
  const svc = openMirror();
  try {
    const state = await svc.leiEntities.store.readState();
    const names = Object.fromEntries(
      (await svc.getLeiEntitiesBatch([A, B, C])).map((e) => [e.lei, e.legalName]),
    );
    const parents = async (lei: string) =>
      (await svc.getRelationships(lei, 'parents'))
        .map((r) => `${r.relationshipType}->${r.parentLei}`)
        .sort();
    return {
      state,
      checkpoint: state.checkpoint ? (JSON.parse(state.checkpoint) as Record<string, string>) : {},
      names,
      x: await parents(X),
      gap: await parents(GAP_CHILD),
      k: await parents(K_CHILD),
      sanctionsReady: await svc.sanctionsReady(),
    };
  } finally {
    await svc.close();
  }
}

describe('mirror:refresh — the GLEIF leg', () => {
  it('applies the smallest window that covers the stored checkpoint, deletions and all', async () => {
    const at = '2026-09-19T08:08:49Z'; // six days back: only LastWeek covers it
    await seed({ lei2: at, rr: at, repex: at });

    const run = await runRefresh();
    const after = await readBack();

    expect(run.code, run.output).toBe(0);
    expect(after.names).toEqual({ [A]: 'A RENAMED', [B]: 'B RENAMED', [C]: 'C OLD' });
    // The deletion removed X's direct parent; its ultimate parent, never restated, stays.
    expect(after.x).toEqual([`${ULTIMATE}->${Z}`]);
    expect(after.gap).toEqual([`${DIRECT}->${GAP_PARENT}`]);
    // Last record in document order wins: added-removed-added is present, added-removed is not.
    expect(after.k).toEqual([`${DIRECT}->${K_PARENT}`]);
    expect(after.checkpoint).toMatchObject({ lei2: CONTENT_DATE, rr: CONTENT_DATE });
    expect(after.state.completedAt).not.toBe(SEEDED_AS_OF);
    // LastWeek was enough; LastMonth was never downloaded.
    expect(standIn.requested).toContain('/files/lei2-LastWeek.xml');
    expect(standIn.requested).toContain('/files/rr-LastWeek.xml');
    expect(standIn.requested).not.toContain('/files/lei2-LastMonth.xml');
    expect(standIn.requested).not.toContain('/files/rr-LastMonth.xml');
    expect(after.sanctionsReady).toBe(true);
  }, 60_000);

  it('loads the exceptions golden copy when no load of it is recorded', async () => {
    const at = '2026-09-24T08:00:00Z';
    await seed({ lei2: at, rr: at });

    const run = await runRefresh();
    expect(run.code, run.output).toBe(0);

    const svc = openMirror();
    try {
      expect(await svc.reportingExceptionsLoaded()).toBe(true);
      expect([...(await svc.getReportingExceptions([B])).get(B)!]).toEqual([
        { category: 'DIRECT_ACCOUNTING_CONSOLIDATION_PARENT', reasons: ['NATURAL_PERSONS'] },
      ]);
      const checkpoint = JSON.parse((await svc.leiEntities.store.readState()).checkpoint ?? '{}');
      expect(checkpoint).toEqual({
        lei2: CONTENT_DATE,
        rr: CONTENT_DATE,
        repex: EXCEPTIONS_GOLDEN_DATE,
      });
    } finally {
      await svc.close();
    }
    expect(standIn.requested).toContain('/files/repex-full.xml');
  }, 60_000);

  it.each([
    [
      'a checkpoint older than every window',
      { lei2: '2026-08-01T00:00:00Z', rr: '2026-08-01T00:00:00Z', repex: '2026-08-01T00:00:00Z' },
    ],
    ['no recorded checkpoint (a mirror an earlier release wrote)', undefined],
  ])(
    'applies nothing on %s, keeps leiAsOf, and exits non-zero naming mirror:init',
    async (_label, checkpoint) => {
      await seed(checkpoint);

      const run = await runRefresh();
      const after = await readBack();

      expect(run.code).not.toBe(0);
      expect(run.output).toContain('mirror:init');
      expect(after.state.completedAt).toBe(SEEDED_AS_OF);
      expect(after.checkpoint).toEqual(checkpoint ?? {});
      expect(after.names).toEqual({ [A]: 'A OLD', [B]: 'B OLD', [C]: 'C OLD' });
      expect(after.x).toEqual([`${DIRECT}->${Y}`, `${ULTIMATE}->${Z}`]);
      // Nothing reloads in its place: no golden copy is fetched, the exceptions' included.
      expect(standIn.requested.filter((path) => path.endsWith('-full.xml'))).toEqual([]);
      // The sanctions lists refreshed first regardless.
      expect(after.sanctionsReady).toBe(true);
    },
    60_000,
  );

  it('never makes a never-initialized GLEIF mirror ready (#5)', async () => {
    const run = await runRefresh();
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('mirror:init');

    const svc = openMirror();
    try {
      expect(await svc.leiReady()).toBe(false);
      expect((await svc.leiReadiness()).entityCount).toBe(0);
    } finally {
      await svc.close();
    }
  }, 60_000);
});
