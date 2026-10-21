import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { beforeEach, test } from 'node:test';
import type { CommandInventory } from './command-menu-state.ts';
beforeEach(context => { context.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 0}); Reflect.deleteProperty(globalThis, 'sessionStorage'); });
import type { DraftImage, DraftView, OperationView, Target, TargetIndex, TargetState } from '../shared/api.ts';

import { Composer, createComposerElements, type ComposerElements } from './composer.ts';
import { MessageTarget } from './selection-state.ts';
class NodeFake {
  id = ''; tag = ''; className = ''; parentElement?: NodeFake; type = ''; selectionStart = 0; selectionEnd = 0; offsetTop = 0; scrollTop = 0; scrollLeft = 0; clientHeight = 80;
  get ownerDocument(): Document { return document; }
  classList = {add: (...names: string[]) => {this.className = `${this.className} ${names.join(' ')}`.trim();}, contains: (name: string) => this.className.split(' ').includes(name), toggle: (name: string, force?: boolean) => {const has = this.className.split(' ').includes(name), want = force ?? !has; if (want && !has) this.className = `${this.className} ${name}`.trim(); if (!want && has) this.className = this.className.split(' ').filter(item => item !== name).join(' '); return want;}};
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
  querySelectorAll(selector?: string): NodeFake[] { return selector === '[role="option"]' ? this.children.filter(node => node.attrs.get('role') === 'option') : this.children; }
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
type Call = {path: string; method: string; body: Record<string, unknown>; bytes?: Blob; id?: string; resolve: (value: unknown) => void; reject: (error: Error) => void};
const draft = (revision = 0, text = '', mode = 'prompt'): DraftView => ({revision, text, mode, images: [], persisted: true});
function state(key = 'a', saved = draft(), agent = false): TargetState {
  return {targetKey: key, target: agent ? {kind: 'agent', identity: key} : {kind: 'primary', key, epoch: 7}, draft: saved,
    reading: {revision: 0, anchorId: null, offsetPx: 0, followTail: true}, unconfirmed: [], retainedInputs: [], imageAvailability: []};
}
const actionText = (node: NodeFake): string | undefined => node.querySelector('.action-label')?.textContent;
const turn = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function scopedNodes(id: string, withMenu: boolean) {
  const nodes = new Map<string, NodeFake>();
  for (const name of ['editor', 'recipient', 'composer', 'queue', 'send', 'caption', 'save', 'receipt', 'receipt-details', 'command-menu', 'attachments']) {const node = new NodeFake(); node.id = `${id}-${name}`; nodes.set(name, node);}
  const node = (name: string) => nodes.get(name) as NodeFake;
  const delivery = new NodeFake(); delivery.tag = 'select'; node('queue').append(delivery);
  const pane = new NodeFake(); Object.defineProperty(pane, 'clientHeight', {get: () => node('editor').conversationHeight});
  pane.append(node('composer')); node('composer').append(node('editor'), node('recipient'), node('receipt'), node('queue'), node('send'), node('attachments'));
  const elements = {root:node('composer'), editor:node('editor'), recipient:node('recipient'), receipt:node('receipt'), receiptDetails:node('receipt-details'), queue:node('queue'), send:node('send'), save:node('save'), attachments:node('attachments'), commandMenu:withMenu ? node('command-menu') : undefined} as unknown as ComposerElements;
  return {node, elements};
}
function fixture(prefix: 'primary' | 'agent' = 'primary', commands?: () => CommandInventory, withMenu = prefix === 'primary', timing?: (start: number, end: number) => void, enterSends: () => boolean = () => false, imageInput = () => ({allowed: true, reason: ''}), prepareInput: () => boolean = () => true) {
  const scoped = scopedNodes(prefix, withMenu); const announcements = new NodeFake(); const lookups: string[] = [];
  const calls: Call[] = []; const arrivals = new Set<() => void>(); let sequence = 0; const frames: (() => void)[] = []; const copied: string[] = [];
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {execCommand: (_command: string, _ui: boolean, value: string) => {
    const editor = document.activeElement as unknown as NodeFake; const at = editor.selectionStart;
    editor.value = editor.value.slice(0, at) + value + editor.value.slice(editor.selectionEnd); editor.setSelectionRange(at + value.length, at + value.length); editor.fire('input'); return true;
  }, getElementById: (id: string) => {lookups.push(id); assert.equal(id, 'announcements', 'Composer never resolves an instance through the global document'); return announcements;}, createElementNS: (_namespace: string, tag: string) => {const node = new NodeFake(); node.tag = tag; return node;}, createElement: (tag: string) => {const node = new NodeFake(); node.tag = tag; return node;}}});
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => { copied.push(text); }}}});
  Object.defineProperty(globalThis, 'requestAnimationFrame', {configurable: true, value: (callback: () => void) => frames.push(callback)});
  Object.defineProperty(globalThis, 'fetch', {configurable: true, value: (path: string, init: RequestInit) => {
    if (path === '/api/operations') { const operationId = `op-${++sequence}`; return Promise.resolve({json: async () => ({ok: true, data: {operationId}})}); }
    return new Promise((resolve, reject) => {
      const bytes = init.body instanceof Blob ? init.body : undefined;
      calls.push({path, method: init.method ?? 'GET', body: !bytes && init.body ? JSON.parse(String(init.body)) : {}, bytes,
        id: (init.headers as Record<string, string>)['Idempotency-Key'], resolve: value => resolve({json: async () => value}), reject});
      for (const notify of arrivals) notify();
    });
  }});
  const submitted: OperationView[] = []; let unknown = (_text: string, _send: () => void) => false;
  const retained: {workspace: string; target: Target; value: boolean}[] = [];
  const create = (id: string, inventory?: () => CommandInventory, menu = true) => {
    const scope = scopedNodes(id, menu); const composer = new Composer(scope.elements, {submitted:result => submitted.push(result), unknownCommand:(text, send) => unknown(text, send), commands:inventory, retained:(workspace, target, value) => retained.push({workspace,target,value})});
    return {...scope, composer};
  };
  const composer = new Composer(scoped.elements, {timing, enterSends, imageInput, prepareInput, submitted: result => submitted.push(result), unknownCommand: (text, send) => unknown(text, send), commands, retained: (workspace, target, value) => retained.push({workspace, target, value})});
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
  const waitCall = (method: string, suffix: string) => new Promise<Call>(resolve => {
    const notify = () => {const call = calls.find(item => item.method === method && item.path.endsWith(suffix)); if (call) {arrivals.delete(notify); resolve(call);}};
    arrivals.add(notify); notify();
  });
  return {composer, node, calls, retained, pick, ok, fail, saved, admit, click, connect, submitted, frames, copied, openReceipt, create, lookups, waitCall, elements:scoped.elements, reservations: () => sequence,
    unknown: (handler: typeof unknown) => { unknown = handler; }};
}

