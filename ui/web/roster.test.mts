import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRow, CachedRoster } from '../shared/api.ts';
import { absoluteTime, relativeTime, timestampDetails } from './format.ts';
import { Roster as RosterView, activityLine, publishedRetryDescription, rosterPreview } from './roster.ts';

test('roster previews project Markdown words without losing literal punctuation', () => {
  assert.equal(rosterPreview('**October 18, 2026** with `const total = 2`'), 'October 18, 2026 with const total = 2');
  assert.equal(rosterPreview(String.raw`Keep \*literal\* and \_under\_ plus a_b.`), 'Keep *literal* and _under_ plus a_b.');
  assert.equal(rosterPreview('[A **label**](https://example.test/doc) and `a*b`'), 'A label and a*b');
  assert.equal(rosterPreview('| First | Second |\n| --- | --- |\n| Alpha | Beta |\n\n- One\n- Two'), 'First Second Alpha Beta One Two');
  const long = rosterPreview('**Text** '.repeat(10000)); assert.ok(long.length <= 180); assert.doesNotMatch(long, /\*\*/);
  assert.equal(rosterPreview(`${' '.repeat(4096)}Outside parser input`), '');
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
    super(select, more, search, message, resolved ?? (row => ({glyph: row.availability !== 'live' ? '○' : ({working: '●', failed: '!', done: '✓'} as Record<string, string>)[row.state] ?? '○', label: row.availability === 'live' ? row.state : row.availability, tool: row.state === 'working' ? row.currentTool : undefined})));
  }
}
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
  const ids = new Map(['roster', 'agent-search', 'roster-footer', ...(withRefresh ? ['agent-refresh'] : [])].map(id => [id, new FakeNode('div')]));
  const frames: Array<() => void> = [];
  const document = {activeElement: null as FakeNode | null, createElementNS: (_namespace: string, tag: string) => new FakeNode(tag), createElement: (tag: string) => {const node = new FakeNode(tag); node.rowHeight = rowHeight; return node;}, getElementById: (id: string) => ids.get(id)};
  Object.assign(globalThis, {document, requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; }});
  return {document, node: required(ids.get('roster')), search: required(ids.get('agent-search')), footer: required(ids.get('roster-footer')), flush: () => { const pending = frames.splice(0); for (const callback of pending) callback(); }};
}
function row(identity: string, facts: Partial<AgentRow> = {}): AgentRow {
  return {identity, name: 'Agent', storageId: identity, cwd: '/project', modifiedAt: 0, state: 'working', availability: 'live', owner: 'here', partial: false, ...facts};
}

