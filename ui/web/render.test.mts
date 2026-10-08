import assert from 'node:assert/strict';
import test from 'node:test';
import { Transcript, structured } from './render.ts';
import { Roster } from './roster.ts';
import { markdownDom } from './safe-markdown.ts';

type Handler = (event: Record<string, unknown>) => void;
class FakeNode {
  tagName: string;
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = '';
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
  assert.match(custom.textContent, /false/); assert.match(custom.textContent, /null/); assert.match(custom.textContent, /7 bytes/);
  const detail = custom.querySelector('details'); assert.ok(detail); assert.equal(detail.querySelector('pre'), null);
  detail.open = true; detail.dispatch('toggle'); assert.ok((detail.querySelector('pre')?.textContent.length ?? Infinity) < 66000);
  view.set([{id: 'custom', kind: 'custom_kind', data: {value: {identity: 'new'}, truncated: false}}, {id: 'unknown', kind: 'unrecognized'}]); flush();
  assert.equal(node('primary-transcript').children[0], custom); assert.match(custom.textContent, /new/); assert.match(node('primary-transcript').textContent, /unrecognized/);
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
test('roster preserves order, full duplicate identities, keyed rows and data-arrival ages', () => {
  setup(); const now = Date.now; let clock = 600000; Date.now = () => clock;
  try {
    const selected: string[] = []; const view = new Roster(row => selected.push(row.identity), () => {}); const one = row('one', 'same'); const two = row('two', 'same');
    view.set([one, two]); flush(); const first = node('roster').children[0]; assert.ok(first); const age = first.querySelector('time'); assert.equal(age?.textContent, '10m ago'); assert.match(first.textContent, /one/);
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
  assert.match(node('roster').textContent, /Roster discovery failed: Record unreadable/); const retry = node('roster-footer').querySelector('button'); assert.equal(retry?.textContent, 'Retry'); retry?.dispatch('click');
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
  view.expandLoaded(true, true); flush(); assert.equal(container.querySelectorAll('.tool-card').length, 170);
  assert.equal(container.querySelectorAll('.tool-card').every(card => card.open), true);
});
test('Markdown creates inert HTML text, safe links, code, lists and aligned semantic tables', () => {
  setup(); const fragment = markdownDom('<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [good](https://example.test) ![image](https://example.test/a)\n\n3. item\n\n```ts\n<script>\n```\n\n| A | B |\n| :--- | ---: |\n| a | b |');
  assert.equal(fragment.querySelector('script'), null); assert.equal(fragment.querySelector('img'), null); assert.match(fragment.textContent, /<script>/);
  const links = fragment.querySelectorAll('a'); assert.equal(links.length, 1); assert.equal(links[0]?.rel, 'noopener noreferrer'); assert.equal(links[0]?.target, '_blank');
  assert.equal(fragment.querySelector('ol')?.attributes.start, '3'); assert.equal(fragment.querySelector('th')?.scope, 'col');
  assert.equal(fragment.querySelectorAll('th')[1]?.style.textAlign, 'right'); assert.equal(fragment.querySelector('code')?.dataset.language, 'ts');
});

test('known session changes use quiet system notes with retained data under disclosure', () => {
  setup(); const view = transcript();
  view.set([{id: 'model', kind: 'model_change', data: {value: {provider: 'fixture', modelId: 'test'}, truncated: false}}, {id: 'thinking', kind: 'thinking_level_change', data: {value: {thinkingLevel: 'high'}, truncated: false}}, {id: 'unknown', kind: 'future_change', data: {value: {fact: 'known'}, truncated: false}}]); flush();
  const notes = node('primary-transcript').querySelectorAll('.system-note'); assert.equal(notes.length, 2);
  assert.match(notes[0]?.textContent ?? '', /Model changed to fixture\/test/); assert.match(notes[1]?.textContent ?? '', /Thinking changed to high/);
  assert.equal(notes[0]?.querySelector('dl'), null); const disclosure = notes[0]?.querySelector('details'); assert.ok(disclosure); disclosure.open = true; disclosure.dispatch('toggle'); assert.match(disclosure.querySelector('pre')?.textContent ?? '', /provider/);
  assert.equal(node('primary-transcript').querySelectorAll('.custom-entry').length, 1);
});
