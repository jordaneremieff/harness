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
  const timers = new Map<number, () => void>(); let serial = 0, state: ReleaseReloadState = 'ready', reloads = 0, details = 0, failures = 0;
  const visibility: boolean[] = [], reloadSignals: AbortSignal[] = [];
  let reload: (signal: AbortSignal) => Promise<void> = async () => {};
  const notice = new ReleaseNotice(identity ?? undefined, {before: version as unknown as HTMLElement,
    read: signal => new Promise((resolve, reject) => requests.push({signal, resolve, reject})),
    reload: signal => {reloads++; reloadSignals.push(signal); return reload(signal);}, details: () => {details++;},
    reloadState: () => state, changed: visible => {version.hidden = visible; visibility.push(visible);}, failure: () => {failures++;},
    clock: {set: (callback, delay) => {assert.equal(delay, RELEASE_CHECK_MS); timers.set(++serial, callback); return serial;}, clear: timer => {timers.delete(timer);}}});
  t.after(() => notice.destroy());
  const node = notice.node as unknown as Node, reloadButton = notice.reloadButton as unknown as Node, detailsButton = notice.detailsButton as unknown as Node;
  return {notice, node, footer, version, requests, timers, visibility, reloadSignals, reloadButton, detailsButton,
    state: (value: ReleaseReloadState) => {state = value; notice.refresh();}, reload: (value: typeof reload) => {reload = value;},
    tick: () => {const entry = timers.entries().next().value; assert.ok(entry); timers.delete(entry[0]); entry[1]();},
    get reloads() {return reloads;}, get details() {return details;}, get failures() {return failures;}};
}

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

test('a changed served release replaces version with exact facts and real named actions, with no automatic reload', async t => {
  const f = fixture(t); assert.equal(f.requests.length, 0); f.notice.readiness(true);
  f.requests[0]?.resolve(snapshot({...loaded, commit: commit('d'), generation: generation('e'), release: generation('f')})); await settle();
  assert.equal(f.node.hidden, false); assert.equal(f.version.hidden, true); assert.deepEqual(f.visibility, [true]);
  assert.equal(f.notice.facts.textContent, 'Release dddddddd live · this tab aaaaaaaa');
  assert.equal(f.reloadButton.type, 'button'); assert.equal(f.reloadButton.textContent, 'Reload'); assert.equal(f.reloadButton.disabled, false);
  assert.equal(f.reloadButton.attributes.get('aria-label'), 'Reload to release dddddddd');
  assert.equal(f.detailsButton.attributes.get('aria-label'), 'Release details');
  assert.doesNotMatch(f.node.textContent, /update available|refresh|!/i); assert.equal(f.reloads, 0);
  f.detailsButton.click(); assert.equal(f.details, 1); assert.equal(f.reloads, 0);
  const disclosure = f.node.children.find(node => node.className.includes('workbench-release-disclosure')); assert.ok(disclosure);
  const narrowDetails = disclosure.children[1]?.children[0]; assert.equal(narrowDetails?.attributes.get('aria-label'), 'Release details'); narrowDetails?.click(); assert.equal(f.details, 2);
  f.reloadButton.click(); assert.equal(f.reloads, 1); assert.equal(f.reloadButton.disabled, true); await settle();
});

test('equal identities show no notice and a later match restores version', async t => {
  const f = fixture(t); f.notice.readiness(true); f.requests[0]?.resolve(snapshot()); await settle();
  assert.equal(f.node.hidden, true); assert.equal(f.version.hidden, false); assert.deepEqual(f.visibility, []);
  f.tick(); f.requests[1]?.resolve(snapshot({...loaded, generation: generation('d')})); await settle(); assert.equal(f.node.hidden, false);
  assert.equal(f.notice.facts.textContent, 'Release dddddddd live · this tab bbbbbbbb');
  assert.equal(f.reloadButton.attributes.get('aria-label'), 'Reload to release dddddddd');
  f.tick(); f.requests[2]?.resolve(snapshot()); await settle(); assert.equal(f.node.hidden, true); assert.equal(f.version.hidden, false); assert.deepEqual(f.visibility, [true, false]);
});

