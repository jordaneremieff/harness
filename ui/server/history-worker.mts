import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import type { OutputPage } from '../shared/api.ts';
import type { ProjectedSnapshot } from '../rpc/events.mts';
import { projectSavedEntry, protectedTextPage } from './projection.mts';

const RECORD_BYTES = 32 * 1024 * 1024;
const SOURCE_BYTES = 512 * 1024 * 1024;
const PAGE_BYTES = 62 * 1024;
type Row = {id: string; parent: string | null; start: number; bytes: number; base?: string};
type Stamp = {size: number; mtimeMs: number; ino: number; dev: number};
export class HistorySourceError extends Error {
  code: string;
  constructor(message: string, code = 'history_limit') { super(message); this.code = code; }
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HistorySourceError('Saved history contains an invalid entry.');
  return raw as Record<string, unknown>;
}
function parse(bytes: Buffer): Record<string, unknown> {
  try { return object(JSON.parse(bytes.toString('utf8'))); }
  catch { throw new HistorySourceError('Saved history contains an invalid JSON record.'); }
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new HistorySourceError('Saved history contains an invalid entry ID.');
  return value;
}
class SessionLines {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private start: number;
  private accept: (line: Buffer, start: number, bytes: number) => void;
  constructor(start: number, accept: (line: Buffer, start: number, bytes: number) => void) { this.start = start; this.accept = accept; }
  get partial(): boolean { return this.bytes > 0; }
  consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const lf = chunk.indexOf(10, offset); const end = lf < 0 ? chunk.length : lf;
      this.chunks.push(chunk.subarray(offset, end)); this.bytes += end - offset;
      if (this.bytes > RECORD_BYTES) throw new HistorySourceError('A saved entry exceeds the record limit; its output is unavailable.');
      if (lf < 0) return;
      const line = Buffer.concat(this.chunks, this.bytes); this.accept(line, this.start, this.bytes);
      this.start += this.bytes + 1; this.chunks = []; this.bytes = 0; offset = lf + 1;
    }
  }
}
function displayCoverage(entries: ProjectedSnapshot['entries'], start: number, partial: boolean): ProjectedSnapshot['coverage'] {
  const truncated = partial || entries.some(row => row.data?.truncated || row.messages?.some(message => message.coverage.truncated));
  return {complete: start === 0 && !truncated, truncated: start > 0 || truncated, omitted: start,
    ...((start > 0 || truncated) ? {reason: partial ? 'A partial trailing record is not yet available.' : start > 0 ? 'Earlier entries are available on request; content previews are bounded.' : 'Saved content has display limits or protected omissions.'} : {})};
}
/** SessionHeader v3 and Entry Base id/parentId follow Pi's public session-format.md. */
export class SessionIndex {
  readonly path: string;
  private rows = new Map<string, Row>();
  private stamp?: Stamp;
  private consumed = 0;
  private lastId: string | null = null;
  private header = false;
  private partial = false;
  private ordered: Row[] = [];
  private branchLeaf?: string | null;
  private signatures = new Map<string, string>();
  constructor(path: string) { this.path = path; }
  async refresh(): Promise<{lastId: string | null; partial: boolean}> {
    const info = await stat(this.path);
    if (!info.isFile() || info.size > SOURCE_BYTES) throw new HistorySourceError('Saved history exceeds the source limit.');
    const same = this.stamp && info.ino === this.stamp.ino && info.dev === this.stamp.dev;
    if (same && info.size === this.stamp?.size && info.mtimeMs === this.stamp.mtimeMs) return {lastId: this.lastId, partial: this.partial};
    if (!same || info.size < (this.stamp?.size ?? 0) || (info.size === this.stamp?.size && info.mtimeMs !== this.stamp.mtimeMs)) this.clear();
    this.branchLeaf = undefined;
    await this.scan(info.size);
    this.stamp = {size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev};
    return {lastId: this.lastId, partial: this.partial};
  }
  private clear(): void {
    this.rows.clear(); this.consumed = 0; this.lastId = null; this.header = false; this.ordered = []; this.signatures.clear(); this.branchLeaf = undefined;
  }
  private async scan(size: number): Promise<void> {
    this.partial = false;
    if (size <= this.consumed) return;
    const lines = new SessionLines(this.consumed, (line, start, bytes) => {
      if (line.length) this.accept(parse(line), start, bytes);
      this.consumed = start + bytes + 1;
    });
    for await (const raw of createReadStream(this.path, {start: this.consumed, end: size - 1, highWaterMark: 64 * 1024})) lines.consume(raw as Buffer);
    this.partial = lines.partial;
    if (!this.header) throw new HistorySourceError('Saved history has no complete version 3 session header.');
  }
  private accept(raw: Record<string, unknown>, start: number, bytes: number): void {
    if (!this.header) {
      if (raw.type !== 'session' || raw.version !== 3) throw new HistorySourceError('Saved history requires the current version 3 session format.');
      this.header = true; return;
    }
    if (raw.type === 'session') throw new HistorySourceError('Saved history contains an unexpected session header.');
    const entryId = id(raw.id); const parent = raw.parentId === null ? null : id(raw.parentId);
    if (this.rows.has(entryId)) throw new HistorySourceError('Saved history contains duplicate entry IDs.');
    if (this.rows.size >= 100_000) throw new HistorySourceError('Saved history exceeds the index row limit.');
    const message = raw.type === 'message' ? object(raw.message) : undefined;
    const base = message ? `${message.role}:${message.timestamp}:${message.toolCallId ?? ''}` : undefined;
    this.rows.set(entryId, {id: entryId, parent, start, bytes, base}); this.lastId = entryId;
  }
  private branch(leaf: string | null): void {
    if (leaf === this.branchLeaf) return;
    const ordered: Row[] = [], seen = new Set<string>(); let current = leaf;
    while (current !== null) {
      const row = this.rows.get(current);
      if (!row || seen.has(current)) throw new HistorySourceError('The RPC history leaf is absent from the saved file; reload history.');
      seen.add(current); ordered.push(row); current = row.parent;
    }
    this.ordered = ordered.reverse(); this.signatures.clear();
    const counts = new Map<string, number>();
    for (const row of this.ordered) if (row.base) {
      const ordinal = counts.get(row.base) ?? 0; counts.set(row.base, ordinal + 1);
      this.signatures.set(row.id, `${row.base}#${ordinal}`);
    }
    this.branchLeaf = leaf;
  }
  private async raw(row: Row): Promise<Record<string, unknown>> {
    const handle = await open(this.path, 'r');
    try {
      const info = await handle.stat();
      if (info.ino !== this.stamp?.ino || info.dev !== this.stamp.dev || info.size < this.consumed) throw new HistorySourceError('The saved history file changed; reload history.');
      const bytes = Buffer.allocUnsafe(row.bytes); let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, row.start + offset);
        if (!read.bytesRead) throw new HistorySourceError('The saved history record is incomplete.');
        offset += read.bytesRead;
      }
      const raw = parse(bytes);
      if (raw.id !== row.id || raw.parentId !== row.parent) throw new HistorySourceError('The saved history record changed; reload history.');
      return raw;
    } finally { await handle.close(); }
  }
  async page(leaf: string | null, before?: string): Promise<ProjectedSnapshot> {
    await this.refresh(); this.branch(leaf);
    const end = before === undefined ? this.ordered.length : this.ordered.findIndex(row => row.id === before);
    if (end < 0) throw new HistorySourceError('The history anchor is absent from the active branch.');
    const collected = await this.collect(end);
    return {...collected.snapshot, coverage: displayCoverage(collected.snapshot.entries, collected.start, this.partial)};
  }
  private async collect(end: number): Promise<{snapshot: ProjectedSnapshot; start: number}> {
    const entries: ProjectedSnapshot['entries'] = [], signatures: [string, string][] = [], sizes: [string, number][] = [];
    let start = end, bytes = 2048;
    while (start > 0 && entries.length < 50) {
      const row = this.ordered[start - 1]; if (!row) break;
      const entry = projectSavedEntry(await this.raw(row));
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > PAGE_BYTES && entries.length) break;
      if (bytes + size > PAGE_BYTES) throw new HistorySourceError('A saved entry exceeds the bounded page limit.');
      entries.unshift(entry); sizes.unshift([entry.id, size]); bytes += size; start--;
      const signature = this.signatures.get(row.id), message = entry.messages?.[0];
      if (signature && message) signatures.unshift([signature, message.id]);
    }
    return {snapshot: {projected: true, entries, signatures, sizes, coverage: {complete: false, truncated: false, omitted: start}}, start};
  }
  async output(leaf: string | null, entryId: string, part: number, offset: number): Promise<OutputPage> {
    await this.refresh(); this.branch(leaf);
    const row = this.ordered.find(row => row.id === entryId);
    if (!row || row.base === undefined) throw new HistorySourceError('The output entry is absent from the active branch.', 'invalid_request');
    const raw = object((await this.raw(row)).message);
    if (raw.role === 'custom' && raw.display === false) throw new HistorySourceError('Hidden custom output is unavailable.', 'invalid_request');
    const content = typeof raw.content === 'string' ? [{type: 'text', text: raw.content}] : raw.content;
    if (!Array.isArray(content) || !Number.isSafeInteger(part) || part < 0 || part >= content.length) throw new HistorySourceError('The output part is invalid.', 'invalid_request');
    const source = object(content[part]);
    if (!['text', 'thinking'].includes(String(source.type)) || source.redacted === true) throw new HistorySourceError('The output part is unavailable.', 'invalid_request');
    const value = source.type === 'thinking' ? source.thinking ?? source.text : source.text;
    if (typeof value !== 'string') throw new HistorySourceError('The output text is unavailable.', 'invalid_request');
    try { return {entryId, part, ...protectedTextPage(value, offset)}; }
    catch { throw new HistorySourceError('The output byte offset is invalid.', 'invalid_request'); }
  }
}

type WorkerRequest = {id: number; path: string; action: 'index' | 'page' | 'output'; leaf?: string | null; before?: string; entryId?: string; part?: number; offset?: number};
async function readRequest(index: SessionIndex, request: WorkerRequest): Promise<unknown> {
  if (request.action === 'index') return index.refresh();
  if (request.action === 'page') return index.page(request.leaf ?? null, request.before);
  return index.output(request.leaf ?? null, request.entryId ?? '', request.part ?? -1, request.offset ?? -1);
}
function workerError(error: unknown): {code: string; message: string} {
  if (error instanceof HistorySourceError) return {code: error.code, message: error.message};
  const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
  return {code: missing ? 'missing_source' : 'history_limit', message: 'Saved history is unavailable.'};
}
const port = parentPort;
if (port) {
  let index: SessionIndex | undefined; let tail = Promise.resolve();
  port.on('message', (request: WorkerRequest) => {
    tail = tail.then(async () => {
      try {
        if (!index || index.path !== request.path) index = new SessionIndex(request.path);
        port.postMessage({id: request.id, value: await readRequest(index, request)});
      } catch (error) { port.postMessage({id: request.id, error: workerError(error)}); }
    });
  });
}
