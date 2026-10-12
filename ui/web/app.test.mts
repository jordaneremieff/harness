import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, {after} from 'node:test';
import { contextMenu } from './context-menu.ts';
import type { AgentRow, ConversationLayout, ConversationTab, EntryView, MessageView, OperationView, PartView, PrimaryView, ProjectedFrame, Snapshot, Target, TargetState, Workspace } from '../shared/api.ts';
import type { Composer } from './composer.ts';
import { createPaneLayout, paneLeaves, movePaneTab, splitPane, validPaneLayout, activatePaneTab } from './pane-layout.ts';
import { tabKey } from './tabs.ts';

const source = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

// In-process browser host: the app module runs against a fake document, storage, event stream, and HTTP backend.
type Handler = (event: Record<string, unknown>) => void;
class HostNode {
  tagName: string;
  id = '';
  className = '';
  hidden = false;
  inert = false;
  disabled = false;
  value = '';
  title = '';
  tabIndex = 0;
  scrollTop = 0; scrollLeft = 0;
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
  get offsetLeft(): number { return 0; }
  get offsetWidth(): number { return this.clientWidth; }
  get offsetHeight(): number { if (this.hidden) return 0; if (this.classList.contains('spacer')) return Number.parseFloat((this.style as {height?: string}).height ?? '0') || 0; return this.classList.contains('entry') ? Number.parseFloat((this.style as {height?: string}).height ?? '140') : 20; }
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
  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value);
    if (key === 'id') this.id = value;
    else if (key === 'class') this.className = value;
    else if (key === 'hidden') this.hidden = true;
    else if (key === 'disabled') this.disabled = true;
    else if (key === 'tabindex') this.tabIndex = Number(value);
    else if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  removeAttribute(key: string): void { this.attributes.delete(key); if (key === 'hidden') this.hidden = false; if (key === 'disabled') this.disabled = false; }
  hasAttribute(key: string): boolean { return this.getAttribute(key) !== null; }
  getAttribute(key: string): string | null {
    if (key === 'id') return this.id || null;
    if (key === 'class') return [this.className, this.classText].join(' ').trim() || null;
    if (key === 'hidden') return this.hidden ? '' : null;
    if (key === 'disabled') return this.disabled ? '' : null;
    if (key.startsWith('data-')) return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] ?? null;
    return this.attributes.get(key) ?? null;
  }
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  removeEventListener(name: string, handler?: Handler): void { if (!handler) { this.handlers.delete(name); return; } const next = (this.handlers.get(name) ?? []).filter(item => item !== handler); if (next.length) this.handlers.set(name, next); else this.handlers.delete(name); }
  dispatch(name: string, event: Record<string, unknown> = {}): void {
    let stopped = false;
    const value = {target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; }, stopImmediatePropagation() { stopped = true; }, ...event};
    for (let node: HostNode | null = this; node; node = ['click', 'contextmenu', 'focusin', 'focusout', 'pointerdown'].includes(name) && !stopped ? node.parentNode : null) {
      for (const handler of node.handlers.get(name) ?? []) handler(value);
    }
    if (!stopped && ['click', 'contextmenu', 'focusin', 'focusout', 'pointerdown'].includes(name)) for (const handler of documentHandlers.get(name) ?? []) handler(value);
  }
  closest(selector: string): HostNode | null { return matchesHost(this, selector) ? this : this.parentNode?.closest(selector) ?? null; }
  querySelector(selector: string): HostNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): HostNode[] {
    const found: HostNode[] = [];
    for (const node of this.children) { if (matchesHost(node, selector)) found.push(node); found.push(...node.querySelectorAll(selector)); }
    return found;
  }
  getBoundingClientRect(): {top: number; bottom: number; left: number; right: number; width: number; height: number} {
    const width = rectWidth(this); const top = this.offsetTop;
    const height = this.id === 'conversation-panes' || this.classList.contains('pane-leaf') || this.classList.contains('pane-split') ? 640 : this.offsetHeight;
    return {top, bottom: top + height, left: 0, right: width, width, height};
  }
  focus(): void { if (hostDocument.activeElement !== this) { hostDocument.activeElement?.dispatch('blur'); hostDocument.activeElement = this; this.dispatch('focus'); this.dispatch('focusin'); } }
  blur(): void { if (hostDocument.activeElement === this) hostDocument.activeElement = null; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.dispatch('close'); }
  scrollIntoView(): void {}
  select(): void {}
  selectionStart = 0; selectionEnd = 0; selectionDirection = 'none';
  setSelectionRange(start: number, end: number, direction = 'none'): void { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  onclick: (() => void) | null = null;
  click(): void { if (this.disabled) return; this.dispatch('click'); this.onclick?.(); }
}
function matchesHost(node: HostNode, selector: string): boolean {
  if (selector.includes(',')) return selector.split(',').some(part => matchesHost(node, part.trim()));
  let base = selector.trim();
  const enabled = base.endsWith(':not(:disabled)'); if (enabled) base = base.slice(0, -':not(:disabled)'.length);
  const pieces = base.split(/\s+(?![^[]*\])/); const last = pieces.pop(); if (!last) return false;
  const tokens = last.match(/\[[^\]]+\]|[.#][\w-]+|^[\w-]+|\*/g) ?? [];
  const matched = tokens.length > 0 && tokens.every(token => {
    if (token === '*') return true;
    if (token.startsWith('.')) return node.classList.contains(token.slice(1));
    if (token.startsWith('#')) return node.id === token.slice(1);
    if (token.startsWith('[')) { const attribute = token.slice(1, -1).match(/^([^=]+)(?:=["']?([^"']*)["']?)?$/); return !!attribute && (attribute[2] === undefined ? node.hasAttribute(attribute[1] ?? '') : node.getAttribute(attribute[1] ?? '') === attribute[2]); }
    return node.tagName === token;
  });
  if (!matched || enabled && node.disabled) return false;
  if (!pieces.length) return true;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) if (matchesHost(ancestor, pieces.join(' '))) return true;
  return false;
}
const hostRoots: HostNode[] = [];
const hostIds = new Map<string, HostNode>();
const documentHandlers = new Map<string, Handler[]>();
const documentDispatches: string[] = [];
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
  getElementById: (id: string): HostNode | undefined => hostDocument.documentElement.querySelector(`#${id}`) ?? undefined,
  querySelector: (selector: string): HostNode | null => hostDocument.documentElement.querySelector(selector),
  querySelectorAll: (selector: string): HostNode[] => hostDocument.documentElement.querySelectorAll(selector),
  getSelection: () => ({isCollapsed: true, anchorNode: null, focusNode: null}),
  addEventListener: (name: string, handler: Handler) => { documentHandlers.set(name, [...documentHandlers.get(name) ?? [], handler]); },
  get defaultView() { return view; },
  removeEventListener: (name: string, handler: Handler) => { documentHandlers.set(name, (documentHandlers.get(name) ?? []).filter(item => item !== handler)); },
  dispatchEvent: (event: Event) => {documentDispatches.push(event.type); for (const handler of documentHandlers.get(event.type) ?? []) handler({target: hostDocument}); return true;},
};
hostRoots.push(hostDocument.documentElement);
const htmlStack: HostNode[] = [];
for (const token of html.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
  const tag = token[1] ?? ''; if (token[0].startsWith('</')) { while (htmlStack.length && htmlStack.pop()?.tagName !== tag) {} continue; }
  const node = tag === 'html' ? hostDocument.documentElement : tag === 'body' ? hostDocument.body : new HostNode(tag);
  for (const attribute of (token[2] ?? '').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attribute[1] ?? '', attribute[2] ?? '');
  if (node.id) hostIds.set(node.id, node);
  if (htmlStack.at(-1) && node !== hostDocument.documentElement) htmlStack.at(-1)?.append(node);
  if (!['meta', 'link', 'input', 'img', 'br', 'hr'].includes(tag)) htmlStack.push(node);
}
const view = {
  getComputedStyle: (node: HostNode) => ({paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px',
    width: `${node.id === 'conversation-splitter' ? host.splitter : 5}px`, maxHeight: '480px',
    getPropertyValue: (key: string) => key === '--palette-row-size' ? '24px' : ''}),
  requestAnimationFrame: (callback: FrameRequestCallback) => hostRequestAnimationFrame(callback),
  cancelAnimationFrame: (id: number) => hostCancelAnimationFrame(id),
  addEventListener: () => {}, removeEventListener: () => {},
  setTimeout: (callback: () => void, ms = 0): ReturnType<typeof setTimeout> | number => setTimeout(callback, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout> | number) => clearTimeout(handle),
  innerWidth: 1200, innerHeight: 800,
};
const host = {viewport: 1200, splitter: 5};
hostDocument.documentElement.classList.add('conversation');
function rectWidth(node: HostNode): number {
  if (node.id === 'conversation-panes') return host.viewport - (host.viewport >= 900 && !hostIds.get('sidebar')?.hidden ? 272 : 0);
  if (node.classList.contains('pane-leaf') || node.classList.contains('pane-split')) {
    const parent = node.parentNode;
    if (parent?.id === 'conversation-panes') return rectWidth(parent);
    if (parent?.classList.contains('pane-split')) return parent.dataset.axis === 'x' ? (rectWidth(parent) - 4) / 2 : rectWidth(parent);
  }
  return 600;
}
let frames: {id: number; callback: FrameRequestCallback}[] = [];
let frameCount = 0;
function hostRequestAnimationFrame(callback: FrameRequestCallback): number { const id = ++frameCount; frames.push({id, callback}); return id; }
function hostCancelAnimationFrame(id: number): void { frames = frames.filter(frame => frame.id !== id); }
function flushFrames(): void { for (let round = 0; round < 20 && frames.length; round++) { const pending = frames; frames = []; for (const frame of pending) frame.callback(0); } }
const storageValues = new Map<string, string>();
const hostSessionStorage = {getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { storageValues.set(key, value); }, removeItem: (key: string) => { storageValues.delete(key); }};
const streams: string[] = [];
const streamSources: FixtureEventSource[] = [];
const developmentSources: FixtureEventSource[] = [];
class FixtureEventSource {
  closed = false;
  onerror: (() => void) | undefined;
  private listeners = new Map<string, ((event: {data: string; lastEventId: string}) => void)[]>();
  constructor(url: string) {if (url.startsWith('/api/dev/events')) developmentSources.push(this); else {streams.push(url); streamSources.push(this);}}
  addEventListener(name: string, handler: (event: {data: string; lastEventId: string}) => void): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]);
  }
  close(): void { this.closed = true; }
  emit(name: string, data: unknown): void {
    const message = {data: JSON.stringify({at: '', data}), lastEventId: `boot:${++cursorSequence}`};
    for (const listener of this.listeners.get(name) ?? []) listener(message);
  }
}
type Fixture = {workspace: Workspace; primaries: PrimaryView[]; roster: AgentRow[]; targets?: TargetState[];
  selectedPage?: Snapshot['selectedPage']; observations?: Snapshot['observations']; history?: EntryView[]; pendingOperations?: OperationView[]};
function singlePane(tabs: ConversationTab[] = [{kind: 'primary'}], active = tabs[0] ? tabKey(tabs[0]) : null): ConversationLayout { return createPaneLayout(tabs, active); }
function twoPanes(identity: string, focusedPane = 'agent-pane', extra: ConversationTab[] = []): ConversationLayout {
  return {root: {kind: 'split', id: 'split-fixture', axis: 'x', ratio: 50,
    first: {kind: 'pane', id: 'primary-pane', tabs: [{kind: 'primary'}], active: 'primary'},
    second: {kind: 'pane', id: 'agent-pane', tabs: [{kind: 'agent', identity}, ...extra], active: `agent:${identity}`}}, focusedPane};
}
function observation(identity: string, frame?: ProjectedFrame, connectionEpoch = 1): NonNullable<Snapshot['observations']>[number] { return {identity, connectionEpoch, ...(frame ? {frame} : {})}; }
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
let fixture: Fixture = {workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: singlePane()}, primaries: [primaryFixture()], roster: [],
  targets: [targetFixture('startup-primary', {kind: 'primary', key: 'p', epoch: 1}, {draft: {revision: 1, text: 'Initial private draft', mode: 'steer', persisted: true}})]};
let cursorSequence = 1;
let eventSequence = 1;
let operationSerial = 0;
const selectionSaves: {body: Record<string, unknown>}[] = [];
let selectionFailure: {code: string; message: string; retry: 'capacity'} | undefined;
function snapshotOf(current: Fixture, sequence: number): Snapshot {
  return {bootId: 'boot', cursor: `boot:${sequence}`, workspace: current.workspace, primaries: current.primaries,
    roster: {rows: current.roster, nextCursor: null, scan: {state: 'ready', complete: true, visited: current.roster.length, skipped: 0, omitted: 0}, stale: false},
    dialogs: [], pendingOperations: current.pendingOperations ?? [], targetIndex: [], targets: current.targets,
    selectedPage: current.selectedPage, observations: current.observations ?? [], notices: [], omitted: []};
}
const transportLog: {method: string; path: string; body?: unknown; key?: string; workspace?: string | null}[] = [];
let startPreparation: ((identity: string) => Promise<Response>) | undefined;
let preferenceSave: ((path: string, body: Record<string, unknown>) => Promise<Response>) | undefined;
function applySelection(workspace: Workspace, body: Record<string, unknown>): Workspace {
  const {expectedRevision: _revision, selectedTarget, ...rest} = body;
  return {...workspace, ...rest, ...(selectedTarget === null ? {} : selectedTarget === undefined ? {} : {selectedTarget: selectedTarget as Workspace['selectedTarget']}),
    ...(selectedTarget === null ? {selectedTarget: undefined} : {}), revision: workspace.revision + 1} as Workspace;
}
function fixturePreparation(value: unknown): unknown {
  const target = value as Target; const row = target.kind === 'agent' ? fixture.roster.find(item => item.identity === target.identity) : undefined;
  let saved = fixture.targets?.find(item => JSON.stringify(item.target) === JSON.stringify(target));
  if (!saved) { saved = targetFixture(`prepared-${target.kind === 'agent' ? target.identity : `${target.key}-${target.epoch}`}`, target); fixture = {...fixture, targets: [...fixture.targets ?? [], saved]}; }
  return {targetState: saved, availability: row?.availability ?? 'stored', capabilities: row?.capabilities ?? {input: false, history: false, observe: false, configure: false, abort: false}};
}
function fixtureDraft(path: string, body?: Record<string, unknown>): unknown {
  const key = decodeURIComponent(path.split('/')[5] ?? ''); const saved = decodeURIComponent(path.split('/')[3] ?? '') === fixture.workspace.id ? fixture.targets?.find(item => item.targetKey === key) : undefined;
  const draft = {revision: Number(body?.expectedRevision ?? 0) + 1, text: String(body?.text ?? ''), mode: String(body?.mode ?? 'prompt'), persisted: true};
  if (saved) { fixture = {...fixture, targets: fixture.targets?.map(item => item === saved ? {...saved, draft} : item)}; queueMicrotask(() => event('draft.changed', {targetKey: key, target: saved.target, draft})); }
  return draft;
}
function fixtureView(path: string, body: Record<string, unknown>): unknown {
  const revision = Number(body.expectedRevision ?? 0) + 1, kind = path.endsWith('/reading') ? 'reading' : 'presentation';
  const value = kind === 'reading' ? {revision, anchorId: body.anchorId ?? null, offsetPx: body.offsetPx ?? 0, followTail: body.followTail ?? true} : {revision, expanded: body.expanded ?? [], showThinking: body.showThinking ?? false, transcriptView: body.transcriptView ?? 'chronological'};
  if (decodeURIComponent(path.split('/')[3] ?? '') === fixture.workspace.id) fixture = {...fixture, targets: fixture.targets?.map(saved => saved.targetKey === decodeURIComponent(path.split('/')[5] ?? '') ? {...saved, [kind]: value} : saved)};
  return value;
}
function fixtureTarget(path: string): TargetState {
  assert.equal(decodeURIComponent(path.split('/')[3] ?? ''), fixture.workspace.id);
  const saved = fixture.targets?.find(item => item.targetKey === decodeURIComponent(path.split('/')[5] ?? '')); assert.ok(saved); return saved;
}
function fixtureRead(path: string, body?: Record<string, unknown>): unknown {
  if (path === '/api/bootstrap') return {...snapshotOf(fixture, ++cursorSequence), limits: {}};
  if (path === '/api/snapshot') return snapshotOf(fixture, ++cursorSequence);
  if (/^\/api\/primaries\/[^/]+\/history(?!.*output)/.test(path)) { const primary = fixture.primaries.find(item => item.key === decodeURIComponent(path.split('/')[3] ?? '')); assert.ok(primary); return {target: {kind: 'primary', key: primary.key, epoch: primary.epoch}, items: fixture.history ?? [], nextCursor: null, coverage}; }
  if (/^\/api\/agents\/[^/]+\/history$/.test(path)) return {target: {kind: 'agent', identity: path.split('/')[3] ?? ''}, entries: [], nextBefore: null, coverage, revision: 'r'};
  if (path === '/api/operations') return {operationId: `op-${++operationSerial}`};
  if (path === '/api/agents/refresh') return {};
  if (path === '/api/agents') return snapshotOf(fixture, cursorSequence).roster;
  if (path.includes('/resources/')) return {items: [], nextCursor: null, revision: 'r'};
  if (path.endsWith('/draft')) return fixtureDraft(path, body);
  if (/\/(reading|presentation)$/.test(path)) return fixtureView(path, body ?? {});
  if (path.includes('/targets/')) return fixtureTarget(path);
  throw new Error(`No fixture for ${path}`);
}
function fixtureSelectionResponse(path: string, body: Record<string, unknown> | undefined): Response {
  assert.equal(path, `/api/workspaces/${fixture.workspace.id}/selection`);
  if (selectionFailure) return Response.json({ok: false, error: selectionFailure});
  selectionSaves.push({body: body ?? {}});
  fixture = {...fixture, workspace: applySelection(fixture.workspace, body ?? {})};
  return Response.json({ok: true, data: fixture.workspace});
}
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), 'http://ui.test/app'); const path = url.pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>;
  const starting = /^\/api\/agents\/[^/]+\/start$/.test(path);
  transportLog.push({method, path, body, ...(starting ? {key: new Headers(init?.headers).get('Idempotency-Key') ?? '', workspace: url.searchParams.get('workspace')} : {})});
  if (starting && startPreparation) return startPreparation(decodeURIComponent(path.split('/')[3] ?? ''));
  if (method === 'PUT' && path.endsWith('/presentation') && preferenceSave) return preferenceSave(path, body ?? {});
  if (method === 'PUT' && path.endsWith('/selection')) return fixtureSelectionResponse(path, body);
  if (/^\/api\/workspaces\/[^/]+\/targets$/.test(path)) return Response.json({ok: true, data: fixturePreparation(body?.target)});
  return Response.json({ok: true, data: fixtureRead(path, body)});
};
Object.assign(globalThis, {
  document: hostDocument, HTMLElement: HostNode, window: view, location: {href: 'http://ui.test/app?workspace=w', hash: ''},
  history: {replaceState() {}}, sessionStorage: hostSessionStorage, matchMedia: (query: string) => ({matches: query === '(min-width: 900px)' && host.viewport >= 900, addEventListener() {}, removeEventListener() {}}),
  getComputedStyle: view.getComputedStyle, requestAnimationFrame: hostRequestAnimationFrame, cancelAnimationFrame: hostCancelAnimationFrame,
  ResizeObserver: class {observe(): void {} unobserve(): void {} disconnect(): void {}},
  MutationObserver: class {observe(): void {} disconnect(): void {}},
  EventSource: FixtureEventSource,
  innerWidth: 1200, innerHeight: 800,
});
try { globalThis.navigator = {};} catch { /* Node exposes a read-only navigator; nothing under test reads it. */ }
const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const intervals = new Set<ReturnType<typeof setInterval>>();
const timers = new Set<ReturnType<typeof setTimeout>>();
Object.assign(globalThis, {setTimeout: (callback: () => void, delay = 0) => {
  const timer = nativeSetTimeout(() => {timers.delete(timer); callback();}, delay); timers.add(timer); return timer;
}, setInterval: (callback: () => void, delay = 0) => {
  const timer = nativeSetInterval(callback, delay); intervals.add(timer); return timer;
}});
after(() => {for (const timer of timers) clearTimeout(timer); for (const timer of intervals) clearInterval(timer); timers.clear(); intervals.clear(); frames = [];});
hostDocument.hidden = true;
const startupMetadata = ['ui-generation', 'ui-client'].map((name, index) => {
  const meta = new HostNode('meta'), content = (index ? 'c' : 'a').repeat(index ? 24 : 64);
  meta.setAttribute('name', name); meta.setAttribute('content', content); Reflect.set(meta, 'content', content); hostDocument.documentElement.append(meta); return meta;
});
const app = await import('./app.ts');
const byId = (id: string): HostNode => {
  const node = hostDocument.getElementById(id);
  assert.ok(node, id);
  return node as HostNode;
};
async function settle(): Promise<void> { for (let round = 0; round < 4; round++) { flushFrames(); await new Promise(resolve => setImmediate(resolve)); } flushFrames(); }
function controls(composer: Composer): (key: string) => HostNode {
  const editor = composer.editor as unknown as HostNode, form = editor.closest('form'); assert.ok(form);
  const root = form.closest('.conversation');
  const selectors: Record<string, string> = {queued: '.queued-list', 'start-command': '.agent-start-help details pre', 'start-disclosure': '.agent-start-help details'};
  return key => {
    if (key === 'editor') return editor;
    if (key === 'composer') return form;
    if (key === 'root') { assert.ok(root); return root; }
    const selector = selectors[key];
    const node = form.querySelector(`#${form.id}-${key}`) ?? root?.querySelector(`[id="${root.id}-${key}"]`) ?? hostDocument.getElementById(`${form.id}-${key}`) ?? (selector ? root?.querySelector(selector) : null);
    assert.ok(node, `Missing scoped ${key} for ${form.id}`); return node;
  };
}
const primaryControl = (key: string) => controls(app.primaryComposer())(key);
const agentControl = (key: string) => controls(app.agentComposer())(key);
function messageControl(key: string): HostNode {
  const form = byId('agent-message-panel').querySelector('form'); assert.ok(form);
  const node = key === 'composer' ? form : form.querySelector(`#${form.id}-${key}`); assert.ok(node, `Missing Message ${key}`); return node;
}
function paneNode(id: string): HostNode { const node = byId('conversation-panes').querySelector(`[data-pane-id="${id}"]`); assert.ok(node); return node; }
function tabsNode(pane = app.focusedPane): HostNode { const node = paneNode(pane).querySelector('.conversation-tabs'); assert.ok(node); return node; }
function menuNode(): HostNode { const node = hostDocument.body.querySelector('.context-menu'); assert.ok(node); return node; }
function pressContext(target: HostNode): void { target.dispatch('contextmenu', {clientX: 10, clientY: 50}); }
async function arrive(next: Fixture): Promise<void> {
  if (next.workspace.conversationLayout) assert.ok(validPaneLayout(next.workspace.conversationLayout));
  assert.ok((next.observations?.length ?? 0) <= 4);
  const selected = next.workspace.selectedTarget;
  const tabs: ConversationTab[] = [...(next.workspace.primaryKey ? [{kind: 'primary' as const}] : []), ...(selected?.kind === 'agent' ? [{kind: 'agent' as const, identity: selected.identity}] : [])];
  const conversationLayout = next.workspace.conversationLayout ?? singlePane(tabs, selected?.kind === 'agent' ? `agent:${selected.identity}` : tabs[0] ? tabKey(tabs[0]) : null);
  fixture = {...next, workspace: {...next.workspace, conversationLayout, revision: Math.max(next.workspace.revision, (app.state.workspace?.revision ?? 0) + 1)}};
  await app.reload();
  await settle();
}
function event(name: string, data: unknown, target?: {kind: 'primary'; key: string; epoch: number}): void {
  cursorSequence = Math.max(cursorSequence + 1, ++eventSequence + 1000);
  app.receive({name: name as never, id: `boot:${cursorSequence}`, envelope: {at: '', ...(target ? {target} : {}), data} as never, bytes: 64});
}
function descendants(node: HostNode): HostNode[] { return [...node.children, ...node.children.flatMap(descendants)]; }

