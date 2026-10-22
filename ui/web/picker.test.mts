import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, {type TestContext} from 'node:test';
import type { AgentRow, CachedRoster, Bootstrap, PrimaryView, RecentProjectPage, SavedSession, SavedSessionPage } from '../shared/api.ts';
import type { Modal } from './modal.ts';
import type { SelectionChange } from './actions.ts';
import { ProjectPicker } from './picker.ts';
import { contextMenu } from './context-menu.ts';

class Node {
  children: Node[] = []; className = ''; id = ''; value = ''; title = ''; hidden = false; disabled = false;
  open = false; scrollLeft = 100; selectionStart = -1; selectionEnd = -1; focused = false; htmlFor = '';
  private handlers = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  classList = {contains: (name: string) => this.className.split(' ').includes(name), add: (name: string) => { this.className += ` ${name}`; }};
  attributes: Record<string, string> = {}; dataset: Record<string, string> = {}; private text = '';
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  prepend(...nodes: Node[]): void { this.children.unshift(...nodes); }
  replaceChildren(...nodes: Node[]): void { this.children = nodes; this.text = ''; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(name: string, callback: (event: Record<string, unknown>) => void): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], callback]); }
  dispatch(name: string, event: Record<string, unknown> = {}): void { for (const callback of this.handlers.get(name) ?? []) callback(event); }
  click(): void { this.dispatch('click'); }
  matches(selector: string): boolean { return selector.split(',').some(value => {const part = value.trim(); return part.startsWith('.') ? this.classList.contains(part.slice(1)) : part.startsWith('#') ? this.id === part.slice(1) : this.tag === part;}); }
  querySelectorAll(selector: string): Node[] { return descendants(this).filter(node => node.matches(selector)); }
  querySelector(selector: string): Node | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus(): void { this.focused = true; Reflect.set(document, 'activeElement', this); }
  getBoundingClientRect() { return {left: 8, top: 8, bottom: 36, width: 140, height: 28}; }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
}
function descendants(node: Node): Node[] { return node.children.flatMap(child => [child, ...descendants(child)]); }
const catalogPresentation: ConstructorParameters<typeof ProjectPicker>[0]['agentPresentation'] = row => ({name: row.name ?? 'Unnamed conversation', activity: 'Running', tone: 'warning', cwd: row.cwd});
const saved: SavedSessionPage = {items: [{id: 's', path: '/project/s.jsonl', project: '/project', revision: 'r', title: 'Saved title', titleSource: 'name' as const, titleState: 'ready', modifiedAt: '2026-01-01T00:00:00Z', size: 10}], total: 1, omitted: 0, nextCursor: null, titleCursor: null, observedAt: '2026-01-01T00:00:00Z'};
for (const [name, page] of [
  ['complete', saved],
  ['more pages', {...saved, total: 2, nextCursor: 'more'}],
  ['omissions', {...saved, omitted: 1}],
  ['unavailable title', {...saved, items: saved.items.map(item => ({...item, titleState: 'unavailable' as const}))}],
] as const) test(`saved session status merges freshness and coverage for ${name}`, async t => {
  t.mock.method(Date, 'now', () => Date.parse(saved.observedAt));
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const oldFetch = globalThis.fetch; const body = new Node('div');
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: Node});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {activeElement: null, createElement: (tag: string) => new Node(tag), createElementNS: (_ns: string, tag: string) => new Node(tag), createDocumentFragment: () => new Node('fragment')}});
  globalThis.fetch = async url => {const path=String(url);const data=path.includes('/api/projects')?{items:[],total:0,omitted:0,nextCursor:null,observedAt:saved.observedAt}:path==='/api/sessions/published'?{...saved,items:[],total:0}:page;return Response.json({ok:true,data});};
  const modal = {node: {dataset: {} as Record<string, string>}, token: 1, open: () => { body.replaceChildren(); return body; }, owns: (token: number) => token === 1, actions: (...buttons: Node[]) => body.append(...buttons), error: (error: unknown) => { throw error; }};
  try {
    const picker = new ProjectPicker({readSession: () => {}, agentPresentation: catalogPresentation, modal: modal as unknown as Modal, snapshot: () => ({launchCwd: '/project', primaries: []}) as unknown as Bootstrap, primary: () => undefined, selection: async () => {}, reload: async () => {}});
    picker.open(); assert.equal(modal.node.dataset.variant, 'picker', 'pickers open as the top-anchored panel');
    assert.equal(descendants(body).some(node => node.textContent === 'Open project'), false);
    await new Promise<void>(resolve => setImmediate(resolve));
    const nodes = descendants(body); const search = nodes.find(node => node.id === 'picker-search'); assert.ok(search);
    const label = nodes.find(node => node.tag === 'label' && node.htmlFor === search.id); assert.ok(label);
    assert.equal(label.className, 'sr-only'); assert.equal(label.textContent, 'Search sessions');
    const ordinary = nodes.find(node => node.className === 'picker-folder-ordinary'); assert.ok(ordinary);
    const searchRow = body.children.find(node => node.className === 'picker-search-row'); assert.ok(searchRow);
    const line = searchRow.children[0]; assert.ok(line); assert.equal(line.className, 'picker-input-row'); assert.equal(search.className, 'picker-input');
    assert.equal(line.children.length, 2); assert.equal(search.id, label.htmlFor);
    assert.equal(line.children[0], label); assert.equal(line.children[1], search);
    const freshness = ordinary.querySelector('.picker-list-details'); assert.ok(freshness);
    assert.match(freshness.textContent, /Saved list · now/);
    assert.match(freshness.textContent, /sessions loaded/); assert.equal(freshness.children[0]?.textContent, 'List details');
    assert.ok(nodes.find(node => node.tag === 'button' && node.attributes['aria-label'] === 'Refresh saved sessions'));
    search.value = 'no match'; search.dispatch('input');
    const empty = nodes.find(node => node.className === 'picker-sessions')?.children.find(node => node.tag === 'p'); assert.ok(empty);
    assert.equal(empty.textContent, 'No matches in this group.');
    assert.equal(nodes.find(node => node.id === 'picker-more')?.hidden, name !== 'more pages');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (oldElement) Object.defineProperty(globalThis, 'HTMLElement', oldElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }
});
type CatalogFixture = {roster: CachedRoster; published: SavedSessionPage; presentation?: typeof catalogPresentation; titlePage?: SavedSessionPage};
function catalogPage(path: string, catalog?: CatalogFixture): SavedSessionPage | undefined {
  if (path === '/api/sessions/published') return catalog?.published ?? {...saved,items:[],total:0};
  return path.includes('&titles=') ? catalog?.titlePage : undefined;
}
function directPicker(t: TestContext, active?: PrimaryView, page: SavedSessionPage = saved, selectOpened?:()=>((key:string)=>Promise<void>), catalog?: CatalogFixture) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const previousFetch = globalThis.fetch; const body = new Node('div'); const origin = new Node('button');
  let popup = false;
  t.mock.method(contextMenu, 'open', (_origin, _point, label, items) => {
    if (label === 'Working folder') assert.equal(_origin, origin); else assert.equal(label, 'Saved session options'); popup = true;
    body.replaceChildren(...items.map(item => {const row = new Node('button'); if (item.key) row.dataset.itemKey = item.key; row.textContent = item.label; row.disabled = item.enabled === false; if (item.description) {row.title = item.description; row.setAttribute('aria-description', item.description);} row.addEventListener('click', () => {popup = false; item.run();}); return row;}));
  });
  t.mock.method(contextMenu, 'owns', control => popup && control === origin as unknown as HTMLElement);
  t.mock.method(contextMenu, 'close', () => {popup = false;});
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: Node});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {activeElement: null, getElementById: () => origin, createElement: (tag: string) => new Node(tag), createElementNS: (_ns: string, tag: string) => new Node(tag), createDocumentFragment: () => new Node('fragment')}});
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousElement) Object.defineProperty(globalThis, 'HTMLElement', previousElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  });
  const calls: {path: string; body?: unknown}[] = []; const selections: SelectionChange[] = []; const steps: string[] = [];
  const state = {primaries: active ? [active] : [], launchCwd: '/project', ...(catalog ? {roster: catalog.roster} : {})} as unknown as Bootstrap;
  const reads: SavedSession[] = []; let reloads = 0; let titleChanges = 0; let failure = false; let listFailure = false; let closed = false; let error = ''; let running = false;
  const modal = {
    node: {dataset: {} as Record<string, string>}, body, token: 0, close: () => {closed = true;},
    open: () => { modal.token++; body.replaceChildren(); closed = false; return body; },
    owns: (token: number) => !closed && modal.token === token,
    actions: (...buttons: Node[]) => body.append(...buttons),
    error: (cause: unknown) => { error = cause instanceof Error ? cause.message : String(cause); },
    confirm: () => { assert.fail('Saved session navigation must not request confirmation'); },
    run: async (action: () => Promise<unknown>) => {
      if (running) return; running = true;
      try { await action(); closed = true; } catch (cause) { modal.error(cause); } finally { running = false; }
    },
  };
  globalThis.fetch = async (url, init) => {
    const path = String(url); const posted = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({path, body: posted});
    if (listFailure && path.includes('/api/sessions')) return new Response(JSON.stringify({ok: false, error: {code: 'invalid_request', message: 'The project directory does not exist.', retry: 'none'}}), {status: 400, headers: {'content-type': 'application/json'}});
    let data: unknown = catalogPage(path, catalog) ?? page;
    if (path.includes('/api/operations')) data = {operationId: 'open'};
    else if (path.includes('/api/primaries')) data = failure
      ? {operation: {state: 'rejected', error: {code: 'operation_conflict', message: 'This saved session already has a backend writer.'}}}
      : {primaryKey: 'opened', operation: {state: 'completed'}};
    else if (path.includes('/api/projects')) data = {items: [], total: 0, omitted: 0, nextCursor: null, observedAt: saved.observedAt};
    return new Response(JSON.stringify({ok: true, data}), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const picker = new ProjectPicker({readSession: item => {reads.push(item);}, agentPresentation: catalog?.presentation ?? catalogPresentation, modal: modal as unknown as Modal, snapshot: () => state, primary: () => active,selectOpened,titlesChanged:()=>{titleChanges++;},
    selection: async change => { steps.push('selection'); selections.push(change); }, reload: async () => { steps.push('reload'); reloads++; }});
  const click = (label: string) => { const node = descendants(body).find(node => node.tag === 'button' && node.textContent === label); assert.ok(node, label); node.click(); };
  return {picker, modal, body, calls, reads, state, selections, steps, click, fail: () => { failure = true; }, failList: () => { listFailure = true; }, get reloads() { return reloads; }, get titleChanges() { return titleChanges; }, get closed() { return closed; }, get error() { return error || descendants(body).find(node => node.id === 'picker-file-error')?.textContent || descendants(body).find(node => node.className === 'picker-error')?.textContent || ''; }};
}
const rowCount = (setup: {body: Node}) => setup.body.querySelectorAll('.picker-select, .picker-durable-select').length;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function catalogRow(identity: string): AgentRow {return {identity, storageId: identity, name: 'Published name', cwd: '/project', modifiedAt: 0, state: 'working', owner: 'unknown', availability: 'live', partial: false};}
function catalogRoster(rows: AgentRow[] = []): CachedRoster {return {rows, scan: {state: 'ready', complete: true, visited: rows.length, skipped: 0, omitted: 0}, stale: false};}
const noPublished = {...saved, items: [], total: 0};
const ordinarySample = saved.items[0]; assert.ok(ordinarySample);
test('the picker answers a session title from metadata it already holds and makes no request for an unknown one', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'HTMLButtonElement');
  Object.defineProperty(globalThis, 'HTMLButtonElement', {configurable: true, value: Node});
  t.after(() => {if (original) Object.defineProperty(globalThis, 'HTMLButtonElement', original); else Reflect.deleteProperty(globalThis, 'HTMLButtonElement');});
  const pending = {...ordinarySample, id: 'p', path: '/project/p.jsonl', title: 'Hidden', titleState: 'pending' as const};
  const setup = directPicker(t, undefined, saved, undefined, {roster: catalogRoster([]), published: {...saved, items: [...saved.items, pending], total: 2}});
  assert.equal(setup.picker.sessionTitle('s'), undefined);
  setup.picker.open(); await settle();
  assert.equal(setup.picker.sessionTitle('s'), 'Saved title'); assert.equal(setup.picker.sessionTitle('p'), undefined); assert.equal(setup.picker.sessionTitle('unknown'), undefined);
});
test('an unchecked live connection leaves no visible state line but stays in the row title and accessible name; meaningful states stay visible', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'HTMLButtonElement');
  Object.defineProperty(globalThis, 'HTMLButtonElement', {configurable: true, value: Node});
  t.after(() => {if (original) Object.defineProperty(globalThis, 'HTMLButtonElement', original); else Reflect.deleteProperty(globalThis, 'HTMLButtonElement');});
  const states: Record<string, {activity: string; hide: boolean}> = {quiet: {activity: 'Running', hide: true}, working: {activity: 'Working', hide: false}, stored: {activity: 'Stored', hide: false}};
  const setup = directPicker(t, undefined, saved, undefined, {roster: catalogRoster([catalogRow('quiet'), catalogRow('working'), catalogRow('stored')]), published: noPublished,
    presentation: row => ({name: row.identity, activity: states[row.identity]?.activity ?? '', tone: 'secondary', cwd: '/project', hideVisibleState: states[row.identity]?.hide})});
  setup.picker.open(); await settle(); const list = setup.body.querySelector('.picker-durable-list'); assert.ok(list);
  const [quiet, working, stored] = list.children; assert.ok(quiet); assert.ok(working); assert.ok(stored);
  assert.equal(quiet.querySelector('.picker-durable-state'), null); assert.deepEqual(quiet.children.map(child => child.className), ['picker-session-heading', 'picker-session-meta']);
  assert.match(quiet.title, /Running/); assert.match(quiet.attributes['aria-label'] ?? '', /Running/);
  assert.equal(working.querySelector('.picker-durable-state')?.textContent, 'Working'); assert.equal(stored.querySelector('.picker-durable-state')?.textContent, 'Stored');
  assert.match(quiet.querySelector('.picker-session-meta')?.textContent ?? '', /Saved folder:/);
  const search = setup.body.querySelector('#picker-search'); assert.ok(search); search.value = 'quiet'; search.dispatch('input');
  assert.equal(setup.body.querySelectorAll('.picker-durable-select').length, 1);
});
test('ordinary groups precede five agent rows and search reaches collapsed agents', async t => {
  const rows = Array.from({length: 40}, (_, index) => catalogRow(`agent-${index}`));
  const setup = directPicker(t, undefined, saved, undefined, {roster: catalogRoster(rows), published: {...saved, items: [{...ordinarySample, project: '/other-project', path: '/other-project/other.jsonl'}]}});
  setup.picker.open(); await settle(); const results = setup.body.querySelector('.picker-results'); assert.ok(results);
  assert.deepEqual(results.children.map(node => node.className), ['picker-folder-ordinary', 'picker-ordinary', 'picker-durable']);
  assert.match(results.children[0]?.textContent ?? '', /Your sessions in/); assert.match(results.children[1]?.textContent ?? '', /Your sessions in other folders/);
  assert.equal(setup.body.querySelectorAll('.picker-durable-select').length, 5);
  const showAll = setup.body.querySelector('.picker-show-all'), search = setup.body.querySelector('#picker-search'); assert.ok(showAll && search); assert.equal(showAll.textContent, 'Show all 40');
  const calls = setup.calls.length; search.value = 'agent-39'; search.dispatch('input'); assert.equal(setup.body.querySelectorAll('.picker-durable-select').length, 1); assert.equal(setup.body.querySelector('.picker-durable-select')?.dataset.agentIdentity, 'agent-39');
  search.value = ''; search.dispatch('input'); assert.equal(setup.body.querySelectorAll('.picker-durable-select').length, 5); showAll.click(); assert.equal(setup.body.querySelectorAll('.picker-durable-select').length, 40);
  assert.equal(setup.calls.length, calls);
});

