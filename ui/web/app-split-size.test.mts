import {activeTab, toggleSplit} from './tabs.ts';
import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import type { ConversationLayout, AgentRow, EntryView, PrimaryView, ProjectedFrame, Snapshot, TargetState, Workspace } from '../shared/api.ts';


// In-process browser host: the app module runs against a fake document, storage, event stream, and HTTP backend.
type Handler = (event: Record<string, unknown>) => void;
class HostNode {
  tagName: string;
  id = '';
  className = '';
  hidden = false;
  disabled = false;
  value = '';
  title = '';
  tabIndex = 0;
  scrollTop = 0;
  open = false;
  text = '';
  writes = 0;
  moves = 0;
  dataset: Record<string, string> = {};
  children: HostNode[] = [];
  parentNode: HostNode | null = null;
  attributes = new Map<string, string>();
  properties = new Map<string, string>();
  classes = new Set<string>();
  private handlers = new Map<string, Handler[]>();
  style = {setProperty: (key: string, value: string) => { this.properties.set(key, value); },
    removeProperty: (key: string) => { const value = this.properties.get(key) ?? ''; this.properties.delete(key); return value; },
    getPropertyValue: (key: string) => this.properties.get(key) ?? ''};
  classList = {add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, value: boolean) => { if (value) this.classes.add(name); else this.classes.delete(name); }};
  constructor(tag: string) { this.tagName = tag; }
  get classText(): string { return [...this.classes].join(' '); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.writes++; this.replaceChildren(); this.text = value; }
  set innerHTML(_value: string) { throw new Error('HTML must never be assigned'); }
  get ownerDocument() { return hostDocument; }
  get nodeType(): number { return this.tagName === '#text' ? 3 : this.tagName === '#fragment' ? 11 : 1; }
  get parentElement(): HostNode | null { return this.parentNode; }
  get clientHeight(): number { return 300; }
  get clientWidth(): number { return 600; }
  get offsetWidth(): number { return this.clientWidth; }
  get offsetHeight(): number { return this.hidden ? 0 : this.className === 'entry' ? 140 : 20; }
  get offsetTop(): number { const peers = this.parentNode?.children ?? []; return (this.parentNode?.offsetTop ?? 0) + peers.slice(0, peers.indexOf(this)).reduce((sum, node) => sum + node.offsetHeight, 0); }
  get scrollHeight(): number { return this.children.reduce((sum, child) => sum + child.offsetHeight, 0); }
  get firstChild(): HostNode | null { return this.children[0] ?? null; }
  get lastElementChild(): HostNode | null { return this.children.at(-1) ?? null; }
  get isConnected(): boolean { return hostRoots.includes(this) || !!this.parentNode?.isConnected; }
  contains(node: HostNode | null): boolean { return !!node && (node === this || this.children.some(child => child.contains(node))); }
  get childNodes(): HostNode[] { return this.children; }
  get scrollWidth(): number { return this.clientWidth; }
  get nextSibling(): HostNode | null { const peers = this.parentNode?.children ?? []; return peers[peers.indexOf(this) + 1] ?? null; }
  get nextElementSibling(): HostNode | null { return this.nextSibling; }
  append(...nodes: HostNode[]): void { for (const node of nodes) this.insert(node, this.children.length); }
  prepend(...nodes: HostNode[]): void { nodes.slice().reverse().forEach(node => { this.insert(node, 0); }); }
  after(node: HostNode): void { this.parentNode?.insert(node, this.parentNode.children.indexOf(this) + 1); }
  insertBefore(node: HostNode, anchor: HostNode | null): HostNode { this.insert(node, anchor ? this.children.indexOf(anchor) : this.children.length); return node; }
  private insert(node: HostNode, index: number): void {
    if (node.tagName === '#fragment') { for (const child of [...node.children]) this.insert(child, index++); return; }
    if (node.parentNode === this && this.children.indexOf(node) < index) index--;
    node.remove(); node.parentNode = this; this.children.splice(index, 0, node); node.moves++;
  }
  remove(): void { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  replaceChildren(...nodes: HostNode[]): void { this.writes++; for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...nodes); }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  hasAttribute(key: string): boolean { return this.attributes.has(key); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  removals = new Map<string, number>();
  removeEventListener(name: string, handler?: Handler): void { this.removals.set(name, (this.removals.get(name) ?? 0) + 1); if (!handler) { this.handlers.delete(name); return; } const next = (this.handlers.get(name) ?? []).filter(item => item !== handler); if (next.length) this.handlers.set(name, next); else this.handlers.delete(name); }
  dispatch(name: string, event: Record<string, unknown> = {}): void { for (const handler of this.handlers.get(name) ?? []) handler({target: this, ...event}); }
  closest(selector: string): HostNode | null { return matchesHost(this, selector) ? this : this.parentNode?.closest(selector) ?? null; }
  querySelector(selector: string): HostNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): HostNode[] {
    const found: HostNode[] = [];
    for (const node of this.children) { if (matchesHost(node, selector)) found.push(node); found.push(...node.querySelectorAll(selector)); }
    return found;
  }
  getBoundingClientRect(): {top: number; bottom: number; left: number; right: number; width: number; height: number} {
    const width = rectWidth(this); const top = this.offsetTop;
    return {top, bottom: top + this.offsetHeight, left: 0, right: width, width, height: this.offsetHeight};
  }
  focus(): void { hostDocument.activeElement = this; }
  blur(): void { if (hostDocument.activeElement === this) hostDocument.activeElement = null; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.dispatch('close'); }
  scrollIntoView(): void {}
  select(): void {}
  click(): void { this.dispatch('click'); }
}
function matchesHost(node: HostNode, selector: string): boolean {
  if (selector.includes(',')) return selector.split(',').some(part => matchesHost(node, part.trim()));
  let base = selector.trim(); let enabledOnly = false;
  if (base.endsWith(':not(:disabled)')) { enabledOnly = true; base = base.slice(0, -':not(:disabled)'.length); }
  const matched = base.startsWith('.') ? node.classText.split(' ').includes(base.slice(1)) || node.className.split(' ').includes(base.slice(1))
    : base.startsWith('#') ? node.id === base.slice(1)
    : base.startsWith('[') && base.endsWith(']') ? node.hasAttribute(base.slice(1, -1))
    : node.tagName === base;
  return matched && !(enabledOnly && node.disabled);
}
const hostRoots: HostNode[] = [];
const hostIds = new Map<string, HostNode>();
const documentHandlers = new Map<string, Handler[]>();
const hostDocument = {
  activeElement: null as HostNode | null,
  title: '',
  hidden: false,
  documentElement: new HostNode('html'),
  body: new HostNode('body'),
  createElement: (tag: string) => new HostNode(tag),
  createElementNS: (_namespace: string, tag: string) => new HostNode(tag),
  createDocumentFragment: () => new HostNode('#fragment'),
  createTextNode: (value: string) => { const node = new HostNode('#text'); node.textContent = value; return node; },
  getElementById: (id: string): HostNode | undefined => {
    let node = hostIds.get(id);
    if (!node) { node = new HostNode(id.endsWith('-editor') ? 'textarea' : 'div'); node.id = id; hostIds.set(id, node); hostRoots.push(node); }
    return node;
  },
  querySelector: (_selector: string): HostNode | null => null,
  querySelectorAll: (_selector: string): HostNode[] => [],
  getSelection: () => ({isCollapsed: true, anchorNode: null, focusNode: null}),
  addEventListener: (name: string, handler: Handler) => { documentHandlers.set(name, [...documentHandlers.get(name) ?? [], handler]); },
  get defaultView() { return view; },
  removeEventListener: () => {},
  dispatchEvent: () => true,
};
const view = {
  getComputedStyle: (node: HostNode) => ({paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px',
    width: `${node.id === 'conversation-splitter' ? host.splitter : 5}px`, maxHeight: '480px',
    getPropertyValue: (key: string) => key === '--palette-row-size' ? '24px' : ''}),
  requestAnimationFrame: (callback: FrameRequestCallback) => hostRequestAnimationFrame(callback),
  cancelAnimationFrame: (_handle: number) => {},
  addEventListener: () => {}, removeEventListener: () => {},
  setTimeout: (callback: () => void, ms = 0) => setTimeout(callback, ms),
  clearTimeout: (handle: number) => clearTimeout(handle),
  innerWidth: 1200,
};
const host = {viewport: 1200, splitter: 5};

