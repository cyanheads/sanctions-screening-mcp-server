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
 * Whitespace, a comment, or a processing instruction — what XML allows before the
 * root element. A comment or instruction body can never contain its own
 * terminator, so each one ends at the first terminator and a run of them splits
 * only one way. A lazy `[\s\S]*?` body could also stretch across its neighbours,
 * and a run that fails to match (a prolog still arriving) would then retry every
 * split: 20 comment/instruction pairs took seconds.
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

/** A section whose content is never markup, named by its terminator. */
type Section = '-->' | '?>' | ']]>';

/** XML whitespace: space, tab, line feed, carriage return. */
function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** How many leading characters of `terminator` the text ends with (a proper prefix only). */
function terminatorPrefixAtEnd(text: string, terminator: Section): number {
  for (let length = terminator.length - 1; length > 0; length -= 1) {
    if (text.endsWith(terminator.slice(0, length))) return length;
  }
  return 0;
}

/**
 * The forward scan behind {@link requireCompleteDocument}'s root-close check. It
 * reads the text after the root start tag once, chunk by chunk, and decides at the
 * end whether the root element closed with nothing but misc after it.
 *
 * Its state is a handful of scalars, so it retains no document text between
 * chunks: where it is (text, the characters after a `<`, the whitespace inside the
 * root end tag, or a comment / processing instruction / CDATA section), how much
 * of a marker or terminator split across a chunk boundary it has matched, and
 * whether the last root end tag outside a section has been followed only by
 * whitespace, comments, and processing instructions. Each step either reads one
 * character or jumps to the next `<` or terminator with `indexOf`, so the scan is
 * linear in the text, and no pattern runs over it.
 *
 * Depth is not tracked: a nested element of the root's own name closes, the scan
 * reads that close as the root's, and the document's real close, published after
 * it, supersedes it. What decides a document is its last root end tag.
 */
class RootCloseScan {
  /** The characters after `<` that open each tracked construct, the root end tag last. */
  private readonly markers: readonly [comment: string, cdata: string, pi: string, end: string];
  /** Where the scan is. */
  private mode: 'text' | 'markup' | 'end-tag' | 'section' = 'text';
  /** In `markup`: the characters after the `<` matched so far. */
  private matched = 0;
  /** In `markup`: one bit per entry of {@link markers} still matching. */
  private candidates = 0;
  /** In `section`: the terminator that ends it. */
  private terminator: Section = '-->';
  /** In `section`: how much of the terminator the text read so far ends with. */
  private terminatorMatched = 0;
  /** The last root end tag outside a section has been followed only by misc. */
  private closed: boolean;

  /**
   * @param rootName The root element's qualified name.
   * @param selfClosing The root start tag closed itself, so the root is already
   *   closed and only misc may follow it.
   */
  constructor(rootName: string, selfClosing: boolean) {
    this.markers = ['!--', '![CDATA[', '?', `/${rootName}`];
    this.closed = selfClosing;
  }

  /** Read the next piece of the document. */
  push(text: string): void {
    let at = 0;
    while (at < text.length) {
      switch (this.mode) {
        case 'text':
          at = this.scanText(text, at);
          break;
        case 'markup':
          at = this.scanMarkup(text, at);
          break;
        case 'end-tag':
          at = this.scanEndTag(text, at);
          break;
        case 'section':
          at = this.scanSection(text, at);
          break;
      }
    }
  }

  /** True when the text read so far ends a complete document. */
  complete(): boolean {
    return this.mode === 'text' && this.closed;
  }

  /** Outside markup: after a root close only whitespace keeps it live. Moves to the next `<`. */
  private scanText(text: string, from: number): number {
    let at = from;
    if (this.closed) {
      while (at < text.length && isXmlSpace(text.charCodeAt(at))) at += 1;
      if (at === text.length) return at;
      if (text[at] !== '<') this.closed = false; // text after the root close
    }
    const open = text.indexOf('<', at);
    if (open === -1) return text.length;
    this.mode = 'markup';
    this.matched = 0;
    this.candidates = 0b1111;
    return open + 1;
  }

