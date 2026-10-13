import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { CommandInventory } from './command-menu-state.ts';
beforeEach(context => { context.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 0}); Reflect.deleteProperty(globalThis, 'sessionStorage'); });
import type { DraftView, OperationView, Target, TargetIndex, TargetState } from '../shared/api.ts';

import { Composer, createComposerElements, type ComposerElements } from './composer.ts';
import { MessageTarget } from './selection-state.ts';
class NodeFake {
  id = ''; tag = ''; className = ''; parentElement?: NodeFake; type = ''; selectionStart = 0; selectionEnd = 0; offsetTop = 0; scrollTop = 0; scrollLeft = 0; clientHeight = 80;
  get ownerDocument(): Document { return document; }
  classList = {add: (...names: string[]) => {this.className = `${this.className} ${names.join(' ')}`.trim();}, contains: (name: string) => this.className.split(' ').includes(name)};
  prepend(...nodes: NodeFake[]): void {this.children.unshift(...nodes);}
  removeAttribute(name: string): void { this.attrs.delete(name); }
  selectionDirection: 'forward' | 'backward' | 'none' = 'none';
  setSelectionRange(start: number, end: number, direction: 'forward' | 'backward' | 'none' = 'none'): void { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  isConnected = false; style = {height: '', maxHeight: ''};
  get offsetHeight(): number { return Number.parseFloat(this.style.height) || 85.5; }
  get scrollHeight(): number { return this.value.split('\n').length * 22.5 + 16; }
  conversationHeight = 900;
  closest(selector?: string): {clientHeight: number} | null {
    if (selector === '[hidden],[inert]') return this.hidden || this.inert ? this : this.parentElement?.closest(selector) ?? null;
    return {clientHeight: this.conversationHeight};
  }
  getBoundingClientRect(): {top: number; bottom: number} { return {top: 0, bottom: 0}; }
  private input = '';
  get value(): string { return this.input; }
  set value(value: string) { this.input = value; this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'; }
  open = false; dataset: Record<string, string> = {}; hidden = false; inert = false; disabled = false; focused = false;
  private text = ''; children: NodeFake[] = []; attrs = new Map<string, string>(); listeners = new Map<string, ((event: EventFake) => void)[]>();
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('\n'); }
  set textContent(text: string) { this.text = text; this.children = []; }
  append(...nodes: NodeFake[]): void { this.children.push(...nodes); for (const node of nodes) node.parentElement = this; }
  contains(node: NodeFake): boolean {return this === node || this.children.some(child => child.contains(node));}
  replaceChildren(...nodes: NodeFake[]): void { this.text = ''; this.children = nodes; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null {return this.attrs.get(name) ?? null;}
  focus(): void { this.focused = true; Reflect.set(document, 'activeElement', this); this.fire('focus'); }
  select(): void {}
  addEventListener(name: string, listener: (event: EventFake) => void): void { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  removeEventListener(name: string, listener: (event: EventFake) => void): void {this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== listener));}
  querySelectorAll(): NodeFake[] { return this.children; }
  querySelector(selector: string): NodeFake | undefined {
    for (const child of this.children) {if (selector === child.tag || (selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1))) || selector.includes(`"${child.dataset.mode}"`)) return child; const found = child.querySelector(selector); if (found) return found;}
    return undefined;
  }
  fire(name: string, options: Partial<EventFake> = {}): EventFake {
    const event: EventFake = {key: '', defaultPrevented: false, isComposing: false, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      preventDefault() { this.defaultPrevented = true; }, ...options};
    for (const listener of this.listeners.get(name) ?? []) listener(event); return event;
  }
  find(text: string): NodeFake | undefined {
    if (this.text === text || this.attrs.get('aria-label') === text) return this;
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
function scopedNodes(id: string, withMenu: boolean) {
  const nodes = new Map<string, NodeFake>();
  for (const name of ['editor', 'recipient', 'composer', 'modes', 'send', 'caption', 'save', 'receipt', 'receipt-details', 'command-menu']) {const node = new NodeFake(); node.id = `${id}-${name}`; nodes.set(name, node);}
  const node = (name: string) => nodes.get(name) as NodeFake;
  const delivery = new NodeFake(); delivery.tag = 'select'; node('modes').append(delivery);
  const pane = new NodeFake(); Object.defineProperty(pane, 'clientHeight', {get: () => node('editor').conversationHeight});
  pane.append(node('composer')); node('composer').append(node('editor'), node('recipient'), node('receipt'), node('modes'), node('send'));
  const elements = {root:node('composer'), editor:node('editor'), recipient:node('recipient'), receipt:node('receipt'), receiptDetails:node('receipt-details'), modes:node('modes'), send:node('send'), save:node('save'), commandMenu:withMenu ? node('command-menu') : undefined} as unknown as ComposerElements;
  return {node, elements};
}
function fixture(prefix: 'primary' | 'agent' = 'primary', commands?: () => CommandInventory, withMenu = prefix === 'primary', timing?: (start: number, end: number) => void, enterSends: () => boolean = () => false) {
  const scoped = scopedNodes(prefix, withMenu); const announcements = new NodeFake(); const lookups: string[] = [];
  const calls: Call[] = []; let sequence = 0; const frames: (() => void)[] = []; const copied: string[] = [];
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {execCommand: (_command: string, _ui: boolean, value: string) => {
    const editor = document.activeElement as unknown as NodeFake; const at = editor.selectionStart;
    editor.value = editor.value.slice(0, at) + value + editor.value.slice(editor.selectionEnd); editor.setSelectionRange(at + value.length, at + value.length); editor.fire('input'); return true;
  }, getElementById: (id: string) => {lookups.push(id); assert.equal(id, 'announcements', 'Composer never resolves an instance through the global document'); return announcements;}, createElementNS: (_namespace: string, tag: string) => {const node = new NodeFake(); node.tag = tag; return node;}, createElement: (tag: string) => {const node = new NodeFake(); node.tag = tag; return node;}}});
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => { copied.push(text); }}}});
  Object.defineProperty(globalThis, 'requestAnimationFrame', {configurable: true, value: (callback: () => void) => frames.push(callback)});
  Object.defineProperty(globalThis, 'fetch', {configurable: true, value: (path: string, init: RequestInit) => {
    if (path === '/api/operations') { const operationId = `op-${++sequence}`; return Promise.resolve({json: async () => ({ok: true, data: {operationId}})}); }
    return new Promise((resolve, reject) => calls.push({path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : {},
      id: (init.headers as Record<string, string>)['Idempotency-Key'], resolve: value => resolve({json: async () => value}), reject}));
  }});
  const submitted: OperationView[] = []; let unknown = (_text: string, _send: () => void) => false;
  const retained: {workspace: string; target: Target; value: boolean}[] = [];
  const create = (id: string, inventory?: () => CommandInventory, menu = true) => {
    const scope = scopedNodes(id, menu); const composer = new Composer(scope.elements, {submitted:result => submitted.push(result), unknownCommand:(text, send) => unknown(text, send), commands:inventory, retained:(workspace, target, value) => retained.push({workspace,target,value})});
    return {...scope, composer};
  };
  const composer = new Composer(scoped.elements, {timing, enterSends, submitted: result => submitted.push(result), unknownCommand: (text, send) => unknown(text, send), commands, retained: (workspace, target, value) => retained.push({workspace, target, value})});
  const node = scoped.node;
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
  return {composer, node, calls, retained, pick, ok, fail, saved, admit, click, connect, submitted, frames, copied, openReceipt, create, lookups, elements:scoped.elements, reservations: () => sequence,
    unknown: (handler: typeof unknown) => { unknown = handler; }};
}

