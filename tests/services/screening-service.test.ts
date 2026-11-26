/**
 * @fileoverview Integration tests for the matching engine over a seeded
 * synthetic-fixture mirror: exact / strong / approximate classification,
 * Jaro-Winkler fuzzy fallback, phonetic transliteration hits, source + type
 * filters, LEI resolution, ownership traversal, and the empty-result contract.
 * @module tests/services/screening-service.test
 */

import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FUZZY_POOL_BUDGET } from '@/services/screening/candidate-pool.js';
import { parseOfac } from '@/services/screening/sanctions-ingest.js';
import {
  buildScreeningService,
  type ScreeningService,
} from '@/services/screening/screening-service.js';
import { doubleMetaphone } from '@/services/screening/text-matching.js';
import {
  type NormalizedDesignation,
  type NormalizedLeiEntity,
  SOURCE_CODES,
  type SourceCode,
} from '@/services/screening/types.js';
import { parseXml } from '@/services/screening/xml.js';
import { freshService, type SeededService, seededService } from './_helpers.js';

let seeded: SeededService;
let svc: ScreeningService;
const ctx = createMockContext();

beforeEach(async () => {
  seeded = await seededService();
  svc = seeded.service;
});

afterEach(async () => {
  await seeded.cleanup();
});

const screenDefaults = {
  entityType: 'any' as const,
  matchMode: 'strict' as const,
  sources: [...SOURCE_CODES],
  limit: 25,
};

describe('screenName — strict matching', () => {
  it('keeps native strict names and strict-only cross-references separate across scripts', async () => {
    await svc.ingestDesignations([namedDesignation('NATIVE', 'Совкомфлот')]);
    const native = await svc.screenName(
      { ...screenDefaults, query: 'Совкомфлот', autoFallback: false },
      ctx,
    );
    expect(native.hits.find((hit) => hit.sourceEntryId === 'NATIVE')).toMatchObject({
      matchType: 'exact',
      matchedName: 'Совкомфлот',
    });
    const latin = await svc.screenName(
      { ...screenDefaults, query: 'Sovcomflot', autoFallback: false },
      ctx,
    );
    expect(latin.hits.find((hit) => hit.sourceEntryId === 'NATIVE')).toBeUndefined();
  });
  it('returns an exact hit for a normalized primary-name match', async () => {
    const res = await svc.screenName({ ...screenDefaults, query: 'Ivan Testovich Volkov' }, ctx);
    expect(res.modeUsed).toBe('strict');
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit?.matchType).toBe('exact');
    expect(hit?.score).toBeUndefined(); // exact hits are unscored
  });

  it('returns a strong hit when all query tokens are present (word-order swap)', async () => {
    const res = await svc.screenName({ ...screenDefaults, query: 'Volkov Ivan' }, ctx);
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit?.matchType).toBe('strong');
  });

  it('matches on an alias, not just the primary name', async () => {
    const res = await svc.screenName({ ...screenDefaults, query: 'FTC LLC' }, ctx);
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-2002');
    expect(hit).toBeDefined();
    expect(hit?.matchedNameType).toBe('aka');
  });

  it('does not fabricate a score on exact/strong hits', async () => {
    const res = await svc.screenName({ ...screenDefaults, query: 'Katarina Beispiel' }, ctx);
    for (const hit of res.hits.filter((h) => h.matchType !== 'approximate')) {
      expect(hit.score).toBeUndefined();
    }
  });
});

describe('screenName — legal-form spellings (issue #90)', () => {
  /** Published names from the lists, each designation under its own list and entry ID. */
  const LEGAL_FORM_DESIGNATIONS = [
    // Reached by `Sberbank Company` only through words of a longer form.
    withAliases('ofac_sdn', '18715', 'JOINT STOCK COMPANY SBERBANK', []),
    withAliases('ofac_sdn', '18669', 'LIMITED LIABILITY COMPANY SBERBANK CAPITAL', []),
    withAliases('ofac_sdn', '18714', 'OPEN JOINT STOCK COMPANY BPS-SBERBANK', []),
    withAliases(
      'ofac_consolidated',
      '18746',
      'SBERBANK TECHNOLOGIES CLOSED JOINT STOCK COMPANY',
      [],
    ),
    // A shorter form inside a longer one, and the PJSC form the JSC query must not reach.
    withAliases('ofac_sdn', '17018', 'PUBLIC JOINT STOCK COMPANY SBERBANK OF RUSSIA', []),
    withAliases('uk', 'RUS0256', 'PJSC Sberbank of Russia', [
      'PJSC Sberbank (Public Joint-Stock Company Sberbank)',
    ]),
    // A form word the name spells inside another form.
    withAliases(
      'ofac_sdn',
      '43121',
      'LIMITED LIABILITY COMPANY SCIENTIFIC-PRODUCTION FIRM RADIO-ELECTRONIC TECHNOLOGIES',
      [],
    ),
    // Form words that are not adjacent in the name, and an OJSC the JSC query must not reach.
    withAliases('ofac_sdn', '18290', 'OPEN JOINT-STOCK OIL AND GAS COMPANY SYZRAN', []),
    withAliases('eu', '181035', 'Open Joint-Stock Oil And Gas Company Syzran', []),
    withAliases('ofac_sdn', '18291', 'OJSC Syzran Refinery', []),
    // Equal to a query up to legal-form spelling.
    withAliases('ofac_sdn', '16830', 'STG HOLDINGS LIMITED', []),
    withAliases('bis_el', 'STG-1', 'STG Holdings Limited', []),
    withAliases('uk', 'RUS2624', 'ELECTRONIC SCIENTIFIC ENGINEERING LTD', []),
    withAliases('uk', 'RUS3162', 'PJSC TATNEFT named after V.D. Shashin', [
      'ПАО "Татнефть" имени В.Д. Шашина',
    ]),
    withAliases('ofac_sdn', '19037', 'INRESBANK OOO', []),
    // The public form half transliterated: `publichnoye` before an English `joint stock company`.
    withAliases('ofac_consolidated', '20002', 'PUBLICHNOYE JOINT-STOCK COMPANY BM BANK', []),
    // The same words under a different form.
    withAliases('eu', 'SPEC-1', 'Limited Liability Company Spectrum', []),
    withAliases('uk', 'VTB-1', 'VTB Bank, Public Joint Stock Company', []),
    withAliases('ofac_sdn', 'DAE-1', 'Korea Daesong Trading Company', []),
    // A longer form spelled with a word of another: `public` of PJSC, `limited` of Ltd.
    withAliases(
      'eu',
      '184224',
      'NON PUBLIC JOINT STOCK  COMPANY  "KALMYK OIL  AND GAS  COMPANY',
      [],
    ),
    withAliases('ofac_consolidated', '19992', 'Limited Liability Corporation Baltech', []),
  ];

  beforeEach(async () => {
    await svc.ingestDesignations(LEGAL_FORM_DESIGNATIONS);
  });

  const strictOnly = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, limit: 100, query, autoFallback: false, ...extra }, ctx);
  const rows = (
    hits: readonly { designationId: string; matchType: string; matchedName: string }[],
  ) => hits.map((hit) => `${hit.designationId} ${hit.matchType} ${hit.matchedName}`);

  it.each([
    [
      'Sberbank Company',
      [
        'ofac_sdn:17018 strong PUBLIC JOINT STOCK COMPANY SBERBANK OF RUSSIA',
        'ofac_sdn:18669 strong LIMITED LIABILITY COMPANY SBERBANK CAPITAL',
        'ofac_sdn:18714 strong OPEN JOINT STOCK COMPANY BPS-SBERBANK',
        'ofac_sdn:18715 strong JOINT STOCK COMPANY SBERBANK',
        'ofac_consolidated:18746 strong SBERBANK TECHNOLOGIES CLOSED JOINT STOCK COMPANY',
        'uk:RUS0256 strong PJSC Sberbank (Public Joint-Stock Company Sberbank)',
      ],
    ],
    [
      'Joint Stock Company Sberbank of Russia',
      ['ofac_sdn:17018 strong PUBLIC JOINT STOCK COMPANY SBERBANK OF RUSSIA'],
    ],
    [
      'Radio-Electronic Technologies Limited',
      [
        'ofac_sdn:43121 strong LIMITED LIABILITY COMPANY SCIENTIFIC-PRODUCTION FIRM RADIO-ELECTRONIC TECHNOLOGIES',
      ],
    ],
    [
      'Joint Stock Company Syzran',
      [
        'ofac_sdn:18290 strong OPEN JOINT-STOCK OIL AND GAS COMPANY SYZRAN',
        'eu:181035 strong Open Joint-Stock Oil And Gas Company Syzran',
      ],
    ],
    ['Baltech Limited', ['ofac_consolidated:19992 strong Limited Liability Corporation Baltech']],
  ])(
    'keeps every strict hit of %j that every query word reaches (characterization)',
    async (query, expected) => {
      expect(rows((await strictOnly(query)).hits)).toEqual(expected);
    },
  );

  it.each([
    [
      'STG Holdings Ltd.',
      ['ofac_sdn:16830 strong STG HOLDINGS LIMITED', 'bis_el:STG-1 strong STG Holdings Limited'],
    ],
    [
      'ELECTRONIC SCIENTIFIC ENGINEERING LIMITED',
      ['uk:RUS2624 strong ELECTRONIC SCIENTIFIC ENGINEERING LTD'],
    ],
    [
      'Public Joint Stock Company TATNEFT named after V.D. Shashin',
      ['uk:RUS3162 strong PJSC TATNEFT named after V.D. Shashin'],
    ],
    [
      'Публичное акционерное общество "Татнефть" имени В.Д. Шашина',
      ['uk:RUS3162 strong ПАО "Татнефть" имени В.Д. Шашина'],
    ],
    ['"INRESBANK" LLC', ['ofac_sdn:19037 strong INRESBANK OOO']],
    ['BM Bank PJSC', ['ofac_consolidated:20002 strong PUBLICHNOYE JOINT-STOCK COMPANY BM BANK']],
    ['Spectrum LLC', ['eu:SPEC-1 strong Limited Liability Company Spectrum']],
    ['Syzran Refinery Open Joint Stock Company', ['ofac_sdn:18291 strong OJSC Syzran Refinery']],
    ['Korea Daesong Trading Co.', ['ofac_sdn:DAE-1 strong Korea Daesong Trading Company']],
    [
      'JSC Kalmyk Oil and Gas Company',
      ['eu:184224 strong NON PUBLIC JOINT STOCK  COMPANY  "KALMYK OIL  AND GAS  COMPANY'],
    ],
    ['Baltech LLC', ['ofac_consolidated:19992 strong Limited Liability Corporation Baltech']],
  ])(
    'matches %j where a legal form differs only in spelling, as strong',
    async (query, expected) => {
      expect(rows((await strictOnly(query)).hits)).toEqual(expected);
    },
  );

  it.each([
    ['Spectrum Ltd', 'eu:SPEC-1'],
    ['JSC VTB Bank', 'uk:VTB-1'],
    ['Sberbank of Russia JSC', 'uk:RUS0256'],
    ['BM Bank JSC', 'ofac_consolidated:20002'],
    ['Syzran Refinery JSC', 'ofac_sdn:18291'],
    ['Korea Daesong Trading Corp', 'ofac_sdn:DAE-1'],
    ['PJSC Kalmyk Oil and Gas Company', 'eu:184224'],
    ['Baltech Ltd', 'ofac_consolidated:19992'],
  ])('never reaches a different form: %j does not match %s', async (query, designationId) => {
    const res = await strictOnly(query);
    expect(res.hits.map((hit) => hit.designationId)).not.toContain(designationId);
  });

  it('keeps exact for normalized equality and leaves the normalized query unfolded', async () => {
    const exact = await strictOnly('STG HOLDINGS LIMITED');
    expect(rows(exact.hits)).toEqual([
      'ofac_sdn:16830 exact STG HOLDINGS LIMITED',
      'bis_el:STG-1 exact STG Holdings Limited',
    ]);
    const spelled = await strictOnly('STG Holdings Ltd.');
    expect(spelled.normalizedQuery).toBe('stg holdings ltd');
    expect(spelled.hits.map((hit) => hit.matchType)).toEqual(['strong', 'strong']);
    expect(spelled).toMatchObject({ totalAvailable: 2, totalAvailableBasis: 'exact' });
  });

  it('keeps the name the literal rule matched when another alias matches only up to spelling (characterization)', async () => {
    // The primary name is written first, so it is the first row any pass reads.
    await svc.ingestDesignations([
      withAliases('eu', 'ACME-1', 'Acme Limited', ['Acme Ltd Trading House']),
    ]);
    expect(rows((await strictOnly('Acme Ltd')).hits)).toEqual([
      'eu:ACME-1 strong Acme Ltd Trading House',
    ]);
    expect(rows((await strictOnly('Acme Limited')).hits)).toEqual(['eu:ACME-1 exact Acme Limited']);
  });

  it('completes only the lists a legal-form match left empty, with full-coverage candidates', async () => {
    await svc.ingestDesignations([
      // Shares one distinctive word: a full fuzzy pass admits it, a completion never does.
      withAliases('uk', 'RG-1', 'RG HOLDINGS LTD', []),
    ]);
    const res = await svc.screenName({ ...screenDefaults, query: 'STG Holdings Ltd.' }, ctx);
    expect(res.modeUsed).toBe('strict');
    expect(res.hits.map((hit) => hit.designationId)).toEqual(['ofac_sdn:16830', 'bis_el:STG-1']);
    expect(res.fuzzySources).toEqual(
      SOURCE_CODES.filter((code) => code !== 'ofac_sdn' && code !== 'bis_el'),
    );
  });

  it('groups an OFAC party whose two records spell the form differently into one hit naming both lists', async () => {
    await svc.ingestDesignations([
      withAliases('ofac_sdn', 'MER-1', 'MERIDIAN TRADE HOLDINGS LIMITED', []),
      withAliases('ofac_consolidated', 'MER-1', 'Meridian Trade Holdings Ltd', []),
    ]);
    const both = { sources: ['ofac_sdn', 'ofac_consolidated'] as SourceCode[] };
    for (const [query, source, matchType] of [
      ['Meridian Trade Holdings Ltd', 'ofac_consolidated', 'exact'],
      ['Meridian Trade Holdings Limited', 'ofac_sdn', 'exact'],
    ] as const) {
      const res = await strictOnly(query, both);
      expect(res.hits, query).toHaveLength(1);
      expect(res.hits[0], query).toMatchObject({
        source,
        matchType,
        sources: ['ofac_sdn', 'ofac_consolidated'],
      });
      expect(res.totalAvailable, query).toBe(1);
    }
    // The other list's record alone, reached only up to spelling.
    const consolidated = await strictOnly('Meridian Trade Holdings Limited', {
      sources: ['ofac_consolidated'],
    });
    expect(rows(consolidated.hits)).toEqual([
      'ofac_consolidated:MER-1 strong Meridian Trade Holdings Ltd',
    ]);
    expect(consolidated.hits[0]?.sources).toEqual(['ofac_consolidated']);
  });

  it('accepts the longest name and a name of legal-form words alone up to the word bound', async () => {
    const forms =
      'Limited Liability Company LLC L.L.C. OOO ООО Ltd Limited Co Company JSC Joint Stock Company AO АО PJSC PAO ПАО OJSC OAO ОАО CJSC ZAO ЗАО Corp Corporation Inc Incorporated LLP AG'.split(
        ' ',
      );
    const formWords = Array.from({ length: 64 }, (_, i) => forms[i % forms.length]);
    const longest = `${'Sberbank '.repeat(113)}Ltd`.slice(0, 1024);
    for (const query of [formWords.slice(0, 64).join(' '), longest]) {
      const res = await strictOnly(query);
      expect(res.normalizedQuery.length).toBeGreaterThan(0);
      expect(res.totalAvailableBasis).toBe('exact');
    }
  });
});

describe('screenName — public-company spellings of PLC (issue #101)', () => {
  const MEHL = 'a90c8b8a90682c265b5f4fd4da267ace4ad1cb81adc2eb0fdf739c0a';
  /** Published records holding `PLC` or a public-company spelling of it, under their own list and entry IDs. */
  const PUBLIC_COMPANY_DESIGNATIONS = [
    withAliases('ofac_sdn', '58644', 'MERITWISE GROUP PUBLIC LTD', []),
    withAliases('ofac_sdn', '31517', 'Myanma Economic Holdings Public Company Limited', [
      'Myanmar Economic Holding Limited',
      'MEHL',
    ]),
    withAliases('ofac_sdn', '35838', 'Asia Green Development Bank Ltd', [
      'Asia Green Development Bank Public Company Limited',
      'Asia Green Development Bank Limited',
      'AGD Bank',
    ]),
    withAliases(
      'ofac_sdn',
      '50005',
      'Scientific Research Institute for Optoelectronic Instrument Engineering',
      [
        'Public Limited Company Scientific Research Institute For Optoelectronic Instrument Engineering',
        'AO NII OEP',
      ],
    ),
    withAliases('eu', '129450', 'Myanmar  Economic  Holdings  Public  Company  Ltd', []),
    withAliases('eu', '179619', 'Evraz PLC', ['Evraz Nyrt.']),
    withAliases('uk', 'GHR0080', 'Myanmar Economic Holdings Public Company Ltd', [
      'MEHL',
      'Myanmar Economic Holdings Limited',
    ]),
    withAliases('uk', 'RUS1027', 'Evraz PLC', ['Евраз']),
    withAliases(
      'bis_el',
      MEHL,
      'Myanmar Economic Holdings Limited',
      [
        'MEHL',
        'Myanma Economic Holdings Limited',
        'Myanma Economic Holdings Public Company Limited',
        'Myanmar Business Holdings Public Company Limited',
        'Myanmar Economic Holdings Public Company Limited',
        'UMEH',
        'Union of Myanmar Economic Holdings Company Limited',
        'Union of Myanmar Economic Holdings Limited.',
      ],
      'unknown',
    ),
  ];

  beforeEach(async () => {
    await svc.ingestDesignations(PUBLIC_COMPANY_DESIGNATIONS);
  });

  const strictOnly = (query: string) =>
    svc.screenName({ ...screenDefaults, limit: 100, query, autoFallback: false }, ctx);
  const rows = (
    hits: readonly { designationId: string; matchType: string; matchedName: string }[],
  ) => hits.map((hit) => `${hit.designationId} ${hit.matchType} ${hit.matchedName}`);

  it.each([
    ['Meritwise Group PLC', ['ofac_sdn:58644 strong MERITWISE GROUP PUBLIC LTD']],
    [
      'Myanmar Economic Holdings PLC',
      [
        'eu:129450 strong Myanmar  Economic  Holdings  Public  Company  Ltd',
        'uk:GHR0080 strong Myanmar Economic Holdings Public Company Ltd',
        `bis_el:${MEHL} strong Myanmar Economic Holdings Public Company Limited`,
      ],
    ],
    [
      'Asia Green Development Bank PLC',
      ['ofac_sdn:35838 strong Asia Green Development Bank Public Company Limited'],
    ],
    ['Evraz Public Ltd', ['eu:179619 strong Evraz PLC', 'uk:RUS1027 strong Evraz PLC']],
    ['Evraz Public Company Limited', ['eu:179619 strong Evraz PLC', 'uk:RUS1027 strong Evraz PLC']],
    // The same form spelled two ways inside one longer name.
    [
      'Public Ltd Scientific Research Institute For Optoelectronic Instrument Engineering',
      [
        'ofac_sdn:50005 strong Public Limited Company Scientific Research Institute For Optoelectronic Instrument Engineering',
      ],
    ],
  ])('matches %j, a PLC spelled another way, as strong', async (query, expected) => {
    expect(rows((await strictOnly(query)).hits)).toEqual(expected);
  });

  it.each([
    [
      'Myanma Economic Holdings Ltd',
      [
        'ofac_sdn:31517 strong Myanma Economic Holdings Public Company Limited',
        `bis_el:${MEHL} strong Myanma Economic Holdings Limited`,
      ],
    ],
    [
      'Myanma Economic Holdings Co Ltd',
      [
        'ofac_sdn:31517 strong Myanma Economic Holdings Public Company Limited',
        `bis_el:${MEHL} strong Myanma Economic Holdings Public Company Limited`,
      ],
    ],
    [
      'Myanmar Economic Holdings Company Limited',
      [
        'eu:129450 strong Myanmar  Economic  Holdings  Public  Company  Ltd',
        'uk:GHR0080 strong Myanmar Economic Holdings Public Company Ltd',
        `bis_el:${MEHL} strong Myanmar Economic Holdings Public Company Limited`,
      ],
    ],
    ['Meritwise Group Ltd', ['ofac_sdn:58644 strong MERITWISE GROUP PUBLIC LTD']],
    ['Meritwise Group Limited', ['ofac_sdn:58644 strong MERITWISE GROUP PUBLIC LTD']],
    [
      'Asia Green Development Bank Co Ltd',
      ['ofac_sdn:35838 strong Asia Green Development Bank Public Company Limited'],
    ],
  ])(
    'keeps the strict hits of %j, read word by word in the stored name (characterization)',
    async (query, expected) => {
      expect(rows((await strictOnly(query)).hits)).toEqual(expected);
    },
  );

  it('never reads Ltd inside Public Limited Company, and keeps that alias exact', async () => {
    const ltd = await strictOnly(
      'Scientific Research Institute For Optoelectronic Instrument Engineering Ltd',
    );
    expect(rows(ltd.hits)).toEqual([]);
    const alias = await strictOnly(
      'Public Limited Company Scientific Research Institute For Optoelectronic Instrument Engineering',
    );
    expect(rows(alias.hits)).toEqual([
      'ofac_sdn:50005 exact Public Limited Company Scientific Research Institute For Optoelectronic Instrument Engineering',
    ]);
  });

  it('reads a stored name one way at a time, never as PLC and Ltd at once (characterization)', async () => {
    expect(rows((await strictOnly('Meritwise Group PLC Ltd')).hits)).toEqual([]);
  });

  it.each([
    // The query read word by word holds `ltd` twice; read longest first, `plc` and `ltd`.
    [
      'Myanma Economic Holdings Public Company Limited Ltd',
      [
        'ofac_sdn:31517 strong Myanma Economic Holdings Public Company Limited',
        `bis_el:${MEHL} strong Myanma Economic Holdings Public Company Limited`,
      ],
    ],
    // Never ofac_sdn 50005: `Public Limited Company` reads as `plc` alone, which holds no `ltd`.
    [
      'Public Company Limited Ltd',
      [
        'ofac_sdn:31517 strong Myanma Economic Holdings Public Company Limited',
        'ofac_sdn:35838 strong Asia Green Development Bank Public Company Limited',
        'eu:129450 strong Myanmar  Economic  Holdings  Public  Company  Ltd',
        'uk:GHR0080 strong Myanmar Economic Holdings Public Company Ltd',
        `bis_el:${MEHL} strong Myanma Economic Holdings Public Company Limited`,
      ],
    ],
  ])(
    'reads a query holding a public-company spelling word by word too: %j',
    async (query, expected) => {
      expect(rows((await strictOnly(query)).hits)).toEqual(expected);
    },
  );

  it('matches a stored X Public Co Ltd, which spells no PLC, for the query X Public Company Limited', async () => {
    await svc.ingestDesignations([
      withAliases('ofac_sdn', 'NWS-1', 'Northwind Shipping Public Co Ltd', []),
    ]);
    expect(rows((await strictOnly('Northwind Shipping Public Company Limited')).hits)).toEqual([
      'ofac_sdn:NWS-1 strong Northwind Shipping Public Co Ltd',
    ]);
    // Read longest first, the query is `plc`, which that name never spells.
    expect(rows((await strictOnly('Northwind Shipping PLC')).hits)).toEqual([]);
  });

  it('keeps exact for normalized equality and leaves the normalized query unfolded', async () => {
    const plc = await strictOnly('Meritwise Group PLC');
    expect(plc.normalizedQuery).toBe('meritwise group plc');
    expect(plc).toMatchObject({ totalAvailable: 1, totalAvailableBasis: 'exact' });
    const spelled = await strictOnly('Myanmar Economic Holdings Public Company Ltd');
    expect(spelled.normalizedQuery).toBe('myanmar economic holdings public company ltd');
    expect(rows(spelled.hits)).toEqual([
      'eu:129450 exact Myanmar  Economic  Holdings  Public  Company  Ltd',
      'uk:GHR0080 exact Myanmar Economic Holdings Public Company Ltd',
      `bis_el:${MEHL} strong Myanmar Economic Holdings Public Company Limited`,
    ]);
  });
});

