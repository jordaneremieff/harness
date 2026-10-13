import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { LIMITS } from '../shared/api.ts';
import type { DraftImage, ImageUploadView } from '../shared/api.ts';
import { attachmentMetadata, attachmentName, ComposerAttachments, includedText, missingImageIndexes } from './composer-attachments.ts';
import { ApiError } from './transport.ts';

function png(width = 1, height = 1, seed = 0): Uint8Array {
  const bytes = new Uint8Array(57), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); bytes.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(16, width); view.setUint32(20, height); bytes[24] = 8; bytes[25] = 6; bytes[32] = seed;
  bytes.set(new TextEncoder().encode('IDAT'), 37); bytes.set(new TextEncoder().encode('IEND'), 49); return bytes;
}
const file = (name = 'one.png', seed = 0) => new File([png(1, 1, seed)], name, {type: 'image/png'});
const target = {workspace: 'captured workspace', targetKey: 'captured target', target: {kind: 'primary' as const, key: 'p', epoch: 9}};
function fixture(t: TestContext) {
  const images: DraftImage[] = [], uploads: {path: string; bytes: Blob; signal: AbortSignal}[] = [];
  let refusal: string | undefined, upload: ((result: ImageUploadView, signal: AbortSignal) => Promise<ImageUploadView>) | undefined;
  const originalBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  let decodes = 0, closed = 0;
  Object.defineProperty(globalThis, 'createImageBitmap', {configurable: true, value: async () => {decodes++; return {width: 1, height: 1, close: () => {closed++;}};}});
  t.after(() => {if (originalBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalBitmap); else Reflect.deleteProperty(globalThis, 'createImageBitmap');});
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    const bytes = init?.body as Blob, signal = init?.signal as AbortSignal; uploads.push({path: String(path), bytes, signal});
    const source = new Uint8Array(await bytes.arrayBuffer());
    const image = {...attachmentMetadata(source), name: new URL(String(path), 'http://fixture').searchParams.get('name') ?? '', digest: createHash('sha256').update(source).digest('hex')};
    const result: ImageUploadView = {targetKey: target.targetKey, target: target.target, image, leaseExpiresAt: 'later'};
    return Response.json({ok: true, data: upload ? await upload(result, signal) : result});
  });
  const waiting = new Set<() => void>();
  const owner = new ComposerAttachments(target, {images: () => images, add: image => images.push(image), refusal: () => refusal, changed: () => {for (const notify of waiting) notify();}});
  t.after(() => owner.destroy());
  const wait = (predicate: () => boolean) => new Promise<void>(resolve => {
    const notify = () => {if (predicate()) {waiting.delete(notify); resolve();}}; waiting.add(notify); notify();
  });
  return {owner, images, uploads, wait, counts: () => ({decodes, closed}), refuse: (reason?: string) => {refusal = reason;}, upload: (fn: NonNullable<typeof upload>) => {upload = fn;}};
}

