import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import { access, open, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { RecentProject, RecentProjectPage, SavedSession, SavedSessionPage } from '../shared/api.ts';
import { ApiError } from './errors.mts';
import { scanSessionTitle, titleExcerpt, type SessionTitle } from './sessions-title.mts';

const READ_BYTES = 64 * 1024;
const PAGE_ITEMS = 20;
const BATCH = 8;
const MAX_FILES = 2048;
const MAX_DIRS = 128;
const MAX_VISITED_ENTRIES = 8192;
const MAX_CACHED_DIRS = 32;
type FileStamp = {path: string; size: number; mtime: number; stamp: string};
type Inventory = {files: FileStamp[]; stamp: string; omitted: number};
type CachedFile = {stamp: string; item: SavedSession | null};
type Listing = {items: SavedSession[]; stamp: string; omitted: number; files: Map<string, CachedFile>};
type Summary = {items: RecentProject[]; stamp: string; omitted: number};
type Header = {id: string; cwd: string};

function expand(path: string) {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
}
function sessionDirectory(project: string) {
  // Pi 1.1.0 dist/core/session-manager.js, getDefaultSessionDirPath:
  // resolvePath(cwd), remove ONE leading separator, replace /, \\, and : with -.
  // resolvePath uses path.resolve, not realpath (dist/utils/paths.js).
  return `--${resolve(project).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}
async function validateProject(project: string): Promise<string> {
  if (typeof project !== 'string' || !isAbsolute(project) || project.length > 4096 || /[\u0000-\u001f\u007f]/.test(project)) {
    throw new ApiError('invalid_project', 'The project must be an absolute readable directory.');
  }
  const path = resolve(project);
  try {
    if (!(await stat(path)).isDirectory()) throw new Error('directory');
    await access(path, constants.R_OK | constants.X_OK);
  } catch {
    throw new ApiError('invalid_project', 'The project must be an existing readable directory.');
  }
  return path;
}
function record(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function header(text: string): Header | null {
  const first = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  const value = first ? record(first) : null;
  if (value?.type !== 'session' || typeof value.id !== 'string' || !value.id || value.id.length > 512 ||
      typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || value.cwd.length > 4096 || /[\u0000-\u001f\u007f]/.test(value.cwd)) return null;
  return {id: value.id, cwd: resolve(value.cwd)};
}
async function readHead(path: string, size: number): Promise<string> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, READ_BYTES));
    const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return size > bytesRead ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  } finally { await file.close(); }
}
/** Manual paths and picker paths share the same bounded, canonical cwd check. */
export async function validateSessionProject(project: string, path: string): Promise<void> {
  const cwd = await validateProject(project);
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new ApiError('invalid_session', 'The saved session path must be absolute.');
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('file');
    const saved = header(await readHead(path, info.size));
    if (!saved || await realpath(saved.cwd) !== await realpath(cwd)) throw new Error('association');
  } catch {
    throw new ApiError('invalid_session', 'The saved session does not belong to the selected project.');
  }
}
async function readSession(info: FileStamp): Promise<SavedSession | null> {
  const saved = header(await readHead(info.path, info.size)); if (!saved) return null;
  return {id: saved.id, path: info.path, project: saved.cwd, revision: fingerprint([info.path, info.stamp]), title: '(title pending)', titleState: 'pending',
    modifiedAt: new Date(info.mtime).toISOString(), size: info.size};
}
function fileStamp(path: string, info: Stats): string {
  return `${basename(path)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
const unavailable = (): SessionTitle => ({title: '(title unavailable)', titleState: 'unavailable'});
type CapturedPage = {project: string; page: SavedSessionPage; rows: SavedSession[]; jobs: Promise<void>[]; expires: number};
async function directoryEntries(path: string, limit: number, include: (entry: Dirent) => boolean) {
  const names: string[] = []; let omitted = 0;
  try {
    const dir = await opendir(path, {bufferSize: 32});
    let visited = 0;
    for await (const entry of dir) {
      if (++visited > MAX_VISITED_ENTRIES) throw new ApiError('session_inventory_limit', 'The saved session directory exceeds the entry scan bound. No complete inventory is available.', 413, 'manual');
      if (include(entry)) { if (names.length < limit) names.push(entry.name); else omitted++; }
      if (visited % 128 === 0) await yieldLoop();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ApiError('sessions_unavailable', 'The saved session directory is not readable.', 503, 'manual');
  }
  return {names, omitted};
}
function mergeProjects(summaries: Summary[]): Map<string, RecentProject> {
  const projects = new Map<string, RecentProject>();
  for (const summary of summaries) for (const item of summary.items) {
    const old = projects.get(item.path);
    if (!old || item.modifiedAt > old.modifiedAt) projects.set(item.path, item);
  }
  return projects;
}
async function batches<T, R>(items: T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < items.length; offset += BATCH) {
    result.push(...await Promise.all(items.slice(offset, offset + BATCH).map(map)));
    await yieldLoop();
  }
  return result;
}
function newest<T extends {modifiedAt: string}>(items: T[], key: (item: T) => string): T[] {
  return items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || key(a).localeCompare(key(b)));
}
function fingerprint(parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}
function retain<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  cache.delete(key); cache.set(key, value);
  while (cache.size > limit) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
}
function decodeCursor(cursor: string, scope: string) {
  if (typeof cursor !== 'string' || cursor.length > 2048) throw new ApiError('invalid_cursor', 'The page cursor is invalid.');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { /* rejected below */ }
  if (!value || typeof value !== 'object' || !('scope' in value) || value.scope !== scope ||
      !('stamp' in value) || typeof value.stamp !== 'string' || !('offset' in value) ||
      typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < PAGE_ITEMS || value.offset % PAGE_ITEMS) {
    throw new ApiError('invalid_cursor', 'The page cursor is invalid.');
  }
  return {stamp: value.stamp, offset: value.offset};
}
type Snapshot = {items: unknown[]; stamp: string; omitted: number; observedAt: string; expires: number};
function page<T>(snapshot: Snapshot, scope: string, offset: number) {
  if (offset && offset >= snapshot.items.length) throw new ApiError('invalid_cursor', 'The page cursor is outside this inventory.');
  const nextOffset = offset + PAGE_ITEMS;
  return {items: (snapshot.items as T[]).slice(offset, nextOffset).map(item => ({...item})), total: snapshot.items.length, omitted: snapshot.omitted,
    nextCursor: nextOffset < snapshot.items.length ? Buffer.from(JSON.stringify({scope, stamp: snapshot.stamp, offset: nextOffset})).toString('base64url') : null,
    observedAt: snapshot.observedAt};
}

/**
 * Read-only ordinary-session discovery. sessions() never scans other projects.
 * Up to 2048 files per directory and 128 directories enter an inventory.
 * omitted counts excluded filesystem entries, not an estimate of valid sessions
 * or distinct projects. total counts validated rows within that inventory.
 * Directory reads stream names with a small buffer and count overflow without
 * retaining it. More than 8192 visited entries rejects explicitly instead of
 * publishing a partial inventory with an unknowable omission count.
 * Metadata uses bounded headers and stat batches. Only returned page rows
 * start title scans, with eight jobs active at once. Explicit title cursors join
 * those jobs and preserve metadata; no timer or polling refresh runs.
 * Projects read only the newest 20 candidate headers per directory; unread
 * candidate files contribute to omitted. No watchers or timers.
 * More serves one retained snapshot for up to 15 minutes or cache eviction.
 * Fresh first-page calls always rebuild the stat inventory.
 */
export class SessionStore {
  #root: string;
  #listings = new Map<string, Listing>();
  #summaries = new Map<string, Summary>();
  #pending = new Map<string, Promise<Listing>>();
  #projectPending?: Promise<{items: RecentProject[]; stamp: string; omitted: number}>;
  #snapshots = new Map<string, Snapshot>();
  #revisions = new WeakMap<SavedSession, FileStamp>();
  #titleCache = new Map<string, Promise<SessionTitle | null>>();
  #failedTitles = new WeakSet<SavedSession>();
  #titlePages = new Map<string, CapturedPage>();
  #titleQueue: (() => void)[] = [];
  #activeTitles = 0;
  constructor(agentDir?: string) {
    this.#root = join(expand(agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')), 'sessions');
  }
  async sessions(project: string, cursor?: string | null): Promise<SavedSessionPage> {
    const cwd = await validateProject(project);
    const scope = `sessions:${cwd}`;
    if (cursor) {
      const {stamp, offset} = decodeCursor(cursor, scope);
      const snapshot = this.#snapshot(scope, stamp);
      return this.#captureTitles(cwd, page<SavedSession>(snapshot, scope, offset), (snapshot.items as SavedSession[]).slice(offset, offset + PAGE_ITEMS));
    }
    const listing = await this.#listing(join(this.#root, sessionDirectory(cwd)));
    const items = listing.items.filter(item => item.project === cwd);
    const result = this.#first(scope, {...listing, items});
    return this.#captureTitles(cwd, result, items.slice(0, PAGE_ITEMS));
  }
  async projects(cursor?: string | null): Promise<RecentProjectPage> {
    if (cursor) return this.#more<RecentProject>('projects', cursor);
    if (!this.#projectPending) {
      const pending = this.#projects(); this.#projectPending = pending;
      void pending.finally(() => { if (this.#projectPending === pending) this.#projectPending = undefined; }).catch(() => {});
    }
    const listing = await this.#projectPending;
    return this.#first('projects', listing);
  }
  #first<T>(scope: string, listing: {items: T[]; stamp: string; omitted: number}) {
    const snapshot = {items: listing.items, stamp: listing.stamp, omitted: listing.omitted, observedAt: new Date().toISOString(), expires: Date.now() + 15 * 60 * 1000};
    retain(this.#snapshots, `${scope}:${listing.stamp}`, snapshot, MAX_CACHED_DIRS);
    return page<T>(snapshot, scope, 0);
  }
  #more<T>(scope: string, cursor: string) {
    const {stamp, offset} = decodeCursor(cursor, scope);
    return page<T>(this.#snapshot(scope, stamp), scope, offset);
  }
  #snapshot(scope: string, stamp: string) {
    const snapshot = this.#snapshots.get(`${scope}:${stamp}`);
    if (!snapshot || snapshot.expires < Date.now()) throw new ApiError('cursor_stale', 'The saved inventory page expired. Start from the first page.', 409, 'manual');
    return snapshot;
  }
  /** One explicit title completion reads only the captured page, never a new inventory. */
  async titles(project: string, cursor: string): Promise<SavedSessionPage> {
    const cwd = await validateProject(project);
    if (typeof cursor !== 'string' || cursor.length > 512) throw new ApiError('invalid_cursor', 'The title cursor is invalid.');
    const captured = this.#titlePages.get(cursor);
    if (!captured || captured.project !== cwd || captured.expires < Date.now()) throw new ApiError('cursor_stale', 'The saved title page expired. Start from the first page.', 409, 'manual');
    await Promise.all(captured.jobs);
    return {...captured.page, items: captured.rows.map(row => ({...row})), titleCursor: null};
  }
  #captureTitles(project: string, result: Omit<SavedSessionPage, 'titleCursor'>, rows: SavedSession[]): SavedSessionPage {
    const pending = rows.filter(row => row.titleState === 'pending');
    if (!pending.length) return {...result, titleCursor: null};
    const cursor = randomUUID();
    const response = {...result, titleCursor: cursor};
    const jobs = pending.map(row => this.#titleJob(row));
    retain(this.#titlePages, cursor, {project, page: response, rows, jobs, expires: Date.now() + 15 * 60 * 1000}, 64);
    return response;
  }
  #titleJob(row: SavedSession): Promise<void> {
    const file = this.#revisions.get(row);
    if (!file) { Object.assign(row, unavailable()); return Promise.resolve(); }
    const key = `${file.path}:${file.stamp}`;
    let job = this.#titleCache.get(key);
    if (!job) {
      if (this.#titleQueue.length >= 4096) { this.#failedTitles.add(row); Object.assign(row, unavailable()); return Promise.resolve(); }
      job = new Promise<SessionTitle | null>(done => {
        this.#titleQueue.push(() => {
          void this.#scanTitle(file).then(title => {
            if (!title && this.#titleCache.get(key) === job) this.#titleCache.delete(key);
            done(title);
          }).finally(() => { this.#activeTitles--; this.#pumpTitles(); });
        });
      });
      retain(this.#titleCache, key, job, 4096);
      this.#pumpTitles();
    }
    return job.then(title => {
      if (!title) this.#failedTitles.add(row);
      Object.assign(row, title ?? unavailable());
    });
  }
  #pumpTitles() {
    while (this.#activeTitles < BATCH && this.#titleQueue.length) {
      const start = this.#titleQueue.shift(); this.#activeTitles++; start?.();
    }
  }
  async #scanTitle(file: FileStamp): Promise<SessionTitle | null> {
    // Yield before any title I/O so metadata rows settle first.
    await yieldLoop();
    try {
      if (fileStamp(file.path, await stat(file.path)) !== file.stamp) return null;
      const title = await scanSessionTitle(file.path, file.size);
      if (fileStamp(file.path, await stat(file.path)) !== file.stamp) return null;
      return title;
    } catch { return null; }
  }
  async #inventory(dir: string): Promise<Inventory> {
    const {names, omitted} = await directoryEntries(dir, MAX_FILES, entry => entry.isFile() && entry.name.endsWith('.jsonl'));
    const stats = await batches(names, async name => {
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) return null;
        return {path, size: info.size, mtime: info.mtime.getTime(), stamp: fileStamp(path, info)};
      } catch { return null; }
    });
    const files = stats.filter((file): file is FileStamp => file !== null);
    return {files, omitted, stamp: fingerprint([`${omitted}`, ...files.map(file => file.stamp)])};
  }
  #listing(dir: string, inventory?: Inventory): Promise<Listing> {
    const existing = this.#pending.get(dir); if (existing) return existing;
    const pending = this.#load(dir, inventory); this.#pending.set(dir, pending);
    void pending.finally(() => { if (this.#pending.get(dir) === pending) this.#pending.delete(dir); }).catch(() => {});
    return pending;
  }
  async #load(dir: string, known?: Inventory): Promise<Listing> {
    const inventory = known ?? await this.#inventory(dir);
    const cached = this.#listings.get(dir);
    if (cached?.stamp === inventory.stamp && !cached.items.some(item => this.#failedTitles.has(item))) {
      retain(this.#listings, dir, cached, MAX_CACHED_DIRS); return cached;
    }
    const files = new Map<string, CachedFile>();
    const items = (await batches(inventory.files, async file => {
      const old = cached?.files.get(file.path);
      if (old?.stamp === file.stamp) {
        const item = old.item && this.#failedTitles.has(old.item) ? {...old.item, title: '(title pending)', titleState: 'pending' as const} : old.item;
        if (item) this.#revisions.set(item, file);
        files.set(file.path, {stamp: file.stamp, item}); return item;
      }
      let item: SavedSession | null = null;
      try { item = await readSession(file); } catch { /* unreadable or concurrently removed */ }
      if (item) this.#revisions.set(item, file);
      files.set(file.path, {stamp: file.stamp, item});
      return item;
    })).filter((item): item is SavedSession => item !== null);
    const listing = {items: newest(items, item => item.path), stamp: inventory.stamp, omitted: inventory.omitted, files};
    retain(this.#listings, dir, listing, MAX_CACHED_DIRS);
    return listing;
  }
  async #summary(inventory: Inventory): Promise<Summary> {
    const ordered = inventory.files.slice().sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    const candidates = ordered.slice(0, PAGE_ITEMS);
    const rows = await batches(candidates, async file => {
      try {
        const saved = header(await readHead(file.path, file.size));
        return saved ? {path: saved.cwd, name: titleExcerpt(basename(saved.cwd) || saved.cwd), modifiedAt: new Date(file.mtime).toISOString()} : null;
      } catch { return null; }
    });
    const items = rows.filter((item): item is RecentProject => item !== null);
    return {items, stamp: inventory.stamp, omitted: inventory.omitted + ordered.length - candidates.length};
  }
  async #projects() {
    const capped = await directoryEntries(this.#root, MAX_DIRS, entry => entry.isDirectory());
    const dirs = capped.names.map(name => join(this.#root, name));
    let omitted = capped.omitted;
    // Directory scans run only for explicit project discovery, never sessions().
    const summaries: Summary[] = [];
    for (const dir of dirs) {
      const inventory = await this.#inventory(dir);
      let summary = this.#summaries.get(dir);
      if (summary?.stamp !== inventory.stamp) { summary = await this.#summary(inventory); retain(this.#summaries, dir, summary, MAX_DIRS); }
      if (summary) { summaries.push(summary); omitted += summary.omitted; }
      await yieldLoop();
    }
    const projects = mergeProjects(summaries);
    const readable = await batches([...projects.values()], async item => {
      try { await validateProject(item.path); return item; } catch { return null; }
    });
    const items = newest(readable.filter((item): item is RecentProject => item !== null), item => item.path);
    return {items, omitted, stamp: fingerprint([`${omitted}`, ...summaries.map(summary => summary.stamp), ...items.map(item => `${item.path}:${item.modifiedAt}`)])};
  }
}