test('composition commit beforeinput cannot release the Enter latch', async () => {
  for (const inputType of ['insertCompositionText', 'insertFromComposition']) {
    const f = fixture('primary', undefined, true, undefined, () => true); f.connect(state('a', draft(1, 'saved')));
    f.node('editor').fire('compositionstart'); f.node('editor').fire('compositionend');
    f.node('editor').fire('beforeinput', Object.assign({}, {inputType}));
    assert.equal(f.node('editor').fire('keydown', {key: 'Enter', metaKey: true}).defaultPrevented, true);
    await turn(); assert.equal(f.calls.length, 0);
  }
});
test('duplicate native input notifications keep one edit and one draft save', async () => {
  const f = fixture(); f.connect(); f.node('editor').value = 'one edit'; f.node('editor').fire('input');
  const retained = f.retained.length; f.node('editor').fire('input'); f.node('editor').fire('input');
  assert.equal(f.retained.length, retained); assert.equal(f.calls.filter(call => call.path.endsWith('/draft')).length, 1);
  f.saved('one edit'); await turn(); assert.equal(f.calls.length, 0);
});
test('newline is native by default; only saved explicit send gestures dispatch', async () => {
  for (const key of ['Enter', 'ArrowUp', 'ArrowDown', 'Tab', 'Escape']) {
    const f = fixture(); f.connect(state('a', draft(1, 'saved')));
    assert.equal(f.node('editor').fire('keydown', {key}).defaultPrevented, false); await turn(); assert.equal(f.calls.length, 0);
  }
  for (const modifier of [{metaKey: true}, {ctrlKey: true}]) {
    const f = fixture(); f.connect(state('a', draft(1, 'saved')));
    assert.equal(f.node('editor').fire('keydown', {key: 'Enter', ...modifier}).defaultPrevented, true); await turn(); assert.ok(f.pick('POST', '/inputs'));
  }
  const f = fixture('primary', undefined, true, undefined, () => true); f.connect(); f.composer.setText('unsaved');
  f.node('editor').fire('keydown', {key: 'Enter', metaKey: true}); f.saved('unsaved'); await turn(); assert.equal(f.calls.length, 0);
  assert.equal(f.node('editor').fire('keydown', {key: 'Enter', shiftKey: true}).defaultPrevented, false);
  assert.equal(f.node('editor').fire('keydown', {key: 'Enter', repeat: true}).defaultPrevented, true); await turn(); assert.equal(f.calls.length, 0);
});
test('composition commit suppression survives compositionend, form submission and final keydown until matching keyup', async () => {
  for (const finalBeforeEnd of [false, true]) {
    const f = fixture('primary', undefined, true, undefined, () => true); f.connect(state('a', draft(1, 'saved'))); const editor = f.node('editor');
    editor.fire('compositionstart');
    if (finalBeforeEnd) editor.fire('keydown', {key: 'Enter'});
    editor.fire('compositionend');
    if (!finalBeforeEnd) assert.equal(editor.fire('keydown', {key: 'Enter'}).defaultPrevented, true);
    f.node('composer').fire('submit'); await turn(); assert.equal(f.calls.length, 0);
    editor.fire('keyup', {key: 'Enter'}); editor.fire('keydown', {key: 'Enter'}); await turn(); assert.ok(f.pick('POST', '/inputs'));
  }
});
test('a later non-Enter native edit releases the composition latch without replay', async () => {
  const f = fixture(); f.connect(state('a', draft(1, 'saved'))); const editor = f.node('editor');
  editor.fire('compositionstart'); editor.fire('compositionend'); editor.fire('beforeinput', {inputType: 'insertText'} as Partial<EventFake>);
  editor.fire('keydown', {key: 'Enter', ctrlKey: true}); await turn(); assert.ok(f.pick('POST', '/inputs'));
});
test('modifier Enter closes active completion first and does not bypass loading or empty lists', async () => {
  for (const inventory of [{state: 'loading', items: []}, {state: 'ready', items: []}] as CommandInventory[]) {
    const f = fixture('primary', () => inventory); f.connect(state('a', draft(1, '/mo'))); f.node('editor').setSelectionRange(3, 3); f.node('editor').focus();
    f.node('editor').fire('keydown', {key: 'Enter', ctrlKey: true}); await turn(); assert.equal(f.calls.length, 0); assert.equal(f.node('command-menu').hidden, true);
  }
});
test('over-byte native paste remains exact, unsaved and unsendable without a backend request', async () => {
  const f = fixture(); f.connect(); const value = 'é'.repeat(32769); f.node('editor').value = value; f.node('editor').fire('input');
  assert.equal(f.composer.editor.value, value); assert.equal(f.composer.unsaved, true); assert.equal(f.node('send').disabled, true); assert.equal(f.calls.length, 0);
  f.node('editor').fire('keydown', {key: 'Enter', ctrlKey: true}); await turn(); assert.equal(f.calls.length, 0);
  const retry = f.node('receipt').find('Retry draft save'); assert.ok(retry); assert.equal(retry.disabled, true);
  f.click('Retry draft save'); await turn(); assert.equal(f.calls.length, 0); assert.equal(f.composer.editor.value, value);
  f.node('editor').value = 'fits'; f.node('editor').fire('input'); assert.equal(f.pick('PUT', '/draft').body.text, 'fits');
});
test('saved ranges and editor scroll survive reload with exact target identity', () => {
  const f = fixture(); const values = new Map<string, string>();
  Reflect.set(globalThis, 'sessionStorage', {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value)});
  const a = f.connect(state('a', draft(4, 'saved draft'))); const editor = f.node('editor');
  editor.setSelectionRange(2, 7, 'backward'); editor.scrollTop = 48; editor.scrollLeft = 12; editor.fire('select'); f.composer.destroy();
  const reloaded = f.create('reload'); reloaded.composer.attach('w', a); reloaded.composer.focus();
  assert.deepEqual([reloaded.node('editor').selectionStart, reloaded.node('editor').selectionEnd, reloaded.node('editor').selectionDirection], [2, 7, 'backward']);
  assert.deepEqual([reloaded.node('editor').scrollTop, reloaded.node('editor').scrollLeft], [48, 12]);
  for (const [workspace, target] of [['other-workspace', a], ['w', {...a, target: {...a.target, epoch: 8}}], ['w', state('a', draft(5, 'saved draft'))]] as const) {
    const other = f.create('other'); other.composer.attach(workspace, target); assert.equal(other.node('editor').selectionStart, 0);
  }
});
test('hidden viewport clamping never replaces the owned editor range or scroll checkpoint', () => {
  for (const hiddenEvents of [false, true]) {
    const f = fixture(); const saved = f.connect(state('a', draft(4, 'saved draft'))); const editor = f.node('editor'), root = f.node('composer');
    editor.focus(); editor.setSelectionRange(2, 7, 'backward'); editor.scrollTop = 80; editor.scrollLeft = 12; editor.fire('select');
    const unrelated = new NodeFake(); unrelated.focus(); root.hidden = true; root.inert = true; editor.scrollTop = 0; editor.scrollLeft = 0;
    if (hiddenEvents) {editor.fire('blur'); editor.fire('scroll'); f.composer.attach('w', saved);}
    root.hidden = false; root.inert = false; f.composer.attach('w', {...saved, draft: {...saved.draft}});
    assert.equal(document.activeElement === unrelated, true);
    assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection, editor.scrollTop, editor.scrollLeft], [2, 7, 'backward', 80, 12]);
    editor.fire('scroll'); f.composer.focus();
    assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection, editor.scrollTop, editor.scrollLeft], [2, 7, 'backward', 80, 12]);
    editor.scrollTop = 0; editor.scrollLeft = 0; editor.fire('scroll'); unrelated.focus(); f.composer.attach('w', saved); f.composer.focus();
    assert.deepEqual([editor.scrollTop, editor.scrollLeft], [0, 0], 'A deliberate visible scroll to the start remains a valid checkpoint.');
    assert.equal(f.composer.editor.value, saved.draft.text); assert.equal(f.calls.length, 0);
  }
});
test('in-memory selection ownership rejects another epoch even with a reused target key', () => {
  const f = fixture(); const a = f.connect(state('a', draft(4, 'shared text'))); f.node('editor').setSelectionRange(1, 5); f.node('editor').fire('select');
  const later = {...a, target: {kind: 'primary' as const, key: 'a', epoch: 8}}; f.composer.attach('w', later); f.composer.focus(); assert.equal(f.node('editor').selectionStart, 0);
  f.composer.attach('w', a); f.composer.focus(); assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd], [1, 5]);
});
test('explicit editor focus waits for draft hydration and expires when another control takes focus', () => {
  const f = fixture(); f.composer.attach('w'); const origin = new NodeFake(); origin.focus(); f.composer.focus();
  f.composer.attach('w', state('a', draft(4, 'saved'))); assert.equal(document.activeElement, f.composer.editor);
  f.composer.attach('w'); origin.focus(); f.composer.focus(); const unrelated = new NodeFake(); unrelated.focus();
  f.composer.attach('w', state('b', draft(4, 'other'))); assert.equal(document.activeElement, unrelated);
  f.composer.attach('w', state('b', draft(4, 'other'))); assert.equal(document.activeElement, unrelated);
});
test('unavailable browser storage never interrupts native editing or in-memory restoration', () => {
  const f = fixture(); Reflect.set(globalThis, 'sessionStorage', {getItem() {throw new Error('denied');}, setItem() {throw new Error('quota');}});
  f.connect(state('a', draft(4, 'saved text'))); f.node('editor').setSelectionRange(1, 4); f.node('editor').fire('select');
  f.composer.attach('w'); f.composer.attachRetained('w', {kind: 'primary', key: 'a', epoch: 7}); f.composer.focus();
  assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd], [1, 4]);
});
test('own save acknowledgement rebases a matching range without accepting an external revision', async () => {
  const f = fixture(); f.connect(); f.composer.setText('local draft'); const editor = f.node('editor'); editor.setSelectionRange(1, 5, 'backward'); editor.fire('select');
  f.composer.updateDraft(draft(1, 'local draft')); editor.setSelectionRange(0, 0); f.composer.focus(); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [1, 5]);
  f.saved('local draft', 1); await turn(); editor.setSelectionRange(0, 0); f.composer.focus();
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [1, 5]);
  f.composer.updateDraft(draft(2, 'local draft')); editor.setSelectionRange(0, 0); f.composer.focus(); assert.equal(editor.selectionStart, 0);
});
test('accepted send clears and clamps the range; rejection keeps it; late results never steal other focus', async () => {
  for (const outcome of ['accepted', 'rejected'] as const) {
    const f = fixture(); const a = f.connect(state('a', draft(4, 'send draft'))); const editor = f.node('editor'); editor.focus(); editor.setSelectionRange(2, 7, 'backward'); editor.scrollTop = 24; editor.fire('select');
    f.node('send').focus(); const sending = f.composer.send(); await turn(); f.admit(a, outcome); await turn();
    if (outcome === 'accepted') f.ok(f.pick('GET', '/a'), state('a', draft(5, '')));
    await sending; assert.equal(document.activeElement, f.composer.editor);
    assert.deepEqual([editor.selectionStart, editor.selectionEnd], outcome === 'accepted' ? [0, 0] : [2, 7]);
    assert.equal(editor.scrollTop, outcome === 'accepted' ? 0 : 24);
  }
  const f = fixture(); const a = f.connect(state('a', draft(4, 'send draft'))); f.node('editor').focus(); const sending = f.composer.send(); await turn();
  const unrelated = new NodeFake(); unrelated.focus(); f.admit(a, 'rejected'); await sending; assert.equal(document.activeElement, unrelated);
  f.composer.attach('w', a); f.composer.availability(true, true, false); f.composer.receipts([]); assert.equal(document.activeElement, unrelated);
});
test('send settlement preserves a newer draft selection and another target focus', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(4, 'captured'))); f.node('editor').focus(); const sending = f.composer.send(); await turn();
  f.composer.setText('newer draft'); f.node('editor').setSelectionRange(2, 6, 'backward'); f.node('editor').fire('select');
  f.admit(a); await turn(); f.ok(f.pick('GET', '/a'), state('a', draft(5, ''))); await sending;
  assert.equal(f.composer.editor.value, 'newer draft'); assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd, f.node('editor').selectionDirection], [2, 6, 'backward']);
  f.saved('newer draft', 6); await turn();
  const second = f.composer.send(); await turn(); f.composer.attach('w', state('b', draft(4, 'other draft'))); f.node('editor').setSelectionRange(1, 3); f.node('editor').focus();
  f.admit(a, 'rejected'); await second; assert.equal(f.composer.editor.value, 'other draft'); assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd], [1, 3]);
});
test('draft drain saves all retained buffers without delivery and honors cancellation', async () => {
  const f = fixture(); f.connect(state('a')); f.composer.setText('alpha');
  const second = state('b'); f.composer.attach('w', second); f.composer.setText('beta');
  const abort = new AbortController(); let settled = false;
  const drain = f.composer.drain(abort.signal).then(() => {settled = true;}); await turn();
  assert.equal(settled, false); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 2);
  for (const call of [...f.calls]) if (call.method === 'PUT') f.ok(call, draft(1, String(call.body.text)));
  await drain; assert.equal(f.composer.unsaved, false); assert.equal(f.submitted.length, 0);
  f.composer.setText('cancel-safe'); const cancellation = new AbortController();
  const pending = f.composer.drain(cancellation.signal); cancellation.abort(new Error('drain cancelled'));
  await assert.rejects(pending, /drain cancelled/); f.saved('cancel-safe', 2); await turn();
  assert.equal(f.composer.unsaved, false); assert.equal(f.submitted.length, 0);
});
test('draft drain refuses IME and conflict without new requests', async () => {
  const f = fixture(); f.connect(); f.node('editor').fire('compositionstart');
  assert.equal(f.composer.reloadHold, 'ime'); await assert.rejects(f.composer.drain(new AbortController().signal), /not safe/);
  f.node('editor').fire('compositionend'); f.composer.setText('review'); f.fail(f.pick('PUT', '/draft'), 'stale_revision'); await turn();
  const before = f.calls.length; assert.equal(f.composer.reloadHold, 'conflict');
  await assert.rejects(f.composer.drain(new AbortController().signal), /not safe/); assert.equal(f.calls.length, before);
});
test('editor echo timing is optional, target-owned and stops after owner disposal', () => {
  const samples: number[][] = [], f = fixture('primary', undefined, false, (start, end) => {samples.push([start, end]);}); f.connect();
  const before = performance.getEntriesByName('ui:editor-echo').length; f.node('editor').value = 'first exact'; f.node('editor').fire('input');
  assert.equal(f.composer.editor.value, 'first exact'); assert.equal(samples.length, 0); for (const frame of f.frames.splice(0)) frame();
  assert.equal(samples.length, 1); assert.ok(samples[0]?.every(Number.isFinite)); assert.ok((samples[0]?.[1] ?? -1) >= (samples[0]?.[0] ?? 0));
  f.node('editor').value = 'retargeted'; f.node('editor').fire('input'); f.composer.attach('w', state('b'));
  for (const frame of f.frames.splice(0)) frame(); assert.equal(samples.length, 1);
  f.node('editor').value = 'closed'; f.node('editor').fire('input'); f.composer.destroy(); for (const frame of f.frames.splice(0)) frame();
  assert.equal(samples.length, 1); assert.equal(performance.getEntriesByName('ui:editor-echo').length, before);
});
test('disposal waits for saves and exposes the acknowledged server draft revision', async () => {
  const f = fixture(); f.connect(); assert.equal(f.composer.canDispose, true); assert.equal(f.composer.serverDraftRevision, 0);
  f.composer.setText(' exact saved copy '); assert.equal(f.composer.canDispose, false);
  f.saved(' exact saved copy ', 1); await turn(); assert.equal(f.composer.canDispose, true); assert.equal(f.composer.serverDraftRevision, 1);
  f.composer.attach('w', state('a')); assert.equal(f.composer.editor.value, ' exact saved copy '); assert.equal(f.composer.serverDraftRevision, 1);
});
test('a dispatched or uncertain input retains its owner after draft acknowledgement', async () => {
  const f = fixture(); const target = f.connect(); f.composer.setText('held input'); const sending = f.composer.send();
  assert.equal(f.composer.canDispose, false); f.saved('held input', 1); await turn(); assert.equal(f.composer.canDispose, false);
  f.admit(target, 'uncertain'); await sending; assert.equal(f.composer.canDispose, false); assert.equal(f.composer.editor.value, 'held input');
});
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
  f.click('Review'); f.fail(f.pick('GET', '/a'), 'review_unavailable'); await turn();
  assert.match(f.node('receipt').textContent, /Draft could not be loaded/); assert.match(f.node('receipt').textContent, /review_unavailable/);
  f.click('Review'); f.ok(f.pick('GET', '/a'), state('a', draft(4, 'remote'))); await turn(); assert.match(f.node('receipt').textContent, /mine/); assert.match(f.node('receipt').textContent, /remote/);
  f.click('Use Mac draft'); assert.equal(f.composer.editor.value, 'remote'); assert.equal(f.composer.unsaved, false);
  assert.doesNotMatch(f.node('receipt').textContent, /review_unavailable|Draft could not be loaded/);
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
  f.openReceipt(); assert.match(f.node('receipt-details').textContent, /Delivery details/); assert.match(f.node('receipt-details').textContent, /started/);
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
  f.click('Copy original message'); await turn(); assert.deepEqual(f.copied, [' exact\n ']); f.click('Restore to draft'); assert.equal(f.composer.editor.value, ' exact\n ');
  f.click('Check delivery'); assert.equal(f.pick('POST', '/reconcile').path, '/api/operations/op-1/reconcile'); f.fail(f.pick('POST', '/reconcile'), 'unknown_operation'); await turn();
  assert.match(f.node('receipt').textContent, /admission remains unknown/); f.click('Send again…'); assert.equal(f.calls.length, 0);
  f.click('Send again'); await turn(); assert.equal(f.pick('POST', '/inputs').id, 'op-2'); f.admit(a, 'rejected'); await turn();
});
test('an uncertain send result shows one warning and retains explicit recovery controls', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'original')));
  const sending = f.composer.send(); await turn(); f.admit(a, 'uncertain'); await sending;
  const receipt = f.node('receipt'); assert.equal(receipt.textContent.split('Send not confirmed. Check before you send again.').length - 1, 1);
  assert.doesNotMatch(receipt.textContent, /Check the receipt before another submission/);
  for (const label of ['Check delivery', 'Copy original message', 'Restore to draft', 'Send again…']) assert.ok(receipt.find(label));
  assert.equal(f.composer.editor.value, 'original'); assert.equal(f.calls.length, 0);
});
test('restoring uncertain input does not replace a newer draft without an explicit choice', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'original'))); const sending = f.composer.send(); await turn(); f.admit(a, 'uncertain'); await sending;
  f.composer.availability(false, false, false); f.composer.setText('newer'); f.click('Restore to draft'); await turn(); assert.equal(f.composer.editor.value, 'newer');
  f.click('Replace draft with original'); assert.equal(f.composer.editor.value, 'original');
});
test('restored input uses one Composer recovery UI, blocks duplicates, and accepts late receipt', async () => {
  const f = fixture(); const a = state('a', draft(2, 'original')); a.unconfirmed.push({operationId: 'retained', target: a.target, text: 'original', mode: 'prompt', submittedDraftRevision: 2, createdAt: '', reason: 'unknown'});
  f.connect(a); assert.equal(f.node('receipt').textContent.split('Send not confirmed').length - 1, 1);
  for (const label of ['Check delivery', 'Copy original message', 'Restore to draft']) assert.ok(f.node('receipt').find(label));
  await f.composer.send(); assert.equal(f.calls.length, 0);
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
  assert.equal(f.node('modes').children[0]?.fire('keydown', {key: 'Tab'}).defaultPrevented, false);
  assert.equal(f.node('editor').fire('keydown', {key: 'Tab', shiftKey: true}).defaultPrevented, false);
});
test('Enter sends preference submits once while pending and form submission shares the duplicate guard', async () => {
  const f = fixture('primary', undefined, true, undefined, () => true); const a = f.connect(state('a', draft(1, 'sent')));
  assert.equal(f.node('editor').fire('keydown', {key: 'Enter'}).defaultPrevented, true); f.node('composer').fire('submit'); await turn();
  assert.equal(f.calls.filter(call => call.path.endsWith('/inputs')).length, 1); f.admit(a, 'rejected'); await turn();
});
test('unknown-command literal action is bound to the original unchanged draft and target', async () => {
  const f = fixture(); f.connect(state('a', draft(1, '/unknown'))); let literal: (() => void) | undefined;
  f.unknown((_text, send) => { literal = send; return true; }); await f.composer.send(); assert.equal(f.calls.length, 0);
  f.composer.attach('w', state('b', draft(1, 'B'))); literal?.(); await turn(); assert.equal(f.calls.length, 0);
  f.composer.attach('w', state('a', draft(1, '/unknown'))); literal?.(); await turn(); assert.equal(f.pick('POST', '/inputs').body.literal, true);
});

