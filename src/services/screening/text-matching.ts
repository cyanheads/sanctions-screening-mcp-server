/**
 * @fileoverview Pure text-matching primitives for sanctions screening:
 * name folding/normalization, tokenization, the legal-form spelling fold strict
 * matching reads, Double-Metaphone phonetic keys, and Jaro-Winkler similarity.
 * These produce the *real signal* the matching engine
 * surfaces — Jaro-Winkler returns a genuine 0–1 measurement, never a fabricated
 * composite "confidence". The index and the query are both folded before the FTS5
 * tokenizer (`unicode61 remove_diacritics 2`) sees them, and the tokenizer splits a
 * folded name into exactly its {@link tokenize} tokens, so the two agree.
 * @module services/screening/text-matching
 */

/** Runs of combining marks (`\p{M}`), stripped by {@link fold}. */
const COMBINING_MARKS = /\p{M}+/gu;

/**
 * Runs {@link fold} collapses to one space: anything outside `[\p{L}\p{N}]`, plus
 * the Spacing Modifier Letters block (U+02B0–U+02FF). What survives NFKD in that
 * block (`ʼ`, `ʻ`, `ʹ`, `ˮ`, …) is a letter to Unicode but an apostrophe, prime,
 * or quote to the reader, who types an ASCII `'` in its place.
 */
const SEPARATOR_RUNS = /(?:[^\p{L}\p{N}]|[ʰ-˿])+/gu;

/** A token written entirely in Latin script (digits allowed) — the only kind Double Metaphone keys. */
const LATIN_TOKEN = /^[\p{Script=Latin}\p{N}]+$/u;

/** A letter of a script other than Latin and Common (see {@link hasOtherScriptLetter}). */
const OTHER_SCRIPT_LETTER = /[^\P{L}\p{Script=Latin}\p{Script=Common}]/u;

/**
 * True when `text` holds a letter of a script other than Latin. Script-neutral
 * letters (Common: `µ`, the modifier apostrophe `ʼ`) belong to no script and do
 * not count, and neither do digits, marks, or punctuation, so a name mixing
 * scripts (`АО Almaz`) holds one and a Latin name with digits does not. One
 * character class, so a read is linear in `text`.
 */
export function hasOtherScriptLetter(text: string): boolean {
  return OTHER_SCRIPT_LETTER.test(text);
}

/**
 * Fold a raw name to its normalized form: NFKD-decompose, strip every combining
 * mark (`\p{M}`), lowercase, map final sigma `ς` to `σ`, drop Arabic tatweel
 * (U+0640, which only stretches a word), collapse each run of characters outside
 * `[\p{L}\p{N}]` — or inside the Spacing Modifier Letters block — to one space,
 * and trim. Letters and digits of every script survive, so a native-script name
 * is indexed and queryable as published; a name whose fold is ASCII folds
 * exactly as it always has.
 *
 * The fold normalizes more than the tokenizer does (unicode61 keeps non-Latin
 * diacritics such as Cyrillic `й`), which is harmless because both sides are
 * folded first. Final sigma is the one place unicode61 would otherwise disagree:
 * it folds `ς` to `σ` itself, so without that step the tokenizer would split a
 * folded Greek name into different tokens than {@link tokenize}.
 *
 * Marks are also stripped BEFORE `normalize()`: NFKD reorders a run of combining
 * marks with an insertion sort, which is quadratic in the run's length, and a
 * caller can send one. No `\p{M}` character decomposes to a non-mark, so the
 * early strip leaves the result unchanged; the only non-marks that decompose to
 * marks (half-width katakana voicing, U+FF9E/U+FF9F) share one combining class,
 * so the normalizer never reorders a long run.
 */
