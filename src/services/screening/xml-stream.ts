/**
 * @fileoverview Streaming XML primitives shared by the sanctions and GLEIF
 * ingesters: a UTF-8 stream decoder and a byte-level record-boundary scanner.
 *
 * `fast-xml-parser` publishes no incremental parser — its 5.x exports are
 * `XMLParser`, `XMLValidator`, and `XMLBuilder`, and `XMLParser.parse()` takes a
 * whole string. Bounding an ingest against a 120 MiB source document therefore
 * has exactly one available shape: scan the decoded text for complete
 * `<Record>…</Record>` fragments and hand each fragment to the real parser. Every
 * record still goes through {@link parseXml}, so a streamed parse and a buffered
 * whole-document parse normalize identically.
 *
 * ASSUMPTION (load-bearing): the scanned record elements are FLAT repeating
 * siblings — a record never nests inside another record of the same name and
 * carries no same-named descendant. That flatness is what lets a text-level tag
 * scan stand in for a streaming parser. It holds for every source this server
 * reads: GLEIF `<LEIRecord>` / `<RelationshipRecord>`, OFAC `<DistinctParty>` /
 * `<SanctionsEntry>` / `<sdnEntry>`, EU `<sanctionEntity>`, UK `<Designation>`,
 * and UN `<INDIVIDUAL>` / `<ENTITY>`.
 * @module services/screening/xml-stream
 */

/**
 * Max characters the record scanner retains between records when no open tag is
 * buffered — enough to reassemble a record's open tag split across a chunk
 * boundary, bounded so a long inter-record region (OFAC publishes ~600 KB of
 * `<Locations>` before its first party) can't grow the buffer unboundedly.
 */
const MAX_RETAINED_TAIL = 4096;

/** One complete record element lifted out of a text stream. */
export interface RecordFragment {
  /** The record's local element name, namespace prefix stripped. */
  name: string;
  /** The full `<Name …>…</Name>` source text, ready for {@link parseXml}. */
  xml: string;
}

/**
 * Decode a byte stream as UTF-8, honoring multi-byte characters split across
 * chunk boundaries via the streaming `TextDecoder`. The decoder stays lossy on
 * purpose — a `fatal: true` decoder would abort a multi-GB ingest over one
 * undecodable byte. Text that decoded to U+FFFD is rejected per record instead,
 * by the shared name predicate in `ingest-validation`.
 */
export async function* decodeUtf8Stream(
  byteChunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of byteChunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/**
 * Scan a decoded-text stream for complete `<recordName>…</recordName>`
 * fragments, buffering across chunk boundaries and yielding each with the local
 * element name that matched.
 *
 * Matches unprefixed and namespace-prefixed (`lei:` / `rr:`) tags. The boundary
 * lookahead requires the tag name to be followed by whitespace, `/`, or `>`, so
 * a plural container element never matches its own record name
 * (`<LEIRecords>` vs `<LEIRecord>`, `<SanctionsEntries>` vs `<SanctionsEntry>`,
 * `<DistinctParties>` vs `<DistinctParty>`).
 *
 * A record whose closing tag never arrives — a truncated document — is dropped
 * rather than emitted partially.
 *
 * @param textChunks Decoded source text, in arrival order.
 * @param recordNames Local element names to lift out, longest-first internally
 *   so a name that prefixes another still matches the longer one.
 */
export async function* scanRecordFragments(
  textChunks: AsyncIterable<string>,
  recordNames: readonly string[],
): AsyncGenerator<RecordFragment> {
  // Longest-first so an alternation like `Designation|Designations` cannot let a
  // shorter alternative win a position the longer one also matches.
  const alternation = [...recordNames].sort((a, b) => b.length - a.length).join('|');
  const openRe = new RegExp(`<((?:[A-Za-z][\\w.-]*:)?(?:${alternation}))(?=[\\s/>])`);
  let buf = '';
  for await (const chunk of textChunks) {
    buf += chunk;
    for (;;) {
      const open = openRe.exec(buf);
      if (!open) {
        // No open tag yet — retain only a short tail so an open tag split across
        // chunks still matches once the rest arrives.
        if (buf.length > MAX_RETAINED_TAIL) buf = buf.slice(buf.length - MAX_RETAINED_TAIL);
        break;
      }
      const qualifiedName = open[1] as string;
      const closeTag = `</${qualifiedName}>`;
      const closeIdx = buf.indexOf(closeTag, open.index + open[0].length);
      if (closeIdx === -1) {
        // Record not fully buffered — drop the pre-record prefix and read more.
        buf = buf.slice(open.index);
        break;
      }
      const end = closeIdx + closeTag.length;
      yield {
        name: qualifiedName.slice(qualifiedName.indexOf(':') + 1),
        xml: buf.slice(open.index, end),
      };
      buf = buf.slice(end);
    }
  }
}
