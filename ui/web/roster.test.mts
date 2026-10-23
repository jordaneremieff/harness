import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRow, CachedRoster } from '../shared/api.ts';
import { absoluteTime, relativeTime, timestampDetails } from './format.ts';
import { Roster as RosterView, activityLine, publishedRetryDescription, rosterPreview } from './roster.ts';
import {conversationPresentation, presentationGlyph} from './conversation-presentation.ts';

test('roster previews project Markdown words without losing literal punctuation', () => {
  assert.equal(rosterPreview('**October 18, 2026** with `const total = 2`'), 'October 18, 2026 with const total = 2');
  assert.equal(rosterPreview(String.raw`Keep \*literal\* and \_under\_ plus a_b.`), 'Keep *literal* and _under_ plus a_b.');
  assert.equal(rosterPreview('[A **label**](https://example.test/doc) and `a*b`'), 'A label and a*b');
  assert.equal(rosterPreview('| First | Second |\n| --- | --- |\n| Alpha | Beta |\n\n- One\n- Two'), 'First Second Alpha Beta One Two');
  const long = rosterPreview('**Text** '.repeat(10000)); assert.doesNotMatch(long, /\*\*/);
  assert.equal(rosterPreview(`${' '.repeat(4096)}Outside parser input`), ' Outside parser input');
});
test('published retry detail names its old source and never claims a current deadline', () => {
  const row: AgentRow = {identity: 'published', storageId: 'storage', cwd: '/project', modifiedAt: 0, state: 'working', owner: 'unknown', availability: 'stored', partial: false,
    observedAt: '2026-10-16T00:00:00Z', publishedRetry: {attempt: 2, maxAttempts: 5, delayMs: 60000, error: 'Opaque diagnostic'}};
  assert.match(publishedRetryDescription(row), /Published retry · attempt 2 of 5/); assert.match(publishedRetryDescription(row), /delay at publication 60000 ms/);
  assert.match(publishedRetryDescription(row), /published 2026-10-16T00:00:00Z/); assert.doesNotMatch(publishedRetryDescription(row), /next retry/i);
  assert.match(publishedRetryDescription({...row, observedAt: undefined}), /publication time unavailable/);
});
type RosterParameters = ConstructorParameters<typeof RosterView>;
class Roster extends RosterView {
  constructor(select: RosterParameters[0], more: RosterParameters[1], search?: RosterParameters[2], message?: RosterParameters[3], resolved?: RosterParameters[4]) {
    super(select, more, search, message, resolved ?? (row => ({glyph: row.availability !== 'live' ? '○' : ({working: '●', failed: '!', done: '✓'} as Record<string, string>)[row.state] ?? '○', label: row.availability !== 'live' ? row.availability : row.state === 'working' ? 'Working' : row.state, tool: row.state === 'working' ? row.currentTool : undefined})));
    (this as unknown as {expanded: boolean}).expanded = true;
  }
}
function rowsOf(node: FakeNode): FakeNode[] { return node.children.filter(child => child.dataset.identity); }
function required<T>(value: T | undefined): T { assert.notEqual(value, undefined); return value as T; }
class FakeNode {
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = '';
  hidden = false;
  disabled = false;
  tabIndex = 0;
  type = '';
  title = '';
  dateTime = '';
  value = '';
  scrollTop = 0;
  clientHeight = 300;
  moves = 0;
  rowHeight = 20;
  private text = '';
  private handlers = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  get nextSibling(): FakeNode | null { const peers = this.parentNode?.children ?? []; return peers[peers.indexOf(this) + 1] ?? null; }
  get offsetHeight(): number { return this.hidden ? 0 : this.style.height ? Number.parseFloat(this.style.height) : this.className === 'agent-row' ? this.rowHeight : 20; }
  append(...nodes: FakeNode[]): void { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); node.moves++; } }
  prepend(node: FakeNode): void { node.remove(); node.parentNode = this; this.children.unshift(node); node.moves++; }
  after(node: FakeNode): void {
    const parent = this.parentNode; if (!parent) return;
    node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); node.moves++;
  }
  remove(): void { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  replaceChildren(...nodes: FakeNode[]): void { for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...nodes); }
  contains(node: FakeNode | null): boolean { return !!node && (node === this || this.children.some(child => child.contains(node))); }
  classList = {add: (name: string) => {this.className = `${this.className} ${name}`.trim();}};
  querySelector(selector: string): FakeNode | null {try {return this.query(selector.slice(1));} catch {return null;}}
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(name: string, callback: (event: Record<string, unknown>) => void): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], callback]); }
  dispatch(name: string, event: Record<string, unknown> = {}): void { for (const callback of this.handlers.get(name) ?? []) callback(event); }
  focus(): void { (globalThis.document as unknown as {activeElement: FakeNode}).activeElement = this; }
  click(): void { if (!this.disabled && !this.hidden) this.dispatch('click'); }
  query(className: string): FakeNode {
    for (const child of this.children) { if (child.className.split(' ').includes(className)) return child; }
    for (const child of this.children) { try { return child.query(className); } catch {} }
    throw new Error(`Missing ${className}`);
  }
}
function setup(withRefresh = true, rowHeight = 20) {
  const ids = new Map(['roster', 'agent-search', 'agent-filter-box', 'roster-footer', ...(withRefresh ? ['agent-refresh'] : [])].map(id => [id, new FakeNode('div')]));
  const frames: Array<() => void> = [];
  const document = {activeElement: null as FakeNode | null, createElementNS: (_namespace: string, tag: string) => new FakeNode(tag), createElement: (tag: string) => {const node = new FakeNode(tag); node.rowHeight = rowHeight; return node;}, getElementById: (id: string) => ids.get(id)};
  Object.assign(globalThis, {document, requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; }});
  return {document, node: required(ids.get('roster')), search: required(ids.get('agent-search')), filterBox: required(ids.get('agent-filter-box')), footer: required(ids.get('roster-footer')), flush: () => { const pending = frames.splice(0); for (const callback of pending) callback(); }};
}
function row(identity: string, facts: Partial<AgentRow> = {}): AgentRow {
  return {identity, name: 'Agent', storageId: identity, cwd: '/project', modifiedAt: 0, state: 'working', availability: 'live', owner: 'here', partial: false, ...facts};
}

