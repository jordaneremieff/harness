import { composerSyntax, DECORATION_SPANS } from './composer-syntax.ts';
import { HIGHLIGHT_BYTES, HIGHLIGHT_LINES, languageFromPath, tokenRanges, type TokenRange } from './highlight.ts';

export const FILE_SYNTAX_BYTES = HIGHLIGHT_BYTES;
export const FILE_SYNTAX_LINES = HIGHLIGHT_LINES;
export const FILE_SYNTAX_SPANS = 16_384;
type Fence = {char: string; length: number};

function lineMarker(line: string, offset: number): TokenRange | undefined {
  const rule = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|=+[ \t]*)\r?$/.exec(line);
  if (rule) return {start: offset, end: offset + line.trimEnd().length, tone: 'punct'};
  const heading = /^ {0,3}(#{1,6})(?:[ \t]+|\r?$)/.exec(line);
  if (heading) return {start: offset, end: offset + heading[0].trimEnd().length, tone: 'keyword'};
  const marker = /^ {0,3}(?:>[ \t]?|[-+*][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)/.exec(line);
  return marker ? {start: offset, end: offset + marker[0].length, tone: 'punct'} : undefined;
}

function destinationEnd(line: string, start: number): number | undefined {
  let at = start + 1; let depth = 1;
  while (at < line.length && depth) {
    const next = line.charAt(at++);
    if (next === '\\') at++;
    else if (next === '(') depth++;
    else if (next === ')') depth--;
  }
  return depth ? undefined : at;
}
/** One monotonic pass finds balanced inline destinations, including escaped delimiters. */
function linkDestinations(line: string, offset: number): TokenRange[] {
  const ranges: TokenRange[] = []; let label = false; let at = 0;
  while (at < line.length) {
    const char = line.charAt(at++);
    if (char === '\\') {at++; continue;}
    if (char === '[') {label = true; continue;}
    if (char !== ']' || !label) continue;
    label = false; if (line.charAt(at) !== '(') continue;
    const end = destinationEnd(line, at); if (end === undefined) break;
    ranges.push({start: offset + at, end: offset + end, tone: 'string'}); at = end;
  }
  return ranges;
}

class MarkdownScanner {
  readonly base: TokenRange[];
  readonly ranges: TokenRange[] = [];
  private blocked = 0;
  private fence?: Fence;
  constructor(base: TokenRange[]) {this.base = base;}
  private add(range: TokenRange): void {
    while (this.base[this.blocked] && (this.base[this.blocked]?.end ?? 0) <= range.start) this.blocked++;
    const block = this.base[this.blocked];
    if (!block || block.start >= range.end) this.ranges.push(range);
  }
  line(line: string, offset: number): boolean {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marks = delimiter?.[1] ?? '', label = delimiter?.[2] ?? '';
    if (this.fence) {
      if (marks[0] === this.fence.char && marks.length >= this.fence.length && !label.trim()) this.fence = undefined;
      return true;
    }
    if (delimiter && !(marks[0] === '`' && label.includes('`'))) {
      this.fence = {char: marks.charAt(0), length: marks.length}; return true;
    }
    if (/^(?: {4}|\t)/.test(line)) return true;
    const marker = lineMarker(line, offset); if (marker) this.add(marker);
    for (const range of linkDestinations(line, offset)) this.add(range);
    return this.base.length + this.ranges.length <= DECORATION_SPANS;
  }
}

/** Both inputs already use source order; merging never changes or reparses source bytes. */
function mergeRanges(base: TokenRange[], extra: TokenRange[]): TokenRange[] {
  const ranges: TokenRange[] = []; let left = 0; let right = 0;
  while (left < base.length || right < extra.length) {
    const a = base[left], b = extra[right];
    if (a && (!b || a.start <= b.start)) {ranges.push(a); left++;}
    else if (b) {ranges.push(b); right++;}
  }
  return ranges;
}
function markdownRanges(text: string): TokenRange[] | undefined {
  const base = composerSyntax(text); if (!base) return undefined;
  const scan = new MarkdownScanner(base); let offset = 0;
  for (const line of text.split('\n')) {
    if (!scan.line(line, offset)) return undefined;
    offset += line.length + 1;
  }
  return mergeRanges(base, scan.ranges);
}

/** Exact UTF-16 source ranges only. Unknown and over-budget files remain wholly undecorated. */
export function fileSyntaxRanges(path: string, text: string): TokenRange[] | undefined {
  const file = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (/\.(?:md|markdown)$/.test(file)) return markdownRanges(text);
  const language = languageFromPath(path);
  return language ? tokenRanges(text, language, FILE_SYNTAX_SPANS) : undefined;
}
