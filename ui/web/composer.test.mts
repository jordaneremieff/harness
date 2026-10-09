import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { CommandInventory } from './command-menu-state.ts';
beforeEach(context => { context.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 0}); });
import type { DraftView, OperationView, TargetState } from '../shared/api.ts';

import { Composer } from './composer.ts';
class NodeFake {
  id = ''; selectionStart = 0; selectionEnd = 0; offsetTop = 0; scrollTop = 0; clientHeight = 80;
  removeAttribute(name: string): void { this.attrs.delete(name); }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
  isConnected = false; style = {height: '', maxHeight: ''};
  get offsetHeight(): number { return Number.parseFloat(this.style.height) || 85.5; }
  get scrollHeight(): number { return this.value.split('\n').length * 22.5 + 16; }
  closest(): {clientHeight: number} { return {clientHeight: 900}; }
  getBoundingClientRect(): {top: number; bottom: number} { return {top: 0, bottom: 0}; }
  open = false; value = ''; dataset: Record<string, string> = {}; hidden = false; disabled = false; focused = false;
  private text = ''; children: NodeFake[] = []; attrs = new Map<string, string>(); listeners = new Map<string, ((event: EventFake) => void)[]>();
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('\n'); }
  set textContent(text: string) { this.text = text; this.children = []; }
  append(...nodes: NodeFake[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: NodeFake[]): void { this.text = ''; this.children = nodes; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  focus(): void { this.focused = true; }
  select(): void {}
  addEventListener(name: string, listener: (event: EventFake) => void): void { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  querySelectorAll(): NodeFake[] { return this.children; }
  querySelector(selector: string): NodeFake | undefined { return this.children.find(node => selector.includes(`"${node.dataset.mode}"`)); }
  fire(name: string, options: Partial<EventFake> = {}): EventFake {
    const event: EventFake = {key: '', defaultPrevented: false, isComposing: false, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      preventDefault() { this.defaultPrevented = true; }, ...options};
    for (const listener of this.listeners.get(name) ?? []) listener(event); return event;
  }
  find(text: string): NodeFake | undefined {
    if (this.text === text) return this;
    for (const child of this.children) { const found = child.find(text); if (found) return found; } return undefined;
  }
}
type EventFake = {key: string; defaultPrevented: boolean; isComposing: boolean; repeat: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; preventDefault(): void};
type Call = {path: string; method: string; body: Record<string, unknown>; id?: string; resolve: (value: unknown) => void; reject: (error: Error) => void};
const draft = (revision = 0, text = '', mode = 'prompt'): DraftView => ({revision, text, mode, persisted: true});
function state(key = 'a', saved = draft(), agent = false): TargetState {
  return {targetKey: key, target: agent ? {kind: 'agent', identity: key} : {kind: 'primary', key, epoch: 7}, draft: saved,
    reading: {revision: 0, anchorId: null, offsetPx: 0, followTail: true}, unconfirmed: []};
}
const turn = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function fixture(prefix: 'primary' | 'agent' = 'primary', commands?: () => CommandInventory) {
  const nodes = new Map<string, NodeFake>();
  for (const id of ['editor', 'composer', 'modes', 'send', 'caption', 'save', 'receipt', 'receipt-details', 'acquire', 'command-menu']) { const node = new NodeFake(); node.id = `${prefix}-${id}`; nodes.set(node.id, node); }
  nodes.set('announcements', new NodeFake());
  for (const mode of ['steer', 'followUp']) { const node = new NodeFake(); node.dataset.mode = mode; nodes.get(`${prefix}-modes`)?.append(node); }
  const calls: Call[] = []; let sequence = 0; const frames: (() => void)[] = []; const copied: string[] = [];
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {getElementById: (id: string) => nodes.get(id), createElement: () => new NodeFake()}});
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => { copied.push(text); }}}});
  Object.defineProperty(globalThis, 'requestAnimationFrame', {configurable: true, value: (callback: () => void) => frames.push(callback)});
  Object.defineProperty(globalThis, 'fetch', {configurable: true, value: (path: string, init: RequestInit) => {
    if (path === '/api/operations') { const operationId = `op-${++sequence}`; return Promise.resolve({json: async () => ({ok: true, data: {operationId}})}); }
    return new Promise((resolve, reject) => calls.push({path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : {},
      id: (init.headers as Record<string, string>)['Idempotency-Key'], resolve: value => resolve({json: async () => value}), reject}));
  }});
  const submitted: OperationView[] = []; let unknown = (_text: string, _send: () => void) => false; let recovered = 0;
  const composer = new Composer(prefix, {submitted: result => submitted.push(result), recover: () => { recovered++; }, unknownCommand: (text, send) => unknown(text, send), commands});
  const node = (id: string) => nodes.get(`${prefix}-${id}`) as NodeFake;
  const pick = (method: string, suffix: string) => { const call = calls.find(item => item.method === method && item.path.endsWith(suffix)); assert.ok(call, `${method} ${suffix}`); return call; };
  const ok = (call: Call, value: unknown) => { calls.splice(calls.indexOf(call), 1); call.resolve({ok: true, data: value}); };
  const fail = (call: Call, code: string) => { calls.splice(calls.indexOf(call), 1); call.resolve({ok: false, error: {code, message: code, retry: 'manual'}}); };
  const saved = (text: string, revision = 1, mode = prefix === 'agent' ? 'followUp' : 'prompt') => ok(pick('PUT', '/draft'), draft(revision, text, mode));
  const admit = (targetState: TargetState, status: OperationView['state'] = 'accepted') => {
    const call = pick('POST', '/inputs'); const result: OperationView = {id: call.id as string, kind: prefix === 'primary' ? 'primary.input' : 'agent.input', target: targetState.target,
      state: status, createdAt: '', updatedAt: '', receipt: {kind: 'rpc', disposition: 'started'}}; ok(call, result); return result;
  };
  const click = (text: string) => { const found = node('receipt').find(text); assert.ok(found, text); found.fire('click'); };
  const connect = (targetState = state('a', draft(0, '', prefix === 'agent' ? 'followUp' : 'prompt'), prefix === 'agent')) => { composer.attach('w', targetState); composer.availability(true, true, false); return targetState; };
  const openReceipt = () => { const details = node('receipt-details').children[0]; assert.ok(details); details.open = true; details.fire('toggle'); };
  return {composer, node, calls, pick, ok, fail, saved, admit, click, connect, submitted, frames, copied, openReceipt, reservations: () => sequence,
    unknown: (handler: typeof unknown) => { unknown = handler; }, recovered: () => recovered};
}

