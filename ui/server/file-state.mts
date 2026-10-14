import {constants} from 'node:fs';
import {open, rename, unlink, lstat, type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LIMITS} from '../shared/api.ts';
import type {FileRootSelection} from '../shared/files.ts';
import {ApiError} from './errors.mts';
import {registerRoot, type RegisteredRoot} from './file-access.mts';
const STATE_BYTES = 2 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Data = {format:'ui.files/1'; roots:RegisteredRoot[]; selections:Record<string,FileRootSelection>};
function publicRoot(root:RegisteredRoot) {return {id:root.id,path:root.path,name:root.name};}
function validate(raw:Data):Data {
  const invalid = () => {throw new ApiError('not_ready','Saved file state is invalid.',503);};
  if (raw?.format !== 'ui.files/1' || Object.keys(raw).length !== 3 || !Array.isArray(raw.roots) || raw.roots.length > LIMITS.fileRoots || !raw.selections || typeof raw.selections !== 'object' || Array.isArray(raw.selections) || Object.keys(raw.selections).length > LIMITS.workspaces) return invalid();
  for (const root of raw.roots) if (!root || Object.keys(root).length !== 5 || !uuid.test(root.id) || typeof root.path !== 'string' || !root.path.startsWith('/') || root.path.length > LIMITS.pathChars || typeof root.name !== 'string' || root.name.length > LIMITS.pathChars || !Number.isSafeInteger(root.dev) || !Number.isSafeInteger(root.ino)) invalid();
  if (new Set(raw.roots.map(root=>root.id)).size !== raw.roots.length) invalid();
  for (const [id, selection] of Object.entries(raw.selections)) if (!uuid.test(id) || !selection || Object.keys(selection).length !== 2 || !Number.isSafeInteger(selection.revision) || selection.revision < 0 || selection.root !== null && !raw.roots.some(root=>JSON.stringify(publicRoot(root)) === JSON.stringify(selection.root))) invalid();
  return raw;
}
/** The enclosing UI state lock owns this file. No project directory contains UI metadata. */
export class FileState {
  private data:Data = {format:'ui.files/1',roots:[],selections:{}};
  private poisoned = false;
  readonly directory:string;
  constructor(directory:string) {this.directory = directory;}
  async load() {
    let handle:FileHandle;
    try {handle = await open(join(this.directory,'files.json'),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > STATE_BYTES) throw new ApiError('not_ready','Saved file state is unsafe or exceeds its bound.',503);
      await handle.chmod(0o600);
      const bytes = Buffer.alloc(STATE_BYTES + 1); let length = 0;
      while (length < bytes.length) {const result = await handle.read(bytes,length,bytes.length-length,length); if (!result.bytesRead) break; length += result.bytesRead;}
      if (length > STATE_BYTES) throw new ApiError('not_ready','Saved file state exceeds its bound.',503);
      this.data = validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length))) as Data);
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
  private async persist(data:Data) {
    const bytes = Buffer.from(JSON.stringify(data));
    if (bytes.length > STATE_BYTES) throw new ApiError('capacity','The file state byte bound is full.',429);
    const temp = join(this.directory,`.files-${randomUUID()}.tmp`), destination = join(this.directory,'files.json');
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