test('routine ready roster hides the footer without a refresh control', t => {
  t.mock.method(Date, 'now', () => 600000);
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  const meta = {...page([]), observedAt: new Date(0).toISOString()};
  roster.set([row('one')], meta); fixture.flush();
  const refresh = required(fixture.document.getElementById('agent-refresh')); refresh.title = 'Unchanged';
  assert.equal(fixture.footer.hidden, true); assert.equal(fixture.footer.textContent, '');
  assert.equal(refresh.title, 'Unchanged');
  roster.set([row('one')], {...meta, stale: true}); fixture.flush();
  assert.equal(fixture.footer.hidden, false); assert.equal(fixture.footer.children[0]?.textContent, 'Saved agent list · 10m ago');
  assert.equal(fixture.footer.children[1]?.textContent, 'Refresh agents');
  assert.equal(refresh.title, 'Unchanged');
  roster.set([], page([])); fixture.flush();
  assert.equal(fixture.footer.hidden, true); assert.equal(refresh.title, 'Unchanged');
  const absent = setup(false); const withoutRefresh = new Roster(() => {}, () => {});
  assert.doesNotThrow(() => withoutRefresh.set([], meta)); absent.flush(); assert.equal(absent.footer.hidden, true);
});
test('roster footer remains visible only for exceptional states', () => {
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  for (const meta of [
    {...page([]), scan: {...page([]).scan, state: 'running' as const}},
    {...page([]), scan: {...page([]).scan, state: 'failed' as const}},
    {...page([]), scan: {...page([]).scan, skipped: 1}},
  ]) { roster.set([row('one')], meta); fixture.flush(); assert.equal(fixture.footer.hidden, false); }
  roster.set([row('one')], page([])); fixture.flush(); assert.equal(fixture.footer.hidden, true);
});
test('paging follows expanded older rows, reuses its button, and never appears in the routine footer', t => {
  t.mock.method(Date, 'now', () => 3 * 86400000);
  const f = setup(); const actions: Array<string | undefined> = []; const roster = new Roster(() => {}, action => actions.push(action));
  const rows = Array.from({length: 80}, (_, i) => row(`agent-${i}`, i < 30 ? {} : {availability: 'stored', state: 'done'}));
  roster.set(rows, page(rows, 'next')); f.flush();
  assert.equal(f.node.children.filter(child => child.className === 'agent-row').length, 30);
  const older = f.node.query('roster-older'); assert.equal(older.textContent, 'Show 50 older agents'); assert.equal(f.node.children.at(-1), older);
  assert.equal(f.footer.hidden, true); assert.throws(() => f.node.query('roster-more'));
  older.click(); const more = f.node.query('roster-more'); assert.equal(more.textContent, 'More agents'); assert.equal(more.type, 'button'); assert.equal(f.node.children.at(-1), more);
  more.click(); assert.deepEqual(actions, ['more']);
  const nextRows = [...rows, row('extra', {availability: 'stored', state: 'done'})];
  roster.set(nextRows, page(nextRows, 'next-2')); f.flush(); assert.equal(f.node.query('roster-more'), more); assert.equal(older.textContent, 'Hide older agents');
  older.click(); assert.equal(f.node.children.at(-1), older); assert.equal(older.textContent, 'Show 51 older agents'); assert.equal(more.parentNode, null);
  older.click(); assert.equal(f.node.query('roster-more'), more);
  roster.set(nextRows, {...page(nextRows), scan: {...page([]).scan, complete: false, scanId: 'scan'}}); f.flush();
  assert.equal(f.node.query('roster-more'), more); assert.equal(more.textContent, 'Load more agents'); more.click();
  assert.equal(f.footer.hidden, true); assert.deepEqual(actions, ['more', 'more']);
  roster.set(nextRows, page(nextRows)); f.flush(); assert.equal(more.parentNode, null);
});
test('paging without loaded older rows appears directly and scan continuation requires an id', () => {
  const f = setup(); const actions: Array<string | undefined> = []; const roster = new Roster(() => {}, action => actions.push(action));
  for (const rows of [[], [row('one')]]) {
    roster.set(rows, page(rows, 'next')); f.flush();
    assert.throws(() => f.node.query('roster-older')); assert.equal(f.footer.hidden, true);
    const more = f.node.query('roster-more'); assert.equal(more.textContent, 'More agents'); assert.equal(f.node.children.at(-1), more); more.click();
    roster.set(rows, {...page(rows), scan: {...page([]).scan, complete: false, scanId: 'scan'}}); f.flush();
    assert.equal(f.node.query('roster-more'), more); assert.equal(more.textContent, 'Load more agents'); more.click();
    roster.set(rows, {...page(rows), scan: {...page([]).scan, complete: false}}); f.flush(); assert.equal(more.parentNode, null);
    assert.equal(f.footer.hidden, true);
  }
  assert.deepEqual(actions, ['more', 'more', 'more', 'more']);
});
test('exception footer actions preserve refresh and retry without routine paging', () => {
  const f = setup(); const actions: Array<string | undefined> = []; const roster = new Roster(() => {}, action => actions.push(action));
  roster.set([], {stale: false, scan: {...page([]).scan, state: 'not-started'}}); f.flush();
  assert.equal(f.footer.textContent, 'Refresh agents'); required(f.footer.children[0]).click();
  roster.set([row('one')], {...page([]), stale: true}); f.flush();
  assert.equal(f.footer.children[0]?.textContent, 'Saved agent list'); assert.equal(f.footer.children[1]?.textContent, 'Refresh agents'); required(f.footer.children[1]).click();
  roster.set([row('one')], {...page([]), scan: {...page([]).scan, state: 'failed'}}); f.flush();
  assert.match(f.footer.textContent, /Agents could not be loaded/); const retry = required(f.footer.children.find(child => child.tagName === 'button'));
  assert.equal(retry.attributes['aria-label'], 'Refresh agents'); assert.equal(retry.title, 'Refresh agents'); assert.equal(retry.query('card-action-label').textContent, 'Refresh agents'); retry.click(); assert.deepEqual(actions, ['refresh', 'refresh', 'refresh']);
});
test('working roster rows keep timestamps separate from accessible current tool details', t => {
  t.mock.method(Date, 'now', () => 600000);
  const f = setup(); const roster = new Roster(() => {}, () => {});
  const currentTool = {name: 'bash', argument: 'npm run check'};
  roster.set([row('one', {state: 'working', currentTool, modifiedAt: 599000})]); f.flush();
  const node = required(f.node.children[0]); const age = node.query('row-age'); const select = node.query('row-select');
  assert.equal(node.dataset.tool, 'true'); assert.equal(age.textContent, 'now'); assert.equal(age.hidden, false); assert.equal(age.disabled, false);
  assert.match(age.title, /1970-01-01T00:09:59.000Z/); assert.equal(age.attributes['aria-description'], timestampDetails(599000).display);
  assert.equal(age.query('timestamp').dateTime, new Date(599000).toISOString()); assert.match(select.title, /bash · npm run check/);
  assert.match(select.attributes['aria-description'] ?? '', /bash · npm run check/);
  const height = node.offsetHeight;
  roster.set([row('one', {state: 'idle', modifiedAt: 599000})]); f.flush();
  assert.equal(node.dataset.tool, 'false'); assert.equal(age.textContent, 'now'); assert.equal(age.disabled, false); assert.equal(node.offsetHeight, height);
  roster.set([row('one', {state: 'working'})]); f.flush(); assert.notEqual(age.textContent, 'bash');
});
test('roster has sibling native actions and plain retained, idle and working status', t => {
  const modifiedAt = Date.UTC(2026, 9, 8, 12);
  t.mock.method(Date, 'now', () => modifiedAt + 600000);
  const fixture = setup(); const selected: string[] = [];
  const roster = new Roster(value => selected.push(value.identity), () => {});
  roster.set([row('stored', {availability: 'stored', modifiedAt}), row('idle', {state: 'idle'}), row('working')], undefined, 'idle'); fixture.flush();
  const [stored, idle, working] = fixture.node.children; assert.ok(stored); assert.ok(idle); assert.ok(working);
  assert.equal(stored.query('row-state').textContent, 'stored');
  assert.equal(idle.query('row-state').textContent, 'idle'); assert.equal(working.query('row-state').textContent, 'working');
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
  assert.equal(select.children.length, 1);
  assert.deepEqual(select.children[0]?.children.map(child => child.className), ['row-name', 'row-identity muted', 'row-state', 'row-preview']);
  assert.equal(stored.dataset.live, 'false'); assert.equal(idle.dataset.live, 'true'); assert.equal(working.dataset.live, 'true');
  for (const removed of ['row-word', 'row-detail', 'row-model', 'row-activity']) assert.throws(() => stored.query(removed));
  assert.equal(idle.query('row-select').title, 'idle'); assert.equal(working.query('row-select').title, 'working');
  assert.equal(select.title, 'stored'); assert.equal(select.attributes['aria-description'], select.title);
  assert.equal(age.tabIndex, 0); assert.equal(age.query('timestamp').textContent, '10m');
  assert.equal(age.query('timestamp').dateTime, new Date(modifiedAt).toISOString());
  assert.equal(age.attributes['aria-description'], timestampDetails(modifiedAt).display); assert.match(age.title, /2026-10-08T12:00:00.000Z/);
  assert.equal(age.dataset.absolute, 'false');
  age.click(); assert.deepEqual(selected, []); assert.doesNotMatch(age.textContent, /ago/); assert.equal(age.dataset.absolute, 'true');
  age.click(); assert.equal(age.textContent, '10m'); assert.deepEqual(selected, []); assert.equal(age.dataset.absolute, 'false');
  select.click(); assert.deepEqual(selected, ['stored']);
});
test('liveness attributes and status update on the same keyed row', () => {
  const f = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('one')]); f.flush(); const wrapper = required(f.node.children[0]); assert.equal(wrapper.dataset.live, 'true');
  for (const availability of ['stored', 'unavailable', 'incompatible'] as const) {
    roster.set([row('one', {availability})]); f.flush();
    assert.equal(f.node.children[0], wrapper); assert.equal(wrapper.dataset.live, 'false');
    assert.equal(wrapper.query('row-state').textContent, availability); assert.equal(wrapper.query('row-state').dataset.tone, 'secondary');
    assert.match(wrapper.query('row-select').title, new RegExp(availability));
    assert.match(wrapper.query('row-select').attributes['aria-label'] ?? '', new RegExp(availability)); assert.throws(() => wrapper.query('row-word'));
  }
  roster.set([row('one')]); f.flush(); assert.equal(f.node.children[0], wrapper); assert.equal(wrapper.dataset.live, 'true');
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
    roster.set([row('one', {modifiedAt: value})]); f.flush();
    const age = required(f.node.children[0]).query('row-age'); const details = timestampDetails(value);
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
test('one-line row titles retain the provider, model, thinking level and activity', () => {
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('one', {model: {provider: 'vendor', modelId: 'model-x', thinkingLevel: 'high'}, currentTool: {name: 'read', argument: 'a.ts'}})]); fixture.flush();
  const select = required(fixture.node.children[0]).query('row-select');
  assert.equal(select.title, 'vendor/model-x · high\nworking · read · a.ts'); assert.equal(select.attributes['aria-description'], select.title);
  assert.doesNotMatch(select.textContent, /model-x|a.ts/);
  fixture.search.value = 'vendor/'; fixture.search.dispatch('input'); fixture.flush();
  assert.equal(fixture.node.children.filter(child => child.className === 'agent-row').length, 1);
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
  const [one, two, unique] = fixture.node.children; assert.ok(one); assert.ok(two); assert.ok(unique);
  assert.equal(one.query('row-heading').query('row-identity').textContent, '1');
  assert.equal(two.query('row-heading').query('row-identity').textContent, '2');
  assert.equal(unique.query('row-identity').hidden, true);
  fixture.search.value = 'storage:one'; fixture.search.dispatch('input'); fixture.flush();
  assert.equal(one.query('row-identity').hidden, false);
  fixture.search.value = ''; roster.set([row('storage:one')]); fixture.flush();
  assert.equal(one.query('row-identity').hidden, true); assert.equal(one.query('row-identity').textContent,'');
  roster.set([row('first:shared'), row('second:shared')]); fixture.flush();
  assert.equal(fixture.node.children[0]?.query('row-identity').textContent, '3');
  assert.equal(fixture.node.children[1]?.query('row-identity').textContent, '4');
  assert.equal(fixture.node.children[0]?.query('row-identity').title, 'Agent ID: first:shared');
  assert.equal(fixture.node.children[1]?.query('row-identity').title, 'Agent ID: second:shared');
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
    assert.deepEqual(f.node.children.map(child => child.query('row-identity').textContent), [String(ordinal++), String(ordinal++)]);
    for (const [index, child] of f.node.children.entries()) {
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
  roster.set(rows); f.flush(); const first = required(f.node.children[0]); const select = first.query('row-select');
  assert.equal(first.query('row-identity').textContent, '1'); assert.equal(f.node.children[2]?.query('row-identity').hidden, true);
  f.search.value = '00000000-a1234'; f.search.dispatch('input'); f.flush();
  assert.equal(f.node.children[0], first); assert.equal(first.query('row-identity').textContent, '1'); assert.equal(first.query('row-select'), select);
  f.search.value = ''; const collision = ['first-12345678', 'second-12345678'];
  roster.set(collision.map(identity => row(identity))); f.flush();
  assert.deepEqual(f.node.children.map(child => child.query('row-identity').textContent), ['3','4']);
});
test('identity-shaped names become honest captions without changing routing or search',()=> {
  const f=setup(),selected:string[]=[],ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
  const roster=new Roster(value=>selected.push(value.identity),()=>{},undefined,undefined,()=>({glyph:'?',label:'Unknown',tone:'warning'}));
  const rows=ids.map(identity=>row(identity,{name:identity}));roster.set(rows);f.flush();
  assert.deepEqual(f.node.children.map(child=>child.query('row-name').textContent),['Unnamed conversation','Unnamed conversation']);assert.deepEqual(f.node.children.map(child=>child.query('row-identity').textContent),['1','2']);
  for(const child of f.node.children)assert.equal(child.query('row-state').dataset.tone,'warning');
  f.search.value=ids[0]??'';f.search.dispatch('input');f.flush();assert.equal(f.node.children[0]?.query('row-identity').textContent,'1');f.node.children[0]?.query('row-select').click();assert.deepEqual(selected,[ids[0]]);
  f.search.value='';roster.set([...rows].reverse());f.flush();assert.equal(f.node.children.find(child=>child.dataset.identity===ids[0])?.query('row-identity').textContent,'1');
});
test('empty roster discovery failure keeps the reason in the list and retry in the footer', () => {
  const fixture = setup(); const actions: Array<string | undefined> = [];
  const roster = new Roster(() => {}, action => actions.push(action));
  roster.set([], {stale: true, scan: {state: 'failed', complete: false, visited: 0, skipped: 0, omitted: 0}, error: {code: 'unavailable', message: 'Catalog could not be read', retry: 'read'}}); fixture.flush();
  const failure = required(fixture.node.children[0]); assert.equal(failure.textContent, 'Agents could not be loaded.');
  assert.match(required(fixture.footer.children.find(child => child.tagName === 'details')).textContent, /Catalog could not be read/);
  assert.equal(fixture.footer.children.some(child => child.tagName === 'p' && child.textContent === failure.textContent), false);
  assert.equal(failure.children.some(child => child.tagName === 'button'), false);
  const retry = required(fixture.footer.children.find(child => child.tagName === 'button')); assert.equal(retry.attributes['aria-label'], 'Refresh agents'); assert.equal(retry.children[0]?.attributes.class, 'card-icon card-icon-restart'); assert.equal(retry.children[0]?.attributes['aria-hidden'], 'true');
  retry.click(); assert.deepEqual(actions, ['refresh']);
});
test('keyed wrappers, actions, order and focused timestamps survive roster updates', t => {
  const modifiedAt = Date.UTC(2026, 9, 8, 12);
  let clock = modifiedAt + 600000; t.mock.method(Date, 'now', () => clock);
  const fixture = setup(); const selected: AgentRow[] = []; const roster = new Roster(value => selected.push(value), () => {});
  const one = row('one', {modifiedAt}); const two = row('two'); roster.set([one, two]); fixture.flush();
  const wrapper = required(fixture.node.children[0]); const select = wrapper.query('row-select'); const age = wrapper.query('row-age'); const moves = wrapper.moves;
  fixture.document.activeElement = age; clock = modifiedAt + 900000;
  roster.set([two, one], undefined, 'two'); fixture.flush();
  assert.equal(fixture.node.children[0], wrapper); assert.equal(wrapper.moves, moves);
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
  roster.set([row('one', {modifiedAt})]); fixture.flush();
  const wrapper = required(fixture.node.children[0]); const age = wrapper.query('row-age');
  assert.equal(age.hidden, false); assert.equal(age.textContent, '10m');
  for (const value of [0, Number.NaN, Infinity, 8.64e15 + 1]) {
    roster.set([row('one', {modifiedAt: value})]); fixture.flush();
    assert.equal(age.hidden, true); assert.equal(age.disabled, true); assert.equal(age.tabIndex, -1); assert.equal(age.textContent, '');
    assert.equal(age.query('timestamp').dateTime, ''); assert.equal(age.title, ''); assert.equal(age.attributes['aria-description'], '');
    assert.equal(age.attributes['aria-label'], ''); assert.equal(wrapper.query('row-select').disabled, false);
  }
  roster.set([row('one', {modifiedAt})]); fixture.flush();
  assert.equal(fixture.node.children[0], wrapper); assert.equal(wrapper.query('row-age'), age);
  assert.equal(age.hidden, false); assert.equal(age.disabled, false); assert.equal(age.tabIndex, 0);
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
  assert.match(fixture.footer.textContent, /Searching agents…/); assert.equal(fixture.footer.hidden, false);
  required(fixture.loads[0]).pending.resolve(page([row('other')], 'page-2')); await required(fixture.loads[0]).pending.promise;
  assert.equal(required(fixture.loads[1]).cursor, 'page-2'); assert.match(fixture.footer.textContent, /Searching agents…/);
  required(fixture.loads[1]).pending.resolve(page([row('needle', {name: 'Needle'})])); await required(fixture.loads[1]).pending.promise; await Promise.resolve(); fixture.flush();
  assert.equal(fixture.loads.length, 2); assert.match(fixture.node.textContent, /Needle/);
  assert.doesNotMatch(fixture.footer.textContent, /Searching/); assert.equal(fixture.footer.hidden, true); assert.deepEqual(fixture.actions, []);
});
test('obsolete cached searches abort and never merge late responses', async () => {
  const fixture = searchFixture(); fixture.query('old'); const old = required(fixture.loads[0]);
  fixture.query('new'); assert.equal(old.signal.aborted, true); const current = required(fixture.loads[1]);
  old.pending.resolve(page([row('old')], 'old-next')); await old.pending.promise;
  assert.equal(fixture.merged.length, 0); assert.equal(fixture.loads.length, 2);
  assert.match(fixture.footer.textContent, /Searching agents…/);
  fixture.query(''); assert.equal(current.signal.aborted, true);
  current.pending.resolve(page([row('new')])); await current.pending.promise;
  assert.equal(fixture.merged.length, 0); assert.doesNotMatch(fixture.footer.textContent, /Searching/);
  fixture.node.query('roster-more').click(); assert.deepEqual(fixture.actions, ['more']);
});
test('cached search has a twenty-page bound and explicit continuation to cache end', async () => {
  const fixture = searchFixture(); fixture.query('missing');
  for (let i = 0; i < 20; i++) { required(fixture.loads[i]).pending.resolve(page([], `page-${i + 2}`)); await required(fixture.loads[i]).pending.promise; }
  await Promise.resolve(); assert.equal(fixture.loads.length, 20); assert.match(fixture.footer.textContent, /The agent list is incomplete/);
  fixture.roster.set(Array.from({length: 20}, (_, i) => row(`initial-${i}`)), page([], 'page-21')); assert.equal(fixture.loads.length, 20);
  required(fixture.footer.children.find(child => child.tagName === 'button')).click(); assert.equal(required(fixture.loads[20]).cursor, 'page-21');
  required(fixture.loads[20]).pending.resolve(page([])); await required(fixture.loads[20]).pending.promise; await Promise.resolve();
  assert.match(fixture.footer.textContent, /No more agents/); assert.deepEqual(fixture.actions, []);
  assert.equal(fixture.footer.children.some(child => child.tagName === 'button'), false);
});
test('cached search errors keep manual retry and do not restart on paint', async () => {
  const fixture = searchFixture(); fixture.query('missing'); const failed = required(fixture.loads[0]);
  failed.pending.reject(new Error('Cache unavailable')); await assert.rejects(failed.pending.promise); fixture.flush();
  assert.match(fixture.footer.textContent, /Agents could not be searched.*DetailsCache unavailable/); assert.equal(fixture.loads.length, 1);
  required(fixture.footer.children.find(child => child.tagName === 'button')).click(); const retry = required(fixture.loads[1]);
  retry.pending.resolve(page([], 'page-1')); await retry.pending.promise; await Promise.resolve();
  assert.match(fixture.footer.textContent, /Repeated cached page cursor/); assert.equal(fixture.loads.length, 2);
  assert.deepEqual(fixture.actions, []);
});
test('loaded matches do not fetch cached pages and expose manual continuation', () => {
  const fixture = searchFixture(); fixture.query(' initial-3 '); assert.equal(fixture.loads.length, 0); assert.equal(fixture.node.children[0]?.dataset.identity, 'initial-3');
  assert.equal(fixture.footer.hidden, true); const more = fixture.node.query('roster-more'); assert.equal(more.textContent, 'More agents'); more.click();
  assert.equal(fixture.loads.length, 1); assert.equal(fixture.loads[0]?.cursor, 'page-1'); fixture.flush(); assert.equal(more.parentNode, null);
});
test('focused timestamp pins its wrapper outside the virtual roster window', t => {
  t.mock.method(Date, 'now', () => 600000);
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  const rows = Array.from({length: 220}, (_, index) => row(`r${index}`, {modifiedAt: 1})); roster.set(rows); fixture.flush();
  const wrapper = required(fixture.node.children.find(child => child.dataset.identity === 'r0'));
  const age = wrapper.query('row-age'); fixture.document.activeElement = age;
  fixture.node.scrollTop = 18000; fixture.node.dispatch('scroll'); fixture.flush();
  assert.equal(wrapper.parentNode, fixture.node); assert.equal(fixture.document.activeElement, age);
  assert.ok(fixture.node.children.filter(child => child.className === 'agent-row').length <= 77);
  roster.set(rows.slice(1)); fixture.flush(); assert.equal(wrapper.parentNode, null);
});

