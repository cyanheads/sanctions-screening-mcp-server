/**
 * @fileoverview The identifier label table and the per-category key rules that
 * `sanctions_screen_identifier` compares on: every published label a parser
 * emits lands in the right category, and a stored value and a caller's spelling
 * of it reduce to the same key exactly when they name the same identifier.
 * @module tests/services/identifier-matching.test
 */

import { describe, expect, it } from 'vitest';
import {
  identifierCategory,
  identifierKey,
  identifierProbes,
} from '@/services/screening/identifier-matching.js';

describe('identifierCategory', () => {
  it.each([
    ['Vessel Registration Identification', 'imo'],
    ['IMO Number', 'imo'],
    ['IMO (vessel identification)', 'imo'],
    ['SWIFT BIC', 'swift_bic'],
    ['SWIFT/BIC', 'swift_bic'],
    ['Digital Currency Address - XBT', 'digital_currency_address'],
    ['Digital Currency Address - USDT', 'digital_currency_address'],
    ['Passport', 'passport'],
    ['Diplomatic Passport', 'passport'],
    ['National passport', 'passport'],
    ['British National Overseas Passport', 'passport'],
    ['Stateless Person Passport', 'passport'],
    ['Número de pasaporte', 'passport'],
    ['Numéro de passeport', 'passport'],
    ['National ID No.', 'national_id'],
    ['National identification card', 'national_id'],
    ['National Identifier', 'national_id'],
    ['National Identification Number', 'national_id'],
    ['Tazkira National ID Card', 'national_id'],
  ])('maps the published label %j to %s', (label, category) => {
    expect(identifierCategory(label)).toBe(category);
  });

  it('collapses whitespace in a label, line breaks included', () => {
    expect(identifierCategory('National Identification\nNumber')).toBe('national_id');
    expect(identifierCategory('  SWIFT   BIC ')).toBe('swift_bic');
  });

  it.each([
    'MMSI',
    'Vessel Call Sign',
    'Tax ID No.',
    'Website',
    'Email Address',
    'Temporary Travel Document',
    'Digital Currency Address - ',
  ])('files %j under other', (label) => {
    expect(identifierCategory(label)).toBe('other');
  });
});

describe('identifierKey', () => {
  it('folds case, spacing, and the separators - . / for every non-wallet category', () => {
    expect(identifierKey('passport', ' l 191-609 ')).toBe('L191609');
    expect(identifierKey('national_id', 'V-6.557.495')).toBe(identifierKey('other', 'V6557495'));
    expect(identifierKey('other', '54401-2288025-9')).toBe('5440122880259');
  });

  it('normalizes compatibility forms before comparing (full-width digits, NBSP)', () => {
    expect(identifierKey('passport', 'Ｌ １９１６０９')).toBe('L191609');
  });

  it('drops a leading IMO from an IMO number, with or without a space', () => {
    expect(identifierKey('imo', 'IMO 7406784')).toBe('7406784');
    expect(identifierKey('imo', 'IMO  7406784')).toBe('7406784');
    expect(identifierKey('imo', 'imo7406784')).toBe('7406784');
    expect(identifierKey('imo', '7406784')).toBe('7406784');
    expect(identifierKey('imo', 'IMO')).toBe('');
  });

  it('compares a SWIFT/BIC on its first eight characters', () => {
    expect(identifierKey('swift_bic', 'SCERIRTHXXX')).toBe('SCERIRTH');
    expect(identifierKey('swift_bic', 'DCBK KPPY')).toBe('DCBKKPPY');
    expect(identifierKey('swift_bic', 'scerirthksh')).toBe(identifierKey('swift_bic', 'SCERIRTH'));
  });

  it('folds an EIP-55 hex address to lowercase', () => {
    const checksummed = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(identifierKey('digital_currency_address', checksummed)).toBe(
      identifierKey('digital_currency_address', checksummed.toLowerCase()),
    );
  });

  it.each([
    'bc1qv7k70u2zynvem59u88ctdlaw7hc735d8xep9rq',
    'ltc1qr8ntsedq8tv0svmxqhzvdcdl5k7kntdmnhwep7',
    'bnb136ns6lfw4zs5hg4n85vdthaad7hq5m4gtkgf23',
    'qpf2cphc5dkuclkqur7lhj2yuqq9pk3hmukle77vhq',
  ])('folds the case-insensitive encoding %s in either case', (address) => {
    expect(identifierKey('digital_currency_address', address.toUpperCase())).toBe(address);
    expect(identifierKey('digital_currency_address', address)).toBe(address);
  });

  it('matches a cashaddr with or without its bitcoincash: prefix', () => {
    expect(
      identifierKey(
        'digital_currency_address',
        'bitcoincash:qpf2cphc5dkuclkqur7lhj2yuqq9pk3hmukle77vhq',
      ),
    ).toBe('qpf2cphc5dkuclkqur7lhj2yuqq9pk3hmukle77vhq');
  });

  it('keeps a base58 address case-significant — one flipped letter is another address', () => {
    const base58 = '12aNKp2iDKuhEde2YfPdd4DFGenRUTKupL';
    expect(identifierKey('digital_currency_address', ` ${base58} `)).toBe(base58);
    expect(identifierKey('digital_currency_address', base58.replace('a', 'A'))).not.toBe(base58);
    // A mixed-case string that happens to start like bech32 is not bech32.
    expect(identifierKey('digital_currency_address', 'bc1QmixedCase')).toBe('bc1QmixedCase');
  });
});

describe('identifierProbes', () => {
  it('probes every category, each under its own rule, for type any', () => {
    expect(identifierProbes('IMO 7406784', 'any')).toEqual([
      { category: 'imo', key: '7406784' },
      { category: 'swift_bic', key: 'IMO74067' },
      { category: 'digital_currency_address', key: 'IMO7406784' },
      { category: 'passport', key: 'IMO7406784' },
      { category: 'national_id', key: 'IMO7406784' },
      { category: 'other', key: 'IMO7406784' },
    ]);
  });

  it('probes only the named category otherwise', () => {
    expect(identifierProbes('l191609', 'passport')).toEqual([
      { category: 'passport', key: 'L191609' },
    ]);
  });

  it('drops a probe whose key is empty, and returns none for a value of separators only', () => {
    expect(identifierProbes('IMO', 'imo')).toEqual([]);
    expect(identifierProbes('IMO', 'any').map((p) => p.category)).not.toContain('imo');
    expect(identifierProbes('---', 'any')).toEqual([]);
    expect(identifierProbes(' ./- ', 'swift_bic')).toEqual([]);
    expect(identifierProbes('　', 'any')).toEqual([]);
  });
});
