import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WorkbenchStatus} from './workbench-status.ts';
import test from 'node:test';
import { Transcript as RetainedTranscript, structured } from './render.ts';
import { contextMenu } from './context-menu.ts';
import { Roster } from './roster.ts';
import { conversationPresentation, presentationGlyph } from './conversation-presentation.ts';
import { markdownDom } from './safe-markdown.ts';
import { outputPages } from './transcript-output.ts';
import { ReferenceResolver, referenceCandidates } from './references.ts';
import { TranscriptGroups, entryGroup } from './transcript-groups.ts';
import type { AgentRow, DisplayCoverage, EntryView, JsonDisplay, OutputPage, PartView, ReadingView } from '../shared/api.ts';

test('response diagnostics stay collapsed and stable while partial content stays readable', () => {
  setup(); const view = transcript();
  const message = {id: 'failure', role: 'assistant', state: 'final' as const, stopReason: 'error', error: 'Opaque diagnostic '.repeat(50), parts: [{type: 'text' as const, text: 'Retained partial content'}], coverage: {complete: true, truncated: false, omitted: 0}};
  const entry = {id: 'failure-entry', kind: 'message', messages: [message]}; view.set([entry]); flush();
  const root = node('primary-transcript'), diagnostic = root.querySelector('.message-error')?.querySelector('details'); assert.ok(diagnostic);
  assert.equal(diagnostic.open, false); assert.equal(root.querySelector('.response-error-summary')?.textContent, 'The response failed.');
  assert.match(root.textContent, /Retained partial content/); assert.equal(diagnostic.querySelector('pre')?.textContent, message.error);
  diagnostic.open = true; view.set([{...entry, messages: [{...message, error: 'Updated diagnostic'}]}]); flush();
  assert.equal(root.querySelector('.message-error')?.querySelector('details'), diagnostic); assert.equal(diagnostic.open, true);
  assert.equal(diagnostic.querySelector('pre')?.textContent, 'Updated diagnostic'); view.reset();
});
function rosterStatus(row: AgentRow) {
  const view = conversationPresentation({target: {kind: 'agent', identity: row.identity}, row, connected: true});
  return {label: view.activity, glyph: presentationGlyph(view), tool: view.tool};
}

type Handler = (event: Record<string, unknown>) => void;
class FakeNode {
  tagName: string;
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  dataset: Record<string, string> = {};
  style = {setProperty: (name: string, value: string) => { Reflect.set(this.style, name, value); },
    removeProperty: (name: string) => { const value = Reflect.get(this.style, name); Reflect.deleteProperty(this.style, name); return value ?? ''; }} as unknown as CSSStyleDeclaration;
  attributes: Record<string, string> = {};
  className = '';
  classList = {add: (name: string) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' '); },
    remove: (name: string) => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, force?: boolean): boolean => { const enabled = force ?? !this.className.split(' ').includes(name); if (enabled) this.classList.add(name); else this.classList.remove(name); return enabled; }};
  hidden = false;
  value = '';
  tabIndex = 0;
  title = '';
  href = '';
  rel = '';
  target = '';
  type = '';
  scope = '';
  clientHeight = 300;
  clientWidth = 600;
  clientTop = 0;
  clientLeft = 0;
  scrollTop = 0;
  measured?: number;
  writes = 0;
  moves = 0;
  private text = '';
  private opened = false;
  private handlers = new Map<string, Handler[]>();
  constructor(tag: string) { this.tagName = tag; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.writes++; this.replaceChildren(); this.text = value; }
  set innerHTML(_value: string) { throw new Error('HTML must never be assigned'); }
  get open(): boolean { return this.opened; }
  set open(value: boolean) { this.opened = value; }
  get childNodes(): FakeNode[] {
    if (this.tagName !== '#text' && this.text) {
      const text = new FakeNode('#text'); text.textContent = this.text; this.text = ''; this.append(text);
    }
    return this.children;
  }
  get parentElement(): FakeNode | null { return this.parentNode; }
  get ownerDocument() { return fakeDocument; }
  get nodeType(): number { return this.tagName === '#text' ? 3 : this.tagName === '#fragment' ? 11 : 1; }
  get offsetWidth(): number { return this.clientWidth; }
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  get firstElementChild(): FakeNode | null { return this.children.find(child => child.nodeType === 1) ?? null; }
  get lastElementChild(): FakeNode | null { return this.children.at(-1) ?? null; }
  get nextSibling(): FakeNode | null {
    const peers = this.parentNode?.children ?? []; return peers[peers.indexOf(this) + 1] ?? null;
  }
  get offsetHeight(): number {
    if (this.hidden) return 0;
    if (this.style.height) return Number.parseFloat(this.style.height);
    if (this.measured !== undefined) return this.measured;
    if (this.classList.contains('entry')) return 140;
    if (this.className === 'agent-row') return 20;
    return 20;
  }
  get offsetTop(): number {
    const peers = this.parentNode?.children ?? [];
    return (this.parentNode?.offsetTop ?? 0) + peers.slice(0, peers.indexOf(this)).reduce((sum, node) => sum + node.offsetHeight, 0);
  }
  get scrollHeight(): number { return this.children.reduce((sum, child) => sum + child.offsetHeight, 0); }
  get isConnected(): boolean { return roots.includes(this) || !!this.parentNode?.isConnected; }
  contains(node: FakeNode | null): boolean { return !!node && (node === this || this.children.some(child => child.contains(node))); }
  append(...nodes: FakeNode[]): void { for (const node of nodes) this.insert(node, this.children.length); }
  prepend(...nodes: FakeNode[]): void { nodes.slice().reverse().forEach(node => { this.insert(node, 0); }); }
  get previousElementSibling(): FakeNode | null { const peers = this.parentNode?.children ?? []; return peers[peers.indexOf(this) - 1] ?? null; }
  insertBefore(node: FakeNode, anchor: FakeNode | null): FakeNode { this.insert(node, anchor ? this.children.indexOf(anchor) : this.children.length); return node; }
  before(node: FakeNode): void { this.parentNode?.insert(node, this.parentNode.children.indexOf(this)); }
  dispatchEvent(event: Event): boolean { this.dispatch(event.type); if (event.bubbles) this.parentNode?.dispatchEvent(event); return true; }
  after(node: FakeNode): void { this.parentNode?.insert(node, this.parentNode.children.indexOf(this) + 1); }
  private insert(node: FakeNode, index: number): void {
    if (node.tagName === '#fragment') { for (const child of [...node.children]) this.insert(child, index++); return; }
    if (node.parentNode === this && this.children.indexOf(node) < index) index--;
    node.remove(); node.parentNode = this; this.children.splice(index, 0, node); node.moves++;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceChildren(...nodes: FakeNode[]): void { for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...nodes); }
  setAttribute(key: string, value: string): void { this.attributes[key] = value; if (key === 'class') this.className = value; }
  removeAttribute(key: string): void { delete this.attributes[key]; }
  hasAttribute(key: string): boolean { return Object.hasOwn(this.attributes, key); }
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  removeEventListener(name: string, handler: Handler): void { this.handlers.set(name, (this.handlers.get(name) ?? []).filter(item => item !== handler)); }
  dispatch(name: string, event: Record<string, unknown> = {}): void { for (const handler of this.handlers.get(name) ?? []) handler({target: this, ...event}); }
  closest(selector: string): FakeNode | null { return matches(this, selector) ? this : this.parentNode?.closest(selector) ?? null; }
  querySelector(selector: string): FakeNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    for (const node of this.children) {
      if (matches(node, selector)) found.push(node);
      found.push(...node.querySelectorAll(selector));
    }
    return found;
  }
  getBoundingClientRect(): {top: number; bottom: number; left: number; right: number; width: number; height: number} {
    return {top: this.offsetTop, bottom: this.offsetTop + this.offsetHeight, left: 0, right: this.clientWidth, width: this.clientWidth, height: this.offsetHeight};
  }
  click(): void { this.dispatch('click'); }
  focus(): void {
    fakeDocument.activeElement = this;
    for (let node: FakeNode | null = this; node; node = node.parentNode) node.dispatch('focusin', {target: this});
  }
}
function matches(node: FakeNode, selector: string): boolean {
  if (selector.includes(',')) return selector.split(',').some(part => matches(node, part.trim()));
  if (selector.startsWith('.')) return node.className.split(' ').includes(selector.slice(1));
  if (selector === 'details[open]') return node.tagName === 'details' && node.open;
  if (selector === '[data-disclosure]') return !!node.dataset.disclosure;
  return node.tagName === selector;
}
let roots: FakeNode[] = [];
let frames: FrameRequestCallback[] = [];
let selection: {isCollapsed: boolean; anchorNode: FakeNode | null; focusNode: FakeNode | null; toString?: () => string} | null = null;
const ids = new Map<string, FakeNode>();
const documentHandlers = new Map<string, Handler[]>();
const fakeDocument = {
  activeElement: null as FakeNode | null,
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeNode(tag),
  createDocumentFragment: () => new FakeNode('#fragment'),
  createTextNode: (value: string) => { const node = new FakeNode('#text'); node.textContent = value; return node; },
  getElementById: (id: string) => ids.get(id),
  getSelection: () => selection,
  addEventListener: (name: string, handler: Handler) => { documentHandlers.set(name, [...documentHandlers.get(name) ?? [], handler]); },
  removeEventListener: (name: string, handler: Handler) => { documentHandlers.set(name, (documentHandlers.get(name) ?? []).filter(item => item !== handler)); },
  dispatch: (name: string, event: Record<string, unknown> = {}) => { for (const handler of documentHandlers.get(name) ?? []) handler(event); },
};
function setup(): void {
  roots = []; frames = []; ids.clear(); documentHandlers.clear(); selection = null; fakeDocument.activeElement = null;
  for (const id of ['primary-transcript', 'primary-latest', 'agent-transcript', 'agent-latest', 'roster', 'agent-search', 'roster-footer', 'announcements', 'primary-editor']) {
    const node = new FakeNode('div'); ids.set(id, node); roots.push(node);
  }
  Reflect.deleteProperty(fakeDocument, 'caretPositionFromPoint'); Reflect.deleteProperty(fakeDocument, 'createRange');
  Object.assign(globalThis, {document: fakeDocument, HTMLElement: FakeNode, requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }});
}
function flush(): void { const pending = frames; frames = []; for (const frame of pending) frame(0); }
function node(id: string): FakeNode { const value = ids.get(id); assert.ok(value); return value; }
const coverage: DisplayCoverage = {complete: true, truncated: false, omitted: 0};
function message(id: string, text: string, state: 'partial' | 'final' = 'final') {
  return {id, role: 'assistant', state, parts: [{type: 'text' as const, text}], coverage};
}
function entry(id: string, text = id) { return {id, kind: 'message', messages: [message(`m-${id}`, text)]}; }
class Transcript extends RetainedTranscript {
  constructor(prefix: 'primary' | 'agent', hooks: ConstructorParameters<typeof RetainedTranscript>[1]) {
    super({transcript: node(`${prefix}-transcript`) as unknown as HTMLElement, latest: node(`${prefix}-latest`) as unknown as HTMLElement, earlier: ids.get(`${prefix}-earlier`) as unknown as HTMLElement | undefined}, hooks);
  }
}
function transcript() { return new Transcript('primary', {presentation: () => {}, reading: () => {}}); }
function row(identity: string, name?: string) {
  return {identity, name, storageId: identity, cwd: '/project', modifiedAt: 0, state: 'working', availability: 'live' as const, owner: 'here' as const, partial: false};
}

