/**
 * @fileoverview Pure text-matching primitives for sanctions screening:
 * name folding/normalization, tokenization, Double-Metaphone phonetic keys, and
 * Jaro-Winkler similarity. These produce the *real signal* the matching engine
 * surfaces — Jaro-Winkler returns a genuine 0–1 measurement, never a fabricated
 * composite "confidence". The fold layer matches the FTS tokenizer's behavior
 * (`unicode61 remove_diacritics 2`) so the index and the query agree.
 * @module services/screening/text-matching
 */

/**
 * Fold a raw name to its normalized form: lowercase, NFKD-decompose, strip
 * combining diacritics, collapse non-alphanumeric runs to single spaces, and
 * trim. Mirrors the FTS5 `unicode61 remove_diacritics 2` tokenizer so a query
 * folded here matches the indexed `normalized` column.
 */
export function fold(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Split a folded string into non-empty tokens. */
export function tokenize(folded: string): string[] {
  return folded.split(/\s+/).filter(Boolean);
}

/**
 * Build an FTS5 `MATCH` expression requiring every query token to be present
 * (AND of tokens). Each token is double-quoted so FTS5 treats it as a literal
 * (defusing FTS operators a hostile name string might contain). Returns null
 * when the query folds to nothing.
 */
export function buildFtsMatch(rawQuery: string): string | null {
  const tokens = tokenize(fold(rawQuery));
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

// ─── Jaro-Winkler ─────────────────────────────────────────────────────────────

/**
 * Jaro similarity of two strings (0–1). The symmetric matching-window
 * comparison underlying Jaro-Winkler.
 */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(lenA, lenB) / 2) - 1);
  const aMatches = new Array<boolean>(lenA).fill(false);
  const bMatches = new Array<boolean>(lenB).fill(false);

  let matches = 0;
  for (let i = 0; i < lenA; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, lenB);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  // Count transpositions.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < lenA; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (matches / lenA + matches / lenB + (matches - transpositions) / matches) / 3;
}

/**
 * Jaro-Winkler similarity (0–1) — Jaro boosted for a shared prefix (up to 4
 * chars), which suits the short, prefix-weighted name strings sanctions
 * screening deals in. `prefixScale` defaults to the standard 0.1.
 */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const j = jaro(a, b);
  if (j === 0) return 0;
  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return j + prefix * prefixScale * (1 - j);
}

/**
 * Best Jaro-Winkler similarity between any query token and any candidate token.
 * Scoring per-token (rather than whole-string) keeps word-order swaps and
 * partial names scorable, per the design.
 */
export function bestTokenScore(queryTokens: string[], candidateTokens: string[]): number {
  let best = 0;
  for (const q of queryTokens) {
    for (const c of candidateTokens) {
      const s = jaroWinkler(q, c);
      if (s > best) best = s;
      if (best === 1) return 1;
    }
  }
  return best;
}

// ─── Double Metaphone (single primary key) ─────────────────────────────────────

/**
 * Compute a Double-Metaphone phonetic key for a folded name. We index the
 * primary key only (a single column), which is sufficient for the
 * transliteration-class fuzzy hits this is meant to catch. Per-word keys are
 * concatenated with a space so a multi-word name's words each contribute.
 *
 * This is a compact, well-tested implementation of the primary Double-Metaphone
 * code (Lawrence Philips' algorithm), adapted to emit only the primary encoding.
 */
export function doubleMetaphone(folded: string): string {
  const words = tokenize(folded);
  return words
    .map((w) => encodeWord(w))
    .filter(Boolean)
    .join(' ');
}

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U', 'Y']);

function isVowel(s: string, i: number): boolean {
  const c = s.charAt(i);
  return c !== '' && VOWELS.has(c);
}

function slavoGermanic(s: string): boolean {
  return /W|K|CZ|WITZ/.test(s);
}

function stringAt(s: string, start: number, len: number, list: string[]): boolean {
  if (start < 0 || start >= s.length) return false;
  const sub = s.substring(start, start + len);
  return list.includes(sub);
}

