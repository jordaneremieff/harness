import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, {after} from 'node:test';
import { contextMenu } from './context-menu.ts';
import type { AgentRow, EntryView, MessageView, PartView, PrimaryView, ProjectedFrame, Snapshot, TargetState, Workspace } from '../shared/api.ts';

const source = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

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
    contains: (name: string) => this.classes.has(name) || this.className.split(' ').includes(name),
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
  removeEventListener(name: string, handler?: Handler): void { if (!handler) { this.handlers.delete(name); return; } const next = (this.handlers.get(name) ?? []).filter(item => item !== handler); if (next.length) this.handlers.set(name, next); else this.handlers.delete(name); }
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
  addEventListener: () => {}, removeEventListener: () => {},
  setTimeout: (callback: () => void, ms = 0) => setTimeout(callback, ms),
  clearTimeout: (handle: number) => clearTimeout(handle),
  innerWidth: 1200, innerHeight: 800,
};
const host = {viewport: 1200, splitter: 5};
view.getDocument = undefined as never;
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
  return {key: 'p', epoch: 1, cwd: '/fixture/project', lifecycle: 'ready', activity: 'running', pendingOperationIds: [],
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
function entryFixture(id: string, messages: MessageView[]): EntryView {
  return {id, kind: 'message', messages};
}
function messageFixture(id: string, parts: PartView[], state: MessageView['state'] = 'final'): MessageView {
  return {id, role: 'assistant', parts, state, coverage};
}
function textPart(text: string): PartView { return {type: 'text', text}; }
function imagePart(entryId: string): PartView {
  return {type: 'image', mimeType: 'image/png', digest: 'a'.repeat(64), bytes: 2048, width: 8, height: 8, alt: 'fixture image', source: {entryId, message: 0, part: 0}};
}
let fixture: Fixture = {workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []};
let cursorSequence = 1;
let eventSequence = 1;
let operationSerial = 0;
const selectionSaves: {body: Record<string, unknown>}[] = [];
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
    assert.equal(path, '/api/workspaces/w/selection');
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
  fixture = {...next, workspace: {...next.workspace, revision: Math.max(next.workspace.revision, (app.state.workspace?.revision ?? 0) + 1)}};
  await app.reload();
  await settle();
}
function event(name: string, data: unknown, target?: {kind: 'primary'; key: string; epoch: number}): void {
  cursorSequence = Math.max(cursorSequence + 1, ++eventSequence + 1000);
  app.receive({name: name as never, id: `boot:${cursorSequence}`, envelope: {at: '', ...(target ? {target} : {}), data} as never, bytes: 64});
}
function descendants(node: HostNode): HostNode[] { return [...node.children, ...node.children.flatMap(descendants)]; }

await settle(); event('ready', {bootId: 'boot'}); await settle();

