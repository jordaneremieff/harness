import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type { Bootstrap, PrimaryView, RecentProjectPage, SavedSessionPage } from '../shared/api.ts';
import type { Modal } from './modal.ts';
import type { SelectionChange } from './actions.ts';
import { ProjectPicker } from './picker.ts';

class Node {
  children: Node[] = []; className = ''; id = ''; value = ''; title = ''; hidden = false; disabled = false;
  scrollLeft = 100; selectionStart = -1; selectionEnd = -1; focused = false; htmlFor = '';
  private handlers = new Map<string, Array<() => void>>();
  classList = {contains: (name: string) => this.className.split(' ').includes(name)};
  attributes: Record<string, string> = {}; dataset: Record<string, string> = {}; private text = '';
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]): void { this.children = nodes; this.text = ''; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(name: string, callback: () => void): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], callback]); }
  dispatch(name: string): void { for (const callback of this.handlers.get(name) ?? []) callback(); }
  click(): void { this.dispatch('click'); }
  querySelectorAll(selector: string): Node[] { return descendants(this).filter(node => selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tag === selector); }
  querySelector(selector: string): Node | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus(): void { this.focused = true; }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
}
function descendants(node: Node): Node[] { return node.children.flatMap(child => [child, ...descendants(child)]); }
const saved: SavedSessionPage = {items: [{id: 's', path: '/project/s.jsonl', project: '/project', revision: 'r', title: 'Saved title', titleState: 'ready', modifiedAt: '2026-01-01T00:00:00Z', size: 10}], total: 1, omitted: 0, nextCursor: null, titleCursor: null, observedAt: '2026-01-01T00:00:00Z'};
for (const [name, page, status] of [
  ['complete', saved, 'Saved list · now'],
  ['more pages', {...saved, total: 2, nextCursor: 'more'}, '1 of 2 shown · Saved list · now'],
  ['omissions', {...saved, omitted: 1}, '1 of 1 shown · 1 unavailable or outside the scan bound · Saved list · now'],
  ['unavailable title', {...saved, items: saved.items.map(item => ({...item, titleState: 'unavailable' as const}))}, '1 of 1 shown · Saved list · now'],
] as const) test(`saved session status merges freshness and coverage for ${name}`, async t => {
  t.mock.method(Date, 'now', () => Date.parse(saved.observedAt));
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const oldFetch = globalThis.fetch; const body = new Node('div');
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: Node});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {activeElement: null, createElement: (tag: string) => new Node(tag), createDocumentFragment: () => new Node('fragment')}});
  globalThis.fetch = async url => new Response(JSON.stringify({ok: true, data: String(url).includes('/api/projects') ? {items: [], total: 0, omitted: 0, nextCursor: null, observedAt: saved.observedAt} : page}), {status: 200, headers: {'content-type': 'application/json'}});
  const modal = {node: {dataset: {} as Record<string, string>}, token: 1, open: () => { body.replaceChildren(); return body; }, owns: (token: number) => token === 1, actions: (...buttons: Node[]) => body.append(...buttons), error: (error: unknown) => { throw error; }};
  try {
    const picker = new ProjectPicker({modal: modal as unknown as Modal, snapshot: () => ({launchCwd: '/project', primaries: []}) as unknown as Bootstrap, primary: () => undefined, selection: async () => {}, reload: async () => {}});
    picker.open(); assert.equal(modal.node.dataset.variant, 'picker', 'pickers open as the top-anchored panel');
    assert.equal(descendants(body).some(node => node.textContent === 'Continue'), false);
    await new Promise<void>(resolve => setImmediate(resolve));
    const nodes = descendants(body); const search = nodes.find(node => node.id === 'picker-search'); assert.ok(search);
    const label = nodes.find(node => node.tag === 'label' && node.htmlFor === search.id); assert.ok(label);
    assert.equal(label.className, 'sr-only'); assert.equal(label.textContent, 'Search saved sessions');
    const heading = body.children.findIndex(node => node.textContent === 'Resume a saved session');
    assert.equal(body.children[heading + 1]?.textContent, 'Close this session in your terminal before opening it here.');
    const line = body.children[heading + 2]; assert.ok(line); assert.equal(line.className, 'palette-input');
    assert.equal(line.children[0]?.textContent, '›'); assert.equal(line.children[0]?.attributes['aria-hidden'], 'true');
    assert.equal(line.children[1], label); assert.equal(line.children[2], search);
    const coverage = nodes.find(node => node.id === 'picker-coverage'); assert.ok(coverage);
    assert.equal(coverage.className, 'secondary'); assert.equal(coverage.attributes['aria-live'], 'polite');
    assert.equal(coverage.textContent, status);
    assert.equal(body.children.filter(node => node.textContent.includes('Saved list ·')).length, 1);
    assert.ok(nodes.find(node => node.tag === 'button' && node.textContent === 'Refresh'));
    search.value = 'no match'; search.dispatch('input');
    assert.equal(coverage.textContent, name === 'complete' ? status : `0 matches in loaded sessions · ${status}`);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (oldElement) Object.defineProperty(globalThis, 'HTMLElement', oldElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }
});
function directPicker(t: TestContext, active?: PrimaryView) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const previousFetch = globalThis.fetch; const body = new Node('div');
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: Node});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {activeElement: null, createElement: (tag: string) => new Node(tag), createDocumentFragment: () => new Node('fragment')}});
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousElement) Object.defineProperty(globalThis, 'HTMLElement', previousElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  });
  const calls: {path: string; body?: unknown}[] = []; const selections: SelectionChange[] = []; const steps: string[] = [];
  const state = {primaries: active ? [active] : [], launchCwd: '/project'} as unknown as Bootstrap;
  let reloads = 0; let failure = false; let listFailure = false; let closed = false; let error = ''; let running = false;
  const modal = {
    node: {dataset: {} as Record<string, string>}, token: 0,
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
    let data: unknown = saved;
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
  return {picker, body, calls, state, selections, steps, click, fail: () => { failure = true; }, failList: () => { listFailure = true; }, get reloads() { return reloads; }, get closed() { return closed; }, get error() { return error; }};
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const active = {key: 'current', cwd: '/project', epoch: 1, lifecycle: 'ready'} as PrimaryView;
test('current project opens its session list and a saved row directly admits one open without attestation', async t => {
  const setup = directPicker(t, active); setup.picker.open(); await settle();
  assert.equal(setup.calls.some(call => call.path.includes('/api/projects')), false);
  assert.equal(descendants(setup.body).some(node => node.textContent === 'Continue'), false);
  assert.ok(descendants(setup.body).find(node => node.textContent === 'Close this session in your terminal before opening it here.'));
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
  assert.ok(descendants(setup.body).find(node => node.textContent === 'Projects…'));
  assert.equal(descendants(setup.body).some(node => node.textContent === 'Continue'), false);
  assert.equal(setup.reloads, 0); assert.equal(setup.state.primaries.length, 0);
});
test('an unavailable launch project leaves a truthful error and explicit Projects recovery without spawning', async t => {
  const setup = directPicker(t); setup.failList(); setup.picker.open(); await settle();
  assert.match(setup.error, /project directory does not exist/); assert.equal(setup.closed, false);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
  setup.click('Projects…'); assert.ok(descendants(setup.body).find(node => node.id === 'picker-project'));
  assert.ok(descendants(setup.body).find(node => node.textContent === 'Continue'));
});
test('without a primary or launch project the picker retains explicit project selection', async t => {
  const setup = directPicker(t); setup.state.launchCwd = undefined; setup.picker.open(); await settle();
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
  setup.click('Projects…'); assert.ok(descendants(setup.body).find(node => node.id === 'picker-project'));
  setup.click('Open saved session path…'); const path = descendants(setup.body).find(node => node.id === 'picker-session-path'); assert.ok(path);
  path.value = 'relative.jsonl'; setup.click('Resume saved session'); await settle();
  assert.match(setup.error, /absolute saved session path/); assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
  path.value = saved.items[0].path; setup.click('Resume saved session'); await settle();
  assert.equal(setup.selections[0]?.primaryKey, 'current'); assert.equal(setup.closed, true);
  assert.equal(setup.reloads, 1); assert.deepEqual(setup.steps, ['selection', 'reload']);
});
test('workspace session selection reloads after selection through the composer focus seam', async t => {
  const setup = directPicker(t, active); setup.picker.open(); await settle(); setup.click('Projects…');
  setup.click('Session · /project · ready'); await settle();
  assert.deepEqual(setup.selections, [{primaryKey: 'current', selectedTarget: null}]);
  assert.deepEqual(setup.steps, ['selection', 'reload']); assert.equal(setup.closed, true);
  assert.equal(setup.calls.some(call => call.path === '/api/primaries'), false);
});
test('an exact saved path outside the loaded list directly opens without confirmation', async t => {
  const setup = directPicker(t, active); setup.picker.open(); await settle(); setup.click('Open saved session path…');
  const path = descendants(setup.body).find(node => node.id === 'picker-session-path'); assert.ok(path); path.value = '/project/unlisted.jsonl';
  setup.click('Resume saved session'); await settle();
  assert.deepEqual(setup.calls.find(call => call.path === '/api/primaries')?.body, {cwd: '/project', sessionFile: '/project/unlisted.jsonl'});
  assert.equal(setup.reloads, 1); assert.equal(setup.closed, true);
});
test('project loading retains its list surface and autofocus exposes the start of long paths', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-01-01T00:00:00Z'));
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousFetch = globalThis.fetch;
  const body = new Node('div');
  let release: (response: Response) => void = () => { throw new Error('Request not started'); };
  const response = new Promise<Response>(resolve => { release = resolve; });
  globalThis.fetch = async () => (await response).clone();
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new Node(tag)}});
  const path = `/projects/${'long-project-'.repeat(24)}`;
  const modal = {node: {dataset: {} as Record<string, string>}, token: 0, open: () => { modal.token++; body.replaceChildren(); return body; }, owns: (token: number) => token === modal.token, actions: (...buttons: Node[]) => body.append(...buttons), error: (error: unknown) => { throw error; }};
  try {
    const picker = new ProjectPicker({modal: modal as unknown as Modal, snapshot: () => ({launchCwd: path, primaries: []}) as unknown as Bootstrap, primary: () => undefined, selection: async () => {}, reload: async () => {}});
    picker.open();
    const projects = descendants(body).find(node => node.textContent === 'Projects…'); assert.ok(projects); projects.click();
    const nodes = descendants(body); const field = nodes.find(node => node.id === 'picker-project');
    assert.ok(field); assert.equal(field.value, path); assert.equal(field.focused, true);
    assert.equal(field.selectionStart, 0); assert.equal(field.selectionEnd, 0); assert.equal(field.scrollLeft, 0);
    const list = nodes.find(node => node.className === 'options picker-projects'); assert.ok(list);
    assert.equal(list.children.length, 0);
    const page: RecentProjectPage = {items: [{path, name: 'Long project'}], total: 1, omitted: 0, nextCursor: null, observedAt: '2026-01-01T00:00:00Z'};
    release(new Response(JSON.stringify({ok: true, data: page}), {status: 200, headers: {'content-type': 'application/json'}}));
    await response; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(descendants(body).find(node => node.className === 'options picker-projects'), list);
    assert.equal(list.children.length, 1); assert.equal(list.children[0].textContent, 'Long project');
    assert.equal(list.children[0].title, path); assert.match(list.children[0].attributes['aria-label'], /Long project/);
    const status = descendants(body).find(node => node.className === 'secondary picker-project-status');
    assert.equal(status?.textContent, 'Saved list · now');
    const refresh = descendants(body).find(node => node.textContent === 'Refresh recent projects'); assert.ok(refresh);
    page.nextCursor = 'more'; page.total = 2; page.omitted = 1;
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true, data: page}), {status: 200, headers: {'content-type': 'application/json'}});
    refresh.click();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(status?.textContent, '1 of 2 projects shown · Saved list · now · 1 file or directory entries unexamined');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
