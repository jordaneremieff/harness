import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {after} from 'node:test';
import type { AgentRow, ConversationLayout, ConversationTab, EntryView, MessageView, OperationView, PartView, PrimaryView, ProjectedFrame, Snapshot, Target, TargetState, Workspace } from '../shared/api.ts';
import type { Composer } from './composer.ts';
import { createPaneLayout, validPaneLayout } from './pane-layout.ts';
import { tabKey } from './tabs.ts';
import { targetIdentity } from './state.ts';

export type Fixture = {workspace: Workspace; primaries: PrimaryView[]; roster: AgentRow[]; targets?: TargetState[]; confirmed?: boolean;
  selectedPage?: Snapshot['selectedPage']; observations?: Snapshot['observations']; history?: EntryView[]; pendingOperations?: OperationView[]};

let application = false;
let app: typeof import('./app.ts');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
type Handler = (event: Record<string, unknown>) => void;
export class HostNode {
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
      node.dispatchProperty(name, value);
    }
    if (!stopped && ['click', 'contextmenu', 'focusin', 'focusout', 'pointerdown'].includes(name)) for (const handler of documentHandlers.get(name) ?? []) handler(value);
  }
  private dispatchProperty(name: string, value: Record<string, unknown>): void {
    if (application) return;
    const property = Reflect.get(this, `on${name}`); if (typeof property === 'function') property.call(this, value);
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
  show(): void { this.open = true; }
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
const windowHandlers = new Map<string, Handler[]>();
function beforeUnload(): boolean {let prevented = false; for (const handler of windowHandlers.get('beforeunload') ?? []) handler({preventDefault: () => {prevented = true;}}); return prevented;}
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
  dispatchEvent: (event: Event) => {if (!application) return true; documentDispatches.push(event.type); for (const handler of documentHandlers.get(event.type) ?? []) handler({target: hostDocument}); return true;},
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
  addEventListener: (name: string, handler: Handler) => {if (!application) windowHandlers.set(name, [...windowHandlers.get(name) ?? [], handler]);},
  removeEventListener: (name: string, handler: Handler) => {if (!application) windowHandlers.set(name, (windowHandlers.get(name) ?? []).filter(item => item !== handler));},
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
  constructor(url: string) {if (application && url.startsWith('/api/dev/events')) developmentSources.push(this); else {streams.push(url); streamSources.push(this);}}
  addEventListener(name: string, handler: (event: {data: string; lastEventId: string}) => void): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]);
  }
  close(): void { this.closed = true; }
  emit(name: string, data: unknown): void {
    const message = {data: JSON.stringify({at: '', data}), lastEventId: `boot:${++cursorSequence}`};
    for (const listener of this.listeners.get(name) ?? []) listener(message);
  }
}
function singlePane(tabs: ConversationTab[] = [{kind: 'primary'}], active = tabs[0] ? tabKey(tabs[0]) : null): ConversationLayout { return createPaneLayout(tabs, active); }
function twoPanes(identity: string, focusedPane = 'agent-pane', extra: ConversationTab[] = []): ConversationLayout {
  return {root: {kind: 'split', id: 'split-fixture', axis: 'x', ratio: 50,
    first: {kind: 'pane', id: 'primary-pane', tabs: [{kind: 'primary'}], active: 'primary'},
    second: {kind: 'pane', id: 'agent-pane', tabs: [{kind: 'agent', identity}, ...extra], active: `agent:${identity}`}}, focusedPane};
}
function observation(identity: string, frame?: ProjectedFrame, connectionEpoch = application ? (app.state.agentEpochs.get(identity) ?? 0) + 1 : 1): NonNullable<Snapshot['observations']>[number] { return {identity, connectionEpoch, ...(frame ? {frame} : {})}; }
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
  const draft = {revision: 1, text: '', mode: 'prompt', persisted: true as const, ...overrides.draft, images: overrides.draft?.images ?? []};
  return {targetKey, target, reading: {revision: 1, anchorId: null, offsetPx: 0, followTail: true}, unconfirmed: [], retainedInputs: [], imageAvailability: [], ...overrides, draft};
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
let fixture: Fixture = {workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: singlePane()}, primaries: [primaryFixture()], roster: []};
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
  const key = decodeURIComponent(path.split('/')[5] ?? ''); const saved = !application || decodeURIComponent(path.split('/')[3] ?? '') === fixture.workspace.id ? fixture.targets?.find(item => item.targetKey === key) : undefined;
  const draft = {revision: Number(body?.expectedRevision ?? 0) + 1, text: String(body?.text ?? ''), mode: String(body?.mode ?? 'prompt'), images: (body?.images ?? []) as import('../shared/api.ts').DraftImage[], persisted: true as const};
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
const fileRoots = new Map<string,import('../shared/files.ts').FileRootSelection>();
function fixtureFileRoot(path:string,body?:Record<string,unknown>):unknown {
  const workspace = decodeURIComponent(path.split('/')[3] ?? '');const current = fileRoots.get(workspace) ?? {revision:0,root:null};
  if (!body) return current;
  const folder = String(body.path);const selected = {revision:current.revision+1,root:{id:folder,path:folder,name:folder.split('/').at(-1) ?? folder}};fileRoots.set(workspace,selected);return selected;
}
function fixtureCatalogRead(path:string):unknown {
  if (path === '/api/bootstrap') return {...snapshotOf(fixture, ++cursorSequence), limits: {}};
  if (path === '/api/snapshot') return snapshotOf(fixture, ++cursorSequence);
  if (/^\/api\/primaries\/[^/]+\/history(?!.*output)/.test(path)) { const primary = fixture.primaries.find(item => item.key === decodeURIComponent(path.split('/')[3] ?? '')); assert.ok(primary); return {target: {kind: 'primary', key: primary.key, epoch: primary.epoch}, items: fixture.history ?? [], nextCursor: null, coverage}; }
  if (/^\/api\/agents\/[^/]+\/history$/.test(path)) return {target: {kind: 'agent', identity: path.split('/')[3] ?? ''}, entries: [], nextBefore: null, coverage, revision: 'r'};
  if (path === '/api/operations') return {operationId: `op-${++operationSerial}`};
  if (path === '/api/agents/refresh') return {};
  if (path === '/api/agents') return snapshotOf(fixture, cursorSequence).roster;
  if (path.includes('/resources/')) return {items: [], nextCursor: null, revision: 'r'};
}
function fixtureRead(path: string, body?: Record<string, unknown>): unknown {
  if (!application && path.endsWith('/files/watch')) return {roots: ((body?.roots ?? []) as {rootId: string}[]).map(root => ({rootId: root.rootId, watch: 'live'}))};
  if (path.endsWith('/files/root')) return fixtureFileRoot(path,body);
  if (path.endsWith('/directory')) return {rootId:decodeURIComponent(path.split('/')[4] ?? ''),path:'',entries:[],nextCursor:null,revision:'r',coverage:{complete:true,visited:0}};
  const catalog = fixtureCatalogRead(path);if (catalog !== undefined) return catalog;
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
class HostResizeObserver {
  static instances: HostResizeObserver[] = [];
  readonly observed = new Set<unknown>();
  readonly callback: () => void;
  constructor(callback: () => void) {this.callback = callback; HostResizeObserver.instances.push(this);}
  observe(node: unknown): void {this.observed.add(node);}
  unobserve(node: unknown): void {this.observed.delete(node);}
  disconnect(): void {this.observed.clear();}
}
function installHost(): void {
  Object.assign(globalThis, {
    document: hostDocument, HTMLElement: HostNode, window: view, location: {href: 'http://ui.test/app?workspace=w', hash: ''},
    history: {replaceState() {}}, sessionStorage: hostSessionStorage, matchMedia: (query: string) => ({matches: query === '(min-width: 900px)' && host.viewport >= 900, addEventListener() {}, removeEventListener() {}}),
    getComputedStyle: view.getComputedStyle, requestAnimationFrame: hostRequestAnimationFrame, cancelAnimationFrame: hostCancelAnimationFrame,
    ResizeObserver: application ? HostResizeObserver : class {observe(): void {} unobserve(): void {} disconnect(): void {}},
    MutationObserver: class {observe(): void {} disconnect(): void {}},
    EventSource: FixtureEventSource,
    innerWidth: 1200, innerHeight: 800,
  });
  try { globalThis.navigator = {};} catch { /* Node exposes a read-only navigator; nothing under test reads it. */ }
}
const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const intervals = new Set<ReturnType<typeof setInterval>>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let hostClosed = false;
function installTimers(): void {
  Object.assign(globalThis, {setTimeout: (callback: () => void, delay = 0) => {
    const timer = nativeSetTimeout(() => {timers.delete(timer); callback();}, delay); timers.add(timer); return timer;
  }, setInterval: (callback: () => void, delay = 0) => {
    const timer = nativeSetInterval(callback, delay); intervals.add(timer); return timer;
  }});
}
const startupMetadata: HostNode[] = [];
const byId = (id: string): HostNode => {
  const node = hostDocument.getElementById(id);
  assert.ok(node, id);
  return node as HostNode;
};
async function settle(): Promise<void> { for (let round = 0; round < 4; round++) { flushFrames(); await new Promise(resolve => setImmediate(resolve)); } flushFrames(); }
function controls(composer: Composer): (key: string) => HostNode {
  const editor = composer.editor as unknown as HostNode, form = editor.closest('form'); assert.ok(form);
  const root = form.closest('.conversation');
  const selectors: Record<string, string> = {queued: '.queued-list'};
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
function paneNode(id: string): HostNode { const node = byId('conversation-panes').querySelector(`[data-pane-id="${id}"]`); assert.ok(node); return node; }
async function arrive(next: Fixture, preserveMissingLayout = false): Promise<void> {
  if (next.workspace.conversationLayout) assert.ok(validPaneLayout(next.workspace.conversationLayout));
  assert.ok((next.observations?.length ?? 0) <= 4);
  const selected = next.workspace.selectedTarget;
  const tabs: ConversationTab[] = [...(next.workspace.primaryKey ? [{kind: 'primary' as const}] : []), ...(selected?.kind === 'agent' ? [{kind: 'agent' as const, identity: selected.identity}] : [])];
  const conversationLayout = next.workspace.conversationLayout ?? singlePane(tabs, selected?.kind === 'agent' ? `agent:${selected.identity}` : tabs[0] ? tabKey(tabs[0]) : null);
  fixture = {...next, workspace: {...next.workspace, ...(preserveMissingLayout ? {} : {conversationLayout}), revision: Math.max(next.workspace.revision, (app.state.workspace?.revision ?? 0) + 1)}};
  await app.reload();
  await settle();
  if (application) await confirmFixtureAvailability();
}
async function confirmFixtureAvailability(): Promise<void> {
  if (fixture.confirmed !== false) {
    const identity = fixture.workspace.selectedTarget?.kind === 'agent' ? fixture.workspace.selectedTarget.identity : undefined, row = fixture.roster.find(item => item.identity === identity);
    if (row?.availability === 'live' && row.capabilities) {
      const conversation = app.state.conversations.get(targetIdentity({kind: 'agent', identity: row.identity}));
      event('agent.availability', {identity: row.identity, connectionEpoch: conversation?.connectionEpoch ?? (app.state.agentEpochs.get(row.identity) ?? 0) + 1, state: 'live', capabilities: row.capabilities}); await settle();
    }
  }
}
function event(name: string, data: unknown, target?: Target): void {
  cursorSequence = Math.max(cursorSequence + 1, ++eventSequence + 1000);
  app.receive({name: name as never, id: `boot:${cursorSequence}`, envelope: {at: '', ...(target ? {target} : {}), data} as never, bytes: 64});
}
/** Each test process starts one browser host and retains its startup profile. */
export async function createAppFixture(profile: 'application' | 'workspace' = 'workspace') {
  application = profile === 'application';
  if (application) fixture.targets = [targetFixture('startup-primary', {kind: 'primary', key: 'p', epoch: 1}, {draft: {revision: 1, text: 'Initial private draft', mode: 'steer', images: [], persisted: true}})];
  installHost(); installTimers();
  after(() => {hostClosed = true; for (const timer of timers) clearTimeout(timer); for (const timer of intervals) clearInterval(timer); timers.clear(); intervals.clear(); frames = [];});
  hostDocument.hidden = application;
  startupMetadata.push(... (application ? ['ui-generation', 'ui-client'] : []).map((name, index) => {
    const meta = new HostNode('meta'), content = (index ? 'c' : 'a').repeat(index ? 24 : 64);
    meta.setAttribute('name', name); meta.setAttribute('content', content); Reflect.set(meta, 'content', content); hostDocument.documentElement.append(meta); return meta;
  }));
  app = await import('./app.ts');
  if (!application) {await settle(); event('ready', {bootId: 'boot'}); await settle();}
  return {app, host, hostDocument, HostNode, HostResizeObserver, beforeUnload, arrive, settle, event, byId, primaryControl, agentControl, controls, paneNode,
    primaryFixture, agentFixture, targetFixture, entryFixture, messageFixture, textPart, imagePart, twoPanes, singlePane, observation,
    coverage, transportLog, selectionSaves, hostSessionStorage, startupMetadata, developmentSources, streamSources, documentDispatches,
    flushFrames, documentHandlers, view, snapshotOf, fixturePreparation,
    failSelection: (value: typeof selectionFailure): void => {selectionFailure = value;},
    get fixture() {return fixture;}, set fixture(value: Fixture) {fixture = value;},
    get startPreparation() {return startPreparation;}, set startPreparation(value: typeof startPreparation) {startPreparation = value;},
    get preferenceSave() {return preferenceSave;}, set preferenceSave(value: typeof preferenceSave) {preferenceSave = value;},
    get selectionFailure() {return selectionFailure;}, set selectionFailure(value: typeof selectionFailure) {selectionFailure = value;},
    get frames() {return frames;}, get frameCount() {return frameCount;}, get cursorSequence() {return cursorSequence;}, get hostClosed() {return hostClosed;},
  };
}