hostDocument.documentElement.classList.add('conversation');
function rectWidth(node: HostNode): number {
  if (node.id === 'conversation-panes') return host.viewport - (host.viewport >= 900 && !hostIds.get('sidebar')?.hidden ? 272 : 0);
  return 600;
}
let frames: FrameRequestCallback[] = [];
let frameCount = 0;
function hostRequestAnimationFrame(callback: FrameRequestCallback): number { frames.push(callback); return ++frameCount; }
function flushFrames(): void { for (let round = 0; round < 20 && frames.length; round++) { const pending = frames; frames = []; for (const frame of pending) frame(0); } }
const storageValues = new Map<string, string>();
const hostSessionStorage = {getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { storageValues.set(key, value); }, removeItem: (key: string) => { storageValues.delete(key); }};
const streams: string[] = [];
type Fixture = {workspace: Workspace; primaries: PrimaryView[]; roster: AgentRow[]; targets?: TargetState[];
  selectedPage?: Snapshot['selectedPage']; selectedFrame?: ProjectedFrame; selectedAgent?: AgentRow; history?: EntryView[]};
const coverage = {complete: true, truncated: false, omitted: 0};
function primaryFixture(overrides: Partial<PrimaryView> = {}): PrimaryView {
  return {key: 'p', epoch: 1, cwd: '/fixture/project', lifecycle: 'ready', activity: 'idle', pendingOperationIds: [],
    pendingDialogs: [], capabilities: {}, ...overrides};
}
function agentFixture(identity: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {identity, storageId: `storage:${identity}`, cwd: '/fixture/project', modifiedAt: 0, state: 'idle', owner: 'here',
    availability: 'live', partial: false, capabilities: {history: true, observe: true, input: true, abort: true, configure: true}, ...overrides};
}
function targetFixture(targetKey: string, target: TargetState['target'], overrides: Partial<TargetState> = {}): TargetState {
  return {targetKey, target, draft: {revision: 1, text: '', mode: 'prompt', persisted: true},
    reading: {revision: 1, anchorId: null, offsetPx: 0, followTail: true}, unconfirmed: [], ...overrides};
}
let fixture: Fixture = {workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []};
let cursorSequence = 1;
let eventSequence = 1;
let operationSerial = 0;
const selectionSaves: {body: Record<string, unknown>}[] = [];
let selectionHook: ((body: Record<string, unknown>) => void) | undefined;
let selectionFailure: {code: string; message: string; retry: 'capacity'} | undefined;
function snapshotOf(current: Fixture, sequence: number): Snapshot {
  return {bootId: 'boot', cursor: `boot:${sequence}`, workspace: current.workspace, primaries: current.primaries,
    roster: {rows: current.roster, nextCursor: null, scan: {state: 'ready', complete: true, visited: current.roster.length, skipped: 0, omitted: 0}, stale: false},
    dialogs: [], pendingOperations: [], targetIndex: [], targets: current.targets, selectedAgent: current.selectedAgent,
    selectedPage: current.selectedPage, selectedFrame: current.selectedFrame, notices: [], omitted: []};
}
const transportLog: {method: string; path: string; body?: unknown}[] = [];
function applySelection(workspace: Workspace, body: Record<string, unknown>): Workspace {
  const {expectedRevision: _revision, selectedTarget, ...rest} = body;
  return {...workspace, ...rest, ...(selectedTarget === null ? {} : selectedTarget === undefined ? {} : {selectedTarget: selectedTarget as Workspace['selectedTarget']}),
    ...(selectedTarget === null ? {selectedTarget: undefined} : {}), revision: workspace.revision + 1} as Workspace;
}
function fixtureRead(path: string, body?: Record<string, unknown>): unknown {
  if (path === '/api/bootstrap') return {...snapshotOf(fixture, ++cursorSequence), limits: {}};
  if (path === '/api/snapshot') return snapshotOf(fixture, ++cursorSequence);
  if (/^\/api\/primaries\/p\/history(?!.*output)/.test(path)) return {target: {kind: 'primary', key: 'p', epoch: 1}, items: fixture.history ?? [], nextCursor: null, coverage};
  if (/^\/api\/agents\/[^/]+\/history$/.test(path)) return {target: {kind: 'agent', identity: path.split('/')[3] ?? ''}, entries: [], nextBefore: null, coverage, revision: 'r'};
  if (path === '/api/operations') return {operationId: `op-${++operationSerial}`};
  if (path === '/api/agents/refresh') return {};
  if (path === '/api/agents') return snapshotOf(fixture, cursorSequence).roster;
  if (path.includes('/resources/')) return {items: [], nextCursor: null, revision: 'r'};
  if (path.endsWith('/draft')) return {revision: 2, text: String(body?.text ?? ''), mode: String(body?.mode ?? 'prompt'), persisted: true};
  if (/\/(reading|presentation)$/.test(path)) return {revision: 2, anchorId: null, offsetPx: 0, followTail: true};
  if (path.includes('/targets/')) return targetFixture('missing', {kind: 'agent', identity: 'missing'});
  throw new Error(`No fixture for ${path}`);
}
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), 'http://ui.test/app').pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>;
  transportLog.push({method, path, body});
  if (method === 'PUT' && path.endsWith('/selection')) {
    assert.equal(path, '/api/workspaces/w/selection'); selectionHook?.(body ?? {});
    if (selectionFailure) return Response.json({ok: false, error: selectionFailure});
    selectionSaves.push({body: body ?? {}});
    fixture = {...fixture, workspace: applySelection(fixture.workspace, body ?? {})};
    return Response.json({ok: true, data: fixture.workspace});
  }
  return Response.json({ok: true, data: fixtureRead(path, body)});
};
Object.assign(globalThis, {
  document: hostDocument, HTMLElement: HostNode, window: view, location: {href: 'http://ui.test/app?workspace=w', hash: ''},
  history: {replaceState() {}}, sessionStorage: hostSessionStorage, matchMedia: (query: string) => ({matches: query === '(min-width: 900px)' && host.viewport >= 900, addEventListener() {}, removeEventListener() {}}),
  getComputedStyle: view.getComputedStyle, requestAnimationFrame: hostRequestAnimationFrame,
  ResizeObserver: class {observe(): void {} unobserve(): void {} disconnect(): void {}},
  MutationObserver: class {observe(): void {} disconnect(): void {}},
  EventSource: class {constructor(url: string) { streams.push(url); } addEventListener(): void {} close(): void {} onerror: (() => void) | undefined},
  innerWidth: 1200, innerHeight: 800,
});
try { globalThis.navigator = {};} catch { /* Node exposes a read-only navigator; nothing under test reads it. */ }
const nativeSetTimeout = globalThis.setTimeout;
const timers = new Set<ReturnType<typeof setTimeout>>();
Object.assign(globalThis, {setTimeout: (callback: () => void, delay = 0) => {
  const timer = nativeSetTimeout(() => {timers.delete(timer); callback();}, delay); timers.add(timer); return timer;
}});
after(() => {for (const timer of timers) clearTimeout(timer); timers.clear(); frames = [];});
const app = await import('./app.ts');
const byId = (id: string): HostNode => {
  const node = hostDocument.getElementById(id);
  assert.ok(node, id);
  return node as HostNode;
};
async function settle(): Promise<void> { for (let round = 0; round < 4; round++) { flushFrames(); await new Promise(resolve => setImmediate(resolve)); } flushFrames(); }
async function arrive(next: Fixture): Promise<void> {
  fixture = next;
  await app.reload();
  await settle();
}
function event(name: string, data: unknown, target?: {kind: 'primary'; key: string; epoch: number}): void {
  cursorSequence = Math.max(cursorSequence + 1, ++eventSequence + 1000);
  app.receive({name: name as never, id: `boot:${cursorSequence}`, envelope: {at: '', ...(target ? {target} : {}), data} as never, bytes: 64});
}


