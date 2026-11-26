/**
 * @fileoverview Reads `content[]` Markdown back the way a client renders it, so a
 * test can assert that an upstream value survives as text: escapes removed,
 * entities decoded, and no heading, list, quote, emphasis, link, or HTML that the
 * value itself introduced. Parses with markdown-it's default preset (CommonMark
 * plus GFM tables and strikethrough) with raw HTML enabled, as chat clients do.
 * @module tests/tools/_markdown-readback
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core';
import markdownit, { type Token } from 'markdown-it';
import { expect } from 'vitest';

const md = markdownit('default', { html: true });

/** Container blocks recorded on each leaf, outermost first. */
const CONTAINERS = new Set(['bullet_list', 'ordered_list', 'blockquote', 'table']);

/** Blocks whose inline content becomes one {@link ReadBlock}. */
const LEAVES = new Set(['paragraph', 'heading', 'th', 'td']);

/** One leaf block as a reader sees it. */
export interface ReadBlock {
  /** Enclosing containers, outermost first (`bullet_list`, `ordered_list`, `blockquote`, `table`). */
  containers: string[];
  /** `paragraph`, `heading`, `th`, `td`, `fence`, `code_block`, `html_block`, or `hr`. */
  kind: string;
  /** The destination of each link and the source of each image in the block, in order, percent-decoded. */
  links: string[];
  /**
   * Inline constructs in the block other than plain text and line breaks, in
   * order: `code_inline`, `html_inline`, `image`, and the opening token of each
   * span (`em`, `strong`, `s`, `link`).
   */
  marks: string[];
  /** The HTML tag: `h1`–`h6` for a heading, `p` for a paragraph. */
  tag: string;
  /** The rendered text: escapes removed, entities decoded, code spans as their content, a line break as `\n`. */
  text: string;
}

function readInline(children: readonly Token[]): Pick<ReadBlock, 'links' | 'marks' | 'text'> {
  let text = '';
  const marks: string[] = [];
  const links: string[] = [];
  for (const child of children) {
    switch (child.type) {
      case 'text':
        text += child.content;
        break;
      case 'softbreak':
      case 'hardbreak':
        text += '\n';
        break;
      case 'code_inline':
      case 'html_inline':
        text += child.content;
        marks.push(child.type);
        break;
      case 'image':
        text += readInline(child.children ?? []).text;
        marks.push('image');
        links.push(md.normalizeLinkText(String(child.attrGet('src') ?? '')));
        break;
      default:
        if (child.type === 'link_open')
          links.push(md.normalizeLinkText(String(child.attrGet('href') ?? '')));
        if (child.nesting === 1) marks.push(child.type.replace(/_open$/, ''));
        else if (child.nesting === 0) marks.push(child.type);
    }
  }
  return { links, marks, text };
}

/** Every leaf block of `markdown`, in document order. */
export function readBlocks(markdown: string): ReadBlock[] {
  const blocks: ReadBlock[] = [];
  const containers: string[] = [];
  let leaf: { kind: string; tag: string } | undefined;
  for (const token of md.parse(markdown, {})) {
    const base = token.type.replace(/_(open|close)$/, '');
    if (token.nesting === 1 && CONTAINERS.has(base)) containers.push(base);
    else if (token.nesting === -1 && CONTAINERS.has(base)) containers.pop();
    else if (token.nesting === 1 && LEAVES.has(base)) leaf = { kind: base, tag: token.tag };
    else if (token.type === 'inline') {
      blocks.push({
        kind: leaf?.kind ?? 'inline',
        tag: leaf?.tag ?? '',
        containers: [...containers],
        ...readInline(token.children ?? []),
      });
      leaf = undefined;
    } else if (
      token.type === 'fence' ||
      token.type === 'code_block' ||
      token.type === 'html_block'
    ) {
      blocks.push({
        kind: token.type,
        tag: token.tag,
        containers: [...containers],
        text: token.content.replace(/\n$/, ''),
        links: [],
        marks: [],
      });
    } else if (token.type === 'hr') {
      blocks.push({
        kind: 'hr',
        tag: 'hr',
        containers: [...containers],
        text: '',
        links: [],
        marks: [],
      });
    }
  }
  return blocks;
}

/**
 * Upstream values that render as Markdown syntax unless escaped, one per
 * construct: a list marker, heading, quote, thematic break, emphasis, link,
 * inline HTML, entity, code span, strikethrough, table pipe, a trailing `#`, edge
 * whitespace, and a line break.
 */