test('Durable picker rows use projected names and truthful state with native keyboard selection only', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'HTMLButtonElement');
  Object.defineProperty(globalThis, 'HTMLButtonElement', {configurable: true, value: Node});
  t.after(() => {if (original) Object.defineProperty(globalThis, 'HTMLButtonElement', original); else Reflect.deleteProperty(globalThis, 'HTMLButtonElement');});
  const name = 'Complete projected conversation name '.repeat(8), activity = 'Running; retained history remains available';
  const qualifier = 'qualifier'.repeat(70), folderPath = `/${'unbroken-folder'.repeat(80)}`;
  const setup = directPicker(t, undefined, saved, undefined, {roster: catalogRoster([catalogRow('first'), catalogRow('second')]), published: noPublished,
    presentation: row => ({name: row.identity === 'first' ? name : 'Unnamed conversation', identityTail: row.identity === 'first' ? qualifier : undefined, activity, tone: 'warning', cwd: folderPath})});
  setup.picker.open(); await settle(); const durable = setup.body.querySelector('.picker-durable'), list = durable?.querySelector('.picker-durable-list'); assert.ok(durable); assert.ok(list);
  const [first, second] = list.children; assert.ok(first); assert.ok(second); assert.equal(first.tag, 'button'); assert.equal(Reflect.get(first, 'type'), 'button');
  assert.equal(first.querySelector('.picker-session-title')?.textContent, name); assert.equal(second.querySelector('.picker-session-title')?.textContent, 'Unnamed conversation');
  assert.equal(first.querySelector('.picker-durable-state')?.textContent, activity); assert.equal(first.querySelector('.picker-durable-state')?.dataset.tone, 'warning');
  assert.match(first.title, /first/); assert.match(first.attributes['aria-label'] ?? '', /first/); assert.match(first.querySelector('.picker-session-meta')?.textContent ?? '', /Saved folder:/);
  assert.equal(first.querySelector('.picker-session-tail')?.textContent, qualifier); assert.ok(first.attributes['aria-label']?.includes(qualifier)); assert.equal(first.querySelector('.picker-session-meta')?.title, folderPath);
  assert.equal(durable.querySelector('.picker-safety'), null); Reflect.set(document, 'activeElement', first);
  const results=setup.body.querySelector('.picker-results');assert.ok(results);
  let prevented = 0; results.dispatch('keydown', {key: 'ArrowDown', target: first, preventDefault() {prevented++;}}); assert.equal(second.focused, true);
  results.dispatch('keydown', {key: 'Enter', target: second, preventDefault() {prevented++;}}); await settle();
  assert.equal(prevented, 2); assert.deepEqual(setup.selections, [{panelVisible: true, selectedTarget: {kind: 'agent', identity: 'second'}}]);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries' || call.path === '/api/agents/convert'), false);
});
test('the ordinary Resume caution lives only in the exact-file disclosure and rows open read-only snapshots', async t => {
  const published = {...saved, items: [{...ordinarySample, project: '/published', path: '/published/session.jsonl'}]};
  const setup = directPicker(t, undefined, saved, undefined, {roster: catalogRoster(), published}); setup.picker.open(); await settle();
  const registered = setup.body.querySelector('.picker-ordinary'), folder = setup.body.querySelector('.picker-folder-ordinary'); assert.ok(registered); assert.ok(folder);
  assert.equal(setup.body.children.some(node => node.classList.contains('picker-safety')), false);
  assert.equal(registered.querySelector('.picker-safety'), null); assert.equal(folder.children.some(node => node.classList.contains('picker-safety')), false); assert.ok(registered.querySelector('.picker-session'));
  const file = folder.querySelector('.picker-file'); assert.ok(file); assert.match(file.querySelector('.picker-safety')?.textContent ?? '', /^Stop a terminal session before you resume it here\./);
  assert.equal(registered.querySelector('.picker-select')?.attributes['aria-description'], 'Open this exact retained snapshot.');
  assert.equal(descendants(registered).some(node => node.tag === 'button' && node.textContent === 'Convert to Durable'), false);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries' || call.path === '/api/agents/convert'), false);
});
function pickerKeyboard(t:TestContext) {
  class Key {key:string;target:Node;constructor(key:string,target:Node) {this.key=key;this.target=target;} preventDefault():void {} }
  const priorKey=Object.getOwnPropertyDescriptor(globalThis,'KeyboardEvent'), priorButton=Object.getOwnPropertyDescriptor(globalThis,'HTMLButtonElement');
  Object.defineProperty(globalThis,'KeyboardEvent',{configurable:true,value:Key});Object.defineProperty(globalThis,'HTMLButtonElement',{configurable:true,value:Node});
  t.after(()=>{if(priorKey)Object.defineProperty(globalThis,'KeyboardEvent',priorKey);else Reflect.deleteProperty(globalThis,'KeyboardEvent');if(priorButton)Object.defineProperty(globalThis,'HTMLButtonElement',priorButton);else Reflect.deleteProperty(globalThis,'HTMLButtonElement');});
  return (node:Node,key:string,target=node)=>node.dispatch('keydown',new Key(key,target) as unknown as Record<string,unknown>);
}
const searchCatalog=()=>({roster:{...catalogRoster([{...catalogRow('designer'),name:'Web UI designer'},{...catalogRow('other'),name:'Other agent'}]),nextCursor:'more'},published:{...saved,omitted:1,items:[{...ordinarySample,path:'/registered.jsonl',title:'Registered planning'}]}});
test('one query filters every loaded group without fetching or weakening coverage and duplicate suppression',async t=> {
  const catalog=searchCatalog(),duplicate={...ordinarySample,path:'/registered.jsonl',title:'Folder alias'};
  const setup=directPicker(t,undefined,{...saved,items:[ordinarySample,duplicate]},undefined,catalog);setup.picker.open();await settle();
  const search=setup.body.querySelector('#picker-search'),results=setup.body.querySelector('.picker-results');assert.ok(search&&results);
  const rows=()=>results.querySelectorAll('.picker-durable-select, .picker-select');const calls=setup.calls.length;
  assert.deepEqual(rows().map(row=>row.dataset.agentIdentity??row.dataset.sessionPath),[ordinarySample.path,'/registered.jsonl','designer','other']);
  for(const [query,expected] of [['Web UI designer','designer'],['Registered planning','/registered.jsonl'],['Saved title',ordinarySample.path]] as const) {
    search.value=query;search.dispatch('input');assert.deepEqual(rows().map(row=>row.dataset.agentIdentity??row.dataset.sessionPath),[expected]);
    assert.equal(results.querySelector('.picker-durable')?.querySelector('.picker-list-details')?.children[0]?.textContent,'List details');assert.equal(results.querySelector('.picker-ordinary')?.querySelector('.picker-list-details')?.children[0]?.textContent,'List details');
    assert.equal(rowCount(setup), 1);
  }
  search.value='Folder alias';search.dispatch('input');assert.equal(rows().length,0);
  search.value='not present';search.dispatch('input');assert.equal(rows().length,0);
  for(const group of ['.picker-durable','.picker-ordinary','.picker-folder-ordinary'])assert.match(results.querySelector(group)?.textContent??'',/No matches in this group/);
  assert.equal(rowCount(setup), 0);
  search.value='';search.dispatch('input');assert.equal(rowCount(setup), 4);
  assert.equal(setup.calls.length,calls);assert.equal(setup.selections.length,0);
});
test('Arrow navigation uses all visible groups and Enter leaves non-row controls alone',async t=> {
  const key=pickerKeyboard(t),setup=directPicker(t,undefined,saved,undefined,searchCatalog());setup.picker.open();await settle();
  const search=setup.body.querySelector('#picker-search'),results=setup.body.querySelector('.picker-results');assert.ok(search&&results);
  const rows=results.querySelectorAll('.picker-durable-select, .picker-select');search.focus();key(search,'ArrowDown');assert.equal(document.activeElement,rows[0]);
  for(let index=1;index<rows.length;index++){key(results,'ArrowDown',rows[index-1]);assert.equal(document.activeElement,rows[index]);}
  key(results,'Home',rows.at(-1));assert.equal(document.activeElement,rows[0]);key(results,'End',rows[0]);assert.equal(document.activeElement,rows.at(-1));
  assert.equal(descendants(results).some(node=>node.tag==='button'&&node.textContent==='Convert to Durable'),false);
  const file=results.querySelector('#picker-session-path');assert.ok(file);file.focus();key(results,'ArrowDown',file);key(results,'Home',file);assert.equal(document.activeElement,file);key(results,'Enter',file);await settle();assert.equal(setup.calls.some(call=>call.path==='/api/agents/convert'||call.path==='/api/primaries'),false);
  search.focus();search.value='no result';search.dispatch('input');key(search,'Enter');key(search,'ArrowDown');assert.equal(document.activeElement,search);assert.equal(setup.selections.length,0);
});
for(const [query,identity,path] of [['Web UI designer','designer',undefined],['Registered planning',undefined,'/registered.jsonl'],['Saved title',undefined,ordinarySample.path]] as const) test(`search Enter selects the exact visible target for ${query}`,async t=> {
  const key=pickerKeyboard(t),setup=directPicker(t,undefined,saved,undefined,searchCatalog());setup.picker.open();await settle();const search=setup.body.querySelector('#picker-search');assert.ok(search);search.value=query;search.dispatch('input');key(search,'Enter');await settle();
  if(identity) {assert.deepEqual(setup.selections,[{panelVisible:true,selectedTarget:{kind:'agent',identity}}]);assert.equal(setup.calls.some(call=>call.path==='/api/primaries'),false);}
  else {assert.deepEqual(setup.reads.map(item=>item.path),[path]);assert.equal(setup.calls.some(call=>call.path==='/api/primaries'),false);}
  assert.equal(setup.calls.some(call=>call.path==='/api/agents/convert'),false);
});
test('late registered rows honor the current query and retain the focused Durable target',async t=> {
  const catalog=searchCatalog(),setup=directPicker(t,undefined,saved,undefined,catalog),original=globalThis.fetch,pending=Promise.withResolvers<Response>();
  globalThis.fetch=async(input,init)=>String(input)==='/api/sessions/published'?pending.promise:original(input,init);
  setup.picker.open();await settle();const search=setup.body.querySelector('#picker-search');assert.ok(search);search.value='Web UI designer';search.dispatch('input');const selected=setup.body.querySelector('.picker-durable-select');assert.ok(selected);selected.focus();
  pending.resolve(Response.json({ok:true,data:catalog.published}));await settle();
  const rows=setup.body.querySelectorAll('.picker-durable-select, .picker-select');assert.equal(rows.length,1);assert.equal(rows[0]?.dataset.agentIdentity,'designer');assert.equal(document.activeElement,rows[0]);assert.equal(setup.selections.length,0);
  assert.equal(rowCount(setup), 1);
});
test('Durable coverage remains local and a ready blank ordinary title displays absence after hydration', async t => {
  const pending = {...saved, titleCursor: 'titles', items: [{...ordinarySample, title: '', titleState: 'pending' as const}]};
  const filled = {...saved, items: [{...ordinarySample, title: '', titleState: 'ready' as const}]};
  const roster = {...catalogRoster(), stale: true, nextCursor: 'more', scan: {...catalogRoster().scan, complete: false}};
  const setup = directPicker(t, undefined, pending, undefined, {roster, published: noPublished, titlePage: filled}); setup.picker.open(); await settle(); await settle();
  const durable = setup.body.querySelector('.picker-durable'); assert.ok(durable); const notice = durable.querySelector('.picker-durable-coverage'); assert.ok(notice);
  assert.match(durable.querySelector('.picker-durable-list')?.textContent ?? '', /No loaded sessions in this group/); assert.match(notice.textContent, /Saved Durable catalog/);   const folder = setup.body.querySelector('.picker-folder-ordinary'); assert.ok(folder); assert.equal(folder.querySelector('.picker-session-title')?.textContent, 'project · s');
  assert.equal(filled.items[0]?.title, ''); assert.equal(pending.items[0]?.titleState, 'pending'); assert.ok(setup.calls.some(call => call.path.includes('&titles=titles')));
});
test('global count follows late titles, local pages and the current query', async t => {
  const pending = {...ordinarySample, title: 'Loading title…', titleState: 'pending' as const};
  const first = {...saved, items: [pending], total: 2, nextCursor: 'next', titleCursor: 'titles'};
  const setup = directPicker(t, undefined, first), original = globalThis.fetch;
  const titles = Promise.withResolvers<Response>(), next = Promise.withResolvers<Response>();
  globalThis.fetch = async (input, init) => String(input).includes('&titles=') ? titles.promise : String(input).includes('&cursor=') ? next.promise : original(input, init);
  setup.picker.open(); await settle();
  const search = setup.body.querySelector('#picker-search'); assert.ok(search);
  search.value = 'Chosen'; search.dispatch('input'); assert.equal(rowCount(setup), 0);
  titles.resolve(Response.json({ok: true, data: {...first, items: [{...pending, title: 'Chosen one', titleState: 'ready'}]}})); await settle();
  assert.equal(rowCount(setup), 1);
  const more = setup.body.querySelector('#picker-more'); assert.ok(more); more.click(); assert.equal(more.disabled, true);
  search.value = 'Second'; search.dispatch('input'); assert.equal(rowCount(setup), 0);
  next.resolve(Response.json({ok: true, data: {...saved, total: 2, items: [{...ordinarySample, id: 'second', path: '/second.jsonl', title: 'Second choice'}]}})); await settle();
  assert.equal(rowCount(setup), 1); assert.equal(more.disabled, false); assert.equal(more.hidden, true);
  search.value = ''; search.dispatch('input'); assert.equal(rowCount(setup), 2);
  assert.equal(setup.body.querySelectorAll('.picker-select').length, 2);
});
test('loaded Primary metadata follows title completion and newer registered evidence without extra retrieval',async t=> {
  const pending={...ordinarySample,title:'',titleSource:'prompt' as const,titleState:'pending' as const};
  const primary={key:'p',epoch:1,cwd:'/project',sessionId:pending.id,sessionFile:pending.path,lifecycle:'ready'} as PrimaryView;
  const setup=directPicker(t,primary,{...saved,items:[pending],titleCursor:'titles'}), original=globalThis.fetch;
  const titles=Promise.withResolvers<Response>(),registered=Promise.withResolvers<Response>();
  globalThis.fetch=async(input,init)=>String(input).includes('&titles=')?titles.promise:String(input)==='/api/sessions/published'?registered.promise:original(input,init);
  setup.picker.open();await settle();assert.equal(setup.picker.savedSession(primary)?.titleState,'pending');
  titles.resolve(Response.json({ok:true,data:{...saved,items:[{...pending,title:'First prompt',titleState:'ready'}]}}));await settle();
  assert.equal(setup.picker.savedSession(primary)?.title,'First prompt');const changed=setup.titleChanges;
  registered.resolve(Response.json({ok:true,data:{...saved,observedAt:'2026-01-02T00:00:00Z',items:[{...pending,revision:'new',titleState:'unavailable'}]}}));await settle();
  assert.equal(setup.picker.savedSession(primary)?.titleState,'unavailable');assert.ok(setup.titleChanges>changed);
  let refresh=Promise.withResolvers<Response>();globalThis.fetch=async(input,init)=>String(input)==='/api/sessions/published'?refresh.promise:original(input,init);
  setup.picker.open();await settle();assert.equal(setup.picker.savedSession(primary)?.titleState,'unavailable');
  assert.match(setup.body.querySelector('.picker-ordinary')?.textContent??'',/Loading registered ordinary sessions/);assert.equal(setup.body.querySelector('.picker-registered-list')?.children.length,0);
  refresh.reject(new Error('offline'));await settle();assert.equal(setup.picker.savedSession(primary)?.titleState,'unavailable');assert.match(setup.body.querySelector('.picker-ordinary')?.textContent??'',/Registered ordinary sessions are unavailable/);
  refresh=Promise.withResolvers<Response>();setup.picker.open();await settle();setup.modal.close();
  refresh.resolve(Response.json({ok:true,data:{...saved,items:[{...pending,title:'Old prompt',titleState:'ready'}]}}));await settle();assert.equal(setup.picker.savedSession(primary)?.titleState,'unavailable');
  assert.equal(setup.picker.savedSession({...primary,sessionId:'other'}),undefined);assert.equal(setup.picker.savedSession({...primary,sessionFile:'/other'}),undefined);
  assert.equal(setup.calls.some(call=>call.path==='/api/primaries'||call.path.includes('/api/operations')),false);
});
test('late registered duplicate removal changes the same visible set and global count', async t => {
  const catalog = searchCatalog(), duplicate = {...ordinarySample, path: '/registered.jsonl', title: 'Folder alias'};
  const setup = directPicker(t, undefined, {...saved, items: [duplicate]}, undefined, catalog), original = globalThis.fetch, pending = Promise.withResolvers<Response>();
  globalThis.fetch = async (input, init) => String(input) === '/api/sessions/published' ? pending.promise : original(input, init);
  setup.picker.open(); await settle();
  const search = setup.body.querySelector('#picker-search'); assert.ok(search);
  search.value = 'Folder alias'; search.dispatch('input'); assert.equal(rowCount(setup), 1);
  pending.resolve(Response.json({ok: true, data: catalog.published})); await settle();
  assert.equal(rowCount(setup), 0); assert.equal(setup.body.querySelectorAll('.picker-select').length, 0);
  search.value = 'r'; search.dispatch('input'); assert.equal(rowCount(setup), 3);
  assert.equal(setup.body.querySelectorAll('.picker-select, .picker-durable-select').length, 3);
});
test('global count tracks rendered batches and ignores batches from an older query', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'), frames: Array<() => void> = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', {configurable: true, value: (callback: () => void) => {frames.push(callback); return frames.length;}});
  t.after(() => {if (previous) Object.defineProperty(globalThis, 'requestAnimationFrame', previous); else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');});
  const items = Array.from({length: 21}, (_, index) => ({...ordinarySample, id: String(index), path: `/session-${index}.jsonl`, title: index === 20 ? 'Chosen last' : `Session ${index}`}));
  const setup = directPicker(t, undefined, {...saved, items, total: items.length}); setup.picker.open(); await settle();
  const search = setup.body.querySelector('#picker-search'); assert.ok(search);
  assert.equal(rowCount(setup), 20); assert.equal(setup.body.querySelectorAll('.picker-select').length, 20);
  search.value = 'Chosen last'; search.dispatch('input'); assert.equal(rowCount(setup), 1);
  for (const callback of frames.splice(0)) callback(); assert.equal(rowCount(setup), 1);
  search.value = ''; search.dispatch('input'); for (const callback of frames.splice(0)) callback();
  assert.equal(rowCount(setup), 21); assert.equal(setup.body.querySelectorAll('.picker-select').length, 21);
});
test('group disclosures preserve exact coverage while unsettled states never claim an empty search', async t => {
  const roster = {...catalogRoster(), stale: true, scan: {...catalogRoster().scan, state: 'failed' as const, complete: false, skipped: 3, omitted: 4}, error: {code: 'scan_failed', message: 'Exact catalog failure', retry: 'none' as const}};
  const setup = directPicker(t, undefined, saved, undefined, {roster, published: {...saved, omitted: 62}});
  setup.picker.open(); await settle();
  const durable = setup.body.querySelector('.picker-durable'), registered = setup.body.querySelector('.picker-ordinary'); assert.ok(durable && registered);
  assert.match(durable.querySelector('.picker-durable-coverage')?.textContent ?? '', /could not refresh.*Saved Durable catalog/);
  assert.doesNotMatch(durable.querySelector('.picker-durable-list')?.textContent ?? '', /No matches|No loaded/);
  const facts = durable.querySelector('.picker-list-details'); assert.ok(facts);
  assert.equal(facts.open, false); assert.match(facts.textContent, /List details.*0 Durable conversations loaded/);   assert.match(facts.textContent, /3 skipped; 4 omitted/); assert.match(facts.textContent, /Exact catalog failure/);
  assert.match(facts.children[0]?.attributes['aria-label'] ?? '', /Agent conversations/);
  assert.match(registered.querySelector('.picker-list-details')?.textContent ?? '', /62 discovery records are unavailable or outside the bound/);
  assert.doesNotMatch(registered.textContent, /Conversion copies saved context only/); assert.match(registered.textContent, /Your sessions in other folders/);
});
const active = {key: 'current', cwd: '/project', epoch: 1, lifecycle: 'ready'} as PrimaryView;
for (const owner of ['new','current'] as const) test(`successful Resume selects the exact ${owner} Primary after refresh`,async t=> {
  const completed:string[] = [];let admissions = 0;
  const setup = directPicker(t,owner === 'current' ? {...active,sessionFile:saved.items[0]?.path} : undefined,saved,()=> {admissions++;return async key=> {completed.push(key);assert.equal(setup.reloads,1);};});
  setup.picker.open();await settle();setup.picker.resume('/project','/project/s.jsonl');await settle();
  assert.equal(admissions,1);assert.deepEqual(completed,[owner === 'new' ? 'opened' : 'current']);assert.equal(setup.selections.length,0);
});
for (const changed of ['closed','replaced'] as const) test(`late Resume completion does not select after the picker is ${changed}`,async t=> {
  const completed:string[] = [];const setup = directPicker(t,undefined,saved,()=>async key=> {completed.push(key);});setup.picker.open();await settle();
  const previous = globalThis.fetch;let release!:()=>void,started!:()=>void;const gate = new Promise<void>(resolve=> {release = resolve;}),pending = new Promise<void>(resolve=> {started = resolve;});
  globalThis.fetch = async(input,init)=> {if (String(input) === '/api/primaries') {started();await gate;}return previous(input,init);};
  setup.picker.resume('/project','/project/s.jsonl');await pending;if (changed === 'closed') setup.modal.close();else setup.picker.open();release();await settle();await settle();assert.deepEqual(completed,[]);
});
test('first-use folder selection retains the inline session chooser after the root save',async t=> {
  const setup=directPicker(t);const root=new Node('main');let folder:string|undefined;
  const picker=new ProjectPicker({readSession: () => {}, agentPresentation:catalogPresentation,modal:setup.modal as unknown as Modal,snapshot:()=>setup.state,primary:()=>undefined,project:()=>folder,selection:async()=>{},reload:async()=>{},workingFolder:async path=> {folder=path;}});
  picker.mount(root as unknown as HTMLElement);await settle();picker.openProject();await settle();
  const other=descendants(root).find(node=>node.tag==='button'&&node.textContent==='Other folder');assert.ok(other);other.click();
  const field=descendants(root).find(node=>node.id==='picker-project');assert.ok(field);field.value='/another-project';
  const use=descendants(root).find(node=>node.tag==='button'&&node.textContent==='Use folder');assert.ok(use);use.click();await settle();await settle();
  assert.equal(folder,'/another-project');assert.ok(descendants(root).find(node=>node.id==='picker-search'));
  assert.ok(descendants(root).find(node=>node.attributes['aria-label']==='New session'));assert.ok(descendants(root).find(node=>node.className==='picker-select'));
  assert.equal(setup.modal.token,0);assert.equal(setup.calls.some(call=>call.path==='/api/primaries'),false);
});
test('current project opens its session list and a saved row reads one exact snapshot without opening a writer', async t => {
  const setup = directPicker(t, active); setup.picker.open(); await settle();
  assert.equal(setup.calls.some(call => call.path.includes('/api/projects')), false);
  assert.equal(descendants(setup.body).some(node => node.textContent === 'Open project'), false);
  assert.ok(setup.body.querySelector('.picker-folder-ordinary'));
  assert.equal(setup.body.children.some(node => node.classList.contains('picker-safety')), false);
  const row = descendants(setup.body).find(node => node.className === 'picker-select'); assert.ok(row);
  row.click(); row.click(); await settle();
  assert.deepEqual(setup.reads.map(item => item.path), ['/project/s.jsonl', '/project/s.jsonl']);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false); assert.equal(setup.reloads, 0);
});
for (const lifecycle of ['stopped', 'failed'] as const) test(`direct resume reopens a ${lifecycle} owner without a chooser, inventory read or confirmation`, async t => {
  const setup = directPicker(t, {...active, lifecycle, sessionFile: saved.items[0].path});
  setup.modal.open(); const command = new Node('pre'); command.textContent = 'pi --session /project/s.jsonl'; setup.body.append(command);
  setup.picker.resume('/project', saved.items[0].path); setup.picker.resume('/project', saved.items[0].path); await settle();
  assert.deepEqual(setup.calls, [{path: '/api/operations', body: {kind: 'primary.open'}}, {path: '/api/primaries', body: {cwd: '/project', sessionFile: saved.items[0].path}}]);
  assert.equal(setup.modal.token, 1); assert.equal(setup.body.children[0], command); assert.equal(setup.closed, true);
  assert.equal(setup.reloads, 1); assert.deepEqual(setup.selections, []);
});
test('direct resume selects the exact current owner and epoch without a second writer or dialog', async t => {
  const setup = directPicker(t, {...active, sessionFile: '/project/other.jsonl'}); setup.modal.open();
  setup.state.primaries = [{...active, key: 'resumed', epoch: 8, sessionFile: saved.items[0].path}];
  setup.picker.resume('/project', saved.items[0].path); await settle();
  assert.deepEqual(setup.selections, [{primaryKey: 'resumed', selectedTarget: {kind: 'primary', key: 'resumed', epoch: 8}}]);
  assert.deepEqual(setup.calls, []); assert.equal(setup.modal.token, 1); assert.equal(setup.closed, true);
  assert.deepEqual(setup.steps, ['selection', 'reload']);
});
test('direct resume retains its host and command on refusal without an automatic retry', async t => {
  const setup = directPicker(t); setup.modal.open(); const command = new Node('pre'); command.textContent = 'pi --session /project/s.jsonl'; setup.body.append(command); setup.fail();
  setup.picker.resume('/project', saved.items[0].path); await settle();
  assert.deepEqual(setup.calls.map(call => call.path), ['/api/operations', '/api/primaries']);
  assert.equal(setup.modal.token, 1); assert.equal(setup.body.children[0], command); assert.equal(setup.closed, false);
  assert.equal(setup.reloads, 0); assert.match(setup.error, /backend writer/);
});
test('direct resume refuses a relative path in the current host without an open effect', async t => {
  const setup = directPicker(t); setup.modal.open(); setup.picker.resume('/project', 'relative.jsonl'); await settle();
  assert.deepEqual(setup.calls, []); assert.equal(setup.closed, false); assert.equal(setup.modal.token, 1);
  assert.match(setup.error, /saved session path that starts with \//);
});

test('bootstrap without a primary lists launch-project sessions directly without starting Pi', async t => {
  const setup = directPicker(t); setup.picker.open(); await settle();
  assert.deepEqual(setup.calls.map(call => call.path), ['/api/sessions?project=%2Fproject','/api/sessions/published']);assert.equal(setup.calls.some(call=>call.path==='/api/primaries'||call.path==='/api/agents/convert'),false);
  assert.ok(descendants(setup.body).find(node => node.id === 'picker-search'));
  assert.ok(descendants(setup.body).find(node => node.textContent === 'New session'));
  assert.ok(descendants(setup.body).find(node => node.attributes['aria-label'] === 'Change working folder'));
  assert.equal(descendants(setup.body).some(node => node.textContent === 'Open project'), false);
  assert.equal(setup.reloads, 0); assert.equal(setup.state.primaries.length, 0);
});
test('an unavailable launch project leaves a truthful error and explicit Projects recovery without spawning', async t => {
  const setup = directPicker(t); setup.failList(); setup.picker.open(); await settle();
  assert.match(setup.error, /project directory does not exist/); assert.equal(setup.closed, false);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
  setup.click('Change working folder'); setup.click('Other folder'); assert.ok(descendants(setup.body).find(node => node.id === 'picker-project'));
  assert.ok(descendants(setup.body).find(node => node.textContent === 'Use folder'));
});
test('without a primary or launch project the picker retains explicit project selection', async t => {
  const setup = directPicker(t); setup.state.launchCwd = undefined; setup.picker.open(); await settle(); setup.click('Other folder');
  assert.ok(descendants(setup.body).find(node => node.id === 'picker-project'));
  assert.equal(setup.calls.some(call => call.path.includes('/api/sessions')), false);
});
test('saved rows read a snapshot whether or not a backend owner holds the file', async t => {
  const setup = directPicker(t, {...active, sessionFile: saved.items[0].path}); setup.picker.open(); await settle();
  descendants(setup.body).find(node => node.className === 'picker-select')?.click(); await settle();
  assert.deepEqual(setup.reads.map(item => item.path), [saved.items[0].path]);
  assert.equal(setup.selections.length, 0); assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false); assert.equal(setup.reloads, 0);
});
test('Projects remains deliberate and exact paths validate before direct open or owner reuse', async t => {
  const setup = directPicker(t, {...active, sessionFile: saved.items[0].path}); setup.picker.open(); await settle();
  setup.click('Change working folder'); setup.click('Other folder'); assert.ok(descendants(setup.body).find(node => node.id === 'picker-project'));
  setup.click('Use folder'); await settle(); const path = descendants(setup.body).find(node => node.id === 'picker-session-path'); assert.ok(path);
  path.value = 'relative.jsonl'; setup.click('Resume session'); await settle();
  assert.match(setup.error, /saved session path that starts with \//);
  assert.equal(descendants(setup.body).some(node => node.className === 'picker-error-details'), false); assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
  path.value = saved.items[0].path; setup.click('Resume session'); await settle();
  assert.equal(setup.selections[0]?.primaryKey, 'current'); assert.equal(setup.closed, true);
  assert.equal(setup.reloads, 1); assert.deepEqual(setup.steps, ['selection', 'reload']);
});
test('workspace session selection reloads after selection through the composer focus seam', async t => {
  const setup = directPicker(t, active); setup.picker.open(); await settle(); setup.click('Change working folder');
  setup.click('project'); await settle();
  assert.deepEqual(setup.selections, [{primaryKey: 'current', selectedTarget: {kind: 'primary', key: 'current', epoch: 1}}]);
  assert.deepEqual(setup.steps, ['selection', 'reload']); assert.equal(setup.closed, true);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});
test('an indexed workspace session selects its exact Primary epoch without opening a second writer', async t => {
  const setup = directPicker(t, undefined); setup.state.primaryIndex = [{key: 'indexed-primary', epoch: 7, lifecycle: 'ready'}];
  setup.picker.openProject(); setup.click('Session indexed-'); await settle();
  assert.deepEqual(setup.selections, [{primaryKey: 'indexed-primary', selectedTarget: {kind: 'primary', key: 'indexed-primary', epoch: 7}}]);
  assert.deepEqual(setup.steps, ['selection', 'reload']); assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});
test('an exact saved path outside the loaded list directly opens without confirmation', async t => {
  const setup = directPicker(t, active); setup.picker.open(); await settle();
  const path = descendants(setup.body).find(node => node.id === 'picker-session-path'); assert.ok(path); path.value = '/project/unlisted.jsonl';
  setup.click('Resume session'); await settle();
  assert.deepEqual(setup.calls.find(call => call.path === '/api/primaries')?.body, {cwd: '/project', sessionFile: '/project/unlisted.jsonl'});
  assert.equal(setup.reloads, 1); assert.equal(setup.closed, true);
});
test('project loading retains its menu surface and folder autofocus exposes the start of long paths', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-01-01T00:00:00Z'));
  const setup = directPicker(t); const path = `/projects/${'long-project-'.repeat(24)}`; setup.state.launchCwd = path;
  let release: (response: Response) => void = () => {throw Error('Request not started');};
  globalThis.fetch = async () => new Promise<Response>(resolve => {release = resolve;});
  setup.picker.openProject(); const host = setup.body;
  assert.match(host.textContent, /Loading projects/); assert.equal(setup.modal.token, 0);
  const page: RecentProjectPage = {items: [{path: '/other', name: 'Other project'}], total: 1, omitted: 0, nextCursor: null, observedAt: saved.observedAt};
  release(Response.json({ok: true, data: page})); await settle();
  assert.equal(setup.body, host); const row = descendants(host).find(node => node.textContent === 'other'); assert.ok(row);
  assert.equal(row.title, '/other'); assert.equal(row.attributes['aria-description'], '/other');
  assert.equal(descendants(host).some(node => node.textContent === 'List details'), false);
  const refresh = descendants(host).find(node => node.textContent === 'Refresh recent projects'); assert.ok(refresh); assert.match(refresh.title, /Saved list · now/);
  page.nextCursor = 'more'; page.total = 2; page.omitted = 1;
  globalThis.fetch = async () => Response.json({ok: true, data: page}); refresh.click(); await settle();
  assert.match(host.textContent, /1 of 2 projects shown · 1 entry is not listed/); assert.match(host.textContent, /More recent projects/);
  setup.click('Other folder'); const field = descendants(host).find(node => node.id === 'picker-project'); assert.ok(field);
  assert.equal(field.value, path); assert.equal(field.focused, true); assert.equal(field.selectionStart, 0); assert.equal(field.selectionEnd, 0); assert.equal(field.scrollLeft, 0);
});
test('a late project reply retains action identity when new project rows precede the focused action', async t => {
  const setup = directPicker(t, active); let release: (response: Response) => void = () => {throw Error('Request not started');};
  globalThis.fetch = async () => new Promise<Response>(resolve => {release = resolve;});
  setup.picker.openProject();
  const folder = descendants(setup.body).find(node => node.textContent === 'Other folder'); assert.ok(folder);
  assert.equal(folder.dataset.itemKey, 'folder');
  release(Response.json({ok: true, data: {items: [{path: '/new/project', name: 'project'}], total: 1, omitted: 0, nextCursor: null, observedAt: saved.observedAt}}));
  await settle();
  const rows = descendants(setup.body);
  assert.equal(rows.find(node => node.textContent === 'Other folder')?.dataset.itemKey, folder.dataset.itemKey);
  assert.deepEqual(rows.filter(node => node.dataset.itemKey?.startsWith('primary:') || node.dataset.itemKey?.startsWith('project:')).map(node => [node.textContent, node.dataset.itemKey]), [['/project', 'primary:current'], ['new/project', 'project:/new/project']]);
  assert.ok(rows.findIndex(node => node.dataset.itemKey === 'project:/new/project') < rows.findIndex(node => node.dataset.itemKey === 'folder'));
});
test('a late project reply never reopens a dismissed popup or replaces the folder dialog', async t => {
  const setup = directPicker(t); let release: (response: Response) => void = () => {throw Error('Request not started');};
  globalThis.fetch = async () => new Promise<Response>(resolve => {release = resolve;});
  setup.picker.openProject(); setup.click('Other folder');
  const field = descendants(setup.body).find(node => node.id === 'picker-project'); assert.ok(field);
  release(Response.json({ok: true, data: {items: [{path: '/late', name: 'Late project'}], total: 1, omitted: 0, nextCursor: null, observedAt: saved.observedAt}}));
  await settle(); assert.equal(descendants(setup.body).find(node => node.id === 'picker-project'), field);
  assert.equal(descendants(setup.body).some(node => node.textContent === 'Late project'), false);
});
test('project menu leads with project identity and keeps the current session name only in its description', async t => {
  const setup = directPicker(t, {...active, sessionName: 'Release notes'}); setup.picker.openProject(); await settle();
  assert.equal(setup.modal.token, 0); const row = descendants(setup.body).find(node => node.textContent === 'project'); assert.ok(row);
  assert.doesNotMatch(setup.body.textContent, /Release notes|In this window|Recent projects|List details|Cancel/);
  assert.match(row.attributes['aria-description'], /Release notes/); assert.match(row.title, /\/project/);
  row.click(); await settle(); assert.equal(setup.selections[0]?.primaryKey, active.key);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});