test('default scope includes live, working and recent rows with an older toggle in stable order', t => {
  const now = 3 * 86400000; t.mock.method(Date, 'now', () => now);
  const f = setup(); const roster = new Roster(() => {}, () => {});
  const old = (identity: string, facts: Partial<AgentRow> = {}) => row(identity, {availability: 'stored', state: 'done', modifiedAt: now - 86400001, ...facts});
  const rows = [old('old'), old('live', {availability: 'live', state: 'idle'}), old('working', {state: 'working'}), old('recent', {modifiedAt: now - 1}), old('boundary', {modifiedAt: now - 86400000}), old('invalid', {modifiedAt: Number.NaN})];
  const ids = () => f.node.children.filter(child => child.className === 'agent-row').map(child => child.dataset.identity);
  roster.set(rows, page(rows)); f.flush();
  assert.deepEqual(ids(), ['live', 'working', 'recent', 'boundary']);
  const older = f.node.query('roster-older'); assert.equal(older.textContent, 'Show 2 older agents'); assert.equal(older.type, 'button'); assert.equal(older.attributes['aria-expanded'], 'false'); assert.equal(f.node.children.at(-1), older);
  older.click(); assert.deepEqual(ids(), rows.map(row => row.identity)); assert.equal(older.textContent, 'Hide older agents'); assert.equal(older.attributes['aria-expanded'], 'true');
  roster.set([...rows].reverse(), page(rows)); f.flush(); assert.deepEqual(ids(), rows.map(row => row.identity));
  older.click(); assert.deepEqual(ids(), ['live', 'working', 'recent', 'boundary']); assert.equal(f.node.query('roster-older'), older);
  f.search.value = 'old'; f.search.dispatch('input'); f.flush(); assert.deepEqual(ids(), ['old']); assert.throws(() => f.node.query('roster-older'));
});
test('selected, focused and retained rows remain in scope as the clock and retained state change', t => {
  let now = 3 * 86400000; t.mock.method(Date, 'now', () => now);
  const f = setup(); const roster = new Roster(() => {}, () => {}, undefined, () => {});
  const rows = ['selected', 'focused', 'retained', 'hidden'].map(identity => row(identity, {availability: 'stored', state: 'done', modifiedAt: now}));
  roster.set(rows, page(rows), 'selected'); f.flush();
  const focused = required(f.node.children.find(child => child.dataset.identity === 'focused')); const age = focused.query('row-age'); age.focus();
  roster.resume('retained', true); now += 86400001;
  roster.set(rows, page(rows), 'selected'); f.flush();
  assert.deepEqual(f.node.children.filter(child => child.className === 'agent-row').map(child => child.dataset.identity), ['selected', 'focused', 'retained']);
  assert.equal(f.document.activeElement, age); assert.equal(f.node.query('roster-older').textContent, 'Show 1 older agent');
  roster.set(rows, page(rows)); f.flush(); assert.equal(f.node.query('roster-older').textContent, 'Show 2 older agents');
  const retained = required(f.node.children.find(child => child.dataset.identity === 'retained')); assert.equal(retained.dataset.action, 'resume');
  roster.resume('retained', false); f.flush(); assert.equal(f.node.query('roster-older').textContent, 'Show 3 older agents');
  f.document.activeElement = null; f.node.dispatch('scroll'); f.flush();
  assert.equal(f.node.children.length, 1); assert.equal(f.node.query('roster-older').textContent, 'Show 4 older agents');
  roster.resume('hidden', true); f.flush(); assert.equal(f.node.children[0]?.dataset.identity, 'hidden'); assert.equal(f.node.children[0]?.dataset.action, 'resume');
});
test('printable roster keys focus the visible filter, search older rows, and Escape returns to the roster', t => {
  t.mock.method(Date, 'now', () => 3 * 86400000);
  const f = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('live', {name: 'Live'}), row('older', {name: 'Needle', availability: 'stored', state: 'done'})], page([])); f.flush();
  assert.equal(f.search.hidden, false);
  const select = required(f.node.children[0]).query('row-select'); select.focus();
  let prevented = 0; const key = (value: string, extra: Record<string, unknown> = {}) => f.node.dispatch('keydown', {key: value, preventDefault: () => { prevented++; }, ...extra});
  for (const extra of [{ctrlKey: true}, {metaKey: true}, {altKey: true}, {isComposing: true}, {defaultPrevented: true}]) key('n', extra);
  key('ArrowDown'); assert.equal(f.search.hidden, false); assert.equal(prevented, 0);
  key('n'); assert.equal(prevented, 1); assert.equal(f.search.hidden, false); assert.equal(f.search.value, 'n'); assert.equal(f.document.activeElement, f.search);
  assert.equal(f.node.children[0]?.dataset.identity, 'older'); assert.throws(() => f.node.query('roster-older'));
  let stopped = false; f.search.dispatch('keydown', {key: 'Escape', preventDefault: () => { prevented++; }, stopPropagation: () => { stopped = true; }}); f.flush();
  assert.equal(stopped, true); assert.equal(f.search.value, ''); assert.equal(f.search.hidden, false); assert.equal(f.document.activeElement, f.node);
  f.search.value = 'Li'; f.search.dispatch('input'); select.focus(); key('v');
  assert.equal(f.search.value, 'Liv'); assert.equal(f.document.activeElement, f.search); assert.equal(f.node.children[0]?.dataset.identity, 'live');
  f.search.value = ''; f.search.dispatch('input'); assert.equal(f.search.hidden, false);
  f.search.dispatch('blur'); f.flush(); assert.equal(f.search.hidden, false);
  f.node.focus(); key('x'); roster.set([], page([])); f.flush();
  f.search.dispatch('keydown', {key: 'Escape', preventDefault: () => {}, stopPropagation: () => {}}); assert.equal(f.document.activeElement, f.node);
});
test('filter visibility never changes and Escape restores the recent scope without an obsolete focus pin', t => {
  const now = 3 * 86400000; t.mock.method(Date, 'now', () => now);
  const f = setup();
  Object.defineProperty(f.search, 'hidden', {get: () => false, set: () => { throw new Error('Roster must not change filter visibility'); }});
  const roster = new Roster(() => {}, () => {});
  roster.set([row('old', {name: 'Old', availability: 'stored', state: 'done'}), row('live', {name: 'Live'})], page([])); f.flush();
  f.node.query('roster-older').click(); const old = required(f.node.children.find(child => child.dataset.identity === 'old')); old.query('row-select').focus();
  f.node.query('roster-older').click();
  f.node.dispatch('keydown', {key: 'x', preventDefault: () => {}}); assert.equal(old.parentNode, null);
  f.search.dispatch('keydown', {key: 'Escape', preventDefault: () => {}, stopPropagation: () => {}}); f.flush();
  assert.equal(f.document.activeElement, f.node); assert.equal(f.search.value, ''); assert.equal(f.search.hidden, false);
  assert.equal(old.parentNode, null); assert.equal(f.node.query('roster-older').textContent, 'Show 1 older agent');
  f.search.dispatch('blur'); assert.equal(f.search.hidden, false);
});
test('the visible scoped list estimates the minimum row height and preserves selected virtual pins', t => {
  const now = 3 * 86400000; t.mock.method(Date, 'now', () => now);
  const f = setup(true, 44); const roster = new Roster(() => {}, () => {});
  const live = Array.from({length: 220}, (_, i) => row(`live-${i}`));
  const older = Array.from({length: 100}, (_, i) => row(`old-${i}`, {availability: 'stored', state: 'done'}));
  roster.set([...live, ...older], page([], 'next'), 'live-200'); f.flush();
  const gap = required(f.node.children.find(child => child.className === 'spacer'));
  const pinned = required(f.node.children.find(child => child.dataset.identity === 'live-200'));
  const beforePin = f.node.children.slice(0, f.node.children.indexOf(pinned)).reduce((height, node) => height + node.offsetHeight, 0);
  assert.equal(beforePin, 200 * 44); assert.ok(Number.parseFloat(gap.style.height ?? '') % 44 === 0);
  assert.equal(f.node.children.reduce((height, node) => height + node.offsetHeight, 0), 220 * 44 + 20);
  assert.equal(f.node.query('roster-older').textContent, 'Show 100 older agents'); assert.ok(f.node.children.filter(child => child.className === 'agent-row').length <= 77);
  const bottom = 220 * 44 + 20 - f.node.clientHeight;
  f.node.scrollTop = bottom; f.node.dispatch('scroll'); f.flush(); assert.equal(f.node.scrollTop, bottom);
  f.node.query('roster-older').click(); assert.equal(f.node.scrollTop, bottom);
  const more = f.node.query('roster-more'); assert.equal(f.node.children.at(-1), more);
  const expandedBottom = 320 * 44 + 40 - f.node.clientHeight;
  f.node.scrollTop = expandedBottom; f.node.dispatch('scroll'); f.flush(); assert.equal(f.node.scrollTop, expandedBottom);
  more.focus(); roster.set([...live, ...older], page([], 'next-2'), 'live-200'); f.flush();
  assert.equal(f.node.query('roster-more'), more); assert.equal(f.document.activeElement, more);
  f.node.query('roster-older').click(); assert.equal(f.node.scrollTop, bottom);
});
test('plain status words retain their full metadata', () => {
  const f = setup(); const roster = new Roster(() => {}, () => {});
  roster.set(['done', 'failed', 'idle', 'unknown'].map(state => row(state, {state}))); f.flush();
  assert.deepEqual(f.node.children.map(child => child.query('row-state').textContent), ['done', 'failed', 'idle', 'unknown']);
  assert.deepEqual(f.node.children.map(child => child.query('row-select').title), ['done', 'failed', 'idle', 'unknown']);
  for (const child of f.node.children) { assert.equal(child.dataset.live, 'true'); assert.throws(() => child.query('row-word')); }
});
test('Message captures identity across rename and reorder; Resume changes only its own action', () => {
  const f = setup(); const messages: string[] = []; const selections: string[] = [];
  const roster = new Roster(value => selections.push(value.identity), () => {}, undefined, identity => messages.push(identity));
  roster.set([row('a', {name: 'First'}), row('b')]); f.flush();
  const a = required(f.node.children[0]); const action = a.query('row-message');
  assert.equal(action.hidden, false); assert.equal(action.parentNode, a); assert.equal(a.query('row-select').contains(action), false);
  roster.set([row('b'), row('a', {name: 'Renamed'})]); f.flush();
  action.click(); assert.deepEqual(messages, ['a']); assert.deepEqual(selections, []); assert.match(action.attributes['aria-label'] ?? '', /Renamed/);
  const moves = a.moves; roster.resume('a', true); assert.equal(action.textContent, 'Resume'); assert.equal(a.moves, moves);
  assert.equal(required(f.node.children[1]).query('row-message').textContent, 'Message');
  roster.set([row('a'), row('b')], undefined, 'b'); f.flush(); assert.equal(action.hidden, false);
  const b = required(f.node.children[1]).query('row-message'); assert.equal(b.hidden, true);
  assert.equal(roster.focusMessage('a'), true); action.click(); assert.deepEqual(messages, ['a', 'a']); assert.deepEqual(selections, []);
  roster.set([row('a'), row('b')], undefined, 'a'); f.flush(); assert.equal(action.hidden, true); assert.equal(b.hidden, false);
  b.click(); assert.deepEqual(messages, ['a', 'a', 'b']); assert.deepEqual(selections, []);
  roster.set([row('a'), row('b')]); f.flush(); assert.equal(action.hidden, false); assert.equal(action.textContent, 'Resume');
});