test('shell element references match the shared DOM contract', () => {
  for (const match of source.matchAll(/byId(?:<[^>]+>)?\('([^']+)'\)/g)) assert.ok(html.includes(`id="${match[1]}"`), `Missing ${match[1]}`);
  assert.doesNotMatch(source, /byId\('(?:agent-panel|agents-button|agent-back|agent-close|agent-detail-close)'\)/);
  assert.match(source, /commands: \(\) => actions\.commandOptions\(\)/);
});
test('section changes hide retained nodes and explicit skip navigation focuses the selected editor', () => {
  assert.match(source, /byId\('primary'\)\.hidden = !tab \|\| \(agentSelected && !split\)/);
  assert.match(source, /byId\('agent-detail'\)\.hidden = !tab \|\| !agentSelected/);
  assert.doesNotMatch(source, /byId\('(?:primary|agent-detail)'\)\.replaceChildren/);
  assert.match(source, /navigationState\(state\.workspace, false\)\.editor\)\.focus\(\)/);
  assert.match(source, /byId\('skip-composer'\)\.addEventListener\('click', event => \{ event\.preventDefault\(\); focusEditor\(\); \}\)/);
});
test('earlier-history loads expose pending and result states without restoring an old saved anchor', () => {
  assert.match(source, /control\.disabled = pending/);
  assert.match(source, /pending \? '↑ earlier…' : '↑ earlier'/);
  assert.match(source, /if \(cursor\) historyFeedback\('primary', `Loaded earlier history/);
  assert.match(source, /else if \(!selectedAgent\(\) \|\| splitActive\(\)\) primaryTranscript\.restore\(targetState\(target\)\?\.reading\)/);
  assert.match(source, /Earlier history unavailable:/);
  assert.match(source, /controller\.signal\.aborted \|\| !sameTarget\(target, primaryTarget\(\)\)/);
});
test('selection admission gate stays separate from transport connectivity', () => {
  assert.match(source, /primaryComposer\.availability\(connected, item\?\.lifecycle === 'ready', busy, selecting\)/);
  assert.match(source, /agentComposer\.availability\(connected, [^\n]+, selecting\)/);
  assert.doesNotMatch(source, /availability\(connected && !selecting/);
});
test('snapshot refresh does not await history and history still has a deadline', () => {
  assert.match(source, /refreshVisible\(refreshSnapshot, loadPrimaryHistory, showError\)/);
  assert.match(source, /AbortSignal\.any\(\[controller\.signal, AbortSignal\.timeout\(15_000\)\]\)/);
  assert.doesNotMatch(source, /await loadPrimaryHistory\(/);
});
test('action errors choose the visible receipt when the rejection is handled', () => {
  assert.match(source, /setText\(byId\(visibleReceipt\(state\.workspace\)\), message\)/);
  assert.doesNotMatch(source, /function showAgentError/);
});
test('connection failures use the visible status bar and tab hiding releases observation', () => {
  assert.match(source, /connectionSurfaceFor\(connectionPhase, true\)/);
  assert.match(source, /for \(const id of \['connection', 'workspace-alert'\]\)/);
  assert.match(source, /document\.hidden && state\.workspace\?\.panelVisible/);
  assert.match(source, /selection\(\{panelVisible: false\}\)/);
  assert.match(source, /selection\(\{panelVisible: true\}\)/);
  assert.doesNotMatch(source, /setInterval/);
});

test('message panel moves the existing form outside the roster without changing the main view', () => {
  assert.equal([...html.matchAll(/id="agent-composer"/g)].length, 1); assert.equal([...html.matchAll(/id="agent-editor"/g)].length, 1);
  assert.ok(html.includes('</section>\n<section id="agent-message-panel"'));
  assert.ok(html.indexOf('id="agent-message-panel"') < html.indexOf('id="sidebar-resizer"'));
  assert.match(source, /form\.parentElement !== panel\) panel\.append\(form\)/);
  assert.match(source, /form\.parentElement !== detail\) detail\.append\(form\)/);
  const panel = source.slice(source.indexOf('function renderMessagePanel()'), source.indexOf('function renderAgent()'));
  assert.doesNotMatch(panel, /selection\(|primaryTranscript\.|primaryComposer\.(attach|setText)/);
  assert.match(source, /targets`, 'POST', \{target\}/);
});
test('transcript saves use their captured workspace and target rather than the movable composer', () => {
  assert.match(source, /saveReading\(agentTranscriptTarget, reading\)/); assert.match(source, /savePresentation\(agentTranscriptTarget, expanded, showThinking\)/);
  const saves = source.slice(source.indexOf('function saveReading('), source.indexOf('function showOperation('));
  assert.doesNotMatch(saves, /composer\.state|agentComposer|selectedAgent/);
  assert.match(saves, /const \{saved, workspaceId, prefix\} = captured/);
  assert.match(saves, /encodeURIComponent\(workspaceId\)/); assert.match(saves, /encodeURIComponent\(saved\.targetKey\)/);
});
test('close and Escape retain buffers, return focus by identity, and hide unsafe controls', () => {
  assert.match(source, /byId\('agent-message-close'\)\.addEventListener\('click', \(\) => closeMessagePanel\(\)\)/);
  assert.match(source, /event\.key === 'Escape' && messageTarget\.current && !modal\.openNow/);
  assert.match(source, /roster\.focusMessage\(identity\)/); assert.match(source, /primaryComposer\.editor\.focus\(\)/);
  for (const control of ['agent-abort', 'agent-acquire']) assert.ok(source.includes(`byId('${control}').addEventListener('click', () => { if (messageTarget.current) return;`));
  assert.match(source, /messageTarget\.current \? messageTarget\.ready : row\?\.availability/);
  assert.match(source, /agentComposer\.placement\(true\)/);
});

test('only arrived roster and availability events invalidate message preparation', () => {
  const events = source.slice(source.indexOf('function applyEvent('), source.indexOf('function renderObservedAgent('));
  assert.match(events, /messageTarget\.rosterChanged\(event\.envelope\.data as EventData\['agent\.roster'\]\)/);
  assert.match(events, /messageTarget\.availabilityChanged\(event\.envelope\.data as EventData\['agent\.availability'\]\)/);
  const panel = source.slice(source.indexOf('function renderMessagePanel()'), source.indexOf('function closeMessagePanel('));
  assert.doesNotMatch(panel, /messageTarget\.(rosterChanged|availabilityChanged)/);
  assert.match(source, /messageTarget\.current && !messageTarget\.current\.invalidated\) await messageTarget\.open/);
});
test('Resume uses revision-aware reconciliation and restores its exact buffer while prepare is pending', () => {
  assert.match(source, /agentComposer\.retained\(state\.workspace\?\.id \?\? '', target, index\) \?\? false/);
  assert.doesNotMatch(source, /retained\([^\n]+\) \?= !!\(index/);
  assert.match(source, /else agentComposer\.attachRetained\(captured\.workspaceId, \{kind: 'agent', identity: captured\.identity\}\)/);
  assert.match(source, /agentComposer\.availability\(connected, messageTarget\.ready, false, selecting\)/);
});
test('the app delegates composer recovery without a duplicate renderer or hook', () => {
  assert.doesNotMatch(source, /function recover\(|recover: recover|exactInput/);

  assert.match(source, /recovery: \(\) => recovery\.open\(\)/);
});

test('visible controls supplement the palette without a header band or title click action', () => {
  assert.doesNotMatch(source, /installIcons|primaryActivityLabel|viewActions\(/);
  for (const id of ['sidebar-hide', 'sessions-button', 'agent-copy', 'agent-identity', 'agent-inspect', 'primary-open-project']) assert.equal(html.includes(`id="${id}"`), false);
  assert.doesNotMatch(source, /byId\('(?:session-title|agent-name)'\)\.addEventListener\('click'/);
  assert.ok(source.includes("setText(byId('primary-row-meta'), item ? primaryState(item) : '')"));
  assert.ok(source.includes('$' + '{primaryState(item)}'));
  assert.doesNotMatch(source, /model\.id\} ▾|thinkingLevel\} ▾|Live · (idle|working|loading)/);
  assert.ok(source.includes("byId('notices-count').hidden = !unread"));
  assert.doesNotMatch(source, /byId\('notices-button'\)\.hidden/);
  assert.ok(source.includes("item?.activity === 'retrying' ? 'Retrying' : ''"));
  assert.ok(source.includes('if (item?.lastError)'));
  assert.ok(source.includes('selectedAgent: () =>'));
  assert.ok(source.includes('view: (tools, expand) => primaryTranscript.expandLoaded(tools, expand)'));
});

test('the project prompt uses lowercase instrument chrome', () => {
  assert.ok(source.includes("setText(byId('project-name'), item?.cwd.split('/').filter(Boolean).at(-1) ?? 'open a project')"));
});

test('the no-session primary row uses the allowed empty state glyph', () => {
  const navigation = source.slice(source.indexOf('function primaryNavigation('), source.indexOf('function primaryActivity('));
  assert.ok(navigation.includes("const glyph = !item ? '○'"));
  assert.ok(navigation.includes("?? 'no session'"));
  assert.doesNotMatch(navigation, /◌/);
});

test('sidebar controls are visible and their icons have consistent decorative strokes and named buttons', () => {
  const controls = ['session-new', 'agent-refresh', 'agent-new', 'notices-button', 'appearance-button', 'session-actions'];
  for (const id of controls) {
    const match = html.match(new RegExp(String.raw`<button id="${id}"([^>]*)>([\s\S]*?)</button>`) ); assert.ok(match, id);
    assert.match(match[1] ?? '', /aria-label="[^"]+"/); assert.match(match[1] ?? '', /class="[^"]*icon-button/);
    assert.doesNotMatch(match[1] ?? '', /\shidden(?:\s|$)/);
    assert.match(match[2] ?? '', /<svg class="ui-icon" width="16" height="16"/);
    assert.match(match[2] ?? '', /stroke="currentColor" stroke-width="1\.5"/);
    assert.match(match[2] ?? '', /aria-hidden="true" focusable="false"/);
  }
  const search = html.match(/<input id="agent-search"[^>]*>/)?.[0]; assert.ok(search);
  assert.match(search, /placeholder="Filter agents"/); assert.doesNotMatch(search, /\shidden/);
  assert.ok(source.includes("byId('session-new').addEventListener('click', () => { if (primary()) actions.newSession(); else actions.projectPicker(); })"));
  assert.ok(source.includes("byId('agent-refresh').addEventListener('click', refreshRoster)"));
  assert.ok(source.includes("byId('agent-new').addEventListener('click', () => actions.prepareText('/agent new'))"));
  assert.ok(source.includes("byId('appearance-button').addEventListener('click', () => actions.appearance())"));
});
test('tabs own the only conversation action menu and panes retain accessible names without title rows', () => {
  for (const id of ['primary-title-line', 'session-title', 'session-state', 'agent-name', 'agent-state', 'agent-actions']) {
    assert.equal(html.includes(`id="${id}"`), false); assert.equal(source.includes(`byId('${id}')`), false);
  }
  assert.match(html, /id="primary" class="conversation" aria-label="Primary conversation"/);
  assert.match(html, /id="agent-detail" class="conversation" aria-label="Agent conversation"/);
  assert.match(html, /id="tab-split"[^\n]*<button id="session-actions" class="icon-button tab-actions"/);
  assert.equal([...html.matchAll(/id="session-actions"/g)].length, 1);
  assert.ok(source.includes("byId('session-actions').addEventListener('click', openTabActions)"));
  for (const id of ['primary-send', 'agent-send']) {
    const send = html.match(new RegExp(String.raw`<button id="${id}"[^>]*>([\s\S]*?)</button>`) )?.[1]; assert.ok(send);
    assert.equal(send, 'Send');
    assert.doesNotMatch(html, /key-hint|Send \(Enter\)/);
  }
});

test('pane handles are labeled keyboard separators at their pane edges', () => {
  for (const [id, axis, controls] of [['sidebar-resizer', 'x', 'sidebar'], ['primary-composer-resizer', 'y', 'primary-editor'], ['agent-composer-resizer', 'y', 'agent-editor'], ['message-panel-resizer', 'y', 'agent-message-panel']]) {
    const handle = html.match(new RegExp(`<div id="${id}"[^>]*>`) )?.[0]; assert.ok(handle, id);
    assert.match(handle, /class="resizer"/); assert.match(handle, /tabindex="0" role="separator"/);
    assert.ok(handle.includes(`data-axis="${axis}"`)); assert.ok(handle.includes(`aria-controls="${controls}"`));
    assert.ok(handle.includes(`aria-orientation="${axis === 'x' ? 'vertical' : 'horizontal'}"`)); assert.match(handle, /aria-label="Resize [^"]+"/);
  }
  assert.match(html, /id="sidebar-resizer"[^>]*><\/div>\s*<\/nav>/);
  assert.match(html, /<form id="primary-composer"[^>]*>\s*<div id="primary-composer-resizer"/);
  assert.match(html, /<form id="agent-composer"[^>]*>\s*<div id="agent-composer-resizer"/);
  assert.match(html, /<section id="agent-message-panel"[^>]*>\s*<div id="message-panel-resizer"/);
});
test('sidebar width commits preserve transcript requests and pane refresh follows form placement', () => {
  const panes = source.slice(source.indexOf('function refreshPaneSizes('), source.indexOf('function currentSnapshot('));
  assert.ok(panes.includes('selectionQueue.select({sidebarWidth: value})')); assert.doesNotMatch(panes, /\bselection\(|historyAbort/);
  assert.ok(panes.includes('if (workspace.id !== paneWorkspace)')); assert.ok(panes.includes('resizer.destroy()')); assert.ok(panes.includes('paneResizers[0]?.refresh()'));
  assert.ok(panes.includes('read: () => state.workspace?.sidebarWidth ?? 272'));
  const render = source.slice(source.indexOf('function renderAll('), source.indexOf('function renderNavigation('));
  assert.ok(render.indexOf('refreshPaneSizes()') > render.indexOf('renderMessagePanel()'));
  const composer = source.slice(source.indexOf('function composerResizer('), source.indexOf('function refreshPaneSizes('));
  assert.ok(composer.includes('composer.setManualHeight(preferred)')); assert.ok(composer.includes('applyInitial: preferred !== undefined'));
  assert.ok(composer.includes('composer.setManualHeight(undefined)')); assert.ok(composer.includes("form.style.removeProperty('--composer-height')"));
});
test('per-tab pane sizes accept bounded integers and storage failures remain nonfatal', async () => {
  const values = new Map<string, string>();
  const working = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};
  const fail = () => {throw new Error('Storage denied');};
  Reflect.set(globalThis, 'sessionStorage', working);
  assert.equal(app.tabSize('pane', 40, 640), undefined);
  for (const [text, expected] of [['40', 40], ['640', 640], ['144', 144], ['39', undefined], ['641', undefined], ['40.5', undefined], ['NaN', undefined], ['', undefined]] as const) {
    values.set('pane', text); assert.equal(app.tabSize('pane', 40, 640), expected);
  }
  app.storeTabSize('pane', 144); assert.equal(values.get('pane'), '144'); app.storeTabSize('pane', undefined); assert.equal(values.has('pane'), false);
  Reflect.set(globalThis, 'sessionStorage', {getItem: fail, setItem: fail, removeItem: fail});
  assert.equal(app.tabSize('pane', 40, 640), undefined);
  assert.doesNotThrow(() => app.storeTabSize('pane', 144)); assert.doesNotThrow(() => app.storeTabSize('pane', undefined));
  Reflect.set(globalThis, 'sessionStorage', hostSessionStorage);
});
test('the primary statusline renders reported usage facts, a labeled context meter and known folder only', () => {
  const usage = source.slice(source.indexOf('function renderPrimaryUsage('), source.indexOf('function primaryState('));
  assert.ok(source.includes('renderPrimaryUsage(item)')); assert.ok(usage.includes('const usage = usageFacts(item, item ? primaryBlocks(state, item.key) : undefined)'));
  assert.ok(usage.includes("element('span', 'usage-fact', fact.text)")); assert.ok(usage.includes('node.dataset.key = fact.key')); assert.ok(usage.includes('node.title = fact.title'));
  assert.ok(usage.includes("element('meter', 'context-bar')")); assert.ok(usage.includes('bar.hidden = usage.contextFraction === null')); assert.ok(usage.includes("bar.setAttribute('aria-label', 'Context usage')"));
  assert.ok(usage.includes("const folder = item?.cwd.split('/').filter(Boolean).at(-1)")); assert.ok(html.includes('id="statusbar-folder" class="status-segment" data-key="folder"'));
  assert.doesNotMatch(usage, /branch/); assert.doesNotMatch(source, /usageSummary/);
});

test('queued primary input renders labeled text, preserves full titles and clears when empty', () => {
  const list = byId('primary-queued');
  app.renderPrimaryQueue({pending: 2, steering: ['Check this first\nThen inspect the output'], followUp: ['<tag>literal input</tag>']});
  assert.equal(list.hidden, false); assert.equal(list.children.length, 2);
  assert.deepEqual(list.children.map(row => ({tag: row.tagName, className: row.className, mode: row.dataset.mode, text: row.textContent, title: row.title})), [
    {tag: 'li', className: 'queued-message', mode: 'steer', text: 'steer: Check this first\nThen inspect the output', title: 'Check this first\nThen inspect the output'},
    {tag: 'li', className: 'queued-message', mode: 'followUp', text: 'follow-up: <tag>literal input</tag>', title: '<tag>literal input</tag>'},
  ]);
  app.renderPrimaryQueue({pending: 1, followUp: ['Only follow-up']}); assert.equal(list.children.length, 1); assert.equal(list.children[0]?.dataset.mode, 'followUp');
  app.renderPrimaryQueue({pending: 0, steering: [], followUp: []}); assert.equal(list.hidden, true); assert.equal(list.children.length, 0);
  app.renderPrimaryQueue(undefined); assert.equal(list.hidden, true);
  assert.match(html, /id="primary-queued" class="queued-list"[^>]*><\/ul>\s*<div class="composer-input">/);
  assert.ok(source.includes('renderPrimaryQueue(conversation?.queue)')); assert.ok(source.includes("name === 'primary.recovery' || name === 'primary.queue'"));
});

test('every theme uses the existing appearance dataset path and dark stays the default', async () => {
  const assignment = source.match(/document\.documentElement\.dataset\.appearance = ([^;]+);/); assert.ok(assignment);
  assert.equal(assignment[1], "state.workspace.appearance ?? 'dark'");
  for (const appearance of ['dark', 'light', 'system', 'latte', 'frappe', 'macchiato', 'mocha', undefined]) {
    await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', ...(appearance ? {appearance} : {})}, primaries: [primaryFixture()], roster: []});
    assert.equal(hostDocument.documentElement.dataset.appearance, appearance ?? 'dark');
  }
});
test('empty editors show target-specific placeholders without replacing their labels', () => {
  assert.match(html, /<textarea id="primary-editor"[^>]*placeholder="Message Pi · \/ for commands"/);
  assert.match(html, /<textarea id="agent-editor"[^>]*placeholder="Message this agent"/);
  assert.match(html, /<label class="sr-only" for="primary-editor">Message to primary<\/label>/);
  assert.match(html, /<label class="sr-only" for="agent-editor">Message to this agent<\/label>/);
});
test('statusbar stays Primary-scoped while tab actions follow the active conversation in a split', async () => {
  const state = byId('statusbar-state'); const actions = byId('session-actions');
  const menuTitles: string[] = [];
  const openedTitle = () => { const menu = hostDocument.body.children.find(node => node.className === 'context-menu'); assert.ok(menu); menuTitles.push(menu.attributes.get('aria-label') ?? ''); contextMenu.close(); };
  const base = {primaries: [primaryFixture({activity: 'running'})], roster: [agentFixture('agent-pane', {state: 'working'})]};
  await arrive({...base, workspace: {id: 'w', revision: 1, primaryKey: 'p',
    conversationLayout: {tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'agent-pane'}], active: 0, splitRatio: 50}}});
  app.renderStatusbarState(); assert.equal(state.textContent, 'Primary · running'); assert.equal(state.dataset.state, 'running');
  app.renderTabActions(); assert.equal(actions.disabled, false); assert.equal(actions.attributes.get('aria-label'), 'Session actions'); app.openTabActions(); openedTitle();
  await arrive({...base, workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'agent-pane'}, panelVisible: true,
    conversationLayout: {tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'agent-pane', split: true}], active: 1, splitRatio: 50}}});
  app.renderStatusbarState(); assert.equal(state.textContent, 'Primary · running'); assert.equal(state.title, 'Primary');
  app.renderTabActions(); assert.equal(actions.disabled, false); assert.equal(actions.attributes.get('aria-label'), 'Agent actions'); app.openTabActions(); openedTitle();
  assert.deepEqual(menuTitles, ['Session actions', 'Agent actions']);
  await arrive({...base, roster: [agentFixture('agent-pane', {availability: 'stored'})], workspace: {id: 'w', revision: 1, primaryKey: 'p',
    conversationLayout: {tabs: [{kind: 'primary'}], active: 0, splitRatio: 50}}});
  app.renderStatusbarState(); assert.equal(state.textContent, 'Primary · running');
  await arrive({...base, workspace: {id: 'w', revision: 1, conversationLayout: {tabs: [{kind: 'primary'}], active: 0, splitRatio: 50}}});
  app.renderTabActions(); assert.equal(actions.disabled, true);
  await arrive({...base, workspace: {id: 'w', revision: 1, conversationLayout: {tabs: [], active: null, splitRatio: 50}}});
  app.renderStatusbarState(); assert.equal(state.textContent, 'Primary · no session'); app.renderTabActions(); assert.equal(actions.disabled, true);
  app.openTabActions(); assert.deepEqual(menuTitles, ['Session actions', 'Agent actions']);
});