test('local echo and one save per target coalesce newer unsent text across switches', async () => {
  const f = fixture(); f.connect(); f.composer.setText('one'); f.composer.setText('two'); f.composer.setText('three');
  assert.equal(f.composer.editor.value, 'three'); assert.equal(f.calls.length, 1); assert.equal(f.node('save').textContent, '');
  f.composer.attach('w', state('b')); f.composer.setText('other'); assert.equal(f.calls.length, 2);
  f.composer.attach('w', state()); assert.equal(f.composer.editor.value, 'three'); f.saved('one'); await turn();
  const next = f.calls.find(call => call.path.includes('/a/draft')); assert.equal(next?.body.text, 'three'); assert.equal(next?.body.expectedRevision, 1);
  f.ok(next as Call, draft(2, 'three')); await turn(); assert.equal(f.composer.editor.value, 'three');
  assert.equal(f.composer.unsaved, true); f.saved('other'); await turn(); assert.equal(f.composer.unsaved, false);
});
test('matching SSE save acknowledgement preserves newer text and does not create a conflict', async () => {
  const f = fixture(); f.connect(); f.composer.setText('one'); f.composer.setText('two');
  f.composer.updateDraft(draft(1, 'one')); assert.equal(f.composer.editor.value, 'two'); assert.doesNotMatch(f.node('save').textContent, /Review/);
  f.saved('one'); await turn(); f.saved('two', 2); await turn(); assert.equal(f.composer.unsaved, false);
});
test('same-target snapshot merge preserves local copy and exposes both exact conflicting copies', async () => {
  const f = fixture(); f.connect(); f.composer.setText(' local\n '); f.composer.attach('w', state('a', draft(2, ' remote\n ')));
  assert.equal(f.composer.editor.value, ' local\n '); assert.match(f.node('receipt').textContent, / local\n /); assert.match(f.node('receipt').textContent, / remote\n /);
  f.saved(' local\n ', 1); await turn(); f.click('Review'); f.ok(f.pick('GET', '/a'), state('a', draft(2, ' remote\n '))); await turn();
  f.click('Keep my copy'); assert.equal(f.pick('PUT', '/draft').body.expectedRevision, 2); assert.equal(f.composer.editor.value, ' local\n ');
});
test('stale save requires Review and never sends the stale saved revision', async () => {
  const f = fixture(); f.connect(state('a', draft(3, 'old'))); f.composer.setText('mine'); const sending = f.composer.send();
  f.fail(f.pick('PUT', '/draft'), 'stale_revision'); await sending; assert.equal(f.calls.length, 0); assert.equal(f.composer.editor.value, 'mine');
  f.click('Review'); f.ok(f.pick('GET', '/a'), state('a', draft(4, 'remote'))); await turn(); assert.match(f.node('receipt').textContent, /mine/); assert.match(f.node('receipt').textContent, /remote/);
  f.click('Use Mac draft'); assert.equal(f.composer.editor.value, 'remote'); assert.equal(f.composer.unsaved, false);
});
test('save transport failure returns failure to send without dispatch', async () => {
  const f = fixture(); f.connect(state('a', draft(1, 'old'))); f.composer.setText('new'); const sending = f.composer.send();
  f.pick('PUT', '/draft').reject(new Error('offline')); await sending; assert.equal(f.calls.filter(call => call.path.endsWith('/inputs')).length, 0);
  assert.equal(f.composer.editor.value, 'new'); assert.equal(f.composer.unsaved, true); assert.match(f.node('receipt').textContent, /offline/);
});
test('submission saves the clicked exact text and mode, then keeps target and revision across navigation', async () => {
  const f = fixture('agent'); const a = f.connect(); f.composer.setText('first'); f.composer.setText('clicked');
  const sending = f.composer.send(); f.composer.setText('newer'); f.composer.attach('w', state('b', draft(0, '', 'followUp'), true)); f.composer.setText('B');
  f.ok(f.calls.find(call => call.path.includes('/a/draft')) as Call, draft(1, 'first', 'followUp')); await turn();
  const clicked = f.calls.find(call => call.path.includes('/a/draft')) as Call; assert.equal(clicked.body.text, 'clicked');
  f.ok(clicked, draft(2, 'clicked', 'followUp')); await turn(); const input = f.pick('POST', '/inputs');
  assert.equal(input.path, '/api/agents/a/inputs'); assert.deepEqual(input.body, {message: 'clicked', mode: 'followUp', draftRevision: 2}); assert.equal(input.id, 'op-1');
  f.admit(a, 'rejected'); await sending; assert.equal(f.composer.editor.value, 'B'); f.composer.attach('w', state('a', draft(2, 'clicked', 'followUp'), true)); assert.equal(f.composer.editor.value, 'newer');
});
test('acceptance preserves newer edits and saves from the backend cleanup revision', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(5, 'sent'))); const sending = f.composer.send(); await turn(); f.composer.setText('newer');
  f.composer.updateDraft(draft(6, '')); f.admit(a); await sending;
  f.openReceipt(); assert.match(f.node('receipt-details').textContent, /Details/); assert.match(f.node('receipt-details').textContent, /started/);
  assert.equal(f.composer.editor.value, 'newer'); assert.equal(f.pick('PUT', '/draft').body.expectedRevision, 6); assert.equal(f.pick('PUT', '/draft').body.text, 'newer');
});
test('acceptance clears only the submitted revision and refreshes cleanup without an extra pre-send reservation', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'sent'))); await turn(); assert.equal(f.reservations(), 1);
  const sending = f.composer.send(); await turn(); assert.equal(f.reservations(), 1); f.admit(a); await turn(); assert.equal(f.composer.editor.value, '');
  f.ok(f.pick('GET', '/a'), state('a', draft(3, ''))); await sending; assert.equal(f.composer.unsaved, false); assert.equal(f.reservations(), 2);
});
test('network loss after dispatch retains original key, copy, restore, receipt check, and duplicate-risk confirmation', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(4, ' exact\n '))); const sending = f.composer.send(); await turn();
  const input = f.pick('POST', '/inputs'); f.calls.splice(f.calls.indexOf(input), 1); input.reject(new Error('connection lost')); await sending;
  assert.match(f.node('receipt').textContent, /op-1/); assert.match(f.node('receipt').textContent, / exact\n /); await f.composer.send(); assert.equal(f.calls.length, 0);
  f.click('Copy'); await turn(); assert.deepEqual(f.copied, [' exact\n ']); f.click('Restore to draft'); assert.equal(f.composer.editor.value, ' exact\n ');
  f.click('Check receipt'); assert.equal(f.pick('POST', '/reconcile').path, '/api/operations/op-1/reconcile'); f.fail(f.pick('POST', '/reconcile'), 'unknown_operation'); await turn();
  assert.match(f.node('receipt').textContent, /admission remains unknown/); f.click('Send again…'); assert.equal(f.calls.length, 0);
  f.click('Confirm duplicate risk and send'); await turn(); assert.equal(f.pick('POST', '/inputs').id, 'op-2'); f.admit(a, 'rejected'); await turn();
});
test('restoring uncertain input does not replace a newer draft without an explicit choice', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'original'))); const sending = f.composer.send(); await turn(); f.admit(a, 'uncertain'); await sending;
  f.composer.availability(false, false, false); f.composer.setText('newer'); f.click('Restore to draft'); await turn(); assert.equal(f.composer.editor.value, 'newer');
  f.click('Replace draft with original'); assert.equal(f.composer.editor.value, 'original');
});
test('restored backend unconfirmed input invokes recover, blocks duplicate sends, and accepts late receipt', async () => {
  const f = fixture(); const a = state('a', draft(2, 'original')); a.unconfirmed.push({operationId: 'retained', target: a.target, text: 'original', mode: 'prompt', submittedDraftRevision: 2, createdAt: '', reason: 'unknown'});
  f.connect(a); assert.equal(f.recovered(), 1); await f.composer.send(); assert.equal(f.calls.length, 0);
  assert.equal(f.composer.updateOperation({id: 'retained', kind: 'primary.input', target: a.target, state: 'accepted', createdAt: '', updatedAt: ''}), true);
  await turn(); f.ok(f.pick('GET', '/a'), state('a', draft(3, ''))); await turn(); assert.equal(f.composer.editor.value, '');
});
test('unknown or expired reservation rejects explicitly without blind resend', async () => {
  const f = fixture(); f.connect(state('a', draft(1, 'sent'))); const sending = f.composer.send(); await turn(); f.fail(f.pick('POST', '/inputs'), 'unknown_operation'); await sending;
  assert.equal(f.composer.editor.value, 'sent'); assert.match(f.node('receipt').textContent, /reservation expired or unknown/); assert.doesNotMatch(f.node('receipt').textContent, /Send not confirmed/);
  assert.equal(f.calls.length, 0); assert.equal(f.reservations(), 2);
});
test('IME, repeat, ShiftEnter, prevented autocomplete, and modified Enter do not submit; busy Tab stays native', async () => {
  const f = fixture(); f.connect(state('a', draft(1, 'sent')));
  for (const option of [{isComposing: true}, {repeat: true}, {shiftKey: true}, {defaultPrevented: true}, {ctrlKey: true}, {metaKey: true}, {altKey: true}]) f.node('editor').fire('keydown', {key: 'Enter', ...option});
  await turn(); assert.equal(f.calls.length, 0); f.composer.availability(true, true, true);
  const tab = f.node('editor').fire('keydown', {key: 'Tab'}); assert.equal(tab.defaultPrevented, false);
  assert.equal(f.node('modes').children.some(node => node.focused), false);
  assert.equal(f.node('modes').children[1]?.fire('keydown', {key: 'Tab'}).defaultPrevented, false);
  assert.equal(f.node('editor').fire('keydown', {key: 'Tab', shiftKey: true}).defaultPrevented, false);
});
test('Enter submits once while pending and form submission shares the duplicate guard', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(1, 'sent')));
  assert.equal(f.node('editor').fire('keydown', {key: 'Enter'}).defaultPrevented, true); f.node('composer').fire('submit'); await turn();
  assert.equal(f.calls.filter(call => call.path.endsWith('/inputs')).length, 1); f.admit(a, 'rejected'); await turn();
});
test('unknown-command literal action is bound to the original unchanged draft and target', async () => {
  const f = fixture(); f.connect(state('a', draft(1, '/unknown'))); let literal: (() => void) | undefined;
  f.unknown((_text, send) => { literal = send; return true; }); await f.composer.send(); assert.equal(f.calls.length, 0);
  f.composer.attach('w', state('b', draft(1, 'B'))); literal?.(); await turn(); assert.equal(f.calls.length, 0);
  f.composer.attach('w', state('a', draft(1, '/unknown'))); literal?.(); await turn(); assert.equal(f.pick('POST', '/inputs').body.literal, true);
});