test('hidden conversations skip queued paints, restore and reading writes until reveal', () => {
  setup(); const section = new FakeNode('section'); section.className = 'conversation'; roots.push(section);
  const container = node('primary-transcript'); section.append(container);
  const saved: import('../shared/api.ts').ReadingView[] = [];
  const view = new Transcript('primary', {presentation: () => {}, reading: value => saved.push(value)});
  const entries = Array.from({length: 40}, (_, i) => entry(`e${i}`));
  view.configure(undefined, {revision: 3, anchorId: 'e10', offsetPx: 33, followTail: false}); view.set(entries);
  section.hidden = true; flush(); assert.equal(container.children.length, 0);
  container.dispatch('scroll'); container.dispatch('scrollend');
  view.restore({revision: 4, anchorId: 'e20', offsetPx: 0, followTail: false}); flush();
  assert.deepEqual([...saved], []); assert.equal(container.scrollTop, 0);
  section.hidden = false; view.set(entries); flush();
  const target = container.children.find(child => child.dataset.entryId === 'e10'); assert.ok(target);
  assert.equal(container.scrollTop, target.offsetTop - container.offsetTop + 33);
  container.dispatch('scrollend'); assert.equal(saved[0]?.anchorId, 'e10'); assert.equal(saved[0]?.offsetPx, 33); assert.equal(saved[0]?.followTail, false);
  const position = container.scrollTop; view.set(entries); section.hidden = true; flush();
  container.dispatch('scrollend'); assert.equal(saved.length, 1); assert.equal(container.scrollTop, position);
  section.hidden = false; view.set(entries); flush(); assert.equal(container.scrollTop, position);
});
test('transcript bursts construct and index only the latest source on one frame', () => {
  setup(); const view = transcript(); const stable = entry('stable'); view.set([stable]); flush();
  const retained = node('primary-transcript').children[0]; let builds = 0; let latest = 0;
  for (let delta = 1; delta <= 20; delta++) {
    latest = delta;
    view.defer(() => { builds++; view.set([stable, entry('tail', String(latest))]); });
  }
  assert.equal(builds, 0); assert.equal(frames.length, 1); assert.equal(node('primary-transcript').children.length, 1);
  flush(); assert.equal(builds, 1); assert.equal(node('primary-transcript').children[0], retained);
  assert.equal(node('primary-transcript').children[1]?.textContent.includes('20'), true);
  view.defer(() => { builds++; view.set([entry('stale')]); }); view.reset(); flush();
  assert.equal(builds, 1); assert.equal(node('primary-transcript').children.length, 0);
  view.defer(() => { builds++; view.set([entry('stale')]); }); view.set([entry('current')]); flush();
  assert.equal(builds, 1); assert.equal(node('primary-transcript').children[0]?.dataset.entryId, 'current'); view.reset();
});
test('deferred sources block old message and original Copy until the current frame commits', async () => {
  setup(); const view = transcript(); const writes: string[] = []; const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => {writes.push(text);}}}});
  try {
    const source = communicationEntry(); view.set([source]); flush();
    const card = node('primary-transcript').querySelector('.communication-card'); const inspection = card?.querySelector('.message-source');
    const menu = card?.querySelector('.message-menu'); assert.ok(card); assert.ok(inspection); assert.ok(menu);
    const messageCopy = messageAction(card, 'Copy'); assert.ok(messageCopy.run);
    assert.equal(inspection.hidden, true); assert.equal(Reflect.get(inspection, 'inert'), true);
    messageAction(card, 'Source').run?.(); node('primary-editor').focus(); flush();
    assert.equal(inspection.hidden, false); assert.equal(Reflect.get(inspection, 'inert'), false);
    const originalCopy = inspection.querySelector('.copy'); assert.ok(originalCopy);
    view.defer(() => view.set([source])); messageCopy.run(); originalCopy.click(); await Promise.resolve(); assert.deepEqual(writes, []);
    flush(); messageCopy.run(); originalCopy.click(); await Promise.resolve(); assert.deepEqual(writes, ['Actual contribution', 'Original transport paragraph']);
    const changed = communicationEntry('ready', 'Latest contribution'); const changedMessage = changed.messages?.[0]; assert.ok(changedMessage); changedMessage.parts = [{type: 'text', text: 'Latest transport'}];
    view.defer(() => view.set([changed])); messageCopy.run(); originalCopy.click(); await Promise.resolve(); assert.equal(writes.length, 2);
    flush(); assert.equal(node('primary-transcript').querySelector('.communication-card'), card); assert.equal(card.querySelector('.message-source'), inspection);
    assert.equal(card.querySelector('.message-menu'), menu); assert.equal(inspection.querySelector('.copy'), originalCopy);
    messageAction(card, 'Copy').run?.(); originalCopy.click(); await Promise.resolve(); assert.deepEqual(writes.slice(2), ['Latest contribution', 'Latest transport']);
  } finally { view.reset(); if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
test('final message DOM stays stable and only the changed partial text updates', () => {
  setup(); const view = transcript(); const first = entry('one'); const second = {id: 'two', kind: 'message', messages: [message('m-two', 'a', 'partial')]};
  const editor = node('primary-editor'); editor.value = 'untouched draft';
  view.set([first, second]); flush();
  const stable = node('primary-transcript').children[0]; const text = node('primary-transcript').querySelector('.stream-text'); assert.ok(stable); assert.ok(text);
  const finalParagraph = stable.querySelector('p'); assert.ok(finalParagraph); const writes = finalParagraph.writes; const moves = stable.moves;
  view.set([first, {...second, messages: [message('m-two', 'ab', 'partial')]}]); flush();
  assert.equal(node('primary-transcript').children[0], stable); assert.equal(stable.moves, moves); assert.equal(finalParagraph.writes, writes);
  assert.equal(node('primary-transcript').querySelector('.stream-text'), text); assert.equal(text.textContent, 'ab'); assert.equal(editor.value, 'untouched draft');
  view.set([first, {...second, messages: [message('m-two', '**final**')]}]); flush(); assert.equal(text.querySelector('strong')?.textContent, 'final');
});
test('the earlier-history control stays the first line inside the scroller across paints and resets', () => {
  setup(); const earlier = new FakeNode('button'); ids.set('primary-earlier', earlier);
  const view = transcript(); view.set([entry('one'), entry('two')]); flush();
  const container = node('primary-transcript'); assert.equal(container.children[0], earlier);
  view.set([entry('one'), entry('two'), entry('three')]); flush(); assert.equal(container.children[0], earlier);
  assert.equal(container.children.filter(child => child === earlier).length, 1);
  view.reset(); assert.equal(earlier.isConnected, true); assert.equal(container.children[0], earlier);
  view.set([entry('new')]); assert.equal(earlier.isConnected, true); flush(); assert.equal(container.children[0], earlier);
  view.set(Array.from({length: 30}, (_, index) => entry(`e${index}`))); flush();
  container.scrollTop = 0; container.dispatch('scroll'); flush();
  assert.equal(container.scrollTop, 0, 'reaching the top keeps the earlier control in view instead of snapping to the first entry');
});
test('CSS geometry adoption keeps current cards and anchor and rejects an old lifetime', () => {
  setup(); const view = transcript(); view.set(Array.from({length: 30}, (_, index) => entry(`css-${index}`))); flush();
  const root = node('primary-transcript'); root.scrollTop = 400; root.dispatch('scroll'); flush();
  const saved = view.captureGeometry(), anchor = root.children.find(child => child.dataset.entryId === saved.anchor?.id); assert.ok(saved.anchor); assert.ok(anchor);
  const offset = root.scrollTop - anchor.offsetTop; const moves = anchor.moves;
  view.applyGeometry(saved); assert.equal(root.children.find(child => child.dataset.entryId === saved.anchor?.id), anchor);
  assert.equal(root.scrollTop - anchor.offsetTop, offset); assert.equal(anchor.moves, moves);
  view.reset(); view.set([entry('new-lifetime')]); flush(); const before = root.scrollTop;
  view.applyGeometry(saved); assert.equal(root.scrollTop, before); assert.equal(root.children.some(child => child.dataset.entryId === 'css-2'), false);
});
test('the final earlier page hides its control without shifting the current reading offset', () => {
  setup(); const earlier = new FakeNode('button'); ids.set('primary-earlier', earlier);
  const view = transcript(); view.set(Array.from({length: 30}, (_, index) => entry(`e${index}`))); flush();
  const root = node('primary-transcript'); root.scrollTop = 400; root.dispatch('scroll'); flush();
  const anchor = root.children.find(child => child.dataset.entryId && child.offsetTop <= root.scrollTop && child.offsetTop + child.offsetHeight > root.scrollTop); assert.ok(anchor);
  const offset = root.scrollTop - anchor.offsetTop;
  view.historyAvailable(false); assert.equal(earlier.hidden, true); assert.equal(root.scrollTop - anchor.offsetTop, offset);
  view.set([entry('older'), ...Array.from({length: 30}, (_, index) => entry(`e${index}`))]); flush();
  assert.equal(root.scrollTop - anchor.offsetTop, offset);
});

test('reset keeps both earlier controls connected and discoverable before the next animation frame', () => {
  for (const prefix of ['primary', 'agent'] as const) {
    setup(); const earlier = new FakeNode('button'); ids.set(`${prefix}-earlier`, earlier); node(`${prefix}-transcript`).append(earlier);
    const lookup = fakeDocument.getElementById;
    fakeDocument.getElementById = id => { const found = ids.get(id); return found?.isConnected ? found : undefined; };
    try {
      const view = new Transcript(prefix, {presentation: () => {}, reading: () => {}}); view.set([entry('old')]); flush();
      view.reset(); view.set([entry('new')]);
      assert.equal(earlier.isConnected, true); assert.equal(fakeDocument.getElementById(`${prefix}-earlier`), earlier);
      assert.equal(node(`${prefix}-transcript`).children[0], earlier); assert.equal(frames.length, 1);
      flush(); assert.equal(node(`${prefix}-transcript`).children[0], earlier);
    } finally { fakeDocument.getElementById = lookup; }
  }
});
test('native nested tool cards retain parent context without fabricated messages or start times', () => {
  setup(); const view = transcript();
  const tool: NonNullable<EntryView['tool']> = {callId: 'parent/child', name: 'read', taskId: 3, parentTaskId: 2, parentCallId: 'parent',
    status: 'running', arguments: {value: {path: 'notes.md'}, truncated: false}, parts: [{type: 'text', text: 'partial output'}],
    coverage: {complete: true, truncated: false, omitted: 0}};
  const nested = (value = tool): EntryView => ({id: 'live:tool:parent/child', kind: 'pi.tool-result', tool: value});
  view.set([nested()]); flush(); const root = node('primary-transcript'), card = root.querySelector('.tool-card'); assert.ok(card);
  assert.equal(root.querySelectorAll('.message').length, 0); assert.equal(root.querySelectorAll('.session-events').length, 0);
  assert.equal(card.querySelector('.tool-name')?.textContent, 'read'); assert.equal(card.querySelector('.tool-target')?.textContent, 'notes.md');
  assert.equal(card.querySelector('.tool-status')?.textContent, 'Working'); assert.equal(card.querySelector('.tool-secondary')?.textContent, 'Within parent');
  assert.match(card.textContent, /partial output/); assert.doesNotMatch(card.textContent, /elapsed|ms/);
  view.set([nested({...tool, status: 'done', isError: true, durationMs: 7})]); flush();
  assert.equal(root.querySelector('.tool-card'), card); assert.equal(card.querySelector('.tool-status')?.textContent, 'Error');
  assert.equal(card.querySelector('.tool-secondary')?.textContent, 'Within parent · 7 ms');
  view.set([]); flush(); assert.equal(root.querySelector('.tool-card'), null);
});
for (const status of ['pending', 'done'] as const) test(`empty native ${status} cards do not invent successful completion`, () => {
  setup(); const view = transcript();
  const tool: NonNullable<EntryView['tool']> = {callId: 'parent/child', name: 'custom', taskId: 3, parentTaskId: 2, parentCallId: 'parent',
    status, arguments: {value: {}, truncated: false}, coverage: {complete: true, truncated: false, omitted: 0}};
  view.set([{id: 'live:tool:parent/child', kind: 'pi.tool-result', tool}]); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  assert.equal(card.querySelector('.tool-status')?.textContent, status === 'pending' ? 'Pending' : 'Ended');
  card.open = true; card.dispatch('toggle'); flush();
  assert.match(card.textContent, status === 'pending' ? /The tool has not started\./ : /The tool ended\. No outcome is available\./);
  assert.doesNotMatch(card.textContent, /completed without output|success|Success/);
});
test('native running tool cards retain their block and details before the result arrives', () => {
  setup(); const view = transcript(); const source: EntryView = {id: 'native-call', kind: 'pi.assistant', messages: [{...message('native-call', '', 'final'),
    parts: [{type: 'toolCall', callId: 'read-current', name: 'read', arguments: {value: {path: 'notes.md'}, truncated: false}}]}]};
  view.set([source], new Map([['read-current', {callId: 'read-current', name: 'read', phase: 'update', nativeStatus: 'running'}]])); flush();
  const root = node('primary-transcript'), shell = root.querySelector('.tool-shell'), card = shell?.querySelector('.tool-card'); assert.ok(shell); assert.ok(card);
  assert.equal(shell.dataset.status, 'working'); assert.equal(card.querySelector('.tool-status')?.textContent, 'Working'); assert.doesNotMatch(card.textContent, /No result recorded/);
  card.open = true; card.dispatch('toggle'); flush(); assert.match(card.querySelector('.tool-output-text')?.textContent ?? '', /Working/);
  assert.ok(card.querySelector('.tool-arguments')); assert.ok(card.querySelectorAll('summary').some(item => item.textContent === 'Details'));
  view.set([source], new Map([['read-current', {callId: 'read-current', name: 'read', phase: 'update', nativeStatus: 'pending'}]])); flush();
  assert.equal(root.querySelector('.tool-card'), card); assert.equal(shell.dataset.status, 'pending'); assert.equal(card.querySelector('.tool-status')?.textContent, 'Queued');
  const output: EntryView = {id: 'native-result', kind: 'pi.tool-result', messages: [{...message('native-result', '', 'final'), role: 'toolResult',
    parts: [{type: 'toolResult', callId: 'read-current', name: 'read', isError: false, parts: [{type: 'text', text: 'Actual source output'}]}]}]};
  view.set([source, output], new Map()); flush(); assert.equal(root.querySelector('.tool-card'), card); assert.equal(shell.dataset.status, 'success');
  assert.match(card.textContent, /Actual source output/); assert.equal(card.open, true); view.reset();
});
test('callId joins call and results across entries with one bounded disclosure and raw output', () => {
  setup(); const view = transcript();
  const call = {type: 'toolCall' as const, callId: 'call-1', name: 'read', arguments: {value: {path: '/full/path', offset: 1, limit: 10}, truncated: false}};
  const result = {type: 'toolResult' as const, callId: 'call-1', name: 'read', isError: false, parts: [{type: 'text' as const, text: 'x'.repeat(5000)}]};
  const entries = [{id: 'call', kind: 'message', messages: [{...message('m-call', ''), parts: [call]}]}, {id: 'result', kind: 'message', messages: [{...message('m-result', ''), parts: [result]}]}];
  view.set(entries); flush(); const cards = node('primary-transcript').querySelectorAll('.tool-card'); assert.equal(cards.length, 1);
  const card = cards[0]; assert.ok(card); assert.equal(card.querySelector('.tool-name')?.textContent, 'read'); assert.equal(card.querySelector('.tool-target')?.textContent, '/full/path');
  assert.equal(card.querySelector('.tool-secondary')?.textContent, 'lines 1–10');
  assert.equal(card.parentNode?.dataset.status, 'success'); assert.equal(card.querySelector('.tool-tier')?.children[0], card.querySelector('.tool-name'));
  assert.equal(card.querySelector('.tool-status')?.attributes.role, undefined); assert.equal(card.querySelector('.tool-status')?.textContent, 'Done');
  assert.deepEqual(card.querySelector('.tool-tier')?.children.map(child=>child.className), ['tool-name','tool-status success']);
  assert.equal(card.querySelector('.tool-target')?.parentNode, card.querySelector('summary')); assert.equal(card.querySelector('.tool-status')?.querySelector('svg'), null);
  assert.doesNotMatch(card.textContent, /The tool completed without output\.|Working|Tool error/); assert.ok((card.querySelector('.tool-preview')?.textContent.length ?? Infinity) < 2000);
  assert.match(card.querySelector('.tool-preview')?.textContent ?? '', /…$/); assert.ok((card.querySelector('.tool-preview')?.textContent.length ?? Infinity) <= 1200);
  assert.equal(card.querySelector('.tool-preview')?.parentNode, card.querySelector('summary'));
  assert.equal(card.querySelectorAll('details').length, 0); card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('pre')?.textContent, 'x'.repeat(5000));
  const raw = card.querySelectorAll('details').find(node => node.querySelector('summary')?.textContent === 'Raw output');
  assert.ok(raw); raw.open = true; raw.dispatch('toggle'); assert.equal(raw.querySelector('pre')?.textContent, 'x'.repeat(5000));
  assert.equal(card.querySelector('summary')?.querySelectorAll('.card-icon-disclosure').length, 1); assert.equal(card.parentNode?.querySelectorAll('.tool-copy').length, 1);
  view.set(entries, new Map([['call-1', {callId: 'call-1', name: 'read', phase: 'end' as const, parts: [{type: 'text' as const, text: 'failure cause'}], isError: true}]])); flush();
  assert.equal(node('primary-transcript').querySelector('.tool-card'), card); assert.match(card.textContent, /failure cause/);
  assert.equal(card.querySelector('.tool-status')?.textContent, 'Error');
  assert.equal(card.parentNode?.dataset.status, 'error'); assert.match(card.querySelector('.tool-status')?.textContent ?? '', /Error/);
});
test('collapsed cards prefer supplied structured summaries and keep exact raw copy, timing and arguments', async () => {
  setup(); const view = transcript(); const raw = '{\n  "count": 2,\n  "valid": false\n}';
  const source = contentEntry('summary', {path: 'result.txt', offset: 40, limit: 8}, raw);
  const parts = source.messages[0]?.parts; assert.ok(parts);
  const call = parts.find(part => part.type === 'toolCall'); const result = parts.find(part => part.type === 'toolResult');
  assert.ok(call && result); call.name = 'read'; result.name = 'read';
  result.parts = [{type: 'text', text: raw, structured: {value: {count: 2, valid: false}, truncated: false}}];
  view.set([source], new Map([[call.callId, {callId: call.callId, name: 'read', phase: 'end', durationMs: 37}]])); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  assert.equal(card.querySelector('.tool-preview')?.textContent, 'count: 2 · valid: false');
  assert.equal(card.querySelector('.tool-secondary')?.textContent, 'lines 40–47 · 37 ms');
  assert.equal(card.querySelector('summary')?.querySelectorAll('.card-icon-disclosure').length, 1);
  const action = card.parentNode?.querySelector('.tool-copy'); assert.ok(action); const icon = action.querySelector('svg'); assert.ok(icon);
  let copied = ''; const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => { copied = text; }}}});
  try { action.dispatch('click', {stopPropagation() {}}); await Promise.resolve(); await Promise.resolve(); assert.equal(copied, raw); assert.equal(action.querySelector('svg'), icon); }
  finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
  card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('.tool-output-info')?.textContent, '');
  assert.ok(card.querySelector('.tool-arguments')); assert.ok(card.querySelector('.tool-raw-output')); view.reset();
});
test('a result before its call moves the same card to its call owner and removed parts disappear', () => {
  setup(); const view = transcript(); const result = {type: 'toolResult' as const, callId: 'x', name: 'custom', parts: [{type: 'text' as const, text: 'result'}], isError: false};
  const resultEntry = {id: 'result', kind: 'message', messages: [{...message('r', ''), parts: [result]}]};
  view.set([resultEntry]); flush(); const card = node('primary-transcript').querySelector('.tool-card');
  const call = {id: 'call', kind: 'message', messages: [{...message('c', ''), parts: [{type: 'toolCall' as const, callId: 'x', name: 'custom', arguments: {value: {}, truncated: false}}]}]};
  view.set([call, resultEntry]); flush(); assert.equal(node('primary-transcript').querySelector('.tool-card'), card);
  assert.equal(node('primary-transcript').children[0]?.contains(card), true);
  view.set([entry('call')]); flush(); assert.equal(node('primary-transcript').querySelector('.tool-card'), null);
});
test('joined result-only wrappers disappear while unmatched results, prose and errors remain', () => {
  setup(); const view = transcript();
  const result = {type: 'toolResult' as const, callId: 'joined', name: 'read', parts: [{type: 'text' as const, text: 'needle result'}], isError: false};
  const resultMessage = {...message('result-message', ''), role: 'toolResult', parts: [result]};
  const call = {id: 'call-owner', kind: 'message', messages: [{...message('call-message', ''), parts: [{type: 'toolCall' as const, callId: 'joined', name: 'read', arguments: {value: {}, truncated: false}}]}, {...resultMessage, id: 'same-entry-result'}]};
  const joined = {id: 'joined-result', kind: 'message', messages: [resultMessage]};
  view.set([call, joined]); flush(); const container = node('primary-transcript'); const card = container.querySelector('.tool-card');
  assert.equal(container.querySelectorAll('.message-actions').length, 1); assert.equal(container.children.length, 1);
  assert.doesNotMatch(container.textContent, /toolResult/); view.find().next('needle result'); assert.equal(fakeDocument.activeElement, null); assert.equal(container.children[0]?.classList.contains('find-current'), true);
  const unmatched = {id: 'unmatched', kind: 'message', messages: [{...resultMessage, id: 'unmatched-message', parts: [{...result, callId: 'unmatched'}]}]};
  const mixed = {id: 'mixed', kind: 'message', messages: [{...resultMessage, id: 'mixed-message', parts: [result, {type: 'text' as const, text: 'Preserved prose'}]}]};
  const error = {id: 'error', kind: 'message', messages: [{...resultMessage, id: 'error-message', error: 'Preserved cause'}]};
  view.set([call, joined, unmatched, mixed, error]); flush(); assert.equal(container.querySelectorAll('.message-actions').length, 4);
  assert.equal(container.querySelectorAll('.tool-card').length, 2); assert.match(container.textContent, /Preserved prose/); assert.match(container.textContent, /Preserved cause/);
  assert.equal(container.querySelector('.tool-card'), card);
  view.set([joined]); flush(); assert.equal(container.querySelectorAll('.message-actions').length, 1);
  assert.equal(container.querySelector('.tool-card'), card); assert.equal(container.querySelector('.message')?.attributes['aria-label'], 'Tool output message');
  assert.doesNotMatch(container.textContent, /toolResult/);
});
test('generic entries update, unknown entries remain inspectable, and expansion stays bounded', () => {
  setup(); const view = transcript(); const data = {value: {identity: 'full-identity', enabled: false, absent: null, nested: {huge: 'x'.repeat(100000)}}, truncated: true, omittedBytes: 7};
  view.set([{id: 'custom', kind: 'custom_kind', data}]); flush(); const custom = node('primary-transcript').children[0]; assert.ok(custom);
  assert.match(custom.textContent, /Custom kind/); assert.match(custom.textContent, /7 bytes/);
  assert.equal(custom.querySelectorAll('details').length, 2);
  const detail = custom.querySelector('details'); assert.ok(detail); assert.equal(detail.querySelector('pre'), null);
  detail.open = true; detail.dispatch('toggle'); assert.ok((detail.querySelector('pre')?.textContent.length ?? Infinity) < 66000);
  assert.match(detail.textContent, /false/); assert.match(detail.textContent, /null/);
  view.set([{id: 'custom', kind: 'custom_kind', data: {value: {identity: 'new'}, truncated: false}}, {id: 'unknown', kind: 'unrecognized'}]); flush();
  assert.equal(node('primary-transcript').children[0], custom);
  const events = custom.querySelector('.session-events'); assert.ok(events); events.open = true; events.dispatch('toggle');
  const updated = events.querySelector('details'); assert.ok(updated); updated.open = true; updated.dispatch('toggle');
  assert.match(updated.textContent, /new/); assert.match(node('primary-transcript').textContent, /Unrecognized/);
  assert.ok(structured({value: ['a'], truncated: false}));
});
test('thinking preference applies to new blocks and reset removes old tools and nodes', () => {
  setup(); const view = transcript(); view.configure({revision: 0, expanded: [], showThinking: true});
  view.set([{id: 'e', kind: 'message', messages: [{...message('m', ''), parts: [{type: 'thinking', text: 'secret', redacted: true}]}]}]); flush();
  const thinking = node('primary-transcript').querySelector('.thinking'); assert.ok(thinking); assert.equal(thinking.open, true); assert.match(thinking.textContent, /Thinking not available/); assert.doesNotMatch(thinking.textContent, /secret/);
  view.expandLoaded(false, false); flush(); assert.equal(thinking.open, false);
  view.reset(); flush(); assert.equal(node('primary-transcript').children.length, 0); view.set([entry('new')]); flush(); assert.doesNotMatch(node('primary-transcript').textContent, /Thinking/);
});
test('variable heights and distant focused pins retain internal gaps and restore the visible anchor', () => {
  setup(); const view = transcript(); const entries = Array.from({length: 220}, (_, index) => entry(`e${index}`));
  view.configure(undefined, {revision: 0, anchorId: 'e100', offsetPx: 12, followTail: false}); view.set(entries);
  view.restore({revision: 0, anchorId: 'e100', offsetPx: 12, followTail: false}); flush();
  const container = node('primary-transcript'); const anchored = container.children.find(child => child.dataset.entryId === 'e100'); assert.ok(anchored);
  const focused = container.children.find(child => child.dataset.entryId === 'e98'); assert.ok(focused); focused.focus(); focused.measured = 240;
  container.scrollTop = 0; container.dispatch('scroll'); flush();
  assert.equal(focused.isConnected, true); assert.ok(container.children.filter(child => child.className === 'spacer').length >= 2);
  const before = focused.offsetTop; assert.equal(before, 98 * 140);
  assert.ok(container.children.filter(child => child.className === 'entry').length < 40);
  selection = {isCollapsed: false, anchorNode: focused, focusNode: focused};
  view.set([entry('older'), ...entries]); flush(); assert.equal(focused.isConnected, true); assert.equal(fakeDocument.activeElement, focused);
  assert.equal(focused.offsetHeight, 240); assert.equal(focused.offsetTop, before + 140);
});
test('restoration clamps a saved offset after the anchored entry shrinks', () => {
  setup(); const view = transcript(); view.set([entry('one'), entry('two'), entry('three')]); flush();
  const target = node('primary-transcript').children.find(child => child.dataset.entryId === 'two'); assert.ok(target); target.measured = 50;
  view.restore({revision: 0, anchorId: 'two', offsetPx: 120, followTail: false}); flush();
  assert.equal(node('primary-transcript').scrollTop, target.offsetTop + 49);
});
test('find mounts a loaded virtual match without focus and restore works outside the current window', () => {
  setup(); const view = transcript(); view.set(Array.from({length: 220}, (_, i) => entry(`e${i}`, `text ${i}`))); flush();
  view.find().next('text 7'); const found = node('primary-transcript').children.find(child => child.dataset.entryId === 'e7'); assert.ok(found);
  assert.equal(fakeDocument.activeElement, null); assert.equal(found.classList.contains('find-current'), true); assert.equal(node('primary-transcript').scrollTop, found.offsetTop);
  view.restore({revision: 1, anchorId: 'e180', offsetPx: 33, followTail: false}); flush();
  const target = node('primary-transcript').children.find(child => child.dataset.entryId === 'e180'); assert.ok(target);
  assert.equal(node('primary-transcript').scrollTop, target.offsetTop + 33);
});
test('loaded Find visits distinct entries in both directions and does not wrap or focus an editor', () => {
  setup(); const view = transcript(); const root = node('primary-transcript'); const editor = node('primary-editor'); editor.value = 'Keep draft'; editor.focus();
  view.set(Array.from({length: 220}, (_, i) => entry(`e${i}`, i === 7 || i === 100 || i === 210 ? 'Needle needle' : 'other'))); flush();
  const find = view.find();
  assert.deepEqual(find.next('needle'), {total: 3, position: 1, moved: true, end: null});
  assert.equal(root.querySelector('.find-current')?.dataset.entryId, 'e7');
  assert.equal(find.next('needle').position, 2); assert.equal(root.querySelector('.find-current')?.dataset.entryId, 'e100');
  assert.equal(find.next('needle').position, 3); assert.equal(root.querySelector('.find-current')?.dataset.entryId, 'e210');
  assert.deepEqual(find.next('needle'), {total: 3, position: 3, moved: false, end: 'last'});
  assert.equal(find.previous('needle').position, 2); assert.equal(find.previous('needle').position, 1);
  assert.deepEqual(find.previous('needle'), {total: 3, position: 1, moved: false, end: 'first'});
  assert.equal(fakeDocument.activeElement, editor); assert.equal(editor.value, 'Keep draft'); assert.equal(view.captureGeometry().followTail, false);
  find.close(); assert.equal(root.querySelector('.find-current'), null); assert.equal(view.captureGeometry().followTail, false);
  assert.equal(find.next('needle').end, 'unavailable');
});
test('Find recomputes loaded coverage and keeps the current identity across Earlier, append, grouping and geometry', () => {
  setup(); const view = transcript(); const rows = [entry('one', 'match'), entry('two', 'match'), entry('tail', 'other')];
  view.set(rows); flush(); const find = view.find(); assert.equal(find.next('match').position, 1);
  view.set([entry('earlier', 'match'), ...rows, entry('new', 'match')]); flush();
  assert.deepEqual(find.next('match'), {total: 4, position: 3, moved: true, end: null});
  const saved = view.captureGeometry(); view.setView('grouped'); view.applyGeometry(saved); flush();
  assert.equal(node('primary-transcript').querySelector('.find-current')?.dataset.entryId, 'two');
  assert.deepEqual(find.previous('match'), {total: 4, position: 2, moved: true, end: null});
  view.setView('chronological'); flush(); assert.equal(find.previous('match').position, 1);
  assert.equal(find.next('other').total, 1); assert.equal(node('primary-transcript').querySelector('.find-current')?.dataset.entryId, 'tail');
  find.reset(); assert.equal(node('primary-transcript').querySelector('.find-current'), null);
  assert.equal(find.next('match').position, 1);
});
test('Find no-match leaves reading and focus unchanged and stale target/reset sessions never search replacements', () => {
  setup(); const view = transcript(); view.set([entry('same', 'original')]); flush();
  const geometry = view.captureGeometry(), root = node('primary-transcript'), children = [...root.children];
  const find = view.find(); assert.deepEqual(find.next('absent'), {total: 0, position: 0, moved: false, end: 'none'});
  assert.deepEqual(view.captureGeometry(), geometry); assert.deepEqual(root.children, children); assert.equal(fakeDocument.activeElement, null);
  view.reset(); view.set([entry('same', 'replacement')]); flush(); const replacement = view.captureGeometry();
  assert.equal(find.next('replacement').end, 'unavailable'); assert.deepEqual(view.captureGeometry(), replacement); assert.equal(root.querySelector('.find-current'), null);
  let active = true; const guarded = view.find(() => active); guarded.next('replacement'); active = false;
  assert.equal(guarded.next('replacement').end, 'unavailable'); assert.equal(root.querySelector('.find-current'), null);
  const fresh = view.find(); fresh.next('replacement'); guarded.close(); assert.ok(root.querySelector('.find-current'));
  view.destroy(); assert.equal(fresh.next('replacement').end, 'unavailable');
});
test('Find distinguishes session members that share a virtual representative', () => {
  setup(); const view = transcript(); view.set(Array.from({length: 75}, (_, i) => sessionEntry(`s${i}`, `needle event ${i}`))); flush();
  const find = view.find(); find.next('needle');
  for (let index = 1; index < 40; index++) assert.equal(find.next('needle').position, index + 1);
  const root = node('primary-transcript'); assert.equal(root.querySelector('.find-current')?.dataset.sessionEventId, 's39');
  assert.equal(find.previous('needle').position, 39); assert.equal(root.querySelector('.find-current')?.dataset.sessionEventId, 's38');
});
test('roster preserves order, visible duplicate identities, keyed rows and data-arrival ages', () => {
  const modifiedAt = Date.UTC(2026, 9, 8, 12);
  setup(); const now = Date.now; let clock = modifiedAt + 600000; Date.now = () => clock;
  try {
    const selected: string[] = []; const view = new Roster(row => selected.push(row.identity), () => {}, undefined, undefined, rosterStatus); const one = {...row('one', 'same'), modifiedAt}; const two = row('two', 'same');
    view.set([one, two]); flush(); const first = node('roster').children[0]; assert.ok(first); const age = first.querySelector('time'); assert.equal(age?.textContent, '10m'); assert.match(first.querySelector('.row-select')?.attributes['aria-label'] ?? '', /one/);
    assert.equal(first.querySelector('.row-identity')?.textContent, '1');
    assert.equal(first.querySelector('.row-word'), null); assert.equal(first.querySelector('.row-detail'), null); assert.equal(first.dataset.live, 'true');
    assert.equal(first.querySelector('.row-model'), null); assert.equal(first.querySelector('.row-activity'), null);
    assert.equal(first.querySelector('.row-select')?.title, 'Connection not checked');
    assert.equal(first.querySelector('.row-select')?.attributes['aria-description'], 'Connection not checked');
    assert.equal(node('roster').children[1]?.querySelector('.row-identity')?.textContent, '2');
    clock = modifiedAt + 900000; view.set([two, one], undefined, 'two'); flush(); assert.equal(node('roster').children[0], first); assert.equal(age?.textContent, '10m');
    first.querySelector('.row-select')?.dispatch('click'); assert.deepEqual(selected, ['one']);
    view.set([{...one, latestReply: 'new'}, two]); flush(); assert.equal(node('roster').children[0], first); assert.equal(age?.textContent, '15m');
    assert.equal(first.querySelector('.row-select')?.title, 'Connection not checked · new');
    first.querySelector('.row-age')?.dispatch('click'); assert.doesNotMatch(age?.textContent ?? '', /ago/);
  } finally { Date.now = now; }
});
test('roster older scope and in-place filter keep the keyed row and focus', () => {
  setup(); const view = new Roster(() => {}, () => {}, undefined, undefined, rosterStatus);
  const old = {...row('old', 'Older'), state: 'done', availability: 'stored' as const};
  view.set([row('live', 'Live'), old], {stale: false, scan: {state: 'ready', complete: true, visited: 2, skipped: 0, omitted: 0}}); flush();
  const container = node('roster'); const older = container.querySelector('.roster-older'); assert.equal(older?.textContent, 'Show 1 older agent');
  assert.equal(node('roster-footer').hidden, true); assert.equal(node('agent-search').hidden, false);
  older?.dispatch('click'); assert.equal(older?.textContent, 'Hide older agents');
  const oldSelect = container.children.find(child => child.dataset.identity === 'old')?.querySelector('.row-select'); assert.ok(oldSelect);
  older?.dispatch('click'); assert.equal(oldSelect.isConnected, false);
  const liveSelect = container.querySelector('.row-select'); assert.ok(liveSelect); liveSelect.focus();
  container.dispatch('keydown', {key: 'O', preventDefault: () => {}});
  assert.equal(node('agent-search').hidden, false); assert.equal(fakeDocument.activeElement, node('agent-search'));
  assert.equal(container.querySelector('.row-select'), oldSelect); assert.equal(container.querySelector('.roster-older'), null);
  node('agent-search').dispatch('keydown', {key: 'Escape', preventDefault: () => {}, stopPropagation: () => {}});
  assert.equal(node('agent-search').hidden, false); assert.equal(fakeDocument.activeElement, container);
  assert.equal(container.querySelector('.roster-older'), older);
});
test('roster empty states distinguish discovery, loading, failure and successful emptiness', () => {
  setup(); const actions: Array<string | undefined> = []; const view = new Roster(() => {}, action => actions.push(action), undefined, undefined, rosterStatus);
  const scan = {state: 'not-started' as const, complete: false, visited: 0, skipped: 0, omitted: 0};
  view.set([], {scan, stale: false}); flush(); assert.equal(node('roster').textContent, 'Agents are not loaded.');
  const empty = node('roster').children[0]; const refresh = node('roster-footer').querySelector('button'); assert.equal(refresh?.textContent, 'Refresh agents'); refresh?.dispatch('click');
  assert.doesNotMatch(node('roster-footer').textContent, /0 loaded|more/);
  view.set([], {scan: {...scan, state: 'running'}, stale: false}); flush(); assert.equal(node('roster').children[0], empty);
  assert.equal(node('roster').textContent, 'Loading agents…'); assert.equal(node('roster-footer').querySelector('button'), null); assert.equal(node('roster-footer').hidden, false);
  view.set([], {scan: {...scan, state: 'failed'}, stale: false, error: {code: 'catalog', message: 'Record unreadable', retry: 'read'}}); flush();
  assert.equal(node('roster').textContent, 'Agents could not be loaded.');
  assert.equal(node('roster-footer').querySelector('details')?.textContent, 'DetailsRecord unreadable');
  const retry = node('roster-footer').querySelector('button'); assert.equal(retry?.attributes['aria-label'], 'Refresh agents'); retry?.dispatch('click');
  view.set([], {scan: {...scan, state: 'ready', complete: true}, stale: false}); flush();
  assert.equal(node('roster').textContent, 'No agents in this view'); assert.equal(node('roster-footer').querySelector('button'), null);
  assert.equal(node('roster-footer').hidden, true); assert.equal(node('roster-footer').textContent, '');
  assert.deepEqual(actions, ['refresh', 'refresh']);
});
test('roster more uses cached page cursors independently from scan completeness', () => {
  setup(); const actions: Array<string | undefined> = []; const view = new Roster(() => {}, action => actions.push(action), undefined, undefined, rosterStatus);
  const scan = {state: 'ready' as const, complete: true, visited: 2, skipped: 0, omitted: 0};
  view.set([row('one')], {scan, stale: false, nextCursor: 'page-2'}); flush();
  const more = node('roster').querySelector('.roster-more'); assert.equal(more?.textContent, 'More agents'); assert.equal(node('roster').lastElementChild, more);
  assert.equal(node('roster-footer').hidden, true); assert.equal(node('roster').querySelector('.roster-older'), null); more?.dispatch('click');
  view.set([], {scan: {...scan, complete: false, scanId: 'scan-2'}, stale: false, nextCursor: null}); flush();
  const continuation = node('roster').querySelector('.roster-more'); assert.equal(continuation, more); assert.equal(continuation?.textContent, 'Load more agents'); continuation?.dispatch('click');
  view.set([], {scan: {...scan, complete: false}, stale: false}); flush(); assert.equal(node('roster-footer').querySelector('button'), null); assert.equal(node('roster').querySelector('.roster-more'), null);
  view.set([row('one')], {scan: {...scan, state: 'failed'}, stale: true, nextCursor: 'page-2'}); flush();
  const buttons = node('roster-footer').querySelectorAll('button'); assert.deepEqual(buttons.map(button => button.attributes['aria-label']), ['Refresh agents']);
  node('roster').querySelector('.roster-more')?.dispatch('click'); buttons[0]?.dispatch('click'); assert.deepEqual(actions, ['more', 'more', 'more', 'refresh']);
});
test('roster virtual rows retain selected/focused pins, internal gaps and measured heights', () => {
  setup(); const view = new Roster(() => {}, () => {}, undefined, undefined, rosterStatus); const rows = Array.from({length: 220}, (_, i) => row(`full-identity-${i}`));
  view.set(rows, undefined, 'full-identity-200'); flush(); const container = node('roster'); const pinned = container.children.find(child => child.dataset.identity === 'full-identity-200'); assert.ok(pinned);
  pinned.measured = 250; pinned.focus(); view.set(rows, undefined, 'full-identity-0'); flush();
  assert.equal(pinned.isConnected, true); assert.equal(fakeDocument.activeElement, pinned); assert.equal(pinned.offsetHeight, 250);
  assert.equal(pinned.offsetTop, 200 * 20); assert.ok(container.children.filter(child => child.className === 'spacer').length >= 2);
  assert.ok(container.children.filter(child => child.className === 'agent-row').length <= 77);
});
test('fork appears only at finalized retained user entries and sends the retained entry ID', () => {
  setup(); const forks: string[] = []; const view = new Transcript('primary', {presentation: () => {}, reading: () => {}, fork: (_message, id) => forks.push(id)});
  const user = {...message('user', 'request'), role: 'user'};
  const entries = [
    {id: 'retained', kind: 'message', messages: [user]},
    {id: 'message:user', kind: 'message', messages: [user]},
    {id: 'live:user', kind: 'message', messages: [user]},
    {id: 'custom', kind: 'custom', messages: [user]},
    {id: 'partial', kind: 'message', messages: [{...user, state: 'partial' as const}]},
  ];
  view.set(entries); flush();
  const container = node('primary-transcript'); const previous = contextMenu.open; let items: import('./context-menu.ts').ContextItem[] = [];
  contextMenu.open = (_origin, _point, _title, values) => { items = values; };
  try {
    const forksInMenus = container.querySelectorAll('.message').flatMap(card => {
      const menu = card.querySelector('.message-menu'); assert.ok(menu); menu.click(); return items.filter(item => item.label === 'Fork');
    });
    assert.equal(forksInMenus.length, 1); const old = forksInMenus[0]; assert.ok(old);
    const unrelated = {id: 'unrelated', kind: 'message', messages: [message('unrelated', 'Stream progress', 'partial')]};
    view.set([...entries, unrelated, contentEntry('unrelated-tool', {}, 'Other retained output')]); flush();
    old.run(); assert.deepEqual(forks, ['retained']);
    assert.equal(container.querySelectorAll('button').filter(button => button.textContent === 'Fork').length, 0);
    view.set([{...entries[0], kind: 'custom'}]); old.run(); assert.deepEqual(forks, ['retained']);
    view.set([{...entries[0], messages: [{...user, state: 'partial'}]}]); flush();
    const menu = container.querySelector('.message-menu'); assert.ok(menu); menu.click(); assert.equal(items.some(item => item.label === 'Fork'), false);
    old.run(); assert.deepEqual(forks, ['retained']);
    view.set([entries[0]]); flush(); old.run(); assert.deepEqual(forks, ['retained']);
    const article = container.querySelector('.message'); assert.ok(article); const current = messageAction(article, 'Fork'); current.run(); assert.deepEqual(forks, ['retained', 'retained']);
    container.classList.add('conversation'); container.hidden = true; current.run(); container.hidden = false; assert.deepEqual(forks, ['retained', 'retained']);
    view.set([]); flush(); current.run(); assert.deepEqual(forks, ['retained', 'retained']);
    view.set([entries[0]]); flush(); const resetArticle = container.querySelector('.message'); assert.ok(resetArticle); const reset = messageAction(resetArticle, 'Fork');
    view.reset(); reset.run(); container.append(resetArticle); assert.equal(resetArticle.isConnected, true); reset.run(); assert.deepEqual(forks, ['retained', 'retained']); view.reset();
  } finally { contextMenu.open = previous; view.reset(); }
});
test('loaded expansion applies to virtual unmounted cards and configure restores an agent anchor', () => {
  setup(); const view = new Transcript('agent', {presentation: () => {}, reading: () => {}});
  const entries = Array.from({length: 170}, (_, index) => ({id: `e${index}`, kind: 'message', messages: [{...message(`m${index}`, ''), parts: [{type: 'toolCall' as const, callId: `c${index}`, name: 'custom', arguments: {value: {}, truncated: false}}]}]}));
  view.configure(undefined, {revision: 0, anchorId: 'e100', offsetPx: 17, followTail: false}); view.set(entries); flush();
  const container = node('agent-transcript'); const target = container.children.find(child => child.dataset.entryId === 'e100'); assert.ok(target);
  assert.equal(container.scrollTop, target.offsetTop + 17);
  view.expandLoaded(true, true); flush(); assert.ok(container.querySelectorAll('.tool-card').length < 15);
  const preferences = view as unknown as {expanded: Set<string>}; assert.equal(preferences.expanded.size, 170);
  assert.equal(container.querySelectorAll('.tool-card').every(card => card.open), true);
});
function richEntries(count: number) {
  return Array.from({length: count}, (_, index) => ({id: `e${index}`, kind: 'message', messages: [{...message(`m${index}`, ''), parts: [
    {type: 'text' as const, text: `Body ${index}`}, {type: 'thinking' as const, text: `Thought ${index}`},
    {type: 'toolCall' as const, callId: `c${index}`, name: 'custom', arguments: {value: {index}, truncated: false}},
  ]}]}));
}
test('both batch controls keep full scrollback bounded and restore saved intent after eviction', () => {
  setup(); let saved: string[] = []; let showThinking = false;
  const view = new Transcript('primary', {reading: () => {}, presentation: (expanded, thinking) => { saved = expanded; showThinking = thinking; }});
  const entries = richEntries(240); view.configure(undefined, {revision: 0, anchorId: 'e0', offsetPx: 0, followTail: false}); view.set(entries); flush();
  const container = node('primary-transcript'); const firstCard = container.querySelector('.tool-card'); const firstThought = container.querySelector('.thinking');
  const retained = view as unknown as {cache: Map<string, unknown>; tools: Map<string, unknown>};
  const assertBounded = () => {
    const mounted = container.children.filter(child => child.dataset.entryId).length;
    assert.ok(mounted < 15); assert.ok(retained.cache.size <= mounted + 32); assert.ok(retained.tools.size <= retained.cache.size);
  };
  view.expandLoaded(true, true); flush(); assertBounded();
  assert.equal(saved.length, 240); assert.equal(container.querySelectorAll('.tool-card').every(card => card.open), true);
  view.expandLoaded(false, true); flush(); assertBounded(); assert.equal(saved.length, 480); assert.equal(showThinking, true);
  const scroll = (index: number) => {
    container.scrollTop = index * 140; container.dispatch('scroll'); flush(); assertBounded();
    assert.equal(container.querySelectorAll('.tool-card').every(card => card.open), true);
    assert.equal(container.querySelectorAll('.thinking').every(thought => thought.open), true);
    const row = container.children.find(child => child.dataset.entryId === `e${index}`); assert.ok(row);
    assert.match(row.textContent, new RegExp(`Body ${index}`)); assert.match(row.textContent, new RegExp(`Thought ${index}`));
  };
  for (let index = 0; index < 240; index += 5) scroll(index);
  assert.equal(retained.cache.has('e0'), false);
  for (let index = 235; index >= 0; index -= 5) scroll(index);
  assert.notEqual(container.querySelector('.tool-card'), firstCard); assert.notEqual(container.querySelector('.thinking'), firstThought);
  view.reset(); view.configure({revision: 0, expanded: saved, showThinking}); view.set(entries); flush(); assertBounded();
  assert.equal(container.querySelectorAll('.tool-card').every(card => card.open), true);
  assert.equal(container.querySelectorAll('.thinking').every(thought => thought.open), true);
});
test('batch controls preserve distant focus selection and deliberate inspection while other rows evict', () => {
  setup(); const view = transcript(); const entries = richEntries(240);
  view.configure(undefined, {revision: 0, anchorId: 'e100', offsetPx: 17, followTail: false}); view.set(entries); flush();
  const container = node('primary-transcript');
  const row = (id: string) => { const found = container.children.find(child => child.dataset.entryId === id); assert.ok(found); return found; };
  const focused = row('e99').querySelector('.tool-copy'); const selected = row('e101').querySelector('p'); assert.ok(focused); assert.ok(selected); focused.focus();
  selection = {isCollapsed: false, anchorNode: selected, focusNode: selected};
  view.expandLoaded(true, true); view.expandLoaded(false, true); flush();
  const card = row('e102').querySelector('.tool-card'); assert.ok(card); card.dispatch('toggle');
  const inspection = card.querySelectorAll('details').find(node => node.firstChild?.textContent === 'Arguments'); assert.ok(inspection);
  inspection.open = true; inspection.dispatch('toggle'); const inspectedText = inspection.querySelector('pre')?.textContent;
  for (const index of [0, 50, 150, 200, 0]) {
    container.scrollTop = index * 140; container.dispatch('scroll'); flush();
    assert.equal(focused.isConnected, true); assert.equal(fakeDocument.activeElement, focused); assert.equal(selected.isConnected, true);
    assert.equal(selection.anchorNode, selected); assert.equal(selection.focusNode, selected);
    assert.equal(inspection.isConnected, true); assert.equal(inspection.open, true); assert.equal(inspection.querySelector('pre')?.textContent, inspectedText);
    assert.ok(container.children.filter(child => child.dataset.entryId).length < 20);
  }
  const retained = view as unknown as {cache: Map<string, unknown>}; assert.equal(retained.cache.has('e100'), false);
  const mounted = container.children.filter(child => child.dataset.entryId).length; assert.ok(retained.cache.size <= mounted + 32);
});
test('Markdown creates inert HTML text, safe links, code, lists and aligned semantic tables', () => {
  setup(); const fragment = markdownDom('<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [good](https://example.test) ![image](https://example.test/a)\n\n3. item\n\n```ts\n<script>\n```\n\n| A | B |\n| :--- | ---: |\n| a | b |');
  assert.equal(fragment.querySelector('script'), null); assert.equal(fragment.querySelector('img'), null); assert.match(fragment.textContent, /<script>/);
  const links = fragment.querySelectorAll('a'); assert.equal(links.length, 1); assert.equal(links[0]?.rel, 'noopener noreferrer'); assert.equal(links[0]?.target, '_blank');
  assert.equal((fragment.querySelector('ol') as unknown as FakeNode | null)?.attributes.start, '3'); assert.equal(fragment.querySelector('th')?.scope, 'col');
  assert.equal(fragment.querySelectorAll('th')[1]?.style.textAlign, 'right'); assert.equal(fragment.querySelector('code')?.dataset.language, 'ts');
});

