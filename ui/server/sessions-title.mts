import type { Stats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { safeText } from './projection.mts';

const CHUNK_BYTES = 64 * 1024;
const SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_MS = 10_000;
const LINE_BYTES = 256 * 1024;
const TITLE_CHARS = 200;
const utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
export type SessionTitle = {title: string; titleSource?: 'name' | 'prompt'; titleState: 'ready' | 'unavailable'};
type ScanState = {name: string; firstUser: string; seenUser: boolean};
const unavailable = (): SessionTitle => ({title: '(title unavailable)', titleState: 'unavailable'});
export function titleExcerpt(text: string): string {
  return safeText(text.slice(0, TITLE_CHARS * 2), TITLE_CHARS * 4).replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS);
}
export function sessionRecord(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function firstTextLine(text:string):string {return text.split(/\r?\n/).find(line=>line.trim())??'';}
function userText(value: unknown): string {
  if (typeof value === 'string') return titleExcerpt(firstTextLine(value));
  if (!Array.isArray(value)) return '';
  let text = '';
  for (const block of value) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += ` ${block.text.slice(0, TITLE_CHARS * 2)}`;
      if (text.length >= TITLE_CHARS * 2) break;
    }
  }
  return titleExcerpt(firstTextLine(text));
}
function consume(line: string, state: ScanState): boolean {
  if (!line.trim()) return true;
  const entry = sessionRecord(line);
  if (!entry || typeof entry.type !== 'string') return false;
  // The latest public session_info record supplies the name, including clears.
  if (entry.type === 'session_info') {
    if (entry.name != null && typeof entry.name !== 'string') return false;
    state.name = titleExcerpt(entry.name ?? '');
  }
  if (state.seenUser || entry.type !== 'message') return true;
  const message = entry.message;
  if (message && typeof message === 'object' && 'role' in message && message.role === 'user') {
    state.seenUser = true; state.firstUser = 'content' in message ? userText(message.content) : '';
  }
  return true;
}
/** Unparsed records leave name coverage unknown, even after an earlier name. */
class SnapshotLines {
  #parts: Buffer[] = [];
  #bytes = 0;
  async consume(buffer: Buffer, state: ScanState, deadline: number): Promise<boolean> {
    let start = 0; let records = 0; let sliceStart = performance.now();
    while (start < buffer.length) {
      if (performance.now() >= deadline) return false;
      const newline = buffer.indexOf(10, start);
      const end = newline < 0 ? buffer.length : newline;
      const part = buffer.subarray(start, end);
      this.#bytes += part.length;
      if (this.#bytes > LINE_BYTES) return false;
      this.#parts.push(part);
      if (newline < 0) break;
      if (!this.#finish(state)) return false;
      start = newline + 1;
      if (++records % 64 === 0 && performance.now() - sliceStart >= 2) { await yieldLoop(); sliceStart = performance.now(); }
    }
    return true;
  }
  #finish(state: ScanState): boolean {
    let line: string;
    try { line = utf8.decode(Buffer.concat(this.#parts, this.#bytes)); }
    catch { return false; }
    finally { this.#parts = []; this.#bytes = 0; }
    return consume(line, state);
  }
  eof(state: ScanState): boolean { return !this.#bytes || this.#finish(state); }
}
async function readSnapshot(file: FileHandle, size: number, state: ScanState, deadline: number): Promise<boolean> {
  const lines = new SnapshotLines();
  let position = 0;
  while (position < size) {
    if (performance.now() >= deadline) return false;
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
    const {bytesRead} = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead || !await lines.consume(buffer.subarray(0, bytesRead), state, deadline)) return false;
    position += bytesRead;
    await yieldLoop();
  }
  return performance.now() < deadline && lines.eof(state);
}
function sameSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
export async function scanSessionTitle(path: string, size: number): Promise<SessionTitle> {
  if (!Number.isSafeInteger(size) || size < 0 || size > SNAPSHOT_BYTES) return unavailable();
  const deadline = performance.now() + SNAPSHOT_MS;
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== size) return unavailable();
    const state = {name: '', firstUser: '', seenUser: false};
    if (!await readSnapshot(file, size, state, deadline)) return unavailable();
    if (!sameSnapshot(before, await file.stat()) || performance.now() >= deadline) return unavailable();
    const title = state.name || state.firstUser;
    return title ? {title, titleSource: state.name ? 'name' : 'prompt', titleState: 'ready'} : unavailable();
  } finally { await file.close(); }
}
