import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
import {DevReload, type DevBuild, type DevReloadEnvironment, type DevReloadNotice} from './dev-reload.ts';
import type {Factory} from './reload-storage.fixture.mts';
const browser = await createAppFixture();

test('native storage refusal reaches the reload notice and captured page record without losing the local File', async t => {
  const identity = 'diagnostic-agent', target = {kind: 'agent' as const, identity}, workspace = 'diagnostic-workspace';
  await browser.arrive({workspace: {id: workspace, revision: 1, selectedTarget: target}, primaries: [], roster: [browser.agentFixture(identity)],
    targets: [browser.targetFixture('diagnostic-target', target)], observations: [browser.observation(identity, {revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: false}, coverage: browser.coverage}, 2)]});
  browser.app.agentComposer().setText('Retain this synthetic draft.');
  browser.app.agentComposer().addFiles([new File(['retained invalid bytes'], 'retained.png', {type: 'image/png', lastModified: 456})]);
  await browser.settle();
  const storage = globalThis.indexedDB as unknown as Factory, error = new DOMException('Synthetic native storage refusal', 'QuotaExceededError');
  storage.issueFailure = error; t.after(() => {storage.issueFailure = undefined;});
  const notice = new browser.HostNode('span'); notice.setAttribute('role', 'status');
  const generation = 'a'.repeat(64), build: DevBuild = {revision: 1, generation: 'b'.repeat(64), previous: generation, change: 'reload', status: 'ready', code: 'none'};
  let publish: ((data: string) => void) | undefined, last: DevReloadNotice | undefined;
  const env: DevReloadEnvironment = {
    meta: name => name === 'ui-client' ? 'c'.repeat(24) : generation, replaceClient() {}, href: () => `https://ui.invalid/?workspace=${workspace}`, navigate() {assert.fail('Storage failure must retain the document.');},
    events: (_url, receive) => {publish = receive; return {close() {}};},
    fetch: async () => ({ok: true, status: 200, json: async () => ({ok: true, data: {...build, revision: 0, generation}})}),
    prepareStylesheet: async () => {throw new Error('No CSS operation expected.');}, clock: {now: Date.now, set: () => 1, clear() {}},
  };
  const dev = new DevReload({interaction: () => ({revision: 1, safe: true}), drain: browser.app.drainDev, captureCheckpoint: browser.app.captureDevCheckpoint,
    writeCheckpoint() {assert.fail('No checkpoint follows a storage refusal.');}, readCheckpoint: () => null, restoreCheckpoint: async () => false, clearCheckpoint() {}, captureCssState() {}, afterCssApply() {},
    status: value => {last = value; browser.app.renderDevReloadNotice(notice as unknown as HTMLElement, value);}}, env);
  t.after(() => dev.destroy()); await dev.ready; assert.ok(publish); publish(JSON.stringify(build)); await browser.settle();
  assert.equal(last?.code, 'drain'); assert.equal(last?.error?.name, error.name); assert.equal(last?.error?.message, error.message);
  const captured = JSON.parse(JSON.stringify({state: {notices: [{text: notice.textContent, title: Reflect.get(notice, 'title'), hidden: notice.hidden}]}}));
  // The footer shows the action alone; the reason lives in its title and accessible name.
  assert.equal(notice.textContent, 'Retry update'); const retry = notice.querySelector('button'); assert.ok(retry); assert.match(retry.title, /Update unavailable/); assert.match(retry.getAttribute('aria-label') ?? '', /^Retry update\. Update unavailable/);
  assert.ok(captured.state.notices[0].title.includes(error.message)); assert.ok(captured.state.notices[0].title.includes(Reflect.get(error, 'stack')));
  assert.deepEqual(JSON.parse(notice.dataset.reloadError), last?.error);
  assert.equal(browser.agentControl('editor').value, 'Retain this synthetic draft.');
  const snapshots = browser.app.agentComposer().captureReload(), file = snapshots.flatMap(value => value.attachments?.items ?? [])[0]?.file;
  assert.ok(file); assert.equal(await file.text(), 'retained invalid bytes'); assert.equal(file.lastModified, 456);
  assert.equal(storage.transactions.some(tx => tx.operation?.kind === 'delete'), false);
  browser.app.renderDevReloadNotice(notice as unknown as HTMLElement, {state: 'idle', code: 'none', retryable: true});
  assert.equal(notice.dataset.reloadError, undefined); assert.equal(Reflect.get(notice, 'title'), 'idle (none)');
});