export function fold(raw: string): string {
  return raw
    .replace(COMBINING_MARKS, '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/ـ/g, '')
    .replace(SEPARATOR_RUNS, ' ')
    .trim();
}

/** Split a folded string into non-empty tokens. */
export function tokenize(folded: string): string[] {
  return folded.split(/\s+/).filter(Boolean);
}

/** Russian-alphabet comparison mapping; unknown characters survive unchanged. */
const RUSSIAN_LATIN: Readonly<Record<string, string>> = Object.freeze({
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
});

/** Native fold first, then a distinct Russian romanization folded only after mapping. */
export function comparisonForms(raw: string): string[] {
  const native = fold(raw);
  if (!/[А-Яа-яЁё]/u.test(raw)) return [native];
  const romanized = fold(
    [...raw.toLowerCase()].map((letter) => RUSSIAN_LATIN[letter] ?? letter).join(''),
  );
  return !romanized || native === romanized ? [native] : [native, romanized];
}

/**
 * The native word each token of a {@link comparisonForms} form spells, in the
 * form's order: the native fold's tokens are their own words, and a romanized
 * token's word is the native token it romanizes, so `mer mer` from `Мэр Мер`
 * spells two words and `semyon semen` from `Семён Семен` one. The romanization
 * maps each letter to letters or to nothing, so its tokens are the native
 * fold's less the words of `ъ` and `ь` alone. A modifier sign (`ꚜ`) folds to
 * `ъ` but romanizes as itself, leaving the two unaligned; the form's own
 * tokens are then its words.
 */
export function nativeWords(
  nativeTokens: readonly string[],
  formTokens: readonly string[],
): readonly string[] {
  const kept = nativeTokens.filter((token) =>
    [...token].some((letter) => RUSSIAN_LATIN[letter] !== ''),
  );
  return kept.length === formTokens.length ? kept : formTokens;
}

/** Distinct first-four-code-point prefixes and their one-deletion signatures, at least two points long. */
export function deletionSignatures(tokens: readonly string[]): string[] {
  const signatures = new Set<string>();
  for (const token of tokens) {
    const prefix = [...token].slice(0, 4);
    if (prefix.length < 2) continue;
    signatures.add(prefix.join(''));
    if (prefix.length > 2) {
      for (let i = 0; i < prefix.length; i++) {
        signatures.add([...prefix.slice(0, i), ...prefix.slice(i + 1)].join(''));
      }
    }
  }
  return [...signatures];
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
//
// Every length and position below counts code points, not UTF-16 code units. A
// supplementary-plane letter (CJK Extension B, e.g. `𠀀`) is two code units, and
// every letter in one 1,024-character block shares its high surrogate, so a
// code-unit measure counts those shared halves as matching characters and
// inflates the score (`𠀀𠀁𠀃` / `𠀀𠀁𠀂` scored 0.9333 against 0.8222 for its
// code-point twin `abd` / `abc`). Text with no surrogate is already a code-point
// sequence and is indexed as a string, so a BMP name scores exactly as before.

/** Characters a similarity measure indexes: a BMP string, or a code-point array. */
type CodePoints = string | readonly string[];

/** True when `s` holds a UTF-16 surrogate, i.e. a supplementary-plane character. */
function hasSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdfff) return true;
  }
  return false;
}

/**
 * `s` as an indexable code-point sequence. A string without surrogates already
 * is one and is returned unchanged; only text holding a supplementary-plane
 * character pays for the split.
 */
function codePoints(s: string): CodePoints {
  return hasSurrogate(s) ? Array.from(s) : s;
}

/**
 * Jaro similarity of two strings (0–1). The symmetric matching-window
 * comparison underlying Jaro-Winkler, over code points.
 */
export function jaro(a: string, b: string): number {
  return a === b ? 1 : jaroOf(codePoints(a), codePoints(b));
}

/** {@link jaro} over two code-point sequences already known to differ. */
function jaroOf(a: CodePoints, b: CodePoints): number {
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
 * code points), which suits the short, prefix-weighted name strings sanctions
 * screening deals in. `prefixScale` defaults to the standard 0.1.
 */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  return a === b ? 1 : jaroWinklerOf(codePoints(a), codePoints(b), prefixScale);
}

