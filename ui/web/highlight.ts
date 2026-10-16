import { element } from './dom.ts';

export const HIGHLIGHT_BYTES = 64 * 1024;
export const HIGHLIGHT_LINES = 2000;
const MAX_SPANS = 16_384;
export const TONES = ['keyword', 'string', 'number', 'comment', 'type', 'fn', 'property', 'operator', 'punct', 'md-heading', 'md-em', 'md-strong', 'md-link', 'md-code', 'md-marker'] as const;
export type Tone = typeof TONES[number];
export type HighlightBudget = {bytes: number; lines: number};
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
function familyFor(language?: string): Family | 'markdown' | undefined {
  const name = language?.toLowerCase().trim() ?? '';
  return ['md', 'markdown', 'mdown'].includes(name) ? 'markdown' : Object.hasOwn(languages, name) ? languages[name] : undefined;
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
  private budget: HighlightBudget;
  constructor(text: string, budget: HighlightBudget) { this.text = text; this.budget = budget; }
  char(offset = 0): string { return this.text.charAt(this.at + offset); }
  take(): void {
    const code = this.text.charCodeAt(this.at++);
    if (code < 0x80) this.bytes++;
    else if (code < 0x800) this.bytes += 2;
    else if (code >= 0xdc00 && code <= 0xdfff && this.at > 1 && this.text.charCodeAt(this.at - 2) >= 0xd800 && this.text.charCodeAt(this.at - 2) <= 0xdbff) this.bytes++;
    else this.bytes += 3;
    if (code === 10 || (code === 13 && this.char() !== '\n')) this.lines++;
    this.exceeded = this.bytes > this.budget.bytes || this.lines > this.budget.lines;
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
function identifier(scan: Scanner, family: Family, state: LexState): Tone | undefined {
  const start = scan.at;
  while (scan.has() && wordCharacter(scan.char(), family)) scan.take();
  return identifierTone(scan.text.slice(start, scan.at), scan, family, state);
}
function identifierTone(word: string, scan: Scanner, family: Family, state: LexState): Tone | undefined {
  if (family === 'markup') return state.tagName ? 'type' : 'keyword';
  if (keywords[family].has(word)) return 'keyword';
  const next = nextSign(scan);
  if (next === ':' && propertyPosition(scan, family, state)) return 'property';
  if (family === 'shell' && shellFunctions.has(word)) return 'fn';
  if (types.has(word) || (word.charAt(0) >= 'A' && word.charAt(0) <= 'Z')) return 'type';
  return next === '(' ? 'fn' : undefined;
}
type LexState = {inTag: boolean; tagName: boolean; previous: string; lineStart: boolean; braces: number};
function propertyPosition(scan: Scanner, family: Family, state: LexState): boolean {
  if (family === 'json') return true;
  if (family === 'script') return state.previous !== '?' && state.previous !== 'case' && (state.lineStart || state.previous === '{' || state.previous === ',');
  if (family !== 'css' || state.braces === 0) return false;
  // A nested selector opens another block; declaration values terminate with ; or }.
  const lookahead = scan.text.slice(scan.at, scan.at + 256).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\//g, '');
  const boundary = /[;{}]/.exec(lookahead)?.[0];
  return boundary !== '{' && (state.lineStart || ['{', ';'].includes(state.previous));
}
function advanceLexState(scan: Scanner, start: number, tone: Tone | undefined, state: LexState): void {
  const source = scan.text.slice(start, scan.at);
  if (tone === 'comment') return;
  if (/^\s+$/.test(source)) {if (/[\r\n]/.test(source)) state.lineStart = true; return;}
  state.lineStart = false; state.previous = source;
  if (source === '{') state.braces++;
  if (source === '}') state.braces = Math.max(0, state.braces - 1);
}
function markupToken(scan: Scanner, state: LexState): Tone | undefined {
  if (scan.char() === '<') { state.inTag = true; state.tagName = true; scan.take(); if (scan.char() === '/') scan.take(); return 'punct'; }
  if (scan.char() === '>') { state.inTag = false; state.tagName = false; scan.take(); return 'punct'; }
  if (!state.inTag) { while (scan.has() && scan.char() !== '<') scan.take(); return undefined; }
  return token(scan, 'markup', state);
}
function identifierStart(scan: Scanner, family: Family): boolean {return letter(scan.char()) || family === 'css' && scan.text.startsWith('--', scan.at);}
function token(scan: Scanner, family: Family, state: LexState): Tone | undefined {
  if (comment(scan, family)) return 'comment';
  if (family === 'markup' && (!state.inTag || scan.char() === '>')) return markupToken(scan, state);
  if (quoted(scan, family)) return nextSign(scan) === ':' && propertyPosition(scan, family, state) ? 'property' : 'string';
  if (digit(scan.char())) { numeric(scan); return 'number'; }
  if (identifierStart(scan, family)) { const tone = identifier(scan, family, state); state.tagName = false; return tone; }
  const char = scan.char(); scan.take();
  if (family === 'diff' && char === '@') return 'keyword';
  return punctuation(char) ? '=+-*/%!&|^~<>?'.includes(char) ? 'operator' : 'punct' : undefined;
}

export type TokenRange = {start: number; end: number; tone: Tone};
/** Undefined means the complete block exceeded its budget, never a highlighted prefix. */
export function tokenRanges(text: string, language?: string, maxSpans = MAX_SPANS, budget: HighlightBudget = {bytes: HIGHLIGHT_BYTES, lines: HIGHLIGHT_LINES}): TokenRange[] | undefined {
  return sourceRanges(text, language, maxSpans, budget, 0);
}
function sourceRanges(text: string, language: string | undefined, maxSpans: number, budget: HighlightBudget, depth: number): TokenRange[] | undefined {
  const family = familyFor(language);
  if (text.length > budget.bytes) return undefined;
  if (!family) return [];
  if (family === 'markdown') return depth > 1 ? [] : markdownRanges(text, maxSpans, budget, depth);
  if (family === 'config') return configRanges(text, maxSpans, budget);
  const scan = new Scanner(text, budget); const state: LexState = {inTag: false, tagName: false, previous: '', lineStart: true, braces: 0};
  const ranges: TokenRange[] = [];
  let lastTone: Tone | undefined; let start = 0; let end = 0;
  const append = (): void => {
    if (end > start && lastTone) ranges.push({start, end, tone: lastTone});
  };
  while (scan.has()) {
    const before = scan.at; const tone = token(scan, family, state);
    advanceLexState(scan, before, tone, state);
    if (tone !== lastTone) { append(); start = before; lastTone = tone; }
    end = scan.at;
    if (ranges.length > maxSpans) return undefined;
  }
  if (scan.exceeded) return undefined;
  append(); return ranges.length > maxSpans ? undefined : ranges;
}
type SourceLine = {text: string; start: number; next: number};
/** A bounded tone map splits inline overrides without overlapping UTF-16 ranges. */
function sourceLines(text: string): SourceLine[] {
  let offset = 0;
  return text.split(/\r\n|\r|\n/).map(line => {const end = offset + line.length, next = end + (text.startsWith('\r\n', end) ? 2 : Number(end < text.length)); const result = {text:line, start:offset, next}; offset = next; return result;});
}
function mapRanges(tones: Uint8Array, maxSpans: number): TokenRange[] | undefined {
  const ranges: TokenRange[] = []; let at = 0;
  while (at < tones.length) {const start = at, value = tones[at]; while (++at < tones.length && tones[at] === value) {} const tone = value ? TONES[value - 1] : undefined; if (tone) ranges.push({start, end:at, tone}); if (ranges.length > maxSpans) return undefined;}
  return ranges;
}
function configQuotePair(text: string, at: number, quote: string): boolean {
  return quote === '"' && text.charAt(at) === '\\' || quote === "'" && text.charAt(at) === "'" && text.charAt(at + 1) === "'";
}
function configCommentMarker(text: string, at: number): boolean {return text.charAt(at) === '#' && (at === 0 || /\s/.test(text.charAt(at - 1)));}
function configComment(text: string): number {
  let quote = ''; const quoted = /^["'[{]/.test(text);
  for (let at = 0; at < text.length; at++) {
    const char = text.charAt(at);
    if (quote) {
      if (configQuotePair(text, at, quote)) {at++; continue;}
      if (char === quote) quote = '';
      continue;
    }
    if (quoted && (char === '"' || char === "'")) {quote = char; continue;}
    if (configCommentMarker(text, at)) return at;
  }
  return text.length;
}
function scalarTone(value: string): Tone {
  if (/^(?:true|false|null|yes|no|on|off|~)$/i.test(value)) return 'keyword';
  if (/^[+-]?(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)$/.test(value)) return 'number';
  return 'string';
}
/** Lexical key/value and indented-scalar color, not YAML structure or value parsing. */
function configRanges(text: string, maxSpans: number, budget: HighlightBudget): TokenRange[] | undefined {
  if (new TextEncoder().encode(text).length > budget.bytes) return undefined;
  const lines = sourceLines(text); if (lines.length > budget.lines) return undefined;
  const scan = new ConfigScanner(maxSpans, budget);
  for (const line of lines) {scan.line(line); if (scan.failed || scan.ranges.length > maxSpans) return undefined;}
  return scan.ranges;
}
class ConfigScanner {
  readonly ranges: TokenRange[] = []; failed = false;
  private maxSpans: number; private budget: HighlightBudget;
  private continuation?: {indent: number; scalar: boolean; literal: boolean};
  constructor(maxSpans: number, budget: HighlightBudget) {this.maxSpans = maxSpans; this.budget = budget;}
  private paint(start: number, end: number, tone: Tone): void {if (end > start) this.ranges.push({start, end, tone});}
  private flow(text: string, start: number): void {
    const ranges = sourceRanges(text, 'json', this.maxSpans, this.budget, 0);
    if (!ranges) {this.failed = true; return;}
    for (const range of ranges) this.paint(start + range.start, start + range.end, range.tone);
  }
  private scalar(line: SourceLine, start: number, indent: number): void {
    const raw = line.text.slice(start), comment = configComment(raw), value = raw.slice(0, comment).trimEnd();
    const literal = /^[>|](?:[+-]?[1-9]?|[1-9][+-]?)$/.test(value);
    const flow = /^[[{]/.test(value);
    if (flow) this.flow(value, line.start + start);
    else if (value) this.paint(line.start + start, line.start + start + value.length, literal ? 'punct' : scalarTone(value));
    this.paint(line.start + start + comment, line.start + line.text.length, 'comment');
    this.continuation = flow ? undefined : {indent, scalar: !!value, literal};
  }
  private continuedScalar(line: SourceLine, indent: number, hasKey: boolean): boolean {
    const continuation = this.continuation;
    if (!continuation || indent <= continuation.indent || !continuation.scalar && hasKey) return false;
    const raw = line.text.slice(indent), comment = continuation.literal ? raw.length : configComment(raw);
    this.paint(line.start + indent, line.start + indent + comment, 'string');
    this.paint(line.start + indent + comment, line.start + line.text.length, 'comment');
    if (raw.slice(0, comment).trim()) continuation.scalar = true;
    return true;
  }
  line(line: SourceLine): void {
    const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
    const key = /^([ \t]*)(?:-[ \t]+)?("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[\w$.-]+)([ \t]*[:=])/.exec(line.text);
    if (this.continuedScalar(line, indent, !!key)) return;
    if (!line.text.trim()) return;
    this.continuation = undefined;
    if (!key) {
      if (line.text.charAt(indent) === '#') this.paint(line.start + indent, line.start + line.text.length, 'comment');
      else this.flow(line.text, line.start);
      return;
    }
    const end = key[0].length, name = key[2] ?? '', delimiter = key[3] ?? '';
    this.paint(line.start + end - delimiter.length - name.length, line.start + end - delimiter.length, 'property');
    this.paint(line.start + end - 1, line.start + end, 'punct');
    const spaces = /^[ \t]*/.exec(line.text.slice(end))?.[0].length ?? 0;
    this.scalar(line, end + spaces, indent);
  }
}
type SourcePaint = (start: number, end: number, tone: Tone, priority?: number) => boolean;
type Fence = {char: string; length: number; language: string; body: number};
class MarkdownScanner {
  private text: string; private budget: HighlightBudget; private maxSpans: number; private depth: number;
  private tones: Uint8Array; private priorities: Uint8Array; private work = 0;
  private fence?: Fence; private paragraph?: SourceLine;
  constructor(text: string, maxSpans: number, budget: HighlightBudget, depth: number) {this.text=text;this.maxSpans=maxSpans;this.budget=budget;this.depth=depth;this.tones=new Uint8Array(text.length);this.priorities=new Uint8Array(text.length);}
  private paint: SourcePaint = (start, end, tone, priority=1) => {
    this.work += end-start;
    if (start<0 || end>this.text.length || this.work>this.budget.bytes*16) return false;
    const value=TONES.indexOf(tone)+1;
    for(let at=start;at<end;at++)if(priority >= (this.priorities[at]??0)){this.tones[at]=value;this.priorities[at]=priority;}
    return true;
  };
  private code(start: number, end: number, language: string): boolean {
    const ranges=sourceRanges(this.text.slice(start,end),language,this.maxSpans,this.budget,this.depth+1);
    return !!ranges && ranges.every(range=>this.paint(start+range.start,start+range.end,range.tone,6));
  }
  private frontmatter(lines: SourceLine[]): number | undefined {
    const opening=lines[0];if(!opening || !/^\uFEFF?---[ \t]*$/.test(opening.text))return 0;
    const close=lines.findIndex((line,index)=>index>0&&/^(?:---|\.\.\.)[ \t]*$/.test(line.text)),closing=lines[close];
    if(!closing)return 0;
    if(!this.paint(0,opening.next,'md-marker') || !this.code(opening.next,closing.start,'yaml') || !this.paint(closing.start,closing.next,'md-marker'))return undefined;
    return close+1;
  }
  private closeFence(line: SourceLine, marks: string, label: string): boolean {
    const fence=this.fence;if(!fence)return false;
    if(marks[0]!==fence.char || marks.length<fence.length || label.trim())return true;
    if(!this.code(fence.body,line.start,fence.language)||!this.paint(line.start,line.next,'md-marker'))return false;
    this.fence=undefined;return true;
  }
  private structure(line: SourceLine, previous?: SourceLine): boolean {
    const heading=/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line.text);
    if(heading&&!this.paint(line.start,line.start+line.text.length,'md-heading'))return false;
    if(previous && this.paragraph===previous && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line.text)){this.paragraph=undefined;return this.paint(previous.start,previous.start+previous.text.length,'md-heading')&&this.paint(line.start,line.start+line.text.length,'md-heading');}
    const marker=/^ {0,3}(?:(?:>[ \t]?)+|[-+*][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+|(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$)/.exec(line.text);
    this.paragraph=undefined;if(!heading&&!marker&&line.text.trim())this.paragraph=line;
    return !marker || this.paint(line.start,line.start+marker[0].length,'md-marker');
  }
  private line(line: SourceLine, previous?: SourceLine): boolean {
    const delimiter=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text),marks=delimiter?.[1]??'',label=delimiter?.[2]??'';
    if(this.fence){this.paragraph=undefined;return this.closeFence(line,marks,label);}
    if(delimiter && !(marks[0]==='`'&&label.includes('`'))){this.paragraph=undefined;this.fence={char:marks.charAt(0),length:marks.length,language:label.trim().split(/\s/)[0]??'',body:line.next};return this.paint(line.start,line.next,'md-marker');}
    if(/^(?: {4}|\t)/.test(line.text)){this.paragraph=undefined;return true;}
    return this.structure(line,previous)&&new MarkdownInline(line,this.paint).run();
  }
  run(): TokenRange[] | undefined {
    if(new TextEncoder().encode(this.text).length>this.budget.bytes)return undefined;
    const lines=sourceLines(this.text);if(lines.length>this.budget.lines)return undefined;
    const first=this.frontmatter(lines);if(first===undefined)return undefined;
    for(let index=first;index<lines.length;index++){const line=lines[index];if(line&&!this.line(line,lines[index-1]))return undefined;}
    if(this.fence&&!this.code(this.fence.body,this.text.length,this.fence.language))return undefined;
    return mapRanges(this.tones,this.maxSpans);
  }
}
function backtickPairs(text: string) {
  const runs=[...text.matchAll(/`+/g)],next=new Map<number,number>(),closes:number[]=[];
  for(let index=runs.length-1;index>=0;index--){const run=runs[index];if(run){closes[index]=next.get(run[0].length)??-1;next.set(run[0].length,index);}}
  return {runs,closes};
}
class MarkdownInline {
  private line: SourceLine; private paint: SourcePaint; private shield: Uint8Array;
  private openings=new Map<string,number>();private label=-1;
  constructor(line: SourceLine, paint: SourcePaint){this.line=line;this.paint=paint;this.shield=new Uint8Array(line.text.length);}
  private code(): boolean {
    const {runs,closes}=backtickPairs(this.line.text);
    for(let index=0;index<runs.length;index++){
      const open=runs[index],endIndex=closes[index]??-1,close=runs[endIndex];if(!open||!close||this.line.text[open.index-1]==='\\')continue;
      const end=close.index+close[0].length;if(!this.paint(this.line.start+open.index,this.line.start+end,'md-code',5))return false;
      this.shield.fill(1,open.index,end);index=endIndex;
    }
    return true;
  }
  private link(at: number): number {
    const source=this.line.text;let end=at+2,nesting=1;
    while(end<source.length&&nesting){const value=source.charAt(end++);if(value==='\\')end++;else if(value==='(')nesting++;else if(value===')')nesting--;}
    if(nesting){this.label=-1;return source.length;}
    const accepted=this.paint(this.line.start+this.label,this.line.start+end,'md-link',4);this.label=-1;return accepted?end-1:-1;
  }
  private emphasis(at: number): number {
    const source=this.line.text,char=source.charAt(at);let end=at+1;while(source.charAt(end)===char)end++;
    const mark=source.slice(at,end);if(mark.length>3||this.wordUnderscore(at,end))return end-1;
    const open=this.openings.get(mark);
    if(open!==undefined&&at>open+mark.length&&!/\s/.test(source.charAt(at-1))){
      if(!this.paint(this.line.start+open,this.line.start+end,mark.length===2?'md-strong':'md-em',mark.length===2?2:3))return -1;
      this.openings.delete(mark);
    }else if(!/\s/.test(source.charAt(end))&&end<source.length)this.openings.set(mark,at);
    return end-1;
  }
  private wordUnderscore(at: number, end: number): boolean {return this.line.text.charAt(at)==='_'&&/[\p{L}\p{N}]/u.test(this.line.text.charAt(at-1))&&/[\p{L}\p{N}]/u.test(this.line.text.charAt(end));}
  private step(at: number): number {
    const char=this.line.text.charAt(at);if(this.shield[at])return at;if(char==='\\')return at+1;
    if(char==='[')this.label=at;
    if(char===']'&&this.label>=0&&this.line.text.charAt(at+1)==='(')return this.link(at);
    return char==='*'||char==='_'?this.emphasis(at):at;
  }
  run(): boolean {if(!this.code())return false;for(let at=0;at<this.line.text.length;at++){at=this.step(at);if(at<0)return false;}return true;}
}
function markdownRanges(text: string, maxSpans: number, budget: HighlightBudget, depth: number): TokenRange[] | undefined {
  return new MarkdownScanner(text,maxSpans,budget,depth).run();
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
