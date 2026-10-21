import {constants} from 'node:fs';
import {open, type FileHandle} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {ApiError} from './errors.mts';

export const CLIENT_ERROR_REQUEST_BYTES = 8192;
const FILE_BYTES = 64 * 1024, ROWS = 128;
const SECTIONS = new Set(['Client', 'Open tabs', 'Recent', 'Agents', 'Sessions', 'Threads', 'Files']);
type Report = {message: string; stack: string; section: string; source: Record<string, string>};
function object(value: unknown): value is Record<string, unknown> {return !!value && typeof value === 'object' && !Array.isArray(value);}
function cleanText(value: string, limit: number): string {
  const clean = value.replace(/\bdata:[^,\s"')]*,[^\s"')]*/gi, '[url omitted]')
    .replace(/\b(?:https?:\/\/|file:\/\/|blob:(?:https?:\/\/|null\/))[^\s"'<>)]*/gi, '[url omitted]')
    .replace(/(\/[^\s"'<>?#)]*)[?#]([^\s"'<>)]*)/g, (_all, path: string, tail: string) => path + (/(?::\d{1,8}){1,2}$/.exec(tail)?.[0] ?? ''))
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, '[credential omitted]')
    .replace(/(\b(?:authorization|cookie|password|secret|token|api[ _-]?key)\b["']?[ \t]*[:=][ \t]*)(?!(?:undefined|null|missing|invalid|unavailable|none|false|true)\b)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}"'[\]]+)/gi, '$1[credential omitted]')
    .replace(/\bsk[-_][\w-]{16,}/g, '[credential omitted]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  let result = '', bytes = 0;
  for (const char of clean.slice(0, limit)) {const size = Buffer.byteLength(char); if (bytes + size > limit) break; result += char; bytes += size;}
  return result;
}
/** Only diagnostic strings, known sections and source hashes cross this boundary. */
export function clientErrorReport(value: unknown): Report {
  const invalid = () => new ApiError('invalid_request', 'The client error report is invalid.');
  if (!object(value) || Object.keys(value).some(key => !['message', 'stack', 'section', 'source'].includes(key))) throw invalid();
  if (typeof value.message !== 'string' || Buffer.byteLength(value.message) > 1024 || typeof value.stack !== 'string' || Buffer.byteLength(value.stack) > 4096
    || typeof value.section !== 'string' || !SECTIONS.has(value.section) || !object(value.source)) throw invalid();
  if (value.stack.split('\n').length > 32) throw invalid();
  const source: Record<string, string> = {};
  for (const [key, hash] of Object.entries(value.source)) {
    if (!['release', 'commit', 'generation'].includes(key) || typeof hash !== 'string' || !(key === 'commit' ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/ : /^[a-f0-9]{64}$/).test(hash)) throw invalid();
    source[key] = hash;
  }
  return {message: cleanText(value.message, 1024).replace(/[\n\t]/g, ' '), stack: cleanText(value.stack, 4096), section: value.section, source};
}
/** The selected UI state lock supplies one owner; one coalesced writer keeps a fixed log window. */
export class ClientErrorLog {
  private rows: string[] = [];
  private recent = new Map<string, number>();
  private windowAt = 0;
  private count = 0;
  private dirty = false;
  private failed = false;
  private stopped = false;
  private pending?: Promise<void>;
  private file: FileHandle;
  private constructor(file: FileHandle) {this.file = file;}
  static async open(directory: string): Promise<ClientErrorLog> {
    const file = await open(join(directory, 'client-errors.jsonl'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Private client error log is unavailable.');
      const log = new ClientErrorLog(file);
      if (stat.size <= FILE_BYTES) {
        const buffer = Buffer.alloc(FILE_BYTES + 1), read = await file.read(buffer, 0, buffer.length, 0);
        for (const row of buffer.subarray(0, read.bytesRead).toString('utf8').split('\n').filter(Boolean).slice(-ROWS)) {
          try {
            const {at, ...value} = JSON.parse(row);
            if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at) || at.length > 40) continue;
            log.rows.push(JSON.stringify({at, ...clientErrorReport(value)}));
          } catch {}
        }
      }
      log.trim();
      // Oversized or malformed retained bytes are replaced without reading beyond the fixed window.
      await file.truncate(0); log.dirty = true; log.flush();
      return log;
    } catch (error) {await file.close(); throw error;}
  }
  record(report: Report): void {
    try {
      if (this.failed || this.stopped) return;
      const now = performance.now();
      if (now - this.windowAt >= 60_000) {this.windowAt = now; this.count = 0;}
      if (this.count >= 20) return;
      const key = createHash('sha256').update(JSON.stringify(report)).digest('hex');
      for (const [key, at] of this.recent) if (now - at >= 60_000) this.recent.delete(key);
      if (this.recent.has(key)) return;
      if (this.recent.size >= 64) this.recent.delete(this.recent.keys().next().value as string);
      this.recent.set(key, now); this.count++;
      const row = JSON.stringify({at: new Date().toISOString(), ...report});
      if (Buffer.byteLength(row) + 1 > CLIENT_ERROR_REQUEST_BYTES) return;
      this.rows.push(row); this.trim(); this.dirty = true; this.flush();
    } catch {this.failed = true;}
  }
  private trim(): void {while (this.rows.length > ROWS || Buffer.byteLength(this.rows.join('\n')) + 1 > FILE_BYTES) this.rows.shift();}
  private flush(): void {
    this.pending ??= this.publish().catch(() => {this.failed = true;}).finally(() => {this.pending = undefined; if (this.dirty && !this.failed) this.flush();});
  }
  private async publish(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const buffer = Buffer.from(this.rows.length ? `${this.rows.join('\n')}\n` : ''); let offset = 0;
      while (offset < buffer.length) {
        const write = await this.file.write(buffer, offset, buffer.length - offset, offset);
        if (!write.bytesWritten) throw new Error('Client error log write stopped.');
        offset += write.bytesWritten;
      }
      await this.file.truncate(buffer.length);
    }
  }
  async close(): Promise<void> {this.stopped = true; while (this.pending) await this.pending; await this.file.close().catch(() => {});}
}