/** {@link jaroWinkler} over two code-point sequences already known to differ. */
function jaroWinklerOf(x: CodePoints, y: CodePoints, prefixScale = 0.1): number {
  const j = jaroOf(x, y);
  if (j === 0) return 0;
  let prefix = 0;
  const maxPrefix = Math.min(4, x.length, y.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (x[i] === y[i]) prefix++;
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

/**
 * How many query tokens are individually "covered" by the candidate — i.e. score
 * at least `threshold` (Jaro-Winkler) against some candidate token. Where
 * {@link bestTokenScore} is the single best pair, this counts how MANY query
 * tokens clear the bar, letting the matching engine require a candidate to explain
 * enough of a multi-token query rather than admitting it on one strong fragment.
 */
export function tokenCoverage(
  queryTokens: string[],
  candidateTokens: string[],
  threshold: number,
): number {
  let covered = 0;
  for (const q of queryTokens) {
    for (const c of candidateTokens) {
      if (jaroWinkler(q, c) >= threshold) {
        covered++;
        break;
      }
    }
  }
  return covered;
}

/** A query token prepared once for scoring against every candidate of a fuzzy pass. */
export interface ScoringToken {
  /** The token as {@link jaroWinkler} indexes it, split once. */
  readonly codePoints: CodePoints;
  /** Whether it is one of {@link splitOnStoplist}'s distinctive tokens. */
  readonly distinctive: boolean;
  readonly text: string;
  /** The query word it spells ({@link nativeWords}); {@link queryWords} and {@link holdsEveryWord} count each once. */
  readonly word: string;
}

/**
 * A fuzzy query's tokens prepared for {@link scoreTokenPairs}, in query order,
 * each spelling the word at its position in `words` — itself unless given.
 */
export function scoringQuery(
  queryTokens: readonly string[],
  words: readonly string[] = queryTokens,
): ScoringToken[] {
  // splitOnStoplist's rule: a query made only of stoplisted tokens counts every one as distinctive.
  const allDistinctive = queryTokens.every(isStoplistToken);
  return queryTokens.map((text, i) => ({
    text,
    codePoints: codePoints(text),
    distinctive: allDistinctive || !isStoplistToken(text),
    word: words[i] ?? text,
  }));
}

/**
 * The query's distinct distinctive words, each a strict screen's completion
 * needs a name word for ({@link oneToOneCoverage}), as the first token that
 * spells it. Identical words are one word, as strict matching reads them, and
 * two native words a romanization spells alike stay two.
 */
export function queryWords(query: readonly ScoringToken[]): ScoringToken[] {
  return firstTokenPerWord(query.filter((q) => q.distinctive));
}

/** The first token of each distinct {@link ScoringToken.word}, in query order. */
function firstTokenPerWord(query: readonly ScoringToken[]): ScoringToken[] {
  const seen = new Set<string>();
  return query.filter((q) => !seen.has(q.word) && Boolean(seen.add(q.word)));
}

/**
 * Whether a name gives every word of the query a word of its own spelled
 * exactly as the token that first spells it: each distinct word, legal forms
 * and function words included, so `el el bank` from `Эль Ель Банк` needs two
 * `el`, `mer mer` from `Мэр Мер` never reads `mer trading`, and `semyon semen`
 * from `Семён Семен` needs one `semyon`. No similarity and no sound. A word
 * pairs only with a name word of its spelling, so a maximum matching seats them
 * all exactly when the name holds each spelling as often as words take it.
 */
export function holdsEveryWord(
  query: readonly ScoringToken[],
  nameTokens: readonly string[],
): boolean {
  const needed = new Map<string, number>();
  for (const q of firstTokenPerWord(query)) needed.set(q.text, (needed.get(q.text) ?? 0) + 1);
  for (const token of nameTokens) {
    const left = needed.get(token);
    if (left === undefined) continue;
    if (left === 1) needed.delete(token);
    else needed.set(token, left - 1);
  }
  return needed.size === 0;
}

/**
 * A folded token's key for matching by sound in {@link scoreTokenPairs} and
 * {@link oneToOneCoverage}, or undefined when the token never matches by sound.
 * Two tokens sound alike when both have a key and the keys are equal.
 */
export type SoundKey = (token: string) => string | undefined;

/**
 * The shortest primary Double-Metaphone key a token matches by sound on. A
 * shorter key joins unrelated words: `wei` and `yu` are both `A`.
 */
const MIN_SOUND_KEY_LENGTH = 3;

/**
 * A memoized {@link SoundKey} for one fuzzy pass: a token's primary
 * Double-Metaphone key ({@link doubleMetaphone}), or undefined when the token is
 * on {@link FUZZY_STOPLIST} (`al` and `el` are both `AL`), has no key (a
 * non-Latin token), or its key is shorter than three characters. The memo lives
 * as long as the returned function, so a pass over thousands of candidate names
 * keys each distinct token once.
 */
export function soundKeys(): SoundKey {
  const memo = new Map<string, string | undefined>();
  return (token) => {
    if (memo.has(token)) return memo.get(token);
    const key = isStoplistToken(token) ? '' : doubleMetaphone(token);
    const soundKey = key.length >= MIN_SOUND_KEY_LENGTH ? key : undefined;
    memo.set(token, soundKey);
    return soundKey;
  };
}

/** One candidate's token-pair measurements against a query — see {@link scoreTokenPairs}. */
export interface TokenPairScores {
  /** {@link bestTokenScore} of the query and candidate tokens. */
  best: number;
  /** Query tokens covered by spelling ({@link tokenCoverage} at the threshold) or by sound. */
  covered: number;
  /** {@link tokenCoverage} of the distinctive query tokens alone at the threshold: spelling only. */
  distinctiveCovered: number;
  /** Of `covered`, the tokens covered by sound alone; every one is distinctive. 0 without a {@link SoundKey}. */
  phonetic: number;
}

/**
 * {@link bestTokenScore}, the coverage of every query token, and
 * {@link tokenCoverage} of the distinctive ones, from one pass over the query ×
 * candidate token pairs: each pair's Jaro-Winkler is computed at most once, and
 * each token is split into code points once. A query token's remaining pairs are
 * skipped only once it is covered and the best score is already 1, when none of
 * them can change a result — so `best` and `distinctiveCovered` equal the
 * separate helpers' results, and so does `covered` without a `soundKey`.
 *
 * With a `soundKey`, a distinctive query token that no candidate token clears
 * the threshold against is covered by sound when its key equals a candidate
 * token's (`gaddafi` and `qadhafi`, both `KTF`, at Jaro-Winkler 0.8095): it counts
 * in `covered` and in `phonetic`, never in `best` or `distinctiveCovered`. So
 * `distinctiveCovered + phonetic` is the distinctive tokens covered either way,
 * and a gate on `distinctiveCovered` admits nothing by sound.
 */
export function scoreTokenPairs(
  query: readonly ScoringToken[],
  candidateTokens: readonly string[],
  threshold: number,
  soundKey?: SoundKey,
): TokenPairScores {
  const candidate = candidateTokens.map((text) => ({ text, codePoints: codePoints(text) }));
  let best = 0;
  let covered = 0;
  let distinctiveCovered = 0;
  let phonetic = 0;
  for (const q of query) {
    let hit = false;
    for (const c of candidate) {
      const score = q.text === c.text ? 1 : jaroWinklerOf(q.codePoints, c.codePoints);
      if (score > best) best = score;
      if (score >= threshold) {
        hit = true;
        if (best === 1) break;
      }
    }
    if (hit) {
      covered++;
      if (q.distinctive) distinctiveCovered++;
    } else if (soundKey && q.distinctive) {
      const key = soundKey(q.text);
      if (key !== undefined && candidateTokens.some((c) => soundKey(c) === key)) {
        covered++;
        phonetic++;
      }
    }
  }
  return { best, covered, distinctiveCovered, phonetic };
}

/**
 * The least Jaro-Winkler at which a word covered by sound counts toward a
 * strict screen's completion ({@link oneToOneCoverage}). Sound keys join
 * transliterations (`qasim`/`kassem` 0.70, `husayn`/`hossein` 0.6786) and words
 * that share no spelling at all (`ping`/`bank` 0.5, `aqssa`/`acoes` 0.64);
 * the floor keeps the first. Its known cost: `oleksiy`/`alexei` (0.6429).
 */
export const SOUND_MIN_SIMILARITY = 0.65;

/**
 * How many of the query's distinct distinctive words ({@link queryWords}) a
 * candidate name covers one to one: the size of a maximum matching between
 * those words and the name's words, each name word taken by at most one query
 * word. A strict screen's completion keeps a candidate only when every word
 * gets one (see `ScreeningService.runFuzzy`). A query word, through the token
 * that spells it, and a name word pair when:
 *
 *  - their Jaro-Winkler clears `threshold`, unless the name word is on
 *    {@link FUZZY_STOPLIST}, the two differ, and the query word is longer than
 *    one letter (`an` never takes `and`). A lone letter, which the fold makes of
 *    `A-Emmeh` or `70.º`, spells only itself and a two-letter word opening with
 *    it at the default 0.85, often a stoplisted one (`a` takes `al`, `o` takes
 *    `of`); or
 *  - they sound alike (`soundKey`) and their Jaro-Winkler is at least
 *    {@link SOUND_MIN_SIMILARITY} (`gaddafi`/`qadhafi` 0.8095; never `ping`/`bank`).
 *
 * {@link scoreTokenPairs} counts each query word on its own, so one name word
 * can cover several (`yong` covers `young` and `yong`); fuzzy admission and the
 * surfaced coverage keep that count. Kuhn's augmenting paths bound the
 * matching: each of the n query words searches the at most n × m pairs once,
 * O(n² · m) beside the n · m Jaro-Winkler comparisons that build them.
 */
export function oneToOneCoverage(
  query: readonly ScoringToken[],
  candidateTokens: readonly string[],
  threshold: number,
  soundKey: SoundKey,
): number {
  const words = queryWords(query);
  const candidate = candidateTokens.map((text) => ({
    text,
    codePoints: codePoints(text),
    stoplisted: isStoplistToken(text),
  }));
  // Each query word's pairable name words, by index into `candidate`.
  const pairs = words.map((q) => {
    const key = soundKey(q.text);
    const letter = q.codePoints.length === 1;
    const reachable: number[] = [];
    for (const [j, c] of candidate.entries()) {
      const score = q.text === c.text ? 1 : jaroWinklerOf(q.codePoints, c.codePoints);
      const paired =
        score >= threshold
          ? q.text === c.text || !c.stoplisted || letter
          : key !== undefined && score >= SOUND_MIN_SIMILARITY && soundKey(c.text) === key;
      if (paired) reachable.push(j);
    }
    return reachable;
  });

  // The query word holding each name word, or -1.
  const holder = new Array<number>(candidate.length).fill(-1);
  const visited = new Array<boolean>(candidate.length);
  /** Seats query word `i`, moving the holders in its way along an augmenting path. */
  const seat = (i: number): boolean => {
    for (const j of pairs[i] ?? []) {
      if (visited[j]) continue;
      visited[j] = true;
      const current = holder[j] ?? -1;
      if (current === -1 || seat(current)) {
        holder[j] = i;
        return true;
      }
    }
    return false;
  };
  let covered = 0;
  for (const i of pairs.keys()) {
    visited.fill(false);
    if (seat(i)) covered++;
  }
  return covered;
}

/**
 * Length ratio of two strings in code points — the shorter length over the longer, in [0, 1].
 * 1.0 means equal-length strings; a small value means one is far shorter than the
 * other. Two empty strings score 1 (identical); empty-vs-nonempty scores 0.
 *
 * This guards whole-string Jaro-Winkler admission. Jaro-Winkler's shared-prefix
 * boost inflates similarity when a short string is a bare (near-)prefix of a much
 * longer one — `jaroWinkler('nicolas maduroo moros', 'nicolas')` is 0.8667, above
 * a 0.85 floor, on one shared word out of three. A whole-string score is therefore
 * trustworthy on its own only when the two strings are of comparable length; the
 * ratio measures exactly that.
 */
export function lengthRatio(a: string, b: string): number {
  const lenA = codePoints(a).length;
  const lenB = codePoints(b).length;
  const longer = Math.max(lenA, lenB);
  if (longer === 0) return 1;
  return Math.min(lenA, lenB) / longer;
}

// ─── Fuzzy stoplist ───────────────────────────────────────────────────────────

/**
 * Folded query tokens that say what kind of entity a name is, not which one:
 * legal forms, articles and other function words, and bare jurisdiction codes.
 * A candidate that shares only these with a query matches nothing about it —
 * `Sovcomflot Ltd` fuzzy-admitted fifty unrelated `… LTD` entities at coverage
 * 1/2 — and counting them raised the share a real match had to cover:
 * `SOVCOMFLOT (UK) LTD` matched three Sovcomflot designations on its one
 * distinctive word and failed the half-coverage gate at 1/3.
 *
 * Built from token counts over `name.normalized` of the 2026-10-03 lists (102,467
 * names): every legal-form word in a language the lists publish that occurs in
 * at least 5 names, the articles, conjunctions, and prepositions those names
 * carry inside organization names, and the codes `uk`, `usa`, `uae`, `rf`. Left
 * out on purpose: country names, which are listed names in their own right
 * (`Iran Air`); one-letter tokens, which are also initials (`s a` from `S.A.`);
 * and person-name particles that are not articles (`bin`, `abu`, `ibn`, `van`).
 * Some entries are also person-name syllables (`uk` in `Pae Won Uk`, `co` in
 * `Augusto Mario Co`, `ag` in `Iyad Ag Ghali`, `sa` from `Sa'id`). Such a name
 * still covers its other words, so it keeps its place; the syllable only stops
 * counting toward admission and stops forming a blocking lookup of its own.
 *
 * The list changes the fuzzy admission gate, blocking, matching by sound, and
 * the name words a completion pairs a distinctive query word with only (see
 * `ScreeningService.admitFuzzy`, `poolCandidates`, {@link soundKeys}, and
 * {@link oneToOneCoverage}). The normalized query, strict matching, the surfaced
 * score, the whole-string arm, and `queryTokenCoverage` by spelling count every token.
 */
export const FUZZY_STOPLIST: ReadonlySet<string> = new Set(
  [
    // Legal forms — English
    'company co limited ltd llc inc incorporated corp corporation plc llp lp',
    'joint stock liability',
    // Legal forms — Russian, transliterated and Cyrillic
    'jsc ojsc cjsc pjsc ao oao zao pao ooo obshchestvo ogranichennoi ogranichennoy',
    'otvetstvennostyu aktsionernoe aktsionernoye otkrytoe zakrytoe kompaniya',
    'общество ограниченнои ответственностью акционерное компания ооо ао пао зао оао',
    // Legal forms — German, Romance, Dutch, Hungarian, Turkish, Balkan, Polish
    'gmbh ag kg aktiengesellschaft sa sarl srl spa sl sas ltda cia sociedad anonima',
    'societatea actiuni bv nv kft reszvenytarsasag sirketi anonim doo spolka',
    // Legal forms — Gulf free zones, South and Southeast Asia
    'fze fzco fzc fz dmcc pte pvt pty sdn bhd',
    // Articles, conjunctions, prepositions
    'al el la le les de des du del der die the of and for ve wa und et en',
    // Jurisdiction codes
    'uk usa uae rf',
  ]
    .join(' ')
    .split(' '),
);

/** True when a folded token is on {@link FUZZY_STOPLIST}. */
export function isStoplistToken(token: string): boolean {
  return FUZZY_STOPLIST.has(token);
}

/**
 * A fuzzy query's tokens split on {@link FUZZY_STOPLIST}: `distinctive` holds the
 * tokens off the list, in query order, and `stoplisted` the rest. A query made
 * only of stoplist tokens has nothing else to match on, so all of them are then
 * distinctive and none stoplisted.
 */
export function splitOnStoplist(tokens: readonly string[]): {
  distinctive: string[];
  stoplisted: string[];
} {
  const distinctive = tokens.filter((token) => !isStoplistToken(token));
  return distinctive.length === 0
    ? { distinctive: [...tokens], stoplisted: [] }
    : { distinctive, stoplisted: tokens.filter(isStoplistToken) };
}

// ─── Legal-form spellings ─────────────────────────────────────────────────────

/**
 * Each legal form strict matching reads as one word, keyed by its canonical
 * token, with every folded spelling of it — the canonical first. A
 * transliterated or Cyrillic Russian form is a spelling of its English form:
 * `OOO`, `ООО`, and `Obshchestvo s Ogranichennoi Otvetstvennostyu` are `LLC`.
 *
 * Built from the alias pairs of one designation that differ only in how a form
 * is spelled, over the 2026-11-19 lists; every spelling here is paired so at
 * least once, except those held so a longer form never reads as a word of
 * another (`Limited Partnership` as `Ltd`): the non-public JSC, a bare
 * `limited liability`, and the LP and PLC rows. Forms the lists pair for one
 * entity's re-registration or in translation are different forms, never one
 * row: JSC, PJSC, OJSC, and CJSC are four forms, LLC and Ltd two, Company and
 * Corporation two.
 *
 * The public-company spellings of PLC ({@link WORD_BY_WORD_SPELLINGS}) are a
 * semantic call rather than a pairing: the lists publish them beside a
 * `Limited` or `Ltd` alias of the same entity and never beside `PLC`, and a
 * public company limited by shares is the PLC form. A name holding one, the
 * query or a stored name, is also read word by word ({@link legalFormReadings}),
 * so a `Ltd` query still reaches it, as it reaches the entity's `Limited`
 * alias, and a query spelling one still reaches a name that holds the same
 * words but spells no PLC (`X Public Co Ltd`).
 *
 * Every canonical is on {@link FUZZY_STOPLIST}. The table reaches strict
 * matching only, through {@link legalFormReadings} and
 * {@link buildLegalFormFtsMatch}; the normalized query, the stored name index,
 * and GLEIF name resolution never see it.
 */
export const LEGAL_FORM_SPELLINGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['ltd', ['ltd', 'limited']],
  ['co', ['co', 'company']],
  ['corp', ['corp', 'corporation']],
  ['inc', ['inc', 'incorporated']],
  ['llp', ['llp', 'limited liability partnership']],
  ['lp', ['lp', 'limited partnership']],
  [
    'plc',
    ['plc', 'public limited company', 'public company limited', 'public company ltd', 'public ltd'],
  ],
  ['ag', ['ag', 'aktiengesellschaft']],
  [
    'llc',
    [
      'llc',
      'limited liability company',
      'limited liability corporation',
      'limited liability',
      'l l c',
      'ooo',
      'obshchestvo s ogranichennoi otvetstvennostyu',
      'obshchestvo s ogranichennoy otvetstvennostyu',
      'obschestvo s ogranichennoi otvetstvennostyu',
      'obschestvo s ogranichennoy otvetstvennostyu',
      'ооо',
      'общество с ограниченнои ответственностью',
      // The same form as the lists also publish it, the preposition a Latin `c` (U+0063).
      'общество c ограниченнои ответственностью',
    ],
  ],
  [
    'jsc',
    [
      'jsc',
      'joint stock company',
      'non public joint stock company',
      'ao',
      'aktsionernoe obshchestvo',
      'aktsionernoye obshchestvo',
      'aktsionernoe obschestvo',
      'ао',
      'акционерное общество',
      'непубличное акционерное общество',
    ],
  ],
  [
    'pjsc',
    [
      'pjsc',
      'public joint stock company',
      'pao',
      'publichnoe aktsionernoe obshchestvo',
      'publichnoye aktsionernoye obshchestvo',
      'publichnoe aktsionernoe obschestvo',
      'publichnoye joint stock company',
      'пао',
      'публичное акционерное общество',
    ],
  ],
  [
    'ojsc',
    [
      'ojsc',
      'open joint stock company',
      'oao',
      'otkrytoe aktsionernoe obshchestvo',
      'otkrytoye aktsionernoye obshchestvo',
      'otkrytoe aktsionernoe obschestvo',
      'оао',
      'открытое акционерное общество',
    ],
  ],
  [
    'cjsc',
    [
      'cjsc',
      'closed joint stock company',
      'zao',
      'zakrytoe aktsionernoe obshchestvo',
      'zakrytoye aktsionernoye obshchestvo',
      'зао',
      'закрытое акционерное общество',
    ],
  ],
]);