/**
 * Encode a single word to its primary Double-Metaphone key. Upper-cased,
 * alphabetic-only input is assumed (caller passes folded tokens). Returns '' for
 * empty/punctuation-only input.
 */
function encodeWord(word: string): string {
  const s = word.toUpperCase().replace(/[^A-Z]/g, '');
  if (s.length === 0) return '';

  let primary = '';
  const length = s.length;
  const last = length - 1;
  let current = 0;

  const add = (p: string) => {
    primary += p;
  };

  // Skip silent leading letters.
  if (stringAt(s, 0, 2, ['GN', 'KN', 'PN', 'WR', 'PS'])) current += 1;

  // Initial 'X' is pronounced 'S'.
  if (s.charAt(0) === 'X') {
    add('S');
    current += 1;
  }

  while (current < length) {
    const c = s.charAt(current);
    switch (c) {
      case 'A':
      case 'E':
      case 'I':
      case 'O':
      case 'U':
      case 'Y':
        if (current === 0) add('A');
        current += 1;
        break;
      case 'B':
        add('P');
        current += s.charAt(current + 1) === 'B' ? 2 : 1;
        break;
      case 'Ç':
        add('S');
        current += 1;
        break;
      case 'C':
        current = encodeC(s, current, add);
        break;
      case 'D':
        if (stringAt(s, current, 2, ['DG'])) {
          add('J');
          current += stringAt(s, current + 2, 1, ['I', 'E', 'Y']) ? 3 : 2;
        } else if (stringAt(s, current, 2, ['DT', 'DD'])) {
          add('T');
          current += 2;
        } else {
          add('T');
          current += 1;
        }
        break;
      case 'F':
        add('F');
        current += s.charAt(current + 1) === 'F' ? 2 : 1;
        break;
      case 'G':
        current = encodeG(s, current, add);
        break;
      case 'H':
        if ((current === 0 || isVowel(s, current - 1)) && isVowel(s, current + 1)) {
          add('H');
          current += 2;
        } else {
          current += 1;
        }
        break;
      case 'J':
        add('J');
        current += s.charAt(current + 1) === 'J' ? 2 : 1;
        break;
      case 'K':
        add('K');
        current += s.charAt(current + 1) === 'K' ? 2 : 1;
        break;
      case 'L':
        add('L');
        current += s.charAt(current + 1) === 'L' ? 2 : 1;
        break;
      case 'M':
        add('M');
        current += s.charAt(current + 1) === 'M' ? 2 : 1;
        break;
      case 'N':
        add('N');
        current += s.charAt(current + 1) === 'N' ? 2 : 1;
        break;
      case 'Ñ':
        add('N');
        current += 1;
        break;
      case 'P':
        if (s.charAt(current + 1) === 'H') {
          add('F');
          current += 2;
        } else {
          add('P');
          current += s.charAt(current + 1) === 'P' ? 2 : 1;
        }
        break;
      case 'Q':
        add('K');
        current += s.charAt(current + 1) === 'Q' ? 2 : 1;
        break;
      case 'R':
        add('R');
        current += s.charAt(current + 1) === 'R' ? 2 : 1;
        break;
      case 'S':
        current = encodeS(s, current, add);
        break;
      case 'T':
        if (stringAt(s, current, 2, ['TH']) || stringAt(s, current, 3, ['TTH'])) {
          add('0');
          current += 2;
        } else if (stringAt(s, current, 2, ['TC'])) {
          current += 1;
        } else {
          add('T');
          current += s.charAt(current + 1) === 'T' ? 2 : 1;
        }
        break;
      case 'V':
        add('F');
        current += s.charAt(current + 1) === 'V' ? 2 : 1;
        break;
      case 'W':
        if (stringAt(s, current, 2, ['WH'])) {
          add('A');
          current += 2;
        } else if (isVowel(s, current + 1)) {
          add('A');
          current += 1;
        } else {
          current += 1;
        }
        break;
      case 'X':
        add('KS');
        current += stringAt(s, current + 1, 1, ['C', 'X']) ? 2 : 1;
        break;
      case 'Z':
        add('S');
        current += s.charAt(current + 1) === 'Z' ? 2 : 1;
        break;
      default:
        current += 1;
        break;
    }
    if (current <= last && current === length) break;
  }

  return primary;
}

