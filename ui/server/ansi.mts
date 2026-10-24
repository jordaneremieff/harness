/** Splits tool output into plain text and the colour sequences worth keeping. Only SGR (ESC [ ... m) survives; every other escape, control and backspace or carriage-return trick is removed or applied. */
export type AnsiItem = {t: 'text'; v: string} | {t: 'sgr'; v: string};
const ESC = '\x1b';
const C1: Record<string, string> = {'\u009b': `${ESC}[`, '\u009d': `${ESC}]`, '\u0090': `${ESC}P`, '\u0098': `${ESC}X`, '\u009e': `${ESC}^`, '\u009f': `${ESC}_`, '\u009c': `${ESC}\\`};
const SGR_PARAMS = /^[0-9;]{0,96}$/;
/** Index after a string-terminated sequence that starts at `from`; an unterminated one ends at its line. */
function stringEnd(source: string, from: number, bell: boolean): number {
  for (let at = from; at < source.length; at++) {
    const char = source[at];
    if (char === '\n') return at;
    if (bell && char === '\x07') return at + 1;
    if (char === ESC && source[at + 1] === '\\') return at + 2;
  }
  return source.length;
}
type Escape = {next: number; sgr?: string};
const inRange = (value: string | undefined, low: number, high: number): boolean => value !== undefined && value.charCodeAt(0) >= low && value.charCodeAt(0) <= high;
const upTo = (source: string, from: number, mask: number): number => { let end = from; while (end < source.length && (source.charCodeAt(end) & 0xf0) === mask) end++; return end; };
function readCsi(source: string, at: number): Escape {
  const paramsEnd = upTo(source, at + 2, 0x30), end = upTo(source, paramsEnd, 0x20);
  const params = source.slice(at + 2, paramsEnd), finalByte = source[end];
  if (finalByte === undefined) return {next: source.length}; // An unterminated sequence at the end is dropped.
  if (!inRange(finalByte, 0x40, 0x7e)) return {next: at + 2};
  const colour = finalByte === 'm' && end === paramsEnd && SGR_PARAMS.test(params);
  return colour ? {next: end + 1, sgr: `${ESC}[${params}m`} : {next: end + 1};
}
/** Reads the escape sequence that starts at `at`; only SGR comes back as text to keep. */
function readEscape(source: string, at: number): Escape {
  const next = source[at + 1];
  if (next === '[') return readCsi(source, at);
  if (next !== undefined && ']P_^X'.includes(next)) return {next: stringEnd(source, at + 2, next === ']')};
  if (inRange(next, 0x20, 0x2f)) { const end = upTo(source, at + 1, 0x20); return {next: end < source.length ? end + 1 : end}; }
  return {next: at + (inRange(next, 0x30, 0x7e) ? 2 : 1)};
}
/** Output builder: carriage return keeps the colour state and rewrites the line, backspace erases within a line. */
class Builder {
  items: AnsiItem[] = []; private buffer = ''; private lineStart = 0;
  flush(): void { if (this.buffer) { this.items.push({t: 'text', v: this.buffer}); this.buffer = ''; } }
  text(char: string): void { this.buffer += char; }
  sgr(value: string): void { this.flush(); this.items.push({t: 'sgr', v: value}); }
  newline(): void { this.buffer += '\n'; this.flush(); this.lineStart = this.items.length; }
  carriageReturn(): void {
    this.flush(); const kept = this.items.slice(this.lineStart).filter(item => item.t === 'sgr');
    this.items.splice(this.lineStart, this.items.length - this.lineStart, ...kept);
  }
  backspace(): void {
    this.flush();
    for (let back = this.items.length - 1; back >= this.lineStart; back--) {
      const item = this.items[back] as AnsiItem;
      if (item.t === 'text' && item.v) { item.v = [...item.v].slice(0, -1).join(''); return; }
    }
  }
}
const keeps = (char: string): boolean => char === '\t' || (char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f);
export function tokenizeAnsi(input: string): AnsiItem[] {
  const source = input.replace(/[\u0080-\u009f]/g, char => C1[char] ?? '');
  const out = new Builder();
  for (let at = 0; at < source.length;) {
    const char = source[at] as string;
    if (char === ESC) { const seq = readEscape(source, at); if (seq.sgr) out.sgr(seq.sgr); at = seq.next; continue; }
    if (char === '\r' && source[at + 1] !== '\n') out.carriageReturn();
    else if (char === '\b') out.backspace();
    else if (char === '\n') out.newline();
    else if (keeps(char)) out.text(char);
    at++;
  }
  out.flush(); return out.items.filter(item => item.v !== '');
}
export const plainOf = (items: readonly AnsiItem[]): string => items.map(item => item.t === 'text' ? item.v : '').join('');
export const ansiOf = (items: readonly AnsiItem[]): string => items.map(item => item.v).join('');
/** Keeps the first `chars` UTF-16 units of plain text and every colour sequence before the cut. */
export function cutAnsi(items: readonly AnsiItem[], chars: number): string {
  let left = Math.max(0, chars); let out = '';
  for (const item of items) {
    if (item.t === 'sgr') { out += item.v; continue; }
    if (left <= 0) break;
    if (item.v.length <= left) { out += item.v; left -= item.v.length; continue; }
    let take = left; const high = item.v.charCodeAt(take - 1); if (high >= 0xd800 && high <= 0xdbff) take--;
    out += item.v.slice(0, take); left = 0;
  }
  return out;
}