await settle();
event('ready', {bootId: 'boot'}); await settle();
let revision = 10;
async function splitFixture({width = 1200, divider = 5, split = true, ratio = 50, sidebar = true, drawer = false} = {}) {
  host.viewport = width; host.splitter = divider; selectionFailure = undefined;
  const layout: ConversationLayout = {tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'a', split}], active: 1, splitRatio: ratio};
  const primaryTarget = targetFixture('primary-draft', {kind: 'primary', key: 'p', epoch: 1}); primaryTarget.draft.text = 'Primary draft';
  const agentTarget = targetFixture('agent-draft', {kind: 'agent', identity: 'a'}); agentTarget.draft.text = 'Agent draft';
  const saves: Record<string, unknown>[] = [];
  selectionHook = body => { const {expectedRevision: _revision, ...change} = body; saves.push(change); };
  revision += 100;
  await arrive({workspace: {id: 'w', revision, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'a'}, panelVisible: true, sidebarVisible: sidebar, conversationLayout: {...layout, tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'a', split: false}]}}, primaries: [primaryFixture()], roster: [agentFixture('a')], targets: [primaryTarget, agentTarget]});
  if (drawer) { app.toggleSidebar(true); await settle(); }
  fixture.workspace = {...fixture.workspace, conversationLayout: layout}; app.state.workspace = fixture.workspace; app.selectionQueue.observe(fixture.workspace); saves.length = 0;
  const baselineDestroy = byId('conversation-splitter').removals.get('pointerdown') ?? 0;
  const baselineAnnouncements = byId('announcements').writes;
  const context = {get drawerOpen() {return app.drawerOpen;}, get primaryDraft() {return app.primaryComposer.state?.draft;}, get agentDraft() {return app.agentComposer.state?.draft;}};
  return {get state() {return app.state;}, layout, byId, context, helpers: app,
    get saved() {return saves;},
    get sizes() {return [{min: Number(byId('conversation-splitter').getAttribute('aria-valuemin')), max: Number(byId('conversation-splitter').getAttribute('aria-valuemax'))}];},
    get errors() {return byId('agent-receipt').textContent.includes('Selection unavailable') ? ['Selection unavailable'] : [];},
    get notices() {return Array.from({length: (byId('announcements').writes - baselineAnnouncements) / 2}, () => byId('announcements').textContent);},
    selectionQueue: app.selectionQueue,
    get destroys() {return (byId('conversation-splitter').removals.get('pointerdown') ?? 0) - baselineDestroy;},
    get targetChanges() {return saves.filter(change => change.selectedTarget && JSON.stringify(change.selectedTarget) !== JSON.stringify({kind: 'agent', identity: 'a'})).length;},
    resize(value: number, handleWidth = host.splitter) {host.viewport = value; host.splitter = handleWidth; app.renderNavigation();},
    failSaves() {selectionFailure = {code: 'capacity', message: 'Selection unavailable', retry: 'capacity'};},
    settle,
  };
}
test('split restoration clamps pixel tracks without replacing a saved ratio or retained conversation state', async () => {
  const f = await splitFixture({width: 1200, ratio: 20}); f.helpers.renderNavigation(); await f.settle();
  assert.equal(f.helpers.splitActive(), true); assert.equal(f.byId('conversation-panes').properties.get('--split-primary'), '320px');
  assert.equal(f.state.workspace.conversationLayout?.splitRatio, 20); assert.equal(f.saved.length, 0);
  assert.equal(f.sizes[0]?.min, 320); assert.equal(f.sizes[0]?.max, 603);
  const primary = f.byId('primary'); const agent = f.byId('agent-detail'); const drafts = [f.context.primaryDraft, f.context.agentDraft];
  f.resize(2000); await f.settle(); assert.equal(f.byId('conversation-panes').properties.get('--split-primary'), '345px');
  assert.equal(f.byId('primary'), primary); assert.equal(f.byId('agent-detail'), agent); assert.deepEqual([f.context.primaryDraft, f.context.agentDraft], drafts);
  assert.equal(f.targetChanges, 0); assert.equal(f.state.workspace.selectedTarget?.kind, 'agent'); assert.equal(f.destroys, 1);
});
test('split requests collapse the sidebar before accepting two safe panes', async () => {
  const f = await splitFixture({width: 900, split: false}); f.helpers.renderNavigation();
  f.helpers.applyLayout(toggleSplit(f.layout)); await f.settle();
  assert.equal(f.byId('sidebar').hidden, true); assert.equal(f.state.workspace.sidebarVisible, false); assert.equal(f.helpers.splitActive(), true);
  assert.equal(f.byId('conversation-panes').properties.get('--split-primary'), '448px');
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0]?.sidebarVisible, false); assert.equal(f.targetChanges, 0);
  assert.deepEqual(f.state.workspace.selectedTarget, {kind: 'agent', identity: 'a'});
});
test('an insufficient window closes the drawer and refuses split without changing the target or drafts', async () => {
  const f = await splitFixture({width: 620, split: false, drawer: true}); f.helpers.renderNavigation();
  f.helpers.applyLayout(toggleSplit(f.layout)); await f.settle();
  assert.equal(f.context.drawerOpen, false); assert.equal(f.byId('sidebar').hidden, true); assert.equal(f.helpers.splitActive(), false);
  assert.equal(f.byId('primary').hidden, true); assert.equal(f.byId('agent-detail').hidden, false);
  const savedLayout = f.state.workspace.conversationLayout; assert.ok(savedLayout);
  assert.equal(activeTab(savedLayout)?.kind, 'agent'); assert.equal(savedLayout.tabs[1]?.kind === 'agent' && savedLayout.tabs[1].split, false);
  assert.match(f.byId('agent-view-notice').textContent, /320 px per pane/); assert.equal(f.notices.length, 1);
  assert.equal(f.context.primaryDraft?.text, 'Primary draft'); assert.equal(f.context.agentDraft?.text, 'Agent draft'); assert.equal(f.targetChanges, 0);
});
test('restored splits and viewport changes use the exact fine and coarse divider thresholds', async () => {
  for (const [width, divider] of [[645, 5], [684, 44]]) {
    const f = await splitFixture({width, divider, sidebar: false, ratio: 80}); f.helpers.renderNavigation(); await f.settle();
    assert.equal(f.helpers.splitActive(), true); assert.equal(f.byId('conversation-panes').properties.get('--split-primary'), '320px');
    assert.equal(f.sizes[0]?.min, 320); assert.equal(f.sizes[0]?.max, 320);
    f.resize(width - 1); assert.equal(f.helpers.splitActive(), false); assert.equal(f.byId('primary').hidden, true);
    await f.settle(); assert.equal(f.saved.length, 1); assert.equal(f.targetChanges, 0); assert.match(f.byId('agent-view-notice').textContent, /Widen the window/);
  }
  const narrow = await splitFixture({width: 500, split: true}); narrow.helpers.renderNavigation(); await narrow.settle();
  assert.equal(narrow.helpers.splitActive(), false); assert.equal(narrow.saved.length, 1);
});
test('automatic split corrections follow the original queued selection and do not replay failed corrections', async () => {
  const f = await splitFixture({width: 900, split: false}); f.helpers.renderNavigation();
  await f.selectionQueue.select({conversationLayout: toggleSplit(f.layout)}); await f.settle();
  assert.equal(f.saved.length, 2); assert.ok(f.saved[0]?.conversationLayout); assert.equal(f.saved[1]?.sidebarVisible, false); assert.deepEqual(Object.keys(f.saved[1] ?? {}), ['sidebarVisible']);
  assert.equal(f.state.workspace.sidebarVisible, false); assert.equal(f.helpers.splitActive(), true);
  const failed = await splitFixture({width: 600}); failed.failSaves(); failed.helpers.renderNavigation(); await failed.settle();
  assert.equal(failed.saved.length, 1); assert.equal(failed.errors.length, 1); assert.equal(failed.helpers.splitActive(), false);
  failed.helpers.renderNavigation(); await failed.settle(); assert.equal(failed.saved.length, 1);
});