test('input echoes before a blocked network request and records the next paint', () => {
  const f = fixture(); f.connect(); f.node('editor').value = 'typed'; f.node('editor').fire('input');
  assert.equal(f.composer.editor.value, 'typed'); assert.equal(f.calls.length, 1); assert.equal(f.frames.length, 2); for (const frame of f.frames) frame();
  assert.equal(f.composer.unsaved, true);
});
test('a clean same-target snapshot updates saved text and mode', () => {
  const f = fixture(); f.connect(state('a', draft(1, 'old'))); f.composer.attach('w', state('a', draft(2, 'remote', 'steer')));
  assert.equal(f.composer.editor.value, 'remote'); assert.equal(f.composer.state?.draft.revision, 2); assert.equal(f.composer.unsaved, false);
  assert.equal(f.node('modes').children[0]?.attrs.get('aria-pressed'), 'true');
});
test('stale save retains both exact copies from the error without a receipt fetch', async () => {
  const f = fixture(); f.connect(); f.composer.setText(' local\n '); const sending = f.composer.send();
  const call = f.pick('PUT', '/draft'); f.calls.splice(f.calls.indexOf(call), 1);
  call.resolve({ok: false, error: {code: 'stale_revision', message: 'stale', retry: 'manual', details: {value: draft(2, ' remote\n '), truncated: false}}});
  await sending; assert.equal(f.composer.editor.value, ' local\n '); assert.match(f.node('receipt').textContent, / remote\n /); assert.match(f.node('receipt').textContent, / local\n /); f.node('receipt').find('Review');
});
test('local reservation expiry requires a new explicit send and never dispatches the old key', async context => {
  let now = 100; context.mock.method(Date, 'now', () => now);
  const f = fixture(); f.connect(state('a', draft(1, 'sent'))); await turn(); now += 600001; await f.composer.send();
  assert.equal(f.calls.length, 0); assert.match(f.node('receipt').textContent, /reservation expired/); assert.equal(f.reservations(), 2);
});
test('an earlier late acceptance keeps a newer already-saved edit', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(4, 'original'))); const sending = f.composer.send(); await turn(); const result = f.admit(a, 'uncertain'); await sending;
  f.composer.setText('newer'); f.saved('newer', 5); await turn(); assert.equal(f.composer.unsaved, false);
  assert.equal(f.composer.updateOperation({...result, state: 'accepted'}), true); await turn(); f.ok(f.pick('GET', '/a'), state('a', draft(5, 'newer'))); await turn();
  assert.equal(f.composer.editor.value, 'newer'); assert.equal(f.composer.unsaved, false);
});
test('late hidden-target acceptance never clears the selected target and stale copies do not rehydrate', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(4, 'original'))); const sending = f.composer.send(); await turn(); const result = f.admit(a, 'uncertain'); await sending;
  f.composer.attach('w', state('b', draft(3, 'B'))); f.composer.updateOperation({...result, state: 'accepted'}); await turn(); f.ok(f.pick('GET', '/a'), state('a', draft(5, ''))); await turn();
  assert.equal(f.composer.editor.value, 'B'); a.unconfirmed.push({operationId: result.id, target: a.target, text: 'original', mode: 'prompt', submittedDraftRevision: 4, createdAt: '', reason: 'old snapshot'});
  f.composer.attach('w', a); assert.equal(f.composer.editor.value, ''); assert.doesNotMatch(f.node('receipt').textContent, /Send not confirmed/);
});
test('agent uncertainty blocks the same input but permits a different explicitly submitted revision', async () => {
  const f = fixture('agent'); const a = f.connect(state('a', draft(1, 'original', 'followUp'), true)); const sending = f.composer.send(); await turn(); f.admit(a, 'uncertain'); await sending;
  await f.composer.send(); assert.equal(f.calls.length, 0); f.composer.setText('different'); f.saved('different', 2); await turn(); const newer = f.composer.send(); await turn();
  assert.equal(f.pick('POST', '/inputs').body.message, 'different'); assert.equal(f.pick('POST', '/inputs').id, 'op-2'); f.admit(a, 'rejected'); await newer;
});
test('workspaces keep independent queues even for the same target key', async () => {
  const f = fixture(); f.connect(); f.composer.setText('workspace one'); f.composer.attach('other', state()); f.composer.setText('workspace two');
  assert.equal(f.calls.length, 2); f.composer.attach('w', state()); assert.equal(f.composer.editor.value, 'workspace one');
  const first = f.calls.find(call => call.path.includes('/workspaces/w/')) as Call; f.ok(first, draft(1, 'workspace one')); await turn();
  f.composer.attach('other', state()); assert.equal(f.composer.editor.value, 'workspace two');
});

