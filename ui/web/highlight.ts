import { element } from './dom.ts';

export const HIGHLIGHT_BYTES = 64 * 1024;
export const HIGHLIGHT_LINES = 2000;
const MAX_SPANS = 16_384;
export type Tone = 'keyword' | 'string' | 'number' | 'comment' | 'type' | 'fn' | 'punct';
type Family = 'script' | 'json' | 'shell' | 'python' | 'css' | 'markup' | 'config' | 'go' | 'rust' | 'diff';
const languages: Record<string, Family> = {
  ts: 'script', typescript: 'script', js: 'script', javascript: 'script', tsx: 'script', jsx: 'script', mjs: 'script', mts: 'script', json: 'json',
  sh: 'shell', bash: 'shell', zsh: 'shell', py: 'python', python: 'python', css: 'css', html: 'markup', xml: 'markup',
  yaml: 'config', yml: 'config', toml: 'config', go: 'go', rust: 'rust', rs: 'rust', diff: 'diff', patch: 'diff',
};
const words = (value: string): ReadonlySet<string> => new Set(value.split(' '));
const keywords: Record<Family, ReadonlySet<string>> = {
  script: words('as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return satisfies static super switch this throw true try type typeof undefined var void while with yield'),
  json: words('true false null'),
  shell: words('if then else elif fi case esac for while until do done in function select time coproc'),
  python: words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'),
  css: words('important inherit initial unset revert auto none'),
  markup: words('DOCTYPE'),
  config: words('true false null yes no on off'),
  go: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil'),
  rust: words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
  diff: new Set(),
};
const types = words('any bigint boolean bool byte char complex64 complex128 double error float float32 float64 int int8 int16 int32 int64 isize never number object rune short string symbol uint uint8 uint16 uint32 uint64 uintptr unknown usize u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 void');
const shellFunctions = words('echo printf cd pwd export source eval exec read set unset shift test return exit local alias unalias trap command builtin');
function letter(char: string): boolean {
  return !!char && ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_' || char === '$');
}
function digit(char: string): boolean { return !!char && char >= '0' && char <= '9'; }
function hex(char: string): boolean { return digit(char) || (!!char && ((char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F'))); }
function punctuation(char: string): boolean { return !!char && '{}[]();:,.=+-*/%!&|^~<>?@#\\'.includes(char); }
function familyFor(language?: string): Family | undefined {
  const name = language?.toLowerCase().trim() ?? '';
  return Object.hasOwn(languages, name) ? languages[name] : undefined;
}
export function languageFromPath(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  const file = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const extension = file.slice(file.lastIndexOf('.') + 1);
  return file.includes('.') && familyFor(extension) ? extension : undefined;
}

/** A monotonic cursor accounts for UTF-8 bytes and lines as it consumes source. */
class Scanner {
  at = 0;
  bytes = 0;
  lines = 1;
  exceeded = false;
  readonly text: string;
  constructor(text: string) { this.text = text; }
  char(offset = 0): string { return this.text.charAt(this.at + offset); }
  take(): void {
    const code = this.text.charCodeAt(this.at++);
    if (code < 0x80) this.bytes++;
    else if (code < 0x800) this.bytes += 2;
    else if (code >= 0xdc00 && code <= 0xdfff && this.at > 1 && this.text.charCodeAt(this.at - 2) >= 0xd800 && this.text.charCodeAt(this.at - 2) <= 0xdbff) this.bytes++;
    else this.bytes += 3;
    if (code === 10 || (code === 13 && this.char() !== '\n')) this.lines++;
    this.exceeded = this.bytes > HIGHLIGHT_BYTES || this.lines > HIGHLIGHT_LINES;
  }
  has(): boolean { return this.at < this.text.length && !this.exceeded; }
  consume(count: number): void { for (let i = 0; i < count && this.has(); i++) this.take(); }
}
function toLineEnd(scan: Scanner): void { while (scan.has() && scan.char() !== '\n') scan.take(); }
function delimited(scan: Scanner, open: string, close: string, escapes = false): void {
  scan.consume(open.length);
  while (scan.has()) {
    if (scan.text.startsWith(close, scan.at)) { scan.consume(close.length); return; }
    if (escapes && scan.char() === '\\') scan.consume(2); else scan.take();
  }
}
function comment(scan: Scanner, family: Family): boolean {
  if (family === 'markup' && scan.text.startsWith('<!--', scan.at)) { delimited(scan, '<!--', '-->'); return true; }
  if (['script', 'css', 'go', 'rust'].includes(family) && scan.text.startsWith('/*', scan.at)) { delimited(scan, '/*', '*/'); return true; }
  if (['script', 'go', 'rust'].includes(family) && scan.text.startsWith('//', scan.at)) { toLineEnd(scan); return true; }
  if (['shell', 'python', 'config'].includes(family) && scan.char() === '#') { toLineEnd(scan); return true; }
  return false;
}
function quoted(scan: Scanner, family: Family): boolean {
  const quote = scan.char();
  if (quote !== '"' && quote !== "'" && !(quote === '`' && ['script', 'shell', 'go'].includes(family))) return false;
  if (family === 'rust' && quote === "'" && scan.char(2) !== "'" && !(scan.char(1) === '\\' && scan.char(3) === "'")) return false;
  const delimiter = family === 'python' && scan.char(1) === quote && scan.char(2) === quote ? quote.repeat(3) : quote;
  delimited(scan, delimiter, delimiter, true); return true;
}
function numericDigits(scan: Scanner, radix = false): void {
  while (scan.has() && (scan.char() === '_' || (radix ? hex(scan.char()) : digit(scan.char())))) scan.take();
}
function exponent(scan: Scanner): void {
  if (scan.char() !== 'e' && scan.char() !== 'E') return;
  const sign = scan.char(1) === '+' || scan.char(1) === '-';
  if (!digit(scan.char(sign ? 2 : 1))) return;
  scan.consume(sign ? 2 : 1); numericDigits(scan);
}
function numeric(scan: Scanner): void {
  if (scan.char() === '0' && scan.char(1) && 'xXbBoO'.includes(scan.char(1))) {
    scan.consume(2); numericDigits(scan, true); return;
  }
  numericDigits(scan);
  if (scan.char() === '.' && digit(scan.char(1))) { scan.take(); numericDigits(scan); }
  exponent(scan);
}
function nextSign(scan: Scanner): string {
  let offset = 0;
  while (offset < 16 && (scan.char(offset) === ' ' || scan.char(offset) === '\t')) offset++;
  return scan.char(offset);
}
function wordCharacter(char: string, family: Family): boolean {
  return letter(char) || digit(char) || (char === '-' && ['css', 'config', 'markup'].includes(family));
}
function identifier(scan: Scanner, family: Family, tag: boolean): Tone | undefined {
  const start = scan.at;
  while (scan.has() && wordCharacter(scan.char(), family)) scan.take();
  return identifierTone(scan.text.slice(start, scan.at), scan, family, tag);
}
function identifierTone(word: string, scan: Scanner, family: Family, tag: boolean): Tone | undefined {
  if (family === 'markup') return tag ? 'type' : 'keyword';
  if (keywords[family].has(word)) return 'keyword';
  const next = nextSign(scan);
  if ((family === 'css' || family === 'config') && (next === ':' || next === '=')) return 'keyword';
  if (family === 'shell' && shellFunctions.has(word)) return 'fn';
  if (types.has(word) || (word.charAt(0) >= 'A' && word.charAt(0) <= 'Z')) return 'type';
  return next === '(' ? 'fn' : undefined;
}
type LexState = {inTag: boolean; tagName: boolean};
function markupToken(scan: Scanner, state: LexState): Tone | undefined {
  if (scan.char() === '<') { state.inTag = true; state.tagName = true; scan.take(); if (scan.char() === '/') scan.take(); return 'punct'; }
  if (scan.char() === '>') { state.inTag = false; state.tagName = false; scan.take(); return 'punct'; }
  if (!state.inTag) { while (scan.has() && scan.char() !== '<') scan.take(); return undefined; }
  return token(scan, 'markup', state);
}
function token(scan: Scanner, family: Family, state: LexState): Tone | undefined {
  if (comment(scan, family)) return 'comment';
  if (family === 'markup' && (!state.inTag || scan.char() === '>')) return markupToken(scan, state);
  if (quoted(scan, family)) return 'string';
  if (digit(scan.char())) { numeric(scan); return 'number'; }
  if (letter(scan.char())) { const tone = identifier(scan, family, state.tagName); state.tagName = false; return tone; }
  const char = scan.char(); scan.take();
  if (family === 'diff' && char === '@') return 'keyword';
  return punctuation(char) ? 'punct' : undefined;
}

export type TokenRange = {start: number; end: number; tone: Tone};
/** Undefined means the complete block exceeded its budget, never a highlighted prefix. */
export function tokenRanges(text: string, language?: string, maxSpans = MAX_SPANS): TokenRange[] | undefined {
  const family = familyFor(language);
  if (text.length > HIGHLIGHT_BYTES) return undefined;
  if (!family) return [];
  const scan = new Scanner(text); const state: LexState = {inTag: false, tagName: false};
  const ranges: TokenRange[] = [];
  let lastTone: Tone | undefined; let start = 0; let end = 0;
  const append = (): void => {
    if (end > start && lastTone) ranges.push({start, end, tone: lastTone});
  };
  while (scan.has()) {
    const before = scan.at; const tone = token(scan, family, state);
    if (tone !== lastTone) { append(); start = before; lastTone = tone; }
    end = scan.at;
    if (ranges.length > maxSpans) return undefined;
  }
  if (scan.exceeded) return undefined;
  append(); return ranges.length > maxSpans ? undefined : ranges;
}
/** Lexical color only, not a grammar parser. Unknown and over-budget blocks stay exact plain text. */
export function highlight(text: string, language?: string): DocumentFragment {
  const ranges = tokenRanges(text, language);
  const fragment = document.createDocumentFragment(); let at = 0;
  for (const range of ranges ?? []) {
    if (range.start > at) fragment.append(document.createTextNode(text.slice(at, range.start)));
    fragment.append(element('span', `syn-${range.tone}`, text.slice(range.start, range.end))); at = range.end;
  }
  fragment.append(document.createTextNode(text.slice(at))); return fragment;
}