test('final fences highlight their language and streaming prose stays plain until final', () => {
  setup(); const view = transcript(); const text = '```ts\nconst value: number = 42;\n```';
  view.set([{id: 'code', kind: 'message', messages: [message('code', text, 'partial')]}]); flush();
  assert.equal(node('primary-transcript').querySelector('.syn-keyword'), null);
  view.set([{id: 'code', kind: 'message', messages: [message('code', text, 'final')]}]); flush();
  assert.equal(node('primary-transcript').querySelector('.syn-keyword')?.textContent, 'const');
  assert.equal(node('primary-transcript').querySelector('code')?.textContent, 'const value: number = 42;');
});
test('expanded completed reads highlight initial output and retained pages but live and error output stay plain', async () => {
  setup(); const text = 'const value = 42;'; const pageText = 'return 24;';
  const view = new Transcript('primary', {presentation: () => {}, reading: () => {}, output: async more => ({entryId: more.entryId, part: more.part, text: pageText, nextOffset: null, totalBytes: more.offset + pageText.length})});
  const call = {type: 'toolCall' as const, callId: 'read', name: 'read', arguments: {value: {path: 'source.ts'}, truncated: false}};
  const entries = [{id: 'read', kind: 'message', messages: [{...message('read', ''), parts: [call]}]}];
  const parts = [{type: 'text' as const, text, more: {entryId: 'result', part: 0, offset: text.length}}];
  view.set(entries, new Map([['read', {callId: 'read', name: 'read', phase: 'update', parts}]])); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const pre = card.querySelector('.tool-output-text'); assert.ok(pre); assert.equal(pre.querySelector('.syn-keyword'), null);
  view.set(entries, new Map([['read', {callId: 'read', name: 'read', phase: 'end', parts}]])); flush();
  assert.equal(pre.textContent, text); assert.equal(pre.querySelector('.syn-keyword')?.textContent, 'const');
  const pages = card.querySelector('.output-pages'); assert.ok(pages);
  pages.querySelectorAll('button').find(button => button.textContent === 'More output')?.dispatch('click');
  await Promise.resolve(); await Promise.resolve(); flush();
  assert.equal(pages.querySelector('.output-page')?.textContent, pageText); assert.equal(pages.querySelector('.syn-keyword')?.textContent, 'return');
  view.set(entries, new Map([['read', {callId: 'read', name: 'read', phase: 'end', parts, isError: true}]])); flush();
  assert.equal(pre.textContent, text); assert.equal(pre.querySelector('.syn-keyword'), null);
  assert.equal(pages.querySelector('.syn-keyword'), null);
});
test('expanded write highlights its bounded supplied preview and keeps exact raw Arguments', () => {
  setup(); const view = transcript(); const content = 'const value: number = 42;\n'.repeat(20);
  const entries = [{id: 'write-code', kind: 'message', messages: [{...message('write-code', ''), parts: [{type: 'toolCall' as const, callId: 'write-code', name: 'write', arguments: {value: {path: 'source.ts', content}, truncated: false}}]}]}];
  view.set(entries); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush();
  const supplied = card.querySelector('.tool-content'); assert.ok(supplied); assert.equal(supplied.querySelector('.syn-keyword')?.textContent, 'const'); assert.equal(supplied.querySelector('pre')?.textContent, content);
  const inspection = card.querySelector('.tool-arguments'); assert.ok(inspection); inspection.open = true; inspection.dispatch('toggle');
  assert.equal(JSON.parse(inspection.querySelector('pre')?.textContent ?? '{}').content, content); assert.equal(inspection.querySelector('.tool-content'), null);
});
test('standalone Markdown rules render semantic hr nodes with no text or HTML evaluation', () => {
  setup(); const wrapper = new FakeNode('div'); wrapper.append(markdownDom('---\n\n***\n\n___\n\n<script>inert</script>') as unknown as FakeNode);
  assert.equal(wrapper.querySelectorAll('hr').length, 3);
  assert.equal(wrapper.querySelectorAll('hr').every(rule => rule.textContent === ''), true);
  assert.equal(wrapper.querySelector('script'), null); assert.match(wrapper.textContent, /<script>inert<\/script>/);
});
test('short retained pages mount a bounded window and scroll jumps reach uncached rows', () => {
  setup(); const view = transcript(); const entries = Array.from({length: 50}, (_, index) => entry(`e${index}`));
  const container = node('primary-transcript'); let scrollTop = 0;
  Object.defineProperty(container, 'scrollTop', {get: () => scrollTop, set: value => { scrollTop = Math.max(0, Math.min(value, Math.max(0, container.scrollHeight - container.clientHeight))); }});
  view.set(entries); flush();
  assert.ok(container.children.filter(child => child.dataset.entryId).length < 15);
  assert.equal(container.children.some(child => child.dataset.entryId === 'e49'), true);
  container.scrollTop = 0; container.dispatch('scroll'); flush();
  assert.equal(container.scrollTop, 0); assert.equal(container.children.some(child => child.dataset.entryId === 'e0'), true);
});
test('offscreen entry and tool DOM is bounded while measured heights survive eviction', () => {
  setup(); const view = transcript();
  const entries = Array.from({length: 300}, (_, index) => ({id: `e${index}`, kind: 'message', messages: [{...message(`m${index}`, ''), parts: [{type: 'toolCall' as const, callId: `c${index}`, name: 'read', arguments: {value: {}, truncated: false}}]}]}));
  view.set(entries); flush(); const container = node('primary-transcript');
  const retained = view as unknown as {cache: Map<string, unknown>; tools: Map<string, unknown>; heights: Map<string, number>};
  for (let index = 0; index < 300; index += 10) {
    container.scrollTop = index * 140; container.dispatch('scroll'); flush();
    const mounted = container.children.filter(child => child.dataset.entryId).length;
    assert.ok(retained.cache.size <= mounted + 32); assert.ok(retained.tools.size <= retained.cache.size);
    const outputs = Reflect.get(view, 'outputNodes') as Set<FakeNode>;
    for (const output of outputs) assert.equal(output.isConnected, true);
  }
  assert.equal(retained.heights.get('e0'), 140); assert.equal(retained.cache.has('e0'), false);
  container.scrollTop = 0; container.dispatch('scroll'); flush();
  assert.equal(container.children.some(child => child.dataset.entryId === 'e0'), true);
});
test('huge final text has a bounded Markdown preview and deliberate retained text disclosure', () => {
  setup(); const view = transcript(); const text = 'plain retained '.repeat(5000);
  view.set([entry('huge', text)]); flush(); const container = node('primary-transcript');
  assert.ok(container.textContent.length < 8500);
  const disclosure = container.querySelector('details'); assert.ok(disclosure);
  assert.equal(disclosure.querySelector('pre'), null); disclosure.open = true; disclosure.dispatch('toggle');
  assert.ok((disclosure.querySelector('pre')?.textContent.length ?? 0) <= 66000);
});
test('output pages use exact locators, replace bounded text, and expose request errors', async () => {
  setup(); const offsets: number[] = []; let failure = true;
  const pages = outputPages({entryId: 'result-entry', part: 4, offset: 8192}, async more => {
    assert.equal(more.entryId, 'result-entry'); assert.equal(more.part, 4); offsets.push(more.offset);
    if (failure) { failure = false; throw new Error('source unavailable'); }
    return {entryId: more.entryId, part: more.part, text: `page ${more.offset}`, nextOffset: more.offset === 8192 ? 16384 : null, totalBytes: 16400};
  }, () => true, () => {});
  const content = pages as unknown as FakeNode; node('primary-transcript').append(content);
  const pre = content.querySelector('.output-page'); assert.ok(pre); const frame = pre.querySelector('.pre-text-frame'); assert.ok(frame);
  const next = content.querySelectorAll('button').find(item => item.textContent === 'More output'); assert.ok(next);
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve(); assert.match(content.textContent, /source unavailable/);
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve(); assert.equal(content.querySelector('.output-page')?.textContent, 'page 8192');
  assert.equal(content.querySelector('.secondary')?.textContent, 'Output bytes 8192–8201 of 16400');
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve(); assert.equal(content.querySelector('.output-page')?.textContent, 'page 16384');
  assert.deepEqual(offsets, [8192, 8192, 16384]); assert.doesNotMatch(content.querySelector('.output-page')?.textContent ?? '', /page 8192/);
  const previous = content.querySelectorAll('button').find(item => item.textContent === 'Previous output'); previous?.dispatch('click');
  await Promise.resolve(); await Promise.resolve(); assert.equal(content.querySelector('.output-page')?.textContent, 'page 8192');
  assert.equal(pre.querySelector('.pre-text-frame'), frame); assert.equal(frame.textContent, 'page 8192');
  content.querySelectorAll('button').find(item => item.textContent === 'Start over')?.dispatch('click');
  assert.equal(pre.hidden, true); assert.equal(frame.textContent, ''); assert.equal(pre.querySelector('.pre-text-frame'), frame);
});
test('output failures keep an unmatched page hidden and use a neutral fallback for an unknown error', async () => {
  setup(); let mismatch = true;
  const pages = outputPages({entryId: 'expected', part: 2, offset: 0}, async () => {
    if (!mismatch) throw null;
    mismatch = false; return {entryId: 'different', part: 2, text: 'wrong message', nextOffset: null, totalBytes: 13};
  }, () => true, () => {}) as unknown as FakeNode;
  const next = pages.querySelectorAll('button').find(item => item.textContent === 'More output'); assert.ok(next);
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve();
  assert.equal(pages.querySelector('.secondary')?.textContent, 'This output does not match the selected message.');
  assert.equal(pages.querySelector('.output-page')?.hidden, true); assert.doesNotMatch(pages.textContent, /wrong message/);
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve();
  assert.equal(pages.querySelector('.secondary')?.textContent, 'Output could not be loaded.');
});
test('tool result paging uses the result source and reset discards a late page', async () => {
  setup(); let resolve: (page: OutputPage) => void = () => {}; const requests: unknown[] = [];
  const view = new Transcript('primary', {presentation: () => {}, reading: () => {}, output: more => { requests.push(more); return new Promise(done => { resolve = done; }); }});
  view.set([{id: 'call-owner', kind: 'message', messages: [{...message('call-message', ''), parts: [{type: 'toolCall', callId: 'x', name: 'read', arguments: {value: {}, truncated: false}}]}]},
    {id: 'result-source', kind: 'message', messages: [{...message('result-message', ''), parts: [{type: 'toolResult', callId: 'x', name: 'read', parts: [{type: 'text', text: 'initial', more: {entryId: 'result-source', part: 3, offset: 8192}}], isError: false}]}]}]); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const next = card.querySelectorAll('button').find(item => item.textContent === 'More output'); assert.ok(next); next.dispatch('click');
  assert.deepEqual(requests, [{entryId: 'result-source', part: 3, offset: 8192}]);
  view.reset(); view.set([entry('replacement')]); flush();
  resolve({entryId: 'result-source', part: 3, text: 'late page', nextOffset: null, totalBytes: 8201}); await Promise.resolve(); await Promise.resolve();
  assert.doesNotMatch(node('primary-transcript').textContent, /late page/); assert.doesNotMatch(card.textContent, /late page/);
});
test('presentation helpers suppress empty messages and keep coverage omissions visible', () => {
  setup(); const view = transcript();
  const empty = {...message('empty', ''), role: 'system', parts: []};
  const omitted = {...empty, id: 'omitted', coverage: {complete: false, truncated: true, omitted: 1}};
  view.set([{id: 'empty', kind: 'message', messages: [empty]}, {id: 'omitted', kind: 'message', messages: [omitted]},
    {id: 'custom', kind: 'custom', head: 'Exact custom label', data: {value: {fact: 'retained'}, truncated: false}}]); flush();
  const container = node('primary-transcript');
  assert.equal(container.children.some(child => child.dataset.entryId === 'empty'), false);
  assert.equal(container.querySelectorAll('.message-actions').length, 1);
  assert.match(container.textContent, /Some message content is not shown/);
  const events = container.querySelector('.session-events'); assert.ok(events); events.open = true; events.dispatch('toggle');
  assert.match(container.textContent, /Exact custom label/);
});
test('bounded coverage reasons preserve continuation text and stable message parts', () => {
  setup(); const view = transcript();
  const part = {type: 'text' as const, text: 'Protected preview', more: {entryId: 'saved', part: 0, offset: 8192}};
  const saved = {...message('saved-message', ''), parts: [part], coverage: {...coverage, complete: false, truncated: true, reason: 'Additional output is available on request.'}};
  const retained = {id: 'saved', kind: 'message', messages: [saved]};
  view.set([retained]); flush(); const container = node('primary-transcript');
  const paragraph = container.querySelector('p'); const continuation = container.querySelector('.output-pages'); assert.ok(paragraph); assert.ok(continuation);
  assert.match(container.textContent, /Additional output is available on request\./);
  assert.doesNotMatch(container.textContent, /Thinking not available|Some output is not available\.|Some output was not retained\./);
  view.set([{...retained, messages: [{...saved, coverage: {...saved.coverage, reason: 'More protected text is available.'}}]}]); flush();
  assert.equal(container.querySelector('p'), paragraph); assert.equal(container.querySelector('.output-pages'), continuation);
  assert.match(container.textContent, /More protected text is available\./);
  assert.equal(continuation.querySelectorAll('button').some(button => button.textContent === 'More output'), true);
});
test('coverage reasons use bounded inert text and remove terminal control instructions', () => {
  setup(); const view = transcript();
  const reason = `\x1b[31m<script>alert(1)</script>\x1b[0m\x00\x1b]0;hidden title\x07${'x'.repeat(5000)}`;
  const withReason = (id: string, reason: string) => ({id, kind: 'message', messages: [{...message(id, ''), parts: [], coverage: {...coverage, complete: false, reason}}]});
  view.set([withReason('malicious', reason), withReason('lines', 'one\ntwo\nthree\nfour\nfive\nsix\nseven')]); flush();
  const container = node('primary-transcript'); const labels = container.querySelectorAll('.message-body').map(body => body.querySelector('p')?.textContent ?? '');
  assert.equal(labels[0]?.length, 4096); assert.ok(labels[0]?.startsWith('<script>alert(1)</script>')); assert.ok(labels[0]?.endsWith('…'));
  assert.doesNotMatch(labels[0] ?? '', /[\x00-\x1f\x7f-\x9f]|hidden title/);
  assert.equal(container.querySelector('script'), null); assert.equal(labels[1], 'one\ntwo\nthree\nfour\nfive\nsix…');
});
test('missing and empty sanitized coverage reasons use a neutral fallback', () => {
  setup(); const view = transcript();
  const reasons = [undefined, '', ' \n\t ', '\x1b[31m\x1b[0m\x00'];
  view.set(reasons.map((reason, index) => ({id: `empty-${index}`, kind: 'message', messages: [{...message(`m-${index}`, ''), parts: [], coverage: {...coverage, omitted: 1, reason}}]}))); flush();
  const labels = node('primary-transcript').querySelectorAll('.message-body').map(body => body.querySelector('p')?.textContent);
  assert.deepEqual(labels, reasons.map(() => 'Some message content is not shown.'));
  assert.doesNotMatch(node('primary-transcript').textContent, /host/);
});
test('expanded edit and write cards show supplied text without replacing generic output', () => {
  setup(); const view = transcript();
  const tool = (id: string, name: string, value: Record<string, unknown>) => ({id, kind: 'message', messages: [{...message(id, ''), parts: [
    {type: 'toolCall' as const, callId: id, name, arguments: {value, truncated: false}},
    {type: 'toolResult' as const, callId: id, name, parts: [{type: 'text' as const, text: 'result text'}], isError: false},
  ]}]});
  view.set([tool('edit', 'edit', {oldText: 'old supplied', newText: 'new supplied'}), tool('write', 'write', {content: 'written supplied'})]); flush();
  const cards = node('primary-transcript').querySelectorAll('.tool-card');
  for (const card of cards) { card.open = true; card.dispatch('toggle'); } flush();
  assert.match(cards[0]?.querySelector('.tool-content')?.textContent ?? '', /- old supplied.*\+ new supplied/s);
  assert.match(cards[1]?.querySelector('.tool-content')?.textContent ?? '', /Supplied content.*written supplied/s);
  for (const card of cards) assert.equal(card.querySelector('.tool-output-text')?.textContent, 'result text');
});
test('tool result refresh preserves open supplied-content inspections', () => {
  setup(); const view = transcript(); const supplied = 'supplied text '.repeat(1200);
  const tool = (id: string, value: Record<string, unknown>) => ({id, kind: 'message', messages: [{...message(id, ''), parts: [
    {type: 'toolCall' as const, callId: id, name: id, arguments: {value, truncated: false}},
    {type: 'toolResult' as const, callId: id, name: id, parts: [{type: 'text' as const, text: 'initial result'}], isError: false},
  ]}]});
  const entries = [tool('edit', {oldText: supplied, newText: supplied}), tool('write', {content: supplied})];
  view.set(entries); flush(); const cards = node('primary-transcript').querySelectorAll('.tool-card');
  const inspections: FakeNode[] = [];
  for (const card of cards) {
    card.open = true; card.dispatch('toggle');
    const disclosure = card.querySelector('.tool-arguments'); assert.ok(disclosure);
    disclosure.open = true; disclosure.dispatch('toggle'); inspections.push(disclosure);
    const args = JSON.parse(disclosure.querySelector('pre')?.textContent ?? '{}'); assert.equal(args.content ?? args.oldText, supplied); assert.equal(disclosure.querySelector('.tool-content'), null);
  }
  const parts = [{type: 'text' as const, text: 'updated raw result'}];
  view.set(entries, new Map(['edit', 'write'].map(id => [id, {callId: id, name: id, phase: 'end' as const, parts}]))); flush();
  for (const disclosure of inspections) { assert.equal(disclosure.isConnected, true); const args = JSON.parse(disclosure.querySelector('pre')?.textContent ?? '{}'); assert.equal(args.content ?? args.oldText, supplied); }
  for (const card of cards) assert.equal(card.querySelector('.tool-output-text')?.textContent, 'updated raw result');
});
test('write completion keeps open retained content and its supplied-source label', () => {
  setup(); const view = transcript(); const content = 'retained '.repeat(2000);
  const entries = [{id: 'write', kind: 'message', messages: [{...message('write', ''), parts: [{type: 'toolCall' as const, callId: 'write', name: 'write', arguments: {value: {content}, truncated: false}}]}]}];
  view.set(entries); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush();
  const region = card.querySelector('.tool-content'); const disclosure = card.querySelector('.tool-arguments'); assert.ok(disclosure);
  disclosure.open = true; disclosure.dispatch('toggle'); disclosure.focus();
  view.set(entries, new Map([['write', {callId: 'write', name: 'write', phase: 'end', parts: [{type: 'text', text: 'complete'}]}]])); flush();
  assert.equal(card.querySelector('.tool-content'), region); assert.equal(disclosure.open, true);
  assert.equal(disclosure.isConnected, true); assert.equal(fakeDocument.activeElement, disclosure);
  assert.equal(JSON.parse(disclosure.querySelector('pre')?.textContent ?? '{}').content, content); assert.match(region?.textContent ?? '', /Supplied content/); assert.doesNotMatch(region?.textContent ?? '', /Written content/);
});
test('bash command and output stay distinct, and shell status follows live completion', () => {
  setup(); const view = transcript();
  const call = {type: 'toolCall' as const, callId: 'bash', name: 'bash', arguments: {value: {command: 'echo first\necho second', timeout: 45}, truncated: false}};
  const entries = [{id: 'call', kind: 'message', messages: [{...message('bash', ''), parts: [call]}]}];
  view.set(entries); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  assert.equal(card.parentNode?.dataset.status, 'missing'); assert.match(card.textContent, /No result recorded/); assert.equal(card.querySelector('.tool-target')?.textContent, '$ echo first…');
  assert.equal(card.querySelector('.tool-secondary')?.textContent, ''); assert.match(card.querySelector('.tool-expanded')?.textContent ?? '', /\(timeout 45s\)/);
  assert.equal(card.querySelector('.tool-expanded')?.hidden, true); assert.doesNotMatch(card.querySelector('summary')?.textContent ?? '', /timeout/);
  card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('.tool-command')?.textContent, 'echo first\necho second');
  assert.equal(card.querySelector('.tool-source')?.open, true);
  view.set(entries, new Map([['bash', {callId: 'bash', name: 'bash', phase: 'end', parts: [{type: 'text', text: 'first\nsecond'}]}]])); flush();
  assert.equal(card.parentNode?.dataset.status, 'success'); assert.equal(card.querySelector('.tool-output-text')?.textContent, 'first\nsecond');
  view.set(entries, new Map([['bash', {callId: 'bash', name: 'bash', phase: 'end', parts: [], isError: true}]])); flush();
  assert.equal(card.parentNode?.dataset.status, 'error'); assert.equal(card.querySelector('.tool-output-text')?.textContent, 'The tool failed. No output is available.');
});
test('collapsed edit and write show supplied previews but failures show the retained error output', () => {
  setup(); const view = transcript();
  const calls = [
    {type: 'toolCall' as const, callId: 'edit', name: 'edit', arguments: {value: {oldText: 'old line', newText: 'new line'}, truncated: false}},
    {type: 'toolCall' as const, callId: 'write', name: 'write', arguments: {value: {content: 'file content'}, truncated: false}},
  ];
  const entries = calls.map(call => ({id: call.callId, kind: 'message', messages: [{...message(call.callId, ''), parts: [call]}]}));
  view.set(entries); flush(); const cards = node('primary-transcript').querySelectorAll('.tool-card');
  assert.equal(cards[0]?.querySelector('.diff-del')?.textContent, '- old line');
  assert.equal(cards[0]?.querySelector('.diff-add')?.textContent, '+ new line');
  assert.equal(cards[1]?.querySelector('.tool-preview')?.textContent, 'file content');
  view.set(entries, new Map([['edit', {callId: 'edit', name: 'edit', phase: 'end', isError: true, parts: [{type: 'text', text: 'Replacement did not match'}]}]])); flush();
  assert.equal(cards[0]?.querySelector('.tool-preview')?.textContent, 'Replacement did not match');
  assert.equal(cards[0]?.querySelector('.diff-del'), null); assert.equal(cards[0]?.parentNode?.dataset.status, 'error');
});
test('read headers keep the recorded tool name and supplied path across disclosure changes', () => {
  setup(); const view = transcript();
  const path = '/skills/audit/SKILL.md';
  const entries = [{id: 'read', kind: 'message', messages: [{...message('read', ''), parts: [{type: 'toolCall' as const, callId: 'read', name: 'read', arguments: {value: {path, offset: 7, limit: 4}, truncated: false}}]}]}];
  view.set(entries); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  assert.equal(card.querySelector('.tool-name')?.textContent, 'read'); assert.equal(card.querySelector('.tool-target')?.textContent, path);
  assert.equal(card.querySelector('.tool-target')?.title, path); assert.equal(card.querySelector('.tool-secondary')?.textContent, 'lines 7–10');
  card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('.tool-name')?.textContent, 'read'); assert.equal(card.querySelector('.tool-target')?.textContent, path);
  card.open = false; card.dispatch('toggle'); flush(); assert.equal(card.querySelector('.tool-target')?.textContent, path);
});
test('final thinking uses safe Markdown while partial and redacted thinking remain plain text', () => {
  setup(); const view = transcript();
  const retained = (state: 'partial' | 'final', redacted = false) => ({id: 'thought', kind: 'message', messages: [{...message('thought', '', state), parts: [{type: 'thinking' as const, text: '**reason**\n<script>inert</script>', redacted}]}]});
  view.set([retained('partial')]); flush(); const thinking = node('primary-transcript').querySelector('.thinking'); assert.ok(thinking);
  assert.equal(thinking.querySelector('strong'), null);
  view.set([retained('final')]); flush(); assert.equal(thinking.querySelector('strong')?.textContent, 'reason'); assert.equal(thinking.querySelector('script'), null);
  view.set([retained('final', true)]); flush(); assert.equal(thinking.querySelector('strong'), null); assert.equal(thinking.querySelector('.thinking-content')?.textContent, 'Thinking not available');
});
test('ordinary turns expose supplied roles without adding headers to compact thought or tool rows', () => {
  setup(); const view = transcript();
  const entries: EntryView[] = ['user', 'assistant', 'custom', 'system'].map(role => ({id: role, kind: 'message', messages: [{...message(role, 'Retained text'), role}]}));
  entries.push({id: 'thought-role', kind: 'message', messages: [{...message('thought-role', ''), parts: [{type: 'thinking', text: 'Retained thought'}]}]});
  view.set(entries); flush(); const root = node('primary-transcript'); const headers = root.querySelectorAll('.message-role');
  assert.deepEqual(headers.map(header => [header.textContent, header.hidden]), [['Input', false], ['Assistant', false], ['Notice', false], ['Notice', false], ['Assistant', true]]);
  assert.equal(root.querySelectorAll('.message-body').filter(body => body.textContent === 'Retained text').length, 4);
  const body = root.querySelector('.message-body'); assert.ok(body); const first = headers[0];
  view.set(entries); flush(); assert.equal(root.querySelector('.message-role'), first); assert.equal(root.querySelector('.message-body'), body);
});
test('response stop states remain visible without a supplied error message', () => {
  setup(); const view = transcript();
  view.set(['error', 'aborted'].map(stopReason => ({id: stopReason, kind: 'message', messages: [{...message(stopReason, ''), parts: [], stopReason}]}))); flush();
  const errors = node('primary-transcript').querySelectorAll('.message-error');
  assert.deepEqual(errors.map(error => [error.hidden, error.textContent]), [[false, 'The response failed.'], [false, 'The response stopped.']]);
  assert.equal(errors[0]?.className, 'error message-error'); assert.equal(errors[1]?.className, 'warning message-error');
});
test('known session changes use quiet system notes with retained data under disclosure', () => {
  setup(); const view = transcript();
  view.set([{id: 'model', kind: 'model_change', data: {value: {provider: 'fixture', modelId: 'test'}, truncated: false}}, {id: 'thinking', kind: 'thinking_level_change', data: {value: {thinkingLevel: 'high'}, truncated: false}}, {id: 'unknown', kind: 'future_change', data: {value: {fact: 'known'}, truncated: false}}]); flush();
  const events = node('primary-transcript').querySelector('.session-events'); assert.ok(events);
  assert.match(events.textContent, /3 session events/); assert.equal(events.querySelectorAll('.system-note').length, 0);
  events.open = true; events.dispatch('toggle');
  const notes = node('primary-transcript').querySelectorAll('.system-note'); assert.equal(notes.length, 2);
  assert.match(notes[0]?.textContent ?? '', /model changed to fixture\/test/); assert.match(notes[1]?.textContent ?? '', /thinking changed to high/);
  assert.equal(notes[0]?.querySelector('dl'), null); const disclosure = notes[0]?.querySelector('details'); assert.ok(disclosure); disclosure.open = true; disclosure.dispatch('toggle'); assert.match(disclosure.querySelector('pre')?.textContent ?? '', /provider/);
  assert.equal(node('primary-transcript').querySelectorAll('.custom-entry').length, 1);
});

test('turns preserve body and action hooks with a compact role label', () => {
  setup(); const view = new Transcript('primary', {presentation: () => {}, reading: () => {}, fork: () => {}});
  view.set([{id: 'user', kind: 'message', messages: [{...message('u', 'Hello'), role: 'user'}]}, entry('assistant', 'Reply')]); flush();
  const container = node('primary-transcript'); const user = container.querySelector('.user'); assert.ok(user);
  const header = user.querySelector('.message-header'); assert.ok(header);
  assert.equal(user.children[0], header); assert.equal(user.children[1], user.querySelector('.message-body')); assert.equal(user.attributes['aria-label'], 'Input message');
  assert.equal(header.children[0], user.querySelector('.message-role')); assert.equal(header.children[1], user.querySelector('.message-actions')); assert.equal(messageAction(user, 'Fork').label, 'Fork');
  assert.equal(user.querySelector('.message-menu')?.attributes['aria-label'], 'Message actions'); assert.doesNotMatch(user.textContent, /Fork/);
  const body = user.querySelector('.message-body'); const actions = user.querySelector('.message-actions');
  view.set([{id: 'user', kind: 'message', messages: [{...message('u', 'Hello'), role: 'user'}]}, entry('assistant', 'Reply')]); flush();
  assert.equal(user.querySelector('.message-header'), header); assert.equal(user.querySelector('.message-body'), body); assert.equal(user.querySelector('.message-actions'), actions);
  assert.deepEqual(container.querySelectorAll('.message-role').map(label => label.textContent), ['Input', 'Assistant']);
  assert.deepEqual(container.querySelectorAll('.message-body').map(body => body.textContent), ['Hello', 'Reply']);
});
test('scroll settlement retains deliberate rest and does not schedule text probes', () => {
  setup(); const geometry = geometryEnvironment();
  try {
    const readings: ReadingView[] = []; const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)});
    view.set(Array.from({length: 12}, (_, i) => entry(`e${i}`))); flush();
    const container = node('primary-transcript'); container.scrollTop = 400; container.dispatch('scroll'); flush();
    let hits = 0; Reflect.set(fakeDocument, 'caretPositionFromPoint', () => { hits++; return null; });
    container.dispatch('scrollend'); geometry.run();
    assert.equal(container.scrollTop, 400); assert.equal(hits, 0); assert.equal(geometry.timers.size, 0);
    assert.deepEqual(readings.at(-1), {revision: 0, anchorId: 'e2', offsetPx: 120, followTail: false});
    assert.equal(node('primary-latest').hidden, false);
  } finally { geometry.restore(); }
});
function geometryEnvironment() {
  const previous = {ResizeObserver: globalThis.ResizeObserver, getComputedStyle: globalThis.getComputedStyle, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout};
  const timers = new Map<number, () => void>(); let timerId = 0;
  const observers: TestResizeObserver[] = [];
  class TestResizeObserver {
    observed = new Set<Element>();
    private callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.push(this); }
    observe(target: Element): void { this.observed.add(target); }
    unobserve(target: Element): void { this.observed.delete(target); }
    disconnect(): void { this.observed.clear(); }
    emit(target: FakeNode, width: number, height: number): void {
      this.callback([{target, contentRect: {width, height}}] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
    }
  }
  let line = 22;
  Object.assign(globalThis, {ResizeObserver: TestResizeObserver,
    getComputedStyle: () => ({maxHeight: '480px', lineHeight: `${line}px`, borderTopWidth: '6px', borderBottomWidth: '6px', paddingTop: '0px', paddingBottom: '0px', boxSizing: 'border-box'}),
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: (id: number) => { timers.delete(id); }});
  return {observers, timers, line: (value: number) => { line = value; },
    run: () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); },
    restore: () => { for (const [key, value] of Object.entries(previous)) { if (value) Reflect.set(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } }};
}
test('composer focus and repeated transcript refresh never replace non-tail reading intent', () => {
  setup(); const readings: ReadingView[] = []; const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)});
  const reading: ReadingView = {revision: 8, anchorId: 'e20', offsetPx: 17, followTail: false};
  const entries = Array.from({length: 100}, (_, index) => entry(`e${index}`));
  view.configure(undefined, reading); view.set(entries); flush(); const container = node('primary-transcript'); const before = container.scrollTop;
  node('primary-editor').focus(); view.set(entries); flush(); assert.equal(container.scrollTop, before); assert.equal(view.captureGeometry().followTail, false);
  const saved = view.captureGeometry(); container.hidden = true; view.visibilityChanged(); container.hidden = false; view.visibilityChanged(); view.applyGeometry(saved); flush();
  assert.equal(container.scrollTop, before); assert.equal(view.captureGeometry().anchor?.id, 'e20'); assert.equal(view.captureGeometry().anchor?.offsetPx, 17);
  assert.ok(readings.every(value => !value.followTail && value.anchorId === 'e20')); view.reset();
});
for (const route of ['capture', 'paint', 'own-scroll']) {
  test(`resized DOM before observer settlement keeps the owned interior anchor through ${route}`, () => {
    setup(); const geometry = geometryEnvironment();
    try {
      const readings: ReadingView[] = [], entries = Array.from({length: 20}, (_, i) => entry(`e${i}`));
      const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)});
      view.configure(undefined, {revision: 1, anchorId: 'e4', offsetPx: 108, followTail: false}); view.set(entries); flush();
      const root = node('primary-transcript'); if (route !== 'own-scroll') root.dispatch('scrollend');
      assert.equal(view.captureGeometry().anchor?.id, 'e4');
      const preceding = root.children.find(child => child.dataset.entryId === 'e0'); assert.ok(preceding);
      preceding.measured = 280; root.clientWidth = 300;
      if (route === 'own-scroll') root.dispatch('scroll');
      if (route === 'capture') {
        const saved = view.captureGeometry(); assert.deepEqual(saved.anchor, {id: 'e4', offsetPx: 108}); view.applyGeometry(saved);
      } else {view.set(entries); flush();}
      const observer = geometry.observers[0]; assert.ok(observer); observer.emit(root, 300, 300); geometry.run(); flush();
      root.dispatch('scrollend');
      const anchor = root.children.find(child => child.dataset.entryId === 'e4'); assert.ok(anchor);
      assert.equal(root.scrollTop - anchor.offsetTop, 108);
      assert.deepEqual(view.captureGeometry().anchor, {id: 'e4', offsetPx: 108});
      assert.equal(readings.at(-1)?.anchorId, 'e4'); assert.equal(readings.at(-1)?.offsetPx, 108);
      view.reset();
    } finally {geometry.restore();}
  });
}
test('a distinct user scroll supersedes a retained geometry anchor after an internal scroll notification', () => {
  setup(); const view = transcript(); const entries = Array.from({length: 30}, (_, i) => entry(`e${i}`));
  view.configure(undefined, {revision: 1, anchorId: 'e4', offsetPx: 108, followTail: false}); view.set(entries); flush();
  const root = node('primary-transcript'); root.dispatch('scroll'); flush(); root.dispatch('scrollend');
  root.scrollTop = 12 * 140 + 17; root.dispatch('scroll'); flush(); root.dispatch('scrollend');
  assert.deepEqual(view.captureGeometry().anchor, {id: 'e12', offsetPx: 17});
  assert.equal(view.captureGeometry().followTail, false); view.reset();
});
test('settled root resize retains its saved anchor and only processes actual dirty geometry', () => {
  setup(); const geometry = geometryEnvironment();
  try {
    const readings: ReadingView[] = []; const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)});
    view.configure(undefined, {revision: 8, anchorId: 'e2', offsetPx: 120, followTail: false});
    view.set(Array.from({length: 12}, (_, i) => entry(`e${i}`))); flush();
    const container = node('primary-transcript'); const observer = geometry.observers[0]; assert.ok(observer);
    assert.equal(container.scrollTop, 400); const preceding = container.children[0]; assert.ok(preceding); preceding.measured = 240;
    observer.emit(container, 600, 300); observer.emit(container, 650, 300); assert.equal(geometry.timers.size, 1);
    geometry.run(); assert.equal(container.scrollTop, 500);
    assert.deepEqual(readings.at(-1), {revision: 8, anchorId: 'e2', offsetPx: 120, followTail: false});
    view.set(Array.from({length: 12}, (_, i) => entry(`e${i}`))); flush(); observer.emit(container, 650, 300);
    assert.equal((Reflect.get(view, 'geometryDirty') as Set<unknown>).size, 0);
    geometry.run(); flush(); assert.equal(geometry.timers.size, 0); view.reset(); assert.deepEqual([...observer.observed], [container]);
  } finally { geometry.restore(); }
});
test('scroll and latest intent supersede a queued saved restore without losing initial anchors', () => {
  for (const intent of ['scroll', 'latest', 'away']) {
    setup(); const view = transcript(); const container = node('primary-transcript'); let scrollTop = 0;
    Object.defineProperty(container, 'scrollTop', {get: () => scrollTop, set: value => {
      scrollTop = Math.max(0, Math.min(value, Math.max(0, container.scrollHeight - container.clientHeight)));
    }});
    view.configure(undefined, {revision: 3, anchorId: 'e20', offsetPx: 17, followTail: false});
    view.set(Array.from({length: 100}, (_, index) => entry(`e${index}`, index === 99 ? 'Retained tail completion' : `Body ${index}`))); flush();
    assert.equal(container.scrollTop, 20 * 140 + 17, 'initial saved reading anchor still restores');
    view.restore({revision: 3, anchorId: 'e2', offsetPx: 118, followTail: false});
    assert.ok(Reflect.get(view, 'restoring'));
    if (intent === 'latest') node('primary-latest').dispatch('click');
    else {
      container.scrollTop = intent === 'away' ? 80 * 140 + 23 : container.scrollHeight;
      container.dispatch('scroll'); container.dispatch('scrollend');
    }
    for (let pass = 0; frames.length && pass < 8; pass++) flush();
    assert.equal(frames.length, 0);
    assert.equal(Reflect.get(view, 'restoring'), undefined, 'newer scroll intent retires the pending restore');
    assert.ok(container.children.filter(child => child.dataset.entryId).length < 15);
    if (intent === 'away') {
      assert.equal(container.scrollTop, 80 * 140 + 23);
      assert.equal(node('primary-latest').hidden, false);
    } else {
      assert.match(container.textContent, /Retained tail completion/);
      assert.equal(container.scrollTop, container.scrollHeight - container.clientHeight);
      assert.equal(node('primary-latest').hidden, true);
    }
  }
});
test('missing saved anchors keep provisional positions unsaved and obey newer view intent', () => {
  for (const intent of ['scroll', 'wrap', 'latest', 'hidden', 'reset', 'exhausted']) {
    setup(); const readings: import('../shared/api.ts').ReadingView[] = [];
    const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)}); const root = node('primary-transcript');
    const reading = {revision: 7, anchorId: 'earlier', offsetPx: 17, followTail: false};
    view.configure(undefined, reading); view.set(Array.from({length: 30}, (_, index) => entry(`recent${index}`))); flush();
    assert.equal(view.restorationCurrent(reading), true); assert.equal(view.restorationCurrent({...reading}), false);
    root.dispatch('scrollend'); assert.deepEqual(readings, [], 'provisional first-page position must not replace the saved anchor');
    if (intent === 'scroll') {root.scrollTop = 400; root.dispatch('scroll');}
    else if (intent === 'wrap') root.dispatch('source-wrap');
    else if (intent === 'latest') node('primary-latest').dispatch('click');
    else if (intent === 'hidden') {const pane = new FakeNode('section'); pane.className = 'conversation'; pane.hidden = true; pane.append(root);}
    else if (intent === 'reset') view.reset();
    else view.abandonRestore(reading);
    assert.equal(view.restorationCurrent(reading), false, intent);
    view.abandonRestore(reading); flush();
    if (intent === 'scroll') assert.equal(root.scrollTop, 400);
    if (intent === 'exhausted') assert.equal(root.scrollTop, 0);
  }
});
test('an earlier page completes its pending saved anchor at the exact offset', () => {
  setup(); const view = transcript(); const reading = {revision: 7, anchorId: 'earlier', offsetPx: 17, followTail: false};
  const recent = Array.from({length: 30}, (_, index) => entry(`recent${index}`));
  view.configure(undefined, reading); view.set(recent); flush(); assert.equal(view.restorationCurrent(reading), true);
  view.set([entry('start'), entry('earlier'), ...recent]); flush();
  const anchor = node('primary-transcript').children.find(child => child.dataset.entryId === 'earlier'); assert.ok(anchor);
  assert.equal(node('primary-transcript').scrollTop, anchor.offsetTop + 17); assert.equal(view.restorationCurrent(reading), false);
});

