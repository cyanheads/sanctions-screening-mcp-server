/**
 * @fileoverview Server-local XML parser for the attribute-bearing sanctions and
 * GLEIF data feeds. The framework's shared `xmlParser`
 * (`@cyanheads/mcp-ts-core/utils`) is tuned for LLM structured output and
 * constructs `fast-xml-parser` with its default `ignoreAttributes: true` — every
 * XML attribute is dropped. That is fatal here: the OFAC advanced schema, the EU
 * `xmlFullSanctionsList_1_1`, and parts of the GLEIF golden copy carry their
 * load-bearing data (stable entry IDs, name strings, type codes, programmes,
 * publication dates) in XML *attributes*, not element text. With attributes
 * ignored the EU list parses to zero designations and OFAC loses its entry IDs,
 * entity types, programmes, and dates.
 *
 * This parser turns attributes on with the `@_` prefix the ingesters read
 * (`@_FixedRef`, `@_wholeName`, `@_code`, `@_publicationDate`, …) and is the only
 * XML entry point the screening ingesters use.
 *
 * Entity references are decoded here, once, and nowhere else. Every source escapes
 * `&` and `"` as XML requires (`Greenland Oil &amp; Gas`), and every ingester reads
 * element text and attribute values through this parser, so decoding at parse time
 * keeps references out of stored names, aliases, remarks, and addresses — and so
 * out of the `name` index and both response surfaces. Stored text is never decoded
 * again. `processEntities` stays `false`: turning it on would also apply entities a
 * document's own DOCTYPE declares, and numeric references come only with the HTML
 * entity tables. Instead {@link decodeXmlEntities} runs as the `tagValueProcessor`
 * and `attributeValueProcessor`, resolving exactly the five predefined entities and
 * numeric character references. fast-xml-parser also passes CDATA content through
 * `tagValueProcessor`, so a reference written inside a CDATA section would decode
 * too; none of the five feeds uses CDATA.
 *
 * `removeNSPrefix: true` gives one uniform, unprefixed read layer across both feed
 * families. Real GLEIF golden-copy and delta files are namespace-prefixed
 * throughout — every element carries `lei:` (LEI-CDF) or `rr:` (RR-CDF), inner
 * fields included (`<lei:LegalName>`, `<lei:Entity>`, `<rr:NodeID>`) — while the
 * four sanctions feeds use default namespaces with no element prefix. Stripping the
 * prefix at parse time lets every ingester read plain element names (`LegalName`,
 * `Entity`, `NodeID`) regardless of source; without it the GLEIF reads miss every
 * prefixed inner field and normalize to empty records. `removeNSPrefix` also strips
 * attribute-name prefixes (GLEIF's `xml:lang` → `lang`) — harmless here: the
 * sanctions ingesters read only unprefixed attribute names (`@_FixedRef`,
 * `@_wholeName`, …), so their reads are untouched, and no ingester reads `xml:lang`.
 * @module services/screening/xml
 */

import { XMLParser } from 'fast-xml-parser';

/** The five entities XML predefines. A `Map`, so `&constructor;` finds nothing. */
const PREDEFINED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/**
 * One entity or character reference. Each match starts at an `&` and its digits or
 * letters can never cross another `&`, so a scan costs time linear in the input
 * however many references start and never finish.
 */
const REFERENCE = /&(?:#([0-9]+)|#x([0-9A-Fa-f]+)|([A-Za-z]+));/g;

/** Whether a code point is an XML `Char` — the only ones a character reference may name. */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/**
 * Decode the predefined entities and numeric character references in one left-to-
 * right pass, so `&amp;lt;` becomes `&lt;` and goes no further. Anything else stays
 * literal: an unknown name (`&nbsp;`), a reference outside the XML `Char` range
 * (`&#0;`, `&#xD800;`), or an unterminated one.
 */
function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(REFERENCE, (ref, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return PREDEFINED_ENTITIES.get(name) ?? ref;
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
    return isXmlChar(cp) ? String.fromCodePoint(cp) : ref;
  });
}

/**
 * Shared parser instance. `fast-xml-parser` is stateless across `parse` calls,
 * so one instance is reused for every source.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Entities are decoded by the value processors below, not by the parser's own
  // entity support — see the file overview.
  processEntities: false,
  tagValueProcessor: (_tagName: string, value: string) => decodeXmlEntities(value),
  attributeValueProcessor: (_attrName: string, value: string) => decodeXmlEntities(value),
  // Strip `lei:`/`rr:` namespace prefixes at parse time so GLEIF's fully-prefixed
  // elements and the sanctions feeds' default-namespace elements both read as plain
  // names. Also strips attribute prefixes (`xml:lang` → `lang`), which no ingester reads.
  removeNSPrefix: true,
  // Keep numeric-looking ids (LEIs, entry ids) as strings — they are opaque
  // identifiers, not numbers, and downstream code treats them as text.
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

/**
 * Parse an XML document string into a plain object, preserving attributes under
 * the `@_` prefix. Synchronous — `fast-xml-parser` is a direct dependency, so
 * there is no lazy-load step.
 *
 * @template T Expected shape of the parsed document.
 * @param xml Raw XML string.
 * @returns The parsed document.
 */
export function parseXml<T = Record<string, unknown>>(xml: string): T {
  return parser.parse(xml) as T;
}