/**
 * The spellings of `plc` ({@link LEGAL_FORM_SPELLINGS}) a name is also read
 * word by word, as `public co ltd` and `public ltd`. `public limited company`
 * is not among them, so `Ltd` never reads inside it.
 */
const WORD_BY_WORD_SPELLINGS: ReadonlySet<string> = new Set([
  'public company limited',
  'public company ltd',
  'public ltd',
]);

/** One spelling's tokens, its form's canonical token, and whether it is also read word by word. */
interface LegalFormSpelling {
  readonly canonical: string;
  readonly tokens: readonly string[];
  readonly wordByWord: boolean;
}

/** Every spelling, keyed by its first token, the longest first within a key. */
const SPELLINGS_BY_FIRST_TOKEN = new Map<string, LegalFormSpelling[]>();
for (const [canonical, spellings] of LEGAL_FORM_SPELLINGS) {
  for (const spelling of spellings) {
    // `split` always returns at least one element.
    const tokens = spelling.split(' ') as [string, ...string[]];
    const bucket = SPELLINGS_BY_FIRST_TOKEN.get(tokens[0]) ?? [];
    bucket.push({ canonical, tokens, wordByWord: WORD_BY_WORD_SPELLINGS.has(spelling) });
    SPELLINGS_BY_FIRST_TOKEN.set(tokens[0], bucket);
  }
}
for (const bucket of SPELLINGS_BY_FIRST_TOKEN.values()) {
  bucket.sort((a, b) => b.tokens.length - a.tokens.length);
}

