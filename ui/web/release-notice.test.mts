import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type {HealthSnapshot} from '../shared/health.ts';
import type {UiIdentity} from '../shared/version.ts';
import {differentRelease, loadedRelease, RELEASE_CHECK_MS, ReleaseNotice, servedRelease, type ReleaseIdentity, type ReleaseReloadState} from './release-notice.ts';

class Node extends EventTarget {
  className = ''; hidden = false; disabled = false; title = ''; type = ''; children: Node[] = []; parentElement: Node | null = null;
  attributes = new Map<string, string>(); private text = ''; writes = 0;
  get textContent(): string {return this.text + this.children.map(child => child.textContent).join('');}
  set textContent(value: string) {this.writes++; this.text = value; this.children = [];}
  append(...nodes: Node[]) {for (const node of nodes) {node.parentElement = this; this.children.push(node);}}
  insertBefore(node: Node, before: Node) {node.parentElement = this; this.children.splice(this.children.indexOf(before), 0, node);}
  remove() {if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null;}
  setAttribute(name: string, value: string) {this.attributes.set(name, value);}
  click() {if (!this.disabled) this.dispatchEvent(new Event('click'));}
}
const commit = (value: string) => value.repeat(40), generation = (value: string) => value.repeat(64);
const loaded: ReleaseIdentity = {commit: commit('a'), generation: generation('b'), release: generation('c')};
function snapshot(identity: ReleaseIdentity = loaded): HealthSnapshot {
  return {startedAt: '2026-10-21T00:00:00.000Z', supervisorRestarts: 0, services: [], build: {state: 'ready'},
    process: {pid: 1, uptimeMs: 1000, rssBytes: 1024}, requests: {active: 0, limit: 64}, userStylesheet: {state: 'none'},
    identity: {iteration: '1.10', commit: identity.commit, assetDigest: identity.generation}, backend: {pid: 2, release: identity.release}};
}
async function settle() {for (let index = 0; index < 10; index++) await Promise.resolve();}
function fixture(t: TestContext, identity: ReleaseIdentity | null = loaded) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => new Node()}});
  t.after(() => {if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');});
  const footer = new Node(), version = new Node(); footer.append(version);
  const requests: {signal: AbortSignal; resolve(value: unknown): void; reject(error: Error): void}[] = [];
  const timers = new Map<number, {callback: () => void; delay: number}>(); let serial = 0, state: ReleaseReloadState = 'ready', now = 10_000;
  const reloads: ReleaseIdentity[] = [], stylesheets: ReleaseIdentity[] = [], reloadSignals: AbortSignal[] = []; let failures = 0;
  let reload: (signal: AbortSignal) => Promise<void> = async () => {};
  const notice = new ReleaseNotice(identity ?? undefined, {before: version as unknown as HTMLElement,
    read: signal => new Promise((resolve, reject) => requests.push({signal, resolve, reject})),
    reload: (signal, release) => {reloads.push(release); reloadSignals.push(signal); return reload(signal);},
    stylesheet: async release => {stylesheets.push(release);}, reloadState: () => state, failure: () => {failures++;},
    clock: {now: () => now, set: (callback, delay) => {timers.set(++serial, {callback, delay}); return serial;}, clear: timer => {timers.delete(timer);}}});
  t.after(() => notice.destroy());
  const node = notice.node as unknown as Node;
  const fire = (delay: number) => {const entry = [...timers.entries()].find(([, value]) => value.delay === delay); assert.ok(entry, `timer ${delay}`); timers.delete(entry[0]); entry[1].callback();};
  return {notice, node, version, requests, timers, reloads, stylesheets, reloadSignals, fire,
    state: (value: ReleaseReloadState) => {state = value;}, advance: (ms: number) => {now += ms;}, reload: (value: typeof reload) => {reload = value;},
    get failures() {return failures;}};
}
const newer = {...loaded, commit: commit('d'), generation: generation('e'), release: generation('f')};

test('loaded identity uses page generation only, and served identity uses the checked health fields without aliases', () => {
  const identity: UiIdentity = {iteration: '1.10', release: loaded.release, git: {commit: loaded.commit, shortCommit: 'aaaaaaaa', branch: 'main', modified: false, committedAt: '2026-10-21T00:00:00Z'}, assets: {digest: generation('f')}};
  assert.deepEqual(loadedRelease(identity, loaded.generation), loaded);
  assert.equal(loadedRelease(identity, null), undefined, 'the asset digest is not a fallback for missing page generation');
  assert.equal(loadedRelease(identity, 'not-a-generation'), undefined);
  assert.equal(loadedRelease({iteration: '1.10'}, loaded.generation), undefined);
  assert.deepEqual(servedRelease(snapshot()), loaded);
  assert.equal(servedRelease({...snapshot(), identity: {iteration: '1.10'}}), undefined);
  assert.equal(differentRelease(loaded, {...loaded}), false);
  for (const changed of [{...loaded, commit: commit('d')}, {...loaded, generation: generation('e')}, {...loaded, release: generation('f')}]) assert.equal(differentRelease(loaded, changed), true);
});

test('a changed served release is adopted automatically once the page is quiet, with no manual controls', async t => {
  const f = fixture(t); f.advance(5000); f.notice.readiness(true);
  assert.equal(f.requests.length, 1); f.requests[0]?.resolve(snapshot(newer)); await settle();
  assert.deepEqual(f.reloads, [newer]); assert.equal(f.node.children.length, 0); assert.doesNotMatch(f.node.textContent, /Reload|Details|update available/i);
});

test('equal identities start no adoption and a later match cancels a waiting one', async t => {
  const f = fixture(t); f.notice.readiness(true); f.requests[0]?.resolve(snapshot()); await settle();
  assert.equal(f.node.hidden, true); assert.deepEqual(f.reloads, []);
  f.notice.key(); f.fire(RELEASE_CHECK_MS); f.requests[1]?.resolve(snapshot({...loaded, generation: generation('d')})); await settle();
  assert.deepEqual(f.reloads, []); assert.equal([...f.timers.values()].some(timer => timer.delay === 250), true);
  f.fire(RELEASE_CHECK_MS); f.requests[2]?.resolve(snapshot()); await settle();
  assert.equal([...f.timers.values()].some(timer => timer.delay === 250), false); assert.deepEqual(f.reloads, []);
});

test('typing or an unsaved draft delays adoption, and long typing shows Update waiting', async t => {
  const f = fixture(t); f.notice.readiness(true); f.notice.key(); f.requests[0]?.resolve(snapshot(newer)); await settle();
  assert.deepEqual(f.reloads, []); assert.equal(f.node.textContent, '');
  f.advance(60_000); f.notice.key(); f.notice.refresh(); assert.equal(f.node.textContent, 'Update waiting'); assert.equal(f.node.hidden, false);
  f.advance(3000); f.state('pending'); f.notice.refresh(); assert.deepEqual(f.reloads, []);
  f.state('ready'); f.notice.refresh(); await settle(); assert.deepEqual(f.reloads, [newer]);
});

test('a release with the same module family replaces only the stylesheet and announces the update', async t => {
  const family = generation('9'), f = fixture(t, {...loaded, moduleFamily: family}); f.advance(5000); f.notice.readiness(true);
  f.requests[0]?.resolve({...snapshot(newer), identity: {...snapshot(newer).identity, moduleFamily: family}}); await settle();
  assert.deepEqual(f.reloads, []); assert.equal(f.stylesheets.length, 1);
  assert.equal(f.node.textContent, 'Updated to ffffffff'); assert.equal(f.node.hidden, false);
  f.fire(6000); assert.equal(f.node.textContent, ''); assert.equal(f.node.hidden, true);
});

test('a failed adoption reports once and retries only after the check interval', async t => {
  const f = fixture(t); f.advance(5000); f.reload(async () => {throw new Error('refused');}); f.notice.readiness(true);
  f.requests[0]?.resolve(snapshot(newer)); await settle();
  assert.equal(f.reloads.length, 1); assert.equal(f.failures, 1);
  f.notice.refresh(); assert.equal(f.reloads.length, 1);
  f.advance(RELEASE_CHECK_MS); f.notice.refresh(); await settle(); assert.equal(f.reloads.length, 2);
});

test('disconnect aborts health and adoption, removes timers, and ignores late results; reconnect reads once', async t => {
  const f = fixture(t); f.advance(5000); f.notice.readiness(true); f.notice.readiness(true); assert.equal(f.requests.length, 1);
  f.notice.readiness(false); assert.equal(f.requests[0]?.signal.aborted, true); f.requests[0]?.resolve(snapshot(newer)); await settle();
  assert.deepEqual(f.reloads, []); assert.equal(f.timers.size, 0);
  f.notice.readiness(true); assert.equal(f.requests.length, 2);
  let finish!: () => void; f.reload(() => new Promise<void>(resolve => {finish = resolve;})); f.requests[1]?.resolve(snapshot(newer)); await settle();
  assert.equal(f.reloads.length, 1); f.notice.readiness(false); assert.equal(f.reloadSignals[0]?.aborted, true); assert.equal(f.timers.size, 0); finish(); await settle(); assert.equal(f.failures, 0);
  f.notice.readiness(true); assert.equal(f.requests.length, 3); f.notice.destroy(); assert.equal(f.requests[2]?.signal.aborted, true);
  f.requests[2]?.reject(new Error('late')); await settle(); assert.equal(f.timers.size, 0); f.notice.readiness(true); assert.equal(f.requests.length, 3);
});

test('failed or missing identity reads keep the last observation, and unavailable page identity starts no polling', async t => {
  const f = fixture(t); f.notice.key(); f.notice.readiness(true); f.requests[0]?.resolve(snapshot(newer)); await settle();
  f.fire(250); f.fire(RELEASE_CHECK_MS); f.requests[1]?.reject(new Error('unavailable')); await settle(); assert.deepEqual(f.reloads, []);
  const absent = fixture(t, null); absent.notice.readiness(true); assert.equal(absent.requests.length, 0); assert.equal(absent.node.hidden, true);
});