function encodeC(s: string, current: number, add: (p: string) => void): number {
  // 'CIA'
  if (current > 1 && !isVowel(s, current - 2) && stringAt(s, current - 1, 3, ['ACH'])) {
    add('K');
    return current + 2;
  }
  if (current === 0 && stringAt(s, current, 6, ['CAESAR'])) {
    add('S');
    return current + 2;
  }
  if (stringAt(s, current, 4, ['CHIA'])) {
    add('K');
    return current + 2;
  }
  if (stringAt(s, current, 2, ['CH'])) {
    if (current > 0 && stringAt(s, current, 4, ['CHAE'])) {
      add('K');
      return current + 2;
    }
    if (
      current === 0 &&
      (stringAt(s, current + 1, 5, ['HARAC', 'HARIS']) ||
        stringAt(s, current + 1, 3, ['HOR', 'HYM', 'HIA', 'HEM'])) &&
      !stringAt(s, 0, 5, ['CHORE'])
    ) {
      add('K');
      return current + 2;
    }
    if (
      stringAt(s, 0, 4, ['VAN ', 'VON ']) ||
      stringAt(s, 0, 3, ['SCH']) ||
      stringAt(s, current - 2, 6, ['ORCHES', 'ARCHIT', 'ORCHID']) ||
      stringAt(s, current + 2, 1, ['T', 'S']) ||
      ((stringAt(s, current - 1, 1, ['A', 'O', 'U', 'E']) || current === 0) &&
        stringAt(s, current + 2, 1, ['L', 'R', 'N', 'M', 'B', 'H', 'F', 'V', 'W', ' ']))
    ) {
      add('K');
      return current + 2;
    }
    add(current > 0 && stringAt(s, 0, 2, ['MC']) ? 'K' : 'X');
    return current + 2;
  }
  if (stringAt(s, current, 2, ['CZ']) && !stringAt(s, current - 2, 4, ['WICZ'])) {
    add('S');
    return current + 2;
  }
  if (stringAt(s, current + 1, 3, ['CIA'])) {
    add('X');
    return current + 3;
  }
  if (stringAt(s, current, 2, ['CC']) && !(current === 1 && s.charAt(0) === 'M')) {
    if (stringAt(s, current + 2, 1, ['I', 'E', 'H']) && !stringAt(s, current + 2, 2, ['HU'])) {
      add('KS');
      return current + 3;
    }
    add('K');
    return current + 2;
  }
  if (stringAt(s, current, 2, ['CK', 'CG', 'CQ'])) {
    add('K');
    return current + 2;
  }
  if (stringAt(s, current, 2, ['CI', 'CE', 'CY'])) {
    add('S');
    return current + 2;
  }
  add('K');
  if (stringAt(s, current + 1, 2, [' C', ' Q', ' G'])) return current + 3;
  if (stringAt(s, current + 1, 1, ['C', 'K', 'Q']) && !stringAt(s, current + 1, 2, ['CE', 'CI'])) {
    return current + 2;
  }
  return current + 1;
}

