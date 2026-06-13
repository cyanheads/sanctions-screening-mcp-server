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
 * XML entry point the screening ingesters use. `processEntities: false` matches
 * the framework's safe default (no entity expansion on untrusted bulk input).
 * @module services/screening/xml
 */

import { XMLParser } from 'fast-xml-parser';

/**
 * Shared parser instance. `fast-xml-parser` is stateless across `parse` calls,
 * so one instance is reused for every source.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
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
