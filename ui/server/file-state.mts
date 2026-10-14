import {constants} from 'node:fs';
import {open, rename, unlink, lstat, type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LIMITS} from '../shared/api.ts';
import {fileSource, sameFileEncoding, sameFileRevision, type FileRootSelection, type FileDraft, type FileDraftState, type FileRevision, type FileSave, type FileEncoding} from '../shared/files.ts';
import {ApiError} from './errors.mts';
import {registerRoot, readText, writeText, filePath, type RegisteredRoot} from './file-access.mts';
const STATE_BYTES = 2 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Data = {format:'ui.files/1'; roots:RegisteredRoot[]; selections:Record<string,FileRootSelection>};
type DraftData = {format:'ui.file-drafts/1'; drafts:Record<string,FileDraft>};
function draftKey(rootId:string,path:string):string {return JSON.stringify([rootId,filePath(path,false)]);}
export function validateFileRevision(value:unknown):asserts value is FileRevision {
  const revision = value as FileRevision;
  if (!revision || typeof revision !== 'object' || Object.keys(revision).length !== 3 || !Number.isSafeInteger(revision.size) || revision.size < 0 || revision.size > LIMITS.fileTextBytes || !Number.isFinite(revision.mtimeMs) || typeof revision.digest !== 'string' || !/^[a-f0-9]{64}$/.test(revision.digest)) throw new ApiError('invalid_request','The file revision is invalid.');
}
export function validateFileEncoding(value:unknown):asserts value is FileEncoding {
  const encoding = value as FileEncoding;
  if (!encoding || typeof encoding !== 'object' || Object.keys(encoding).length !== 3 || typeof encoding.bom !== 'boolean' || typeof encoding.writable !== 'boolean' || !['lf','crlf'].includes(encoding.ending)) throw new ApiError('invalid_request','The file encoding is invalid.');
}
export function validateFileDraftText(value:unknown):asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > LIMITS.fileTextBytes) throw new ApiError('payload_too_large','The file draft exceeds the text byte bound.',413);
}
function publicRoot(root:RegisteredRoot) {return {id:root.id,path:root.path,name:root.name};}
function validate(raw:Data):Data {
  const invalid = () => {throw new ApiError('not_ready','Saved file state is invalid.',503);};
  if (raw?.format !== 'ui.files/1' || Object.keys(raw).length !== 3 || !Array.isArray(raw.roots) || raw.roots.length > LIMITS.fileRoots || !raw.selections || typeof raw.selections !== 'object' || Array.isArray(raw.selections) || Object.keys(raw.selections).length > LIMITS.workspaces) return invalid();
  for (const root of raw.roots) if (!root || Object.keys(root).length !== 5 || !uuid.test(root.id) || typeof root.path !== 'string' || !root.path.startsWith('/') || root.path.length > LIMITS.pathChars || typeof root.name !== 'string' || root.name.length > LIMITS.pathChars || !Number.isSafeInteger(root.dev) || !Number.isSafeInteger(root.ino)) invalid();
  if (new Set(raw.roots.map(root=>root.id)).size !== raw.roots.length) invalid();
  for (const [id, selection] of Object.entries(raw.selections)) if (!uuid.test(id) || !selection || Object.keys(selection).length !== 2 || !Number.isSafeInteger(selection.revision) || selection.revision < 0 || selection.root !== null && !raw.roots.some(root=>JSON.stringify(publicRoot(root)) === JSON.stringify(selection.root))) invalid();
  return raw;
}
function validateDrafts(raw:DraftData,roots:RegisteredRoot[]):DraftData {
  const invalid = () => {throw new ApiError('not_ready','Saved file drafts are invalid.',503);};
  if (raw?.format !== 'ui.file-drafts/1' || Object.keys(raw).length !== 2 || !raw.drafts || typeof raw.drafts !== 'object' || Array.isArray(raw.drafts)) invalid();
  for (const [key,draft] of Object.entries(raw.drafts)) {
    const identity = JSON.parse(key) as unknown[];
    if (!Array.isArray(identity) || identity.length !== 2 || typeof identity[0] !== 'string' || typeof identity[1] !== 'string' || !roots.some(root=>root.id === identity[0]) || draftKey(identity[0],identity[1]) !== key || !draft || Object.keys(draft).length !== 4 || !Number.isSafeInteger(draft.revision) || draft.revision < 1) invalid();
    validateFileRevision(draft.base);validateFileDraftText(draft.text);
    if (!draft.encoding || Object.keys(draft.encoding).length !== 3 || typeof draft.encoding.bom !== 'boolean' || typeof draft.encoding.writable !== 'boolean' || !['lf','crlf'].includes(draft.encoding.ending)) invalid();
  }
  return raw;
}
/** The enclosing UI state lock owns this file. No project directory contains UI metadata. */
export class FileState {
  private data:Data = {format:'ui.files/1',roots:[],selections:{}};
  private drafts:DraftData = {format:'ui.file-drafts/1',drafts:{}};
  private poisoned = false;
  readonly directory:string;
  constructor(directory:string) {this.directory = directory;}
  async load() {
    const roots = await this.read('files.json');if (roots !== undefined) this.data = validate(roots as Data);
    const drafts = await this.read('file-drafts.json',LIMITS.fileResponseBytes);if (drafts !== undefined) this.drafts = validateDrafts(drafts as DraftData,this.data.roots);
  }
  private async read(name:string,bound:number = STATE_BYTES):Promise<unknown> {
    let handle:FileHandle;
    try {handle = await open(join(this.directory,name),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > bound) throw new ApiError('not_ready','Saved file state is unsafe or exceeds its bound.',503);
      await handle.chmod(0o600);
      const bytes = Buffer.alloc(bound + 1); let length = 0;
      while (length < bytes.length) {const result = await handle.read(bytes,length,bytes.length-length,length); if (!result.bytesRead) break; length += result.bytesRead;}
      if (length > bound) throw new ApiError('not_ready','Saved file state exceeds its bound.',503);
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
    } finally {await handle.close();}
  }
  selection(workspace:string):FileRootSelection {return structuredClone(this.data.selections[workspace] ?? {revision:0,root:null});}
  root(id:string):RegisteredRoot {
    const root = this.data.roots.find(root=>root.id === id);
    if (!root) throw new ApiError('file_root_missing','The registered working folder is unavailable.',404);
    return structuredClone(root);
  }
  async select(workspace:string,path:string,expectedRevision:number):Promise<FileRootSelection> {
    if (!uuid.test(workspace) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ApiError('invalid_request','The working-folder selection is invalid.');
    if (this.poisoned) throw new ApiError('not_ready','File state requires a backend restart.',503,'manual');
    const current = this.selection(workspace);
    if (expectedRevision !== current.revision) throw new ApiError('stale_revision','The working folder changed. Refresh it before retry.',409,'read');
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new ApiError('capacity','The working-folder revision bound is full.',429);
    const candidate = await registerRoot(path,randomUUID());
    const existing = this.data.roots.find(root=>root.path === candidate.path && root.dev === candidate.dev && root.ino === candidate.ino);
    if (!existing && this.data.roots.length >= LIMITS.fileRoots || !Object.hasOwn(this.data.selections,workspace) && Object.keys(this.data.selections).length >= LIMITS.workspaces) throw new ApiError('capacity','The registered working-folder bound is full.',429);
    const root = existing ?? candidate, selection:FileRootSelection = {revision:current.revision+1,root:publicRoot(root)}, next = structuredClone(this.data);
    if (!existing) next.roots.push(root);
    next.selections[workspace] = selection;
    await this.persist(next); this.data = next;
    return structuredClone(selection);
  }
  draft(rootId:string,path:string):FileDraftState {
    this.root(rootId);const draft = this.drafts.drafts[draftKey(rootId,path)];return structuredClone({revision:draft?.revision ?? 0,draft:draft ?? null});
  }
  private currentDraft(rootId:string,path:string,expectedRevision:number):FileDraft|undefined {
    if (this.poisoned) throw new ApiError('not_ready','File state requires a backend restart.',503,'manual');
    const draft = this.draft(rootId,path).draft ?? undefined;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (draft?.revision ?? 0)) throw new ApiError('stale_revision','The file draft changed. Reload it before retry.',409,'read');
    if (expectedRevision >= Number.MAX_SAFE_INTEGER) throw new ApiError('capacity','The file draft revision bound is full.',429);
    return draft;
  }
  async putDraft(rootId:string,path:string,expectedRevision:number,base:FileRevision,text:string,encoding:FileEncoding):Promise<FileDraft> {
    validateFileRevision(base);validateFileDraftText(text);validateFileEncoding(encoding);const current = this.currentDraft(rootId,path,expectedRevision);
    if (current && sameFileRevision(current.base,base) && !sameFileEncoding(current.encoding,encoding)) throw new ApiError('invalid_request','The file draft encoding changed without a new disk revision.');
    if (current && !sameFileRevision(current.base,base)) {
      const source = await readText(this.root(rootId),path);
      if (!sameFileRevision(source.revision,base) || !sameFileEncoding(fileSource(source.text).encoding,encoding)) throw new ApiError('file_changed','The file changed on disk. Re-read it or keep editing the draft.',409,'read');
    }
    const draft:FileDraft = {revision:expectedRevision+1,base:structuredClone(base),encoding:{...encoding},text};const next = structuredClone(this.drafts);
    next.drafts[draftKey(rootId,path)] = draft;await this.persist(next,'file-drafts.json');this.drafts = next;return structuredClone(draft);
  }
  async saveDraft(rootId:string,path:string,expectedRevision:number):Promise<FileSave> {
    const current = this.currentDraft(rootId,path,expectedRevision);
    if (!current) throw new ApiError('invalid_request','Save requires an acknowledged file draft.');
    const draft:FileDraft = {...current,revision:expectedRevision+1};const next = structuredClone(this.drafts);next.drafts[draftKey(rootId,path)] = draft;
    // The fixed revision shape grows by fewer than these bytes when disk metadata is rebased.
    this.stateBytes(next,'file-drafts.json',64);
    const source = await writeText(this.root(rootId),path,current.base,current.text,current.encoding);draft.base = source.revision;
    try {await this.persist(next,'file-drafts.json');this.drafts = next;} catch (error) {this.poisoned = true;throw error;}
    return structuredClone({source,draft});
  }
  private stateBytes(data:Data|DraftData,name:string,reserve = 0):Buffer {
    const bytes = Buffer.from(JSON.stringify(data));
    if (bytes.length + reserve > (name === 'files.json' ? STATE_BYTES : LIMITS.fileResponseBytes)) throw new ApiError('capacity','The file state byte bound is full.',429);return bytes;
  }
  private async persist(data:Data|DraftData,name = 'files.json') {
    const bytes = this.stateBytes(data,name);
    const temp = join(this.directory,`.files-${randomUUID()}.tmp`), destination = join(this.directory,name);
    let handle:FileHandle|undefined, renamed = false;
    try {
      try {const info = await lstat(destination); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new ApiError('not_ready','Saved file state is unsafe.',503);}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      handle = await open(temp,'wx',0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temp,destination); renamed = true;
      const directory = await open(this.directory,constants.O_RDONLY | constants.O_NOFOLLOW); try {await directory.sync();} finally {await directory.close();}
    } catch (error) {if (renamed) this.poisoned = true; throw error;}
    finally {await handle?.close(); if (!renamed) await unlink(temp).catch(()=>{});}
  }
}