describe('screenName — fuzzy fallback', () => {
  it('keeps original query-token coverage when romanization removes a standalone sign', async () => {
    await svc.ingestDesignations([namedDesignation('SIGN-ROSNEFT', 'Rosneft')]);
    const result = await svc.screenName(
      { ...screenDefaults, query: 'Ъ Роснефть', matchMode: 'fuzzy' },
      ctx,
    );
    expect(
      result.hits.find((hit) => hit.sourceEntryId === 'SIGN-ROSNEFT')?.queryTokenCoverage,
    ).toEqual({ covered: 1, total: 2 });
  });
  it('builds typed GLEIF signatures only out of band, atomically across more than one slice', async () => {
    const handle = await svc.leiEntities.raw();
    await svc.ingestLeiEntities([
      ...Array.from({ length: 2001 }, (_, i) => registered(`SLICE${i}`, `Filler${i}`)),
      registered('LASTROSNEFT', 'Rosneft'),
    ]);
    handle.exec('DELETE FROM lei_name_signature; DELETE FROM lei_name_signature_stamp;');
    const resolve = () =>
      svc.resolveEntity({ query: 'Rpsneft', matchMode: 'fuzzy', status: 'any', limit: 25 }, ctx);
    expect((await resolve()).matches.some((hit) => hit.lei === testLei('LASTROSNEFT'))).toBe(false);
    expect(
      handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM lei_name_signature').get()?.n,
    ).toBe(0);
    handle.exec(
      `CREATE TRIGGER reject_signature BEFORE INSERT ON lei_name_signature WHEN new.rowid > 2000 BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END;`,
    );
    await expect(svc.indexLeiFuzzyNames()).rejects.toThrow('fixture interruption');
    expect(handle.prepare('SELECT 1 FROM lei_name_signature_stamp').get()).toBeFalsy();
    expect(
      handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM lei_name_signature').get()?.n,
    ).toBe(0);
    handle.exec('DROP TRIGGER reject_signature;');
    await svc.indexLeiFuzzyNames();
    expect(
      (await resolve()).matches.find((hit) => hit.lei === testLei('LASTROSNEFT')),
    ).toMatchObject({ matchedName: 'Rosneft' });
    await svc.ingestLeiEntities([registered('LASTROSNEFT', 'Varnok Updated')]);
    expect((await resolve()).matches.some((hit) => hit.lei === testLei('LASTROSNEFT'))).toBe(false);
    const replaced = await svc.resolveEntity(
      { query: 'Vqrnok', matchMode: 'fuzzy', status: 'any', limit: 25 },
      ctx,
    );
    expect(replaced.matches.find((hit) => hit.lei === testLei('LASTROSNEFT'))).toMatchObject({
      matchedName: 'Varnok Updated',
      matchType: 'approximate',
    });
  });
  it.each([
    ['Rpsneft', 'Rosneft'],
    ['Sobcomflot', 'Sovcomflot'],
    ['Совкомфлот', 'Sovcomflot'],
    ['Sovcomflot', 'Совкомфлот'],
    ['Роснефть', 'Rosneft'],
  ])('supplements native blocking for %s against published %s', async (query, name) => {
    await svc.ingestDesignations([namedDesignation('SUPPLEMENT', name)]);
    const result = await svc.screenName({ ...screenDefaults, query, matchMode: 'fuzzy' }, ctx);
    expect(result.hits.find((hit) => hit.sourceEntryId === 'SUPPLEMENT')).toMatchObject({
      matchedName: name,
      matchedNameType: 'primary',
      matchType: 'approximate',
      queryTokenCoverage: { covered: 1, total: 1 },
    });
  });

  it('supplements typed GLEIF names for an early typo after an out-of-band index build', async () => {
    await svc.ingestLeiEntities([registered('ROSNEFT', 'Rosneft')]);
    // The fixture seed follows the same lifecycle path as mirror:init.
    await svc.indexLeiFuzzyNames();
    const result = await svc.resolveEntity(
      { query: 'Rpsneft', matchMode: 'fuzzy', status: 'any', limit: 25 },
      ctx,
    );
    expect(result.matches.find((hit) => hit.lei === testLei('ROSNEFT'))).toMatchObject({
      matchedName: 'Rosneft',
      matchType: 'approximate',
    });
  });
  it('auto-falls-back to fuzzy when strict finds nothing, surfacing a raw JW score', async () => {
    // "Volkow" is a one-character near-miss of the primary name "Volkov".
    const res = await svc.screenName({ ...screenDefaults, query: 'Ivan Volkow' }, ctx);
    expect(res.modeUsed).toBe('fuzzy');
    expect(res.fuzzyFallbackTriggered).toBe(true);
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit?.matchType).toBe('approximate');
    expect(typeof hit?.score).toBe('number');
    expect(hit!.score!).toBeGreaterThan(0);
    expect(hit!.score!).toBeLessThanOrEqual(1);
  });

  it('catches transliteration-class variants at the default floor', async () => {
    // "Muhammad" phonetically collides with the published "Mohammed" (DM key MHMT),
    // which seeds "Mohammed Al-Testi" into the candidate pool. The shared exact
    // tokens "al"/"testi" then drive bestTokenScore to 1.0, so it clears the
    // default fuzzy floor (0.85) without any floor exemption — default-floor recall
    // for transliteration variants is preserved.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Muhammad Al-Testi', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-6006');
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe('approximate');
  });

  it('returns an empty result (not a guess) for a name nothing resembles', async () => {
    // The fixture now carries FX-8008, whose short low-quality-aka "Noni" scores
    // 0.8515 against "nonexistent" (above the 0.85 floor). This query must still
    // return nothing: the coverage gate rejects a candidate that explains only 1 of
    // 3 query tokens (issue #4). Before the gate, that single token pair leaked.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Zzqxwv Nonexistent Qqpzm', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
  });
});

describe('screenName — single-token false-positive gate (issue #4)', () => {
  // A multi-token query must not be carried by ONE token pair that clears the fuzzy
  // floor. FX-8008 ("Mateo Restrepo Cardoza") has the short low-quality-aka "Noni";
  // "nonexistent" scores 0.8515 against "noni" — above the 0.85 floor — yet the
  // whole 3-token nonsense query is otherwise unrelated (coverage 1/3).
  it('rejects a candidate that clears the floor on a single query token (coverage 1/3)', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Zzqxwv Nonexistent Qqpzm', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.hits.find((h) => h.sourceEntryId === 'FX-8008')).toBeUndefined();
  });

  it('still admits a legitimate partial match that covers 2 of 3 query tokens', async () => {
    // "Ivan" + "Volkov" both match FX-1001 exactly (coverage 2/3); the trailing
    // "Qqzzxw" is noise. Enough of the query is explained → the candidate admits.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkov Qqzzxw', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe('approximate');
  });

  it('leaves single-token queries unchanged — the floor alone governs', async () => {
    // One token, coverage is trivially the whole query; a near-miss above the floor
    // still surfaces (the gate only tightens 3+-token queries).
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Volkow', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit?.matchType).toBe('approximate');
    expect(hit!.score!).toBeGreaterThanOrEqual(0.85);
  });

  it('still admits a fuzzy word-order swap with a near-miss token', async () => {
    // "Volkow Ivan" — swapped order, "Volkow" ≈ "Volkov"; both tokens covered.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Volkow Ivan', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit?.matchType).toBe('approximate');
  });
});

describe('screenName — whole-string prefix-inflation gate (issue #8)', () => {
  // The whole-string admission arm must not admit a SHORT candidate that is merely a
  // (near-)prefix of a much LONGER multi-token query. Jaro-Winkler's shared-prefix
  // boost inflates such pairs above the floor; a folded-length-ratio guard on the
  // whole-string arm blocks them without touching the spacing/concatenation recall
  // that arm exists for.
  it('rejects a bare short alias that only prefixes a longer multi-token query', async () => {
    // FX-9009 ("Aurelio Ferdinand Castellanos") carries the bare low-quality-aka
    // "Ferdinand". Against "Ferdinand Aquino Delgado", the whole-string JW of
    // "ferdinand aquino delgado" vs "ferdinand" is 0.875 — above the 0.85 floor — but
    // the length ratio is 0.375 (< 0.5) and token coverage is 1/3. Before the guard,
    // the inflated whole-string score admitted it; now it must not surface.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Ferdinand Aquino Delgado', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.hits.find((h) => h.sourceEntryId === 'FX-9009')).toBeUndefined();
  });

  it('still admits a spacing/concatenation variant via the whole-string arm', async () => {
    // FX-1010 ("Van Der Berg Shipping") queried as its space-stripped concatenation
    // "vanderbergshipping": whole-string JW is 0.9667 but the best token pair is only
    // 0.806, so the token arm cannot admit it — ONLY the whole-string arm can. The
    // length ratio (0.857) clears the guard, so this concatenation recall survives.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'vanderbergshipping', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1010');
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe('approximate');
  });
});

describe('screenName — minScore floor enforced uniformly (issue #1)', () => {
  // The floor binds every fuzzy candidate, regardless of match strategy
  // (exact-normalized / token / phonetic). A phonetic-key candidate is seeded into
  // the pool but admitted ONLY when its computed score clears the floor — there is
  // no phonetic bypass. Before the fix, `score >= minScore || phoneticHit` admitted
  // a sub-floor phonetic-only hit, so a caller asking minScore:0.99 still saw a hit
  // scored e.g. 0.78. FX-7007 ("Catherine Pyotrov") is a purpose-built case: the
  // query "Katharina Petrov" shares its whole phonetic key (K0RN PTRF) but no exact
  // token, so its score (~0.78) is sub-floor — it reaches the pool only via the
  // phonetic key.
  const PHONETIC_QUERY = 'Katharina Petrov';

  it('excludes a phonetic-only hit whose score is below an explicit high minScore', async () => {
    const { result: res, ...trace } = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName(
        { ...screenDefaults, query: PHONETIC_QUERY, matchMode: 'fuzzy', minScore: 0.99 },
        ctx,
      ),
    );
    // The phonetic arm pooled the candidate, so the floor — not blocking — withholds it.
    expect(phoneticallyPooled(trace, 'un:FX-7007')).toBe(true);
    expect(res.hits.find((h) => h.sourceEntryId === 'FX-7007')).toBeUndefined();
    // No returned hit may sit below the requested floor — the bypass is gone.
    for (const hit of res.hits) {
      if (hit.score !== undefined) expect(hit.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('also excludes that phonetic-only sub-floor hit at the default floor', async () => {
    // The same candidate scores ~0.78 — below the default floor (0.85) too. Under
    // the old bypass it surfaced regardless; now it is correctly withheld. This is
    // the intended fix, not a recall loss: a genuine variant that scores ABOVE the
    // floor still surfaces (covered by the transliteration test above, which lands
    // at 1.0 via shared exact tokens).
    const { result: res, ...trace } = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName({ ...screenDefaults, query: PHONETIC_QUERY, matchMode: 'fuzzy' }, ctx),
    );
    expect(phoneticallyPooled(trace, 'un:FX-7007')).toBe(true);
    expect(res.hits.find((h) => h.sourceEntryId === 'FX-7007')).toBeUndefined();
  });

  it('floors a strict screen’s fuzzy passes too: the completion of a list strict missed, and the fallback', async () => {
    await svc.ingestDesignations([
      listed('un', 'MS-EXACT', 'Zorbek Kalandar'),
      listed('eu', 'MS-NEAR', 'Zorbek Kalandarov'),
    ]);
    const strict = async (query: string, minScore?: number) =>
      (
        await svc.screenName(
          { ...screenDefaults, query, ...(minScore === undefined ? {} : { minScore }) },
          ctx,
        )
      ).hits.map((hit) => hit.designationId);

    // `kalandarov` covers `kalandar` at 0.96: over the default floor, under 0.99.
    expect(await strict('Zorbek Kalandar')).toEqual(['un:MS-EXACT', 'eu:MS-NEAR']);
    expect(await strict('Zorbek Kalandar', 0.99)).toEqual(['un:MS-EXACT']);
    // Strict finds nothing; every token pair of the fallback scores under 0.99.
    expect(await strict('Zorbex Kalandarr')).toContain('un:MS-EXACT');
    expect(await strict('Zorbex Kalandarr', 0.99)).toEqual([]);
  });
});

describe('screenName — query-token coverage ranking (issue #15)', () => {
  // Coverage is a literal count of query tokens the candidate explains, surfaced
  // as its own field and used as the ranking key BETWEEN score and the terminal
  // designation-id key. It never enters `score`, which stays raw Jaro-Winkler.
  it('omits queryTokenCoverage on exact and strong hits', async () => {
    const exact = await svc.screenName({ ...screenDefaults, query: 'Ivan Testovich Volkov' }, ctx);
    const strong = await svc.screenName({ ...screenDefaults, query: 'Volkov Ivan' }, ctx);
    for (const res of [exact, strong]) {
      for (const hit of res.hits) {
        expect(hit.matchType).not.toBe('approximate');
        expect(hit.queryTokenCoverage).toBeUndefined();
      }
    }
  });

  it('counts coverage at the applied minScore floor, not a fixed threshold', async () => {
    // "volkow" ~ "volkov" is 0.9556: covered at the default 0.85 floor, uncovered
    // at 0.99. The exact "ivan" pair carries admission either way, so the same
    // candidate surfaces with a different, honest coverage count per floor.
    const atDefault = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkow', matchMode: 'fuzzy' },
      ctx,
    );
    expect(atDefault.hits.find((h) => h.sourceEntryId === 'FX-1001')?.queryTokenCoverage).toEqual({
      covered: 2,
      total: 2,
    });

    const atHighFloor = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkow', matchMode: 'fuzzy', minScore: 0.99 },
      ctx,
    );
    expect(atHighFloor.hits.find((h) => h.sourceEntryId === 'FX-1001')?.queryTokenCoverage).toEqual(
      { covered: 1, total: 2 },
    );
  });

  it('keeps the designation id as the terminal key when score and coverage tie', async () => {
    // Offset pagination needs a total order. Coverage is inserted BETWEEN score
    // and the id — it must not displace the id as the final tie-break.
    await svc.ingestDesignations(
      (['TIE-B', 'TIE-A'] as const).map((entryId, index) => ({
        id: `un:${entryId}`,
        source: 'un' as const,
        sourceEntryId: entryId,
        entityType: 'person' as const,
        primaryName: `Rikardo Almeyda ${index === 0 ? 'Sorel' : 'Torres'}`,
        payload: {
          aliases: [],
          identifiers: [],
          addresses: [],
          datesOfBirth: [],
          nationalities: [],
        },
      })),
    );

    const res = await svc.screenName(
      { ...screenDefaults, query: 'Rikardo Almeyda Zzqx', matchMode: 'fuzzy' },
      ctx,
    );
    const a = res.hits.find((h) => h.sourceEntryId === 'TIE-A');
    const b = res.hits.find((h) => h.sourceEntryId === 'TIE-B');
    expect(a?.score).toBe(b?.score);
    expect(a?.queryTokenCoverage).toEqual(b?.queryTokenCoverage);
    expect(res.hits.findIndex((h) => h.sourceEntryId === 'TIE-A')).toBeLessThan(
      res.hits.findIndex((h) => h.sourceEntryId === 'TIE-B'),
    );
  });
});

describe('resolveEntity — query-token coverage ranking (issue #15)', () => {
  // runLeiFuzzy shares runFuzzy's `Math.max(tokenScore, wholeScore)` shape and so
  // shares the tie: two candidates each holding one exact query token both score
  // 1.0. The weaker LEI sorts first alphabetically, so the terminal LEI tie-break
  // ranks it ahead until coverage separates them.
  const FULL_LEI = 'ZZZZFULLCOVERAGE0011';
  const WEAK_LEI = 'AAAAWEAKCOVERAGE0011';

  beforeEach(async () => {
    await svc.ingestLeiEntities([
      {
        lei: FULL_LEI,
        legalName: 'Testland Maritime Holdings Group PLC',
        otherNames: [],
        jurisdiction: 'GB',
        status: 'ISSUED',
      },
      {
        lei: WEAK_LEI,
        legalName: 'Aurora Holdings Group Ltd',
        otherNames: [],
        jurisdiction: 'GB',
        status: 'ISSUED',
      },
    ]);
  });

  const resolveFuzzy = () =>
    svc.resolveEntity(
      {
        query: 'Testlandia Maritime Holdings Group',
        matchMode: 'fuzzy',
        status: 'any',
        limit: 25,
      },
      ctx,
    );

  it('ranks the full-coverage candidate above a weaker one tied at the same score', async () => {
    const res = await resolveFuzzy();
    const full = res.matches.findIndex((m) => m.lei === FULL_LEI);
    const weak = res.matches.findIndex((m) => m.lei === WEAK_LEI);
    expect(full).toBe(0);
    expect(weak).toBeGreaterThan(full);
    expect(res.matches[full]?.score).toBe(res.matches[weak]?.score);
  });

  it('surfaces the literal coverage count for each candidate', async () => {
    const res = await resolveFuzzy();
    expect(res.matches.find((m) => m.lei === FULL_LEI)?.queryTokenCoverage).toEqual({
      covered: 4,
      total: 4,
    });
    expect(res.matches.find((m) => m.lei === WEAK_LEI)?.queryTokenCoverage).toEqual({
      covered: 2,
      total: 4,
    });
  });

  it('keeps the LEI as the terminal key when score and coverage tie', async () => {
    const res = await resolveFuzzy();
    const tied = res.matches.filter((m) => m.score === 1 && m.queryTokenCoverage?.covered === 2);
    expect(tied.length).toBeGreaterThan(1);
    expect(tied.map((m) => m.lei)).toEqual([...tied.map((m) => m.lei)].sort());
  });

  it('reports the coverage of the same name it reports the score for', async () => {
    // FX-2002's LEI carries both a legal name and a shorter trading name. Both
    // hold the exact token "trading" and so tie at score 1.0; the legal name
    // covers "compny" too, so it is the name surfaced — and the coverage on the
    // match describes that name, not a different one.
    const res = await svc.resolveEntity(
      { query: 'Fictionel Trading Compny', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === '5493001KJTIIGC8Y1R12');
    expect(match?.matchedName).toBe('Fictional Trading Company LLC');
    expect(match?.queryTokenCoverage).toEqual({ covered: 3, total: 3 });
  });

  it('omits queryTokenCoverage on strict matches', async () => {
    const res = await svc.resolveEntity(
      {
        query: 'Testland Maritime Holdings Group PLC',
        matchMode: 'strict',
        status: 'any',
        limit: 10,
      },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === FULL_LEI);
    expect(match?.matchType).toBe('exact');
    expect(match?.queryTokenCoverage).toBeUndefined();
  });
});

describe('screenName — candidate-pool fairness', () => {
  it('surfaces a fuzzy match whose distinctive token is not the first query token', async () => {
    // Every query token contributes candidates to the fuzzy pool (not just the
    // first / not a single OR clause that the leading token can exhaust). Here the
    // leading token "Vanya" is a near-miss nickname; the real signal is in the
    // later tokens "Volkof" ≈ "Volkov".
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Vanya Volkof', matchMode: 'fuzzy' },
      ctx,
    );
    const hit = res.hits.find((h) => h.sourceEntryId === 'FX-1001');
    expect(hit).toBeDefined();
    expect(hit?.matchType).toBe('approximate');
  });
});