test('input echoes before a blocked network request and records the next frame', () => {
  const samples: number[][] = []; const f = fixture('primary', undefined, true, (start, end) => {samples.push([start, end]);}); f.connect(); f.node('editor').value = 'typed'; f.node('editor').fire('input');
  assert.equal(f.composer.editor.value, 'typed'); assert.equal(f.calls.length, 1); assert.equal(samples.length, 0); assert.equal(f.frames.length, 2); for (const frame of f.frames) frame();
  assert.equal(samples.length, 1); assert.equal(f.composer.editor.value, 'typed'); assert.equal(f.calls.length, 1); assert.equal(f.composer.unsaved, true);
});
test('a clean same-target snapshot updates saved text and mode', () => {
  const f = fixture(); f.connect(state('a', draft(1, 'old'))); f.composer.attach('w', state('a', draft(2, 'remote', 'steer')));
  assert.equal(f.composer.editor.value, 'remote'); assert.equal(f.composer.state?.draft.revision, 2); assert.equal(f.composer.unsaved, false);
  assert.equal(f.node('modes').children[0]?.value, 'steer');
});
test('a busy primary shows a prompt-mode draft as steer, the mode it delivers', () => {
  const f = fixture(); f.connect(state('a', draft(2, 'queued words', 'prompt'))); void f.composer.send(); f.composer.availability(true, true, true);
  assert.equal(f.node('modes').children[0]?.value, 'steer');
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
  f.connect(a); f.click('Copy original message'); const fetch = f.pick('GET', '/retained'); assert.equal(fetch.path, '/api/workspaces/w/unconfirmed/retained');
  f.composer.attach('other', state('b', draft(1, 'B'))); f.ok(fetch, {...item, text: ' exact\n original ', textTruncated: undefined}); await turn();
  assert.deepEqual(f.copied, [' exact\n original ']); assert.equal(f.composer.editor.value, 'B');
  f.composer.attach('w', a); f.click('Restore to draft'); await turn(); assert.equal(f.composer.editor.value, 'newer');
  f.click('Replace draft with original'); assert.equal(f.composer.editor.value, ' exact\n original '); assert.equal(f.pick('PUT', '/draft').body.expectedRevision, 3);
});
test('delayed draft restoration returns focus only to the original action owner', async () => {
  for (const nextFocus of ['delivery', 'external', 'restore'] as const) {
    const f = fixture(); const a = state('a', draft(3, '', 'steer'));
    const item = {operationId: 'retained', target: a.target, text: 'preview', mode: 'steer', submittedDraftRevision: 2, createdAt: '', reason: 'unknown', textTruncated: true as const}; a.unconfirmed.push(item);
    f.connect(a); f.composer.availability(true, true, true); assert.equal(f.node('modes').hidden, false);
    const restore = f.node('receipt').find('Restore to draft'); assert.ok(restore); restore.focus(); restore.fire('click');
    const fetch = f.pick('GET', '/retained'); assert.equal(fetch.path, '/api/workspaces/w/unconfirmed/retained');
    const origin = nextFocus === 'delivery' ? f.node('modes').children[0] : nextFocus === 'external' ? new NodeFake() : restore; assert.ok(origin); origin.focus();
    f.ok(fetch, {...item, text: 'full original', textTruncated: undefined}); await turn();
    assert.equal(f.composer.editor.value, 'full original'); assert.equal(f.pick('PUT', '/draft').body.expectedRevision, 3);
    assert.equal(document.activeElement === (nextFocus === 'restore' ? f.composer.editor : origin), true, `focus owner: ${nextFocus}`);
    f.saved('full original', 4, 'steer'); await turn(); assert.equal(document.activeElement === (nextFocus === 'restore' ? f.composer.editor : origin), true, `saved focus owner: ${nextFocus}`);
    assert.equal(f.calls.length, 0);
  }
});
test('explicit replacement starts a fresh focus intent after delayed restoration review', async () => {
  const f = fixture(); const a = state('a', draft(3, 'newer', 'steer'));
  const item = {operationId: 'retained', target: a.target, text: 'preview', mode: 'steer', submittedDraftRevision: 2, createdAt: '', reason: 'unknown', textTruncated: true as const}; a.unconfirmed.push(item);
  f.connect(a); f.composer.availability(true, true, true); assert.equal(f.node('modes').hidden, false);
  f.node('editor').setSelectionRange(1, 4, 'backward'); f.node('editor').fire('select');
  const restore = f.node('receipt').find('Restore to draft'); assert.ok(restore); restore.focus(); restore.fire('click');
  const delivery = f.node('modes').children[0]; assert.ok(delivery); delivery.focus();
  f.ok(f.pick('GET', '/retained'), {...item, text: 'full original', textTruncated: undefined}); await turn();
  assert.equal(f.composer.editor.value, 'newer'); assert.equal(document.activeElement, delivery); assert.equal(f.calls.length, 0);
  const replace = f.node('receipt').find('Replace draft with original'); assert.ok(replace); replace.focus(); replace.fire('click');
  assert.equal(document.activeElement, f.composer.editor); assert.equal(f.composer.editor.value, 'full original');
  assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd, f.node('editor').selectionDirection], [1, 4, 'backward']);
  assert.equal(f.pick('PUT', '/draft').body.expectedRevision, 3); f.saved('full original', 4, 'steer'); await turn(); assert.equal(f.calls.length, 0);
});
test('failed exact recovery fetch never copies or restores the preview', async () => {
  const f = fixture(); const a = state('a', draft(3, 'newer'));
  a.unconfirmed.push({operationId: 'retained', target: a.target, text: 'preview', mode: 'prompt', submittedDraftRevision: 2, createdAt: '', reason: 'unknown', textTruncated: true});
  f.connect(a); f.click('Copy original message'); f.fail(f.pick('GET', '/retained'), 'host_unavailable'); await turn();
  assert.deepEqual(f.copied, []); assert.equal(f.composer.editor.value, 'newer'); assert.match(f.node('receipt').textContent, /Send not confirmed/);
});
test('accepted native receipt exposes exact identity, submission ID, and request key', async () => {
  const f = fixture('agent'); const a = f.connect(state('a', draft(2, 'sent', 'followUp'), true)); const sending = f.composer.send(); await turn();
  const input = f.pick('POST', '/inputs'); const result: OperationView = {id: input.id as string, kind: 'agent.input', target: a.target, state: 'accepted', createdAt: '', updatedAt: '',
    receipt: {kind: 'durable', identity: 'a', submissionId: 42, requestId: 'ui:op-1', deduped: false}};
  f.ok(input, result); await turn(); f.ok(f.pick('GET', '/a'), state('a', draft(3, '', 'followUp'), true)); await sending;
  f.openReceipt(); assert.match(f.node('receipt-details').textContent, /Delivery details/); assert.match(f.node('receipt-details').textContent, /42/); assert.match(f.node('receipt-details').textContent, /ui:op-1/);
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

test('an unavailable agent keeps an editable draft and visible disabled Send without an acquisition dependency', () => {
  const f = fixture('agent'); f.connect(state('a', draft(1, 'retained', 'steer'), true));
  f.composer.availability(true, false, true); assert.equal(f.composer.editor.value, 'retained');
  assert.equal(f.node('send').hidden, false); assert.equal(f.node('acquire'), undefined); assert.equal(f.node('modes').hidden, true); assert.equal(f.node('send').attrs.get('aria-description'), 'Connect this agent to send.');
  assert.equal(f.node('send').disabled, true);
  f.composer.availability(false, false, false); assert.equal(f.node('send').hidden, false); assert.equal(f.node('send').disabled, true); assert.equal(f.node('acquire'), undefined);
});
test('a missing target hides the composer and clears all save and receipt presentation', () => {
  const f = fixture(); f.connect(); f.composer.attach('w');
  assert.equal(f.node('composer').hidden, true); assert.equal(f.node('save').textContent, ''); assert.equal(f.node('receipt-details').textContent, ''); assert.equal(f.node('send').disabled, true);
});
test('input and control receipts share one disclosure and never leak across targets', () => {
  const f = fixture(); const a = f.connect();
  const result: OperationView = {id: 'input', target: a.target, kind: 'primary.input', state: 'accepted', createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z'};
  f.composer.receipts([result, {...result, id: 'control', kind: 'primary.control', state: 'completed', updatedAt: '2026-10-08T12:01:00Z'}]);
  assert.equal(f.node('receipt-details').children.length, 1); f.openReceipt(); assert.match(f.node('receipt-details').textContent, /Input receipt/); assert.match(f.node('receipt-details').textContent, /Action receipt/); assert.equal(f.node('receipt').textContent, '');
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
    f.composer.setText('one'); paint(); assert.equal(editor.style.height, '40.5px');
    editor.style.height = '180px'; editor.fire('pointerup'); f.composer.setText('two'); paint(); assert.equal(editor.style.height, '180px');
    f.composer.setManualHeight(600); paint(); assert.equal(editor.style.height, '540px'); assert.equal(editor.style.maxHeight, '540px');
    f.composer.setText('short'); paint(); assert.equal(editor.style.height, '540px');
    editor.conversationHeight = 400; f.composer.resize(); paint(); assert.equal(editor.style.height, '240px');
    editor.conversationHeight = 900; f.composer.resize(); paint(); assert.equal(editor.style.height, '540px');
    f.composer.setManualHeight(300.6); paint(); assert.equal(editor.style.height, '301px');
    f.node('composer').hidden = true; f.composer.setManualHeight(600); paint(); assert.equal(editor.style.height, '301px');
    f.node('composer').hidden = false; f.composer.resize(); paint(); assert.equal(editor.style.height, '540px');
    f.composer.setManualHeight(0); paint(); assert.equal(editor.style.height, '40.5px');
    f.composer.setManualHeight(undefined); paint(); assert.equal(editor.style.height, '40.5px'); assert.equal(editor.style.maxHeight, '243px');
    for (const px of [NaN, Infinity, -1]) assert.throws(() => f.composer.setManualHeight(px), RangeError);
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
  f.composer.setText('unsaved'); assert.equal(f.node('save').textContent, 'Draft not saved'); assert.equal(f.calls.length, 0);
  f.composer.availability(true, true, false); assert.equal(f.node('save').textContent, '');
  f.saved('unsaved', 2); await turn(); assert.equal(f.node('save').textContent, '');
});
test('a failed save exposes Retry and latches through edits until an explicit retry succeeds', async () => {
  const f = fixture(); f.connect(); f.composer.setText('one'); f.fail(f.pick('PUT', '/draft'), 'host_unavailable'); await turn();
  assert.equal(f.node('save').textContent, 'Draft not saved'); assert.doesNotMatch(f.node('receipt').textContent, /Draft not saved/); assert.match(f.node('receipt').textContent, /host_unavailable/);
  f.composer.setText('two'); assert.equal(f.calls.length, 0); f.click('Retry draft save'); assert.equal(f.pick('PUT', '/draft').body.text, 'two');
  f.saved('two'); await turn(); assert.equal(f.node('save').textContent, ''); assert.equal(f.node('receipt').textContent, '');
});
test('routine admitted notices announce once without persistent text but queued input remains visible', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'sent'))); const sending = f.composer.send(); await turn();
  f.admit(a); await turn(); f.ok(f.pick('GET', '/a'), state('a', draft(3, ''))); await sending;
  assert.equal(f.node('receipt').textContent, ''); assert.equal(f.node('save').textContent, '');
  f.composer.receipts([{id: 'queued', kind: 'primary.input', target: a.target, state: 'accepted', receipt: {kind: 'rpc', disposition: 'queued'}, createdAt: '', updatedAt: ''}]);
  assert.match(f.node('receipt').textContent, /Message queued/); assert.equal(f.node('save').textContent, '');
});
test('an open primary menu accepts an exact name without dispatch and normal Enter returns after acceptance', async () => {
  const commands = () => ({state: 'ready' as const, items: [{name: 'fixture', description: 'public command', source: 'extension'}]});
  const f = fixture('primary', commands); const a = f.connect(state('a', draft(1, '/fixture')));
  f.node('editor').setSelectionRange(8, 8); f.node('editor').fire('focus'); f.composer.commandsChanged();
  assert.equal(f.node('command-menu').hidden, false); f.node('editor').fire('keydown', {key: 'Enter'}); await turn();
  assert.equal(f.composer.editor.value, '/fixture '); assert.equal(f.calls.some(call => call.path.endsWith('/inputs')), false);
  f.saved('/fixture ', 2); await turn(); f.node('editor').fire('keydown', {key: 'Enter', metaKey: true}); await turn();
  assert.equal(f.calls.filter(call => call.path.endsWith('/inputs')).length, 1); f.admit(a, 'rejected'); await turn();
});
test('loading or empty primary menus consume Enter and agent composers never open slash menus', async () => {
  let inventory: CommandInventory = {state: 'loading', items: []}; const f = fixture('primary', () => inventory); f.connect(state('a', draft(1, '/missing')));
  f.node('editor').setSelectionRange(8, 8); f.node('editor').fire('focus'); f.node('editor').fire('keydown', {key: 'Enter'}); await turn(); assert.equal(f.calls.length, 0);
  inventory = {state: 'ready', items: []}; f.composer.commandsChanged(); f.node('editor').fire('keydown', {key: 'Enter'}); await turn(); assert.equal(f.calls.length, 0);
  const agent = fixture('agent', () => ({state: 'ready', items: [{name: 'model', description: '', source: 'app'}]})); agent.connect();
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
  assert.equal(f.node('save').textContent, 'Draft not saved'); assert.match(f.node('receipt').textContent, /host_unavailable/); f.click('Retry draft save'); f.saved('text'); await turn();
  assert.equal(f.node('receipt').textContent, ''); assert.equal(f.node('save').textContent, ''); assert.equal(f.calls.length, 0);
});
test('journal refusals and uncertain input remain visible outside routine admission notices', () => {
  const f = fixture(); const a = f.connect(); const result: OperationView = {id: 'other-tab', kind: 'primary.input', target: a.target, state: 'uncertain', createdAt: '', updatedAt: ''};
  f.composer.receipts([result]); assert.match(f.node('receipt').textContent, /Send not confirmed/);
  f.composer.receipts([{...result, state: 'rejected'}]); assert.match(f.node('receipt').textContent, /Message not sent/);
  f.composer.receipts([{...result, state: 'accepted'}]); assert.equal(f.node('receipt').textContent, '');
});
test('exact live target reuse retains the unchanged draft range through detach and attach', () => {
  const f = fixture(); const target = f.connect(state('a', draft(3, 'retained draft')));
  f.node('editor').setSelectionRange(2, 7, 'backward'); f.node('editor').focus();
  f.composer.attach('w'); assert.equal(f.node('editor').value, ''); assert.equal(f.node('editor').selectionStart, 0);
  f.composer.attach('w', {...target, draft: {...target.draft}}); f.node('editor').focus();
  assert.equal(f.node('editor').value, 'retained draft'); assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd, f.node('editor').selectionDirection], [2, 7, 'backward']);
  assert.equal(document.activeElement, f.composer.editor); assert.equal(f.submitted.length, 0);
});
test('chooser cancel restores an unchanged draft range after selection reload and focus return', () => {
  const f = fixture(); const target = f.connect(state('a', draft(3, 'retained draft')));
  f.node('editor').setSelectionRange(2, 7); f.node('editor').fire('blur');
  f.composer.attach('w'); f.composer.attach('w', {...target, draft: {...target.draft}});
  f.node('editor').setSelectionRange(0, 0); f.node('editor').focus();
  assert.equal(f.node('editor').value, 'retained draft'); assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd], [2, 7]);
  assert.equal(document.activeElement, f.composer.editor); assert.equal(f.calls.length, 0);
});
test('modal focus return restores the same revision range but never applies it to changed text or another target', () => {
  const f = fixture(); const target = f.connect(state('a', draft(3, 'retained draft')));
  f.node('editor').setSelectionRange(2, 7); f.node('editor').fire('blur');
  f.node('editor').setSelectionRange(0, 0); f.node('editor').focus(); assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd], [2, 7]);
  f.composer.attach('w', state('other', draft(3, 'other draft'))); assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd], [0, 0]);
  f.composer.attach('w', target); assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd], [2, 7]);
  f.node('editor').fire('blur'); f.composer.updateDraft(draft(4, 'changed text')); f.node('editor').focus();
  assert.equal(f.node('editor').value, 'changed text'); assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd], [0, 0]); assert.equal(f.submitted.length, 0);
});
test('a healthy selection gate blocks Send and draft writes without offline presentation', async () => {
  const f = fixture(); f.connect(); f.composer.availability(true, true, false, true); f.composer.setText('unsaved');
  assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, true); assert.equal(f.composer.unsaved, true);
  assert.equal(f.node('send').attrs.get('aria-description'), 'Selecting this conversation…');
  await f.composer.send(); assert.equal(f.calls.length, 0);
  f.composer.availability(true, true, false, false); assert.equal(f.pick('PUT', '/draft').body.text, 'unsaved'); f.saved('unsaved'); await turn();
  assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, false);
});
test('an outstanding save settles during a healthy gate but newer text waits until the gate clears', async () => {
  const f = fixture(); f.connect(); f.composer.setText('first'); f.composer.availability(true, true, false, true); f.composer.setText('newer');
  f.saved('first'); await turn(); assert.equal(f.calls.length, 0); assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, true);
  f.composer.availability(true, true, false); assert.equal(f.pick('PUT', '/draft').body.text, 'newer'); f.saved('newer', 2); await turn();
  f.composer.availability(false, true, false, true); f.composer.setText('offline edit'); assert.equal(f.node('save').textContent, 'Draft not saved');
});