function encodeG(s: string, current: number, add: (p: string) => void): number {
  if (s.charAt(current + 1) === 'H') {
    if (current > 0 && !isVowel(s, current - 1)) {
      add('K');
      return current + 2;
    }
    if (current === 0) {
      add(s.charAt(current + 2) === 'I' ? 'J' : 'K');
      return current + 2;
    }
    if (
      (current > 1 && stringAt(s, current - 2, 1, ['B', 'H', 'D'])) ||
      (current > 2 && stringAt(s, current - 3, 1, ['B', 'H', 'D'])) ||
      (current > 3 && stringAt(s, current - 4, 1, ['B', 'H']))
    ) {
      return current + 2;
    }
    if (
      current > 2 &&
      s.charAt(current - 1) === 'U' &&
      stringAt(s, current - 3, 1, ['C', 'G', 'L', 'R', 'T'])
    ) {
      add('F');
      return current + 2;
    }
    if (current > 0 && s.charAt(current - 1) !== 'I') add('K');
    return current + 2;
  }
  if (s.charAt(current + 1) === 'N') {
    if (current === 1 && isVowel(s, 0) && !slavoGermanic(s)) {
      add('KN');
      return current + 2;
    }
    if (
      !stringAt(s, current + 2, 2, ['EY']) &&
      s.charAt(current + 1) !== 'Y' &&
      !slavoGermanic(s)
    ) {
      add('N');
      return current + 2;
    }
    add('KN');
    return current + 2;
  }
  if (stringAt(s, current + 1, 2, ['LI']) && !slavoGermanic(s)) {
    add('KL');
    return current + 2;
  }
  if (
    current === 0 &&
    (s.charAt(current + 1) === 'Y' ||
      stringAt(s, current + 1, 2, [
        'ES',
        'EP',
        'EB',
        'EL',
        'EY',
        'IB',
        'IL',
        'IN',
        'IE',
        'EI',
        'ER',
      ]))
  ) {
    add('K');
    return current + 2;
  }
  if (
    (stringAt(s, current + 1, 2, ['ER']) || s.charAt(current + 1) === 'Y') &&
    !stringAt(s, 0, 6, ['DANGER', 'RANGER', 'MANGER']) &&
    !stringAt(s, current - 1, 1, ['E', 'I']) &&
    !stringAt(s, current - 1, 3, ['RGY', 'OGY'])
  ) {
    add('K');
    return current + 2;
  }
  if (
    stringAt(s, current + 1, 1, ['E', 'I', 'Y']) ||
    stringAt(s, current - 1, 4, ['AGGI', 'OGGI'])
  ) {
    if (
      stringAt(s, 0, 4, ['VAN ', 'VON ']) ||
      stringAt(s, 0, 3, ['SCH']) ||
      stringAt(s, current + 1, 2, ['ET'])
    ) {
      add('K');
      return current + 2;
    }
    add('J');
    return current + 2;
  }
  add('K');
  return current + (s.charAt(current + 1) === 'G' ? 2 : 1);
}

function encodeS(s: string, current: number, add: (p: string) => void): number {
  if (stringAt(s, current - 1, 3, ['ISL', 'YSL'])) return current + 1;
  if (current === 0 && stringAt(s, current, 5, ['SUGAR'])) {
    add('X');
    return current + 1;
  }
  if (stringAt(s, current, 2, ['SH'])) {
    if (stringAt(s, current + 1, 4, ['HEIM', 'HOEK', 'HOLM', 'HOLZ'])) {
      add('S');
      return current + 2;
    }
    add('X');
    return current + 2;
  }
  if (stringAt(s, current, 3, ['SIO', 'SIA']) || stringAt(s, current, 4, ['SIAN'])) {
    add('S');
    return current + 3;
  }
  if (
    (current === 0 && stringAt(s, current + 1, 1, ['M', 'N', 'L', 'W'])) ||
    stringAt(s, current + 1, 1, ['Z'])
  ) {
    add('S');
    return current + (stringAt(s, current + 1, 1, ['Z']) ? 2 : 1);
  }
  if (stringAt(s, current, 2, ['SC'])) {
    if (s.charAt(current + 2) === 'H') {
      if (stringAt(s, current + 3, 2, ['OO', 'ER', 'EN', 'UY', 'ED', 'EM'])) {
        add('SK');
        return current + 3;
      }
      add('X');
      return current + 3;
    }
    add(stringAt(s, current + 2, 1, ['I', 'E', 'Y']) ? 'S' : 'SK');
    return current + 3;
  }
  add('S');
  return current + (stringAt(s, current + 1, 1, ['S', 'Z']) ? 2 : 1);
}