describe('screenName — autoFallback control', () => {
  it('auto-upgrades strict→fuzzy by default when strict is empty', async () => {
    const res = await svc.screenName({ ...screenDefaults, query: 'Ivan Volkow' }, ctx);
    expect(res.modeUsed).toBe('fuzzy');
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it('does NOT auto-fall-back to fuzzy when autoFallback is false', async () => {
    // The internal cross-reference screens (get_entity / trace_ownership) pass
    // this so a generic name does not fuzzy-flood with single-common-token hits.
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkow', autoFallback: false },
      ctx,
    );
    expect(res.modeUsed).toBe('strict');
    expect(res.hits).toHaveLength(0); // strict miss stays a miss — the honest answer
  });

  it('still runs fuzzy when explicitly requested even with autoFallback false', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkow', matchMode: 'fuzzy', autoFallback: false },
      ctx,
    );
    expect(res.modeUsed).toBe('fuzzy');
  });
});

describe('screenName — filters', () => {
  it('honors the source filter', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Imaginary Front Organisation', sources: ['un'] },
      ctx,
    );
    expect(res.hits.every((h) => h.source === 'un')).toBe(true);
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it('honors the entity-type filter', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Phantom Voyager', entityType: 'vessel' },
      ctx,
    );
    expect(res.hits.every((h) => h.entityType === 'vessel')).toBe(true);
  });

  it('excludes hits when the type filter does not match', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Phantom Voyager', entityType: 'person' },
      ctx,
    );
    expect(res.hits).toHaveLength(0);
  });
});

describe('screenName — unknown types under a typed filter', () => {
  beforeEach(async () => {
    await svc.ingestDesignations([
      listed('bis_el', 'TYPE-1', 'Zelvan Rostok Marinsk', 'unknown'),
      listed('eu', 'TYPE-2', 'Zelvan Rostok Marinsk', 'organization'),
    ]);
  });

  it('keeps the source type when screening without a filter (characterization)', async () => {
    const result = await svc.screenName(
      { ...screenDefaults, query: 'Zelvan Rostok Marinsk', sources: ['bis_el'] },
      ctx,
    );
    expect(result.hits.map((hit) => [hit.designationId, hit.entityType, hit.matchType])).toEqual([
      ['bis_el:TYPE-1', 'unknown', 'exact'],
    ]);
  });

  it.each(['person', 'organization', 'vessel', 'aircraft'] as const)(
    'keeps an unknown exact hit under %s',
    async (entityType) => {
      const result = await svc.screenName(
        { ...screenDefaults, query: 'Zelvan Rostok Marinsk', sources: ['bis_el'], entityType },
        ctx,
      );
      expect(result.hits.map((hit) => [hit.designationId, hit.entityType, hit.matchType])).toEqual([
        ['bis_el:TYPE-1', 'unknown', 'exact'],
      ]);
    },
  );

  it.each(['fuzzy', 'strict'] as const)(
    'keeps a fuzzy-only unknown hit in %s mode',
    async (matchMode) => {
      const result = await svc.screenName(
        {
          ...screenDefaults,
          query: 'Zelvann Rostock Marinska',
          sources: ['bis_el'],
          entityType: 'organization',
          matchMode,
        },
        ctx,
      );
      expect(result.hits.map((hit) => [hit.designationId, hit.entityType, hit.matchType])).toEqual([
        ['bis_el:TYPE-1', 'unknown', 'approximate'],
      ]);
    },
  );

  it('keeps a full-coverage unknown hit from a strict-empty list', async () => {
    await svc.ingestDesignations([
      listed('bis_dpl', 'TYPE-3', 'Zelvann Rostock Marinska', 'unknown'),
    ]);
    const result = await svc.screenName(
      {
        ...screenDefaults,
        query: 'Zelvan Rostok Marinsk',
        sources: ['eu', 'bis_dpl'],
        entityType: 'organization',
      },
      ctx,
    );
    expect(result.hits.map((hit) => [hit.designationId, hit.entityType, hit.matchType])).toEqual([
      ['eu:TYPE-2', 'organization', 'exact'],
      ['bis_dpl:TYPE-3', 'unknown', 'approximate'],
    ]);
  });
});

describe('source filter — a repeated list counts once (issue #73)', () => {
  /** As many entries as there are lists, every one the same list. */
  const repeated = (source: SourceCode): SourceCode[] => SOURCE_CODES.map(() => source);

  beforeEach(async () => {
    await svc.ingestDesignations(
      (['eu', 'uk'] as const).map((source) => ({
        ...listed(source, 'REP-73', 'Repeated Filter Holding', 'organization'),
        payload: {
          aliases: [],
          identifiers: [{ type: 'Tax ID No.', value: '7706000073', country: 'Russia' }],
          addresses: [],
          datesOfBirth: [],
          nationalities: [],
        },
      })),
    );
  });

  it.each(['strict', 'fuzzy'] as const)(
    'screens a name on the named list alone: %s',
    async (matchMode) => {
      const res = await svc.screenName(
        { ...screenDefaults, matchMode, query: 'Repeated Filter Holding', sources: repeated('eu') },
        ctx,
      );
      expect(res.hits.map((hit) => hit.designationId)).toEqual(['eu:REP-73']);
      expect(res.totalAvailable).toBe(1);
      if (matchMode === 'fuzzy') expect(res.fuzzySources).toEqual(['eu']);
    },
  );

  it('looks an identifier up on the named list alone', async () => {
    const hits = await svc.screenIdentifier({
      value: '7706000073',
      type: 'any',
      sources: repeated('eu'),
    });
    expect(hits.map((hit) => [hit.source, hit.sources])).toEqual([['eu', ['eu']]]);
  });
});

describe('screenIdentifier — IMO company numbers', () => {
  const identifier = { type: 'Identification Number', value: 'IMO 1790183' };
  const screen = (service: ScreeningService, value: string, type: 'any' | 'imo' | 'other') =>
    service.screenIdentifier({ value, type, sources: ['ofac_sdn'] });

  beforeEach(async () => {
    const entity = listed(
      'ofac_sdn',
      '17068',
      'Ocean Maritime Management Company Limited',
      'organization',
    );
    await svc.ingestDesignations([
      { ...entity, payload: { ...entity.payload, identifiers: [identifier] } },
    ]);
  });

  it.each([
    ['1790183', 'any'],
    ['IMO 1790183', 'imo'],
    ['IMO 1790183', 'any'],
  ] as const)('matches %s under %s once, with the published identifier', async (value, type) => {
    const hits = await screen(svc, value, type);
    expect(hits.map((hit) => [hit.source, hit.sourceEntryId, hit.matchedIdentifiers])).toEqual([
      ['ofac_sdn', '17068', [identifier]],
    ]);
  });

  it('excludes the IMO number from other lookups', async () => {
    expect(await screen(svc, 'IMO 1790183', 'other')).toEqual([]);
  });

  it.each(['complete', 'in_progress'] as const)(
    'rebuilds an unversioned identifier index on reopen while sync is %s',
    async (status) => {
      const handle = await svc.designations.raw();
      const state = await svc.designations.store.readState();
      handle
        .prepare('UPDATE designation_identifier_stamp SET stamp = ? WHERE id = 1')
        .run(`${state.startedAt ?? ''}|${state.completedAt ?? ''}`);
      handle.exec(
        "UPDATE designation_identifier SET category = 'other', key = 'IMO1790183' WHERE designation_id = 'ofac_sdn:17068'",
      );
      await svc.designations.store.writeState({ ...state, status });
      await svc.close();
      const reopened = buildScreeningService();
      try {
        const hits = await screen(reopened, '1790183', 'imo');
        expect(hits.map((hit) => [hit.source, hit.sourceEntryId, hit.matchedIdentifiers])).toEqual([
          ['ofac_sdn', '17068', [identifier]],
        ]);
        const reopenedHandle = await reopened.designations.raw();
        expect(
          reopenedHandle
            .prepare('SELECT category, key FROM designation_identifier WHERE designation_id = ?')
            .all('ofac_sdn:17068'),
        ).toEqual([{ category: 'imo', key: '1790183' }]);
        expect(
          reopenedHandle
            .prepare('SELECT stamp FROM designation_identifier_stamp WHERE id = 1')
            .get(),
        ).toEqual({ stamp: `v1:${state.startedAt ?? ''}|${state.completedAt ?? ''}` });
      } finally {
        await reopened.close();
      }
    },
  );
});