test('closing a targeted composer preserves unsaved and conflicting copies with one retention transition', () => {
  const f = fixture('agent'); const a = state('a', draft(0, '', 'followUp'), true);
  f.composer.attach('w', a); f.composer.placement(true); f.composer.availability(false, false, false);
  f.composer.setText('first'); f.composer.setText('second'); f.composer.setText('exact local');
  assert.deepEqual(f.retained.map(item => item.value), [false, true]); assert.deepEqual(f.retained.at(-1)?.target, a.target);
  f.composer.attach('w'); assert.equal(f.composer.target, undefined); assert.equal(f.composer.retained('w', a.target), true);
  f.composer.attach('w', {...a, draft: draft(1, 'remote', 'followUp')});
  assert.equal(f.composer.editor.value, 'exact local'); assert.match(f.node('receipt').textContent, /Review/);
  f.composer.attach('w'); f.composer.attach('w', a); assert.match(f.node('receipt').textContent, /exact local/); assert.match(f.node('receipt').textContent, /remote/);
  assert.equal(f.composer.retained('other', a.target), undefined);
});
test('close retains pending and unconfirmed sends and reopening never sends them again', async () => {
  const f = fixture('agent'); const a = f.connect(state('a', draft(2, 'original', 'followUp'), true));
  const sending = f.composer.send(); await turn(); f.composer.attach('w');
  assert.equal(f.composer.retained('w', a.target), true); f.admit(a, 'uncertain'); await sending;
  f.composer.attach('w', a); assert.match(f.node('receipt').textContent, /Send not confirmed/);
  assert.ok(f.node('receipt').find('Check delivery')); assert.ok(f.node('receipt').find('Copy original message')); assert.ok(f.node('receipt').find('Restore to draft'));
  await f.composer.send(); assert.equal(f.calls.length, 0);
});
test('composer placement keeps delivery gating independent of app-owned connection controls', () => {
  const f = fixture('agent'); f.connect(); f.composer.placement(true); f.composer.availability(true, false, false);
  f.composer.setText('safe draft'); assert.equal(f.node('acquire'), undefined); assert.equal(f.node('send').disabled, true);
  f.composer.availability(false, false, false); f.composer.availability(true, false, false); assert.equal(f.node('send').hidden, false);
  f.composer.placement(false); assert.equal(f.node('send').disabled, true); assert.equal(f.composer.editor.value, 'safe draft');
});

