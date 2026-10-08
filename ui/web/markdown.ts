export type MarkdownInline =
  | { type: 'text'; text: string } | { type: 'code'; text: string }
  | { type: 'emphasis'; children: MarkdownInline[] } | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'link'; href: string; children: MarkdownInline[] } | { type: 'omitted'; label: string };
export type MarkdownBlock =
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'heading'; level: number; children: MarkdownInline[] }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownBlock[][] }
  | { type: 'quote'; children: MarkdownBlock[] }
  | { type: 'code'; text: string; language: string }
  | { type: 'table'; header: MarkdownInline[][]; rows: MarkdownInline[][][]; align: Alignment[] };
type Alignment = 'left' | 'center' | 'right' | null;
interface InlineRead { nodes: MarkdownInline[]; end: number }
interface BlockRead { block: MarkdownBlock; end: number }

export function safeLink(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}
function escaped(source: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && source.charAt(i) === '\\'; i--) count++;
  return count % 2 === 1;
}
function closing(source: string, token: string, start: number): number {
  for (let at = source.indexOf(token, start); at !== -1; at = source.indexOf(token, at + token.length)) {
    if (escaped(source, at) || /\s/.test(source.charAt(at - 1))) continue;
    if (token.length === 1 && source.charAt(at + 1) === token) continue;
    const nested = token.length === 2 && source.charAt(at + 2) === token.charAt(0) && source.slice(start, at).includes(token.charAt(0));
    return nested ? at + 1 : at;
  }
  return -1;
}
function recordPair(character: string, open: string, close: string, stack: number[], pairs: Map<number, number>, index: number): void {
  if (character === open) stack.push(index);
  if (character !== close) return;
  const start = stack.pop();
  if (start !== undefined) pairs.set(start, index);
}
function bracketPairs(source: string): ReadonlyMap<number, number> {
  const square: number[] = []; const round: number[] = []; const pairs = new Map<number, number>();
  for (let i = 0; i < source.length; i++) {
    const character = source.charAt(i);
    if (character === '\\') { i++; continue; }
    recordPair(character, '[', ']', square, pairs, i);
    recordPair(character, '(', ')', round, pairs, i);
  }
  return pairs;
}
function linkAt(source: string, start: number, pairs: ReadonlyMap<number, number>): { end: number; label: string; href: string | null } | null {
  const labelEnd = pairs.get(start) ?? -1;
  if (labelEnd < 0 || source.charAt(labelEnd + 1) !== '(') return null;
  const end = pairs.get(labelEnd + 1) ?? -1;
  if (end < 0) return null;
  const destination = source.slice(labelEnd + 2, end).trim();
  const value = /^(?:<([^<>]*)>|(\S+?))(?:\s+["'][\s\S]*["'])?$/.exec(destination);
  return { end: end + 1, label: source.slice(start + 1, labelEnd), href: value ? safeLink(value[1] ?? value[2] ?? '') : null };
}
function readEscape(source: string, i: number): InlineRead | null {
  if (source.charAt(i) !== '\\' || !/[\\`*{}[\]()#+\-.!_>|]/.test(source.charAt(i + 1))) return null;
  return { nodes: [{ type: 'text', text: source.charAt(i + 1) }], end: i + 2 };
}
function readCode(source: string, i: number): InlineRead | null {
  if (source.charAt(i) !== '`') return null;
  const run = /^`+/.exec(source.slice(i))?.[0] ?? '`';
  let end = source.indexOf(run, i + run.length);
  while (end >= 0 && (source.charAt(end - 1) === '`' || source.charAt(end + run.length) === '`')) end = source.indexOf(run, end + run.length);
  if (end < 0) return { nodes: [{ type: 'text', text: run }], end: i + run.length };
  let text = source.slice(i + run.length, end).replace(/\n/g, ' ');
  if (text.startsWith(' ') && text.endsWith(' ') && text.trim()) text = text.slice(1, -1);
  return { nodes: [{ type: 'code', text }], end: end + run.length };
}
function readReferenceImage(source: string, i: number, pairs: ReadonlyMap<number, number>): InlineRead | null {
  const end = pairs.get(i + 1) ?? -1;
  if (end < 0) return null;
  let after = end + 1;
  if (source.charAt(after) === '[') {
    const reference = pairs.get(after) ?? -1;
    if (reference >= 0) after = reference + 1;
  }
  return { nodes: [{ type: 'omitted', label: `Image omitted: ${source.slice(i + 2, end)}` }], end: after };
}
function readLink(source: string, i: number, depth: number, pairs: ReadonlyMap<number, number>): InlineRead | null {
  const image = source.charAt(i) === '!' && source.charAt(i + 1) === '[';
  if (!image && source.charAt(i) !== '[') return null;
  const link = linkAt(source, i + (image ? 1 : 0), pairs);
  if (!link) return image ? readReferenceImage(source, i, pairs) : null;
  if (image) return { nodes: [{ type: 'omitted', label: `Image omitted${link.label ? `: ${link.label}` : ''}` }], end: link.end };
  const children = parseInline(link.label, depth + 1);
  return { nodes: link.href ? [{ type: 'link', href: link.href, children }] : children, end: link.end };
}
function readHtml(source: string, i: number): InlineRead | null {
  if (source.charAt(i) !== '<') return null;
  const end = source.indexOf('>', i + 1);
  return end < 0 ? null : { nodes: [{ type: 'text', text: source.slice(i, end + 1) }], end: end + 1 };
}
function readEmphasis(source: string, i: number, depth: number): InlineRead | null {
  const marker = source.charAt(i);
  if (marker !== '*' && marker !== '_') return null;
  if (!source.charAt(i + 1) || /\s/.test(source.charAt(i + 1))) return null;
  if (marker === '_' && /[\p{L}\p{N}]/u.test(source.charAt(i - 1))) return null;
  const token = source.charAt(i + 1) === marker ? marker + marker : marker;
  const end = closing(source, token, i + token.length);
  if (end <= i + token.length) return null;
  return { nodes: [{ type: token.length === 2 ? 'strong' : 'emphasis', children: parseInline(source.slice(i + token.length, end), depth + 1) }], end: end + token.length };
}
function appendInline(nodes: MarkdownInline[], additions: MarkdownInline[]): void {
  for (const node of additions) {
    const last = nodes.at(-1);
    if (last?.type === 'text' && node.type === 'text') last.text += node.text;
    else nodes.push(node);
  }
}
/** The AST contains no HTML node and no executable or relative URL. */
export function parseInline(source: string, depth = 0): MarkdownInline[] {
  if (depth >= 16) return [{ type: 'text', text: source }];
  const nodes: MarkdownInline[] = [];
  const pairs = bracketPairs(source); const lastGreater = source.lastIndexOf('>');
  let i = 0;
  while (i < source.length) {
    const read = readEscape(source, i) ?? readCode(source, i) ?? readLink(source, i, depth, pairs) ?? (i < lastGreater ? readHtml(source, i) : null) ?? readEmphasis(source, i, depth);
    appendInline(nodes, read?.nodes ?? [{ type: 'text', text: source.charAt(i) }]);
    i = read?.end ?? i + 1;
  }
  return nodes;
}
interface ListMarker { indent: number; ordered: boolean; start: number; text: string; width: number }
function listMarker(line: string): ListMarker | null {
  const match = /^( *)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
  if (!match) return null;
  const indent = match[1] ?? ''; const marker = match[2] ?? ''; const text = match[3] ?? '';
  return { indent: indent.length, ordered: /^\d/.test(marker), start: Number.parseInt(marker, 10) || 1, text, width: match[0].length - text.length };
}
function tableSource(line: string): string {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !escaped(text, text.length - 1)) text = text.slice(0, -1);
  return text;
}
function tableCells(line: string): string[] {
  const text = tableSource(line);
  const cells: string[] = []; let current = ''; let ticks = '';
  for (let i = 0; i < text.length; i++) {
    const character = text.charAt(i);
    if (character === '`' && !escaped(text, i)) {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? '`';
      ticks = ticks === run ? '' : ticks || run;
      current += run; i += run.length - 1; continue;
    }
    if (character === '|' && !escaped(text, i) && !ticks) { cells.push(current.trim()); current = ''; }
    else current += character;
  }
  cells.push(current.trim()); return cells;
}
function cellAlignment(cell: string): Alignment {
  if (cell.startsWith(':')) return cell.endsWith(':') ? 'center' : 'left';
  return cell.endsWith(':') ? 'right' : null;
}
function tableAlignment(line: string): Alignment[] | null {
  const cells = tableCells(line);
  return cells.length && cells.every(cell => /^:?-{3,}:?$/.test(cell)) ? cells.map(cellAlignment) : null;
}
function lineAt(lines: string[], i: number): string { return lines[i] ?? ''; }
function startsBlock(line: string): boolean {
  return /^\s*$/.test(line) || /^ {0,3}(?:#{1,6}\s|>|`{3,}|~{3,})/.test(line) || !!listMarker(line);
}
function readFence(lines: string[], i: number): BlockRead | null {
  const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lineAt(lines, i));
  if (!fence) return null;
  const marker = fence[1] ?? '```';
  const language = (fence[2] ?? '').trim().split(/\s+/)[0] ?? '';
  const close = new RegExp(`^ {0,3}${marker.charAt(0)}{${marker.length},}\\s*$`);
  const body: string[] = []; let end = i + 1;
  while (end < lines.length && !close.test(lineAt(lines, end))) body.push(lineAt(lines, end++));
  return { block: { type: 'code', text: body.join('\n'), language }, end: end < lines.length ? end + 1 : end };
}
function readHeading(lines: string[], i: number): BlockRead | null {
  const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(lineAt(lines, i));
  if (heading) return { block: { type: 'heading', level: (heading[1] ?? '#').length, children: parseInline((heading[2] ?? '').replace(/\s+#+\s*$/, '')) }, end: i + 1 };
  const next = lineAt(lines, i + 1);
  if (!next || !/^ {0,3}(?:=+|-+)\s*$/.test(next)) return null;
  return { block: { type: 'heading', level: next.trim().startsWith('=') ? 1 : 2, children: parseInline(lineAt(lines, i)) }, end: i + 2 };
}
function readQuote(lines: string[], i: number, depth: number): BlockRead | null {
  if (!/^ {0,3}>/.test(lineAt(lines, i))) return null;
  const body: string[] = []; let end = i;
  while (end < lines.length && /^ {0,3}>/.test(lineAt(lines, end))) body.push(lineAt(lines, end++).replace(/^ {0,3}> ?/, ''));
  return { block: { type: 'quote', children: parseMarkdown(body.join('\n'), depth + 1) }, end };
}
function blankListContinuation(lines: string[], i: number, indent: number): boolean {
  const look = lines[i + 1];
  if (look === undefined) return false;
  return !look.trim() || (look.match(/^ */)?.[0].length ?? 0) > indent;
}
function listItemBody(lines: string[], i: number, marker: ListMarker): { source: string; end: number } {
  const body = [marker.text]; let end = i + 1;
  while (end < lines.length) {
    const line = lineAt(lines, end); const upcoming = listMarker(line);
    if (upcoming && upcoming.indent <= marker.indent) break;
    if (!line.trim()) {
      if (!blankListContinuation(lines, end, marker.indent)) break;
      body.push(''); end++; continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= marker.indent) break;
    body.push(line.slice(Math.min(indent, marker.width))); end++;
  }
  return { source: body.join('\n'), end };
}
function readList(lines: string[], i: number, depth: number): BlockRead | null {
  const marker = listMarker(lineAt(lines, i));
  if (!marker) return null;
  const items: MarkdownBlock[][] = []; let end = i;
  while (end < lines.length) {
    const next = listMarker(lineAt(lines, end));
    if (!next || next.indent !== marker.indent || next.ordered !== marker.ordered) break;
    const body = listItemBody(lines, end, next); end = body.end;
    items.push(parseMarkdown(body.source, depth + 1));
    if (!lineAt(lines, end).trim() && listMarker(lineAt(lines, end + 1))?.indent === marker.indent) end++;
  }
  return { block: { type: 'list', ordered: marker.ordered, start: marker.start, items }, end };
}
function readTable(lines: string[], i: number): BlockRead | null {
  if (!lineAt(lines, i).includes('|')) return null;
  const align = tableAlignment(lineAt(lines, i + 1));
  if (!align) return null;
  const header = tableCells(lineAt(lines, i)).map(cell => parseInline(cell));
  if (header.length !== align.length) return null;
  const rows: MarkdownInline[][][] = []; let end = i + 2;
  while (end < lines.length && lineAt(lines, end).includes('|') && !startsBlock(lineAt(lines, end))) {
    const cells = tableCells(lineAt(lines, end++));
    rows.push(header.map((_, index) => parseInline(cells[index] ?? '')));
  }
  return { block: { type: 'table', header, rows, align }, end };
}
function readParagraph(lines: string[], i: number): BlockRead {
  const body = [lineAt(lines, i)]; let end = i + 1;
  while (end < lines.length && !startsBlock(lineAt(lines, end))) {
    if (lineAt(lines, end).includes('|') && tableAlignment(lineAt(lines, end + 1))) break;
    body.push(lineAt(lines, end++));
  }
  return { block: { type: 'paragraph', children: parseInline(body.join('\n')) }, end };
}
/** Parse only the supplied block/page. Unclosed fences remain inert code. */
export function parseMarkdown(source: string, depth = 0): MarkdownBlock[] {
  if (depth >= 16) return [{ type: 'paragraph', children: [{ type: 'text', text: source }] }];
  const lines = source.replace(/\r\n?/g, '\n').split('\n'); const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lineAt(lines, i).trim()) { i++; continue; }
    const read = readFence(lines, i) ?? readQuote(lines, i, depth) ?? readList(lines, i, depth) ?? readTable(lines, i) ?? readHeading(lines, i) ?? readParagraph(lines, i);
    blocks.push(read.block); i = read.end;
  }
  return blocks;
}