/**
 * One left-to-right scan of `tokens`, taking the longest spelling that opens at
 * each token; with `wordByWord`, a {@link WORD_BY_WORD_SPELLINGS} spelling is
 * passed over, so its words fold one by one. `tookWordByWord` says whether the
 * fold took one of those spellings as its form.
 */
function scanLegalForms(
  tokens: readonly string[],
  wordByWord: boolean,
): { folded: string[]; tookWordByWord: boolean } {
  const folded: string[] = [];
  let tookWordByWord = false;
  let next = 0;
  for (const [i, token] of tokens.entries()) {
    if (i < next) continue;
    const spelling = SPELLINGS_BY_FIRST_TOKEN.get(token)?.find(
      (candidate) =>
        !(wordByWord && candidate.wordByWord) &&
        candidate.tokens.every((part, k) => tokens[i + k] === part),
    );
    if (spelling?.wordByWord) tookWordByWord = true;
    folded.push(spelling?.canonical ?? token);
    next = i + (spelling?.tokens.length ?? 1);
  }
  return { folded, tookWordByWord };
}

/**
 * The readings strict matching gives a name, the query and every stored name
 * alike. The first is its tokens with every legal-form spelling replaced by its
 * form's canonical token ({@link LEGAL_FORM_SPELLINGS}): the scan runs left to
 * right and takes the longest spelling that opens at each token, so `limited
 * liability company` is `llc`, never `ltd liability co`, and `public joint stock
 * company` is `pjsc`, never `public jsc`. A second reading follows only when
 * that scan took a public-company spelling of PLC ({@link WORD_BY_WORD_SPELLINGS}):
 * the tokens read those words one by one (`public co ltd`). A scan that took
 * none equals the word-by-word one, since every token then takes the same
 * spelling in both. Each reading reads every such spelling the same way, so no
 * reading holds both `plc` and a `ltd` one of them spells. At most two scans,
 * each linear in the tokens: a token tries only the few spellings that open with
 * it, each at most five tokens long.
 */