function targetIndex(saved: TargetState, changes: Partial<TargetIndex> = {}): TargetIndex {
  return {targetKey: saved.targetKey, target: saved.target, draftRevision: saved.draft.revision, hasDraft: !!saved.draft.text, unconfirmedOperationIds: saved.unconfirmed.map(item => item.operationId), ...changes};
}
test('Resume reconciles indexed revisions and unresolved IDs against an empty retained buffer', () => {
  const f = fixture('agent'); const a = state('a', draft(4, '', 'followUp'), true); f.composer.attach('w', a); f.composer.attach('w');
  assert.equal(f.composer.retained('w', a.target, targetIndex(a)), false);
  assert.equal(f.composer.retained('w', a.target, targetIndex(a, {draftRevision: 5, hasDraft: true})), true);
  assert.equal(f.composer.retained('w', a.target, targetIndex(a, {draftRevision: 3, hasDraft: true})), false);
  assert.equal(f.composer.retained('w', a.target, targetIndex(a, {unconfirmedOperationIds: ['remote-input']})), true);
  assert.equal(f.composer.retained('w', a.target, targetIndex(a, {draftRevision: 3, unconfirmedOperationIds: ['remote-input']})), true);
  assert.equal(f.composer.retained('w', a.target, targetIndex(a, {target: {kind: 'agent', identity: 'other'}, hasDraft: true, draftRevision: 9})), false);
});
test('an old index cannot resurrect a draft or input copy cleared by this tab', async () => {
  const f = fixture('agent'); const a = state('a', draft(4, 'sent', 'followUp'), true);
  a.unconfirmed.push({operationId: 'retained', target: a.target, text: 'sent', mode: 'followUp', submittedDraftRevision: 4, createdAt: '', reason: 'unknown'});
  f.connect(a); const oldIndex = targetIndex(a);
  f.composer.updateOperation({id: 'retained', kind: 'agent.input', target: a.target, state: 'accepted', createdAt: '', updatedAt: ''});
  await turn(); f.ok(f.pick('GET', '/a'), state('a', draft(5, '', 'followUp'), true)); await turn(); f.composer.attach('w');
  assert.equal(f.composer.retained('w', a.target, oldIndex), false);
  assert.equal(f.composer.retained('w', a.target, {...oldIndex, draftRevision: 6}), true);
});
test('offline Resume attaches the exact buffer before preparation and keeps it after refusal', async () => {
  const f = fixture('agent'); const a = state('a', draft(2, 'saved draft', 'followUp'), true);
  f.composer.attach('w', a); f.composer.setText('unsaved exact draft'); f.composer.attach('w');
  const response = Promise.withResolvers<never>();
  const message: MessageTarget = new MessageTarget({workspace: () => ({id: 'w', revision: 0}), prepare: () => response.promise, paint: () => {
    const captured = message.current; assert.ok(captured);
    f.composer.availability(false, message.ready, false);
    f.composer.attachRetained(captured.workspaceId, {kind: 'agent', identity: captured.identity});
  }});
  const pending = message.open('a');
  assert.equal(f.composer.editor.value, 'unsaved exact draft'); assert.equal(f.node('composer').hidden, false); assert.equal(f.node('editor').disabled, false); assert.equal(f.node('send').disabled, true);
  f.composer.setText('still editable offline'); response.reject(new Error('offline')); await pending;
  assert.equal(f.composer.editor.value, 'still editable offline'); assert.equal(f.node('composer').hidden, false); assert.equal(f.node('send').disabled, true); assert.equal(f.calls.length, 0);
  assert.equal(f.composer.attachRetained('other-workspace', a.target), false); assert.equal(f.composer.target, undefined);
  assert.equal(f.composer.attachRetained('w', {kind: 'agent', identity: 'other'}), false);
  assert.equal(f.composer.attachRetained('w', a.target), true); assert.equal(f.composer.editor.value, 'still editable offline');
});


