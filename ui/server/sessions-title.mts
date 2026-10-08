import { open, type FileHandle } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { safeText } from './projection.mts';

const CHUNK_BYTES = 64 * 1024;
const FORWARD_BYTES = 2 * 1024 * 1024;
const LINE_BYTES = 256 * 1024;
const TITLE_CHARS = 200;
export type SessionTitle = {title: string; titleState: 'ready' | 'unavailable'};
type ScanState = {name: string; firstUser: string; seenUser: boolean};
export function titleExcerpt(text: string): string {
  return safeText(text.slice(0, TITLE_CHARS * 2), TITLE_CHARS * 4).replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS);
}
function record(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function userText(value: unknown): string {
  if (typeof value === 'string') return titleExcerpt(value);
  if (!Array.isArray(value)) return '';
  let text = '';
  for (const block of value) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += ` ${block.text.slice(0, TITLE_CHARS * 2)}`;
      if (text.length >= TITLE_CHARS * 2) break;
    }
  }
  return titleExcerpt(text);
}
function consume(line: string, state: ScanState, allowUser: boolean) {
  const entry = record(line); if (!entry) return;
  // Pi 1.1.0 dist/core/session-manager.js buildSessionInfo: latest name, including clears.
  if (entry.type === 'session_info' && (entry.name == null || typeof entry.name === 'string')) state.name = titleExcerpt(entry.name ?? '');
  if (!allowUser || state.seenUser || entry.type !== 'message') return;
  const message = entry.message;
  if (message && typeof message === 'object' && 'role' in message && message.role === 'user') {
    state.seenUser = true; state.firstUser = 'content' in message ? userText(message.content) : '';
  }
}
type PrefixFrame = {path: string; key: string; object: boolean; keyNext: boolean};
type PrefixToken = {text: string; string: boolean};
function stringEnd(source: string, start: number) {
  let end = start;
  while (end < source.length && source[end] !== '"') { if (source[end] === '\\') end++; end++; }
  return end;
}
function* prefixTokens(source: string): Generator<PrefixToken> {
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char !== '"') { if ('{}[],:'.includes(char)) yield {text: char, string: false}; continue; }
    const start = index; index = stringEnd(source, index + 1);
    if (index >= source.length) return;
    try { yield {text: JSON.parse(source.slice(start, index + 1)), string: true}; } catch { return; }
  }
}
function nonUserPrefix(source: string): boolean {
  const frames: PrefixFrame[] = [];
  const fields = new Map<string, string>();
  for (const token of prefixTokens(source)) {
    prefixField(frames, fields, token);
    const type = fields.get('type'); const role = fields.get('message.role');
    if (type && type !== 'message') return true;
    if (type === 'message' && role) return role !== 'user';
  }
  // An unclassified oversized record could be the first user, so later users
  // cannot safely supply its excerpt. Strings inside content are never fields.
  return false;
}
function prefixField(frames: PrefixFrame[], fields: Map<string, string>, token: PrefixToken) {
  const top = frames.at(-1);
  if (!token.string || !top) { updateFrames(frames, token.text); return; }
  if (top.keyNext) { top.key = token.text; top.keyNext = false; }
  else fields.set(top.path ? `${top.path}.${top.key}` : top.key, token.text);
}
function updateFrames(frames: PrefixFrame[], token: string) {
  const top = frames.at(-1);
  if (token === '{' || token === '[') {
    const path = top ? [top.path, top.key].filter(Boolean).join('.') : '';
    frames.push({path, key: '', object: token === '{', keyNext: token === '{'});
  } else if (token === '}' || token === ']') frames.pop();
  else if (token === ',' && top) top.keyNext = top.object;
}
/** A byte-bounded line decoder drops oversized records without retaining them. */
class ForwardLines {
  #parts: Buffer[] = [];
  #bytes = 0;
  #oversized = false;
  async consume(buffer: Buffer, state: ScanState) {
    let start = 0; let records = 0; let sliceStart = performance.now();
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start);
      const end = newline < 0 ? buffer.length : newline;
      this.#append(buffer.subarray(start, end), state);
      if (newline < 0) break;
      this.#finish(state); start = newline + 1;
      if (++records % 64 === 0 && performance.now() - sliceStart >= 2) { await yieldLoop(); sliceStart = performance.now(); }
    }
  }
  #append(part: Buffer, state: ScanState) {
    if (this.#oversized) return;
    this.#bytes += part.length;
    if (this.#bytes > LINE_BYTES) {
      if (!state.seenUser && !nonUserPrefix(Buffer.concat(this.#parts).toString('utf8'))) state.seenUser = true;
      this.#oversized = true; this.#parts = []; return;
    }
    this.#parts.push(part);
  }
  #finish(state: ScanState) {
    if (!this.#oversized) consume(Buffer.concat(this.#parts, this.#bytes).toString('utf8'), state, true);
    this.#parts = []; this.#bytes = 0; this.#oversized = false;
  }
  eof(state: ScanState) { if (this.#bytes && !state.seenUser) this.#finish(state); }
}
async function forward(file: FileHandle, size: number, state: ScanState) {
  const lines = new ForwardLines();
  const limit = Math.min(size, FORWARD_BYTES);
  let position = 0; let endsLine = false;
  while (position < limit && !state.seenUser) {
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, limit - position));
    const {bytesRead} = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead; endsLine = buffer[bytesRead - 1] === 10;
    await lines.consume(buffer.subarray(0, bytesRead), state);
    await yieldLoop();
  }
  if (position === size) lines.eof(state);
  return {position, endsLine};
}
async function tail(file: FileHandle, size: number, scanned: {position: number; endsLine: boolean}, state: ScanState) {
  const forwardEnd = scanned.position;
  // Avoid re-reading older names when the file fits in the forward scan.
  if (forwardEnd >= size) return;
  const start = Math.max(forwardEnd, size - CHUNK_BYTES);
  const buffer = Buffer.alloc(size - start);
  const {bytesRead} = await file.read(buffer, 0, buffer.length, start);
  const text = buffer.subarray(0, bytesRead).toString('utf8');
  const firstBoundary = text.indexOf('\n');
  const complete = start === forwardEnd && scanned.endsLine ? text : firstBoundary < 0 ? '' : text.slice(firstBoundary + 1);
  const lines = complete.split('\n');
  let sliceStart = performance.now();
  for (let index = 0; index < lines.length; index++) {
    consume(lines[index], state, false);
    if (index % 64 === 63 && performance.now() - sliceStart >= 2) { await yieldLoop(); sliceStart = performance.now(); }
  }
}
export async function scanSessionTitle(path: string, size: number): Promise<SessionTitle> {
  const file = await open(path, 'r');
  try {
    const state = {name: '', firstUser: '', seenUser: false};
    const scanned = await forward(file, size, state);
    await tail(file, size, scanned, state);
    const title = state.name || state.firstUser;
    return title ? {title, titleState: 'ready'} : {title: '(title unavailable)', titleState: 'unavailable'};
  } finally { await file.close(); }
}
