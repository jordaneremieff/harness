import { createHash, randomUUID } from 'node:crypto';
import { LIMITS } from '../shared/api.ts';
import type { DisplayCoverage, EntryView, HistoryPage, Target } from '../shared/api.ts';
import { projectEntry } from './projection.mts';
import { StateError, validateTarget } from './state.mts';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new StateError('history_limit', 'History anchor left its cache', 409);
  return value;
}
function targetBinding(target: Target): string {
  const identity = target.kind === 'primary' ? {kind: target.kind, key: target.key, epoch: target.epoch} : {kind: target.kind, identity: target.identity};
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
export function decodeHistoryCursor(encoded: string, target: Target): {before: string} {
  validateTarget(target);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > LIMITS.cursorBytes || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new StateError('invalid_request', 'Invalid history cursor');
  let cursor: {target: string; before: string};
  try { cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new StateError('invalid_request', 'Invalid history cursor'); }
  if (!cursor || cursor.target !== targetBinding(target) || typeof cursor.before !== 'string' || cursor.before.length > LIMITS.idChars) throw new StateError('history_limit', 'History cursor belongs to another target', 409);
  return {before: cursor.before};
}
function cursorEnd(entries: EntryView[], target: Target, encoded?: string): number {
  if (!encoded) return entries.length;
  const cursor = decodeHistoryCursor(encoded, target);
  const end = entries.findIndex(entry => entry.id === cursor.before);
  if (end <= 0) throw new StateError('history_limit', 'History anchor left the retained cache or reached its older boundary', 409);
  return end;
}
function slicePage(entries: EntryView[], end: number, limit: number): {start: number; items: EntryView[]} {
  let start = end, bytes = 2048;
  const items: EntryView[] = [];
  while (start > 0 && items.length < limit) {
    let entry = required(entries[start - 1]);
    let size = Buffer.byteLength(JSON.stringify(entry));
    if (items.length === 0 && size + bytes > LIMITS.displayBytes) { entry = projectEntry(entry); size = Buffer.byteLength(JSON.stringify(entry)); }
    if (items.length > 0 && bytes + size > LIMITS.pageBytes) break;
    if (bytes + size > LIMITS.displayBytes) throw new StateError('history_limit', 'Entry exceeds the display safety limit', 409);
    items.unshift(structuredClone(entry)); bytes += size; start--;
  }
  return {start, items};
}
function pageCoverage(source: DisplayCoverage, items: EntryView[], start: number): DisplayCoverage {
  const result = {...source};
  if (start > 0) result.complete = false;
  const omittedDisplay = items.some(entry => entry.data?.truncated || entry.messages?.some(message => message.coverage.truncated));
  if (omittedDisplay) { result.complete = false; result.truncated = true; }
  return result;
}
/** Pages a trusted, already-projected cache without projecting the whole source again. */
export function pageEntries(entries: EntryView[], target: Target, sourceCoverage: DisplayCoverage, input: {cursor?: string; limit?: number} = {}): HistoryPage {
  validateTarget(target);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.pageItems) throw new StateError('invalid_request', 'History page limit must be between 1 and 100');
  if (entries.length > 8192) throw new StateError('history_limit', 'History cache exceeds the row limit', 409);
  const binding = targetBinding(target);
  const end = cursorEnd(entries, target, input.cursor);
  const {start, items} = slicePage(entries, end, limit);
  const olderOutsideCache = start === 0 && sourceCoverage.omitted > 0 && !sourceCoverage.complete && entries.length > 0;
  const nextCursor = start > 0 || olderOutsideCache ? Buffer.from(JSON.stringify({target: binding, before: required(entries[start]).id})).toString('base64url') : null;
  return {target: structuredClone(target), items, nextCursor, coverage: pageCoverage(sourceCoverage, items, start)};
}

/** A bounded in-memory branch window. It never reads a saved session or claims upstream pagination. */
export class History {
  readonly target: Target;
  private readonly maxBytes: number;
  private generation: string = randomUUID();
  private rows: {entry: EntryView; bytes: number}[] = [];
  private bytes = 0;
  private complete = false;
  private omitted = 0;
  private readonly ids = new WeakMap<object, string>();
  constructor(target: Target, options: {maxBytes?: number} = {}) {
    validateTarget(target); this.target = structuredClone(target);
    this.maxBytes = options.maxBytes ?? LIMITS.primaryBytes;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < LIMITS.pageBytes || this.maxBytes > LIMITS.primaryBytes) throw new StateError('invalid_request', 'Invalid history memory limit');
  }
  get coverage(): DisplayCoverage {
    return {complete: this.complete && !this.omitted, truncated: this.omitted > 0, omitted: this.omitted, ...(!this.complete || this.omitted ? {reason: 'Only the retained branch window is available'} : {})};
  }
  private project(raw: unknown): EntryView {
    let id: string = randomUUID();
    if (raw && typeof raw === 'object') {
      const known = this.ids.get(raw);
      if (known) id = known; else this.ids.set(raw, id);
    }
    return projectEntry(raw, id);
  }
  replace(rawEntries: unknown[], options: {complete?: boolean} = {}): void {
    if (!Array.isArray(rawEntries)) throw new StateError('invalid_request', 'History source must be an array');
    this.rows = []; this.bytes = 0; this.omitted = 0; this.complete = options.complete === true; this.generation = randomUUID();
    const accepted: {entry: EntryView; bytes: number}[] = []; const ids = new Set<string>();
    for (let index = rawEntries.length - 1; index >= 0; index--) {
      const entry = this.project(rawEntries[index]); const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (this.bytes + bytes > this.maxBytes || accepted.length >= 8192) { this.omitted = index + 1; break; }
      if (ids.has(entry.id)) continue;
      ids.add(entry.id); accepted.push({entry, bytes}); this.bytes += bytes;
    }
    this.rows = accepted.reverse();
  }
  upsert(rawEntry: unknown): void {
    const entry = this.project(rawEntry); const bytes = Buffer.byteLength(JSON.stringify(entry));
    const index = this.rows.findIndex(row => row.entry.id === entry.id);
    if (index >= 0) { this.bytes -= required(this.rows[index]).bytes; this.rows[index] = {entry, bytes}; }
    else this.rows.push({entry, bytes});
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.rows.length > 8192) { const row = required(this.rows.shift()); this.bytes -= row.bytes; this.omitted++; }
  }
  page(input: {cursor?: string; limit?: number} = {}): HistoryPage {
    let cursor: string | undefined;
    if (input.cursor) {
      if (Buffer.byteLength(input.cursor) > LIMITS.cursorBytes) throw new StateError('invalid_request', 'Invalid history cursor');
      const split = input.cursor.indexOf('.');
      if (split < 0) throw new StateError('invalid_request', 'Invalid history cursor');
      if (input.cursor.slice(0, split) !== this.generation) throw new StateError('history_limit', 'History cursor belongs to a different branch window', 409);
      cursor = input.cursor.slice(split + 1);
    }
    const page = pageEntries(this.rows.map(row => row.entry), this.target, this.coverage, {cursor, limit: input.limit});
    if (page.nextCursor) page.nextCursor = `${this.generation}.${page.nextCursor}`;
    return page;
  }
}
