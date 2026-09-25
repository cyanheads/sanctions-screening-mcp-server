/**
 * @fileoverview Exact identifier matching for `sanctions_screen_identifier`: the
 * published-label → category table and the per-category normalizers that turn a
 * stored identifier, and a caller's value, into the same comparison key. Kept
 * beside `text-matching` (the name path) because the two index the same
 * designations for different lookups; nothing here scores — two keys are equal
 * or they are not.
 * @module services/screening/identifier-matching
 */

/** The identifier categories a caller can restrict a lookup to. */
export const IDENTIFIER_TYPES = [
  'imo',
  'swift_bic',
  'digital_currency_address',
  'passport',
  'national_id',
] as const;

/** A named identifier category. */
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/** A stored identifier's category — `other` for every label the table does not map. */
export type IdentifierCategory = IdentifierType | 'other';

/**
 * Published labels per category, lowercased with whitespace collapsed. Labels
 * vary by list (the UN publishes passports under Spanish and French labels too,
 * and one national-ID label with an embedded line break), so a label is looked
 * up in the same folded form.
 */
const LABEL_CATEGORIES: ReadonlyMap<string, IdentifierType> = new Map([
  // OFAC, UK, EU
  ['vessel registration identification', 'imo'],
  ['imo number', 'imo'],
  ['imo (vessel identification)', 'imo'],
  // EU, OFAC
  ['swift bic', 'swift_bic'],
  ['swift/bic', 'swift_bic'],
  // Every list; OFAC and UN variants
  ['passport', 'passport'],
  ['diplomatic passport', 'passport'],
  ['national passport', 'passport'],
  ['british national overseas passport', 'passport'],
  ['stateless person passport', 'passport'],
  ['número de pasaporte', 'passport'],
  ['numéro de passeport', 'passport'],
  // OFAC, EU, UK, UN
  ['national id no.', 'national_id'],
  ['national identification card', 'national_id'],
  ['national identifier', 'national_id'],
  ['national identification number', 'national_id'],
  ['tazkira national id card', 'national_id'],
]);

/** OFAC labels each currency's address `Digital Currency Address - <code>`. */
const DIGITAL_CURRENCY_LABEL_PREFIX = 'digital currency address - ';

/** The category a published identifier label belongs to. */
export function identifierCategory(label: string): IdentifierCategory {
  const folded = label.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (folded.startsWith(DIGITAL_CURRENCY_LABEL_PREFIX)) return 'digital_currency_address';
  return LABEL_CATEGORIES.get(folded) ?? 'other';
}

/** Characters every key drops: whitespace and the separators lists print numbers with. */
const SEPARATORS = /[\s\-./]/gu;

/** Trim, NFKC, uppercase, drop whitespace and `-./` — the key for every category but wallets. */
function foldIdentifier(value: string): string {
  return value.normalize('NFKC').toUpperCase().replace(SEPARATORS, '');
}

/** A single-case string — bech32 and cashaddr are invalid in mixed case. */
function singleCase(value: string): boolean {
  return value === value.toLowerCase() || value === value.toUpperCase();
}

/**
 * A wallet address's key. Hex (`0x…`), bech32 (`bc1…`, `ltc1…`, `bnb1…`), and
 * cashaddr encodings are case-insensitive, so they fold to lowercase — an EIP-55
 * checksummed ETH address matches its lowercase form. Every other shape (base58:
 * legacy BTC, TRX, SOL, XMR, …) is case-significant and compares exactly.
 */
function walletKey(value: string): string {
  const compact = value.normalize('NFKC').replace(SEPARATORS, '');
  if (/^0x[0-9a-f]+$/iu.test(compact)) return compact.toLowerCase();
  if (/^(?:bc|ltc|bnb)1[02-9ac-hj-np-z]+$/iu.test(compact) && singleCase(compact)) {
    return compact.toLowerCase();
  }
  const cashaddr = /^(?:bitcoincash:)?([qp][02-9ac-hj-np-z]{41})$/iu.exec(compact);
  if (cashaddr?.[1] && singleCase(compact)) return cashaddr[1].toLowerCase();
  return compact;
}

/**
 * The comparison key of `value` under `category`'s rule: IMO numbers drop a
 * leading `IMO`, SWIFT/BIC codes compare on their first eight characters (a
 * branch BIC11 matches its institution's BIC8), wallet addresses fold case by
 * shape, and every other category uses the common fold. Empty when nothing is
 * left to compare.
 */
export function identifierKey(category: IdentifierCategory, value: string): string {
  switch (category) {
    case 'imo':
      return foldIdentifier(value).replace(/^IMO/u, '');
    case 'swift_bic':
      return foldIdentifier(value).slice(0, 8);
    case 'digital_currency_address':
      return walletKey(value);
    default:
      return foldIdentifier(value);
  }
}

/** One `(category, key)` pair a stored identifier must equal to match. */
export interface IdentifierProbe {
  category: IdentifierCategory;
  key: string;
}

const ALL_CATEGORIES: readonly IdentifierCategory[] = [...IDENTIFIER_TYPES, 'other'];

/**
 * The probes a caller's value runs as: one per category it may match, each
 * keyed under that category's rule. `any` probes every category, including the
 * labels the table does not map. Empty when the value normalizes to nothing
 * under every rule it runs as.
 */
export function identifierProbes(value: string, type: IdentifierType | 'any'): IdentifierProbe[] {
  const categories = type === 'any' ? ALL_CATEGORIES : [type];
  return categories
    .map((category) => ({ category, key: identifierKey(category, value) }))
    .filter((probe) => probe.key.length > 0);
}