await test('initial hidden startup and its retired ready wait initialize once after fresh ready and restored checkpoint', async t => {
  const fetch = globalThis.fetch, restore = Promise.withResolvers<Response>(), ack = Promise.withResolvers<Response>();
  const devResponse = () => Response.json({ok: true, data: {revision: 1, generation: 'a'.repeat(64), previous: null, change: 'reload', status: 'ready', code: 'none'}});
  let armed = false, restoreReads = 0, acknowledgments = 0; let restoredResponse: Response | undefined;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname;
    if (path === '/api/dev/diagnostics' || path === '/api/dev/release') return devResponse();
    if (path === '/api/dev/ack') {acknowledgments++; return ack.promise;}
    if (armed && (init?.method ?? 'GET') === 'GET' && path.includes('/targets/')) {armed = false; restoreReads++; restoredResponse = await fetch(input, init); return restore.promise;}
    return fetch(input, init);
  };
  t.after(async () => {if (restoredResponse) restore.resolve(restoredResponse); ack.resolve(devResponse()); hostDocument.hidden = false; for (const meta of startupMetadata) meta.remove(); globalThis.fetch = fetch; for (const source of developmentSources) source.close(); await settle();});
  await settle(); assert.equal(streamSources.length, 0); assert.equal(developmentSources.length, 0); assert.equal(documentDispatches.filter(name => name === 'ui-ready').length, 0);
  pageHidden(false); await settle(); const initial = streamSources.at(-1); assert.ok(initial); assert.equal(primaryControl('send').disabled, true);
  pageHidden(true); await settle(); assert.equal(initial.closed, true); initial.emit('ready', {bootId: 'boot'}); await settle(); assert.equal(developmentSources.length, 0); assert.equal(documentDispatches.filter(name => name === 'ui-ready').length, 0);
  pageHidden(false); await settle(); const fresh = streamSources.at(-1); assert.ok(fresh); assert.notEqual(fresh, initial); assert.equal(primaryControl('send').disabled, true);
  const checkpoint = {...app.captureDevCheckpoint(), version: 1, generation: 'a'.repeat(64), oldClient: 'b'.repeat(24), capturedAt: Date.now(), interactionRevision: 0};
  hostSessionStorage.setItem('ui:dev-checkpoint', JSON.stringify(checkpoint)); armed = true;
  assert.equal(restoreReads, 0); assert.equal(acknowledgments, 0); fresh.emit('ready', {bootId: 'boot'}); await settle();
  assert.equal(restoreReads, 1); assert.equal(acknowledgments, 0); assert.equal(developmentSources.length, 0); assert.equal(documentDispatches.filter(name => name === 'ui-ready').length, 0); assert.ok(restoredResponse);
  restore.resolve(restoredResponse); await settle(); assert.equal(acknowledgments, 1); assert.equal(documentDispatches.filter(name => name === 'ui-ready').length, 0);
  ack.resolve(devResponse()); await settle(); assert.equal(developmentSources.length, 1); assert.equal(documentDispatches.filter(name => name === 'ui-ready').length, 1); assert.equal(hostSessionStorage.getItem('ui:dev-checkpoint'), null);
  pageHidden(true); pageHidden(false); await settle(); streamSources.at(-1)?.emit('ready', {bootId: 'boot'}); await settle();
  assert.equal(developmentSources.length, 1); assert.equal(acknowledgments, 1); assert.equal(documentDispatches.filter(name => name === 'ui-ready').length, 1);
});

async function devHookFixture(workspace: string, epoch: number): Promise<{primary: TargetState; agent: TargetState}> {
  const identity = `${workspace}-agent`, primary = targetFixture(`${workspace}-primary`, {kind: 'primary', key: 'p', epoch}, {draft: {revision: 3, text: 'Primary private draft', mode: 'steer', persisted: true}, presentation: {revision: 5, expanded: [], showThinking: false, transcriptView: 'chronological'}});
  const agent = targetFixture(`${workspace}-agent`, {kind: 'agent', identity}, {draft: {revision: 3, text: 'Agent private draft', mode: 'prompt', persisted: true}, presentation: {revision: 5, expanded: [], showThinking: false, transcriptView: 'chronological'}});
  await arrive({workspace: {id: workspace, revision: 1, primaryKey: 'p', selectedTarget: agent.target, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch})], roster: [agentFixture(identity)], targets: [primary, agent], observations: [observation(identity, {revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: false}, coverage}, 10)], history: Array.from({length: 20}, (_, index) => entryFixture(`dev-history-${index}`, [messageFixture(`dev-message-${index}`, [textPart(`Development history ${index}`)])]))});
  return {primary, agent};
}
function devCheckpoint(): import('./dev-reload.ts').DevReloadCheckpoint {
  return {...app.captureDevCheckpoint(), version: 1, generation: 'a'.repeat(64), oldClient: 'b'.repeat(24), capturedAt: 1, interactionRevision: 0};
}

test('development checkpoint captures exact owners and rejects workspace, recipient and revision changes', async t => {
  const saved = await devHookFixture('dev-capture', 9660), original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original; byId('agent-message-close').click();});
  app.focusPane('primary-pane'); await settle(); app.openTabActions('agent-pane'); const message = menuNode().children.find(node => node.textContent === 'Message'); assert.ok(message); message.click(); await settle();
  const editor = messageControl('editor'); editor.focus(); editor.setSelectionRange(2, 7, 'backward'); const checkpoint = devCheckpoint();
  assert.equal(checkpoint.workspaceId, 'dev-capture'); assert.equal(checkpoint.targets.length, 2); assert.equal(checkpoint.messageRecipient, saved.agent.targetKey); assert.deepEqual(checkpoint.focusedControl, {targetKey: saved.agent.targetKey, kind: 'message'});
  assert.deepEqual(checkpoint.targets.map(entry => entry.targetKey).sort(), [saved.primary.targetKey, saved.agent.targetKey].sort()); assert.doesNotMatch(JSON.stringify(checkpoint), /private draft|Development history/);
  const signal = new AbortController().signal; assert.equal(await app.restoreDevCheckpoint({...checkpoint, workspaceId: 'other-workspace'}, signal), false);
  for (const mismatch of ['draft', 'reading', 'presentation', 'identity', 'unconfirmed'] as const) {
    globalThis.fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'GET' && new URL(String(input), 'http://ui.test').pathname.endsWith(`/targets/${saved.agent.targetKey}`)) {
        const value = fixture.targets?.find(item => item.targetKey === saved.agent.targetKey); assert.ok(value); assert.ok(value.presentation);
        const changed = mismatch === 'identity' ? {...value, target: {kind: 'agent', identity: 'wrong-recipient'}} : mismatch === 'unconfirmed' ? {...value, unconfirmed: [{operationId: 'held'}]} : {...value, [mismatch]: {...value[mismatch], revision: value[mismatch].revision + 1}};
        return Response.json({ok: true, data: changed});
      }
      return original(input, init);
    };
    assert.equal(await app.restoreDevCheckpoint(checkpoint, signal), false); assert.equal(messageControl('editor'), editor); assert.equal(editor.value, 'Agent private draft'); assert.equal(hostDocument.activeElement, editor);
  }
  globalThis.fetch = original; assert.equal(await app.restoreDevCheckpoint({...checkpoint, messageRecipient: saved.primary.targetKey}, signal), false);
  assert.equal(await app.restoreDevCheckpoint(checkpoint, signal), true); assert.equal(messageControl('editor'), editor); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']); assert.deepEqual(app.state.workspace?.selectedTarget, saved.primary.target);
});

test('development restoration accepts a fresh Agent epoch but refuses later epochs and newer buffers during target reads', async t => {
  const saved = await devHookFixture('dev-race', 9661); assert.equal(saved.agent.target.kind, 'agent'); const identity = (saved.agent.target as {identity: string}).identity;
  const checkpoint = devCheckpoint(), original = globalThis.fetch; t.after(async () => {globalThis.fetch = original; await app.drainDev(new AbortController().signal);});
  fixture = {...fixture, observations: [observation(identity, {revision: 2, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: false}, coverage}, 11)]}; await app.reload(); await settle();
  assert.equal(app.state.conversations.get(JSON.stringify(['agent', identity]))?.connectionEpoch, 11); assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), true);
  for (const race of ['epoch', 'draft', 'buffer'] as const) {
    const activeCheckpoint = devCheckpoint();
    const response = Promise.withResolvers<Response>(); const value = fixture.targets?.find(item => item.targetKey === saved.agent.targetKey); assert.ok(value);
    globalThis.fetch = async (input, init) => (init?.method ?? 'GET') === 'GET' && new URL(String(input), 'http://ui.test').pathname.endsWith(`/targets/${saved.agent.targetKey}`) ? response.promise : original(input, init);
    const restore = app.restoreDevCheckpoint(activeCheckpoint, new AbortController().signal); await settle(); const editor = agentControl('editor');
    if (race === 'epoch') {fixture = {...fixture, observations: [observation(identity, {revision: 3, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: false}, coverage}, 12)]}; await app.reload(); await settle();}
    else if (race === 'draft') {const draft = {...value.draft, revision: value.draft.revision + 1, text: 'Newer server draft'}; fixture = {...fixture, targets: fixture.targets?.map(item => item.targetKey === saved.agent.targetKey ? {...item, draft} : item)}; event('draft.changed', {targetKey: saved.agent.targetKey, target: saved.agent.target, draft});}
    else {editor.value = 'Newer local draft'; editor.dispatch('input');}
    const current = app.state.targets.get(saved.agent.targetKey); response.resolve(Response.json({ok: true, data: value})); assert.equal(await restore, false); await settle(); if (race === 'buffer') assert.ok((app.state.targets.get(saved.agent.targetKey)?.draft.revision ?? 0) >= value.draft.revision); else assert.equal(app.state.targets.get(saved.agent.targetKey), current);
    if (race === 'epoch') assert.equal(app.state.conversations.get(JSON.stringify(['agent', identity]))?.connectionEpoch, 12);
    else if (race === 'draft') {assert.equal(editor.value, 'Newer server draft'); assert.equal(app.state.targets.get(saved.agent.targetKey)?.draft.text, 'Newer server draft');}
    else assert.equal(editor.value, 'Newer local draft');
    globalThis.fetch = original;
  }
});

test('development drain waits for retained drafts, view preferences and selection without transferring buffers', async t => {
  await devHookFixture('dev-drain', 9662); const primary = app.primaryComposer(), agent = app.agentComposer(), p = controls(primary), a = controls(agent), original = globalThis.fetch;
  const held: {path: string; finish: () => Promise<void>}[] = []; let holding = true;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname;
    if (holding && init?.method === 'PUT' && /\/(draft|reading|presentation|selection)$/.test(path)) {const response = Promise.withResolvers<Response>(); assert.ok(held.length < 8); held.push({path, finish: async () => {response.resolve(await original(input, init));}}); return response.promise;}
    return original(input, init);
  };
  t.after(async () => {holding = false; await Promise.all(held.map(item => item.finish())); globalThis.fetch = original; await app.drainDev(new AbortController().signal);});
  const pe = p('editor'), ae = a('editor'); pe.value = 'Primary queued draft'; pe.dispatch('input'); ae.value = 'Agent queued draft'; ae.dispatch('input');
  const scroller = p('transcript'); scroller.scrollTop = 180; scroller.dispatch('scroll'); flushFrames(); scroller.dispatch('scrollend');
  app.openTabActions('primary-pane'); const grouped = menuNode().children.find(node => node.textContent === 'View: Grouped'); assert.ok(grouped); grouped.click(); await settle();
  app.applyLayout(singlePane()); await settle(); assert.equal(agent.canDispose, false);
  const aborted = new AbortController(); aborted.abort(new Error('Drain cancelled')); await assert.rejects(app.drainDev(aborted.signal), /Drain cancelled/);
  let done = false; const drain = app.drainDev(new AbortController().signal).then(() => {done = true;}); await settle(); assert.equal(done, false);
  const selection = held.find(item => item.path.endsWith('/selection')); assert.ok(selection); await selection.finish(); await settle(); assert.equal(done, false);
  assert.equal(held.filter(item => item.path.endsWith('/draft')).length, 2); assert.ok(held.some(item => item.path.endsWith('/reading'))); assert.ok(held.some(item => item.path.endsWith('/presentation')));
  holding = false; await Promise.all(held.filter(item => item !== selection).map(item => item.finish())); await drain; await settle();
  assert.equal(primary.unsaved, false); assert.equal(agent.unsaved, false); assert.equal(pe.value, 'Primary queued draft'); assert.equal(ae.value, 'Agent queued draft'); assert.equal(p('editor'), pe); assert.equal(a('editor'), ae); assert.equal(app.selectionQueue.unsettled, false);
});

test('development CSS hooks retain cards, editors, carets and the same reading anchor', async () => {
  await devHookFixture('dev-css', 9663); const p=controls(app.primaryComposer()),a=controls(app.agentComposer()),pe=p('editor'),ae=a('editor'),forms=[p('composer'),a('composer')],root=p('transcript');
  root.scrollTop=857;root.dispatch('scroll');flushFrames();const card=root.querySelector('[data-entry-id="dev-history-6"]'),before=root.querySelector('[data-entry-id="dev-history-5"]');assert.ok(card);assert.ok(before);
  root.scrollTop=card.offsetTop-root.offsetTop+17;root.dispatch('scroll');root.dispatch('scrollend');await settle();pe.focus();pe.setSelectionRange(2,7,'backward');ae.setSelectionRange(1,6,'forward');
  const offset=root.scrollTop-(card.offsetTop-root.offsetTop),captured=app.captureDevCssState();(before.style as {height?:string}).height='260px';app.applyDevCssState(captured);await settle();
  assert.equal(root.querySelector('[data-entry-id="dev-history-6"]'),card);assert.equal(root.scrollTop-(card.offsetTop-root.offsetTop),offset);assert.equal(p('editor'),pe);assert.equal(a('editor'),ae);assert.equal(p('composer'),forms[0]);assert.equal(a('composer'),forms[1]);
  assert.deepEqual([pe.selectionStart,pe.selectionEnd,pe.selectionDirection],[2,7,'backward']);assert.deepEqual([ae.selectionStart,ae.selectionEnd,ae.selectionDirection],[1,6,'forward']);assert.equal(pe.value,'Primary private draft');assert.equal(ae.value,'Agent private draft');assert.equal(hostDocument.activeElement,pe);
});