const image = (name = 'one.png', digit = 'a'): DraftImage => ({name, digest: digit.repeat(64), mimeType: 'image/png', bytes: 67, width: 1, height: 1});
test('file admission reports its existing buffer and stages saved text without insertion or delivery',async()=> {
  const f=fixture('agent',undefined,false),file=new File(['\ufeffSaved\r\nbytes\n'],'saved.md',{type:'text/plain'});
  assert.equal(f.composer.addFiles([file]),false);f.connect(state('text-owner',draft(0,'Keep this draft','followUp'),true));f.composer.editor.setSelectionRange(2,5,'backward');
  assert.equal(f.composer.addFiles([file]),true);await turn();const captured=f.composer.captureReload()[0];assert.ok(captured);assert.equal(captured.attachments?.items[0]?.state,'text');assert.deepEqual(new Uint8Array(await captured.attachments?.items[0]?.file?.arrayBuffer()),new TextEncoder().encode('\ufeffSaved\r\nbytes\n'));assert.equal(f.composer.editor.value,'Keep this draft');assert.deepEqual([f.composer.editor.selectionStart,f.composer.editor.selectionEnd,f.composer.editor.selectionDirection],[2,5,'backward']);assert.equal(f.calls.some(call=>call.path.endsWith('/inputs')||call.path.endsWith('/images')),false);assert.equal(f.composer.addFiles([file,file,file,file]),false);f.composer.destroy();assert.equal(f.composer.addFiles([file]),false);
});
test('reload preserves unsaved draft, caret and failed File bytes without retry or input',async()=>{
  const f=fixture('agent',undefined,false);const saved=f.connect(state('preserved',draft(0,'','followUp'),true));
  f.composer.setText('Exact unsaved draft');f.composer.editor.setSelectionRange(2,7,'backward');
  f.composer.addFiles([new File(['invalid image bytes'],'invalid.png',{type:'image/png',lastModified:123})]);await turn();
  assert.equal(f.composer.reloadHold,undefined);
  const snapshot=f.composer.captureReload()[0];assert.ok(snapshot);assert.equal(snapshot.attachments?.items[0]?.state,'failed');
  const g=fixture('agent',undefined,false);g.connect(saved);g.composer.restoreReload(structuredClone(snapshot),saved);
  const restored=g.composer.captureReload()[0];assert.ok(restored);
  assert.equal(g.composer.editor.value,'Exact unsaved draft');
  assert.deepEqual([g.composer.editor.selectionStart,g.composer.editor.selectionEnd,g.composer.editor.selectionDirection],[2,7,'backward']);
  assert.equal(await restored.attachments?.items[0]?.file?.text(),'invalid image bytes');
  assert.equal(restored.attachments?.items[0]?.error,snapshot.attachments?.items[0]?.error);
  assert.equal(g.calls.some(call=>call.path.endsWith('/inputs')||call.path.endsWith('/images')),false);
  f.composer.destroy();g.composer.destroy();
});
test('reload retains local text beside a newer server draft without overwriting either',()=>{
  const f=fixture('agent',undefined,false);f.connect(state('preserved',draft(0,'','followUp'),true));f.composer.setText('Local draft');
  const snapshot=f.composer.captureReload()[0];assert.ok(snapshot);
  const g=fixture('agent',undefined,false),saved=state('preserved',draft(1,'Newer remote draft','followUp'),true);g.connect(saved);g.composer.restoreReload(snapshot,saved);
  assert.equal(g.composer.editor.value,'Local draft');assert.equal(g.composer.state?.draft.text,'Newer remote draft');
  assert.equal(g.calls.some(call=>call.method==='PUT'||call.path.endsWith('/inputs')),false);
  f.composer.destroy();g.composer.destroy();
});
test('native Send does not await draft save or observation and a late save preserves later edits', async () => {
  for (const [newer,late] of [[false,'ack'],[true,'ack'],[false,'fenced'],[true,'fenced']] as const) {
  const f=fixture('agent',undefined,false);const saved=f.connect(state('native-send',draft(0,'','followUp'),true));
  f.composer.setText('Captured native message');await turn();const firstSave=f.pick('PUT','/draft');
  f.composer.availability(false,true,false,true);assert.equal(f.node('send').disabled,false);
  const sending=f.composer.send();const request=await f.waitCall('POST','/inputs');
  assert.equal(request.body.message,'Captured native message');assert.equal(request.body.draftRevision,0);
  if(newer) f.composer.setText('Newer local draft');f.admit(saved);await turn();
  f.ok(f.pick('GET','/native-send'),{...saved,draft:draft(late==='ack'?2:1,'','followUp')});await sending;
  assert.equal(f.composer.editor.value,newer?'Newer local draft':'');
  if(late==='ack') f.ok(firstSave,draft(1,'Captured native message','followUp'));
  else {f.calls.splice(f.calls.indexOf(firstSave),1);firstSave.resolve({ok:false,error:{code:'stale_revision',message:'The admitted input advanced this draft',retry:'manual',details:{value:draft(1,'','followUp'),truncated:false}}});}
  await turn();
  assert.equal(f.composer.editor.value,newer?'Newer local draft':'');assert.equal(f.calls.some(call=>call.method==='POST'&&call.path.endsWith('/inputs')),false);
  f.composer.destroy();
  }
});
test('passive attachment and availability never reserve input while explicit activation preserves the complete draft', async () => {
  for (const kind of ['primary', 'agent'] as const) {
    let active = false;
    const f = fixture(kind, undefined, false, undefined, undefined, undefined, () => active);
    const saved = state('passive', {...draft(2, 'Exact retained draft', kind === 'agent' ? 'followUp' : 'prompt'), images: [image(), image('two.png', 'b')]}, kind === 'agent');
    f.connect(saved); await turn(); assert.equal(f.reservations(), 0);
    const editor = f.composer.editor, parent = editor.parentElement;
    f.node('editor').setSelectionRange(2, 7, 'backward'); f.composer.setManualHeight(140);
    for (let i = 0; i < 3; i++) {
      f.composer.attachRetained('w', saved.target); f.composer.availability(false, false, false);
      f.composer.availability(true, true, false); f.composer.attach('w', saved);
    }
    await turn(); assert.equal(f.reservations(), 0); assert.equal(f.calls.length, 0);
    assert.equal(f.composer.editor, editor); assert.equal(editor.parentElement, parent);
    assert.equal(editor.value, saved.draft.text); assert.deepEqual(f.composer.state?.draft.images, saved.draft.images);
    assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']);
    active = true; f.composer.availability(true, true, false); await turn(); assert.equal(f.reservations(), 1);
    f.composer.availability(true, true, false); await turn(); assert.equal(f.reservations(), 1);
    assert.equal(editor.value, saved.draft.text); assert.deepEqual(f.composer.state?.draft.images, saved.draft.images);
    f.composer.destroy();
  }
});
test('Up in an empty draft browses earlier messages and Escape or Down past the newest restores the draft', async () => {
  const f = fixture(); const scope = scopedNodes('recall', true);
  let items: string[] = ['first', 'second\nline two'];
  const composer = new Composer(scope.elements, {submitted() {}, unknownCommand: () => false, recallItems: () => items});
  const editor = scope.node('editor'); composer.attach('w', state('r', draft(1, ''))); composer.availability(true, true, false);
  const press = (key: string) => editor.fire('keydown', {key});
  editor.focus(); assert.equal(press('ArrowUp').defaultPrevented, true); assert.equal(editor.value, 'second\nline two');
  assert.equal(press('ArrowUp').defaultPrevented, false, 'the caret is on the last line, so the arrow stays native'); assert.equal(editor.value, 'second\nline two');
  editor.setSelectionRange(0, 0); assert.equal(press('ArrowUp').defaultPrevented, true); assert.equal(editor.value, 'first');
  assert.equal(press('ArrowDown').defaultPrevented, true); assert.equal(editor.value, 'second\nline two');
  assert.equal(press('ArrowDown').defaultPrevented, true); assert.equal(editor.value, '', 'past the newest message the draft is restored');
  assert.equal(composer.state?.draft.text, '');
  press('ArrowUp'); assert.equal(editor.value, 'second\nline two'); assert.equal(press('Escape').defaultPrevented, true); assert.equal(editor.value, '');
  press('ArrowUp'); editor.value = 'second\nline two edited'; editor.fire('input');
  editor.setSelectionRange(0, 0); assert.equal(press('ArrowUp').defaultPrevented, false, 'an edit ends browsing and keeps the text'); assert.equal(editor.value, 'second\nline two edited');
  assert.equal(press('Escape').defaultPrevented, false);
  composer.setText(''); items = []; assert.equal(press('ArrowUp').defaultPrevented, false, 'nothing to recall leaves the key native');
  items = ['again']; composer.setText('draft'); editor.setSelectionRange(0, 0); assert.equal(press('ArrowUp').defaultPrevented, false, 'only an empty draft starts browsing');
  composer.destroy(); void f;
});
test('Restore draft does what Escape does and the recall line names no key', () => {
  const f = fixture(); const scope = scopedNodes('restore', true);
  const hint = new NodeFake(), visible = new NodeFake(), spoken = new NodeFake(), line = new NodeFake(), restore = new NodeFake(), meta = new NodeFake();
  visible.className = 'composer-recall-visible'; spoken.className = 'composer-recall-spoken'; hint.append(visible, spoken); line.hidden = true; line.append(hint, restore);
  const elements = {...scope.elements, recallHint: hint, recallLine: line, recallRestore: restore, meta} as unknown as ComposerElements;
  const composer = new Composer(elements, {submitted() {}, unknownCommand: () => false, recallItems: () => ['first', 'second']});
  const editor = scope.node('editor'); composer.attach('w', state('r', draft(1, ''))); composer.availability(true, true, false);
  editor.focus(); editor.fire('keydown', {key: 'ArrowUp'});
  assert.equal(editor.value, 'second'); assert.equal(line.hidden, false); assert.equal(meta.dataset.recall, 'true');
  assert.equal(visible.textContent, 'Earlier message 1 of 2'); assert.equal(spoken.textContent, 'Earlier message 1 of 2 from the loaded conversation.');
  assert.doesNotMatch(`${visible.textContent} ${spoken.textContent}`, /Esc/);
  const down = restore.fire('mousedown'); assert.equal(down.defaultPrevented, true, 'the editor keeps focus while the button is pressed');
  restore.fire('click');
  assert.equal(editor.value, ''); assert.equal(composer.state?.draft.text, ''); assert.equal(line.hidden, true); assert.equal(meta.dataset.recall, undefined); assert.equal(editor.focused, true);
  restore.fire('click'); assert.equal(editor.value, '', 'a click with no browsing changes nothing');
  composer.destroy(); void f;
});
test('a typed @ file is staged, only its token leaves the draft, and a changed draft stages nothing', async t => {
  const f = fixture(); const scope = scopedNodes('mention', true); const menu = new NodeFake(); menu.id = 'mention-files';
  const elements = {...scope.elements, fileMenu: menu} as unknown as ComposerElements; let staged: File[] = []; let release: (() => boolean) | undefined;
  const composer = new Composer(elements, {submitted() {}, unknownCommand: () => false,
    fileSearch: (query) => Promise.resolve({rootId: 'r', query, scope: '', rows: [{name: 'a.txt', path: 'src/a.txt', kind: 'file'}, {name: 'lib', path: 'lib', kind: 'directory'}], more: false, coverage: {complete: true, visited: 2, skipped: 0}}),
    fileStage: (_path, _signal, _current, stage) => new Promise<boolean>(resolve => { release = () => { const ok = stage([new File(['body'], 'a.txt')]); resolve(ok); return ok; }; })});
  const editor = scope.node('editor'); composer.attach('w', state('m', draft(1, 'see @a now'))); composer.availability(true, true, false);
  const open = async () => { editor.focus(); editor.setSelectionRange(6, 6); editor.fire('select'); t.mock.timers.tick(100); await Promise.resolve(); await Promise.resolve(); };
  await open(); assert.equal(menu.hidden, false);
  const key = (name: string) => editor.fire('keydown', {key: name});
  assert.equal(key('Enter').defaultPrevented, true); assert.ok(release); const before = composer.state?.draft.text;
  assert.equal(release(), true); staged = []; assert.equal(editor.value, 'see  now'); assert.notEqual(before, editor.value);
  assert.equal(menu.hidden, true, 'the list closes once the token is gone');
  // A draft edited while the file was being read stages nothing and keeps the edit.
  composer.setText('see @a now'); await open(); key('Enter'); assert.ok(release); editor.value = 'see @a now!'; editor.fire('input');
  assert.equal(release(), false); assert.equal(editor.value, 'see @a now!'); void staged; composer.destroy(); void f;
});
test('the Send, Steer and Run tooltips name the action and never a key', () => {
  const keyless = /⌘|Ctrl|Enter/;
  for (const enterSends of [true, false]) {
    const f = fixture('primary', undefined, true, undefined, () => enterSends); f.connect(); assert.equal(f.node('send').title, 'Send');
    f.composer.availability(true, true, true); assert.equal(f.node('send').title, 'Steer: send now; the agent reads it at its next step'); assert.doesNotMatch(f.node('send').title, keyless);
    f.composer.destroy();
  }
});
test('a recipient that cannot receive input reserves nothing and prepares once it can', async () => {
  const f = fixture('agent'); const saved = state('suppressed', draft(1, 'Draft for a stored agent', 'followUp'), true);
  f.composer.setState({line: 'Not running. Start it to send a message.', action: {label: 'Start', run: () => {}}});
  f.connect(saved); await turn(); f.composer.availability(true, true, false); await turn();
  assert.equal(f.reservations(), 0);
  f.composer.setState(undefined); await turn(); assert.equal(f.reservations(), 1);
  f.composer.setState({line: 'This agent cannot run here.', blocksSend: true}); f.composer.availability(true, true, false); await turn(); assert.equal(f.reservations(), 1);
  f.composer.destroy();
});
test('explicit send reserves a passive draft and passive settlement never prepares another input', async () => {
  const f = fixture('agent', undefined, false, undefined, undefined, undefined, () => false);
  const saved = f.connect(state('passive-send', draft(2, 'Deliberate message', 'followUp'), true));
  await turn(); assert.equal(f.reservations(), 0);
  const sending = f.composer.send(); await f.waitCall('POST', '/inputs'); assert.equal(f.reservations(), 1);
  f.admit(saved); await f.waitCall('GET', '/passive-send'); f.ok(f.pick('GET', '/passive-send'), state('passive-send', draft(3, '', 'followUp'), true));
  await sending; assert.equal(f.reservations(), 1); assert.equal(f.submitted.length, 1); assert.equal(f.composer.editor.value, '');
  f.composer.availability(true, true, false); await turn(); assert.equal(f.reservations(), 1); f.composer.destroy();
});
test('captured image send retains its exact tuple after a newer text-only edit', async () => {
  let allowed = true; const f = fixture('primary', undefined, true, undefined, () => false, () => ({allowed, reason: 'No image input'}));
  const a=f.connect(state('a', {...draft(4, 'captured'), images: [image()]})); const sending = f.composer.send();
  f.node('attachments').find('Remove one.png')?.fire('click'); allowed = false;
  const request=await f.waitCall('POST','/inputs');assert.deepEqual(request.body.images,[image()]);assert.equal(request.body.message,'captured');f.admit(a,'rejected');await sending;
  assert.deepEqual(f.pick('PUT', '/draft').body.images, []); f.saved('captured', 5); await turn();assert.deepEqual(f.composer.state?.draft.images,[]);assert.equal(f.calls.some(call=>call.path.endsWith('/inputs')),false);f.composer.destroy();
});
test('exact recovery refuses changed ordered image metadata instead of restoring another tuple', async () => {
  const f = fixture(), a = state('a', draft(4)), images = [image(), image('two.png', 'b')];
  const original = {admission: 'unconfirmed' as const, operationId: 'copy', target: a.target, text: 'short', textTruncated: true, mode: 'prompt', images, submittedDraftRevision: 2, createdAt: '', reason: 'unknown'};
  a.unconfirmed.push(original); f.connect(a); f.click('Restore to draft'); await turn();
  f.ok(f.pick('GET', '/copy'), {...original, text: 'full text', textTruncated: false, images: [...images].reverse()}); await turn();
  assert.equal(f.calls.length, 0); assert.deepEqual(f.composer.state?.draft.images, []);
});
test('missing image lease reacquires exact bytes once for Save but never retries Send', {timeout: 5000}, async t => {
  const bitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', {configurable: true, value: async () => ({width: 1, height: 1, close() {}})});
  t.after(() => {if (bitmap) Object.defineProperty(globalThis, 'createImageBitmap', bitmap); else Reflect.deleteProperty(globalThis, 'createImageBitmap');});
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFioAAAAASUVORK5CYII=', 'base64');
  const file = new File([bytes], 'one.png', {type: 'image/png'}), metadata = {...image(), bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex')};
  const f = fixture(), a = f.connect(state('a', draft(3, 'source'))); t.after(() => f.composer.destroy()); f.composer.addFiles([file]);
  const upload = await f.waitCall('POST', '/images?name=one.png&epoch=7'); assert.equal(upload.bytes, file);
  f.ok(upload, {targetKey: 'a', target: a.target, image: metadata, leaseExpiresAt: 'later'});
  const first = await f.waitCall('PUT', '/draft'); f.calls.splice(f.calls.indexOf(first), 1);
  first.resolve({ok: false, error: {code: 'unknown_image_digest', message: 'Lease expired', retry: 'read', details: {value: {targetKey: 'a', missingIndexes: [0]}, truncated: false}}});
  const repair = await f.waitCall('POST', '/images?name=one.png&epoch=7'); assert.equal(repair.bytes, file);
  f.ok(repair, {targetKey: 'a', target: a.target, image: metadata, leaseExpiresAt: 'later'});
  const second = await f.waitCall('PUT', '/draft'); assert.deepEqual(second.body, first.body); f.ok(second, {...draft(4, 'source'), images: [metadata]}); await turn();
  const sending = f.composer.send(); await f.waitCall('POST', '/inputs'); f.fail(f.pick('POST', '/inputs'), 'unknown_image_digest'); await sending;
  assert.equal(f.calls.length, 0); assert.deepEqual(f.composer.state?.draft.images, [metadata]);
});
test('preview retry refreshes authoritative availability without replacing text or sending', async () => {
  const f = fixture(), a = state('a', {...draft(4, 'source'), images: [image()]}); a.imageAvailability = [{digest: image().digest, state: 'unavailable'}];
  a.imageStorageError = {code: 'image_storage_unavailable', message: 'Storage unavailable', retry: 'read'}; f.connect(a); assert.equal(f.node('send').disabled, false);
  f.node('attachments').find('Retry preview one.png')?.fire('click'); await turn();
  f.ok(f.pick('GET', '/a'), {...a, imageStorageError: undefined, imageAvailability: [{digest: image().digest, state: 'ready'}]}); await turn();
  assert.equal(f.node('send').disabled, false); assert.equal(f.composer.editor.value, 'source'); assert.equal(f.calls.length, 0);
});
test('image-only input uses the saved ordered tuple and retains it on refusal', async () => {
  const f = fixture(), images = [image(), image('two.png', 'b')], a = f.connect(state('a', {...draft(4), images}));
  assert.equal(f.node('send').disabled, false); const sending = f.composer.send(); await turn();
  assert.deepEqual(f.pick('POST', '/inputs').body, {message: '', mode: 'prompt', images, draftRevision: 4, epoch: 7, literal: false});
  f.admit(a, 'rejected'); await sending; assert.deepEqual(f.composer.state?.draft.images, images); assert.match(f.node('attachments').textContent, /one.png/);
});
test('image removal saves the entire remaining tuple independently of send readiness', async () => {
  const f = fixture(), images = [image(), image('two.png', 'b')]; f.connect(state('a', {...draft(3, 'source'), images}));
  f.node('editor').setSelectionRange(1, 4, 'backward'); f.node('editor').fire('select');
  f.node('attachments').find('Remove one.png')?.fire('click');
  assert.deepEqual(f.pick('PUT', '/draft').body, {expectedRevision: 3, text: 'source', mode: 'prompt', images: [images[1]]}); assert.equal(f.node('send').disabled, false);
  f.ok(f.pick('PUT', '/draft'), {...draft(4, 'source'), images: [images[1]]}); await turn();
  assert.equal(f.node('send').disabled, false); assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd, f.node('editor').selectionDirection], [1, 4, 'backward']);
});
test('handled image admission keeps the draft without a cleanup save', async () => {
  const f = fixture(), images = [image()], a = f.connect(state('a', {...draft(5, 'source'), images}));
  const sending = f.composer.send(); await turn(); const call = f.pick('POST', '/inputs');
  f.ok(call, {id: call.id, kind: 'primary.input', target: a.target, state: 'accepted', receipt: {kind: 'rpc', disposition: 'handled'}}); await turn();
  f.ok(f.pick('GET', '/a'), a); await sending;
  assert.equal(f.composer.editor.value, 'source'); assert.deepEqual(f.composer.state?.draft.images, images); assert.match(f.node('receipt').textContent, /images not confirmed/); assert.equal(f.calls.length, 0);
});
test('queue recovery uncertainty is not overridden by different-message consent', async () => {
  const f = fixture(), a = state('a', {...draft(5, 'queue text'), recoverySendGuard: {state: 'unavailable', imageCopies: 1}}); f.connect(a);
  await f.composer.send(); assert.equal(f.calls.length, 0); assert.match(f.node('receipt').textContent, /unavailable/); assert.equal(f.node('receipt').find('Send a different message…'), undefined);
});
test('known queue recovery consent applies to one exact attempt and preserves provenance', async () => {
  const f = fixture(), origin = {clearOperationId: 'clear', recoveryOperationId: 'copy'}, a = state('a', {...draft(5, 'different text'), recoveryOrigin: origin, recoverySendGuard: {state: 'blocked', imageCopies: 1}}); f.connect(a);
  await f.composer.send(); assert.equal(f.calls.length, 0); f.click('Send a different message…'); const confirm = f.node('receipt').find('Confirm different message'); assert.ok(confirm);
  confirm.fire('click'); await turn(); assert.equal(f.pick('POST', '/inputs').body.differentMessage, true); f.admit(a, 'rejected'); await turn();
  confirm.fire('click'); await turn(); assert.equal(f.calls.length, 0);
  f.composer.setText('new text'); assert.equal(f.pick('PUT', '/draft').body.recoverySource, origin.recoveryOperationId); f.saved('new text', 6); await turn();
});
test('a save acknowledgment preserves one different-message consent for the unchanged tuple', async () => {
  const f = fixture(), guard = {state: 'blocked' as const, imageCopies: 1},a=f.connect(state('a', {...draft(5, 'different text'), recoverySendGuard: guard}));
  f.click('Send a different message…'); f.click('Confirm different message');
  f.composer.updateDraft({...draft(6, 'different text'), recoverySendGuard: guard}); await turn();
  const request=f.pick('POST','/inputs');assert.deepEqual(request.body,{epoch:7,message:'different text',mode:'prompt',draftRevision:6,images:[],literal:false,differentMessage:true});assert.equal(f.calls.filter(call=>call.path.endsWith('/inputs')).length,1);f.admit(a,'rejected');await turn();assert.equal(f.composer.editor.value,'different text');
});
test('duplicate-send consent retains the original uncertain operation and cannot be reused', async () => {
  const f = fixture(), a = f.connect(state('a', draft(2, 'original'))), first = f.composer.send(); await turn(); const original = f.admit(a, 'uncertain'); await first;
  f.click('Send again…'); const confirm = f.node('receipt').find('Send again'); assert.ok(confirm); confirm.fire('click'); await turn();
  assert.equal(f.pick('POST', '/inputs').id, 'op-2'); f.admit(a, 'rejected'); await turn(); assert.match(f.node('receipt').textContent, /op-1/);
  confirm.fire('click'); await turn(); assert.equal(f.calls.length, 0); assert.equal(f.composer.updateOperation({...original, state: 'accepted'}), true); await turn();
  f.ok(f.pick('GET', '/a'), state('a', draft(3))); await turn(); assert.equal(f.composer.editor.value, '');
});
test('whole-image restore uses exact-target CAS and never sends', async () => {
  const f = fixture(), images = [image(), image('two.png', 'b')], a = state('a', draft(4));
  a.unconfirmed.push({admission: 'unconfirmed', operationId: 'copy', target: a.target, text: '', mode: 'prompt', images, submittedDraftRevision: 2, createdAt: '', reason: 'unknown'}); f.connect(a);
  f.click('Restore to draft'); await turn(); assert.deepEqual(f.pick('POST', '/restore').body, {expectedDraftRevision: 4});
  f.ok(f.pick('POST', '/restore'), {...draft(5), images}); await turn(); assert.deepEqual(f.composer.state?.draft.images, images); assert.equal(f.calls.length, 0);
});
test('attachment rows retain image identity and expose capability uncertainty through local details', () => {
  let allowed = true;
  const f = fixture('agent', undefined, false, undefined, undefined, () => ({allowed, reason: 'Exact image capability explanation.'}));
  const wide = {...image('wide-landscape.png'), width: 4096, height: 4, bytes: 6144};
  const saved = f.connect(state('a', {...draft(4, 'Exact draft', 'followUp'), images: [wide]}, true));
  const editor = f.node('editor'); editor.focus(); editor.setSelectionRange(2, 7, 'backward');
  let row = f.node('attachments').children[0]; assert.ok(row);
  assert.ok(row.find('wide-landscape.png')); assert.ok(row.find('PNG · 6.0 KiB')); assert.equal(row.find('Acceptance unknown'), undefined);
  const thumbnail = row.querySelector('img') as unknown as HTMLImageElement; assert.equal(thumbnail.width, 48); assert.equal(thumbnail.height, 48);
  const details = row.querySelector('.attachment-details'); assert.ok(details); assert.equal(details.open, false);
  assert.match(details.textContent, /4096 × 4 pixels\. The image is available in this draft\. The model's ability to use images is not confirmed\./);
  assert.equal(details.querySelector('summary')?.textContent.trim(), 'Details'); assert.equal(details.querySelector('summary')?.getAttribute('aria-label'), 'Attachment details for wide-landscape.png');
  details.open = true; assert.equal(f.calls.length, 0); assert.equal(f.submitted.length, 0); assert.doesNotMatch(row.textContent, /This host accepts image input/);
  assert.ok(row.find('Remove wide-landscape.png'));
  allowed = false; f.composer.availability(true, true, false);
  row = f.node('attachments').children[0]; assert.ok(row?.find('Needs attention')); assert.match(row.textContent, /Exact image capability explanation/);
  f.node('attachments').querySelector('img')?.fire('error'); row = f.node('attachments').children[0]; assert.ok(row?.find('Image unavailable')); assert.ok(row.find('Retry preview wide-landscape.png'));
  assert.equal(editor.value, 'Exact draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']);
  assert.deepEqual(f.composer.target, saved.target); assert.deepEqual(f.composer.state?.draft.images, [wide]); assert.equal(f.calls.length, 0); assert.equal(f.submitted.length, 0);
});
test('attachment preparation keeps short states, full errors and explicit text actions outside Details', async () => {
  const f = fixture('agent'); f.connect(); const editor = f.composer.editor;
  f.composer.addFiles([new File(['exact text'], 'notes.txt', {type: 'text/plain'})]);
  assert.ok(f.node('attachments').find('Preparing…')); await new Promise(resolve => setImmediate(resolve));
  const textRow = f.node('attachments').children[0]; assert.ok(textRow?.find('Text not included')); assert.ok(textRow.find('text/plain · 10 B'));
  const include = textRow.find('Include text from notes.txt'); assert.ok(include); assert.equal(include.textContent, 'Include text');
  assert.equal(textRow.querySelector('.attachment-details')?.contains(include), false);
  const invalid = new File(['invalid image'], 'broken.png', {type: 'image/png'}); f.composer.addFiles([invalid]); await new Promise(resolve => setImmediate(resolve));
  const failedRow = f.node('attachments').children[1]; assert.ok(failedRow?.find('Unavailable'));
  const details = failedRow.querySelector('.attachment-details'); assert.ok(details); assert.match(details.textContent, /Only valid PNG and JPEG images are supported/);
  const retry = failedRow.find('Retry broken.png'); assert.ok(retry); assert.equal(retry.textContent, 'Retry'); assert.equal(details.contains(retry), false);
  const saved = f.composer.captureReload()[0]; assert.equal(saved?.attachments?.items[1]?.file, invalid);
  assert.equal(f.composer.editor, editor); assert.equal(editor.value, ''); assert.equal(f.calls.length, 0); assert.equal(f.submitted.length, 0);
});
test('a failed thumbnail retains identity and the complete native input tuple', async () => {
  const f = fixture(),a=f.connect(state('a', {...draft(4, 'source'), images: [image()]})); const thumbnail = f.node('attachments').querySelector('img'); assert.ok(thumbnail);
  thumbnail.fire('error'); assert.equal(f.node('send').disabled, false); assert.match(f.node('attachments').textContent, /Image unavailable/); assert.equal(f.composer.editor.value, 'source'); assert.deepEqual(f.composer.state?.draft.images, [image()]);
  const sending=f.composer.send(),request=await f.waitCall('POST','/inputs');assert.deepEqual(request.body.images,[image()]);assert.equal(request.body.message,'source');f.admit(a,'rejected');await sending;assert.deepEqual(f.composer.state?.draft.images,[image()]);
});
test('file inclusion after an edit remains a named suggestion until deliberate native insertion', async () => {
  const f = fixture(); f.connect(state('a', draft(2, 'before'))); f.node('editor').focus(); f.node('editor').setSelectionRange(1, 3, 'backward');
  f.composer.addFiles([new File(['exact\nfile'], 'notes.txt')]); await new Promise(resolve => setImmediate(resolve));
  const include = f.node('attachments').find('Include text from notes.txt'); assert.ok(include);
  f.composer.setText('after'); include.fire('click'); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.composer.editor.value, 'after');
  const insert = f.node('attachments').find('Insert prepared text from notes.txt'); assert.ok(insert); f.node('editor').setSelectionRange(1, 1); insert.fire('click'); await turn();
  assert.match(f.composer.editor.value, /^aFile: "notes.txt"/); assert.match(f.composer.editor.value, /exact\nfile/); assert.equal(f.node('attachments').hidden, true);
});
test('removed text preparation cannot insert after its asynchronous read', async () => {
  const f = fixture(); f.connect(state('a', draft(2, 'source'))); f.composer.addFiles([new File(['retained'], 'notes.txt')]); await new Promise(resolve => setImmediate(resolve));
  f.node('attachments').find('Include text from notes.txt')?.fire('click'); f.node('attachments').find('Remove notes.txt')?.fire('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.composer.editor.value, 'source'); assert.equal(f.calls.length, 0); assert.equal(f.node('attachments').hidden, true);
});

test('composition commit beforeinput cannot release the Enter latch', async () => {
  for (const inputType of ['insertCompositionText', 'insertFromComposition']) {
    const f = fixture('primary', undefined, true, undefined, () => true); f.connect(state('a', draft(1, 'saved')));
    f.node('editor').fire('compositionstart'); f.node('editor').fire('compositionend');
    f.node('editor').fire('beforeinput', Object.assign({}, {inputType}));
    assert.equal(f.node('editor').fire('keydown', {key: 'Enter', metaKey: true}).defaultPrevented, true);
    await turn(); assert.equal(f.calls.length, 0);
  }
});
test('non-Enter composition commits release the task guard before the next deliberate Enter', async t => {
  for (const candidate of ['pointer', ' ', '1']) {
    const f = fixture(); f.connect(state('a', draft(1, 'saved'))); const editor = f.node('editor');
    editor.fire('compositionstart');
    if (candidate !== 'pointer') {editor.fire('keydown', Object.assign({key: candidate}, {keyCode: 229})); editor.fire('keyup', {key: candidate});}
    editor.fire('compositionend');
    f.node('composer').fire('submit'); await turn(); assert.equal(f.calls.length, 0);
    t.mock.timers.tick(1);
    assert.equal(editor.fire('keydown', {key: 'Enter'}).defaultPrevented, false); await turn(); assert.equal(f.calls.length, 0);
  }
});
test('commit Enter keeps suppression across tasks until its matching keyup', async t => {
  for (const afterEnd of [false, true]) {
    const f = fixture('primary', undefined, true, undefined, () => true); f.connect(state('a', draft(1, 'saved'))); const editor = f.node('editor');
    editor.fire('compositionstart');
    if (!afterEnd) editor.fire('keydown', {key: 'Enter'});
    editor.fire('compositionend');
    if (afterEnd) editor.fire('keydown', {key: 'Enter'});
    t.mock.timers.tick(1); f.node('composer').fire('submit');
    assert.equal(editor.fire('keydown', {key: 'Enter', repeat: true}).defaultPrevented, true); await turn(); assert.equal(f.calls.length, 0);
    editor.fire('keyup', {key: 'Enter'}); editor.fire('keydown', {key: 'Enter'}); await turn(); assert.ok(f.pick('POST', '/inputs'));
  }
});
test('duplicate native input notifications keep one edit and one draft save', async () => {
  const f = fixture(); f.connect(); f.node('editor').value = 'one edit'; f.node('editor').fire('input');
  const retained = f.retained.length; f.node('editor').fire('input'); f.node('editor').fire('input');
  assert.equal(f.retained.length, retained); assert.equal(f.calls.filter(call => call.path.endsWith('/draft')).length, 1);
  f.saved('one edit'); await turn(); assert.equal(f.calls.length, 0);
});
test('newline is native by default and explicit send gestures capture local text', async () => {
  for (const key of ['Enter', 'ArrowUp', 'ArrowDown', 'Tab', 'Escape']) {
    const f = fixture(); f.connect(state('a', draft(1, 'saved')));
    assert.equal(f.node('editor').fire('keydown', {key}).defaultPrevented, false); await turn(); assert.equal(f.calls.length, 0);
  }
  for (const modifier of [{metaKey: true}, {ctrlKey: true}]) {
    const f = fixture(); f.connect(state('a', draft(1, 'saved')));
    assert.equal(f.node('editor').fire('keydown', {key: 'Enter', ...modifier}).defaultPrevented, true); await turn(); assert.ok(f.pick('POST', '/inputs'));
  }
  const f = fixture('primary', undefined, true, undefined, () => true); f.connect(); f.composer.setText('unsaved');
  f.node('editor').fire('keydown', {key: 'Enter', metaKey: true}); await turn(); const request=f.pick('POST','/inputs');assert.equal(request.body.message,'unsaved');f.admit(state('a'),'rejected');await turn();f.saved('unsaved');await turn();assert.equal(f.calls.length,0);
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
test('Shift Enter closes completion for native newline with any send modifier or repeat', async () => {
  for (const modifier of [{metaKey: true}, {ctrlKey: true}, {altKey: true}, {repeat: true}]) {
    const f = fixture('primary', () => ({state: 'ready', items: [{name: 'model', description: '', source: 'app'}]}), true, undefined, () => true);
    f.connect(state('a', draft(1, '/mo'))); f.node('editor').setSelectionRange(3, 3); f.node('editor').focus();
    assert.equal(f.node('editor').fire('keydown', {key: 'Enter', shiftKey: true, ...modifier}).defaultPrevented, false);
    assert.equal(f.node('command-menu').hidden, true); await turn(); assert.equal(f.calls.length, 0);
  }
});
test('over-byte native paste remains exact, unsaved and unsendable without a backend request', async () => {
  const f = fixture(); f.connect(); const value = 'é'.repeat(32769); f.node('editor').value = value; f.node('editor').fire('input');
  assert.equal(f.composer.editor.value, value); assert.equal(f.composer.unsaved, true); assert.equal(f.node('send').disabled, true); assert.equal(f.calls.length, 0);
  assert.match(f.node('receipt').textContent, /The saved draft is unchanged\. Shorten the text to save and send\./);
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
test('draft drain refuses IME and preserves a conflict for byte-preserving reload', async () => {
  const f = fixture(); f.connect(); f.node('editor').fire('compositionstart');
  assert.equal(f.composer.reloadHold, 'ime'); await assert.rejects(f.composer.drain(new AbortController().signal), /not safe/);
  f.node('editor').fire('compositionend'); f.composer.setText('review'); f.fail(f.pick('PUT', '/draft'), 'stale_revision'); await turn();
  const before = f.calls.length; assert.equal(f.composer.reloadHold, undefined);
  await assert.rejects(f.composer.drain(new AbortController().signal), /did not settle/); assert.equal(f.calls.length, before);assert.equal(f.composer.captureReload()[0]?.data.text,'review');
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
test('stale save keeps local text and requires Review before replacement', async () => {
  const f = fixture(); f.connect(state('a', draft(3, 'old'))); f.composer.setText('mine');
  f.fail(f.pick('PUT', '/draft'), 'stale_revision'); await turn(); assert.equal(f.calls.length, 0); assert.equal(f.composer.editor.value, 'mine');
  f.click('Review'); f.fail(f.pick('GET', '/a'), 'review_unavailable'); await turn();
  assert.match(f.node('receipt').textContent, /Draft could not be loaded/); assert.match(f.node('receipt').textContent, /review_unavailable/);
  f.click('Review'); f.ok(f.pick('GET', '/a'), state('a', draft(4, 'remote'))); await turn(); assert.match(f.node('receipt').textContent, /mine/); assert.match(f.node('receipt').textContent, /remote/);
  f.click('Use Mac draft'); assert.equal(f.composer.editor.value, 'remote'); assert.equal(f.composer.unsaved, false);
  assert.doesNotMatch(f.node('receipt').textContent, /review_unavailable|Draft could not be loaded/);
});
test('save transport failure retains the exact unsaved draft without dispatch', async () => {
  const f = fixture(); f.connect(state('a', draft(1, 'old'))); f.composer.setText('new');
  f.pick('PUT', '/draft').reject(new Error('offline')); await turn(); assert.equal(f.calls.filter(call => call.path.endsWith('/inputs')).length, 0);
  assert.equal(f.composer.editor.value, 'new'); assert.equal(f.composer.unsaved, true); assert.match(f.node('receipt').textContent, /offline/);
});
test('submission captures exact local text and mode independently of saves and later navigation', async () => {
  const f = fixture('agent'); const a = f.connect(); f.composer.setText('first'); const first=f.pick('PUT','/draft');f.composer.setText('clicked');
  const sending = f.composer.send(); f.composer.setText('newer'); f.composer.attach('w', state('b', draft(0, '', 'followUp'), true)); f.composer.setText('B');
  const input=await f.waitCall('POST','/inputs');assert.equal(input.path,'/api/agents/a/inputs');assert.deepEqual(input.body,{message:'clicked',mode:'followUp',draftRevision:0,images:[]});assert.equal(input.id,'op-1');
  f.admit(a,'rejected');await sending;assert.equal(f.composer.editor.value,'B');f.ok(first,draft(1,'first','followUp'));await turn();
  const newer=f.calls.find(call=>call.path.includes('/a/draft'));assert.ok(newer);assert.equal(newer.body.text,'newer');f.ok(newer,draft(2,'newer','followUp'));await turn();
  f.composer.attach('w',state('a',draft(2,'newer','followUp'),true));assert.equal(f.composer.editor.value,'newer');
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
  f.click('Copy original text only'); await turn(); assert.deepEqual(f.copied, [' exact\n ']); f.click('Restore to draft'); await turn(); assert.deepEqual(f.pick('POST', '/restore').body, {expectedDraftRevision: 4}); f.fail(f.pick('POST', '/restore'), 'host_unavailable'); await turn(); assert.equal(f.composer.editor.value, ' exact\n ');
  f.click('Check delivery'); assert.equal(f.pick('POST', '/reconcile').path, '/api/operations/op-1/reconcile'); f.fail(f.pick('POST', '/reconcile'), 'unknown_operation'); await turn();
  assert.match(f.node('receipt').textContent, /admission remains unknown/); f.click('Send again…'); assert.equal(f.calls.length, 0);
  f.click('Send again'); await turn(); assert.equal(f.pick('POST', '/inputs').id, 'op-2'); f.admit(a, 'rejected'); await turn();
});
test('a confirmed send again keeps the follow-up delivery of the uncertain Queue send', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(4, 'later'))); f.composer.availability(true, true, true);
  f.node('queue').fire('click'); await turn();
  const input = f.pick('POST', '/inputs'); assert.equal(input.body.mode, 'followUp'); f.calls.splice(f.calls.indexOf(input), 1); input.reject(new Error('connection lost')); await turn();
  f.click('Send again…'); f.click('Send again'); await turn();
  assert.equal(f.pick('POST', '/inputs').body.mode, 'followUp'); f.admit(a, 'rejected'); await turn();
});
test('an uncertain send result shows one warning and retains explicit recovery controls', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'original')));
  const sending = f.composer.send(); await turn(); f.admit(a, 'uncertain'); await sending;
  const receipt = f.node('receipt'); assert.equal(receipt.textContent.split('Send not confirmed. Check before you send again.').length - 1, 1);
  assert.doesNotMatch(receipt.textContent, /Check the receipt before another submission/);
  for (const label of ['Check delivery', 'Copy original text only', 'Restore to draft', 'Send again…']) assert.ok(receipt.find(label));
  assert.equal(f.composer.editor.value, 'original'); assert.equal(f.calls.length, 0);
});
test('an unconfirmed send shows one Details that starts with the reason, and a refused send keeps its own', async () => {
  const walk = (node: NodeFake): NodeFake[] => [node, ...node.children.flatMap(walk)];
  const disclosures = (root: NodeFake) => walk(root).filter(node => node.tag === 'details' && node.children[0]?.textContent !== 'Review message');
  const f = fixture(); f.connect(state('a', draft(2, 'original')));
  const sending = f.composer.send(); await f.waitCall('POST', '/inputs'); const call = f.pick('POST', '/inputs'); f.fail(call, 'delivery_uncertain'); await sending;
  const receipt = f.node('receipt'); const found = disclosures(receipt);
  assert.equal(found.length, 1); assert.equal(found[0]?.children[0]?.textContent, 'Details');
  assert.ok(found[0]?.children[1]?.textContent.startsWith('delivery_uncertain\n\n')); assert.ok(found[0]?.children[1]?.textContent.includes(call.id as string));
  assert.equal(receipt.textContent.split('Send not confirmed. Check before you send again.').length - 1, 1); assert.ok(receipt.find('Review message'));
  const g = fixture(); g.connect(state('a', draft(2, 'original')));
  const refused = g.composer.send(); await g.waitCall('POST', '/inputs'); g.fail(g.pick('POST', '/inputs'), 'invalid_request'); await refused;
  const refusal = g.node('receipt'); assert.match(refusal.textContent, /Message not sent/); assert.equal(disclosures(refusal).length, 1); assert.equal(disclosures(refusal)[0]?.children[1]?.textContent, 'invalid_request');
});
test('restoring uncertain input does not replace a newer draft without an explicit choice', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'original'))); const sending = f.composer.send(); await turn(); f.admit(a, 'uncertain'); await sending;
  f.composer.availability(false, false, false); f.composer.setText('newer'); f.click('Restore to draft'); await turn(); assert.equal(f.composer.editor.value, 'newer');
  f.composer.availability(true, true, false); f.saved('newer', 3); await turn();
  f.click('Restore to draft'); await turn(); f.click('Replace draft with original');
  assert.equal(f.composer.editor.value, 'newer'); assert.deepEqual(f.pick('POST', '/restore').body, {expectedDraftRevision: 3});
  f.ok(f.pick('POST', '/restore'), draft(4, 'original')); await turn(); assert.equal(f.composer.editor.value, 'original'); assert.equal(f.calls.length, 0);
});
test('restored input uses one Composer recovery UI, blocks duplicates, and accepts late receipt', async () => {
  const f = fixture(); const a = state('a', draft(2, 'original')); a.unconfirmed.push({admission: 'unconfirmed', images: [], operationId: 'retained', target: a.target, text: 'original', mode: 'prompt', submittedDraftRevision: 2, createdAt: '', reason: 'unknown'});
  f.connect(a); assert.equal(f.node('receipt').textContent.split('Send not confirmed').length - 1, 1);
  for (const label of ['Check delivery', 'Copy original text only', 'Restore to draft']) assert.ok(f.node('receipt').find(label));
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
  assert.equal(f.node('queue').focused, false);
  assert.equal(f.node('queue').fire('keydown', {key: 'Tab'}).defaultPrevented, false);
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
});
test('the send key and the action slot capture steer, Queue captures followUp, and idle Primary sends prompt', async () => {
  const sent = async (kind: 'primary' | 'agent', saved: string, busy: boolean, act: (f: ReturnType<typeof fixture>) => void) => {
    const f = fixture(kind, undefined, true, undefined, () => true); const target = f.connect(state('a', draft(1, 'words', saved), kind === 'agent'));
    f.composer.availability(true, true, busy); act(f); const call = await f.waitCall('POST', '/inputs'); const mode = call.body.mode; f.admit(target, 'rejected'); await turn(); return mode;
  };
  const key = (f: ReturnType<typeof fixture>) => f.node('editor').fire('keydown', {key: 'Enter'});
  const queue = (f: ReturnType<typeof fixture>) => f.node('queue').fire('click');
  for (const saved of ['prompt', 'steer', 'followUp']) {
    assert.equal(await sent('primary', saved, true, key), 'steer', `primary key, saved ${saved}`);
    assert.equal(await sent('primary', saved, true, f => f.node('composer').fire('submit')), 'steer', `primary submit, saved ${saved}`);
    assert.equal(await sent('primary', saved, true, queue), 'followUp', `primary Queue, saved ${saved}`);
    assert.equal(await sent('agent', saved, true, key), 'steer', `agent key, saved ${saved}`);
    assert.equal(await sent('agent', saved, true, queue), 'followUp', `agent Queue, saved ${saved}`);
    assert.equal(await sent('primary', saved, false, key), 'prompt', `idle primary, saved ${saved}`);
    assert.equal(await sent('agent', saved, false, key), 'followUp', `idle agent, saved ${saved}`);
  }
});
test('stale save retains both exact copies from the error without a receipt fetch', async () => {
  const f = fixture(); f.connect(); f.composer.setText(' local\n ');
  const call = f.pick('PUT', '/draft'); f.calls.splice(f.calls.indexOf(call), 1);
  call.resolve({ok: false, error: {code: 'stale_revision', message: 'stale', retry: 'manual', details: {value: draft(2, ' remote\n '), truncated: false}}});
  await turn(); assert.equal(f.composer.editor.value, ' local\n '); assert.match(f.node('receipt').textContent, / remote\n /); assert.match(f.node('receipt').textContent, / local\n /); f.node('receipt').find('Review');
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
  assert.equal(f.composer.editor.value, 'B'); a.unconfirmed.push({admission: 'unconfirmed', images: [], operationId: result.id, target: a.target, text: 'original', mode: 'prompt', submittedDraftRevision: 4, createdAt: '', reason: 'old snapshot'});
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
  const item = {admission: 'unconfirmed' as const, images: [], operationId: 'retained', target: a.target, text: 'preview', mode: 'prompt', submittedDraftRevision: 2, createdAt: '', reason: 'unknown', textTruncated: true as const}; a.unconfirmed.push(item);
  f.connect(a); f.click('Copy original text only'); const fetch = f.pick('GET', '/retained'); assert.equal(fetch.path, '/api/workspaces/w/unconfirmed/retained');
  f.composer.attach('other', state('b', draft(1, 'B'))); f.ok(fetch, {...item, text: ' exact\n original ', textTruncated: undefined}); await turn();
  assert.deepEqual(f.copied, [' exact\n original ']); assert.equal(f.composer.editor.value, 'B');
  f.composer.attach('w', a); f.click('Restore to draft'); await turn(); assert.equal(f.composer.editor.value, 'newer');
  f.click('Replace draft with original'); assert.equal(f.pick('POST', '/restore').body.expectedDraftRevision, 3);
  f.ok(f.pick('POST', '/restore'), draft(4, ' exact\n original ')); await turn(); assert.equal(f.composer.editor.value, ' exact\n original '); assert.equal(f.calls.length, 0);
});
test('delayed draft restoration returns focus only to the original action owner', async () => {
  for (const nextFocus of ['delivery', 'external', 'restore'] as const) {
    const f = fixture(); const a = state('a', draft(3, '', 'steer'));
    const item = {admission: 'unconfirmed' as const, images: [], operationId: 'retained', target: a.target, text: 'preview', mode: 'steer', submittedDraftRevision: 2, createdAt: '', reason: 'unknown', textTruncated: true as const}; a.unconfirmed.push(item);
    f.connect(a); f.composer.availability(true, true, true); assert.equal(f.node('queue').hidden, true);
    const restore = f.node('receipt').find('Restore to draft'); assert.ok(restore); restore.focus(); restore.fire('click');
    const fetch = f.pick('GET', '/retained'); assert.equal(fetch.path, '/api/workspaces/w/unconfirmed/retained');
    const origin = nextFocus === 'delivery' ? f.node('queue') : nextFocus === 'external' ? new NodeFake() : restore; assert.ok(origin); origin.focus();
    f.ok(fetch, {...item, text: 'full original', textTruncated: undefined}); await turn();
    assert.equal(f.composer.editor.value, ''); assert.equal(f.pick('POST', '/restore').body.expectedDraftRevision, 3);
    f.ok(f.pick('POST', '/restore'), draft(4, 'full original', 'steer')); await turn(); assert.equal(f.composer.editor.value, 'full original'); assert.equal(document.activeElement === (nextFocus === 'restore' ? f.composer.editor : origin), true, `saved focus owner: ${nextFocus}`);
    assert.equal(f.calls.length, 0);
  }
});
test('explicit replacement starts a fresh focus intent after delayed restoration review', async () => {
  const f = fixture(); const a = state('a', draft(3, 'newer', 'steer'));
  const item = {admission: 'unconfirmed' as const, images: [], operationId: 'retained', target: a.target, text: 'preview', mode: 'steer', submittedDraftRevision: 2, createdAt: '', reason: 'unknown', textTruncated: true as const}; a.unconfirmed.push(item);
  f.connect(a); f.composer.availability(true, true, true); assert.equal(f.node('queue').hidden, false);
  f.node('editor').setSelectionRange(1, 4, 'backward'); f.node('editor').fire('select');
  const restore = f.node('receipt').find('Restore to draft'); assert.ok(restore); restore.focus(); restore.fire('click');
  const delivery = f.node('queue'); delivery.focus();
  f.ok(f.pick('GET', '/retained'), {...item, text: 'full original', textTruncated: undefined}); await turn();
  assert.equal(f.composer.editor.value, 'newer'); assert.equal(document.activeElement, delivery); assert.equal(f.calls.length, 0);
  const replace = f.node('receipt').find('Replace draft with original'); assert.ok(replace); replace.focus(); replace.fire('click');
  assert.equal(document.activeElement, replace); assert.equal(f.composer.editor.value, 'newer');
  assert.equal(f.pick('POST', '/restore').body.expectedDraftRevision, 3); f.ok(f.pick('POST', '/restore'), draft(4, 'full original', 'steer')); await turn();
  assert.equal(document.activeElement, f.composer.editor); assert.equal(f.composer.editor.value, 'full original');
  assert.deepEqual([f.node('editor').selectionStart, f.node('editor').selectionEnd, f.node('editor').selectionDirection], [1, 4, 'backward']); assert.equal(f.calls.length, 0);
});
test('failed exact recovery fetch never copies or restores the preview', async () => {
  const f = fixture(); const a = state('a', draft(3, 'newer'));
  a.unconfirmed.push({admission: 'unconfirmed', images: [], operationId: 'retained', target: a.target, text: 'preview', mode: 'prompt', submittedDraftRevision: 2, createdAt: '', reason: 'unknown', textTruncated: true});
  f.connect(a); f.click('Copy original text only'); f.fail(f.pick('GET', '/retained'), 'host_unavailable'); await turn();
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
test('an idle primary captures prompt mode without a save and retains it across busy-state changes', async () => {
  const f = fixture(); const a = f.connect(state('a', draft(2, 'sent', 'steer'))); const sending = f.composer.send(); f.composer.availability(true, true, true); await turn();
  assert.deepEqual(f.pick('POST', '/inputs').body, {epoch: 7, message: 'sent', mode: 'prompt', draftRevision: 2, images: [], literal: false});assert.equal(f.calls.some(call=>call.method==='PUT'),false);f.admit(a,'rejected');await sending;
  assert.equal(f.pick('PUT','/draft').body.mode,'prompt');f.saved('sent',3,'prompt');await turn();
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
  assert.equal(f.node('send').hidden, false); assert.equal(f.node('acquire'), undefined); assert.equal(f.node('queue').hidden, true); assert.equal(f.node('send').attrs.get('aria-description'), 'This agent is not ready for messages.');
  assert.equal(f.node('send').disabled, true);
  f.composer.availability(false, false, false); assert.equal(f.node('send').hidden, false); assert.equal(f.node('send').disabled, true); assert.equal(f.node('acquire'), undefined);
});
test('a missing target hides the composer and clears all save and receipt presentation', () => {
  const f = fixture(); f.connect(); f.composer.attach('w');
  assert.equal(f.node('composer').hidden, true); assert.equal(f.node('save').textContent, ''); assert.equal(f.node('receipt-details').textContent, ''); assert.equal(f.node('send').disabled, true);
});
test('a state that holds the composer without a draft shows it with a disabled editor, the note, Details and its action', () => {
  const f = fixture('agent'); const elements = {...createComposerElements('target:no-draft/1'), overlay: undefined}; const composer = new Composer(elements, {submitted() {}, unknownCommand: () => false});
  const root = elements.root as unknown as NodeFake, editor = elements.editor as unknown as NodeFake, sources = elements.sources as unknown as NodeFake, start = elements.start as unknown as NodeFake, send = elements.send as unknown as NodeFake, note = elements.state as unknown as NodeFake;
  const label = () => (elements.state?.querySelector('.composer-state-label') as unknown as NodeFake), detail = () => (elements.state?.querySelector('.composer-state-detail') as unknown as HTMLButtonElement);
  composer.attach('w'); assert.equal(root.hidden, true, 'no state, no draft');
  composer.setState({line: 'Not running. Start it to send a message.', label: 'Not running', action: {label: 'Start', run() {}}}); assert.equal(root.hidden, true, 'a state without the marker stays hidden');
  composer.setState({line: 'Checking the agent…', label: 'Checking the agent…', blocksSend: true}); assert.equal(root.hidden, true);
  let checks = 0;
  composer.setState({line: 'Could not reach the agent.', label: 'Could not reach the agent', tone: 'warning', withoutDraft: true, detail: 'socket closed', action: {label: 'Check again', recovery: true, run: () => { checks++; }}});
  assert.equal(root.hidden, false); assert.equal(editor.disabled, true); assert.equal(sources.disabled, true); assert.equal(send.hidden, true);
  assert.equal(start.hidden, false); assert.equal(start.disabled, false); assert.equal(actionText(start), 'Check again'); assert.equal(note.hidden, false); assert.equal(note.dataset.tone, 'warning');
  assert.equal(label().hidden, false); assert.equal(label().textContent, 'Could not reach the agent'); assert.equal(start.getAttribute('aria-label'), 'Check again'); assert.equal(detail().hidden, false);
  assert.equal(detail().getAttribute('aria-expanded'), 'false');
  (detail().onclick as () => void)(); assert.equal(detail().getAttribute('aria-expanded'), 'true'); assert.equal(elements.stateDetails?.hidden, false); assert.equal(elements.stateDetails?.textContent, 'socket closed');
  composer.setState({line: 'Could not reach the agent.', label: 'Could not reach the agent', withoutDraft: true, detail: 'socket closed'}); assert.equal(elements.stateDetails?.hidden, false, 'a same-error repaint keeps the disclosure open');
  (detail().onclick as () => void)(); assert.equal(elements.stateDetails?.hidden, true); assert.equal(detail().getAttribute('aria-expanded'), 'false');
  composer.setState({line: 'Could not reach the agent.', label: 'Could not reach the agent', withoutDraft: true, detail: 'new exact error', action: {label: 'Check again', recovery: true, run: () => { checks++; }}}); assert.equal(elements.stateDetails?.hidden, true);
  (start.onclick as unknown as () => void)(); assert.equal(checks, 1);
  composer.setState({line: 'Checking the agent…', label: 'Checking the agent…', withoutDraft: true, blocksSend: true, action: {label: 'Checking…', pending: true, disabled: true, run() {}}});
  assert.equal(root.hidden, false); assert.equal(start.disabled, true); assert.equal(start.getAttribute('aria-busy'), 'true'); assert.equal(start.getAttribute('aria-label'), 'Checking…'); assert.match(start.querySelector('svg')?.getAttribute('class') ?? '', /card-icon-working/);
  composer.attach('w', state('m', draft(1, 'kept'), true)); composer.setState({line: 'Not running. Start it to send a message.', label: 'Not running', action: {label: 'Start', run() {}}});
  assert.equal(root.hidden, false); assert.equal(editor.disabled, false); assert.equal(sources.disabled, false); assert.equal(composer.showsWithoutDraft, false);
  composer.attach('w'); assert.equal(root.hidden, true, 'without a draft the same state hides the composer again'); void f; composer.destroy();
});
test('input and control receipts share one disclosure and never leak across targets', () => {
  const f = fixture(); const a = f.connect();
  const result: OperationView = {id: 'input', target: a.target, kind: 'primary.input', state: 'accepted', createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z'};
  f.composer.receipts([result, {...result, id: 'control', kind: 'primary.control', state: 'completed', updatedAt: '2026-10-08T12:01:00Z'}]);
  assert.equal(f.node('receipt-details').children.length, 1); f.openReceipt(); assert.match(f.node('receipt-details').textContent, /Input receipt/); assert.match(f.node('receipt-details').textContent, /Action receipt/); assert.equal(f.node('receipt').textContent, '');
  f.composer.attach('w', state('b')); assert.equal(f.node('receipt-details').textContent, ''); assert.equal(f.node('save').textContent, '');
});

test('editor height grows locally, caps long drafts, shrinks, and keeps an explicit size as its resting minimum', () => {
  const computed = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle'); const media = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  Object.defineProperty(globalThis, 'getComputedStyle', {configurable: true, value: () => ({lineHeight: '22.5px', paddingTop: '8px', paddingBottom: '8px', borderTopWidth: '1px', borderBottomWidth: '1px'})});
  Object.defineProperty(globalThis, 'matchMedia', {configurable: true, value: () => ({matches: false})});
  try {
    const f = fixture(); f.connect(); const editor = f.node('editor'); editor.isConnected = true;
    const paint = () => {for (const frame of f.frames.splice(0)) frame();};
    f.composer.setText(Array(10).fill('line').join('\n')); paint(); assert.equal(editor.style.height, '243px');
    f.composer.setText(Array(20).fill('line').join('\n')); paint(); assert.equal(editor.style.height, '243px');
    f.composer.setText('one'); paint(); assert.equal(editor.style.height, '40.5px');
    editor.style.height = '180px'; editor.fire('pointerup'); f.composer.setText('two'); paint(); assert.equal(editor.style.height, '40.5px');
    f.composer.setManualHeight(180); paint(); assert.equal(editor.style.height, '180px');
    f.composer.setText(Array(20).fill('line').join('\n')); paint(); assert.equal(editor.style.height, '243px'); assert.equal(editor.style.maxHeight, '243px');
    f.composer.setText('two'); paint(); assert.equal(editor.style.height, '180px');
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
  assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, false);
  f.composer.setText('unsaved'); assert.equal(f.node('save').textContent, 'Draft not saved'); assert.equal(f.calls.length, 0);
  f.composer.availability(true, true, false); assert.equal(f.node('save').textContent, '');
  f.saved('unsaved', 2); await turn(); assert.equal(f.node('save').textContent, '');
});
test('a failed save exposes Retry and latches through edits until an explicit retry succeeds', async () => {
  const f = fixture(); f.connect(); f.composer.setText('one'); f.fail(f.pick('PUT', '/draft'), 'host_unavailable'); await turn();
  assert.equal(f.node('save').textContent, 'Draft not saved'); assert.match(f.node('receipt').textContent, /^Draft not saved\./); assert.match(f.node('receipt').textContent, /host_unavailable/);
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
test('a queued admission names the delivery mode in the quiet tier while a refusal stays a warning', async () => {
  const announcements = () => (globalThis.document as unknown as {getElementById(id: string): NodeFake}).getElementById('announcements');
  const admitQueued = async (f: ReturnType<typeof fixture>, a: TargetState, sending: Promise<void>, mode: string) => {
    await turn(); const call = f.pick('POST', '/inputs'); assert.equal(call.body.mode, mode);
    f.ok(call, {id: call.id, kind: 'primary.input', target: a.target, state: 'accepted', createdAt: '', updatedAt: '', receipt: {kind: 'rpc', disposition: 'queued'}});
    await turn(); f.ok(f.pick('GET', '/a'), state('a', draft(3, '', mode))); await sending; await turn();
  };
  const steer = fixture(); const sa = steer.connect(state('a', draft(2, 'steer this'))); steer.composer.availability(true, true, true);
  await admitQueued(steer, sa, steer.composer.send(), 'steer');
  assert.equal(steer.node('receipt').textContent, 'Steer queued');
  assert.equal(steer.node('receipt').children[0]?.className, 'secondary'); assert.equal(announcements().textContent, 'Steer queued');
  const follow = fixture(); const fa = follow.connect(state('a', draft(2, 'after this run'))); follow.composer.availability(true, true, true);
  await admitQueued(follow, fa, follow.composer.send(false, undefined, 'followUp'), 'followUp');
  assert.equal(follow.node('receipt').textContent, 'Message queued');
  assert.equal(follow.node('receipt').children[0]?.className, 'secondary'); assert.equal(announcements().textContent, 'Message queued');
  const refused = fixture(); const ra = refused.connect(state('a', draft(2, 'not now')));
  const refusing = refused.composer.send(); await turn(); refused.admit(ra, 'rejected'); await refusing; await turn();
  assert.equal(refused.node('receipt').textContent, 'Message not sent'); assert.equal(refused.node('receipt').children[0]?.className, 'warning');
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
test('save Retry clears the matching save failure after an acknowledged retry', async () => {
  const f = fixture(); f.connect(); f.composer.setText('text'); f.fail(f.pick('PUT', '/draft'), 'host_unavailable'); await turn();
  assert.equal(f.node('save').textContent, 'Draft not saved'); assert.match(f.node('receipt').textContent, /host_unavailable/);
  const control = f.node('receipt').find('Retry draft save'); assert.ok(control); const row = control.parentElement; assert.ok(row); assert.equal(row.className, 'receipt-save-failure'); assert.equal(control.textContent, 'Try again'); assert.equal(control.children.length, 0); assert.equal(control.getAttribute('aria-label'), 'Retry draft save'); assert.equal(f.node('receipt').children.length, 1); assert.match(row.textContent, /^Draft not saved\.\nDetails/); assert.match(row.textContent, /Try again$/);
  f.click('Retry draft save'); f.saved('text'); await turn();
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
test('a healthy selection gate pauses draft writes without gating the captured native message', async () => {
  const f = fixture(); f.connect(); f.composer.availability(true, true, false, true); f.composer.setText('unsaved');
  assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, false); assert.equal(f.composer.unsaved, true);
  assert.equal(f.node('send').attrs.get('aria-description'), '');
  const sending=f.composer.send(),request=await f.waitCall('POST','/inputs');assert.equal(request.body.message,'unsaved');f.admit(state('a'),'rejected');await sending;assert.equal(f.calls.length,0);
  f.composer.availability(true, true, false, false); assert.equal(f.pick('PUT', '/draft').body.text, 'unsaved'); f.saved('unsaved'); await turn();
  assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, false);
});
test('an outstanding save settles during a healthy gate but newer text waits until the gate clears', async () => {
  const f = fixture(); f.connect(); f.composer.setText('first'); f.composer.availability(true, true, false, true); f.composer.setText('newer');
  f.saved('first'); await turn(); assert.equal(f.calls.length, 0); assert.equal(f.node('save').textContent, ''); assert.equal(f.node('send').disabled, false);
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
  assert.ok(f.node('receipt').find('Check delivery')); assert.ok(f.node('receipt').find('Copy original text only')); assert.ok(f.node('receipt').find('Restore to draft'));
  await f.composer.send(); assert.equal(f.calls.length, 0);
});
test('composer placement keeps delivery gating independent of app-owned connection controls', () => {
  const f = fixture('agent'); f.connect(); f.composer.placement(true); f.composer.availability(true, false, false);
  f.composer.setText('safe draft'); assert.equal(f.node('acquire'), undefined); assert.equal(f.node('send').disabled, true);
  f.composer.availability(false, false, false); f.composer.availability(true, false, false); assert.equal(f.node('send').hidden, false);
  f.composer.placement(false); assert.equal(f.node('send').disabled, true); assert.equal(f.composer.editor.value, 'safe draft');
});

function targetIndex(saved: TargetState, changes: Partial<TargetIndex> = {}): TargetIndex {
  return {targetKey: saved.targetKey, target: saved.target, draftRevision: saved.draft.revision, hasDraft: !!saved.draft.text, retainedInputOperationIds: [], unconfirmedOperationIds: saved.unconfirmed.map(item => item.operationId), ...changes};
}
test('Resume reconciles indexed revisions and unresolved IDs against an empty retained buffer', () => {
  const f = fixture('agent'); const a = state('a', draft(4, '', 'followUp'), true); f.composer.attach('w', a); f.composer.attach('w');
  assert.equal(f.composer.retained('w', a.target, targetIndex(a)), false);
  assert.equal(f.composer.retained('w', a.target, targetIndex(a, {draftRevision: 5, hasDraft: true})), true);
  assert.equal(f.composer.retained('w', a.target, targetIndex(a, {draftRevision: 3, hasDraft: true})), false);
  assert.equal(f.composer.retained('w', a.target, targetIndex(a, {retainedInputOperationIds: [], unconfirmedOperationIds: ['remote-input']})), true);
  assert.equal(f.composer.retained('w', a.target, targetIndex(a, {draftRevision: 3, retainedInputOperationIds: [], unconfirmedOperationIds: ['remote-input']})), true);
  assert.equal(f.composer.retained('w', a.target, targetIndex(a, {target: {kind: 'agent', identity: 'other'}, hasDraft: true, draftRevision: 9})), false);
});
test('an old index cannot resurrect a draft or input copy cleared by this tab', async () => {
  const f = fixture('agent'); const a = state('a', draft(4, 'sent', 'followUp'), true);
  a.unconfirmed.push({admission: 'unconfirmed', images: [], operationId: 'retained', target: a.target, text: 'sent', mode: 'followUp', submittedDraftRevision: 4, createdAt: '', reason: 'unknown'});
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
  assert.equal(f.node('send').hidden, true); assert.equal(f.node('send').disabled, true);
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
  assert.equal(f.composer.editor.placeholder, 'Message Review companion…');
  assert.equal(f.node('editor').attrs.get('aria-label'), 'Message Review companion');
  f.composer.availability(false, true, false); f.composer.recipient('Message Review companion');
  assert.equal(f.composer.editor.value, 'retained draft'); assert.equal(f.node('editor').selectionStart, 4);
  assert.equal(f.node('editor').selectionEnd, 8); assert.equal(f.node('editor').focused, true); assert.equal(f.node('send').disabled, false);
  f.composer.availability(true, true, false); assert.equal(f.calls.length, 0);
  f.composer.availability(true, false, false); f.composer.recipient('Draft for Review companion');
  assert.equal(f.node('recipient').textContent, 'Draft for Review companion'); assert.equal(f.node('send').hidden, false);
  assert.equal(f.node('send').attrs.get('aria-description'), 'This agent is not ready for messages.'); assert.deepEqual(f.composer.target, a.target);
  f.composer.recipient('Draft for Review companion', 'Messages are unavailable for this agent.');
  assert.equal(f.node('send').attrs.get('aria-description'), 'Messages are unavailable for this agent.'); assert.equal(f.node('send').hidden, false);
  f.composer.recipient('Draft for Review companion', ''); assert.equal(f.node('send').attrs.get('aria-description'), '');
  assert.equal(f.composer.editor.value, 'retained draft'); assert.equal(f.node('editor').selectionStart, 4); assert.equal(f.node('editor').selectionEnd, 8);
  assert.equal(f.node('editor').focused, true); assert.equal(f.calls.length, 0);
});
test('recipient placeholders and busy delivery capability preserve the exact native draft', () => {
  const f = fixture('agent'); const a = f.connect(state('a', draft(2, 'Exact local draft', 'followUp'), true));
  const editor = f.composer.editor, parent = editor.parentElement; editor.focus(); editor.setSelectionRange(2, 9, 'backward');
  const name = 'A complete recipient name '.repeat(12);
  f.composer.recipient(`Draft for ${name}`, 'Connect before sending.', `Message ${name}`);
  assert.equal(editor.placeholder, `Message ${name}…`); assert.equal(f.node('editor').getAttribute('aria-label'), `Draft for ${name}`);
  for (const [connected, ready, busy, supported, visible] of [[true, true, true, false, false], [true, true, true, true, true], [true, true, false, true, false], [false, true, true, true, false], [true, false, true, true, false]] as const) {
    f.composer.availability(connected, ready, busy, false, supported);
    assert.equal(f.node('queue').hidden, !visible);
    assert.equal(f.composer.editor, editor); assert.equal(editor.parentElement, parent); assert.equal(editor.value, 'Exact local draft');
    assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 9, 'backward']); assert.deepEqual(f.composer.target, a.target);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.submitted.length, 0);
});
test('confirmed work keeps named Steer and Queue visible with empty drafts disabled', () => {
  const f = fixture(); f.connect(); f.composer.recipient('Message Primary'); f.composer.availability(true, true, true);
  const root = f.node('composer'), send = f.node('send'), queue = f.node('queue');
  assert.equal(root.dataset.working, 'empty'); assert.equal(queue.hidden, false); assert.equal(queue.disabled, true); assert.equal(send.hidden, false); assert.equal(send.disabled, true); assert.equal(actionText(send), 'Steer'); assert.equal(send.querySelector('.action-label')?.classList.contains('sr-only'), false);
  f.composer.setText('Look at the failing test'); f.saved('Look at the failing test');
  assert.equal(root.dataset.working, 'draft'); assert.equal(queue.hidden, false); assert.equal(queue.disabled, false); assert.equal(send.disabled, false);
  assert.equal(actionText(send), 'Steer'); assert.equal(send.getAttribute('aria-label'), 'Steer message'); assert.equal(send.title, 'Steer: send now; the agent reads it at its next step');
  assert.equal(queue.title, 'Add a follow-up message.');
  f.composer.setText(''); assert.equal(root.dataset.working, 'empty'); assert.equal(queue.hidden, false); assert.equal(queue.disabled, true);
  f.composer.availability(true, true, false); assert.equal(root.dataset.working, undefined); assert.equal(queue.hidden, true); assert.equal(actionText(send), 'Send'); assert.equal(send.getAttribute('aria-label'), 'Send message');
});
test('working image-only drafts retain both delivery actions and recognized commands omit Queue', () => {
  const commands = () => ({state: 'ready' as const, items: [{name: 'status', description: 'Read status', source: 'extension'}]});
  const f = fixture('agent', commands); f.connect(state('images', {...draft(2, '', 'followUp'), images: [image()]}, true));
  f.composer.availability(true, true, true);
  assert.equal(f.node('send').disabled, false); assert.equal(f.node('queue').hidden, false); assert.equal(f.node('queue').disabled, false);
  f.composer.attach('w', state('command', draft(3, '/status', 'followUp'), true));
  assert.equal(actionText(f.node('send')), 'Run command'); assert.equal(f.node('send').disabled, false); assert.equal(f.node('queue').hidden, true);
  assert.equal(f.calls.some(call => call.path.endsWith('/inputs') || call.path.endsWith('/command')), false);
});
test('recognized working commands replace delivery guidance until an ordinary message returns', () => {
  const host = fixture('agent'), elements = createComposerElements('working-command');
  const composer = new Composer(elements, {commands: () => ({state: 'ready', items: [{name: 'status', description: 'Read status', source: 'extension'}]}), submitted() {}, unknownCommand() {return false;}});
  composer.attach('w', state('command-guidance', draft(1, '/status', 'followUp'), true)); composer.availability(true, true, true);
  const label = elements.state?.querySelector('.composer-state-label');
  assert.equal(label?.textContent, 'Working'); assert.equal(elements.queue.hidden, true); assert.equal(elements.send.getAttribute('aria-label'), 'Run command /status');
  assert.equal(elements.send.title, 'Run /status on this agent. It sends no message');
  composer.setText('Continue with this change');
  assert.equal(label?.textContent, 'Working · Steer at the next step; Queue adds a follow-up.'); assert.equal(elements.queue.hidden, false); assert.equal(elements.send.getAttribute('aria-label'), 'Steer message');
  composer.setText('/status'); assert.equal(label?.textContent, 'Working'); assert.equal(elements.queue.hidden, true);
  assert.equal(host.calls.some(call => call.path.endsWith('/inputs') || call.path.endsWith('/command')), false); composer.destroy();
});
test('empty ready drafts omit Send while text, images and required recovery retain their actions', () => {
  for (const kind of ['primary', 'agent'] as const) {
    const f = fixture(kind); f.connect(state('empty', draft(1, ''), kind === 'agent'));
    const editor = f.composer.editor, parent = editor.parentElement, send = f.node('send');
    assert.equal(send.hidden, true); editor.focus(); editor.setSelectionRange(0, 0);
    f.composer.setText('x'); assert.equal(send.hidden, false);
    f.composer.setText(''); assert.equal(send.hidden, true);
    assert.equal(f.composer.editor, editor); assert.equal(editor.parentElement, parent); assert.equal(editor.selectionStart, 0);
    const imageOnly = state('image-only', {...draft(2, ''), images: [{digest: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, width: 1, height: 1, name: 'draft.png'}]}, kind === 'agent');
    f.composer.attach('w', imageOnly); assert.equal(send.hidden, false); assert.equal(send.disabled, false);
    f.composer.availability(false, true, false); assert.equal(send.hidden, false);
    f.composer.attach('w', state('recovery', draft(3, ''), kind === 'agent'));
    f.composer.setState({line: 'Could not reach the agent.', action: {label: 'Check again', recovery: true, run() {}}});
    assert.equal(send.hidden, true);
  }
});
test('unconfirmed delivery puts captured identifiers and text in closed disclosures', () => {
  const f = fixture(); const a = state('captured', draft(2, 'message'));
  a.unconfirmed.push({admission: 'unconfirmed', images: [], operationId: 'unconfirmed-id', target: a.target, text: 'message', mode: 'prompt', submittedDraftRevision: 2, createdAt: '', reason: 'unknown'});
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
  assert.equal(first.root.querySelector('.stop')?.getAttribute('aria-label'), 'Stop response');
  const stop = first.root.querySelector('.stop'); assert.equal(actionText(stop as NodeFake), 'Stop'); assert.equal(stop?.querySelector('.action-label')?.classList.contains('sr-only'), false);
  assert.equal(first.send.getAttribute('aria-label'), 'Send message'); assert.equal(actionText(first.send), 'Send'); assert.equal(first.send.children.length, 2);
  assert.equal(first.queue.getAttribute('aria-label'), 'Queue message'); assert.equal(first.queue.textContent, 'Queue'); assert.equal(first.queue.hidden, true); assert.equal(first.root.querySelector('select'), undefined); assert.equal(first.send.type, 'submit'); assert.equal(first.send.disabled, true);
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
  for (const node of [f.node('editor'),f.node('composer'),f.node('command-menu'),f.node('queue')]) assert.equal([...node.listeners.values()].flat().length,0);
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

const hostCommands = (state: CommandInventory['state'] = 'ready'): CommandInventory => ({state, items: state === 'ready' ? [{name: 'ping', description: 'Reply with pong', source: 'alpha'}] : []});
const commandResult = (id: string, changes: Partial<OperationView> = {}): OperationView => ({id, kind: 'agent.command', target: {kind: 'agent', identity: 'run'}, state: 'completed', createdAt: '', updatedAt: '1', receipt: {kind: 'command', name: 'ping', text: 'pong', truncated: false}, ...changes});
test('an agent draft that names a host command runs it once and clears only after the confirmed result', async () => {
  const f = fixture('agent', () => hostCommands(), true); f.connect(state('run', draft(0, '', 'followUp'), true));
  f.composer.setText('/ping now'); const reserved = f.reservations();
  assert.equal(actionText(f.node('send')), 'Run command'); assert.equal(f.node('send').attrs.get('aria-label'), 'Run command /ping'); assert.equal(f.node('send').title, 'Run /ping on this agent. It sends no message');
  const sending = f.composer.send(); const call = await f.waitCall('POST', '/command');
  assert.equal(call.path, '/api/agents/run/command'); assert.deepEqual(call.body, {name: 'ping', args: 'now'}); assert.equal(f.calls.some(item => item.path.endsWith('/inputs')), false);
  assert.equal(f.composer.editor.value, '/ping now', 'the draft stays while the command runs');
  f.ok(call, commandResult(call.id as string)); await sending;
  assert.equal(f.composer.editor.value, ''); assert.equal(f.submitted.length, 1); assert.equal(f.reservations(), reserved + 1, 'one reservation for the one run');
  assert.equal(f.node('receipt').find('Command /ping ran') !== undefined, true);
  assert.equal(actionText(f.node('send')), 'Send');
  assert.equal(f.calls.filter(item => item.path.endsWith('/command')).length, 0, 'the command is never repeated');
});
test('a command with no arguments sends only its name, and a name that is not in the host list is an ordinary message', async () => {
  const f = fixture('agent', () => hostCommands(), true); f.connect(state('run', draft(0, '', 'followUp'), true));
  f.composer.setText('/ping'); const sending = f.composer.send(); const call = await f.waitCall('POST', '/command');
  assert.deepEqual(call.body, {name: 'ping'}); f.ok(call, commandResult(call.id as string)); await sending;
  f.composer.setText('/other thing'); assert.equal(actionText(f.node('send')), 'Send'); const message = f.composer.send(); await f.waitCall('POST', '/inputs'); assert.equal(f.calls.some(item => item.path.endsWith('/command')), false); void message;
});
test('a host refusal keeps the draft, shows the host message and runs nothing again', async () => {
  const f = fixture('agent', () => hostCommands(), true); f.connect(state('run', draft(0, '', 'followUp'), true));
  f.composer.setText('/ping'); const sending = f.composer.send(); const call = await f.waitCall('POST', '/command');
  f.ok(call, commandResult(call.id as string, {state: 'rejected', receipt: undefined, error: {code: 'command_refused', message: 'durable command ping failed', retry: 'none'}})); await sending;
  assert.equal(f.composer.editor.value, '/ping'); assert.ok(f.node('receipt').find('durable command ping failed')); assert.ok(f.node('receipt').find('Your draft is unchanged.'));
  assert.equal(f.calls.filter(item => item.path.endsWith('/command')).length, 0);
});
test('an unknown outcome keeps the draft, says the command may have run and offers no repeat', async () => {
  const f = fixture('agent', () => hostCommands(), true); f.connect(state('run', draft(0, '', 'followUp'), true));
  f.composer.setText('/ping'); const sending = f.composer.send(); const call = await f.waitCall('POST', '/command');
  const used = f.reservations();
  f.ok(call, commandResult(call.id as string, {state: 'uncertain', receipt: undefined, error: {code: 'delivery_uncertain', message: 'Dispatch ended without a valid receipt', retry: 'manual'}})); await sending;
  assert.equal(f.composer.editor.value, '/ping'); assert.ok(f.node('receipt').find('The command may have run. Your draft is unchanged.'));
  assert.equal(f.node('receipt').find('Check action'), undefined); assert.equal(f.node('receipt').find('Run again'), undefined);
  f.click('Dismiss'); const removal = f.pick('DELETE', `/api/operations/${call.id}`); f.ok(removal, {removed: true});
  assert.equal(f.node('receipt').find('The command may have run. Your draft is unchanged.'), undefined);
  assert.equal(f.reservations(), used, 'dismissing does not run anything');
});
test('a lost request leaves the draft and says the command may have run', async () => {
  const f = fixture('agent', () => hostCommands(), true); f.connect(state('run', draft(0, '', 'followUp'), true));
  f.composer.setText('/ping'); const sending = f.composer.send(); const call = await f.waitCall('POST', '/command');
  call.reject(new Error('network down')); await sending;
  assert.equal(f.composer.editor.value, '/ping'); assert.ok(f.node('receipt').find('The command may have run. Your draft is unchanged.'));
});
test('a result stays in the receipt with a bounded disclosure, Copy and the cut notice until it is dismissed or the next run', async () => {
  const f = fixture('agent', () => hostCommands(), true); f.connect(state('run', draft(0, '', 'followUp'), true));
  f.composer.setText('/ping'); const sending = f.composer.send(); const call = await f.waitCall('POST', '/command');
  f.ok(call, commandResult(call.id as string, {receipt: {kind: 'command', name: 'ping', text: 'first line\nsecond line', truncated: true}})); await sending;
  assert.ok(f.node('receipt').find('Showing the first 16 KiB')); assert.ok(f.node('receipt').find('Result')); assert.equal(f.node('receipt').textContent.includes('first line'), true);
  f.click('Copy result'); await turn(); assert.deepEqual(f.copied, ['first line\nsecond line']);
  f.composer.setText('typing elsewhere'); assert.ok(f.node('receipt').find('Command /ping ran'), 'a later edit keeps the result');
  f.click('Dismiss'); assert.equal(f.node('receipt').find('Command /ping ran'), undefined);
  f.composer.setText('/ping'); const again = f.composer.send(); const next = await f.waitCall('POST', '/command');
  assert.equal(f.node('receipt').find('Command /ping ran'), undefined, 'the previous result leaves when the next run starts');
  f.ok(next, commandResult(next.id as string, {updatedAt: '2', receipt: {kind: 'command', name: 'ping', text: '', truncated: false}})); await again;
  assert.ok(f.node('receipt').find('The command returned no text.'));
});
test('a draft that edits during the run keeps the newer text', async () => {
  const f = fixture('agent', () => hostCommands(), true); f.connect(state('run', draft(0, '', 'followUp'), true));
  f.composer.setText('/ping'); const sending = f.composer.send(); const call = await f.waitCall('POST', '/command');
  f.composer.setText('/ping changed'); f.ok(call, commandResult(call.id as string)); await sending;
  assert.equal(f.composer.editor.value, '/ping changed'); assert.ok(f.node('receipt').find('The command ran. Your newer draft is unchanged.'));
});
test('a slash draft waits while the list loads, and a command cannot carry attachments', async () => {
  let inventory = hostCommands('loading'); const f = fixture('agent', () => inventory, true); f.connect(state('run', draft(0, '', 'followUp'), true));
  f.composer.setText('/ping'); assert.equal(f.node('send').disabled, true); assert.equal(f.node('send').title, 'Loading commands…');
  await f.composer.send(); assert.equal(f.calls.some(item => item.path.endsWith('/inputs') || item.path.endsWith('/command')), false);
  inventory = hostCommands(); f.composer.commandsChanged(); assert.equal(f.node('send').disabled, false); assert.equal(actionText(f.node('send')), 'Run command');
  const withImage = state('run', {...draft(0, '/ping', 'followUp'), images: [image()]}, true); f.composer.attach('w', {...withImage, targetKey: 'run-image'}); f.composer.commandsChanged();
  assert.equal(f.node('send').disabled, true); assert.equal(f.node('send').title, 'Remove attachments to run a command.');
});
test('Primary and a recipient without commands never run a command from the draft', async () => {
  const primary = fixture('primary', () => hostCommands(), true); primary.connect(); primary.composer.setText('/ping');
  assert.equal(actionText(primary.node('send')), 'Send');
  const none = fixture('agent', () => ({state: 'unavailable', items: [], message: 'Start the agent to run commands.'}), true); none.connect(state('run', draft(0, '', 'followUp'), true));
  none.composer.setText('/ping'); assert.equal(actionText(none.node('send')), 'Send');
});
test('an open extension dialog changes the pending send line to Waiting for your answer without changing delivery', async () => {
  const f = fixture('primary'); const saved = f.connect(state('dialog-wait', draft(0, '', 'prompt')));
  f.composer.setText('/approval-probe'); await turn(); const firstSave = f.pick('PUT', '/draft');
  const sending = f.composer.send(); const request = await f.waitCall('POST', '/inputs');
  assert.match(f.node('receipt').textContent, /Sending…/); assert.doesNotMatch(f.node('receipt').textContent, /Waiting for your answer/);
  f.composer.awaitingAnswer(true);
  assert.match(f.node('receipt').textContent, /Waiting for your answer/); assert.doesNotMatch(f.node('receipt').textContent, /Sending…/);
  f.composer.awaitingAnswer(false);
  assert.match(f.node('receipt').textContent, /Sending…/); assert.doesNotMatch(f.node('receipt').textContent, /Waiting for your answer/);
  f.composer.awaitingAnswer(true);
  assert.equal(request.body.message, '/approval-probe'); f.admit(saved); await turn(); f.ok(f.pick('GET', '/dialog-wait'), {...saved, draft: draft(2, '', 'prompt')}); await sending; f.ok(firstSave, draft(1, '/approval-probe', 'prompt')); await turn();
  assert.doesNotMatch(f.node('receipt').textContent, /Waiting for your answer|Sending…/);
  f.composer.destroy();
});