  /**
   * After a `<`: narrow the tracked markers by one character. A character no
   * marker continues with starts an element, another end tag, or a declaration —
   * none of them misc, so it ends a live root close — and is read again as text.
   */
  private scanMarkup(text: string, at: number): number {
    const char = text[at];
    let candidates = 0;
    let completed = -1;
    this.markers.forEach((marker, index) => {
      if ((this.candidates & (1 << index)) === 0 || marker[this.matched] !== char) return;
      candidates |= 1 << index;
      if (marker.length === this.matched + 1) completed = index;
    });
    if (candidates === 0) {
      this.closed = false;
      this.mode = 'text';
      return at;
    }
    this.matched += 1;
    this.candidates = candidates;
    switch (completed) {
      case 0:
        this.enterSection('-->');
        break;
      case 1:
        this.closed = false; // CDATA is character data, not misc
        this.enterSection(']]>');
        break;
      case 2:
        this.enterSection('?>');
        break;
      case 3:
        this.mode = 'end-tag';
        break;
    }
    return at + 1;
  }

  /**
   * After `</root`: whitespace, then `>`, closes the root. Any other character —
   * a longer name, or a token inside the tag — makes it some other tag, and is
   * read again as text.
   */
  private scanEndTag(text: string, at: number): number {
    if (isXmlSpace(text.charCodeAt(at))) return at + 1;
    this.mode = 'text';
    this.closed = text[at] === '>';
    return this.closed ? at + 1 : at;
  }

  private enterSection(terminator: Section): void {
    this.mode = 'section';
    this.terminator = terminator;
    this.terminatorMatched = 0;
  }

  /**
   * Inside a comment, processing instruction, or CDATA section: move past its
   * terminator. A terminator split across a chunk boundary is completed from the
   * matched count — the characters carried are the terminator's own prefix, not
   * document text.
   */
  private scanSection(text: string, from: number): number {
    const terminator = this.terminator;
    const lookahead = terminator.length - 1;
    if (this.terminatorMatched > 0) {
      const carried = this.terminatorMatched;
      const joined = terminator.slice(0, carried) + text.slice(from, from + lookahead);
      const end = joined.indexOf(terminator);
      if (end !== -1) {
        this.mode = 'text';
        return from + end + terminator.length - carried;
      }
      if (text.length - from < lookahead) {
        // The piece ended inside the lookahead: carry what the joined text ends with.
        this.terminatorMatched = terminatorPrefixAtEnd(joined, terminator);
        return text.length;
      }
      this.terminatorMatched = 0;
    }
    const end = text.indexOf(terminator, from);
    if (end !== -1) {
      this.mode = 'text';
      return end + terminator.length;
    }
    this.terminatorMatched = terminatorPrefixAtEnd(
      text.slice(Math.max(from, text.length - lookahead)),
      terminator,
    );
    return text.length;
  }
}

/**
 * Pass a decoded document through unchanged, then fail if it ended before its
 * root element closed. A transfer can end cleanly at the transport and still be
 * cut short — a proxy or origin that closes a response mid-document, with no
 * length mismatch for the client to notice — and {@link scanRecordFragments}
 * then yields every record before the cut and ends normally. Without this check
 * a truncated document is indistinguishable from a complete one that published
 * fewer records.
 *
 * The root is learned from the prolog, and the rest of the document passes
 * through a {@link RootCloseScan}. A document is complete when its last root end
 * tag outside a comment, processing instruction, or CDATA section is followed by
 * nothing but whitespace, comments, and processing instructions, of any length,
 * and the stream does not end inside one of them. A self-closing root is a
 * complete, empty document on the same terms.
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
  let root: { name: string; scan: RootCloseScan } | undefined;
  for await (const chunk of textChunks) {
    if (root) {
      root.scan.push(chunk);
    } else {
      head += chunk;
      const match = ROOT_START_TAG.exec(head);
      if (match) {
        const name = match[1] as string;
        root = { name, scan: new RootCloseScan(name, match[2] === '/') };
        root.scan.push(head.slice(match[0].length));
        head = '';
      } else if (head.length > MAX_ROOT_SEARCH) {
        throw serviceUnavailable(
          `${label} did not open an XML root element in its first ${MAX_ROOT_SEARCH} characters — not the expected document.`,
        );
      }
    }
    yield chunk;
  }
  if (!root) {
    throw serviceUnavailable(`${label} ended before its XML root element opened.`);
  }
  if (!root.scan.complete()) {
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