test('shell element references match the shared DOM contract', () => {
  for (const match of source.matchAll(/byId(?:<[^>]+>)?\('([^']+)'\)/g)) assert.ok(html.includes(`id="${match[1]}"`), `Missing ${match[1]}`);
  assert.doesNotMatch(source, /byId\('(?:agent-panel|agents-button|agent-back|agent-close|agent-detail-close)'\)/);
  assert.match(source, /commands: \(\) => actions\.commandOptions\(\)/);
});
test('section changes hide retained nodes and explicit skip navigation focuses the selected editor', async () => {
  const row = agentFixture('skip-agent'); await arrive({workspace: {id:'w',revision:1,primaryKey:'p',conversationLayout:singlePane([{kind:'primary'},{kind:'agent',identity:row.identity}])},primaries:[primaryFixture({epoch:700})],roster:[row]});
  const primary=controls(app.primaryComposer()),root=primary('root'),editor=primary('editor'); await app.selectAgent(row); await settle();
  assert.equal(root.hidden,true); byId('skip-composer').click(); assert.equal(hostDocument.activeElement,agentControl('editor'));
  byId('primary-row').click(); await settle(); byId('skip-composer').click(); assert.equal(primaryControl('root'),root); assert.equal(primaryControl('editor'),editor); assert.equal(root.hidden,false); assert.equal(hostDocument.activeElement,editor);
});
test('earlier-history loads expose pending and result states without restoring an old saved anchor', async t => {
  const original = globalThis.fetch, target = {kind: 'primary' as const, key: 'p', epoch: 699};
  const pending = Array.from({length: 3}, () => Promise.withResolvers<Response>()), cursors: (string | null)[] = [];
  const entries = Array.from({length: 20}, (_, index) => entryFixture(`feedback-${index}`, [messageFixture(`feedback-message-${index}`, [textPart(`Feedback entry ${index}`)])]));
  const saved = targetFixture('history-feedback', target, {reading: {revision: 7, anchorId: 'feedback-6', offsetPx: 17, followTail: false}});
  t.after(() => {globalThis.fetch = original; for (const response of pending) response.resolve(Response.json({ok: true, data: {target, items: [], nextCursor: null, coverage}}));});
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname !== '/api/primaries/p/history') return original(input, init);
    const cursor = url.searchParams.get('cursor'); cursors.push(cursor);
    if (!cursor) return Response.json({ok: true, data: {target, items: entries, nextCursor: 'older', coverage}});
    const response = pending[cursors.filter(value => value !== null).length - 1]; assert.ok(response); return response.promise;
  };
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: [], targets: [saved]});
  const scroller = primaryControl('transcript'), earlier = primaryControl('earlier'), notice = primaryControl('view-notice');
  earlier.click(); await settle(); assert.equal(earlier.disabled, true); assert.equal(earlier.getAttribute('aria-label'), 'Loading earlier messages'); assert.equal(earlier.getAttribute('aria-busy'), 'true');
  pending[0]?.resolve(Response.json({ok: false, error: {code: 'capacity', message: 'Earlier unavailable', retry: 'manual'}})); await settle();
  assert.equal(earlier.disabled, false); assert.equal(earlier.getAttribute('aria-label'), 'Earlier messages'); assert.equal(earlier.getAttribute('aria-busy'), null); assert.match(notice.textContent, /[Hh]istory could not be loaded.*Retry history/); assert.equal(notice.querySelector('summary')?.getAttribute('aria-label'), 'History error details'); assert.equal(notice.querySelector('summary svg')?.getAttribute('class'), 'card-icon card-icon-info');
  earlier.click(); await settle(); const anchor = scroller.querySelector('[data-entry-id="feedback-6"]'); assert.ok(anchor);
  scroller.scrollTop = anchor.offsetTop - scroller.offsetTop + 77; scroller.dispatch('scroll'); flushFrames();
  pending[1]?.resolve(Response.json({ok: true, data: {target, items: [entryFixture('feedback-older', [messageFixture('feedback-older-message', [textPart('Earlier feedback')])])], nextCursor: 'oldest', coverage}})); await settle();
  assert.match(byId('announcements').textContent, /Earlier entries loaded/); assert.equal(app.state.conversations.get(JSON.stringify(['primary', 'p', 699]))?.entries.has('feedback-older'), true); assert.equal(earlier.disabled, false); assert.equal(scroller.querySelector('[data-entry-id="feedback-6"]'), anchor); assert.equal(scroller.scrollTop - (anchor.offsetTop - scroller.offsetTop), 77);
  earlier.click(); await settle(); await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'new-history-owner'}, primaries: [primaryFixture({key: 'new-history-owner', epoch: 698})], roster: []});
  const currentNotice = primaryControl('view-notice'); currentNotice.textContent = 'Current owner notice';
  pending[2]?.resolve(Response.json({ok: true, data: {target, items: [entryFixture('feedback-too-late', [])], nextCursor: null, coverage}})); await settle();
  assert.equal(currentNotice.textContent, 'Current owner notice'); assert.equal(app.state.conversations.get(JSON.stringify(['primary', 'p', 699]))?.entries.has('feedback-too-late'), false); assert.deepEqual(cursors, [null, 'older', 'older', 'oldest']);
});
test('initial primary history pages to the saved anchor without a full-session request', async () => {
  const fetch = globalThis.fetch; const calls: (string | null)[] = []; const epoch = 701;
  const saved = targetFixture('anchor-pages', {kind: 'primary', key: 'p', epoch}, {reading: {revision: 7, anchorId: 'saved-anchor', offsetPx: 17, followTail: false}});
  const row = (id: string) => entryFixture(id, [messageFixture(`m-${id}`, [textPart(id)])]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname === '/api/primaries/p/history') {
      assert.equal(url.searchParams.get('limit'), '50'); const cursor = url.searchParams.get('cursor'); calls.push(cursor);
      const items = cursor === 'older' ? [row('saved-anchor')] : [row('recent-anchor')];
      return Response.json({ok: true, data: {target: saved.target, items, nextCursor: cursor ? 'start' : 'older', coverage}});
    }
    return fetch(input, init);
  };
  try {
    await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch})], roster: [], targets: [saved]});
    assert.deepEqual(calls, [null, 'older']);
    assert.equal(app.state.conversations.get(JSON.stringify(['primary', 'p', epoch]))?.entries.has('saved-anchor'), true);
    const anchor = primaryControl('transcript').querySelector('.entry'); assert.ok(anchor);
    assert.equal(primaryControl('transcript').scrollTop, anchor.offsetTop - primaryControl('transcript').offsetTop + 17);
  } finally {globalThis.fetch = fetch;}
});
test('a user scroll during saved-anchor paging wins over the late earlier response', async () => {
  const fetch = globalThis.fetch; const calls: (string | null)[] = []; const epoch = 702;
  const pending = Promise.withResolvers<Response>(); const started = Promise.withResolvers<void>();
  const saved = targetFixture('anchor-interrupt', {kind: 'primary', key: 'p', epoch}, {reading: {revision: 7, anchorId: 'absent-anchor', offsetPx: 17, followTail: false}});
  const row = (id: string) => entryFixture(id, [messageFixture(`m-${id}`, [textPart(id)])]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname === '/api/primaries/p/history') {
      const cursor = url.searchParams.get('cursor'); calls.push(cursor);
      if (cursor) {started.resolve(); return pending.promise;}
      return Response.json({ok: true, data: {target: saved.target, items: Array.from({length: 20}, (_, at) => row(`recent${at}`)), nextCursor: 'older', coverage}});
    }
    return fetch(input, init);
  };
  try {
    await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch})], roster: [], targets: [saved]});
    await started.promise; const root = primaryControl('transcript'); root.scrollTop = 280; root.dispatch('scroll'); flushFrames();
    pending.resolve(Response.json({ok: true, data: {target: saved.target, items: [row('absent-anchor')], nextCursor: 'start', coverage}})); await settle();
    assert.deepEqual(calls, [null, 'older']); assert.notEqual(root.scrollTop, 17);
    assert.equal(primaryControl('latest').hidden, false);
  } finally {globalThis.fetch = fetch;}
});

test('a non-split agent round trip keeps the loaded primary anchor and earlier page', async () => {
  const epoch = 703; const target = {kind: 'primary' as const, key: 'p', epoch};
  const current = primaryFixture({epoch, sessionId: 'retained-session', sessionFile: '/fixture/project/retained.jsonl'});
  const earlier = entryFixture('retained-earlier', [messageFixture('retained-message', [textPart('Earlier code stays available')])]);
  const leaf = entryFixture('retained-leaf', [messageFixture('retained-last', [textPart('Latest history')])]);
  const saved = targetFixture('anchor-roundtrip', target, {reading: {revision: 7, anchorId: earlier.id, offsetPx: 17, followTail: false}});
  const agent = agentFixture('anchor-observer', {availability: 'stored'}); const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname === '/api/primaries/p/history') {
      const cursor = url.searchParams.get('cursor');
      return Response.json({ok: true, data: {target, items: cursor ? [earlier] : [leaf], nextCursor: cursor ? null : 'earlier', coverage}});
    }
    return fetch(input, init);
  };
  try {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: singlePane()}, primaries: [current], roster: [agent], targets: [saved], history: [earlier, leaf], selectedPage: {target, items: [leaf], nextCursor: 'earlier', coverage}});
  const root = primaryControl('transcript'); const anchor = root.querySelector('[data-entry-id="retained-earlier"]'); assert.ok(anchor); const offset = root.scrollTop - (anchor.offsetTop - root.offsetTop); assert.match(root.textContent, /Earlier code stays available/);
  assert.equal(primaryControl('earlier').hidden, true);
  fixture = {...fixture, selectedPage: {target: {kind: 'agent', identity: agent.identity}, entries: [], nextBefore: null, coverage, revision: 'r'}};
  await app.selectAgent(agent); await settle(); assert.equal(primaryControl('root').hidden, true);
  fixture = {...fixture, history: [leaf], selectedPage: {target, items: [leaf], nextCursor: 'earlier', coverage}};
  byId('primary-row').click(); await settle();
  assert.equal(primaryControl('root').hidden, false); assert.match(root.textContent, /Earlier code stays available/); assert.equal(root.querySelector('[data-entry-id="retained-earlier"]'), anchor); assert.equal(root.scrollTop - (anchor.offsetTop - root.offsetTop), offset);
  assert.equal(app.state.conversations.get(JSON.stringify(['primary', 'p', epoch]))?.entries.has(earlier.id), true);
  assert.equal(primaryControl('earlier').hidden, true, 'the exhausted boundary remains hidden after an initial-page refresh');
  } finally {globalThis.fetch = fetch;}
});


test('pane detach, tab reveal and width changes retain target-owned transcript geometry', async t => {
  t.after(() => {host.viewport = 1200;});
  const epoch = 706; const target = {kind: 'primary' as const, key: 'p', epoch}; const identity = 'geometry-observer';
  const rows = Array.from({length: 24}, (_, index) => entryFixture(`geometry-${index}`, [messageFixture(`geometry-message-${index}`, [textPart(`Retained place ${index}`)])]));
  const saved = targetFixture('geometry-primary', target, {reading: {revision: 7, anchorId: 'geometry-8', offsetPx: 17, followTail: false}});
  const agentTarget = {kind: 'agent' as const, identity}; const agent = agentFixture(identity, {availability: 'stored'});
  const other = targetFixture('geometry-agent', agentTarget, {reading: {revision: 2, anchorId: null, offsetPx: 0, followTail: false}});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: singlePane()}, primaries: [primaryFixture({epoch, sessionId: 'geometry-session', sessionFile: '/fixture/project/geometry.jsonl'})], roster: [agent], targets: [saved, other], history: rows, selectedPage: {target, items: rows, nextCursor: null, coverage}});
  const scroller = primaryControl('transcript'), anchor = scroller.querySelector('[data-entry-id="geometry-8"]'); assert.ok(anchor);
  const top = scroller.scrollTop, offset = top - (anchor.offsetTop - scroller.offsetTop); assert.equal(offset, 17);
  const remove = HostNode.prototype.remove; let detached = 0;
  t.mock.method(HostNode.prototype, 'remove', function(this: HostNode) {
    const attached = this.parentNode !== null; remove.call(this);
    if (attached && this.className === 'conversation') { for (const transcript of this.querySelectorAll('.transcript')) transcript.scrollTop = 0; detached++; }
  });
  await app.selectAgent(agent); await settle(); assert.equal(primaryControl('root').hidden, true); assert.ok(detached > 0);
  const agentNotice = agentControl('view-notice'); assert.doesNotMatch(agentNotice.textContent, /Saved position|saved place/);
  fixture = {...fixture, selectedPage: {target, items: rows, nextCursor: null, coverage}};
  byId('primary-row').click(); await settle();
  assert.equal(primaryControl('root').hidden, false); assert.equal(scroller.querySelector('[data-entry-id="geometry-8"]'), anchor);
  assert.equal(scroller.scrollTop - (anchor.offsetTop - scroller.offsetTop), offset);
  const layout = twoPanes(identity, 'primary-pane'); app.applyLayout(layout); await settle();
  assert.equal(scroller.scrollTop - (anchor.offsetTop - scroller.offsetTop), offset);
  host.viewport = 335; app.renderNavigation(); await settle(); host.viewport = 1440; app.renderNavigation(); await settle();
  assert.equal(scroller.scrollTop - (anchor.offsetTop - scroller.offsetTop), offset);
  scroller.dispatch('scrollend'); await settle();
  const reading = app.state.targets.get(saved.targetKey)?.reading; assert.equal(reading?.anchorId, 'geometry-8'); assert.equal(reading?.offsetPx, 17);
  assert.doesNotMatch(primaryControl('view-notice').textContent, /Saved position|saved place/);
  assert.doesNotMatch(agentNotice.textContent, /Saved position|saved place/);
});
test('selection admission gate stays separate from transport connectivity', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p'},primaries:[primaryFixture({epoch:704})],roster:[]}); const editor=primaryControl('editor'); editor.value='Gate draft'; editor.dispatch('input');
  const original=globalThis.fetch,response=Promise.withResolvers<Response>(); globalThis.fetch=async(input,init)=>new URL(String(input),'http://ui.test').pathname.endsWith('/selection')?response.promise:original(input,init);
  try {const pending=app.selectionQueue.select({sidebarWidth:260}); assert.equal(primaryControl('send').disabled,true); assert.equal(editor.disabled,false); assert.equal(byId('connection').hidden,true);
    response.resolve(Response.json({ok:true,data:{...fixture.workspace,revision:fixture.workspace.revision+1,sidebarWidth:260}})); await pending; await settle(); assert.equal(primaryControl('send').disabled,false);
  }finally{globalThis.fetch=original;}
});
test('snapshot refresh does not await history and history still has a deadline', async () => {
  assert.ok(source.includes('refreshVisible(() => refreshSnapshot(signal), loadVisibleHistory, showError)')); assert.ok(source.includes('AbortSignal.timeout(15_000)')); assert.ok(source.includes('AbortSignal.any'));
});
test('a late action rejection stays under its captured owner after navigation', async context => {
  const fetch = globalThis.fetch; context.after(() => { globalThis.fetch = fetch; });
  const response = Promise.withResolvers<Response>(); const started = Promise.withResolvers<void>();
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), 'http://ui.test').pathname === '/api/operations' && JSON.parse(String(init?.body ?? '{}')).kind === 'primary.stop') { started.resolve(); return response.promise; }
    return fetch(input, init);
  };
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: 8400})], roster: []});
  assert.equal(primaryControl('stop').disabled, false); primaryControl('stop').click(); await started.promise;
  const row = agentFixture('receipt-owner');
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: row.identity}, panelVisible: true},
    primaries: [primaryFixture({epoch: 8400})], roster: [row], targets: [targetFixture('receipt-agent', {kind: 'agent', identity: row.identity})]});
  primaryControl('receipt').textContent = 'Primary receipt retained'; agentControl('receipt').textContent = 'Agent receipt retained';
  response.resolve(Response.json({ok: false, error: {code: 'capacity', message: 'Late action refused', retry: 'manual'}})); await settle();
  assert.match(primaryControl('receipt').textContent, /Late action refused/);
  assert.equal(agentControl('receipt').textContent, 'Agent receipt retained');
});
test('connection and access views stay distinct and tab hiding releases observation', async t => {
  assert.ok(source.includes('connectionSurfaceFor(connectionPhase)')); assert.ok(source.includes('setUnauthorizedHandler(error =>'));
  assert.ok(source.includes("byId('app').hidden = auth")); assert.ok(source.includes("byId('access-view').hidden = !auth")); assert.ok(source.includes("byId('skip-composer').hidden = auth")); assert.doesNotMatch(source, /setInterval/);
  const identity = 'visibility-owner'; await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 9536})], roster: [agentFixture(identity)], observations: [observation(identity)]});
  const editor = agentControl('editor'), stream = streamSources.at(-1); assert.ok(stream); editor.value = 'Hidden tab draft'; editor.dispatch('input'); editor.setSelectionRange(2, 7);
  const tree = app.state.workspace?.conversationLayout, selected = app.state.workspace?.selectedTarget, saves = selectionSaves.length;
  const retained = () => {assert.deepEqual(app.state.workspace?.conversationLayout, tree); assert.deepEqual(app.state.workspace?.selectedTarget, selected); assert.equal(selectionSaves.length, saves); assert.equal(agentControl('editor'), editor);};
  const visibility = () => {for (const handler of [...documentHandlers.get('visibilitychange') ?? []]) handler({target: hostDocument});};
  t.after(async () => {hostDocument.hidden = false; visibility(); await settle(); streamSources.at(-1)?.emit('ready', {bootId: 'boot'}); await settle(); retained();});
  hostDocument.hidden = true; visibility(); await settle(); assert.equal(stream.closed, true); retained();
  assert.equal(editor.value, 'Hidden tab draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]);
});

