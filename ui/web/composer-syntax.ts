import { tokenRanges, type TokenRange } from './highlight.ts';
export const DECORATION_BYTES = 16 * 1024;
export const DECORATION_LINES = 500;
export const DECORATION_SPANS = 2048;
type Fence = {char: string; length: number; language: string; body: number};
function inlineRanges(line: string, offset: number): TokenRange[] {
  const ranges: TokenRange[] = [], runs = [...line.matchAll(/`+/g)], next = new Map<number,number>(), closes:number[] = [];
  for (let i = runs.length - 1;i >= 0;i--) {
    const run = runs[i];if (!run) continue;closes[i] = next.get(run[0].length) ?? -1;next.set(run[0].length,i);
  }
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]; if (!open) continue;
    const close = closes[i] ?? -1;
    const match = runs[close]; if (!match || open.index === undefined || match.index === undefined) continue;
    ranges.push({start: offset + open.index, end: offset + match.index + match[0].length, tone: 'string'}); i = close;
  }
  return ranges;
}
function fenceBody(text: string, fence: Fence, end: number, ranges: TokenRange[]): boolean {
  if (end <= fence.body) return true;
  const tokens = tokenRanges(text.slice(fence.body, end), fence.language, DECORATION_SPANS - ranges.length);
  if (!tokens) return false;
  ranges.push(...tokens.map(range => ({...range, start: range.start + fence.body, end: range.end + fence.body}))); return true;
}
class SourceScanner {
  ranges: TokenRange[] = [];
  fence?: Fence;
  text: string;
  constructor(text: string) {this.text = text;}
  line(line: string, offset: number): boolean {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marks = delimiter?.[1] ?? '', label = delimiter?.[2] ?? '';
    if (this.fence) return this.closeFence(line, offset, marks, label);
    if (delimiter && !(marks[0] === '`' && label.includes('`'))) {
      this.ranges.push({start: offset, end: offset + line.length, tone: 'punct'});
      this.fence = {char: marks.charAt(0), length: marks.length, language: label.trim().split(/\s/)[0] ?? '', body: offset + line.length + 1};
    } else this.ranges.push(...inlineRanges(line, offset));
    return this.ranges.length <= DECORATION_SPANS;
  }
  private closeFence(line: string, offset: number, marks: string, label: string): boolean {
    const fence = this.fence; if (!fence) return true;
    if (marks[0] !== fence.char || marks.length < fence.length || label.trim()) return true;
    if (!fenceBody(this.text, fence, offset, this.ranges)) return false;
    this.ranges.push({start: offset, end: offset + line.length, tone: 'punct'}); this.fence = undefined;
    return this.ranges.length <= DECORATION_SPANS;
  }
}
/** Source offsets are UTF-16 ranges, so decoration never normalizes or serializes the draft. */
export function composerSyntax(text: string): TokenRange[] | undefined {
  if (text.length > DECORATION_BYTES || new TextEncoder().encode(text).length > DECORATION_BYTES) return undefined;
  const lines = text.split('\n'); if (lines.length > DECORATION_LINES) return undefined;
  const scan = new SourceScanner(text); let offset = 0;
  for (const line of lines) {if (!scan.line(line, offset)) return undefined; offset += line.length + 1;}
  if (scan.fence && !fenceBody(text, scan.fence, text.length, scan.ranges)) return undefined;
  return scan.ranges.length > DECORATION_SPANS ? undefined : scan.ranges;
}
