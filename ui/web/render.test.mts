import assert from 'node:assert/strict';
import test from 'node:test';
import { Transcript, structured } from './render.ts';
import { Roster } from './roster.ts';
import { markdownDom } from './safe-markdown.ts';
import { outputPages } from './transcript-output.ts';
import type { OutputPage } from '../shared/api.ts';

type Handler = (event: Record<string, unknown>) => void;
class FakeNode {
  tagName: string;
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = '';
  classList = {add: (name: string) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' '); }};
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
    if (this.className === 'agent-row') return 110;
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
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  dispatch(name: string, event: Record<string, unknown> = {}): void { for (const handler of this.handlers.get(name) ?? []) handler(event); }
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
  focus(): void { fakeDocument.activeElement = this; }
}
function matches(node: FakeNode, selector: string): boolean {
  if (selector.startsWith('.')) return node.className.split(' ').includes(selector.slice(1));
  if (selector === 'details[open]') return node.tagName === 'details' && node.open;
  if (selector === '[data-disclosure]') return !!node.dataset.disclosure;
  return node.tagName === selector;
}
let roots: FakeNode[] = [];
let frames: FrameRequestCallback[] = [];
let selection: {isCollapsed: boolean; anchorNode: FakeNode | null; focusNode: FakeNode | null} | null = null;
const ids = new Map<string, FakeNode>();
const fakeDocument = {
  activeElement: null as FakeNode | null,
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeNode(tag),
  createDocumentFragment: () => new FakeNode('#fragment'),
  createTextNode: (value: string) => { const node = new FakeNode('#text'); node.textContent = value; return node; },
  getElementById: (id: string) => ids.get(id),
  getSelection: () => selection,
  addEventListener: () => {},
};
function setup(): void {
  roots = []; frames = []; ids.clear(); selection = null; fakeDocument.activeElement = null;
  for (const id of ['primary-transcript', 'primary-latest', 'agent-transcript', 'agent-latest', 'roster', 'agent-search', 'roster-footer', 'announcements', 'primary-editor']) {
    const node = new FakeNode('div'); ids.set(id, node); roots.push(node);
  }
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
test('callId joins call and results across entries with one bounded disclosure and raw output', () => {
  setup(); const view = transcript();
  const call = {type: 'toolCall' as const, callId: 'call-1', name: 'read', arguments: {value: {path: '/full/path', offset: 1, limit: 10}, truncated: false}};
  const result = {type: 'toolResult' as const, callId: 'call-1', name: 'read', isError: false, parts: [{type: 'text' as const, text: 'x'.repeat(5000)}]};
  const entries = [{id: 'call', kind: 'message', messages: [{...message('m-call', ''), parts: [call]}]}, {id: 'result', kind: 'message', messages: [{...message('m-result', ''), parts: [result]}]}];
  view.set(entries); flush(); const cards = node('primary-transcript').querySelectorAll('.tool-card'); assert.equal(cards.length, 1);
  const card = cards[0]; assert.ok(card); assert.match(card.textContent, /read · \/full\/path/); assert.match(card.textContent, /offset 1 · limit 10/);
  assert.match(card.textContent, /Tool returned successfully/); assert.ok((card.querySelector('.tool-preview')?.textContent.length ?? Infinity) < 2000);
  assert.equal(card.querySelector('.tool-preview')?.parentNode, card.querySelector('summary'));
  assert.equal(card.querySelectorAll('details').length, 0); card.open = true; card.dispatch('toggle'); flush();
  assert.equal(card.querySelector('pre')?.textContent, 'x'.repeat(5000));
  const raw = card.querySelectorAll('details').find(node => node.querySelector('summary')?.textContent === 'Raw result');
  assert.ok(raw); raw.open = true; raw.dispatch('toggle'); assert.match(raw.querySelector('pre')?.textContent ?? '', /"type": "text"/);
  assert.equal(card.querySelectorAll('.tool-chevron').length, 1); assert.equal(card.parentNode?.querySelectorAll('.tool-copy').length, 1);
  view.set(entries, new Map([['call-1', {callId: 'call-1', name: 'read', phase: 'end' as const, parts: [{type: 'text' as const, text: 'failure cause'}], isError: true}]])); flush();
  assert.equal(node('primary-transcript').querySelector('.tool-card'), card); assert.match(card.textContent, /failure cause/);
  assert.equal(card.querySelector('.tool-status')?.attributes['aria-label'], 'error');
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
  assert.equal(container.querySelectorAll('.message-header').length, 1); assert.equal(container.children.length, 1);
  assert.doesNotMatch(container.textContent, /toolResult/); view.find('needle result'); assert.equal(fakeDocument.activeElement, container.children[0]);
  const unmatched = {id: 'unmatched', kind: 'message', messages: [{...resultMessage, id: 'unmatched-message', parts: [{...result, callId: 'unmatched'}]}]};
  const mixed = {id: 'mixed', kind: 'message', messages: [{...resultMessage, id: 'mixed-message', parts: [result, {type: 'text' as const, text: 'Preserved prose'}]}]};
  const error = {id: 'error', kind: 'message', messages: [{...resultMessage, id: 'error-message', error: 'Preserved cause'}]};
  view.set([call, joined, unmatched, mixed, error]); flush(); assert.equal(container.querySelectorAll('.message-header').length, 4);
  assert.equal(container.querySelectorAll('.tool-card').length, 2); assert.match(container.textContent, /Preserved prose/); assert.match(container.textContent, /Preserved cause/);
  assert.equal(container.querySelector('.tool-card'), card);
  view.set([joined]); flush(); assert.equal(container.querySelectorAll('.message-header').length, 1);
  assert.equal(container.querySelector('.tool-card'), card); assert.match(container.textContent, /toolResult/);
});
test('generic entries update, unknown entries remain inspectable, and expansion stays bounded', () => {
  setup(); const view = transcript(); const data = {value: {identity: 'full-identity', enabled: false, absent: null, nested: {huge: 'x'.repeat(100000)}}, truncated: true, omittedBytes: 7};
  view.set([{id: 'custom', kind: 'custom_kind', data}]); flush(); const custom = node('primary-transcript').children[0]; assert.ok(custom);
  assert.match(custom.textContent, /Custom kind/); assert.match(custom.textContent, /7 bytes/);
  assert.equal(custom.querySelectorAll('details').length, 1);
  const detail = custom.querySelector('details'); assert.ok(detail); assert.equal(detail.querySelector('pre'), null);
  detail.open = true; detail.dispatch('toggle'); assert.ok((detail.querySelector('pre')?.textContent.length ?? Infinity) < 66000);
  assert.match(detail.textContent, /false/); assert.match(detail.textContent, /null/);
  view.set([{id: 'custom', kind: 'custom_kind', data: {value: {identity: 'new'}, truncated: false}}, {id: 'unknown', kind: 'unrecognized'}]); flush();
  assert.equal(node('primary-transcript').children[0], custom);
  const updated = custom.querySelector('details'); assert.ok(updated); updated.open = true; updated.dispatch('toggle');
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
    view.set([one, two]); flush(); const first = node('roster').children[0]; assert.ok(first); const age = first.querySelector('time'); assert.equal(age?.textContent, '10m ago'); assert.match(first.querySelector('.row-select')?.attributes['aria-label'] ?? '', /one/);
    assert.equal(first.querySelector('.row-identity')?.textContent, 'one');
    assert.equal(node('roster').children[1]?.querySelector('.row-identity')?.textContent, 'two');
    clock = 900000; view.set([two, one], undefined, 'two'); flush(); assert.equal(node('roster').children[0], first); assert.equal(age?.textContent, '10m ago');
    first.querySelector('.row-select')?.dispatch('click'); assert.deepEqual(selected, ['one']);
    view.set([{...one, latestReply: 'new'}, two]); flush(); assert.equal(node('roster').children[0], first); assert.equal(age?.textContent, '15m ago');
    first.querySelector('.row-age')?.dispatch('click'); assert.doesNotMatch(age?.textContent ?? '', /ago/);
  } finally { Date.now = now; }
});
test('roster empty states distinguish discovery, loading, failure and successful emptiness', () => {
  setup(); const actions: Array<string | undefined> = []; const view = new Roster(() => {}, action => actions.push(action));
  const scan = {state: 'not-started' as const, complete: false, visited: 0, skipped: 0, omitted: 0};
  view.set([], {scan, stale: false}); flush(); assert.equal(node('roster').textContent, 'Roster not loaded');
  const empty = node('roster').children[0]; const refresh = node('roster-footer').querySelector('button'); assert.equal(refresh?.textContent, 'Refresh'); refresh?.dispatch('click');
  assert.doesNotMatch(node('roster-footer').textContent, /0 shown|More/);
  view.set([], {scan: {...scan, state: 'running'}, stale: false}); flush(); assert.equal(node('roster').children[0], empty);
  assert.equal(node('roster').textContent, 'Loading roster'); assert.equal(node('roster-footer').querySelector('button'), null);
  view.set([], {scan: {...scan, state: 'failed'}, stale: false, error: {code: 'catalog', message: 'Record unreadable', retry: 'read'}}); flush();
  assert.match(node('roster').textContent, /Roster discovery failed: Record unreadable/); const retry = node('roster').querySelector('button'); assert.equal(retry?.textContent, 'Retry'); retry?.dispatch('click');
  view.set([], {scan: {...scan, state: 'ready', complete: true}, stale: false}); flush();
  assert.equal(node('roster').textContent, 'No agents in this view'); assert.equal(node('roster-footer').querySelector('button'), null);
  assert.deepEqual(actions, ['refresh', 'refresh']);
});
test('roster More uses cached page cursors independently from scan completeness', () => {
  setup(); const actions: Array<string | undefined> = []; const view = new Roster(() => {}, action => actions.push(action));
  const scan = {state: 'ready' as const, complete: true, visited: 2, skipped: 0, omitted: 0};
  view.set([row('one')], {scan, stale: false, nextCursor: 'page-2'}); flush();
  const more = node('roster-footer').querySelector('button'); assert.equal(more?.textContent, '1 shown · More'); more?.dispatch('click');
  view.set([], {scan: {...scan, complete: false, scanId: 'scan-2'}, stale: false, nextCursor: null}); flush();
  const continuation = node('roster-footer').querySelector('button'); assert.equal(continuation?.textContent, 'Continue roster scan'); continuation?.dispatch('click');
  view.set([], {scan: {...scan, complete: false}, stale: false}); flush(); assert.equal(node('roster-footer').querySelector('button'), null);
  view.set([row('one')], {scan: {...scan, state: 'failed'}, stale: true, nextCursor: 'page-2'}); flush();
  const buttons = node('roster-footer').querySelectorAll('button'); assert.deepEqual(buttons.map(button => button.textContent), ['1 shown · More', 'Retry']);
  buttons[0]?.dispatch('click'); buttons[1]?.dispatch('click'); assert.deepEqual(actions, ['more', 'more', 'more', 'refresh']);
});
test('roster virtual rows retain selected/focused pins, internal gaps and measured heights', () => {
  setup(); const view = new Roster(() => {}, () => {}); const rows = Array.from({length: 220}, (_, i) => row(`full-identity-${i}`));
  view.set(rows, undefined, 'full-identity-200'); flush(); const container = node('roster'); const pinned = container.children.find(child => child.dataset.identity === 'full-identity-200'); assert.ok(pinned);
  pinned.measured = 250; pinned.focus(); view.set(rows, undefined, 'full-identity-0'); flush();
  assert.equal(pinned.isConnected, true); assert.equal(fakeDocument.activeElement, pinned); assert.equal(pinned.offsetHeight, 250);
  assert.equal(pinned.offsetTop, 200 * 110); assert.ok(container.children.filter(child => child.className === 'spacer').length >= 2);
  assert.ok(container.children.filter(child => child.className === 'agent-row').length < 40);
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
  const buttons = node('primary-transcript').querySelectorAll('button').filter(button => button.textContent === 'Fork');
  assert.equal(buttons.length, 1); buttons[0]?.dispatch('click'); assert.deepEqual(forks, ['retained']);
  view.set([{...entries[0], messages: [{...user, state: 'partial'}]}]); flush();
  assert.equal(node('primary-transcript').querySelectorAll('button').filter(button => button.textContent === 'Fork').length, 0);
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
  assert.equal(fragment.querySelector('ol')?.attributes.start, '3'); assert.equal(fragment.querySelector('th')?.scope, 'col');
  assert.equal(fragment.querySelectorAll('th')[1]?.style.textAlign, 'right'); assert.equal(fragment.querySelector('code')?.dataset.language, 'ts');
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
  const next = content.querySelectorAll('button').find(item => item.textContent === 'Load more output'); assert.ok(next);
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve(); assert.match(content.textContent, /source unavailable/);
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve(); assert.equal(content.querySelector('.output-page')?.textContent, 'page 8192');
  next.dispatch('click'); await Promise.resolve(); await Promise.resolve(); assert.equal(content.querySelector('.output-page')?.textContent, 'page 16384');
  assert.deepEqual(offsets, [8192, 8192, 16384]); assert.doesNotMatch(content.querySelector('.output-page')?.textContent ?? '', /page 8192/);
  const previous = content.querySelectorAll('button').find(item => item.textContent === 'Previous output'); previous?.dispatch('click');
  await Promise.resolve(); await Promise.resolve(); assert.equal(content.querySelector('.output-page')?.textContent, 'page 8192');
});
test('tool result paging uses the result source and reset discards a late page', async () => {
  setup(); let resolve: (page: OutputPage) => void = () => {}; const requests: unknown[] = [];
  const view = new Transcript('primary', {presentation: () => {}, reading: () => {}, output: more => { requests.push(more); return new Promise(done => { resolve = done; }); }});
  view.set([{id: 'call-owner', kind: 'message', messages: [{...message('call-message', ''), parts: [{type: 'toolCall', callId: 'x', name: 'read', arguments: {value: {}, truncated: false}}]}]},
    {id: 'result-source', kind: 'message', messages: [{...message('result-message', ''), parts: [{type: 'toolResult', callId: 'x', name: 'read', parts: [{type: 'text', text: 'initial', more: {entryId: 'result-source', part: 3, offset: 8192}}], isError: false}]}]}]); flush();
  const card = node('primary-transcript').querySelector('.tool-card'); assert.ok(card); card.open = true; card.dispatch('toggle'); flush();
  const next = card.querySelectorAll('button').find(item => item.textContent === 'Load more output'); assert.ok(next); next.dispatch('click');
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
  assert.equal(container.querySelectorAll('.message-header').length, 1);
  assert.match(container.textContent, /Message content is not fully displayed/);
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
  assert.equal(continuation.querySelectorAll('button').some(button => button.textContent === 'Load more output'), true);
});
test('coverage reasons use bounded inert text and remove terminal control instructions', () => {
  setup(); const view = transcript();
  const reason = `\x1b[31m<script>alert(1)</script>\x1b[0m\x00\x1b]0;hidden title\x07${'x'.repeat(5000)}`;
  const withReason = (id: string, reason: string) => ({id, kind: 'message', messages: [{...message(id, ''), parts: [], coverage: {...coverage, complete: false, reason}}]});
  view.set([withReason('malicious', reason), withReason('lines', 'one\ntwo\nthree\nfour\nfive\nsix\nseven')]); flush();
  const container = node('primary-transcript'); const labels = container.querySelectorAll('.message-body').map(body => body.querySelector('p')?.textContent ?? '');
  assert.equal(labels[0]?.length, 4096); assert.ok(labels[0]?.startsWith('<script>alert(1)</script>'));
  assert.doesNotMatch(labels[0] ?? '', /[\x00-\x1f\x7f-\x9f]|hidden title/);
  assert.equal(container.querySelector('script'), null); assert.equal(labels[1], 'one\ntwo\nthree\nfour\nfive\nsix');
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
  assert.match(cards[1]?.querySelector('.tool-content')?.textContent ?? '', /Written content.*written supplied/s);
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
  assert.equal(disclosure.querySelector('pre')?.textContent, content); assert.match(region?.textContent ?? '', /Written content/);
});
test('known session changes use quiet system notes with retained data under disclosure', () => {
  setup(); const view = transcript();
  view.set([{id: 'model', kind: 'model_change', data: {value: {provider: 'fixture', modelId: 'test'}, truncated: false}}, {id: 'thinking', kind: 'thinking_level_change', data: {value: {thinkingLevel: 'high'}, truncated: false}}, {id: 'unknown', kind: 'future_change', data: {value: {fact: 'known'}, truncated: false}}]); flush();
  const notes = node('primary-transcript').querySelectorAll('.system-note'); assert.equal(notes.length, 2);
  assert.match(notes[0]?.textContent ?? '', /Model changed to fixture\/test/); assert.match(notes[1]?.textContent ?? '', /Thinking changed to high/);
  assert.equal(notes[0]?.querySelector('dl'), null); const disclosure = notes[0]?.querySelector('details'); assert.ok(disclosure); disclosure.open = true; disclosure.dispatch('toggle'); assert.match(disclosure.querySelector('pre')?.textContent ?? '', /provider/);
  assert.equal(node('primary-transcript').querySelectorAll('.custom-entry').length, 1);
});
