export type FileRoot = {id: string; path: string; name: string};
export type FileRootSelection = {revision: number; root: FileRoot | null};
export type FileEntry = {name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other'};
export type FileCoverage = {complete: boolean; visited: number; reason?: string};
export type FileDirectoryPage = {rootId: string; path: string; entries: FileEntry[]; revision: string; nextCursor: string | null; coverage: FileCoverage};
export type FileRevision = {size: number; mtimeMs: number; digest: string};
/** Exact decoded UTF-8 source, independent of display normalization. */
export type FileText = {rootId: string; path: string; text: string; revision: FileRevision};
