import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRow, CachedRoster } from '../shared/api.ts';
import { absoluteTime, relativeTime } from './format.ts';
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
  private handlers = new Map<string, Array<() => void>>();
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  get nextSibling(): FakeNode | null { const peers = this.parentNode?.children ?? []; return peers[peers.indexOf(this) + 1] ?? null; }
  get offsetHeight(): number { return this.hidden ? 0 : this.style.height ? Number.parseFloat(this.style.height) : this.className === 'agent-row' ? 110 : 20; }
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
  addEventListener(name: string, callback: () => void): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], callback]); }
  dispatch(name: string): void { for (const callback of this.handlers.get(name) ?? []) callback(); }
  click(): void { if (!this.disabled && !this.hidden) this.dispatch('click'); }
  query(className: string): FakeNode {
    for (const child of this.children) { if (child.className.split(' ').includes(className)) return child; }
    for (const child of this.children) { try { return child.query(className); } catch {} }
    throw new Error(`Missing ${className}`);
  }
}
function setup() {
  const ids = new Map(['roster', 'agent-search', 'roster-footer'].map(id => [id, new FakeNode('div')]));
  const frames: Array<() => void> = [];
  const document = {activeElement: null as FakeNode | null, createElement: (tag: string) => new FakeNode(tag), getElementById: (id: string) => ids.get(id)};
  Object.assign(globalThis, {document, requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; }});
  return {document, node: required(ids.get('roster')), search: required(ids.get('agent-search')), footer: required(ids.get('roster-footer')), flush: () => { const pending = frames.splice(0); for (const callback of pending) callback(); }};
}
function row(identity: string, facts: Partial<AgentRow> = {}): AgentRow {
  return {identity, name: 'Agent', storageId: identity, cwd: '/project', modifiedAt: 0, state: 'working', availability: 'live', owner: 'here', partial: false, ...facts};
}

test('roster has sibling native actions and preserves retained, idle and working glyphs', t => {
  t.mock.method(Date, 'now', () => 600000);
  const fixture = setup(); const selected: string[] = [];
  const roster = new Roster(value => selected.push(value.identity), () => {});
  roster.set([row('stored', {availability: 'stored'}), row('idle', {state: 'idle'}), row('working')], undefined, 'idle'); fixture.flush();
  const [stored, idle, working] = fixture.node.children; assert.ok(stored); assert.ok(idle); assert.ok(working);
  assert.equal(stored.query('row-state').textContent.codePointAt(0), 0x25cc);
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
  assert.equal(select.children.length, 3); assert.match(stored.query('row-activity').textContent, /^stored/);
  assert.equal(age.tabIndex, 0); assert.equal(age.query('timestamp').textContent, '10m ago');
  assert.equal(age.query('timestamp').dateTime, '1970-01-01T00:00:00.000Z');
  assert.match(age.attributes['aria-description'] ?? '', /1969|1970/); assert.match(age.title, /1970-01-01T00:00:00.000Z/);
  assert.equal(age.dataset.absolute, 'false');
  age.click(); assert.deepEqual(selected, []); assert.doesNotMatch(age.textContent, /ago/); assert.equal(age.dataset.absolute, 'true');
  age.click(); assert.equal(age.textContent, '10m ago'); assert.deepEqual(selected, []); assert.equal(age.dataset.absolute, 'false');
  select.click(); assert.deepEqual(selected, ['stored']);
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
  assert.equal(fixture.node.children[0]?.query('row-identity').textContent, 'first:shared');
  assert.equal(fixture.node.children[1]?.query('row-identity').textContent, 'second:shared');
});
test('empty roster discovery failure puts the reason and retry at the top', () => {
  const fixture = setup(); const actions: Array<string | undefined> = [];
  const roster = new Roster(() => {}, action => actions.push(action));
  roster.set([], {stale: true, scan: {state: 'failed', complete: false, visited: 0, skipped: 0, omitted: 0}, error: {code: 'unavailable', message: 'Catalog could not be read', retry: 'read'}}); fixture.flush();
  const failure = required(fixture.node.children[0]); assert.match(failure.textContent, /Catalog could not be read/);
  required(failure.children.find(child => child.tagName === 'button')).click(); assert.deepEqual(actions, ['refresh']);
  assert.equal(fixture.footer.children.some(child => child.tagName === 'button'), false);
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
  assert.equal(fixture.document.activeElement, age); assert.equal(age.textContent, '10m ago');
  const changed = {...one, latestReply: 'New answer'}; roster.set([changed, two]); fixture.flush();
  assert.equal(age.textContent, '15m ago'); select.click(); assert.equal(selected[0], changed);
  age.click(); const absolute = age.textContent;
  roster.set([changed, {...two, latestReply: 'Another answer'}]); fixture.flush(); assert.equal(age.textContent, absolute);
  age.click(); assert.equal(age.textContent, '15m ago');
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
  assert.equal(age.textContent, relativeTime(0, now)); assert.match(age.textContent, /1969|1970/);
  age.click(); assert.equal(age.textContent, absoluteTime(0));
  age.click(); assert.equal(age.textContent, relativeTime(0, now));
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
  assert.match(fixture.footer.textContent, /Searching cached pages/);
  required(fixture.loads[0]).pending.resolve(page([row('other')], 'page-2')); await required(fixture.loads[0]).pending.promise;
  assert.equal(required(fixture.loads[1]).cursor, 'page-2'); assert.match(fixture.footer.textContent, /Searching cached pages/);
  required(fixture.loads[1]).pending.resolve(page([row('needle', {name: 'Needle'})])); await required(fixture.loads[1]).pending.promise; await Promise.resolve(); fixture.flush();
  assert.equal(fixture.loads.length, 2); assert.match(fixture.node.textContent, /Needle/);
  assert.doesNotMatch(fixture.footer.textContent, /Searching/); assert.deepEqual(fixture.actions, []);
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
  required(fixture.footer.children.find(child => child.tagName === 'button')).click(); assert.deepEqual(fixture.actions, ['more']);
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
test('loaded matches do not fetch cached pages', () => {
  const fixture = searchFixture(); fixture.query(' initial-3 '); assert.equal(fixture.loads.length, 0); assert.equal(fixture.node.children[0]?.dataset.identity, 'initial-3');
});
test('focused timestamp pins its wrapper outside the virtual roster window', t => {
  t.mock.method(Date, 'now', () => 600000);
  const fixture = setup(); const roster = new Roster(() => {}, () => {});
  const rows = Array.from({length: 220}, (_, index) => row(`r${index}`)); roster.set(rows); fixture.flush();
  const wrapper = required(fixture.node.children.find(child => child.dataset.identity === 'r0'));
  const age = wrapper.query('row-age'); fixture.document.activeElement = age;
  fixture.node.scrollTop = 18000; fixture.node.dispatch('scroll'); fixture.flush();
  assert.equal(wrapper.parentNode, fixture.node); assert.equal(fixture.document.activeElement, age);
  assert.ok(fixture.node.children.filter(child => child.className === 'agent-row').length < 40);
  roster.set(rows.slice(1)); fixture.flush(); assert.equal(wrapper.parentNode, null);
});