test('truncated recovery Copy fetches exact text for the captured workspace and target', async () => {
  const f = fixture(); const a = state('a', draft(3, 'newer'));
  const item = {operationId: 'retained', target: a.target, text: 'preview', mode: 'prompt', submittedDraftRevision: 2, createdAt: '', reason: 'unknown', textTruncated: true as const}; a.unconfirmed.push(item);
  f.connect(a); f.click('Copy'); const fetch = f.pick('GET', '/retained'); assert.equal(fetch.path, '/api/workspaces/w/unconfirmed/retained');
  f.composer.attach('other', state('b', draft(1, 'B'))); f.ok(fetch, {...item, text: ' exact\n original ', textTruncated: undefined}); await turn();
  assert.deepEqual(f.copied, [' exact\n original ']); assert.equal(f.composer.editor.value, 'B');
  f.composer.attach('w', a); f.click('Restore to draft'); await turn(); assert.equal(f.composer.editor.value, 'newer');
  f.click('Replace draft with original'); assert.equal(f.composer.editor.value, ' exact\n original '); assert.equal(f.pick('PUT', '/draft').body.expectedRevision, 3);
});
test('failed exact recovery fetch never copies or restores the preview', async () => {
  const f = fixture(); const a = state('a', draft(3, 'newer'));
  a.unconfirmed.push({operationId: 'retained', target: a.target, text: 'preview', mode: 'prompt', submittedDraftRevision: 2, createdAt: '', reason: 'unknown', textTruncated: true});
  f.connect(a); f.click('Copy'); f.fail(f.pick('GET', '/retained'), 'host_unavailable'); await turn();
  assert.deepEqual(f.copied, []); assert.equal(f.composer.editor.value, 'newer'); assert.match(f.node('receipt').textContent, /Send not confirmed/);
});
test('accepted native receipt exposes exact identity, submission ID, and request key', async () => {
  const f = fixture('agent'); const a = f.connect(state('a', draft(2, 'sent', 'followUp'), true)); const sending = f.composer.send(); await turn();
  const input = f.pick('POST', '/inputs'); const result: OperationView = {id: input.id as string, kind: 'agent.input', target: a.target, state: 'accepted', createdAt: '', updatedAt: '',
    receipt: {kind: 'durable', identity: 'a', submissionId: 42, requestId: 'ui:op-1', deduped: false}};
  f.ok(input, result); await turn(); f.ok(f.pick('GET', '/a'), state('a', draft(3, '', 'followUp'), true)); await sending;
  f.openReceipt(); assert.match(f.node('receipt-details').textContent, /Details/); assert.match(f.node('receipt-details').textContent, /42/); assert.match(f.node('receipt-details').textContent, /ui:op-1/);
});

