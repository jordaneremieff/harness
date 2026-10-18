export type FileRoot = {id: string; path: string; name: string};
export type FileRootSelection = {revision: number; root: FileRoot | null};
export type FileEntry = {name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other'};
export type FileCoverage = {complete: boolean; visited: number; reason?: string};
/** One name-search row; discovery never reads file contents. */
export type FileSearchRow = {name: string; path: string; kind: 'directory' | 'file'};
export type FileSearchCoverage = {complete: boolean; visited: number; skipped: number; reason?: string};
export type FileSearchResult = {rootId: string; query: string; scope: string; rows: FileSearchRow[]; more: boolean; coverage: FileSearchCoverage};
export type FileDirectoryPage = {rootId: string; path: string; entries: FileEntry[]; revision: string; nextCursor: string | null; coverage: FileCoverage};
export type FileRevision = {size: number; mtimeMs: number; digest: string};
/** Exact decoded UTF-8 source, independent of display normalization. */
export type FileText = {rootId: string; path: string; text: string; revision: FileRevision};
export type FileEncoding = {bom: boolean; ending: 'lf' | 'crlf'; writable: boolean};
export type FileDraft = {revision: number; base: FileRevision; encoding: FileEncoding; text: string};
export type FileDraftState = {revision: number; draft: FileDraft | null};
export type FileSave = {source: FileText; draft: FileDraft};
export type FileWatchScope = {rootId:string; directories:string[]; files:string[]};
export type FileWatchRootState = {rootId:string; watch:'live'|'unavailable'; reason?:string};
export type FileWatchState = {roots:FileWatchRootState[]};
export type FileMove = {from:string; to:string; kind:'file'|'directory'};
export type FileChanges = {rootId:string; directories:string[]; files:string[]; rescan:boolean; watch:'live'|'unavailable'; reason?:string; move?:FileMove};
export type FileMutation = {rootId:string; operation:'create'|'move'|'trash'; path:string; kind:'file'|'directory'; previousPath?:string};
/** Descendants follow a directory move; unrelated prefixes remain unchanged. */
export function movedFilePath(path:string,from:string,to:string):string {return path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;}
export function sameFileEncoding(a:FileEncoding,b:FileEncoding):boolean {return a.bom === b.bom && a.ending === b.ending && a.writable === b.writable;}
export function sameFileRevision(a: FileRevision, b: FileRevision): boolean {return a.size === b.size && a.mtimeMs === b.mtimeMs && a.digest === b.digest;}
/** Native textarea source excludes only the initial BOM and normalizes CRLF. */
export function fileSource(text: string): {text: string; encoding: FileEncoding} {
  const bom = text.startsWith('\ufeff'); const source = bom ? text.slice(1) : text;
  const crlf = source.includes('\r\n'), rest = source.replace(/\r\n/g, '');
  return {text: source.replace(/\r\n?/g, '\n'), encoding: {bom, ending: crlf ? 'crlf' : 'lf', writable: !rest.includes('\r') && !(crlf && rest.includes('\n'))}};
}