export function legalFormReadings(normalized: string): string[][] {
  const tokens = tokenize(normalized);
  const { folded, tookWordByWord } = scanLegalForms(tokens, false);
  return tookWordByWord ? [folded, scanLegalForms(tokens, true).folded] : [folded];
}

/**
 * The FTS5 `MATCH` expression for one legal-form reading of a name
 * ({@link legalFormReadings}): each distinct token quoted as
 * {@link buildFtsMatch} quotes it, a canonical one widened to any spelling of
 * its form — a multi-word spelling as a phrase, which FTS5 matches on adjacent
 * tokens only. Null when the reading holds no legal form.
 */
export function buildLegalFormFtsMatch(foldTokens: readonly string[]): string | null {
  const distinct = [...new Set(foldTokens)];
  if (!distinct.some((token) => LEGAL_FORM_SPELLINGS.has(token))) return null;
  return distinct
    .map((token) => {
      const spellings = LEGAL_FORM_SPELLINGS.get(token);
      return spellings ? `(${spellings.map((s) => `"${s}"`).join(' OR ')})` : `"${token}"`;
    })
    .join(' AND ');
}

// ─── Double Metaphone (single primary key) ─────────────────────────────────────

/**
 * Compute a Double-Metaphone phonetic key for a folded name. We index the
 * primary key only (a single column), which is sufficient for the
 * transliteration-class fuzzy hits this is meant to catch. Per-word keys are
 * concatenated with a space so a multi-word name's words each contribute.
 *
 * Only all-Latin tokens are keyed. Double Metaphone encodes English-oriented
 * Latin spelling; a non-Latin token has no key, and a mixed token (a Cyrillic
 * name carrying one Latin homoglyph) would key its Latin residue alone — `A` for
 * a stray `i`, which would block it against every name that starts with a vowel.
 *
 * This is a compact, well-tested implementation of the primary Double-Metaphone
 * code (Lawrence Philips' algorithm), adapted to emit only the primary encoding.
 */
export function doubleMetaphone(folded: string): string {
  const words = tokenize(folded).filter((w) => LATIN_TOKEN.test(w));
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
  // Tested once: a test per G would rescan the word, quadratic in a long run of `GN`.
  const slavic = slavoGermanic(s);

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
        current = encodeG(s, current, add, slavic);
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

/** `slavic` is {@link slavoGermanic} of the whole word, tested once by the caller. */
function encodeG(s: string, current: number, add: (p: string) => void, slavic: boolean): number {
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
    if (current === 1 && isVowel(s, 0) && !slavic) {
      add('KN');
      return current + 2;
    }
    if (!stringAt(s, current + 2, 2, ['EY']) && s.charAt(current + 1) !== 'Y' && !slavic) {
      add('N');
      return current + 2;
    }
    add('KN');
    return current + 2;
  }
  if (stringAt(s, current + 1, 2, ['LI']) && !slavic) {
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