test('the full-window status bar owns settings and facts while the composer owns draft status', () => {
  const bar = html.match(/<footer id="statusbar" class="statusbar" aria-label="Primary status">([\s\S]*?)<\/footer>/)?.[1]; assert.ok(bar);
  assert.match(html, /<\/main>\s*<footer id="statusbar"[\s\S]*?<\/footer>\s*<\/div>\s*<div id="announcements"/);
  for (const id of ['connection', 'primary-usage', 'extension-status', 'thinking-button', 'model-button', 'commands-button', 'statusbar-state', 'statusbar-agents', 'statusbar-folder']) {
    assert.ok(bar.includes(`id="${id}"`), id); assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, id);
  }
  assert.match(bar, /class="statusbar-left"/); assert.match(bar, /class="statusbar-facts"/); assert.match(bar, /class="statusbar-right"/);
  const order = ['model-button', 'thinking-button', 'primary-usage', 'statusbar-state', 'statusbar-folder', 'statusbar-agents'];
  for (let index = 1; index < order.length; index++) assert.ok(bar.indexOf(`id="${order[index - 1]}"`) < bar.indexOf(`id="${order[index]}"`));
  const footer = html.match(/<div class="sidebar-footer">([\s\S]*?)<\/div>/)?.[1]; assert.ok(footer);
  for (const id of ['notices-button', 'appearance-button']) { assert.ok(footer.includes(`id="${id}"`)); assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1); assert.ok(!bar.includes(`id="${id}"`)); }
  const composer = html.match(/<form id="primary-composer"[\s\S]*?<\/form>/)?.[0]; assert.ok(composer);
  for (const id of ['primary-save', 'primary-receipt-details', 'primary-modes', 'primary-stop', 'primary-send']) assert.ok(composer.includes(`id="${id}"`));
  for (const id of ['primary-usage', 'extension-status', 'model-button', 'thinking-button']) assert.equal(composer.includes(`id="${id}"`), false);
  assert.ok(source.includes("byId('model-button').addEventListener('click', () => actions.modelPicker())"));
  assert.ok(source.includes("byId('thinking-button').addEventListener('click', () => actions.thinkingPicker())"));
});
test('status bar facts use the primary and count only loaded live roster records', async () => {
  const base = {primaries: [primaryFixture({cwd: '/fixture/project', activity: 'running'})]};
  await arrive({...base, workspace: {id: 'w', revision: 1, primaryKey: 'p'}, roster: [
    agentFixture('a', {state: 'working'}), agentFixture('b'), agentFixture('c', {availability: 'stored', state: 'working'})]});
  app.renderStatusbarPrimary({cwd: '/fixture/project', lifecycle: 'ready', activity: 'running'} as PrimaryView);
  assert.equal(byId('statusbar-state').textContent, 'Primary · running'); assert.equal(byId('statusbar-state').dataset.state, 'running');
  assert.equal(byId('statusbar-folder').textContent, 'project'); assert.equal(byId('statusbar-folder').title, '/fixture/project');
  app.renderStatusbarAgents(); assert.equal(byId('statusbar-agents').textContent, '2 live · 1 working');
  await arrive({...base, workspace: {id: 'w', revision: 1, primaryKey: 'p'}, roster: [agentFixture('b'), agentFixture('c', {availability: 'stored'})]});
  app.renderStatusbarAgents(); assert.equal(byId('statusbar-agents').textContent, '1 live');
  await arrive({...base, workspace: {id: 'w', revision: 1}, primaries: [], roster: []});
  app.renderStatusbarAgents(); assert.equal(byId('statusbar-agents').textContent, '0 live');
  app.renderStatusbarPrimary();
  assert.equal(byId('statusbar-folder').hidden, true); assert.equal(byId('statusbar-state').textContent, 'Primary · no session');
  assert.ok(source.includes("byId('statusbar-agents').addEventListener('click', focusAgentSearch)"));
});
test('sidebar sections retain their collapsed state per workspace and tab and filter focus expands agents', async () => {
  const values = new Map<string, string>();
  Reflect.set(globalThis, 'sessionStorage', {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}});
  const workspace = (id: string): Workspace => ({id, revision: 1, primaryKey: 'p'});
  await arrive({workspace: workspace('w'), primaries: [primaryFixture()], roster: []});
  app.renderSidebarSections(); assert.equal(byId('primary-heading').attributes.get('aria-expanded'), 'true');
  app.setSidebarSection('primary', true); app.setSidebarSection('agents', true);
  assert.equal(byId('primary-section-body').hidden, true); assert.equal(byId('primary-heading').attributes.get('aria-expanded'), 'false');
  assert.equal(values.get('ui:sections:w:primary'), 'true'); assert.equal(values.get('ui:sections:w:agents'), 'true');
  await arrive({workspace: workspace('w'), primaries: [primaryFixture()], roster: []});
  app.renderSidebarSections(); assert.equal(byId('agents-section-body').hidden, true);
  await arrive({workspace: workspace('other'), primaries: [primaryFixture()], roster: []});
  app.renderSidebarSections(); assert.equal(byId('primary-section-body').hidden, false);
  await arrive({workspace: workspace('w'), primaries: [primaryFixture()], roster: []});
  app.renderSidebarSections(); assert.equal(byId('primary-section-body').hidden, true);
  byId('sidebar').hidden = true; const before = frameCount; app.focusAgentSearch(); await settle();
  assert.equal(byId('sidebar').hidden, false); assert.equal(byId('agents-section-body').hidden, false);
  assert.equal(hostDocument.activeElement, byId('agent-search')); assert.ok(frameCount > before);
  const denied = () => {throw new Error('denied');};
  Reflect.set(globalThis, 'sessionStorage', {getItem: denied, setItem: denied, removeItem: denied});
  assert.doesNotThrow(() => app.setSidebarSection('agents', true)); app.renderSidebarSections();
  assert.equal(byId('agents-section-body').hidden, true);
  Reflect.set(globalThis, 'sessionStorage', hostSessionStorage);
  assert.match(html, /id="primary-heading" class="section-toggle"[^>]*aria-controls="primary-section-body">PRIMARY/);
  assert.match(html, /id="agents-heading" class="section-toggle"[^>]*aria-controls="agents-section-body">AGENTS/);
});
test('palette key aliases prevent browser defaults and preserve IME, repeat and open-dialog guards', async () => {
  const modalNode = byId('modal');
  const closeDialog = () => { if (modalNode.open) { modalNode.open = false; modalNode.dispatch('close'); } };
  const press = (key: string, options: Record<string, boolean> = {}) => {
    const pressed = {key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options};
    app.appKey(pressed as never); return pressed;
  };
  for (const modifier of ['metaKey', 'ctrlKey']) {
    closeDialog();
    assert.equal(press('k', {[modifier]: true}).defaultPrevented, true);
    assert.equal(modalNode.open, true); assert.equal(modalNode.dataset.mode, 'commands');
    closeDialog();
    assert.equal(press('P', {[modifier]: true, shiftKey: true}).defaultPrevented, true);
    assert.equal(modalNode.dataset.mode, 'commands');
    closeDialog();
    assert.equal(press('p', {[modifier]: true}).defaultPrevented, true);
    assert.equal(modalNode.dataset.mode, 'goto');
    closeDialog();
  }
  const count = byId('modal-title').writes;
  assert.equal(press('p', {metaKey: true, isComposing: true}).defaultPrevented, false);
  assert.equal(press('p', {metaKey: true, altKey: true}).defaultPrevented, false); assert.equal(press('p').defaultPrevented, false);
  assert.equal(modalNode.open, false); assert.equal(byId('modal-title').writes, count);
  press('k', {metaKey: true}); assert.equal(modalNode.open, true); const openTitle = byId('modal-title').writes;
  assert.equal(press('p', {metaKey: true, repeat: true}).defaultPrevented, true);
  assert.equal(byId('modal-title').writes, openTitle); assert.equal(modalNode.dataset.mode, 'commands');
  press('p', {ctrlKey: true}); assert.equal(byId('modal-title').writes, openTitle);
  closeDialog();
  assert.ok(source.includes("document.addEventListener('keydown', appKey)"));
});

