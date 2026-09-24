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
 * reads: GLEIF `<LEIRecord>` / `<RelationshipRecord>`, OFAC `<Location>` /
 * `<IDRegDocument>` / `<DistinctParty>` / `<SanctionsEntry>` / `<sdnEntry>`, EU
 * `<sanctionEntity>`, UK `<Designation>`, and UN `<INDIVIDUAL>` / `<ENTITY>`.
 * A name that only prefixes a record name (OFAC's `<LocationCountry>`,
 * `<LocationPart>`, `<IDRegDocumentReference>`) never matches it — see
 * {@link scanRecordFragments}.
 *
 * A record scan cannot tell a complete document from a truncated one: it drops a
 * record whose closing tag never arrives and ends normally. {@link
 * requireCompleteDocument} is the check that can — it confirms the document's
 * root element closed.
 * @module services/screening/xml-stream
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

/**
 * Max characters the record scanner retains between records when no open tag is
 * buffered — enough to reassemble a record's open tag split across a chunk
 * boundary, bounded so a long inter-record region (OFAC `SDN_ADVANCED.XML`
 * publishes ~1.9 MB of `<ProfileRelationships>` between its last party and its
 * first programme entry) can't grow the buffer unboundedly.
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
 * Whitespace, a comment, or a processing instruction — what XML allows around the
 * root element. A comment or instruction body can never contain its own
 * terminator, so each one ends at the first terminator and a run of them splits
 * only one way. A lazy `[\s\S]*?` body could also stretch across its neighbours,
 * and a run that fails to match (a prolog still arriving, an epilog cut short)
 * would then retry every split: 20 comment/instruction pairs took seconds.
 */
const MISC = String.raw`\s|<!--(?:(?!-->)[\s\S])*-->|<\?(?:(?!\?>)[\s\S])*\?>`;

/**
 * The document's root start tag: the first element after the prolog (XML
 * declaration, processing instructions, comments, a DOCTYPE with or without an
 * internal subset). Captures the qualified name and a `/` when self-closing. A
 * byte-order mark is already gone — {@link decodeUtf8Stream} strips it — and
 * would match `\s` if it were not.
 */
const ROOT_START_TAG = new RegExp(
  String.raw`^(?:${MISC}|<!DOCTYPE[^[>]*(?:\[(?:(?!\]\s*>)[\s\S])*\])?\s*>)*<([A-Za-z_][\w.:-]*)(?:\s[^>]*?)?(\/?)>`,
);

/**
 * How far into a stream the root start tag must appear. Every source's prolog is
 * a few hundred bytes; a body that has not opened an element by this point is
 * not the document (an error page in another format), and the bound keeps the
 * buffered head from growing with it.
 */
const MAX_ROOT_SEARCH = 65_536;

/**
 * Characters of the stream's end kept for the root-close check — room for the
 * closing tag plus trailing whitespace and comments.
 */
const COMPLETION_TAIL = 4096;

/**
 * Pass a decoded document through unchanged, then fail if it ended before its
 * root element closed. A transfer can end cleanly at the transport and still be
 * cut short — a proxy or origin that closes a response mid-document, with no
 * length mismatch for the client to notice — and {@link scanRecordFragments}
 * then yields every record before the cut and ends normally. Without this check
 * a truncated document is indistinguishable from a complete one that published
 * fewer records.
 *
 * The root is learned from the prolog; a self-closing root is a complete, empty
 * document. Trailing whitespace, comments, and processing instructions after the
 * root close are allowed, as XML permits.
 *
 * @param textChunks Decoded document text, in arrival order.
 * @param label Names the document in the error (the source code).
 * @throws ServiceUnavailable when the stream ends before the root element opens
 *   or closes.
 */
export async function* requireCompleteDocument(
  textChunks: AsyncIterable<string>,
  label: string,
): AsyncGenerator<string> {
  let head = '';
  let root: { name: string; selfClosing: boolean } | undefined;
  let tail = '';
  for await (const chunk of textChunks) {
    if (!root) {
      head += chunk;
      const match = ROOT_START_TAG.exec(head);
      if (match) {
        root = { name: match[1] as string, selfClosing: match[2] === '/' };
        head = '';
      } else if (head.length > MAX_ROOT_SEARCH) {
        throw serviceUnavailable(
          `${label} did not open an XML root element in its first ${MAX_ROOT_SEARCH} characters — not the expected document.`,
        );
      }
    }
    tail = (tail + chunk).slice(-COMPLETION_TAIL);
    yield chunk;
  }
  if (!root) {
    throw serviceUnavailable(`${label} ended before its XML root element opened.`);
  }
  if (root.selfClosing) return;
  const name = root.name.replace(/[.]/g, '\\.');
  const closed = new RegExp(String.raw`</${name}\s*>(?:${MISC})*$`);
  if (!closed.test(tail)) {
    throw serviceUnavailable(
      `${label} document ended before its closing </${root.name}> tag — the transfer was truncated.`,
    );
  }
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