test('saved conversations keep title and duplicate tail first with searchable identity below', async t => {
  const item = saved.items[0]; assert.ok(item);
  const page = {...saved, total: 2, items: [
    {...item, id: 'fixture0033', title: 'Review companion with a long descriptive name'},
    {...item, id: 'fixture0034', path: '/project/second.jsonl', title: 'Review companion with a long descriptive name'},
  ]};
  const setup = directPicker(t, {...active, sessionFile: '/project/s.jsonl'}, page); setup.picker.open(); await settle();
  const nodes = descendants(setup.body); const rows = nodes.filter(node => node.className === 'picker-select'); assert.equal(rows.length, 2);
  const first = rows[0]; assert.ok(first); assert.equal(first.children[0]?.className, 'picker-session-heading'); assert.equal(first.children[0]?.children[0]?.textContent, page.items[0]?.title);
  assert.equal(first.children[0]?.children[1]?.textContent, '0033'); assert.equal(rows[1]?.children[0]?.children[1]?.textContent, '0034');
  assert.equal(first.children[1]?.className, 'picker-session-meta'); assert.equal(first.children[1]?.textContent, 'In this window');
  const metadata = nodes.find(node => node.className === 'picker-session-details'); assert.ok(metadata);
  assert.match(metadata.textContent, /fixture0033.*10 B/);
  assert.equal(first.textContent.includes('fixture0033'), false);
  assert.ok(nodes.find(node => node.className === 'picker-age quiet'));
  const search = nodes.find(node => node.id === 'picker-search'); assert.ok(search); search.value = 'fixture0034'; search.dispatch('input');
  assert.equal(descendants(setup.body).filter(node => node.className === 'picker-select').length, 1);
  assert.equal(descendants(setup.body).find(node => node.className === 'picker-session-tail')?.textContent, '0034');
});