test('age toggles request row measurement and retain their deliberate clock through paint', t => {
  let now = Date.UTC(2026, 9, 8, 12); t.mock.method(Date, 'now', () => now);
  const f = setup(), roster = new Roster(() => {}, () => {}), source = row('age', {modifiedAt: now - 60000});
  roster.set([source]); f.flush(); const node = required(f.node.children[0]), age = node.query('row-age');
  let measurements = 0; Object.defineProperty(node, 'offsetHeight', {get() {measurements++; return 88;}});
  now += 5 * 60000; age.click(); f.flush(); assert.ok(measurements > 0); assert.equal(age.dataset.absolute, 'true');
  const previous = measurements; age.click(); f.flush(); assert.ok(measurements > previous); assert.equal(age.textContent, '6m');
  roster.set([source]); f.flush(); assert.equal(f.node.children[0], node); assert.equal(age.textContent, '6m');
});
test('roster keeps callback truth and its bounded excerpt in distinct heading fields', () => {
  const f = setup(); const label = 'Running; retained history only';
  const roster = new RosterView(() => {}, () => {}, undefined, () => {}, () => ({label, glyph: '?', tone: 'warning'}));
  const source = row('truthful', {name: 'A complete supplied conversation name', availability: 'stored', latestReply: 'Supplied reply '.repeat(80)});
  roster.set([source]); f.flush(); const node = required(f.node.children[0]), heading = node.query('row-heading');
  assert.deepEqual(heading.children.map(child => child.className), ['row-name', 'row-identity muted', 'row-state', 'row-preview']);
  assert.equal(heading.query('row-name').textContent, source.name); assert.equal(heading.query('row-state').textContent, label);
  assert.equal(heading.query('row-state').dataset.tone, 'warning'); assert.equal(heading.query('row-identity').hidden, true);
  assert.ok(heading.query('row-preview').textContent.startsWith('Supplied reply')); assert.ok(heading.query('row-preview').textContent.length <= 181);
  assert.match(node.query('row-select').attributes['aria-label'] ?? '', /truthful/); assert.equal(node.query('row-message').parentNode, node);
});
test('quiet roster state preserves canonical accessibility, full preview and keyed actions', () => {
  const f = setup(); let hidden = true, label = 'Running';
  const roster = new RosterView(() => {}, () => {}, undefined, () => {}, () => ({label, glyph: '?', hideVisibleState: hidden}));
  const source = row('quiet', {latestReply: `**Long** ${'unbroken'.repeat(30)}`, currentTool: {name: 'read', argument: 'source.ts'}});
  roster.set([source]); f.flush();
  const node = required(f.node.children[0]), select = node.query('row-select'), preview = node.query('row-preview'), state = node.query('row-state'), message = node.query('row-message'), age = node.query('row-age');
  assert.equal(state.hidden, true); assert.equal(state.textContent, label);
  assert.match(select.title, /Running/); assert.match(select.attributes['aria-label'], /Running/); assert.match(select.attributes['aria-description'], /Running/);
  assert.equal(preview.textContent, rosterPreview(source.latestReply ?? '')); assert.equal(preview.title, preview.textContent);
  assert.ok(select.attributes['aria-description'].includes(preview.textContent)); assert.equal(preview.hidden, false);
  select.focus(); hidden = false;
  for (label of ['Working', 'Retrying', 'Response failed', 'Not connected', 'Unavailable', 'Connection lost; activity unknown']) {
    roster.set([source]); f.flush(); assert.equal(f.node.children[0], node); assert.equal(state.hidden, false); assert.equal(state.textContent, label);
    assert.equal(node.query('row-preview'), preview); assert.equal(node.query('row-message'), message); assert.equal(node.query('row-age'), age); assert.equal(f.document.activeElement, select);
  }
  hidden = true; label = 'Running'; roster.set([source]); f.flush(); assert.equal(state.hidden, true);
  roster.set([{...source, latestReply: ''}]); f.flush(); assert.equal(preview.hidden, true); assert.equal(preview.title, ''); assert.doesNotMatch(select.attributes['aria-description'], /Preview:/);
});
test('resolved status overrides live catalog state and removes a stale tool without replacing the row', () => {
  const f = setup(); let label = 'Working';
  const roster = new RosterView(() => {}, () => {}, undefined, undefined, () => ({label, glyph: label === 'Working' ? '●' : '○', tool: label === 'Working' ? {name: 'read', argument: 'file.ts'} : undefined}));
  const source = row('selected', {state: 'unavailable', currentTool: {name: 'read', argument: 'file.ts'}});
  roster.set([source], undefined, source.identity); f.flush();
  const node = required(f.node.children[0]); const select = node.query('row-select'); select.focus();
  assert.match(select.attributes['aria-label'] ?? '', /Working/); assert.doesNotMatch(select.attributes['aria-label'] ?? '', /unavailable/);
  assert.equal(node.query('row-age').textContent, ''); assert.match(select.title, /read · file.ts/); assert.equal(node.query('row-state').title, 'Working');
  label = 'Ready'; roster.set([source], undefined, source.identity); f.flush();
  assert.equal(f.node.children[0], node); assert.equal(f.document.activeElement, select);
  assert.match(select.attributes['aria-label'] ?? '', /Ready/); assert.notEqual(node.query('row-age').textContent, 'read');
  assert.equal(node.query('row-state').title, 'Ready');
});
