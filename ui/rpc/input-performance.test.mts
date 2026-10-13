import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter, once} from 'node:events';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {PrimarySession} from './session.mts';
import {validateImageBytes} from '../server/images.mts';
import {LIMITS, type EventData} from '../shared/api.ts';

function present<T>(value: T | undefined): T { assert.ok(value !== undefined); return value; }
function pngAtLimit(): Buffer {
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const chunk = Buffer.alloc(LIMITS.draftImageBytes - original.length);
  chunk.writeUInt32BE(chunk.length - 12); chunk.write('paDd', 4);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]);
}

test('maximum image preparation, pipe write, echo and history decode preserve another primary stream', {timeout: 15000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rpc-input-performance-'));
  const sourceRoot = join(root, 'blobs'), targetKey = randomUUID(), targetDir = join(sourceRoot, 'images', targetKey);
  const imageCwd = join(root, 'image'), streamCwd = join(root, 'stream');
  await Promise.all([mkdir(targetDir, {recursive: true, mode: 0o700}), mkdir(imageCwd), mkdir(streamCwd)]);
  const bytes = pngAtLimit(); const image = {...validateImageBytes(bytes, 'image/png'), name: 'bounded.png'};
  await writeFile(join(targetDir, `${image.digest}.bin`), bytes, {mode: 0o600});
  const imageEvents = new EventEmitter(), streamEvents = new EventEmitter();
  const records: {stage: string; id: string; at: number; bytes?: number}[] = [];
  const companion: {at: number; latency: number}[] = [];
  const primary = new PrimarySession({key: 'images', executable: resolve('ui/rpc/fake-pi.mts'), cwd: imageCwd,
    onBeforeClearQueue: async () => randomUUID(), onRecoveredQueue: async () => {}, onQueueClearFailed: async () => {},
    measure: (stage, id, at, size) => records.push({stage, id, at, bytes: size}),
    publish: (name, _target, data) => imageEvents.emit(name, data)});
  const stream = new PrimarySession({key: 'stream', executable: resolve('ui/rpc/fake-pi.mts'), cwd: streamCwd,
    publish: (name, _target, data) => {
      streamEvents.emit(name, data);
      if (name === 'primary.delta') {
        const sent = Number((data as EventData['primary.delta']).delta.trim());
        if (Number.isFinite(sent)) companion.push({at: performance.now(), latency: Math.max(0, Date.now() - sent)});
      }
    }});
  const loop = monitorEventLoopDelay({resolution: 1});
  try {
    await Promise.all([primary.start(), stream.start()]);
    const firstDelta = once(streamEvents, 'primary.delta'); await stream.input('/fixture stream', 'prompt'); await firstDelta;
    const began = performance.now(); loop.enable();
    await primary.input('no-dialog image', 'prompt', false, {root: sourceRoot, targetKey, images: [image]});
    await primary.refreshState();
    // A small correlated response can bypass a large decode. This history response cannot.
    const historyStart = performance.now(); const history = await primary.client.request('get_entries'); const historyEnd = performance.now();
    assert.equal(JSON.stringify(history).includes('"data":'), false);
    assert.ok(JSON.stringify(history).includes(image.digest));
    assert.ok(primary.messages.some(message => message.parts.some(part => part.type === 'image' && part.digest === image.digest)));
    const fileStart = performance.now(); await primary.resynchronize(); const fileEnd = performance.now();
    assert.ok(primary.messages.some(message => message.parts.some(part => part.type === 'image' && part.digest === image.digest)));
    loop.disable();
    const prepare = present(records.find(record => record.stage === 'rpc.prepare.start'));
    const prepared = present(records.find(record => record.stage === 'rpc.prepare.end'));
    const written = present(records.find(record => record.stage === 'rpc.write.end'));
    const decodes = records.filter(record => record.stage === 'rpc.decode.start').map(start => ({bytes: start.bytes, ms: present(records.find(record => record.stage === 'rpc.decode.end' && record.id === start.id)).at - start.at}));
    const overlapping = companion.filter(sample => sample.at >= began && sample.at <= fileEnd).map(sample => sample.latency).sort((a, b) => a - b);
    assert.ok(overlapping.length > 5); assert.ok(present(companion.at(-1)).at > historyStart);
    assert.ok(decodes.filter(record => (record.bytes ?? 0) > 10 * 1024 * 1024).length >= 3);
    assert.ok((prepared.bytes ?? Infinity) <= LIMITS.inputFrameBytes);
    const result = {compressedBytes: bytes.length, frameBytes: prepared.bytes, prepareMs: prepared.at - prepare.at,
      prepareAndWriteMs: written.at - prepare.at, historyRpcMs: historyEnd - historyStart, savedHistoryMs: fileEnd - fileStart,
      decode: decodes, companionFrames: overlapping.length, companionP95Ms: overlapping[Math.ceil(overlapping.length * 0.95) - 1],
      eventLoopMaxMs: loop.max / 1e6};
    t.diagnostic(JSON.stringify(result));
    assert.ok(Number.isFinite(result.eventLoopMaxMs));
    assert.ok(Number.isFinite(result.companionP95Ms));
  } finally {
    loop.disable(); await Promise.all([primary.close(), stream.close()]); await rm(root, {recursive: true, force: true});
  }
});