test('a blank saved title keeps session identity in details without an agent suffix', async t => {
  const item = saved.items[0]; assert.ok(item);
  const setup = directPicker(t, undefined, {...saved, items: [{...item, id: 'blank0033', title: ''}]}); setup.picker.open(); await settle();
  const row = descendants(setup.body).find(node => node.className === 'picker-select'); assert.ok(row);
  assert.equal(row.querySelector('.picker-session-title')?.textContent, 'project · 0033'); assert.equal(row.querySelector('.picker-session-tail')?.hidden, true); assert.equal(row.querySelector('.picker-session-tail')?.textContent, '');
  assert.match(descendants(setup.body).find(node => node.className === 'picker-session-details')?.textContent ?? '', /blank0033/);
});

test('title completion updates duplicate tails without replacing a focused saved row', async t => {
  const item = saved.items[0]; assert.ok(item);
  const page = {...saved, total: 2, items: [{...item, id: 'fixture0033', titleState: 'pending' as const}, {...item, id: 'fixture0034', path: '/project/second.jsonl', titleState: 'pending' as const}]};
  const setup = directPicker(t, active, page); setup.picker.open(); await settle();
  const list = descendants(setup.body).find(node => node.className === 'picker-sessions'); assert.ok(list);
  const select = descendants(list).find(node => node.className === 'picker-select'); assert.ok(select); select.focus();
  const data = {...page, pendingTitles: [], items: page.items.map(item => ({...item, title: 'Completed duplicate title', titleState: 'ready' as const}))};
  (setup.picker as unknown as {patchTitles(list: HTMLElement, data: typeof data): void}).patchTitles(list as unknown as HTMLElement, data);
  assert.equal(descendants(list).find(node => node.className === 'picker-select'), select); assert.equal(select.focused, true);
  assert.equal(select.querySelector('.picker-session-title')?.textContent, 'Completed duplicate title'); assert.equal(select.querySelector('.picker-session-tail')?.textContent, '0033');
});