test('resize measurements reconcile the virtual tail without another scroll event', () => {
  setup(); const geometry = geometryEnvironment(); const createElement = fakeDocument.createElement;
  let height = 2000;
  fakeDocument.createElement = tag => {
    const created = createElement(tag);
    const naturalHeight = Object.getOwnPropertyDescriptor(FakeNode.prototype, 'offsetHeight')?.get;
    Object.defineProperty(created, 'offsetHeight', {get: () => created.dataset.entryId === 'e95' ? height : naturalHeight?.call(created)});
    return created;
  };
  try {
    const view = transcript(); const container = node('primary-transcript'); let scrollTop = 0;
    Object.defineProperty(container, 'scrollTop', {get: () => scrollTop, set: value => {
      scrollTop = Math.max(0, Math.min(value, Math.max(0, container.scrollHeight - container.clientHeight)));
    }});
    (Reflect.get(view, 'heights') as Map<string, number>).set('e95', height);
    view.configure(undefined, {revision: 0, anchorId: 'e95', offsetPx: 500, followTail: false});
    view.set(Array.from({length: 100}, (_, index) => entry(`e${index}`, index === 99 ? 'Retained tail completion' : `Body ${index}`))); flush();
    assert.doesNotMatch(container.textContent, /Retained tail completion/);
    let scrollEvents = 0; container.addEventListener('scroll', () => { scrollEvents++; });
    container.dispatch('scroll'); flush(); container.dispatch('scrollend');
    const observer = geometry.observers[0]; assert.ok(observer);
    const settle = () => {
      geometry.run();
      for (let pass = 0; frames.length && pass < 8; pass++) flush();
      assert.equal(frames.length, 0, 'measurement reconciliation reaches a stable window');
      assert.ok(container.children.filter(child => child.dataset.entryId).length < 15);
    };
    height = 100; observer.emit(container, 400, 300); settle();
    assert.match(container.textContent, /Retained tail completion/);
    const anchor = container.children.find(child => child.dataset.entryId === 'e95'); assert.ok(anchor);
    assert.equal(container.scrollTop, anchor.offsetTop + 99);
    assert.equal(node('primary-latest').hidden, false, 'resize preserves deliberate reading instead of enabling tail follow');
    height = 1200; observer.emit(container, 300, 300); settle();
    height = 80; observer.emit(container, 500, 300); settle();
    assert.match(container.textContent, /Retained tail completion/);
    node('primary-latest').dispatch('click'); settle();
    assert.equal(container.scrollTop, container.scrollHeight - container.clientHeight);
    assert.equal(node('primary-latest').hidden, true);
    assert.match(container.textContent, /Retained tail completion/);
    height = 2000; observer.emit(container, 250, 300); settle();
    assert.equal(container.scrollTop, container.scrollHeight - container.clientHeight);
    assert.match(container.textContent, /Retained tail completion/);
    assert.equal(scrollEvents, 1, 'resize and tail follow converge without another scroll event');
  } finally { fakeDocument.createElement = createElement; geometry.restore(); }
});
test('selection and active scroll defer root geometry until intent guards clear', () => {
  setup(); const geometry = geometryEnvironment();
  try {
    const view = transcript(); view.configure(undefined, {revision: 1, anchorId: 'e2', offsetPx: 120, followTail: false});
    view.set(Array.from({length: 12}, (_, i) => entry(`e${i}`))); flush();
    const container = node('primary-transcript'); const paragraph = container.querySelector('p'); assert.ok(paragraph);
    const observer = geometry.observers[0]; assert.ok(observer); const preceding = container.children[0]; assert.ok(preceding); preceding.measured = 240;
    selection = {isCollapsed: false, anchorNode: paragraph, focusNode: paragraph}; observer.emit(container, 500, 300); geometry.run();
    assert.equal(container.scrollTop, 400); selection = null; container.dispatch('scroll');
    observer.emit(container, 501, 300); geometry.run(); assert.equal(container.scrollTop, 400);
    container.dispatch('scrollend'); assert.equal(container.scrollTop, 400);
  } finally { geometry.restore(); }
});
test('an observed output resize refreshes virtual heights even when its line cap is unchanged', () => {
  setup(); const geometry = geometryEnvironment();
  try {
    const readings: import('../shared/api.ts').ReadingView[] = [];
    const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)});
    const output = 'first retained line\nsecond retained line';
    const row = {id: 'long', kind: 'message', messages: [{...message('r', ''), role: 'toolResult', parts: [{type: 'toolResult' as const, callId: 'long', name: 'bash', isError: false, parts: [{type: 'text' as const, text: output}]}]}]};
    view.configure(undefined, {revision: 3, anchorId: 'after2', offsetPx: 20, followTail: false});
    view.set([row, ...Array.from({length: 7}, (_, i) => entry(`after${i + 1}`))]); flush();
    const container = node('primary-transcript'); const card = container.querySelector('.tool-card'); assert.ok(card);
    card.open = true; card.dispatch('toggle'); flush(); const pre = card.querySelector('.tool-output-text'); assert.ok(pre);
    pre.clientHeight = 44; Object.defineProperty(pre, 'scrollHeight', {get: () => pre.clientHeight});
    const observer = geometry.observers[0]; assert.ok(observer); observer.emit(pre, 220, 44); geometry.run();
    assert.equal(pre.style.maxHeight, undefined); assert.equal(container.scrollTop, 300); readings.length = 0;
    const preceding = container.children.find(child => child.dataset.entryId === 'long'); assert.ok(preceding);
    preceding.measured = 184; pre.clientHeight = 88; observer.emit(pre, 120, 88); geometry.run();
    assert.equal(pre.style.maxHeight, undefined); assert.equal(container.scrollTop, 344);
    assert.equal((Reflect.get(view, 'heights') as Map<string, number>).get('long'), 184);
    assert.deepEqual(readings, [{revision: 3, anchorId: 'after2', offsetPx: 20, followTail: false}]);
    assert.equal(pre.textContent, output);
  } finally { geometry.restore(); }
});
test('a focused descendant defers root reflow and reading writes until focus leaves the transcript', () => {
  setup(); const geometry = geometryEnvironment();
  try {
    const readings: import('../shared/api.ts').ReadingView[] = [];
    const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)});
    view.configure(undefined, {revision: 3, anchorId: 'e2', offsetPx: 120, followTail: false});
    view.set(Array.from({length: 12}, (_, i) => entry(`e${i}`))); flush();
    const container = node('primary-transcript'); const control = container.querySelector('.message-menu'); assert.ok(control);
    const preceding = container.children[0]; assert.ok(preceding); const moves = control.moves;
    control.focus(); preceding.measured = 240;
    const observer = geometry.observers[0]; assert.ok(observer); observer.emit(container, 500, 300); geometry.run();
    assert.equal(container.scrollTop, 400); assert.equal(fakeDocument.activeElement, control); assert.equal(control.moves, moves);
    assert.deepEqual(readings, []); assert.equal((Reflect.get(view, 'heights') as Map<string, number>).get('e0'), 140);
    fakeDocument.activeElement = null; container.dispatch('focusout'); assert.equal(geometry.timers.size, 1); geometry.run();
    assert.equal(container.scrollTop, 500); assert.equal(control.moves, moves);
    assert.equal((Reflect.get(view, 'heights') as Map<string, number>).get('e0'), 240);
    assert.deepEqual(readings, [{revision: 3, anchorId: 'e2', offsetPx: 120, followTail: false}]);
  } finally { geometry.restore(); }
});
test('registered output preserves native caps, fractional offsets, native end, selection and focus without changing text', () => {
  setup(); const geometry = geometryEnvironment();
  try {
    const view = transcript(); const output = Array.from({length: 200}, (_, i) => `queue/check ${i + 1}: receipt retained`).join('\n');
    const row = {id: 'long', kind: 'message', messages: [{...message('r', ''), role: 'toolResult', parts: [{type: 'toolResult' as const, callId: 'long', name: 'bash', isError: false, parts: [{type: 'text' as const, text: output}]}]}]};
    view.set([row]); flush(); const container = node('primary-transcript'); const card = container.querySelector('.tool-card'); assert.ok(card);
    card.open = true; card.dispatch('toggle'); flush(); const pre = card.querySelector('.tool-output-text'); assert.ok(pre);
    const summary = card.querySelector('summary'); assert.ok(summary); summary.focus();
    Object.defineProperty(pre, 'clientHeight', {get: () => Math.round((Number.parseFloat(pre.style.maxHeight ?? '') || 480) - 12)});
    Object.defineProperty(pre, 'scrollHeight', {get: () => 4400});
    const observer = geometry.observers[0]; assert.ok(observer); assert.equal(observer.observed.has(pre as unknown as Element), true);
    observer.emit(pre, 400, 468); geometry.run(); assert.equal(pre.style.maxHeight, undefined); assert.equal(pre.scrollTop, 0);
    assert.equal(pre.textContent, output); assert.equal(fakeDocument.activeElement, summary);
    fakeDocument.activeElement = null; container.dispatch('focusout'); geometry.run();
    assert.equal(pre.style.maxHeight, undefined); assert.equal(pre.scrollTop, 0); assert.equal(pre.textContent, output);
    pre.scrollTop = pre.scrollHeight - pre.clientHeight; pre.dispatch('scroll'); observer.emit(pre, 401, 462); geometry.run();
    const end = pre.scrollTop; pre.dispatch('scrollend'); assert.equal(pre.scrollTop, end); assert.match(pre.textContent, /queue\/check 200: receipt retained$/);
    pre.scrollTop = 21; selection = {isCollapsed: false, anchorNode: pre, focusNode: pre}; pre.dispatch('scrollend'); assert.equal(pre.scrollTop, 21); selection = null;
    pre.dispatch('scrollend'); assert.equal(pre.scrollTop, 21);
    container.dispatch('scrollend', {target: pre}); assert.equal(pre.scrollTop, 21);
    view.set([]); flush(); assert.equal(observer.observed.has(pre as unknown as Element), false);
    pre.scrollTop = 21; pre.dispatch('scrollend'); assert.equal(pre.scrollTop, 21, 'a discarded viewport never adjusts a new transcript');
    view.reset(); assert.deepEqual([...observer.observed], [container as unknown as Element]);
  } finally { geometry.restore(); }
});
test('tool output facts survive metadata-only refresh and full output references stay inert', () => {
  setup(); const view = transcript(); const parts = [{type: 'text' as const, text: 'retained output'}];
  const row = (output: {fullOutputPath?: string; truncation?: {truncated: true; truncatedBy?: 'bytes'; outputBytes?: number; totalBytes?: number}}) => ({id: 'r', kind: 'message', messages: [{...message('r', ''), role: 'toolResult', parts: [{type: 'toolResult' as const, callId: 'b', name: 'bash', isError: false, parts, output}]}]});
  view.set([row({truncation: {truncated: true, truncatedBy: 'bytes', outputBytes: 20, totalBytes: 200}, fullOutputPath: 'https://untrusted.test/<script>path</script>'})]); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const info = card.querySelector('.tool-output-info'); assert.ok(info); assert.match(info.textContent, /20\/200 bytes/);
  assert.match(info.textContent, /https:\/\/untrusted.test\/<script>path/); assert.equal(info.querySelector('a'), null); assert.equal(info.querySelector('script'), null);
  view.set([row({truncation: {truncated: true}})]); flush(); assert.equal(card.querySelector('.tool-output-info'), info);
  assert.match(info.textContent, /Full output reference not supplied/); assert.doesNotMatch(info.textContent, /untrusted/);
  view.set([row({})]); flush(); assert.equal(info.hidden, false); assert.match(info.textContent, /not supplied/);
});
function sessionEntry(id: string, text: string, severity?: string) {
  return {id, kind: 'custom', data: {value: {text, ...(severity ? {severity} : {})}, truncated: false}};
}
function contentEntry(id: string, args: Record<string, unknown>, text: string, isError = false, structured?: JsonDisplay) {
  return {id, kind: 'message', messages: [{...message(id, ''), parts: [
    {type: 'toolCall' as const, callId: id, name: 'custom', arguments: {value: args, truncated: false}},
    {type: 'toolResult' as const, callId: id, name: 'custom', isError, parts: [{type: 'text' as const, text, ...(structured ? {structured} : {})}] as PartView[]},
  ]}]};
}
test('session groups fold adjacent visible events and show actionable notices outside their lazy body', () => {
  setup(); const view = transcript();
  view.set([sessionEntry('a', 'quiet'), sessionEntry('b', 'Check the input', 'warning'), entry('empty', ''), sessionEntry('c', 'later')]); flush();
  const root = node('primary-transcript'); const groups = root.querySelectorAll('.session-events');
  assert.equal(groups.length, 1); assert.match(groups[0]?.textContent ?? '', /3 session events/);
  assert.match(root.textContent, /Check the input/); assert.doesNotMatch(root.textContent, /quiet|later/);
  assert.equal(groups[0]?.querySelectorAll('.custom-entry').length, 0);
  const first = groups[0]; assert.ok(first); first.open = true; first.dispatch('toggle');
  assert.match(first.textContent, /quiet/); assert.match(first.textContent, /later/); assert.equal(first.querySelectorAll('.custom-entry').length, 3);
});
test('compact tool and thinking messages omit empty parts without losing message, event or tool controls', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); const copied: string[] = [];
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => {copied.push(text);}}}});
  try {
  setup(); const view = transcript(); const source = contentEntry('compact', {}, 'retained output');
  const sourceMessage = source.messages[0]; assert.ok(sourceMessage);
  (sourceMessage.parts as PartView[]).unshift({type: 'text', text: ' \n '});
  const thinking = {id: 'thought-compact', kind: 'message', messages: [{...message('thought-compact', ''), parts: [{type: 'text' as const, text: ''}, {type: 'thinking' as const, text: 'Retained thought'}]}]};
  view.set([source, sessionEntry('notice', 'Check this warning', 'warning'), thinking]); flush();
  const root = node('primary-transcript'); const compact = root.querySelector('.tool-only'); assert.ok(compact);
  const body = compact.querySelector('.message-body'); assert.ok(body); assert.equal(body.children.length, 1);
  assert.ok(body.children[0]?.classList.contains('tool-shell'));
  assert.equal(compact.querySelector('.message-actions')?.hidden, false);
  assert.ok(compact.closest('.compact-entry'));
  const copy = messageAction(compact, 'Copy'); assert.equal(copy.enabled, true); copy.run(); await Promise.resolve(); assert.equal(copied.at(-1), ' \n \n\nretained output'); assert.equal(compact.querySelector('.message-menu')?.attributes['aria-label'], 'Message actions');
  assert.ok(compact.querySelector('.tool-copy')); assert.match(root.textContent, /Check this warning/);
  assert.equal(root.querySelector('.session-events')?.querySelector('summary')?.textContent, '1 session event');
  const thought = root.querySelector('.thinking-only'); assert.ok(thought);
  assert.equal(thought.querySelector('.message-body')?.children.length, 1);
  assert.equal(thought.querySelector('.message-actions')?.hidden, false);
  const detail = thought.querySelector('.thinking'); assert.ok(detail); detail.open = true; detail.dispatch('toggle');
  assert.match(detail.textContent, /Retained thought/);
  const next = {...source, messages: [{...sourceMessage, parts: [...sourceMessage.parts, {type: 'text' as const, text: 'Visible prose'}]}]};
  view.set([next, thinking]); flush(); assert.equal(root.querySelector('.tool-only'), null);
  assert.equal(compact.querySelector('.message-actions')?.hidden, false);
  assert.equal(messageAction(compact, 'Copy').enabled, true); assert.equal(compact.querySelector('.message-menu')?.attributes['aria-label'], 'Message actions'); assert.match(root.textContent, /Visible prose/);
  messageAction(compact, 'Copy').run(); await Promise.resolve(); assert.equal(copied.at(-1), ' \n \n\nretained output\nVisible prose');
  } finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
});

test('adjacent thinking chunks share one disclosure and preserve retained inspection and preferences', () => {
  setup(); const view = transcript();
  const source = {id: 'grouped-thought', kind: 'message', messages: [{...message('grouped-thought', ''), parts: [
    {type: 'thinking' as const, text: 'First retained chunk'},
    {type: 'thinking' as const, text: 'Long retained chunk '.repeat(500)},
    {type: 'thinking' as const, text: 'Last retained chunk'},
    {type: 'omitted' as const, label: 'Exact omitted-part label'},
  ]}]};
  view.set([source]); flush(); const root = node('primary-transcript');
  const group = root.querySelector('.thinking-group'); assert.ok(group); assert.equal(group.open, false);
  assert.equal(root.querySelector('.message-body')?.children.length, 2);
  assert.equal(root.querySelector('.message-coverage')?.textContent, 'Exact omitted-part label');
  assert.ok(root.querySelector('.thinking-only')); assert.equal(root.querySelector('.message-actions')?.hidden, false);
  const parts = group.children[1]?.children ?? []; assert.equal(parts.length, 3);
  const ids = parts.map(part => part.dataset.disclosure); assert.equal(new Set(ids).size, 3);
  assert.ok(parts.every(part => part.querySelector('summary')?.hidden));
  group.open = true; group.dispatch('toggle'); flush(); assert.ok(parts.every(part => part.open));
  assert.match(group.textContent, /First retained chunk/); assert.match(group.textContent, /Last retained chunk/);
  const inspection = group.querySelectorAll('details').find(details => details.children[0]?.textContent === 'More thinking'); assert.ok(inspection);
  assert.equal(inspection.querySelector('pre'), null); inspection.open = true; inspection.dispatch('toggle');
  assert.ok(inspection.querySelector('pre')); assert.equal(inspection.querySelector('pre')?.textContent, 'Long retained chunk '.repeat(500));
  view.expandLoaded(false, false); flush(); assert.equal(group.open, false); assert.ok(parts.every(part => !part.open));
  view.expandLoaded(false, true); flush(); assert.equal(group.open, true);
  view.set([{...source, messages: [{...source.messages[0], parts: [...source.messages[0].parts.slice(0, 3), {type: 'thinking', text: 'Appended retained chunk'}, source.messages[0].parts[3]]}]}]); flush();
  assert.equal(root.querySelector('.thinking-group'), group); assert.equal(group.children[1]?.children[0], parts[0]);
  assert.match(group.textContent, /Appended retained chunk/);
});
for (const count of [1, 2]) test(`supplied live thinking stays visible through saved collapse with ${count} parts`, () => {
  setup(); const choices: {expanded: string[]; thinking: boolean}[] = [];
  const view = new Transcript('primary', {reading: () => {}, presentation: (expanded, thinking) => {choices.push({expanded, thinking});}});
  const saved = {revision: 1, expanded: [], showThinking: false}; view.configure(saved);
  const thought = (id: string, state: 'partial' | 'final', text: string): EntryView => ({id, kind: 'message', messages: [{...message(id, '', state),
    parts: Array.from({length: count}, (_, index) => ({type: 'thinking', text: `${text} ${index}`}))}]});
  const retained = thought('retained', 'final', 'Older retained thinking');
  view.set([retained, thought('stream', 'partial', 'Supplied live thinking')]); flush();
  const root = node('primary-transcript'), live = root.children.find(row => row.dataset.entryId === 'stream'); assert.ok(live);
  const older = root.children.find(row => row.dataset.entryId === 'retained'); assert.ok(older);
  assert.equal(older.querySelectorAll('.thinking').every(node => !node.open), true);
  assert.equal(live.querySelectorAll('.thinking').every(node => node.open), true);
  for (const node of live.querySelectorAll('.thinking')) node.dispatch('toggle');
  assert.equal(choices.length, 0, 'automatic expansion does not become a saved choice');
  view.configure(saved); view.expandLoaded(false, false); flush();
  assert.equal(live.querySelectorAll('.thinking').every(node => node.open), true);
  assert.equal(choices.at(-1)?.thinking, false); assert.deepEqual(choices.at(-1)?.expanded, []);
  view.set([retained, thought('stream', 'partial', 'More supplied live thinking')]); flush();
  assert.match(live.textContent, /More supplied live thinking/);
  view.set([retained, thought('stream', 'final', 'Complete retained thinking')]); flush();
  assert.equal(live.querySelectorAll('.thinking').every(node => !node.open), true, 'settlement restores the retained choice');
  const disclosure = live.querySelector('.thinking'); assert.ok(disclosure); disclosure.open = true; disclosure.dispatch('toggle'); flush();
  view.set([retained, thought('stream', 'final', 'Updated retained thinking')]); flush(); assert.equal(disclosure.open, true);
  view.reset();
});
test('retained collapse does not save a forced live thinking expansion', () => {
  setup(); let saved: string[] = []; const view = new Transcript('primary', {reading: () => {}, presentation: value => {saved = value;}});
  const thought = (id: string, state: 'partial' | 'final'): EntryView => ({id, kind: 'message', messages: [{...message(id, '', state), parts: [{type: 'thinking', text: id}]}]});
  const older = thought('older', 'final'); view.set([older, thought('live', 'partial')]); flush();
  const root = node('primary-transcript'), retained = root.children.find(row => row.dataset.entryId === 'older')?.querySelector('.thinking'); assert.ok(retained);
  retained.open = false; retained.dispatch('toggle'); flush(); assert.deepEqual(saved, []);
  const live = root.children.find(row => row.dataset.entryId === 'live')?.querySelector('.thinking'); assert.ok(live); assert.equal(live.open, true);
  view.set([older, thought('live', 'final')]); flush(); assert.equal(live.open, false); view.reset();
});
test('empty and redacted partial thinking do not invent readable thinking', () => {
  setup(); const view = transcript(); view.configure({revision: 1, expanded: [], showThinking: false});
  view.set([{id: 'empty-thinking', kind: 'message', messages: [{...message('empty-thinking', '', 'partial'), parts: [{type: 'thinking', text: ''}]}]}]); flush();
  const root = node('primary-transcript'); assert.equal(root.querySelector('.thinking'), null);
  view.set([{id: 'redacted-thinking', kind: 'message', messages: [{...message('redacted-thinking', '', 'partial'), parts: [{type: 'thinking', text: 'withheld bytes', redacted: true}]}]}]); flush();
  const redacted = root.querySelector('.thinking'); assert.ok(redacted); assert.equal(redacted.open, false);
  assert.doesNotMatch(redacted.textContent, /withheld bytes/); assert.match(redacted.textContent, /Thinking not available/); view.reset();
});
test('thinking grouping preserves an expanded original disclosure', () => {
  setup(); const view = transcript(); const first = {type: 'thinking' as const, text: 'Original retained chunk'};
  const source = {id: 'expanded-thought', kind: 'message', messages: [{...message('expanded-thought', ''), parts: [first]}]};
  view.set([source]); flush(); const original = node('primary-transcript').querySelector('.thinking'); assert.ok(original);
  const id = original.dataset.disclosure; original.open = true; original.dispatch('toggle'); flush();
  view.set([{...source, messages: [{...source.messages[0], parts: [first, {type: 'thinking', text: 'New retained chunk'}]}]}]); flush();
  const group = node('primary-transcript').querySelector('.thinking-group'); assert.ok(group); assert.equal(group.open, true);
  assert.equal(group.children[1]?.children[0], original); assert.equal(original.dataset.disclosure, id); assert.equal(original.open, true);
});
test('thinking grouping preserves a focused original disclosure', () => {
  setup(); const view = transcript(); const first = {type: 'thinking' as const, text: 'Retained first chunk'};
  const source = {id: 'protected-thought', kind: 'message', messages: [{...message('protected-thought', ''), parts: [first]}]};
  view.set([source]); flush(); const thought = node('primary-transcript').querySelector('.thinking'); assert.ok(thought);
  const summary = thought.querySelector('summary'); assert.ok(summary); summary.focus();
  view.set([{...source, messages: [{...source.messages[0], parts: [first, {type: 'thinking', text: 'Retained second chunk'}]}]}]); flush();
  assert.equal(node('primary-transcript').querySelector('.thinking'), thought); assert.equal(document.activeElement, summary);
  assert.equal(summary.hidden, false); assert.equal(node('primary-transcript').querySelector('.thinking-group'), null);
  node('primary-editor').focus(); node('primary-transcript').dispatch('focusout'); flush();
  const group = node('primary-transcript').querySelector('.thinking-group'); assert.ok(group);
  assert.equal(group.children[1]?.children[0], thought); assert.equal(document.activeElement, node('primary-editor'));
});
test('coverage metadata keeps thinking and tool messages compact without hiding retained content', () => {
  setup(); const view = transcript();
  const thought = {id: 'covered-thought', kind: 'message', messages: [{...message('covered-thought', ''),
    parts: [{type: 'thinking' as const, text: 'Retained reasoning'}],
    coverage: {complete: false, truncated: true, omitted: 2, reason: 'Exact coverage reason'}}]};
  const tool = contentEntry('covered-tool', {}, 'Retained tool output');
  tool.messages[0].coverage = {complete: false, truncated: true, omitted: 1, reason: 'Exact tool coverage'};
  view.set([thought, tool]); flush();
  const root = node('primary-transcript');
  const thoughtEntry = root.children.find(child => child.dataset.entryId === 'covered-thought'); assert.ok(thoughtEntry);
  const toolEntry = root.children.find(child => child.dataset.entryId === 'covered-tool'); assert.ok(toolEntry);
  for (const row of [thoughtEntry, toolEntry]) {
    assert.equal(row.classList.contains('compact-entry'), true); assert.equal(row.querySelector('.message-actions')?.hidden, false);
    assert.ok(row.querySelector('.message-coverage'));
  }
  assert.ok(thoughtEntry.querySelector('.thinking-only')); assert.ok(toolEntry.querySelector('.tool-only'));
  assert.equal(thoughtEntry.querySelector('.message-coverage')?.textContent, 'Exact coverage reason');
  assert.equal(toolEntry.querySelector('.message-coverage')?.textContent, 'Exact tool coverage');
  const disclosure = thoughtEntry.querySelector('.thinking'); assert.ok(disclosure); assert.equal(disclosure.open, false);
  disclosure.open = true; disclosure.dispatch('toggle'); flush(); assert.match(thoughtEntry.textContent, /Retained reasoning/);
  const card = toolEntry.querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  assert.match(toolEntry.textContent, /Retained tool output/); assert.equal(toolEntry.querySelector('.tool-copy')?.hidden, false);
});
test('compact message updates keep a focused Copy action visible until focus leaves', () => {
  setup(); const view = transcript(); const source = contentEntry('focused-compact', {}, 'retained output');
  const msg = source.messages[0]; assert.ok(msg);
  view.set([{...source, messages: [{...msg, parts: [...msg.parts, {type: 'text', text: 'Visible prose'}]}]}]); flush();
  const root = node('primary-transcript'); const card = root.querySelector('.message'); assert.ok(card); const action = card.querySelector('.message-menu'); assert.ok(action); assert.equal(messageAction(card, 'Copy').enabled, true);
  action.focus(); view.set([source]); flush();
  assert.equal(fakeDocument.activeElement, action); assert.equal(root.querySelector('.message-actions')?.hidden, false);
  assert.equal(card.querySelector('.message-menu'), action); assert.equal(messageAction(card, 'Copy').enabled, true);
  fakeDocument.activeElement = null; view.schedule(); flush(); assert.equal(root.querySelector('.message-actions')?.hidden, false); assert.equal(card.querySelector('.message-menu'), action);
});
test('single visible session events use a singular caption', () => {
  setup(); const view = transcript(); view.set([sessionEntry('single', 'retained event')]); flush();
  const group = node('primary-transcript').querySelector('.session-events'); assert.ok(group);
  assert.equal(group.querySelector('summary')?.textContent, '1 session event');
});
test('session find mounts the matching member page and saved member anchors map to its representative', () => {
  setup(); const readings: ReadingView[] = []; const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)});
  const entries = Array.from({length: 75}, (_, i) => sessionEntry(`s${i}`, `event ${i}`));
  view.configure(undefined, {revision: 4, anchorId: 's39', offsetPx: 0, followTail: false}); view.set(entries); flush();
  view.find().next('event 39'); const root = node('primary-transcript'); const group = root.querySelector('.session-events'); assert.ok(group);
  assert.equal(group.open, true); assert.match(group.textContent, /event 39/); assert.doesNotMatch(group.textContent, /event 0custom/);
  assert.equal(group.querySelectorAll('.custom-entry').length, 32);
  assert.equal(root.children[0]?.dataset.entryId, 's0'); assert.equal(fakeDocument.activeElement, null); assert.equal(group.querySelectorAll('.find-current')[0]?.dataset.sessionEventId, 's39');
  root.dispatch('scrollend'); assert.equal(readings.at(-1)?.anchorId, 's0'); assert.equal(readings.at(-1)?.followTail, false);
  const buttons = group.querySelectorAll('button'); const next = buttons.at(-1); assert.ok(next); next.dispatch('click');
  assert.equal(group.querySelectorAll('.custom-entry').length, 11); assert.match(group.textContent, /event 74/);
});
test('session representative changes preserve the disclosure node, focus and expansion state', () => {
  setup(); const view = transcript(); const first = sessionEntry('first', 'one'); const second = sessionEntry('second', 'two');
  view.set([first, second]); flush(); const root = node('primary-transcript'); const group = root.querySelector('.session-events'); assert.ok(group);
  group.open = true; group.dispatch('toggle'); flush(); const summary = group.querySelector('summary'); assert.ok(summary); summary.focus();
  view.set([sessionEntry('earlier', 'zero'), first, second]); flush();
  assert.equal(root.querySelector('.session-events'), group); assert.equal(group.open, true); assert.equal(fakeDocument.activeElement, summary);
  assert.equal(group.dataset.disclosure, 'events:earlier'); assert.equal(root.children[0]?.dataset.entryId, 'earlier');
  group.open = false; group.dispatch('toggle'); flush(); assert.equal(group.open, false);
  assert.equal((Reflect.get(view, 'expanded') as Set<string>).has('events:earlier'), false);
});
test('session notices and expanded rows keep bounded pages and reset releases their nodes', () => {
  setup(); const view = transcript(); view.set(Array.from({length: 90}, (_, i) => sessionEntry(`n${i}`, `notice ${i}`, 'warning'))); flush();
  const root = node('primary-transcript'); assert.equal(root.querySelectorAll('.custom-entry').length, 16);
  const group = root.querySelector('.session-events'); assert.ok(group); group.open = true; group.dispatch('toggle'); flush();
  assert.equal(group.querySelectorAll('.custom-entry').length, 32); assert.equal(root.querySelectorAll('.custom-entry').length, 48);
  view.reset(); flush(); assert.equal(root.children.length, 0); assert.equal(group.isConnected, false);
});
test('complete projected documents do not depend on the retained raw page prefix', () => {
  setup(); const body = `# Complete document\n\n${'Retained paragraph.\n\n'.repeat(20)}Final retained paragraph.`;
  const raw = JSON.stringify({usage: {note: 'metadata '.repeat(1400)}, body});
  const source = contentEntry('complete', {}, raw.slice(0, 8192), false, {value: {usage: {note: 'metadata'}, body}, truncated: true});
  const result = source.messages[0]?.parts.find(part => part.type === 'toolResult'); assert.ok(result);
  result.parts[0] = {...result.parts[0] as Extract<PartView, {type: 'text'}>, more: {entryId: 'complete', part: 0, offset: 8192}};
  const view = transcript(); view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('h1')?.textContent, 'Complete document');
  assert.match(card.querySelector('.tool-document')?.textContent ?? '', /Final retained paragraph/);
  assert.equal(card.querySelector('.preview-omission')?.textContent, 'Some output was not retained. Show saved output');
  assert.equal(card.querySelectorAll('.preview-omission').length, 1); assert.ok(card.querySelector('.tool-result-part')?.querySelector('.output-pages'));
});

