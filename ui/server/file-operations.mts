import {constants} from 'node:fs';
import {open, mkdir, lstat} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LIMITS} from '../shared/api.ts';
import type {FileMutation} from '../shared/files.ts';
import {ApiError,fileIdentityUncertain} from './errors.mts';
import {checkedFilePath, revalidateFileComponents, filePath, type RegisteredRoot} from './file-access.mts';
const execute = promisify(execFile);
const NATIVE = `ObjC.import('Foundation');
ObjC.bindFunction('renamex_np', ['int', ['char *', 'char *', 'unsigned int']]);
ObjC.bindFunction('__error', ['int *', []]);
function run(argv) {
  if (argv[0] === 'move') {
    var result = $.renamex_np(argv[1], argv[2], 4);
    return JSON.stringify({ok:result === 0, code:result === 0 ? 0 : $.__error()[0]});
  }
  var error = Ref();
  var success = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[1]), null, error);
  return JSON.stringify({ok:Boolean(success), code:success ? 0 : Number(error[0].code)});
}`;
/** Host paths are arguments, never executable source. No Finder or automation target participates. */
export async function nativeFileOperation(operation:'move'|'trash',source:string,destination?:string,run?:(argv:string[])=>Promise<string>):Promise<void> {
  if (process.platform !== 'darwin') throw new ApiError('unsupported','File move and Trash require macOS.');
  let output:string;const argv = ['-l','JavaScript','-e',NATIVE,operation,source,...(destination ? [destination] : [])];
  try {output = run ? await run(argv) : (await execute('/usr/bin/osascript',argv,{maxBuffer:8192,timeout:LIMITS.fileReadMs,encoding:'utf8'})).stdout;}
  catch {throw fileIdentityUncertain();}
  let value:{ok?:boolean;code?:number};
  try {value = JSON.parse(output);if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || typeof value.ok !== 'boolean' || !Number.isSafeInteger(value.code)) throw fileIdentityUncertain();} catch {throw fileIdentityUncertain();}
  if (value.ok === true && value.code === 0) return;
  if (value.ok === false && operation === 'move' && value.code === 17) throw new ApiError('file_changed','The destination already exists. Choose another name.',409,'read');
  if (value.ok === false && operation === 'move' && value.code === 18) throw new ApiError('unsupported','The destination is on another filesystem. The file stayed in place.');
  throw fileIdentityUncertain();
}
async function syncDirectory(path:string) {const handle = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);try {await handle.sync();} finally {await handle.close();}}
async function parent(root:RegisteredRoot,path:string) {
  filePath(path,false);const relative = dirname(path);const target = await checkedFilePath(root,relative === '.' ? '' : relative);
  if (!target.info.isDirectory()) throw new ApiError('file_unsafe','The destination parent is not a directory.');
  return target;
}
async function entry(root:RegisteredRoot,path:string) {
  filePath(path,false);const target = await checkedFilePath(root,path);
  if (!target.info.isDirectory() && (!target.info.isFile() || target.info.nlink !== 1)) throw new ApiError('file_unsafe','Only directories and regular files with one link support this action.');
  return target;
}
export async function createFileEntry(root:RegisteredRoot,path:string,kind:'file'|'directory',sync = syncDirectory):Promise<FileMutation> {
  const target = await parent(root,path), destination = join(root.path,path);
  await revalidateFileComponents(target.chain);
  let created = false;
  try {
    if (kind === 'directory') {await mkdir(destination,{mode:0o755});created = true;}
    else {const handle = await open(destination,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o644);created = true;try {await handle.sync();} finally {await handle.close();}}
    await revalidateFileComponents(target.chain);await sync(target.path);
  } catch (error) {if (created) throw fileIdentityUncertain();if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ApiError('file_changed','The destination already exists. Choose another name.',409,'read');throw error;}
  return {rootId:root.id,operation:'create',path,kind};
}
/** Darwin RENAME_EXCL refuses an existing destination inside the rename syscall. */
export async function moveFileEntry(root:RegisteredRoot,from:string,to:string,effect = nativeFileOperation,sync = syncDirectory):Promise<FileMutation> {
  filePath(to,false);
  if (from === to || to.startsWith(`${from}/`)) throw new ApiError('invalid_request','Choose a destination outside the source entry.');
  const source = await entry(root,from), destination = await parent(root,to);
  if (source.info.dev !== destination.info.dev) throw new ApiError('unsupported','Moves between filesystems are not supported.');
  await revalidateFileComponents(source.chain);await revalidateFileComponents(destination.chain);
  await effect('move',source.path,join(root.path,to));
  try {
    const after = await lstat(join(root.path,to));
    if (after.dev !== source.info.dev || after.ino !== source.info.ino) throw fileIdentityUncertain();
    await revalidateFileComponents(source.chain.slice(0,-1));await revalidateFileComponents(destination.chain);
    await sync(dirname(source.path));if (dirname(source.path) !== destination.path) await sync(destination.path);
  } catch {throw fileIdentityUncertain();}
  return {rootId:root.id,operation:'move',path:to,previousPath:from,kind:source.info.isDirectory() ? 'directory' : 'file'};
}
export async function trashFileEntry(root:RegisteredRoot,path:string,effect = nativeFileOperation,sync = syncDirectory):Promise<FileMutation> {
  const source = await entry(root,path);await revalidateFileComponents(source.chain);
  await effect('trash',source.path);
  try {await revalidateFileComponents(source.chain.slice(0,-1));await sync(dirname(source.path));} catch {throw fileIdentityUncertain();}
  return {rootId:root.id,operation:'trash',path,kind:source.info.isDirectory() ? 'directory' : 'file'};
}