test('accepted operation event before cleanup and HTTP response never creates a false tab conflict', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'sent'))); const sending = f.composer.send(); await turn();
  const input = f.pick('POST', '/inputs'); const accepted: OperationView = {id: input.id as string, kind: 'primary.input', target: a.target, state: 'accepted', createdAt: '', updatedAt: '', receipt: {kind: 'rpc', disposition: 'started'}};
  assert.equal(f.composer.updateOperation(accepted), true); await turn(); f.composer.updateDraft(draft(3, ''));
  assert.doesNotMatch(f.node('save').textContent, /Review/); f.ok(f.pick('GET', '/a'), state('a', draft(3, ''))); await turn(); f.ok(input, accepted); await sending;
  assert.equal(f.composer.editor.value, ''); assert.equal(f.composer.unsaved, false); assert.doesNotMatch(f.node('save').textContent, /Review/);
});

test('accepted-event cleanup keeps newer edits and advances their next save revision', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(5, 'sent'))); const sending = f.composer.send(); await turn(); const input = f.pick('POST', '/inputs');
  const accepted: OperationView = {id: input.id as string, kind: 'primary.input', target: a.target, state: 'accepted', createdAt: '', updatedAt: ''};
  f.composer.updateOperation(accepted); await turn(); f.composer.setText('newer'); f.composer.updateDraft(draft(6, '')); assert.doesNotMatch(f.node('save').textContent, /Review/);
  f.ok(f.pick('GET', '/a'), state('a', draft(6, ''))); await turn(); f.ok(input, accepted); await sending;
  assert.equal(f.composer.editor.value, 'newer'); assert.equal(f.pick('PUT', '/draft').body.expectedRevision, 6); assert.doesNotMatch(f.node('save').textContent, /Review/);
});
test('an idle primary saves prompt mode before dispatch and keeps that captured mode if busy state changes', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'sent', 'steer'))); const sending = f.composer.send(); f.composer.availability(true, true, true); await turn();
  assert.equal(f.pick('PUT', '/draft').body.mode, 'prompt'); f.saved('sent', 3, 'prompt'); await turn();
  assert.deepEqual(f.pick('POST', '/inputs').body, {epoch: 7, message: 'sent', mode: 'prompt', draftRevision: 3, literal: false}); f.admit(a, 'rejected'); await sending;
});

