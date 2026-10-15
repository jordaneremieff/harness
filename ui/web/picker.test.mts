import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, {type TestContext} from 'node:test';
import type { Bootstrap, PrimaryView, RecentProjectPage, SavedSessionPage } from '../shared/api.ts';
import type { Modal } from './modal.ts';
import type { SelectionChange } from './actions.ts';
import { ProjectPicker } from './picker.ts';
import { contextMenu } from './context-menu.ts';

class Node {
  children: Node[] = []; className = ''; id = ''; value = ''; title = ''; hidden = false; disabled = false;
  open = false; scrollLeft = 100; selectionStart = -1; selectionEnd = -1; focused = false; htmlFor = '';
  private handlers = new Map<string, Array<() => void>>();
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
  addEventListener(name: string, callback: () => void): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], callback]); }
  dispatch(name: string): void { for (const callback of this.handlers.get(name) ?? []) callback(); }
  click(): void { this.dispatch('click'); }
  querySelectorAll(selector: string): Node[] { return descendants(this).filter(node => selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : selector.startsWith('#') ? node.id === selector.slice(1) : node.tag === selector); }
  querySelector(selector: string): Node | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus(): void { this.focused = true; }
  getBoundingClientRect() { return {left: 8, top: 8, bottom: 36, width: 140, height: 28}; }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
}
function descendants(node: Node): Node[] { return node.children.flatMap(child => [child, ...descendants(child)]); }
const saved: SavedSessionPage = {items: [{id: 's', path: '/project/s.jsonl', project: '/project', revision: 'r', title: 'Saved title', titleState: 'ready', modifiedAt: '2026-01-01T00:00:00Z', size: 10}], total: 1, omitted: 0, nextCursor: null, titleCursor: null, observedAt: '2026-01-01T00:00:00Z'};
for (const [name, page, status] of [
  ['complete', saved, 'Saved list · now'],
  ['more pages', {...saved, total: 2, nextCursor: 'more'}, '1 of 2 sessions shown · Saved list · now'],
  ['omissions', {...saved, omitted: 1}, '1 of 1 sessions shown · 1 session is not listed. · Saved list · now'],
  ['unavailable title', {...saved, items: saved.items.map(item => ({...item, titleState: 'unavailable' as const}))}, '1 of 1 sessions shown · Saved list · now'],
] as const) test(`saved session status merges freshness and coverage for ${name}`, async t => {
  t.mock.method(Date, 'now', () => Date.parse(saved.observedAt));
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const oldFetch = globalThis.fetch; const body = new Node('div');
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: Node});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {activeElement: null, createElement: (tag: string) => new Node(tag), createElementNS: (_ns: string, tag: string) => new Node(tag), createDocumentFragment: () => new Node('fragment')}});
  globalThis.fetch = async url => new Response(JSON.stringify({ok: true, data: String(url).includes('/api/projects') ? {items: [], total: 0, omitted: 0, nextCursor: null, observedAt: saved.observedAt} : page}), {status: 200, headers: {'content-type': 'application/json'}});
  const modal = {node: {dataset: {} as Record<string, string>}, token: 1, open: () => { body.replaceChildren(); return body; }, owns: (token: number) => token === 1, actions: (...buttons: Node[]) => body.append(...buttons), error: (error: unknown) => { throw error; }};
  try {
    const picker = new ProjectPicker({modal: modal as unknown as Modal, snapshot: () => ({launchCwd: '/project', primaries: []}) as unknown as Bootstrap, primary: () => undefined, selection: async () => {}, reload: async () => {}});
    picker.open(); assert.equal(modal.node.dataset.variant, 'picker', 'pickers open as the top-anchored panel');
    assert.equal(descendants(body).some(node => node.textContent === 'Open project'), false);
    await new Promise<void>(resolve => setImmediate(resolve));
    const nodes = descendants(body); const search = nodes.find(node => node.id === 'picker-search'); assert.ok(search);
    const label = nodes.find(node => node.tag === 'label' && node.htmlFor === search.id); assert.ok(label);
    assert.equal(label.className, 'sr-only'); assert.equal(label.textContent, 'Search sessions');
    const heading = body.children.findIndex(node => node.className === 'secondary picker-safety');
    assert.equal(body.children[heading]?.textContent, 'If a session is open in a terminal, close it there before opening it here.');
    const searchRow = body.children[heading - 1]; assert.ok(searchRow); assert.equal(searchRow.className, 'picker-search-row');
    const line = searchRow.children[0]; assert.ok(line); assert.equal(line.className, 'picker-input-row'); assert.equal(search.className, 'picker-input');
    assert.equal(line.children.length, 2); assert.equal(search.id, label.htmlFor);
    assert.equal(line.children[0], label); assert.equal(line.children[1], search);
    const coverage = nodes.find(node => node.id === 'picker-coverage'); assert.ok(coverage);
    assert.equal(coverage.className, 'secondary'); assert.equal(coverage.attributes['aria-live'], 'polite');
    const freshness = nodes.find(node => node.className === 'picker-list-details'); assert.ok(freshness);
    assert.match(freshness.textContent, /Saved list · now/);
    assert.equal(coverage.textContent, name === 'complete' ? '' : status.replace(' · Saved list · now', ''));
    assert.equal(coverage.hidden, name === 'complete');
    assert.equal(body.children.filter(node => node.textContent.includes('Saved list ·')).length, 1);
    assert.ok(nodes.find(node => node.tag === 'button' && node.attributes['aria-label'] === 'Refresh saved sessions'));
    search.value = 'no match'; search.dispatch('input');
    assert.equal(coverage.textContent, name === 'complete' ? '0 matches in loaded sessions' : `0 matches in loaded sessions · ${status.replace(' · Saved list · now', '')}`);
    const empty = nodes.find(node => node.className === 'picker-sessions')?.children.find(node => node.tag === 'p'); assert.ok(empty);
    assert.match(empty.textContent, /sessions match “no match”/); assert.equal(empty.textContent.includes('Use More saved sessions'), name === 'more pages');
    assert.equal(empty.textContent.includes('list is incomplete'), name === 'omissions' || name === 'unavailable title');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (oldElement) Object.defineProperty(globalThis, 'HTMLElement', oldElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }
});
function directPicker(t: TestContext, active?: PrimaryView, page: SavedSessionPage = saved) {
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
  const state = {primaries: active ? [active] : [], launchCwd: '/project'} as unknown as Bootstrap;
  let reloads = 0; let failure = false; let listFailure = false; let closed = false; let error = ''; let running = false;
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
    let data: unknown = page;
    if (path.includes('/api/operations')) data = {operationId: 'open'};
    else if (path.includes('/api/primaries')) data = failure
      ? {operation: {state: 'rejected', error: {code: 'operation_conflict', message: 'This saved session already has a backend writer.'}}}
      : {primaryKey: 'opened', operation: {state: 'completed'}};
    else if (path.includes('/api/projects')) data = {items: [], total: 0, omitted: 0, nextCursor: null, observedAt: saved.observedAt};
    return new Response(JSON.stringify({ok: true, data}), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const picker = new ProjectPicker({modal: modal as unknown as Modal, snapshot: () => state, primary: () => active,
    selection: async change => { steps.push('selection'); selections.push(change); }, reload: async () => { steps.push('reload'); reloads++; }});
  const click = (label: string) => { const node = descendants(body).find(node => node.tag === 'button' && node.textContent === label); assert.ok(node, label); node.click(); };
  return {picker, modal, body, calls, state, selections, steps, click, fail: () => { failure = true; }, failList: () => { listFailure = true; }, get reloads() { return reloads; }, get closed() { return closed; }, get error() { return error || descendants(body).find(node => node.id === 'picker-file-error')?.textContent || descendants(body).find(node => node.className === 'picker-error')?.textContent || ''; }};
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const active = {key: 'current', cwd: '/project', epoch: 1, lifecycle: 'ready'} as PrimaryView;
test('first-use folder selection retains the inline session chooser after the root save',async t=> {
  const setup=directPicker(t);const root=new Node('main');let folder:string|undefined;
  const picker=new ProjectPicker({modal:setup.modal as unknown as Modal,snapshot:()=>setup.state,primary:()=>undefined,project:()=>folder,selection:async()=>{},reload:async()=>{},workingFolder:async path=> {folder=path;}});
  picker.mount(root as unknown as HTMLElement);await settle();picker.openProject();await settle();
  const other=descendants(root).find(node=>node.tag==='button'&&node.textContent==='Other folder…');assert.ok(other);other.click();
  const field=descendants(root).find(node=>node.id==='picker-project');assert.ok(field);field.value='/another-project';
  const use=descendants(root).find(node=>node.tag==='button'&&node.textContent==='Use folder');assert.ok(use);use.click();await settle();await settle();
  assert.equal(folder,'/another-project');assert.ok(descendants(root).find(node=>node.id==='picker-search'));
  assert.ok(descendants(root).find(node=>node.attributes['aria-label']==='New session'));assert.ok(descendants(root).find(node=>node.className==='picker-select'));
  assert.equal(setup.modal.token,0);assert.equal(setup.calls.some(call=>call.path==='/api/primaries'),false);
});
test('current project opens its session list and a saved row directly admits one open without attestation', async t => {
  const setup = directPicker(t, active); setup.picker.open(); await settle();
  assert.equal(setup.calls.some(call => call.path.includes('/api/projects')), false);
  assert.equal(descendants(setup.body).some(node => node.textContent === 'Open project'), false);
  assert.ok(descendants(setup.body).find(node => node.textContent === 'If a session is open in a terminal, close it there before opening it here.'));
  const row = descendants(setup.body).find(node => node.className === 'picker-select'); assert.ok(row);
  row.click(); row.click(); await settle();
  assert.deepEqual(setup.calls.filter(call => call.path === '/api/primaries').map(call => call.body), [{cwd: '/project', sessionFile: '/project/s.jsonl'}]);
  assert.equal(setup.reloads, 1); assert.equal(setup.closed, true);
});
test('bootstrap without a primary lists launch-project sessions directly without starting Pi', async t => {
  const setup = directPicker(t); setup.picker.open(); await settle();
  assert.deepEqual(setup.calls.map(call => call.path), ['/api/sessions?project=%2Fproject']);
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
  setup.click('Change working folder'); setup.click('Other folder…'); assert.ok(descendants(setup.body).find(node => node.id === 'picker-project'));
  assert.ok(descendants(setup.body).find(node => node.textContent === 'Use folder'));
});
test('without a primary or launch project the picker retains explicit project selection', async t => {
  const setup = directPicker(t); setup.state.launchCwd = undefined; setup.picker.open(); await settle(); setup.click('Other folder…');
  assert.ok(descendants(setup.body).find(node => node.id === 'picker-project'));
  assert.equal(setup.calls.some(call => call.path.includes('/api/sessions')), false);
});
test('saved row reuses the current exact backend owner and epoch without a second open', async t => {
  const setup = directPicker(t, {...active, sessionFile: saved.items[0].path}); setup.picker.open(); await settle();
  setup.state.primaries = [{...active, epoch: 3, sessionFile: saved.items[0].path}];
  descendants(setup.body).find(node => node.className === 'picker-select')?.click(); await settle();
  assert.deepEqual(setup.selections, [{primaryKey: 'current', selectedTarget: {kind: 'primary', key: 'current', epoch: 3}}]);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false); assert.equal(setup.closed, true);
  assert.equal(setup.reloads, 1); assert.deepEqual(setup.steps, ['selection', 'reload']);
});
test('a row whose owner changed opens the saved path and a known conflict retains the list', async t => {
  const setup = directPicker(t, {...active, sessionFile: saved.items[0].path}); setup.picker.open(); await settle();
  setup.state.primaries = [{...active, epoch: 2, sessionFile: '/project/other.jsonl'}]; setup.fail();
  const row = descendants(setup.body).find(node => node.className === 'picker-select'); assert.ok(row); row.click(); await settle();
  assert.equal(setup.selections.length, 0); assert.equal(setup.reloads, 0); assert.equal(setup.closed, false);
  assert.match(setup.error, /backend writer/); assert.ok(descendants(setup.body).includes(row));
});
test('Projects remains deliberate and exact paths validate before direct open or owner reuse', async t => {
  const setup = directPicker(t, {...active, sessionFile: saved.items[0].path}); setup.picker.open(); await settle();
  setup.click('Change working folder'); setup.click('Other folder…'); assert.ok(descendants(setup.body).find(node => node.id === 'picker-project'));
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
  setup.click('Other folder…'); const field = descendants(host).find(node => node.id === 'picker-project'); assert.ok(field);
  assert.equal(field.value, path); assert.equal(field.focused, true); assert.equal(field.selectionStart, 0); assert.equal(field.selectionEnd, 0); assert.equal(field.scrollLeft, 0);
});
test('a late project reply retains action identity when new project rows precede the focused action', async t => {
  const setup = directPicker(t, active); let release: (response: Response) => void = () => {throw Error('Request not started');};
  globalThis.fetch = async () => new Promise<Response>(resolve => {release = resolve;});
  setup.picker.openProject();
  const folder = descendants(setup.body).find(node => node.textContent === 'Other folder…'); assert.ok(folder);
  assert.equal(folder.dataset.itemKey, 'folder');
  release(Response.json({ok: true, data: {items: [{path: '/new/project', name: 'project'}], total: 1, omitted: 0, nextCursor: null, observedAt: saved.observedAt}}));
  await settle();
  const rows = descendants(setup.body);
  assert.equal(rows.find(node => node.textContent === 'Other folder…')?.dataset.itemKey, folder.dataset.itemKey);
  assert.deepEqual(rows.filter(node => node.dataset.itemKey?.startsWith('primary:') || node.dataset.itemKey?.startsWith('project:')).map(node => [node.textContent, node.dataset.itemKey]), [['/project', 'primary:current'], ['new/project', 'project:/new/project']]);
  assert.ok(rows.findIndex(node => node.dataset.itemKey === 'project:/new/project') < rows.findIndex(node => node.dataset.itemKey === 'folder'));
});
test('a late project reply never reopens a dismissed popup or replaces the folder dialog', async t => {
  const setup = directPicker(t); let release: (response: Response) => void = () => {throw Error('Request not started');};
  globalThis.fetch = async () => new Promise<Response>(resolve => {release = resolve;});
  setup.picker.openProject(); setup.click('Other folder…');
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
  assert.equal(first.children[1]?.className, 'picker-session-meta'); assert.equal(first.children[1]?.textContent, 'projectIn this window');
  const metadata = nodes.find(node => node.className === 'picker-session-details'); assert.ok(metadata);
  assert.match(metadata.textContent, /fixture0033.*10 B/);
  assert.equal(first.textContent.includes('fixture0033'), false);
  assert.ok(nodes.find(node => node.className === 'picker-age quiet'));
  const search = nodes.find(node => node.id === 'picker-search'); assert.ok(search); search.value = 'fixture0034'; search.dispatch('input');
  assert.equal(descendants(setup.body).filter(node => node.className === 'picker-select').length, 1);
  assert.equal(descendants(setup.body).find(node => node.className === 'picker-session-tail')?.textContent, '0034');
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

test('first use mounts the shared session list inline and enters a saved session without a dialog', async t => {
  const setup = directPicker(t); const root = new Node('main');
  setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle();
  assert.equal(setup.modal.token, 0);
  assert.match(root.textContent, /Sessions in project/);
  assert.ok(descendants(root).find(node => node.id === 'picker-search'));
  const select = descendants(root).find(node => node.className === 'picker-select'); assert.ok(select);
  select.click(); select.click(); await settle();
  assert.equal(setup.calls.filter(call => call.path === '/api/primaries').length, 1);
  assert.equal(setup.reloads, 1); assert.equal(root.children.length, 0); assert.equal(setup.modal.token, 0);
});
test('an inline conflict retains the list and project choice', async t => {
  const setup = directPicker(t); const root = new Node('main');
  setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle(); setup.fail();
  descendants(root).find(node => node.className === 'picker-select')?.click(); await settle();
  assert.match(root.textContent, /backend writer/); assert.ok(descendants(root).find(node => node.id === 'picker-search'));
  assert.equal(setup.reloads, 0); assert.equal(setup.modal.token, 0);
});
test('inline loading cancels late inventory after unmount and terminal safety only accompanies unowned saved rows', async t => {
  const setup = directPicker(t, {...active, sessionFile: saved.items[0].path}); const root = new Node('main');
  setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle();
  assert.equal(descendants(root).find(node => node.className === 'secondary picker-safety')?.hidden, true);
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

test('chooser controls stay with their title, search and list disclosure while row facts remain reachable', async t => {
  const setup = directPicker(t); const root = new Node('main');
  setup.picker.mount(root as unknown as HTMLElement, '/project'); await settle();
  const header = root.children[0]; assert.ok(header); assert.equal(header.className, 'picker-header');
  assert.equal(header.children[0]?.tag, 'h1'); assert.match(header.children[0]?.textContent ?? '', /Sessions in project/);
  assert.equal(header.children[1]?.className, 'dialog-actions');
  assert.deepEqual(header.children[1]?.children.map(node => node.attributes['aria-label']), ['New session']);
  const nodes = descendants(root); const searchRow = nodes.find(node => node.className === 'picker-search-row'); assert.ok(searchRow);
  assert.equal(searchRow.children[0]?.className, 'picker-input-row'); assert.equal(searchRow.children[1]?.attributes['aria-label'], 'Refresh saved sessions');
  assert.equal(searchRow.children[2]?.attributes['aria-label'], 'Saved session options');
  const footer = nodes.find(node => node.classList.contains('picker-footer')); assert.ok(footer);
  const listDetails = footer.children.find(node => node.className === 'picker-list-details'); assert.ok(listDetails);
  assert.equal(listDetails.children.some(node => node.textContent === 'Session file…'), false);
  const file = nodes.find(node => node.className === 'picker-file'); assert.ok(file);
  assert.equal(file.children[0]?.textContent, 'Session file…');
  const row = nodes.find(node => node.className === 'picker-session'); assert.ok(row);
  assert.equal(row.children[0]?.className, 'picker-select'); assert.equal(row.children[1]?.className, 'picker-age quiet');
  const facts = row.children[2]; assert.ok(facts); assert.equal(facts.tag, 'details'); assert.equal(facts.children[0]?.attributes['aria-label'], 'Details for Saved title');
  assert.deepEqual(facts.children.slice(1).map(node => node.textContent), ['Saved title', '/project', 's', '/project/s.jsonl', '10 B', 'If this session is active in a terminal, close it there first.']);
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
  const folder = body.children.find(node => node.textContent === 'Other folder…'); assert.ok(folder);
  assert.ok(body.children.indexOf(recent) < body.children.indexOf(folder)); recent.click(); await settle();
  assert.equal(setup.modal.token, 0); assert.match(root.textContent, /^Sessions in other/);
  assert.equal(setup.calls.filter(call => call.path === '/api/sessions?project=%2Fother').length, 1);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});
test('Use this project immediately shows its sessions and folder validation stays beside its field', async t => {
  const setup = directPicker(t); setup.picker.openProject(); await settle(); setup.click('Other folder…');
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
test('stopped and failed session records resume their exact file rather than select a dead target', async t => {
  const setup = directPicker(t, {...active, lifecycle: 'stopped', sessionFile: saved.items[0].path}); setup.picker.open(); await settle();
  setup.state.primaries.push({...active, key: 'failed', lifecycle: 'failed', sessionFile: saved.items[0].path});
  const row = descendants(setup.body).find(node => node.className === 'picker-select'); assert.ok(row); row.click(); await settle();
  assert.equal(setup.selections.length, 0);
  assert.deepEqual(setup.calls.find(call => call.path === '/api/primaries')?.body, {cwd: '/project', sessionFile: saved.items[0].path});
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
test('prompt excerpts retain full supplied details and the exact-file route has one global writer caution', async t => {
  const title = 'Inspect this saved conversation '.repeat(6), item = saved.items[0]; assert.ok(item);
  const setup = directPicker(t, active, {...saved, items: [{...item, title, titleSource: 'prompt'}, {...item, id: 'named', path: '/project/named.jsonl', title, titleSource: 'name'}]});
  setup.picker.open(); await settle();
  const rows = descendants(setup.body).filter(node => node.className === 'picker-session'); assert.equal(rows.length, 2);
  assert.ok((rows[0]?.querySelector('.picker-session-title')?.textContent.length ?? 100) <= 65);
  assert.equal(rows[0]?.querySelector('.picker-select')?.title, title); assert.equal(rows[0]?.querySelector('.picker-session-full-title')?.textContent, title);
  assert.equal(rows[1]?.querySelector('.picker-session-title')?.textContent, title);
  assert.equal(rows[0]?.querySelector('.picker-session-folder')?.textContent, 'project'); assert.ok(rows[0]?.querySelector('.picker-age'));
  const file = descendants(setup.body).find(node => node.className === 'picker-file'); assert.ok(file); file.open = true; file.dispatch('toggle');
  const warnings = descendants(setup.body).filter(node => node.className === 'secondary picker-safety'); assert.equal(warnings.length, 1); assert.equal(warnings[0]?.hidden, false);
  assert.doesNotMatch(file.textContent, /terminal/); assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});
test('different prompts with identical compact captions retain distinct exact-identity tails', async t => {
  const item = saved.items[0]; assert.ok(item); const prefix = 'Same visible prompt '.repeat(5);
  const setup = directPicker(t, active, {...saved, items: [{...item, id: 'prompt0033', title: `${prefix}first`, titleSource: 'prompt'}, {...item, id: 'prompt0034', path: '/project/second.jsonl', title: `${prefix}second`, titleSource: 'prompt'}]});
  setup.picker.open(); await settle(); const rows = descendants(setup.body).filter(node => node.className === 'picker-select'); assert.equal(rows.length, 2);
  assert.equal(rows[0]?.querySelector('.picker-session-title')?.textContent, rows[1]?.querySelector('.picker-session-title')?.textContent);
  assert.equal(rows[0]?.querySelector('.picker-session-tail')?.textContent, '0033'); assert.equal(rows[1]?.querySelector('.picker-session-tail')?.textContent, '0034');
  assert.notEqual(rows[0]?.title, rows[1]?.title);
});
test('chooser style bindings keep closed facts on the title line and separate list utilities', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(css, /\.picker-header \{[^}]*align-items: center;[^}]*justify-content: space-between;/);
  assert.match(css, /\.picker-session \{[^}]*grid-template-columns: minmax\(0,1fr\) auto auto;/);
  assert.match(css, /\.picker-session-details\[open\] \{[^}]*grid-column: 1 \/ -1; grid-row: 2;/);
  assert.match(css, /\.picker-session-meta:empty \{ display: none; \}/);
  assert.match(css, /\.picker-footer \{[^}]*border-top: 1px solid var\(--edge\);/);
  assert.match(css, /\.agent-row \.row-identity \{ grid-column: 2; grid-row: 2; \}/);
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
  assert.equal(options.attributes['aria-haspopup'], 'menu'); options.click(); setup.click('Session file…');
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