test('replacement stream readiness ignores old callbacks and does not wait for history', async context => {
  const fetch = globalThis.fetch; const set = view.setTimeout;
  const history = Promise.withResolvers<Response>(); const callbacks: {delay: number; run: () => void}[] = []; let pendingHistoryCalls = 0;
  context.after(async () => {
    globalThis.fetch = fetch; view.setTimeout = set;
    history.resolve(Response.json({ok: true, data: {target: {kind: 'primary', key: 'p', epoch: 8500}, items: [], nextCursor: null, coverage}}));
    streamSources.at(-1)?.emit('ready', {bootId: 'boot'}); await settle();
  });
  const target = {kind: 'primary' as const, key: 'p', epoch: 8500};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: 8500})], roster: [],
    targets: [targetFixture('reconnect-draft', target, {draft: {revision: 7, text: 'Retained reconnect draft', mode: 'prompt', persisted: true}})]});
  const editor = primaryControl('editor'); editor.focus(); editor.setSelectionRange(2, 8);
  const a = streamSources.at(-1); assert.ok(a); const before = transportLog.length;
  assert.equal(primaryControl('send').disabled, false);
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), 'http://ui.test').pathname === '/api/primaries/p/history') { pendingHistoryCalls++; return history.promise; }
    return fetch(input, init);
  };
  view.setTimeout = (run, delay = 0) => { if (delay > 0 && delay <= 750) { callbacks.push({delay, run}); return -callbacks.length; } return set(run, delay); };
  a.onerror?.(); assert.equal(a.closed, true); assert.equal(primaryControl('send').disabled, true);
  const retry = callbacks.find(item => item.delay <= 250); assert.ok(retry); retry.run(); await settle();
  const b = streamSources.at(-1); assert.ok(b); assert.notEqual(b, a); assert.equal(b.closed, false);
  assert.equal(pendingHistoryCalls, 1);
  const cursor = app.state.cursor; a.emit('ready', {bootId: 'boot'}); a.emit('notice', {id: 'late-source-notice', message: 'Old source'}); await settle();
  assert.equal(app.state.cursor, cursor); assert.equal(primaryControl('send').disabled, true);
  assert.equal(app.state.notices.some(item => item.id === 'late-source-notice'), false);
  b.emit('ready', {bootId: 'boot'}); await settle(); assert.equal(primaryControl('send').disabled, false);
  assert.equal(primaryControl('editor'), editor); assert.equal(editor.value, 'Retained reconnect draft');
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 8]); assert.equal(hostDocument.activeElement, editor);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
});
function pageHidden(hidden: boolean): void {
  hostDocument.hidden = hidden;
  for (const handler of [...documentHandlers.get('visibilitychange') ?? []]) handler({target: hostDocument});
}
test('hide before recovery ready retires the wait and reveal admits exactly one fresh stream', async t => {
  const saved = await devHookFixture('hide-ready', 9664), editor = primaryControl('editor'); editor.focus(); editor.setSelectionRange(2, 7, 'backward'); await settle();
  const tree = app.state.workspace?.conversationLayout, target = app.state.workspace?.selectedTarget, saves = selectionSaves.length;
  t.after(async () => {pageHidden(false); await settle(); streamSources.at(-1)?.emit('ready', {bootId: 'boot'}); await settle();});
  pageHidden(true); pageHidden(false); await settle(); const pending = streamSources.at(-1); assert.ok(pending); assert.equal(pending.closed, false);
  const count = streamSources.length; pageHidden(true); await settle(); assert.equal(pending.closed, true); assert.equal(primaryControl('send').disabled, true);
  const cursor = app.state.cursor; pending.emit('ready', {bootId: 'boot'}); pending.onerror?.(); await settle(); assert.equal(app.state.cursor, cursor); assert.equal(streamSources.length, count);
  pageHidden(false); await settle(); const fresh = streamSources.at(-1); assert.ok(fresh); assert.notEqual(fresh, pending); assert.equal(streamSources.length, count + 1);
  pending.emit('notice', {id: 'late-hidden-ready', message: 'Old stream'}); pending.onerror?.(); await settle(); assert.equal(streamSources.length, count + 1);
  assert.equal(primaryControl('send').disabled, true); fresh.emit('ready', {bootId: 'boot'}); await settle(); assert.equal(primaryControl('send').disabled, false);
  assert.equal(app.state.notices.some(notice => notice.id === 'late-hidden-ready'), false); assert.equal(primaryControl('editor'), editor);
  assert.equal(editor.value, saved.primary.draft.text); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']); assert.equal(hostDocument.activeElement, editor);
  assert.deepEqual(app.state.workspace?.conversationLayout, tree); assert.deepEqual(app.state.workspace?.selectedTarget, target); assert.equal(selectionSaves.length, saves);
});
test('hide during recovery reload aborts that owner and ignores its late snapshot after reveal', async t => {
  await devHookFixture('hide-reload', 9665); const fetch = globalThis.fetch, response = Promise.withResolvers<Response>(); let calls = 0; let oldSignal: AbortSignal | null | undefined;
  const stale = snapshotOf(fixture, cursorSequence); const before = streamSources.length;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), 'http://ui.test').pathname === '/api/snapshot' && ++calls === 1) {oldSignal = init?.signal; return response.promise;}
    return fetch(input, init);
  };
  t.after(async () => {globalThis.fetch = fetch; response.resolve(Response.json({ok: true, data: stale})); pageHidden(false); await settle(); streamSources.at(-1)?.emit('ready', {bootId: 'boot'}); await settle();});
  pageHidden(true); pageHidden(false); await settle(); assert.equal(calls, 1); assert.equal(streamSources.length, before);
  pageHidden(true); await settle(); assert.equal(oldSignal?.aborted, true); assert.equal(streamSources.length, before);
  pageHidden(false); await settle(); assert.ok(calls >= 2); assert.equal(streamSources.length, before + 1); const fresh = streamSources.at(-1); assert.ok(fresh);
  fresh.emit('ready', {bootId: 'boot'}); await settle(); const cursor = app.state.cursor, workspace = app.state.workspace;
  response.resolve(Response.json({ok: true, data: stale})); await settle(); assert.equal(streamSources.length, before + 1); assert.equal(app.state.cursor, cursor); assert.equal(app.state.workspace, workspace); assert.equal(fresh.closed, false); assert.equal(primaryControl('send').disabled, false);
});
test('hide cancels a queued recovery retry and refuses its late callback before one reveal attempt', async t => {
  await devHookFixture('hide-retry', 9666); const set = view.setTimeout, clear = view.clearTimeout; let serial = 0;
  const queued = new Map<number, () => void>();
  view.setTimeout = (run, delay = 0) => {if (delay > 0 && delay <= 750) {const id = --serial; queued.set(id, run); return id;} return set(run, delay);};
  view.clearTimeout = id => {if (typeof id === 'number' && id < 0) queued.delete(id); else clear(id);};
  t.after(async () => {view.setTimeout = set; view.clearTimeout = clear; pageHidden(false); await settle(); streamSources.at(-1)?.emit('ready', {bootId: 'boot'}); await settle();});
  const current = streamSources.at(-1); assert.ok(current); current.onerror?.(); const retry = [...queued.values()].at(-1); assert.ok(retry); const count = streamSources.length;
  pageHidden(true); assert.equal(queued.size, 0); retry(); current.onerror?.(); await settle(); assert.equal(streamSources.length, count);
  pageHidden(false); await settle(); assert.equal(streamSources.length, count + 1); const fresh = streamSources.at(-1); assert.ok(fresh); fresh.emit('ready', {bootId: 'boot'}); await settle(); assert.equal(primaryControl('send').disabled, false);
});
test('message panel moves the existing form outside the roster without changing the main view', async () => {
  const row=agentFixture('movable-message'); await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:row.identity},conversationLayout:twoPanes(row.identity)},primaries:[primaryFixture({epoch:706})],roster:[row]});
  const selected=app.state.workspace?.selectedTarget,agent=controls(app.agentComposer()),form=agent('composer'),editor=agent('editor'),root=agent('root'),saved=selectionSaves.length;
  app.openTabActions('agent-pane'); const message = menuNode().children.find(node => node.textContent === 'Message'); assert.ok(message); message.click(); await settle();
  assert.equal(messageControl('composer'),form); assert.equal(messageControl('editor'),editor); assert.equal(form.parentNode,byId('agent-message-panel')); assert.equal(byId('roster').contains(form),false); assert.deepEqual(app.state.workspace?.selectedTarget,selected); assert.equal(selectionSaves.length,saved);
  byId('agent-message-close').click(); await settle(); assert.equal(form.parentNode,root);
});
test('preference completions keep their captured request and leave a newer target notice unchanged', async context => {
  context.after(() => { preferenceSave = undefined; });
  for (const fail of [false, true]) {
    const epoch = fail ? 8202 : 8201; const key = `preference-a-${epoch}`;
    const target = {kind: 'primary' as const, key: 'p', epoch};
    await arrive({workspace: {id:'w',revision:1,primaryKey:'p',selectedTarget:target}, primaries:[primaryFixture({epoch})],roster:[],targets:[targetFixture(key,target)]});
    let finish: (response: Response) => void = () => { throw new Error('No pending preference'); };
    preferenceSave = () => new Promise(resolve => { finish = resolve; });
    const before = transportLog.length; app.openTabActions(); const grouped = menuNode().children.find(node => node.textContent === 'View: Grouped'); assert.ok(grouped); grouped.click(); await settle();
    const call = transportLog.slice(before).find(item => item.path.endsWith('/presentation')); assert.ok(call);
    assert.equal(call.path, `/api/workspaces/w/targets/${key}/presentation`);
    assert.equal((call.body as Record<string,unknown>).transcriptView, 'grouped');
    const next = {kind:'primary' as const,key:'p',epoch:epoch+10}; preferenceSave = undefined;
    await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:next},primaries:[primaryFixture({epoch:next.epoch})],roster:[],targets:[targetFixture(`preference-b-${epoch}`,next)]});
    const notice = primaryControl('view-notice'); notice.dataset.kind = 'presentation'; notice.textContent = 'New target recovery';
    finish(Response.json(fail ? {ok:false,error:{code:'capacity',message:'Preference refused',retry:'manual'}} : {ok:true,data:{revision:2,expanded:[],showThinking:false,transcriptView:'grouped'}})); await settle();
    assert.equal(notice.textContent, 'New target recovery');
  }
  const target = {kind:'primary' as const,key:'p',epoch:8300};
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:target.epoch})],roster:[],targets:[targetFixture('preference-current',target)]});
  preferenceSave = async () => Response.json({ok:false,error:{code:'capacity',message:'Current preference refused',retry:'manual'}});
  app.openTabActions(); const grouped = menuNode().children.find(node => node.textContent === 'View: Grouped'); assert.ok(grouped); grouped.click(); await settle();
  assert.match(primaryControl('view-notice').textContent, /View preferences not saved/);
  assert.match(primaryControl('view-notice').textContent, /Restore saved view/);
});
async function thinkingFixture(epoch: number, shown = false): Promise<TargetState> {
  const target = {kind: 'primary' as const, key: 'p', epoch};
  const saved = targetFixture(`thinking-${epoch}`, target, {presentation: {revision: 1, expanded: [], showThinking: shown}});
  const history = [entryFixture(`thinking-entry-${epoch}`, [messageFixture(`thinking-message-${epoch}`, [{type: 'thinking', text: 'Retained reasoning'}])])];
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch})], roster: [], targets: [saved], history});
  return saved;
}
function thinkingChoice(): HostNode {
  app.openTabActions(); const choice = menuNode().children.find(node => node.textContent === 'Show thinking'); assert.ok(choice); return choice;
}
function thinkingDisclosure(): HostNode {
  const node = primaryControl('transcript').querySelector('.thinking'); assert.ok(node); return node;
}
test('thinking menu follows local changes while preference writes are pending and acknowledgments lag', async context => {
  const pending: Array<{body: Record<string, unknown>; resolve: (response: Response) => void}> = [];
  context.after(() => {preferenceSave = undefined; contextMenu.close(); for (const item of pending) item.resolve(Response.json({ok: false, error: {code: 'capacity', message: 'Closed pending write', retry: 'manual'}}));});
  const saved = await thinkingFixture(8401);
  preferenceSave = (_path, body) => new Promise(resolve => pending.push({body, resolve}));
  assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false'); thinkingChoice().click(); await settle();
  assert.equal(thinkingDisclosure().open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true');
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, false); assert.equal(pending.length, 1);
  thinkingChoice().click(); await settle(); assert.equal(thinkingDisclosure().open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  assert.equal(pending[0]?.body.showThinking, true);
  pending[0]?.resolve(Response.json({ok: true, data: {revision: 2, expanded: [], showThinking: true}})); await settle();
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, true);
  assert.equal(thinkingDisclosure().open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  assert.equal(pending[1]?.body.showThinking, false);
  pending[1]?.resolve(Response.json({ok: true, data: {revision: 3, expanded: [], showThinking: false}})); await settle();
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, false);
});
test('failed thinking saves retain local checked state and Restore saved view explicitly restores it', async context => {
  context.after(() => {preferenceSave = undefined; contextMenu.close();});
  const saved = await thinkingFixture(8402, true);
  assert.equal(thinkingDisclosure().open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true');
  preferenceSave = async () => Response.json({ok: false, error: {code: 'capacity', message: 'Thinking preference refused', retry: 'manual'}});
  thinkingChoice().click(); await settle();
  assert.equal(thinkingDisclosure().open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, true);
  const notice = primaryControl('view-notice'); assert.match(notice.textContent, /View preferences not saved.*Thinking preference refused/);
  thinkingChoice().click(); await settle(); assert.equal(thinkingDisclosure().open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true');
  thinkingChoice().click(); await settle(); assert.equal(thinkingDisclosure().open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  contextMenu.close(); const restore = notice.querySelector('button'); assert.ok(restore); assert.equal(restore.textContent, 'Restore saved view'); restore.click(); await settle();
  assert.equal(thinkingDisclosure().open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true'); assert.equal(notice.textContent, '');
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, true);
});
test('individual thinking collapse clears the local all-thinking check before a failed save', async context => {
  context.after(() => {preferenceSave = undefined; contextMenu.close();});
  const saved = await thinkingFixture(8404, true);
  preferenceSave = async () => Response.json({ok: false, error: {code: 'capacity', message: 'Collapsed preference refused', retry: 'manual'}});
  const disclosure = thinkingDisclosure(); disclosure.open = false; disclosure.dispatch('toggle'); await settle();
  assert.equal(disclosure.open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, true);
  assert.match(primaryControl('view-notice').textContent, /View preferences not saved/);
  thinkingChoice().click(); await settle(); assert.equal(disclosure.open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true');
});
test('disconnected thinking changes alternate locally without claiming a saved preference', async context => {
  context.after(async () => {contextMenu.close(); pageHidden(false); await settle(); streamSources.at(-1)?.emit('ready', {bootId: 'boot'}); await settle();});
  const saved = await thinkingFixture(8403); pageHidden(true); await settle(); assert.equal(primaryControl('send').disabled, true);
  const before = transportLog.length;
  thinkingChoice().click(); await settle(); assert.equal(thinkingDisclosure().open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true');
  thinkingChoice().click(); await settle(); assert.equal(thinkingDisclosure().open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, false);
  assert.equal(transportLog.slice(before).filter(call => call.method === 'PUT' && call.path.endsWith('/presentation')).length, 0);
});
test('close and Escape retain buffers, return focus by identity, and hide unsafe controls', async () => {
  const row=agentFixture('escape-recipient'); await arrive({workspace:{id:'w',revision:1,primaryKey:'p'},primaries:[primaryFixture({epoch:707})],roster:[row]});
  const message=byId('roster').querySelector('[data-identity="escape-recipient"]')?.querySelector('.row-message'); assert.ok(message); message.click(); await settle();
  const editor=messageControl('editor'); editor.value='Escape buffer'; editor.dispatch('input'); editor.focus(); editor.setSelectionRange(2,7); assert.equal(messageControl('stop').hidden,true);
  app.appKey({key:'Escape',preventDefault(){}} as KeyboardEvent); await settle(); assert.equal(byId('agent-message-panel').hidden,true); assert.equal(hostDocument.activeElement,message);
  message.click(); await settle(); assert.equal(messageControl('editor'),editor); assert.equal(editor.value,'Escape buffer'); assert.deepEqual([editor.selectionStart,editor.selectionEnd],[2,7]); byId('agent-message-close').click();
});

test('only arrived roster and availability events invalidate message preparation', () => {
  const events = source.slice(source.indexOf('function applyEvent('), source.indexOf('function renderObservedAgent('));
  assert.match(events, /messageTarget\.rosterChanged\(event\.envelope\.data as EventData\['agent\.roster'\]\)/);
  assert.match(events, /messageTarget\.availabilityChanged\(event\.envelope\.data as EventData\['agent\.availability'\]\)/);
  const panel = source.slice(source.indexOf('function renderMessagePanel()'), source.indexOf('function closeMessagePanel('));
  assert.doesNotMatch(panel, /messageTarget\.(rosterChanged|availabilityChanged)/);
  assert.match(source, /messageTarget\.current && !messageTarget\.current\.invalidated\) await waitForSignal\(messageTarget\.open\(messageTarget\.current\.identity\), signal\)/);
});
test('Resume uses revision-aware reconciliation and restores its exact buffer while prepare is pending', async () => {
  assert.ok(source.includes('controller?.composer.retained(workspace, target, index)')); assert.ok(source.includes('controller.composer.attachRetained(captured.workspaceId, target)')); assert.ok(source.includes('controller.composer.availability(connected, ready, false, selecting)')); assert.ok(source.includes('current.draft.revision >= prepared.draft.revision'));
});
test('the app delegates composer recovery without a duplicate renderer or hook', () => {
  assert.doesNotMatch(source, /function recover\(|recover: recover|exactInput/);

  assert.match(source, /recovery: \(\) => recovery\.open\(\)/);
});

test('visible controls supplement the palette without a header band or title click action', async () => {
  for(const id of ['session-open','session-new','agent-new','commands-button','notifications-button','appearance-button'])assert.ok(byId(id)); assert.doesNotMatch(html,/window-actions|pane-heading|key-hint|id="notices-button"/); assert.ok(source.includes('focusedTranscript()?.expandLoaded')); assert.ok(source.includes("byId('notices-count').hidden = !unread")); assert.ok(source.includes("item?.activity === 'retrying' ? 'Retrying' : ''")); assert.ok(source.includes('if (item?.lastError)')); assert.doesNotMatch(source, /byId\('(?:session-title|agent-name)'\)\.addEventListener\('click'/); for (const binding of ["byId('session-new').addEventListener('click'", "byId('agent-refresh').addEventListener('click', refreshRoster)", "byId('agent-new').addEventListener('click'", "byId('commands-button').addEventListener('click', () => actions.palette())", "byId('notifications-button').addEventListener('click', notices)", "byId('appearance-button').addEventListener('click', () => actions.appearance())"]) assert.ok(source.includes(binding));
});

test('project identity names both direct controls with a launch-directory fallback', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  assert.equal(byId('project-name').textContent, 'project'); assert.equal(byId('compact-project-name').textContent, 'project');
  assert.equal(byId('project-button').title, 'Working folder: /fixture/project');
  assert.equal(byId('project-name').title, '/fixture/project');
  assert.equal(byId('project-button').getAttribute('aria-label'), 'Choose working folder');
  assert.match(html, /id="project-name" class="project-context">Working folder/);
});

test('working-folder context disambiguates loaded primaries and late recent projects in both headers', async () => {
  const first = primaryFixture({cwd: '/work/one/checkout', sessionName: 'Release notes'});
  const second = primaryFixture({key: 'p2', cwd: '/work/two/checkout', sessionName: 'Other title'});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [first, second], roster: []});
  for (const prefix of ['', 'compact-']) {
    assert.equal(byId(`${prefix}project-name`).textContent, 'one/checkout');
    assert.equal(byId(`${prefix}project-name`).title, first.cwd);
    assert.equal(byId(`${prefix}project-button`).getAttribute('aria-description'), first.cwd);
  }
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => String(url).includes('/api/projects')
      ? Response.json({ok: true, data: {items: [{path: '/archive/one/checkout', name: 'checkout', modifiedAt: 'now'}], total: 1, omitted: 0, nextCursor: null, observedAt: 'now'}})
      : originalFetch(url, init);
    byId('project-button').click(); await settle();
    assert.equal(byId('project-name').textContent, 'work/one/checkout');
    assert.equal(byId('compact-project-name').textContent, 'work/one/checkout');
    const rows = menuNode().children;
    assert.ok(rows.find(row => row.textContent === 'archive/one/checkout'));
    assert.ok(rows.find(row => row.textContent === 'work/one/checkout'));
    assert.equal(app.state.primaries.get('p')?.sessionName, 'Release notes');
    contextMenu.close();
  } finally {globalThis.fetch = originalFetch;}
});

test('the missing Primary uses the shared unknown glyph rather than a connected mark', async () => {
  await arrive({workspace: {id: 'w', revision: 1}, primaries: [], roster: []});
  assert.equal(byId('primary-row-state').textContent, '?');
  assert.equal(byId('primary-row-state').dataset.state, 'none');
  assert.equal(byId('primary-row-title').textContent, 'no session');
  assert.equal(byId('session-chooser').hidden, false); assert.equal(byId('conversation-panes').querySelector('textarea'), null);
});

test('sidebar controls are visible and their icons have consistent decorative strokes and named buttons', async () => {
  for(const id of ['agent-refresh','agent-new','sidebar-close']){const node=byId(id); assert.equal(node.hidden,false); assert.ok(node.getAttribute('aria-label')); const icon=node.querySelector('svg'); assert.ok(icon); assert.equal(icon.getAttribute('width'),'16'); assert.equal(icon.getAttribute('height'),'16'); assert.equal(icon.getAttribute('focusable'),'false'); assert.equal(icon.getAttribute('stroke'),'currentColor'); assert.equal(icon.getAttribute('stroke-width'),'1.5'); assert.equal(icon.getAttribute('aria-hidden'),'true');} assert.match(html,/id="agent-search"[^>]*placeholder="Filter agents"/);
});
test('pane controls separate creation from conversation actions without title rows', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p'},primaries:[primaryFixture({epoch:708})],roster:[]}); assert.equal(tabsNode().getAttribute('role'),'tablist'); assert.equal(tabsNode().getAttribute('aria-label'),'Conversations');
  const pane=paneNode('pane-1'); assert.equal(pane.querySelectorAll('.pane-actions').length,1); assert.equal(pane.querySelector('.pane-actions')?.getAttribute('aria-label'),'New tab'); assert.equal(pane.querySelector('.pane-actions svg')?.getAttribute('class'),'card-icon card-icon-plus'); assert.equal(primaryControl('transcript').getAttribute('aria-label'),'Conversation messages'); assert.equal(primaryControl('send').textContent,'Send'); assert.doesNotMatch(html,/pane-heading|id="tab-split"|id="session-title"/);
});

test('pane handles are labeled keyboard separators at their pane edges', async () => {
test('pane strips expose local navigation, a direct new-tab chooser and a separate complete tab list', async () => {
  const layout = singlePane([{kind: 'primary'}, {kind: 'agent', identity: 'strip-a'}, {kind: 'agent', identity: 'strip-b'}]);
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: layout}, primaries: [primaryFixture({epoch: 8405})], roster: [agentFixture('strip-a', {name: 'First full tab name'}), agentFixture('strip-b', {name: 'Second full tab name'})]});
  const pane = paneNode('pane-1'); const bar = pane.querySelector('.tab-bar'); assert.ok(bar);
  assert.deepEqual(bar.children.filter(node => node.classList.contains('pane-tab-nav') || node.classList.contains('conversation-tabs') || node.classList.contains('pane-actions') || node.classList.contains('pane-menu')).map(node => node.getAttribute('aria-label')), ['Previous tab', 'Next tab', 'Conversations', 'New tab', 'Tabs in this pane']);
  const [previous, next] = pane.querySelectorAll('.pane-tab-nav'); assert.ok(previous); assert.ok(next);
  assert.equal(previous.disabled, true); assert.equal(next.disabled, false); next.click(); await settle();
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: 'strip-a'}); assert.equal(previous.disabled, false);
  const list = pane.querySelector('.pane-menu'); assert.ok(list); list.click();
  assert.equal(menuNode().getAttribute('aria-label'), 'Tabs in this pane');
  for (const name of ['First full tab name', 'Second full tab name', 'Split right', 'Split down', 'Close tab']) assert.ok(menuNode().children.some(node => node.textContent === name), name);
  const selected = menuNode().children.find(node => node.textContent === 'First full tab name'); assert.equal(selected?.getAttribute('aria-checked'), 'true');
  const second = menuNode().children.find(node => node.textContent === 'Second full tab name'); assert.ok(second); second.click(); await settle(); assert.equal(next.disabled, true);
  contextMenu.close(); const plus = pane.querySelector('.pane-actions'); assert.ok(plus); plus.focus(); plus.click(); await settle();
  assert.equal(contextMenu.openNow, false); assert.equal(byId('modal-title').textContent, 'Go to conversation'); byId('modal-close').click();
  app.openTabActions('pane-1'); for (const name of ['Split right', 'Split down', 'Close tab']) assert.ok(menuNode().children.some(node => node.textContent === name)); contextMenu.close();
});
  const identity='separator-owner'; await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity},conversationLayout:twoPanes(identity)},primaries:[primaryFixture({epoch:9537})],roster:[agentFixture(identity)]});
  const agentForm=agentControl('composer'),agentHandle=agentForm.querySelector('.resizer'); assert.ok(agentHandle); assert.equal(agentHandle.getAttribute('aria-controls'),agentControl('editor').id); assert.ok(agentForm.children.indexOf(agentHandle)<agentForm.children.findIndex(node=>node.classList.contains('composer-input')));
  const form=primaryControl('composer'),handle=form.querySelector('.resizer'); assert.ok(handle); assert.equal(form.contains(handle),true); assert.ok(form.children.indexOf(handle) < form.children.findIndex(node => node.classList.contains('composer-input'))); assert.equal(handle.getAttribute('aria-controls'),primaryControl('editor').id);
  for(const node of [handle,agentHandle,byId('sidebar-resizer'),byId('message-panel-resizer')]){assert.equal(node.getAttribute('data-axis'),node.id==='sidebar-resizer'?'x':'y');assert.equal(node.getAttribute('aria-orientation'),node.id==='sidebar-resizer'?'vertical':'horizontal');assert.equal(node.tabIndex,0); assert.equal(node.getAttribute('role'),'separator'); assert.match(node.getAttribute('aria-label')??'',/^Resize /); assert.ok(node.getAttribute('aria-orientation'));} assert.equal(byId('sidebar-resizer').parentNode,byId('sidebar')); assert.equal(byId('message-panel-resizer').parentNode,byId('agent-message-panel'));
});
test('sidebar width commits preserve transcript requests and pane refresh follows form placement', () => {
  const panes = source.slice(source.indexOf('function refreshPaneSizes('), source.indexOf('function currentSnapshot('));
  assert.ok(panes.includes('selectionQueue.select({sidebarWidth: value})')); assert.doesNotMatch(panes, /\bselection\(|historyAbort/);
  assert.ok(panes.includes('if (workspace.id !== paneWorkspace)')); assert.ok(panes.includes('resizer.destroy()')); assert.ok(panes.includes('paneResizers[0]?.refresh()'));
  assert.ok(panes.includes('read: () => state.workspace?.sidebarWidth ?? 248'));
  const render = source.slice(source.indexOf('function renderAll('), source.indexOf('function renderNavigation('));
  assert.ok(render.indexOf('refreshPaneSizes()') > render.indexOf('renderMessagePanel()'));
  const composer = source.slice(source.indexOf('function composerResizer('), source.indexOf('function refreshPaneSizes('));
  assert.ok(composer.includes('composer.setManualHeight(preferred)')); assert.ok(composer.includes('applyInitial: preferred !== undefined'));
  assert.ok(composer.includes('composer.setManualHeight(undefined)')); assert.doesNotMatch(source, /--composer-height/);
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
test('Primary metadata exposes scoped text while project identity remains separate', () => {
  const usage = source.slice(source.indexOf('function renderPrimaryUsage('), source.indexOf('export function renderTabActions('));
  assert.ok(source.includes('renderPrimaryUsage(item)')); assert.ok(usage.includes('const usage = usageFacts(item, item ? primaryBlocks(state, item.key) : undefined)'));
  assert.ok(usage.includes("element('span', 'usage-fact', fact.text)")); assert.ok(usage.includes('node.dataset.key = fact.key'));
  assert.ok(usage.includes("element('p', 'usage-detail', fact.detail)")); assert.ok(usage.includes('if (!fact.summary) continue'));
  assert.doesNotMatch(usage, /element\('meter'|usage-separator|launchCwd/);
  assert.match(source, /projectIdentity\(view, launchCwd, picker\.projectPaths\(\)\)/); assert.ok(html.includes('id="primary-context"'));
});

test('queued primary input renders labeled text, preserves full titles and clears when empty', () => {
  const list = primaryControl('queued');
  app.renderPrimaryQueue({pending: 2, steering: ['Check this first\nThen inspect the output'], followUp: ['<tag>literal input</tag>']});
  assert.equal(list.hidden, false); assert.equal(list.children.length, 2);
  assert.deepEqual(list.children.map(row => ({tag: row.tagName, className: row.className, mode: row.dataset.mode, text: row.textContent, title: row.title})), [
    {tag: 'li', className: 'queued-message', mode: 'steer', text: 'Next step: Check this first\nThen inspect the output', title: 'Check this first\nThen inspect the output'},
    {tag: 'li', className: 'queued-message', mode: 'followUp', text: 'After response: <tag>literal input</tag>', title: '<tag>literal input</tag>'},
  ]);
  app.renderPrimaryQueue({pending: 1, followUp: ['Only follow-up']}); assert.equal(list.children.length, 1); assert.equal(list.children[0]?.dataset.mode, 'followUp');
  app.renderPrimaryQueue({pending: 0, steering: [], followUp: []}); assert.equal(list.hidden, true); assert.equal(list.children.length, 0);
  app.renderPrimaryQueue(undefined); assert.equal(list.hidden, true);
  const form = primaryControl('composer'); assert.equal(list.parentNode, form); assert.ok(form.children.indexOf(list) < form.children.findIndex(node => node.classList.contains('composer-input')));
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
test('editors keep accessible recipient labels and the common placeholder', async () => {
  const row=agentFixture('labels-agent'); await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:row.identity},conversationLayout:twoPanes(row.identity)},primaries:[primaryFixture({epoch:709})],roster:[row]});
  for(const control of [primaryControl,agentControl]){const editor=control('editor') as HostNode & {placeholder:string}; assert.equal(editor.placeholder,'Write a message…'); assert.equal((control('recipient') as HostNode & {htmlFor:string}).htmlFor,editor.id); assert.match(control('recipient').textContent,/^Message /);}
});

test('pane tabs keep separate menus and focused facts while both target owners stay retained', async () => {
  const identity='agent-pane',agent={kind:'agent' as const,identity}; await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:agent,conversationLayout:twoPanes(identity)},primaries:[primaryFixture({epoch:710})],roster:[agentFixture(identity)],observations:[observation(identity)],targets:[targetFixture('pane-p',{kind:'primary',key:'p',epoch:710},{draft:{revision:1,text:'Primary draft',mode:'steer',persisted:true}}),targetFixture('pane-a',agent,{draft:{revision:1,text:'Agent draft',mode:'prompt',persisted:true}})]});
  const p=controls(app.primaryComposer()),a=controls(app.agentComposer()),pe=p('editor'),ae=a('editor'); pe.setSelectionRange(1,3); ae.setSelectionRange(2,4); byId('primary-usage-details').open=true;
  app.focusPane('primary-pane'); await settle(); assert.equal(hostDocument.activeElement,pe); assert.equal(byId('workbench-status').dataset.pane,'primary'); assert.equal(byId('workbench-status-primary').hidden,false); assert.equal(byId('workbench-status-agent').hidden,true); assert.equal(byId('workbench-scope').title,'p'); assert.equal(app.state.conversations.get(JSON.stringify(['agent',identity]))?.connectionEpoch,1);
  for(const pane of ['primary-pane','agent-pane']){app.openTabActions(pane);assert.equal(menuNode().getAttribute('aria-label'),'Tab and view actions');contextMenu.close();}
  app.focusPane('agent-pane');await settle();assert.equal(hostDocument.activeElement,ae);assert.equal(byId('workbench-scope').title,identity);assert.equal(byId('workbench-status-primary').hidden,true);assert.equal(byId('workbench-status-agent').hidden,false);assert.equal(a('editor'),ae);assert.equal(p('editor'),pe);assert.deepEqual([pe.selectionStart,pe.selectionEnd],[1,3]);assert.deepEqual([ae.selectionStart,ae.selectionEnd],[2,4]);assert.equal(byId('primary-usage-details').open,true);
});