test('first use mounts the shared session list inline and reads a saved session without a dialog', async t => {
  const setup = directPicker(t); const root = new Node('main');
  setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle();
  assert.equal(setup.modal.token, 0);
  assert.match(root.textContent, /Sessions in project/);
  assert.ok(descendants(root).find(node => node.id === 'picker-search'));
  const select = descendants(root).find(node => node.className === 'picker-select'); assert.ok(select);
  select.click(); await settle();
  assert.deepEqual(setup.reads.map(item => item.path), ['/project/s.jsonl']);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false); assert.equal(setup.reloads, 0); assert.ok(root.children.length > 0); assert.equal(setup.modal.token, 0);
});
test('inline loading cancels late inventory after unmount', async t => {
  const setup = directPicker(t, {...active, sessionFile: saved.items[0].path}); const root = new Node('main');
  setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle();
  const nodes = [...root.children]; setup.picker.mount(root as unknown as HTMLElement, '/project'); assert.deepEqual(root.children, nodes);
  setup.picker.unmount(); assert.equal(root.children.length, 0);
  setup.picker.mount(root as unknown as HTMLElement, '/project'); setup.picker.unmount(); await settle();
  assert.equal(root.children.length, 0); assert.equal(setup.modal.token, 0);
});
test('inline list failure gives a local retry and preserves New session without opening another chooser', async t => {
  const setup = directPicker(t); const root = new Node('main'); setup.failList();
  setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle();
  assert.match(root.textContent, /Sessions could not be loaded/);
  assert.ok(descendants(root).find(node => node.attributes['aria-label'] === 'Retry saved sessions'));
  assert.equal(setup.modal.token, 0); setup.picker.newSession('/project'); await settle();
  assert.deepEqual(setup.calls.find(call => call.path === '/api/primaries')?.body, {cwd: '/project'});
  assert.equal(setup.reloads, 1);
});