test('container metadata checks signatures, dimensions and complete PNG/JPEG structure', () => {
  assert.deepEqual(attachmentMetadata(png(23, 41)), {mimeType: 'image/png', bytes: 57, width: 23, height: 41});
  assert.deepEqual(attachmentMetadata(new Uint8Array([255, 216, 255, 192, 0, 8, 8, 0, 2, 0, 3, 1, 255, 217])), {mimeType: 'image/jpeg', bytes: 14, width: 3, height: 2});
  for (const bytes of [new Uint8Array(), new Uint8Array([1, 2]), png(0, 1), png(8193, 1), png(4097, 4097), png().slice(0, -1)]) assert.throws(() => attachmentMetadata(bytes));
  const animated = png(); animated.set(new TextEncoder().encode('acTL'), 37); assert.throws(() => attachmentMetadata(animated), /Animated/);
  const trailing = new Uint8Array(58); trailing.set(png()); assert.throws(() => attachmentMetadata(trailing), /container/);
  const malformed = png(); new DataView(malformed.buffer).setUint32(33, 1000); assert.throws(() => attachmentMetadata(malformed), /malformed/);
});
test('filenames use code-point and control/path bounds without inferring a host path', () => {
  assert.equal(attachmentName('🖼'.repeat(240)), '🖼'.repeat(240));
  for (const name of ['', '🖼'.repeat(241), 'folder/name', 'folder\\name', 'line\nname', 'nul\0name']) assert.throws(() => attachmentName(name));
});
test('explicit text inclusion retains source, BOM and whitespace behind a safe fence', () => {
  const source = '\uFEFF first\r\n````\n  last '; const bytes = new TextEncoder().encode(source);
  const included = includedText(bytes, 'notes "one".txt');
  assert.equal(included, `File: "notes \\"one\\".txt"\n\`\`\`\`\`\n${source}\n\`\`\`\`\`\n`);
  assert.throws(() => includedText(new Uint8Array([0xff]), 'bad.txt'), /UTF-8/);
  assert.throws(() => includedText(new Uint8Array([0]), 'bad.txt'), /NUL/);
  assert.throws(() => includedText(new Uint8Array(LIMITS.textFileBytes + 1), 'big.txt'), /32 KiB/);
});
test('missing-image repair accepts only bounded exact-target typed indexes', () => {
  const images = [{digest: 'a'}, {digest: 'b'}] as DraftImage[];
  const error = (value: unknown, truncated = false, code = 'unknown_image_digest') => new ApiError({code, message: 'missing', retry: 'manual', details: {value, truncated}});
  assert.deepEqual(missingImageIndexes(error({targetKey: 'a', missingIndexes: [1, 0]}), 'a', images), [1, 0]);
  for (const value of [{targetKey: 'b', missingIndexes: [0]}, {targetKey: 'a', missingIndexes: []}, {targetKey: 'a', missingIndexes: [2]}, {targetKey: 'a', missingIndexes: [-1]}, {targetKey: 'a', missingIndexes: [0, 0]}, {targetKey: 'a', missingIndexes: ['0']}]) assert.equal(missingImageIndexes(error(value), 'a', images), undefined);
  assert.equal(missingImageIndexes(error({targetKey: 'a', missingIndexes: [0]}, true), 'a', images), undefined);
  assert.equal(missingImageIndexes(error({targetKey: 'a', missingIndexes: [0]}, false, 'internal'), 'a', images), undefined);
});
test('preparation decodes and uploads exact original bytes in selection order', async t => {
  const f = fixture(t), files = [file('first.png'), file('second.png', 1)];
  f.owner.add(files); await f.wait(() => !f.owner.pending);
  assert.deepEqual(f.images.map(image => image.name), ['first.png', 'second.png']);
  assert.equal(f.uploads[0].bytes, files[0]); assert.equal(f.uploads[1].bytes, files[1]);
  assert.equal(f.uploads[0].path, '/api/workspaces/captured%20workspace/targets/captured%20target/images?name=first.png&epoch=9');
  assert.deepEqual(f.counts(), {decodes: 2, closed: 2});
});
test('host refusal preserves named local files without decoding or upload', async t => {
  const f = fixture(t); f.refuse('This connection does not accept images.'); const selected = file(); f.owner.add([selected]);
  await f.wait(() => !f.owner.busy); assert.equal(f.owner.items[0].state, 'failed'); assert.equal(f.owner.items[0].file, selected);
  assert.match(f.owner.items[0].error ?? '', /does not accept/); assert.equal(f.uploads.length, 0); assert.equal(f.counts().decodes, 0);
  f.refuse(); f.owner.retry(f.owner.items[0]); await f.wait(() => !f.owner.pending); assert.equal(f.images.length, 1);
});
test('upload errors remain visible and retry requires an explicit action', async t => {
  const f = fixture(t); f.upload(async () => {throw new Error('connection lost');}); f.owner.add([file()]); await f.wait(() => !f.owner.busy);
  assert.equal(f.owner.items[0].error, 'connection lost'); assert.equal(f.images.length, 0); assert.equal(f.uploads.length, 1);
  f.upload(async result => result); assert.equal(f.uploads.length, 1); f.owner.retry(f.owner.items[0]); await f.wait(() => !f.owner.pending); assert.equal(f.images.length, 1);
});
test('a late successful response after removal never recreates an attachment', async t => {
  const f = fixture(t), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.upload(async result => {started.resolve(); await release.promise; return result;}); f.owner.add([file()]); await started.promise;
  const item = f.owner.items[0]; f.owner.remove(item); assert.equal(item.file, undefined); assert.equal(f.uploads[0].signal.aborted, true);
  release.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.images.length, 0); assert.equal(f.owner.pending, false);
});
test('access suspension stops upload but retains exact bytes for a later deliberate retry', async t => {
  const f = fixture(t), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), selected = file();
  f.upload(async result => {started.resolve(); await release.promise; return result;}); f.owner.add([selected]); await started.promise;
  f.owner.suspend(); assert.equal(f.owner.items[0].file, selected); assert.equal(f.owner.items[0].state, 'failed'); assert.equal(f.uploads[0].signal.aborted, true);
  release.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.images.length, 0);
  f.upload(async result => result); f.owner.retry(f.owner.items[0]); await f.wait(() => !f.owner.pending); assert.equal(f.images.length, 1);
});
test('mismatched upload identity or metadata does not enter the draft', async t => {
  const f = fixture(t); f.upload(async result => ({...result, target: {...target.target, epoch: 10}})); f.owner.add([file()]); await f.wait(() => !f.owner.busy);
  assert.match(f.owner.items[0].error ?? '', /does not match/); assert.equal(f.images.length, 0);
});
test('file and aggregate bounds refuse before expensive decoding', async t => {
  const f = fixture(t); assert.throws(() => f.owner.add(Array.from({length: 5}, () => file())), /four/); assert.equal(f.owner.pending, false);
  f.images.push({...attachmentMetadata(png()), name: 'existing.png', digest: 'a'.repeat(64), bytes: LIMITS.draftImageBytes});
  f.owner.add([file()]); await f.wait(() => !f.owner.busy); assert.match(f.owner.items[0].error ?? '', /8 MiB/); assert.equal(f.counts().decodes, 0); assert.equal(f.uploads.length, 0);
});
test('non-images expose explicit inclusion only after bounded strict text validation', async t => {
  const f = fixture(t); f.owner.add([new File(['valid\n'], 'notes.txt'), new File([new Uint8Array([0xff])], 'binary.dat'), new File(['not an image'], 'wrong.png', {type: 'image/png'})]);
  await f.wait(() => !f.owner.busy); assert.deepEqual(f.owner.items.map(item => item.state), ['text', 'failed', 'failed']);
  assert.equal(f.images.length, 0); assert.equal(f.uploads.length, 0);
});
test('lease repair reuses retained bytes and explicit release prevents hidden reacquisition', async t => {
  const f = fixture(t), selected = file(); f.owner.add([selected]); await f.wait(() => !f.owner.pending);
  await f.owner.reacquire(f.images, [0]); assert.equal(f.uploads.length, 2); assert.equal(f.uploads[1].bytes, selected);
  f.owner.forget(f.images[0].digest); await assert.rejects(f.owner.reacquire(f.images, [0]), /Reattach/); assert.equal(f.uploads.length, 2);
});
