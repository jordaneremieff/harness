import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open, mkdir, realpath, rename, lstat, opendir, chmod, rm} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {RELEASE_FORMAT, BROWSER_API, type ReleaseManifest, type ReleaseSelection} from '../shared/release.ts';

export const RELEASE_LIMITS = {entries: 100000, bytes: 2 * 1024 ** 3, fileBytes: 128 * 1024 ** 2, releases: 8, rootBytes: 8 * 1024 ** 3, manifestBytes: 2 * 1024 ** 2};
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const releaseId = (id: string) => /^[a-f0-9]{64}$/.test(id);
export async function releaseRoot(stateDir: string) {
  await mkdir(stateDir, {recursive: true, mode: 0o700});
  const state = await realpath(stateDir), root = join(state, 'releases');
  await mkdir(root, {mode: 0o700, recursive: true});
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('The release root must be a private owned directory.');
  return {state, root, control: join(root, 'owner-control.sock'), claim: join(root, 'owner.json'), active: join(root, 'active.json'), recovery: join(root, 'owner-recovery')};
}
export async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('The release file exceeds its bound or is not a real file.');
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1)); let size = 0;
    while (size < bytes.length) {const read = await file.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead;}
    if (size > limit || size !== info.size) throw new Error('The release file changed during capture.');
    return bytes.subarray(0, size);
  } finally {await file.close();}
}
export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.pending`, file = await open(temporary, 'wx', 0o600);
  try {await file.writeFile(JSON.stringify(value)); await file.sync();} finally {await file.close();}
  try {await rename(temporary, path);} catch (error) {await rm(temporary, {force: true}); throw error;}
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid release metadata.');
  return value as Record<string, unknown>;
}
function manifestHeader(v:Record<string,unknown>) {
  if(v.format!==RELEASE_FORMAT||v.browserApi!==BROWSER_API||typeof v.ownerProtocol!=='string'||v.ownerProtocol.length>128||typeof v.iteration!=='string'||!/^\d+\.\d+$/.test(v.iteration))throw new Error('Incompatible release metadata.');
}
function manifestIdentities(v:Record<string,unknown>) {
  for(const name of ['id','sourceTree','sourceCommit','runtimeDigest','lockDigest','assetDigest','generation','moduleFamily']){
    const pattern=name==='sourceCommit'||name==='sourceTree'?/^[a-f0-9]{40,64}$/:/^[a-f0-9]{64}$/;
    if(typeof v[name]!=='string'||!pattern.test(v[name] as string))throw new Error('Invalid release identity.');
  }
  for(const name of ['stagedAt','committedAt'])if(typeof v[name]!=='string'||!Number.isFinite(Date.parse(v[name] as string)))throw new Error('Invalid release time.');
}
function manifestFiles(files:Record<string,unknown>) {
  if(Object.keys(files).length>4096)throw new Error('Invalid release inventory.');
  for(const [path,hash]of Object.entries(files))if(!/^(?:package\.json|(?:ui|transport)\/[a-zA-Z0-9_./-]+)$/.test(path)||path.split('/').includes('..')||typeof hash!=='string'||!releaseId(hash))throw new Error('Invalid release file inventory.');
}
function manifestImports(imports:Record<string,unknown>) {
  if(Object.keys(imports).length>256)throw new Error('Invalid release module inventory.');
  for(const [route,references]of Object.entries(imports))if(!/^\/(?:web|shared)\/[a-zA-Z0-9_-]+\.js$/.test(route)||!Array.isArray(references)||references.length>256||references.some(reference=>typeof reference!=='string'||!/^\.{1,2}\/[a-zA-Z0-9_./-]+\.js$/.test(reference)))throw new Error('Invalid release module imports.');
}
export function readManifest(value: unknown): ReleaseManifest {
  const v=object(value);manifestHeader(v);manifestIdentities(v);manifestFiles(object(v.files));manifestImports(object(v.imports));
  if(typeof v.branch!=='string'||v.branch.length>256)throw new Error('Invalid release inventory.');
  return v as unknown as ReleaseManifest;
}
export async function manifestAt(directory: string, verify = false) {
  const manifest = readManifest(JSON.parse((await boundedFile(join(directory, 'release.json'), RELEASE_LIMITS.manifestBytes)).toString('utf8')));
  if (verify) for (const [path, digest] of Object.entries(manifest.files)) if (sha256(await boundedFile(join(directory, path), RELEASE_LIMITS.fileBytes)) !== digest) throw new Error(`Release integrity mismatch: ${path}`);
  return manifest;
}
export async function findRelease(root: string, id: string): Promise<{directory: string; manifest: ReleaseManifest}> {
  if (!releaseId(id)) throw new Error('Use a complete release identity.');
  const descriptor = object(JSON.parse((await boundedFile(join(root, 'releases', `${id}.json`), 4096)).toString('utf8')));
  if (typeof descriptor.runtimeDigest !== 'string' || !releaseId(descriptor.runtimeDigest)) throw new Error('Invalid release runtime descriptor.');
  const directory = join(root, 'runtimes', descriptor.runtimeDigest, 'releases', id), info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The selected release is not sealed.');
  const manifest = await manifestAt(directory, true);
  if (manifest.id !== id) throw new Error('The release directory and identity differ.');
  return {directory, manifest};
}
export async function readSelection(root: string): Promise<ReleaseSelection | undefined> {
  try {
    const v = object(JSON.parse((await boundedFile(join(root, 'active.json'), 4096)).toString('utf8')));
    if (typeof v.current !== 'string' || !releaseId(v.current) || v.lastGood !== undefined && (typeof v.lastGood !== 'string' || !releaseId(v.lastGood)) || typeof v.updatedAt !== 'string') throw new Error('Invalid release selection.');
    return v as ReleaseSelection;
  } catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
}
export async function writeSelection(root: string, current: string, lastGood?: string) {
  if (!releaseId(current) || lastGood !== undefined && !releaseId(lastGood)) throw new Error('Invalid release selection.');
  await atomicJson(join(root, 'active.json'), {current, ...(lastGood ? {lastGood} : {}), updatedAt: new Date().toISOString()});
}
export async function sealTree(directory: string) {
  const entries = await inventory(directory);
  for (const entry of entries.reverse()) await chmod(join(directory, entry.path), entry.directory ? 0o500 : entry.executable ? 0o500 : 0o400);
  await chmod(directory, 0o500);
}
export type InventoryEntry = {path: string; directory: boolean; bytes: number; executable: boolean};
async function inventoryEntry(root:string,path:string):Promise<InventoryEntry> {
  const name=relative(root,path),info=await lstat(path);
  if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile())throw new Error(`Release snapshots refuse links and special files: ${name}`);
  if(info.size>RELEASE_LIMITS.fileBytes)throw new Error('A release file exceeds its byte bound.');
  return {path:name,directory:info.isDirectory(),bytes:info.isDirectory()?0:info.size,executable:!!(info.mode&0o111)};
}
/** This traversal has one shared entry, depth and byte budget. It never follows links. */
export async function inventory(root: string, omitBin = false, maximumBytes = RELEASE_LIMITS.bytes, maximumEntries = RELEASE_LIMITS.entries): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = []; let bytes = 0;
  const checkCount=()=>{if(entries.length>=maximumEntries)throw new Error('The release inventory exceeds its entry bound.');};
  const retain=(info:InventoryEntry)=>{bytes+=info.bytes;if(bytes>maximumBytes)throw new Error('The release inventory exceeds its byte bound.');entries.push(info);};
  const visit = async (directory: string, depth: number) => {
    if (depth > 32) throw new Error('The release inventory exceeds its depth bound.');
    const handle = await opendir(directory, {bufferSize: 1});
    for await (const entry of handle) {
      checkCount();
      if(omitBin&&entry.name==='.bin')continue;
      const path=join(directory,entry.name),info=await inventoryEntry(root,path);retain(info);if(info.directory)await visit(path,depth+1);
    }
  };
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error('The inventory root must be canonical and absolute.');
  await visit(root, 0); return entries;
}