describe('screenName — offset pagination and overflow disclosure (issue #9)', () => {
  /** Six designations sharing a name stem, so one strict screen matches all six. */
  const pageDesignations = Array.from({ length: 6 }, (_, index) => ({
    id: `un:PAGE-${index}`,
    source: 'un' as const,
    sourceEntryId: `PAGE-${index}`,
    entityType: 'organization' as const,
    primaryName: `Overflow Candidate ${String.fromCharCode(65 + index)}`,
    payload: {
      aliases: [],
      identifiers: [],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  }));

  beforeEach(async () => {
    await svc.ingestDesignations(pageDesignations);
  });

  // The one list the six are on: a list strict found nothing on would be fuzzy-completed (#59).
  const screenPage = (offset: number, limit: number) =>
    svc.screenName(
      { ...screenDefaults, query: 'Overflow Candidate', sources: ['un'], limit, offset },
      ctx,
    );

  it('reports the pre-slice total as exact and returns only the requested page', async () => {
    const res = await screenPage(0, 2);
    expect(res.hits).toHaveLength(2);
    expect(res.totalAvailable).toBe(6);
    expect(res.totalAvailableBasis).toBe('exact');
  });

  it('walks disjoint pages that reassemble the complete set in order', async () => {
    const pages = await Promise.all([screenPage(0, 2), screenPage(2, 2), screenPage(4, 2)]);
    const ids = pages.flatMap((page) => page.hits.map((hit) => hit.designationId));
    expect(ids).toEqual([
      'un:PAGE-0',
      'un:PAGE-1',
      'un:PAGE-2',
      'un:PAGE-3',
      'un:PAGE-4',
      'un:PAGE-5',
    ]);
  });

  it('orders same-band ties deterministically across repeated identical queries', async () => {
    // Every hit here is `strong`, so matchRank cannot separate them — without an
    // explicit secondary key the order is incidental Map-insertion order and the
    // pages above could overlap or drop rows.
    const first = await screenPage(0, 6);
    const second = await screenPage(0, 6);
    expect(second.hits.map((hit) => hit.designationId)).toEqual(
      first.hits.map((hit) => hit.designationId),
    );
  });

  it('returns an empty page past the end while still reporting the true total', async () => {
    const res = await screenPage(99, 2);
    expect(res.hits).toHaveLength(0);
    expect(res.totalAvailable).toBe(6);
  });

  it('labels a fuzzy-mode total as a bound, never an exact corpus count', async () => {
    const res = await svc.screenName(
      { ...screenDefaults, query: 'Ivan Volkow', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.modeUsed).toBe('fuzzy');
    expect(res.totalAvailableBasis).toBe('lower_bound');
  });

  it('counts every strict match exactly and pages to the last one, past 5,000 alias rows', async () => {
    // A strict pass once read at most 5,000 alias rows in no set order, so a token
    // this common left designations that no offset reached.
    const count = 5100;
    await svc.ingestDesignations(
      Array.from({ length: count }, (_, index) =>
        listed('un', `CAP-${index}`, `Capped Candidate ${index}`, 'organization'),
      ),
    );
    const walked: string[] = [];
    for (let offset = 0; offset < count; offset += 1000) {
      const res = await svc.screenName(
        { ...screenDefaults, query: 'Capped', sources: ['un'], limit: 1000, offset },
        ctx,
      );
      expect(res).toMatchObject({
        modeUsed: 'strict',
        totalAvailable: count,
        totalAvailableBasis: 'exact',
        poolBounded: false,
      });
      walked.push(...res.hits.map((hit) => hit.designationId));
    }
    expect(walked).toEqual(Array.from({ length: count }, (_, index) => `un:CAP-${index}`));
  });

  it('pages every candidate a fuzzy pass admits, past the fifty it once kept', async () => {
    await svc.ingestDesignations(
      Array.from({ length: 80 }, (_, i) =>
        listed('un', `ZEL-${i}`, `Zelvanora Zx${i}`, 'organization'),
      ),
    );
    const screen = (offset: number, limit: number) =>
      svc.screenName(
        { ...screenDefaults, query: 'Zelvanorra', matchMode: 'fuzzy', limit, offset },
        ctx,
      );
    const whole = await screen(0, 100);
    expect(whole).toMatchObject({ totalAvailable: 80, totalAvailableBasis: 'lower_bound' });
    expect(new Set(whole.hits.map((hit) => hit.designationId))).toEqual(
      new Set(Array.from({ length: 80 }, (_, i) => `un:ZEL-${i}`)),
    );

    const walked: string[] = [];
    for (let offset = 0; offset < whole.totalAvailable; offset += 7) {
      walked.push(...(await screen(offset, 7)).hits.map((hit) => hit.designationId));
    }
    expect(walked).toEqual(whole.hits.map((hit) => hit.designationId));
  });

  it('says when the candidate budget left a block out, and only then', async () => {
    // `vla` and the phonetic key of `Vladimir` each reach 2,002 names, past the budget.
    await svc.ingestDesignations([
      ...Array.from({ length: FUZZY_POOL_BUDGET + 1 }, (_, i) =>
        listed('ofac_sdn', `VLA-${i}`, `Vladimir Zx${i}`),
      ),
      listed('uk', 'PET-UK', 'Vladimir Petrenkov'),
    ]);
    const fuzzy = (query: string) =>
      svc.screenName({ ...screenDefaults, query, matchMode: 'fuzzy' }, ctx);

    const bounded = await fuzzy('Vladimir Petrenkox');
    expect(bounded.poolBounded).toBe(true);
    expect(bounded.hits.map((hit) => hit.designationId)).toContain('uk:PET-UK');
    expect((await fuzzy('Petrenkox')).poolBounded).toBe(false);
  });
});

describe('resolveEntity — offset pagination and overflow disclosure (issue #9)', () => {
  const pageEntities = Array.from({ length: 4 }, (_, index) => ({
    lei: `OVERFLOWSERVICE${index}0011`,
    legalName: `Overflow Candidate ${String.fromCharCode(65 + index)} Ltd`,
    otherNames: [],
    jurisdiction: 'US',
    status: 'ISSUED',
  }));

  beforeEach(async () => {
    await svc.ingestLeiEntities(pageEntities);
  });

  const resolvePage = (offset: number, limit: number) =>
    svc.resolveEntity(
      { query: 'Overflow Candidate', matchMode: 'strict', status: 'issued', limit, offset },
      ctx,
    );

  it('reports the pre-slice total as exact and returns only the requested page', async () => {
    const res = await resolvePage(0, 2);
    expect(res.matches).toHaveLength(2);
    expect(res.totalAvailable).toBe(4);
    expect(res.totalAvailableBasis).toBe('exact');
  });

  it('walks disjoint pages that reassemble the complete set in a stable order', async () => {
    const pages = await Promise.all([resolvePage(0, 2), resolvePage(2, 2)]);
    const leis = pages.flatMap((page) => page.matches.map((match) => match.lei));
    expect(leis).toEqual(pageEntities.map((entity) => entity.lei));
    expect((await resolvePage(0, 4)).matches.map((match) => match.lei)).toEqual(leis);
  });

  it('returns an empty page past the end while still reporting the true total', async () => {
    const res = await resolvePage(99, 2);
    expect(res.matches).toHaveLength(0);
    expect(res.totalAvailable).toBe(4);
  });

  it('labels a fuzzy-mode total as a bound, never an exact corpus count', async () => {
    const res = await svc.resolveEntity(
      { query: 'Fictionel Trading Compny', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    expect(res.modeUsed).toBe('fuzzy');
    expect(res.totalAvailableBasis).toBe('lower_bound');
  });

  it('pages every LEI a fuzzy pass admits, past the fifty it once kept', async () => {
    await svc.ingestLeiEntities(
      Array.from({ length: 80 }, (_, i) => registered(`ZELVANORA${i}`, `Zelvanora Zx${i}`)),
    );
    const fuzzy = (offset: number, limit: number) =>
      svc.resolveEntity(
        { query: 'Zelvanorra', matchMode: 'fuzzy', status: 'issued', limit, offset },
        ctx,
      );
    const whole = await fuzzy(0, 100);
    expect(whole).toMatchObject({ totalAvailable: 80, totalAvailableBasis: 'lower_bound' });
    expect(new Set(whole.matches.map((match) => match.lei))).toEqual(
      new Set(Array.from({ length: 80 }, (_, i) => testLei(`ZELVANORA${i}`))),
    );

    const walked: string[] = [];
    for (let offset = 0; offset < whole.totalAvailable; offset += 7) {
      walked.push(...(await fuzzy(offset, 7)).matches.map((match) => match.lei));
    }
    expect(walked).toEqual(whole.matches.map((match) => match.lei));
  });

  it('says when the candidate budget left a block of names out, and only then', async () => {
    await svc.ingestLeiEntities([
      ...Array.from({ length: FUZZY_POOL_BUDGET + 1 }, (_, i) =>
        registered(`KESBOUND${i}`, `Kestrel Zx${i}`),
      ),
      registered('KESTRELBANK', 'Kestrel Bank'),
    ]);
    const fuzzy = (query: string) =>
      svc.resolveEntity({ query, matchMode: 'fuzzy', status: 'any', limit: 10 }, ctx);

    // `kes` holds 2,002 names, past the budget; `ban` pools the target on its own.
    const bounded = await fuzzy('Kestrel Banko');
    expect(bounded.poolBounded).toBe(true);
    expect(bounded.matches.map((match) => match.lei)).toContain(testLei('KESTRELBANK'));
    expect((await fuzzy('Banko')).poolBounded).toBe(false);
  });
});

describe('getDesignation', () => {
  it('returns the full normalized record', async () => {
    const d = await svc.getDesignation('ofac_sdn', 'FX-1001');
    expect(d?.primaryName).toBe('Ivan Testovich Volkov');
    expect(d?.payload.aliases.length).toBeGreaterThan(0);
    expect(d?.payload.identifiers[0]?.type).toBe('Passport');
  });

  it('returns null for an unknown entry', async () => {
    expect(await svc.getDesignation('ofac_sdn', 'NOPE')).toBeNull();
  });
});

describe('resolveEntity', () => {
  it('resolves a company name to its LEI (strict)', async () => {
    const res = await svc.resolveEntity(
      { query: 'Fictional Trading Company LLC', matchMode: 'strict', status: 'issued', limit: 10 },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === '5493001KJTIIGC8Y1R12');
    expect(match).toBeDefined();
    expect(match?.matchType).toBe('exact');
  });

  it('honors the jurisdiction filter', async () => {
    const res = await svc.resolveEntity(
      {
        query: 'Testland Holdings',
        jurisdiction: 'GB',
        matchMode: 'strict',
        status: 'issued',
        limit: 10,
      },
      ctx,
    );
    expect(res.matches.every((m) => m.jurisdiction === 'GB')).toBe(true);
  });

  it('fuzzy-matches a misspelled company name with a raw score', async () => {
    const res = await svc.resolveEntity(
      { query: 'Fictionel Trading Compny', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === '5493001KJTIIGC8Y1R12');
    expect(match?.matchType).toBe('approximate');
    expect(typeof match?.score).toBe('number');
  });
});

describe('resolveEntity — single-token false-positive gate (issue #4)', () => {
  // runLeiFuzzy shares runFuzzy's admission gate: a legal/trading name must explain
  // enough of the query, not be carried by one strong token pair. "Testland
  // Holdings PLC" is pooled by any query token whose prefix matches its legal name.
  it('rejects an LEI whose legal name matches only one of three query tokens', async () => {
    // "Testlandia" ≈ "Testland" (JW ~0.96, above the floor); "Xyzzy"/"Qqpzm" are
    // noise. Coverage 1/3 → not admitted, even though the one pair clears the floor.
    const res = await svc.resolveEntity(
      { query: 'Testlandia Xyzzy Qqpzm', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    expect(res.matches.find((m) => m.lei === '529900T8BM49AURSDO55')).toBeUndefined();
  });

  it('still admits an LEI when 2 of 3 query tokens are covered', async () => {
    // "Testland" + "Holdings" both match the legal name exactly (coverage 2/3);
    // "Qqzz" is noise. Enough of the query is explained → admitted.
    const res = await svc.resolveEntity(
      { query: 'Testland Holdings Qqzz', matchMode: 'fuzzy', status: 'any', limit: 10 },
      ctx,
    );
    const match = res.matches.find((m) => m.lei === '529900T8BM49AURSDO55');
    expect(match).toBeDefined();
    expect(match?.matchType).toBe('approximate');
  });
});

describe('ownership', () => {
  it('checks indexed relationship references at either end without admitting an absent LEI', async () => {
    expect(await svc.hasRelationshipReference('5493001KJTIIGC8Y1R12')).toBe(true);
    expect(await svc.hasRelationshipReference('529900T8BM49AURSDO55')).toBe(true);
    expect(await svc.hasRelationshipReference('529900UNKNOWNLEI0009')).toBe(false);
    await svc.ingestLeiRelationships([
      {
        childLei: 'MISSING-CHILD',
        parentLei: 'MISSING-PARENT',
        relationshipType: 'IS_DIRECTLY_CONSOLIDATED_BY',
      },
    ]);
    expect(await svc.hasRelationshipReference('MISSING-CHILD')).toBe(true);
    expect(await svc.hasRelationshipReference('MISSING-PARENT')).toBe(true);
    expect(await svc.getLeiEntity('MISSING-PARENT')).toBeNull();
  });

  it('counts only existing Level 1 membership across bind batches, without hydrating payloads', async () => {
    const missing = Array.from({ length: 501 }, (_, i) => `ABSENT${i}`);
    const existing = await svc.existingLeiEntities([
      ...missing,
      '5493001KJTIIGC8Y1R12',
      '529900T8BM49AURSDO55',
      '5493001KJTIIGC8Y1R12',
    ]);
    expect(existing).toEqual(new Set(['5493001KJTIIGC8Y1R12', '529900T8BM49AURSDO55']));
    expect(await svc.existingLeiEntities([])).toEqual(new Set());
  });

  it('returns the direct parent relationship for a child LEI', async () => {
    const rels = await svc.getRelationships('5493001KJTIIGC8Y1R12', 'parents');
    expect(rels).toHaveLength(1);
    expect(rels[0]?.parentLei).toBe('529900T8BM49AURSDO55');
    expect(rels[0]?.relationshipType).toBe('IS_ULTIMATELY_CONSOLIDATED_BY');
  });

  it('returns the child relationship from the parent side', async () => {
    const rels = await svc.getRelationships('529900T8BM49AURSDO55', 'children');
    expect(rels).toHaveLength(1);
    expect(rels[0]?.childLei).toBe('5493001KJTIIGC8Y1R12');
  });
});

describe('sources + readiness', () => {
  it('reports per-source counts and readiness', async () => {
    const counts = await svc.sourceCounts();
    // FX-1001 (Ivan Testovich Volkov) + FX-8008 (the single-token false-positive guard).
    expect(counts.find((c) => c.code === 'ofac_sdn')?.recordCount).toBe(2);
    expect(await svc.sanctionsReady()).toBe(true);
    expect(await svc.leiReady()).toBe(true);
  });
});

describe('ingestLeiRelationships — per-record apply (issues #6, #49)', () => {
  const CHILD = '5493001KJTIIGC8Y1R12';
  const relA = {
    childLei: CHILD,
    parentLei: 'PARENTAAAAAAAAAAAAA1',
    relationshipType: 'IS_DIRECTLY_CONSOLIDATED_BY',
  };
  const relB = {
    childLei: CHILD,
    parentLei: 'PARENTBBBBBBBBBBBBB1',
    relationshipType: 'IS_ULTIMATELY_CONSOLIDATED_BY',
  };
  const parents = async () =>
    (await svc.getRelationships(CHILD, 'parents'))
      .map((r) => `${r.relationshipType}->${r.parentLei}`)
      .sort();

  it('keeps a child whose relationships span a batch boundary', async () => {
    // The streaming golden-copy hazard: one child's relationships arrive in two
    // separate batches, so batch 2 must not delete batch 1's rows.
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([relA]);
    await svc.ingestLeiRelationships([relB]);
    expect(await parents()).toEqual([
      `IS_DIRECTLY_CONSOLIDATED_BY->${relA.parentLei}`,
      `IS_ULTIMATELY_CONSOLIDATED_BY->${relB.parentLei}`,
    ]);
  });

  it("keeps a child's rows a delta does not restate", async () => {
    // A delta carries only changed relationships: restating relA says nothing about relB.
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([relA, relB]);
    await svc.ingestLeiRelationships([{ ...relA, relationshipStatus: 'INACTIVE' }]);
    const rows = await svc.getRelationships(CHILD, 'parents');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.parentLei === relA.parentLei)?.relationshipStatus).toBe('INACTIVE');
  });

  it('removes the row a change marks deleted, and only that row', async () => {
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([relA, relB]);
    await svc.ingestLeiRelationships([{ ...relA, deleted: true }]);
    expect(await parents()).toEqual([`IS_ULTIMATELY_CONSOLIDATED_BY->${relB.parentLei}`]);
    // Deleting a row that is not stored is a no-op, so a re-applied delta converges.
    await svc.ingestLeiRelationships([{ ...relA, deleted: true }]);
    expect(await parents()).toEqual([`IS_ULTIMATELY_CONSOLIDATED_BY->${relB.parentLei}`]);
  });

  it("leaves each key in its last record's state, in document order within one batch", async () => {
    await svc.clearLeiRelationships();
    await svc.ingestLeiRelationships([
      relA,
      { ...relA, deleted: true },
      relA,
      relB,
      { ...relB, deleted: true },
    ]);
    expect(await parents()).toEqual([`IS_DIRECTLY_CONSOLIDATED_BY->${relA.parentLei}`]);
  });

  it('clearLeiRelationships wipes the table', async () => {
    await svc.clearLeiRelationships();
    expect(await svc.getRelationships(CHILD, 'parents')).toHaveLength(0);
    expect((await svc.leiReadiness()).relationshipCount).toBe(0);
  });
});

describe('reporting exceptions — per-record apply and batched read (issue #26)', () => {
  const LEI = '0292001156F2T0UFG565';
  const OTHER = '097900BHKT0000085647';
  const DIRECT = 'DIRECT_ACCOUNTING_CONSOLIDATION_PARENT';
  const ULTIMATE = 'ULTIMATE_ACCOUNTING_CONSOLIDATION_PARENT';

  it('upserts by (LEI, category), deletes on the marker, and keeps the last record', async () => {
    await svc.clearReportingExceptions();
    await svc.ingestReportingExceptions([
      { lei: LEI, category: DIRECT, reasons: ['NON_PUBLIC'] },
      { lei: LEI, category: DIRECT, reasons: ['NATURAL_PERSONS'] },
      { lei: LEI, category: ULTIMATE, reasons: ['NATURAL_PERSONS', 'NO_KNOWN_PERSON'] },
      { lei: OTHER, category: DIRECT, reasons: ['NO_LEI'] },
      { lei: OTHER, category: DIRECT, reasons: ['NO_LEI'], deleted: true },
    ]);
    const byLei = await svc.getReportingExceptions([LEI, OTHER, '5493001KJTIIGC8Y1R12']);
    expect(byLei.get(LEI)).toEqual([
      { category: DIRECT, reasons: ['NATURAL_PERSONS'] },
      { category: ULTIMATE, reasons: ['NATURAL_PERSONS', 'NO_KNOWN_PERSON'] },
    ]);
    expect(byLei.has(OTHER)).toBe(false);
    expect(byLei.has('5493001KJTIIGC8Y1R12')).toBe(false);
    expect((await svc.leiReadiness()).exceptionCount).toBe(2);
  });

  it('reports the exception count of the committed state, re-counted after each commit', async () => {
    const before = (await svc.leiReadiness()).exceptionCount;
    await svc.ingestReportingExceptions([
      { lei: OTHER, category: DIRECT, reasons: ['NO_LEI'] },
      { lei: OTHER, category: ULTIMATE, reasons: ['NO_LEI'] },
    ]);
    // Rows a load or refresh is still applying are not counted until it commits.
    expect((await svc.leiReadiness()).exceptionCount).toBe(before);
    await svc.markLeiReady(3, { repex: '2026-09-25T10:00:00Z' });
    expect((await svc.leiReadiness()).exceptionCount).toBe(before + 2);
  });

  it('counts as loaded only once a load is recorded, never because rows exist', async () => {
    const fresh = await freshService();
    try {
      await fresh.service.ingestReportingExceptions([
        { lei: LEI, category: DIRECT, reasons: ['NON_PUBLIC'] },
      ]);
      expect(await fresh.service.reportingExceptionsLoaded()).toBe(false);
      await fresh.service.markLeiReady(0, { repex: '2026-09-25T09:01:50Z' });
      expect(await fresh.service.reportingExceptionsLoaded()).toBe(true);
    } finally {
      await fresh.cleanup();
    }
  });
});

describe('markLeiReady — the durable GLEIF checkpoint (issue #49)', () => {
  it('records the per-dataset checkpoint it is given, with the live entity count', async () => {
    await svc.markLeiReady(99, { lei2: '2026-09-25T08:08:49Z', rr: '2026-09-25T09:17:31Z' });
    expect(await svc.gleifCheckpoint()).toEqual({
      lei2: '2026-09-25T08:08:49Z',
      rr: '2026-09-25T09:17:31Z',
    });
    expect((await svc.leiReadiness()).total).toBe(99);
  });

  it('keeps the stored checkpoint when given none', async () => {
    await svc.markLeiReady(1, { lei2: '2026-09-25T08:08:49Z' });
    await svc.markLeiReady(2);
    expect(await svc.gleifCheckpoint()).toEqual({ lei2: '2026-09-25T08:08:49Z' });
  });

  it('reads no checkpoint from a mirror whose sync state carries none', async () => {
    const fresh = await freshService();
    try {
      expect(await fresh.service.gleifCheckpoint()).toEqual({});
    } finally {
      await fresh.cleanup();
    }
  });
});

describe('re-harvest idempotence (issue #14)', () => {
  const HARVEST_XML = `<sdnList>
    <sdnEntry><uid>RH-1</uid><firstName>Reharvest</firstName><lastName>Person</lastName></sdnEntry>
    <sdnEntry><firstName>Identifierless</firstName><lastName>Person</lastName></sdnEntry>
  </sdnList>`;

  it('re-ingesting the same source document updates rows instead of inserting new ones', async () => {
    const harvest = () => parseOfac(parseXml(HARVEST_XML), 'ofac_sdn');

    await svc.ingestDesignations(harvest());
    const afterFirst = await svc.sourceCounts();
    await svc.ingestDesignations(harvest());

    expect(await svc.sourceCounts()).toEqual(afterFirst);
  });

  it('never admits a record the source gave no identifier for', async () => {
    await svc.ingestDesignations(parseOfac(parseXml(HARVEST_XML), 'ofac_sdn'));

    const admitted = await svc.screenName({ ...screenDefaults, query: 'Reharvest Person' }, ctx);
    expect(admitted.hits.map((h) => h.sourceEntryId)).toContain('RH-1');

    const rejected = await svc.screenName(
      { ...screenDefaults, query: 'Identifierless Person', autoFallback: false },
      ctx,
    );
    expect(rejected.hits).toHaveLength(0);
  });
});

// ─── Fuzzy blocking prefixes (issue #31) ───────────────────────────────────────

/**
 * Every `LIKE` pattern the fuzzy paths bind during `run` — the blocking prefixes
 * as SQLite receives them, read at the statement boundary.
 */
async function likePatterns(handle: SqliteHandle, run: () => Promise<unknown>): Promise<string[]> {
  const original = handle.prepare.bind(handle);
  const patterns: string[] = [];
  handle.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!/\bLIKE \?/.test(sql)) return statement;
    return {
      ...statement,
      all: (...params: Parameters<typeof statement.all>) => {
        patterns.push(String(params[0]));
        return statement.all(...params);
      },
    };
  }) as typeof handle.prepare;
  try {
    await run();
  } finally {
    handle.prepare = original;
  }
  return patterns;
}

/**
 * Every FTS prefix term the fuzzy blocking lookups bind during `run` — the
 * blocking prefixes as the index receives them (`"fic"*`), read at the statement
 * boundary.
 */
async function indexPrefixes(handle: SqliteHandle, run: () => Promise<unknown>): Promise<string[]> {
  const original = handle.prepare.bind(handle);
  const prefixes: string[] = [];
  handle.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!/\bMATCH \?/.test(sql) || sql.includes('name_supplement_fts')) return statement;
    return {
      ...statement,
      all: (...params: Parameters<typeof statement.all>) => {
        for (const m of String(params[0]).matchAll(/"([^"]+)"\*/g)) prefixes.push(m[1] ?? '');
        return statement.all(...params);
      },
    };
  }) as typeof handle.prepare;
  try {
    await run();
  } finally {
    handle.prepare = original;
  }
  return prefixes;
}

/** What a screen read from the designation `name` index. */
interface NameIndexTrace {
  /** Each MATCH lookup: the expression it bound and the name rowids it returned. */
  lookups: { expression: string; rowids: number[] }[];
  /** The name rows the fuzzy pass scored — its candidate pool — rowid → designation id. */
  pooled: Map<number, string>;
  /** Every statement that read the name index, with the parameters it ran with. */
  statements: { params: unknown[]; sql: string }[];
}

/**
 * Trace what `run` reads from the name index, at the statement boundary. A row
 * read with its `rowid` and `normalized` columns is one the fuzzy pass scores;
 * the strict pass reads no `rowid`, so its rows never count as pooled.
 */
async function traceNameIndex<T>(
  handle: SqliteHandle,
  run: () => Promise<T>,
): Promise<NameIndexTrace & { result: T }> {
  const original = handle.prepare.bind(handle);
  const trace: NameIndexTrace = { lookups: [], pooled: new Map(), statements: [] };
  handle.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!/\b(FROM|JOIN) name(_fts|_blocking_fts)?\b/.test(sql)) return statement;
    return {
      ...statement,
      all: (...params: Parameters<typeof statement.all>) => {
        const rows = statement.all(...params) as Record<string, unknown>[];
        trace.statements.push({ sql, params });
        if (/\bMATCH \?/.test(sql)) {
          trace.lookups.push({
            expression: String(params[0]),
            rowids: rows.map((row) => Number(row.rowid)),
          });
        }
        for (const row of rows) {
          if ('rowid' in row && 'normalized' in row) {
            trace.pooled.set(Number(row.rowid), String(row.designation_id));
          }
        }
        return rows;
      },
    };
  }) as typeof handle.prepare;
  try {
    return { ...trace, result: await run() };
  } finally {
    handle.prepare = original;
  }
}

/** True when a phonetic lookup returned one of the designation's name rows and the pass scored it. */
function phoneticallyPooled(trace: NameIndexTrace, designationId: string): boolean {
  const rows = [...trace.pooled].filter(([, id]) => id === designationId).map(([rowid]) => rowid);
  return trace.lookups.some(
    ({ expression, rowids }) =>
      expression.includes('phonetic :') && rowids.some((rowid) => rows.includes(rowid)),
  );
}

/** The plan steps that read a table row by row rather than through an index. */
function tableScans(handle: SqliteHandle, statements: NameIndexTrace['statements']): string[] {
  return statements.flatMap(({ sql, params }) =>
    handle
      .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(params as never[]))
      .map((step) => step.detail)
      .filter((detail) => detail.startsWith('SCAN ') && !detail.includes('VIRTUAL TABLE')),
  );
}

/** One designation whose only name is `name`. */
function namedDesignation(entryId: string, name: string): NormalizedDesignation {
  return listed('un', entryId, name);
}

/** One designation on `source` whose only name is `name`. */
function listed(
  source: NormalizedDesignation['source'],
  entryId: string,
  name: string,
  entityType: NormalizedDesignation['entityType'] = 'person',
): NormalizedDesignation {
  return {
    id: `${source}:${entryId}`,
    source,
    sourceEntryId: entryId,
    entityType,
    primaryName: name,
    payload: { aliases: [], identifiers: [], addresses: [], datesOfBirth: [], nationalities: [] },
  };
}

describe('fuzzy blocking prefixes — BMP tokens', () => {
  it('blocks the designation path on each token’s leading three characters, dropping one-letter tokens, through the name index', async () => {
    const handle = await svc.designations.raw();
    const run = () =>
      svc.screenName(
        { ...screenDefaults, matchMode: 'fuzzy', query: 'Nikolas Ib Maduro X Moros' },
        ctx,
      );
    expect(await indexPrefixes(handle, run)).toEqual(['nik', 'ib', 'mad', 'mor']);
    expect(await likePatterns(handle, run)).toEqual([]);
  });

  it('blocks the LEI path on the same prefixes, through the name index', async () => {
    const handle = await svc.leiEntities.raw();
    const run = () =>
      svc.resolveEntity(
        { query: 'Fictionall Tradng Xu X', matchMode: 'fuzzy', limit: 10, status: 'any' },
        ctx,
      );
    expect(await indexPrefixes(handle, run)).toEqual(['fic', 'tra', 'xu']);
    expect(await likePatterns(handle, run)).toEqual([]);
  });
});

describe('fuzzy blocking prefixes — supplementary-plane letters (issue #31)', () => {
  // U+20000–U+20004 (CJK Extension B): each is one code point, two UTF-16 units.
  const STORED = '𠀀𠀁𠀂𠀃';
  const QUERY = '𠀀𠀁𠀂𠀄'; // shares its first three code points with STORED

  let astral: SeededService;
  afterEach(async () => {
    await astral.cleanup();
  });

  it('pools and admits a designation on its supplementary-plane prefix', async () => {
    astral = await freshService();
    const service = astral.service;
    await service.ingestDesignations([namedDesignation('ASTRAL-1', STORED)]);

    const handle = await service.designations.raw();
    const run = () =>
      service.screenName({ ...screenDefaults, matchMode: 'fuzzy', query: QUERY }, ctx);
    const prefixes = await indexPrefixes(handle, run);

    expect(prefixes).toEqual(['𠀀𠀁𠀂']);
    expect(prefixes.every((p) => p.isWellFormed())).toBe(true);
    expect(await likePatterns(handle, run)).toEqual([]);
    expect((await run()).hits.map((h) => h.designationId)).toEqual(['un:ASTRAL-1']);
  });

  it('pools and admits an LEI entity on its supplementary-plane prefix', async () => {
    astral = await freshService();
    const service = astral.service;
    await service.ingestLeiEntities([
      { lei: '5493001KJTIIGC8Y1R12', legalName: STORED, otherNames: [] },
    ]);

    const handle = await service.leiEntities.raw();
    let leis: string[] = [];
    const prefixes = await indexPrefixes(handle, async () => {
      const res = await service.resolveEntity(
        { query: QUERY, matchMode: 'fuzzy', limit: 10, status: 'any' },
        ctx,
      );
      leis = res.matches.map((m) => m.lei);
    });

    expect(prefixes).toEqual(['𠀀𠀁𠀂']);
    expect(prefixes.every((p) => p.isWellFormed())).toBe(true);
    expect(leis).toEqual(['5493001KJTIIGC8Y1R12']);
  });

  it('counts a token’s length in code points, so a lone supplementary letter blocks nothing', async () => {
    astral = await freshService();
    const service = astral.service;
    await service.ingestDesignations([namedDesignation('ASTRAL-2', 'ab𠀀xyz')]);

    const handle = await service.designations.raw();
    const prefixes = await indexPrefixes(handle, () =>
      service.screenName({ ...screenDefaults, matchMode: 'fuzzy', query: '𠀀 ab𠀀x' }, ctx),
    );

    // `𠀀` is one code point (two code units) — too short to block on, like any
    // one-letter token; `ab𠀀x` blocks on its first three code points, whole.
    expect(prefixes).toEqual(['ab𠀀']);
  });

  it('admits a supplementary-plane candidate exactly when its BMP twin is admitted', async () => {
    // `𠀀𠀁𠀂𠀃𠀄𠀅` / `𠀀𠀁𠀂𠀗𠀘𠀙` is the code-point image of `abcdef` / `abcxyz`: three
    // shared letters of six score 0.7667, under the 0.85 floor, in either plane.
    // Counted in UTF-16 code units, the shared high surrogates lift it to 0.90.
    astral = await freshService();
    const service = astral.service;
    await service.ingestDesignations([
      namedDesignation('BMP-TWIN', 'abcxyz'),
      namedDesignation('ASTRAL-TWIN', '𠀀𠀁𠀂𠀗𠀘𠀙'),
    ]);
    const screen = (query: string) =>
      service.screenName({ ...screenDefaults, matchMode: 'fuzzy', query }, ctx);

    expect((await screen('abcdef')).hits).toEqual([]);
    expect((await screen('𠀀𠀁𠀂𠀃𠀄𠀅')).hits).toEqual([]);

    // A genuine near-miss still admits in both planes, at the same score.
    const bmp = await screen('abcxyw');
    const sup = await screen('𠀀𠀁𠀂𠀗𠀘𠀖');
    expect(bmp.hits.map((h) => h.designationId)).toEqual(['un:BMP-TWIN']);
    expect(sup.hits.map((h) => h.designationId)).toEqual(['un:ASTRAL-TWIN']);
    expect(sup.hits[0]?.score).toBe(bmp.hits[0]?.score);
  });
});

