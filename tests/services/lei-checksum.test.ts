/**
 * @fileoverview The ISO 17442 (ISO 7064 MOD 97-10) LEI check-digit predicate
 * the LEI-keyed surfaces read a mirror miss with (issue #62).
 * @module tests/services/lei-checksum.test
 */

import { describe, expect, it } from 'vitest';
import { leiChecksumValid } from '@/services/screening/lei-checksum.js';

describe('leiChecksumValid', () => {
  it.each([
    'HWUPKR0MPOU8FGXBT394', // Apple Inc.
    '7LTWFZYICNSX8D621K86', // Deutsche Bank AG
    '253400JT3MQWNDKMJE44',
    '5493001KJTIIGC8Y1R12',
    '529900UNKNOWNLEI0009',
  ])('accepts %s', (lei) => {
    expect(leiChecksumValid(lei)).toBe(true);
  });

  it.each([
    'HWUPKR0MPOU8FGXBT395', // last check digit mistyped
    'HWUPKR0MPOU8FGXBT349', // check digits transposed
    'WHUPKR0MPOU8FGXBT394', // leading letters transposed
    '0292001629A3Q7XJ0D13', // an ANNULLED registration GLEIF still publishes
    '00000000000000000000',
    '999900XXXXXXXXXXXX99',
  ])('rejects %s', (lei) => {
    expect(leiChecksumValid(lei)).toBe(false);
  });

  it('rejects every single-character substitution of a valid LEI that changes its value mod 97', () => {
    // One substitution changes the expanded integer by (new − old) × 10^k for
    // some position k; MOD 97 misses it only when that difference is ≡ 0, so a
    // substituted digit in a check-digit position is always caught.
    for (const digit of '0123456789') {
      if (digit === '4') continue;
      expect(leiChecksumValid(`HWUPKR0MPOU8FGXBT39${digit}`)).toBe(false);
    }
  });
});
