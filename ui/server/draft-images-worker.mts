import {constants} from 'node:fs';
import type {Dirent} from 'node:fs';
import {chmod, lstat, mkdir, open, opendir, rename, unlink} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {parentPort, workerData} from 'node:worker_threads';
import {LIMITS} from '../shared/api.ts';
import {ApiError} from './errors.mts';
import {validateImageBytes} from './images.mts';
import type {ValidatedImage} from './images.mts';
import {sameImageContent} from './draft-images.mts';
import type {BlobIndex, BlobReferenceGraph, UploadReservation} from './draft-images.mts';

const root = resolve(workerData.root), base = join(root, 'images');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const intakes = new Map<string, {reservation: UploadReservation; file?: FileHandle; bytes: number; image?: ValidatedImage}>();
function fail(message: string): never { throw new ApiError('image_storage_unavailable', message, 503); }
async function sync(path: string): Promise<void> { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await file.sync(); } finally { await file.close(); } }
async function directory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Image storage directory is unavailable.');
  await chmod(path, 0o700);
}
async function targetDirectory(targetKey: string, create = false): Promise<string> {
  if (!UUID.test(targetKey)) fail('Image target identity is invalid.');
  await directory(root); await directory(base, create);
  const path = join(base, targetKey); await directory(path, create);
  if (create) { await sync(root); await sync(base); }
  return path;
}
function imagePath(path: string, digest: string): string { if (!DIGEST.test(digest)) fail('Image digest is invalid.'); return join(path, `${digest}.bin`); }
function tempPath(path: string, id: string): string { if (!UUID.test(id)) fail('Image intake identity is invalid.'); return join(path, `${id}.tmp`); }
async function bytesAt(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > LIMITS.imageBytes) fail('Image bytes are unavailable or exceed their bound.');
    const data = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < data.length) { const {bytesRead} = await file.read(data, offset, data.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== info.size) fail('Image bytes changed during read.');
    return data.subarray(0, offset);
  } finally { await file.close(); }
}
async function verified(targetKey: string, image: ValidatedImage): Promise<Buffer> {
  try {
    const path = await targetDirectory(targetKey); const bytes = await bytesAt(imagePath(path, image.digest));
    if (!sameImageContent(validateImageBytes(bytes, image.mimeType), image)) throw new Error('Image metadata changed');
    return bytes;
  } catch { throw new ApiError('image_unavailable', 'The referenced image bytes are missing or changed.', 409, 'read'); }
}
async function scanEntry(targetKey: string, path: string, item: Dirent, result: BlobIndex): Promise<void> {
  if (!item.isFile()) fail('Image storage has unexpected entries.');
  const file = join(path, item.name), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('Image storage contains a nonregular entry.');
  if (item.name.endsWith('.tmp') && UUID.test(item.name.slice(0, -4))) {
    if (info.size > LIMITS.imageBytes) fail('Image temporary file exceeds its bound.');
    result.temps.push({targetKey, id: item.name.slice(0, -4), bytes: info.size}); return;
  }
  if (!item.name.endsWith('.bin') || !DIGEST.test(item.name.slice(0, -4))) fail('Image storage contains unknown content.');
  const bytes = await bytesAt(file);
  const mimeType = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'image/png' : 'image/jpeg';
  const image = validateImageBytes(bytes, mimeType);
  if (image.digest !== item.name.slice(0, -4)) fail('Stored image digest does not match its bytes.');
  result.entries.push({targetKey, image});
}
function countEntry(counter: {entries: number}): void {
  if (++counter.entries > LIMITS.blobEntries) fail('Image storage has excess directory entries.');
}
async function scanTarget(targetKey: string, result: BlobIndex, counter: {entries: number}): Promise<void> {
  countEntry(counter); result.directories.push(targetKey);
  const path = await targetDirectory(targetKey);
  for await (const item of await opendir(path, {bufferSize: 1})) {
    countEntry(counter); await scanEntry(targetKey, path, item, result);
  }
}
function checkReferences(graph: BlobReferenceGraph, result: BlobIndex): void {
  for (const reference of graph.references) {
    const entry = result.entries.find(value => value.targetKey === reference.targetKey && value.image.digest === reference.image.digest);
    if (!entry || !sameImageContent(entry.image, reference.image)) {
      result.unavailable ??= []; result.unavailable.push({targetKey: reference.targetKey, digest: reference.image.digest});
    }
  }
  if (result.unavailable?.length) result.error = 'A saved image reference is unavailable. No cleanup or upload is permitted.';
}
async function scan(graph: BlobReferenceGraph): Promise<BlobIndex> {
  await directory(root); await directory(base, true); await sync(root);
  const result: BlobIndex = {directories: [], entries: [], temps: []}, counter = {entries: 0}; let visits = 0;
  const known = new Set(graph.targetKeys);
  try {
    for await (const entry of await opendir(base, {bufferSize: 1})) {
      if (++visits > LIMITS.targets || !known.has(entry.name) || !entry.isDirectory() || !UUID.test(entry.name)) fail('Unexpected image storage directory.');
      await scanTarget(entry.name, result, counter);
    }
  } catch { result.error = 'Image storage has corrupt, unknown or excess entries. No cleanup or upload is permitted.'; }
  checkReferences(graph, result); return result;
}
async function begin(reservation: UploadReservation): Promise<void> {
  if (intakes.size >= LIMITS.imageUploads || intakes.has(reservation.id)) throw new ApiError('capacity', 'Image intake capacity is occupied.', 429);
  if (!Number.isSafeInteger(reservation.maxBytes) || reservation.maxBytes < 1 || reservation.maxBytes > LIMITS.imageBytes) fail('Image intake bound is invalid.');
  const path = await targetDirectory(reservation.targetKey, true);
  const file = await open(tempPath(path, reservation.id), 'wx', 0o600);
  intakes.set(reservation.id, {reservation, file, bytes: 0});
}
async function write(id: string, data: Uint8Array): Promise<void> {
  const item = intakes.get(id);
  if (!item?.file || !(data instanceof Uint8Array) || data.byteLength > 64 * 1024) fail('Image intake chunk is invalid.');
  if (Date.now() > item.reservation.receiveDeadlineAt || item.bytes + data.byteLength > item.reservation.maxBytes) throw new ApiError('payload_too_large', 'Image intake exceeded its deadline or byte reservation.', 413);
  await item.file.writeFile(data); item.bytes += data.byteLength;
}
async function finish(id: string): Promise<ValidatedImage> {
  const item = intakes.get(id); if (!item?.file) fail('Image intake is unavailable.');
  if (Date.now() > item.reservation.receiveDeadlineAt) throw new ApiError('not_ready', 'Image receive deadline expired.', 408);
  await item.file.sync(); await item.file.close(); delete item.file;
  const path = await targetDirectory(item.reservation.targetKey);
  item.image = validateImageBytes(await bytesAt(tempPath(path, id)), item.reservation.mimeType);
  return item.image;
}
async function publish(reservation: UploadReservation, image: ValidatedImage): Promise<void> {
  const item = intakes.get(reservation.id);
  if (!item?.image || !sameImageContent(item.image, image) || item.reservation.targetKey !== reservation.targetKey) fail('Validated image intake is unavailable.');
  const path = await targetDirectory(reservation.targetKey), destination = imagePath(path, image.digest);
  let exists = true;
  try { await lstat(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
  if (exists) { await verified(reservation.targetKey, image); await unlink(tempPath(path, reservation.id)); }
  else await rename(tempPath(path, reservation.id), destination);
  await sync(path); intakes.delete(reservation.id);
}
async function cancel(id: string, targetKey: string): Promise<void> {
  const item = intakes.get(id); await item?.file?.close();
  let path: string;
  try { path = await targetDirectory(targetKey); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !item) return; throw error; }
  await unlink(tempPath(path, id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await sync(path); intakes.delete(id);
}
type Message = {id: number} & (
  {action: 'scan'; body: BlobReferenceGraph} | {action: 'begin'; body: UploadReservation} |
  {action: 'write'; body: {id: string; data: Uint8Array}} | {action: 'finish'; body: {id: string}} |
  {action: 'publish'; body: {reservation: UploadReservation; image: ValidatedImage}} |
  {action: 'cancel'; body: {id: string; targetKey: string}} |
  {action: 'read' | 'verify' | 'reference'; body: {targetKey: string; image: ValidatedImage}} |
  {action: 'remove'; body: {targetKey: string; image?: ValidatedImage; id?: string}});
async function work(message: Message): Promise<unknown> {
  switch (message.action) {
    case 'scan': return scan(message.body);
    case 'begin': return begin(message.body);
    case 'write': return write(message.body.id, message.body.data);
    case 'finish': return finish(message.body.id);
    case 'publish': return publish(message.body.reservation, message.body.image);
    case 'cancel': return cancel(message.body.id, message.body.targetKey);
    case 'read': return {mimeType: message.body.image.mimeType, data: await verified(message.body.targetKey, message.body.image)};
    case 'verify': await verified(message.body.targetKey, message.body.image); return;
    case 'reference': await verified(message.body.targetKey, message.body.image); return imagePath(await targetDirectory(message.body.targetKey), message.body.image.digest);
    case 'remove': {
      const body = message.body, path = await targetDirectory(body.targetKey);
      const file = body.image ? imagePath(path, body.image.digest) : tempPath(path, body.id ?? '');
      if (body.image) await verified(body.targetKey, body.image);
      else { const info = await lstat(file); if (!info.isFile() || info.nlink !== 1 || info.size > LIMITS.imageBytes) fail('Temporary image content is unavailable.'); }
      await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); await sync(path); return;
    }
  }
}
let queue: Promise<unknown> = Promise.resolve();
parentPort?.on('message', (message: Message) => {
  queue = queue.then(async () => {
    try { parentPort?.postMessage({id: message.id, value: await work(message)}); }
    catch (error) { parentPort?.postMessage({id: message.id, error: error instanceof ApiError ? {code: error.code, message: error.message, status: error.status} : {code: 'image_storage_unavailable', message: 'Image storage action failed.', status: 503}}); }
  });
});