// ─── Fuzzy blocking through the name index (issues #50, #54, #68) ─────────────

/** A designation with a Han alias whose leading characters a query can omit. */
const LIMBACH: NormalizedDesignation = {
  id: 'eu:171379',
  source: 'eu',
  sourceEntryId: '171379',
  entityType: 'organization',
  primaryName: 'Xiamen Limbach Aviation Engine Co., Ltd',
  payload: {
    aliases: [{ name: '厦门林巴贺航空发动机股份有限公司', nameType: 'aka' }],
    identifiers: [],
    addresses: [],
    datesOfBirth: [],
    nationalities: [],
  },
};

describe('fuzzy blocking — index lookups (issue #50)', () => {
  it.each([
    {},
    { entityType: 'person' as const },
    { sources: ['uk' as const] },
    { sources: ['uk' as const, 'eu' as const], entityType: 'person' as const },
  ])('plans every name-index read on an index, filters %j', async (filters) => {
    const handle = await svc.designations.raw();
    const trace = await traceNameIndex(handle, () =>
      svc.screenName(
        { ...screenDefaults, ...filters, query: 'Vladimir Poutine', matchMode: 'fuzzy' },
        ctx,
      ),
    );
    expect(trace.statements.length).toBeGreaterThan(1);
    expect(tableScans(handle, trace.statements)).toEqual([]);
  });

  it('reads only index lookups for a 64-word query whose words match nothing', async () => {
    const words = Array.from(
      { length: 64 },
      (_, i) => `q${'bcdfghjk'[i % 8]}${'lmnpqrst'[Math.floor(i / 8)]}zzv`,
    );
    const handle = await svc.designations.raw();
    const trace = await traceNameIndex(handle, () =>
      svc.screenName({ ...screenDefaults, query: words.join(' '), matchMode: 'fuzzy' }, ctx),
    );
    expect(trace.result.hits).toEqual([]);
    expect(trace.statements.filter(({ sql }) => /\bLIKE\b/.test(sql))).toEqual([]);
    expect(tableScans(handle, trace.statements)).toEqual([]);
  });

  it('pools a Han name queried without its leading characters, which no token prefix reaches', async () => {
    await svc.ingestDesignations([LIMBACH]);
    const res = await svc.screenName(
      { ...screenDefaults, query: '林巴贺航空发动机股份有限公司', matchMode: 'fuzzy' },
      ctx,
    );
    expect(res.hits[0]).toMatchObject({
      designationId: 'eu:171379',
      matchedName: '厦门林巴贺航空发动机股份有限公司',
      matchType: 'approximate',
    });
    const handle = await svc.designations.raw();
    const tokenPrefixRows = handle
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM name_fts WHERE name_fts MATCH ?')
      .get('normalized : "林巴贺"*')?.n;
    expect(tokenPrefixRows).toBe(0);
  });

  it.each([
    ['a mid-token run of a Han name', '林巴贺航空发动机股份有限公司'],
    ['the phonetic keys of a name', 'k0rn ptrf'],
  ])('never widens a strict hit to %s', async (_, query) => {
    await svc.ingestDesignations([LIMBACH]);
    const res = await svc.screenName({ ...screenDefaults, query, autoFallback: false }, ctx);
    expect(res.hits).toEqual([]);
  });
});

describe('fuzzy candidate pool — whole blocks under one budget (issue #54)', () => {
  const PUTIN = listed('uk', 'PUTIN-1', 'Vladimir Vladimirovich PUTIN');
  /** `count` OFAC persons whose names open with `stem`. */
  const namesakes = (count: number, stem: string): NormalizedDesignation[] =>
    Array.from({ length: count }, (_, i) => listed('ofac_sdn', `NS-${i}`, `${stem} Zx${i}`));
  const screenPutin = (service: ScreeningService, filters: { entityType?: 'person' } = {}) =>
    service.screenName(
      { ...screenDefaults, ...filters, query: 'Vladimir Poutine', matchMode: 'fuzzy', limit: 100 },
      ctx,
    );

  it('pools a later-listed match that shares its prefix with more rows than one lookup used to keep', async () => {
    await svc.ingestDesignations([...namesakes(250, 'Vladimir'), PUTIN]);
    const res = await screenPutin(svc, { entityType: 'person' });
    const rank = res.hits.findIndex((h) => h.designationId === 'uk:PUTIN-1');
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(5);
  });

  it.each([{}, { entityType: 'person' as const }])(
    'returns identical hits whichever order the lists were ingested in, filters %j',
    async (filters) => {
      const corpus = [...namesakes(250, 'Vladimir'), PUTIN];
      const screens: Awaited<ReturnType<typeof screenPutin>>[] = [];
      for (const order of [corpus, [...corpus].reverse()]) {
        const fresh = await freshService();
        try {
          await fresh.service.ingestDesignations(order);
          screens.push(await screenPutin(fresh.service, filters));
        } finally {
          await fresh.cleanup();
        }
      }
      expect(screens[1]).toEqual(screens[0]);
      expect(screens[0]?.hits.some((h) => h.designationId === 'uk:PUTIN-1')).toBe(true);
    },
  );

  it('never pools more than the budget, at the 64-word bound', async () => {
    const words = Array.from(
      { length: 64 },
      (_, i) => `${'bdfgklmp'[i % 8]}a${'bdfgklmp'[Math.floor(i / 8)]}ondo`,
    );
    await svc.ingestDesignations(
      words.flatMap((word, w) =>
        Array.from({ length: 40 }, (_, j) => listed('un', `BUDGET-${w}-${j}`, `${word} Zx${j}`)),
      ),
    );
    const trace = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName({ ...screenDefaults, query: words.join(' '), matchMode: 'fuzzy' }, ctx),
    );
    expect(trace.pooled.size).toBeGreaterThan(0);
    expect(trace.pooled.size).toBeLessThanOrEqual(FUZZY_POOL_BUDGET);
  });

  it.each([{ sources: ['uk' as const] }, { entityType: 'vessel' as const }])(
    'measures blocks under the request filters, pooling a match only they make fit: %j',
    async (filters) => {
      // Unfiltered, every block of the query holds 2,101 rows — past the budget.
      await svc.ingestDesignations([
        ...Array.from({ length: 2100 }, (_, i) =>
          listed('ofac_sdn', `PET-${i}`, `Vladimir Petrenko${i}`),
        ),
        listed('uk', 'PET-UK', 'Vladimir Petrenkov', 'vessel'),
      ]);
      const res = await svc.screenName(
        { ...screenDefaults, ...filters, query: 'Vladimir Petrenkox', matchMode: 'fuzzy' },
        ctx,
      );
      expect(res.hits.map((h) => h.designationId)).toContain('uk:PET-UK');
    },
  );
});

describe('fuzzy candidate pool — one budget per list (issues #54, #59)', () => {
  /**
   * Every blocking key of `Shihab Mohammed` (`shi`, `moh`, and both words'
   * phonetic keys) reaches 1,200 OFAC names and 901 EU names, each pair of keys
   * the same names: each list fits the budget alone, the two together do not.
   * None holds `mohammed`, so strict finds them nowhere; `un:EXACT` is the one
   * strict hit, for the completion case.
   */
  const crowd = (source: SourceCode, count: number, stem: string): NormalizedDesignation[] =>
    Array.from({ length: count }, (_, i) =>
      listed(source, `CROWD-${i}`, `Shihab Mohammad ${stem}${i}`),
    );

  beforeEach(async () => {
    await svc.ingestDesignations([
      ...crowd('ofac_sdn', 1200, 'Zx'),
      ...crowd('eu', 900, 'Qx'),
      listed('eu', 'TARGET', 'Mohammad Shihab'),
      listed('un', 'EXACT', 'Shihab Mohammed'),
    ]);
  });

  const screen = (matchMode: 'fuzzy' | 'strict', sources: SourceCode[]) =>
    svc.screenName(
      { ...screenDefaults, query: 'Shihab Mohammed', matchMode, sources, limit: 5000 },
      ctx,
    );
  const hitsOn = (res: Awaited<ReturnType<typeof screen>>, source: SourceCode) =>
    res.hits.filter((hit) => hit.source === source).map((hit) => hit.designationId);

  it.each([
    ['fuzzy mode', 'fuzzy', [], 'fuzzy'],
    ['the fallback when strict finds nothing', 'strict', [], 'fuzzy'],
    ['the completion of the lists strict found nothing on', 'strict', ['un'], 'strict'],
  ] as const)(
    'gives each list the candidates it has when screened without the other: %s',
    async (_, matchMode, others, modeUsed) => {
      const joined = await screen(matchMode, ['ofac_sdn', 'eu', ...others]);
      for (const source of ['ofac_sdn', 'eu'] as const) {
        const alone = await screen(matchMode, [source, ...others]);
        expect(hitsOn(joined, source), source).toEqual(hitsOn(alone, source));
      }
      expect(hitsOn(joined, 'eu')).toContain('eu:TARGET');
      expect(hitsOn(joined, 'eu')).toHaveLength(901);
      expect(hitsOn(joined, 'ofac_sdn')).toHaveLength(1200);
      expect(joined).toMatchObject({
        modeUsed,
        fuzzySources: ['ofac_sdn', 'eu'],
        poolBounded: false,
      });
    },
  );

  it('never pools more than the budget from one list, at the 64-word bound', async () => {
    const words = Array.from(
      { length: 64 },
      (_, i) => `${'bdfgklmp'[i % 8]}a${'bdfgklmp'[Math.floor(i / 8)]}ondo`,
    );
    const lists = ['eu', 'un'] as const;
    await svc.ingestDesignations(
      lists.flatMap((source) =>
        words.flatMap((word, w) =>
          Array.from({ length: 40 }, (_, j) =>
            listed(source, `BUDGET-${w}-${j}`, `${word} Zx${j}`),
          ),
        ),
      ),
    );
    const trace = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName({ ...screenDefaults, query: words.join(' '), matchMode: 'fuzzy' }, ctx),
    );
    const pooled = [...trace.pooled.values()];
    for (const source of lists) {
      const fromList = pooled.filter((id) => id.startsWith(`${source}:`)).length;
      expect(fromList, source).toBeGreaterThan(0);
      expect(fromList, source).toBeLessThanOrEqual(FUZZY_POOL_BUDGET);
    }
    expect(pooled.length).toBeGreaterThan(FUZZY_POOL_BUDGET);
    expect(trace.result.poolBounded).toBe(true);
  });
});

describe('fuzzy phonetic arm — per-word keys (issue #68)', () => {
  it('pools a multi-word name whose only word in common with the query is a phonetic variant', async () => {
    await svc.ingestDesignations([listed('un', 'PH-1', 'MOHAMMED Zarqawi Faisal')]);
    const trace = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName({ ...screenDefaults, query: 'Muhammad Qorbx', matchMode: 'fuzzy' }, ctx),
    );
    expect(phoneticallyPooled(trace, 'un:PH-1')).toBe(true);
  });

  it('looks each query word’s key up through the name index', async () => {
    const handle = await svc.designations.raw();
    const trace = await traceNameIndex(handle, () =>
      svc.screenName(
        { ...screenDefaults, query: 'Muhammad Qorbx', matchMode: 'fuzzy', entityType: 'person' },
        ctx,
      ),
    );
    const phonetic = trace.statements.filter(({ params }) =>
      /\(phonetic :/.test(String(params[0])),
    );
    expect(phonetic.map(({ params }) => params[0])).toEqual([
      '(phonetic : "MHMT")',
      '(phonetic : "KRPKS")',
    ]);
    expect(tableScans(handle, phonetic)).toEqual([]);
  });
});

// ─── LEI fuzzy pool (issue #51) ────────────────────────────────────────────────

/**
 * A well-formed test LEI: the tag padded to 18 characters with `X`, then two
 * digits. A digit pad would make `CROWD1` and `CROWD10` one LEI.
 */
const testLei = (tag: string): string => `${tag.padEnd(18, 'X')}42`;

/** One ISSUED entity whose only name is its legal name. */
function registered(tag: string, legalName: string, jurisdiction = 'US'): NormalizedLeiEntity {
  return { lei: testLei(tag), legalName, otherNames: [], jurisdiction, status: 'ISSUED' };
}

/**
 * The LEIs `run` pooled for scoring — the list the fuzzy pass reads every name
 * of, read at the statement boundary — or none when it pooled none.
 */
async function pooledLeis(handle: SqliteHandle, run: () => Promise<unknown>): Promise<string[]> {
  const original = handle.prepare.bind(handle);
  let pooled: string[] = [];
  handle.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!/\bn\.lei IN \(SELECT value FROM json_each\(\?\)\)/.test(sql)) return statement;
    return {
      ...statement,
      all: (...params: Parameters<typeof statement.all>) => {
        pooled = JSON.parse(String(params[0])) as string[];
        return statement.all(...params);
      },
    };
  }) as typeof handle.prepare;
  try {
    await run();
  } finally {
    handle.prepare = original;
  }
  return pooled;
}

describe('LEI fuzzy candidate pool — whole blocks under one budget (issue #51)', () => {
  const TARGET = registered('KESTRELOSTWIND', 'Kestrel Bank Ostwind', 'DE');
  /**
   * `count` entities per word, each sharing only that word with the target —
   * so `kes` and `ost` each hold one name more than the budget, and only the
   * target holds both.
   */
  const crowd = (count: number): NormalizedLeiEntity[] => [
    ...Array.from({ length: count }, (_, i) => registered(`KESCROWD${i}`, `Kestrel Zx${i}`)),
    ...Array.from({ length: count }, (_, i) => registered(`OSTCROWD${i}`, `Zy${i} Ostwind`)),
  ];
  const resolveTypo = (service: ScreeningService, extra: { jurisdiction?: string } = {}) =>
    service.resolveEntity(
      { query: 'Kestrel Bnak Ostwind', matchMode: 'fuzzy', status: 'any', limit: 100, ...extra },
      ctx,
    );

  it('pools a target only a pair of its words reaches, each word shared with more names than the budget', async () => {
    await svc.ingestLeiEntities([...crowd(FUZZY_POOL_BUDGET), TARGET]);
    const res = await resolveTypo(svc);
    expect(res.matches.map((m) => m.lei)).toContain(TARGET.lei);
    expect(res.matches.find((m) => m.lei === TARGET.lei)).toMatchObject({
      score: 1,
      queryTokenCoverage: { covered: 3, total: 3 },
    });
  });

  it('returns identical matches whichever order the entities were written in', async () => {
    const corpus = [...crowd(FUZZY_POOL_BUDGET), TARGET];
    const results: Awaited<ReturnType<typeof resolveTypo>>[] = [];
    for (const order of [corpus, [...corpus].reverse()]) {
      const fresh = await freshService();
      try {
        await fresh.service.ingestLeiEntities(order);
        results.push(await resolveTypo(fresh.service));
      } finally {
        await fresh.cleanup();
      }
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.matches.map((m) => m.lei)).toContain(TARGET.lei);
  });

  it('measures a block inside the jurisdiction, pooling a match only it makes fit', async () => {
    // Unfiltered, `kes` holds 2,101 names; under DE it holds the target alone.
    await svc.ingestLeiEntities([
      ...Array.from({ length: 2100 }, (_, i) => registered(`KESONLY${i}`, `Kestrel Zx${i}`)),
      TARGET,
    ]);
    const res = await svc.resolveEntity(
      { query: 'Kestrel Bnak', jurisdiction: 'DE', matchMode: 'fuzzy', status: 'any', limit: 100 },
      ctx,
    );
    expect(res.matches.map((m) => m.lei)).toEqual([TARGET.lei]);
  });

  it('never pools more LEIs than the budget, at the 64-word bound', async () => {
    const words = Array.from(
      { length: 64 },
      (_, i) => `${'bdfgklmp'[i % 8]}a${'bdfgklmp'[Math.floor(i / 8)]}ondo`,
    );
    await svc.ingestLeiEntities(
      words.flatMap((word, w) =>
        Array.from({ length: 40 }, (_, j) => registered(`BUDGET${w}X${j}`, `${word} Zx${j}`)),
      ),
    );
    const pooled = await pooledLeis(await svc.leiEntities.raw(), () =>
      svc.resolveEntity(
        { query: words.join(' '), matchMode: 'fuzzy', status: 'any', limit: 100 },
        ctx,
      ),
    );
    expect(pooled.length).toBeGreaterThan(0);
    expect(pooled.length).toBeLessThanOrEqual(FUZZY_POOL_BUDGET);
    expect(new Set(pooled).size).toBe(pooled.length);
  });
});

// ─── Fuzzy stoplist (issue #55) ────────────────────────────────────────────────

/** One designation on `source` named `primaryName`, with its aliases. */
function withAliases(
  source: NormalizedDesignation['source'],
  entryId: string,
  primaryName: string,
  aliases: string[],
  entityType: NormalizedDesignation['entityType'] = 'organization',
): NormalizedDesignation {
  const designation = listed(source, entryId, primaryName, entityType);
  designation.payload.aliases = aliases.map((name) => ({ name, nameType: 'aka' as const }));
  return designation;
}

describe('fuzzy stoplist — legal forms, articles, and codes carry no admission (issue #55)', () => {
  const SOVCOMFLOT = [
    withAliases('eu', 'SCF-EU', 'JSC Sovcomflot', ['PAO Sovcomflot']),
    withAliases('ofac_sdn', 'SCF-OFAC', 'Joint Stock Company Sovcomflot', ['PAO Sovcomflot']),
    listed('uk', 'SCF-UK', 'Sovcomflot', 'organization'),
  ];
  /** Organizations that share only a legal form, an article, or a code with the probes. */
  const LOOKALIKES = [
    listed('ofac_sdn', 'LTD-1', 'Arctic Shipping Ltd', 'organization'),
    listed('ofac_sdn', 'LTD-2', 'Baltic Ltd', 'organization'),
    listed('ofac_sdn', 'LTD-3', 'Delta (UK) Ltd', 'organization'),
    listed('eu', 'OIL-1', 'Gulf Oil Company', 'organization'),
    listed('eu', 'OIL-2', 'Caspian Oil', 'organization'),
    listed('eu', 'CO-1', 'Northern Trading Company', 'organization'),
  ];
  const screen = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, query, limit: 100, ...extra }, ctx);
  const ids = (hits: { designationId: string }[]) => hits.map((h) => h.designationId);

  beforeEach(async () => {
    await svc.ingestDesignations([...SOVCOMFLOT, ...LOOKALIKES]);
  });

  it('admits every match of a name’s one distinctive word, however many legal forms and codes wrap it', async () => {
    const res = await screen('SOVCOMFLOT (UK) LTD');
    expect(res.modeUsed).toBe('fuzzy');
    expect(ids(res.hits).sort()).toEqual(['eu:SCF-EU', 'ofac_sdn:SCF-OFAC', 'uk:SCF-UK']);
  });

  it('admits no candidate that shares only a legal form with the query', async () => {
    const res = await screen('Sovcomflot Ltd', { matchMode: 'fuzzy', sources: ['ofac_sdn'] });
    expect(ids(res.hits)).toEqual(['ofac_sdn:SCF-OFAC']);
  });

  it('admits no candidate that covers only `oil` or `company` of `Rosneft Oil Company`', async () => {
    await svc.ingestDesignations([
      listed('eu', 'ROSNEFT', 'Rosneft Oil Company PJSC', 'organization'),
    ]);
    const res = await screen('Rosneft Oil Company', { matchMode: 'fuzzy' });
    expect(ids(res.hits)).toEqual(['eu:ROSNEFT']);
  });

  it('keeps counting every query token in the surfaced coverage', async () => {
    const res = await screen('SOVCOMFLOT (UK) LTD');
    const hit = res.hits.find((h) => h.designationId === 'eu:SCF-EU');
    expect(hit).toMatchObject({ matchType: 'approximate', score: 1 });
    expect(hit?.queryTokenCoverage).toEqual({ covered: 1, total: 3 });
    expect(res.normalizedQuery).toBe('sovcomflot uk ltd');
  });

  it.each([
    ['Pae Won Uk', ['Kim Chang Uk', 'Pae Song Il']],
    ['Augusto Mario Co', ['Mario Trading Co', 'Augusto Holdings Co']],
    ['Iyad Ag Ghali', ['Ag Saleh Trading', 'Iyad Al Rashid']],
  ])('keeps a listed name with a stoplisted syllable first: %s', async (name, decoys) => {
    await svc.ingestDesignations([
      listed('un', 'SYLLABLE', name),
      ...decoys.map((decoy, i) => listed('un', `DECOY-${i}`, decoy)),
    ]);
    for (const matchMode of ['strict', 'fuzzy'] as const) {
      const res = await screen(name, { matchMode });
      expect(res.hits[0]?.designationId, matchMode).toBe('un:SYLLABLE');
    }
  });

  it('gates a query made only of stoplist tokens as it always has', async () => {
    await svc.ingestDesignations([
      listed('eu', 'LLC-FULL', 'Alpha Limited Liability Company', 'organization'),
      listed('eu', 'LLC-PART', 'Beta Limited', 'organization'),
    ]);
    const res = await screen('Limited Liability Company', { matchMode: 'fuzzy' });
    expect(ids(res.hits)).toContain('eu:LLC-FULL');
    // One token of three: under half, as before the stoplist.
    expect(ids(res.hits)).not.toContain('eu:LLC-PART');
  });

  it('applies the same gate to LEI resolution', async () => {
    await svc.ingestLeiEntities([
      registered('SOVCOMFLOTPAO', 'Sovcomflot PAO'),
      registered('ARCTICSHIP', 'Arctic Shipping Ltd'),
      registered('BALTICLTD', 'Baltic Ltd'),
    ]);
    const res = await svc.resolveEntity(
      { query: 'Sovcomflot Ltd', matchMode: 'fuzzy', status: 'any', limit: 100 },
      ctx,
    );
    expect(res.matches.map((m) => m.lei)).toEqual([testLei('SOVCOMFLOTPAO')]);
    expect(res.matches[0]?.queryTokenCoverage).toEqual({ covered: 1, total: 2 });
  });
});