test('sidebar session entry focuses the existing first-use list without discarding its search or rows', async t => {
  const setup = directPicker(t); const root = new Node('main');
  setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle();
  const search = descendants(root).find(node => node.id === 'picker-search'); assert.ok(search);
  search.value = 'Saved'; search.dispatch('input'); search.setSelectionRange(1, 3); search.focused = false;
  const children = [...root.children]; const rows = descendants(root).filter(node => node.className === 'picker-select'); const calls = setup.calls.length;
  setup.picker.open('/project');
  assert.equal(setup.modal.token, 0); assert.deepEqual(root.children, children);
  assert.deepEqual(descendants(root).filter(node => node.className === 'picker-select'), rows);
  assert.equal(search.focused, true); assert.equal(search.value, 'Saved');
  assert.equal(search.selectionStart, 1); assert.equal(search.selectionEnd, 3); assert.equal(setup.calls.length, calls);
});

for (const failed of [false,true]) test(`modal context keeps its exact folder and actions together with list failure ${failed}`,async t => {
  const setup=directPicker(t),project=`/projects/${'long-folder-'.repeat(24)}`;if(failed)setup.failList();
  setup.picker.open(project);
  assert.equal(setup.body.querySelectorAll('.picker-context').length,1);assert.equal(setup.body.querySelectorAll('.dialog-actions').length,0);
  await settle();const context=setup.body.querySelector('.picker-context');assert.ok(context);
  const path=context.children[0],actions=context.children[1];assert.ok(path&&actions);assert.equal(path.tag,'details');assert.equal(path.children[0]?.textContent,'Working folder');assert.equal(path.children[1]?.textContent,project);assert.equal(actions.className,'picker-context-actions');
  assert.deepEqual(actions.children.map(node=>node.attributes['aria-label']),['Change working folder','New session']);assert.deepEqual(actions.children.map(node=>node.title),['Change working folder','New session']);
  assert.equal(setup.body.querySelectorAll('.picker-context').length,1);assert.equal(setup.body.querySelectorAll('.dialog-actions').length,0);
  const search=setup.body.querySelector('.picker-search-row');if(failed)assert.match(setup.body.textContent,/Sessions could not be loaded/);else {assert.ok(search);assert.ok(setup.body.children.indexOf(context)<setup.body.children.indexOf(search));}
  const calls=setup.calls.length;path.open=true;path.dispatch('toggle');path.open=false;path.dispatch('toggle');assert.equal(setup.calls.length,calls);assert.equal(setup.calls.some(call=>call.path==='/api/primaries'),false);
  actions.children[1]?.click();await settle();assert.deepEqual(setup.calls.find(call=>call.path==='/api/primaries')?.body,{cwd:project});assert.equal(setup.reloads,1);
});
test('chooser controls stay with their title, search and list disclosure while row facts remain reachable', async t => {
  const setup = directPicker(t); const root = new Node('main');
  setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle();
  const header = root.children[0]; assert.ok(header); assert.equal(header.className, 'picker-header');
  assert.equal(header.children[0]?.tag, 'h1'); assert.match(header.children[0]?.textContent ?? '', /Sessions in project/);
  assert.equal(header.children[1]?.className, 'dialog-actions');
  assert.deepEqual(header.children[1]?.children.map(node => node.attributes['aria-label']), ['New session']);
  assert.equal(root.querySelectorAll('.picker-context').length,0);assert.equal(descendants(root).some(node=>node.attributes['aria-label']==='Change working folder'),false);
  const nodes = descendants(root); const searchRow = nodes.find(node => node.className === 'picker-search-row'); assert.ok(searchRow);
  assert.equal(searchRow.children[0]?.className, 'picker-input-row'); assert.equal(searchRow.children[1]?.attributes['aria-label'], 'Refresh saved sessions');
  assert.equal(searchRow.children[2]?.attributes['aria-label'], 'Saved session options');
  const folder = nodes.find(node => node.className === 'picker-folder-ordinary'); assert.ok(folder);
  const listDetails = folder.querySelector('.picker-list-details'); assert.ok(listDetails);
  const results = nodes.find(node => node.className === 'picker-results'); assert.ok(results);
  assert.equal(results.children[0], folder); assert.ok(root.querySelector('#picker-more'));
  assert.equal(listDetails.children.some(node => node.textContent === 'Session file'), false);
  const file = nodes.find(node => node.className === 'picker-file'); assert.ok(file);
  assert.equal(file.children[0]?.textContent, 'Session file');
  const row = nodes.find(node => node.className === 'picker-session'); assert.ok(row);
  assert.equal(row.children[0]?.className, 'picker-select'); assert.equal(row.children[1]?.className, 'picker-age quiet');
  const facts=row.querySelector('.picker-session-details');assert.ok(facts);assert.equal(row.children[2],facts);assert.equal(facts.tag,'details');assert.equal(facts.children[0]?.attributes['aria-label'],'Details for Saved title');assert.equal(row.children.length,3);assert.equal(setup.calls.some(call=>call.path==='/api/primaries'||call.path==='/api/agents/convert'),false);
  assert.deepEqual(facts.children.slice(1).map(node => node.textContent), ['Saved title', '/project', 's', '/project/s.jsonl', '10 B']);
  file.open = true; file.dispatch('toggle');
  assert.ok(descendants(root).find(node => node.id === 'picker-session-path')); assert.equal(setup.modal.token, 0);
});