test('tab selection changes the observation atomically and split-only edits keep the selection lane', async () => {
  selectionSaves.length = 0; transportLog.length = 0;
  const layout = (tabs: {kind: 'primary'}[] | {kind: 'agent'; identity: string; split?: boolean}[], active: number | null, splitRatio = 60) => ({tabs, active, splitRatio});
  const agentTabs = [{kind: 'primary' as const}, {kind: 'agent' as const, identity: 'a', split: true}];
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'a'}, panelVisible: true,
    conversationLayout: {tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'a'}], active: 1, splitRatio: 60}}, primaries: [primaryFixture()], roster: [agentFixture('a')]});
  selectionSaves.length = 0; transportLog.length = 0;
  app.applyLayout(layout(agentTabs, 1) as never);
  await settle();
  const split = selectionSaves[0]?.body;
  assert.ok(split?.conversationLayout); assert.deepEqual(split?.selectedTarget, {kind: 'agent', identity: 'a'}); assert.equal(split?.panelVisible, true);
  app.applyLayout(layout([{kind: 'primary'}], 0) as never);
  await settle();
  assert.deepEqual(selectionSaves[1]?.body.selectedTarget, {kind: 'primary', key: 'p', epoch: 1});
  app.applyLayout(layout([], null) as never);
  await settle();
  assert.equal(selectionSaves[2]?.body.selectedTarget, null); assert.equal(selectionSaves[2]?.body.panelVisible, false);
  assert.equal(transportLog.filter(call => call.path === '/api/operations').length, 0);
});
test('split panes retain both transcript and composer nodes and use the shared resize primitive', () => {
  assert.match(html, /id="conversation-tabs" class="conversation-tabs" role="tablist"/);
  assert.match(html, /id="conversation-splitter" class="resizer"[^>]*aria-controls="primary agent-detail"/);
  for (const id of ['primary-transcript', 'agent-transcript', 'primary-composer', 'agent-composer']) assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1);
  const split = source.slice(source.indexOf('function refreshSplitSize('), source.indexOf('function selection('));
  assert.ok(split.includes('createResizer(')); assert.ok(split.includes('onReset: () => save(50)')); assert.doesNotMatch(split, /historyAbort|operation\(/);
  assert.ok(source.includes('if (selectedAgent() && !splitActive()) return'));
  assert.ok(source.includes('new ResizeObserver(renderNavigation)'));
  assert.ok(source.includes("matchMedia('(pointer: coarse)').addEventListener('change', renderNavigation)"));
});
test('loaded assistant usage refreshes on completed messages and history, not streaming deltas or partials', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({contextUsage: {tokens: 1000, contextWindow: 4000, percent: 25}})], roster: []});
  flushFrames();
  const usageNode = byId('primary-usage'); const baseline = usageNode.writes;
  const coverageTiny = {complete: true, truncated: false, omitted: 0};
  const primary = {kind: 'primary' as const, key: 'p', epoch: 1};
  event('primary.delta', {messageId: 'm1', index: 0, kind: 'text', delta: 'streaming'}, primary);
  event('primary.tool', {callId: 'c1', name: 'generic', phase: 'start', arguments: {value: {}, truncated: false}}, primary);
  event('primary.entry', {entry: {id: 'e-side', kind: 'notice', data: {value: 'side', truncated: false}}}, primary);
  event('primary.message', {message: {id: 'm1', role: 'assistant', parts: [textPart('streaming')], state: 'partial', coverage: coverageTiny}}, primary);
  flushFrames(); await settle();
  assert.equal(usageNode.writes, baseline);
  event('primary.message', {message: {id: 'm1', role: 'assistant', parts: [textPart('streaming')], state: 'final', coverage: coverageTiny,
    usage: {input: 4, cacheRead: 4, cacheWrite: 0}}}, primary);
  flushFrames(); await settle();
  assert.ok(usageNode.writes > baseline);
  assert.ok(descendants(usageNode).some(node => node.dataset.key === 'cacheTurnHit'));
  assert.ok(descendants(byId('primary-transcript')).some(node => node.textContent.includes('streaming')));
  const history = source.slice(source.indexOf('function applyPrimaryHistoryPage('), source.indexOf('function primaryHistoryFailure('));
  assert.ok(history.indexOf('renderPrimaryUsage(primary())') > history.indexOf('state = mergePrimaryPage'));
});
test('image URLs bind each transcript pane rather than the movable composer or active pane', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  event('primary.message', {message: {id: 'img1', role: 'user', parts: [imagePart('img1')], state: 'final', coverage}}, {kind: 'primary', key: 'p', epoch: 1});
  flushFrames(); await settle();
  const primaryImage = descendants(byId('primary-transcript')).find(node => node.tagName === 'img');
  assert.ok(primaryImage); assert.match(String(primaryImage.properties.get('src') ?? (primaryImage as {src?: string}).src ?? ''), /^\/api\/primaries\/p\/history\/image\?/);
  assert.match(String((primaryImage as {src?: string}).src ?? ''), /workspace=w/); assert.match(String((primaryImage as {src?: string}).src ?? ''), /epoch=1/);
  const frame: ProjectedFrame = {revision: 1, observedAt: '', entries: [entryFixture('img2', [messageFixture('img2', [imagePart('img2')])])], live: [], nextBefore: null, status: {busy: false}, coverage};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'a'}, panelVisible: true}, primaries: [primaryFixture()],
    roster: [agentFixture('a')], targets: [targetFixture('image-a', {kind: 'agent', identity: 'a'})], selectedFrame: frame});
  flushFrames(); await settle();
  const agentImage = descendants(byId('agent-transcript')).find(node => node.tagName === 'img');
  assert.ok(agentImage); assert.match(String((agentImage as {src?: string}).src ?? ''), /^\/api\/agents\/a\/history\/image\?/);
  assert.match(String((agentImage as {src?: string}).src ?? ''), /workspace=w/);
  assert.doesNotMatch(String((agentImage as {src?: string}).src ?? ''), /epoch/);
});
test('terse usage keeps context and cache groups together with accessible scope and hidden separators', () => {
  const facts = [{key: 'context', text: '?', title: 'Unknown context'}, {key: 'contextTokens', text: '?/1k', title: 'Estimated tokens'}, {key: 'cost', text: '$0.01', title: 'Reported cost'}, {key: 'cacheTurnHit', text: '●', title: 'Latest loaded assistant'}, {key: 'cacheHitShare', text: '50% hit', title: 'Loaded window only'}];
  const nodes = app.usageNodes({facts, contextFraction: null}, true);
  const groups = nodes.filter(node => node.className === 'usage-group');
  assert.equal(groups.length, 4); assert.equal(nodes.filter(node => node.className === 'usage-separator').length, 4);
  assert.equal(groups[0]?.children[0]?.tagName, 'meter'); assert.equal(groups[0]?.children[0]?.hidden, true); assert.equal(groups[0]?.children[1]?.textContent, '?');
  assert.deepEqual(Array.from(groups[3]?.children ?? [], node => node.textContent), ['●', '50% hit']);
  for (const group of groups) for (const node of group.children.filter(node => node.className === 'usage-fact')) assert.equal(node.attributes.get('aria-label'), node.title);
  for (const separator of nodes.filter(node => node.className === 'usage-separator')) { assert.equal(separator.textContent, '│'); assert.equal(separator.attributes.get('aria-hidden'), 'true'); }
  assert.equal(app.usageNodes({facts, contextFraction: .25}, false)[0]?.children[0]?.hidden, false);
  assert.equal(app.usageNodes({facts: [], contextFraction: null}, true).length, 0);
});
test('session reload restores the ready composer after dialog close without changing its draft', async () => {
  const saved = targetFixture('primary-draft', {kind: 'primary', key: 'p', epoch: 1}, {draft: {revision: 1, text: 'Retained session draft', mode: 'prompt', persisted: true}});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: saved.target}, primaries: [primaryFixture({activity: 'idle'})], roster: [], targets: [saved]});
  const editor = byId('primary-editor'); assert.equal(editor.value, 'Retained session draft');
  byId('project-button').focus(); byId('modal').showModal(); await app.reloadSelection(); byId('modal').close();
  assert.equal(hostDocument.activeElement, editor); assert.equal(editor.value, 'Retained session draft'); assert.equal(editor.disabled, false);
});
test('context menus capture inactive tabs and never close a later selection', async () => {
  const base = {primaries: [primaryFixture()], roster: [agentFixture('a'), agentFixture('b')], workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: {tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'a'}, {kind: 'agent', identity: 'b'}], active: 0, splitRatio: 50}}} as Fixture;
  await arrive(base); const tab = byId('conversation-tabs').children[1]; assert.ok(tab);
  const context = {target: tab, clientX: 1190, clientY: 790, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}, stopPropagation() {}};
  app.appContextMenu(context as never); assert.equal(context.defaultPrevented, true);
  const menu = hostDocument.body.children.find(node => node.className === 'context-menu'); assert.ok(menu);
  assert.deepEqual(menu.children.map(row => row.textContent), ['Activate', 'Close', 'Close others', 'Split beside Primary']);
  assert.equal(app.state.workspace?.conversationLayout?.active, 0);
  menu.children[1]?.click(); await settle(); assert.deepEqual(app.state.workspace?.conversationLayout?.tabs.map(tab => tab.kind === 'primary' ? 'primary' : tab.identity), ['primary', 'b']);
  await arrive(base); const stale = byId('conversation-tabs').children[1]; assert.ok(stale);
  app.appContextMenu({...context, target: stale, defaultPrevented: false} as never); const staleMenu = hostDocument.body.children.find(node => node.className === 'context-menu'); assert.ok(staleMenu);
  app.applyLayout({tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'a'}, {kind: 'agent', identity: 'b'}], active: 2, splitRatio: 50}); await settle();
  const saves = selectionSaves.length; staleMenu.children[1]?.click(); await settle(); assert.equal(selectionSaves.length, saves);
  assert.equal(app.state.workspace?.selectedTarget?.kind === 'agent' && app.state.workspace.selectedTarget.identity, 'b');
  assert.match(byId('announcements').textContent, /target changed/);
});
test('agent row and pane menus expose only their supported actions and text inputs keep native menus', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: [agentFixture('context-agent', {capabilities: {input: true, inspect: true}})]});
  const row = byId('roster').children.find(node => node.dataset.identity === 'context-agent'); assert.ok(row);
  const event = (target: HostNode) => ({target, clientX: 10, clientY: 50, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}, stopPropagation() {}});
  app.appContextMenu(event(row) as never); let menu = hostDocument.body.children.find(node => node.className === 'context-menu'); assert.ok(menu);
  assert.deepEqual(menu.children.map(row => row.textContent), ['Open', 'Open beside Primary', 'Message', 'Copy identity', 'Inspect activity…']); assert.equal(row.tabIndex, -1);
  contextMenu.close(); assert.equal(hostDocument.activeElement, row);
  const editor = byId('primary-editor'); const native = event(editor); app.appContextMenu(native as never); assert.equal(native.defaultPrevented, false); assert.equal(contextMenu.openNow, false);
  const pane = byId('primary'); pane.className = 'conversation'; app.appContextMenu(event(pane) as never); menu = hostDocument.body.children.find(node => node.className === 'context-menu'); assert.ok(menu);
  assert.equal(menu.children[0]?.textContent, 'Focus message box'); assert.equal(pane.tabIndex, -1);
  assert.ok(menu.children.every(row => !['Appearance', 'Help', 'Commands…', 'Refresh agent roster'].includes(row.textContent)));
  contextMenu.close(); assert.equal(hostDocument.activeElement, pane);
});
test('status settings use terse model and bracketed thinking text with full accessible names', () => {
  app.primaryChrome({cwd: '/fixture', lifecycle: 'ready', model: {provider: 'provider', id: 'model', name: 'Model', reasoning: false, input: ['text']}, thinkingLevel: 'high'} as PrimaryView);
  assert.equal(byId('model-button').textContent, 'model'); assert.equal(byId('model-button').title, 'provider/model · Primary'); assert.equal(byId('model-button').attributes.get('aria-label'), 'Model for Primary: provider/model');
  assert.equal(byId('thinking-button').textContent, '[high]'); assert.equal(byId('thinking-button').attributes.get('aria-label'), 'Thinking level for Primary: high');
});
