import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRow, CachedRoster } from '../shared/api.ts';
import { absoluteTime, relativeTime, timestampDetails } from './format.ts';
import { Roster, activityLine } from './roster.ts';

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
  private text = '';
  private handlers = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  get nextSibling(): FakeNode | null { const peers = this.parentNode?.children ?? []; return peers[peers.indexOf(this) + 1] ?? null; }
  get offsetHeight(): number { return this.hidden ? 0 : this.style.height ? Number.parseFloat(this.style.height) : 20; }
  append(...nodes: FakeNode[]): void { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); node.moves++; } }
  prepend(node: FakeNode): void { node.remove(); node.parentNode = this; this.children.unshift(node); node.moves++; }
  after(node: FakeNode): void {
    const parent = this.parentNode; if (!parent) return;
    node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); node.moves++;
  }
  remove(): void { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  replaceChildren(...nodes: FakeNode[]): void { for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...nodes); }
  contains(node: FakeNode | null): boolean { return !!node && (node === this || this.children.some(child => child.contains(node))); }
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
function setup(withRefresh = true) {
  const ids = new Map(['roster', 'agent-search', 'roster-footer', ...(withRefresh ? ['agent-refresh'] : [])].map(id => [id, new FakeNode('div')]));
  const frames: Array<() => void> = [];
  const document = {activeElement: null as FakeNode | null, createElement: (tag: string) => new FakeNode(tag), getElementById: (id: string) => ids.get(id)};
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
  assert.equal(fixture.footer.hidden, false); assert.equal(fixture.footer.children[0]?.textContent, 'saved roster · 10m ago');
  assert.equal(fixture.footer.children[1]?.textContent, 'refresh');
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
  const older = f.node.query('roster-older'); assert.equal(older.textContent, '50 older'); assert.equal(f.node.children.at(-1), older);
  assert.equal(f.footer.hidden, true); assert.throws(() => f.node.query('roster-more'));
  older.click(); const more = f.node.query('roster-more'); assert.equal(more.textContent, 'more'); assert.equal(more.type, 'button'); assert.equal(f.node.children.at(-1), more);
  more.click(); assert.deepEqual(actions, ['more']);
  const nextRows = [...rows, row('extra', {availability: 'stored', state: 'done'})];
  roster.set(nextRows, page(nextRows, 'next-2')); f.flush(); assert.equal(f.node.query('roster-more'), more); assert.equal(older.textContent, 'hide older');
  older.click(); assert.equal(f.node.children.at(-1), older); assert.equal(older.textContent, '51 older'); assert.equal(more.parentNode, null);
  older.click(); assert.equal(f.node.query('roster-more'), more);
  roster.set(nextRows, {...page(nextRows), scan: {...page([]).scan, complete: false, scanId: 'scan'}}); f.flush();
  assert.equal(f.node.query('roster-more'), more); assert.equal(more.textContent, 'continue scan'); more.click();
  assert.equal(f.footer.hidden, true); assert.deepEqual(actions, ['more', 'more']);
  roster.set(nextRows, page(nextRows)); f.flush(); assert.equal(more.parentNode, null);
});
test('paging without loaded older rows appears directly and scan continuation requires an id', () => {
  const f = setup(); const actions: Array<string | undefined> = []; const roster = new Roster(() => {}, action => actions.push(action));
  for (const rows of [[], [row('one')]]) {
    roster.set(rows, page(rows, 'next')); f.flush();
    assert.throws(() => f.node.query('roster-older')); assert.equal(f.footer.hidden, true);
    const more = f.node.query('roster-more'); assert.equal(more.textContent, 'more'); assert.equal(f.node.children.at(-1), more); more.click();
    roster.set(rows, {...page(rows), scan: {...page([]).scan, complete: false, scanId: 'scan'}}); f.flush();
    assert.equal(f.node.query('roster-more'), more); assert.equal(more.textContent, 'continue scan'); more.click();
    roster.set(rows, {...page(rows), scan: {...page([]).scan, complete: false}}); f.flush(); assert.equal(more.parentNode, null);
    assert.equal(f.footer.hidden, true);
  }
  assert.deepEqual(actions, ['more', 'more', 'more', 'more']);
});
test('exception footer actions preserve refresh and retry without routine paging', () => {
  const f = setup(); const actions: Array<string | undefined> = []; const roster = new Roster(() => {}, action => actions.push(action));
  roster.set([], {stale: false, scan: {...page([]).scan, state: 'not-started'}}); f.flush();
  assert.equal(f.footer.textContent, 'refresh'); required(f.footer.children[0]).click();
  roster.set([row('one')], {...page([]), stale: true}); f.flush();
  assert.equal(f.footer.children[0]?.textContent, 'saved roster'); assert.equal(f.footer.children[1]?.textContent, 'refresh'); required(f.footer.children[1]).click();
  roster.set([row('one')], {...page([]), scan: {...page([]).scan, state: 'failed'}}); f.flush();
  assert.match(f.footer.textContent, /Roster discovery failed/); const retry = required(f.footer.children.find(child => child.tagName === 'button'));
  assert.equal(retry.textContent, 'retry'); retry.click(); assert.deepEqual(actions, ['refresh', 'refresh', 'refresh']);
});
test('roster has sibling native actions and preserves retained, idle and working glyphs', t => {
  t.mock.method(Date, 'now', () => 600000);
  const fixture = setup(); const selected: string[] = [];
  const roster = new Roster(value => selected.push(value.identity), () => {});
  roster.set([row('stored', {availability: 'stored'}), row('idle', {state: 'idle'}), row('working')], undefined, 'idle'); fixture.flush();
  const [stored, idle, working] = fixture.node.children; assert.ok(stored); assert.ok(idle); assert.ok(working);
  assert.equal(stored.query('row-state').textContent, '○');
  assert.equal(idle.query('row-state').textContent, '○'); assert.equal(working.query('row-state').textContent, '●');
  assert.equal(stored.query('row-state').attributes['aria-hidden'], 'true');
  assert.equal(stored.query('row-state').dataset.state, 'retained');
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
  assert.deepEqual(select.children[0]?.children.map(child => child.className), ['row-state', 'row-name', 'row-identity muted']);
  assert.equal(stored.dataset.live, 'false'); assert.equal(idle.dataset.live, 'true'); assert.equal(working.dataset.live, 'true');
  for (const removed of ['row-word', 'row-detail', 'row-model', 'row-activity']) assert.throws(() => stored.query(removed));
  assert.equal(idle.query('row-select').title, 'idle'); assert.equal(working.query('row-select').title, 'working');
  assert.equal(select.title, 'stored · working'); assert.equal(select.attributes['aria-description'], select.title);
  assert.equal(age.tabIndex, 0); assert.equal(age.query('timestamp').textContent, '10m');
  assert.equal(age.query('timestamp').dateTime, '1970-01-01T00:00:00.000Z');
  assert.match(age.attributes['aria-description'] ?? '', /1969|1970/); assert.match(age.title, /1970-01-01T00:00:00.000Z/);
  assert.equal(age.dataset.absolute, 'false');
  age.click(); assert.deepEqual(selected, []); assert.doesNotMatch(age.textContent, /ago/); assert.equal(age.dataset.absolute, 'true');
  age.click(); assert.equal(age.textContent, '10m'); assert.deepEqual(selected, []); assert.equal(age.dataset.absolute, 'false');
  select.click(); assert.deepEqual(selected, ['stored']);
});
test('liveness attributes update on the same keyed row without a visible state word', () => {
  const f = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('one')]); f.flush(); const wrapper = required(f.node.children[0]); assert.equal(wrapper.dataset.live, 'true');
  for (const availability of ['stored', 'unavailable', 'incompatible'] as const) {
    roster.set([row('one', {availability})]); f.flush();
    assert.equal(f.node.children[0], wrapper); assert.equal(wrapper.dataset.live, 'false');
    assert.equal(wrapper.query('row-state').textContent, '○'); assert.equal(wrapper.query('row-state').dataset.state, 'retained');
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
    {value: now - 30 * 86400000, text: 'Sep 8'},
    {value: new Date(2026, 8, 2, 12).getTime(), text: 'Sep 2'},
    {value: now + 60000, text: 'now'},
    {value: now + 120000, text: 'Oct 8'},
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
  assert.equal(activityLine({...live, availability: 'stored'} as AgentRow, 'stored'), 'stored · working');
});
test('duplicate loaded names show distinguishing identity text on the name line', () => {
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('storage:one'), row('storage:two'), row('unique', {name: 'Only'})]); fixture.flush();
  const [one, two, unique] = fixture.node.children; assert.ok(one); assert.ok(two); assert.ok(unique);
  assert.equal(one.query('row-heading').query('row-identity').textContent, 'one');
  assert.equal(two.query('row-heading').query('row-identity').textContent, 'two');
  assert.equal(unique.query('row-identity').hidden, true);
  fixture.search.value = 'storage:one'; fixture.search.dispatch('input'); fixture.flush();
  assert.equal(one.query('row-identity').hidden, false);
  fixture.search.value = ''; roster.set([row('storage:one')]); fixture.flush();
  assert.equal(one.query('row-identity').hidden, true);
  roster.set([row('first:shared'), row('second:shared')]); fixture.flush();
  assert.equal(fixture.node.children[0]?.query('row-identity').textContent, 'shared');
  assert.equal(fixture.node.children[1]?.query('row-identity').textContent, 'shared');
  assert.equal(fixture.node.children[0]?.query('row-identity').title, 'first:shared');
  assert.equal(fixture.node.children[1]?.query('row-identity').title, 'second:shared');
});
test('shared-prefix duplicates use the shortest unique identity tail and retain full identity metadata', () => {
  const f = setup(); const roster = new Roster(() => {}, () => {});
  for (const {identities, labels} of [
    {identities: ['00000000-0000-abcd', '00000000-0000-wxyz'], labels: ['abcd', 'wxyz']},
    {identities: ['00000000-a1234', '00000000-b1234'], labels: ['a1234', 'b1234']},
    {identities: ['00000000-a1234567', '00000000-b1234567'], labels: ['a1234567', 'b1234567']},
    {identities: ['00000000-abcd', 'storage:abcd'], labels: ['-abcd', 'abcd']},
    {identities: ['00000000-storage:conversation-one', '00000000-storage:conversation-two'], labels: ['conversation-one', 'conversation-two']},
  ]) {
    roster.set(identities.map(identity => row(identity))); f.flush();
    assert.deepEqual(f.node.children.map(child => child.query('row-identity').textContent), labels);
    for (const [index, child] of f.node.children.entries()) {
      const identity = required(identities[index]);
      assert.equal(child.query('row-identity').title, identity); assert.ok(child.title.includes(identity));
      assert.ok(child.query('row-select').attributes['aria-label']?.includes(identity));
    }
  }
});
test('identity suffix uniqueness uses all loaded duplicates and falls back to full identity after eight colliding characters', () => {
  const f = setup(); const roster = new Roster(() => {}, () => {});
  const rows = [row('00000000-a1234'), row('00000000-b1234'), row('other-a1234', {name: 'Only'})];
  roster.set(rows); f.flush(); const first = required(f.node.children[0]); const select = first.query('row-select');
  assert.equal(first.query('row-identity').textContent, 'a1234'); assert.equal(f.node.children[2]?.query('row-identity').hidden, true);
  f.search.value = '00000000-a1234'; f.search.dispatch('input'); f.flush();
  assert.equal(f.node.children[0], first); assert.equal(first.query('row-identity').textContent, 'a1234'); assert.equal(first.query('row-select'), select);
  f.search.value = ''; const collision = ['first-12345678', 'second-12345678'];
  roster.set(collision.map(identity => row(identity))); f.flush();
  assert.deepEqual(f.node.children.map(child => child.query('row-identity').textContent), collision);
});
test('empty roster discovery failure keeps the reason in the list and retry in the footer', () => {
  const fixture = setup(); const actions: Array<string | undefined> = [];
  const roster = new Roster(() => {}, action => actions.push(action));
  roster.set([], {stale: true, scan: {state: 'failed', complete: false, visited: 0, skipped: 0, omitted: 0}, error: {code: 'unavailable', message: 'Catalog could not be read', retry: 'read'}}); fixture.flush();
  const failure = required(fixture.node.children[0]); assert.match(failure.textContent, /Catalog could not be read/);
  assert.equal(failure.children.some(child => child.tagName === 'button'), false);
  const retry = required(fixture.footer.children.find(child => child.tagName === 'button')); assert.equal(retry.textContent, 'retry');
  retry.click(); assert.deepEqual(actions, ['refresh']);
});
test('keyed wrappers, actions, order and focused timestamps survive roster updates', t => {
  let clock = 600000; t.mock.method(Date, 'now', () => clock);
  const fixture = setup(); const selected: AgentRow[] = []; const roster = new Roster(value => selected.push(value), () => {});
  const one = row('one'); const two = row('two'); roster.set([one, two]); fixture.flush();
  const wrapper = required(fixture.node.children[0]); const select = wrapper.query('row-select'); const age = wrapper.query('row-age'); const moves = wrapper.moves;
  fixture.document.activeElement = age; clock = 900000;
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
test('invalid timestamps stay hidden and unfocusable and recover without node replacement', t => {
  const now = new Date(2026, 9, 8, 12).getTime(); t.mock.method(Date, 'now', () => now);
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('one', {modifiedAt: Number.NaN})]); fixture.flush();
  const wrapper = required(fixture.node.children[0]); const age = wrapper.query('row-age');
  for (const value of [Number.NaN, Infinity, 8.64e15 + 1]) {
    roster.set([row('one', {modifiedAt: value})]); fixture.flush();
    assert.equal(age.hidden, true); assert.equal(age.disabled, true); assert.equal(age.tabIndex, -1); assert.equal(age.textContent, '');
    assert.equal(age.query('timestamp').dateTime, ''); assert.equal(age.title, ''); assert.equal(age.attributes['aria-description'], '');
    assert.equal(wrapper.query('row-select').disabled, false);
  }
  roster.set([row('one', {modifiedAt: 0})]); fixture.flush();
  assert.equal(fixture.node.children[0], wrapper); assert.equal(wrapper.query('row-age'), age);
  assert.equal(age.hidden, false); assert.equal(age.disabled, false); assert.equal(age.tabIndex, 0);
  const shortDate = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'}).format(new Date(0));
  assert.equal(age.textContent, shortDate); assert.doesNotMatch(age.textContent, /1969|1970/);
  assert.equal(age.attributes['aria-label'], `Timestamp for Agent · ${relativeTime(0, now)}`);
  age.click(); assert.equal(age.textContent, absoluteTime(0));
  age.click(); assert.equal(age.textContent, shortDate);
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
  assert.match(fixture.footer.textContent, /Searching cached pages/); assert.equal(fixture.footer.hidden, false);
  required(fixture.loads[0]).pending.resolve(page([row('other')], 'page-2')); await required(fixture.loads[0]).pending.promise;
  assert.equal(required(fixture.loads[1]).cursor, 'page-2'); assert.match(fixture.footer.textContent, /Searching cached pages/);
  required(fixture.loads[1]).pending.resolve(page([row('needle', {name: 'Needle'})])); await required(fixture.loads[1]).pending.promise; await Promise.resolve(); fixture.flush();
  assert.equal(fixture.loads.length, 2); assert.match(fixture.node.textContent, /Needle/);
  assert.doesNotMatch(fixture.footer.textContent, /Searching/); assert.equal(fixture.footer.hidden, true); assert.deepEqual(fixture.actions, []);
});
test('obsolete cached searches abort and never merge late responses', async () => {
  const fixture = searchFixture(); fixture.query('old'); const old = required(fixture.loads[0]);
  fixture.query('new'); assert.equal(old.signal.aborted, true); const current = required(fixture.loads[1]);
  old.pending.resolve(page([row('old')], 'old-next')); await old.pending.promise;
  assert.equal(fixture.merged.length, 0); assert.equal(fixture.loads.length, 2);
  assert.match(fixture.footer.textContent, /Searching cached pages/);
  fixture.query(''); assert.equal(current.signal.aborted, true);
  current.pending.resolve(page([row('new')])); await current.pending.promise;
  assert.equal(fixture.merged.length, 0); assert.doesNotMatch(fixture.footer.textContent, /Searching/);
  fixture.node.query('roster-more').click(); assert.deepEqual(fixture.actions, ['more']);
});
test('cached search has a twenty-page bound and explicit continuation to cache end', async () => {
  const fixture = searchFixture(); fixture.query('missing');
  for (let i = 0; i < 20; i++) { required(fixture.loads[i]).pending.resolve(page([], `page-${i + 2}`)); await required(fixture.loads[i]).pending.promise; }
  await Promise.resolve(); assert.equal(fixture.loads.length, 20); assert.match(fixture.footer.textContent, /Cached search limit reached · 20 pages read/);
  fixture.roster.set(Array.from({length: 20}, (_, i) => row(`initial-${i}`)), page([], 'page-21')); assert.equal(fixture.loads.length, 20);
  required(fixture.footer.children.find(child => child.tagName === 'button')).click(); assert.equal(required(fixture.loads[20]).cursor, 'page-21');
  required(fixture.loads[20]).pending.resolve(page([])); await required(fixture.loads[20]).pending.promise; await Promise.resolve();
  assert.match(fixture.footer.textContent, /No more cached agents/); assert.deepEqual(fixture.actions, []);
  assert.equal(fixture.footer.children.some(child => child.tagName === 'button'), false);
});
test('cached search errors keep manual retry and do not restart on paint', async () => {
  const fixture = searchFixture(); fixture.query('missing'); const failed = required(fixture.loads[0]);
  failed.pending.reject(new Error('Cache unavailable')); await assert.rejects(failed.pending.promise); fixture.flush();
  assert.match(fixture.footer.textContent, /Cached search failed: Cache unavailable/); assert.equal(fixture.loads.length, 1);
  required(fixture.footer.children.find(child => child.tagName === 'button')).click(); const retry = required(fixture.loads[1]);
  retry.pending.resolve(page([], 'page-1')); await retry.pending.promise; await Promise.resolve();
  assert.match(fixture.footer.textContent, /Repeated cached page cursor/); assert.equal(fixture.loads.length, 2);
  assert.deepEqual(fixture.actions, []);
});
test('loaded matches do not fetch cached pages and expose the lowercase manual continuation', () => {
  const fixture = searchFixture(); fixture.query(' initial-3 '); assert.equal(fixture.loads.length, 0); assert.equal(fixture.node.children[0]?.dataset.identity, 'initial-3');
  assert.equal(fixture.footer.hidden, true); const more = fixture.node.query('roster-more'); assert.equal(more.textContent, 'more'); more.click();
  assert.equal(fixture.loads.length, 1); assert.equal(fixture.loads[0]?.cursor, 'page-1'); fixture.flush(); assert.equal(more.parentNode, null);
});
test('focused timestamp pins its wrapper outside the virtual roster window', t => {
  t.mock.method(Date, 'now', () => 600000);
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  const rows = Array.from({length: 220}, (_, index) => row(`r${index}`)); roster.set(rows); fixture.flush();
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
  const older = f.node.query('roster-older'); assert.equal(older.textContent, '2 older'); assert.equal(older.type, 'button'); assert.equal(older.attributes['aria-expanded'], 'false'); assert.equal(f.node.children.at(-1), older);
  older.click(); assert.deepEqual(ids(), rows.map(row => row.identity)); assert.equal(older.textContent, 'hide older'); assert.equal(older.attributes['aria-expanded'], 'true');
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
  assert.equal(f.document.activeElement, age); assert.equal(f.node.query('roster-older').textContent, '1 older');
  roster.set(rows, page(rows)); f.flush(); assert.equal(f.node.query('roster-older').textContent, '2 older');
  const retained = required(f.node.children.find(child => child.dataset.identity === 'retained')); assert.equal(retained.dataset.action, 'resume');
  roster.resume('retained', false); f.flush(); assert.equal(f.node.query('roster-older').textContent, '3 older');
  f.document.activeElement = null; f.node.dispatch('scroll'); f.flush();
  assert.equal(f.node.children.length, 1); assert.equal(f.node.query('roster-older').textContent, '4 older');
  roster.resume('hidden', true); f.flush(); assert.equal(f.node.children[0]?.dataset.identity, 'hidden'); assert.equal(f.node.children[0]?.dataset.action, 'resume');
});
test('printable roster keys reveal the filter, search older rows, and Escape restores row focus', t => {
  t.mock.method(Date, 'now', () => 3 * 86400000);
  const f = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('live', {name: 'Live'}), row('older', {name: 'Needle', availability: 'stored', state: 'done'})], page([])); f.flush();
  assert.equal(f.search.hidden, true);
  const select = required(f.node.children[0]).query('row-select'); select.focus();
  let prevented = 0; const key = (value: string, extra: Record<string, unknown> = {}) => f.node.dispatch('keydown', {key: value, preventDefault: () => { prevented++; }, ...extra});
  for (const extra of [{ctrlKey: true}, {metaKey: true}, {altKey: true}, {isComposing: true}, {defaultPrevented: true}]) key('n', extra);
  key('ArrowDown'); assert.equal(f.search.hidden, true); assert.equal(prevented, 0);
  key('n'); assert.equal(prevented, 1); assert.equal(f.search.hidden, false); assert.equal(f.search.value, 'n'); assert.equal(f.document.activeElement, f.search);
  assert.equal(f.node.children[0]?.dataset.identity, 'older'); assert.throws(() => f.node.query('roster-older'));
  let stopped = false; f.search.dispatch('keydown', {key: 'Escape', preventDefault: () => { prevented++; }, stopPropagation: () => { stopped = true; }}); f.flush();
  assert.equal(stopped, true); assert.equal(f.search.value, ''); assert.equal(f.search.hidden, true); assert.equal(f.document.activeElement, select);
  select.focus(); key('L'); f.search.value = ''; f.search.dispatch('input'); assert.equal(f.search.hidden, false);
  f.search.dispatch('blur'); f.flush(); assert.equal(f.search.hidden, true);
  f.node.focus(); key('x'); roster.set([], page([])); f.flush();
  f.search.dispatch('keydown', {key: 'Escape', preventDefault: () => {}, stopPropagation: () => {}}); assert.equal(f.document.activeElement, f.node);
});
test('Escape restores an old focused row after the filter removes it', t => {
  const now = 3 * 86400000; t.mock.method(Date, 'now', () => now);
  const f = setup(); const roster = new Roster(() => {}, () => {});
  roster.set([row('old', {name: 'Old', availability: 'stored', state: 'done'}), row('live', {name: 'Live'})], page([])); f.flush();
  f.node.query('roster-older').click(); const old = required(f.node.children.find(child => child.dataset.identity === 'old')); old.query('row-select').focus();
  f.node.query('roster-older').click();
  f.node.dispatch('keydown', {key: 'x', preventDefault: () => {}}); assert.equal(old.parentNode, null);
  let hidden = f.search.hidden;
  Object.defineProperty(f.search, 'hidden', {get: () => hidden, set: value => { const changed = hidden !== value; hidden = value; if (changed && value) f.search.dispatch('blur'); }});
  f.search.dispatch('keydown', {key: 'Escape', preventDefault: () => {}, stopPropagation: () => {}}); f.flush();
  assert.equal(old.parentNode, f.node); assert.equal(f.document.activeElement, old.query('row-select'));
});
test('the visible scoped list uses a 20 pixel estimate and preserves selected virtual pins', t => {
  const now = 3 * 86400000; t.mock.method(Date, 'now', () => now);
  const f = setup(); const roster = new Roster(() => {}, () => {});
  const live = Array.from({length: 220}, (_, i) => row(`live-${i}`));
  const older = Array.from({length: 100}, (_, i) => row(`old-${i}`, {availability: 'stored', state: 'done'}));
  roster.set([...live, ...older], page([], 'next'), 'live-200'); f.flush();
  const gap = required(f.node.children.find(child => child.className === 'spacer'));
  const pinned = required(f.node.children.find(child => child.dataset.identity === 'live-200'));
  const beforePin = f.node.children.slice(0, f.node.children.indexOf(pinned)).reduce((height, node) => height + node.offsetHeight, 0);
  assert.equal(beforePin, 200 * 20); assert.ok(Number.parseFloat(gap.style.height ?? '') % 20 === 0);
  assert.equal(f.node.children.reduce((height, node) => height + node.offsetHeight, 0), 220 * 20 + 20);
  assert.equal(f.node.query('roster-older').textContent, '100 older'); assert.ok(f.node.children.filter(child => child.className === 'agent-row').length <= 77);
  const bottom = 220 * 20 + 20 - f.node.clientHeight;
  f.node.scrollTop = bottom; f.node.dispatch('scroll'); f.flush(); assert.equal(f.node.scrollTop, bottom);
  f.node.query('roster-older').click(); assert.equal(f.node.scrollTop, bottom);
  const more = f.node.query('roster-more'); assert.equal(f.node.children.at(-1), more);
  const expandedBottom = 320 * 20 + 40 - f.node.clientHeight;
  f.node.scrollTop = expandedBottom; f.node.dispatch('scroll'); f.flush(); assert.equal(f.node.scrollTop, expandedBottom);
  more.focus(); roster.set([...live, ...older], page([], 'next-2'), 'live-200'); f.flush();
  assert.equal(f.node.query('roster-more'), more); assert.equal(f.document.activeElement, more);
  f.node.query('roster-older').click(); assert.equal(f.node.scrollTop, bottom);
});
test('status words stay in metadata while live glyphs remain visible', () => {
  const f = setup(); const roster = new Roster(() => {}, () => {});
  roster.set(['done', 'failed', 'idle', 'unknown'].map(state => row(state, {state}))); f.flush();
  assert.deepEqual(f.node.children.map(child => child.query('row-state').textContent), ['✓', '!', '○', '○']);
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
  roster.set([row('a'), row('b')], undefined, 'b'); f.flush(); assert.equal(action.hidden, true);
  roster.set([row('a'), row('b')]); f.flush(); assert.equal(action.hidden, false); assert.equal(action.textContent, 'Resume');
});