test('first-use project selection keeps one inline host and recent rows directly show sessions', async t => {
  const setup = directPicker(t); const root = new Node('main');
  setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle(); setup.picker.openProject();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes('/api/projects')
    ? Response.json({ok: true, data: {items: [{name: 'Other project', path: '/other'}], total: 1, omitted: 0, nextCursor: null, observedAt: saved.observedAt}})
    : originalFetch(url, init);
  descendants(root).find(node => node.textContent === 'Refresh recent projects')?.click(); await settle();
  assert.equal(setup.modal.token, 0); assert.match(root.textContent, /^Working folder/);
  const body = root.children.find(node => node.className === 'session-picker-body'); assert.ok(body);
  const recent = body.children.find(node => node.textContent === 'other'); assert.ok(recent);
  const folder = body.children.find(node => node.textContent === 'Other folder'); assert.ok(folder);
  assert.ok(body.children.indexOf(recent) < body.children.indexOf(folder)); recent.click(); await settle();
  assert.equal(setup.modal.token, 0); assert.match(root.textContent, /^Sessions in other/);
  assert.equal(setup.calls.filter(call => call.path === '/api/sessions?project=%2Fother').length, 1);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});
test('Use this project immediately shows its sessions and folder validation stays beside its field', async t => {
  const setup = directPicker(t); setup.picker.openProject(); await settle(); setup.click('Other folder');
  const field = descendants(setup.body).find(node => node.id === 'picker-project'); assert.ok(field);
  field.value = 'relative'; const before = setup.calls.length; setup.click('Use folder');
  assert.equal(setup.calls.length, before); assert.match(setup.body.textContent, /working folder path that starts with/);
  assert.equal(field.focused, true); field.value = '/project'; setup.click('Use folder'); await settle();
  assert.ok(descendants(setup.body).find(node => node.id === 'picker-search'));
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});
test('Session file retains project, query, list nodes and caret and restores search focus on collapse', async t => {
  const setup = directPicker(t); const root = new Node('main'); setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle();
  const search = descendants(root).find(node => node.id === 'picker-search'); assert.ok(search);
  search.value = 'Saved'; search.setSelectionRange(1, 3); search.dispatch('input');
  const list = descendants(root).find(node => node.className === 'picker-sessions'); assert.ok(list); const rows = [...list.children];
  const file = descendants(root).find(node => node.className === 'picker-file'); assert.ok(file);
  const path = descendants(file).find(node => node.id === 'picker-session-path'); assert.ok(path);
  file.open = true; file.dispatch('toggle'); assert.equal(path.focused, true);
  assert.equal(descendants(root).filter(node => node.id === 'picker-search').length, 1);
  assert.equal(descendants(file).filter(node => node.tag === 'input').length, 1);
  const resume = descendants(file).find(node => node.textContent === 'Resume session'); assert.ok(resume);
  path.value = 'relative'; resume.click(); assert.match(file.textContent, /saved session path that starts with/);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
  search.focused = false; file.open = false; file.dispatch('toggle');
  assert.equal(search.focused, true); assert.equal(search.value, 'Saved');
  assert.deepEqual([search.selectionStart, search.selectionEnd], [1, 3]); assert.deepEqual(list.children, rows);
  assert.equal(descendants(root).find(node => node.className === 'picker-path')?.textContent, 'Working folder/project');
  assert.equal(setup.modal.token, 0);
});
test('exact file conflict stays beside the field without dropping the selected project or saved list', async t => {
  const setup = directPicker(t, active); setup.picker.open(); await settle(); setup.fail();
  const path = descendants(setup.body).find(node => node.id === 'picker-session-path'); assert.ok(path);
  const list = descendants(setup.body).find(node => node.className === 'picker-sessions'); assert.ok(list);
  path.value = '/project/unlisted.jsonl'; setup.click('Resume session'); await settle();
  assert.match(descendants(setup.body).find(node => node.id === 'picker-file-error')?.textContent ?? '', /backend writer/);
  assert.equal(descendants(setup.body).find(node => node.className === 'picker-sessions'), list);
  assert.equal(path.value, '/project/unlisted.jsonl'); assert.equal(setup.closed, false); assert.equal(setup.reloads, 0);
});
test('stopped and failed session records stay read-only snapshots and select no dead target', async t => {
  const setup = directPicker(t, {...active, lifecycle: 'stopped', sessionFile: saved.items[0].path}); setup.picker.open(); await settle();
  setup.state.primaries.push({...active, key: 'failed', lifecycle: 'failed', sessionFile: saved.items[0].path});
  const row = descendants(setup.body).find(node => node.className === 'picker-select'); assert.ok(row); row.click(); await settle();
  assert.equal(setup.selections.length, 0); assert.deepEqual(setup.reads.map(item => item.path), [saved.items[0].path]);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});