test('footer facts follow a Message recipient while Primary stays selected', async () => {
  const recipient=agentFixture('footer-recipient'),target={kind:'primary' as const,key:'p',epoch:8600}; await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:8600})],roster:[recipient],targets:[targetFixture('footer-p',target),targetFixture('footer-b',{kind:'agent',identity:recipient.identity},{draft:{revision:1,text:'Recipient draft',mode:'prompt',persisted:true}})]});
  byId('roster').querySelector('[data-identity="footer-recipient"]')?.querySelector('.row-message')?.click(); await settle(); const editor=messageControl('editor');editor.focus();editor.setSelectionRange(2,6); const disclosure=byId('agent-usage-details');disclosure.open=true;
  assert.equal(byId('workbench-status').dataset.pane,'agent');assert.equal(byId('workbench-scope').title,recipient.identity);assert.deepEqual(app.state.workspace?.selectedTarget,target);assert.equal(editor.value,'Recipient draft');assert.equal(byId('workbench-status-primary').hidden,true);assert.equal(byId('workbench-status-agent').hidden,false);app.renderConnection();assert.equal(byId('workbench-scope').title,recipient.identity);assert.equal(messageControl('editor'),editor);assert.equal(hostDocument.activeElement,editor);assert.deepEqual([editor.selectionStart,editor.selectionEnd],[2,6]);assert.equal(disclosure.open,true);byId('agent-message-close').click();await settle();
});
test('explicit observed conversation activation focuses its editor while incidental repaint retains Primary focus', async () => {
  const identity='row-focus',target={kind:'agent' as const,identity}; await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:twoPanes(identity)},primaries:[primaryFixture({epoch:778})],roster:[agentFixture(identity)],observations:[observation(identity)],targets:[targetFixture('row-p',{kind:'primary',key:'p',epoch:778},{draft:{revision:1,text:'Primary row draft',mode:'steer',persisted:true}}),targetFixture('row-a',target,{draft:{revision:1,text:'Agent row draft',mode:'prompt',persisted:true}})]});
  const p=controls(app.primaryComposer()),a=controls(app.agentComposer()),pe=p('editor'),ae=a('editor');pe.setSelectionRange(2,7);ae.setSelectionRange(3,8);app.focusPane('primary-pane');await settle();const readings=[...app.state.targets.values()].map(item=>item.reading),before=transportLog.length;
  const row=byId('sidebar-conversations').querySelector('[data-tab-key="agent:row-focus"]');assert.ok(row);row.click();await settle();assert.equal(hostDocument.activeElement,ae);assert.equal(app.focusedPane,'agent-pane');assert.deepEqual(app.state.workspace?.selectedTarget,target);assert.equal(byId('sidebar-conversations').querySelector('[data-tab-key="agent:row-focus"]')?.getAttribute('aria-current'),'true');assert.equal(paneNode('primary-pane').dataset.focused,'false');assert.equal(paneNode('agent-pane').dataset.focused,'true');assert.equal(pe.value,'Primary row draft');assert.equal(ae.value,'Agent row draft');assert.deepEqual([...app.state.targets.values()].map(item=>item.reading),readings);
  app.focusPane('primary-pane');await settle();await app.reload();await settle();assert.equal(hostDocument.activeElement,pe);assert.equal(app.focusedPane,'primary-pane');tabsNode('agent-pane').querySelector('[data-tab-key="agent:row-focus"]')?.click();await settle();assert.equal(hostDocument.activeElement,ae);assert.equal(p('editor'),pe);assert.equal(a('editor'),ae);assert.deepEqual([pe.selectionStart,pe.selectionEnd],[2,7]);assert.deepEqual([ae.selectionStart,ae.selectionEnd],[3,8]);assert.equal(transportLog.slice(before).filter(call=>call.path.endsWith('/start')||call.path.includes('/inputs')).length,0);
});

test('the whole-workbench footer owns facts while composers retain direct delivery actions', async () => {
  const identity='delivery-owner';await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity},conversationLayout:twoPanes(identity)},primaries:[primaryFixture({epoch:9538})],roster:[agentFixture(identity)]});const agent=controls(app.agentComposer());
  app.focusPane('primary-pane'); await settle(); const footer=byId('workbench-status'); for(const id of ['primary-context','primary-usage','model-button','thinking-button','extension-status'])assert.equal(footer.contains(byId(id)),true);
  const slots=byId('focused-composer-status'); assert.equal(slots.children.length,2); assert.match(slots.children[0]?.id??'',/-save$/); assert.match(slots.children[1]?.id??'',/-receipt-details$/);
  for(const owner of [primaryControl,agent]){const form=owner('composer');assert.ok(form.contains(owner('modes')));assert.ok(form.contains(owner('send')));assert.equal(form.querySelector('.usage-details'),null);assert.equal(form.querySelector('.composer-settings,.composer-guidance'),null);}assert.ok(source.includes("byId('model-button').addEventListener('click', () => actions.modelPicker())"));assert.ok(source.includes("byId('thinking-button').addEventListener('click', () => actions.thinkingPicker())"));
});

test('a live agent with unavailable catalog metadata keeps title pane and composer coherent without a Primary', async () => {
  const row=agentFixture('a', {state:'unavailable', availability:'live', name:'Worker'});
  await arrive({workspace:{id:'w',revision:1,selectedTarget:{kind:'agent',identity:'a'},panelVisible:true},primaries:[],roster:[row],targets:[targetFixture('agent-a',{kind:'agent',identity:'a'})]});
  assert.equal(hostDocument.title,'Pi · Worker · Connected'); assert.equal(byId('primary-row').hidden,true); assert.equal(byId('project-name').textContent,'project'); assert.equal(byId('project-button').title, 'Working folder: /fixture/project');
  const active = tabsNode().children.find(node => node.attributes.get('aria-selected') === 'true'); assert.ok(active); assert.equal(active.querySelector('.tab-state')?.textContent, 'Connected');
  assert.equal(agentControl('recipient').textContent,'Message Worker'); assert.equal(agentControl('send').disabled,true); assert.equal(agentControl('editor').disabled,false);
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
  assert.match(html, /id="primary-heading" class="section-toggle"[^>]*aria-controls="primary-section-body">Sessions/);
  assert.match(html, /id="agents-heading" class="section-toggle"[^>]*aria-controls="agents-section-body">Agents/);
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
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:'a'},conversationLayout:singlePane([{kind:'primary'},{kind:'agent',identity:'a'}],'agent:a')},primaries:[primaryFixture()],roster:[agentFixture('a')]});selectionSaves.length=0;transportLog.length=0;
  app.applyLayout(twoPanes('a'));await settle();assert.ok(selectionSaves[0]?.body.conversationLayout);assert.deepEqual(selectionSaves[0]?.body.selectedTarget,{kind:'agent',identity:'a'});assert.equal(selectionSaves[0]?.body.panelVisible,true);
  app.applyLayout(singlePane());await settle();assert.deepEqual(selectionSaves[1]?.body.selectedTarget,{kind:'primary',key:'p',epoch:1});app.applyLayout(singlePane([]));await settle();assert.equal(selectionSaves[2]?.body.selectedTarget,null);assert.equal(selectionSaves[2]?.body.panelVisible,false);assert.equal(transportLog.filter(call=>call.path==='/api/operations').length,0);
});
test('split panes retain both transcript and composer nodes and use the shared resize primitive', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:'split-a'},conversationLayout:singlePane([{kind:'primary'},{kind:'agent',identity:'split-a'}],'agent:split-a')},primaries:[primaryFixture({epoch:711})],roster:[agentFixture('split-a')]});const p=controls(app.primaryComposer()),a=controls(app.agentComposer()),roots=[p('root'),a('root')],editors=[p('editor'),a('editor')],transcripts=[p('transcript'),a('transcript')],forms=[p('composer'),a('composer')];
  app.applyLayout(twoPanes('split-a'));await settle();assert.equal(p('root'),roots[0]);assert.equal(a('root'),roots[1]);assert.equal(p('editor'),editors[0]);assert.equal(a('editor'),editors[1]);assert.equal(p('transcript'),transcripts[0]);assert.equal(a('transcript'),transcripts[1]);assert.equal(p('composer'),forms[0]);assert.equal(a('composer'),forms[1]);const handle=byId('conversation-panes').querySelector('.pane-divider');assert.ok(handle);assert.equal(handle.getAttribute('role'),'separator');assert.equal(handle.tabIndex,0);handle.dispatch('keydown',{key:'ArrowRight'});await settle();assert.ok(selectionSaves.at(-1)?.body.conversationLayout);
});
test('an addressed split retains Primary and agent owners without a permanent Split control', async () => {
  const identity='split-target';const layout=singlePane([{kind:'primary'},{kind:'agent',identity}]);await arrive({workspace:{id:'w',revision:1,primaryKey:'p',conversationLayout:layout},primaries:[primaryFixture({epoch:712})],roster:[agentFixture(identity)]});const p=controls(app.primaryComposer()),editor=p('editor');editor.value='Retain the Primary draft';editor.dispatch('input');editor.setSelectionRange(3,8);
  const next=splitPane(layout,'pane-1','x',{width:1400,height:640,divider:4},`agent:${identity}`);app.applyLayout(next);await settle();assert.deepEqual(app.state.workspace?.selectedTarget,{kind:'agent',identity});assert.equal(p('editor'),editor);assert.equal(editor.value,'Retain the Primary draft');assert.deepEqual([editor.selectionStart,editor.selectionEnd],[3,8]);assert.equal(paneLeaves(app.state.workspace?.conversationLayout?.root??next.root).length,2);assert.equal(hostDocument.getElementById('tab-split'),undefined);
});

test('Primary tool start and end refresh the pane and active tab without another state event', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({activity: 'running'})], roster: []});
  const target = {kind: 'primary' as const, key: 'p', epoch: 1};
  const activeStatus = () => tabsNode().children.find(node => node.attributes.get('aria-selected') === 'true')?.querySelector('.tab-state')?.textContent;
  assert.equal(activeStatus(), 'Working');
  event('primary.tool', {callId: 'chrome-tool', name: 'generic', phase: 'start', arguments: {value: {}, truncated: false}}, target);
  assert.equal(activeStatus(), 'Working · generic');
  event('primary.tool', {callId: 'chrome-tool', name: 'generic', phase: 'end'}, target);
  assert.equal(activeStatus(), 'Working');
});

