import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import type {DevReloadCheckpoint} from './dev-reload.ts';
const {app, arrive, settle, primaryControl, primaryFixture, targetFixture, singlePane, documentHandlers, HostNode: Node} = await createAppFixture();
function trusted(type: string, target: HostNode = primaryControl('editor')): void {
  const event = {type, target, isTrusted: true, key: 'ArrowRight', button: 0, buttons: 1, deltaY: 24,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false,
    preventDefault() {this.defaultPrevented = true;}, stopPropagation() {}};
  for (const handler of documentHandlers.get(type) ?? []) handler(event);
}
let serial = 0;
async function prepare(): Promise<DevReloadCheckpoint> {
  const workspace = `reload-${++serial}`, primary = primaryFixture({activity: 'idle', capabilities: {input: true, history: true}});
  const target = targetFixture(`draft-${serial}`, {kind: 'primary', key: primary.key, epoch: primary.epoch},
    {draft: {revision: 1, text: 'Retained native draft', mode: 'prompt', images: [], persisted: true}});
  await arrive({workspace: {id: workspace, revision: 1, primaryKey: primary.key, conversationLayout: singlePane()}, primaries: [primary], roster: [], targets: [target]});
  await app.drainDev(new AbortController().signal); await settle();
  primaryControl('editor').setSelectionRange(2, 9, 'backward');
  return {...app.captureDevCheckpoint(), version: 1, generation: 'a'.repeat(64), oldClient: 'b'.repeat(24), capturedAt: Date.now(), interactionRevision: 0};
}
function targetRead(input: RequestInfo | URL, init?: RequestInit): boolean {
  return (init?.method ?? 'GET') === 'GET' && new URL(String(input), 'http://ui.test').pathname.includes('/targets/');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {resolve = yes;});
  return {promise, resolve};
}
test('owned checkpoint restore accepts native scroll and select notifications without losing its revisions', async t => {
  const checkpoint = await prepare(), original = globalThis.fetch, editor = primaryControl('editor'), select = editor.setSelectionRange.bind(editor);
  t.after(() => {globalThis.fetch = original;});
  const file = new Node('textarea'); file.className = 'file-editor';
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    if (targetRead(input, init)) {trusted('scroll', editor); trusted('select', editor); trusted('scroll', file);}
    return response;
  };
  t.mock.method(editor, 'setSelectionRange', (start: number, end: number, direction?: string) => {select(start, end, direction); trusted('select', editor);});
  assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), true);
  assert.equal(editor.value, 'Retained native draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 9, 'backward']);
  assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), true);
});
test('actual input intent still interrupts an owned restore before its controls change', async t => {
  const checkpoint = await prepare(), original = globalThis.fetch, editor = primaryControl('editor');
  t.after(() => {globalThis.fetch = original;});
  for (const type of ['pointerdown', 'keydown', 'input', 'change', 'compositionstart', 'compositionend', 'wheel']) {
    editor.setSelectionRange(1, 1);
    globalThis.fetch = async (input, init) => {
      const response = await original(input, init); if (targetRead(input, init)) trusted(type, editor); return response;
    };
    assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), false, type);
    assert.deepEqual([editor.selectionStart, editor.selectionEnd], [1, 1], type);
    globalThis.fetch = original;
    if(type === 'compositionstart')trusted('compositionend',editor);
    assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), true, `${type} cleanup`);
  }
});
test('a failed restore releases notification ownership even when a read rejects', async t => {
  const checkpoint = await prepare(), original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {if (targetRead(input, init)) throw new Error('Read unavailable'); return original(input, init);};
  await assert.rejects(app.restoreDevCheckpoint(checkpoint, new AbortController().signal));
  globalThis.fetch = original;
  assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), true);
});
test('cancellation releases ownership immediately and late completion cannot release a newer restore', async t => {
  const checkpoint = await prepare(), original = globalThis.fetch, firstRead = deferred<Response>(), secondRead = deferred<Response>();
  const firstEntered = deferred<Response>(), secondEntered = deferred<Response>(); let reads = 0;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init); if (!targetRead(input, init)) return response;
    if (++reads === 1) {firstEntered.resolve(response); return firstRead.promise;}
    secondEntered.resolve(response); return secondRead.promise;
  };
  const controller = new AbortController(), first = app.restoreDevCheckpoint(checkpoint, controller.signal), firstResponse = await firstEntered.promise;
  assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), false);
  controller.abort();
  const second = app.restoreDevCheckpoint(checkpoint, new AbortController().signal), secondResponse = await secondEntered.promise;
  firstRead.resolve(firstResponse); assert.equal(await first, false);
  assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), false);
  trusted('wheel'); secondRead.resolve(secondResponse); assert.equal(await second, false);
  globalThis.fetch = original;
  assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), true);
});
