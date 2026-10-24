/** Paints SGR (ESC [ ... m) tool output as modelled colour classes. The server keeps only SGR; this module still drops anything else, escapes all text and sets no inline colour. */
export type AnsiTone = 'error' | 'success' | 'warning' | 'link' | 'agent' | 'search' | 'muted' | 'dim' | 'fg';
export type AnsiRun = {text: string; cls: string};
type Flag = 'bold' | 'dim' | 'italic' | 'underline' | 'inverse' | 'strike';
type Style = {fg?: AnsiTone; bg: boolean} & Record<Flag, boolean>;
const BASIC: readonly AnsiTone[] = ['dim', 'error', 'success', 'warning', 'link', 'agent', 'search', 'fg'];
const LEVELS = [0, 95, 135, 175, 215, 255];
const HUES: readonly AnsiTone[] = ['error', 'warning', 'success', 'search', 'link', 'agent'];
const FLAG_ON: Record<number, Flag> = {1: 'bold', 2: 'dim', 3: 'italic', 4: 'underline', 21: 'underline', 7: 'inverse', 9: 'strike'};
const FLAG_OFF: Record<number, Flag[]> = {22: ['bold', 'dim'], 23: ['italic'], 24: ['underline'], 27: ['inverse'], 29: ['strike']};
const fresh = (): Style => ({bg: false, inverse: false, bold: false, dim: false, italic: false, underline: false, strike: false});
const clamp = (value: number | undefined): number => Math.max(0, Math.min(255, Number.isFinite(value) ? value as number : 0));
function hueOf(r: number, g: number, b: number, max: number, d: number): number {
  const sector = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (sector * 60 + 360) % 360;
}
/** The nearest modelled tone: greys by lightness, everything else by hue sector. */
function fromRgb(red?: number, green?: number, blue?: number): AnsiTone {
  const [r, g, b] = [clamp(red), clamp(green), clamp(blue)] as [number, number, number];
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (d < 32) return max < 128 ? 'dim' : max < 204 ? 'muted' : 'fg';
  return HUES[Math.floor(((hueOf(r, g, b, max, d) + 30) % 360) / 60)] as AnsiTone;
}
function indexed(n: number): AnsiTone {
  if (n < 16) return BASIC[n % 8] as AnsiTone;
  if (n >= 232) { const level = 8 + 10 * (n - 232); return fromRgb(level, level, level); }
  const i = n - 16; return fromRgb(LEVELS[Math.floor(i / 36)], LEVELS[Math.floor((i % 36) / 6)], LEVELS[i % 6]);
}
/** Applies 38 or 48 (5;n or 2;r;g;b) and returns the index of the last parameter it used. */
function extended(codes: number[], at: number, style: Style): number {
  const mode = codes[at + 1], length = mode === 5 ? 2 : mode === 2 ? 4 : 0;
  if (length === 0 || at + length >= codes.length) return codes.length; // An unknown mode or missing values ends the sequence.
  if (codes[at] === 48) style.bg = true;
  else style.fg = mode === 5 ? indexed(codes[at + 2] as number) : fromRgb(codes[at + 2], codes[at + 3], codes[at + 4]);
  return at + length;
}
function setColour(style: Style, code: number): boolean {
  if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) style.fg = BASIC[code % 10] as AnsiTone;
  else if (code === 39) delete style.fg;
  else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) style.bg = true;
  else if (code === 49) style.bg = false;
  else return false;
  return true;
}
function apply(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(';').map(value => value === '' ? 0 : Number(value));
  let next = {...style};
  for (let at = 0; at < codes.length; at++) {
    const code = codes[at] as number;
    if (code === 0) next = fresh();
    else if (FLAG_ON[code]) next[FLAG_ON[code]] = true;
    else if (FLAG_OFF[code]) for (const flag of FLAG_OFF[code] as Flag[]) next[flag] = false;
    else if (code === 38 || code === 48) at = extended(codes, at, next);
    else setColour(next, code);
  }
  return next;
}
function classes(style: Style): string {
  const list = style.fg ? [`ansi-fg-${style.fg}`] : [];
  for (const [flag, name] of [['bold', 'ansi-b'], ['dim', 'ansi-dim'], ['italic', 'ansi-i'], ['underline', 'ansi-u'], ['strike', 'ansi-s']] as const) if (style[flag]) list.push(name);
  if (style.bg || style.inverse) list.push('ansi-mark');
  return list.join(' ');
}
const ANY_ESCAPE = /^\u001b(?:\[([0-?]*)([ -/]*)([@-~])|[\u0000-\u001a\u001c-\uffff]?)/;
const PARTIAL = /^\u001b(?:\[[0-?]*[ -/]*)?$/;
const STRING_START = /^\u001b[\]P_^X]/;
const visible = (char: string): boolean => { const code = char.charCodeAt(0); return char === '\n' || char === '\t' || (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)); };
/** Streaming painter: style carries across chunks and lines, and a sequence cut at a chunk boundary waits for its rest. */
export class AnsiPainter {
  private style = fresh();
  private pending = '';
  /** Consumes the escape at the start of \`rest\`: the length used, and the colour parameters when it is SGR. */
  private escape(rest: string): {length: number; params?: string} {
    if (STRING_START.test(rest)) {
      const end = /\u0007|\u001b\\|\n/.exec(rest.slice(2));
      return {length: end ? 2 + end.index + (end[0] === '\n' ? 0 : end[0].length) : rest.length};
    }
    const match = ANY_ESCAPE.exec(rest);
    if (!match) return {length: 1};
    const sgr = match[3] === 'm' && match[2] === '' && /^[0-9;]*$/.test(match[1] ?? '');
    return {length: match[0].length || 1, ...(sgr ? {params: match[1] ?? ''} : {})};
  }
  feed(chunk: string): AnsiRun[] {
    const source = this.pending + chunk; this.pending = '';
    const runs: AnsiRun[] = []; let text = '';
    const emit = () => { if (text) { runs.push({text, cls: classes(this.style)}); text = ''; } };
    for (let at = 0; at < source.length;) {
      const char = source[at] as string;
      if (char !== '\u001b') { if (visible(char)) text += char; at++; continue; }
      const rest = source.slice(at);
      if (PARTIAL.test(rest)) { this.pending = rest; break; }
      const {length, params} = this.escape(rest);
      if (params !== undefined) { emit(); this.style = apply(this.style, params); }
      at += length;
    }
    emit(); return runs;
  }
}
/** Text and SGR to DOM with a plain-text length cap. Adjacent runs with the same classes merge. */
export function paintAnsi(source: string, limit = Number.MAX_SAFE_INTEGER): DocumentFragment {
  const fragment = document.createDocumentFragment(); let left = limit;
  const merged: AnsiRun[] = [];
  for (const run of new AnsiPainter().feed(source)) { const last = merged.at(-1); if (last?.cls === run.cls) last.text += run.text; else merged.push({...run}); }
  for (const run of merged) {
    if (left <= 0) break;
    const text = run.text.slice(0, left); left -= text.length;
    if (!run.cls) { fragment.append(document.createTextNode(text)); continue; }
    const node = document.createElement('span'); node.className = run.cls; node.textContent = text; fragment.append(node);
  }
  return fragment;
}