test('ready agent Send requires a nonempty draft and readiness never submits input', () => {
  const f = fixture('agent');
  f.connect(state('a', draft(0, '', 'followUp'), true));
  assert.equal(f.node('send').hidden, false); assert.equal(f.node('send').disabled, true);
  f.composer.attach('w', state('a', draft(1, '  ', 'followUp'), true));
  assert.equal(f.node('send').disabled, true);
  f.composer.attach('w', state('a', draft(2, 'Fixture text', 'followUp'), true));
  assert.equal(f.node('send').hidden, false); assert.equal(f.node('send').disabled, false);
  assert.equal(f.calls.length, 0); assert.equal(f.reservations(), 1);
  f.composer.availability(true, false, false);
  assert.equal(f.node('send').hidden, false); assert.equal(f.node('send').disabled, true);
  assert.equal(f.composer.editor.value, 'Fixture text'); assert.equal(f.calls.length, 0);
});

 test('accessible recipient labels and Send reasons do not change the editor or delivery', () => {
  const f = fixture('agent'); const a = f.connect(state('a', draft(2, 'retained draft', 'followUp'), true));
  f.composer.recipient('Message Review companion'); f.node('editor').setSelectionRange(4, 8); f.node('editor').focus();
  assert.equal(f.node('recipient').textContent, 'Message Review companion');
  assert.equal(f.composer.editor.placeholder, 'Write a message…');
  assert.equal(f.node('editor').attrs.get('aria-label'), 'Message Review companion');
  f.composer.availability(false, true, false); f.composer.recipient('Message Review companion');
  assert.equal(f.composer.editor.value, 'retained draft'); assert.equal(f.node('editor').selectionStart, 4);
  assert.equal(f.node('editor').selectionEnd, 8); assert.equal(f.node('editor').focused, true); assert.equal(f.node('send').disabled, true);
  f.composer.availability(true, true, false); assert.equal(f.calls.length, 0);
  f.composer.availability(true, false, false); f.composer.recipient('Draft for Review companion');
  assert.equal(f.node('recipient').textContent, 'Draft for Review companion'); assert.equal(f.node('send').hidden, false);
  assert.equal(f.node('send').attrs.get('aria-description'), 'Connect this agent to send.'); assert.deepEqual(f.composer.target, a.target);
  f.composer.recipient('Draft for Review companion', 'Messages are unavailable for this agent.');
  assert.equal(f.node('send').attrs.get('aria-description'), 'Messages are unavailable for this agent.'); assert.equal(f.node('send').hidden, false);
  f.composer.recipient('Draft for Review companion', ''); assert.equal(f.node('send').attrs.get('aria-description'), '');
  assert.equal(f.composer.editor.value, 'retained draft'); assert.equal(f.node('editor').selectionStart, 4); assert.equal(f.node('editor').selectionEnd, 8);
  assert.equal(f.node('editor').focused, true); assert.equal(f.calls.length, 0);
});
test('busy delivery choices describe timing once and stay separate from activity', () => {
  const f = fixture(); f.connect(); f.composer.recipient('Message Primary'); f.composer.availability(true, true, true);
  const delivery = f.node('modes').children[0]; assert.equal(delivery?.value, 'steer');
  assert.ok(delivery); delivery.value = 'followUp'; delivery.fire('change'); assert.equal(delivery.value, 'followUp');
  assert.equal(f.node('caption').textContent, ''); assert.equal(f.node('send').disabled, true);
  f.composer.availability(true, true, false); assert.equal(f.node('modes').hidden, true);
});
test('unconfirmed delivery puts captured identifiers and text in closed disclosures', () => {
  const f = fixture(); const a = state('captured', draft(2, 'message'));
  a.unconfirmed.push({operationId: 'unconfirmed-id', target: a.target, text: 'message', mode: 'prompt', submittedDraftRevision: 2, createdAt: '', reason: 'unknown'});
  f.connect(a); const row = f.node('receipt').children.find(node => node.find('Check delivery')); assert.ok(row);
  assert.match(row.children[0]?.textContent ?? '', /Send not confirmed. Check before you send again./);
  assert.equal(row.children[1]?.open, false); assert.equal(row.children[2]?.open, false);
  assert.match(row.children[1]?.textContent ?? '', /unconfirmed-id/); assert.match(row.children[2]?.textContent ?? '', /Review message/);
});

