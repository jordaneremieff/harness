import assert from 'node:assert/strict';
import test from 'node:test';
import {getEventListeners} from 'node:events';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {draftImageFingerprint} from '../shared/api.ts';
import type {DevReloadCheckpoint} from './dev-reload.ts';
const {app, arrive, settle, event, primaryControl, primaryFixture, agentFixture, targetFixture, singlePane, twoPanes, entryFixture, messageFixture, textPart, documentHandlers, hostDocument, byId, streamSources, HostNode: Node} = await createAppFixture();
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
async function flushRestore(): Promise<void> {for (let round = 0; round < 8; round++) await Promise.resolve();}
function pageVisibility(hidden: boolean): void {hostDocument.hidden = hidden; for (const handler of documentHandlers.get('visibilitychange') ?? []) handler({});}
async function prepareRich(agents = 1) {
  const workspace = `rich-reload-${++serial}`, identities = Array.from({length: agents}, (_, index) => `${workspace}-agent-${index}`);
  const primary = primaryFixture({activity: 'idle', capabilities: {input: true, history: true}});
  const targets = [targetFixture(`${workspace}-primary`, {kind: 'primary', key: primary.key, epoch: primary.epoch},
    {draft: {revision: 1, text: 'Retained native draft', mode: 'prompt', images: [], persisted: true}, reading: {revision: 1, anchorId: 'rich-entry', offsetPx: 0, followTail: false}}),
    ...identities.map(identity => targetFixture(identity, {kind: 'agent', identity}, {draft: {revision: 1, text: 'Agent retained draft', mode: 'prompt', images: [], persisted: true}}))];
  const layout = twoPanes(identities[0] as string, 'primary-pane');
  if (agents === 2 && layout.root.kind === 'split') layout.root.second = {kind: 'split', id: 'agents-split', axis: 'y', ratio: 50,
    first: layout.root.second, second: {kind: 'pane', id: 'second-agent-pane', tabs: [{kind: 'agent', identity: identities[1] as string}], active: `agent:${identities[1]}`}};
  await arrive({workspace: {id: workspace, revision: 1, primaryKey: primary.key, selectedTarget: targets[0]?.target, conversationLayout: layout}, primaries: [primary],
    roster: identities.map(identity => agentFixture(identity)), targets, confirmed: false, observations: [], history: [entryFixture('rich-entry', [messageFixture('rich-message', [textPart('Retained history')])])]});
  await app.drainDev(new AbortController().signal); await settle();
  assert.equal(app.devHold(), undefined); assert.equal(app.state.workspace?.id, workspace);
  for (const identity of identities) assert.equal(app.state.conversations.get(JSON.stringify(['agent', identity]))?.connectionEpoch, undefined);
  const checkpoint: DevReloadCheckpoint = {version: 1, generation: 'a'.repeat(64), oldClient: 'b'.repeat(24), capturedAt: 1, interactionRevision: 0,
    workspaceId: workspace, focusedPane: 'primary-pane', focusedControl: {targetKey: targets[0]?.targetKey as string, kind: 'composer'},
    targets: targets.map(saved => ({targetKey: saved.targetKey, target: saved.target.kind === 'agent' ? {...saved.target, connectionEpoch: 10} : saved.target,
      draftRevision: saved.draft.revision, imageFingerprint: draftImageFingerprint(saved.draft.images), readingRevision: saved.reading.revision, presentationRevision: 0,
      selection: {start: 2, end: 9, direction: 'backward'}}))};
  primaryControl('editor').setSelectionRange(1, 1); byId('notifications-button').focus();
  return {checkpoint, identities, targets, layout};
}
function ready(identity: string, connectionEpoch = 20): void {event('agent.availability', {identity, connectionEpoch, state: 'live', capabilities: agentFixture(identity).capabilities});}
test('rich checkpoint waits for real new-page agent readiness before target reads', async t => {
  const {checkpoint, identities, layout} = await prepareRich(), original = globalThis.fetch, controller = new AbortController(); let reads = 0;
  t.after(() => {controller.abort(); globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {if (targetRead(input, init)) reads++; return original(input, init);};
  let result: boolean | 'pending' = 'pending';
  const restore = app.restoreDevCheckpoint(checkpoint, controller.signal).then(value => {result = value; return value;});
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) ready(identities[0] as string, invalid);
  trusted('scroll'); trusted('select');
  await flushRestore(); assert.equal(result, 'pending'); assert.equal(reads, 0);
  ready(identities[0] as string); assert.equal(await restore, true); await settle();
  assert.equal(reads, checkpoint.targets.length); assert.equal(primaryControl('editor').value, 'Retained native draft'); assert.ok(hostDocument.body.querySelectorAll('textarea').some(editor => editor.value === 'Agent retained draft'));
  assert.deepEqual([primaryControl('editor').selectionStart, primaryControl('editor').selectionEnd, primaryControl('editor').selectionDirection], [2, 9, 'backward']);
  assert.equal(hostDocument.activeElement, primaryControl('editor')); assert.deepEqual(app.state.workspace?.conversationLayout, layout);
  const captured = app.captureDevCheckpoint(); assert.equal(captured.focusedPane, checkpoint.focusedPane);
  const agent = captured.targets.find(entry => entry.target.kind === 'agent')?.target; assert.ok(agent?.kind === 'agent' && 'connectionEpoch' in agent); assert.equal(agent.connectionEpoch, 20);
  assert.equal(app.state.targets.get(checkpoint.targets[0]?.targetKey as string)?.reading.anchorId, 'rich-entry');
});
test('Primary-only, retained-only and already-ready checkpoints start reads without a readiness event', async t => {
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  for (const kind of ['primary', 'retained', 'ready'] as const) {
    const {checkpoint, identities} = await prepareRich();
    if (kind === 'primary') checkpoint.targets = checkpoint.targets.filter(entry => entry.target.kind === 'primary');
    if (kind === 'retained') {
      checkpoint.targets = checkpoint.targets.map(entry => entry.target.kind === 'agent' ? {...entry, target: {kind: 'agent', identity: entry.target.identity, retained: true}} : entry);
      checkpoint.inspections = [{identity: identities[0] as string, mode: 'result', selector: {}, offset: 0, scrollTop: 0}];
    }
    if (kind === 'ready') ready(identities[0] as string);
    let reads = 0; globalThis.fetch = async (input, init) => {if (targetRead(input, init)) reads++; return original(input, init);};
    const restore = app.restoreDevCheckpoint(checkpoint, new AbortController().signal);
    assert.equal(reads, checkpoint.targets.length, kind); assert.equal(await restore, true, kind); globalThis.fetch = original;
  }
});
test('readiness pins each real epoch while other agents remain pending', async t => {
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  for (const initiallyReady of [false, true]) {
    const {checkpoint, identities} = await prepareRich(2), controller = new AbortController(); t.after(() => controller.abort());
    if (initiallyReady) ready(identities[0] as string);
    let reads = 0, result: boolean | 'pending' = 'pending';
    globalThis.fetch = async (input, init) => {if (targetRead(input, init)) reads++; return original(input, init);};
    const restore = app.restoreDevCheckpoint(checkpoint, controller.signal).then(value => {result = value; return value;});
    if (!initiallyReady) ready(identities[0] as string);
    await flushRestore(); assert.equal(result, 'pending'); assert.equal(reads, 0);
    ready(identities[0] as string, 21); assert.equal(await restore, false);
    ready(identities[1] as string); await flushRestore(); assert.equal(reads, 0); assert.equal(primaryControl('editor').selectionStart, 1);
    globalThis.fetch = original;
  }
});
test('a pinned epoch that disappears while another agent is pending refuses without rebasing', async t => {
  const {checkpoint, identities} = await prepareRich(2), original = globalThis.fetch, controller = new AbortController(); let reads = 0;
  t.after(() => {controller.abort(); globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {if (targetRead(input, init) && init?.signal === controller.signal) reads++; return original(input, init);};
  const restore = app.restoreDevCheckpoint(checkpoint, controller.signal); ready(identities[0] as string); await flushRestore();
  assert.ok(app.state.workspace); event('workspace.changed', {...app.state.workspace, conversationLayout: twoPanes(identities[1] as string, 'primary-pane'), revision: app.state.workspace.revision + 1});
  assert.equal(app.state.conversations.get(JSON.stringify(['agent', identities[0]]))?.connectionEpoch, undefined);
  assert.equal(app.focusedPane, checkpoint.focusedPane); assert.equal(await restore, false); ready(identities[1] as string); assert.equal(reads, 0);
});
test('a pinned epoch change during a held target read still refuses control restoration', async t => {
  const {checkpoint, identities} = await prepareRich(), original = globalThis.fetch, held = deferred<Response>(), entered = deferred<Response>();
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    if (targetRead(input, init) && new URL(String(input), 'http://ui.test').pathname.endsWith(checkpoint.targets[0]?.targetKey as string)) {entered.resolve(response); return held.promise;}
    return response;
  };
  const restore = app.restoreDevCheckpoint(checkpoint, new AbortController().signal); ready(identities[0] as string);
  const response = await entered.promise; ready(identities[0] as string, 21); held.resolve(response);
  assert.equal(await restore, false); assert.equal(primaryControl('editor').selectionStart, 1);
});
for (const change of ['input', 'workspace', 'pane', 'disconnect', 'hidden'] as const) test(`readiness never adopts a newer ${change} state`, async t => {
  const {checkpoint, identities} = await prepareRich(), controller = new AbortController(), original = globalThis.fetch;
  let recover: (() => void) | undefined; const timeout = window.setTimeout.bind(window);
  if (change === 'disconnect') {const now = Date.now(); t.mock.method(Date, 'now', () => now);}
  t.mock.method(window, 'setTimeout', (callback, delay, ...args) => {
    if (change === 'disconnect' && delay === 250) {recover = () => {if (typeof callback === 'function') callback(...args);}; return 0;}
    return timeout(callback, delay, ...args);
  });
  t.after(async () => {
    controller.abort(); globalThis.fetch = original; pageVisibility(false);
    if (change === 'disconnect') {assert.ok(recover); recover(); await settle(); streamSources.at(-1)?.emit('ready', {bootId: 'boot'}); await settle();}
  });
  let reads = 0; globalThis.fetch = async (input, init) => {if (targetRead(input, init) && init?.signal === controller.signal) reads++; return original(input, init);};
  const restore = app.restoreDevCheckpoint(checkpoint, controller.signal);
  if (change === 'input') trusted('input');
  if (change === 'workspace') await prepare();
  if (change === 'pane') {assert.ok(app.state.workspace); event('workspace.changed', {...app.state.workspace, selectedTarget: {kind: 'agent', identity: identities[0]}, conversationLayout: twoPanes(identities[0] as string), revision: app.state.workspace.revision + 1});}
  if (change === 'disconnect') streamSources.at(-1)?.onerror?.();
  if (change === 'hidden') pageVisibility(true);
  ready(identities[0] as string); assert.equal(await restore, false, change); assert.equal(reads, 0, change);
  await flushRestore(); assert.equal(reads, 0, change);
});
test('a post-readiness input change refuses before the first target GET', async t => {
  const {checkpoint, identities} = await prepareRich(), original = globalThis.fetch; let reads = 0;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {if (targetRead(input, init)) reads++; return original(input, init);};
  const restore = app.restoreDevCheckpoint(checkpoint, new AbortController().signal); ready(identities[0] as string); trusted('wheel');
  assert.equal(await restore, false); assert.equal(reads, 0);
});
test('abort removes the readiness callback before a late availability event', async t => {
  const {checkpoint, identities} = await prepareRich(), controller = new AbortController(), original = globalThis.fetch; let reads = 0;
  t.after(() => {controller.abort(); Reflect.deleteProperty(controller.signal, 'aborted'); globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {if (targetRead(input, init)) reads++; return original(input, init);};
  const restore = app.restoreDevCheckpoint(checkpoint, controller.signal); controller.abort(); assert.equal(await restore, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  let lateChecks = 0; Object.defineProperty(controller.signal, 'aborted', {configurable: true, get: () => {lateChecks++; return true;}});
  ready(identities[0] as string); await flushRestore(); assert.equal(lateChecks, 0); assert.equal(reads, 0);
  assert.equal(primaryControl('editor').selectionStart, 1);
  assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), true);
});
test('abort detaches readiness immediately and old abort cleanup cannot clear a newer waiter', async t => {
  const {checkpoint, identities} = await prepareRich(), firstController = new AbortController(), nextController = new AbortController(), original = globalThis.fetch;
  t.after(() => {firstController.abort(); nextController.abort(); globalThis.fetch = original;});
  let second: Promise<boolean> | undefined, additions = 0, reads = 0;
  const add = firstController.signal.addEventListener.bind(firstController.signal);
  t.mock.method(firstController.signal, 'addEventListener', (type, listener, options) => {
    add(type, listener, options);
    if (type === 'abort' && ++additions === 1) add('abort', () => {second = app.restoreDevCheckpoint(checkpoint, nextController.signal);}, {once: true});
  });
  globalThis.fetch = async (input, init) => {if (targetRead(input, init)) reads++; return original(input, init);};
  const first = app.restoreDevCheckpoint(checkpoint, firstController.signal);
  assert.equal(getEventListeners(firstController.signal, 'abort').length, 3);
  firstController.abort(); assert.ok(second); assert.equal(await first, false);
  assert.equal(getEventListeners(firstController.signal, 'abort').length, 0);
  assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), false); assert.equal(reads, 0);
  ready(identities[0] as string); assert.equal(await second, true); assert.equal(reads, checkpoint.targets.length);
  assert.equal(getEventListeners(nextController.signal, 'abort').length, 0);
});
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