describe('fuzzy stoplist — blocking (issue #55)', () => {
  it('blocks the designation path on no stoplisted word', async () => {
    const handle = await svc.designations.raw();
    const prefixes = await indexPrefixes(handle, () =>
      svc.screenName(
        { ...screenDefaults, matchMode: 'fuzzy', query: 'Nikolas al Maduro X Moros' },
        ctx,
      ),
    );
    expect(prefixes).toEqual(['nik', 'mad', 'mor']);
  });

  it('keys no phonetic lookup on a stoplisted word', async () => {
    const trace = await traceNameIndex(await svc.designations.raw(), () =>
      svc.screenName({ ...screenDefaults, query: 'Sovcomflot Ltd', matchMode: 'fuzzy' }, ctx),
    );
    const phonetic = trace.lookups
      .map(({ expression }) => expression)
      .filter((expression) => /\(phonetic :/.test(expression));
    expect(phonetic).toEqual([`(phonetic : "${doubleMetaphone('sovcomflot')}")`]);
  });

  it('blocks a query made only of stoplist tokens on all of them', async () => {
    const handle = await svc.designations.raw();
    const prefixes = await indexPrefixes(handle, () =>
      svc.screenName(
        { ...screenDefaults, matchMode: 'fuzzy', query: 'Limited Liability Company' },
        ctx,
      ),
    );
    expect(prefixes).toEqual(['lim', 'lia', 'com']);
  });

  it('blocks the LEI path on no stoplisted word', async () => {
    const handle = await svc.leiEntities.raw();
    const prefixes = await indexPrefixes(handle, () =>
      svc.resolveEntity(
        { query: 'Fictionall Tradng Co X', matchMode: 'fuzzy', limit: 10, status: 'any' },
        ctx,
      ),
    );
    expect(prefixes).toEqual(['fic', 'tra']);
  });

  it('still narrows a block past the budget by a stoplisted word, through a pair', async () => {
    // `fle` holds 2,002 names; only the target also carries `gmbh`.
    await svc.ingestLeiEntities([
      ...Array.from({ length: FUZZY_POOL_BUDGET + 1 }, (_, i) =>
        registered(`FLEXCROWD${i}`, `Flexa Zx${i}`),
      ),
      registered('FLEXOPUSGMBH', 'Flexopus GmbH', 'DE'),
    ]);
    const handle = await svc.leiEntities.raw();
    let leis: string[] = [];
    const prefixes = await indexPrefixes(handle, async () => {
      const res = await svc.resolveEntity(
        { query: 'Fleoxpus GmbH', matchMode: 'fuzzy', status: 'any', limit: 100 },
        ctx,
      );
      leis = res.matches.map((m) => m.lei);
    });
    expect(leis).toEqual([testLei('FLEXOPUSGMBH')]);
    // One block lookup for `fle`, then the pair; `gmb` is never looked up alone.
    expect(prefixes).toEqual(['fle', 'fle', 'gmb']);
  });
});

describe('OFAC SDN + Consolidated grouping (issue #61)', () => {
  /**
   * One OFAC party as both OFAC files publish it: one entry ID on each list. The
   * two records carry their own designation dates, as each file dates the party
   * from its own lists.
   */
  const ofacPair = (
    entryId: string,
    name: string,
    copies: {
      consolidated?: Partial<NormalizedDesignation>;
      sdn?: Partial<NormalizedDesignation>;
    } = {},
  ): NormalizedDesignation[] => [
    { ...listed('ofac_sdn', entryId, name, 'organization'), ...copies.sdn },
    { ...listed('ofac_consolidated', entryId, name, 'organization'), ...copies.consolidated },
  ];
  const withIdentifier = (value: string): Partial<NormalizedDesignation> => ({
    payload: {
      aliases: [],
      identifiers: [{ type: 'Tax ID No.', value, country: 'Russia' }],
      addresses: [],
      datesOfBirth: [],
      nationalities: [],
    },
  });

  beforeEach(async () => {
    await svc.ingestDesignations([
      ...ofacPair('GRP-17', 'Grouped Petroleum Holding', {
        sdn: {
          designationDate: '2025-10-22',
          program: 'RUSSIA-EO14024',
          ...withIdentifier('7706999990'),
        },
        consolidated: {
          designationDate: '2014-07-16',
          program: 'RUSSIA-EO14024',
          ...withIdentifier('7706999990'),
        },
      }),
      ...ofacPair('GRP-18', 'Grouped Petroleum Trading'),
      listed('ofac_consolidated', 'GRP-19', 'Grouped Petroleum Services', 'organization'),
      // The same name on another regime's list is another hit, never grouped.
      listed('eu', 'GRP-17', 'Grouped Petroleum Holding', 'organization'),
    ]);
  });

  const screen = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, query, ...extra }, ctx);
  const ids = (hits: readonly { designationId: string }[]) => hits.map((hit) => hit.designationId);

  it('returns the Consolidated copy alone when only ofac_consolidated is selected (characterization)', async () => {
    const res = await screen('Grouped Petroleum Holding', { sources: ['ofac_consolidated'] });
    expect(ids(res.hits)).toEqual(['ofac_consolidated:GRP-17']);
    expect(res.hits[0]?.designationDate).toBe('2014-07-16');
  });

  it('names the one selected list in sources when only one OFAC list is selected', async () => {
    const res = await screen('Grouped Petroleum Holding', { sources: ['ofac_consolidated'] });
    expect(res.hits.map((hit) => [hit.source, hit.sources])).toEqual([
      ['ofac_consolidated', ['ofac_consolidated']],
    ]);
  });

  it('groups an entry both OFAC lists publish into one hit, counted once, naming both lists', async () => {
    const res = await screen('Grouped Petroleum');
    expect(res.hits.map((hit) => [hit.designationId, hit.sources])).toEqual([
      ['ofac_sdn:GRP-17', ['ofac_sdn', 'ofac_consolidated']],
      ['ofac_sdn:GRP-18', ['ofac_sdn', 'ofac_consolidated']],
      ['ofac_consolidated:GRP-19', ['ofac_consolidated']],
      ['eu:GRP-17', ['eu']],
    ]);
    expect(res.totalAvailable).toBe(4);
  });

  it('carries the SDN copy on a tie — its source, entry ID, program, and designation date', async () => {
    const [hit] = (await screen('Grouped Petroleum Holding')).hits;
    expect(hit).toMatchObject({
      source: 'ofac_sdn',
      sourceEntryId: 'GRP-17',
      matchType: 'exact',
      program: 'RUSSIA-EO14024',
      designationDate: '2025-10-22',
      sources: ['ofac_sdn', 'ofac_consolidated'],
    });
  });

  it('groups copies whose fields differ to the better-ranked copy, at its rank', async () => {
    await svc.ingestDesignations(
      ofacPair('GRP-20', 'Divergent Copy Holding', {
        sdn: { primaryName: 'Divergent Copy Holding Group', designationDate: '2022-02-24' },
        consolidated: { designationDate: '2014-09-12' },
      }),
    );
    // The SDN copy's only name holds every token (strong); the Consolidated copy's equals the query (exact).
    const res = await screen('Divergent Copy Holding');
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({
      designationId: 'ofac_consolidated:GRP-20',
      source: 'ofac_consolidated',
      matchType: 'exact',
      matchedName: 'Divergent Copy Holding',
      designationDate: '2014-09-12',
      sources: ['ofac_sdn', 'ofac_consolidated'],
    });
  });

  it('projects only the returned copy’s published details, preserving sparse fields', async () => {
    const sdn = listed('ofac_sdn', 'BIO-1', 'Chaldeo Vesper Archive', 'person');
    const consolidated = listed('ofac_consolidated', 'BIO-1', 'Chaldeo Vesper', 'person');
    const sparse = listed('eu', 'BIO-2', 'Chaldeo Vesper Holdings', 'person');
    await svc.ingestDesignations([
      {
        ...sdn,
        payload: { ...sdn.payload, datesOfBirth: [{ date: '1980-01-01' }], nationalities: ['IT'] },
      },
      {
        ...consolidated,
        payload: {
          ...consolidated.payload,
          datesOfBirth: [
            { date: '1955/1957', circa: true, place: 'A' },
            { date: '1960-02' },
            { place: 'B' },
          ],
          nationalities: ['MA', 'FR'],
          addresses: [
            { full: '1', country: 'FR' },
            { full: '2', country: 'FR' },
            { full: '3', country: 'MA' },
            { full: '4' },
          ],
        },
      },
      { ...sparse, payload: { ...sparse.payload, datesOfBirth: [{ place: 'C' }] } },
    ]);
    const options = { ...screenDefaults, query: 'Chaldeo Vesper', autoFallback: false, limit: 1 };
    const unhydrated = await svc.screenName(options, ctx);
    expect(unhydrated.hits[0]).not.toHaveProperty('birthDates');
    const first = await svc.screenName({ ...options, includeDetails: true }, ctx);
    expect(first.totalAvailable).toBe(2);
    expect(first.hits).toEqual([
      {
        ...unhydrated.hits[0],
        designationId: 'ofac_consolidated:BIO-1',
        sources: ['ofac_sdn', 'ofac_consolidated'],
        birthDates: [{ date: '1955/1957', circa: true }, { date: '1960-02' }],
        nationalities: ['MA', 'FR'],
        addressCountries: ['FR', 'MA'],
      },
    ]);
    const second = await svc.screenName({ ...options, includeDetails: true, offset: 1 }, ctx);
    expect(second.hits.map((hit) => hit.designationId)).toEqual(['eu:BIO-2']);
    expect(second.hits[0]).not.toHaveProperty('birthDates');
    expect(second.hits[0]).not.toHaveProperty('nationalities');
    expect(second.hits[0]).not.toHaveProperty('addressCountries');
    const afterEnd = await svc.screenName({ ...options, includeDetails: true, offset: 2 }, ctx);
    expect(afterEnd.hits).toEqual([]);
  });

  it('pages grouped hits disjointly, never splitting a pair across pages', async () => {
    const whole = await screen('Grouped Petroleum');
    const walked: string[] = [];
    for (let offset = 0; offset < whole.totalAvailable + 1; offset += 1) {
      const page = await screen('Grouped Petroleum', { limit: 1, offset });
      expect(page.totalAvailable).toBe(4);
      walked.push(...ids(page.hits));
    }
    expect(walked).toEqual(ids(whole.hits));
  });

  it('groups the copies a fuzzy pass admits', async () => {
    const res = await screen('Grouped Petrolium Holding', { matchMode: 'fuzzy' });
    const ofac = res.hits.filter((hit) => hit.sourceEntryId === 'GRP-17' && hit.source !== 'eu');
    expect(ofac.map((hit) => [hit.designationId, hit.sources])).toEqual([
      ['ofac_sdn:GRP-17', ['ofac_sdn', 'ofac_consolidated']],
    ]);
  });

  it('looks an identifier both copies publish up as one hit naming both lists', async () => {
    const lookUp = (sources: SourceCode[]) =>
      svc.screenIdentifier({ value: '7706999990', type: 'any', sources });
    expect((await lookUp([...SOURCE_CODES])).map((hit) => [hit.source, hit.sources])).toEqual([
      ['ofac_sdn', ['ofac_sdn', 'ofac_consolidated']],
    ]);
    expect((await lookUp(['ofac_consolidated'])).map((hit) => [hit.source, hit.sources])).toEqual([
      ['ofac_consolidated', ['ofac_consolidated']],
    ]);
  });

  it('names both OFAC lists on a hit whose screen reached one record of the party', async () => {
    await svc.ingestDesignations([
      // A strict hit on ofac_sdn, so the completion searches ofac_consolidated and not ofac_sdn.
      listed('ofac_sdn', 'GPN-AERO', 'Gazpromneft Aero Joint Stock Company', 'organization'),
      ...ofacPair('GPN-1', 'Public Joint Stock Company Gazprom Neft'),
    ]);
    const res = await screen('Gazpromneft Joint Stock Company');
    expect(res.hits.map((hit) => [hit.designationId, hit.matchType, hit.sources])).toEqual([
      ['ofac_sdn:GPN-AERO', 'strong', ['ofac_sdn']],
      ['ofac_consolidated:GPN-1', 'approximate', ['ofac_sdn', 'ofac_consolidated']],
    ]);
    const unselected = await screen('Gazpromneft Joint Stock Company', {
      sources: ['ofac_consolidated', 'eu'],
    });
    expect(unselected.hits.map((hit) => [hit.designationId, hit.sources])).toEqual([
      ['ofac_consolidated:GPN-1', ['ofac_consolidated']],
    ]);
  });

  it('names both OFAC lists on an identifier one record of the party publishes', async () => {
    await svc.ingestDesignations(
      ofacPair('GRP-21', 'Diverging Identifier Holding', { sdn: withIdentifier('7706999991') }),
    );
    const lookUp = (sources: SourceCode[]) =>
      svc.screenIdentifier({ value: '7706999991', type: 'any', sources });
    expect((await lookUp([...SOURCE_CODES])).map((hit) => [hit.source, hit.sources])).toEqual([
      ['ofac_sdn', ['ofac_sdn', 'ofac_consolidated']],
    ]);
    expect((await lookUp(['ofac_sdn', 'eu'])).map((hit) => [hit.source, hit.sources])).toEqual([
      ['ofac_sdn', ['ofac_sdn']],
    ]);
  });
});

describe('per-list strict→fuzzy completion (issue #59)', () => {
  beforeEach(async () => {
    await svc.ingestDesignations([
      // Strict for "Vladimir Poutine": every query token present.
      listed('eu', 'POU-1', 'Vladimir Vladimirovich POUTINE'),
      // A spelling variant on two other lists: both query tokens covered (poutine ~ putin).
      listed('ofac_sdn', 'PUT-1', 'Putin Vladimir Vladimirovich'),
      listed('uk', 'PUT-UK', 'Vladimir Vladimirovich PUTIN'),
      // Shares one query token only: a full fuzzy pass admits it, a completion never does.
      listed('ofac_sdn', 'ZHI-1', 'Vladimir Zhirinovsky'),
    ]);
  });

  const screen = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, query, ...extra }, ctx);
  const ids = (hits: readonly { designationId: string }[]) => hits.map((hit) => hit.designationId);
  const fuzzyLookups = async (run: () => Promise<unknown>) =>
    indexPrefixes(await svc.designations.raw(), run);

  it('runs no fuzzy pass when every selected list has a strict hit (characterization)', async () => {
    let res: Awaited<ReturnType<typeof screen>> | undefined;
    const prefixes = await fuzzyLookups(async () => {
      res = await screen('Vladimir Vladimirovich', { sources: ['eu', 'uk'] });
    });
    expect(prefixes).toEqual([]);
    expect(res).toMatchObject({ modeUsed: 'strict', totalAvailableBasis: 'exact' });
    expect(ids(res?.hits ?? [])).toEqual(['eu:POU-1', 'uk:PUT-UK']);
    expect(res?.fuzzySources).toBeUndefined();
  });

  it('runs no completion for a screen with autoFallback off (characterization)', async () => {
    const res = await screen('Vladimir Poutine', { autoFallback: false });
    expect(ids(res.hits)).toEqual(['eu:POU-1']);
    expect(res).toMatchObject({ modeUsed: 'strict', totalAvailableBasis: 'exact' });
    expect(res.fuzzySources).toBeUndefined();
  });

  it('completes the strict-empty lists with candidates covering every query token, after the strict hits', async () => {
    const res = await screen('Vladimir Poutine');
    expect(ids(res.hits)).toEqual(['eu:POU-1', 'ofac_sdn:PUT-1', 'uk:PUT-UK']);
    expect(res.hits.map((hit) => hit.matchType)).toEqual(['strong', 'approximate', 'approximate']);
    for (const hit of res.hits.slice(1)) {
      expect(hit.queryTokenCoverage).toEqual({ covered: 2, total: 2 });
    }
    expect(res).toMatchObject({
      modeUsed: 'strict',
      fuzzySources: [
        'ofac_sdn',
        'ofac_consolidated',
        'uk',
        'un',
        'bis_el',
        'bis_dpl',
        'bis_uvl',
        'bis_meu',
        'state_dtc',
        'state_acn',
      ],
      totalAvailable: 3,
      totalAvailableBasis: 'lower_bound',
      fuzzyFallbackTriggered: false,
    });
  });

  it('never removes a full-coverage candidate when another list joins the selection', async () => {
    const alone = await screen('Vladimir Poutine', { sources: ['ofac_sdn'] });
    expect(ids(alone.hits)).toContain('ofac_sdn:PUT-1');
    const joined = await screen('Vladimir Poutine', { sources: ['ofac_sdn', 'eu'] });
    expect(ids(joined.hits)).toEqual(['eu:POU-1', 'ofac_sdn:PUT-1']);
    expect(joined.fuzzySources).toEqual(['ofac_sdn']);
  });

  it('requires every distinctive query word of a completion candidate, never a stoplisted one', async () => {
    await svc.ingestDesignations([
      listed('eu', 'STP-1', 'Zelvan Rostok Marinsk LLC', 'organization'),
      // Covers every word but the stoplisted LLC.
      listed('ofac_sdn', 'STP-2', 'Zelvann Rostock Marinska', 'organization'),
      // Covers two of three distinctive words: the fuzzy gate's half, not the completion's whole.
      listed('ofac_sdn', 'STP-3', 'Zelvann Rostock Shipping', 'organization'),
    ]);
    const completed = await screen('Zelvan Rostok Marinsk LLC');
    expect(ids(completed.hits)).toEqual(['eu:STP-1', 'ofac_sdn:STP-2']);
    const fuzzy = await screen('Zelvan Rostok Marinsk LLC', { matchMode: 'fuzzy' });
    expect(ids(fuzzy.hits)).toContain('ofac_sdn:STP-3');
  });

  it('requires every token of a query made only of stoplisted words', async () => {
    await svc.ingestDesignations([
      listed('eu', 'LLC-1', 'Limited Liability Company', 'organization'),
      listed('ofac_sdn', 'LLC-2', 'Limitid Liability Compani', 'organization'),
      listed('ofac_sdn', 'LLC-3', 'Limited Liability Partnership', 'organization'),
    ]);
    const completed = await screen('Limited Liability Company');
    // The seeded `Fictional Trading Company LLC` holds the same form spelled LLC (issue #90).
    expect(ids(completed.hits)).toEqual([
      'eu:LLC-1',
      'ofac_consolidated:FX-2002',
      'ofac_sdn:LLC-2',
    ]);
    const fuzzy = await screen('Limited Liability Company', { matchMode: 'fuzzy' });
    expect(ids(fuzzy.hits)).toContain('ofac_sdn:LLC-3');
  });

  it('falls back to a full fuzzy pass over every selected list when no list hits strict', async () => {
    const res = await screen('Vladimir Poutin');
    expect(ids(res.hits)).toEqual(
      expect.arrayContaining(['eu:POU-1', 'ofac_sdn:PUT-1', 'uk:PUT-UK', 'ofac_sdn:ZHI-1']),
    );
    expect(res).toMatchObject({
      modeUsed: 'fuzzy',
      fuzzyFallbackTriggered: true,
      fuzzySources: [...SOURCE_CODES],
      totalAvailableBasis: 'lower_bound',
    });
  });

  it('names every selected list as fuzzy-searched in explicit fuzzy mode', async () => {
    const res = await screen('Vladimir Poutine', { matchMode: 'fuzzy', sources: ['uk', 'eu'] });
    expect(res).toMatchObject({ modeUsed: 'fuzzy', fuzzySources: ['eu', 'uk'] });
    expect(ids(res.hits)).toEqual(['eu:POU-1', 'uk:PUT-UK']);
  });

  it('counts a grouped OFAC hit as a strict hit on both OFAC lists', async () => {
    await svc.ingestDesignations([
      listed('ofac_sdn', 'GRP-59', 'Vladimir Poutine Holding', 'organization'),
      listed('ofac_consolidated', 'GRP-59', 'Vladimir Poutine Holding', 'organization'),
    ]);
    const res = await screen('Vladimir Poutine');
    expect(res.fuzzySources).toEqual([
      'uk',
      'un',
      'bis_el',
      'bis_dpl',
      'bis_uvl',
      'bis_meu',
      'state_dtc',
      'state_acn',
    ]);
    expect(ids(res.hits)).toEqual(['ofac_sdn:GRP-59', 'eu:POU-1', 'uk:PUT-UK']);
  });
});

