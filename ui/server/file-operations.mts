import {constants} from 'node:fs';
import {open, mkdir, lstat} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LIMITS} from '../shared/api.ts';
import type {FileMutation} from '../shared/files.ts';
import {ApiError} from './errors.mts';
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
export async function nativeFileOperation(operation:'move'|'trash',source:string,destination?:string):Promise<void> {
  if (process.platform !== 'darwin') throw new ApiError('unsupported','File move and Trash require macOS.');
  let output:string;
  try {output = (await execute('/usr/bin/osascript',['-l','JavaScript','-e',NATIVE,operation,source,...(destination ? [destination] : [])],{maxBuffer:8192,timeout:LIMITS.fileReadMs,encoding:'utf8'})).stdout;}
  catch {throw new ApiError('file_unavailable','The macOS file service did not confirm the operation. Refresh before another action.',503,'read');}
  let value:{ok?:boolean;code?:number};
  try {value = JSON.parse(output);} catch {throw new ApiError('file_unavailable','The macOS file service returned no confirmation. Refresh before another action.',503,'read');}
  if (value.ok === true && value.code === 0) return;
  if (operation === 'move' && value.code === 17) throw new ApiError('file_changed','The destination already exists. Choose another name.',409,'read');
  if (operation === 'move' && value.code === 18) throw new ApiError('unsupported','The destination is on another filesystem. The file stayed in place.');
  throw new ApiError('file_unavailable','The macOS file service refused the operation. Refresh before another action.',503,'read');
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
export async function createFileEntry(root:RegisteredRoot,path:string,kind:'file'|'directory'):Promise<FileMutation> {
  const target = await parent(root,path), destination = join(root.path,path);
  await revalidateFileComponents(target.chain);
  try {
    if (kind === 'directory') await mkdir(destination,{mode:0o755});
    else {const handle = await open(destination,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o644);try {await handle.sync();} finally {await handle.close();}}
  } catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ApiError('file_changed','The destination already exists. Choose another name.',409,'read');throw error;}
  await revalidateFileComponents(target.chain);await syncDirectory(target.path);
  return {rootId:root.id,operation:'create',path,kind};
}
/** Darwin RENAME_EXCL refuses an existing destination inside the rename syscall. */
export async function moveFileEntry(root:RegisteredRoot,from:string,to:string):Promise<FileMutation> {
  filePath(to,false);
  if (from === to || to.startsWith(`${from}/`)) throw new ApiError('invalid_request','Choose a destination outside the source entry.');
  const source = await entry(root,from), destination = await parent(root,to);
  if (source.info.dev !== destination.info.dev) throw new ApiError('unsupported','Moves between filesystems are not supported.');
  await revalidateFileComponents(source.chain);await revalidateFileComponents(destination.chain);
  await nativeFileOperation('move',source.path,join(root.path,to));
  const after = await lstat(join(root.path,to));
  if (after.dev !== source.info.dev || after.ino !== source.info.ino) throw new ApiError('file_changed','The moved entry changed. Refresh before another action.',409,'read');
  await revalidateFileComponents(source.chain.slice(0,-1));await revalidateFileComponents(destination.chain);
  await syncDirectory(dirname(source.path));if (dirname(source.path) !== destination.path) await syncDirectory(destination.path);
  return {rootId:root.id,operation:'move',path:to,previousPath:from,kind:source.info.isDirectory() ? 'directory' : 'file'};
}
export async function trashFileEntry(root:RegisteredRoot,path:string):Promise<FileMutation> {
  const source = await entry(root,path);await revalidateFileComponents(source.chain);
  await nativeFileOperation('trash',source.path);
  await revalidateFileComponents(source.chain.slice(0,-1));await syncDirectory(dirname(source.path));
  return {rootId:root.id,operation:'trash',path,kind:source.info.isDirectory() ? 'directory' : 'file'};
}