test('literal confirmation refuses changed text, saved revision, and target epoch', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(1, '/unknown'))); let literal: (() => void) | undefined;
  f.unknown((_text, send) => { literal = send; return true; }); await f.composer.send(); f.composer.updateDraft(draft(2, '/unknown')); literal?.(); await turn(); assert.equal(f.calls.length, 0);
  await f.composer.send(); const changed = {...a, target: {kind: 'primary' as const, key: 'a', epoch: 8}, draft: draft(2, '/unknown')}; f.composer.attach('w', changed); literal?.(); await turn(); assert.equal(f.calls.length, 0);
  await f.composer.send(); f.composer.setText('/different'); literal?.(); await turn(); assert.equal(f.calls.filter(call => call.path.endsWith('/inputs')).length, 0);
});

test('an unavailable agent keeps an editable draft and exposes only acquisition until transport reconnects', () => {
  const f = fixture('agent'); f.connect(state('a', draft(1, 'retained', 'steer'), true));
  f.composer.availability(true, false, true); assert.equal(f.composer.editor.value, 'retained');
  assert.equal(f.node('send').hidden, true); assert.equal(f.node('acquire').hidden, false); assert.equal(f.node('modes').hidden, true); assert.equal(f.node('caption').textContent, '');
  f.composer.availability(false, false, false); assert.equal(f.node('send').hidden, false); assert.equal(f.node('send').disabled, true); assert.equal(f.node('acquire').hidden, true);
});
test('a missing target hides the composer and clears all save and receipt presentation', () => {
  const f = fixture(); f.connect(); f.composer.attach('w');
  assert.equal(f.node('composer').hidden, true); assert.equal(f.node('save').textContent, ''); assert.equal(f.node('receipt-details').textContent, ''); assert.equal(f.node('send').disabled, true);
});
test('input and control receipts share one disclosure and never leak across targets', () => {
  const f = fixture(); const a = f.connect();
  const result: OperationView = {id: 'input', target: a.target, kind: 'primary.input', state: 'accepted', createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z'};
  f.composer.receipts([result, {...result, id: 'control', kind: 'primary.control', state: 'completed', updatedAt: '2026-10-08T12:01:00Z'}]);
  assert.equal(f.node('receipt-details').children.length, 1); f.openReceipt(); assert.match(f.node('receipt-details').textContent, /Input receipt/); assert.match(f.node('receipt-details').textContent, /Control receipt/); assert.equal(f.node('receipt').textContent, '');
  f.composer.attach('w', state('b')); assert.equal(f.node('receipt-details').textContent, ''); assert.equal(f.node('save').textContent, '');
});

test('editor height grows locally, caps long drafts, shrinks, and preserves explicit manual sizing', () => {
  const computed = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle'); const media = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  Object.defineProperty(globalThis, 'getComputedStyle', {configurable: true, value: () => ({lineHeight: '22.5px', paddingTop: '8px', paddingBottom: '8px', borderTopWidth: '1px', borderBottomWidth: '1px'})});
  Object.defineProperty(globalThis, 'matchMedia', {configurable: true, value: () => ({matches: false})});
  try {
    const f = fixture(); f.connect(); const editor = f.node('editor'); editor.isConnected = true;
    const paint = () => {for (const frame of f.frames.splice(0)) frame();};
    f.composer.setText(Array(10).fill('line').join('\n')); paint(); assert.equal(editor.style.height, '243px');
    f.composer.setText(Array(20).fill('line').join('\n')); paint(); assert.equal(editor.style.height, '243px');
    f.composer.setText('one'); paint(); assert.equal(editor.style.height, '85.5px');
    editor.style.height = '180px'; editor.fire('pointerup'); f.composer.setText('two'); paint(); assert.equal(editor.style.height, '180px');
    assert.equal(f.calls.length, 1);
  } finally {
    if (computed) Object.defineProperty(globalThis, 'getComputedStyle', computed); else Reflect.deleteProperty(globalThis, 'getComputedStyle');
    if (media) Object.defineProperty(globalThis, 'matchMedia', media); else Reflect.deleteProperty(globalThis, 'matchMedia');
  }
});

test('fast serialized saves remain silent and only one outstanding request reaches the slow threshold', async context => {
  const f = fixture(); f.connect(); f.composer.setText('one');
  context.mock.timers.tick(999); assert.equal(f.node('save').textContent, '');
  context.mock.timers.tick(1); assert.equal(f.node('save').textContent, 'Saving draft…');
  f.composer.setText('two'); f.saved('one'); await turn(); assert.equal(f.node('save').textContent, '');
  context.mock.timers.tick(999); assert.equal(f.node('save').textContent, '');
  f.saved('two', 2); await turn(); context.mock.timers.tick(2000); assert.equal(f.node('save').textContent, '');
  assert.equal(f.composer.unsaved, false);
});
test('a slow-save timer never paints another target and a late settle clears its own presentation', async context => {
  const f = fixture(); f.connect(); f.composer.setText('one'); f.composer.attach('w', state('b'));
  context.mock.timers.tick(1000); assert.equal(f.node('save').textContent, '');
  f.composer.attach('w', state()); assert.equal(f.node('save').textContent, 'Saving draft…');
  f.saved('one'); await turn(); assert.equal(f.node('save').textContent, '');
});
test('a clean acknowledged draft stays quiet offline while unsaved text gets the offline exception', async () => {
  const f = fixture(); f.connect(state('a', draft(1, 'retained'))); f.composer.availability(false, true, false);
  assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, true);
  f.composer.setText('unsaved'); assert.equal(f.node('save').textContent, 'Draft not saved · offline'); assert.equal(f.calls.length, 0);
  f.composer.availability(true, true, false); assert.equal(f.node('save').textContent, '');
  f.saved('unsaved', 2); await turn(); assert.equal(f.node('save').textContent, '');
});
test('a failed save exposes Retry and latches through edits until an explicit retry succeeds', async () => {
  const f = fixture(); f.connect(); f.composer.setText('one'); f.fail(f.pick('PUT', '/draft'), 'host_unavailable'); await turn();
  assert.equal(f.node('save').textContent, 'Draft not saved'); assert.match(f.node('receipt').textContent, /Draft not saved/);
  f.composer.setText('two'); assert.equal(f.calls.length, 0); f.click('Retry'); assert.equal(f.pick('PUT', '/draft').body.text, 'two');
  f.saved('two'); await turn(); assert.equal(f.node('save').textContent, ''); assert.equal(f.node('receipt').textContent, '');
});
test('routine admitted notices announce once without persistent text but queued input remains visible', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'sent'))); const sending = f.composer.send(); await turn();
  f.admit(a); await turn(); f.ok(f.pick('GET', '/a'), state('a', draft(3, ''))); await sending;
  assert.equal(f.node('receipt').textContent, ''); assert.equal(f.node('save').textContent, '');
  f.composer.receipts([{id: 'queued', kind: 'primary.input', target: a.target, state: 'accepted', receipt: {kind: 'rpc', disposition: 'queued'}, createdAt: '', updatedAt: ''}]);
  assert.match(f.node('receipt').textContent, /Follow-up queued/); assert.equal(f.node('save').textContent, '');
});
test('an open primary menu accepts an exact name without dispatch and normal Enter returns after acceptance', async () => {
  const commands = () => ({state: 'ready' as const, items: [{name: 'fixture', description: 'public command', source: 'extension'}]});
  const f = fixture('primary', commands); const a = f.connect(state('a', draft(1, '/fixture')));
  f.node('editor').setSelectionRange(8, 8); f.node('editor').fire('focus'); f.composer.commandsChanged();
  assert.equal(f.node('command-menu').hidden, false); f.node('editor').fire('keydown', {key: 'Enter'}); await turn();
  assert.equal(f.composer.editor.value, '/fixture '); assert.equal(f.calls.some(call => call.path.endsWith('/inputs')), false);
  f.saved('/fixture ', 2); await turn(); f.node('editor').fire('keydown', {key: 'Enter'}); await turn();
  assert.equal(f.calls.filter(call => call.path.endsWith('/inputs')).length, 1); f.admit(a, 'rejected'); await turn();
});
test('loading or empty primary menus consume Enter and agent composers never open slash menus', async () => {
  let inventory: CommandInventory = {state: 'loading', items: []}; const f = fixture('primary', () => inventory); f.connect(state('a', draft(1, '/missing')));
  f.node('editor').setSelectionRange(8, 8); f.node('editor').fire('focus'); f.node('editor').fire('keydown', {key: 'Enter'}); await turn(); assert.equal(f.calls.length, 0);
  inventory = {state: 'ready', items: []}; f.composer.commandsChanged(); f.node('editor').fire('keydown', {key: 'Enter'}); await turn(); assert.equal(f.calls.length, 0);
  const agent = fixture('agent', () => ({state: 'ready', items: [{name: 'model', description: '', source: 'App'}]})); agent.connect();
  agent.composer.setText('/mo'); agent.node('editor').setSelectionRange(3, 3); agent.node('editor').fire('focus'); agent.composer.commandsChanged();
  assert.equal(agent.node('command-menu').children.length, 0); assert.equal(agent.node('editor').fire('keydown', {key: 'Tab'}).defaultPrevented, false);
});
test('a matching stream acknowledgment stays quiet if its later HTTP response is lost', async () => {
  const f = fixture(); f.connect(); f.composer.setText('retained'); f.composer.updateDraft(draft(1, 'retained'));
  f.pick('PUT', '/draft').reject(new Error('response lost')); await turn();
  assert.equal(f.composer.unsaved, false); assert.equal(f.node('save').textContent, ''); assert.equal(f.node('receipt').textContent, '');
  f.composer.availability(false, true, false); assert.equal(f.node('save').textContent, '');
});
test('save Retry clears the matching failed-send notice after an acknowledged retry', async () => {
  const f = fixture(); f.connect(); f.composer.setText('text'); const sending = f.composer.send(); f.fail(f.pick('PUT', '/draft'), 'host_unavailable'); await sending;
  assert.match(f.node('receipt').textContent, /Draft not saved/); f.click('Retry'); f.saved('text'); await turn();
  assert.equal(f.node('receipt').textContent, ''); assert.equal(f.node('save').textContent, ''); assert.equal(f.calls.length, 0);
});
test('journal refusals and uncertain input remain visible outside routine admission notices', () => {
  const f = fixture(); const a = f.connect(); const result: OperationView = {id: 'other-tab', kind: 'primary.input', target: a.target, state: 'uncertain', createdAt: '', updatedAt: ''};
  f.composer.receipts([result]); assert.match(f.node('receipt').textContent, /Send not confirmed/);
  f.composer.receipts([{...result, state: 'rejected'}]); assert.match(f.node('receipt').textContent, /Input refused/);
  f.composer.receipts([{...result, state: 'accepted'}]); assert.equal(f.node('receipt').textContent, '');
});
test('a healthy selection gate blocks Send and draft writes without offline presentation', async () => {
  const f = fixture(); f.connect(); f.composer.availability(true, true, false, true); f.composer.setText('unsaved');
  assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, true); assert.equal(f.composer.unsaved, true);
  assert.match(f.node('send').attrs.get('aria-description') ?? '', /View change/);
  await f.composer.send(); assert.equal(f.calls.length, 0);
  f.composer.availability(true, true, false, false); assert.equal(f.pick('PUT', '/draft').body.text, 'unsaved'); f.saved('unsaved'); await turn();
  assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, false);
});
test('an outstanding save settles during a healthy gate but newer text waits until the gate clears', async () => {
  const f = fixture(); f.connect(); f.composer.setText('first'); f.composer.availability(true, true, false, true); f.composer.setText('newer');
  f.saved('first'); await turn(); assert.equal(f.calls.length, 0); assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, true);
  f.composer.availability(true, true, false); assert.equal(f.pick('PUT', '/draft').body.text, 'newer'); f.saved('newer', 2); await turn();
  f.composer.availability(false, true, false, true); f.composer.setText('offline edit'); assert.equal(f.node('save').textContent, 'Draft not saved · offline');
});