test('expanded plain output has one Result header with Wrap and retains exact copy and disclosures', async () => {
  setup(); const view = transcript(); const raw = '  retained output\nsecond line\n';
  view.set([contentEntry('single-result', {}, raw, false)]); flush();
  const root = node('primary-transcript'), card = root.querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush();
  const labels = card.querySelectorAll('.source-header').flatMap(header => header.querySelectorAll('span')).filter(label => label.textContent === 'Result');
  assert.equal(labels.length, 1); assert.equal(card.querySelector('.tool-result-label'), null);
  assert.equal(card.querySelector('.tool-output-text')?.textContent, raw);
  assert.ok(card.querySelectorAll('button').some(button => button.textContent === 'Wrap'));
  assert.ok(card.querySelectorAll('summary').some(summary => summary.textContent === 'Arguments'));
  assert.ok(card.querySelectorAll('summary').some(summary => summary.textContent === 'Raw output'));
  assert.ok(card.querySelectorAll('summary').some(summary => summary.textContent === 'Display limits'));
  let copied = ''; const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => {copied = text;}}}});
  try { const copy = card.parentNode?.querySelector('.tool-copy'); assert.ok(copy); copy.dispatch('click', {stopPropagation: () => {}}); await Promise.resolve(); assert.equal(copied, raw); }
  finally { if (original) Object.defineProperty(globalThis, 'navigator', original); else Reflect.deleteProperty(globalThis, 'navigator'); }
  view.destroy();
});
test('a saved null anchor restores the start and permits later geometry and reading writes', () => {
  setup(); const readings: ReadingView[] = []; const view = new Transcript('primary', {presentation: () => {}, reading: reading => readings.push(reading)});
  const reading = {revision: 3, anchorId: null, offsetPx: 0, followTail: false};
  view.configure(undefined, reading); view.set(Array.from({length: 20}, (_, index) => entry(`start-${index}`))); flush();
  const root = node('primary-transcript'); assert.equal(root.scrollTop, 0); assert.equal(view.restorationCurrent(reading), false);
  root.dispatch('scrollend'); assert.equal(readings.length, 1); assert.equal(readings[0]?.followTail, false);
  const saved = view.captureGeometry(); root.scrollTop = 500; view.applyGeometry(saved); assert.equal(root.scrollTop, 0);
  view.destroy();
});
test('structured result parts preserve plain text, image and omission order without duplicate images', () => {
  setup(); const source = contentEntry('parts', {}, '');
  const result = source.messages[0]?.parts.find(part => part.type === 'toolResult'); assert.ok(result);
  result.parts = [{type: 'text', text: 'First protected part'},
    {type: 'text', text: '{"body":"# Second\\nDocument"}', structured: {value: {body: '# Second\nDocument'}, truncated: false}},
    {type: 'image', mimeType: 'image/png', digest: 'a'.repeat(64), width: 2, height: 2, bytes: 20, alt: 'Retained image'},
    {type: 'omitted', label: 'Fourth part omitted by host'}, {type: 'text', text: 'Last protected part'}];
  const view = transcript(); view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush(); const parts = card.querySelector('.tool-result-parts'); assert.ok(parts);
  assert.equal(parts.children.length, 5); assert.equal(parts.children[0]?.querySelector('pre')?.textContent, 'First protected part');
  assert.equal(parts.children[1]?.querySelector('h1')?.textContent, 'Second'); assert.equal(parts.querySelectorAll('.image-part').length, 1);
  assert.match(parts.children[3]?.textContent ?? '', /Fourth part omitted/); assert.equal(parts.children[4]?.querySelector('pre')?.textContent, 'Last protected part');
  assert.equal(card.querySelector('.tool-images'), null);
});
test('absent structured projection leaves JSON prefixes plain and raw inspection excludes sidecars', () => {
  setup(); const prefix = '{"body":"incomplete'; const view = transcript(); view.set([contentEntry('plain-prefix', {}, prefix)]); flush();
  let card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('.tool-document'), null); assert.equal(card.querySelector('.tool-output-text')?.textContent, prefix);
  const raw = '{"result":"{\\"body\\":\\"# Original\\nProtected source\\"}"}';
  view.set([contentEntry('raw-only', {}, raw, false, {value: {result: {body: '# Original\nProtected source'}}, truncated: false})]); flush();
  card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const inspection = card.querySelectorAll('details').find(detail => detail.querySelector('summary')?.textContent === 'Raw output'); assert.ok(inspection);
  inspection.open = true; inspection.dispatch('toggle'); assert.equal(inspection.querySelector('pre')?.textContent, raw);
});
test('structured result expansion is lazy and exact raw copy survives document and metadata formatting', async () => {
  setup(); const raw = JSON.stringify({title: 'Retained title', result: JSON.stringify({document: '# Document\n\nFirst paragraph.\n\nSecond paragraph.', rows: [{id: 1, value: 'one'}]}), cursor: 'cursor-token', coverage: {complete: true}});
  const decoded = {title: 'Retained title', result: {document: '# Document\n\nFirst paragraph.\n\nSecond paragraph.', rows: [{id: 1, value: 'one'}]}, cursor: 'cursor-token', coverage: {complete: true}};
  const view = transcript(); view.set([contentEntry('json', {}, raw, false, {value: decoded, truncated: false})]); flush();
  const root = node('primary-transcript'); const card = root.querySelector('.tool-card'); assert.ok(card);
  assert.equal(card.querySelector('.tool-document'), null); card.open = true; card.dispatch('toggle'); flush();
  assert.ok(card.querySelector('.tool-document')); assert.ok(card.querySelector('.tool-rows'));
  const metadata = card.querySelector('.tool-metadata'); assert.ok(metadata); assert.equal(metadata.querySelector('dl'), null);
  metadata.open = true; metadata.dispatch('toggle'); assert.match(metadata.textContent, /cursor-token/);
  const pre = card.querySelector('.tool-output-text'); assert.ok(pre); assert.equal(pre.hidden, true); assert.equal(pre.textContent, '');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let copied = '';
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => { copied = text; }}}});
  try { const action = card.parentNode?.querySelector('.tool-copy'); assert.ok(action); action.dispatch('click', {stopPropagation: () => {}}); await Promise.resolve(); assert.equal(copied, raw); }
  finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
test('generic source arguments precede output and their own collapse survives result refresh', () => {
  setup(); const view = transcript(); const args = {program: 'const value = 1;\nreturn value;', language: 'typescript'};
  view.set([contentEntry('program', args, 'first result')]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush(); const source = card.querySelector('.tool-source'); assert.ok(source);
  assert.equal(source.open, true); assert.equal(source.querySelector('pre')?.textContent, args.program); assert.ok(source.querySelector('span'));
  const expanded = card.querySelector('.tool-expanded'); assert.ok(expanded); const argumentsNode = card.querySelector('.tool-arguments'); assert.ok(argumentsNode); assert.equal(argumentsNode.contains(source), true);
  const output = card.querySelector('.tool-output-text'); assert.ok(output);
  assert.ok(expanded.children.indexOf(argumentsNode) > expanded.children.indexOf(output));
  source.open = false; source.dispatch('toggle'); view.set([contentEntry('program', args, 'second result')]); flush();
  assert.equal(card.querySelector('.tool-source'), source); assert.equal(source.open, false); assert.equal(card.querySelector('.tool-output-text')?.textContent, 'second result');
});
test('generic supplied edits and documents keep output distinct while errors remain plain', () => {
  setup(); const view = transcript(); const args = {edits: [{oldText: 'before supplied', newText: 'after supplied'}], document: '# Supplied\n\nRetained text'};
  view.set([contentEntry('edits', args, 'ordinary output')]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush(); assert.match(card.querySelector('.diff-del')?.textContent ?? '', /before supplied/);
  assert.match(card.querySelector('.diff-add')?.textContent ?? '', /after supplied/); assert.ok(card.querySelector('.tool-document'));
  assert.equal(card.querySelector('.tool-output-text')?.textContent, 'ordinary output');
  const error = '{"document":"failed\\nretained"}'; view.set([contentEntry('edits', args, error, true)]); flush();
  assert.equal(card.parentNode?.dataset.status, 'error'); assert.equal(card.querySelector('.tool-output-text')?.textContent, error); assert.equal(card.querySelector('.tool-output-text')?.hidden, false);
});
test('structured document refresh preserves focused and selected content until the guard clears', () => {
  setup(); const view = transcript(); const args = {};
  view.set([contentEntry('document', args, '{"document":"# First\\n\\nRetained paragraph."}', false, {value: {document: '# First\n\nRetained paragraph.'}, truncated: false})]); flush();
  const root = node('primary-transcript'); const card = root.querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const first = card.querySelector('.tool-document'); assert.ok(first); const paragraph = first.querySelector('p'); assert.ok(paragraph); paragraph.focus();
  view.set([contentEntry('document', args, '{"document":"# Second\\n\\nNew paragraph."}', false, {value: {document: '# Second\n\nNew paragraph.'}, truncated: false})]); flush();
  assert.equal(card.querySelector('.tool-document'), first); assert.equal(fakeDocument.activeElement, paragraph); assert.match(first.textContent, /First/);
  fakeDocument.activeElement = null; root.dispatch('focusout'); flush(); assert.match(card.querySelector('.tool-document')?.textContent ?? '', /Second/);
  const second = card.querySelector('.tool-document'); assert.ok(second); selection = {isCollapsed: false, anchorNode: second, focusNode: second};
  view.set([contentEntry('document', args, '{"document":"# Third\\n\\nLatest paragraph."}', false, {value: {document: '# Third\n\nLatest paragraph.'}, truncated: false})]); flush(); assert.equal(card.querySelector('.tool-document'), second);
  selection = null; fakeDocument.dispatch('selectionchange'); flush(); assert.match(card.querySelector('.tool-document')?.textContent ?? '', /Third/);
});
test('native output boundaries expose exact retained text and keyboard focus without line paint cuts', () => {
  setup(); const view = transcript(); const raw = JSON.stringify({body: '# Result\n\nParagraph', rows: [{id: 1}, {id: 2}]});
  view.set([contentEntry('native', {program: 'first\nsecond'}, raw, false, {value: {body: '# Result\n\nParagraph', rows: [{id: 1}, {id: 2}]}, truncated: false})]); flush();
  const root = node('primary-transcript'); const card = root.querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const detail = card.querySelectorAll('details').find(item => item.firstChild?.textContent === 'Raw output'); assert.ok(detail);
  detail.open = true; detail.dispatch('toggle'); flush(); const pre = detail.querySelector('pre'); assert.ok(pre);
  assert.equal(pre.textContent, raw); assert.equal(pre.tabIndex, 0); assert.equal(pre.attributes.role, 'region');
  const table = card.querySelector('.tool-rows'); assert.ok(table); assert.equal(table.tabIndex, 0);
  const range = {isCollapsed: false, anchorNode: pre, focusNode: pre}; selection = range; pre.focus();
  pre.scrollTop = 21.375; pre.dispatch('scroll'); pre.dispatch('scrollend');
  assert.equal(pre.scrollTop, 21.375); assert.equal(selection, range); assert.equal(fakeDocument.activeElement, pre); assert.equal(pre.textContent, raw);
  for (const flow of root.querySelectorAll('pre,p,th,td,summary')) assert.equal(flow.hasAttribute('data-rest-lines'), false);
  assert.equal(Reflect.has(view, 'restFrames'), false); assert.equal(Reflect.has(view, 'restPlan'), false);
});
test('transcript context distinguishes selected text from full content and captures the exact item', async () => {
  setup(); const body = new FakeNode('body'); roots.push(body);
  Reflect.set(fakeDocument, 'body', body); Reflect.set(fakeDocument, 'defaultView', {innerWidth: 1000, innerHeight: 760, addEventListener() {}, removeEventListener() {}});
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); const copied: string[] = [];
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => {copied.push(text);}}}});
  try {
    const view = transcript(); view.set([entry('context-content', 'Full retained paragraph')]); flush();
    const root = node('primary-transcript'); const paragraph = root.querySelector('p'); const article = root.querySelector('.message'); assert.ok(paragraph); assert.ok(article);
    selection = {isCollapsed: false, anchorNode: paragraph, focusNode: paragraph, toString: () => 'retained'};
    root.dispatch('contextmenu', {target: paragraph, clientX: 990, clientY: 750, preventDefault() {}, stopPropagation() {}});
    let menu = body.querySelector('.context-menu'); assert.ok(menu); assert.deepEqual(menu.children.map(row => row.textContent), ['Copy selection', 'Copy', 'Source']);
    assert.equal(fakeDocument.activeElement, menu.children[0]); assert.equal(article.tabIndex, -1);
    selection = null; menu.children[0]?.dispatch('click'); await Promise.resolve(); assert.deepEqual(copied, ['retained']); assert.equal(fakeDocument.activeElement, article);
    root.dispatch('contextmenu', {target: paragraph, clientX: 20, clientY: 20, preventDefault() {}, stopPropagation() {}});
    menu = body.querySelector('.context-menu'); assert.ok(menu); assert.deepEqual(menu.children.map(row => row.textContent), ['Copy', 'Source']);
    view.reset(); view.set([entry('changed', 'New paragraph')]); flush(); menu.children[0]?.dispatch('click'); await Promise.resolve(); assert.deepEqual(copied, ['retained']);
    assert.match(node('announcements').textContent, /This item changed. Choose the action again./);
  } finally {
    contextMenu.close(false); Reflect.deleteProperty(fakeDocument, 'body'); Reflect.deleteProperty(fakeDocument, 'defaultView');
    if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
test('supplied diffs and image captions remain readable without a line measurement registry', () => {
  setup(); const view = transcript(); const args = {edits: [{oldText: 'before\nsecond before', newText: 'after\nsecond after'}]};
  view.set([contentEntry('diff-native', args, 'result')]); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const removed = card.querySelector('.diff-del'); const added = card.querySelector('.diff-add'); assert.ok(removed); assert.ok(added);
  assert.match(removed.textContent, /second before/); assert.match(added.textContent, /second after/);
  view.set([contentEntry('diff-native', args, 'new result')]); flush(); assert.equal(card.querySelector('.diff-del'), removed);
  view.set([{id: 'caption', kind: 'message', messages: [{...message('caption', ''), parts: [{type: 'image', mimeType: 'image/png', digest: 'a'.repeat(64), width: 2, height: 2, bytes: 20, alt: 'Retained image'}]}]}]); flush();
  const caption = node('primary-transcript').querySelector('figcaption'); assert.ok(caption); assert.match(caption.textContent, /PNG/);
  assert.equal(caption.hasAttribute('data-rest-lines'), false);
});
test('shared result budgets retain all part boundaries, raw pages and plain/image/omitted order without raw structured fallback', () => {
  setup(); const view = transcript(); const source = contentEntry('budget', {program: 'argument\nsource'}, '');
  const result = source.messages[0]?.parts.find(part => part.type === 'toolResult'); assert.ok(result);
  const rich: PartView[] = Array.from({length: 100}, (_, index) => ({type: 'text', text: `protected raw ${index} ${'x'.repeat(2000)}`,
    structured: {value: {body: `# Part ${index}\n${'content '.repeat(300)}`}, truncated: false}, more: {entryId: 'budget', part: index, offset: 8192}}));
  result.parts = [{type: 'text', text: 'first plain'}, ...rich, {type: 'image', mimeType: 'image/png', digest: 'b'.repeat(64), bytes: 20, width: 2, height: 2, alt: 'image retained'},
    {type: 'omitted', label: 'omission retained'}, {type: 'text', text: 'last plain'}];
  view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const parts = card.querySelector('.tool-result-parts'); assert.ok(parts); assert.equal(parts.querySelectorAll('.tool-result-part').length, 104);
  assert.equal(parts.querySelectorAll('.output-pages').length, 100); assert.equal(parts.querySelectorAll('.image-part').length, 1);
  assert.equal(card.querySelector('.preview-omission')?.textContent, 'Preview shortened. Show saved output');
  assert.equal(card.querySelectorAll('.preview-omission').length, 1); assert.doesNotMatch(parts.textContent, /Content preview limited\.|protected raw \d/);
  const sections = parts.querySelectorAll('.tool-result-part');
  assert.equal(sections[0]?.querySelector('pre')?.textContent, 'first plain'); assert.ok(sections[101]?.querySelector('.image-part'));
  assert.equal(sections[102]?.textContent, 'omission retained'); assert.equal(sections[103]?.querySelector('pre')?.textContent, 'last plain');
  const previews = parts.querySelectorAll('.tool-content'); const argument = card.querySelector('.tool-arguments')?.querySelector('.tool-content'); assert.ok(argument);
  const shown = previews.reduce((total, preview) => total + preview.textContent.length, argument.textContent.length); assert.ok(shown <= 16384);
  const count = (root: FakeNode): number => 1 + root.childNodes.reduce((total, child) => total + count(child), 0);
  const dom = previews.reduce((total, preview) => total + count(preview), count(argument)); assert.ok(dom <= 512);
  const sourceDisclosure = card.querySelector('.tool-source'); assert.ok(sourceDisclosure); sourceDisclosure.open = false;
  view.set([source]); flush(); assert.equal(card.querySelector('.tool-source'), sourceDisclosure); assert.equal(sourceDisclosure.open, false);
  const empty = contentEntry('empty-structured', {}, '', false, {value: {}, truncated: false});
  const emptyResult = empty.messages[0]?.parts.find(part => part.type === 'toolResult'); assert.ok(emptyResult);
  emptyResult.parts.push({type: 'text', text: 'Useful retained text'}, {type: 'omitted', label: 'Retained host omission'});
  view.set([empty]); flush(); const emptyCard = node('primary-transcript').querySelector('.tool-card'); assert.ok(emptyCard);
  emptyCard.open = true; emptyCard.dispatch('toggle'); flush(); const emptyParts = emptyCard.querySelector('.tool-result-parts'); assert.ok(emptyParts);
  const note = emptyParts.querySelector('.preview-omission'); assert.ok(note); assert.equal(emptyCard.querySelectorAll('.preview-omission').length, 1);
  assert.equal(emptyParts.children.at(-1), note); assert.equal(note.textContent, 'Preview shortened. Show saved output');
  assert.match(emptyParts.textContent, /Useful retained text/); assert.equal(emptyParts.querySelectorAll('.tool-result-part')[2]?.textContent, 'Retained host omission');
});
test('large write/edit previews share one argument root, result budget and deferred metadata budget', () => {
  const count = (root: FakeNode): number => 1 + root.childNodes.reduce((total, child) => total + count(child), 0);
  for (const variant of ['write', 'edit', 'multi-edit']) {
    const name = variant === 'write' ? 'write' : 'edit';
    setup(); const view = transcript(); const text = 'supplied text '.repeat(1200);
    const pairs = Array.from({length: 8}, () => ({oldText: text.slice(0, 1800), newText: text.slice(0, 1800)}));
    const supplied = variant === 'write' ? {content: text} : variant === 'edit' ? {oldText: text, newText: text} : {edits: pairs};
    const args = {...supplied, metadata: {note: 'argument metadata '.repeat(300)}};
    const source = contentEntry(name, args, '', false); const message = source.messages[0]; assert.ok(message); for (const part of message.parts) part.name = name; message.parts = message.parts.filter(part => part.type !== 'toolResult');
    view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
    const argument = card.querySelector('.tool-content'); assert.ok(argument); const raw = card.querySelector('.tool-arguments'); assert.ok(raw); assert.equal(raw.querySelector('.tool-content'), null);
    const part: PartView = {type: 'text', text: 'Saved raw result', structured: {value: {body: 'Initial result', metadata: {note: 'result metadata '.repeat(300)}}, truncated: false}};
    view.set([source], new Map([[name, {callId: name, name, phase: 'end' as const, parts: [part]}]])); flush(); assert.equal(card.querySelector('.tool-content'), argument);
    const roots = card.querySelectorAll('.tool-content'); assert.ok(roots.length <= 2); assert.equal(card.querySelector('.tool-arguments')?.querySelector('.tool-content'), null);
    const budget = () => {const mounted = card.querySelectorAll('.tool-content'); assert.ok(mounted.reduce((total, root) => total + root.textContent.length, 0) <= 16384); assert.ok(mounted.reduce((total, root) => total + count(root), 0) <= 512);}; budget();
    if (variant === 'multi-edit') assert.ok(argument.querySelectorAll('.diff-del').length >= 2);
    const metadata = roots.flatMap(root => root.querySelectorAll('.tool-metadata')); assert.ok(metadata.length); for (const detail of metadata) {detail.open = true; detail.dispatch('toggle');} flush(); budget();
    const argumentMetadata = argument.querySelector('.tool-metadata'); assert.ok(argumentMetadata); assert.match(argumentMetadata.textContent, /argument metadata/);
    const refreshed: PartView = {type: 'text', text: 'Refreshed saved result', structured: {value: {body: 'refreshed result '.repeat(2000), metadata: {note: 'refreshed metadata '.repeat(300)}}, truncated: false}};
    view.set([source], new Map([[name, {callId: name, name, phase: 'end' as const, parts: [refreshed]}]])); flush(); budget();
    assert.equal(card.querySelector('.tool-content'), argument); assert.equal(argument.querySelector('.tool-metadata'), argumentMetadata); assert.equal(argumentMetadata.open, true); assert.match(argumentMetadata.textContent, /argument metadata/);
    raw.open = true; raw.dispatch('toggle'); flush(); assert.deepEqual(JSON.parse(raw.querySelector('pre')?.textContent ?? '{}'), args); assert.equal(raw.querySelector('.tool-content'), null);
    const result = card.querySelectorAll('.source-header').find(header => header.querySelector('.source-language')?.textContent === 'Result'); assert.ok(result); const parent = argument.parentNode; assert.ok(parent); assert.equal(result.parentNode, parent); assert.ok(parent.children.indexOf(argument) < parent.children.indexOf(result));
    view.reset();
  }
});
test('rejected write argument adoption retires its root and isolates late metadata', () => {
  setup(); const view = transcript(); const source = contentEntry('rejected-write', {content: 'Supplied source', metadata: {note: 'Deferred metadata'}}, '', false); const message = source.messages[0]; assert.ok(message); for (const part of message.parts) part.name = 'write'; message.parts = message.parts.filter(part => part.type !== 'toolResult');
  view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const rejected = card.querySelector('.tool-content'); const metadata = rejected?.querySelector('.tool-metadata'); assert.ok(rejected); assert.ok(metadata);
  // An externally enlarged retained root no longer fits the helper budget.
  const overflow = new FakeNode('#text'); overflow.textContent = 'x'.repeat(20000); rejected.append(overflow);
  const result: PartView = {type: 'text', text: 'Saved result', structured: {value: {body: 'Current result'}, truncated: false}};
  view.set([source], new Map([['rejected-write', {callId: 'rejected-write', name: 'write', phase: 'end' as const, parts: [result]}]])); flush();
  const tool = Reflect.get(view, 'tools').get('rejected-write'); assert.equal(rejected.isConnected, false); assert.equal(tool.presentation, undefined); assert.equal(tool.argumentsDocument, undefined); assert.equal(card.querySelector('.tool-arguments')?.querySelector('.tool-content'), null);
  const bounded = () => {const roots = card.querySelectorAll('.tool-content'); const count = (node: FakeNode): number => 1 + node.childNodes.reduce((total, child) => total + count(child), 0); assert.ok(roots.reduce((total, root) => total + root.textContent.length, 0) <= 16384); assert.ok(roots.reduce((total, root) => total + count(root), 0) <= 512);}; bounded();
  const before = card.textContent; const budget = tool.previewBudget; const remaining = budget.text; metadata.open = true; metadata.dispatch('toggle'); flush(); bounded();
  assert.equal(card.textContent, before); assert.equal(tool.previewBudget, budget); assert.equal(budget.text, remaining); assert.equal(rejected.isConnected, false);
  const raw = card.querySelector('.tool-arguments'); assert.ok(raw); raw.open = true; raw.dispatch('toggle'); flush(); assert.equal(JSON.parse(raw.querySelector('pre')?.textContent ?? '{}').content, 'Supplied source'); view.reset();
});
test('plain saved output reports the local cut and keeps available raw and copy actions', () => {
  setup(); const view = transcript(); const source = contentEntry('plain-cut', {}, 'retained raw '.repeat(6000));
  view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const note = card.querySelector('.preview-omission'); assert.ok(note); assert.equal(note.textContent, 'Preview shortened. Show saved output');
  assert.doesNotMatch(note.textContent, /Some output was not retained/); const pre = card.querySelector('.tool-output-text'); assert.ok(pre); assert.ok(pre.textContent.length <= 65536);
  const before = note; view.set([source]); flush(); assert.equal(card.querySelector('.preview-omission'), before);
  view.set([contentEntry('plain-cut', {}, 'new short saved text')]); flush(); assert.equal(card.querySelector('.preview-omission'), null);
  assert.equal(card.querySelector('.tool-output-text')?.textContent, 'new short saved text');
});
test('saved-output actions target retained inspection refs and reject replaced tool sources', () => {
  setup(); const view = transcript();
  const source = (id: string, text: string) => contentEntry(id, {}, text, false, {value: {body: 'long preview '.repeat(3000)}, truncated: false});
  view.set([source('saved-a', 'first saved raw'), source('saved-b', 'second saved raw')]); flush();
  const cards = node('primary-transcript').querySelectorAll('.tool-card'); assert.equal(cards.length, 2);
  for (const card of cards) { card.open = true; card.dispatch('toggle'); } flush();
  const controls = cards.map(card => card.querySelector('.preview-omission')?.querySelectorAll('button') ?? []);
  assert.deepEqual(controls.map(items => items.map(item => item.textContent)), [['Show saved output'], ['Show saved output']]);
  const tools = Reflect.get(view, 'tools'); const firstRaw = tools.get('saved-a').inspections.output; const secondRaw = tools.get('saved-b').inspections.output;
  firstRaw.querySelector('summary').textContent = 'Changed owned caption';
  controls[0]?.[0]?.dispatch('click'); assert.equal(firstRaw.open, true); assert.equal(secondRaw.open, false); assert.equal(fakeDocument.activeElement, firstRaw.querySelector('summary'));
  firstRaw.dispatch('toggle'); assert.equal(firstRaw.querySelector('pre')?.textContent, 'first saved raw');
  assert.equal(firstRaw.querySelector('.copy'), null); assert.equal(cards[0]?.querySelector('.preview-omission')?.querySelectorAll('button').length, 1);
  firstRaw.open = false; const oldShow = controls[0]?.[0];
  view.set([source('saved-a', 'replacement raw'), source('saved-b', 'second saved raw')]); flush();
  oldShow?.dispatch('click'); assert.equal(firstRaw.open, false);
  const fresh = cards[0]?.querySelector('.preview-omission')?.querySelectorAll('button')[0]; assert.ok(fresh); fresh.dispatch('click');
  assert.equal(firstRaw.open, true); firstRaw.dispatch('toggle'); assert.equal(firstRaw.querySelector('pre')?.textContent, 'replacement raw');
  firstRaw.open = false; view.set([]); flush(); fresh.dispatch('click'); assert.equal(firstRaw.open, false);
});
test('source omission remains separate from display shortening and no output action promises unavailable source text', () => {
  setup(); const view = transcript();
  const host = contentEntry('host-cut', {}, 'saved subset', false, {value: {body: 'retained short body'}, truncated: true});
  const local = contentEntry('local-cut', {}, 'saved complete text', false, {value: {body: 'long preview '.repeat(3000)}, truncated: false});
  const empty = contentEntry('empty-raw', {}, '', false, {value: {body: 'long preview '.repeat(3000)}, truncated: true});
  view.set([host, local, empty]); flush(); const cards = node('primary-transcript').querySelectorAll('.tool-card');
  for (const card of cards) { card.open = true; card.dispatch('toggle'); } flush();
  assert.match(cards[0]?.querySelector('.preview-omission')?.textContent ?? '', /^Some output was not retained./);
  assert.doesNotMatch(cards[0]?.querySelector('.preview-omission')?.textContent ?? '', /Preview shortened/);
  assert.match(cards[1]?.querySelector('.preview-omission')?.textContent ?? '', /^Preview shortened./);
  assert.doesNotMatch(cards[1]?.querySelector('.preview-omission')?.textContent ?? '', /Some output was not retained/);
  const notice = cards[2]?.querySelector('.preview-omission'); assert.ok(notice);
  assert.match(notice.textContent, /Preview shortened. Some output was not retained./); assert.equal(notice.querySelectorAll('button').length, 0);
  assert.doesNotMatch(node('primary-transcript').textContent, /Open Raw output|Copy for more|full output recover/i);
});
test('tool refresh leaves open generic Details text intact and refreshes only owned inspections', () => {
  setup(); const view = transcript(); const args = {program: 'retained source', usage: {note: 'supplied metadata '.repeat(400)}};
  const source = (text: string) => contentEntry('inspection-owner', args, text);
  view.set([source('initial raw result')]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush();
  const argumentRoot = card.querySelector('.tool-content'); const metadata = argumentRoot?.querySelector('.tool-metadata'); assert.ok(metadata);
  assert.equal(metadata.firstElementChild?.textContent, 'Details'); metadata.open = true; metadata.dispatch('toggle');
  const supplied = metadata.querySelector('pre'); assert.ok(supplied); const retainedText = supplied.textContent; assert.match(retainedText, /supplied metadata/);
  const owned = card.querySelectorAll('.tool-inspection'); assert.equal(owned.length, 3);
  const raw = owned.find(node => node.firstElementChild?.textContent === 'Raw output'); assert.ok(raw);
  raw.open = true; raw.dispatch('toggle'); assert.equal(raw.querySelector('pre')?.textContent, 'initial raw result');
  const limits = owned.find(node => node.firstElementChild?.textContent === 'Display limits'); assert.ok(limits);
  limits.open = true; limits.dispatch('toggle'); assert.match(limits.querySelector('pre')?.textContent ?? '', /Raw inspection/);
  assert.ok(raw.firstElementChild); raw.firstElementChild.textContent = 'Retained raw inspection';
  view.set([source('updated raw result')]); flush();
  assert.equal(card.querySelector('.tool-metadata'), metadata); assert.equal(metadata.open, true); assert.equal(metadata.querySelector('pre'), supplied);
  assert.equal(supplied.textContent, retainedText); assert.equal(raw.querySelector('pre')?.textContent, 'updated raw result');
  assert.match(limits.querySelector('pre')?.textContent ?? '', /Raw inspection/);
});
test('changed result budgets adopt retained argument DOM and charge deferred metadata to the new budget', () => {
  setup(); const view = transcript(); const args = {program: `source\n${'line '.repeat(300)}`, usage: {note: 'metadata '.repeat(900)}};
  const source = (text: string) => contentEntry('adopt', args, JSON.stringify({body: text}), false, {value: {body: text}, truncated: false});
  view.set([source(`# First\n${'result '.repeat(700)}`)]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush(); const argumentsRoot = card.querySelector('.tool-arguments')?.querySelector('.tool-content'); assert.ok(argumentsRoot);
  const disclosure = argumentsRoot.querySelector('.tool-source'); const metadata = argumentsRoot.querySelector('.tool-metadata'); assert.ok(disclosure); assert.ok(metadata);
  assert.equal(metadata.childNodes.length, 1); assert.doesNotMatch(argumentsRoot.textContent, /metadata metadata/);
  disclosure.open = false; const oldBudget = Reflect.get(view, 'tools').get('adopt').previewBudget;
  view.set([source(`# Second\n${'fresh '.repeat(1300)}`)]); flush();
  const budget = Reflect.get(view, 'tools').get('adopt').previewBudget; assert.notEqual(budget, oldBudget);
  assert.equal(card.querySelector('.tool-arguments')?.querySelector('.tool-content'), argumentsRoot); assert.equal(disclosure.open, false);
  const oldText = oldBudget.text; const newText = budget.text; metadata.open = true; metadata.dispatch('toggle');
  assert.ok(budget.text < newText); assert.equal(oldBudget.text, oldText);
  const shown = card.querySelectorAll('.tool-content').reduce((total, preview) => total + preview.textContent.length, 0); assert.ok(shown <= 16384);
  assert.equal(card.querySelector('.preview-omission')?.textContent, 'Preview shortened. Show saved output');
  assert.equal(card.querySelectorAll('.preview-omission').length, 1);
});
test('session selected raw content stays connected through updates and refreshes after selection clears', () => {
  setup(); const view = transcript(); view.set([sessionEntry('selected', 'original text')]); flush();
  const group = node('primary-transcript').querySelector('.session-events'); assert.ok(group); group.open = true; group.dispatch('toggle'); flush();
  const row = group.querySelector('.custom-entry'); assert.ok(row); const inspection = row.querySelector('details'); assert.ok(inspection); inspection.open = true; inspection.dispatch('toggle');
  const pre = inspection.querySelector('pre'); assert.ok(pre); selection = {isCollapsed: false, anchorNode: pre, focusNode: pre};
  view.set([sessionEntry('selected', 'updated text')]); flush(); assert.equal(pre.isConnected, true); assert.match(pre.textContent, /original text/);
  selection = null; fakeDocument.dispatch('selectionchange'); flush(); assert.match(group.textContent, /updated text/);
});
test('projected nested documents stack without tables and preserve the protected raw result', async () => {
  setup(); const raw = JSON.stringify({results: [{result: JSON.stringify({body: '# Title\nParagraph'})}]});
  const source = contentEntry('nested', {}, raw, false, {value: {results: [{result: {body: '# Title\nParagraph'}}]}, truncated: false}); const view = transcript(); view.set([source]); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  assert.equal(card.querySelector('.tool-rows'), null); card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('.tool-rows'), null); assert.equal(card.querySelector('.tool-record'), null);
  const metadata = card.querySelector('.tool-metadata'); assert.ok(metadata); metadata.open = true; metadata.dispatch('toggle'); flush();
  assert.match(metadata.textContent, /results\.1\.result\.body/); assert.equal(card.querySelector('h1')?.textContent, 'Title');
  const doc = card.querySelector('.tool-document'); assert.ok(doc); assert.match(doc.textContent, /Paragraph/); assert.doesNotMatch(doc.textContent, /\[object\]/);
  view.set([source]); flush(); assert.equal(card.querySelector('.tool-document'), doc);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let copied = '';
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => { copied = text; }}}});
  try { const action = card.parentNode?.querySelector('.tool-copy'); assert.ok(action); action.dispatch('click', {stopPropagation: () => {}}); await Promise.resolve(); assert.equal(copied, raw); }
  finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
  const multiple = {results: [{result: {body: '# Title\nParagraph'}}, {result: {body: '# Second\nAnother paragraph'}}]};
  view.set([contentEntry('nested-many', {}, JSON.stringify(multiple), false, {value: multiple, truncated: false})]); flush();
  const stacked = node('primary-transcript').querySelector('.tool-card'); assert.ok(stacked); stacked.open = true; stacked.dispatch('toggle'); flush();
  assert.equal(stacked.querySelector('.tool-rows'), null); assert.ok(stacked.querySelector('.tool-record'));
  assert.deepEqual(stacked.querySelectorAll('h1').map(heading => heading.textContent), ['Title', 'Second']);
});

