import {constants, type Stats} from 'node:fs';
import {lstat, realpath, open, opendir, rename, unlink, type FileHandle} from 'node:fs/promises';
import {createHash, createHmac, randomBytes, randomUUID} from 'node:crypto';
import {isAbsolute, join, relative, basename, dirname} from 'node:path';
import {LIMITS} from '../shared/api.ts';
import {fileSource, sameFileEncoding, sameFileRevision, type FileRoot, type FileEntry, type FileCoverage, type FileDirectoryPage, type FileText, type FileRevision, type FileEncoding} from '../shared/files.ts';
import {ApiError,fileIdentityUncertain} from './errors.mts';

export type RegisteredRoot = FileRoot & {dev: number; ino: number};
const excluded = new Set(['.git', '.hg', '.svn', '.bzr']);
export const excludedNames: ReadonlySet<string> = excluded;
const cursorKey = randomBytes(32);
export function filePath(value: unknown, empty = true): string {
  if (typeof value !== 'string' || value.length > LIMITS.pathChars || (!empty && !value) || isAbsolute(value) || value.includes('\\') || /[\u0000-\u001f\u007f]|%2f|%5c|%2e/i.test(value) || /[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))) throw new ApiError('invalid_request', 'The relative file path is invalid.');
  const parts = value ? value.split('/') : [];
  if (parts.length > 128 || parts.some(part => !part || part === '.' || part === '..' || excluded.has(part))) throw new ApiError('invalid_request', 'The relative file path is invalid.');
  return value;
}
export function fileFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') return new ApiError('file_missing', 'The file or directory is unavailable.', 404, 'read');
  if (code === 'ELOOP') return new ApiError('file_unsafe', 'Symbolic links are not supported.', 400);
  if (code === 'EACCES' || code === 'EPERM') return new ApiError('file_denied', 'The file or directory is not readable.', 403);
  return new ApiError('file_unavailable', 'The file operation failed.', 503, 'read');
}
function same(a: Pick<Stats, 'dev'|'ino'>, b: Pick<Stats, 'dev'|'ino'>) {return a.dev === b.dev && a.ino === b.ino;}
function unchanged(a: Stats, b: Stats) {return same(a,b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;}
function changed(): never {throw new ApiError('file_changed', 'The file or directory changed. Refresh it before retry.', 409, 'read');}
export async function registerRoot(path: unknown, id: string): Promise<RegisteredRoot> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > LIMITS.pathChars || /[\u0000-\u001f\u007f]/.test(path)) throw new ApiError('invalid_request', 'Use an absolute working-folder path.');
  const canonical = await realpath(path), info = await lstat(canonical);
  if (canonical.length > LIMITS.pathChars) throw new ApiError('invalid_request','The canonical working-folder path exceeds its bound.');
  if (canonical.split('/').some(part=>excluded.has(part))) throw new ApiError('file_unsafe', 'Version-control internals are excluded.');
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ApiError('file_unsafe', 'The working folder is not a directory.');
  return {id, path: canonical, name: basename(canonical) || canonical, dev: info.dev, ino: info.ino};
}
/** Component checks detect replacement. Path-based Node opens do not provide an adversarial openat boundary. */
export async function checkedFilePath(root: RegisteredRoot, path: string) {
  const rootInfo = await lstat(root.path);
  if (!same(root,rootInfo) || !rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root.path) !== root.path) changed();
  const chain: {path: string; info: Stats}[] = [{path: root.path, info: rootInfo}];
  let current = root.path;
  for (const component of filePath(path).split('/').filter(Boolean)) {
    current = join(current,component); const info = await lstat(current);
    if (info.isSymbolicLink()) throw new ApiError('file_unsafe', 'Symbolic links are not supported.');
    chain.push({path:current,info});
  }
  const canonical = await realpath(current), suffix = relative(root.path,canonical);
  if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix) || canonical !== current) throw new ApiError('file_unsafe', 'The path is outside its registered working folder.');
  const leaf = chain[chain.length-1]; if (!leaf) changed();
  return {path:current, info:leaf.info, chain};
}
export async function revalidateFileComponents(chain: {path:string;info:Stats}[]) {
  for (const entry of chain) {const info = await lstat(entry.path); if (!same(info,entry.info) || info.isSymbolicLink() || info.isDirectory() !== entry.info.isDirectory()) changed();}
}
function digest(value: string | Buffer) {return createHash('sha256').update(value).digest('hex');}
export function decodeText(content:Buffer): string {
  if (content.length > LIMITS.fileTextBytes) throw new ApiError('payload_too_large','The text file exceeds the byte bound.',413);
  if (content.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 || byte === 127)) throw new ApiError('file_binary','The file contains unsupported binary bytes.');
  let text: string;
  try {text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(content);} catch {throw new ApiError('file_binary','The file is not valid UTF-8 text.');}
  if (!Buffer.from(text,'utf8').equals(content)) throw new ApiError('file_binary','The file does not round-trip as UTF-8 text.');
  return text;
}
export type FileSnapshot = {
  target: Awaited<ReturnType<typeof checkedFilePath>>;
  info: Stats;
  handle: FileHandle;
  content: Buffer;
  text: string;
  revision: FileRevision;
};
/** The callback retains the checked leaf descriptor until it completes. */
export async function withFileSnapshot<T>(root: RegisteredRoot, path: string, use: (snapshot: FileSnapshot) => Promise<T>): Promise<T> {
  filePath(path,false); const target = await checkedFilePath(root,path);
  if (!target.info.isFile() || target.info.nlink !== 1) throw new ApiError('file_unsafe', 'Only regular files with one link are supported.');
  if (target.info.size > LIMITS.fileTextBytes) throw new ApiError('payload_too_large', 'The text file exceeds the byte bound.',413);
  const handle = await open(target.path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !unchanged(before,target.info)) changed();
    if (before.size > LIMITS.fileTextBytes) throw new ApiError('payload_too_large','The text file exceeds the byte bound.',413);
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) {const result = await handle.read(bytes,length,bytes.length-length,length); if (!result.bytesRead) break; length += result.bytesRead;}
    const after = await handle.stat();
    if (length > LIMITS.fileTextBytes) throw new ApiError('payload_too_large','The text file exceeds the byte bound.',413);
    if (length !== before.size || !unchanged(before,after)) changed();
    const content = bytes.subarray(0,length);
    const text = decodeText(content);
    await revalidateFileComponents(target.chain); const current = await lstat(target.path); if (!unchanged(after,current)) changed();
    return await use({target,info:after,handle,content,text,revision:{size:length,mtimeMs:after.mtimeMs,digest:digest(content)}});
  } finally {await handle.close();}
}
export async function readText(root: RegisteredRoot, path: string): Promise<FileText> {
  return withFileSnapshot(root,path,async snapshot => {
    return {rootId:root.id,path,text:snapshot.text,revision:snapshot.revision};
  });
}
export function encodeFileText(text:string, encoding:FileEncoding):Buffer {
  if (!encoding.writable) throw new ApiError('unsupported','Mixed line endings or lone carriage returns prevent exact file writes.');
  if (typeof text !== 'string' || text.includes('\r') || /[\ud800-\udfff]/u.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g,''))) throw new ApiError('unsupported','The edited text does not round-trip as normalized UTF-8.');
  const bytes = Buffer.from(`${encoding.bom ? '\ufeff' : ''}${encoding.ending === 'crlf' ? text.replace(/\n/g,'\r\n') : text}`,'utf8');
  decodeText(bytes);return bytes;
}
/** Revision checks detect ordinary external changes; the final path check cannot make rename a compare-and-swap. */
export async function writeText(root:RegisteredRoot,path:string,base:FileRevision,text:string,encoding:FileEncoding):Promise<FileText> {
  const bytes = encodeFileText(text,encoding);let renamed = false;
  try {return await withFileSnapshot(root,path,async snapshot=> {
    if (!sameFileRevision(snapshot.revision,base)) throw new ApiError('file_changed','The file changed on disk. Re-read it or keep editing the draft.',409,'read');
    if (!sameFileEncoding(fileSource(snapshot.text).encoding,encoding)) throw new ApiError('invalid_request','The file encoding does not match its disk revision.');
    const parent = dirname(snapshot.target.path), temp = join(parent,`.ui-file-${randomUUID()}.tmp`);let handle:FileHandle|undefined;
    try {
      handle = await open(temp,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
      await handle.writeFile(bytes);await handle.chmod(snapshot.info.mode & 0o7777);await handle.sync();await handle.close();handle = undefined;
      await withFileSnapshot(root,path,async current=> {if (!sameFileRevision(current.revision,base) || !unchanged(current.info,snapshot.info)) changed();return undefined;});
      await revalidateFileComponents(snapshot.target.chain);
      await rename(temp,snapshot.target.path);renamed = true;
      const directory = await open(parent,constants.O_RDONLY | constants.O_NOFOLLOW);try {await directory.sync();} finally {await directory.close();}
      const result = await readText(root,path);
      if (result.revision.digest !== digest(bytes)) changed();return result;
    } finally {await handle?.close();if (!renamed) await unlink(temp).catch(()=>{});}
  });} catch (error) {if (renamed) throw fileIdentityUncertain();throw error;}
}
function kind(entry: {isDirectory():boolean;isFile():boolean;isSymbolicLink():boolean}): FileEntry['kind'] {return entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other';}
function compare(a:FileEntry,b:FileEntry) {return Number(b.kind === 'directory') - Number(a.kind === 'directory') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);}
export function childPath(parent:string,name:string):string|undefined {
  try {return filePath(parent ? `${parent}/${name}` : name,false);} catch {return undefined;}
}
async function enumerate(root: RegisteredRoot,path:string,entryLimit:number,byteLimit:number) {
  const target = await checkedFilePath(root,path);
  if (!target.info.isDirectory()) throw new ApiError('invalid_request','The path is not a directory.');
  const entries: FileEntry[] = []; let visited = 0, bytes = 0, complete = true;
  const directory = await opendir(target.path,{bufferSize:1});
  try {
    while (visited < entryLimit) {
      const entry = await directory.read(); if (!entry) break; visited++;
      if (visited === entryLimit) complete = false;
      if (excluded.has(entry.name)) continue;
      const child = childPath(path,entry.name);
      if (child === undefined) {complete = false; continue;}
      const value: FileEntry = {name:entry.name,path:child,kind:kind(entry)};
      const cost = Buffer.byteLength(JSON.stringify(value));
      if (bytes + cost > byteLimit) {complete = false; break;}
      bytes += cost; entries.push(value);
    }
  } finally {await directory.close();}
  await revalidateFileComponents(target.chain); const after = await lstat(target.path); if (!unchanged(target.info,after)) changed();
  entries.sort(compare);
  const revision = digest(JSON.stringify({root:root.id,path,dev:after.dev,ino:after.ino,mtime:after.mtimeMs,ctime:after.ctimeMs,entries}));
  return {entries,visited,bytes,complete,revision};
}
function cursorPayload(rootId:string,path:string,revision:string,limit:number,offset:number) {return JSON.stringify({rootId,path,revision,limit,offset});}
function cursor(rootId:string,path:string,revision:string,limit:number,offset:number) {
  const payload = Buffer.from(cursorPayload(rootId,path,revision,limit,offset)).toString('base64url');
  return `${payload}.${createHmac('sha256',cursorKey).update(payload).digest('base64url')}`;
}
function cursorOffset(value:string,rootId:string,path:string,revision:string,limit:number) {
  if (value.length > LIMITS.cursorBytes) throw new ApiError('invalid_request','The directory cursor is invalid.');
  const [payload,signature,...extra] = value.split('.');
  if (!payload || !signature || extra.length || createHmac('sha256',cursorKey).update(payload).digest('base64url') !== signature) throw new ApiError('file_changed','The directory cursor expired. Refresh the folder.',409,'read');
  try {const raw = JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as {offset:number};
    if (!Number.isSafeInteger(raw.offset) || raw.offset < 0 || cursorPayload(rootId,path,revision,limit,raw.offset) !== Buffer.from(payload,'base64url').toString('utf8')) changed();
    return raw.offset;
  } catch {return changed();}
}
export async function directoryPage(root:RegisteredRoot,path:string,limit:number,cursorValue?:string): Promise<FileDirectoryPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.filePageItems) throw new ApiError('invalid_request','The directory page size is invalid.');
  const scan = await enumerate(root,path,LIMITS.fileDirectoryEntries,LIMITS.fileScanBytes);
  const offset = cursorValue ? cursorOffset(cursorValue,root.id,path,scan.revision,limit) : 0;
  if (offset > scan.entries.length) changed();
  const end = Math.min(scan.entries.length,offset+limit);
  const coverage: FileCoverage = {complete:scan.complete,visited:scan.visited,...(!scan.complete ? {reason:'The directory scan reached a bound or omitted unsupported names.'} : {})};
  return {rootId:root.id,path,entries:scan.entries.slice(offset,end),nextCursor:end < scan.entries.length ? cursor(root.id,path,scan.revision,limit,end) : null,revision:scan.revision,coverage};
}