describe('per-list completion of a name in another script (issue #87)', () => {
  /** One designation on `source` named `name`, also published under each of `aliases`. */
  const aliased = (
    source: NormalizedDesignation['source'],
    entryId: string,
    name: string,
    aliases: string[],
    entityType: NormalizedDesignation['entityType'] = 'person',
  ): NormalizedDesignation => {
    const designation = listed(source, entryId, name, entityType);
    return {
      ...designation,
      payload: {
        ...designation.payload,
        aliases: aliases.map((alias) => ({ name: alias, nameType: 'aka' as const })),
      },
    };
  };
  const BORTNIKOV = 'Александр Васильевич БОРТНИКОВ';

  beforeEach(async () => {
    await svc.ingestDesignations([
      // The UK names one person once per regime and gives only some of those
      // records a native-script name: RUS0084 publishes the Cyrillic, CHW0014 does not.
      aliased('uk', 'RUS0084', 'Aleksandr Vasilyevich BORTNIKOV', [BORTNIKOV]),
      listed('uk', 'CHW0014', 'Aleksandr Vasilyevich BORTNIKOV'),
      // Covers one of the three words: never a completion candidate.
      listed('uk', 'SMI-1', 'Aleksandr Petrovich SMIRNOV'),
    ]);
  });

  const screen = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, limit: 100, query, ...extra }, ctx);
  const ids = (hits: readonly { designationId: string }[]) => hits.map((hit) => hit.designationId);
  /** Each hit as `id matchType`, with its coverage when it carries one. */
  const rows = (
    hits: readonly {
      designationId: string;
      matchType: string;
      queryTokenCoverage?: { covered: number; total: number };
    }[],
  ) =>
    hits.map(({ designationId, matchType, queryTokenCoverage: cov }) =>
      [designationId, matchType, cov && `${cov.covered}/${cov.total}`].filter(Boolean).join(' '),
    );

  it('completes the list a native-script strict hit reached with its Latin-only records, after the strict hits', async () => {
    const res = await screen(BORTNIKOV);
    expect(rows(res.hits)).toEqual(['uk:RUS0084 exact', 'uk:CHW0014 approximate 3/3']);
    expect(res).toMatchObject({
      modeUsed: 'strict',
      fuzzyFallbackTriggered: false,
      fuzzySources: [...SOURCE_CODES],
      totalAvailable: 2,
      totalAvailableBasis: 'lower_bound',
    });
  });

  it('returns the strictly matched designation once, as its strict hit, though the completion scored it', async () => {
    const { pooled, result } = await traceNameIndex(await svc.designations.raw(), () =>
      screen(BORTNIKOV, { sources: ['uk'] }),
    );
    expect([...pooled.values()]).toContain('uk:RUS0084');
    expect(result.hits.filter((hit) => hit.designationId === 'uk:RUS0084')).toEqual([
      expect.objectContaining({ matchType: 'exact', matchedName: BORTNIKOV }),
    ]);
    expect(result.hits[0]).not.toHaveProperty('score');
    // Strict hit the one selected list, and the completion still searched it.
    expect(result).toMatchObject({
      modeUsed: 'strict',
      fuzzyFallbackTriggered: false,
      fuzzySources: ['uk'],
      poolBounded: false,
      totalAvailable: 2,
      totalAvailableBasis: 'lower_bound',
    });
  });

  it('keeps a Latin-script strict hit settling its list (characterization)', async () => {
    await svc.ingestDesignations([
      listed('uk', 'LAT-1', 'Aleksandr BORTNIKOV'),
      listed('uk', 'LAT-2', 'Alexandr BORTNIKOFF'),
      listed('eu', 'LAT-3', 'Alexandr BORTNIKOFF'),
    ]);
    const res = await screen('Aleksandr Bortnikov');
    expect(res.fuzzySources).not.toContain('uk');
    expect(res.fuzzySources).toContain('eu');
    expect(rows(res.hits)).toEqual([
      'uk:LAT-1 exact',
      'uk:CHW0014 strong',
      'uk:RUS0084 strong',
      'eu:LAT-3 approximate 2/2',
    ]);
    // The UK spelling variant is a candidate the strict hit leaves unsearched.
    const fuzzy = await screen('Aleksandr Bortnikov', { matchMode: 'fuzzy' });
    expect(ids(fuzzy.hits)).toContain('uk:LAT-2');
  });

  it('completes the UK list for a name mixing scripts', async () => {
    await svc.ingestDesignations([
      aliased('uk', 'ALM-1', 'Almaz Joint Venture', ['АО Almaz'], 'organization'),
      listed('uk', 'ALM-2', 'ALMAZ Trading', 'organization'),
    ]);
    const res = await screen('АО Almaz');
    expect(rows(res.hits)).toEqual(['uk:ALM-1 exact', 'uk:ALM-2 approximate 1/2']);
    expect(res.fuzzySources).toEqual([...SOURCE_CODES]);
  });

  it('completes the UN list the same way, and reads every other list its native-script strict hit settled for whole romanized words alone', async () => {
    await svc.ingestDesignations([
      aliased('un', 'UN-1', 'Aleksandr Vasilyevich BORTNIKOV', [BORTNIKOV]),
      listed('un', 'UN-2', 'Aleksandr Vasilyevich BORTNIKOV'),
      aliased('eu', 'EU-1', 'Aleksandr Vasilyevich BORTNIKOV', [BORTNIKOV]),
      listed('eu', 'EU-2', 'Aleksandr Vasilyevich BORTNIKOV'),
    ]);
    const res = await screen(BORTNIKOV);
    // The EU is searched too, by the romanized read (issue #99).
    expect(res.fuzzySources).toEqual([...SOURCE_CODES]);
    expect(rows(res.hits).sort()).toEqual([
      'eu:EU-1 exact',
      'uk:CHW0014 approximate 3/3',
      'uk:RUS0084 exact',
      'un:UN-1 exact',
      'un:UN-2 approximate 3/3',
    ]);
    // The EU's Latin-only record spells `Vasilyevich`, the romanization `vasilevich`:
    // the romanized read needs the romanization's own words, so only fuzzy mode reaches it.
    const fuzzy = await screen(BORTNIKOV, { matchMode: 'fuzzy' });
    expect(ids(fuzzy.hits)).toContain('eu:EU-2');
  });

  it('runs no fuzzy pass for a native-script name with autoFallback off (characterization)', async () => {
    let res: Awaited<ReturnType<typeof screen>> | undefined;
    const prefixes = await indexPrefixes(await svc.designations.raw(), async () => {
      res = await screen(BORTNIKOV, { autoFallback: false });
    });
    expect(prefixes).toEqual([]);
    expect(ids(res?.hits ?? [])).toEqual(['uk:RUS0084']);
    expect(res).toMatchObject({ modeUsed: 'strict', totalAvailableBasis: 'exact' });
    expect(res?.fuzzySources).toBeUndefined();
  });
});

describe('the romanized read of the lists a native-script strict hit settled (issue #99)', () => {
  /** One organization on `source` named `name`, also published under each of `aliases`. */
  const organization = (
    id: string,
    name: string,
    aliases: string[] = [],
    entityType: NormalizedDesignation['entityType'] = 'organization',
  ): NormalizedDesignation => {
    const [source, entryId] = id.split(':') as [SourceCode, string];
    const designation = listed(source, entryId, name, entityType);
    return {
      ...designation,
      payload: {
        ...designation.payload,
        aliases: aliases.map((alias) => ({ name: alias, nameType: 'aka' as const })),
      },
    };
  };
  const UNMANNED = 'Беспилотные системы';
  /** The read's FTS expression for `UNMANNED`: both romanized words, whole, on one column. */
  const UNMANNED_READ = 'comparison_normalized : ("bespilotnye" AND "sistemy")';

  beforeEach(async () => {
    await svc.ingestDesignations([
      // Strict reaches the Cyrillic alias; the Latin one spells `obyedineniye`, not the romanization's `obedinenie`.
      organization(
        'ofac_sdn:35337',
        'IZHEVSK UNMANNED SYSTEMS RESEARCH AND PRODUCTION ASSOCIATED LIMITED LIABILITY COMPANY',
        ['ООО НАУЧНО-ПРОИЗВОДСТВЕННОЕ ОБЪЕДИНЕНИЕ ИЖЕВСКИЕ БЕСПИЛОТНЫЕ СИСТЕМЫ'],
      ),
      // Published only in transliteration: the record the read exists for.
      organization('ofac_sdn:49352', 'LIMITED LIABILITY COMPANY UNMANNED SYSTEMS', [
        'Bespilotnye Sistemy',
      ]),
      // `sistemyy` opens with `sistemy` but is another word; `Sistemy Trading` lacks a word.
      organization('ofac_sdn:PRE-1', 'Bespilotnye Sistemyy Group'),
      organization('ofac_sdn:ONE-1', 'Sistemy Trading'),
      organization('eu:175107', 'Limited Liability Company Unmanned Systems', [
        'ООО “Беспилотные Системы”',
      ]),
    ]);
  });

  const screen = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, limit: 100, query, ...extra }, ctx);
  const ids = (hits: readonly { designationId: string }[]) => hits.map((hit) => hit.designationId);
  /** Each hit as `id matchType`, with its coverage when it carries one. */
  const rows = (
    hits: readonly {
      designationId: string;
      matchType: string;
      queryTokenCoverage?: { covered: number; total: number };
    }[],
  ) =>
    hits.map(({ designationId, matchType, queryTokenCoverage: cov }) =>
      [designationId, matchType, cov && `${cov.covered}/${cov.total}`].filter(Boolean).join(' '),
    );
  /** The romanized reads `run` issued, as the FTS expressions they bound. */
  const romanizedReads = async <T>(run: () => Promise<T>) => {
    const trace = await traceNameIndex(await svc.designations.raw(), run);
    return {
      result: trace.result,
      reads: trace.lookups
        .map(({ expression }) => expression)
        .filter((expression) => expression.startsWith('comparison_normalized : (')),
    };
  };

  it('returns a settled list’s transliterated-only record as approximate, after the strict hits', async () => {
    const res = await screen(UNMANNED);
    expect(rows(res.hits)).toEqual([
      'ofac_sdn:35337 strong',
      'eu:175107 strong',
      'ofac_sdn:49352 approximate 2/2',
    ]);
    expect(res.hits[2]).toMatchObject({
      matchedName: 'Bespilotnye Sistemy',
      matchedNameType: 'aka',
      score: 1,
    });
    // ofac_sdn and eu by the read, every other list by the fuzzy completion.
    expect(res).toMatchObject({
      modeUsed: 'strict',
      fuzzyFallbackTriggered: false,
      fuzzySources: [...SOURCE_CODES],
      totalAvailable: 3,
      totalAvailableBasis: 'lower_bound',
    });
  });

  it('reads each settled list once, for every romanized word as a whole word', async () => {
    const { reads, result } = await romanizedReads(() =>
      screen(UNMANNED, { sources: ['ofac_sdn'] }),
    );
    expect(reads).toEqual([UNMANNED_READ]);
    expect(ids(result.hits)).toEqual(['ofac_sdn:35337', 'ofac_sdn:49352']);
    // The read alone ran: no candidate budget, so the count stays the whole set.
    expect(result).toMatchObject({
      modeUsed: 'strict',
      fuzzyFallbackTriggered: false,
      fuzzySources: ['ofac_sdn'],
      poolBounded: false,
      totalAvailable: 2,
      totalAvailableBasis: 'exact',
    });
  });

  it('keeps the type filter on the romanized read, unknown types included', async () => {
    await svc.ingestDesignations([
      organization('ofac_sdn:UNK-0', 'Беспилотные системы', [], 'unknown'),
      organization('ofac_sdn:UNK-1', 'Bespilotnye Sistemy Bureau', [], 'unknown'),
    ]);
    const res = await screen(UNMANNED, { sources: ['ofac_sdn'], entityType: 'person' });
    expect(rows(res.hits)).toEqual(['ofac_sdn:UNK-0 exact', 'ofac_sdn:UNK-1 approximate 2/2']);
  });

  it('returns a designation strict reached once, as its strict hit, OFAC copies included', async () => {
    await svc.ingestDesignations([
      // The Consolidated copy of 35337 publishes only the transliteration.
      organization(
        'ofac_consolidated:35337',
        'IZHEVSK UNMANNED SYSTEMS RESEARCH AND PRODUCTION ASSOCIATED LIMITED LIABILITY COMPANY',
        ['OOO NAUCHNO-PROIZVODSTVENNOYE OBYEDINENIYE IZHEVSKIYE BESPILOTNYE SISTEMY'],
      ),
      organization('ofac_consolidated:CON-1', 'Беспилотные системы'),
    ]);
    const { reads, result } = await romanizedReads(() =>
      screen(UNMANNED, { sources: ['ofac_sdn', 'ofac_consolidated'] }),
    );
    expect(reads).toEqual([UNMANNED_READ]);
    expect(rows(result.hits)).toEqual([
      'ofac_consolidated:CON-1 exact',
      'ofac_sdn:35337 strong',
      'ofac_sdn:49352 approximate 2/2',
    ]);
    expect(result.hits[1]?.sources).toEqual(['ofac_sdn', 'ofac_consolidated']);
    expect(result).toMatchObject({ totalAvailable: 3, totalAvailableBasis: 'exact' });
  });

  it('pages the romanized hits with the strict ones, limit 1, to past the end', async () => {
    const walks: [SourceCode[], string[], 'exact' | 'lower_bound'][] = [
      [['ofac_sdn'], ['ofac_sdn:35337', 'ofac_sdn:49352'], 'exact'],
      [[...SOURCE_CODES], ['ofac_sdn:35337', 'eu:175107', 'ofac_sdn:49352'], 'lower_bound'],
    ];
    for (const [sources, expected, basis] of walks) {
      const paged: string[] = [];
      for (let offset = 0; offset <= expected.length; offset++) {
        const page = await screen(UNMANNED, { sources, limit: 1, offset });
        expect(page).toMatchObject({ totalAvailable: expected.length, totalAvailableBasis: basis });
        expect(page.hits).toHaveLength(offset < expected.length ? 1 : 0);
        paged.push(...ids(page.hits));
      }
      expect(paged).toEqual(expected);
    }
  });

  it('ranks the read’s hits with the completion’s as one set, by score then identity, and pages across both', async () => {
    await svc.ingestDesignations([
      // Two read hits written against identity order: 10 before 9.
      organization('ofac_sdn:10', 'Bespilotnye Sistemy Holding'),
      organization('ofac_sdn:9', 'Bespilotnye Sistemy Plant'),
      // A UK spelling the completion admits below 1: `bespilotnyye` 0.9833, `sistemi` 0.9429.
      organization('uk:SPL-1', 'Bespilotnyye Sistemi'),
    ]);
    const res = await screen(UNMANNED);
    expect(rows(res.hits)).toEqual([
      'ofac_sdn:35337 strong',
      'eu:175107 strong',
      'ofac_sdn:9 approximate 2/2',
      'ofac_sdn:10 approximate 2/2',
      'ofac_sdn:49352 approximate 2/2',
      'uk:SPL-1 approximate 2/2',
    ]);
    expect(res.hits.map((hit) => hit.score)).toEqual([undefined, undefined, 1, 1, 1, 0.9833]);
    // A page holding the last read hit and the completion's hit.
    const page = await screen(UNMANNED, { limit: 2, offset: 4 });
    expect(ids(page.hits)).toEqual(['ofac_sdn:49352', 'uk:SPL-1']);
    expect(page).toMatchObject({ totalAvailable: 6, totalAvailableBasis: 'lower_bound' });
  });

  it('never reads the UK or UN lists, which the completion searches instead', async () => {
    await svc.ingestDesignations([
      organization('eu:MER-0', 'Мэр Мер'),
      // Hold the one romanized word `mer` whole, but a single word for the query's two.
      organization('uk:MER-2', 'Mer Trading'),
      organization('un:MER-3', 'Mer Trading'),
    ]);
    const { reads, result } = await romanizedReads(() => screen('Мэр Мер'));
    expect(reads).toEqual(['comparison_normalized : ("mer")']);
    expect(ids(result.hits)).toEqual(['eu:MER-0']);
    expect(result.fuzzySources).toEqual([...SOURCE_CODES]);
  });

  it('keeps a name holding a word for each native word the romanization spells: Мэр Мер reads Mer Mer, never Mer Trading', async () => {
    await svc.ingestDesignations([
      organization('eu:MER-0', 'Мэр Мер'),
      // `мэр` and `мер` both romanize to `mer`: two native words, a `mer` for each.
      organization('eu:MER-1', 'Mer Mer'),
      // Holds the one romanized word `mer` whole, but a single word for the query's two.
      organization('eu:MER-2', 'Mer Trading'),
    ]);
    const { reads, result } = await romanizedReads(() => screen('Мэр Мер', { sources: ['eu'] }));
    expect(ids(result.hits)).not.toContain('eu:MER-2');
    expect(rows(result.hits)).toEqual(['eu:MER-0 exact', 'eu:MER-1 approximate 2/2']);
    expect(reads).toEqual(['comparison_normalized : ("mer")']);
  });

  it('holds each comparison form of a name to every native word on its own, never the forms joined', async () => {
    await svc.ingestDesignations([
      organization('eu:EL-0', 'Эль Ель Банк'),
      organization('eu:EL-1', 'El El Bank'),
      // Its fold `el банк` and romanization `el bank` hold `el` twice between them, each once.
      organization('eu:EL-2', 'El Банк'),
    ]);
    const { reads, result } = await romanizedReads(() =>
      screen('Эль Ель Банк', { sources: ['eu'] }),
    );
    expect(rows(result.hits)).toEqual(['eu:EL-0 exact', 'eu:EL-1 approximate 3/3']);
    expect(reads).toEqual(['comparison_normalized : ("el" AND "bank")']);
  });

  it('reads nothing for a Latin-script name (characterization)', async () => {
    const { reads, result } = await romanizedReads(() =>
      screen('Bespilotnye Sistemy', { sources: ['ofac_sdn'] }),
    );
    expect(reads).toEqual([]);
    expect(rows(result.hits)).toEqual(['ofac_sdn:49352 exact']);
    expect(result.fuzzySources).toBeUndefined();
    expect(result.totalAvailableBasis).toBe('exact');
  });

  it('reads nothing for a native-script name without a romanization, or one that romanizes to nothing (characterization)', async () => {
    await svc.ingestDesignations([
      organization('eu:GRK-1', 'Αφγανική Επιτροπή Στήριξης'),
      organization('eu:GRK-2', 'Afganiki Epitropi Stiriksis'),
      // `ъ` romanizes to nothing, so the query has no romanized word to read.
      organization('eu:HRD-1', 'Ъ'),
    ]);
    for (const [query, strictHit] of [
      ['Αφγανική Επιτροπή Στήριξης', 'eu:GRK-1'],
      ['Ъ', 'eu:HRD-1'],
    ] as const) {
      const { reads, result } = await romanizedReads(() => screen(query, { sources: ['eu'] }));
      expect(reads, query).toEqual([]);
      expect(ids(result.hits), query).toEqual([strictHit]);
      expect(result.fuzzySources, query).toBeUndefined();
    }
  });

  it('reads nothing with autoFallback off or in fuzzy mode (characterization)', async () => {
    const off = await romanizedReads(() => screen(UNMANNED, { autoFallback: false }));
    expect(off.reads).toEqual([]);
    expect(ids(off.result.hits)).toEqual(['ofac_sdn:35337', 'eu:175107']);
    expect(off.result.fuzzySources).toBeUndefined();
    expect(off.result.totalAvailableBasis).toBe('exact');
    // Fuzzy mode's pass compares romanizations on every list already (issue #57).
    const fuzzy = await romanizedReads(() =>
      screen(UNMANNED, { matchMode: 'fuzzy', sources: ['ofac_sdn'] }),
    );
    expect(fuzzy.reads).toEqual([]);
    expect(fuzzy.result.modeUsed).toBe('fuzzy');
    expect(ids(fuzzy.result.hits)).toContain('ofac_sdn:49352');
  });
});