test('mixed thinking and tool turns compact both part orders without loss of action controls', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); const copied: string[] = [];
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => {copied.push(text);}}}});
  try {
  for (const firstThinking of [true, false]) {
    setup(); const view = transcript(); const source = contentEntry('utility', {program: 'source'}, 'retained output');
    const msg: import('../shared/api.ts').MessageView | undefined = source.messages[0]; assert.ok(msg); msg.timestamp = Date.now();
    const thought: PartView = {type: 'thinking', text: 'Retained thought'};
    if (firstThinking) msg.parts.unshift(thought); else msg.parts.push(thought);
    view.set([source, sessionEntry('event', 'routine')]); flush();
    const root = node('primary-transcript'); const turn = root.querySelector('.tool-only'); assert.ok(turn);
    assert.equal(turn.querySelector('.message-body')?.children.length, 2);
    assert.ok(turn.querySelector('.thinking')); assert.ok(turn.querySelector('.tool-card'));
    assert.equal(turn.querySelector('.message-actions')?.hidden, false);
    assert.ok(turn.closest('.compact-entry'));
    const copy = messageAction(turn, 'Copy'); assert.equal(copy.enabled, true); copy.run(); await Promise.resolve();
    assert.equal(copied.at(-1), firstThinking ? 'Retained thought\n\nretained output' : '\nretained output\nRetained thought'); assert.equal(turn.querySelector('.message-menu')?.attributes['aria-label'], 'Message actions');
    assert.equal(turn.querySelector('.timestamp'), null); messageAction(turn, 'Source').run(); node('primary-editor').focus(); flush();
    assert.match(turn.querySelector('.message-source')?.textContent ?? '', /Retained thought/); assert.match(turn.querySelector('.message-source')?.textContent ?? '', /retained output/);
    assert.match(turn.querySelector('.message-source')?.textContent ?? '', new RegExp(new Date(msg.timestamp).toISOString().replaceAll('.', '\\.'))); assert.ok(turn.querySelector('.tool-copy'));
    assert.equal(root.querySelector('.session-events')?.querySelector('summary')?.textContent, '1 session event');
    view.set([{...source, messages: [{...msg, parts: [...msg.parts, {type: 'text', text: 'Visible prose'}]}]}]); flush();
    assert.equal(root.querySelector('.tool-only'), null); assert.match(root.textContent, /Visible prose/);
  }
  } finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
test('expanded source disclosures avoid the raw inspection scroll cap', () => {
  setup(); const view = transcript(); view.set([contentEntry('source-cap', {program: 'long source\n'.repeat(200)}, 'output')]); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const source = card.querySelector('.tool-source'); assert.ok(source);
  assert.equal(source.classList.contains('tool-inspection'), false);
  const inspections = card.querySelectorAll('.tool-inspection'); assert.equal(inspections.length, 3);
  assert.deepEqual(inspections.map(detail => detail.querySelector('summary')?.textContent), ['Arguments', 'Raw output', 'Display limits']);
  const limits = inspections[2]; assert.ok(limits); assert.equal(limits.querySelector('pre'), null);
  limits.open = true; limits.dispatch('toggle');
  assert.match(limits.querySelector('pre')?.textContent ?? '', /8192 characters/);
  assert.match(limits.querySelector('pre')?.textContent ?? '', /65536 characters/);
  assert.equal(card.querySelector('.tool-name')?.textContent, 'custom'); assert.equal(card.querySelector('.tool-status')?.textContent, 'Done');
});
test('authored subject captions preserve exact arguments, output and guarded navigation', async () => {
  setup(); const root = '00000000-0000-4000-8000-000000000001', child = `${root}:7906`, calls: string[] = [], copies: string[] = [];
  let label = 'Review · 2', resolved = true;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable:true,value:{clipboard:{writeText:async(text:string)=>{copies.push(text);}}}});
  const view = new Transcript('primary', {presentation:()=>{},reading:()=>{},subject:value=>value === child ? {text:label,title:value,...(resolved ? {open:()=>calls.push(value)} : {})} : undefined});
  try {
    const output = `Exact supplied identity ${child}`, source = contentEntry('caption-source', {sessionId:child}, output);
    view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'), shell = card?.parentNode; assert.ok(card && shell);
    const target = card.querySelector('.tool-target'), link = target?.querySelector('.tool-subject-link'); assert.ok(target && link);
    assert.equal(link.textContent,label); assert.equal(target.title,child); assert.equal(card.open,false);
    const click = () => link.dispatch('click',{preventDefault:()=>{},stopPropagation:()=>{}});
    click(); assert.deepEqual(calls,[child]); assert.equal(card.open,false);
    card.open=true; card.dispatch('toggle'); flush();
    const args = card.querySelector('.tool-arguments'); assert.ok(args); args.open=true; args.dispatch('toggle'); flush(); assert.match(args.textContent,new RegExp(child));
    shell.querySelector('.tool-copy')?.dispatch('click',{stopPropagation:()=>{}}); await Promise.resolve(); assert.deepEqual(copies,[output]);
    view.defer(()=>view.set([source])); click(); assert.deepEqual(calls,[child]); flush();
    label='Renamed review'; view.set([source]); flush(); assert.equal(target.querySelector('.tool-subject-link'),link); assert.equal(link.textContent,label);
    resolved=false; view.set([source]); flush(); assert.equal(target.querySelector('.tool-subject-link'),null); assert.equal(target.textContent,label);
    assert.equal(JSON.stringify(source).includes(child),true); assert.equal(source.messages[0]?.parts[0]?.type,'toolCall');
  } finally {view.destroy(); if(previous)Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');}
});

test('tool subjects mark known character and line cuts without changing complete unknown endings', () => {
  const targetFor = (name: string, key: string, value: string): FakeNode => {
    setup(); const view = transcript(); const source = contentEntry('subject-cut', {[key]: value}, 'output');
    const msg = source.messages[0]; assert.ok(msg); for (const part of msg.parts) part.name = name;
    view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
    card.open = true; card.dispatch('toggle'); flush(); const target = card.querySelector('.tool-target'); assert.ok(target); return target;
  };
  for (const [name, key] of [['bash', 'command'], ['read', 'path'], ['custom', 'code']] as const) {
    const prefix = name === 'bash' ? '$ ' : '';
    const characterCut = targetFor(name, key, 'x'.repeat(4200));
    assert.equal(characterCut.textContent, `${prefix}${'x'.repeat(4095)}…`); assert.equal(characterCut.title, `${prefix}${'x'.repeat(4200)}`);
    const lineCut = targetFor(name, key, 'first line\nsecond line'); assert.equal(lineCut.textContent, `${prefix}first line…`);
    assert.equal(lineCut.title, prefix.concat('first line', String.fromCharCode(10), 'second line'));
    const boundedTitle = targetFor(name, key, 'x'.repeat(65536)); assert.equal(boundedTitle.title.length, 65536); assert.equal(boundedTitle.title.endsWith('…'), name === 'bash');
    const complete = targetFor(name, key, 'Complete unknown TypeScr'); assert.equal(complete.textContent, `${prefix}Complete unknown TypeScr`);
  }
});
test('multiline tool targets keep a compact row and complete retained title and Arguments', () => {
  setup(); const view = transcript(); const command = ['printf first', 'printf second', 'printf third'].join(String.fromCharCode(10));
  const source = contentEntry('multiline-command', {command}, 'output'); const message = source.messages[0]; assert.ok(message); for (const part of message.parts) part.name = 'bash';
  view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); const target = card?.querySelector('.tool-target'); assert.ok(card); assert.ok(target);
  assert.equal(target.textContent, '$ printf first…'); assert.equal(target.title, `$ ${command}`);
  card.open = true; card.dispatch('toggle'); flush(); const args = card.querySelector('.tool-arguments'); assert.ok(args); args.open = true; args.dispatch('toggle'); flush();
  assert.match(args.textContent, /printf second/); assert.match(args.textContent, /printf third/);
  const text = 'x'.repeat(70000); const large = contentEntry('multiline-command', {command: text}, 'output'); const largeMessage = large.messages[0]; assert.ok(largeMessage); for (const part of largeMessage.parts) part.name = 'bash';
  view.set([large]); flush(); assert.ok(target.title.length <= 65536); assert.ok(target.title.endsWith('…')); view.reset();
});
test('message coverage notices mark known line cuts and preserve complete reasons', () => {
  setup(); const view = transcript(); const source = entry('coverage-cut', 'Retained prose');
  const reason = Array.from({length: 7}, (_, index) => `Reason row ${index + 1}`).join('\n');
  const msg = source.messages[0]; assert.ok(msg); msg.coverage = {...coverage}; Object.assign(msg.coverage, {complete: false, reason});
  view.set([source]); flush(); const root = node('primary-transcript');
  const notice = root.querySelectorAll('.message-body').flatMap(body => body.querySelectorAll('p')).find(value => value.textContent.startsWith('Reason row')); assert.ok(notice);
  assert.equal(notice.textContent, `${reason.split('\n').slice(0, 6).join('\n')}…`); assert.match(root.textContent, /Retained prose/);
  view.set([{...source, messages: [{...msg, coverage: {...msg.coverage, reason: 'Complete reason TypeScr'}}]}]); flush();
  assert.ok(root.querySelectorAll('.message-body').flatMap(body => body.querySelectorAll('p')).some(value => value.textContent === 'Complete reason TypeScr'));
});

test('source wrap reconciles entry heights under focused controls and keeps the reading anchor and text nodes', () => {
  setup(); const view = transcript();
  const entries = Array.from({length: 30}, (_, i) => entry(`e${i}`, i === 2 ? '```ts\n  const n = 1;\n\n\treturn n;\n```' : `paragraph ${i}`));
  view.set(entries); flush(); const root = node('primary-transcript'); root.scrollTop = 2 * 140 + 17; root.dispatch('scroll'); flush();
  const code = root.querySelector('.code-block'); assert.ok(code);
  const pre = code.querySelector('pre'); const wrap = code.querySelector('.source-wrap'); assert.ok(pre); assert.ok(wrap);
  const text = pre.textContent; const retained = pre.children[0];
  const anchor = pre.closest('.entry'); assert.ok(anchor); const top = anchor.offsetTop - root.scrollTop;
  wrap.focus(); anchor.measured = 350; wrap.dispatch('click'); flush();
  assert.equal(pre.dataset.wrap, 'false'); assert.equal(pre.textContent, text); assert.equal(pre.children[0], retained);
  assert.equal(anchor.offsetTop - root.scrollTop, top); assert.equal(fakeDocument.activeElement, wrap);
  wrap.dispatch('click'); flush(); assert.equal(pre.dataset.wrap, 'true'); assert.equal(pre.textContent, text);
  view.reset();
});

test('visible working tools share one clock and stop on pane hide, document hide, unmount, end and reset', context => {
  context.mock.timers.enable({apis: ['setInterval', 'Date'], now: 1000});
  const intervals = context.mock.method(globalThis, 'setInterval');
  setup(); Reflect.set(fakeDocument, 'hidden', false);
  const pane = new FakeNode('section'); pane.className = 'conversation'; roots.push(pane); pane.append(node('primary-transcript'));
  const view = transcript(); const source = contentEntry('timed', {command: 'probe'}, '');
  const state = {callId: 'timed', name: 'bash', phase: 'start' as const, observedStart: 1000};
  const call = source.messages[0]?.parts.find(part => part.type === 'toolCall'); assert.ok(call);
  state.callId = call.callId;
  const tools = new Map([[state.callId, state]]);
  const paint = () => { view.set([source], tools); flush(); };
  try {
    paint(); const meta = node('primary-transcript').querySelector('.tool-secondary'); assert.ok(meta);
    assert.match(meta.textContent, /^0s elapsed/); assert.equal(intervals.mock.callCount(), 1);
    context.mock.timers.tick(1000); assert.match(meta.textContent, /^1s elapsed/);
    paint(); paint(); assert.equal(intervals.mock.callCount(), 1);
    pane.hidden = true; paint(); const hiddenWrites = meta.writes; context.mock.timers.tick(2000); assert.equal(meta.writes, hiddenWrites);
    pane.hidden = false; paint(); assert.equal(intervals.mock.callCount(), 2);
    Reflect.set(fakeDocument, 'hidden', true); fakeDocument.dispatch('visibilitychange');
    const documentWrites = meta.writes; context.mock.timers.tick(2000); assert.equal(meta.writes, documentWrites);
    Reflect.set(fakeDocument, 'hidden', false); fakeDocument.dispatch('visibilitychange'); assert.equal(intervals.mock.callCount(), 3);
    const card = node('primary-transcript').querySelector('.tool-shell'); assert.ok(card); card.remove();
    const detachedWrites = meta.writes; context.mock.timers.tick(2000); assert.equal(meta.writes, detachedWrites);
    paint(); assert.equal(intervals.mock.callCount(), 4);
    view.set([source], new Map([[state.callId, {...state, phase: 'end', durationMs: 37}]])); flush();
    assert.match(meta.textContent, /^37 ms/); const finalWrites = meta.writes;
    context.mock.timers.tick(2000); assert.equal(meta.writes, finalWrites);
    paint(); assert.equal(intervals.mock.callCount(), 5); view.reset(); context.mock.timers.tick(2000); assert.equal(meta.writes, finalWrites + 1);
  } finally { view.reset(); Reflect.set(fakeDocument, 'hidden', false); }
});

test('expanded tool captions share the wrap row and native source disclosures keep a separate control', () => {
  setup(); const view = transcript(); const source = contentEntry('compact', {command: 'printf fixture'}, 'first\nsecond');
  const msg = source.messages[0]; assert.ok(msg); for (const part of msg.parts) part.name = 'bash';
  view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush();
  const disclosure = card.querySelector('.tool-source'); assert.ok(disclosure);
  const summary = disclosure.querySelector('summary'); const control = disclosure.querySelector('.source-wrap');
  const pre = disclosure.querySelector('pre'); assert.ok(summary); assert.ok(control); assert.ok(pre);
  assert.equal(disclosure.children[0], summary); assert.equal(summary.textContent, 'command');
  assert.equal(summary.contains(control), false); assert.equal(control.previousElementSibling, summary);
  assert.equal(disclosure.querySelectorAll('.source-header').length, 1);
  const retained = pre.children[0]; const text = pre.textContent; control.dispatch('click'); flush();
  assert.equal(disclosure.open, true); assert.equal(pre.dataset.wrap, 'false'); assert.equal(pre.textContent, text); assert.equal(pre.children[0], retained);
  control.dispatch('click'); flush(); assert.equal(pre.dataset.wrap, 'true');
  const output = card.querySelector('.tool-output-text'); assert.ok(output);
  const header = output.previousElementSibling; assert.ok(header); assert.equal(header.textContent, 'ResultWrap');
  assert.equal(header.classList.contains('source-header'), true); assert.equal(header.children.length, 2);
  const outputControl = header.querySelector('.source-wrap'); assert.ok(outputControl);
  assert.equal(outputControl.attributes['aria-label'], 'Wrap source lines');
  assert.equal(outputControl.attributes['aria-pressed'], 'true'); assert.equal(outputControl.title, 'Do not wrap source lines');
  const outputText = output.textContent; outputControl.dispatch('click'); flush(); assert.equal(output.textContent, outputText);
  assert.equal(output.dataset.wrap, 'false'); assert.equal(output.contains(header), false);
  assert.equal(outputControl.attributes['aria-label'], 'Wrap source lines'); assert.equal(outputControl.attributes['aria-pressed'], 'false'); assert.equal(outputControl.title, 'Wrap source lines');
  view.set([source]); flush(); assert.equal(disclosure.querySelectorAll('.source-wrap').length, 1); view.reset();
});

test('grouped local Thinking collapse clears the global default and preserves other open choices through updates', () => {
  setup(); let saved = {revision: 0, expanded: [] as string[], showThinking: true};
  const view = new Transcript('primary', {presentation: (expanded, showThinking) => { saved = {...saved, expanded, showThinking}; }, reading: () => {}});
  const grouped = (text: string) => ({id: 'grouped', kind: 'message', messages: [{...message('grouped', ''), parts: [
    {type: 'thinking' as const, text}, {type: 'thinking' as const, text: 'second thought'}, {type: 'text' as const, text: 'Reply'},
  ]}]});
  const other = {id: 'other', kind: 'message', messages: [{...message('other', ''), parts: [{type: 'thinking' as const, text: 'Other choice'}]}]};
  view.configure(saved); view.set([grouped('first thought'), other]); flush();
  const root = node('primary-transcript'); const group = root.querySelector('.thinking-group'); assert.ok(group); assert.equal(group.open, true);
  const children = group.querySelectorAll('.thinking'); assert.equal(children.length, 2);
  group.open = false; group.dispatch('toggle'); flush();
  assert.equal(saved.showThinking, false); assert.equal(group.open, false); assert.ok(children.every(child => !child.open));
  assert.ok(saved.expanded.includes('thinking:other:other:0'));
  view.set([grouped('updated thought'), other]); flush(); view.set([grouped('updated again'), other]); flush();
  assert.equal(root.querySelector('.thinking-group'), group); assert.equal(group.open, false); assert.ok(children.every(child => !child.open));
  const otherRow = root.children.find(row => row.dataset.entryId === 'other'); assert.equal(otherRow?.querySelector('.thinking')?.open, true);
});