test('roster summaries keep only the first reply line and omit empty fields', () => {
  const f = setup();
  const roster = new RosterView(() => {}, () => {}, undefined, () => {}, source => ({label: source.state === 'working' ? 'Working' : 'Running', glyph: '?', tone: 'info', hideVisibleState: source.state !== 'working', tool: source.state === 'working' ? source.currentTool : undefined}));
  const name = 'A complete long conversation name '.repeat(12).trim();
  const source = row('two-lines', {name, role: '**First reply line**\nSecond reply line', currentTool: {name: 'read', argument: 'a.ts'}});
  roster.set([source]); f.flush();
  const node = required(rowsOf(f.node)[0]), select = node.query('row-select'), heading = node.query('row-heading'), summary = node.query('row-summary');
  assert.deepEqual(select.children, [heading, node.query('row-model'), summary]); assert.equal(node.query('row-model').hidden, true); assert.ok(heading.query('row-name').title.includes(name));
  assert.equal(summary.query('row-state').textContent, 'Working'); assert.equal(summary.query('row-state').className, 'row-state');
  assert.equal(summary.query('row-state').dataset.busy, 'true'); assert.equal(summary.query('row-preview').textContent, 'read · a.ts');
  assert.equal(summary.hidden, false); assert.equal(summary.query('row-separator').hidden, false);
  roster.set([{...source, state: 'idle', handle: 'lead'}]); f.flush();
  assert.equal(summary.query('row-preview').textContent, 'First reply line');
  assert.equal(summary.hidden, false); assert.equal(summary.query('row-state').hidden, true); assert.equal(summary.query('row-separator').hidden, true);
  roster.set([{...source, handle: 'lead', role: undefined, currentTool: undefined}]); f.flush();
  assert.equal(summary.hidden, false); assert.equal(summary.query('row-preview').hidden, true); assert.equal(summary.query('row-separator').hidden, true);
  roster.set([{...source, state: 'idle', handle: 'lead', role: ''}]); f.flush(); assert.equal(summary.hidden, true);
});
test('connected attention precedes Working and remaining catalog order without catalog failure inference',()=>{
  const f=setup(); let blocked=true;
  const roster=new RosterView(()=>{},()=>{},undefined,undefined,source=>({glyph:'?',label:source.identity==='working'?'Working':'Running',hideVisibleState:true,...(source.identity==='blocked'&&blocked?{attention:{label:'Blocked' as const,tone:'warning' as const}}:{})}));
  const rows=[row('catalog-failure',{state:'failed',error:'Not an attention contract'}),row('working'),row('catalog-idle',{state:'idle'}),row('blocked',{availability:'stored',state:'idle',latestReply:'Reply excerpt'})];
  roster.set(rows);f.flush();
  const ids=()=>rowsOf(f.node).filter(node=>node.dataset.identity).map(node=>node.dataset.identity);
  assert.deepEqual(ids(),['blocked','working']);
  const node=rowsOf(f.node)[0];assert.ok(node);assert.equal(node.query('row-summary').children[0]?.textContent,'Blocked');assert.equal(node.query('row-state').dataset.tone,'warning');assert.equal(node.query('row-state').hidden,false);
  blocked=false;roster.set(rows);f.flush();assert.deepEqual(ids(),['working']);
});
function expanded<T extends RosterView>(roster: T): T { (roster as unknown as {expanded: boolean}).expanded = true; return roster; }
function collapse(roster: RosterView): void { (roster as unknown as {expanded: boolean}).expanded = false; }
test('agent filter shows only in the catalog view, for a query, or on explicit focus', () => {
  const f = setup(), roster = new Roster(() => {}, () => {}), rows = Array.from({length: 9}, (_, i) => row(`filter-${i}`));
  collapse(roster);
  roster.set(rows); f.flush(); assert.equal(f.filterBox.hidden, true);
  f.search.value = 'filter'; roster.set(rows); f.flush(); assert.equal(f.filterBox.hidden, false);
  f.search.value = ''; f.search.dispatch('input'); assert.equal(f.filterBox.hidden, true);
  const focus = f.search.focus.bind(f.search); f.search.focus = () => {assert.equal(f.filterBox.hidden, false); focus();};
  roster.focusSearch(); assert.equal(f.document.activeElement, f.search); assert.equal(f.filterBox.hidden, false);
  roster.set(rows); f.flush(); assert.equal(f.filterBox.hidden, false);
  f.document.activeElement = null; f.search.dispatch('blur'); roster.schedule(); f.flush(); assert.equal(f.filterBox.hidden, true);
});
test('roster footer stays hidden and its facts move to the refresh control title', t => {
  t.mock.method(Date, 'now', () => 600000);
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  const meta = {...page([]), observedAt: new Date(Date.now()).toISOString()};
  const refresh = required(fixture.document.getElementById('agent-refresh'));
  roster.set([row('one')], meta); fixture.flush();
  assert.equal(fixture.footer.hidden, true); assert.equal(fixture.footer.textContent, '');
  assert.match(refresh.title, /^Refresh agents\n1 loaded\n/); assert.match(refresh.title, /Agent scan: ready; complete: true; skipped: 0/);
  roster.set([row('one')], {...meta, stale: true, observedAt: new Date(0).toISOString()}); fixture.flush();
  assert.equal(fixture.footer.hidden, true); assert.match(refresh.title, /Saved agent list · 10m ago/);
  for (const [scan, expected] of [[{state: 'running' as const}, /Agent scan: running/], [{state: 'failed' as const}, /Agent scan: failed/], [{skipped: 1}, /skipped: 1/]] as const) {
    roster.set([row('one')], {...page([]), scan: {...page([]).scan, ...scan}}); fixture.flush();
    assert.equal(fixture.footer.hidden, true); assert.equal(fixture.footer.textContent, ''); assert.match(refresh.title, expected);
  }
});
test('paging appears only in the catalog view, reuses its button and sits before the catalog control', () => {
  const f = setup(); const actions: Array<string | undefined> = []; const roster = new Roster(() => {}, action => actions.push(action)); collapse(roster);
  const rows = Array.from({length: 80}, (_, i) => row(`agent-${i}`, i < 30 ? {handle: `a${i}`} : {availability: 'stored', state: 'done'}));
  roster.set(rows, page(rows, 'next')); f.flush();
  assert.equal(rowsOf(f.node).length, 8);
  const older = f.node.query('roster-older'); assert.equal(older.textContent, 'All agents (80)'); assert.equal(f.node.children.at(-1), older);
  assert.equal(f.footer.hidden, true); assert.throws(() => f.node.query('roster-more'));
  older.click(); const more = f.node.query('roster-more'); assert.equal(rowsOf(f.node).length, 80);
  assert.equal(more.textContent, 'More agents'); assert.equal(more.type, 'button'); assert.equal(f.node.children.at(-2), more); assert.equal(f.node.children.at(-1), older);
  more.click(); assert.deepEqual(actions, ['more']);
  const nextRows = [...rows, row('extra', {availability: 'stored', state: 'done'})];
  roster.set(nextRows, page(nextRows, 'next-2')); f.flush(); assert.equal(f.node.query('roster-more'), more); assert.equal(older.textContent, 'All agents (81)');
  roster.set(nextRows, {...page(nextRows), scan: {...page([]).scan, complete: false, scanId: 'scan'}}); f.flush();
  assert.equal(f.node.query('roster-more'), more); assert.equal(more.textContent, 'Load more agents'); more.click();
  assert.equal(f.footer.hidden, true); assert.deepEqual(actions, ['more', 'more']);
  roster.set(nextRows, page(nextRows)); f.flush(); assert.equal(more.parentNode, null);
});
test('catalog paging works with and without loaded rows and scan continuation requires an id', () => {
  const f = setup(); const actions: Array<string | undefined> = []; const roster = new Roster(() => {}, action => actions.push(action));
  for (const rows of [[], [row('one')]]) {
    roster.set(rows, page(rows, 'next')); f.flush();
    assert.equal(f.node.query('roster-older').textContent, rows.length ? `All agents (${rows.length})` : 'New agent'); assert.equal(f.footer.hidden, true);
    const more = f.node.query('roster-more'); assert.equal(more.textContent, 'More agents'); assert.equal(f.node.children.at(-2), more); more.click();
    roster.set(rows, {...page(rows), scan: {...page([]).scan, complete: false, scanId: 'scan'}}); f.flush();
    assert.equal(f.node.query('roster-more'), more); assert.equal(more.textContent, 'Load more agents'); more.click();
    roster.set(rows, {...page(rows), scan: {...page([]).scan, complete: false}}); f.flush(); assert.equal(more.parentNode, null);
    assert.equal(f.footer.hidden, true);
  }
  assert.deepEqual(actions, ['more', 'more', 'more', 'more']);
});
test('working roster rows keep timestamps separate from accessible current tool details', t => {
  t.mock.method(Date, 'now', () => 600000);
  const f = setup(); const roster = new Roster(() => {}, () => {});
  const currentTool = {name: 'bash', argument: 'npm run check'};
  roster.set([row('one', {state: 'working', currentTool, modifiedAt: 599000})]); f.flush();
  const node = required(rowsOf(f.node)[0]); const age = node.query('row-age'); const select = node.query('row-select');
  assert.equal(node.dataset.tool, 'true'); assert.equal(age.textContent, ''); assert.equal(age.hidden, true); assert.equal(age.disabled, true);
  assert.match(select.title, /bash · npm run check/);
  assert.match(select.attributes['aria-description'] ?? '', /bash · npm run check/);
  const height = node.offsetHeight;
  roster.set([row('one', {state: 'idle', modifiedAt: 599000, handle: 'lead'})]); f.flush();
  assert.equal(node.dataset.tool, 'false'); assert.equal(age.textContent, 'now'); assert.equal(age.disabled, false); assert.equal(node.offsetHeight, height);
  assert.match(age.title, /1970-01-01T00:09:59.000Z/); assert.equal(age.attributes['aria-description'], timestampDetails(599000).display);
  assert.equal(age.query('timestamp').dateTime, new Date(599000).toISOString());
  roster.set([row('one', {state: 'working'})]); f.flush(); assert.notEqual(age.textContent, 'bash');
});
test('roster has sibling native actions and plain retained, idle and working status', t => {
  const modifiedAt = Date.UTC(2026, 9, 8, 12);
  t.mock.method(Date, 'now', () => modifiedAt + 600000);
  const fixture = setup(); const selected: string[] = [];
  const roster = new Roster(value => selected.push(value.identity), () => {});
  roster.set([row('stored', {availability: 'stored', modifiedAt}), row('idle', {state: 'idle'}), row('working')], undefined, undefined, 'idle'); fixture.flush();
  const byIdentity = (id: string) => rowsOf(fixture.node).find(node => node.dataset.identity === id); const stored = byIdentity('stored'), idle = byIdentity('idle'), working = byIdentity('working'); assert.ok(stored); assert.ok(idle); assert.ok(working);
  assert.equal(stored.query('row-state').textContent, '');
  assert.equal(idle.query('row-state').textContent, ''); assert.equal(working.query('row-state').textContent, 'Working');
  assert.equal(stored.query('row-state').attributes['aria-hidden'], 'true');
  assert.equal(stored.query('row-state').dataset.tone, 'secondary');
  assert.equal(stored.query('row-name').textContent, 'Agent');
  const select = stored.query('row-select'); const age = stored.query('row-age');
  assert.equal(stored.tagName, 'div'); assert.equal(stored.attributes.role, 'listitem');
  assert.equal(select.tagName, 'button'); assert.equal(age.tagName, 'button');
  assert.equal(select.type, 'button'); assert.equal(age.type, 'button');
  assert.equal(select.parentNode, stored); assert.equal(age.parentNode, stored); assert.equal(select.contains(age), false);
  assert.match(select.attributes['aria-label'] ?? '', /stored/);
  assert.equal(idle.attributes['aria-current'], undefined); assert.equal(idle.query('row-select').attributes['aria-current'], 'page');
  assert.equal(stored.query('row-select').attributes['aria-current'], 'false');
  assert.equal(select.children.length, 3); assert.equal(select.children[1]?.className, 'row-model'); assert.equal(select.children[1]?.hidden, true);
  assert.deepEqual(select.children[0]?.children.map(child => child.className), ['row-name', 'row-identity muted']);
  assert.deepEqual(select.children[2]?.children.map(child => child.className), ['row-state', 'row-separator', 'row-preview']);
  assert.equal(stored.dataset.live, 'false'); assert.equal(idle.dataset.live, 'true'); assert.equal(working.dataset.live, 'true');
  for (const removed of ['row-word', 'row-detail', 'row-activity']) assert.throws(() => stored.query(removed));
  assert.equal(idle.query('row-select').title, 'idle'); assert.equal(working.query('row-select').title, 'Working');
  assert.equal(select.title, 'stored'); assert.equal(select.attributes['aria-description'], select.title);
  assert.equal(age.tabIndex, -1); assert.equal(age.query('timestamp').textContent, '10m');
  assert.equal(age.query('timestamp').dateTime, new Date(modifiedAt).toISOString());
  assert.equal(age.attributes['aria-description'], timestampDetails(modifiedAt).display); assert.match(age.title, /2026-10-08T12:00:00.000Z/);
  assert.equal(age.dataset.absolute, 'false');
  age.click(); assert.deepEqual(selected, []); assert.doesNotMatch(age.textContent, /ago/); assert.equal(age.dataset.absolute, 'true');
  age.click(); assert.equal(age.textContent, '10m'); assert.deepEqual(selected, []); assert.equal(age.dataset.absolute, 'false');
  select.click(); assert.deepEqual(selected, ['stored']);
});
test('liveness attributes and status update on the same keyed row', () => {
  const f = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('one')]); f.flush(); const wrapper = required(rowsOf(f.node)[0]); assert.equal(wrapper.dataset.live, 'true');
  for (const availability of ['stored', 'unavailable', 'incompatible'] as const) {
    roster.set([row('one', {availability})]); f.flush();
    assert.equal(rowsOf(f.node)[0], wrapper); assert.equal(wrapper.dataset.live, 'false');
    assert.equal(wrapper.query('row-state').textContent, ''); assert.equal(wrapper.query('row-state').dataset.tone, 'secondary');
    assert.match(wrapper.query('row-select').title, new RegExp(availability));
    assert.match(wrapper.query('row-select').attributes['aria-label'] ?? '', new RegExp(availability)); assert.throws(() => wrapper.query('row-word'));
  }
  roster.set([row('one')]); f.flush(); assert.equal(rowsOf(f.node)[0], wrapper); assert.equal(wrapper.dataset.live, 'true');
});
test('row ages are compact while exact metadata, relative labels and absolute toggles stay complete', t => {
  const now = new Date(2026, 9, 8, 12).getTime(); t.mock.method(Date, 'now', () => now);
  const f = setup(); const roster = new Roster(() => {}, () => {});
  const cases = [
    {value: now, text: 'now'},
    {value: now - 60000, text: 'now'},
    {value: now - 61000, text: '1m'},
    {value: now - 12 * 60000, text: '12m'},
    {value: now - 3600000, text: '1h'},
    {value: now - 3 * 3600000, text: '3h'},
    {value: now - 86400000, text: '1d'},
    {value: now - 5 * 86400000, text: '5d'},
    {value: now - 29 * 86400000, text: '29d'},
    {value: now - 30 * 86400000, text: '8 Sept'},
    {value: new Date(2026, 8, 2, 12).getTime(), text: '2 Sept'},
    {value: now + 60000, text: 'now'},
    {value: now + 120000, text: '8 Oct'},
  ];
  for (const {value, text} of cases) {
    roster.set([row('one', {modifiedAt: value, state: 'idle'})]); f.flush();
    const age = required(rowsOf(f.node)[0]).query('row-age'); const details = timestampDetails(value);
    assert.equal(age.textContent, text); assert.equal(age.dataset.absolute, 'false');
    assert.equal(age.query('timestamp').dateTime, details.exact);
    assert.equal(age.title, `${details.exact} · ${details.display}`);
    assert.equal(age.attributes['aria-description'], details.display);
    assert.equal(age.attributes['aria-label'], `Timestamp for Agent · ${relativeTime(value, now)}`);
    age.click(); assert.equal(age.textContent, absoluteTime(value)); assert.equal(age.dataset.absolute, 'true');
    assert.equal(age.attributes['aria-label'], `Timestamp for Agent · ${absoluteTime(value)}`);
    assert.equal(age.title, `${details.exact} · ${details.display}`); assert.equal(age.attributes['aria-description'], details.display);
    age.click(); assert.equal(age.textContent, text); assert.equal(age.attributes['aria-label'], `Timestamp for Agent · ${relativeTime(value, now)}`);
  }
});
test('roster model line follows the name before activity and retains tooltip and search facts', () => {
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('one', {model: {provider: 'vendor', modelId: 'model-x', thinkingLevel: 'high'}, currentTool: {name: 'read', argument: 'a.ts'}})]); fixture.flush();
  const select = required(rowsOf(fixture.node)[0]).query('row-select');
  assert.equal(select.title, 'vendor/model-x · high\nWorking\nread · a.ts'); assert.equal(select.attributes['aria-description'], `${select.title}\nPreview: read · a.ts`);
  assert.deepEqual(select.children.map(child => child.className), ['row-heading', 'row-model', 'row-summary']);
  assert.equal(select.query('row-model').textContent, 'vendor/model-x · high'); assert.equal(select.query('row-model').hidden, false);
  assert.equal(select.query('row-preview').textContent, 'read · a.ts');
  fixture.search.value = 'vendor/'; fixture.search.dispatch('input'); fixture.flush();
  assert.equal(rowsOf(fixture.node).filter(child => child.className === 'agent-row').length, 1);
});
test('model updates omit absent facts and preserve keyed actions, focus and row measurement', () => {
  const f = setup(), selected: AgentRow[] = [], messages: string[] = [];
  const roster = new Roster(source => selected.push(source), () => {}, undefined, identity => messages.push(identity));
  const source = row('model', {state: 'idle', role: 'Review changes', modifiedAt: 1});
  roster.set([source]); f.flush();
  const node = required(rowsOf(f.node)[0]), select = node.query('row-select'), model = node.query('row-model'), age = node.query('row-age'), message = node.query('row-message');
  select.focus(); const measurements: number[] = [];
  Object.defineProperty(node, 'offsetHeight', {get() {const height = model.hidden ? 48 : 84; measurements.push(height); return height;}});
  const changed = {...source, model: {provider: 'vendor', modelId: 'long-model-name', thinkingLevel: 'high'}, thinkingLevel: 'low'};
  roster.set([changed]); f.flush();
  assert.equal(model.textContent, 'vendor/long-model-name · high'); assert.equal(model.hidden, false); assert.ok(measurements.includes(84));
  assert.equal(node.query('row-preview').textContent, 'Review changes'); assert.equal(f.document.activeElement, select);
  assert.equal(rowsOf(f.node)[0], node); assert.equal(node.query('row-age'), age); assert.equal(node.query('row-message'), message);
  select.click(); message.click(); assert.equal(selected[0], changed); assert.deepEqual(messages, ['model']);
  roster.set([{...changed, model: {provider: 'vendor', modelId: 'model-y'}}]); f.flush(); assert.equal(model.textContent, 'vendor/model-y · low');
  roster.set([{...source, model: {provider: 'vendor', modelId: 'model-y'}}]); f.flush(); assert.equal(model.textContent, 'vendor/model-y');
  roster.set([{...source, thinkingLevel: 'high'}]); f.flush();
  assert.equal(model.textContent, ''); assert.equal(model.hidden, true); assert.ok(measurements.includes(48));
  assert.equal(node.query('row-model'), model); assert.equal(f.document.activeElement, select); assert.doesNotMatch(select.textContent, /unknown|unavailable|high/);
});
test('activity line never repeats the status and keeps distinct details', () => {
  const live = {identity: 's:2', storageId: 's', cwd: '/p', modifiedAt: 0, state: 'working', owner: 'here', availability: 'live', partial: false} as AgentRow;
  assert.equal(activityLine(live, 'working'), 'working');
  assert.equal(activityLine({...live, latestReply: 'Reviewing the diff'}, 'working'), 'working · Reviewing the diff');
  assert.equal(activityLine({...live, currentTool: {name: 'read', argument: 'a.ts'}}, 'working'), 'working · read · a.ts');
  assert.equal(activityLine({...live, latestReply: 'working'}, 'working'), 'working');
  assert.equal(activityLine({...live, availability: 'stored'} as AgentRow, 'stored'), 'stored');
});
test('duplicate loaded names keep names first with distinct session qualifiers', () => {
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('storage:one'), row('storage:two'), row('unique', {name: 'Only'})]); fixture.flush();
  const [one, two, unique] = rowsOf(fixture.node); assert.ok(one); assert.ok(two); assert.ok(unique);
  assert.equal(one.query('row-heading').query('row-identity').textContent, '1');
  assert.equal(two.query('row-heading').query('row-identity').textContent, '2');
  assert.equal(unique.query('row-identity').hidden, true);
  fixture.search.value = 'storage:one'; fixture.search.dispatch('input'); fixture.flush();
  assert.equal(one.query('row-identity').hidden, false);
  fixture.search.value = ''; roster.set([row('storage:one')]); fixture.flush();
  assert.equal(one.query('row-identity').hidden, true); assert.equal(one.query('row-identity').textContent,'');
  roster.set([row('first:shared'), row('second:shared')]); fixture.flush();
  assert.equal(rowsOf(fixture.node)[0]?.query('row-identity').textContent, '3');
  assert.equal(rowsOf(fixture.node)[1]?.query('row-identity').textContent, '4');
  assert.equal(rowsOf(fixture.node)[0]?.query('row-identity').title, 'Agent ID: first:shared');
  assert.equal(rowsOf(fixture.node)[1]?.query('row-identity').title, 'Agent ID: second:shared');
});
test('shared-prefix duplicates use unique display ordinals and retain full identity metadata', () => {
  const f = setup(); const roster = new Roster(() => {}, () => {});
  let ordinal = 1;
  for (const {identities} of [
    {identities: ['00000000-0000-abcd', '00000000-0000-wxyz']},
    {identities: ['00000000-a1234', '00000000-b1234']},
    {identities: ['00000000-a1234567', '00000000-b1234567']},
    {identities: ['00000000-abcd', 'storage:abcd']},
    {identities: ['00000000-storage:conversation-one', '00000000-storage:conversation-two']},
  ]) {
    roster.set(identities.map(identity => row(identity))); f.flush();
    assert.deepEqual(rowsOf(f.node).map(child => child.query('row-identity').textContent), [String(ordinal++), String(ordinal++)]);
    for (const [index, child] of rowsOf(f.node).entries()) {
      const identity = required(identities[index]);
      assert.equal(child.query('row-identity').title, `Agent ID: ${identity}`); assert.ok(child.title.includes(identity));
      assert.equal(child.query('row-identity').attributes['aria-label'], `Agent ID: ${identity}`);
      assert.ok(child.query('row-select').attributes['aria-label']?.includes(identity));
    }
  }
});
test('display ordinal uniqueness uses all loaded duplicates and survives search', () => {
  const f = setup(); const roster = new Roster(() => {}, () => {});
  const rows = [row('00000000-a1234'), row('00000000-b1234'), row('other-a1234', {name: 'Only'})];
  roster.set(rows); f.flush(); const first = required(rowsOf(f.node)[0]); const select = first.query('row-select');
  assert.equal(first.query('row-identity').textContent, '1'); assert.equal(rowsOf(f.node)[2]?.query('row-identity').hidden, true);
  f.search.value = '00000000-a1234'; f.search.dispatch('input'); f.flush();
  assert.equal(rowsOf(f.node)[0], first); assert.equal(first.query('row-identity').textContent, '1'); assert.equal(first.query('row-select'), select);
  f.search.value = ''; const collision = ['first-12345678', 'second-12345678'];
  roster.set(collision.map(identity => row(identity))); f.flush();
  assert.deepEqual(rowsOf(f.node).map(child => child.query('row-identity').textContent), ['3','4']);
});
test('identity-shaped names become honest captions without changing routing or search',()=> {
  const f=setup(),selected:string[]=[],ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
  const roster=new Roster(value=>selected.push(value.identity),()=>{},undefined,undefined,()=>({glyph:'?',label:'Unknown',tone:'warning'}));
  const rows=ids.map(identity=>row(identity,{name:identity}));roster.set(rows);f.flush();
  assert.deepEqual(rowsOf(f.node).map(child=>child.query('row-name').textContent),['Unnamed conversation','Unnamed conversation']);assert.deepEqual(rowsOf(f.node).map(child=>child.query('row-identity').textContent),['1','2']);
  for(const child of rowsOf(f.node))assert.equal(child.query('row-state').dataset.tone,'warning');
  f.search.value=ids[0]??'';f.search.dispatch('input');f.flush();assert.equal(rowsOf(f.node)[0]?.query('row-identity').textContent,'1');rowsOf(f.node)[0]?.query('row-select').click();assert.deepEqual(selected,[ids[0]]);
  f.search.value='';roster.set([...rows].reverse());f.flush();assert.equal(rowsOf(f.node).find(child=>child.dataset.identity===ids[0])?.query('row-identity').textContent,'1');
});
test('empty roster discovery failure keeps the reason in the refresh title and offers a new agent', () => {
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([], {stale: true, scan: {state: 'failed', complete: false, visited: 0, skipped: 0, omitted: 0}, error: {code: 'unavailable', message: 'Catalog could not be read', retry: 'read'}}); fixture.flush();
  assert.deepEqual(rowsOf(fixture.node), []); assert.equal(fixture.node.query('roster-older').textContent, 'New agent');
  assert.equal(fixture.footer.hidden, true); assert.equal(fixture.footer.textContent, '');
  const refresh = required(fixture.document.getElementById('agent-refresh'));
  assert.match(refresh.title, /Catalog could not be read/); assert.match(refresh.title, /Agent scan: failed/);
});
test('keyed wrappers, actions, order and focused timestamps survive roster updates', t => {
  const modifiedAt = Date.UTC(2026, 9, 8, 12);
  let clock = modifiedAt + 600000; t.mock.method(Date, 'now', () => clock);
  const fixture = setup(); const selected: AgentRow[] = []; const roster = new Roster(value => selected.push(value), () => {});
  const one = row('one', {modifiedAt, state: 'idle'}); const two = row('two', {state: 'idle'}); roster.set([one, two]); fixture.flush();
  const wrapper = required(rowsOf(fixture.node)[0]); const select = wrapper.query('row-select'); const age = wrapper.query('row-age'); const moves = wrapper.moves;
  fixture.document.activeElement = age; clock = modifiedAt + 900000;
  roster.set([two, one], undefined, 'two'); fixture.flush();
  assert.equal(rowsOf(fixture.node)[0], wrapper); assert.equal(wrapper.moves, moves);
  assert.equal(wrapper.query('row-select'), select); assert.equal(wrapper.query('row-age'), age);
  assert.equal(fixture.document.activeElement, age); assert.equal(age.textContent, '10m');
  const changed = {...one, latestReply: 'New answer'}; roster.set([changed, two]); fixture.flush();
  assert.equal(age.textContent, '15m'); select.click(); assert.equal(selected[0], changed);
  age.click(); const absolute = age.textContent;
  roster.set([changed, {...two, latestReply: 'Another answer'}]); fixture.flush(); assert.equal(age.textContent, absolute);
  age.click(); assert.equal(age.textContent, '15m');
});
test('absent and invalid activity times clear metadata and recover without node replacement', t => {
  const now = new Date(2026, 9, 8, 12).getTime(); t.mock.method(Date, 'now', () => now);
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  const modifiedAt = now - 600000;
  roster.set([row('one', {modifiedAt, state: 'idle'})]); fixture.flush();
  const wrapper = required(rowsOf(fixture.node)[0]); const age = wrapper.query('row-age');
  assert.equal(age.hidden, false); assert.equal(age.textContent, '10m');
  for (const value of [0, Number.NaN, Infinity, 8.64e15 + 1]) {
    roster.set([row('one', {modifiedAt: value, state: 'idle'})]); fixture.flush();
    assert.equal(age.hidden, true); assert.equal(age.disabled, true); assert.equal(age.tabIndex, -1); assert.equal(age.textContent, '');
    assert.equal(age.query('timestamp').dateTime, ''); assert.equal(age.title, ''); assert.equal(age.attributes['aria-description'], '');
    assert.equal(age.attributes['aria-label'], ''); assert.equal(wrapper.query('row-select').disabled, false);
  }
  roster.set([row('one', {modifiedAt, state: 'idle'})]); fixture.flush();
  assert.equal(rowsOf(fixture.node)[0], wrapper); assert.equal(wrapper.query('row-age'), age);
  assert.equal(age.hidden, false); assert.equal(age.disabled, false); assert.equal(age.tabIndex, -1);
  assert.equal(age.textContent, '10m'); assert.equal(age.query('timestamp').dateTime, new Date(modifiedAt).toISOString());
  assert.equal(age.attributes['aria-label'], `Timestamp for Agent · ${relativeTime(modifiedAt, now)}`);
  age.click(); assert.equal(age.textContent, absoluteTime(modifiedAt));
  age.click(); assert.equal(age.textContent, '10m');
});
function page(rows: AgentRow[], nextCursor: string | null = null): CachedRoster {
  return {rows, nextCursor, stale: false, scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}};
}
function searchFixture() {
  const fixture = setup(); const actions: Array<string | undefined> = []; const merged: CachedRoster[] = [];
  const loads: Array<{cursor: string; signal: AbortSignal; pending: ReturnType<typeof Promise.withResolvers<CachedRoster>>}> = [];
  let rows = Array.from({length: 20}, (_, i) => row(`initial-${i}`));
  const roster = new Roster(() => {}, action => actions.push(action), {
    load: (cursor, signal) => { const pending = Promise.withResolvers<CachedRoster>(); loads.push({cursor, signal, pending}); return pending.promise; },
    merge: value => { merged.push(value); rows = [...rows, ...value.rows]; roster.set(rows, value); },
  });
  roster.set(rows, page(rows, 'page-1')); fixture.flush();
  return {...fixture, loads, merged, actions, roster, query: (value: string) => { fixture.search.value = value; fixture.search.dispatch('input'); }};
}
test('cached search reaches a match beyond the first loaded page without discovery', async () => {
  const fixture = searchFixture(); fixture.query('needle');
  assert.match(fixture.roster.diagnostics(), /Searching agents/); assert.equal(fixture.footer.hidden, true);
  required(fixture.loads[0]).pending.resolve(page([row('other')], 'page-2')); await required(fixture.loads[0]).pending.promise;
  assert.equal(required(fixture.loads[1]).cursor, 'page-2'); assert.match(fixture.roster.diagnostics(), /Searching agents/);
  required(fixture.loads[1]).pending.resolve(page([row('needle', {name: 'Needle'})])); await required(fixture.loads[1]).pending.promise; await Promise.resolve(); fixture.flush();
  assert.equal(fixture.loads.length, 2); assert.match(fixture.node.textContent, /Needle/);
  assert.doesNotMatch(fixture.roster.diagnostics(), /Searching/); assert.equal(fixture.footer.hidden, true); assert.deepEqual(fixture.actions, []);
});
test('obsolete cached searches abort and never merge late responses', async () => {
  const fixture = searchFixture(); fixture.query('old'); const old = required(fixture.loads[0]);
  fixture.query('new'); assert.equal(old.signal.aborted, true); const current = required(fixture.loads[1]);
  old.pending.resolve(page([row('old')], 'old-next')); await old.pending.promise;
  assert.equal(fixture.merged.length, 0); assert.equal(fixture.loads.length, 2);
  assert.match(fixture.roster.diagnostics(), /Searching agents/);
  fixture.query(''); assert.equal(current.signal.aborted, true);
  current.pending.resolve(page([row('new')])); await current.pending.promise;
  assert.equal(fixture.merged.length, 0); assert.doesNotMatch(fixture.roster.diagnostics(), /Searching/);
  await Promise.resolve(); fixture.flush(); fixture.node.query('roster-more').click(); assert.deepEqual(fixture.actions, ['more']);
});
test('cached search has a twenty-page bound and explicit continuation to cache end', async () => {
  const fixture = searchFixture(); fixture.query('missing');
  for (let i = 0; i < 20; i++) { required(fixture.loads[i]).pending.resolve(page([], `page-${i + 2}`)); await required(fixture.loads[i]).pending.promise; }
  await Promise.resolve(); assert.equal(fixture.loads.length, 20); assert.match(fixture.roster.diagnostics(), /The agent list is incomplete/);
  fixture.roster.set(Array.from({length: 20}, (_, i) => row(`initial-${i}`)), page([], 'page-21')); assert.equal(fixture.loads.length, 20);
  fixture.node.query('roster-more').click(); assert.equal(required(fixture.loads[20]).cursor, 'page-21');
  required(fixture.loads[20]).pending.resolve(page([])); await required(fixture.loads[20]).pending.promise; await Promise.resolve();
  assert.match(fixture.roster.diagnostics(), /No more agents/); assert.deepEqual(fixture.actions, []);
  fixture.flush(); assert.throws(() => fixture.node.query('roster-more'));
});
test('cached search errors keep manual retry and do not restart on paint', async () => {
  const fixture = searchFixture(); fixture.query('missing'); const failed = required(fixture.loads[0]);
  failed.pending.reject(new Error('Cache unavailable')); await assert.rejects(failed.pending.promise); fixture.flush();
  assert.match(fixture.roster.diagnostics(), /Agents could not be searched\.\nCache unavailable/); assert.equal(fixture.loads.length, 1);
  fixture.node.query('roster-more').click(); const retry = required(fixture.loads[1]);
  retry.pending.resolve(page([], 'page-1')); await retry.pending.promise; await Promise.resolve();
  assert.match(fixture.roster.diagnostics(), /Repeated cached page cursor/); assert.equal(fixture.loads.length, 2);
  assert.deepEqual(fixture.actions, []);
});
test('loaded matches do not fetch cached pages and expose manual continuation', () => {
  const fixture = searchFixture(); fixture.query(' initial-3 '); assert.equal(fixture.loads.length, 0); assert.equal(rowsOf(fixture.node)[0]?.dataset.identity, 'initial-3');
  assert.equal(fixture.footer.hidden, true); const more = fixture.node.query('roster-more'); assert.equal(more.textContent, 'More agents'); more.click();
  assert.equal(fixture.loads.length, 1); assert.equal(fixture.loads[0]?.cursor, 'page-1'); fixture.flush(); assert.equal(more.parentNode, null);
});
test('focused timestamp pins its wrapper outside the virtual roster window', t => {
  t.mock.method(Date, 'now', () => 600000);
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  const rows = Array.from({length: 220}, (_, index) => row(`r${index}`, {modifiedAt: 1})); roster.set(rows); fixture.flush();
  const wrapper = required(rowsOf(fixture.node).find(child => child.dataset.identity === 'r0'));
  const age = wrapper.query('row-age'); fixture.document.activeElement = age;
  fixture.node.scrollTop = 18000; fixture.node.dispatch('scroll'); fixture.flush();
  assert.equal(wrapper.parentNode, fixture.node); assert.equal(fixture.document.activeElement, age);
  assert.ok(rowsOf(fixture.node).filter(child => child.className === 'agent-row').length <= 77);
  roster.set(rows.slice(1)); fixture.flush(); assert.equal(wrapper.parentNode, null);
});