describe('words that sound alike (issue #92)', () => {
  const screen = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, limit: 100, query, ...extra }, ctx);
  const ids = (hits: readonly { designationId: string }[]) => hits.map((hit) => hit.designationId);
  /** Each hit as `id matchType`, with its coverage and sound count when it carries them. */
  const rows = (
    hits: readonly {
      designationId: string;
      matchType: string;
      queryTokenCoverage?: { covered: number; phonetic?: number; total: number };
    }[],
  ) =>
    hits.map(({ designationId, matchType, queryTokenCoverage: cov }) =>
      [designationId, matchType, cov && `${cov.covered}/${cov.total}`, cov?.phonetic]
        .filter((part) => part !== undefined)
        .join(' '),
    );

  describe('completing a strict hit on the other lists', () => {
    beforeEach(async () => {
      await svc.ingestDesignations([
        // The strict hit, and the same person under the other lists' spelling.
        listed('ofac_sdn', '12627', 'Hannibal Muammar GADDAFI'),
        listed('eu', '6093', 'Hannibal Muammar QADHAFI'),
        listed('uk', 'LIB0051', 'HANNIBAL MUAMMAR QADHAFI'),
        listed('un', '690771', 'Hannibal Muammar Qadhafi'),
        listed('ofac_sdn', '12608', 'Saif al-Islam GADDAFI'),
        listed('eu', '6097', 'Saif al-Islam QADHAFI'),
        listed('uk', 'LIB0064', 'SAIF AL-ISLAM QADHAFI'),
        listed('un', '690778', 'SAIF AL-ISLAM QADHAFI'),
        // Shares both keys (HNPL, KTF) and no spelling: 0.7214 and 0.
        listed('bis_el', 'SND-1', 'Honebul Kotov'),
      ]);
    });

    it.each([
      [
        'Hannibal Gaddafi',
        [
          'ofac_sdn:12627 strong',
          'eu:6093 approximate 2/2 1',
          'uk:LIB0051 approximate 2/2 1',
          'un:690771 approximate 2/2 1',
        ],
      ],
      [
        'Saif al-Islam Gaddafi',
        [
          'ofac_sdn:12608 exact',
          'eu:6097 approximate 4/4 1',
          'uk:LIB0064 approximate 4/4 1',
          'un:690778 approximate 4/4 1',
        ],
      ],
    ])(
      'completes %j with a sound-alike surname on each list strict missed',
      async (query, expected) => {
        const res = await screen(query);
        expect(rows(res.hits)).toEqual(expected);
        expect(res).toMatchObject({ modeUsed: 'strict', fuzzyFallbackTriggered: false });
      },
    );

    it('scores a sound-completed hit on spelling alone', async () => {
      const res = await screen('Hannibal Gaddafi', { sources: ['un'] });
      // `hannibal` is exact; `gaddafi` ~ `qadhafi` (0.8095) never reaches the score.
      expect(res.hits).toMatchObject([
        { designationId: 'un:690771', score: 1, queryTokenCoverage: { covered: 2, phonetic: 1 } },
      ]);
    });

    it('omits phonetic from an approximate hit that matched no word by sound', async () => {
      const res = await screen('Hannibal Gaddafi', { matchMode: 'fuzzy' });
      const spelled = res.hits.find((hit) => hit.designationId === 'ofac_sdn:12608');
      expect(spelled?.queryTokenCoverage).toStrictEqual({ covered: 1, total: 2 });
    });

    it('never returns a candidate whose only link to the query is a shared key', async () => {
      for (const extra of [{}, { matchMode: 'fuzzy' as const }, { sources: ['bis_el' as const] }]) {
        const { result: res, ...trace } = await traceNameIndex(await svc.designations.raw(), () =>
          screen('Hannibal Gaddafi', extra),
        );
        expect(phoneticallyPooled(trace, 'bis_el:SND-1'), JSON.stringify(extra)).toBe(true);
        expect(ids(res.hits), JSON.stringify(extra)).not.toContain('bis_el:SND-1');
      }
    });

    it('admits only on spelling in fuzzy mode, ranking a sound-completed hit by its coverage', async () => {
      const res = await screen('Hannibal Gaddafi', { matchMode: 'fuzzy' });
      // The Saif QADHAFI records share no spelled word with the query, so sound adds none.
      expect(rows(res.hits)).toEqual([
        'ofac_sdn:12627 strong',
        'eu:6093 approximate 2/2 1',
        'uk:LIB0051 approximate 2/2 1',
        'un:690771 approximate 2/2 1',
        'ofac_sdn:12608 approximate 1/2',
      ]);
    });
  });

  it('ranks by score, then words covered, then words covered by spelling', async () => {
    await svc.ingestDesignations([
      listed('ofac_sdn', '12610', 'Aisha GADHAFI'),
      listed('eu', 'AB-1', 'AISHA Abu Bakr'),
      listed('eu', 'KH-1', 'GADDAFI Khamis'),
      listed('uk', 'LIB0047', 'Aisha QADHAFI'),
      listed('un', '690757', 'Aisha Qadhafi'),
      listed('eu', 'HUS-1', 'Ahmed HUSSEIN'),
      // `hasan` ~ `hassan` (0.97) by spelling, so strict never reaches it.
      listed('un', 'HAS-1', 'HASAN Ahmed Ali'),
      listed('ofac_sdn', 'AH-1', 'Ahmed Zorvani'),
    ]);
    const aisha = await screen('Aisha Gaddafi');
    expect(aisha.modeUsed).toBe('fuzzy');
    expect(rows(aisha.hits)).toEqual([
      'ofac_sdn:12610 approximate 2/2',
      'uk:LIB0047 approximate 2/2 1',
      'un:690757 approximate 2/2 1',
      'eu:AB-1 approximate 1/2',
      'eu:KH-1 approximate 1/2',
    ]);
    expect(aisha.hits[0]?.queryTokenCoverage).toStrictEqual({ covered: 2, total: 2 });
    // Score 1 and 2/2 each: `hassan` spelled outranks `hussein` sounded, whatever the list order.
    const ahmed = await screen('Ahmed Hassan', { matchMode: 'fuzzy' });
    expect(rows(ahmed.hits)).toEqual([
      'un:HAS-1 approximate 2/2',
      'eu:HUS-1 approximate 2/2 1',
      'ofac_sdn:AH-1 approximate 1/2',
    ]);
    expect(new Set(ahmed.hits.map((hit) => hit.score))).toEqual(new Set([1]));
  });

  it.each([
    // `ali` ~ `el`: key AL, two characters, and `el` is stoplisted.
    ['Mohammed Ali', 'Mohammed ALI', 'EL BARDAWIL Salah Mohammad'],
    // `wei` ~ `yu`: key A; `zhang` ~ `han` clears the floor by spelling (0.8667).
    ['Zhang Wei', 'ZHANG Wei', 'Yu-ro Han'],
    // `jun` ~ `jin`: key JN, two characters.
    ['Wang Jun', 'WANG Jun', 'Jin Wang'],
    // `anita` ~ `and`: key ANT, but `and` is stoplisted.
    ['Anita Rahimi', 'Anita RAHIMI', 'Rahimi and Sons'],
  ])(
    'keeps no %j completion candidate whose sound match is a short key or a stoplisted word',
    async (query, strictName, soundAlike) => {
      await svc.ingestDesignations([
        listed('un', 'STRICT-1', strictName),
        listed('eu', 'SOUND-1', soundAlike),
      ]);
      const completed = await screen(query);
      expect(ids(completed.hits)).toEqual(['un:STRICT-1']);
      // A full pass admits it on its spelled word, and covers only that word.
      const fuzzy = await screen(query, { matchMode: 'fuzzy', sources: ['eu'] });
      expect(fuzzy.hits).toMatchObject([
        { designationId: 'eu:SOUND-1', queryTokenCoverage: { covered: 1, total: 2 } },
      ]);
      expect(fuzzy.hits[0]?.queryTokenCoverage?.phonetic).toBeUndefined();
    },
  );

  it('leaves a fuzzy LEI resolution unchanged by a sound-alike candidate', async () => {
    const resolve = async () =>
      (
        await svc.resolveEntity(
          { query: 'Hannibal Gaddafi Trading', matchMode: 'fuzzy', status: 'any', limit: 25 },
          ctx,
        )
      ).matches.filter((match) => match.lei.startsWith('92'));
    await svc.ingestLeiEntities([
      {
        lei: '92000000000000SPELL1',
        legalName: 'Hannibal Zorvex Trading Ltd',
        otherNames: [],
        jurisdiction: 'GB',
        status: 'ISSUED',
      },
    ]);
    const without = await resolve();
    // Sorts after the spelled LEI, and sanctions screening would rank it first at 3/3.
    await svc.ingestLeiEntities([
      {
        lei: '92ZZZZZZZZZZZZSOUND1',
        legalName: 'Hannibal Qadhafi Trading Ltd',
        otherNames: [],
        jurisdiction: 'GB',
        status: 'ISSUED',
      },
    ]);
    const withSoundAlike = await resolve();
    expect(
      withSoundAlike.map((match) => [match.lei, match.score, match.queryTokenCoverage]),
    ).toEqual([
      ['92000000000000SPELL1', 1, { covered: 2, total: 3 }],
      ['92ZZZZZZZZZZZZSOUND1', 1, { covered: 2, total: 3 }],
    ]);
    expect(withSoundAlike[0]).toEqual(without[0]);
    expect(without).toHaveLength(1);
  });
});

describe('a completion gives each query word its own word (issue #98)', () => {
  const screen = (
    query: string,
    extra: Partial<Parameters<ScreeningService['screenName']>[0]> = {},
  ) => svc.screenName({ ...screenDefaults, limit: 100, query, ...extra }, ctx);
  const ids = (hits: readonly { designationId: string }[]) => hits.map((hit) => hit.designationId);
  const coverageOf = (
    hits: readonly {
      designationId: string;
      queryTokenCoverage?: { covered: number; phonetic?: number; total: number };
    }[],
    id: string,
  ) => hits.find((hit) => hit.designationId === id)?.queryTokenCoverage;

  beforeEach(async () => {
    await svc.ingestDesignations([
      // `PING AN`: the strict hit, then names sharing `ping`'s key PNK at 0.48–0.5.
      listed('ofac_sdn', 'PNG-1', 'PING AN', 'vessel'),
      // `an` ~ `a` spells (0.85), so only the sound floor keeps `ping` ~ `banca` out.
      listed('eu', 'BNC-1', 'Banca Finservice S.A.', 'organization'),
      // `an` ~ `and` spells (0.9111) against a stoplisted word, and `ping` ~ `bank` sounds.
      listed('uk', 'BNK-1', 'Bank of Industry and Mine', 'organization'),
      // `YOUNG YONG`: one word `Yong` covers both query words.
      listed('ofac_sdn', 'YNG-1', 'YOUNG YONG', 'vessel'),
      listed('eu', 'RYM-1', 'RYOM Yong'),
      listed('eu', 'KIM-1', 'Yong Chol KIM'),
      // Two words: `young` ~ `yung` by spelling, `yong` ~ `wong` by sound (0.8333).
      listed('bis_el', 'WYF-1', 'Wong Yung Fai'),
      // `Naim Qasim`: `nasim` covers both `naim` (0.9467) and `qasim` (0.8667).
      listed('ofac_sdn', 'QSM-1', 'Qasim Naim'),
      listed('eu', 'NSM-1', 'Al Nasim'),
      listed('uk', 'NSM-2', 'Nasim al-Sahrawi'),
      // And a two-word spelling of the same pair: `qasim` ~ `kassem` by sound (0.70).
      listed('un', 'KSM-1', 'Kassem Naim'),
    ]);
  });

  it('keeps fuzzy mode admitting and covering word by word (characterization)', async () => {
    const ping = await screen('PING AN', { matchMode: 'fuzzy', sources: ['eu', 'uk'] });
    expect(coverageOf(ping.hits, 'uk:BNK-1')).toEqual({ covered: 2, total: 2, phonetic: 1 });
    expect(coverageOf(ping.hits, 'eu:BNC-1')).toEqual({ covered: 2, total: 2, phonetic: 1 });
    const young = await screen('YOUNG YONG', { matchMode: 'fuzzy', sources: ['eu'] });
    expect(coverageOf(young.hits, 'eu:RYM-1')).toEqual({ covered: 2, total: 2 });
    const naim = await screen('Naim Qasim', { matchMode: 'fuzzy', sources: ['eu', 'uk'] });
    expect(ids(naim.hits)).toEqual(expect.arrayContaining(['eu:NSM-1', 'uk:NSM-2']));
  });

  it('keeps a fuzzy LEI resolution covering word by word (characterization)', async () => {
    await svc.ingestLeiEntities([
      {
        lei: '98000000000000YONG01',
        legalName: 'Yong Trading Ltd',
        otherNames: [],
        jurisdiction: 'KP',
        status: 'ISSUED',
      },
    ]);
    const { matches } = await svc.resolveEntity(
      { query: 'Young Yong Trading', matchMode: 'fuzzy', status: 'any', limit: 25 },
      ctx,
    );
    // One word `Yong` covers `young` and `yong`: GLEIF still counts both.
    expect(
      matches
        .filter((match) => match.lei.startsWith('98'))
        .map((match) => [match.lei, match.queryTokenCoverage]),
    ).toEqual([['98000000000000YONG01', { covered: 3, total: 3 }]]);
  });

  it('drops a candidate whose only sound match falls under the 0.65 floor', async () => {
    const res = await screen('PING AN');
    expect(ids(res.hits)).toEqual(['ofac_sdn:PNG-1']);
  });

  it('drops a candidate whose one word would cover two query words', async () => {
    const young = await screen('YOUNG YONG');
    expect(ids(young.hits)).toEqual(['ofac_sdn:YNG-1', 'bis_el:WYF-1']);
    // The surfaced coverage stays per word: `yung` clears the floor against both (0.94, 0.85).
    expect(coverageOf(young.hits, 'bis_el:WYF-1')).toEqual({ covered: 2, total: 2 });
    const naim = await screen('Naim Qasim');
    expect(ids(naim.hits)).toEqual(['ofac_sdn:QSM-1', 'un:KSM-1']);
    expect(coverageOf(naim.hits, 'un:KSM-1')).toEqual({ covered: 2, total: 2, phonetic: 1 });
  });

  it('drops a candidate covering a distinctive word only through a stoplisted one', async () => {
    await svc.ingestDesignations([
      listed('eu', 'ALF-1', 'Альфа-Банк', 'organization'),
      // `alfa` ~ `al` (0.8667) against a stoplisted word, `bank` ~ `bakr` (0.8667).
      listed('uk', 'AQD-1', 'Abou Bakr Al Djazairi'),
      listed('uk', 'LIB-1', 'Al Masraf Al Zirae Agricultural Bank', 'organization'),
      listed('uk', 'RUS-1', 'Alfa-Bank JSC', 'organization'),
    ]);
    const res = await screen('Альфа-Банк');
    expect(ids(res.hits)).toEqual(['eu:ALF-1', 'uk:RUS-1']);
  });

  it('drops a sound match of a word no spelling of it reaches: oleksiy ~ alexei (0.6429)', async () => {
    await svc.ingestDesignations([
      listed('eu', 'OLK-1', 'Oleksiy Petrenko'),
      listed('uk', 'ALX-1', 'Alexei Petrenko'),
    ]);
    expect(ids((await screen('Oleksiy Petrenko')).hits)).toEqual(['eu:OLK-1']);
    // A full pass still admits it on `petrenko` and counts `oleksiy` by sound.
    const fuzzy = await screen('Oleksiy Petrenko', { matchMode: 'fuzzy', sources: ['uk'] });
    expect(coverageOf(fuzzy.hits, 'uk:ALX-1')).toEqual({ covered: 2, total: 2, phonetic: 1 });
  });

  it('counts an identical query word once, as strict matching does', async () => {
    await svc.ingestDesignations([
      listed('eu', 'SLH-1', 'Saleh Mosfer Saleh al Shaer'),
      listed('ofac_sdn', 'SLH-2', 'Al-Shaer Salih Misfer'),
    ]);
    const res = await screen('Saleh Mosfer Saleh al Shaer');
    expect(ids(res.hits)).toEqual(['eu:SLH-1', 'ofac_sdn:SLH-2']);
    // Coverage stays the per-word count: both `saleh` and the stoplisted `al`.
    expect(coverageOf(res.hits, 'ofac_sdn:SLH-2')).toEqual({ covered: 5, total: 5 });
  });

  it('gives a repeated query word one name word, never one per occurrence: Saleh Saleh Mosfer covers 2 of 3', async () => {
    await svc.ingestDesignations([
      listed('eu', 'SLH-1', 'Saleh Mosfer Saleh al Shaer'),
      // Each `saleh` of the query finds a `saleh` here, and `shaer` finds nothing.
      listed('ofac_sdn', 'SLH-3', 'Saleh Saleh Mosfer'),
    ]);
    expect(ids((await screen('Saleh Mosfer Saleh al Shaer')).hits)).toEqual(['eu:SLH-1']);
    // A full pass admits it on the spelled words, so the completion's rule is what drops it.
    const fuzzy = await screen('Saleh Mosfer Saleh al Shaer', {
      matchMode: 'fuzzy',
      sources: ['ofac_sdn'],
    });
    expect(coverageOf(fuzzy.hits, 'ofac_sdn:SLH-3')).toEqual({ covered: 3, total: 5 });
  });

  it('counts two native words a romanization spells alike as two words: Мэр Мер keeps Mer Mer, never Mer Trading', async () => {
    await svc.ingestDesignations([
      listed('eu', 'MER-0', 'Мэр Мер'),
      // `мэр` and `мер` both romanize to `mer`: a name word for each.
      listed('uk', 'MER-1', 'Mer Mer'),
      // One `mer` for the two.
      listed('uk', 'MER-2', 'Mer Trading', 'organization'),
    ]);
    const res = await screen('Мэр Мер');
    expect(ids(res.hits)).toEqual(['eu:MER-0', 'uk:MER-1']);
    expect(res.hits[1]).toMatchObject({
      matchType: 'approximate',
      matchedName: 'Mer Mer',
      score: 1,
      queryTokenCoverage: { covered: 2, total: 2 },
    });
    // A full pass admits both on `mer`, so the completion's rule is what drops the second.
    const fuzzy = await screen('Мэр Мер', { matchMode: 'fuzzy', sources: ['uk'] });
    expect(ids(fuzzy.hits)).toEqual(['uk:MER-1', 'uk:MER-2']);
  });

  it('needs as many words as the query when its romanization drops one: Альфа Ъ never completes on alfa alone', async () => {
    await svc.ingestDesignations([
      listed('eu', 'ALF-0', 'Альфа Ъ', 'organization'),
      // `ъ` romanizes to nothing, so the romanization `alfa` is one word of the query's two.
      listed('uk', 'ALF-2', 'Alfa Trading', 'organization'),
    ]);
    expect(ids((await screen('Альфа Ъ')).hits)).toEqual(['eu:ALF-0']);
    const fuzzy = await screen('Альфа Ъ', { matchMode: 'fuzzy', sources: ['uk'] });
    expect(ids(fuzzy.hits)).toEqual(['uk:ALF-2']);
  });

  it('pairs a lone letter with the stoplisted word its spelling reaches: the a of A-Emmeh takes al', async () => {
    // The published records, under their own list and entry IDs.
    await svc.ingestDesignations([
      withAliases('uk', 'INU0222', 'CRUISE MISSILE INDUSTRY GROUP', [
        'Samen Al A-Emmeh Industries Group',
        "Samen Al-A'Emmeh Industries Group",
        '8th Imam Industries Group',
      ]),
      withAliases('ofac_sdn', '11314', 'NAVAL DEFENCE MISSILE INDUSTRY GROUP', [
        "SAMEN AL-A'EMMEH INDUSTRIES GROUP",
        '8TH IMAM INDUSTRIES GROUP',
      ]),
      withAliases('eu', '3812', 'Groupe de l’industrie des missiles de la défense navale', [
        'Samen al-Aemeh Industries Group',
        'Naval Defense Missile Industry Group',
      ]),
    ]);
    const res = await screen('Samen Al A-Emmeh Industries Group');
    // `a` ~ `al` (0.85) is the only word the eu record gives `a`; `emmeh` ~ `aemeh` (0.8667).
    expect(ids(res.hits)).toEqual(['ofac_sdn:11314', 'uk:INU0222', 'eu:3812']);
    expect(res.hits.map((hit) => hit.matchType)).toEqual(['exact', 'exact', 'approximate']);
    expect(coverageOf(res.hits, 'eu:3812')).toEqual({ covered: 6, total: 6 });
  });
});