test('pending saves disable Reload until acknowledgement; failed saves never gain a competing retry action', async t => {
  const f = fixture(t); f.state('pending'); f.notice.readiness(true); f.requests[0]?.resolve(snapshot({...loaded, commit: commit('d')})); await settle();
  assert.equal(f.reloadButton.textContent, 'Reload after draft save'); assert.equal(f.reloadButton.disabled, true); f.reloadButton.click(); assert.equal(f.reloads, 0);
  f.state('failed'); assert.equal(f.reloadButton.disabled, true); assert.equal(f.reloadButton.textContent, 'Reload'); assert.doesNotMatch(f.node.textContent, /Try again|Draft not saved/);
  f.state('blocked'); assert.equal(f.reloadButton.disabled, true);
  f.state('ready'); assert.equal(f.reloadButton.disabled, false); f.reloadButton.click(); await settle(); assert.equal(f.reloads, 1);
});

test('the stable polite region announces once per observed identity, not on save state or repeated reads', async t => {
  const f = fixture(t); f.notice.readiness(true); const current = {...loaded, commit: commit('d')}; f.requests[0]?.resolve(snapshot(current)); await settle();
  const region = f.node.children.find(node => node.attributes.get('aria-live') === 'polite'); assert.ok(region);
  assert.equal(region.attributes.get('role'), 'status'); assert.equal(region.attributes.get('aria-atomic'), 'true'); const writes = region.writes;
  f.state('pending'); f.state('ready'); f.tick(); f.requests[1]?.resolve(snapshot(current)); await settle(); assert.equal(region.writes, writes);
  f.tick(); f.requests[2]?.resolve(snapshot({...current, commit: commit('e')})); await settle(); assert.equal(region.writes, writes + 1);
});

test('disconnect aborts health and explicit reload, removes timers, and ignores late results; reconnect reads once', async t => {
  const f = fixture(t); f.notice.readiness(true); f.notice.readiness(true); assert.equal(f.requests.length, 1);
  f.notice.readiness(false); assert.equal(f.requests[0]?.signal.aborted, true); f.requests[0]?.resolve(snapshot({...loaded, commit: commit('d')})); await settle();
  assert.equal(f.node.hidden, true); assert.equal(f.timers.size, 0);
  f.notice.readiness(true); f.requests[1]?.resolve(snapshot({...loaded, commit: commit('d')})); await settle(); assert.equal(f.timers.size, 1);
  let finish!: () => void; f.reload(() => new Promise<void>(resolve => {finish = resolve;})); f.reloadButton.click(); assert.equal(f.reloads, 1); f.reloadButton.click(); assert.equal(f.reloads, 1);
  f.notice.readiness(false); assert.equal(f.reloadSignals[0]?.aborted, true); assert.equal(f.timers.size, 0); finish(); await settle(); assert.equal(f.failures, 0);
  f.notice.readiness(true); assert.equal(f.requests.length, 3); f.notice.destroy(); assert.equal(f.requests[2]?.signal.aborted, true);
  f.requests[2]?.reject(new Error('late')); await settle(); assert.equal(f.timers.size, 0); f.notice.destroy(); f.notice.readiness(true); assert.equal(f.requests.length, 3);
});

test('failed or missing identity reads keep the last observation, and unavailable page identity starts no polling', async t => {
  const f = fixture(t); f.notice.readiness(true); f.requests[0]?.resolve(snapshot({...loaded, commit: commit('d')})); await settle(); const text = f.notice.facts.textContent;
  f.tick(); f.requests[1]?.reject(new Error('unavailable')); await settle(); assert.equal(f.notice.facts.textContent, text);
  f.tick(); f.requests[2]?.resolve({...snapshot(), identity: {iteration: '1.10'}}); await settle(); assert.equal(f.notice.facts.textContent, text);
  const absent = fixture(t, null); absent.notice.readiness(true); assert.equal(absent.requests.length, 0); assert.equal(absent.node.hidden, true);
});