test('default scope lists attention, working and named rows ahead of the catalog control', t => {
  const now = 3 * 86400000; t.mock.method(Date, 'now', () => now);
  const f = setup(); const roster = new Roster(() => {}, () => {}); collapse(roster);
  const catalog = (identity: string, facts: Partial<AgentRow> = {}) => row(identity, {availability: 'stored', state: 'done', ...facts});
  const rows = [catalog('old', {modifiedAt: now - 3}), catalog('plain', {availability: 'live', state: 'idle', modifiedAt: now - 2}), catalog('lead', {handle: 'lead', modifiedAt: now - 5}), catalog('working', {availability: 'live', state: 'working', modifiedAt: now - 10})];
  const ids = () => rowsOf(f.node).map(child => child.dataset.identity);
  roster.set(rows, page(rows)); f.flush();
  assert.deepEqual(ids(), ['working', 'lead']);
  const older = f.node.query('roster-older'); assert.equal(older.textContent, 'All agents (4)'); assert.equal(older.type, 'button'); assert.equal(older.attributes['aria-expanded'], 'false'); assert.equal(f.node.children.at(-1), older);
  older.click(); assert.deepEqual(ids(), ['working', 'lead', 'plain', 'old']); assert.equal(older.attributes['aria-expanded'], 'true');
  roster.set([...rows].reverse(), page(rows)); f.flush(); assert.deepEqual(ids(), ['working', 'lead', 'plain', 'old']);
  f.search.value = 'old'; f.search.dispatch('input'); f.flush(); assert.deepEqual(ids(), ['old']); assert.equal(f.node.query('roster-older'), older);
});
test('the collapsed list keeps a keyboard-focused row within its eight rows', t => {
  const now = 3 * 86400000; t.mock.method(Date, 'now', () => now);
  const f = setup(); const roster = new Roster(() => {}, () => {}); collapse(roster);
  const rows = Array.from({length: 10}, (_, i) => row(`r${i}`, {handle: `h${i}`, availability: 'stored', state: 'done', modifiedAt: now - i}));
  const ids = () => rowsOf(f.node).map(child => child.dataset.identity);
  roster.set(rows); f.flush(); assert.deepEqual(ids(), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
  const age = required(rowsOf(f.node)[3]).query('row-age'); age.focus();
  roster.set(rows.map(source => source.identity === 'r3' ? {...source, modifiedAt: 1} : source)); f.flush();
  assert.deepEqual(ids(), ['r0', 'r1', 'r2', 'r4', 'r5', 'r6', 'r7', 'r3']); assert.equal(f.document.activeElement, age);
  roster.set(rows.map(source => source.identity === 'r3' ? {...source, modifiedAt: 1} : source), undefined, undefined, 'r4'); f.flush();
  assert.equal(required(rowsOf(f.node).find(child => child.dataset.identity === 'r4')).query('row-select').attributes['aria-current'], 'page');
});
test('printable roster keys focus the visible filter, search the catalog, and Escape returns to the roster', t => {
  t.mock.method(Date, 'now', () => 3 * 86400000);
  const f = setup(); const roster = new Roster(() => {}, () => {}); collapse(roster);
  roster.set([row('live', {name: 'Live', handle: 'lead'}), row('older', {name: 'Needle', availability: 'stored', state: 'done'})], page([])); f.flush();
  assert.equal(f.filterBox.hidden, true);
  const select = required(rowsOf(f.node)[0]).query('row-select'); select.focus();
  let prevented = 0; const key = (value: string, extra: Record<string, unknown> = {}) => f.node.dispatch('keydown', {key: value, preventDefault: () => { prevented++; }, ...extra});
  for (const extra of [{ctrlKey: true}, {metaKey: true}, {altKey: true}, {isComposing: true}, {defaultPrevented: true}]) key('n', extra);
  key('ArrowDown'); assert.equal(f.filterBox.hidden, true); assert.equal(prevented, 0);
  key('n'); assert.equal(prevented, 1); assert.equal(f.filterBox.hidden, false); assert.equal(f.search.value, 'n'); assert.equal(f.document.activeElement, f.search);
  assert.equal(rowsOf(f.node)[0]?.dataset.identity, 'older'); assert.equal(f.node.query('roster-older').textContent, 'All agents (2)');
  let stopped = false; f.search.dispatch('keydown', {key: 'Escape', preventDefault: () => { prevented++; }, stopPropagation: () => { stopped = true; }}); f.flush();
  assert.equal(stopped, true); assert.equal(f.search.value, ''); assert.equal(f.filterBox.hidden, true); assert.equal(f.document.activeElement, f.node);
  f.search.value = 'Li'; f.search.dispatch('input'); select.focus(); key('v');
  assert.equal(f.search.value, 'Liv'); assert.equal(f.document.activeElement, f.search); assert.equal(rowsOf(f.node)[0]?.dataset.identity, 'live');
  f.search.value = ''; f.search.dispatch('input'); assert.equal(f.filterBox.hidden, false);
  f.document.activeElement = null; f.search.dispatch('blur'); roster.schedule(); f.flush(); assert.equal(f.filterBox.hidden, true);
  f.node.focus(); key('x'); roster.set([], page([])); f.flush();
  f.search.dispatch('keydown', {key: 'Escape', preventDefault: () => {}, stopPropagation: () => {}}); assert.equal(f.document.activeElement, f.node);
});
test('quiet filter Escape clears the query, keeps the catalog open and never changes filter visibility', t => {
  const now = 3 * 86400000; t.mock.method(Date, 'now', () => now);
  const f = setup();
  Object.defineProperty(f.search, 'hidden', {get: () => false, set: () => { throw new Error('Roster must not change filter visibility'); }});
  const roster = new Roster(() => {}, () => {}); collapse(roster);
  roster.set([row('old', {name: 'Old', availability: 'stored', state: 'done'}), row('live', {name: 'Live', availability: 'live', state: 'working'})], page([])); f.flush();
  assert.equal(rowsOf(f.node).length, 1);
  f.node.query('roster-older').click(); const old = required(rowsOf(f.node).find(child => child.dataset.identity === 'old')); old.query('row-select').focus();
  f.node.dispatch('keydown', {key: 'x', preventDefault: () => {}}); assert.equal(old.parentNode, null);
  f.search.dispatch('keydown', {key: 'Escape', preventDefault: () => {}, stopPropagation: () => {}}); f.flush();
  assert.equal(f.document.activeElement, f.node); assert.equal(f.search.value, ''); assert.equal(f.search.hidden, false);
  assert.equal(old.parentNode, f.node); assert.equal(f.node.query('roster-older').textContent, 'All agents (2)');
  f.search.dispatch('blur'); assert.equal(f.search.hidden, false);
});
test('the catalog list estimates the minimum row height and preserves selected virtual pins', t => {
  const now = 3 * 86400000; t.mock.method(Date, 'now', () => now);
  const f = setup(true, 30); const roster = new Roster(() => {}, () => {});
  const live = Array.from({length: 220}, (_, i) => row(`live-${i}`));
  const older = Array.from({length: 100}, (_, i) => row(`old-${i}`, {availability: 'stored', state: 'done'}));
  roster.set([...live, ...older], page([], 'next'), 'live-200'); f.flush();
  const gap = required(f.node.children.find(child => child.className === 'spacer'));
  const pinned = required(rowsOf(f.node).find(child => child.dataset.identity === 'live-200'));
  const beforePin = f.node.children.slice(0, f.node.children.indexOf(pinned)).reduce((height, node) => height + node.offsetHeight, 0);
  assert.equal(beforePin, 200 * 30); assert.ok(Number.parseFloat(gap.style.height ?? '') % 30 === 0);
  assert.equal(f.node.children.reduce((height, node) => height + node.offsetHeight, 0), 320 * 30 + 40);
  assert.equal(f.node.query('roster-older').textContent, 'All agents (320)'); assert.ok(rowsOf(f.node).length <= 77);
  const bottom = 320 * 30 + 40 - f.node.clientHeight;
  f.node.scrollTop = bottom; f.node.dispatch('scroll'); f.flush(); assert.equal(f.node.scrollTop, bottom);
  const more = f.node.query('roster-more'); assert.equal(f.node.children.at(-2), more);
  more.focus(); roster.set([...live, ...older], page([], 'next-2'), 'live-200'); f.flush();
  assert.equal(f.node.query('roster-more'), more); assert.equal(f.document.activeElement, more);
  f.node.query('roster-older').click(); assert.equal(f.node.scrollTop, bottom);
});
test('plain status words retain their full metadata', () => {
  const f = setup(); const roster = new Roster(() => {}, () => {});
  roster.set(['done', 'failed', 'idle', 'unknown'].map(state => row(state, {state}))); f.flush();
  assert.deepEqual(rowsOf(f.node).map(child => child.query('row-state').textContent), ['', '', '', '']);
  assert.deepEqual(rowsOf(f.node).map(child => child.query('row-select').title), ['done', 'failed', 'idle', 'unknown']);
  for (const child of rowsOf(f.node)) { assert.equal(child.dataset.live, 'true'); assert.throws(() => child.query('row-word')); }
});
test('Message captures identity across rename and reorder; Resume changes only its own action', () => {
  const f = setup(); const messages: string[] = []; const selections: string[] = [];
  const roster = new Roster(value => selections.push(value.identity), () => {}, undefined, identity => messages.push(identity));
  roster.set([row('a', {name: 'First'}), row('b')]); f.flush();
  const a = required(rowsOf(f.node)[0]); const action = a.query('row-message');
  assert.equal(action.hidden, false); assert.equal(action.parentNode, a); assert.equal(a.query('row-select').contains(action), false);
  roster.set([row('b'), row('a', {name: 'Renamed'})]); f.flush();
  action.click(); assert.deepEqual(messages, ['a']); assert.deepEqual(selections, []); assert.match(action.attributes['aria-label'] ?? '', /Renamed/);
  const moves = a.moves; roster.resume('a', true); assert.equal(action.textContent, 'Resume'); assert.equal(a.moves, moves);
  assert.equal(required(rowsOf(f.node)[1]).query('row-message').textContent, 'Message');
  roster.set([row('a'), row('b')], undefined, 'b'); f.flush(); assert.equal(action.hidden, false);
  const b = required(rowsOf(f.node)[1]).query('row-message'); assert.equal(b.hidden, true);
  assert.equal(roster.focusMessage('a'), true); action.click(); assert.deepEqual(messages, ['a', 'a']); assert.deepEqual(selections, []);
  roster.set([row('a'), row('b')], undefined, 'a'); f.flush(); assert.equal(action.hidden, true); assert.equal(b.hidden, false);
  b.click(); assert.deepEqual(messages, ['a', 'a', 'b']); assert.deepEqual(selections, []);
  roster.set([row('a'), row('b')]); f.flush(); assert.equal(action.hidden, false); assert.equal(action.textContent, 'Resume');
});

test('age toggles request row measurement and retain their deliberate clock through paint', t => {
  let now = Date.UTC(2026, 9, 8, 12); t.mock.method(Date, 'now', () => now);
  const f = setup(), roster = new Roster(() => {}, () => {}), source = row('age', {modifiedAt: now - 60000, state: 'idle'});
  roster.set([source]); f.flush(); const node = required(rowsOf(f.node)[0]), age = node.query('row-age');
  let measurements = 0; Object.defineProperty(node, 'offsetHeight', {get() {measurements++; return 88;}});
  now += 5 * 60000; age.click(); f.flush(); assert.ok(measurements > 0); assert.equal(age.dataset.absolute, 'true');
  const previous = measurements; age.click(); f.flush(); assert.ok(measurements > previous); assert.equal(age.textContent, '6m');
  roster.set([source]); f.flush(); assert.equal(rowsOf(f.node)[0], node); assert.equal(age.textContent, '6m');
});
test('roster keeps callback truth and its bounded excerpt in distinct heading fields', () => {
  const f = setup(); const label = 'Running; retained history only';
  const roster = expanded(new RosterView(() => {}, () => {}, undefined, () => {}, () => ({label, glyph: '?', tone: 'warning'})));
  const source = row('truthful', {name: 'A complete supplied conversation name', availability: 'stored', role: 'Supplied role '.repeat(80)});
  roster.set([source]); f.flush(); const node = required(rowsOf(f.node)[0]), heading = node.query('row-heading'), summary = node.query('row-summary');
  assert.deepEqual(heading.children.map(child => child.className), ['row-name', 'row-identity muted']);
  assert.deepEqual(summary.children.map(child => child.className), ['row-state', 'row-separator', 'row-preview']);
  assert.equal(heading.query('row-name').textContent, source.name); assert.equal(summary.query('row-state').textContent, ''); assert.equal(summary.query('row-state').title, label);
  assert.equal(summary.query('row-state').dataset.tone, 'warning'); assert.equal(heading.query('row-identity').hidden, true);
  assert.ok(summary.query('row-preview').textContent.startsWith('Supplied role')); assert.equal(summary.query('row-preview').title, source.role);
  assert.match(node.query('row-select').attributes['aria-label'] ?? '', /truthful/); assert.equal(node.query('row-message').parentNode, node);
});
test('quiet roster state preserves canonical accessibility, full preview and keyed actions', () => {
  const f = setup(); let hidden = true, label = 'Running';
  const roster = expanded(new RosterView(() => {}, () => {}, undefined, () => {}, () => ({label, glyph: '?', hideVisibleState: hidden})));
  const source = row('quiet', {state: 'idle', role: `**Long** ${'unbroken'.repeat(30)}`, currentTool: {name: 'read', argument: 'source.ts'}});
  roster.set([source]); f.flush();
  const node = required(rowsOf(f.node)[0]), select = node.query('row-select'), preview = node.query('row-preview'), state = node.query('row-state'), message = node.query('row-message'), age = node.query('row-age');
  assert.equal(state.hidden, true); assert.equal(state.textContent, ''); assert.equal(state.title, label);
  assert.match(select.title, /Running/); assert.match(select.attributes['aria-label'], /Running/); assert.match(select.attributes['aria-description'], /Running/);
  assert.equal(preview.textContent, rosterPreview(source.role ?? '')); assert.equal(preview.title, source.role);
  assert.ok(select.attributes['aria-description'].includes(preview.textContent)); assert.equal(preview.hidden, false);
  select.focus(); hidden = false;
  for (label of ['Working', 'Retrying', 'Response failed', 'Not connected', 'Unavailable', 'Connection lost; activity unknown']) {
    roster.set([source]); f.flush(); assert.equal(rowsOf(f.node)[0], node); assert.equal(state.hidden, label !== 'Working'); assert.equal(state.textContent, label === 'Working' ? label : '');
    assert.equal(node.query('row-preview'), preview); assert.equal(node.query('row-message'), message); assert.equal(node.query('row-age'), age); assert.equal(f.document.activeElement, select);
  }
  hidden = true; label = 'Running'; roster.set([source]); f.flush(); assert.equal(state.hidden, true);
  roster.set([{...source, role: ''}]); f.flush(); assert.equal(preview.hidden, true); assert.equal(preview.title, ''); assert.doesNotMatch(select.attributes['aria-description'], /Preview:/);
});
test('unchecked live work shows published activity without changing readiness or stored status', () => {
  const f = setup();
  const roster = expanded(new RosterView(() => {}, () => {}, undefined, undefined, source => {
    const view = conversationPresentation({target: {kind: 'agent', identity: source.identity}, row: source, connected: true});
    assert.equal(view.input, false); assert.equal(view.busy, false); assert.equal(view.tool, undefined);
    return {label: view.activity, glyph: presentationGlyph(view), tone: view.tone, hideVisibleState: view.hideVisibleState};
  }));
  const source = row('published-work', {currentTool: {name: 'read', argument: 'source.ts'}});
  roster.set([source]); f.flush();
  const node = required(rowsOf(f.node)[0]), state = node.query('row-state'), select = node.query('row-select');
  assert.equal(state.textContent, 'Working'); assert.equal(state.hidden, false); assert.equal(state.dataset.tone, 'info');
  assert.equal(state.dataset.busy, 'true'); assert.equal(state.className, 'row-state');
  assert.match(select.title, /Last reported tool · read · source.ts/); assert.match(select.attributes['aria-label'], /Working/);
  roster.set([{...source, state: 'idle'}]); f.flush();
  assert.equal(rowsOf(f.node)[0], node); assert.equal(state.hidden, true); assert.equal(state.dataset.busy, 'false');
  assert.doesNotMatch(select.textContent, /Ready|Idle/);
  roster.set([{...source, availability: 'stored'}]); f.flush();
  assert.equal(state.textContent, ''); assert.equal(state.hidden, true); assert.equal(state.dataset.busy, 'false'); assert.equal(state.dataset.tone, 'secondary');
});
test('resolved status overrides live catalog state and removes a stale tool without replacing the row', () => {
  const f = setup(); let label = 'Working';
  const roster = expanded(new RosterView(() => {}, () => {}, undefined, undefined, () => ({label, glyph: label === 'Working' ? '●' : '○', tool: label === 'Working' ? {name: 'read', argument: 'file.ts'} : undefined})));
  const source = row('selected', {state: 'unavailable', currentTool: {name: 'read', argument: 'file.ts'}});
  roster.set([source], undefined, source.identity); f.flush();
  const node = required(rowsOf(f.node)[0]); const select = node.query('row-select'); select.focus();
  assert.match(select.attributes['aria-label'] ?? '', /Working/); assert.doesNotMatch(select.attributes['aria-label'] ?? '', /unavailable/);
  assert.equal(node.query('row-age').textContent, ''); assert.match(select.title, /read · file.ts/); assert.equal(node.query('row-state').title, 'Working');
  label = 'Ready'; roster.set([source], undefined, source.identity); f.flush();
  assert.equal(rowsOf(f.node)[0], node); assert.equal(f.document.activeElement, select);
  assert.match(select.attributes['aria-label'] ?? '', /Ready/); assert.notEqual(node.query('row-age').textContent, 'read');
  assert.equal(node.query('row-state').title, 'Ready');
});