test('two scoped instances keep separate drafts, caret, recipient controls and save routes without instance lookups', async () => {
  const f = fixture('agent'); f.connect(state('a', draft(0, 'draft A', 'followUp'), true));
  const other = f.create('second'); other.composer.attach('w', state('b', draft(0, 'draft B', 'followUp'), true)); other.composer.availability(true, false, false);
  f.composer.recipient('Message Alpha'); other.composer.recipient('Draft for Beta', 'Beta does not accept messages.');
  f.node('editor').setSelectionRange(1, 4, 'backward'); f.node('editor').focus(); other.node('editor').setSelectionRange(2, 5);
  other.composer.recipient('Draft for Beta', 'Beta does not accept messages.');
  assert.equal(document.activeElement, f.composer.editor); assert.equal(f.node('recipient').textContent, 'Message Alpha'); assert.equal(other.node('recipient').textContent, 'Draft for Beta');
  assert.equal(f.node('send').disabled, false); assert.equal(other.node('send').disabled, true); assert.equal(other.node('send').attrs.get('aria-description'), 'Beta does not accept messages.');
  assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd, f.node('editor').selectionDirection], [1, 4, 'backward']);
  assert.deepEqual([other.node('editor').selectionStart, other.node('editor').selectionEnd], [2, 5]);
  f.composer.setText('new A'); other.composer.setText('new B'); assert.equal(f.calls.length, 2);
  const a = f.calls.find(call => call.path.endsWith('/a/draft')); const b = f.calls.find(call => call.path.endsWith('/b/draft')); assert.ok(a); assert.ok(b);
  assert.equal(a.body.text, 'new A'); assert.equal(b.body.text, 'new B'); assert.equal(a.body.expectedRevision, 0); assert.equal(b.body.expectedRevision, 0);
  f.ok(b, draft(1, 'new B', 'followUp')); await turn(); assert.equal(other.composer.unsaved, false); assert.equal(f.composer.unsaved, true);
  f.ok(a, draft(1, 'new A', 'followUp')); await turn(); assert.equal(f.composer.unsaved, false);
  assert.equal(f.composer.editor.value, 'new A'); assert.equal(other.composer.editor.value, 'new B'); assert.ok(f.lookups.every(id => id === 'announcements'));
});
test('scoped element factories create distinct editors and exact label/resize/command links with detached footer facts', () => {
  const f = fixture(); const first = createComposerElements('target:a/1'); const second = createComposerElements('target:b/1');
  const walk = (node: NodeFake): NodeFake[] => [node, ...node.children.flatMap(walk)];
  const ids = [first, second].flatMap(elements => [...walk(elements.root as unknown as NodeFake), elements.save as unknown as NodeFake, elements.receiptDetails as unknown as NodeFake]).map(node => node.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length); assert.notEqual(first.editor, second.editor); assert.equal((first.recipient as HTMLLabelElement).htmlFor, first.editor.id);
  assert.equal(first.root.querySelector('.resizer')?.getAttribute('aria-controls'), first.editor.id); assert.equal(first.root.querySelector('.resizer')?.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(first.root.querySelector('.stop')?.getAttribute('aria-label'), 'Stop');
  assert.equal(first.send.getAttribute('aria-label'), 'Send'); assert.equal(first.send.querySelector('svg')?.getAttribute('viewBox'), '0 0 16 16');
  assert.equal(first.modes.querySelector('select')?.getAttribute('aria-label'), 'Delivery while working'); assert.equal(first.send.type, 'submit'); assert.equal(first.send.disabled, true);
  assert.equal(first.root.contains(first.editor), true); assert.equal(first.root.contains(first.save), false); assert.equal(first.root.contains(first.receiptDetails), false);
  assert.equal(first.save.className, 'draft-state'); assert.equal(first.receiptDetails.className, 'receipt-details'); assert.equal(first.commandMenu?.hidden, true); assert.deepEqual(f.lookups, []);
});
test('command capability requires both the supplied inventory and the scoped container, not target kind', async () => {
  const inventory = () => ({state:'ready' as const, items:[{name:'fixture',description:'command',source:'extension'}]});
  const supplied = fixture('agent', inventory, true); supplied.connect(state('a', draft(1, '/fixture', 'followUp'), true)); supplied.node('editor').setSelectionRange(8,8); supplied.node('editor').focus();
  assert.equal(supplied.node('command-menu').hidden, false); assert.equal(supplied.node('editor').attrs.get('aria-controls'), supplied.node('command-menu').id);
  supplied.node('editor').fire('keydown', {key:'Enter'}); await turn(); assert.equal(supplied.composer.editor.value, '/fixture '); assert.equal(supplied.calls.some(call => call.path.endsWith('/inputs')), false);
  let reads = 0; const missingContainer = fixture('primary', () => {reads++; return inventory();}, false); missingContainer.connect(); missingContainer.composer.commandsChanged();
  assert.equal(reads,0); assert.equal(missingContainer.node('editor').attrs.has('aria-autocomplete'), false);
  const missingInventory = fixture('primary'); missingInventory.connect(); assert.equal(missingInventory.node('editor').attrs.has('aria-controls'), false);
});
test('two editor height limits follow their own form containers without editor or global selector lookups', () => {
  const computed = Object.getOwnPropertyDescriptor(globalThis,'getComputedStyle'); const media = Object.getOwnPropertyDescriptor(globalThis,'matchMedia');
  Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,value:()=>({lineHeight:'22.5px',paddingTop:'8px',paddingBottom:'8px',borderTopWidth:'1px',borderBottomWidth:'1px'})});
  Object.defineProperty(globalThis,'matchMedia',{configurable:true,value:()=>({matches:false})});
  try {
    const f = fixture(); f.composer.attach('w',state('a',draft(1,'A'))); const other = f.create('other'); other.composer.attach('w',state('b',draft(1,'B')));
    f.node('editor').isConnected = true; other.node('editor').isConnected = true; f.node('editor').conversationHeight = 400; other.node('editor').conversationHeight = 900;
    f.node('editor').closest = () => {throw new Error('Editor selector lookup is forbidden');}; other.node('editor').closest = f.node('editor').closest;
    f.composer.setManualHeight(600); other.composer.setManualHeight(600); for (const frame of f.frames.splice(0)) frame();
    assert.equal(f.node('editor').style.height,'240px'); assert.equal(other.node('editor').style.height,'540px'); assert.equal(document.activeElement,undefined); assert.deepEqual(f.lookups,[]);
  } finally {
    if (computed) Object.defineProperty(globalThis,'getComputedStyle',computed); else Reflect.deleteProperty(globalThis,'getComputedStyle');
    if (media) Object.defineProperty(globalThis,'matchMedia',media); else Reflect.deleteProperty(globalThis,'matchMedia');
  }
});
test('Composer destroy removes form, editor, mode and command listeners once without editor replacement', () => {
  const f = fixture('primary',()=>({state:'ready',items:[{name:'fixture',description:'',source:'app'}]})); f.connect(state('a',draft(1,'/fixture'))); f.node('editor').setSelectionRange(8,8); f.node('editor').focus();
  const editor = f.composer.editor; assert.equal(f.node('command-menu').hidden,false); f.node('editor').setSelectionRange(2,4); f.composer.destroy(); f.composer.destroy();
  for (const node of [f.node('editor'),f.node('composer'),f.node('command-menu'),...f.node('modes').children]) assert.equal([...node.listeners.values()].flat().length,0);
  assert.equal(f.node('command-menu').hidden,true); assert.equal(f.node('command-menu').children.length,0); assert.equal(f.composer.editor,editor); assert.equal(editor.value,'/fixture');
  assert.deepEqual([editor.selectionStart,editor.selectionEnd],[2,4]); assert.equal(f.node('editor').fire('keydown',{key:'Enter'}).defaultPrevented,false); f.node('composer').fire('submit');
  assert.equal(f.calls.length,0); assert.equal(f.node('editor').attrs.has('aria-autocomplete'),false);
});
test('destroy keeps pending draft and input settlement owned by their captured targets without a new reservation', async () => {
  const saved = fixture('agent'); const target = saved.connect(); saved.composer.setText('retained draft'); saved.composer.destroy();
  assert.equal(saved.composer.unsaved,true); saved.saved('retained draft'); await turn(); assert.equal(saved.composer.unsaved,false); assert.equal(saved.composer.retained('w',target.target),true);
  const input = fixture('agent'); const a = input.connect(state('a',draft(2,'captured','followUp'),true)); const sending = input.composer.send(); await turn();
  input.composer.destroy(); input.admit(a,'uncertain'); await sending;
  assert.equal(input.composer.retained('w',a.target),true); assert.equal(input.composer.editor.value,'captured'); assert.equal(input.reservations(),1); assert.equal(input.calls.length,0); assert.equal(input.node('receipt').children.length,0);
});
