import assert from 'node:assert/strict';
import test from 'node:test';
import { Transcript, structured } from './render.ts';
import { contextMenu } from './context-menu.ts';
import { Roster } from './roster.ts';
import { markdownDom } from './safe-markdown.ts';
import { outputPages } from './transcript-output.ts';
import type { JsonDisplay, OutputPage, PartView } from '../shared/api.ts';

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
    contains: (name: string) => this.className.split(' ').includes(name)};
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
  get lastElementChild(): FakeNode | null { return this.children.at(-1) ?? null; }
  get nextSibling(): FakeNode | null {
    const peers = this.parentNode?.children ?? []; return peers[peers.indexOf(this) + 1] ?? null;
  }
  get offsetHeight(): number {
    if (this.hidden) return 0;
    if (this.style.height) return Number.parseFloat(this.style.height);
    if (this.measured !== undefined) return this.measured;
    if (this.className === 'entry') return 140;
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
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  removeAttribute(key: string): void { delete this.attributes[key]; }
  hasAttribute(key: string): boolean { return Object.hasOwn(this.attributes, key); }
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
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
let selection: {isCollapsed: boolean; anchorNode: FakeNode | null; focusNode: FakeNode | null} | null = null;
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
  dispatch: (name: string) => { for (const handler of documentHandlers.get(name) ?? []) handler({}); },
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
const coverage = {complete: true, truncated: false, omitted: 0};
function message(id: string, text: string, state: 'partial' | 'final' = 'final') {
  return {id, role: 'assistant', state, parts: [{type: 'text' as const, text}], coverage};
}
function entry(id: string, text = id) { return {id, kind: 'message', messages: [message(`m-${id}`, text)]}; }
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
  assert.deepEqual(saved, []); assert.equal(container.scrollTop, 0);
  section.hidden = false; view.set(entries); flush();
  const target = container.children.find(child => child.dataset.entryId === 'e10'); assert.ok(target);
  assert.equal(container.scrollTop, target.offsetTop - container.offsetTop + 33);
  container.dispatch('scrollend'); assert.equal(saved[0]?.anchorId, 'e10'); assert.equal(saved[0]?.offsetPx, 33); assert.equal(saved[0]?.followTail, false);
  const position = container.scrollTop; view.set(entries); section.hidden = true; flush();
  container.dispatch('scrollend'); assert.equal(saved.length, 1); assert.equal(container.scrollTop, position);
  section.hidden = false; view.set(entries); flush(); assert.equal(container.scrollTop, position);
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
test('callId joins call and results across entries with one bounded disclosure and raw output', () => {
  setup(); const view = transcript();
  const call = {type: 'toolCall' as const, callId: 'call-1', name: 'read', arguments: {value: {path: '/full/path', offset: 1, limit: 10}, truncated: false}};
  const result = {type: 'toolResult' as const, callId: 'call-1', name: 'read', isError: false, parts: [{type: 'text' as const, text: 'x'.repeat(5000)}]};
  const entries = [{id: 'call', kind: 'message', messages: [{...message('m-call', ''), parts: [call]}]}, {id: 'result', kind: 'message', messages: [{...message('m-result', ''), parts: [result]}]}];
  view.set(entries); flush(); const cards = node('primary-transcript').querySelectorAll('.tool-card'); assert.equal(cards.length, 1);
  const card = cards[0]; assert.ok(card); assert.equal(card.querySelector('.tool-name')?.textContent, 'read'); assert.equal(card.querySelector('.tool-target')?.textContent, '/full/path');
  assert.equal(card.querySelector('.tool-secondary')?.textContent, 'lines 1–10');
  assert.equal(card.parentNode?.dataset.status, 'success'); assert.equal(card.querySelector('.tool-tier')?.children[0], card.querySelector('.tool-status'));
  assert.equal(card.querySelector('.tool-status')?.attributes.role, 'img'); assert.equal(card.querySelector('.tool-status')?.attributes['aria-label'], 'success');
  assert.doesNotMatch(card.textContent, /Tool returned successfully|Working|Tool error/); assert.ok((card.querySelector('.tool-preview')?.textContent.length ?? Infinity) < 2000);
  assert.match(card.querySelector('.tool-preview')?.textContent ?? '', /\n…$/);
  assert.equal(card.querySelector('.tool-preview')?.parentNode, card.querySelector('summary'));
  assert.equal(card.querySelectorAll('details').length, 0); card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('pre')?.textContent, 'x'.repeat(5000));
  const raw = card.querySelectorAll('details').find(node => node.querySelector('summary')?.textContent === 'raw result');
  assert.ok(raw); raw.open = true; raw.dispatch('toggle'); assert.equal(raw.querySelector('pre')?.textContent, 'x'.repeat(5000));
  assert.equal(card.querySelectorAll('.tool-chevron').length, 0); assert.equal(card.parentNode?.querySelectorAll('.tool-copy').length, 1);
  view.set(entries, new Map([['call-1', {callId: 'call-1', name: 'read', phase: 'end' as const, parts: [{type: 'text' as const, text: 'failure cause'}], isError: true}]])); flush();
  assert.equal(node('primary-transcript').querySelector('.tool-card'), card); assert.match(card.textContent, /failure cause/);
  assert.equal(card.querySelector('.tool-status')?.attributes['aria-label'], 'error');
  assert.equal(card.parentNode?.dataset.status, 'error'); assert.match(card.querySelector('.tool-status')?.textContent ?? '', /error/);
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
  assert.doesNotMatch(container.textContent, /toolResult/); view.find('needle result'); assert.equal(fakeDocument.activeElement, container.children[0]);
  const unmatched = {id: 'unmatched', kind: 'message', messages: [{...resultMessage, id: 'unmatched-message', parts: [{...result, callId: 'unmatched'}]}]};
  const mixed = {id: 'mixed', kind: 'message', messages: [{...resultMessage, id: 'mixed-message', parts: [result, {type: 'text' as const, text: 'Preserved prose'}]}]};
  const error = {id: 'error', kind: 'message', messages: [{...resultMessage, id: 'error-message', error: 'Preserved cause'}]};
  view.set([call, joined, unmatched, mixed, error]); flush(); assert.equal(container.querySelectorAll('.message-actions').length, 4);
  assert.equal(container.querySelectorAll('.tool-card').length, 2); assert.match(container.textContent, /Preserved prose/); assert.match(container.textContent, /Preserved cause/);
  assert.equal(container.querySelector('.tool-card'), card);
  view.set([joined]); flush(); assert.equal(container.querySelectorAll('.message-actions').length, 1);
  assert.equal(container.querySelector('.tool-card'), card); assert.equal(container.querySelector('.message')?.attributes['aria-label'], 'toolResult message');
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
  const thinking = node('primary-transcript').querySelector('.thinking'); assert.ok(thinking); assert.equal(thinking.open, true); assert.match(thinking.textContent, /omitted by host/); assert.doesNotMatch(thinking.textContent, /secret/);
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
test('find mounts a loaded virtual match before focus and restore works outside the current window', () => {
  setup(); const view = transcript(); view.set(Array.from({length: 220}, (_, i) => entry(`e${i}`, `text ${i}`))); flush();
  view.find('text 7'); const found = node('primary-transcript').children.find(child => child.dataset.entryId === 'e7'); assert.ok(found);
  assert.equal(fakeDocument.activeElement, found); assert.equal(node('primary-transcript').scrollTop, found.offsetTop);
  view.restore({revision: 1, anchorId: 'e180', offsetPx: 33, followTail: false}); flush();
  const target = node('primary-transcript').children.find(child => child.dataset.entryId === 'e180'); assert.ok(target);
  assert.equal(node('primary-transcript').scrollTop, target.offsetTop + 33);
});
test('roster preserves order, visible duplicate identities, keyed rows and data-arrival ages', () => {
  setup(); const now = Date.now; let clock = 600000; Date.now = () => clock;
  try {
    const selected: string[] = []; const view = new Roster(row => selected.push(row.identity), () => {}); const one = row('one', 'same'); const two = row('two', 'same');
    view.set([one, two]); flush(); const first = node('roster').children[0]; assert.ok(first); const age = first.querySelector('time'); assert.equal(age?.textContent, '10m'); assert.match(first.querySelector('.row-select')?.attributes['aria-label'] ?? '', /one/);
    assert.equal(first.querySelector('.row-identity')?.textContent, 'one');
    assert.equal(first.querySelector('.row-word'), null); assert.equal(first.querySelector('.row-detail'), null); assert.equal(first.dataset.live, 'true');
    assert.equal(first.querySelector('.row-model'), null); assert.equal(first.querySelector('.row-activity'), null);
    assert.equal(first.querySelector('.row-select')?.title, 'working');
    assert.equal(first.querySelector('.row-select')?.attributes['aria-description'], 'working');
    assert.equal(node('roster').children[1]?.querySelector('.row-identity')?.textContent, 'two');
    clock = 900000; view.set([two, one], undefined, 'two'); flush(); assert.equal(node('roster').children[0], first); assert.equal(age?.textContent, '10m');
    first.querySelector('.row-select')?.dispatch('click'); assert.deepEqual(selected, ['one']);
    view.set([{...one, latestReply: 'new'}, two]); flush(); assert.equal(node('roster').children[0], first); assert.equal(age?.textContent, '15m');
    assert.equal(first.querySelector('.row-select')?.title, 'working · new');
    first.querySelector('.row-age')?.dispatch('click'); assert.doesNotMatch(age?.textContent ?? '', /ago/);
  } finally { Date.now = now; }
});
test('roster older scope and in-place filter keep the keyed row and focus', () => {
  setup(); const view = new Roster(() => {}, () => {});
  const old = {...row('old', 'Older'), state: 'done', availability: 'stored' as const};
  view.set([row('live', 'Live'), old], {stale: false, scan: {state: 'ready', complete: true, visited: 2, skipped: 0, omitted: 0}}); flush();
  const container = node('roster'); const older = container.querySelector('.roster-older'); assert.equal(older?.textContent, '1 older');
  assert.equal(node('roster-footer').hidden, true); assert.equal(node('agent-search').hidden, false);
  older?.dispatch('click'); assert.equal(older?.textContent, 'hide older');
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
  setup(); const actions: Array<string | undefined> = []; const view = new Roster(() => {}, action => actions.push(action));
  const scan = {state: 'not-started' as const, complete: false, visited: 0, skipped: 0, omitted: 0};
  view.set([], {scan, stale: false}); flush(); assert.equal(node('roster').textContent, 'Roster not loaded');
  const empty = node('roster').children[0]; const refresh = node('roster-footer').querySelector('button'); assert.equal(refresh?.textContent, 'refresh'); refresh?.dispatch('click');
  assert.doesNotMatch(node('roster-footer').textContent, /0 loaded|more/);
  view.set([], {scan: {...scan, state: 'running'}, stale: false}); flush(); assert.equal(node('roster').children[0], empty);
  assert.equal(node('roster').textContent, 'Loading roster'); assert.equal(node('roster-footer').querySelector('button'), null); assert.equal(node('roster-footer').hidden, false);
  view.set([], {scan: {...scan, state: 'failed'}, stale: false, error: {code: 'catalog', message: 'Record unreadable', retry: 'read'}}); flush();
  assert.match(node('roster').textContent, /Roster discovery failed: Record unreadable/); const retry = node('roster-footer').querySelector('button'); assert.equal(retry?.textContent, 'retry'); retry?.dispatch('click');
  view.set([], {scan: {...scan, state: 'ready', complete: true}, stale: false}); flush();
  assert.equal(node('roster').textContent, 'No agents in this view'); assert.equal(node('roster-footer').querySelector('button'), null);
  assert.equal(node('roster-footer').hidden, true); assert.equal(node('roster-footer').textContent, '');
  assert.deepEqual(actions, ['refresh', 'refresh']);
});
test('roster more uses cached page cursors independently from scan completeness', () => {
  setup(); const actions: Array<string | undefined> = []; const view = new Roster(() => {}, action => actions.push(action));
  const scan = {state: 'ready' as const, complete: true, visited: 2, skipped: 0, omitted: 0};
  view.set([row('one')], {scan, stale: false, nextCursor: 'page-2'}); flush();
  const more = node('roster').querySelector('.roster-more'); assert.equal(more?.textContent, 'more'); assert.equal(node('roster').lastElementChild, more);
  assert.equal(node('roster-footer').hidden, true); assert.equal(node('roster').querySelector('.roster-older'), null); more?.dispatch('click');
  view.set([], {scan: {...scan, complete: false, scanId: 'scan-2'}, stale: false, nextCursor: null}); flush();
  const continuation = node('roster').querySelector('.roster-more'); assert.equal(continuation, more); assert.equal(continuation?.textContent, 'continue scan'); continuation?.dispatch('click');
  view.set([], {scan: {...scan, complete: false}, stale: false}); flush(); assert.equal(node('roster-footer').querySelector('button'), null); assert.equal(node('roster').querySelector('.roster-more'), null);
  view.set([row('one')], {scan: {...scan, state: 'failed'}, stale: true, nextCursor: 'page-2'}); flush();
  const buttons = node('roster-footer').querySelectorAll('button'); assert.deepEqual(buttons.map(button => button.textContent), ['retry']);
  node('roster').querySelector('.roster-more')?.dispatch('click'); buttons[0]?.dispatch('click'); assert.deepEqual(actions, ['more', 'more', 'more', 'refresh']);
});
test('roster virtual rows retain selected/focused pins, internal gaps and measured heights', () => {
  setup(); const view = new Roster(() => {}, () => {}); const rows = Array.from({length: 220}, (_, i) => row(`full-identity-${i}`));
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
  const buttons = node('primary-transcript').querySelectorAll('button').filter(button => button.textContent === 'fork');
  assert.equal(buttons.length, 1); buttons[0]?.dispatch('click'); assert.deepEqual(forks, ['retained']);
  view.set([{...entries[0], messages: [{...user, state: 'partial'}]}]); flush();
  assert.equal(node('primary-transcript').querySelectorAll('button').filter(button => button.textContent === 'fork').length, 0);
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
  const inspection = card.querySelectorAll('details').find(node => node.firstChild?.textContent === 'arguments'); assert.ok(inspection);
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
  assert.equal(fragment.querySelector('ol')?.attributes.start, '3'); assert.equal(fragment.querySelector('th')?.scope, 'col');
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
  pages.querySelectorAll('button').find(button => button.textContent === 'more output')?.dispatch('click');
  await Promise.resolve(); await Promise.resolve(); flush();
  assert.equal(pages.querySelector('.output-page')?.textContent, pageText); assert.equal(pages.querySelector('.syn-keyword')?.textContent, 'return');
  view.set(entries, new Map([['read', {callId: 'read', name: 'read', phase: 'end', parts, isError: true}]])); flush();
  assert.equal(pre.textContent, text); assert.equal(pre.querySelector('.syn-keyword'), null);
  assert.equal(pages.querySelector('.syn-keyword'), null);
});
test('expanded write inspection highlights retained supplied code without changing the text', () => {
  setup(); const view = transcript(); const content = 'const value: number = 42;\n'.repeat(400);
  const entries = [{id: 'write-code', kind: 'message', messages: [{...message('write-code', ''), parts: [{type: 'toolCall' as const, callId: 'write-code', name: 'write', arguments: {value: {path: 'source.ts', content}, truncated: false}}]}]}];
  view.set(entries); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush();
  const inspection = card.querySelector('.tool-content')?.querySelector('details'); assert.ok(inspection);
  inspection.open = true; inspection.dispatch('toggle');
  assert.equal(inspection.querySelector('pre')?.textContent, content); assert.equal(inspection.querySelector('.syn-keyword')?.textContent, 'const');
});
test('standalone Markdown rules render semantic hr nodes with no text or HTML evaluation', () => {
  setup(); const wrapper = new FakeNode('div'); wrapper.append(markdownDom('---\n\n***\n\n___\n\n<script>inert</script>'));
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
  const next = content.querySelectorAll('button').find(item => item.textContent === 'more output'); assert.ok(next);
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve(); assert.match(content.textContent, /source unavailable/);
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve(); assert.equal(content.querySelector('.output-page')?.textContent, 'page 8192');
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve(); assert.equal(content.querySelector('.output-page')?.textContent, 'page 16384');
  assert.deepEqual(offsets, [8192, 8192, 16384]); assert.doesNotMatch(content.querySelector('.output-page')?.textContent ?? '', /page 8192/);
  const previous = content.querySelectorAll('button').find(item => item.textContent === 'previous output'); previous?.dispatch('click');
  await Promise.resolve(); await Promise.resolve(); assert.equal(content.querySelector('.output-page')?.textContent, 'page 8192');
  assert.equal(pre.querySelector('.pre-text-frame'), frame); assert.equal(frame.textContent, 'page 8192');
  content.querySelectorAll('button').find(item => item.textContent === 'start over')?.dispatch('click');
  assert.equal(pre.hidden, true); assert.equal(frame.textContent, ''); assert.equal(pre.querySelector('.pre-text-frame'), frame);
});
test('tool result paging uses the result source and reset discards a late page', async () => {
  setup(); let resolve: (page: OutputPage) => void = () => {}; const requests: unknown[] = [];
  const view = new Transcript('primary', {presentation: () => {}, reading: () => {}, output: more => { requests.push(more); return new Promise(done => { resolve = done; }); }});
  view.set([{id: 'call-owner', kind: 'message', messages: [{...message('call-message', ''), parts: [{type: 'toolCall', callId: 'x', name: 'read', arguments: {value: {}, truncated: false}}]}]},
    {id: 'result-source', kind: 'message', messages: [{...message('result-message', ''), parts: [{type: 'toolResult', callId: 'x', name: 'read', parts: [{type: 'text', text: 'initial', more: {entryId: 'result-source', part: 3, offset: 8192}}], isError: false}]}]}]); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const next = card.querySelectorAll('button').find(item => item.textContent === 'more output'); assert.ok(next); next.dispatch('click');
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
  assert.match(container.textContent, /Message content is not fully displayed/);
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
  assert.doesNotMatch(container.textContent, /omitted by host/);
  view.set([{...retained, messages: [{...saved, coverage: {...saved.coverage, reason: 'More protected text is available.'}}]}]); flush();
  assert.equal(container.querySelector('p'), paragraph); assert.equal(container.querySelector('.output-pages'), continuation);
  assert.match(container.textContent, /More protected text is available\./);
  assert.equal(continuation.querySelectorAll('button').some(button => button.textContent === 'more output'), true);
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
  assert.deepEqual(labels, reasons.map(() => 'Message content is not fully displayed.'));
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
  assert.match(cards[1]?.querySelector('.tool-content')?.textContent ?? '', /written content.*written supplied/s);
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
    const disclosure = card.querySelector('.tool-content')?.querySelector('details'); assert.ok(disclosure);
    disclosure.open = true; disclosure.dispatch('toggle'); inspections.push(disclosure);
    assert.equal(disclosure.querySelector('pre')?.textContent, supplied);
  }
  const parts = [{type: 'text' as const, text: 'updated raw result'}];
  view.set(entries, new Map(['edit', 'write'].map(id => [id, {callId: id, name: id, phase: 'end' as const, parts}]))); flush();
  for (const disclosure of inspections) { assert.equal(disclosure.isConnected, true); assert.equal(disclosure.querySelector('pre')?.textContent, supplied); }
  for (const card of cards) assert.equal(card.querySelector('.tool-output-text')?.textContent, 'updated raw result');
});
test('write completion keeps open retained content and updates its reported label', () => {
  setup(); const view = transcript(); const content = 'retained '.repeat(2000);
  const entries = [{id: 'write', kind: 'message', messages: [{...message('write', ''), parts: [{type: 'toolCall' as const, callId: 'write', name: 'write', arguments: {value: {content}, truncated: false}}]}]}];
  view.set(entries); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush();
  const region = card.querySelector('.tool-content'); const disclosure = region?.querySelector('details'); assert.ok(disclosure);
  disclosure.open = true; disclosure.dispatch('toggle'); disclosure.focus();
  view.set(entries, new Map([['write', {callId: 'write', name: 'write', phase: 'end', parts: [{type: 'text', text: 'complete'}]}]])); flush();
  assert.equal(card.querySelector('.tool-content'), region); assert.equal(disclosure.open, true);
  assert.equal(disclosure.isConnected, true); assert.equal(fakeDocument.activeElement, disclosure);
  assert.equal(disclosure.querySelector('pre')?.textContent, content); assert.match(region?.textContent ?? '', /written content/);
});
test('bash command and output stay distinct, and shell status follows live completion', () => {
  setup(); const view = transcript();
  const call = {type: 'toolCall' as const, callId: 'bash', name: 'bash', arguments: {value: {command: 'echo first\necho second', timeout: 45}, truncated: false}};
  const entries = [{id: 'call', kind: 'message', messages: [{...message('bash', ''), parts: [call]}]}];
  view.set(entries); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  assert.equal(card.parentNode?.dataset.status, 'working'); assert.equal(card.querySelector('.tool-target')?.textContent, '$ echo first…');
  assert.equal(card.querySelector('.tool-secondary')?.textContent, '(timeout 45s)');
  card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('.tool-command')?.textContent, 'echo first\necho second');
  assert.equal(card.querySelector('.tool-source')?.open, true);
  view.set(entries, new Map([['bash', {callId: 'bash', name: 'bash', phase: 'end', parts: [{type: 'text', text: 'first\nsecond'}]}]])); flush();
  assert.equal(card.parentNode?.dataset.status, 'success'); assert.equal(card.querySelector('.tool-output-text')?.textContent, 'first\nsecond');
  view.set(entries, new Map([['bash', {callId: 'bash', name: 'bash', phase: 'end', parts: [], isError: true}]])); flush();
  assert.equal(card.parentNode?.dataset.status, 'error'); assert.equal(card.querySelector('.tool-output-text')?.textContent, 'Tool failed without retained output.');
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
test('compact read headers expand to the supplied path and retain the line range', () => {
  setup(); const view = transcript();
  const path = '/skills/audit/SKILL.md';
  const entries = [{id: 'read', kind: 'message', messages: [{...message('read', ''), parts: [{type: 'toolCall' as const, callId: 'read', name: 'read', arguments: {value: {path, offset: 7, limit: 4}, truncated: false}}]}]}];
  view.set(entries); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  assert.equal(card.querySelector('.tool-name')?.textContent, '[skill]'); assert.equal(card.querySelector('.tool-target')?.textContent, 'audit');
  assert.equal(card.querySelector('.tool-target')?.title, path); assert.equal(card.querySelector('.tool-secondary')?.textContent, 'lines 7–10');
  card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('.tool-name')?.textContent, 'read'); assert.equal(card.querySelector('.tool-target')?.textContent, path);
  card.open = false; card.dispatch('toggle'); flush(); assert.equal(card.querySelector('.tool-target')?.textContent, 'audit');
});
test('final thinking uses safe Markdown while partial and redacted thinking remain plain text', () => {
  setup(); const view = transcript();
  const retained = (state: 'partial' | 'final', redacted = false) => ({id: 'thought', kind: 'message', messages: [{...message('thought', '', state), parts: [{type: 'thinking' as const, text: '**reason**\n<script>inert</script>', redacted}]}]});
  view.set([retained('partial')]); flush(); const thinking = node('primary-transcript').querySelector('.thinking'); assert.ok(thinking);
  assert.equal(thinking.querySelector('strong'), null);
  view.set([retained('final')]); flush(); assert.equal(thinking.querySelector('strong')?.textContent, 'reason'); assert.equal(thinking.querySelector('script'), null);
  view.set([retained('final', true)]); flush(); assert.equal(thinking.querySelector('strong'), null); assert.equal(thinking.querySelector('.thinking-content')?.textContent, 'Thinking omitted by host');
});
test('response stop states remain visible without a supplied error message', () => {
  setup(); const view = transcript();
  view.set(['error', 'aborted'].map(stopReason => ({id: stopReason, kind: 'message', messages: [{...message(stopReason, ''), parts: [], stopReason}]}))); flush();
  const errors = node('primary-transcript').querySelectorAll('.message-error');
  assert.deepEqual(errors.map(error => [error.hidden, error.textContent]), [[false, 'Response stopped with an error.'], [false, 'Response aborted.']]);
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

test('turns have no header or visible role label and preserve body and action hooks', () => {
  setup(); const view = new Transcript('primary', {presentation: () => {}, reading: () => {}, fork: () => {}});
  view.set([{id: 'user', kind: 'message', messages: [{...message('u', 'Hello'), role: 'user'}]}, entry('assistant', 'Reply')]); flush();
  const container = node('primary-transcript'); const user = container.querySelector('.user'); assert.ok(user);
  assert.equal(user.children[0], user.querySelector('.message-body')); assert.equal(user.attributes['aria-label'], 'User message');
  assert.equal(user.children.at(-1), user.querySelector('.message-actions')); assert.match(user.textContent, /fork/);
  assert.equal(container.querySelector('header'), null); assert.equal(container.querySelector('.message-header'), null);
  assert.doesNotMatch(container.textContent, /You|Assistant/);
});
test('scroll settlement retains deliberate rest and does not schedule text probes', () => {
  setup(); const geometry = geometryEnvironment();
  try {
    const readings = []; const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)});
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
test('settled root resize retains its saved anchor and only processes actual dirty geometry', () => {
  setup(); const geometry = geometryEnvironment();
  try {
    const readings = []; const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)});
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
    const container = node('primary-transcript'); const control = container.querySelector('.copy'); assert.ok(control);
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
test('compact tool and thinking messages omit empty parts without losing message, event or tool controls', () => {
  setup(); const view = transcript(); const source = contentEntry('compact', {}, 'retained output');
  const sourceMessage = source.messages[0]; assert.ok(sourceMessage);
  (sourceMessage.parts as PartView[]).unshift({type: 'text', text: ' \n '});
  const thinking = {id: 'thought-compact', kind: 'message', messages: [{...message('thought-compact', ''), parts: [{type: 'text' as const, text: ''}, {type: 'thinking' as const, text: 'Retained thought'}]}]};
  view.set([source, sessionEntry('notice', 'Check this warning', 'warning'), thinking]); flush();
  const root = node('primary-transcript'); const compact = root.querySelector('.tool-only'); assert.ok(compact);
  const body = compact.querySelector('.message-body'); assert.ok(body); assert.equal(body.children.length, 1);
  assert.ok(body.children[0]?.classList.contains('tool-shell'));
  assert.equal(compact.querySelector('.message-actions')?.hidden, false);
  assert.equal(compact.querySelector('.message-actions')?.querySelector('.copy')?.textContent, 'copy all');
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
  assert.equal(compact.querySelector('.message-actions')?.querySelector('.copy')?.textContent, 'copy'); assert.match(root.textContent, /Visible prose/);
});

test('single visible session events use a singular caption', () => {
  setup(); const view = transcript(); view.set([sessionEntry('single', 'retained event')]); flush();
  const group = node('primary-transcript').querySelector('.session-events'); assert.ok(group);
  assert.equal(group.querySelector('summary')?.textContent, '1 session event');
});
test('session find mounts the matching member page and saved member anchors map to its representative', () => {
  setup(); const readings = []; const view = new Transcript('primary', {presentation: () => {}, reading: value => readings.push(value)});
  const entries = Array.from({length: 75}, (_, i) => sessionEntry(`s${i}`, `event ${i}`));
  view.configure(undefined, {revision: 4, anchorId: 's39', offsetPx: 0, followTail: false}); view.set(entries); flush();
  view.find('event 39'); const root = node('primary-transcript'); const group = root.querySelector('.session-events'); assert.ok(group);
  assert.equal(group.open, true); assert.match(group.textContent, /event 39/); assert.doesNotMatch(group.textContent, /event 0custom/);
  assert.equal(group.querySelectorAll('.custom-entry').length, 32);
  assert.equal(root.children[0]?.dataset.entryId, 's0'); assert.equal(fakeDocument.activeElement, root.children[0]);
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
  assert.equal(card.querySelector('.preview-omission')?.textContent, 'Structured preview incomplete. Inspect raw output or Copy for retained content.');
  assert.equal(card.querySelectorAll('.preview-omission').length, 1); assert.ok(card.querySelector('.tool-result-part')?.querySelector('.output-pages'));
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
  assert.equal(parts.children.length, 5); assert.equal(parts.children[0]?.textContent, 'First protected part');
  assert.equal(parts.children[1]?.querySelector('h1')?.textContent, 'Second'); assert.equal(parts.querySelectorAll('.image-part').length, 1);
  assert.match(parts.children[3]?.textContent ?? '', /Fourth part omitted/); assert.equal(parts.children[4]?.textContent, 'Last protected part');
  assert.equal(card.querySelector('.tool-images'), null);
});
test('absent structured projection leaves JSON prefixes plain and raw inspection excludes sidecars', () => {
  setup(); const prefix = '{"body":"incomplete'; const view = transcript(); view.set([contentEntry('plain-prefix', {}, prefix)]); flush();
  let card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('.tool-document'), null); assert.equal(card.querySelector('.tool-output-text')?.textContent, prefix);
  const raw = '{"result":"{\\"body\\":\\"# Original\\nProtected source\\"}"}';
  view.set([contentEntry('raw-only', {}, raw, false, {value: {result: {body: '# Original\nProtected source'}}, truncated: false})]); flush();
  card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const inspection = card.querySelectorAll('details').find(detail => detail.querySelector('summary')?.textContent === 'raw result'); assert.ok(inspection);
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
  const expanded = card.querySelector('.tool-expanded'); assert.ok(expanded); assert.equal(expanded.children[0]?.querySelector('.tool-source'), source);
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
  const detail = card.querySelectorAll('details').find(item => item.firstChild?.textContent === 'raw result'); assert.ok(detail);
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
    let menu = body.querySelector('.context-menu'); assert.ok(menu); assert.deepEqual(menu.children.map(row => row.textContent), ['Copy selection', 'Copy content']);
    assert.equal(fakeDocument.activeElement, menu.children[0]); assert.equal(article.tabIndex, -1);
    selection = null; menu.children[0]?.dispatch('click'); await Promise.resolve(); assert.deepEqual(copied, ['retained']); assert.equal(fakeDocument.activeElement, article);
    root.dispatch('contextmenu', {target: paragraph, clientX: 20, clientY: 20, preventDefault() {}, stopPropagation() {}});
    menu = body.querySelector('.context-menu'); assert.ok(menu); assert.deepEqual(menu.children.map(row => row.textContent), ['Copy content']);
    view.reset(); view.set([entry('changed', 'New paragraph')]); flush(); menu.children[0]?.dispatch('click'); await Promise.resolve(); assert.deepEqual(copied, ['retained']);
    assert.match(node('announcements').textContent, /target changed/);
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
  result.parts = [{type: 'text', text: 'first plain'}, ...rich, {type: 'image', mimeType: 'image/png', digest: 'b'.repeat(64), alt: 'image retained'},
    {type: 'omitted', label: 'omission retained'}, {type: 'text', text: 'last plain'}];
  view.set([source]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const parts = card.querySelector('.tool-result-parts'); assert.ok(parts); assert.equal(parts.querySelectorAll('.tool-result-part').length, 104);
  assert.equal(parts.querySelectorAll('.output-pages').length, 100); assert.equal(parts.querySelectorAll('.image-part').length, 1);
  assert.equal(card.querySelector('.preview-omission')?.textContent, 'Preview shortened. Inspect raw output or Copy for retained content.');
  assert.equal(card.querySelectorAll('.preview-omission').length, 1); assert.doesNotMatch(parts.textContent, /Content preview limited\.|protected raw \d/);
  const sections = parts.querySelectorAll('.tool-result-part');
  assert.equal(sections[0]?.textContent, 'first plain'); assert.ok(sections[101]?.querySelector('.image-part'));
  assert.equal(sections[102]?.textContent, 'omission retained'); assert.equal(sections[103]?.textContent, 'last plain');
  const previews = parts.querySelectorAll('.tool-content'); const argument = card.querySelector('.tool-content'); assert.ok(argument);
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
  assert.equal(emptyParts.children.at(-1), note); assert.equal(note.textContent, 'Preview shortened. Inspect raw output or Copy for retained content.');
  assert.match(emptyParts.textContent, /Useful retained text/); assert.equal(emptyParts.querySelectorAll('.tool-result-part')[2]?.textContent, 'Retained host omission');
});
test('changed result budgets adopt retained argument DOM and charge deferred metadata to the new budget', () => {
  setup(); const view = transcript(); const args = {program: `source\n${'line '.repeat(300)}`, usage: {note: 'metadata '.repeat(900)}};
  const source = (text: string) => contentEntry('adopt', args, JSON.stringify({body: text}), false, {value: {body: text}, truncated: false});
  view.set([source(`# First\n${'result '.repeat(700)}`)]); flush(); const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card);
  card.open = true; card.dispatch('toggle'); flush(); const argumentsRoot = card.querySelector('.tool-content'); assert.ok(argumentsRoot);
  const disclosure = argumentsRoot.querySelector('.tool-source'); const metadata = argumentsRoot.querySelector('.tool-metadata'); assert.ok(disclosure); assert.ok(metadata);
  assert.equal(metadata.childNodes.length, 1); assert.doesNotMatch(argumentsRoot.textContent, /metadata metadata/);
  disclosure.open = false; const oldBudget = Reflect.get(view, 'tools').get('adopt').previewBudget;
  view.set([source(`# Second\n${'fresh '.repeat(1300)}`)]); flush();
  const budget = Reflect.get(view, 'tools').get('adopt').previewBudget; assert.notEqual(budget, oldBudget);
  assert.equal(card.querySelector('.tool-content'), argumentsRoot); assert.equal(disclosure.open, false);
  const oldText = oldBudget.text; const newText = budget.text; metadata.open = true; metadata.dispatch('toggle');
  assert.ok(budget.text < newText); assert.equal(oldBudget.text, oldText);
  const shown = card.querySelectorAll('.tool-content').reduce((total, preview) => total + preview.textContent.length, 0); assert.ok(shown <= 16384);
  assert.equal(card.querySelector('.preview-omission')?.textContent, 'Preview shortened. Inspect raw output or Copy for retained content.');
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

test('mixed thinking and tool turns compact both part orders without loss of action controls', () => {
  for (const firstThinking of [true, false]) {
    setup(); const view = transcript(); const source = contentEntry('utility', {program: 'source'}, 'retained output');
    const msg = source.messages[0]; assert.ok(msg); msg.timestamp = Date.now();
    const thought: PartView = {type: 'thinking', text: 'Retained thought'};
    if (firstThinking) msg.parts.unshift(thought); else msg.parts.push(thought);
    view.set([source, sessionEntry('event', 'routine')]); flush();
    const root = node('primary-transcript'); const turn = root.querySelector('.tool-only'); assert.ok(turn);
    assert.equal(turn.querySelector('.message-body')?.children.length, 2);
    assert.ok(turn.querySelector('.thinking')); assert.ok(turn.querySelector('.tool-card'));
    assert.equal(turn.querySelector('.message-actions')?.hidden, false);
    assert.equal(turn.querySelector('.message-actions')?.querySelector('.copy')?.textContent, 'copy all');
    assert.ok(turn.querySelector('.timestamp')); assert.ok(turn.querySelector('.tool-copy'));
    assert.equal(root.querySelector('.session-events')?.querySelector('summary')?.textContent, '1 session event');
    view.set([{...source, messages: [{...msg, parts: [...msg.parts, {type: 'text', text: 'Visible prose'}]}]}]); flush();
    assert.equal(root.querySelector('.tool-only'), null); assert.match(root.textContent, /Visible prose/);
  }
});
test('expanded source disclosures avoid the raw inspection scroll cap', () => {
  setup(); const view = transcript(); view.set([contentEntry('source-cap', {program: 'long source\n'.repeat(200)}, 'output')]); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const source = card.querySelector('.tool-source'); assert.ok(source);
  assert.equal(source.classList.contains('tool-inspection'), false);
  const inspections = card.querySelectorAll('.tool-inspection'); assert.equal(inspections.length, 2);
  assert.deepEqual(inspections.map(detail => detail.querySelector('summary')?.textContent), ['arguments', 'raw result']);
  assert.equal(card.querySelector('.tool-name')?.textContent, 'custom'); assert.equal(card.querySelector('.tool-status')?.textContent, '✓');
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
    assert.equal(characterCut.textContent, `${prefix}${'x'.repeat(4095)}…`); assert.equal(characterCut.title, characterCut.textContent);
    const lineCut = targetFor(name, key, 'first line\nsecond line'); assert.equal(lineCut.textContent, `${prefix}first line…`);
    const complete = targetFor(name, key, 'Complete unknown TypeScr'); assert.equal(complete.textContent, `${prefix}Complete unknown TypeScr`);
  }
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
