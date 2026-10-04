/**
 * @fileoverview ISO 17442 LEI check digits — the ISO 7064 MOD 97-10 check the
 * LEI-keyed surfaces run after a mirror miss, to tell a mistyped LEI from one
 * the mirror does not hold.
 * @module services/screening/lei-checksum
 */

/**
 * Whether `lei` carries valid ISO 17442 check digits: every character expanded
 * to its base-36 value (digits stay, `A`–`Z` become 10–35), the resulting
 * integer taken modulo 97, leaves 1. Expects the 20-character form the input
 * schemas enforce. GLEIF publishes records whose LEIs fail this check (annulled
 * and duplicate registrations), so it reads a miss and never gates an input.
 */
export function leiChecksumValid(lei: string): boolean {
  let remainder = 0;
  for (const char of lei) {
    const value = Number.parseInt(char, 36);
    remainder = (value < 10 ? remainder * 10 + value : remainder * 100 + value) % 97;
  }
  return remainder === 1;
}
