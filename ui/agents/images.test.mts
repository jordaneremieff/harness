import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeImage } from './images.mts';
import { imagePart } from '../server/images.mts';
import { projectFrame } from '../server/projection.mts';
import { transferSnapshot } from './transfer.mts';
import type { Snapshot } from './contract.mts';

const raw = {type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
test('native snapshot transfer retains exact image metadata across both projection boundaries', () => {
  const snapshot = {entries: [{id: 42, kind: 'message', model: [{role: 'user', content: [raw]}]}], revision: 1, nextBefore: null, partial: false,
    coverage: {complete: true, entries: 1, bytes: 100, hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: false}} as unknown as Snapshot;
  const transfer = transferSnapshot(snapshot);
  const display = projectFrame({...transfer, status: {busy: false}, live: []});
  const image = display.entries[0]?.messages?.[0]?.parts[0]; assert.ok(image?.type === 'image');
  assert.deepEqual(image.source, {entryId: '42', message: 0, part: 0}); assert.ok(!JSON.stringify(transfer).includes(raw.data));
  assert.ok(Buffer.byteLength(JSON.stringify(transfer)) < 256 * 1024);
});
test('native image uses existing exact-boundary snapshot and refuses absent or changed source', async () => {
  const image = imagePart(raw); assert.ok(image.type === 'image');
  const source = {entryId: '42', message: 0, part: 0};
  const snapshot = {entries: [{id: 42, kind: 'message', model: [{role: 'user', content: [raw]}]}]} as unknown as Snapshot;
  let calls = 0;
  const service = {history: async (identity: string, options: unknown) => {
    calls++; assert.equal(identity, 'storage:9'); assert.deepEqual(options, {before: 43, limit: 1, maxBytes: 65536}); return snapshot;
  }};
  const result = await nativeImage(service, 'storage:9', source, image.digest);
  assert.equal(Buffer.from(result.data).toString('base64'), raw.data); assert.equal(calls, 1);
  await assert.rejects(nativeImage(service, 'storage:9', source, '0'.repeat(64)), {code: 'stale_revision'});
  await assert.rejects(nativeImage(service, 'storage:9', {...source, entryId: 'bad'}, image.digest), {code: 'invalid_request'});
  assert.equal(calls, 2);
  snapshot.entries = [];
  await assert.rejects(nativeImage(service, 'storage:9', source, image.digest), {code: 'stale_revision'});
});