test('stream bursts reduce immediately and defer the Primary transcript index to one frame', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []}); flushFrames();
  const {Transcript} = await import('./render.ts'); const transcript = primaryControl('transcript'); const set = Transcript.prototype.set; let indexed = 0;
  Transcript.prototype.set = function (...args: Parameters<typeof set>) { if (this.node === transcript as unknown) indexed++; return set.apply(this, args); };
  try {
    const editor = primaryControl('editor'); editor.value = 'Keep this local draft'; editor.focus(); editor.setSelectionRange(3, 7);
    const before = transportLog.length; const target = {kind: 'primary' as const, key: 'p', epoch: 1};
    for (let delta = 0; delta < 20; delta++) event('primary.delta', {messageId: 'burst-message', index: 0, kind: 'text', delta: 'x'}, target);
    assert.equal(indexed, 0); assert.equal(app.state.conversations.get(JSON.stringify(['primary', 'p', 1]))?.messages.has('burst-message'), true);
    assert.equal(editor.value, 'Keep this local draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [3, 7]); assert.equal(hostDocument.activeElement, editor);
    flushFrames(); assert.equal(indexed, 1); assert.match(primaryControl('transcript').textContent, /x{20}/);
    assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
  } finally { Transcript.prototype.set = set; }
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
  assert.match(usageNode.textContent, /input 4, cache read 4, cache write 0/);
  assert.match(byId('primary-usage-summary').textContent, /Cache 50% · loaded/);
  assert.doesNotMatch(byId('primary-usage-summary').textContent, /●/);
  assert.ok(descendants(primaryControl('transcript')).some(node => node.textContent.includes('streaming')));
  const final = {...messageFixture('history-usage', [textPart('Earlier usage')]), usage: {input: 9, cacheRead: 3, cacheWrite: 0}};
  fixture = {...fixture, history: [entryFixture('history-usage-entry', [final])]}; await app.reload(); await settle();
  assert.match(usageNode.textContent, /input 13, cache read 7, cache write 0/);
});
test('image URLs bind each transcript pane rather than the movable composer or active pane', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  event('primary.message', {message: {id: 'img1', role: 'user', parts: [imagePart('img1')], state: 'final', coverage}}, {kind: 'primary', key: 'p', epoch: 1});
  flushFrames(); await settle();
  const primaryImage = descendants(primaryControl('transcript')).find(node => node.tagName === 'img');
  assert.ok(primaryImage); assert.match(String(primaryImage.properties.get('src') ?? (primaryImage as {src?: string}).src ?? ''), /^\/api\/primaries\/p\/history\/image\?/);
  assert.match(String((primaryImage as {src?: string}).src ?? ''), /workspace=w/); assert.match(String((primaryImage as {src?: string}).src ?? ''), /epoch=1/);
  const frame: ProjectedFrame = {revision: 1, observedAt: '', entries: [entryFixture('img2', [messageFixture('img2', [imagePart('img2')])])], live: [], nextBefore: null, status: {busy: false}, coverage};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'a'}, panelVisible: true}, primaries: [primaryFixture()],
    roster: [agentFixture('a')], targets: [targetFixture('image-a', {kind: 'agent', identity: 'a'})], observations: [observation('a', frame)]});
  flushFrames(); await settle();
  const agentImage = descendants(agentControl('transcript')).find(node => node.tagName === 'img');
  assert.ok(agentImage); assert.match(String((agentImage as {src?: string}).src ?? ''), /^\/api\/agents\/a\/history\/image\?/);
  assert.match(String((agentImage as {src?: string}).src ?? ''), /workspace=w/);
  assert.doesNotMatch(String((agentImage as {src?: string}).src ?? ''), /epoch/);
});
test('metadata summary keeps context counts together and details expose scope without meters or dots', () => {
  const facts = [
    {key: 'context', text: 'Context unknown', title: 'Unknown context', detail: 'Current Primary context is unknown.', summary: true},
    {key: 'contextTokens', text: '?/1k', title: 'Estimated tokens', detail: 'Model window: 1,000 tokens.', summary: true},
    {key: 'cost', text: 'Session ~$0.01', title: 'Reported cost', detail: 'Whole-session estimate, not billing.', summary: true},
    {key: 'cacheHitShare', text: 'Cache 50% · loaded', title: 'Loaded window only', detail: 'Loaded finalized assistant usage only.', summary: true},
    {key: 'unavailable', text: 'Unavailable', title: 'No report', detail: 'Not reported, not zero.', summary: false},
  ];
  const nodes = app.usageNodes({facts, contextFraction: null}, true);
  assert.equal(nodes.length, 3); assert.deepEqual(nodes.map(node => node.dataset.group), ['context', 'cost', 'cache']);
  assert.deepEqual(nodes[0]?.children.map(node => node.textContent), ['Context unknown', '?/1k']);
  assert.ok(nodes.every(node => node.className === 'usage-group'));
  for (const group of nodes) for (const node of group.children) { assert.equal(node.className, 'usage-fact'); assert.equal(node.attributes.get('aria-label'), node.title); }
  const details = app.usageNodes({facts, contextFraction: .25}, false);
  assert.deepEqual(details.map(node => node.textContent), facts.map(fact => fact.detail));
  assert.ok(details.every(node => node.tagName === 'p')); assert.equal(app.usageNodes({facts: [], contextFraction: null}, true).length, 0);
});

test('session reload restores the ready composer after dialog close without changing its draft', async () => {
  const saved = targetFixture('primary-draft', {kind: 'primary', key: 'p', epoch: 8800}, {draft: {revision: 1, text: 'Retained session draft', mode: 'prompt', persisted: true}});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: saved.target}, primaries: [primaryFixture({epoch: 8800, activity: 'idle'})], roster: [], targets: [saved]});
  const editor = primaryControl('editor'); assert.equal(editor.value, 'Retained session draft');
  byId('project-button').focus(); byId('modal').showModal(); await app.reloadSelection(); byId('modal').close();
  assert.equal(hostDocument.activeElement, editor); assert.equal(editor.value, 'Retained session draft'); assert.equal(editor.disabled, false);
});
test('context menus capture inactive tabs and never close a later selection', async () => {
  const layout=singlePane([{kind:'primary'},{kind:'agent',identity:'menu-a'},{kind:'agent',identity:'menu-b'}]);const base={workspace:{id:'w',revision:1,primaryKey:'p',conversationLayout:layout},primaries:[primaryFixture({epoch:713})],roster:[agentFixture('menu-a'),agentFixture('menu-b')]};await arrive(base);
  const tab=tabsNode().querySelector('[data-tab-key="agent:menu-a"]');assert.ok(tab);pressContext(tab);const close=menuNode().children.find(node=>node.textContent==='Close tab');assert.ok(close);close.click();await settle();assert.deepEqual(paneLeaves(app.state.workspace?.conversationLayout?.root??layout.root).flatMap(pane=>pane.tabs).map(tabKey),['primary','agent:menu-b']);
  await arrive(base);const stale=tabsNode().querySelector('[data-tab-key="agent:menu-a"]');assert.ok(stale);pressContext(stale);const staleClose=menuNode().children.find(node=>node.textContent==='Close tab');assert.ok(staleClose);app.applyLayout(activatePaneTab(layout,'pane-1','agent:menu-b'));await settle();const saves=selectionSaves.length;staleClose.click();await settle();assert.equal(selectionSaves.length,saves);assert.deepEqual(app.state.workspace?.selectedTarget,{kind:'agent',identity:'menu-b'});assert.match(byId('announcements').textContent,/changed.*again/);
});
test('agent and Primary pane menus expose supported actions while text inputs keep native menus', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:'context-agent'},conversationLayout:twoPanes('context-agent')},primaries:[primaryFixture({epoch:714})],roster:[agentFixture('context-agent',{capabilities:{input:true,inspect:true}})]});app.openTabActions('agent-pane');for(const label of ['Show conversation','Message','Copy agent ID','Conversation details','View activity…'])assert.ok(menuNode().children.some(node=>node.textContent===label));assert.equal(menuNode().children.some(node=>node.textContent==='New session'),false);contextMenu.close();assert.equal(hostDocument.activeElement,paneNode('agent-pane').querySelector('.pane-menu'));
  pressContext(primaryControl('editor'));assert.equal(contextMenu.openNow,false);app.openTabActions('primary-pane');assert.equal(menuNode().children.some(node=>['Appearance','Help','Commands…','Refresh agent roster'].includes(node.textContent)),false); const thinking = menuNode().children.find(node=>node.textContent==='Show thinking'); assert.ok(thinking); assert.equal(thinking.getAttribute('role'),'menuitemcheckbox'); assert.equal(thinking.getAttribute('aria-checked'),'false'); assert.equal(menuNode().children.some(node=>node.textContent==='Hide thinking'),false);contextMenu.close();
});
test('status settings label model and thinking while retaining picker accessible names', () => {
  app.primaryChrome({cwd: '/fixture', lifecycle: 'ready', model: {provider: 'provider', id: 'model', name: 'Model', reasoning: false, input: ['text']}, thinkingLevel: 'high'} as PrimaryView);
  assert.equal(byId('model-button').textContent, 'model'); assert.equal(byId('model-button').title, 'provider/model · Primary'); assert.equal(byId('model-button').attributes.get('aria-label'), 'Model for Primary: provider/model');
  assert.equal(byId('thinking-button').textContent, 'high'); assert.equal(byId('thinking-button').attributes.get('aria-label'), 'Thinking level for Primary: high');
});

test('the Primary composer uses the projected conversation name without replacing its editor', async () => {
  const item=primaryFixture({epoch:41,sessionName:'Named conversation',activity:'idle'});await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'primary',key:'p',epoch:41}},primaries:[item],roster:[]});const editor=primaryControl('editor');assert.equal(primaryControl('recipient').textContent,'Message Named conversation');assert.equal(byId('primary-row-state').textContent,'✓');event('primary.state',{...item,sessionName:'Renamed conversation'},{kind:'primary',key:'p',epoch:41});assert.equal(primaryControl('recipient').textContent,'Message Renamed conversation');assert.equal(primaryControl('editor'),editor);
});

test('navigation uses drawer state while a breakpoint resize still has desktop DOM visibility', async () => {
  host.viewport = 1200; await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', sidebarVisible: true}, primaries: [primaryFixture()], roster: []});
  assert.equal(byId('sidebar').hidden, false); host.viewport = 760; byId('sidebar-show').click();
  assert.equal(app.drawerOpen, true); assert.equal(byId('sidebar').hidden, false); app.toggleSidebar(false); host.viewport = 1200;
});

test('drawer Close, outside pointer and Escape retain drafts and desktop visibility preference', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'primary', key: 'p', epoch: 1}, sidebarVisible: true}, primaries: [primaryFixture()], roster: []});
  host.viewport = 760; selectionSaves.length = 0; primaryControl('editor').value = 'Exact retained draft'; primaryControl('editor').dispatch('input'); primaryControl('transcript').scrollTop = 140;
  app.toggleSidebar(true); assert.equal(app.drawerOpen, true); assert.equal(byId('sidebar-show').hidden, false);
  byId('sidebar-close').click(); assert.equal(app.drawerOpen, false); assert.equal(hostDocument.activeElement, byId('sidebar-show'));
  app.toggleSidebar(true); let prevented = 0; let stopped = 0;
  app.dismissDrawerPointer({target: primaryControl('send'), preventDefault: () => {prevented++;}, stopImmediatePropagation: () => {stopped++;}} as unknown as PointerEvent);
  assert.equal(app.drawerOpen, false); assert.equal(prevented, 1); assert.equal(stopped, 1);
  app.consumeDrawerClick({detail: 1, preventDefault: () => {prevented++;}, stopImmediatePropagation: () => {stopped++;}} as unknown as MouseEvent);
  assert.equal(prevented, 2); assert.equal(stopped, 2); assert.equal(hostDocument.activeElement, byId('sidebar-show'));
  app.toggleSidebar(true); app.appKey({key: 'Escape', preventDefault() {}} as KeyboardEvent); assert.equal(app.drawerOpen, false);
  assert.equal(primaryControl('editor').value, 'Exact retained draft'); assert.equal(primaryControl('transcript').scrollTop, 140); assert.equal(selectionSaves.length, 0); assert.equal(app.state.workspace?.sidebarVisible, true);
  app.toggleSidebar(true); host.viewport = 1100; app.renderNavigation(); assert.equal(app.drawerOpen, false); assert.equal(byId('sidebar').hidden, false);
});
test('drawer dismissal excludes its own controls, dialogs, command lists and context menus', () => {
  host.viewport = 760; app.toggleSidebar(true);
  for (const node of [byId('sidebar'), new HostNode('dialog'), Object.assign(new HostNode('div'), {className: 'command-menu'}), Object.assign(new HostNode('div'), {className: 'context-menu'})]) {
    app.dismissDrawerPointer({target: node, preventDefault: () => assert.fail('excluded surface'), stopImmediatePropagation: () => assert.fail('excluded surface')} as unknown as PointerEvent);
    assert.equal(app.drawerOpen, true);
  }
  contextMenu.open(byId('sidebar-show') as unknown as HTMLElement, {x: 4, y: 4}, 'Fixture menu', [{label: 'Fixture', run() {}}]);
  app.dismissDrawerPointer({target: primaryControl('send')} as unknown as PointerEvent); assert.equal(app.drawerOpen, true);
  app.appKey({key: 'Escape', preventDefault: () => assert.fail('menu Escape belongs to its menu')} as KeyboardEvent); assert.equal(app.drawerOpen, true);
  contextMenu.close(); app.toggleSidebar(false); host.viewport = 1200;
});
test('the conversation list reuses exact tab activation without a new navigation lane', async () => {
  const layout = singlePane([{kind: 'primary'}, {kind: 'agent', identity: 'list-a'}, {kind: 'agent', identity: 'list-b'}]);
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: layout}, primaries: [primaryFixture({epoch: 715})], roster: [agentFixture('list-a', {name: 'Review'}), agentFixture('list-b', {name: 'Review'})]});
  const rows = byId('sidebar-conversations').querySelectorAll('.conversation-row'); assert.equal(rows.length, 3); assert.notEqual(rows[1]?.textContent, rows[2]?.textContent); assert.notEqual(rows[1]?.getAttribute('aria-label'), rows[2]?.getAttribute('aria-label'));
  for (const [index, row] of rows.entries()) {const status = row.querySelector('.conversation-state'); assert.ok(status); assert.equal(status.getAttribute('aria-hidden'), 'true'); assert.equal(status.querySelector('svg')?.getAttribute('class'), index === 0 ? 'card-icon card-icon-working' : 'card-icon card-icon-success'); assert.equal(status.title, index === 0 ? 'Working' : 'Connected'); assert.match(row.getAttribute('aria-label') ?? '', index === 0 ? /Working/ : /Connected/);}
  rows[2]?.click(); await settle(); assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: 'list-b'}); assert.equal(hostDocument.activeElement, agentControl('editor')); assert.equal(rows[2]?.getAttribute('aria-current'), 'true');
});

test('reselecting the active conversation entry closes a drawer without a desktop preference write', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',sidebarVisible:true,selectedTarget:{kind:'agent',identity:'overflow-a'},conversationLayout:singlePane([{kind:'primary'},{kind:'agent',identity:'overflow-a'}],'agent:overflow-a')},primaries:[primaryFixture({epoch:716})],roster:[agentFixture('overflow-a')]});host.viewport=760;app.toggleSidebar(true);selectionSaves.length=0;byId('sidebar-conversations').querySelector('[data-tab-key="agent:overflow-a"]')?.click();await settle();assert.equal(app.drawerOpen,false);assert.equal(byId('sidebar').hidden,true);assert.equal(app.state.workspace?.sidebarVisible,true);assert.equal(selectionSaves.some(save=>save.body.sidebarVisible!==undefined),false);host.viewport=1200;
});

test('the desktop transition restores the hidden-sidebar preference and a visible focus target', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', sidebarVisible: false, selectedTarget: {kind: 'primary', key: 'p', epoch: 1}}, primaries: [primaryFixture()], roster: []});
  host.viewport = 760; app.toggleSidebar(true); assert.equal(hostDocument.activeElement, byId('session-open'));
  const sidebar = byId('sidebar'); const project = byId('session-open'), parent = project.parentNode, sibling = project.nextSibling; assert.ok(parent); sidebar.append(project);
  host.viewport = 1100; app.renderNavigation(); assert.equal(app.drawerOpen, false); assert.equal(byId('sidebar').hidden, true); assert.equal(app.state.workspace?.sidebarVisible, false);
  assert.equal(hostDocument.activeElement, byId('sidebar-show')); parent.insertBefore(project, sibling); host.viewport = 1200;
});

test('unread notifications name their direct control and clear only after deliberate review', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  const counter = byId('notices-count'); const control = byId('notifications-button'); assert.equal(counter.hidden, true);
  event('notice', {id: 'visible-notice', level: 'info', message: 'A notification', at: 'now'});
  assert.equal(counter.hidden, false); assert.equal(counter.textContent, '1'); assert.equal(control.attributes.get('aria-label'), 'Notifications (1 unread)');
  assert.equal(control.title, 'Notifications (1 unread)'); assert.equal(counter.parentNode, control);
  control.click(); assert.equal(contextMenu.openNow, false); assert.match(byId('modal-body').textContent, /A notification/);
  assert.equal(counter.hidden, true); assert.equal(control.attributes.get('aria-label'), 'Notifications'); byId('modal-close').click();
});