test('owned argument and raw inspections retain nodes, focus, source Copy, Wrap and target-local choices', async () => {
  setup(); let saved = {revision: 0, expanded: [] as string[], showThinking: false};
  const view = new Transcript('primary', {presentation: (expanded, showThinking) => { saved = {...saved, expanded, showThinking}; }, reading: () => {}});
  const args = {path: '/retained/source', value: 'Supplied argument'};
  const source = (text: string) => contentEntry('owned', args, text);
  view.set([source('first raw')]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush();
  const argumentsNode = card.querySelector('.tool-arguments'); const raw = card.querySelector('.tool-raw-output'); assert.ok(argumentsNode); assert.ok(raw);
  for (const detail of [argumentsNode, raw]) { detail.open = true; detail.dispatch('toggle'); } flush();
  const pre = raw.querySelector('pre'); const frame = pre?.children[0]; const rawCopy = card.parentNode?.querySelector('.tool-copy'); assert.ok(pre); assert.ok(rawCopy); assert.equal(raw.querySelector('.copy'), null);
  assert.equal(raw.querySelectorAll('.source-wrap').length, 1); const wrap = raw.querySelector('.source-wrap'); assert.ok(wrap);
  wrap.dispatch('click'); assert.equal(pre.dataset.wrap, 'false'); assert.equal(pre.children[0], frame);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); const writes: string[] = [];
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => { writes.push(text); }}}});
  try {
    rawCopy.focus(); selection = {isCollapsed: false, anchorNode: pre, focusNode: pre};
    view.set([source('second raw')]); flush();
    assert.equal(card.querySelector('.tool-arguments'), argumentsNode); assert.equal(card.querySelector('.tool-raw-output'), raw);
    assert.equal(fakeDocument.activeElement, rawCopy); assert.equal(selection.anchorNode, pre); assert.equal(pre.textContent, 'first raw');
    rawCopy.dispatch('click', {stopPropagation() {}}); await Promise.resolve(); assert.deepEqual(writes, []);
    selection = null; fakeDocument.activeElement = null; view.schedule(); flush();
    assert.equal(pre.textContent, 'second raw'); assert.equal(pre.children[0], frame); assert.equal(pre.dataset.wrap, 'false');
    rawCopy.dispatch('click', {stopPropagation() {}}); await Promise.resolve(); assert.deepEqual(writes, ['second raw']);
    const argumentCopy = argumentsNode.querySelector('.copy'); assert.ok(argumentCopy); argumentCopy.dispatch('click'); await Promise.resolve();
    assert.deepEqual(JSON.parse(writes[1] ?? ''), args);
    view.expandLoaded(true, false); flush(); assert.equal(card.open, false); assert.equal(argumentsNode.open, true); assert.equal(raw.open, true);
    view.expandLoaded(true, true); flush(); assert.equal(card.open, true); assert.equal(argumentsNode.open, true); assert.equal(raw.open, true);
    const retained = {...saved, expanded: [...saved.expanded]}; view.reset(); rawCopy.dispatch('click', {stopPropagation() {}}); await Promise.resolve(); assert.equal(writes.length, 2);
    view.configure(retained); view.set([source('restored raw')]); flush();
    const restored = node('primary-transcript').querySelector('.tool-card'); assert.ok(restored); restored.dispatch('toggle'); flush();
    assert.equal(restored.querySelector('.tool-arguments')?.open, true); assert.equal(restored.querySelector('.tool-raw-output')?.open, true);
    assert.equal(restored.querySelector('.tool-raw-output')?.querySelector('pre')?.textContent, 'restored raw');
    const argumentRoot = restored.querySelector('.tool-arguments')?.querySelector('.tool-content'); assert.ok(argumentRoot);
    selection = {isCollapsed: false, anchorNode: argumentRoot, focusNode: argumentRoot};
    view.set([contentEntry('owned', {...args, value: 'Updated supplied argument'}, 'restored raw')]); flush();
    assert.equal(argumentRoot.isConnected, true); assert.doesNotMatch(argumentRoot.textContent, /Updated supplied argument/);
    selection = null; view.schedule(); flush(); assert.equal(argumentRoot.isConnected, false);
    assert.match(restored.querySelector('.tool-arguments')?.textContent ?? '', /Updated supplied argument/);
  } finally {
    selection = null; fakeDocument.activeElement = null;
    if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

function communicationEntry(state: 'ready' | 'unresolved' | 'unavailable' = 'ready', body = 'Actual contribution', name = 'Peer'): import('../shared/api.ts').EntryView {
  const communication: import('../shared/api.ts').CommunicationPresentation = state === 'ready' ? {state, origin: {kind: 'ordinary-custom', customType: 'agent.peer', renderEntryId: 'peer-message', sourceEntryId: 'peer'}, value: {format: 'agent.communication/1', sender: {identity: '10000000-0000-4000-8000-000000000001', name}, body: {text: body, complete: false, redacted: false}, recordedAt: 1700000000000, kind: 'report', metadata: {sourceId: 'source', requestId: 'request'}}, rawDetails: {value: {literal: '[omitted]'}, truncated: false}} : state === 'unresolved' ? {state} : {state, reason: 'invalid'};
  return {id: 'peer', kind: 'message', messages: [{id: 'peer-message', role: 'custom', state: 'final', parts: [{type: 'text', text: 'Original transport paragraph'}], coverage, communication}]};
}
test('scoped transcripts isolate matching entry IDs and retain the same root across pane moves', () => {
  setup(); const paneOne = new FakeNode('section'), paneTwo = new FakeNode('section'); paneOne.className = 'pane-leaf'; paneTwo.className = 'pane-leaf'; roots.push(paneOne, paneTwo);
  const first = new FakeNode('div'), second = new FakeNode('div'), firstLatest = new FakeNode('button'), secondLatest = new FakeNode('button'); paneOne.append(first, firstLatest); paneTwo.append(second, secondLatest);
  const left = new RetainedTranscript({transcript: first as unknown as HTMLElement, latest: firstLatest as unknown as HTMLElement}, {presentation: () => {}, reading: () => {}});
  const right = new RetainedTranscript({transcript: second as unknown as HTMLElement, latest: secondLatest as unknown as HTMLElement}, {presentation: () => {}, reading: () => {}});
  left.set([entry('same', 'First agent context')]); right.set([entry('same', 'Second agent context')]); flush();
  assert.match(first.textContent, /First agent context/); assert.doesNotMatch(first.textContent, /Second agent context/); assert.match(second.textContent, /Second agent context/);
  const retained = first.children[0]; const menu = retained?.querySelector('.message-menu'); assert.ok(retained); assert.ok(menu);
  paneTwo.append(first, firstLatest); left.schedule(); flush(); assert.equal(first.children[0], retained); assert.equal(first.querySelector('.message-menu'), menu); assert.equal(left.node, first);
  paneTwo.hidden = true; left.set([entry('same', 'New first context')]); right.set([entry('same', 'New second context')]); flush(); assert.match(first.textContent, /First agent context/); assert.match(second.textContent, /Second agent context/);
  paneTwo.hidden = false; left.schedule(); right.schedule(); flush(); assert.match(first.textContent, /New first context/); assert.match(second.textContent, /New second context/); left.reset(); right.reset();
});
function messageAction(card: FakeNode, label: string): import('./context-menu.ts').ContextItem {
  const previous = contextMenu.open; let items: import('./context-menu.ts').ContextItem[] = [];
  contextMenu.open = (_origin, _point, _title, values) => { items = values; };
  try { const menu = card.querySelector('.message-menu'); assert.ok(menu); menu.click(); }
  finally { contextMenu.open = previous; }
  const item = items.find(value => value.label === label); assert.ok(item); return item;
}
test('communication keeps sender and text at rest and opens one hidden Source from shared actions', () => {
  setup(); const view = transcript(); const source = communicationEntry(); const message = source.messages?.[0]; assert.ok(message); message.error = 'Synthetic message error'; view.set([source]); flush();
  const card = node('primary-transcript').querySelector('.communication-card'); assert.ok(card);
  const region = card.querySelector('.message-source'); const menu = card.querySelector('.message-menu'); assert.ok(region); assert.ok(menu);
  assert.equal(card.querySelector('.communication-sender')?.textContent, 'Peer'); assert.equal(card.querySelector('.communication-text')?.textContent, 'Actual contribution');
  assert.equal(card.querySelector('.response-error-summary')?.textContent, 'The response failed.');
  assert.equal(card.querySelector('.message-error')?.querySelector('details')?.open, false);
  assert.equal(card.querySelector('.message-error')?.querySelector('pre')?.textContent, 'Synthetic message error');
  for (const selector of ['.communication-kind', '.communication-time', '.communication-trust', '.communication-copy', '.timestamp']) assert.equal(card.querySelector(selector), null);
  assert.equal(region.tagName, 'section'); assert.equal(region.attributes.role, 'region'); assert.equal(region.attributes['aria-label'], 'Source'); assert.equal(region.hidden, true); assert.equal(Reflect.get(region, 'inert'), true); assert.equal(region.querySelector('summary'), null); assert.equal(region.querySelector('pre'), null);
  assert.equal(menu.textContent, 'Message actions'); assert.equal(menu.attributes['aria-label'], 'Message actions');
  messageAction(card, 'Source').run?.(); assert.equal(region.hidden, false); assert.equal(Reflect.get(region, 'inert'), false); assert.match(region.textContent, /Original transport paragraph/);
  const close = region.querySelector('.message-source-close'); assert.ok(close); close.click(); assert.equal(region.hidden, true); assert.equal(Reflect.get(region, 'inert'), true); assert.equal(fakeDocument.activeElement, menu); view.reset();
});
test('ordinary unresolved user input keeps its public role without a source warning', () => {
  setup(); const view = transcript(); const source = communicationEntry('unresolved'); const input = source.messages?.[0]; assert.ok(input);
  input.role = 'user'; input.parts = [{type: 'text', text: '**A genuine prompt** with no peer association'}];
  view.set([source]); flush(); const card = node('primary-transcript').querySelector('.communication-card'); assert.ok(card);
  assert.equal(card.querySelector('.communication-sender')?.textContent, 'Input');
  assert.equal(card.querySelector('.communication-sender')?.hidden, false); assert.equal(card.querySelector('.communication-unverified')?.hidden, true);
  assert.equal(card.querySelector('.communication-text')?.classList.contains('communication-quoted'), false); assert.equal(card.classList.contains('user'), true);
  assert.equal(card.querySelector('.communication-text')?.querySelector('strong')?.textContent, 'A genuine prompt');
  assert.doesNotMatch(messageAction(card, 'Copy').description ?? '', /unverified/);
  messageAction(card, 'Source').run(); node('primary-editor').focus(); flush();
  assert.match(card.querySelector('.message-source')?.textContent ?? '', /Source association not established/);
  assert.doesNotMatch(card.querySelector('.message-source')?.textContent ?? '', /Sender identity/);
  view.set([{...source, messages: [{...input, communication: {state: 'unavailable', reason: 'invalid'}}]}]); flush();
  assert.equal(card.querySelector('.communication-unverified')?.hidden, false, 'invalid associations remain explicit'); view.reset();
});
test('communication headers use supplied identities rather than missing-name prose', () => {
  setup(); const view = transcript(); const source = communicationEntry('ready', 'Body', ''); view.set([source]); flush();
  const card = node('primary-transcript').querySelector('.communication-card'); assert.ok(card);
  const heading = card.querySelector('.communication-sender'); assert.ok(heading);
  assert.equal(heading.textContent, '10000000-0000-4000-8000-000000000001'); assert.equal(heading.title, heading.textContent);
  assert.doesNotMatch(heading.textContent, /unavailable/);
  view.set([communicationEntry()]); flush(); assert.equal(card.querySelector('.communication-sender'), heading); assert.equal(heading.textContent, 'Peer');
  assert.equal(heading.title, '10000000-0000-4000-8000-000000000001'); view.reset();
});
test('unverified marker opens Source without inventing a sender and Copy keeps literal retained bytes', async () => {
  setup(); const view = transcript(); const writes: string[] = []; const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (value: string) => { writes.push(value); }}}});
  try {
    view.set([communicationEntry('unavailable')]); flush(); const card = node('primary-transcript').querySelector('.communication-card'); assert.ok(card);
    assert.equal(card.querySelector('.communication-sender')?.hidden, true); assert.equal(card.querySelector('.communication-sender')?.textContent, '');
    const marker = card.querySelector('.communication-unverified'); assert.ok(marker); assert.equal(marker.hidden, false); assert.equal(marker.attributes['aria-label'], 'Source unverified'); assert.equal(marker.querySelectorAll('svg').length, 1);
    assert.equal(marker.parentNode, card.querySelector('.message-header'));
    const label = marker.querySelector('.card-action-label'); assert.ok(label); assert.equal(label.textContent, 'Source unverified'); assert.equal(label.classList.contains('sr-only'), false);
    const copy = messageAction(card, 'Copy'); assert.match(copy.description ?? '', /source unverified/); copy.run?.(); await Promise.resolve(); assert.deepEqual(writes, ['Original transport paragraph']);
    marker.click(); const region = card.querySelector('.message-source'); assert.ok(region); assert.equal(region.hidden, false); assert.match(region.textContent, /Original transport paragraph/);
    region.querySelector('.message-source-close')?.click(); assert.equal(fakeDocument.activeElement, marker);
    const retained = messageAction(card, 'Copy'); view.reset(); retained.run?.(); await Promise.resolve(); assert.equal(writes.length, 1);
  } finally { view.reset(); if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
test('ready message Copy and open original Copy keep distinct exact sources and refuse hidden owners', async () => {
  setup(); const view = transcript(); const writes: string[] = []; const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (value: string) => { writes.push(value); }}}});
  try {
    view.set([communicationEntry('ready', 'Exact body  ')]); flush(); const card = node('primary-transcript').querySelector('.communication-card'); assert.ok(card);
    messageAction(card, 'Copy').run?.(); await Promise.resolve(); assert.deepEqual(writes, ['Exact body  ']);
    messageAction(card, 'Source').run?.(); const region = card.querySelector('.message-source'); assert.ok(region); const original = region.querySelector('.copy'); assert.ok(original);
    original.click(); await Promise.resolve(); assert.deepEqual(writes, ['Exact body  ', 'Original transport paragraph']);
    region.querySelector('.message-source-close')?.click(); original.click(); await Promise.resolve(); assert.equal(writes.length, 2);
    const retained = messageAction(card, 'Copy'); node('primary-transcript').hidden = true; retained.run?.(); await Promise.resolve(); assert.equal(writes.length, 2);
  } finally { view.reset(); if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
test('communication presents the message with one lazy retained Source disclosure', () => {
  setup(); const view = transcript(); view.set([communicationEntry()]); flush();
  const article = node('primary-transcript').querySelector('.communication-card'); assert.ok(article);
  const header = article.querySelector('.communication-header'); const actions = article.querySelector('.message-actions'); const text = article.querySelector('.communication-text'); const source = article.querySelector('.message-source'); assert.ok(header); assert.ok(actions); assert.ok(text); assert.ok(source);
  assert.equal(article.querySelector('.communication-sender')?.textContent, 'Peer'); assert.equal(text.textContent, 'Actual contribution');
  assert.equal(article.querySelector('.communication-kind'), null); assert.equal(article.querySelector('.communication-trust'), null); assert.equal(header.querySelector('time'), null); assert.equal(actions.querySelector('.communication-copy'), null);
  assert.equal(actions.querySelector('.message-menu')?.attributes['aria-label'], 'Message actions');
  assert.equal(source.hidden, true); assert.equal(Reflect.get(source, 'inert'), true); assert.equal(article.querySelectorAll('.message-source').length, 1); assert.equal(source.querySelector('summary'), null); assert.equal(source.querySelector('pre'), null); assert.doesNotMatch(text.textContent, /Completeness|Communication|Original transport/);
  messageAction(article, 'Source').run?.(); flush(); assert.equal(source.hidden, false); assert.equal(Reflect.get(source, 'inert'), false); assert.match(source.textContent, /Message kindreport/); assert.match(source.textContent, /Ordinary custom message/); assert.match(source.textContent, /2023-11-14T22:13:20.000Z/); assert.match(source.textContent, /Completeness not reported/); assert.match(source.textContent, /Original transport paragraph/); assert.match(source.textContent, /Structured source details/);
  const frame = source.querySelector('.pre-text-frame'); const wrap = source.querySelector('.source-wrap'); assert.ok(frame); assert.ok(wrap); wrap.click();
  view.set([communicationEntry()]); flush(); assert.equal(node('primary-transcript').querySelector('.communication-card'), article); assert.equal(article.querySelector('.communication-header'), header); assert.equal(article.querySelector('.message-actions'), actions); assert.equal(article.querySelector('.message-source'), source); assert.equal(source.querySelector('.pre-text-frame'), frame); assert.equal(source.querySelector('pre')?.dataset.wrap, 'false'); assert.equal(source.hidden, false);
  view.expandLoaded(true, false); flush(); assert.equal(source.hidden, false); assert.equal(Reflect.get(source, 'inert'), false); view.reset();
});
test('native communication kinds and trust exceptions use only supplied facts', () => {
  setup(); const view = transcript(); const variants: import('../shared/api.ts').Communication[] = [
    {format: 'agent.communication/1', sender: {identity: '10000000-0000-4000-8000-000000000001'}, body: {text: 'Message', complete: true, redacted: false}, recordedAt: 0, kind: 'notice', metadata: {threadId: 'thread', passive: true}},
    {format: 'agent.communication/1', sender: {identity: '10000000-0000-4000-8000-000000000001'}, body: {text: 'Message', complete: false, redacted: false}, recordedAt: 0, kind: 'report', metadata: {sourceId: 'source', requestId: 'request'}},
    {format: 'agent.communication/1', sender: {identity: '10000000-0000-4000-8000-000000000001'}, body: {text: 'Message', complete: true, redacted: false}, recordedAt: 0, kind: 'result', metadata: {status: 'done', references: [{submissionId: 1, requestId: 'result-request', entryId: 'input-entry', answerEntryId: 'answer-entry'}], omittedReferences: 2}},
    {format: 'agent.communication/1', sender: {identity: '10000000-0000-4000-8000-000000000001'}, body: {text: 'Message', complete: true, redacted: false}, recordedAt: 0, kind: 'result', metadata: {status: 'unanswered', references: [], omittedReferences: 0, reason: 'No retained answer'}},
    {format: 'agent.communication/1', sender: {identity: '10000000-0000-4000-8000-000000000001'}, body: {text: 'Message', complete: true, redacted: false}, recordedAt: 0, kind: 'check-in', metadata: {sourceId: 'source', producerRequestId: 'request', elapsedMs: 0, origin: 'model'}}
  ];
  const kinds = ['notice', 'report', 'result', 'result', 'check-in']; let original: FakeNode | undefined;
  for (const [index, value] of variants.entries()) {
    const source = communicationEntry(); const message = source.messages?.[0]; assert.ok(message); message.timestamp = 1700000000000;
    message.communication = {state: 'ready', value, origin: {kind: 'native', recordEntryId: '42', target: {mode: 'input', storageId: '20000000-0000-4000-8000-000000000001', conversationId: 7, entryId: '41', submissionId: 1, requestId: 'receiving-request'}}};
    view.set([source]); flush(); const card = node('primary-transcript').querySelector('.communication-card'); assert.ok(card); original ??= card; assert.equal(card, original); assert.equal(card.querySelector('.communication-kind'), null); assert.equal(card.querySelector('.tool-card'), null);
    assert.equal(card.querySelector('.communication-trust'), null); assert.equal(card.querySelector('.communication-unverified')?.hidden, true);
    if (index === 1) assert.match(messageAction(card, 'Copy').description ?? '', /incomplete text/);
    assert.equal(card.querySelectorAll('time').length, 0); assert.equal(card.querySelector('.message-actions')?.querySelector('.timestamp'), null);
    const details = card.querySelector('.message-source'); assert.ok(details); messageAction(card, 'Source').run(); node('primary-editor').focus(); flush();
    assert.match(details.textContent, new RegExp(`Message kind${kinds[index]}`)); assert.match(details.textContent, /Recorded time1970-01-01T00:00:00.000Z/);
    assert.match(details.textContent, index === 1 ? /Message coverageIncomplete text/ : /Message coverageComplete/);
    if (index === 3) { assert.match(details.textContent, /Result statusunanswered/); assert.match(details.textContent, /ReasonNo retained answer/); }
    assert.match(details.textContent, /Receiving conversation20000000-0000-4000-8000-000000000001:7/); assert.match(details.textContent, /Sender identity10000000/); assert.match(details.textContent, /Transport timestamp2023/);
    if (index === 2) { assert.match(details.textContent, /result-request/); assert.match(details.textContent, /answer-entry/); assert.match(details.textContent, /Omitted references2/); }
    if (index === 4) assert.match(details.textContent, /Request originmodel/);
  }
  view.reset();
});
test('Source restores one target-local disclosure and preserves transport loss warnings', () => {
  setup(); let saved: string[] = []; const view = new Transcript('primary', {presentation: value => {saved = value;}, reading: () => {}}); const entry = communicationEntry(); const message = entry.messages?.[0]; assert.ok(message); message.coverage = {complete: false, truncated: true, omitted: 1};
  if (message.communication?.state === 'ready') message.communication.rawDetails = {value: {retained: true}, truncated: true, omittedBytes: 20};
  message.error = 'Supplied diagnostic'; view.set([entry]); flush(); const card = node('primary-transcript').querySelector('.communication-card'); const source = card?.querySelector('.communication-source'); assert.ok(card); assert.ok(source); assert.match(card.querySelector('.message-error')?.textContent ?? '', /Supplied diagnostic/);
  assert.equal(source.hidden, true); messageAction(card, 'Source').run?.(); flush(); assert.equal(source.hidden, false); assert.equal(Reflect.get(source, 'inert'), false); assert.match(source.querySelector('.communication-source-warning')?.textContent ?? '', /Only available transport.*incomplete.*20 structured/); assert.match(source.querySelector('.copy')?.title ?? '', /available/);
  const keys = [...saved]; assert.equal(keys.length, 1); assert.match(keys[0] ?? '', /^communication-details:/); view.reset(); view.configure({revision: 1, expanded: keys, showThinking: false}); view.set([communicationEntry()]); flush();
  const restored = node('primary-transcript').querySelector('.message-source'); assert.ok(restored); assert.equal(restored.hidden, false); assert.equal(Reflect.get(restored, 'inert'), false);
  const other = new Transcript('agent', {presentation: () => {}, reading: () => {}}); other.configure({revision: 1, expanded: [], showThinking: false}); other.set([communicationEntry()]); flush(); assert.equal(node('agent-transcript').querySelector('.message-source')?.hidden, true); assert.equal(restored.hidden, false); other.reset(); view.reset();
});
test('non-ready associations show literal previews without promoting sender or kind claims', () => {
  setup(); const view = transcript(); view.set([communicationEntry('ready', '', '')]); flush(); const article = node('primary-transcript').querySelector('.communication-card'); assert.ok(article);
  assert.equal(article.querySelector('.communication-sender')?.textContent, '10000000-0000-4000-8000-000000000001'); assert.equal(messageAction(article, 'Copy').enabled, false);
  const actions = article.querySelector('.message-actions');
  for (const state of ['unresolved', 'unavailable'] as const) {
    view.set([communicationEntry(state)]); flush(); assert.equal(article.dataset.state, state); assert.equal(article.querySelector('.communication-sender')?.textContent, ''); assert.equal(article.querySelector('.communication-sender')?.hidden, true); assert.equal(article.querySelector('.communication-unverified')?.attributes['aria-label'], 'Source unverified'); assert.equal(article.querySelector('.communication-unverified')?.hidden, false); assert.equal(article.querySelector('.communication-kind'), null); assert.equal(article.querySelector('.communication-copy'), null); assert.match(messageAction(article, 'Copy').description ?? '', /source unverified/); assert.equal(article.querySelector('.message-actions'), actions);
    assert.equal(article.querySelector('.communication-text')?.textContent, 'Original transport paragraph'); assert.equal(article.querySelector('.communication-text')?.classList.contains('communication-quoted'), true);
  }
  const unavailable = communicationEntry('unavailable'); const message = unavailable.messages?.[0]; assert.ok(message); message.communication = {state: 'unavailable', reason: 'limit'}; message.timestamp = 0; message.parts = [{type: 'text', text: '<b>literal</b>\n'.repeat(100)}]; view.set([unavailable]); flush();
  assert.equal(article.dataset.reason, 'limit'); const text = article.querySelector('.communication-text'); assert.ok(text); assert.equal(text.querySelector('b'), null); assert.ok(text.textContent.length <= 360); assert.match(text.attributes['aria-label'] ?? '', /Preview shortened/);
  const source = article.querySelector('.message-source'); assert.ok(source); messageAction(article, 'Source').run(); node('primary-editor').focus(); flush(); assert.equal(source.hidden, false); assert.match(source.textContent, /within display limits/); assert.ok(source.querySelector('pre')?.textContent.includes('<b>literal</b>'));
  message.parts = []; view.set([{...unavailable, messages: [{...message}]}]); flush(); assert.equal(text.textContent, 'No retained text'); view.reset();
});
test('redacted communication copies exact retained body with the trust exception', async () => {
  setup(); const view = transcript(); const writes: string[] = []; const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => {writes.push(text);}}}});
  try {
    const source = communicationEntry(); const message = source.messages?.[0]; assert.ok(message); if (message.communication?.state === 'ready') message.communication.value.body = {text: 'Safe prefix [redacted credential]', complete: false, redacted: true};
    view.set([source]); flush(); const article = node('primary-transcript').querySelector('.communication-card'); assert.ok(article); assert.equal(article.querySelector('.communication-text')?.textContent, 'Safe prefix [redacted credential]'); assert.equal(article.querySelector('.communication-trust'), null);
    const copy = messageAction(article, 'Copy'); assert.match(copy.description ?? '', /withheld/); messageAction(article, 'Source').run(); assert.match(article.querySelector('.message-source')?.textContent ?? '', /Some text withheld/); copy.run(); await Promise.resolve(); assert.deepEqual(writes, ['Safe prefix [redacted credential]']);
  } finally { view.reset(); if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
test('communication Copy refuses hidden, selected-old, reset and removed sources', async () => {
  setup(); const view = transcript(); const writes: string[] = []; const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => {writes.push(text);}}}});
  try {
    view.set([communicationEntry()]); flush(); const article = node('primary-transcript').querySelector('.communication-card'); assert.ok(article);
    const body = article.querySelector('.communication-body'); const source = article.querySelector('.message-source'); const menu = article.querySelector('.message-menu'); assert.ok(body); assert.ok(source); assert.ok(menu);
    assert.equal(article.querySelector('.communication-copy'), null); assert.equal(article.querySelector('.message-actions')?.querySelectorAll('.message-menu').length, 1);
    const messageCopy = messageAction(article, 'Copy'); assert.ok(messageCopy.run); messageAction(article, 'Source').run?.(); node('primary-editor').focus(); flush();
    const originalCopy = source.querySelector('.copy'); const close = source.querySelector('.message-source-close'); assert.ok(originalCopy); assert.ok(close); assert.equal(originalCopy.textContent, 'Copy original');
    assert.equal(source.hidden, false); assert.equal(Reflect.get(source, 'inert'), false);
    const ancestor = new FakeNode('section'); ancestor.className = 'conversation'; roots.push(ancestor); ancestor.append(node('primary-transcript')); ancestor.hidden = true;
    messageCopy.run(); originalCopy.click(); await Promise.resolve(); assert.deepEqual(writes, []);
    ancestor.hidden = false; close.click(); assert.equal(source.hidden, true); assert.equal(Reflect.get(source, 'inert'), true); originalCopy.click(); await Promise.resolve(); assert.deepEqual(writes, []);
    messageAction(article, 'Source').run?.(); node('primary-editor').focus(); messageCopy.run(); originalCopy.click(); await Promise.resolve(); assert.deepEqual(writes, ['Actual contribution', 'Original transport paragraph']);
    selection = {isCollapsed: false, anchorNode: body, focusNode: body}; const changed = communicationEntry('ready', 'Next supplied body'); const changedMessage = changed.messages?.[0]; assert.ok(changedMessage); changedMessage.parts = [{type: 'text', text: 'Next transport'}]; view.set([changed]); flush();
    assert.equal(article.querySelector('.communication-text')?.textContent, 'Actual contribution'); messageCopy.run(); originalCopy.click(); await Promise.resolve(); assert.equal(writes.length, 2);
    selection = null; view.schedule(); flush(); messageAction(article, 'Copy').run?.(); originalCopy.click(); await Promise.resolve(); assert.deepEqual(writes.slice(2), ['Next supplied body', 'Next transport']);
    for (const state of ['unavailable', 'unresolved'] as const) {
      view.set([communicationEntry(state)]); flush(); assert.equal(article.dataset.state, state); assert.equal(article.querySelector('.communication-sender')?.hidden, true);
      assert.equal(article.querySelector('.communication-unverified')?.hidden, false); assert.equal(article.querySelector('.message-source'), source); assert.equal(source.hidden, false); assert.equal(Reflect.get(source, 'inert'), false);
      const copy = messageAction(article, 'Copy'); assert.equal(copy.enabled, true); assert.match(copy.description ?? '', /source unverified/); const before: number = writes.length;
      copy.run?.(); originalCopy.click(); await Promise.resolve(); assert.deepEqual(writes.slice(before), ['Original transport paragraph', 'Original transport paragraph']);
    }
    view.set([communicationEntry()]); flush(); assert.equal(article.querySelector('.message-menu'), menu); assert.equal(source.querySelector('.copy'), originalCopy); assert.equal(article.querySelector('.communication-unverified')?.hidden, true);
    const restoredCopy = messageAction(article, 'Copy'); assert.ok(restoredCopy.run); const restoredAt = writes.length;
    restoredCopy.run(); originalCopy.click(); await Promise.resolve(); assert.deepEqual(writes.slice(restoredAt), ['Actual contribution', 'Original transport paragraph']); const confirmed = writes.length;
    view.reset(); view.set([communicationEntry('ready', 'New body')]); flush(); assert.equal(article.isConnected, false); restoredCopy.run(); originalCopy.click(); await Promise.resolve(); assert.equal(writes.length, confirmed);
    node('primary-transcript').append(article); restoredCopy.run(); originalCopy.click(); await Promise.resolve(); assert.equal(writes.length, confirmed); article.remove();
    const current = node('primary-transcript').querySelector('.communication-card'); assert.ok(current); const retained = messageAction(current, 'Copy'); assert.ok(retained.run);
    messageAction(current, 'Source').run?.(); node('primary-editor').focus(); const retainedOriginal = current.querySelector('.message-source')?.querySelector('.copy'); assert.ok(retainedOriginal);
    view.set([]); flush(); node('primary-transcript').append(current); retained.run(); retainedOriginal.click(); await Promise.resolve(); assert.equal(writes.length, confirmed); current.remove();
  } finally { selection = null; view.reset(); if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
test('Source caps displays but retains exact Copy and protected frame, Wrap and disclosure state', async () => {
  setup(); const view = transcript(); const writes: string[] = []; const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => {writes.push(text);}}}});
  try {
    const transport = 'transport '.repeat(6600); const detailsText = 'd'.repeat(8300); const entry = communicationEntry(); const message = entry.messages?.[0]; assert.ok(message); message.parts = [{type: 'text', text: transport}]; if (message.communication?.state === 'ready') message.communication.rawDetails = {value: detailsText, truncated: false};
    view.set([entry]); flush(); const card = node('primary-transcript').querySelector('.communication-card'); const source = card?.querySelector('.message-source'); assert.ok(card); assert.ok(source);
    assert.equal(source.hidden, true); assert.equal(Reflect.get(source, 'inert'), true); assert.equal(source.querySelector('pre'), null);
    messageAction(card, 'Source').run?.(); node('primary-editor').focus(); flush(); assert.equal(source.hidden, false); assert.equal(Reflect.get(source, 'inert'), false);
    const previews = source.querySelectorAll('pre'); const main = previews[0]; const structured = previews[1]; assert.ok(main); assert.ok(structured); assert.equal(main.textContent.length, 65536); assert.ok(main.textContent.endsWith('…')); assert.equal(structured.textContent.length, 8192); assert.ok(structured.textContent.endsWith('…'));
    const warning = source.querySelector('.communication-source-warning'); assert.ok(warning); assert.match(warning.textContent, /Display shortened; Copy original includes all retained text/); assert.match(warning.textContent, /Structured source display shortened/); assert.doesNotMatch(warning.textContent, /incomplete|Only available/);
    const frame = main.querySelector('.pre-text-frame'); const wrap = source.querySelector('.source-wrap'); const copy = source.querySelector('.copy'); assert.ok(frame); assert.ok(wrap); assert.ok(copy); wrap.click(); copy.click(); await Promise.resolve(); assert.deepEqual(writes, [transport]);
    selection = {isCollapsed: false, anchorNode: frame, focusNode: frame}; const changed = {...entry, messages: [{...message, communication: message.communication?.state === 'ready' ? {...message.communication, rawDetails: {value: 'new metadata', truncated: false}} : message.communication}]}; view.set([changed]); flush();
    assert.equal(source.querySelector('pre'), main); assert.equal(main.querySelector('.pre-text-frame'), frame); assert.equal(source.hidden, false); assert.equal(Reflect.get(source, 'inert'), false); assert.equal(main.dataset.wrap, 'false'); assert.equal(source.querySelector('.source-wrap'), wrap);
    assert.equal(structured.textContent.length, 8192); copy.click(); await Promise.resolve(); assert.deepEqual(writes, [transport]);
    selection = null; view.schedule(); flush(); assert.equal(source.querySelector('pre'), main); assert.equal(main.querySelector('.pre-text-frame'), frame); assert.equal(source.querySelectorAll('pre')[1], structured); assert.equal(structured.textContent, 'new metadata');
    assert.equal(source.hidden, false); assert.equal(Reflect.get(source, 'inert'), false); assert.equal(main.dataset.wrap, 'false'); assert.equal(source.querySelector('.source-wrap'), wrap); assert.equal(source.querySelector('.copy'), copy);
    copy.click(); await Promise.resolve(); assert.deepEqual(writes, [transport, transport]);
  } finally { selection = null; view.reset(); if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
test('Copy scopes retain one full output action and distinct argument and code actions', async () => {
  setup(); const view = transcript(); const writes: string[] = []; const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => {writes.push(text);}}}});
  try {
    const output = 'retained output '.repeat(6000); const args = {program: 'Supplied arguments'};
    view.set([contentEntry('one-copy', args, output, false, {value: {body: 'rich preview '.repeat(3000)}, truncated: false})]); flush();
    const shell = node('primary-transcript').querySelector('.tool-shell'); const card = shell?.querySelector('.tool-card'); assert.ok(shell); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
    const outputCopy = shell.querySelector('.tool-copy'); const argumentsNode = card.querySelector('.tool-arguments'); const raw = card.querySelector('.tool-raw-output'); assert.ok(outputCopy); assert.ok(argumentsNode); assert.ok(raw);
    assert.equal(shell.querySelectorAll('.tool-copy').length, 1); assert.equal(raw.querySelector('.copy'), null); assert.ok(raw.querySelector('.source-wrap'));
    assert.deepEqual(card.querySelector('.preview-omission')?.querySelectorAll('button').map(button => button.textContent), ['Show saved output']);
    outputCopy.dispatch('click', {stopPropagation() {}}); argumentsNode.querySelector('.copy')?.click(); await Promise.resolve(); assert.equal(writes[0], output); assert.deepEqual(JSON.parse(writes[1] ?? '{}'), args);
    assert.equal(argumentsNode.querySelector('.copy')?.textContent, 'Copy arguments');
    const code = markdownDom(['```ts', 'const value = 1;', '```'].join('\n')); assert.equal(code.querySelector('.copy')?.textContent, 'Copy code');
    view.set([entry('message-copy-scope', 'Original message')]); flush(); const message = node('primary-transcript').querySelector('.message'); assert.ok(message);
    assert.equal(message.querySelector('.message-actions')?.querySelector('.copy'), null); messageAction(message, 'Copy').run(); await Promise.resolve(); assert.equal(writes.at(-1), 'Original message');
  } finally {view.reset(); if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator');}
});
test('Source offers one original Copy with Wrap without duplicating the header message Copy', () => {
  setup(); const view = transcript();
  for (const state of ['ready', 'unresolved', 'unavailable'] as const) {
    view.set([communicationEntry(state)]); flush(); const card = node('primary-transcript').querySelector('.communication-card'); const source = card?.querySelector('.message-source'); assert.ok(card); assert.ok(source); messageAction(card, 'Source').run(); node('primary-editor').focus(); flush(); assert.equal(source.hidden, false);
    const copies = card.querySelectorAll('.copy').filter(button => !button.hidden); assert.equal(copies.filter(button => button.textContent === 'Copy original').length, 1); assert.equal(source.querySelectorAll('.copy').length, 1); assert.equal(card.querySelector('.message-actions')?.querySelectorAll('.copy').length, 0); assert.equal(messageAction(card, 'Copy').enabled, true); assert.ok(source.querySelector('.source-wrap'));
    assert.equal(copies.filter(button => button.textContent === 'Copy').length, 0); assert.equal(card.querySelector('.message-actions')?.querySelectorAll('.message-menu').length, 1);
    const headings = source.querySelectorAll('.communication-original-heading'); assert.equal(headings.length, 2); assert.equal(source.querySelector('.communication-structured')?.hidden, state !== 'ready'); for (const heading of headings) { assert.ok(heading.querySelector('h4')); assert.ok(heading.querySelector('.communication-original-toolbar')?.querySelector('.source-wrap')); }
  } view.reset();
});
test('action hover cues remain neutral while actual links and keyboard focus remain visible', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8'); const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selectors, body] of blocks) if (selectors?.includes(':hover')) assert.doesNotMatch(body ?? '', /text-decoration\s*:\s*underline/);
  for (const selector of ['.row-message:hover', '.message-actions button:hover', '.source-header button:hover', '.card-action:hover']) {
    const block = blocks.find(([, selectors]) => selectors?.split(',').some(value => value.trim() === selector)); assert.ok(block, selector); assert.match(block[2] ?? '', /background:\s*var\(--raised\)/);
  }
  assert.match(css, /a\s*\{[^}]*color:\s*var\(--link\)[^}]*text-underline-offset:\s*2px/); assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  setup(); const link = markdownDom('[Destination](https://example.test/destination)').querySelector('a'); assert.equal(Reflect.get(link ?? {}, 'href'), 'https://example.test/destination');
});
test('communication header keeps healthy and unknown completeness inside Source', () => {
  setup(); const view = transcript(); view.set([communicationEntry()]); flush(); const card = node('primary-transcript').querySelector('.communication-card'); assert.ok(card);
  const header = card.querySelector('.communication-header'); const actions = header?.querySelector('.message-actions'); const body = card.querySelector('.communication-body'); assert.ok(header); assert.ok(actions); assert.ok(body);
  assert.equal(actions.querySelectorAll('.message-menu').length, 1); assert.equal(actions.querySelector('.communication-copy'), null); assert.equal(card.querySelector('.communication-trust'), null);
  const inspection = body.querySelector('.message-source'); assert.ok(inspection); assert.equal(inspection.hidden, true); assert.equal(Reflect.get(inspection, 'inert'), true); assert.equal(inspection.querySelector('button')?.attributes['aria-label'], 'Close Source');
  assert.equal(card.querySelector('.communication-details'), null); assert.equal(card.querySelector('.communication-raw'), null); assert.equal(body.querySelectorAll('details').length, 0); assert.doesNotMatch(header.textContent, /Complete|Completeness|Communication/);
  messageAction(card, 'Source').run(); node('primary-editor').focus(); flush(); assert.match(inspection.textContent, /Message coverageCompleteness not reported/);
  const source = communicationEntry(); const message = source.messages?.[0]; assert.ok(message); if (message.communication?.state === 'ready') message.communication.value.body.complete = true;
  view.set([source]); flush(); assert.equal(header.querySelector('.communication-trust'), null); assert.doesNotMatch(header.textContent, /Complete|Completeness/); assert.match(inspection.textContent, /Message coverageComplete/); view.reset();
});
test('whole-workbench status retains controls and selects only the focused fact group', t => {
  setup(); const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {configurable: true, value: new EventTarget()});
  t.after(() => {documentHandlers.clear(); if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');});
  const root = new FakeNode('div'); const nodes = new Map<string, FakeNode>();
  const get = (id: string): FakeNode => { let value = nodes.get(id); if (!value) {value = new FakeNode('div'); nodes.set(id, value);} return value; };
  const model = get('model-button');
  const footerNode = get('workbench-status'); footerNode.className = 'workbench-status'; root.append(footerNode); const scope = get('workbench-scope'); scope.className = 'workbench-scope'; footerNode.append(scope, get('workbench-activity'));
  for (const pane of ['primary', 'agent']) { const group = get(`workbench-status-${pane}`); group.className = 'workbench-status-facts'; footerNode.append(group); }
  get('workbench-status-primary').append(model);
  const status = new WorkbenchStatus(id => get(id) as unknown as HTMLElement);
  status.update('primary', 'Primary', 'Working', 'primary-key'); const footer = root.querySelector('.workbench-status'); assert.ok(footer); assert.equal(footer.parentNode, root); assert.equal(footer.querySelectorAll('.workbench-status-facts')[0]?.children.includes(model), true);
  const groups = footer.querySelectorAll('.workbench-status-facts'); assert.equal(groups.length, 2); assert.deepEqual(groups.map(group => group.hidden), [false, true]);
  status.update('agent', 'Peer', 'Idle', 'exact-agent-identity'); assert.deepEqual(groups.map(group => group.hidden), [true, false]); assert.equal(footer.querySelector('.workbench-scope')?.title, 'exact-agent-identity'); assert.equal(groups[0]?.children.includes(model), true);
});
test('static workbench markup owns one footer and keeps composer actions without fact rings', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.equal([...html.matchAll(/<footer id="workbench-status"/g)].length, 1); assert.match(html, /<\/main>\s*<\/div>\s*<dialog id="modal"[\s\S]*?<\/dialog>\s*<footer id="workbench-status"/);
  assert.doesNotMatch(html, /<form id="(?:primary|agent)-composer"/);
  const composer = readFileSync(new URL('./composer.ts', import.meta.url), 'utf8');
  const factory = composer.slice(composer.indexOf('export function createComposerElements('), composer.indexOf('\ntype Edit ='));
  assert.match(factory, /const id = `composer-\$\{encodeURIComponent\(instanceId\)\}`/);
  assert.match(factory, /const root = element\('form', 'composer'\); root\.id = id/);
  assert.match(factory, /const send = element\('button', 'send'\); send\.id = `\$\{id\}-send`; send\.type = 'submit'/);
  assert.match(factory, /controlIcon\(send, 'send', 'Send'\)/); assert.match(factory, /controlIcon\(stop, 'stop', 'Stop'\)/);
  assert.match(factory, /element\('select'\)/);
  assert.match(factory, /const modes = element\('div', 'modes'\); modes\.id = `\$\{id\}-modes`/);
  assert.match(factory, /const recipient = element\('label', 'sr-only', 'Message'\); recipient\.id = `\$\{id\}-recipient`; recipient\.htmlFor = editor\.id/);
  assert.match(factory, /root\.append\(resize, receipt, input, line\)/); assert.match(factory, /bar\.append\(attach, picker, modes, stop, send\)/);
  assert.doesNotMatch(factory, /composer-settings|composer-guidance|usage-details|class="statusline"|root\.append\([^)]*receiptDetails/);
  assert.equal([...html.matchAll(/id="focused-composer-status" class="workbench-draft-state"/g)].length, 1);
});
test('workbench and communication CSS retain direct compact controls and keyboard targets', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  for (const selector of ['.workbench-status {', '.workbench-model {', '.workbench-draft-state {', '.workbench-activity {', '.communication-unverified {']) assert.ok(css.includes(selector), selector);
  assert.match(css, /\.workbench-status \{[^}]*display: flex;[^}]*flex: none;/); assert.match(css, /\.message-actions \{[^}]*display: flex;[^}]*min-height: 24px;[^}]*opacity: 0; pointer-events: none;/);
  assert.match(css, /\.message:hover > \.message-header > \.message-actions, \.message:focus-within > \.message-header > \.message-actions \{ opacity: 1; pointer-events: auto;/);
  assert.match(css, /\.message-menu \{ min-width: 24px; min-height: 24px/);
  assert.match(css, /\.message-menu, \.communication-unverified, \.message-source-close, \.pane-actions, \.context-menu > \.context-menu-item \{ min-height: 44px; min-width: 44px/);
  assert.doesNotMatch(css, /\.communication-header > \.communication-trust\s*\{/);
  assert.doesNotMatch(css, /\.composer-settings\b/); assert.doesNotMatch(css, /\.composer-details > summary\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.workbench-status \.composer-details > summary \{[^}]*min-height:\s*44px;[^}]*min-width:\s*44px/);
});
test('communication preserves selected contribution through refresh and deferred removal', () => {
  setup(); const view = transcript(); view.set([communicationEntry()]); flush(); const article = node('primary-transcript').querySelector('.communication-card'); const contribution = article?.querySelector('.communication-text'); assert.ok(article); assert.ok(contribution);
  const paragraph = contribution.firstChild; assert.ok(paragraph); selection = {isCollapsed: false, anchorNode: paragraph, focusNode: paragraph};
  view.set([communicationEntry('ready', 'Updated contribution')]); flush(); assert.equal(contribution.firstChild, paragraph); assert.equal(contribution.textContent, 'Actual contribution');
  selection = null; view.schedule(); flush(); assert.equal(contribution.textContent, 'Updated contribution');
  contribution.focus(); const ordinary = communicationEntry(); const message = ordinary.messages?.[0]; assert.ok(message); delete message.communication;
  view.set([ordinary]); flush(); assert.equal(article.classList.contains('communication-card'), true);
  fakeDocument.activeElement = null; view.schedule(); flush(); assert.equal(article.classList.contains('communication-card'), false); assert.match(article.textContent, /Original transport paragraph/); assert.equal(article.attributes['aria-label'], 'Notice message'); view.reset();
});
function threadEntry(id: string, threadId: string) {
  const source = communicationEntry(); source.id = id; const message = source.messages?.[0]; assert.ok(message);
  message.id = `m-${id}`; const carrier = message.communication; assert.ok(carrier?.state === 'ready');
  carrier.origin = {kind: 'ordinary-custom', customType: 'agent.peer', renderEntryId: message.id};
  carrier.value = {...carrier.value, kind: 'notice', metadata: {threadId}}; return source;
}
test('group mode retains original rows, cards, Source choices and source member order', () => {
  setup(); const saved: string[] = [];
  const view = new Transcript('primary', {presentation: (_expanded, _thinking, mode) => saved.push(mode ?? ''), reading: () => {}});
  const thread = '10000000-0000-4000-8000-000000000009/0123456789abcdef';
  const a = threadEntry('a', thread); const b = entry('b', 'Unassociated'); const c = threadEntry('c', thread);
  view.set([a, b, c]); flush(); const container = node('primary-transcript');
  const rows = container.children.filter(child => child.classList.contains('entry')); const cards = rows.map(row => row.querySelector('.message'));
  const card = cards[0]; assert.ok(card); const raw = card.querySelector('.message-source'); assert.ok(raw); messageAction(card, 'Source').run(); node('primary-editor').focus(); flush();
  saved.length = 0; view.setView('grouped'); flush();
  assert.deepEqual(container.children.filter(child => child.classList.contains('entry')).map(row => row.dataset.entryId), ['a', 'c', 'b']);
  assert.equal(rows[0]?.querySelector('.message'), cards[0]); assert.equal(rows[2]?.querySelector('.message'), cards[2]); assert.equal(raw.hidden, false); assert.equal(Reflect.get(raw, 'inert'), false);
  assert.equal(container.querySelectorAll('.transcript-group-header').length, 1); assert.match(container.querySelector('.transcript-group-coverage')?.textContent ?? '', /2 loaded entries/);
  assert.equal(view.loadedReference(thread), 'a'); assert.deepEqual(saved, ['grouped']);
  view.setView('chronological'); flush(); assert.deepEqual(container.children.filter(child => child.classList.contains('entry')).map(row => row.dataset.entryId), ['a', 'b', 'c']);
  assert.equal(container.querySelector('.transcript-group-header'), null); assert.equal(raw.hidden, false); assert.equal(Reflect.get(raw, 'inert'), false); view.reset();
});
test('group mode waits for selected text and restores the existing presentation preference', () => {
  setup(); const view = transcript(); const a = threadEntry('a', 'thread'); const b = entry('b'); const c = threadEntry('c', 'thread');
  view.set([a, b, c]); flush(); const content = node('primary-transcript').querySelector('.communication-text'); assert.ok(content);
  selection = {isCollapsed: false, anchorNode: content, focusNode: content}; view.setView('grouped');
  assert.equal(node('primary-transcript').dataset.view, 'chronological'); assert.equal(selection.anchorNode, content);
  selection = null; view.schedule(); flush(); assert.equal(node('primary-transcript').dataset.view, 'grouped'); assert.equal(content.isConnected, true);
  view.reset(); view.configure({revision: 2, expanded: [], showThinking: false, transcriptView: 'grouped'}); view.set([a, b, c]); flush();
  assert.deepEqual(node('primary-transcript').children.filter(row => row.classList.contains('entry')).map(row => row.dataset.entryId), ['a', 'c', 'b']); view.reset();
});
test('derived group updates do not read unchanged entries or infer prose membership', () => {
  const a = threadEntry('a', 'thread'); const b = entry('b', 'thread'); const groups = new TranscriptGroups(); const entries = new Map([[a.id, a], [b.id, b]]);
  groups.update(new Set(['a', 'b']), entries); const rows = groups.rows([a, b]);
  Object.defineProperty(a, 'messages', {get() { throw new Error('Unchanged entry was rescanned'); }});
  const next = entry('b', 'Updated unassociated content'); entries.set('b', next); groups.update(new Set(['b']), entries);
  assert.equal(groups.rows([a, next], false), rows); assert.equal(rows[1], next); assert.equal(groups.membership.has('b'), false);
  assert.equal(entryGroup(communicationEntry('unresolved')), undefined);
});
test('qualified native request groups remain separate and multi-reference results remain visible', () => {
  const a = communicationEntry(); const b = communicationEntry(); b.id = 'other';
  for (const [source, storageId] of [[a, 'owner-a'], [b, 'owner-b']] as const) {
    const message = source.messages?.[0]; assert.ok(message?.communication?.state === 'ready');
    message.communication.origin = {kind: 'native', recordEntryId: source.id, target: {mode: 'input', storageId, conversationId: 1, entryId: '1', submissionId: 1, requestId: 'same'}};
  }
  assert.notEqual(entryGroup(a)?.key, entryGroup(b)?.key);
  const message = a.messages?.[0]; assert.ok(message?.communication?.state === 'ready');
  message.communication.value = {...message.communication.value, kind: 'result', metadata: {status: 'done', references: [{submissionId: 1}, {submissionId: 2}], omittedReferences: 0}};
  assert.equal(entryGroup(a), undefined);
});
test('Source request and submission links use loaded native receiving records and reject ambiguity', () => {
  setup(); const calls: unknown[] = []; const queries: import('./references.ts').ReferenceQuery[] = []; const owner = '10000000-0000-4000-8000-000000000002:2'; let view: RetainedTranscript;
  const resolver = new ReferenceResolver(query => {queries.push(query); const entryId = view.loadedReference(query, owner); return entryId ? {destination: {target: {kind: 'agent', identity: 'receiver'}, entryId}} : {reason: 'No single loaded public receiving record.'};}, destination => calls.push(destination));
  view = new Transcript('primary', {references: resolver, presentation: () => {}, reading: () => {}});
  const source = communicationEntry(); const carrier = source.messages?.[0]?.communication; assert.ok(carrier?.state === 'ready');
  carrier.origin = {kind: 'native', recordEntryId: 'record', target: {mode: 'input', storageId: '10000000-0000-4000-8000-000000000002', conversationId: 2, entryId: 'input', submissionId: 19, requestId: 'public-request'}};
  view.set([source]); flush(); const card = node('primary-transcript').querySelector('.communication-card'); assert.ok(card); messageAction(card, 'Source').run?.(); flush();
  const links = card.querySelectorAll('.reference-link'); const request = links.find(link => link.textContent === 'public-request'), submission = links.find(link => link.textContent === '19'); assert.ok(request); assert.ok(submission);
  assert.ok(queries.some(query => typeof query !== 'string' && query.text === 'public-request' && query.owner === owner && query.field === 'requestId'));
  assert.ok(queries.some(query => typeof query !== 'string' && query.text === '19' && query.owner === owner && query.field === 'submissionId'));
  assert.equal(view.loadedReference({text: '19', owner: 'other-owner', field: 'submissionId'}, owner), undefined);
  assert.equal(view.loadedReference({text: '19', owner, field: 'entryId'}, owner), undefined);
  request.dispatch('click', {preventDefault() {}}); submission.dispatch('click', {preventDefault() {}}); assert.equal(calls.length, 2); assert.equal(view.loadedReference(carrier.value.sender.identity), undefined);
  const duplicate = structuredClone(source); duplicate.id = 'other-record'; view.set([source, duplicate]); flush();
  request.dispatch('click', {preventDefault() {}}); submission.dispatch('click', {preventDefault() {}}); assert.equal(calls.length, 2); assert.equal(view.loadedReference('19'), undefined);
  view.reset(); request.dispatch('click', {preventDefault() {}}); assert.equal(calls.length, 2);
});
test('one reference renderer links only resolved identities and preserves text and stale guards', () => {
  setup(); const known = '10000000-0000-4000-8000-000000000001'; const unknown = '20000000-0000-4000-8000-000000000002';
  const destinations: unknown[] = []; const resolver = new ReferenceResolver(text => text === known ? {destination: {target: {kind: 'agent', identity: known}}} : {reason: 'Not in the loaded public identities.'}, target => destinations.push(target));
  const view = new Transcript('primary', {references: resolver, presentation: () => {}, reading: () => {}});
  const original = `Reference ${known} and unresolved ${unknown}`;
  view.set([entry('ref', original)]); flush(); const container = node('primary-transcript'); const link = container.querySelector('.reference-link'); const inert = container.querySelector('.reference-unresolved');
  assert.ok(link); assert.ok(inert); assert.equal(link.tagName, 'a'); assert.equal(inert.tagName, 'span'); assert.equal(inert.title, 'Not in the loaded public identities.');
  assert.equal(container.querySelector('.message-body')?.textContent, original);
  const moves = link.moves; view.schedule(); flush(); assert.equal(container.querySelector('.reference-link'), link); assert.equal(link.moves, moves);
  link.dispatch('click', {preventDefault() {}}); assert.equal(destinations.length, 1);
  view.reset(); container.append(link); link.dispatch('click', {preventDefault() {}}); assert.equal(destinations.length, 1);
  assert.equal(referenceCandidates(`prefix${known}`).length, 0); assert.equal(referenceCandidates(`${known}:2`)[0]?.text, `${known}:2`);
});
test('mode and reference CSS retain direct controls, coarse targets and honest link cues', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8'); const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(css, /\.pane-actions \{ display: inline-flex; flex: none;[^}]*min-width: 24px; min-height: 24px/);
  assert.match(css, /\.message-menu, \.communication-unverified, \.message-source-close, \.pane-actions, \.context-menu > \.context-menu-item \{ min-height: 44px; min-width: 44px/);
  const menu = readFileSync(new URL('./context-menu.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');
  assert.match(app, /mode === 'chronological' \? 'View: Conversation' : 'View: Grouped'/);
  assert.match(app, /checked: view === mode, run: \(\) => owner\.transcript\.setView\(mode\)/);
  assert.match(menu, /label: 'Conversation actions…'/);
  assert.match(menu, /item\.checked === undefined \? 'menuitem' : item\.checkbox \? 'menuitemcheckbox' : 'menuitemradio'/); assert.match(menu, /row\.setAttribute\('aria-checked', String\(item\.checked\)\)/);
  assert.match(css, /a\.reference-link\[href\]\s*\{[^}]*text-decoration: underline/);
  assert.match(css, /\.reference-unresolved\s*\{[^}]*text-decoration: none; cursor: text/);
  assert.doesNotMatch(html, /id="(?:primary|agent)-transcript-view"|transcript-view-selector/); assert.doesNotMatch(css, /\.transcript-view-selector\s*\{/);
});

test('message Copy refuses retained controls after a session reset and source removal', async () => {
  setup(); const view = transcript(); const writes: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => { writes.push(text); }}}});
  try {
    view.set([entry('same-id', 'Original message')]); flush();
    const article = node('primary-transcript').querySelector('.message'); assert.ok(article); const menu = article.querySelector('.message-menu'); assert.ok(menu); const copy = messageAction(article, 'Copy'); assert.ok(copy.run);
    copy.run(); await Promise.resolve(); assert.deepEqual(writes, ['Original message']);
    view.reset(); view.set([entry('same-id', 'New session message')]); flush();
    assert.equal(menu.isConnected, false); copy.run(); await Promise.resolve(); assert.deepEqual(writes, ['Original message']);
    node('primary-transcript').append(article); assert.equal(menu.isConnected, true); copy.run(); await Promise.resolve(); assert.deepEqual(writes, ['Original message']);
    article.remove();
    const currentArticle = node('primary-transcript').querySelector('.message'); assert.ok(currentArticle); const current = messageAction(currentArticle, 'Copy'); assert.ok(current.run);
    current.run(); await Promise.resolve(); assert.deepEqual(writes, ['Original message', 'New session message']);
    view.set([]); flush(); current.run(); await Promise.resolve(); assert.equal(writes.length, 2);
  } finally {
    view.reset();
    if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

function retainedLifecycleFixture() {
  setup();
  const globalNames = ['ResizeObserver', 'MutationObserver', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'navigator'];
  const globals = globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const documents = ['fonts', 'documentElement', 'hidden'].map(name => [name, Object.getOwnPropertyDescriptor(fakeDocument, name)] as const);
  const fonts = new FakeNode('fonts'), appearance = new FakeNode('html'), media = [new FakeNode('media'), new FakeNode('media')];
  const rafs = new Map<number, FrameRequestCallback>(), timeouts = new Map<number, () => void>(), intervals = new Map<number, () => void>();
  const cancelled: number[] = [], writes: string[] = []; let sequence = 0;
  class Resize {
    targets = new Set<Element>(); observations = 0; disconnects = 0;
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; resizes.push(this); }
    observe(target: Element) { this.targets.add(target); this.observations++; }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.disconnects++; this.targets.clear(); }
    fire(target: FakeNode) { this.callback([{target, contentRect: {width: 601, height: 301}}] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver); }
  }
  class Mutation {
    targets = new Set<Node>(); disconnects = 0;
    readonly callback: MutationCallback;
    constructor(callback: MutationCallback) { this.callback = callback; mutations.push(this); }
    observe(target: Node) { this.targets.add(target); }
    disconnect() { this.disconnects++; this.targets.clear(); }
    fire() { this.callback([], this as unknown as MutationObserver); }
  }
  const resizes: Resize[] = [], mutations: Mutation[] = [];
  Object.assign(fakeDocument, {fonts, documentElement: appearance, hidden: false});
  Object.assign(globalThis, {ResizeObserver: Resize, MutationObserver: Mutation,
    matchMedia: (query: string) => media[query === '(forced-colors: active)' ? 0 : 1],
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++sequence; rafs.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => { cancelled.push(id); rafs.delete(id); },
    setTimeout: (callback: () => void) => { const id = ++sequence; timeouts.set(id, () => { timeouts.delete(id); callback(); }); return id; }, clearTimeout: (id: number) => timeouts.delete(id),
    setInterval: (callback: () => void) => { const id = ++sequence; intervals.set(id, callback); return id; }, clearInterval: (id: number) => intervals.delete(id)});
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (value: string) => { writes.push(value); }}}});
  const listeners = (target: FakeNode): Handler[] => [...(Reflect.get(target, 'handlers') as Map<string, Handler[]>).values()].flat();
  const drain = () => { const pending = [...rafs.values()]; rafs.clear(); for (const callback of pending) callback(0); };
  const create = () => {
    const pane = new FakeNode('section'), root = new FakeNode('div'), latest = new FakeNode('button'); pane.className = 'conversation pane-leaf'; roots.push(pane); pane.append(root, latest);
    const readings: import('../shared/api.ts').ReadingView[] = [], presentations: string[][] = [];
    const view = new RetainedTranscript({transcript: root as unknown as HTMLElement, latest: latest as unknown as HTMLElement}, {reading: value => readings.push(value), presentation: value => presentations.push(value)});
    return {pane, root, latest, readings, presentations, view};
  };
  const restore = () => {
    for (const [name, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    for (const [name, descriptor] of documents) { if (descriptor) Object.defineProperty(fakeDocument, name, descriptor); else Reflect.deleteProperty(fakeDocument, name); }
  };
  return {create, fonts, media, resizes, mutations, rafs, timeouts, intervals, cancelled, writes, listeners, drain, restore};
}

test('retained Transcript disposal removes listeners and cancels queued work without stale Copy or Source', async () => {
  const f = retainedLifecycleFixture(); const {view, root, latest, readings, presentations} = f.create();
  try {
    const source = contentEntry('clock', {command: 'probe'}, ''); const call = source.messages[0]?.parts.find(part => part.type === 'toolCall'); assert.ok(call);
    view.set([entry('text', 'Exact retained message'), source], new Map([[call.callId, {callId: call.callId, name: 'bash', phase: 'start', observedStart: Date.now()}]])); f.drain();
    assert.equal(f.intervals.size, 1);
    const card = root.querySelector('.message'); assert.ok(card); const copy = messageAction(card, 'Copy'), show = messageAction(card, 'Source');
    copy.run?.(); show.run?.(); const region = card.querySelector('.message-source'); assert.ok(region); const original = region.querySelector('.copy'); assert.ok(original); original.click(); await Promise.resolve();
    assert.deepEqual(f.writes, ['Exact retained message', 'Exact retained message']);
    const resize = f.resizes[0]; assert.ok(resize); resize.fire(root); assert.equal(f.timeouts.size, 1);
    view.defer(() => { throw new Error('Disposed deferred work must not execute'); }); root.dispatch('source-wrap'); root.dispatch('source-wrap');
    assert.equal(f.rafs.size, 3);
    const queuedFrames = [...f.rafs.values()], queuedTimers = [...f.timeouts.values(), ...f.intervals.values()];
    const targets = [root, latest, f.fonts, ...f.media]; const queuedListeners = [...targets.flatMap(f.listeners), ...[...documentHandlers.values()].flat()];
    assert.equal(queuedListeners.length, 13); const observations = resize.observations;
    view.destroy(); const disconnected = [resize.disconnects, ...f.mutations.map(observer => observer.disconnects)];
    const counts = [root.moves, root.writes, latest.writes, readings.length, presentations.length, region.textContent, original.textContent];
    view.destroy(); assert.deepEqual([resize.disconnects, ...f.mutations.map(observer => observer.disconnects)], disconnected);
    assert.equal(resize.observations, observations); assert.equal(resize.targets.size, 0); assert.equal(f.mutations.every(observer => observer.targets.size === 0), true);
    assert.equal(f.rafs.size, 0); assert.equal(f.cancelled.length, 3); assert.equal(f.timeouts.size, 0); assert.equal(f.intervals.size, 0);
    assert.equal(targets.flatMap(f.listeners).length, 0); assert.equal([...documentHandlers.values()].flat().length, 0);
    for (const callback of queuedFrames) callback(0); for (const callback of queuedTimers) callback();
    for (const listener of queuedListeners) listener({target: root}); resize.fire(root); for (const observer of f.mutations) observer.fire();
    for (const event of ['contextmenu', 'source-wrap', 'scroll', 'scrollend', 'focusout']) root.dispatch(event);
    latest.click(); fakeDocument.dispatch('selectionchange'); fakeDocument.dispatch('visibilitychange'); f.fonts.dispatch('loading'); f.fonts.dispatch('loadingdone'); for (const media of f.media) media.dispatch('change'); view.visibilityChanged(); view.schedule();
    copy.run?.(); show.run?.(); original.click(); card.querySelector('.message-menu')?.click(); await Promise.resolve();
    assert.deepEqual(f.writes, ['Exact retained message', 'Exact retained message']);
    assert.deepEqual([root.moves, root.writes, latest.writes, readings.length, presentations.length, region.textContent, original.textContent], counts);
    assert.equal(root.children.length, 0); assert.equal(f.rafs.size, 0); assert.equal(f.timeouts.size, 0); assert.equal(f.intervals.size, 0);
  } finally { view.destroy(); f.restore(); }
});

test('two independent scoped Transcript roots keep Source, reading and shared signals after one disposal', async () => {
  const f = retainedLifecycleFixture(); const left = f.create(), right = f.create();
  try {
    left.view.set([entry('same', 'Left exact text')]); right.view.set([entry('same', 'Right exact text')]); f.drain();
    const first = left.root.querySelector('.message'), second = right.root.querySelector('.message'); assert.ok(first); assert.ok(second);
    const leftCopy = messageAction(first, 'Copy'), leftSource = messageAction(first, 'Source');
    messageAction(second, 'Source').run?.(); const rightRegion = second.querySelector('.message-source'); assert.ok(rightRegion);
    assert.equal(first.querySelector('.message-source'), null); assert.match(rightRegion.textContent, /Right exact text/); assert.doesNotMatch(rightRegion.textContent, /Left exact text/);
    assert.equal(left.presentations.length, 0); assert.equal(right.presentations.length, 1); f.drain();
    left.root.dispatch('scrollend'); assert.equal(left.readings.length, 1); assert.equal(right.readings.length, 0);
    left.view.destroy(); const rightResize = f.resizes[1]; assert.ok(rightResize); assert.equal(rightResize.disconnects, 0); assert.equal(rightResize.targets.has(right.root as unknown as Element), true);
    assert.equal(f.listeners(left.root).length, 0); assert.equal(f.listeners(right.root).length, 5); assert.equal([...documentHandlers.values()].flat().length, 3);
    assert.equal(f.listeners(f.fonts).length, 2); assert.equal(f.media.every(target => f.listeners(target).length === 1), true);
    assert.equal(f.mutations.filter(observer => observer.disconnects === 0).length, 2);
    const leftCounts = [left.root.moves, left.root.writes, left.latest.writes, left.readings.length, left.presentations.length];
    f.fonts.dispatch('loadingdone'); for (const target of f.media) target.dispatch('change'); fakeDocument.dispatch('selectionchange'); fakeDocument.dispatch('visibilitychange');
    right.root.dispatch('source-wrap'); f.drain(); for (const callback of [...f.timeouts.values()]) callback();
    assert.deepEqual([left.root.moves, left.root.writes, left.latest.writes, left.readings.length, left.presentations.length], leftCounts);
    assert.equal(right.root.querySelector('.message'), second); assert.equal(right.root.querySelector('.message-source'), rightRegion); assert.ok(right.readings.length > 0);
    leftCopy.run?.(); leftSource.run?.(); messageAction(second, 'Copy').run?.(); await Promise.resolve(); assert.deepEqual(f.writes, ['Right exact text']);
    fakeDocument.activeElement = null; right.view.set([entry('same', 'Updated right text')]); f.drain(); assert.match(right.root.textContent, /Updated right text/); assert.equal(left.root.children.length, 0);
    right.latest.click(); assert.equal(right.readings.at(-1)?.followTail, false); right.root.dispatch('scrollend'); assert.equal(right.readings.at(-1)?.followTail, true);
    right.view.destroy(); assert.equal([...documentHandlers.values()].flat().length, 0); assert.equal(f.listeners(f.fonts).length, 0); assert.equal(f.media.flatMap(f.listeners).length, 0);
    assert.equal(rightResize.disconnects, 1); assert.equal(f.rafs.size, 0); assert.equal(f.timeouts.size, 0); assert.equal(f.intervals.size, 0);
  } finally { left.view.destroy(); right.view.destroy(); f.restore(); }
});

function transcriptTimingFixture() {
  const f = retainedLifecycleFixture(), previous = Object.getOwnPropertyDescriptor(globalThis, 'performance'); let now = 0;
  const entries: string[] = [], owners: RetainedTranscript[] = [];
  Object.defineProperty(globalThis, 'performance', {configurable: true, value: {now: () => now,
    mark: (name: string) => entries.push(name), measure: (name: string) => entries.push(name),
    getEntriesByName: () => { throw new Error('Transcript must not read another owner timing entry'); }}});
  const create = (timing?: ConstructorParameters<typeof RetainedTranscript>[1]['timing']) => {
    const pane = new FakeNode('section'), root = new FakeNode('div'), latest = new FakeNode('button'); pane.className = 'conversation pane-leaf'; roots.push(pane); pane.append(root, latest);
    const view = new RetainedTranscript({transcript: root as unknown as HTMLElement, latest: latest as unknown as HTMLElement}, {presentation: () => {}, reading: () => {}, timing}); owners.push(view);
    return {pane, root, view};
  };
  const restore = () => { for (const view of owners) view.destroy(); if (previous) Object.defineProperty(globalThis, 'performance', previous); else Reflect.deleteProperty(globalThis, 'performance'); f.restore(); };
  const tasks = () => { for (const callback of [...f.timeouts.values()]) callback(); };
  const drain = () => { tasks(); f.drain(); };
  return {...f, create, entries, tasks, drain, at: (value: number) => { now = value; }, restore};
}

test('Transcript timing coalesces each owned root and emits only after its real DOM update', () => {
  const f = transcriptTimingFixture(); const samples: [string, string, number, number][] = []; let replaced = 0;
  const left = f.create((metric, start, end) => { assert.match(left.root.textContent, /Left latest/); assert.doesNotMatch(left.root.textContent, /Right latest/); samples.push(['left', metric, start, end]); });
  const right = f.create((metric, start, end) => { assert.match(right.root.textContent, /Right latest/); samples.push(['right', metric, start, end]); });
  try {
    f.at(100); left.view.defer(() => { replaced++; }, 90);
    f.at(110); left.view.defer(() => { f.at(154); left.view.set([entry('same', 'Left latest')]); }, 95);
    right.view.defer(() => { replaced++; }, 108);
    f.at(120); right.view.defer(() => { f.at(161); right.view.set([entry('same', 'Right latest')]); }, 109);
    assert.equal(f.rafs.size, 0); assert.equal(f.timeouts.size, 2); assert.deepEqual(samples, []); f.at(150); f.drain();
    assert.equal(replaced, 0); assert.deepEqual(samples, [['left', 'render', 100, 154], ['left', 'stream-to-render', 90, 154], ['right', 'render', 110, 161], ['right', 'stream-to-render', 108, 161]]);
    assert.deepEqual(f.entries, []);
  } finally { f.restore(); }
});

test('Transcript timing rejects invalid receipts, preserves zero and is inert without a hook', () => {
  const f = transcriptTimingFixture(); const samples: [string, number, number][] = [];
  const inert = f.create(), owned = f.create((metric, start, end) => samples.push([metric, start, end]));
  try {
    f.at(10); inert.view.defer(() => inert.view.set([entry('inert', 'Inert real DOM')]), 0); f.at(20); f.drain(); assert.match(inert.root.textContent, /Inert real DOM/); assert.deepEqual(f.entries, []); assert.deepEqual(samples, []);
    f.at(50); const refresh = () => owned.view.set([entry('owned', 'Current text')]);
    for (const receipt of [Number.NaN, Infinity, -1, 51]) owned.view.defer(refresh, receipt);
    owned.view.defer(refresh, 0); owned.view.defer(refresh, 40); f.at(60); f.drain();
    assert.deepEqual(samples, [['render', 50, 60], ['stream-to-render', 0, 60]]);
    f.at(70); owned.view.schedule(); f.at(80); f.drain(); assert.deepEqual(samples.slice(2), [['render', 70, 80]]);
    f.at(90); owned.view.defer(refresh); f.at(100); f.drain(); assert.deepEqual(samples.slice(3), [['render', 90, 100]]); assert.deepEqual(f.entries, []);
  } finally { f.restore(); }
});

test('Transcript timing drops hidden, reset, cancelled and destroyed receipts without stale owner samples', () => {
  const f = transcriptTimingFixture(); const samples: [string, number, number][] = [];
  const owner = f.create((metric, start, end) => samples.push([metric, start, end]));
  const defer = () => owner.view.defer(() => owner.view.set([entry('same', 'Updated owner')]), 90);
  try {
    f.at(100); defer(); owner.pane.hidden = true; f.mutations[0]?.fire(); f.at(150); f.drain(); assert.deepEqual([...samples], []);
    owner.pane.hidden = false; owner.view.visibilityChanged(); f.at(160); f.drain(); assert.deepEqual(samples, [['render', 150, 160]]); samples.length = 0;
    f.at(200); owner.view.defer(() => owner.view.set([entry('same', 'Document hidden')]), 190); Reflect.set(fakeDocument, 'hidden', true); fakeDocument.dispatch('visibilitychange'); f.at(210); f.drain(); assert.deepEqual([...samples], []);
    Reflect.set(fakeDocument, 'hidden', false); fakeDocument.dispatch('visibilitychange'); f.at(220); owner.view.schedule(); f.at(230); f.drain(); assert.deepEqual(samples, [['render', 220, 230]]); samples.length = 0;
    f.at(300); owner.view.defer(() => { throw new Error('Reset must discard this refresh'); }, 290); owner.view.reset(); f.at(310); f.drain(); assert.deepEqual([...samples], []);
    f.at(320); owner.view.defer(() => owner.view.set([entry('same', 'Fresh receipt')]), 315); f.at(330); f.drain(); assert.deepEqual(samples, [['render', 320, 330], ['stream-to-render', 315, 330]]); samples.length = 0;
    f.at(340); defer(); owner.view.reset(); f.at(345); owner.view.defer(() => owner.view.set([entry('same', 'Fresh pending generation')]), 342); f.at(350); f.drain(); assert.deepEqual(samples, [['render', 345, 350], ['stream-to-render', 342, 350]]); samples.length = 0;
    f.at(400); defer(); owner.view.set([entry('same', 'Direct replacement')]); f.at(410); f.drain(); assert.deepEqual(samples, [['render', 400, 410]]); samples.length = 0;
    f.at(500); owner.view.defer(() => { owner.view.reset(); owner.view.set([entry('same', 'Reset inside refresh')]); }, 490); f.at(510); f.drain(); assert.deepEqual([...samples], []);
    f.at(520); owner.view.schedule(); f.at(530); f.drain(); assert.deepEqual(samples, [['render', 520, 530]]); samples.length = 0;
    f.at(600); defer(); const queued = [...f.rafs.values()]; owner.view.destroy(); f.at(610); for (const callback of queued) callback(0); owner.view.defer(() => { throw new Error('Destroyed refresh'); }, 605); owner.view.schedule(); assert.deepEqual([...samples], []); assert.equal(f.rafs.size, 0);
    const sinkReset = f.create((metric, start, end) => { samples.push([metric, start, end]); if (metric === 'render') sinkReset.view.reset(); });
    f.at(700); sinkReset.view.defer(() => sinkReset.view.set([entry('same', 'Before sink reset')]), 690); f.at(710); f.drain(); assert.deepEqual(samples, [['render', 700, 710]]); assert.deepEqual(f.entries, []);
  } finally { f.restore(); }
});

test('stream tasks coalesce after native echo and invalidate superseded frame and timer callbacks', () => {
  const f = transcriptTimingFixture(), owner = f.create(); const order: string[] = [];
  const editor = {closest: () => editor};
  try {
    f.at(10); owner.view.schedule(); const oldFrame = [...f.rafs.values()][0]; assert.ok(oldFrame);
    owner.view.defer(() => { order.push('stale'); }, 9);
    const oldTask = [...f.timeouts.values()][0]; assert.ok(oldTask); assert.equal(f.rafs.size, 0);
    fakeDocument.dispatch('beforeinput', {target: editor}); assert.equal(f.timeouts.size, 0);
    owner.view.defer(() => { order.push('first'); }, 10);
    owner.view.defer(() => { order.push('latest'); owner.view.set([entry('latest')]); }, 10);
    requestAnimationFrame(() => order.push('editor echo'));
    oldTask(); oldFrame(0); assert.deepEqual(order, []);
    const callbacks = [...f.rafs.values()]; f.rafs.clear(); for (const callback of callbacks) callback(0);
    assert.deepEqual(order, ['editor echo']); assert.equal(f.timeouts.size, 1);
    f.tasks(); assert.deepEqual(order, ['editor echo', 'latest']); assert.match(owner.root.textContent, /latest/);
    f.drain(); assert.deepEqual(order, ['editor echo', 'latest']); assert.equal(f.rafs.size, 0);
  } finally { f.restore(); }
});

test('native echo guards do not create extra renders and retain only current pending work', () => {
  const f = transcriptTimingFixture(); const samples: string[] = []; const owner = f.create(metric => samples.push(metric));
  const editor = {closest: () => editor};
  try {
    f.at(10); fakeDocument.dispatch('beforeinput', {target: editor}); f.drain(); f.drain();
    assert.deepEqual(samples, []); assert.equal(f.rafs.size, 0); assert.equal(f.timeouts.size, 0);
    fakeDocument.dispatch('beforeinput', {target: editor}); owner.view.set([entry('current')]); f.at(20); f.drain();
    assert.deepEqual(samples, []); assert.equal(f.rafs.size, 1); f.drain(); assert.deepEqual(samples, ['render']); samples.length = 0;
    fakeDocument.dispatch('beforeinput', {target: editor}); owner.view.defer(() => { throw new Error('Reset must discard guarded refresh'); }, 19); owner.view.reset();
    f.drain(); assert.deepEqual(samples, []); assert.equal(f.rafs.size, 0); assert.equal(f.timeouts.size, 0);
    fakeDocument.dispatch('beforeinput', {target: editor}); owner.view.reset(); owner.view.defer(() => owner.view.set([entry('fresh')]), 19);
    f.drain(); assert.deepEqual(samples, []); f.tasks(); assert.deepEqual(samples, ['render', 'stream-to-render']); assert.match(owner.root.textContent, /fresh/);
  } finally { f.restore(); }
});

test('stream tasks are inert after reset, disposal or a direct replacement, and hidden views stay frame-bound', () => {
  const f = transcriptTimingFixture(), owner = f.create(); let stale = 0;
  try {
    f.at(10); owner.view.defer(() => { stale++; }, 9); const resetTask = [...f.timeouts.values()][0]; assert.ok(resetTask);
    owner.view.reset(); resetTask(); assert.equal(stale, 0);
    owner.view.defer(() => { stale++; }, 9); owner.view.set([entry('direct')]); f.drain(); assert.equal(stale, 0); assert.match(owner.root.textContent, /direct/);
    f.tasks(); owner.pane.hidden = true; owner.view.defer(() => owner.view.set([entry('hidden')]), 9);
    assert.equal(f.timeouts.size, 0); assert.equal(f.rafs.size, 1); f.drain(); assert.doesNotMatch(owner.root.textContent, /hidden/);
    owner.pane.hidden = false; owner.view.visibilityChanged(); f.drain(); assert.match(owner.root.textContent, /hidden/); f.tasks();
    owner.view.defer(() => { stale++; }, 9); const disposedTask = [...f.timeouts.values()][0]; assert.ok(disposedTask);
    owner.view.destroy(); disposedTask(); assert.equal(stale, 0); assert.equal(f.timeouts.size, 0); assert.equal(f.rafs.size, 0);
  } finally { f.restore(); }
});