test('an owned modal resume retains its host when a transient empty view requests inline mounting', async t => {
  const setup = directPicker(t, active); setup.picker.open(); await settle();
  const path = descendants(setup.body).find(node => node.id === 'picker-session-path'); assert.ok(path);
  const modalToken = setup.modal.token; path.value = '/project/unlisted.jsonl'; setup.click('Resume session');
  const inline = new Node('main'); setup.picker.mount(inline as unknown as HTMLElement, '/project');
  assert.equal(inline.children.length, 0); assert.equal(setup.modal.token, modalToken);
  await settle(); assert.equal(setup.closed, true); assert.equal(setup.reloads, 1);
  assert.deepEqual(setup.calls.find(call => call.path === '/api/primaries')?.body, {cwd: '/project', sessionFile: '/project/unlisted.jsonl'});
  setup.picker.mount(inline as unknown as HTMLElement, '/project'); await settle();
  assert.ok(descendants(inline).find(node => node.id === 'picker-search'));
});
test('prompt excerpts retain full supplied details and the Resume caution stays in the file form', async t => {
  const title = 'Inspect this saved conversation '.repeat(6), item = saved.items[0]; assert.ok(item);
  const setup = directPicker(t, active, {...saved, items: [{...item, title, titleSource: 'prompt'}, {...item, id: 'named', path: '/project/named.jsonl', title, titleSource: 'name'}]});
  setup.picker.open(); await settle();
  const rows = descendants(setup.body).filter(node => node.className === 'picker-session'); assert.equal(rows.length, 2);
  assert.equal(rows[0]?.querySelector('.picker-session-title')?.textContent, title.trim());
  assert.ok(rows[0]?.querySelector('.picker-select')?.title.startsWith(title.trim())); assert.equal(rows[0]?.querySelector('.picker-session-full-title')?.textContent, title.trim());
  assert.equal(rows[1]?.querySelector('.picker-session-title')?.textContent, title.trim());
  assert.equal(rows[0]?.querySelector('.picker-session-folder'), undefined); assert.ok(rows[0]?.querySelector('.picker-age'));
  const file = descendants(setup.body).find(node => node.className === 'picker-file'); assert.ok(file); file.open = true; file.dispatch('toggle');
  const durable=setup.body.querySelector('.picker-durable'),registered=setup.body.querySelector('.picker-ordinary'),ordinary=setup.body.querySelector('.picker-folder-ordinary');assert.ok(durable&&registered&&ordinary);assert.equal(durable.querySelector('.picker-safety'),null);assert.equal(registered.querySelector('.picker-safety'),null);assert.equal(ordinary.children.some(node=>node.classList.contains('picker-safety')),false);assert.equal(setup.body.children.some(node=>node.classList.contains('picker-safety')),false);const fileSafety=file.querySelector('.picker-safety');assert.ok(fileSafety);assert.equal(fileSafety.hidden,false);assert.match(fileSafety.textContent,/^Stop a terminal session before you resume it here\./);assert.equal(setup.calls.some(call=>call.path==='/api/primaries'||call.path==='/api/agents/convert'),false);
});
test('different prompts keep distinct captions so rows need no identity tail', async t => {
  const item = saved.items[0]; assert.ok(item); const prefix = 'Same visible prompt '.repeat(5);
  const setup = directPicker(t, active, {...saved, items: [{...item, id: 'prompt0033', title: `${prefix}first`, titleSource: 'prompt'}, {...item, id: 'prompt0034', path: '/project/second.jsonl', title: `${prefix}second`, titleSource: 'prompt'}]});
  setup.picker.open(); await settle(); const rows = descendants(setup.body).filter(node => node.className === 'picker-select'); assert.equal(rows.length, 2);
  assert.notEqual(rows[0]?.querySelector('.picker-session-title')?.textContent, rows[1]?.querySelector('.picker-session-title')?.textContent);
  assert.equal(rows[0]?.querySelector('.picker-session-tail')?.hidden, true); assert.equal(rows[1]?.querySelector('.picker-session-tail')?.hidden, true);
    assert.notEqual(rows[0]?.title, rows[1]?.title);
});
test('chooser style bindings preserve ordinary actions and full-width Durable rows', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(css, /\.picker-header \{[^}]*align-items: center;[^}]*justify-content: space-between;/);
  assert.match(css, /\.picker-context \{[^}]*grid-template-columns: minmax\(0,1fr\) auto;[^}]*align-items: start;/);
  assert.match(css, /\.picker-path \{ min-width: 0; overflow-wrap: anywhere; \}/);
  assert.match(css, /--s2: 8px;/);
  assert.match(css, /\.picker-context-actions \{ display: flex; align-items: center; gap: var\(--s2\); \}/);
  assert.match(css, /@media \(pointer: coarse\) \{ \.picker-context > \.picker-path > summary \{ min-height: 44px;/);
  assert.match(css, /\.picker-session \{[^}]*grid-template-columns: minmax\(0,1fr\) auto auto auto auto;/);
  assert.match(css, /\.picker-session-details\[open\] \{[^}]*grid-column: 1 \/ -1; grid-row: 2;/);
  assert.match(css, /\.picker-session-meta:empty \{ display: none; \}/);
  assert.match(css, /\.picker-session\[data-opened=true\] \{[^}]*grid-template-columns: minmax\(0,1fr\) auto auto auto;/);
  assert.match(css, /\.picker-footer \{[^}]*border-top: 1px solid var\(--edge\);/);
  assert.match(css, /dialog\[open\]\[data-variant=picker\] \{ display: flex; flex-direction: column; overflow: hidden; \}/);
  assert.match(css, /dialog\[data-variant=picker\] #modal-body \{[^}]*display: flex; flex-direction: column; min-height: 0;/);
  assert.match(css, /\.picker-results \{ flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; \}/);
  assert.match(css, /dialog\[data-variant=picker\] #modal-body > :not\(\.picker-results\) \{ flex: none; \}/);
  assert.match(css,/\.picker-durable-list \{[^}]*grid-template-columns: minmax\(0,1fr\);/);assert.match(css,/\.picker-durable-select \{[^}]*grid-template-columns: minmax\(0,1fr\);[^}]*width: 100%;[^}]*min-width: 0;/);assert.match(css,/\.picker-durable-select :is\(\.picker-session-title, \.picker-session-tail, \.picker-durable-state\) \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
});


test('picker SVG actions retain names and options reveal exact-file input without replacing the list', async t => {
  const setup = directPicker(t); const root = new Node('main'); setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle();
  const nodes = descendants(root), list = nodes.find(node => node.className === 'picker-sessions'), search = nodes.find(node => node.id === 'picker-search');
  assert.ok(list); assert.ok(search); search.value = 'Saved'; search.setSelectionRange(1, 3); search.dispatch('input');
  const rows = [...list.children];
  for (const label of ['New session', 'Refresh saved sessions', 'Saved session options']) {
    const action = nodes.find(node => node.attributes['aria-label'] === label); assert.ok(action, label);
    assert.equal(action.title, label); assert.equal(action.children[0]?.tag, 'svg');
    assert.equal(action.children[1]?.className, 'sr-only card-action-label');
  }
  const file = nodes.find(node => node.className === 'picker-file'); assert.ok(file); assert.equal(file.hidden, true);
  const options = nodes.find(node => node.attributes['aria-label'] === 'Saved session options'); assert.ok(options);
  assert.equal(options.attributes['aria-haspopup'], 'menu'); options.click(); setup.click('Session file');
  assert.equal(file.hidden, false); assert.equal(file.open, true);
  assert.equal(descendants(root).find(node => node.id === 'picker-session-path')?.focused, true);
  assert.equal(descendants(root).find(node => node.className === 'picker-sessions'), list); assert.deepEqual(list.children, rows);
  assert.equal(search.value, 'Saved'); assert.deepEqual([search.selectionStart, search.selectionEnd], [1, 3]);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});
test('loaded project rows share shortest unique suffixes and preserve exact directory actions', async t => {
  const setup = directPicker(t, {...active, cwd: '/projects/one/checkout', sessionName: 'Release notes'});
  setup.state.launchCwd = '/projects/two/checkout';
  globalThis.fetch = async () => Response.json({ok: true, data: {items: [
    {path: '/archive/one/checkout', name: 'checkout'}, {path: '/projects/notes', name: 'notes'},
  ], total: 2, omitted: 0, nextCursor: null, observedAt: saved.observedAt}});
  setup.picker.openProject(); await settle();
  const rows = descendants(setup.body).filter(node => node.dataset.itemKey?.startsWith('primary:') || node.dataset.itemKey?.startsWith('project:'));
  assert.deepEqual(rows.map(node => node.textContent), ['projects/one/checkout', 'two/checkout', 'archive/one/checkout', 'notes']);
  assert.equal(rows[2]?.title, '/archive/one/checkout'); assert.match(rows[0]?.title ?? '', /Release notes/);
  rows[0]?.click(); await settle();
  assert.deepEqual(setup.selections, [{primaryKey: 'current', selectedTarget: {kind: 'primary', key: 'current', epoch: 1}}]);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});

const sessionRow = (setup: ReturnType<typeof directPicker>) => { const row = setup.body.querySelector('.picker-folder-ordinary')?.querySelector('.picker-session'); assert.ok(row); return row; };
const rowOf = (setup: ReturnType<typeof directPicker>) => { const select = setup.body.querySelector('.picker-folder-ordinary')?.querySelector('.picker-select'); assert.ok(select); return select; };
test('a saved file a terminal writes reads "live in terminal", then "Terminal ended" once the terminal ends, and stays readable', async t => {
  const page = {...saved, items: [{...ordinarySample, writer: 'live' as const}]};
  const setup = directPicker(t, undefined, page, undefined, {roster: catalogRoster(), published: noPublished}); setup.picker.open(); await settle();
  let select = rowOf(setup);
  assert.equal(select.disabled, false); assert.match(select.textContent, /live in terminal/); assert.doesNotMatch(select.textContent, /Terminal ended/);
  assert.equal(select.querySelectorAll('.picker-session-meta').length, 1, 'The held state reads on one line');
  assert.equal(sessionRow(setup).children.some(node => node.className === 'quiet picker-resume'), false);
  page.items = [{...ordinarySample}]; setup.picker.writersChanged(); await settle();
  select = rowOf(setup); assert.equal(select.disabled, false); assert.match(select.textContent, /Terminal ended/); assert.doesNotMatch(select.textContent, /live in terminal/);
  select.click(); await settle();
  assert.deepEqual(setup.reads.map(item => item.path), [ordinarySample.path]);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false, 'release alone resumes nothing');
});
test('a registered file in the current folder keeps one folder row before and after writer release', async t => {
  const held = {...ordinarySample, writer: 'live' as const};
  const catalog = {roster: catalogRoster(), published: {...noPublished, items: [held], total: 1}};
  const page = {...saved, items: [held]};
  const setup = directPicker(t, undefined, page, undefined, catalog); setup.picker.open(); await settle();
  const registered = () => setup.body.querySelector('.picker-registered-list')?.querySelectorAll('.picker-select').length;
  assert.equal(registered(), 0); assert.equal(setup.body.querySelector('.picker-folder-ordinary')?.querySelectorAll('.picker-select').length, 1, 'a registered file lists once in its folder');
  page.items = [{...ordinarySample}]; catalog.published = {...noPublished}; setup.picker.writersChanged(); await settle();
  assert.equal(registered(), 0);
  let select = rowOf(setup);
  assert.equal(select.disabled, false); assert.match(select.textContent, /Terminal ended/);
  setup.modal.close(); setup.picker.open(); await settle();
  select = rowOf(setup); assert.equal(select.disabled, false); assert.match(select.textContent, /Terminal ended/);
});
test('a file that was never held reads as before and the window regaining focus makes no row claim', async t => {
  const setup = directPicker(t, undefined, saved, undefined, {roster: catalogRoster(), published: noPublished}); setup.picker.open(); await settle();
  const select = rowOf(setup);
  assert.equal(select.disabled, false); assert.doesNotMatch(select.textContent, /terminal/i);
  setup.picker.writersChanged(); await settle(); assert.doesNotMatch(rowOf(setup).textContent, /terminal/i);
});
test('a refusal at Resume shows the writer sentence and turns the row to its held state', async t => {
  const page = {...saved, items: [{...ordinarySample}]};
  const setup = directPicker(t, undefined, page, undefined, {roster: catalogRoster(), published: noPublished}); setup.picker.open(); await settle();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/primaries') || String(url).includes('/api/operations')) return new Response(JSON.stringify({ok: false, error: {code: 'writer_active', message: 'A terminal session is writing this file. Resume when it ends.', retry: 'manual'}}), {status: 409, headers: {'content-type': 'application/json'}});
    return original(url, init);
  };
  page.items = [{...ordinarySample, writer: 'live' as const}];
  setup.picker.resume('/project', ordinarySample.path); await settle(); await settle();
  assert.match(setup.error, /^A terminal session is writing this file\. Resume when it ends\./);
  assert.equal(rowOf(setup).disabled, false); assert.match(rowOf(setup).textContent, /live in terminal/);
});
test('an opened row has no Resume control while the row itself still selects its session', async t => {
  const setup = directPicker(t, {...active, sessionFile: saved.items[0].path}); setup.picker.open(); await settle();
  const row = sessionRow(setup);
  assert.equal(row.children.some(node => node.className === 'quiet picker-resume'), false); assert.equal(row.dataset.opened, 'true');
  assert.match(row.querySelector('.picker-select')?.textContent ?? '', /In this window/);
  assert.equal(row.children.some(node => node.textContent === 'Convert to Durable'), false);
  row.querySelector('.picker-select')?.click(); await settle();
  assert.deepEqual(setup.reads.map(item => item.path), [saved.items[0].path]);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false, 'Selecting an open session starts nothing');
});
test('the Session file form carries the only Resume caution', async t => {
  const setup = directPicker(t, undefined, saved, undefined, {roster: catalogRoster(), published: noPublished}); setup.picker.open(); await settle();
  const file = setup.body.querySelector('.picker-file'); assert.ok(file);
  const cautions = () => descendants(setup.body).filter(node => node.classList.contains('picker-safety') && node.hidden !== true && !(file.hidden && file.querySelector('.picker-safety') === node));
  assert.equal(cautions().length, 0);
  file.hidden = false; file.open = true; file.dispatch('toggle');
  assert.equal(cautions().length, 1, 'Only the form caution shows');
  file.open = false; file.dispatch('toggle');
  assert.equal(cautions().length, 0); assert.equal(file.hidden, true);
});