test('project navigation remains an anchored project-first menu beside direct utility actions', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({sessionId: 'named-project', sessionName: 'Release notes'})], roster: []});
  const project = byId('project-button'); project.click(); await settle(); const projects = menuNode();
  assert.equal(projects.getAttribute('aria-label'), 'Working folder'); assert.equal(project.getAttribute('aria-expanded'), 'true');
  assert.equal(byId('modal').open, false); assert.doesNotMatch(projects.textContent, /Release notes|In this window|List details|Cancel/);
  const choice = projects.children.find(node => node.textContent === 'project'); assert.ok(choice); assert.match(choice.getAttribute('aria-description') ?? '', /Release notes/);
  assert.equal(projects.style.left, `${Math.max(4, project.getBoundingClientRect().left)}px`);
  projects.dispatch('keydown', {key: 'Escape', preventDefault() {}, stopPropagation() {}});
  assert.equal(project.getAttribute('aria-expanded'), 'false'); assert.equal(hostDocument.activeElement, project);
  byId('appearance-button').click(); assert.equal(contextMenu.openNow, false); assert.equal(byId('modal').open, true);
  assert.equal(byId('modal-title').textContent, 'Appearance'); byId('modal-close').click();
  assert.doesNotMatch(html, /id="app-menu"|id="window-menu"/);
});
test('three direct utility icons preserve inventory, native button focus, destinations and unread count', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  const footer = byId('sidebar').querySelector('.sidebar-footer'); assert.ok(footer);
  assert.deepEqual(footer.querySelectorAll('button').map(node => node.getAttribute('aria-label')), ['Commands', 'Notifications', 'Appearance']);
  assert.equal(hostDocument.getElementById('app-menu'), undefined); assert.doesNotMatch(source, /byId\('app-menu'\)|'App menu'/);
  event('notice', {id: 'direct-utility-notice', level: 'info', message: 'Review through the direct icon', at: 'now'});
  for (const [id, icon, title] of [['commands-button', 'commands', 'Commands'], ['appearance-button', 'appearance', 'Appearance'], ['notifications-button', 'notifications', 'Notifications']]) {
    const control = byId(id as string); assert.equal(control.getAttribute('type'), 'button'); assert.equal(control.tabIndex, 0); assert.equal(control.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(control.querySelector('svg')?.getAttribute('class'), `card-icon card-icon-${icon}`);
    assert.equal(control.querySelector('svg')?.getAttribute('aria-hidden'), 'true'); assert.ok(control.title.startsWith(title as string));
    control.focus(); control.click(); await settle(); assert.equal(contextMenu.openNow, false); assert.equal(byId('modal').open, true); assert.equal(byId('modal-title').textContent, title);
    assert.equal(byId('notices-count').hidden, id === 'notifications-button');
    byId('modal-close').click(); assert.equal(hostDocument.activeElement, control);
  }
});
test('notifications produce existing semantic classes instead of unused prefixed classes', async () => {
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(source, /notification \$\{notice\.level\}/);
  assert.match(css, /\.secondary, \.info \{ color: var\(--muted\)/);
  assert.match(css, /\.warning \{ color: var\(--warning\)/);
  assert.match(css, /\.error, button.danger \{ color: var\(--error\)/);
});
test('Message panel settings describe its captured agent instead of a prior agent or Primary', async () => {
  const row = agentFixture('message-settings', {name: 'Recipient', model: {provider: 'agent-provider', modelId: 'recipient-model'}, thinkingLevel: 'low'});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'primary', key: 'p', epoch: 1}}, primaries: [primaryFixture({model: {provider: 'primary-provider', id: 'primary-model', name: 'Primary model', reasoning: false, input: ['text']}})], roster: [row]});
  const agent = byId('roster').children.find(node => node.dataset.identity === row.identity); assert.ok(agent); const message = agent.querySelector('.row-message'); assert.ok(message); message.click(); await settle();
  assert.equal(byId('agent-message-panel').hidden, false); assert.equal(byId('agent-status').hidden, false);
  assert.equal(byId('agent-status').textContent, 'Model recipient-model (retained) · Thinking low (retained)'); assert.equal(byId('agent-status').title, 'agent-provider/recipient-model');
  assert.equal(messageControl('recipient').textContent, 'Message Recipient'); assert.equal(primaryControl('root').hidden, false);
  const editor = messageControl('editor'); editor.value = 'Keep the recipient draft'; editor.dispatch('input'); editor.focus(); editor.setSelectionRange(3, 8);
  event('agent.availability', {identity: row.identity, state: 'live', capabilities: {input: false}});
  assert.match(byId('agent-message-status').textContent, /Message access changed/); assert.equal(messageControl('recipient').textContent, 'Draft for Recipient');
  assert.equal(messageControl('send').disabled, true); assert.equal(messageControl('editor'), editor); assert.equal(editor.value, 'Keep the recipient draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [3, 8]);
  assert.equal(hostDocument.activeElement, editor); assert.doesNotMatch(messageControl('send').getAttribute('aria-description') ?? '', /not connected/);
  const retry = byId('agent-message-retry'); assert.equal(retry.hidden, false); assert.equal(retry.disabled, false); assert.equal(retry.textContent, 'Check connection');
  const preparations = transportLog.filter(call => call.path.endsWith('/targets')).length;
  const inputs = transportLog.filter(call => call.path.includes('/inputs')).length;
  const staleRetry = retry.onclick; retry.focus(); retry.click();
  assert.equal(retry.hidden, false); assert.equal(retry.disabled, true); assert.equal(hostDocument.activeElement, editor); await settle();
  assert.equal(transportLog.filter(call => call.path.endsWith('/targets')).length, preparations + 1);
  assert.equal(transportLog.filter(call => call.path.includes('/inputs')).length, inputs);
  assert.equal(byId('agent-message-panel').hidden, false); assert.equal(retry.hidden, true);
  assert.equal(messageControl('editor'), editor); assert.equal(editor.value, 'Keep the recipient draft');
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [3, 8]); assert.equal(hostDocument.activeElement, editor);
  assert.equal(app.state.workspace?.selectedTarget?.kind, 'primary');
  const completed = transportLog.filter(call => call.path.endsWith('/targets')).length; staleRetry?.(); await settle();
  assert.equal(transportLog.filter(call => call.path.endsWith('/targets')).length, completed); byId('agent-message-close').click();
});

test('a connected agent without input retains a draft without a false disconnection explanation', async () => {
  const row = agentFixture('no-input', {availability: 'live', capabilities: {input: false}});
  await arrive({workspace: {id: 'w', revision: 1, selectedTarget: {kind: 'agent', identity: row.identity}, panelVisible: true}, primaries: [], roster: [row], targets: [targetFixture('no-input', {kind: 'agent', identity: row.identity})]});
  assert.match(hostDocument.title, /Connected$/); assert.equal(agentControl('editor').disabled, false); assert.equal(agentControl('send').disabled, true);
  assert.equal(agentControl('send').attributes.get('aria-description'), 'Messages are unavailable for this agent.'); assert.doesNotMatch(agentControl('empty').textContent, /not connected/);
});

test('the sidebar avoids a duplicate Primary destination and retains its closed-tab return action', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  assert.equal(byId('primary-row').hidden, true);
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: singlePane([])}, primaries: [primaryFixture()], roster: []});
  assert.equal(byId('primary-row').hidden, false); assert.equal(byId('primary-row').attributes.get('aria-label'), 'Return to Primary');
  byId('primary-row').click(); await settle(); assert.equal(byId('primary-row').hidden, true);
  assert.equal(paneLeaves(app.state.workspace?.conversationLayout?.root ?? singlePane([]).root)[0]?.tabs[0]?.kind, 'primary');
});

test('stored connection checks keep both drafts and use only exact-target preparation', async () => {
  const target = {kind: 'agent' as const, identity: 'stored-check'};
  const primaryTarget = {kind: 'primary' as const, key: 'p', epoch: 2};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target, panelVisible: true}, primaries: [primaryFixture({epoch: 2})], roster: [agentFixture(target.identity, {availability: 'stored', capabilities: {input: false}})], targets: [targetFixture('check-primary', primaryTarget, {draft: {revision: 7, text: 'Primary keep', mode: 'prompt', persisted: true}}), targetFixture('check-agent', target, {draft: {revision: 7, text: 'Agent keep', mode: 'followUp', persisted: true}})]});
  const primaryEditor = primaryControl('editor'); const agentEditor = agentControl('editor');
  assert.equal(agentControl('start-help').hidden, false); assert.match(agentControl('start-command').textContent, /\/agent attach stored-check/);
  assert.equal(byId('agent-usage-details').hidden, false); assert.equal(agentControl('editor').disabled, false); assert.equal(agentControl('send').disabled, true);
  assert.match(byId('agent-usage').textContent, /Cache usage is not reported/); assert.equal(byId('agent-usage-summary').textContent, '');
  const start = transportLog.length; await app.checkAgentConnection('w', target.identity); await settle();
  const mutations = transportLog.slice(start).filter(item => item.method === 'POST'); assert.deepEqual(mutations.map(item => item.path), ['/api/workspaces/w/targets']);
  assert.deepEqual(mutations[0]?.body, {target}); assert.equal(primaryControl('editor'), primaryEditor); assert.equal(agentControl('editor'), agentEditor);
  assert.equal(primaryEditor.value, 'Primary keep'); assert.equal(agentEditor.value, 'Agent keep'); assert.deepEqual(app.state.workspace?.selectedTarget, target);
});

test('old Check settlement repaints current stored controls without old-target status or focus transfer', async t => {
  const oldTarget = {kind: 'agent' as const, identity: 'check-old'}; const newTarget = {kind: 'agent' as const, identity: 'check-new'};
  const primaryTarget = {kind: 'primary' as const, key: 'p', epoch: 2222};
  const oldRow = agentFixture(oldTarget.identity, {availability: 'stored', capabilities: {input: false}});
  const newRow = agentFixture(newTarget.identity, {availability: 'stored', capabilities: {input: false}});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: oldTarget, panelVisible: true,
    conversationLayout: twoPanes(oldTarget.identity, 'agent-pane', [{kind:'agent',identity:newTarget.identity}])},
    primaries: [primaryFixture({epoch: primaryTarget.epoch})], roster: [oldRow, newRow],
    targets: [targetFixture('navigation-check-primary', primaryTarget, {draft: {revision: 9, text: 'Primary exact draft', mode: 'steer', persisted: true}}),
      targetFixture('check-old', oldTarget, {draft: {revision: 9, text: 'Old exact draft', mode: 'followUp', persisted: true}}),
      targetFixture('check-new', newTarget, {draft: {revision: 9, text: 'New exact draft', mode: 'followUp', persisted: true}})]});
  const fakeFetch = globalThis.fetch; let complete: ((response: Response) => void) | undefined;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), 'http://ui.test').pathname; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === '/api/workspaces/w/targets' && body?.target?.identity === oldTarget.identity) return new Promise(resolve => { complete = resolve; });
    return fakeFetch(input, init);
  });
  const before = transportLog.length; const pending = app.checkAgentConnection('w', oldTarget.identity); assert.ok(complete);
  const primaryEditor = primaryControl('editor'); const oldEditor = agentControl('editor');
  await app.selectAgent(newRow); await settle(); const agentEditor = agentControl('editor'); assert.notEqual(agentEditor, oldEditor); primaryEditor.setSelectionRange(2, 8); agentEditor.setSelectionRange(1, 6); agentEditor.focus();
  assert.equal(agentControl('start').disabled, true); assert.equal(agentControl('connect').disabled, true);
  const status = agentControl('connect-status').textContent; const afterNavigation = transportLog.length;
  complete(Response.json({ok: true, data: {targetState: targetFixture('old-late', oldTarget), availability: 'live', capabilities: {input: true}}}));
  await pending; await settle();
  assert.equal(agentControl('start').disabled, false); assert.equal(agentControl('connect').disabled, false);
  assert.deepEqual(app.state.workspace?.selectedTarget, newTarget); assert.equal(agentControl('connect-status').textContent, status);
  assert.equal(primaryControl('editor'), primaryEditor); assert.equal(agentControl('editor'), agentEditor);
  assert.equal(primaryEditor.value, 'Primary exact draft'); assert.equal(agentEditor.value, 'New exact draft'); assert.equal(oldEditor.value, 'Old exact draft');
  assert.deepEqual([primaryEditor.selectionStart, primaryEditor.selectionEnd], [2, 8]); assert.deepEqual([agentEditor.selectionStart, agentEditor.selectionEnd], [1, 6]);
  assert.equal(hostDocument.activeElement, agentEditor); assert.deepEqual(transportLog.slice(afterNavigation), []);
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start') || call.path.includes('/inputs')).length, 0);
});

let launchEpoch = 600;
async function storedLaunchFixture(identity: string): Promise<void> {
  const target = {kind: 'agent' as const, identity}; const primaryTarget = {kind: 'primary' as const, key: 'p', epoch: ++launchEpoch};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target, panelVisible: true, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: primaryTarget.epoch})], roster: [agentFixture(identity, {availability: 'stored', capabilities: {input: false}})], targets: [targetFixture(`launch-primary-${identity}`, primaryTarget, {draft: {revision: 9, text: 'Primary launch keep', mode: 'prompt', persisted: true}}), targetFixture(`launch-agent-${identity}`, target, {draft: {revision: 9, text: 'Agent launch keep', mode: 'followUp', persisted: true}})]});
}
function confirmLaunch(identity: string): Response {
  const row = agentFixture(identity);
  fixture = {...fixture, roster: fixture.roster.map(item => item.identity === identity ? row : item), observations: [observation(identity, {revision:1,observedAt:'now',entries:[],live:[],nextBefore:null,status:{busy:false},coverage}, (app.state.agentEpochs.get(identity) ?? 0) + 1)]};
  return Response.json({ok: true, data: fixturePreparation({kind: 'agent', identity})});
}

test('stored Start is explicit, uses fresh keys and retains both drafts, caret, focus and ready input', async t => {
  t.after(() => { startPreparation = undefined; }); const identity = 'explicit-start';
  const before = transportLog.length; await storedLaunchFixture(identity);
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start')).length, 0);
  const primaryEditor = primaryControl('editor'); const agentEditor = agentControl('editor');
  primaryEditor.setSelectionRange(2, 7); agentEditor.setSelectionRange(3, 8); app.focusPane('agent-pane');
  startPreparation = async captured => confirmLaunch(captured);
  await app.startStoredAgent('w', identity); await settle();
  const first = transportLog.slice(before).find(call => call.path.endsWith('/start')); assert.ok(first);
  assert.equal(first.path, '/api/agents/explicit-start/start'); assert.equal(first.workspace, 'w'); assert.deepEqual(first.body, {});
  assert.match(first.key ?? '', /^[0-9a-f-]{36}$/); assert.equal(agentControl('start-help').hidden, true); assert.equal(agentControl('send').disabled, false);
  assert.equal(primaryEditor.value, 'Primary launch keep'); assert.equal(agentEditor.value, 'Agent launch keep');
  assert.equal(primaryControl('editor'), primaryEditor); assert.equal(agentControl('editor'), agentEditor);
  assert.deepEqual([primaryEditor.selectionStart, primaryEditor.selectionEnd], [2, 7]); assert.deepEqual([agentEditor.selectionStart, agentEditor.selectionEnd], [3, 8]);
  assert.equal(hostDocument.activeElement, agentEditor); assert.equal(app.focusedPane, 'agent-pane'); assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity});
  fixture = {...fixture, roster: [agentFixture(identity, {availability: 'stored', capabilities: {input: false}})], observations: []};
  event('agent.availability', {identity, connectionEpoch: 2, state: 'stored', capabilities: {input: false}}); await settle();
  await app.startStoredAgent('w', identity); await settle();
  const starts = transportLog.slice(before).filter(call => call.path.endsWith('/start')); assert.equal(starts.length, 2); assert.notEqual(starts[1]?.key, first.key);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
});

test('uncertain stored Start remains attach-only across navigation and keeps the editable draft', async t => {
  t.after(() => { startPreparation = undefined; }); const identity = 'uncertain-start'; await storedLaunchFixture(identity);
  const editor = agentControl('editor'); editor.focus(); editor.setSelectionRange(2, 7); const before = transportLog.length;
  startPreparation = async () => Response.json({ok: false, error: {code: 'not_ready', message: 'Readiness was not confirmed.', retry: 'manual'}});
  await app.startStoredAgent('w', identity); await settle();
  assert.match(agentControl('connect-status').textContent, /^Start not confirmed\./); assert.equal(agentControl('start').hidden, true); assert.equal(agentControl('start-disclosure').hidden, true);
  assert.equal(agentControl('connect').disabled, false); assert.equal(editor.value, 'Agent launch keep'); assert.equal(editor.disabled, false);
  assert.equal(agentControl('send').attributes.get('aria-description'), 'Use Check connection before you send a message.');
  assert.equal(hostDocument.activeElement, editor); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]);
  await app.startStoredAgent('w', identity); await storedLaunchFixture('other-start'); await storedLaunchFixture(identity); await app.startStoredAgent('w', identity);
  assert.equal(agentControl('start').hidden, true); assert.match(agentControl('connect-status').textContent, /^Start not confirmed\./);
  assert.equal(agentControl('send').attributes.get('aria-description'), 'Use Check connection before you send a message.');
  const starts = transportLog.slice(before).filter(call => call.path.endsWith('/start')); assert.equal(starts.length, 1);
  confirmLaunch(identity); await app.checkAgentConnection('w', identity); await settle();
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start')).length, 1);
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/targets')).length, 1);
  assert.equal(agentControl('send').disabled, false); assert.equal(agentControl('start-help').hidden, true);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
});

test('connection checks retain uncertainty until the selected observation confirms usable input', async t => {
  t.after(() => { startPreparation = undefined; }); const identity = 'unobserved-check'; await storedLaunchFixture(identity);
  startPreparation = async () => Response.json({ok: false, error: {code: 'not_ready', message: 'No readiness.', retry: 'manual'}});
  await app.startStoredAgent('w', identity); const editor = agentControl('editor'); editor.focus(); editor.setSelectionRange(2, 7);
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (new URL(String(input), 'http://ui.test/app').pathname.endsWith('/targets')) return Response.json({ok: true, data: {targetState: targetFixture('unobserved', {kind: 'agent', identity}), availability: 'live', capabilities: {input: true}}});
    return original(input, init);
  });
  const before = transportLog.length; await app.checkAgentConnection('w', identity); await settle();
  assert.equal(agentControl('start').hidden, true); assert.equal(agentControl('start-disclosure').hidden, true);
  assert.match(agentControl('connect-status').textContent, /^Start not confirmed\./); assert.equal(agentControl('send').disabled, true);
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity}); assert.equal(editor.value, 'Agent launch keep');
  assert.equal(hostDocument.activeElement, editor); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]);
  const selections = transportLog.slice(before).filter(call => call.path.endsWith('/selection')); assert.equal(selections.length, 1);
  const savedSelection = selections[0]?.body as {selectedTarget?: unknown} | undefined; assert.ok(savedSelection);
  assert.deepEqual(savedSelection.selectedTarget, {kind: 'agent', identity});
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start') || call.path.includes('/inputs')).length, 0);
});

test('pending stored Start deduplicates clicks and a stale completion never changes the new recipient or focus', async t => {
  t.after(() => { startPreparation = undefined; }); const identity = 'pending-start'; await storedLaunchFixture(identity);
  let complete: ((response: Response) => void) | undefined;
  startPreparation = () => new Promise(resolve => { complete = resolve; }); const before = transportLog.length;
  const pending = app.startStoredAgent('w', identity); await app.startStoredAgent('w', identity);
  assert.equal(agentControl('start').hidden, true); assert.equal(agentControl('connect').disabled, true);
  await storedLaunchFixture('new-recipient'); const editor = agentControl('editor'); editor.focus(); editor.setSelectionRange(1, 6);
  assert.ok(complete); complete(Response.json({ok: true, data: {targetState: targetFixture('late-target', {kind: 'agent', identity}), availability: 'live', capabilities: {input: true}}})); await pending; await settle();
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start')).length, 1);
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: 'new-recipient'}); assert.equal(editor.value, 'Agent launch keep');
  assert.equal(hostDocument.activeElement, editor); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [1, 6]);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
});

test('stored Start refuses a wrong prepared recipient or missing input and stale controls do not launch', async t => {
  t.after(() => { startPreparation = undefined; });
  for (const invalid of ['wrong-recipient', 'no-input']) {
    const identity = `invalid-start-${invalid}`; await storedLaunchFixture(identity); const before = transportLog.length;
    startPreparation = async () => Response.json({ok: true, data: {targetState: targetFixture('invalid-preparation', {kind: 'agent', identity: invalid === 'wrong-recipient' ? 'different' : identity}), availability: 'live', capabilities: {input: invalid !== 'no-input'}}});
    await app.startStoredAgent('w', identity); await settle(); assert.match(agentControl('connect-status').textContent, /^Start not confirmed\./);
    assert.equal(agentControl('send').disabled, true); assert.equal(agentControl('start').hidden, true);
    await app.startStoredAgent('wrong-workspace', identity); await app.startStoredAgent('w', 'different');
    assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start')).length, 1);
    assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
  }
});

test('failed-session recovery leaves retained text and unconfirmed input under the old target', async () => {
  const target = {kind: 'primary' as const, key: 'p', epoch: 3};
  const unconfirmed = [{operationId: 'unresolved', target, text: 'Unconfirmed text', mode: 'prompt', submittedDraftRevision: 1, createdAt: 'now', reason: 'Uncertain'}];
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target}, primaries: [primaryFixture({epoch: 3, lifecycle: 'failed', sessionFile: '/fixture/exact.jsonl', pid: 42, lastError: {code: 'host_unavailable', message: 'Failed', retry: 'manual'}})], roster: [], targets: [targetFixture('failed-retained', target, {draft: {revision: 7, text: 'Retained failure draft', mode: 'prompt', persisted: true}, unconfirmed})]});
  assert.match(primaryControl('activity').textContent, /Pi did not confirm that its process exited/); assert.match(primaryControl('activity').textContent, /Sessions/);
  assert.equal(primaryControl('editor').value, 'Retained failure draft'); assert.equal(app.primaryComposer().state?.unconfirmed[0]?.operationId, 'unresolved');
  assert.doesNotMatch(primaryControl('activity').textContent, /Resume this session/);
});

