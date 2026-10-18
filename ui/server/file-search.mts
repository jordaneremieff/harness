import type {Dir} from 'node:fs';
import {opendir} from 'node:fs/promises';
import type {FileSearchResult, FileSearchRow} from '../shared/files.ts';
import {ApiError} from './errors.mts';
import {checkedFilePath, childPath, excludedNames, filePath, type RegisteredRoot} from './file-access.mts';

/** Separate bounds for one on-demand name search; none of them reads file contents. */
export const SEARCH_LIMITS = {depth: 8, visits: 4000, ms: 800, rows: 8, matches: 64, queryChars: 200, bytes: 32 * 1024};
/** Directories with these names are visited after every other directory at their depth; nothing is excluded by name. */
const deferredNames: ReadonlySet<string> = new Set(['node_modules']);
type Match = {row: FileSearchRow; rank: number; depth: number};
type Scope = {dir: string; needle: string; byPath: boolean};

export function searchQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > SEARCH_LIMITS.queryChars || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError('invalid_request', 'The file search query is invalid.');
  return value;
}
/** A query with a slash starts below that folder when it exists; otherwise the whole text matches names and paths. */
async function startScope(root: RegisteredRoot, query: string): Promise<Scope> {
  const cut = query.lastIndexOf('/'), dir = cut < 0 ? '' : query.slice(0, cut), needle = query.slice(cut + 1).toLowerCase();
  if (cut < 0) return {dir: '', needle, byPath: false};
  try {
    filePath(dir, true);
    const target = await checkedFilePath(root, dir);
    if (target.info.isDirectory()) return {dir, needle, byPath: false};
  } catch { /* An incomplete folder name still matches as part of a path. */ }
  return {dir: '', needle: query.toLowerCase(), byPath: true};
}
function rank(scope: Scope, name: string, path: string): number | undefined {
  const lowerName = name.toLowerCase();
  if (!scope.needle) return scope.byPath ? undefined : 0;
  if (!scope.byPath && lowerName.startsWith(scope.needle)) return 0;
  if (!scope.byPath && lowerName.includes(scope.needle)) return 1;
  return path.toLowerCase().includes(scope.needle) ? 2 : undefined;
}
function order(a: Match, b: Match): number { return a.rank - b.rank || a.depth - b.depth || (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0); }
function fitRows(rows: FileSearchRow[]): FileSearchRow[] {
  const kept = rows.slice(0, SEARCH_LIMITS.rows);
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept)) > SEARCH_LIMITS.bytes) kept.pop();
  return kept;
}
type Walk = {visited: number; skipped: number; limited?: 'time' | 'visits' | 'matches' | 'depth'};
type Listed = {name: string; directory: boolean};
async function readEntries(handle: Dir, walk: Walk): Promise<Listed[]> {
  const entries: Listed[] = [];
  while (walk.visited < SEARCH_LIMITS.visits) {
    const entry = await handle.read(); if (!entry) break; walk.visited++;
    if (excludedNames.has(entry.name)) continue;
    if (entry.isDirectory() || entry.isFile()) entries.push({name: entry.name, directory: entry.isDirectory()}); else walk.skipped++;
  }
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
async function listing(root: RegisteredRoot, path: string, walk: Walk): Promise<Listed[] | undefined> {
  try {
    const target = await checkedFilePath(root, path);
    if (!target.info.isDirectory()) return undefined;
    const handle = await opendir(target.path, {bufferSize: 1});
    try {return await readEntries(handle, walk);} finally {await handle.close();}
  } catch { walk.skipped++; return undefined; }
}
const boundNames = {time: 'time', visits: 'entry', matches: 'match', depth: 'depth'} as const;
type Level = {normal: string[]; deferred: string[]};
type Search = {root: RegisteredRoot; scope: Scope; walk: Walk; matches: Match[]; deadline: number};
function place(search: Search, parent: string, entry: Listed, depth: number, next: Level): void {
  const path = childPath(parent, entry.name); if (path === undefined) {search.walk.skipped++; return;}
  const found = rank(search.scope, entry.name, path);
  if (found !== undefined) search.matches.push({row: {name: entry.name, path, kind: entry.directory ? 'directory' : 'file'}, rank: found, depth});
  if (entry.directory) (deferredNames.has(entry.name) ? next.deferred : next.normal).push(path);
}
/** Reads one directory's entries into the match list and the next level; returns whether a bound ended the walk. */
async function visit(search: Search, parent: string, depth: number, next: Level): Promise<boolean> {
  const {walk, matches} = search;
  if (Date.now() > search.deadline) {walk.limited = 'time'; return true;}
  if (walk.visited >= SEARCH_LIMITS.visits) {walk.limited = 'visits'; return true;}
  for (const entry of await listing(search.root, parent, walk) ?? []) place(search, parent, entry, depth, next);
  if (matches.length >= SEARCH_LIMITS.matches) walk.limited = 'matches'; else if (walk.visited >= SEARCH_LIMITS.visits) walk.limited ??= 'visits';
  return !!walk.limited;
}
function coverageReason(walk: Walk): string | undefined {
  if (walk.limited) return `Searched part of the folder: the search reached its ${boundNames[walk.limited]} bound.`;
  return walk.skipped ? 'Some folders or entries were skipped.' : undefined;
}
async function walkLevels(search: Search): Promise<void> {
  let level: Level = {normal: [search.scope.dir], deferred: []};
  for (let depth = 1; depth <= SEARCH_LIMITS.depth && !search.walk.limited; depth++) {
    const next: Level = {normal: [], deferred: []};
    for (const parent of [...level.normal, ...level.deferred]) if (await visit(search, parent, depth, next)) break;
    const more = next.normal.length > 0 || next.deferred.length > 0;
    if (!search.walk.limited && depth === SEARCH_LIMITS.depth && more) search.walk.limited = 'depth';
    level = next; if (!more) return;
  }
}
/** Breadth-first name search under one registered root, bounded in visits, depth, time, matches and response bytes. */
export async function searchFiles(root: RegisteredRoot, rawQuery: string): Promise<FileSearchResult> {
  const query = searchQuery(rawQuery), scope = await startScope(root, query);
  const search: Search = {root, scope, walk: {visited: 0, skipped: 0}, matches: [], deadline: Date.now() + SEARCH_LIMITS.ms};
  await walkLevels(search);
  const {walk, matches} = search; matches.sort(order);
  const rows = fitRows(matches.map(match => match.row)), reason = coverageReason(walk);
  return {rootId: root.id, query, scope: scope.dir, rows, more: matches.length > rows.length || walk.limited === 'matches', coverage: {complete: !walk.limited && walk.skipped === 0, visited: walk.visited, skipped: walk.skipped, ...(reason ? {reason} : {})}};
}