const HOSTILE_VALUES: readonly string[] = [
  '7. Brigade',
  '- Alpha',
  '# Bravo',
  '> Charlie',
  '***',
  'Delta *Echo* _Foxtrot_',
  '[Golf](https://example.invalid)',
  '<b>Hotel</b>',
  'India &amp; Juliet',
  '`Kilo`',
  '~~Lima~~',
  'Mike | November',
  'Oscar #',
  ' Papa ',
  'Quebec\n- Romeo',
];

/** The text a reader sees, one leaf block per line. */
export function readText(markdown: string): string {
  return readBlocks(markdown)
    .map((block) => block.text)
    .join('\n');
}

/**
 * {@link HOSTILE_VALUES} plus each single-line one again at the start of a
 * continuation line.
 */
export const CONSTRUCT_VALUES: readonly string[] = [
  ...HOSTILE_VALUES,
  ...HOSTILE_VALUES.filter((value) => !value.includes('\n')).map((value) => `Lead\n${value}`),
];

/** Parse a payload against the tool's declared output schema, then render it. */
export function render(tool: AnyToolDefinition, payload: unknown): string {
  const parsed = tool.output.parse(payload);
  const blocks = tool.format?.(parsed as never) ?? [];
  return blocks.map((block) => ('text' in block ? (block.text ?? '') : '')).join('\n');
}

/** Fills one upstream string slot; a heading ends at a line break, so a heading slot holds one line. */
export type Fill = (slot?: 'heading') => string;

/** What a reader sees of a render beyond its text: each block's kind, tag, containers, and marks. */
const structureOf = (markdown: string) =>
  readBlocks(markdown).map(({ kind, tag, containers, marks }) => ({
    kind,
    tag,
    containers,
    marks,
  }));

/** `build` with a distinct plain marker in every slot, and the markers in fill order. */
function markerPayload(build: (fill: Fill) => unknown) {
  const markers: { heading: boolean; marker: string }[] = [];
  const payload = build((slot) => {
    const marker = `Xq${markers.length}qX`;
    markers.push({ marker, heading: slot === 'heading' });
    return marker;
  });
  return { markers, payload };
}

/** The marker payload with each marker replaced, rotating `values` across the slots from `offset`. */
function filled(
  { markers, payload }: ReturnType<typeof markerPayload>,
  values: readonly string[],
  offset: number,
) {
  const rawByMarker = new Map(
    markers.map(({ marker, heading }, slot) => {
      const value = values[(offset + slot) % values.length] ?? '';
      return [marker, heading ? value.replaceAll('\n', ' ') : value] as const;
    }),
  );
  return {
    payload: JSON.parse(JSON.stringify(payload), (_key, value: unknown) =>
      typeof value === 'string' ? (rawByMarker.get(value) ?? value) : value,
    ) as unknown,
    replace: (text: string) =>
      text.replace(/Xq\d+qX/g, (marker) => rawByMarker.get(marker) ?? marker),
  };
}

/**
 * Render `build` once with a distinct plain marker in every upstream slot, then
 * once per offset into `values`, rotated across the slots so every slot holds
 * every value beside changing neighbors. The marker render must show every
 * marker, since a slot `format()` never prints compares equal whatever it holds.
 * Each render must read back as the marker render with every marker replaced by
 * its raw value, in the same blocks, containers, and marks, while the output
 * schema (the structuredContent side) keeps the raw value.
 */
export function expectReadBack(
  tool: AnyToolDefinition,
  build: (fill: Fill) => unknown,
  values: readonly string[],
): void {
  const template = markerPayload(build);
  const templateText = render(tool, template.payload);
  const templateRead = readText(templateText);
  const unprinted = template.markers
    .map(({ marker }) => marker)
    .filter((marker) => !templateRead.includes(marker));
  expect(unprinted, `${tool.name}: filled slots the marker render never prints`).toEqual([]);
  for (let offset = 0; offset < values.length; offset++) {
    const { payload, replace } = filled(template, values, offset);
    const label = `${tool.name}, slot 0 holding ${JSON.stringify(values[offset])}`;
    const text = render(tool, payload);

    expect(readText(text), label).toBe(replace(templateRead));
    expect(structureOf(text), label).toEqual(structureOf(templateText));
    expect(tool.output.parse(payload), label).toEqual(payload);
  }
}

/** Values with nothing to escape render as the template with each value put in raw, byte for byte. */
export function expectByteIdentical(
  tool: AnyToolDefinition,
  build: (fill: Fill) => unknown,
  values: readonly string[],
): void {
  const template = markerPayload(build);
  const templateText = render(tool, template.payload);
  for (let offset = 0; offset < values.length; offset++) {
    const { payload, replace } = filled(template, values, offset);
    expect(render(tool, payload)).toBe(replace(templateText));
  }
}