test('accepted working activity owns the tool while retained settings stay composer-local', async () => {
  const row=agentFixture('tool-agent',{state:'working',currentTool:{name:'read',argument:'src/current-file.ts'},model:{provider:'fixture',modelId:'model'}});
  await arrive({workspace:{id:'w',revision:1,selectedTarget:{kind:'agent',identity:row.identity},panelVisible:true},primaries:[],roster:[row],observations:[observation(row.identity,{revision:1,observedAt:'now',entries:[],live:[],nextBefore:null,status:{busy:true},coverage})]});
  assert.equal(tabsNode().children.find(node => node.attributes.get('aria-selected') === 'true')?.querySelector('.tab-state')?.textContent, 'Working'); assert.equal(byId('agent-status').textContent,'Model model (retained)');
  assert.equal(byId('agent-status').title,'fixture/model'); assert.doesNotMatch(html, /agent-pane-heading/);
  app.openTabActions(); const menu = hostDocument.body.children.find(node => node.className === 'context-menu'); assert.ok(menu);
  const detailsAction = menu.children.find(node => node.textContent === 'Conversation details'); assert.ok(detailsAction); detailsAction.click();
  assert.match(byId('modal-body').textContent, /Last reported tool/); assert.match(byId('modal-body').textContent, /src\/current-file.ts/); byId('modal-close').click();
});

test('metadata updates retain the disclosure, editor, caret, saved draft and recipient-only folder', async () => {
  const target = {kind: 'primary' as const, key: 'p', epoch: 6001};
  const saved = targetFixture('metadata-draft', target, {draft: {revision: 7, text: 'Keep metadata draft', mode: 'prompt', persisted: true}});
  const contextUsage = {tokens: 0, contextWindow: 4000, percent: 0};
  const usage = {cost: 0, tokens: {input: 4, output: 5, cacheRead: 6, cacheWrite: 7, total: 22}};
  const workspace = {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target};
  await arrive({workspace, primaries: [primaryFixture({epoch: 6001, cwd: '/reported/primary', contextUsage, usage})], roster: [], targets: [saved]});
  const editor = primaryControl('editor'); const details = byId('primary-usage-details'); editor.focus(); editor.setSelectionRange(3, 9);
  Reflect.set(details, 'open', true); const height = editor.style.height;
  assert.match(byId('primary-context').textContent, /Context 0%.*0\/4/);
  assert.match(byId('primary-usage-summary').textContent, /Session ~\$0.00/);
  assert.match(byId('primary-usage').textContent, /whole-session.*input 4, output 5, cache read 6, cache write 7/);
  assert.equal(byId('primary-folder').textContent, 'Folder /reported/primary');
  const inputs = transportLog.filter(call => call.path.includes('/inputs')).length;
  await arrive({workspace, primaries: [primaryFixture({epoch: 6001, cwd: undefined, contextUsage: {tokens: null, contextWindow: 4000, percent: null}})], roster: [], targets: [saved]});
  assert.equal(primaryControl('editor'), editor); assert.equal(byId('primary-usage-details'), details); assert.equal(Reflect.get(details, 'open'), true);
  assert.equal(editor.value, saved.draft.text); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [3, 9]); assert.equal(hostDocument.activeElement, editor); assert.equal(editor.style.height, height);
  assert.match(byId('primary-context').textContent, /Context unknown.*\?\/4/); assert.match(byId('primary-usage').textContent, /Missing cost is not zero/);
  assert.equal(byId('primary-folder').hidden, true); assert.equal(byId('primary-folder').textContent, '');
  assert.equal(transportLog.filter(call => call.path.includes('/inputs')).length, inputs);
});

test('Message panel uses its captured loaded cache and ignores unaccepted late frames without focus or admission changes', async () => {
  const row = agentFixture('metadata-recipient', {cwd: '/saved/recipient', model: {provider: 'saved', modelId: 'retained'}, thinkingLevel: 'low'});
  const message = {...messageFixture('metadata-final', [textPart('Retained result')]), usage: {input: 5, cacheRead: 5, cacheWrite: 0}};
  const frame = {revision: 1, observedAt: 'now', entries: [entryFixture('metadata-entry', [message])], live: [], nextBefore: null, status: {busy: false, model: {provider: 'accepted', modelId: 'live-model'}}, coverage};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: row.identity}, panelVisible: true}, primaries: [primaryFixture()], roster: [row], observations: [observation(row.identity, frame)]});
  await arrive({workspace: {id: 'w', revision: 2, primaryKey: 'p', selectedTarget: {kind: 'primary', key: 'p', epoch: 1}, conversationLayout: twoPanes(row.identity, 'primary-pane')}, primaries: [primaryFixture()], roster: [row, agentFixture('other-recipient')], observations: [observation(row.identity, frame)]});
  byId('roster').children.find(node => node.dataset.identity === row.identity)?.querySelector('.row-message')?.click(); await settle();
  const editor = messageControl('editor'); editor.value = 'Keep captured draft'; editor.dispatch('input'); await settle(); editor.focus(); editor.setSelectionRange(2, 7);
  const details = byId('agent-usage-details'); Reflect.set(details, 'open', true);
  assert.equal(byId('workbench-status').dataset.pane, 'agent'); assert.equal(byId('workbench-scope').title, row.identity);
  assert.equal(byId('workbench-status-primary').hidden, true); assert.equal(byId('workbench-status-agent').hidden, false);
  assert.equal(app.state.workspace?.selectedTarget?.kind, 'primary');
  const before = transportLog.length;
  event('agent.frame', {identity: row.identity, connectionEpoch: 0, frame: {...frame, revision: 2, status: {busy: false, model: {provider: 'unaccepted', modelId: 'late-model'}}}}); flushFrames(); await settle();
  assert.equal(byId('agent-status').textContent, 'Model live-model · Thinking low (retained)');
  assert.match(byId('agent-usage-summary').textContent, /Cache 50% · loaded/); assert.doesNotMatch(byId('agent-usage').textContent, /Primary|whole-session cost|context window/);
  assert.equal(byId('agent-folder').textContent, 'Saved folder /saved/recipient');
  event('agent.frame', {identity: 'other-recipient', connectionEpoch: 1, frame: {...frame, status: {busy: true, model: {provider: 'other', modelId: 'not-recipient'}}}}); flushFrames(); await settle();
  assert.equal(byId('agent-status').textContent, 'Model live-model · Thinking low (retained)');
  assert.equal(messageControl('editor'), editor); assert.equal(editor.value, 'Keep captured draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]); assert.equal(hostDocument.activeElement, editor);
  assert.equal(byId('agent-usage-details'), details); assert.equal(Reflect.get(details, 'open'), true);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs') || call.path.endsWith('/targets')).length, 0);
  byId('agent-message-close').click();
});


test('three exact owners isolate drafts, carets, roots and accepted frames through pane and Message moves', async t => {
  host.viewport = 1800; t.after(() => {host.viewport = 1200; byId('agent-message-close').click();});
  const p = {kind: 'primary' as const, key: 'p', epoch: 9500}, a = {kind: 'agent' as const, identity: 'three-a'}, b = {kind: 'agent' as const, identity: 'three-b'};
  const frame = (identity: string, revision: number): ProjectedFrame => ({revision, observedAt: 'now', entries: [entryFixture(identity + revision, [messageFixture(`${identity}-m${revision}`, [textPart(`${identity} frame ${revision}`)])])], live: [], nextBefore: null, status: {busy: false, model: {provider: 'frame-owner', modelId: `${identity}-model-${revision}`}}, coverage});
  const layout: ConversationLayout = {focusedPane: 'pane-a', root: {kind: 'split', id: 'three-x', axis: 'x', ratio: 50,
    first: {kind: 'pane', id: 'pane-p', tabs: [{kind: 'primary'}], active: 'primary'},
    second: {kind: 'split', id: 'three-y', axis: 'y', ratio: 50, first: {kind: 'pane', id: 'pane-a', tabs: [a], active: tabKey(a)}, second: {kind: 'pane', id: 'pane-b', tabs: [b], active: tabKey(b)}}}};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: a, conversationLayout: layout}, primaries: [primaryFixture({epoch: p.epoch})], roster: [agentFixture(a.identity), agentFixture(b.identity)],
    observations: [observation(a.identity, frame(a.identity, 1), 10), observation(b.identity, frame(b.identity, 1), 20)], targets: [p, a, b].map((target, index) => targetFixture(`three-${index}`, target, {draft: {revision: 7, text: ['Primary exact draft', 'Alpha exact draft', 'Beta exact draft'][index] ?? '', mode: target.kind === 'primary' ? 'steer' : 'prompt', persisted: true}}))});
  const pc = controls(app.primaryComposer()), ac = controls(app.agentComposer());
  app.focusPane('pane-b'); await settle(); const bc = controls(app.agentComposer()); app.focusPane('pane-a'); await settle();
  const owners = [pc, ac, bc], roots = owners.map(owner => owner('root')), editors = owners.map(owner => owner('editor')), forms = owners.map(owner => owner('composer'));
  assert.equal(new Set(roots).size, 3); assert.equal(new Set(editors).size, 3); assert.equal(new Set(forms).size, 3);
  for (const [index, editor] of editors.entries()) { editor.value += ' local'; editor.dispatch('input'); editor.setSelectionRange(index + 1, index + 5, index === 1 ? 'backward' : 'forward'); editor.dispatch('select'); }
  await settle();
  const moved = movePaneTab(app.state.workspace?.conversationLayout ?? layout, tabKey(b), 'pane-a'); app.applyLayout(moved); await settle();
  assert.equal(bc('root'), roots[2]); assert.equal(bc('editor'), editors[2]); assert.equal(roots[2]?.parentNode?.id, 'pane-content-pane-a');
  fixture = {...fixture, observations: [observation(a.identity, frame(a.identity, 1), 11), observation(b.identity, frame(b.identity, 1), 20)]};
  const restored = splitPane(app.state.workspace?.conversationLayout ?? moved, 'pane-a', 'y', {width: 760, height: 640, divider: 4}, tabKey(b)); app.applyLayout(restored); await settle();
  app.applyLayout(activatePaneTab(app.state.workspace?.conversationLayout ?? restored, 'pane-a', tabKey(a))); await settle();
  const bPane = paneLeaves((app.state.workspace?.conversationLayout ?? restored).root).find(pane => pane.active === tabKey(b)); assert.ok(bPane); app.openTabActions(bPane.id); const message = menuNode().children.find(node => node.textContent === 'Message'); assert.ok(message); message.click(); await settle();
  assert.equal(messageControl('composer'), forms[2]); assert.equal(messageControl('editor'), editors[2]); assert.equal(forms[2]?.parentNode, byId('agent-message-panel')); assert.deepEqual(app.state.workspace?.selectedTarget, a); editors[2]?.focus();
  event('agent.frame', {identity: a.identity, connectionEpoch: 11, frame: frame(a.identity, 2)}); event('agent.frame', {identity: b.identity, connectionEpoch: 20, frame: frame(b.identity, 2)}); await settle();
  assert.match(ac('transcript').textContent, /three-a frame 2/); assert.doesNotMatch(ac('transcript').textContent, /three-b frame/);
  assert.match(bc('transcript').textContent, /three-b frame 2/); assert.doesNotMatch(bc('transcript').textContent, /three-a frame/); assert.equal(messageControl('stop').hidden, true); assert.equal(byId('workbench-scope').title,b.identity); assert.match(byId('agent-status').textContent,/three-b-model-2/); assert.equal(hostDocument.activeElement,editors[2]);
  event('agent.frame', {identity: b.identity, connectionEpoch: 19, frame: frame('stale-b', 99)}); await settle(); assert.doesNotMatch(bc('transcript').textContent, /stale-b/);
  for (const [index, owner] of owners.entries()) { assert.equal(owner('root'), roots[index]); assert.equal(owner('editor'), editors[index]); assert.equal(owner('composer'), forms[index]); assert.deepEqual([editors[index]?.selectionStart, editors[index]?.selectionEnd], [index + 1, index + 5]); assert.equal(editors[index]?.selectionDirection,index === 1 ? 'backward' : 'forward'); }
  assert.deepEqual(editors.map(editor => editor.value), ['Primary exact draft local', 'Alpha exact draft local', 'Beta exact draft local']);
  byId('agent-message-close').click(); await settle(); assert.equal(forms[2]?.parentNode, roots[2]);
});

test('focused footer retains the same ordered owner nodes and replaces them only on owner change', async () => {
  const identity = 'footer-owner-change'; await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 9501})], roster: [agentFixture(identity)]});
  const slot = byId('focused-composer-status'); const agentNodes = [...slot.children], moves = agentNodes.map(node => node.moves), writes = slot.writes;
  app.renderNavigation(); app.renderNavigation(); await settle(); assert.deepEqual(slot.children, agentNodes); assert.equal(slot.writes, writes); assert.deepEqual(agentNodes.map(node => node.moves), moves);
  app.focusPane('primary-pane'); await settle(); const primaryNodes = [...slot.children]; assert.equal(primaryNodes.length, 2); assert.notEqual(primaryNodes[0], agentNodes[0]); assert.equal(slot.writes, writes + 1);
  const primaryWrites = slot.writes, primaryMoves = primaryNodes.map(node => node.moves); app.renderNavigation(); await settle(); assert.equal(slot.writes, primaryWrites); assert.deepEqual(primaryNodes.map(node => node.moves), primaryMoves);
  app.focusPane('agent-pane'); await settle(); assert.deepEqual(slot.children, agentNodes); assert.equal(slot.writes, primaryWrites + 1);
});

test('closing a Message and its tab retains an unsettled receipt under its exact owner', async t => {
  const target = {kind: 'agent' as const, identity: 'unsettled-owner'}, p = {kind: 'primary' as const, key: 'p', epoch: 9502};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target, conversationLayout: twoPanes(target.identity)}, primaries: [primaryFixture({epoch: p.epoch})], roster: [agentFixture(target.identity)], targets: [targetFixture('unsettled-p', p), targetFixture('unsettled-a', target, {draft: {revision: 7, text: 'Exact pending input', mode: 'prompt', persisted: true}})]});
  const composer = app.agentComposer(), owner = controls(composer), editor = owner('editor'), form = owner('composer');
  const message = byId('roster').querySelector('[data-identity="unsettled-owner"]')?.querySelector('.row-message'); assert.ok(message); message.click(); await settle();
  const original = globalThis.fetch, result = Promise.withResolvers<Response>(), started = Promise.withResolvers<void>(); let operationId = '';
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => { if (new URL(String(input), 'http://ui.test').pathname === '/api/agents/unsettled-owner/inputs') {operationId = new Headers(init?.headers).get('Idempotency-Key') ?? ''; started.resolve(); return result.promise;} return original(input, init); };
  form.dispatch('submit'); await started.promise; assert.equal(composer.canDispose, false); byId('agent-message-close').click(); await settle();
  app.applyLayout(singlePane()); await settle(); assert.equal(composer.canDispose, false); message.click(); await settle(); assert.equal(messageControl('composer'), form); assert.equal(messageControl('editor'), editor);
  result.resolve(Response.json({ok: true, data: {id: operationId, kind: 'agent.input', target, state: 'uncertain', createdAt: 'now', updatedAt: 'now', error: {code: 'host_unavailable', message: 'Delivery not confirmed', retry: 'manual'}}})); await settle();
  assert.equal(messageControl('editor'), editor); assert.match(messageControl('receipt').textContent, /not confirmed|Delivery/i); assert.equal(composer.canDispose, false); assert.doesNotMatch(primaryControl('receipt').textContent, /Delivery not confirmed/); byId('agent-message-close').click();
});


test('held Agent capabilities block the captured Stop control without a reservation', async () => {
  const identity = 'held-stop-owner'; await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 9530})], roster: [agentFixture(identity, {capabilities: {input: true, abort: false}})], observations: [observation(identity)]});
  const owner = controls(app.agentComposer()), stop = owner('stop'), editor = owner('editor'), before = transportLog.length;
  assert.equal(stop.hidden, true); stop.click(); await settle();
  event('agent.availability', {identity, connectionEpoch: 1, state: 'live', capabilities: {input: false, abort: true}}); await settle(); stop.click(); await settle();
  assert.equal(stop.hidden, true); assert.equal(owner('editor'), editor); assert.equal(byId('modal').open, false);
  assert.equal(transportLog.slice(before).filter(call => call.path === '/api/operations' || call.path.endsWith('/abort')).length, 0);
});

test('a stale Stop confirmation cannot dispatch after its captured owner leaves the active pane', async () => {
  const identity = 'stale-stop-owner'; await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 9531})], roster: [agentFixture(identity)], observations: [observation(identity)]});
  const owner = controls(app.agentComposer()); owner('stop').click(); await settle();
  assert.equal(byId('modal').open, true); const confirm = byId('modal-body').querySelector('button.danger'); assert.ok(confirm); const before = transportLog.length;
  app.applyLayout(singlePane()); await settle(); const editor = primaryControl('editor'); editor.focus(); confirm.click(); await settle();
  assert.equal(transportLog.slice(before).filter(call => call.path === '/api/operations' || call.path.endsWith('/abort')).length, 0);
  assert.equal(hostDocument.activeElement, editor); assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'primary', key: 'p', epoch: 9531}); byId('modal').close();
});

test('queued view writes keep the old workspace acknowledgment despite a same-key current target', async t => {
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  for (const [index, kind] of (['reading', 'presentation'] as const).entries()) {
    const target = {kind: 'primary' as const, key: 'p', epoch: 9540 + index}, key = 'shared-view-key', workspace = `queued-old-${kind}`;
    const old = targetFixture(key, target, {reading: {revision: 7, anchorId: null, offsetPx: 0, followTail: true}, presentation: {revision: 5, expanded: [], showThinking: false, transcriptView: 'chronological'}});
    const history = Array.from({length: 20}, (_, at) => entryFixture(`queued-history-${kind}${at}`, [messageFixture(`queued-message-${kind}${at}`, [textPart(`Queued history ${at}`)])]));
    await arrive({workspace: {id: workspace, revision: 1, primaryKey: 'p', selectedTarget: target}, primaries: [primaryFixture({epoch: target.epoch})], roster: [], targets: [old], history});
    const response = Promise.withResolvers<Response>(), requests: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input), 'http://ui.test').pathname === `/api/workspaces/${workspace}/targets/${key}/${kind}`) {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        if (requests.length === 1) return response.promise;
        const {expectedRevision, ...values} = body; return Response.json({ok: true, data: {...values, revision: Number(expectedRevision) + 1}});
      }
      return original(input, init);
    };
    const scroller = primaryControl('transcript');
    const change = async (value: number) => {
      if (kind === 'reading') {scroller.scrollTop = value; scroller.dispatch('scroll'); flushFrames(); scroller.dispatch('scrollend');}
      else {app.openTabActions(); const item = menuNode().children.find(node => node.textContent === (value === 120 ? 'View: Grouped' : 'View: Conversation')); assert.ok(item); item.click();}
      await settle();
    };
    await change(120); assert.equal(requests.length, 1); await change(240); assert.equal(requests.length, 1);
    assert.ok(old.presentation); const current = targetFixture(key, target, {reading: {...old.reading, revision: 50}, presentation: {...old.presentation, revision: 50}});
    await arrive({workspace: {id: `queued-new-${kind}`, revision: 1, primaryKey: 'p', selectedTarget: target}, primaries: [primaryFixture({epoch: target.epoch})], roster: [], targets: [current], history});
    const editor = primaryControl('editor'), notice = primaryControl('view-notice'); editor.focus(); notice.dataset.kind = kind; notice.textContent = 'Current workspace notice';
    const first = requests[0]; assert.ok(first); const {expectedRevision, ...values} = first;
    response.resolve(Response.json({ok: true, data: {...values, revision: Number(expectedRevision) + 1}})); await settle();
    assert.equal(requests.length, 2); assert.equal(requests[1]?.expectedRevision, Number(expectedRevision) + 1); assert.notEqual(requests[1]?.expectedRevision, 50);
    assert.equal(app.state.targets.get(key)?.[kind]?.revision, 50); assert.equal(notice.textContent, 'Current workspace notice'); assert.equal(hostDocument.activeElement, editor);
    globalThis.fetch = original;
  }
});
