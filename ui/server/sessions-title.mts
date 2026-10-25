import type { Stats } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { safeText } from './projection.mts';

const CHUNK_BYTES = 64 * 1024;
const SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_MS = 10_000;
const LINE_BYTES = 256 * 1024;
const TITLE_CHARS = 200;
const utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
/** Message facts come from native user and assistant records, never custom peer messages or file modification time. */
export type SessionTitle = {title: string; titleSource?: 'name' | 'prompt'; titleState: 'ready' | 'unavailable'; lastUserAt?: string; lastAnswerAt?: string; hasMessages?: boolean};
export type SessionFileStamp = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;
type ScanState = {name: string; firstUser: string; seenUser: boolean; nameKnown: boolean; userKnown: boolean; lastUserAt?: number; lastAnswerAt?: number; hasMessages: boolean};
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
type PeekRole = 'key' | 'type' | 'skip' | 'nested';
/** Classifies the root type with bounded tokens and nesting while discarding large values. */
class TypePeek {
  #stage: 'start' | 'key' | 'colon' | 'value' | 'after' | 'done' = 'start';
  #quoted = false;
  #escaped = false;
  #role: PeekRole = 'skip';
  #token: number[] = [];
  #nested: number[] = [];
  #primitive = false;
  #key = '';
  #type?: string;
  #typed = false;
  #invalid = false;
  feed(bytes: Buffer): void {
    for (const byte of bytes) {
      if (this.#invalid) return;
      if (this.#quoted) this.#quotedByte(byte);
      else if (this.#nested.length) this.#nestedByte(byte);
      else this.#rootByte(byte);
    }
  }
  #quotedByte(byte: number): void {
    if (this.#role === 'key' || this.#role === 'type') this.#push(byte);
    if (this.#escaped) { this.#escaped = false; return; }
    if (byte === 92) { this.#escaped = true; return; }
    if (byte < 32) { this.#invalid = true; return; }
    if (byte === 34) { this.#quoted = false; this.#string(); }
  }
  #nestedByte(byte: number): void {
    if (byte === 34) this.#quote('nested');
    else if (byte === 123 || byte === 91) this.#nest(byte);
    else if (byte === 125 || byte === 93) {
      if (this.#nested.pop() !== byte) this.#invalid = true;
      else if (!this.#nested.length) this.#stage = 'after';
    }
  }
  #rootByte(byte: number): void {
    const space = byte === 32 || byte === 9 || byte === 13;
    if (this.#primitive && !this.#endPrimitive(byte, space)) return;
    if (!space) this.#rootToken(byte);
  }
  #endPrimitive(byte: number, space: boolean): boolean {
    if (!space && byte !== 44 && byte !== 125) { this.#push(byte); return false; }
    try { JSON.parse(utf8.decode(Buffer.from(this.#token))); }
    catch { this.#invalid = true; }
    this.#token = []; this.#primitive = false; this.#stage = 'after'; return true;
  }
  #rootToken(byte: number): void {
    switch (this.#stage) {
      case 'start': if (byte === 123) this.#stage = 'key'; else this.#invalid = true; break;
      case 'key': this.#keyByte(byte); break;
      case 'colon': if (byte === 58) this.#stage = 'value'; else this.#invalid = true; break;
      case 'value': this.#valueByte(byte); break;
      case 'after': this.#afterByte(byte); break;
      case 'done': this.#invalid = true; break;
    }
  }
  #keyByte(byte: number): void {
    if (byte === 34) this.#quote('key');
    else if (byte === 125 && !this.#typed) this.#stage = 'done';
    else this.#invalid = true;
  }
  #valueByte(byte: number): void {
    if (byte === 34) this.#quote(this.#key === 'type' ? 'type' : 'skip');
    else if (this.#key === 'type') this.#invalid = true;
    else if (byte === 123 || byte === 91) this.#nest(byte);
    else { this.#primitive = true; this.#token = []; this.#push(byte); }
  }
  #afterByte(byte: number): void {
    if (byte === 44) this.#stage = 'key';
    else if (byte === 125) this.#stage = 'done';
    else this.#invalid = true;
  }
  #push(byte: number): void { if (this.#token.length < 256) this.#token.push(byte); else this.#invalid = true; }
  #nest(byte: number): void { if (this.#nested.length < 128) this.#nested.push(byte === 123 ? 125 : 93); else this.#invalid = true; }
  #quote(role: PeekRole): void { this.#quoted = true; this.#escaped = false; this.#role = role; this.#token = role === 'key' || role === 'type' ? [34] : []; }
  #string(): void {
    if (this.#role === 'nested') return;
    if (this.#role === 'key' || this.#role === 'type') {
      const value = this.#stringValue();
      if (value === undefined) { this.#invalid = true; return; }
      if (this.#role === 'key') this.#setKey(value); else this.#type = value;
    }
    this.#token = [];
    this.#stage = this.#role === 'key' ? 'colon' : 'after';
  }
  #stringValue(): string | undefined {
    try { const value: unknown = JSON.parse(utf8.decode(Buffer.from(this.#token))); return typeof value === 'string' ? value : undefined; }
    catch { return; }
  }
  #setKey(value: string): void {
    this.#key = value;
    if (value === 'type') { if (this.#typed) this.#invalid = true; this.#typed = true; }
  }
  type(): string | undefined { return !this.#invalid && this.#stage === 'done' ? this.#type : undefined; }
}
const HEAD_BYTES = 4096;
const headText = new TextDecoder('utf-8', {ignoreBOM: true});
// Root keys before `message` must hold primitives, so string content cannot forge the role or the text.
const MESSAGE_HEAD = /^\{"type":"message"(?:,"[A-Za-z]+":(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null))*,"message":\{"role":"([A-Za-z]+)"(?:,"content":(?:("(?:[^"\\]|\\.)*")|\[\{"type":"text","text":("(?:[^"\\]|\\.)*")))?/;
type MessageHead = {role?: string; text?: string};
/** Reads the role and a leading complete text from the bounded start of an oversized message record. */
function messageHead(head: Buffer | undefined): MessageHead {
  const match = head ? MESSAGE_HEAD.exec(headText.decode(head)) : null;
  if (!match) return {};
  const literal = match[2] ?? match[3];
  if (literal === undefined) return {role: match[1]};
  try { const text: unknown = JSON.parse(literal); return typeof text === 'string' ? {role: match[1], text} : {role: match[1]}; }
  catch { return {role: match[1]}; }
}
function headOf(parts: readonly Buffer[]): Buffer {
  const head = Buffer.alloc(HEAD_BYTES); let used = 0;
  for (const part of parts) { if (used >= HEAD_BYTES) break; used += part.copy(head, used, 0, Math.min(part.length, HEAD_BYTES - used)); }
  return head.subarray(0, used);
}
function skipped(type: string | undefined, state: ScanState, head: MessageHead = {}): void {
  if (type === 'message' && (head.role === 'user' || head.role === 'assistant')) state.hasMessages = true;
  if (type === undefined || type === 'session_info') state.nameKnown = false;
  if (state.seenUser || (type !== undefined && type !== 'message')) return;
  // A known system, assistant or tool record is not the first user prompt.
  if (type === 'message' && head.role !== undefined && head.role !== 'user') return;
  state.seenUser = true;
  if (type === 'message' && head.role === 'user' && head.text !== undefined) state.firstUser = titleExcerpt(firstTextLine(head.text));
  else state.userKnown = false;
}
function noteMessage(entry: Record<string, unknown>, state: ScanState): void {
  const message = entry.message;
  if (entry.type !== 'message' || !message || typeof message !== 'object' || !('role' in message) || !['user', 'assistant'].includes(String(message.role))) return;
  state.hasMessages = true;
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(at)) return;
  if (message.role === 'user') state.lastUserAt = Math.max(state.lastUserAt ?? -Infinity, at);
  else if ('stopReason' in message && ['stop', 'length'].includes(String(message.stopReason)) && 'content' in message && Array.isArray(message.content) && message.content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) && !message.content.some(part => part?.type === 'toolCall')) state.lastAnswerAt = Math.max(state.lastAnswerAt ?? -Infinity, at);
}
function consume(line: string, bytes: Buffer, state: ScanState): void {
  if (!line.trim()) return;
  const entry = sessionRecord(line);
  if (!entry || typeof entry.type !== 'string') { const peek = new TypePeek(); peek.feed(bytes); skipped(peek.type(), state); return; }
  noteMessage(entry, state);
  // The latest public session_info record supplies the name, including clears.
  if (entry.type === 'session_info') {
    if (entry.name != null && typeof entry.name !== 'string') { state.nameKnown = false; return; }
    state.name = titleExcerpt(entry.name ?? ''); state.nameKnown = true;
  }
  if (state.seenUser || entry.type !== 'message') return;
  const message = entry.message;
  if (message && typeof message === 'object' && 'role' in message && message.role === 'user') {
    state.seenUser = true; state.firstUser = 'content' in message ? userText(message.content) : '';
  }
}
class SnapshotLines {
  #parts: Buffer[] = [];
  #bytes = 0;
  #peek?: TypePeek;
  #head?: Buffer;
  async consume(buffer: Buffer, state: ScanState, deadline: number): Promise<boolean> {
    let start = 0; let records = 0; let sliceStart = performance.now();
    while (start < buffer.length) {
      if (performance.now() >= deadline) return false;
      const newline = buffer.indexOf(10, start);
      const end = newline < 0 ? buffer.length : newline;
      this.#part(buffer.subarray(start, end));
      if (newline < 0) break;
      this.#finish(state);
      start = newline + 1;
      if (++records % 64 === 0 && performance.now() - sliceStart >= 2) { await yieldLoop(); sliceStart = performance.now(); }
    }
    return true;
  }
  #part(part: Buffer): void {
    this.#bytes += part.length;
    if (!this.#peek && this.#bytes > LINE_BYTES) {
      this.#head = headOf([...this.#parts, part]);
      this.#peek = new TypePeek();
      for (const previous of this.#parts) this.#peek.feed(previous);
      this.#parts = [];
    }
    if (this.#peek) this.#peek.feed(part); else this.#parts.push(part);
  }
  #finish(state: ScanState): void {
    if (this.#peek) { const type = this.#peek.type(); skipped(type, state, type === 'message' ? messageHead(this.#head) : {}); }
    else {
      const bytes = Buffer.concat(this.#parts, this.#bytes);
      try { consume(utf8.decode(bytes), bytes, state); }
      catch { const peek = new TypePeek(); peek.feed(bytes); skipped(peek.type(), state); }
    }
    this.#parts = []; this.#bytes = 0; this.#peek = undefined; this.#head = undefined;
  }
  eof(state: ScanState): void { if (this.#bytes) this.#finish(state); }
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
  lines.eof(state);
  return performance.now() < deadline;
}
/** Growth permits a captured prefix; stats do not prove that growth was append-only. */
function sameFilePrefix(before: SessionFileStamp, after: SessionFileStamp): boolean {
  return before.dev === after.dev && before.ino === after.ino && after.size >= before.size &&
    (after.size > before.size || before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
}
function validStart(before: Stats, size: number, captured?: SessionFileStamp): boolean {
  if (!before.isFile() || before.size < size) return false;
  return !captured || captured.size === size && sameFilePrefix(captured, before);
}
function scanResult(state:ScanState):SessionTitle {
  const facts={hasMessages:state.hasMessages,...(state.lastUserAt===undefined?{}:{lastUserAt:new Date(state.lastUserAt).toISOString()}),...(state.lastAnswerAt===undefined?{}:{lastAnswerAt:new Date(state.lastAnswerAt).toISOString()})};
  if(!state.nameKnown||!state.name&&!state.userKnown)return {...unavailable(),...facts};
  const title=state.name||state.firstUser;
  return title?{title,titleSource:state.name?'name':'prompt',titleState:'ready',...facts}:{...unavailable(),...facts};
}
export async function scanSessionTitle(path: string, size: number, captured?: SessionFileStamp): Promise<SessionTitle> {
  if (!Number.isSafeInteger(size) || size < 0 || size > SNAPSHOT_BYTES) return unavailable();
  const deadline = performance.now() + SNAPSHOT_MS;
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!validStart(before, size, captured)) return unavailable();
    const state: ScanState = {name: '', firstUser: '', seenUser: false, nameKnown: true, userKnown: true, hasMessages: false};
    if (!await readSnapshot(file, size, state, deadline)) return unavailable();
    const after = await file.stat();
    if (!sameFilePrefix(before, after) || !sameFilePrefix(after, await stat(path)) || performance.now() >= deadline) return unavailable();
    return scanResult(state);
  } finally { await file.close(); }
}
