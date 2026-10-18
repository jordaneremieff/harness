import assert from 'node:assert/strict';
import {draftImageFingerprint} from '../shared/api.ts';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { contextMenu } from './context-menu.ts';
import type { ConversationLayout, ProjectedFrame, Target, TargetState, Workspace } from '../shared/api.ts';
import { paneLeaves, movePaneTab, splitPane, activatePaneTab } from './pane-layout.ts';
import { tabKey } from './tabs.ts';
import {readReloadState, deleteReloadState} from './reload-storage.ts';
import type {ComposerReloadState} from './composer.ts';

import {createAppFixture, type Fixture} from './app-fixture.mts';
const source = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const browser = await createAppFixture('application');
const {HostNode, hostDocument, startupMetadata, developmentSources, settle, streamSources, documentDispatches, primaryControl, app, hostSessionStorage, arrive, primaryFixture, HostResizeObserver, byId, flushFrames, targetFixture, twoPanes, agentFixture, observation, entryFixture, messageFixture, textPart, event, singlePane, agentControl, controls, transportLog, host, selectionSaves, documentHandlers, view, snapshotOf, paneNode, imagePart, fixturePreparation, coverage} = browser;
type HostNode = InstanceType<typeof HostNode>;
function messageControl(key: string): HostNode {
  const form = hostDocument.body.querySelector('.composer[data-message-panel="true"]'); assert.ok(form);
  const node = key === 'composer' ? form : form.querySelector(`#${form.id}-${key}`); assert.ok(node, `Missing Message ${key}`); return node;
}
function tabsNode(pane = app.focusedPane): HostNode { const node = paneNode(pane).querySelector('.conversation-tabs'); assert.ok(node); return node; }
function menuNode(): HostNode { const node = hostDocument.body.querySelector('.context-menu'); assert.ok(node); return node; }
function pressContext(target: HostNode): void { target.dispatch('contextmenu', {clientX: 10, clientY: 50}); }

function descendants(node: HostNode): HostNode[] { return [...node.children, ...node.children.flatMap(descendants)]; }

test('initial hidden readiness completes once on reveal without replacing the retained stream', async t => {
  await settle();const initial=streamSources.at(-1);assert.ok(initial);assert.equal(streamSources.length,1);
  for(const meta of startupMetadata)meta.remove();
  t.after(async()=>{pageHidden(false);if(!documentDispatches.includes('ui-ready')){const now=Date.now();t.mock.method(Date,'now',()=>now);let recover:(()=>void)|undefined;const timeout=view.setTimeout;t.mock.method(view,'setTimeout',(run,delay)=>{if(delay===250){recover=run;return -1;}return timeout(run,delay);});initial.onerror?.();assert.ok(recover);recover();await settle();streamSources.at(-1)?.emit('ready',{bootId:'boot'});await settle();}});
  initial.emit('ready',{bootId:'boot'});await settle();pageHidden(false);await settle();
  assert.equal(documentDispatches.filter(name=>name==='ui-ready').length,1);assert.equal(developmentSources.length,0);assert.equal(initial.closed,false);
  const editor=primaryControl('editor'),text=editor.value,count=streamSources.length,before=transportLog.length;editor.setSelectionRange(2,7,'backward');pageHidden(true);await settle();pageHidden(false);await settle();
  assert.equal(streamSources.length,count);assert.equal(initial.closed,false);assert.equal(primaryControl('editor'),editor);assert.equal(editor.value,text);assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,7,'backward']);assert.equal(documentDispatches.filter(name=>name==='ui-ready').length,1);assert.equal(transportLog.slice(before).some(call=>call.path.includes('/inputs')||call.path.endsWith('/start')||call.path==='/api/snapshot'||call.path.startsWith('/api/dev/')),false);
});

test('pane resize notifications defer navigation writes and coalesce into one next frame', async () => {
  await arrive({workspace: {id: 'resize-workspace', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  const observer = HostResizeObserver.instances.find(item => item.observed.has(byId('conversation-panes')));
  const label = tabsNode().children[0]?.querySelector('.tab-label'); assert.ok(observer); assert.ok(label);
  const before = label.writes; app.renderNavigation(); const renderWrites = label.writes - before; assert.ok(renderWrites > 0); flushFrames();
  const writes = label.writes, pending = browser.frames.length;
  observer.callback(); observer.callback();
  assert.equal(label.writes, writes, 'ResizeObserver delivery must not write pane geometry.');
  assert.equal(browser.frames.length, pending + 1, 'Repeated notifications share one next-frame render.');
  flushFrames(); assert.equal(label.writes, writes + renderWrites);
  observer.callback(); assert.equal(label.writes, writes + renderWrites); flushFrames(); assert.equal(label.writes, writes + 2 * renderWrites);
  app.renderNavigation(); assert.equal(label.writes, writes + 3 * renderWrites, 'Explicit navigation remains synchronous.');
});

async function devHookFixture(workspace: string, epoch: number, images: import('../shared/api.ts').DraftImage[] = []): Promise<{primary: TargetState; agent: TargetState}> {
  const identity = `${workspace}-agent`, primary = targetFixture(`${workspace}-primary`, {kind: 'primary', key: 'p', epoch}, {draft: {revision: 3, text: 'Primary private draft', mode: 'steer', persisted: true}, presentation: {revision: 5, expanded: [], showThinking: false, transcriptView: 'chronological'}});
  const agent = targetFixture(`${workspace}-agent`, {kind: 'agent', identity}, {draft: {revision: 3, text: 'Agent private draft', mode: 'prompt', images, persisted: true}, presentation: {revision: 5, expanded: [], showThinking: false, transcriptView: 'chronological'}});
  await arrive({workspace: {id: workspace, revision: 1, primaryKey: 'p', selectedTarget: agent.target, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch})], roster: [agentFixture(identity)], targets: [primary, agent], observations: [observation(identity, {revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: false}, coverage}, 10)], history: Array.from({length: 20}, (_, index) => entryFixture(`dev-history-${index}`, [messageFixture(`dev-message-${index}`, [textPart(`Development history ${index}`)])]))});
  return {primary, agent};
}
function devCheckpoint(): import('./dev-reload.ts').DevReloadCheckpoint {
  return {...app.captureDevCheckpoint(), version: 1, generation: 'a'.repeat(64), oldClient: 'b'.repeat(24), capturedAt: 1, interactionRevision: 0};
}

const attachedImage = (name = 'one.png', digit = 'a'): import('../shared/api.ts').DraftImage => ({name, digest: digit.repeat(64), mimeType: 'image/png', bytes: 67, width: 1, height: 1});
test('development checkpoint rejects changed image order at the same text and revision', async t => {
  assert.equal(browser.hostClosed, false, 'The browser host must remain active after startup.');
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(browser.hostClosed, false, 'The browser host must retain its scheduled work until tests finish.');
  const images = [attachedImage(), attachedImage('two.png', 'b')], saved = await devHookFixture('image-order', 9770, images), checkpoint = devCheckpoint(), original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  assert.equal(checkpoint.targets.find(item => item.targetKey === saved.agent.targetKey)?.imageFingerprint, draftImageFingerprint(images));
  globalThis.fetch = async (input, init) => (init?.method ?? 'GET') === 'GET' && new URL(String(input), 'http://ui.test').pathname.endsWith(`/targets/${saved.agent.targetKey}`)
    ? Response.json({ok: true, data: {...saved.agent, draft: {...saved.agent.draft, images: [...images].reverse()}}}) : original(input, init);
  assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), false); assert.deepEqual(app.agentComposer().state?.draft.images, images);
});
test('Primary image controls follow current model input and exact model-change outcomes', async () => {
  const target = {kind: 'primary' as const, key: 'p', epoch: 9771};
  const primary = primaryFixture({epoch: target.epoch, model: {provider: 'fixture', id: 'image-model', name: 'Image model', reasoning: false, input: ['text', 'image']}});
  await arrive({workspace: {id: 'image-model', revision: 1, primaryKey: 'p', selectedTarget: target}, primaries: [primary], roster: [], targets: [targetFixture('image-model-target', target, {draft: {revision: 2, text: '', mode: 'prompt', images: [attachedImage()], persisted: true}})]});
  assert.equal(primaryControl('send').disabled, false);
  event('primary.state', {...primary, model: {...primary.model, input: ['text']}}); await settle(); assert.equal(primaryControl('send').disabled, false);
  assert.match(primaryControl('composer').querySelector('.attachment-details p')?.textContent ?? '', /current model does not report image input/);
  event('primary.state', primary); await settle(); assert.equal(primaryControl('send').disabled, false);
  const pending = {id: 'model-hold', kind: 'primary.control' as const, action: 'model', target, state: 'uncertain' as const, createdAt: '', updatedAt: ''};
  event('operation.changed', pending); event('primary.state', primary); await settle(); assert.equal(primaryControl('send').disabled, false);
  assert.match(primaryControl('composer').querySelector('.attachment-details p')?.textContent ?? '', /model change is not confirmed/);
  event('operation.changed', {...pending, state: 'rejected'}); event('primary.state', primary); await settle(); assert.equal(primaryControl('send').disabled, false);
  assert.doesNotMatch(primaryControl('composer').querySelector('.attachment-details p')?.textContent ?? '', /model change is not confirmed|current model does not report image input/);
});
test('Agent image controls reject stale capabilities without borrowing transcript or roster state', async () => {
  const target = {kind: 'agent' as const, identity: 'image-agent'}, capabilities = {input: true, images: true, history: true, observe: true};
  await arrive({workspace: {id: 'image-agent-workspace', revision: 1, selectedTarget: target, conversationLayout: singlePane([target])}, primaries: [], roster: [agentFixture(target.identity, {capabilities})], observations: [observation(target.identity, undefined, 10)], targets: [targetFixture('image-agent-target', target, {draft: {revision: 2, text: '', mode: 'prompt', images: [attachedImage()], persisted: true}})]});
  assert.equal(agentControl('send').disabled, false); const epoch = app.state.conversations.get(JSON.stringify(['agent', target.identity]))?.connectionEpoch; assert.ok(epoch);
  const editor = agentControl('editor');
  event('agent.availability', {identity: target.identity, connectionEpoch: epoch, state: 'live', capabilities: {...capabilities, images: false}}); await settle(); assert.equal(agentControl('send').disabled, false);
  assert.equal(app.state.agentAvailability.get(target.identity)?.capabilities.images, false);
  event('agent.availability', {identity: target.identity, connectionEpoch: epoch - 1, state: 'live', capabilities}); await settle(); assert.equal(agentControl('send').disabled, false);
  assert.equal(app.state.agentAvailability.get(target.identity)?.connectionEpoch, epoch); assert.equal(app.state.agentAvailability.get(target.identity)?.capabilities.images, false);
  event('agent.availability', {identity: target.identity, connectionEpoch: epoch + 1, state: 'live', capabilities}); await settle(); assert.equal(agentControl('send').disabled, false);
  assert.equal(app.state.agentAvailability.get(target.identity)?.connectionEpoch, epoch + 1); assert.equal(app.state.agentAvailability.get(target.identity)?.capabilities.images, true);
  assert.equal(agentControl('editor'), editor); assert.deepEqual(app.agentComposer().state?.draft.images, [attachedImage()]);
});
test('development checkpoint captures exact owners and rejects workspace, recipient and revision changes', async t => {
  const saved = await devHookFixture('dev-capture', 9660), original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original; byId('agent-message-close').click();});
  app.focusPane('primary-pane'); await settle(); app.openConversationActions('agent-pane'); const message = menuNode().children.find(node => node.textContent === 'Message'); assert.ok(message); message.click(); await settle();
  const editor = messageControl('editor'); editor.focus(); editor.setSelectionRange(2, 7, 'backward'); const checkpoint = devCheckpoint();
  assert.equal(checkpoint.workspaceId, 'dev-capture'); assert.equal(checkpoint.targets.length, 2); assert.equal(checkpoint.messageRecipient, saved.agent.targetKey); assert.deepEqual(checkpoint.focusedControl, {targetKey: saved.agent.targetKey, kind: 'message'});
  assert.deepEqual(checkpoint.targets.map(entry => entry.targetKey).sort(), [saved.primary.targetKey, saved.agent.targetKey].sort()); assert.doesNotMatch(JSON.stringify(checkpoint), /private draft|Development history/);
  const signal = new AbortController().signal; assert.equal(await app.restoreDevCheckpoint({...checkpoint, workspaceId: 'other-workspace'}, signal), false);
  for (const mismatch of ['draft', 'reading', 'presentation', 'identity', 'unconfirmed'] as const) {
    globalThis.fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'GET' && new URL(String(input), 'http://ui.test').pathname.endsWith(`/targets/${saved.agent.targetKey}`)) {
        const value = browser.fixture.targets?.find(item => item.targetKey === saved.agent.targetKey); assert.ok(value); assert.ok(value.presentation);
        const changed = mismatch === 'identity' ? {...value, target: {kind: 'agent', identity: 'wrong-recipient'}} : mismatch === 'unconfirmed' ? {...value, unconfirmed: [{operationId: 'held'}]} : {...value, [mismatch]: {...value[mismatch], revision: value[mismatch].revision + 1}};
        return Response.json({ok: true, data: changed});
      }
      return original(input, init);
    };
    assert.equal(await app.restoreDevCheckpoint(checkpoint, signal), false); assert.equal(messageControl('editor'), editor); assert.equal(editor.value, 'Agent private draft'); assert.equal(hostDocument.activeElement, editor);
  }
  globalThis.fetch = original; assert.equal(await app.restoreDevCheckpoint({...checkpoint, messageRecipient: saved.primary.targetKey}, signal), false);
  assert.equal(await app.restoreDevCheckpoint(checkpoint, signal), true); assert.equal(messageControl('editor'), editor); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']); assert.deepEqual(app.state.workspace?.selectedTarget, saved.primary.target);
});

test('development restoration accepts a fresh Agent epoch but refuses later epochs and newer buffers during target reads', async t => {
  const saved = await devHookFixture('dev-race', 9661); assert.equal(saved.agent.target.kind, 'agent'); const identity = (saved.agent.target as {identity: string}).identity;
  const checkpoint = devCheckpoint(), original = globalThis.fetch; t.after(async () => {globalThis.fetch = original; await app.drainDev(new AbortController().signal);});
  browser.fixture = {...browser.fixture, observations: [observation(identity, {revision: 2, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: false}, coverage}, 11)]}; await app.reload(); await settle();
  assert.equal(app.state.conversations.get(JSON.stringify(['agent', identity]))?.connectionEpoch, 11); assert.equal(await app.restoreDevCheckpoint(checkpoint, new AbortController().signal), true);
  for (const race of ['epoch', 'draft', 'buffer'] as const) {
    const activeCheckpoint = devCheckpoint();
    const response = Promise.withResolvers<Response>(); const value = browser.fixture.targets?.find(item => item.targetKey === saved.agent.targetKey); assert.ok(value);
    globalThis.fetch = async (input, init) => (init?.method ?? 'GET') === 'GET' && new URL(String(input), 'http://ui.test').pathname.endsWith(`/targets/${saved.agent.targetKey}`) ? response.promise : original(input, init);
    const restore = app.restoreDevCheckpoint(activeCheckpoint, new AbortController().signal); await settle(); const editor = agentControl('editor');
    if (race === 'epoch') {browser.fixture = {...browser.fixture, observations: [observation(identity, {revision: 3, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: false}, coverage}, 12)]}; await app.reload(); await settle();}
    else if (race === 'draft') {const draft = {...value.draft, revision: value.draft.revision + 1, text: 'Newer server draft'}; browser.fixture = {...browser.fixture, targets: browser.fixture.targets?.map(item => item.targetKey === saved.agent.targetKey ? {...item, draft} : item)}; event('draft.changed', {targetKey: saved.agent.targetKey, target: saved.agent.target, draft});}
    else {editor.value = 'Newer local draft'; editor.dispatch('input');}
    const current = app.state.targets.get(saved.agent.targetKey); response.resolve(Response.json({ok: true, data: value})); assert.equal(await restore, false); await settle(); if (race === 'buffer') assert.ok((app.state.targets.get(saved.agent.targetKey)?.draft.revision ?? 0) >= value.draft.revision); else assert.equal(app.state.targets.get(saved.agent.targetKey), current);
    if (race === 'epoch') assert.equal(app.state.conversations.get(JSON.stringify(['agent', identity]))?.connectionEpoch, 12);
    else if (race === 'draft') {assert.equal(editor.value, 'Newer server draft'); assert.equal(app.state.targets.get(saved.agent.targetKey)?.draft.text, 'Newer server draft');}
    else assert.equal(editor.value, 'Newer local draft');
    globalThis.fetch = original;
  }
});

test('development drain preserves exact local draft bytes after view preferences and selection settle', async t => {
  const saved = await devHookFixture('dev-drain', 9662); const primary = app.primaryComposer(), agent = app.agentComposer(), p = controls(primary), a = controls(agent), original = globalThis.fetch;
  const held: {path: string; finish: () => Promise<void>}[] = []; let holding = true;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname;
    if (holding && init?.method === 'PUT' && /\/(draft|reading|presentation|selection)$/.test(path)) {const response = Promise.withResolvers<Response>(); assert.ok(held.length < 8); let finished = false; held.push({path, finish: async () => {if (finished) return; finished = true; response.resolve(await original(input, init));}}); return response.promise;}
    return original(input, init);
  };
  t.after(async () => {holding = false; await Promise.all(held.map(item => item.finish())); globalThis.fetch = original; await app.drainDev(new AbortController().signal); const key = app.captureDevCheckpoint().composerStateKey; if (key) await deleteReloadState(key);});
  const before = transportLog.length, pe = p('editor'), ae = a('editor'); pe.value = 'Primary queued draft'; pe.dispatch('input'); ae.value = 'Agent queued draft'; ae.dispatch('input');
  pe.setSelectionRange(2, 7, 'backward'); pe.dispatch('select'); ae.setSelectionRange(1, 6, 'forward'); ae.dispatch('select');
  const scroller = p('transcript'); scroller.scrollTop = 180; scroller.dispatch('scroll'); flushFrames(); scroller.dispatch('scrollend');
  app.openConversationActions('primary-pane'); const grouped = menuNode().children.find(node => node.textContent === 'Grouped'); assert.ok(grouped); grouped.click(); await settle();
  app.applyLayout(singlePane()); await settle(); assert.equal(agent.canDispose, false);
  const aborted = new AbortController(); aborted.abort(new Error('Drain cancelled')); await assert.rejects(app.drainDev(aborted.signal), /Drain cancelled/);
  let done = false; const drain = app.drainDev(new AbortController().signal).then(() => {done = true;}); await settle(); assert.equal(done, false);
  const selection = held.find(item => item.path.endsWith('/selection')); assert.ok(selection); await selection.finish(); await settle(); assert.equal(done, false);
  const drafts = held.filter(item => item.path.endsWith('/draft')); assert.equal(drafts.length, 2); assert.ok(held.some(item => item.path.endsWith('/reading'))); assert.ok(held.some(item => item.path.endsWith('/presentation')));
  holding = false; await Promise.all(held.filter(item => item !== selection && !drafts.includes(item)).map(item => item.finish())); await drain; await settle();
  assert.equal(done, true); assert.equal(primary.unsaved, true); assert.equal(agent.unsaved, true);
  const key = app.captureDevCheckpoint().composerStateKey; assert.ok(key);
  const preserved = await readReloadState(key, new AbortController().signal); assert.ok(Array.isArray(preserved));
  const records = preserved as ComposerReloadState[]; assert.equal(records.length, 2);
  for (const [owner, text, start, end, direction] of [[saved.primary, pe.value, 2, 7, 'backward'], [saved.agent, ae.value, 1, 6, 'forward']] as const) {
    const record = records.find(item => item.targetKey === owner.targetKey); assert.ok(record);
    assert.equal(record.workspace, 'dev-drain'); assert.deepEqual(record.target, owner.target); assert.equal(record.data.text, text); assert.equal(record.data.mode, owner.draft.mode); assert.deepEqual(record.data.images, owner.draft.images);
    assert.deepEqual(record.selection && [record.selection.start, record.selection.end, record.selection.direction], [start, end, direction]);
  }
  assert.equal(p('editor'), pe); assert.equal(a('editor'), ae); assert.equal(pe.value, 'Primary queued draft'); assert.equal(ae.value, 'Agent queued draft'); assert.equal(app.selectionQueue.unsettled, false);
  assert.equal(transportLog.slice(before).some(call => call.path.includes('/inputs') || call.path.endsWith('/start')), false);
  await Promise.all(drafts.map(item => item.finish())); await settle();
  assert.equal(primary.unsaved, false); assert.equal(agent.unsaved, false); assert.equal(pe.value, 'Primary queued draft'); assert.equal(ae.value, 'Agent queued draft'); assert.equal(p('editor'), pe); assert.equal(a('editor'), ae); assert.equal(app.selectionQueue.unsettled, false);
});

test('development CSS hooks retain cards, editors, carets and the same reading anchor', async () => {
  await devHookFixture('dev-css', 9663); const p=controls(app.primaryComposer()),a=controls(app.agentComposer()),pe=p('editor'),ae=a('editor'),forms=[p('composer'),a('composer')],root=p('transcript');
  root.scrollTop=857;root.dispatch('scroll');flushFrames();const card=root.querySelector('[data-entry-id="dev-history-6"]'),before=root.querySelector('[data-entry-id="dev-history-5"]');assert.ok(card);assert.ok(before);
  root.scrollTop=card.offsetTop-root.offsetTop+17;root.dispatch('scroll');root.dispatch('scrollend');await settle();pe.focus();pe.setSelectionRange(2,7,'backward');ae.setSelectionRange(1,6,'forward');
  const offset=root.scrollTop-(card.offsetTop-root.offsetTop),captured=app.captureDevCssState();(before.style as {height?:string}).height='260px';app.applyDevCssState(captured);await settle();
  assert.equal(root.querySelector('[data-entry-id="dev-history-6"]'),card);assert.equal(root.scrollTop-(card.offsetTop-root.offsetTop),offset);assert.equal(p('editor'),pe);assert.equal(a('editor'),ae);assert.equal(p('composer'),forms[0]);assert.equal(a('composer'),forms[1]);
  assert.deepEqual([pe.selectionStart,pe.selectionEnd,pe.selectionDirection],[2,7,'backward']);assert.deepEqual([ae.selectionStart,ae.selectionEnd,ae.selectionDirection],[1,6,'forward']);assert.equal(pe.value,'Primary private draft');assert.equal(ae.value,'Agent private draft');assert.equal(hostDocument.activeElement,pe);
});

test('shell element references match the shared DOM contract', () => {
  for (const match of source.matchAll(/byId(?:<[^>]+>)?\('([^']+)'\)/g)) assert.ok(html.includes(`id="${match[1]}"`), `Missing ${match[1]}`);
  assert.doesNotMatch(source, /byId\('(?:agent-panel|agents-button|agent-back|agent-close|agent-detail-close)'\)/);
  assert.match(source, /commands: \(\) => actions\.commandOptions\(\)/);
});
test('section changes hide retained nodes and explicit skip navigation focuses the selected editor', async () => {
  const row = agentFixture('skip-agent'); await arrive({workspace: {id:'w',revision:1,primaryKey:'p',conversationLayout:singlePane([{kind:'primary'},{kind:'agent',identity:row.identity}])},primaries:[primaryFixture({epoch:700})],roster:[row]});
  const primary=controls(app.primaryComposer()),root=primary('root'),editor=primary('editor'); await app.selectAgent(row); await settle();
  assert.equal(root.hidden,true); byId('skip-composer').click(); assert.equal(hostDocument.activeElement,agentControl('editor'));
  byId('primary-row').click(); await settle(); byId('skip-composer').click(); assert.equal(primaryControl('root'),root); assert.equal(primaryControl('editor'),editor); assert.equal(root.hidden,false); assert.equal(hostDocument.activeElement,editor);
});
test('an initial Primary history error keeps one summary, exact detail and a read-only retry row', async t => {
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  const target = {kind: 'primary' as const, key: 'p', epoch: 9801}, diagnostic = 'history operation failed at host endpoint';
  let failed = true; const calls: Array<[string, string]> = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname; calls.push([init?.method ?? 'GET', path]);
    return path === '/api/primaries/p/history' ? failed ? Response.json({ok: false, error: {code: 'host_unavailable', message: diagnostic, retry: 'read'}}) : Response.json({ok: true, data: {target, items: [], nextCursor: null, coverage}}) : original(input, init);
  };
  await arrive({workspace: {id: 'primary-read-failure', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: []});
  const notice = primaryControl('view-notice'), actions = notice.querySelector('.history-actions'); assert.ok(actions);
  assert.equal(notice.children.length, 2); assert.equal(notice.children[0]?.textContent, 'History could not be loaded.');
  assert.equal(actions.children.length, 2); assert.equal(actions.querySelector('pre')?.textContent, diagnostic);
  const retry = actions.querySelector('button'); assert.ok(retry); assert.equal(retry.getAttribute('aria-label'), 'Retry history');
  const editor = primaryControl('editor'), before = calls.length; failed = false; retry.click(); await settle();
  assert.deepEqual(calls.slice(before), [['GET', '/api/primaries/p/history']]); assert.equal(primaryControl('editor'), editor); assert.equal(notice.textContent, '');
});

test('failed Message preparation and technical availability reasons stay in exact details through retry', async t => {
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original; byId('agent-message-close').click();});
  const a = agentFixture('message-error-main', {modifiedAt: Date.now()}), b = agentFixture('message-error-recipient', {modifiedAt: Date.now()});
  const targetA = {kind: 'agent' as const, identity: a.identity}, targetB = {kind: 'agent' as const, identity: b.identity};
  const savedA = targetFixture('message-error-main', targetA, {draft: {revision: 4, text: 'Main draft stays', mode: 'prompt', persisted: true}});
  const savedB = targetFixture('message-error-recipient', targetB, {draft: {revision: 4, text: 'Recipient draft stays', mode: 'followUp', persisted: true}});
  const diagnostic = 'connect ENOENT /fixture/pi-hosts/unavailable.sock', reason = 'task-submit/1.2.0 endpoint does not support input';
  let phase: 'ready' | 'failed' | 'reason' = 'ready'; const preparations: Target[] = [];
  globalThis.fetch = async (input, init) => {
    if (!new URL(String(input), 'http://ui.test').pathname.endsWith('/targets') || init?.method !== 'POST') return original(input, init);
    const target = JSON.parse(String(init.body)).target;
    if (target.identity !== b.identity) return original(input, init);
    preparations.push(target);
    if (phase === 'failed') return Response.json({ok: false, error: {code: 'host_unavailable', message: diagnostic, retry: 'manual'}});
    const ready = phase === 'ready';
    return Response.json({ok: true, data: {targetState: savedB, availability: ready ? 'live' : 'incompatible', capabilities: {input: ready}, reason: ready ? undefined : reason}});
  };
  await arrive({workspace: {id: 'message-errors', revision: 1, selectedTarget: targetA, conversationLayout: singlePane([{kind: 'agent', identity: a.identity}, {kind: 'agent', identity: b.identity}], `agent:${a.identity}`)}, primaries: [], roster: [a, b], targets: [savedA, savedB]});
  const message = byId('roster').querySelector(`[data-identity="${b.identity}"]`)?.querySelector('.row-message'); assert.ok(message);
  message.click(); await settle(); const editor = messageControl('editor'); editor.setSelectionRange(2, 7);
  byId('agent-message-close').click(); await settle(); const main = agentControl('editor'); main.setSelectionRange(1, 4);
  const before = transportLog.length; phase = 'failed'; message.click(); await settle();
  const status = byId('agent-message-status'); assert.equal(status.textContent, 'Message connection is unavailable. Your draft is unchanged.'); assert.equal(status.title, diagnostic);
  assert.doesNotMatch(byId('agent-message-panel').textContent, /ENOENT|unavailable\.sock/); assert.equal(messageControl('editor'), editor); assert.equal(editor.value, savedB.draft.text); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]);
  assert.equal(messageControl('send').disabled, false); assert.equal(messageControl('stop').hidden, true); assert.equal(byId('agent-message-retry').textContent, 'Try again');
  phase = 'reason'; byId('agent-message-retry').click(); await settle(); assert.equal(status.textContent, 'Agent connection is unavailable.'); assert.equal(status.title, reason);
  assert.doesNotMatch(byId('agent-message-panel').textContent, /task-submit/); assert.equal(byId('agent-message-retry').textContent, 'Check agent'); assert.equal(messageControl('send').disabled, false);
  phase = 'ready'; byId('agent-message-retry').click(); await settle(); assert.equal(status.textContent, ''); assert.equal(status.title, ''); assert.equal(messageControl('send').disabled, false);
  assert.deepEqual(preparations, [targetB, targetB, targetB, targetB]); assert.deepEqual(app.state.workspace?.selectedTarget, targetA); assert.equal(agentControl('editor'), main); assert.equal(main.value, savedA.draft.text); assert.deepEqual([main.selectionStart, main.selectionEnd], [1, 4]);
  assert.equal(messageControl('editor'), editor); assert.equal(editor.value, savedB.draft.text); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]);
  assert.equal(transportLog.slice(before).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
});

test('Primary reload keeps an inactive live claim unchecked until exact Message negotiation', async t => {
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  const b = agentFixture('reload-claim'), target = {kind: 'agent' as const, identity: b.identity}, saved = targetFixture('reload-claim', target);
  const layout = singlePane([{kind: 'primary'}, {kind: 'agent', identity: b.identity}], 'primary');
  await arrive({workspace: {id: 'reload-claim-workspace', revision: 1, primaryKey: 'p', conversationLayout: layout}, primaries: [primaryFixture({epoch: 9808})], roster: [b], targets: [targetFixture('reload-primary', {kind: 'primary', key: 'p', epoch: 9808}), saved], confirmed: false});
  assert.match(tabsNode().querySelector('[data-tab-key="agent:reload-claim"]')?.title ?? '', /Running/);
  await app.reload(); await settle();
  assert.match(tabsNode().querySelector('[data-tab-key="agent:reload-claim"]')?.title ?? '', /Running/);
  const row = byId('roster').querySelector('[data-identity="reload-claim"]'); assert.ok(row);
  assert.equal(row.querySelector('.row-state')?.hidden, true); assert.match(row.querySelector('.row-select')?.getAttribute('aria-label') ?? '', /Running/);
  const before = transportLog.length;
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname.endsWith('/targets') && init?.method === 'POST' ? Response.json({ok: true, data: {targetState: saved, availability: 'unavailable', capabilities: {history: true, observe: false, input: false, abort: false, configure: false}, reason: 'Claim socket is absent'}}) : original(input, init);
  const message = byId('roster').querySelector('[data-identity="reload-claim"]')?.querySelector('.row-message'); assert.ok(message); message.click(); await settle();
  assert.equal(messageControl('send').disabled, true); assert.match(tabsNode().querySelector('[data-tab-key="agent:reload-claim"]')?.title ?? '', /Read only/);
  assert.equal(row.querySelector('.row-state')?.hidden, false); assert.equal(row.querySelector('.row-state')?.textContent, 'Read only');
  assert.doesNotMatch(byId('workbench-status-agent').textContent, /Connected|Ready/); assert.equal(app.state.workspace?.primaryKey, 'p');
  assert.equal(transportLog.slice(before).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
  byId('agent-message-close').click(); await settle();
});

test('Message negotiation overrides a claim across main selection, panel close, availability and reconnect', async t => {
  const original = globalThis.fetch, recovery = preparationRecovery(); t.after(async () => {globalThis.fetch = original; byId('agent-message-close').click(); await recovery.dispose();});
  const a = agentFixture('negotiated-a'), b = agentFixture('claimed-b'), targetA = {kind: 'agent' as const, identity: a.identity}, targetB = {kind: 'agent' as const, identity: b.identity};
  const savedA = targetFixture('negotiated-a', targetA), savedB = targetFixture('claimed-b', targetB, {draft: {revision: 4, text: 'Retained B draft', mode: 'followUp', persisted: true}});
  const capabilities = {history: true, observe: false, input: false, abort: false, configure: false}; let ready = false;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname;
    const connection = ready ? {availability: 'live', capabilities: b.capabilities} : {availability: 'unavailable', capabilities, reason: 'Claim endpoint is unavailable'};
    if (path === `/api/agents/${b.identity}/history`) return Response.json({ok: true, data: {target: targetB, entries: [entryFixture('retained-b', [messageFixture('retained-b-message', [textPart('Saved B history')])])], nextBefore: null, coverage, revision: 'r'}});
    if (path.endsWith('/targets') && init?.method === 'POST' && JSON.parse(String(init.body)).target?.identity === b.identity) {
      if (ready) event('agent.availability', {identity: b.identity, connectionEpoch: (app.state.agentEpochs.get(b.identity) ?? 0) + 1, state: 'live', capabilities: b.capabilities});
      return Response.json({ok: true, data: {targetState: savedB, ...connection}});
    }
    return original(input, init);
  };
  const layout = singlePane([{kind: 'agent', identity: a.identity}, {kind: 'agent', identity: b.identity}], `agent:${b.identity}`);
  await arrive({workspace: {id: 'negotiation-owner', revision: 1, selectedTarget: targetB, conversationLayout: layout}, primaries: [], roster: [a, b], targets: [savedA, savedB]});
  event('agent.availability', {identity: b.identity, connectionEpoch: 1, state: 'unavailable', capabilities, reason: 'Claim endpoint is unavailable'}); await settle();
  const editor = agentControl('editor'); editor.setSelectionRange(2, 7); assert.match(agentControl('root').textContent, /Saved B history/);
  app.applyLayout(activatePaneTab(layout, 'pane-1', `agent:${a.identity}`)); await app.selectionQueue.drain(); await settle();
  const before = transportLog.length, message = byId('roster').querySelector(`[data-identity="${b.identity}"]`)?.querySelector('.row-message'); assert.ok(message); message.click(); await settle();
  assert.equal(byId('agent-message-status').textContent, 'Agent connection is unavailable.'); assert.equal(messageControl('send').disabled, true);
  assert.match(tabsNode().querySelector(`[data-tab-key="agent:${b.identity}"]`)?.title ?? '', /Read only/); assert.doesNotMatch(byId('workbench-status-agent').textContent, /Connected|Ready/);
  assert.equal(messageControl('editor'), editor); assert.equal(editor.value, savedB.draft.text); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]); assert.deepEqual(app.state.workspace?.selectedTarget, targetA);
  byId('agent-message-close').click(); await settle(); await app.reload(); await settle();
  assert.match(tabsNode().querySelector(`[data-tab-key="agent:${b.identity}"]`)?.title ?? '', /Read only/);
  app.applyLayout(activatePaneTab(app.state.workspace?.conversationLayout ?? layout, 'pane-1', `agent:${b.identity}`)); await app.selectionQueue.drain(); await settle();
  event('agent.availability', {identity: b.identity, connectionEpoch: 2, state: 'live', capabilities: b.capabilities}); await settle();
  assert.equal(agentControl('send').disabled, false); assert.match(tabsNode().querySelector(`[data-tab-key="agent:${b.identity}"]`)?.title ?? '', /Connected|Ready/);
  ready = true; await app.checkAgentConnection('negotiation-owner', b.identity); await settle();
  assert.equal(agentControl('send').disabled, false); assert.match(tabsNode().querySelector(`[data-tab-key="agent:${b.identity}"]`)?.title ?? '', /Connected|Ready/);
  event('agent.availability', {identity: b.identity, connectionEpoch: app.state.agentEpochs.get(b.identity), state: 'unavailable', capabilities, reason: 'Connection closed'}); await settle();
  assert.equal(agentControl('send').disabled, true); assert.match(tabsNode().querySelector(`[data-tab-key="agent:${b.identity}"]`)?.title ?? '', /Read only/);
  await app.checkAgentConnection('negotiation-owner', b.identity); await settle(); assert.equal(agentControl('send').disabled, false);
  await recovery.disconnect(); assert.equal(agentControl('send').disabled, false); assert.doesNotMatch(tabsNode().querySelector(`[data-tab-key="agent:${b.identity}"]`)?.title ?? '', /Connected|Ready/);
  await recovery.recover(); assert.equal(agentControl('send').disabled, false);
  await app.checkAgentConnection('negotiation-owner', b.identity); await settle(); assert.equal(agentControl('send').disabled, false);
  assert.equal(agentControl('editor'), editor); assert.equal(editor.value, savedB.draft.text); assert.match(agentControl('root').textContent, /Saved B history/);
  assert.equal(transportLog.slice(before).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
  await arrive({workspace: {id: 'different-negotiation-owner', revision: 1, selectedTarget: targetB, conversationLayout: singlePane([{kind: 'agent', identity: b.identity}])}, primaries: [], roster: [agentFixture(b.identity, {availability: 'stored', capabilities})], targets: [targetFixture('different-owner-b', targetB)]});
  assert.equal(agentControl('send').disabled, true); assert.doesNotMatch(tabsNode().querySelector(`[data-tab-key="agent:${b.identity}"]`)?.title ?? '', /Connected|Ready/);
});

function preparationRecovery() {
  const set = view.setTimeout, clear = view.clearTimeout;
  const queued = new Map<number, {delay: number; run: () => void}>();
  let serial = 0, lost = false, attempted = false;
  view.setTimeout = (run, delay = 0) => {
    if (delay > 0 && delay <= 750) {const id = --serial; queued.set(id, {delay, run}); return id;}
    return set(run, delay);
  };
  view.clearTimeout = id => {if (typeof id === 'number' && id < 0) queued.delete(id); else clear(id);};
  const attempt = async () => {
    if (!lost || attempted) return;
    const next = [...queued].find(([, item]) => item.delay <= 250); assert.ok(next, 'A lost stream must schedule its bounded recovery.');
    queued.delete(next[0]); attempted = true; next[1].run(); await settle();
  };
  const ready = async () => {
    const fresh = streamSources.at(-1); assert.ok(fresh); assert.equal(fresh.closed, false);
    fresh.emit('ready', {bootId: 'boot'}); await settle(); lost = false;
  };
  const recover = async () => {pageHidden(false); await settle(); if (!lost) return; await attempt(); await ready();};
  return {
    async disconnect() {const old = streamSources.at(-1); assert.ok(old); lost = true; attempted = false; old.onerror?.(); await settle(); return old;},
    attempt, ready, recover,
    queued,
    async dispose() {try {await recover();} finally {queued.clear(); view.setTimeout = set; view.clearTimeout = clear;}},
  };
}
type PreparationRecovery = ReturnType<typeof preparationRecovery>;
async function restorePreparationConnection(recovery: PreparationRecovery): Promise<void> {await recovery.recover();}
async function interruptPreparation(mode: string, recovery: PreparationRecovery): Promise<void> {
  if (mode === 'suspend') pageHidden(true);
  else {await recovery.disconnect(); if (mode === 'reconnect') await restorePreparationConnection(recovery);}
  await settle();
}
async function latePreparationFixture(surface: string, mode: string, t: {after: (fn: () => Promise<void>) => void}) {
  const original = globalThis.fetch, pending = Promise.withResolvers<Response>(), recovery = preparationRecovery(); let held = true, requests = 0;
  const prefix = `late-${surface}-${mode}`, a = agentFixture(`${prefix}-a`), b = agentFixture(`${prefix}-b`);
  const targetA = {kind: 'agent' as const, identity: a.identity}, targetB = {kind: 'agent' as const, identity: b.identity};
  const savedA = targetFixture(`${prefix}-a`, targetA, {draft: {revision: 4, text: 'Keep A draft', mode: 'prompt', persisted: true}}), savedB = targetFixture(`${prefix}-b`, targetB, {draft: {revision: 4, text: 'Keep B draft', mode: 'followUp', persisted: true}});
  const response = () => Response.json({ok: true, data: {targetState: savedB, availability: 'live', capabilities: b.capabilities}});
  t.after(async () => {held = false; pending.resolve(response()); globalThis.fetch = original; byId('agent-message-close').click(); await settle(); await recovery.dispose();});
  const selected = surface === 'Message' ? targetA : targetB, layout = singlePane([{kind: 'agent', identity: a.identity}, {kind: 'agent', identity: b.identity}], `agent:${b.identity}`);
  await arrive({workspace: {id: prefix, revision: 1, selectedTarget: targetB, conversationLayout: layout}, primaries: [], roster: [a, b], targets: [savedA, savedB], confirmed: false});
  if (surface === 'Message') {app.applyLayout(activatePaneTab(layout, 'pane-1', `agent:${a.identity}`)); await app.selectionQueue.drain(); await settle();}
  const mainEditor = agentControl('editor'); mainEditor.setSelectionRange(1, 5, 'backward');
  const before = transportLog.length;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname;
    if (path.endsWith('/targets') && init?.method === 'POST' && JSON.parse(String(init.body)).target?.identity === b.identity) {
      requests++; browser.fixture = {...browser.fixture, targets: [savedA, savedB]}; if (held) return pending.promise;
      if (surface === 'main') event('agent.availability', {identity: b.identity, connectionEpoch: (app.state.agentEpochs.get(b.identity) ?? 0) + 1, state: 'live', capabilities: b.capabilities});
      return response();
    }
    return original(input, init);
  };
  if (surface === 'Message') {
    const message = byId('roster').querySelector(`[data-identity="${b.identity}"]`)?.querySelector('.row-message'); assert.ok(message); message.click();
  } else {browser.fixture = {...browser.fixture, targets: [savedA]}; app.state.targets.delete(savedB.targetKey); app.focusPane(app.focusedPane); await app.selectionQueue.drain();}
  await settle(); const control = surface === 'Message' ? messageControl : agentControl, editor = control('editor'); editor.setSelectionRange(2, 6, 'backward');
  return {prefix, b, selected, savedA, savedB, mainEditor, control, editor, before, recovery, requests: () => requests, resolve: () => pending.resolve(response()), reject: () => pending.resolve(Response.json({ok: false, error: {code: 'host_unavailable', message: 'Obsolete connection failure', retry: 'manual'}})), fresh: async () => {
    held = false; if (surface === 'Message') byId('agent-message-retry').click(); else await app.checkAgentConnection(prefix, b.identity); await settle();
  }};
}
for (const surface of ['Message', 'main']) for (const mode of ['disconnect', 'reconnect', 'suspend']) test(`pending ${surface} preparation ${mode === 'suspend' ? 'retains its current result while hidden' : `cannot restore connection after ${mode}`}`, async t => {
  const f = await latePreparationFixture(surface, mode, t); assert.equal(f.requests(), 1);
  const currentSource = streamSources.at(-1), beforeInterrupt = transportLog.length;
  await interruptPreparation(mode, f.recovery); assert.equal(f.control('send').disabled, false);
  if (surface === 'Message' && mode === 'reconnect') assert.equal(f.requests(), 1);
  f.resolve(); await settle();
  if (mode === 'suspend') {
    assert.equal(hostDocument.hidden, true); assert.equal(streamSources.at(-1), currentSource); assert.equal(currentSource?.closed, false);
    assert.equal(f.requests(), 1); assert.match(tabsNode().querySelector(`[data-tab-key="agent:${f.b.identity}"]`)?.title ?? '', /Connected|Ready/);
    assert.equal(transportLog.slice(beforeInterrupt).some(call => call.path.endsWith('/targets') || call.path.includes('/inputs') || call.path.endsWith('/start')), false);
    if (surface === 'Message') assert.equal(byId('agent-message-status').textContent, '');
    pageHidden(false); await settle(); assert.equal(f.requests(), 1);
  } else {
    const unchecked = () => {assert.doesNotMatch(tabsNode().querySelector(`[data-tab-key="agent:${f.b.identity}"]`)?.title ?? '', /Connected|Ready|Working/); assert.equal(f.control('send').disabled, false);};
    unchecked(); if (mode !== 'reconnect') await restorePreparationConnection(f.recovery); unchecked(); assert.equal(f.requests(), 1);
    await f.fresh(); assert.equal(f.requests(), 2); assert.equal(f.control('send').disabled, false);
  }
  assert.equal(f.control('editor'), f.editor); assert.equal(f.editor.value, f.savedB.draft.text); assert.deepEqual([f.editor.selectionStart, f.editor.selectionEnd, f.editor.selectionDirection], [2, 6, 'backward']);
  assert.deepEqual(app.state.workspace?.selectedTarget, f.selected); assert.equal(app.state.workspace?.id, f.prefix);
  if (surface === 'Message') {assert.equal(agentControl('editor'), f.mainEditor); assert.equal(f.mainEditor.value, f.savedA.draft.text); assert.deepEqual([f.mainEditor.selectionStart, f.mainEditor.selectionEnd, f.mainEditor.selectionDirection], [1, 5, 'backward']);}
  assert.equal(transportLog.slice(f.before).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
});
test('a rejected Message preparation from the retired stream keeps the lifetime recovery reason', async t => {
  const f = await latePreparationFixture('Message', 'retired-error', t); await interruptPreparation('reconnect', f.recovery);
  f.reject(); await settle(); assert.equal(f.control('send').disabled, false);
  assert.match(byId('agent-message-status').title, /browser connection changed/); assert.doesNotMatch(byId('agent-message-status').title, /Obsolete connection failure/);
  assert.equal(byId('agent-message-retry').textContent, 'Check agent');
  await f.fresh(); assert.equal(f.control('send').disabled, false); assert.equal(f.editor.value, f.savedB.draft.text);
});

test('fresh Message preparation supersedes a pending failure from the retired stream', async t => {
  const f = await latePreparationFixture('Message', 'rejected', t);
  await interruptPreparation('reconnect', f.recovery); await f.fresh(); assert.equal(f.requests(), 2); assert.equal(f.control('send').disabled, false);
  f.reject(); await settle(); assert.equal(f.control('send').disabled, false); assert.equal(byId('agent-message-status').textContent, '');
  assert.match(tabsNode().querySelector(`[data-tab-key="agent:${f.b.identity}"]`)?.title ?? '', /Connected|Ready/);
  assert.equal(f.control('editor'), f.editor); assert.equal(f.editor.value, f.savedB.draft.text); assert.deepEqual([f.editor.selectionStart, f.editor.selectionEnd, f.editor.selectionDirection], [2, 6, 'backward']);
});

test('an obsolete Message completion cannot replace another recipient in another workspace', async t => {
  const f = await latePreparationFixture('Message', 'owner', t); await restorePreparationConnection(f.recovery);
  const c = agentFixture('late-new-c'), targetC = {kind: 'agent' as const, identity: c.identity}, savedC = targetFixture('late-new-c', targetC, {draft: {revision: 5, text: 'Keep new C draft', mode: 'followUp', persisted: true}});
  await arrive({workspace: {id: 'late-new-owner', revision: 1, selectedTarget: f.selected}, primaries: [], roster: [agentFixture(f.selected.identity), c], targets: [f.savedA, savedC], confirmed: false});
  byId('roster').querySelector('[data-identity="late-new-c"]')?.querySelector('.row-message')?.click(); await settle(); const editor = messageControl('editor'); editor.setSelectionRange(1, 4, 'backward');
  f.resolve(); await settle(); assert.equal(app.state.workspace?.id, 'late-new-owner'); assert.deepEqual(app.state.workspace?.selectedTarget, f.selected);
  assert.equal(messageControl('editor'), editor); assert.equal(editor.value, savedC.draft.text); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [1, 4, 'backward']);
  assert.equal(f.editor.value, f.savedB.draft.text); assert.deepEqual([f.editor.selectionStart, f.editor.selectionEnd, f.editor.selectionDirection], [2, 6, 'backward']); assert.equal(app.state.targets.has(f.savedB.targetKey), false);
});

test('Primary preparation errors clear after fresh preparation or snapshot restoration', async t => {
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  const diagnostic = 'connect ENOENT /fixture/primary-endpoint.sock', target = {kind: 'primary' as const, key: 'p', epoch: 9802};
  for (const recovery of ['prepare', 'snapshot']) {
    const saved = targetFixture('prepare-primary-error', target, {draft: {revision: 4, text: 'Retained Primary draft', mode: 'prompt', persisted: true}});
    await arrive({workspace: {id: `prepare-primary-error-${recovery}`, revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: [], targets: [saved]});
    const editor = primaryControl('editor'); browser.fixture = {...browser.fixture, targets: []};
    globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname.endsWith('/targets') && init?.method === 'POST' ? Response.json({ok: false, error: {code: 'host_unavailable', message: diagnostic, retry: 'manual'}}) : original(input, init);
    app.state.targets.clear(); app.focusPane(app.focusedPane); await app.selectionQueue.drain(); await settle();
    const notice = primaryControl('view-notice'), caption = notice.querySelector('.preparation-error'); assert.ok(caption);
    assert.equal(notice.textContent, 'Conversation could not be prepared.'); assert.equal(caption.title, diagnostic); assert.equal(notice.title, ''); assert.doesNotMatch(notice.textContent, /ENOENT|endpoint/);
    globalThis.fetch = original; browser.fixture = {...browser.fixture, targets: [saved]}; const beforeRetry = transportLog.length;
    if (recovery === 'snapshot') await app.reload(); else app.focusPane(app.focusedPane);
    await app.selectionQueue.drain(); await settle();
    const retries = transportLog.slice(beforeRetry).filter(call => call.method === 'POST' && call.path.endsWith('/targets'));
    assert.equal(retries.length, recovery === 'prepare' ? 1 : 0); assert.ok(retries.every(call => JSON.stringify(call.body) === JSON.stringify({target})));
    assert.equal(notice.textContent, ''); assert.equal(notice.title, ''); assert.equal(caption.parentNode, null); assert.equal(notice.querySelector('.preparation-error'), null);
    assert.equal(primaryControl('editor'), editor); assert.equal(editor.value, saved.draft.text); assert.equal(editor.disabled, false);
  }
});

test('a late Primary preparation failure does not restore an obsolete caption after snapshot recovery', async t => {
  const original = globalThis.fetch; let complete!: (response: Response) => void, preparations = 0;
  const pending = new Promise<Response>(resolve => {complete = resolve;});
  t.after(() => {globalThis.fetch = original; complete(Response.json({ok: false, error: {code: 'host_unavailable', message: 'Late preparation failure', retry: 'manual'}}));});
  const target = {kind: 'primary' as const, key: 'p', epoch: 9806}, saved = targetFixture('late-primary-preparation', target, {draft: {revision: 3, text: 'Retained recovered draft', mode: 'prompt', persisted: true}});
  await arrive({workspace: {id: 'late-primary-preparation', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: [], targets: [saved]});
  const editor = primaryControl('editor'); browser.fixture = {...browser.fixture, targets: []};
  globalThis.fetch = async (input, init) => {if (new URL(String(input), 'http://ui.test').pathname.endsWith('/targets') && init?.method === 'POST') {preparations++; browser.fixture = {...browser.fixture, targets: [saved]}; return pending;} return original(input, init);};
  app.state.targets.clear(); app.focusPane(app.focusedPane); await app.selectionQueue.drain(); await settle(); assert.equal(preparations, 1);
  browser.fixture = {...browser.fixture, targets: [saved]}; await app.reload(); await settle();
  complete(Response.json({ok: false, error: {code: 'host_unavailable', message: 'Late preparation failure', retry: 'manual'}})); await settle();
  const notice = primaryControl('view-notice'); assert.equal(notice.textContent, ''); assert.equal(notice.title, ''); assert.equal(notice.querySelector('.preparation-error'), null);
  assert.equal(primaryControl('editor'), editor); assert.equal(editor.value, saved.draft.text); assert.equal(editor.disabled, false); assert.equal(preparations, 1);
});

test('roster refresh failure keeps the exact error behind Details and retains Refresh', async t => {
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  const diagnostic = 'connect ENOENT /fixture/roster-endpoint.sock';
  await arrive({workspace: {id: 'roster-refresh-error', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: 9803})], roster: []});
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname === '/api/agents/refresh' ? Response.json({ok: false, error: {code: 'host_unavailable', message: diagnostic, retry: 'manual'}}) : original(input, init);
  byId('agent-refresh').click(); await settle(); const footer = byId('roster-footer');
  assert.equal(footer.querySelector('p')?.textContent, 'Agents could not be refreshed.'); assert.equal(footer.querySelector('pre')?.textContent, diagnostic);
  assert.equal(footer.querySelector('button')?.getAttribute('aria-label'), 'Refresh agent roster'); assert.equal(byId('announcements').textContent, 'Agents could not be refreshed.');
});

test('Message B remains visible while main A retains its writer, caret and reading place', async () => {
  const targetA = {kind: 'agent' as const, identity: 'message-main-a'}, targetB = {kind: 'agent' as const, identity: 'message-other-b'};
  const a = agentFixture(targetA.identity, {availability: 'stored', modifiedAt: Date.now(), capabilities: {input: false}}), b = agentFixture(targetB.identity, {availability: 'stored', modifiedAt: Date.now(), capabilities: {input: false}});
  const savedA = targetFixture('message-main-a', targetA, {draft: {revision: 4, text: 'Keep main A draft', mode: 'prompt', persisted: true}});
  const savedB = targetFixture('message-other-b', targetB, {draft: {revision: 4, text: 'Keep B draft', mode: 'followUp', persisted: true}});
  await arrive({workspace: {id: 'message-with-agent', revision: 1, selectedTarget: targetA, conversationLayout: singlePane([{kind: 'agent', identity: a.identity}, {kind: 'agent', identity: b.identity}], `agent:${a.identity}`)}, primaries: [], roster: [a, b], targets: [savedA, savedB]});
  const editorA = agentControl('editor'), rootA = agentControl('root'), transcriptA = agentControl('transcript');
  editorA.focus(); editorA.setSelectionRange(2, 7, 'backward'); transcriptA.scrollTop = 17;
  const reading = app.state.targets.get(savedA.targetKey)?.reading, before = transportLog.length;
  const row = byId('roster').querySelector(`[data-identity="${b.identity}"]`), message = row?.querySelector('.row-message'); assert.ok(message); assert.equal(message.hidden, false);
  message.click(); await settle();
  assert.deepEqual(app.state.workspace?.selectedTarget, targetA); assert.equal(agentControl('root'), rootA); assert.equal(rootA.hidden, false);
  assert.equal(agentControl('editor'), editorA); assert.equal(editorA.value, 'Keep main A draft'); assert.deepEqual([editorA.selectionStart, editorA.selectionEnd, editorA.selectionDirection], [2, 7, 'backward']);
  assert.equal(transcriptA.scrollTop, 17); assert.deepEqual(app.state.targets.get(savedA.targetKey)?.reading, reading);
  const editorB = messageControl('editor'); assert.equal(editorB.value, 'Keep B draft'); assert.equal(messageControl('send').disabled, false); assert.equal(messageControl('stop').hidden, true);
  const preparation = transportLog.slice(before).filter(call => call.path.endsWith('/targets')); assert.equal(preparation.length, 1); assert.deepEqual((preparation[0]?.body as {target?: Target})?.target, targetB);
  editorB.setSelectionRange(1, 5); byId('agent-message-close').click(); await settle();
  assert.equal(message.hidden, false); assert.match(message.getAttribute('aria-label') ?? '', /Resume message to/); message.click(); await settle();
  assert.equal(messageControl('editor'), editorB); assert.deepEqual([editorB.selectionStart, editorB.selectionEnd], [1, 5]); assert.deepEqual(app.state.workspace?.selectedTarget, targetA);
  assert.equal(transportLog.slice(before).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
  byId('agent-message-close').click(); await settle();
});

test('Commands find and thinking actions work on the agent-only focused transcript', async () => {
  const identity = 'agent-transcript-commands', target = {kind: 'agent' as const, identity};
  const saved = targetFixture('agent-transcript-commands', target, {presentation: {revision: 1, expanded: [], showThinking: false}});
  const entry = entryFixture('agent-command-entry', [messageFixture('agent-command-message', [textPart('Find this retained agent text'), {type: 'thinking', text: 'Agent reasoning'}])]);
  const entries = [...Array.from({length: 30}, (_, index) => entryFixture(`agent-command-before-${index}`, [messageFixture(`agent-command-before-message-${index}`, [textPart(`Earlier agent text ${index}`)])])), entry];
  await arrive({workspace: {id: identity, revision: 1, selectedTarget: target}, primaries: [], roster: [agentFixture(identity)], targets: [saved], observations: [observation(identity, {revision: 1, observedAt: 'now', entries, live: [], nextBefore: null, status: {busy: false}, coverage})]});
  const rows = () => byId('modal-body').querySelectorAll('.palette-row');
  const choice = (name: string) => {const row = rows().find(row => row.querySelector('.palette-name')?.textContent === name); assert.ok(row, name); return row;};
  byId('commands-button').click();
  for (const name of ['Expand loaded tools', 'Collapse loaded tools', 'Show thinking', 'Hide thinking', 'Find text']) assert.equal(choice(name).disabled, false);
  for (const name of ['Compact…', 'Fork from message…', 'Automatic retry…', 'Automatic compaction…', 'Continue in terminal…', 'Model', 'Thinking']) assert.equal(choice(name).disabled, true);
  choice('Show thinking').click(); await settle(); assert.equal(agentControl('transcript').querySelector('.thinking')?.open, true);
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, true);
  byId('commands-button').click(); choice('Find text').click();
  const query = byId('modal-body').querySelector('input'); assert.ok(query); query.value = 'Find this retained agent text'; query.dispatch('keydown', {key: 'Enter'}); await settle();
  const found = agentControl('transcript').querySelector('[data-entry-id="agent-command-entry"]'); assert.ok(found); assert.equal(found.classList.contains('find-current'), true); assert.equal(hostDocument.activeElement, query);
  assert.ok(agentControl('transcript').scrollTop > 0);
  assert.equal(app.state.primaries.size, 0); assert.deepEqual(app.state.workspace?.selectedTarget, target);
  byId('modal-close').click(); assert.equal(found.classList.contains('find-current'), false);
});

test('local Find captures the exact pane across query edits, focus changes and target replacement', async () => {
  const identity = 'find-capture-agent', target = {kind: 'primary' as const, key: 'p', epoch: 9870};
  const agentRows = [entryFixture('agent-hit-one', [messageFixture('agent-hit-message-one', [textPart('needle alpha')])]), entryFixture('agent-hit-two', [messageFixture('agent-hit-message-two', [textPart('needle beta')])])];
  const primaryRows = [entryFixture('primary-hit', [messageFixture('primary-hit-message', [textPart('needle beta')])])];
  const primarySaved = targetFixture('find-primary', target, {draft: {revision: 1, text: 'Primary draft', images: [attachedImage()], mode: 'prompt', persisted: true}});
  const agentSaved = targetFixture('find-agent', {kind: 'agent', identity}, {draft: {revision: 1, text: 'Agent draft', images: [attachedImage()], mode: 'prompt', persisted: true}});
  await arrive({workspace: {id: 'find-capture', revision: 1, primaryKey: 'p', selectedTarget: agentSaved.target, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: target.epoch})], roster: [agentFixture(identity)], targets: [primarySaved, agentSaved], observations: [observation(identity, {revision: 1, observedAt: 'now', entries: agentRows, live: [], nextBefore: null, status: {busy: false}, coverage}, 10)], history: primaryRows});
  const capturedAgent = app.agentComposer(), capturedControls = controls(capturedAgent), agentEditor = capturedControls('editor');
  app.focusPane('primary-pane'); await settle(); const primaryEditor = primaryControl('editor'); primaryEditor.setSelectionRange(2, 5, 'backward');
  const start = transportLog.length;
  app.openConversationActions('agent-pane'); menuNode().children.find(node => node.textContent === 'Find text')?.click();
  const query = byId('modal-body').querySelector('input'); assert.ok(query); assert.equal(byId('modal').dataset.variant, 'find');
  const status = byId('modal-body').querySelector('.find-status'); assert.ok(status);
  query.value = 'needle'; query.dispatch('keydown', {key: 'Enter', shiftKey: false}); await settle();
  assert.equal(capturedControls('transcript').querySelector('.find-current')?.dataset.entryId, 'agent-hit-one'); assert.equal(primaryControl('transcript').querySelector('.find-current'), null);
  app.focusPane('primary-pane'); query.focus(); query.dispatch('keydown', {key: 'Enter'}); await settle(); assert.equal(status.textContent, 'Match 2 of 2 in loaded messages.');
  query.value = 'alpha'; query.dispatch('input'); assert.equal(capturedControls('transcript').querySelector('.find-current'), null); query.dispatch('keydown', {key: 'Enter'}); await settle();
  assert.equal(capturedControls('transcript').querySelector('.find-current')?.dataset.entryId, 'agent-hit-one');
  assert.equal(primaryEditor.value, 'Primary draft'); assert.equal(agentEditor.value, 'Agent draft'); assert.deepEqual([primaryEditor.selectionStart, primaryEditor.selectionEnd, primaryEditor.selectionDirection], [2, 5, 'backward']);
  assert.deepEqual(app.primaryComposer().state?.draft.images, [attachedImage()]); assert.deepEqual(capturedAgent.state?.draft.images, [attachedImage()]);
  assert.equal(transportLog.slice(start).some(call => call.path.includes('/inputs') || call.path.endsWith('/start')), false);
  await arrive({workspace: {id: 'find-replacement', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: 9871})], roster: [], history: primaryRows});
  const replacement = primaryControl('transcript'), scroll = replacement.scrollTop; query.value = 'needle'; query.dispatch('input'); query.dispatch('keydown', {key: 'Enter'}); await settle();
  assert.equal(status.textContent, 'Captured conversation is unavailable.'); assert.equal(replacement.scrollTop, scroll); assert.equal(replacement.querySelector('.find-current'), null);
  byId('modal-close').click();
});
test('Earlier changes Find coverage while the native Find dialog stays open', async t => {
  const original = globalThis.fetch, target = {kind: 'primary' as const, key: 'p', epoch: 9872}; const row = (id: string) => entryFixture(id, [messageFixture(`m-${id}`, [textPart('needle')])]);
  t.after(() => {globalThis.fetch = original; byId('modal-close').click();});
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname !== '/api/primaries/p/history') return original(input, init);
    const earlier = !!url.searchParams.get('cursor'); return Response.json({ok: true, data: {target, items: [row(earlier ? 'older' : 'recent')], nextCursor: earlier ? null : 'older-page', coverage}});
  };
  await arrive({workspace: {id: 'find-earlier', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: []});
  byId('commands-button').click(); byId('modal-body').querySelectorAll('.palette-row').find(row => row.querySelector('.palette-name')?.textContent === 'Find text')?.click();
  const query = byId('modal-body').querySelector('input'), status = byId('modal-body').querySelector('.find-status'); assert.ok(query); assert.ok(status);
  query.value = 'needle'; query.dispatch('keydown', {key: 'Enter'}); await settle(); assert.equal(status.textContent, 'Match 1 of 1 in loaded messages.');
  primaryControl('earlier').click(); await settle(); assert.equal(byId('modal').open, true);
  query.dispatch('keydown', {key: 'Enter', shiftKey: true}); await settle(); assert.equal(status.textContent, 'Match 1 of 2 in loaded messages.'); assert.equal(primaryControl('transcript').querySelector('.find-current')?.dataset.entryId, 'older');
  query.dispatch('keydown', {key: 'Enter'}); await settle(); assert.equal(status.textContent, 'Match 2 of 2 in loaded messages.');
  query.dispatch('keydown', {key: 'Enter'}); assert.match(status.textContent, /Last loaded match/);
});
test('earlier-history loads expose pending and result states without restoring an old saved anchor', async t => {
  const original = globalThis.fetch, target = {kind: 'primary' as const, key: 'p', epoch: 699};
  const pending = Array.from({length: 3}, () => Promise.withResolvers<Response>()), cursors: (string | null)[] = [];
  const entries = Array.from({length: 20}, (_, index) => entryFixture(`feedback-${index}`, [messageFixture(`feedback-message-${index}`, [textPart(`Feedback entry ${index}`)])]));
  const saved = targetFixture('history-feedback', target, {reading: {revision: 7, anchorId: 'feedback-6', offsetPx: 17, followTail: false}});
  t.after(() => {globalThis.fetch = original; for (const response of pending) response.resolve(Response.json({ok: true, data: {target, items: [], nextCursor: null, coverage}}));});
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname !== '/api/primaries/p/history') return original(input, init);
    const cursor = url.searchParams.get('cursor'); cursors.push(cursor);
    if (!cursor) return Response.json({ok: true, data: {target, items: entries, nextCursor: 'older', coverage}});
    const response = pending[cursors.filter(value => value !== null).length - 1]; assert.ok(response); return response.promise;
  };
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: [], targets: [saved]});
  const scroller = primaryControl('transcript'), earlier = primaryControl('earlier'), notice = primaryControl('view-notice');
  earlier.click(); await settle(); assert.equal(earlier.disabled, true); assert.equal(earlier.getAttribute('aria-label'), 'Loading earlier messages'); assert.equal(earlier.getAttribute('aria-busy'), 'true');
  pending[0]?.resolve(Response.json({ok: false, error: {code: 'capacity', message: 'Earlier unavailable', retry: 'manual'}})); await settle();
  assert.equal(earlier.disabled, false); assert.equal(earlier.getAttribute('aria-label'), 'Earlier messages'); assert.equal(earlier.getAttribute('aria-busy'), null); assert.match(notice.textContent, /[Hh]istory could not be loaded.*Retry history/); assert.equal(notice.querySelector('summary')?.getAttribute('aria-label'), 'History error details'); assert.equal(notice.querySelector('summary svg')?.getAttribute('class'), 'card-icon card-icon-info');
  const actions = notice.querySelector('.history-actions'); assert.ok(actions); assert.equal(notice.children.length, 2);
  assert.equal(actions.children.length, 2); assert.equal(actions.children[0]?.tagName, 'details'); assert.equal(actions.children[1]?.getAttribute('aria-label'), 'Retry history');
  assert.match(actions.querySelector('pre')?.textContent ?? '', /Earlier unavailable/);
  earlier.click(); await settle(); const anchor = scroller.querySelector('[data-entry-id="feedback-6"]'); assert.ok(anchor);
  scroller.scrollTop = anchor.offsetTop - scroller.offsetTop + 77; scroller.dispatch('scroll'); flushFrames();
  pending[1]?.resolve(Response.json({ok: true, data: {target, items: [entryFixture('feedback-older', [messageFixture('feedback-older-message', [textPart('Earlier feedback')])])], nextCursor: 'oldest', coverage}})); await settle();
  assert.match(byId('announcements').textContent, /Earlier entries loaded/); assert.equal(app.state.conversations.get(JSON.stringify(['primary', 'p', 699]))?.entries.has('feedback-older'), true); assert.equal(earlier.disabled, false); assert.equal(scroller.querySelector('[data-entry-id="feedback-6"]'), anchor); assert.equal(scroller.scrollTop - (anchor.offsetTop - scroller.offsetTop), 77);
  earlier.click(); await settle(); await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'new-history-owner'}, primaries: [primaryFixture({key: 'new-history-owner', epoch: 698})], roster: []});
  const currentNotice = primaryControl('view-notice'); currentNotice.textContent = 'Current owner notice';
  pending[2]?.resolve(Response.json({ok: true, data: {target, items: [entryFixture('feedback-too-late', [])], nextCursor: null, coverage}})); await settle();
  assert.equal(currentNotice.textContent, 'Current owner notice'); assert.equal(app.state.conversations.get(JSON.stringify(['primary', 'p', 699]))?.entries.has('feedback-too-late'), false); assert.deepEqual(cursors, [null, 'older', 'older', 'oldest']);
});
test('initial primary history pages to the saved anchor without a full-session request', async () => {
  const fetch = globalThis.fetch; const calls: (string | null)[] = []; const epoch = 701;
  const saved = targetFixture('anchor-pages', {kind: 'primary', key: 'p', epoch}, {reading: {revision: 7, anchorId: 'saved-anchor', offsetPx: 17, followTail: false}});
  const row = (id: string) => entryFixture(id, [messageFixture(`m-${id}`, [textPart(id)])]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname === '/api/primaries/p/history') {
      assert.equal(url.searchParams.get('limit'), '50'); const cursor = url.searchParams.get('cursor'); calls.push(cursor);
      const items = cursor === 'older' ? [row('saved-anchor')] : [row('recent-anchor')];
      return Response.json({ok: true, data: {target: saved.target, items, nextCursor: cursor ? 'start' : 'older', coverage}});
    }
    return fetch(input, init);
  };
  try {
    await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch})], roster: [], targets: [saved]});
    assert.deepEqual(calls, [null, 'older']);
    assert.equal(app.state.conversations.get(JSON.stringify(['primary', 'p', epoch]))?.entries.has('saved-anchor'), true);
    const anchor = primaryControl('transcript').querySelector('.entry'); assert.ok(anchor);
    assert.equal(primaryControl('transcript').scrollTop, anchor.offsetTop - primaryControl('transcript').offsetTop + 17);
  } finally {globalThis.fetch = fetch;}
});
test('a user scroll during saved-anchor paging wins over the late earlier response', async () => {
  const fetch = globalThis.fetch; const calls: (string | null)[] = []; const epoch = 702;
  const pending = Promise.withResolvers<Response>(); const started = Promise.withResolvers<void>();
  const saved = targetFixture('anchor-interrupt', {kind: 'primary', key: 'p', epoch}, {reading: {revision: 7, anchorId: 'absent-anchor', offsetPx: 17, followTail: false}});
  const row = (id: string) => entryFixture(id, [messageFixture(`m-${id}`, [textPart(id)])]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname === '/api/primaries/p/history') {
      const cursor = url.searchParams.get('cursor'); calls.push(cursor);
      if (cursor) {started.resolve(); return pending.promise;}
      return Response.json({ok: true, data: {target: saved.target, items: Array.from({length: 20}, (_, at) => row(`recent${at}`)), nextCursor: 'older', coverage}});
    }
    return fetch(input, init);
  };
  try {
    await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch})], roster: [], targets: [saved]});
    await started.promise; const root = primaryControl('transcript'); root.scrollTop = 280; root.dispatch('scroll'); flushFrames();
    pending.resolve(Response.json({ok: true, data: {target: saved.target, items: [row('absent-anchor')], nextCursor: 'start', coverage}})); await settle();
    assert.deepEqual(calls, [null, 'older']); assert.notEqual(root.scrollTop, 17);
    assert.equal(primaryControl('latest').hidden, false);
  } finally {globalThis.fetch = fetch;}
});

test('a non-split agent round trip keeps the loaded primary anchor and earlier page', async () => {
  const epoch = 703; const target = {kind: 'primary' as const, key: 'p', epoch};
  const current = primaryFixture({epoch, sessionId: 'retained-session', sessionFile: '/fixture/project/retained.jsonl'});
  const earlier = entryFixture('retained-earlier', [messageFixture('retained-message', [textPart('Earlier code stays available')])]);
  const leaf = entryFixture('retained-leaf', [messageFixture('retained-last', [textPart('Latest history')])]);
  const saved = targetFixture('anchor-roundtrip', target, {reading: {revision: 7, anchorId: earlier.id, offsetPx: 17, followTail: false}});
  const agent = agentFixture('anchor-observer', {availability: 'stored'}); const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname === '/api/primaries/p/history') {
      const cursor = url.searchParams.get('cursor');
      return Response.json({ok: true, data: {target, items: cursor ? [earlier] : [leaf], nextCursor: cursor ? null : 'earlier', coverage}});
    }
    return fetch(input, init);
  };
  try {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: singlePane()}, primaries: [current], roster: [agent], targets: [saved], history: [earlier, leaf], selectedPage: {target, items: [leaf], nextCursor: 'earlier', coverage}});
  const root = primaryControl('transcript'); const anchor = root.querySelector('[data-entry-id="retained-earlier"]'); assert.ok(anchor); const offset = root.scrollTop - (anchor.offsetTop - root.offsetTop); assert.match(root.textContent, /Earlier code stays available/);
  assert.equal(primaryControl('earlier').hidden, true);
  browser.fixture = {...browser.fixture, selectedPage: {target: {kind: 'agent', identity: agent.identity}, entries: [], nextBefore: null, coverage, revision: 'r'}};
  await app.selectAgent(agent); await settle(); assert.equal(primaryControl('root').hidden, true);
  browser.fixture = {...browser.fixture, history: [leaf], selectedPage: {target, items: [leaf], nextCursor: 'earlier', coverage}};
  byId('primary-row').click(); await settle();
  assert.equal(primaryControl('root').hidden, false); assert.match(root.textContent, /Earlier code stays available/); assert.equal(root.querySelector('[data-entry-id="retained-earlier"]'), anchor); assert.equal(root.scrollTop - (anchor.offsetTop - root.offsetTop), offset);
  assert.equal(app.state.conversations.get(JSON.stringify(['primary', 'p', epoch]))?.entries.has(earlier.id), true);
  assert.equal(primaryControl('earlier').hidden, true, 'the exhausted boundary remains hidden after an initial-page refresh');
  } finally {globalThis.fetch = fetch;}
});


test('tab reveal and width changes retain target-owned transcript geometry without detachment', async t => {
  t.after(() => {host.viewport = 1200;});
  const epoch = 706; const target = {kind: 'primary' as const, key: 'p', epoch}; const identity = 'geometry-observer';
  const rows = Array.from({length: 24}, (_, index) => entryFixture(`geometry-${index}`, [messageFixture(`geometry-message-${index}`, [textPart(`Retained place ${index}`)])]));
  const saved = targetFixture('geometry-primary', target, {reading: {revision: 7, anchorId: 'geometry-8', offsetPx: 17, followTail: false}});
  const agentTarget = {kind: 'agent' as const, identity}; const agent = agentFixture(identity, {availability: 'stored'});
  const other = targetFixture('geometry-agent', agentTarget, {reading: {revision: 2, anchorId: null, offsetPx: 0, followTail: false}});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: singlePane()}, primaries: [primaryFixture({epoch, sessionId: 'geometry-session', sessionFile: '/fixture/project/geometry.jsonl'})], roster: [agent], targets: [saved, other], history: rows, selectedPage: {target, items: rows, nextCursor: null, coverage}});
  const scroller = primaryControl('transcript'), anchor = scroller.querySelector('[data-entry-id="geometry-8"]'); assert.ok(anchor);
  const top = scroller.scrollTop, offset = top - (anchor.offsetTop - scroller.offsetTop); assert.equal(offset, 17);
  const remove = HostNode.prototype.remove; let detached = 0;
  t.mock.method(HostNode.prototype, 'remove', function(this: HostNode) {
    const attached = this.parentNode !== null; remove.call(this);
    if (attached && this.className === 'conversation') { for (const transcript of this.querySelectorAll('.transcript')) transcript.scrollTop = 0; detached++; }
  });
  await app.selectAgent(agent); await settle(); assert.equal(primaryControl('root').hidden, true); assert.equal(detached, 0);
  const agentNotice = agentControl('view-notice'); assert.doesNotMatch(agentNotice.textContent, /Saved position|saved place/);
  browser.fixture = {...browser.fixture, selectedPage: {target, items: rows, nextCursor: null, coverage}};
  byId('primary-row').click(); await settle();
  assert.equal(primaryControl('root').hidden, false); assert.equal(scroller.querySelector('[data-entry-id="geometry-8"]'), anchor);
  assert.equal(scroller.scrollTop - (anchor.offsetTop - scroller.offsetTop), offset);
  const layout = twoPanes(identity, 'primary-pane'); app.applyLayout(layout); await settle();
  assert.equal(scroller.scrollTop - (anchor.offsetTop - scroller.offsetTop), offset);
  host.viewport = 335; app.renderNavigation(); await settle(); host.viewport = 1440; app.renderNavigation(); await settle();
  assert.equal(scroller.scrollTop - (anchor.offsetTop - scroller.offsetTop), offset);
  scroller.dispatch('scrollend'); await settle();
  const reading = app.state.targets.get(saved.targetKey)?.reading; assert.equal(reading?.anchorId, 'geometry-8'); assert.equal(reading?.offsetPx, 17);
  assert.doesNotMatch(primaryControl('view-notice').textContent, /Saved position|saved place/);
  assert.doesNotMatch(agentNotice.textContent, /Saved position|saved place/);
});
test('selection admission gate stays separate from transport connectivity', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p'},primaries:[primaryFixture({epoch:704})],roster:[]}); app.focusPane(app.focusedPane);await settle();const editor=primaryControl('editor'); editor.value='Gate draft'; editor.dispatch('input');
  const original=globalThis.fetch,response=Promise.withResolvers<Response>(); globalThis.fetch=async(input,init)=>new URL(String(input),'http://ui.test').pathname.endsWith('/selection')?response.promise:original(input,init);
  try {const pending=app.selectionQueue.select({sidebarWidth:260}); assert.equal(primaryControl('send').disabled,false); assert.equal(editor.disabled,false); assert.equal(byId('connection').hidden,true);
    response.resolve(Response.json({ok:true,data:{...browser.fixture.workspace,revision:browser.fixture.workspace.revision+1,sidebarWidth:260}})); await pending; await settle(); assert.equal(primaryControl('send').disabled,false);
  }finally{globalThis.fetch=original;}
});
test('snapshot refresh does not await history and history still has a deadline', async () => {
  assert.ok(source.includes('refreshVisible(() => refreshSnapshot(signal), loadVisibleHistory, showError)')); assert.ok(source.includes('AbortSignal.timeout(15_000)')); assert.ok(source.includes('AbortSignal.any'));
});
test('a late action rejection stays under its captured owner after navigation', async context => {
  const fetch = globalThis.fetch; context.after(() => { globalThis.fetch = fetch; });
  const response = Promise.withResolvers<Response>(); const started = Promise.withResolvers<void>();
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), 'http://ui.test').pathname === '/api/operations' && JSON.parse(String(init?.body ?? '{}')).kind === 'primary.stop') { started.resolve(); return response.promise; }
    return fetch(input, init);
  };
  const primaryDraft=targetFixture('stop-primary',{kind:'primary',key:'p',epoch:8400});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: 8400})], roster: [],targets:[primaryDraft]});
  assert.equal(primaryControl('stop').disabled, false); primaryControl('stop').click(); await started.promise;
  const row = agentFixture('receipt-owner');
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: row.identity}, panelVisible: true},
    primaries: [primaryFixture({epoch: 8400})], roster: [row], targets: [primaryDraft,targetFixture('receipt-agent', {kind: 'agent', identity: row.identity})]});
  primaryControl('receipt').textContent = 'Primary receipt retained'; agentControl('receipt').textContent = 'Agent receipt retained';
  response.resolve(Response.json({ok: false, error: {code: 'capacity', message: 'Late action refused', retry: 'manual'}})); await settle();
  const receipt = primaryControl('receipt'), caption = receipt.querySelector('.status-error'); assert.ok(caption);
  assert.equal(receipt.textContent, 'Stop could not be confirmed.'); assert.equal(caption.title, 'Late action refused'); assert.equal(receipt.title, '');
  assert.equal(agentControl('receipt').textContent, 'Agent receipt retained');
  app.primaryComposer().receipts(app.state.operations.values()); assert.equal(caption.parentNode, null); assert.equal(receipt.querySelector('.status-error'), null); assert.equal(receipt.title, '');
});
test('page visibility retains the shell stream and observation', async t => {
  assert.ok(source.includes('connectionSurfaceFor(connectionPhase)'));
  assert.doesNotMatch(source,/access-view|accessRequired|setUnauthorizedHandler/); assert.doesNotMatch(source, /setInterval/);
  const identity = 'visibility-owner'; await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 9536})], roster: [agentFixture(identity)], observations: [observation(identity)]});
  const editor = agentControl('editor'), stream = streamSources.at(-1); assert.ok(stream); editor.value = 'Hidden tab draft'; editor.dispatch('input'); editor.setSelectionRange(2, 7); editor.dispatch('select');
  const tree = app.state.workspace?.conversationLayout, selected = app.state.workspace?.selectedTarget, saves = selectionSaves.length;
  const retained = () => {assert.deepEqual(app.state.workspace?.conversationLayout, tree); assert.deepEqual(app.state.workspace?.selectedTarget, selected); assert.equal(selectionSaves.length, saves); assert.equal(agentControl('editor'), editor);};
  const visibility = () => {for (const handler of [...documentHandlers.get('visibilitychange') ?? []]) handler({target: hostDocument});};
  const streamCount = streamSources.length, before = transportLog.length;
  t.after(async () => {hostDocument.hidden = false; visibility(); await settle(); retained();});
  hostDocument.hidden = true; visibility(); await settle(); assert.equal(stream.closed, false); retained();
  assert.equal(streamSources.length, streamCount); assert.equal(transportLog.slice(before).some(call => call.path === '/api/snapshot' || call.path.endsWith('/selection')), false);
  assert.equal(editor.value, 'Hidden tab draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]);
});

test('replacement stream readiness ignores old callbacks and does not wait for history', async context => {
  const fetch = globalThis.fetch, recovery = preparationRecovery();
  const history = Promise.withResolvers<Response>(); let pendingHistoryCalls = 0;
  context.after(async () => {
    globalThis.fetch = fetch;
    history.resolve(Response.json({ok: true, data: {target: {kind: 'primary', key: 'p', epoch: 8500}, items: [], nextCursor: null, coverage}}));
    await settle(); await recovery.dispose();
  });
  const target = {kind: 'primary' as const, key: 'p', epoch: 8500};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: 8500})], roster: [],
    targets: [targetFixture('reconnect-draft', target, {draft: {revision: 7, text: 'Retained reconnect draft', mode: 'prompt', persisted: true}})]});
  const editor = primaryControl('editor'); editor.focus(); editor.setSelectionRange(2, 8);
  const a = streamSources.at(-1); assert.ok(a); const before = transportLog.length;
  assert.equal(primaryControl('send').disabled, false);
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), 'http://ui.test').pathname === '/api/primaries/p/history') { pendingHistoryCalls++; return history.promise; }
    return fetch(input, init);
  };
  await recovery.disconnect(); assert.equal(a.closed, true); assert.equal(primaryControl('send').disabled, false); assert.match(hostDocument.title, /Connection lost/);
  await recovery.attempt();
  const b = streamSources.at(-1); assert.ok(b); assert.notEqual(b, a); assert.equal(b.closed, false);
  assert.equal(pendingHistoryCalls, 1);
  const cursor = app.state.cursor; a.emit('ready', {bootId: 'boot'}); a.emit('notice', {id: 'late-source-notice', message: 'Old source'}); await settle();
  assert.equal(app.state.cursor, cursor); assert.equal(primaryControl('send').disabled, false); assert.match(hostDocument.title, /Connection lost/);
  assert.equal(app.state.notices.some(item => item.id === 'late-source-notice'), false);
  await recovery.ready(); assert.equal(primaryControl('send').disabled, false);
  assert.equal(primaryControl('editor'), editor); assert.equal(editor.value, 'Retained reconnect draft');
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 8]); assert.equal(hostDocument.activeElement, editor);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
});
function pageHidden(hidden: boolean): void {
  hostDocument.hidden = hidden;
  for (const handler of [...documentHandlers.get('visibilitychange') ?? []]) handler({target: hostDocument});
}
test('hide before recovery ready retains the wait and reveal keeps that stream', async t => {
  const recovery = preparationRecovery(); t.after(async () => {await recovery.dispose();});
  const saved = await devHookFixture('hide-ready', 9664), editor = primaryControl('editor'); editor.focus(); editor.setSelectionRange(2, 7, 'backward'); await settle();
  const tree = app.state.workspace?.conversationLayout, target = app.state.workspace?.selectedTarget, saves = selectionSaves.length;
  const old = await recovery.disconnect(); await recovery.attempt(); const pending = streamSources.at(-1); assert.ok(pending); assert.notEqual(pending, old); assert.equal(pending.closed, false);
  const count = streamSources.length; pageHidden(true); await settle(); assert.equal(pending.closed, false); assert.equal(primaryControl('send').disabled, false);
  const cursor = app.state.cursor; old.emit('ready', {bootId: 'boot'}); old.emit('notice', {id: 'late-hidden-ready', message: 'Old stream'}); old.onerror?.(); await settle(); assert.equal(app.state.cursor, cursor); assert.equal(streamSources.length, count);
  await recovery.ready(); assert.equal(hostDocument.hidden, true); assert.equal(primaryControl('send').disabled, false);
  pageHidden(false); await settle(); assert.equal(streamSources.at(-1), pending); assert.equal(streamSources.length, count); assert.equal(pending.closed, false);
  assert.equal(app.state.notices.some(notice => notice.id === 'late-hidden-ready'), false); assert.equal(primaryControl('editor'), editor);
  assert.equal(editor.value, saved.primary.draft.text); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']); assert.equal(hostDocument.activeElement, editor);
  assert.deepEqual(app.state.workspace?.conversationLayout, tree); assert.deepEqual(app.state.workspace?.selectedTarget, target); assert.equal(selectionSaves.length, saves);
});
test('hide during recovery reload retains its owner and reveal does not duplicate the snapshot', async t => {
  const recovery = preparationRecovery();
  await devHookFixture('hide-reload', 9665); const fetch = globalThis.fetch, response = Promise.withResolvers<Response>(); let calls = 0; let currentSignal: AbortSignal | null | undefined;
  const captured = snapshotOf(browser.fixture, browser.cursorSequence), before = streamSources.length, editor = primaryControl('editor'), text = editor.value;
  editor.focus(); editor.setSelectionRange(2, 7, 'backward');
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), 'http://ui.test').pathname === '/api/snapshot' && ++calls === 1) {currentSignal = init?.signal; return response.promise;}
    return fetch(input, init);
  };
  t.after(async () => {globalThis.fetch = fetch; response.resolve(Response.json({ok: true, data: captured})); await settle(); await recovery.dispose();});
  await recovery.disconnect(); await recovery.attempt(); assert.equal(calls, 1); assert.equal(streamSources.length, before);
  pageHidden(true); await settle(); assert.equal(currentSignal?.aborted, false); assert.equal(streamSources.length, before);
  response.resolve(Response.json({ok: true, data: captured})); await settle(); assert.equal(streamSources.length, before + 1);
  const fresh = streamSources.at(-1); assert.ok(fresh); await recovery.ready(); assert.equal(hostDocument.hidden, true);
  const cursor = app.state.cursor, workspace = app.state.workspace, completedReads=calls; pageHidden(false); await settle();
  assert.equal(calls, completedReads); assert.equal(streamSources.length, before + 1); assert.equal(app.state.cursor, cursor); assert.equal(app.state.workspace, workspace); assert.equal(fresh.closed, false); assert.equal(primaryControl('send').disabled, false);
  assert.equal(primaryControl('editor'), editor); assert.equal(editor.value, text); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']); assert.equal(hostDocument.activeElement, editor);
});
test('hide retains a queued recovery retry and reveal does not add another attempt', async t => {
  const recovery = preparationRecovery(); t.after(async () => {await recovery.dispose();});
  await devHookFixture('hide-retry', 9666);
  const current = await recovery.disconnect(), count = streamSources.length;
  const retry = [...recovery.queued.values()].find(item => item.delay <= 250); assert.ok(retry);
  pageHidden(true); assert.ok([...recovery.queued.values()].includes(retry)); await recovery.attempt();
  assert.equal(hostDocument.hidden, true); assert.equal(streamSources.length, count + 1); const fresh = streamSources.at(-1); assert.ok(fresh); assert.notEqual(fresh, current);
  current.onerror?.(); await settle(); assert.equal(streamSources.length, count + 1);
  await recovery.ready(); pageHidden(false); await settle(); assert.equal(streamSources.at(-1), fresh); assert.equal(streamSources.length, count + 1); assert.equal(primaryControl('send').disabled, false);
});
test('message panel moves the existing form outside the roster without changing the main view', async () => {
  const row=agentFixture('movable-message'); await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:row.identity},conversationLayout:twoPanes(row.identity)},primaries:[primaryFixture({epoch:706})],roster:[row]});
  const selected=app.state.workspace?.selectedTarget,agent=controls(app.agentComposer()),form=agent('composer'),editor=agent('editor'),root=agent('root'),saved=selectionSaves.length;
  app.openConversationActions('agent-pane'); const message = menuNode().children.find(node => node.textContent === 'Message'); assert.ok(message); message.click(); await settle();
  assert.equal(messageControl('composer'),form); assert.equal(messageControl('editor'),editor); assert.equal(form.parentNode,agentControl('root')); assert.equal(app.stableViews().slot(form as unknown as HTMLElement)?.id,'agent-message-editor-slot'); assert.equal(byId('roster').contains(form),false); assert.deepEqual(app.state.workspace?.selectedTarget,selected); assert.equal(selectionSaves.length,saved);
  byId('agent-message-close').click(); await settle(); assert.equal(form.parentNode,root);
});
test('preference completions keep their captured request and leave a newer target notice unchanged', async context => {
  context.after(() => { browser.preferenceSave = undefined; });
  for (const fail of [false, true]) {
    const epoch = fail ? 8202 : 8201; const key = `preference-a-${epoch}`;
    const target = {kind: 'primary' as const, key: 'p', epoch};
    await arrive({workspace: {id:'w',revision:1,primaryKey:'p',selectedTarget:target}, primaries:[primaryFixture({epoch})],roster:[],targets:[targetFixture(key,target)]});
    let finish: (response: Response) => void = () => { throw new Error('No pending preference'); };
    browser.preferenceSave = () => new Promise(resolve => { finish = resolve; });
    const before = transportLog.length; app.openConversationActions(); const grouped = menuNode().children.find(node => node.textContent === 'Grouped'); assert.ok(grouped); grouped.click(); await settle();
    const call = transportLog.slice(before).find(item => item.path.endsWith('/presentation')); assert.ok(call);
    assert.equal(call.path, `/api/workspaces/w/targets/${key}/presentation`);
    assert.equal((call.body as Record<string,unknown>).transcriptView, 'grouped');
    const next = {kind:'primary' as const,key:'p',epoch:epoch+10}; browser.preferenceSave = undefined;
    await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:next},primaries:[primaryFixture({epoch:next.epoch})],roster:[],targets:[targetFixture(`preference-b-${epoch}`,next)]});
    const notice = primaryControl('view-notice'); notice.dataset.kind = 'presentation'; notice.textContent = 'New target recovery';
    finish(Response.json(fail ? {ok:false,error:{code:'capacity',message:'Preference refused',retry:'manual'}} : {ok:true,data:{revision:2,expanded:[],showThinking:false,transcriptView:'grouped'}})); await settle();
    assert.equal(notice.textContent, 'New target recovery');
  }
  const target = {kind:'primary' as const,key:'p',epoch:8300};
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:target.epoch})],roster:[],targets:[targetFixture('preference-current',target)]});
  browser.preferenceSave = async () => Response.json({ok:false,error:{code:'capacity',message:'Current preference refused',retry:'manual'}});
  app.openConversationActions(); const grouped = menuNode().children.find(node => node.textContent === 'Grouped'); assert.ok(grouped); grouped.click(); await settle();
  assert.match(primaryControl('view-notice').textContent, /View preferences not saved/);
  assert.match(primaryControl('view-notice').textContent, /Restore saved view/);
});
async function thinkingFixture(epoch: number, shown = false): Promise<TargetState> {
  const target = {kind: 'primary' as const, key: 'p', epoch};
  const saved = targetFixture(`thinking-${epoch}`, target, {presentation: {revision: 1, expanded: [], showThinking: shown}});
  const history = [entryFixture(`thinking-entry-${epoch}`, [messageFixture(`thinking-message-${epoch}`, [{type: 'thinking', text: 'Retained reasoning'}])])];
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch})], roster: [], targets: [saved], history});
  return saved;
}
function thinkingChoice(): HostNode {
  app.openConversationActions(); const choice = menuNode().children.find(node => node.textContent === 'Show thinking'); assert.ok(choice); return choice;
}
function thinkingDisclosure(): HostNode {
  const node = primaryControl('transcript').querySelector('.thinking'); assert.ok(node); return node;
}
test('thinking menu follows local changes while preference writes are pending and acknowledgments lag', async context => {
  const pending: Array<{body: Record<string, unknown>; resolve: (response: Response) => void}> = [];
  context.after(() => {browser.preferenceSave = undefined; contextMenu.close(); for (const item of pending) item.resolve(Response.json({ok: false, error: {code: 'capacity', message: 'Closed pending write', retry: 'manual'}}));});
  const saved = await thinkingFixture(8401);
  browser.preferenceSave = (_path, body) => new Promise(resolve => pending.push({body, resolve}));
  assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false'); thinkingChoice().click(); await settle();
  assert.equal(thinkingDisclosure().open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true');
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, false); assert.equal(pending.length, 1);
  thinkingChoice().click(); await settle(); assert.equal(thinkingDisclosure().open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  assert.equal(pending[0]?.body.showThinking, true);
  pending[0]?.resolve(Response.json({ok: true, data: {revision: 2, expanded: [], showThinking: true}})); await settle();
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, true);
  assert.equal(thinkingDisclosure().open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  assert.equal(pending[1]?.body.showThinking, false);
  pending[1]?.resolve(Response.json({ok: true, data: {revision: 3, expanded: [], showThinking: false}})); await settle();
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, false);
});
test('failed thinking saves retain local checked state and Restore saved view explicitly restores it', async context => {
  context.after(() => {browser.preferenceSave = undefined; contextMenu.close();});
  const saved = await thinkingFixture(8402, true);
  assert.equal(thinkingDisclosure().open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true');
  browser.preferenceSave = async () => Response.json({ok: false, error: {code: 'capacity', message: 'Thinking preference refused', retry: 'manual'}});
  thinkingChoice().click(); await settle();
  assert.equal(thinkingDisclosure().open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, true);
  const notice = primaryControl('view-notice'); assert.match(notice.textContent, /View preferences not saved.*Thinking preference refused/);
  thinkingChoice().click(); await settle(); assert.equal(thinkingDisclosure().open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true');
  thinkingChoice().click(); await settle(); assert.equal(thinkingDisclosure().open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  contextMenu.close(); const restore = notice.querySelector('button'); assert.ok(restore); assert.equal(restore.textContent, 'Restore saved view'); restore.click(); await settle();
  assert.equal(thinkingDisclosure().open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true'); assert.equal(notice.textContent, '');
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, true);
});
test('individual thinking collapse clears the local all-thinking check before a failed save', async context => {
  context.after(() => {browser.preferenceSave = undefined; contextMenu.close();});
  const saved = await thinkingFixture(8404, true);
  browser.preferenceSave = async () => Response.json({ok: false, error: {code: 'capacity', message: 'Collapsed preference refused', retry: 'manual'}});
  const disclosure = thinkingDisclosure(); disclosure.open = false; disclosure.dispatch('toggle'); await settle();
  assert.equal(disclosure.open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, true);
  assert.match(primaryControl('view-notice').textContent, /View preferences not saved/);
  thinkingChoice().click(); await settle(); assert.equal(disclosure.open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true');
});
test('disconnected thinking changes alternate locally without claiming a saved preference', async context => {
  const recovery = preparationRecovery();
  context.after(async () => {contextMenu.close(); await recovery.dispose();});
  const saved = await thinkingFixture(8403); await recovery.disconnect(); assert.equal(primaryControl('send').disabled, true);
  const before = transportLog.length;
  thinkingChoice().click(); await settle(); assert.equal(thinkingDisclosure().open, true); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'true');
  thinkingChoice().click(); await settle(); assert.equal(thinkingDisclosure().open, false); assert.equal(thinkingChoice().getAttribute('aria-checked'), 'false');
  assert.equal(app.state.targets.get(saved.targetKey)?.presentation?.showThinking, false);
  assert.equal(transportLog.slice(before).filter(call => call.method === 'PUT' && call.path.endsWith('/presentation')).length, 0);
});
test('close and Escape retain buffers, return focus by identity, and hide unsafe controls', async () => {
  const row=agentFixture('escape-recipient'); await arrive({workspace:{id:'w',revision:1,primaryKey:'p'},primaries:[primaryFixture({epoch:707})],roster:[row]});
  const message=byId('roster').querySelector('[data-identity="escape-recipient"]')?.querySelector('.row-message'); assert.ok(message); message.click(); await settle();
  const editor=messageControl('editor'); editor.value='Escape buffer'; editor.dispatch('input'); editor.focus(); editor.setSelectionRange(2,7); editor.dispatch('select'); assert.equal(messageControl('stop').hidden,true);
  app.appKey({key:'Escape',preventDefault(){}} as KeyboardEvent); await settle(); assert.equal(byId('agent-message-panel').hidden,true); assert.equal(hostDocument.activeElement,message);
  message.click(); await settle(); assert.equal(messageControl('editor'),editor); assert.equal(editor.value,'Escape buffer'); assert.deepEqual([editor.selectionStart,editor.selectionEnd],[2,7]); byId('agent-message-close').click();
});

test('only arrived roster and availability events invalidate message preparation', () => {
  const events = source.slice(source.indexOf('function applyEvent('), source.indexOf('function renderObservedAgent('));
  assert.match(events, /messageTarget\.rosterChanged\(event\.envelope\.data as EventData\['agent\.roster'\]\)/);
  assert.match(events, /const data = event\.envelope\.data as EventData\['agent\.availability'\]/); assert.match(events, /messageTarget\.availabilityChanged\(data\)/);
  const panel = source.slice(source.indexOf('function renderMessagePanel()'), source.indexOf('function closeMessagePanel('));
  assert.doesNotMatch(panel, /messageTarget\.(rosterChanged|availabilityChanged)/);
  assert.match(source, /messageTarget\.current && !messageTarget\.current\.invalidated\) await waitForSignal\(messageTarget\.open\(messageTarget\.current\.identity\), signal\)/);
});
test('Resume uses revision-aware reconciliation and restores its exact buffer while prepare is pending', async () => {
  assert.ok(source.includes('controller?.composer.retained(workspace, target, index)')); assert.ok(source.includes('controller.composer.attachRetained(captured.workspaceId, target)')); assert.ok(source.includes('controller.composer.availability(connected, !!controller.saved, view.busy, selecting, view.input)')); assert.ok(source.includes('current.draft.revision >= prepared.draft.revision'));
});
test('the app delegates composer recovery without a duplicate renderer or hook', () => {
  assert.doesNotMatch(source, /function recover\(|recover: recover|exactInput/);

  assert.match(source, /recovery: \(\) => recovery\.open\(\)/);
});

test('visible controls supplement the palette without a header band or title click action', async () => {
  for(const id of ['session-open','session-new','agent-new','commands-button','notifications-button','appearance-button'])assert.ok(byId(id)); assert.doesNotMatch(html,/window-actions|pane-heading|key-hint|id="notices-button"/); assert.ok(source.includes('focusedTranscript()?.expandLoaded')); assert.ok(source.includes("byId('notices-count').hidden = !unread")); assert.ok(source.includes("const activity = byId('workbench-activity'); if (!notice && view.detail) activity.title +=")); assert.ok(source.includes("!view.busy && view.responseOutcome === 'failed'")); assert.doesNotMatch(source, /Retrying after/); assert.ok(source.includes('if (item?.lastError)')); assert.doesNotMatch(source, /byId\('(?:session-title|agent-name)'\)\.addEventListener\('click'/); for (const binding of ["byId('session-new').addEventListener('click'", "byId('agent-refresh').addEventListener('click', refreshRoster)", "byId('agent-new').addEventListener('click'", "byId('commands-button').addEventListener('click', () => actions.palette())", "byId('notifications-button').addEventListener('click', notices)", "byId('appearance-button').addEventListener('click', () => actions.appearance())"]) assert.ok(source.includes(binding));
});

test('project identity names both direct controls with a launch-directory fallback', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  assert.equal(byId('project-name').textContent, 'project'); assert.equal(byId('compact-project-name').textContent, 'project');
  assert.equal(byId('project-button').title, 'Working folder: /fixture/project');
  assert.equal(byId('project-name').title, '/fixture/project');
  assert.equal(byId('project-button').getAttribute('aria-label'), 'Choose working folder');
  assert.match(html, /id="project-name" class="project-context">Working folder/);
});

test('working-folder context disambiguates loaded primaries and late recent projects in both headers', async () => {
  const first = primaryFixture({cwd: '/work/one/checkout', sessionName: 'Release notes'});
  const second = primaryFixture({key: 'p2', cwd: '/work/two/checkout', sessionName: 'Other title'});
  await arrive({workspace: {id: 'project-context', revision: 1, primaryKey: 'p'}, primaries: [first, second], roster: []});
  for (const prefix of ['', 'compact-']) {
    assert.equal(byId(`${prefix}project-name`).textContent, 'one/checkout');
    assert.equal(byId(`${prefix}project-name`).title, first.cwd);
    assert.equal(byId(`${prefix}project-button`).getAttribute('aria-description'), first.cwd);
  }
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => String(url).includes('/api/projects')
      ? Response.json({ok: true, data: {items: [{path: '/archive/one/checkout', name: 'checkout', modifiedAt: 'now'}], total: 1, omitted: 0, nextCursor: null, observedAt: 'now'}})
      : originalFetch(url, init);
    byId('project-button').click(); await settle();
    assert.equal(byId('project-name').textContent, 'work/one/checkout');
    assert.equal(byId('compact-project-name').textContent, 'work/one/checkout');
    const rows = menuNode().children;
    assert.ok(rows.find(row => row.textContent === 'archive/one/checkout'));
    assert.ok(rows.find(row => row.textContent === 'work/one/checkout'));
    assert.equal(app.state.primaries.get('p')?.sessionName, 'Release notes');
    contextMenu.close();
  } finally {globalThis.fetch = originalFetch;}
});

test('unnamed same-prefix agents keep distinct tab footer and native message labels through late names',async()=> {
  const identities=['12345678-aaaa-4bbb-8ccc-000000001001','12345678-aaaa-4bbb-8ccc-000000002002'],first=identities[0];assert.ok(first);
  const layout=singlePane(identities.map(identity=>({kind:'agent' as const,identity}))),workspace={id:'readable-identities',revision:1,selectedTarget:{kind:'agent' as const,identity:first},conversationLayout:layout};
  await arrive({workspace,primaries:[],roster:identities.map(identity=>agentFixture(identity,{name:identity,handle:undefined}))});
  const nodes=tabsNode().children;assert.equal(nodes[0]?.querySelector('.tab-label')?.textContent,'Unnamed conversation');
  assert.equal(nodes[1]?.querySelector('.tab-label')?.textContent,`Unnamed · ${nodes[1]?.querySelector('.tab-identity')?.textContent}`);
  assert.ok(nodes.every(node => (node.getAttribute('aria-label') ?? '').includes('Unnamed conversation')));
  const tails = nodes.map(node=>node.querySelector('.tab-identity')?.textContent); assert.equal(new Set(tails).size,2); for (const tail of tails) assert.match(tail ?? '', /^\d+$/);
  const firstTail = tails[0]; assert.equal(byId('workbench-scope').textContent,`Unnamed conversation · ${firstTail}`);assert.equal(agentControl('recipient').textContent,`Message Unnamed conversation · ${firstTail}`);const editor=agentControl('editor');
  await arrive({workspace:{...workspace,revision:2},primaries:[],roster:[...identities].reverse().map(identity=>agentFixture(identity,{name:'Review'}))});
  assert.equal(agentControl('editor'),editor);assert.equal(byId('workbench-scope').textContent,`Review · ${firstTail}`);assert.equal(agentControl('recipient').textContent,`Message Review · ${firstTail}`);assert.deepEqual(app.state.workspace?.selectedTarget,{kind:'agent',identity:first});
});
test('Primary and agent name collisions never expose a suffix from the internal Primary key', async () => {
  const identity = 'primary-name-peer', target = {kind: 'primary' as const, key: 'p', epoch: 8451};
  const layout = singlePane([{kind: 'primary'}, {kind: 'agent', identity}]);
  await arrive({workspace: {id: 'primary-name-collision', revision: 1, primaryKey: 'p', selectedTarget: target, conversationLayout: layout}, primaries: [primaryFixture({epoch: target.epoch, sessionName: 'Review'})], roster: [agentFixture(identity, {name: 'Review'})]});
  const primaryTab = tabsNode().children.find(node => node.querySelector('.tab-label')?.textContent === 'Review'); assert.ok(primaryTab);
  assert.equal(primaryTab.querySelector('.tab-identity')?.textContent ?? '', '');
  assert.equal(byId('workbench-scope').textContent, 'Review'); assert.match(primaryControl('recipient').textContent, /Review$/);
  assert.doesNotMatch(byId('primary-row').textContent, /mary/); assert.deepEqual(app.state.workspace?.selectedTarget, target);
});

test('the missing Primary uses the shared unknown glyph rather than a connected mark', async () => {
  await arrive({workspace: {id: 'w', revision: 1}, primaries: [], roster: []});
  assert.equal(byId('primary-row-state').dataset.glyph, '?');
  assert.ok(byId('primary-row-state').querySelector('.card-icon-unknown'));
  assert.equal(byId('primary-row-state').dataset.tone, 'warning');
  assert.equal(byId('primary-row-title').textContent, 'no session');
  assert.equal(byId('session-chooser').hidden, false); assert.equal(byId('conversation-panes').querySelector('textarea'), null);
});

test('sidebar controls are visible and their icons have consistent decorative strokes and named buttons', async () => {
  for(const id of ['agent-refresh','agent-new','sidebar-close']){const node=byId(id); assert.equal(node.hidden,false); assert.ok(node.getAttribute('aria-label')); const icon=node.querySelector('svg'); assert.ok(icon); assert.equal(icon.getAttribute('width'),'16'); assert.equal(icon.getAttribute('height'),'16'); assert.equal(icon.getAttribute('focusable'),'false'); assert.equal(icon.getAttribute('stroke'),'currentColor'); assert.equal(icon.getAttribute('stroke-width'),'1.5'); assert.equal(icon.getAttribute('aria-hidden'),'true');} assert.match(html,/id="agent-search"[^>]*placeholder="Filter agents"/);
});
test('pane controls separate creation from conversation actions without title rows', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p'},primaries:[primaryFixture({epoch:708})],roster:[]}); assert.equal(tabsNode().getAttribute('role'),'tablist'); assert.equal(tabsNode().getAttribute('aria-label'),'Tabs');
  const pane=paneNode('pane-1'); assert.equal(pane.querySelectorAll('.pane-actions').length,2); assert.equal(pane.querySelector('.pane-conversation-actions')?.getAttribute('aria-label'),'Conversation actions'); assert.equal(pane.querySelector('.pane-actions')?.getAttribute('aria-label'),'New tab'); assert.equal(pane.querySelector('.pane-actions svg')?.getAttribute('class'),'card-icon card-icon-plus'); assert.equal(primaryControl('transcript').getAttribute('aria-label'),'Conversation messages'); assert.equal(primaryControl('send').textContent,'Send'); assert.doesNotMatch(html,/pane-heading|id="tab-split"|id="session-title"/);
});

test('pane strips expose local navigation, a direct new-tab chooser and a separate complete tab list', async () => {
  const layout = singlePane([{kind: 'primary'}, {kind: 'agent', identity: 'strip-a'}, {kind: 'agent', identity: 'strip-b'}]);
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: layout}, primaries: [primaryFixture({epoch: 8405})], roster: [agentFixture('strip-a', {name: 'First full tab name'}), agentFixture('strip-b', {name: 'Second full tab name'})]});
  const pane = paneNode('pane-1'); const bar = pane.querySelector('.tab-bar'); assert.ok(bar);
  assert.deepEqual(bar.children.filter(node => node.classList.contains('pane-tab-nav') || node.classList.contains('conversation-tabs') || node.classList.contains('pane-actions') || node.classList.contains('pane-menu')).map(node => node.getAttribute('aria-label')), ['Previous tab', 'Next tab', 'Tabs', 'New tab', 'Tabs in this pane', 'Conversation actions']);
  const [previous, next] = pane.querySelectorAll('.pane-tab-nav'); assert.ok(previous); assert.ok(next);
  assert.equal(previous.disabled, true); assert.equal(previous.dataset.unreachable, 'true'); assert.equal(previous.hidden, false); assert.equal(next.disabled, false); assert.equal(next.dataset.unreachable, 'false'); next.click(); await settle();
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: 'strip-a'}); assert.equal(previous.disabled, false); assert.equal(previous.dataset.unreachable, 'false');
  const list = pane.querySelector('.pane-menu'); assert.ok(list); list.click();
  assert.equal(menuNode().getAttribute('aria-label'), 'Tabs in this pane');
  for (const name of ['First full tab name', 'Second full tab name', 'Split right', 'Split down', 'Close tab']) assert.ok(menuNode().children.some(node => node.textContent === name), name);
  const selected = menuNode().children.find(node => node.textContent === 'First full tab name'); assert.equal(selected?.getAttribute('aria-checked'), 'true');
  const second = menuNode().children.find(node => node.textContent === 'Second full tab name'); assert.ok(second); second.click(); await settle(); assert.equal(next.disabled, true);
  contextMenu.close(); const plus = pane.querySelector('.pane-actions'); assert.ok(plus); plus.focus(); plus.click(); await settle();
  assert.equal(contextMenu.openNow, false); assert.equal(byId('modal-title').textContent, 'Go to conversation'); byId('modal-close').click();
  app.openTabActions('pane-1'); for (const name of ['Split right', 'Split down', 'Close tab']) assert.ok(menuNode().children.some(node => node.textContent === name)); contextMenu.close();
});
test('pane tab-list choices disambiguate identical names without changing exact targets', async () => {
  const cases = [
    {identities: ['left-source:choice-one', 'right-source:choice-two']},
    {identities: ['left-source:shared-choice', 'right-source:shared-choice']},
  ];
  for (const [index, item] of cases.entries()) {
    const [first, second] = item.identities; assert.ok(first); assert.ok(second);
    const layout = singlePane([{kind: 'primary'}, {kind: 'agent', identity: first}, {kind: 'agent', identity: second}, {kind: 'agent', identity: 'unique-choice'}]);
    await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: layout}, primaries: [primaryFixture({epoch: 8406 + index})], roster: [agentFixture(first, {name: 'Review'}), agentFixture(second, {name: 'Review'}), agentFixture('unique-choice', {name: 'Unique full name'})]});
    const labels = tabsNode().children.filter(node=>node.dataset.tabKey === `agent:${first}` || node.dataset.tabKey === `agent:${second}`).map(node=>`${node.querySelector('.tab-label')?.textContent} · ${node.querySelector('.tab-identity')?.textContent}`);
    assert.equal(new Set(labels).size, 2); for (const label of labels) assert.match(label, /^Review · \d+$/);
    app.openTabsList('pane-1');
    const rows = menuNode().children.filter(node => labels.includes(node.textContent)); assert.equal(rows.length, 2);
    assert.equal(rows[0]?.getAttribute('aria-description'), rows[1]?.getAttribute('aria-description'));
    assert.deepEqual(rows.map(row => row.textContent), labels);
    assert.deepEqual(rows.map(row => row.getAttribute('aria-label') ?? row.textContent), labels);
    assert.ok(rows.every(row => row.getAttribute('role') === 'menuitemradio'));
    assert.ok(menuNode().children.some(row => row.textContent === 'Unique full name'));
    rows[1]?.click(); await settle(); assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: second});
    app.openTabsList('pane-1'); const selected = menuNode().children.find(row => row.textContent === labels[1]); assert.equal(selected?.getAttribute('aria-checked'), 'true');
    const other = menuNode().children.find(row => row.textContent === labels[0]); assert.ok(other); other.click(); await settle();
    assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: first}); contextMenu.close();
  }
});
test('pane handles are labeled keyboard separators at their pane edges', async () => {
  const identity='separator-owner'; await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity},conversationLayout:twoPanes(identity)},primaries:[primaryFixture({epoch:9537})],roster:[agentFixture(identity)]});
  const agentForm=agentControl('composer'),agentHandle=agentForm.querySelector('.resizer'); assert.ok(agentHandle); assert.equal(agentHandle.getAttribute('aria-controls'),agentControl('editor').id); assert.ok(agentForm.children.indexOf(agentHandle)<agentForm.children.findIndex(node=>node.classList.contains('composer-input')));
  const form=primaryControl('composer'),handle=form.querySelector('.resizer'); assert.ok(handle); assert.equal(form.contains(handle),true); assert.ok(form.children.indexOf(handle) < form.children.findIndex(node => node.classList.contains('composer-input'))); assert.equal(handle.getAttribute('aria-controls'),primaryControl('editor').id);
  for(const node of [handle,agentHandle,byId('sidebar-resizer'),byId('message-panel-resizer')]){assert.equal(node.getAttribute('data-axis'),node.id==='sidebar-resizer'?'x':'y');assert.equal(node.getAttribute('aria-orientation'),node.id==='sidebar-resizer'?'vertical':'horizontal');assert.equal(node.tabIndex,0); assert.equal(node.getAttribute('role'),'separator'); assert.match(node.getAttribute('aria-label')??'',/^Resize /); assert.ok(node.getAttribute('aria-orientation'));} assert.equal(byId('sidebar-resizer').parentNode,byId('sidebar')); assert.equal(byId('message-panel-resizer').parentNode,byId('agent-message-panel'));
});
test('sidebar width commits preserve transcript requests and pane refresh follows form placement', () => {
  const panes = source.slice(source.indexOf('function refreshPaneSizes('), source.indexOf('function currentSnapshot('));
  assert.ok(panes.includes('selectionQueue.select({sidebarWidth: value})')); assert.doesNotMatch(panes, /\bselection\(|historyAbort/);
  assert.ok(panes.includes('if (workspace.id !== paneWorkspace)')); assert.ok(panes.includes('resizer.destroy()')); assert.ok(panes.includes('paneResizers[0]?.refresh()'));
  assert.ok(panes.includes('read: () => state.workspace?.sidebarWidth ?? (innerWidth <= 1100 ? 200 : 224)'));
  const render = source.slice(source.indexOf('function renderAll('), source.indexOf('function renderNavigation('));
  assert.ok(render.indexOf('refreshPaneSizes()') > render.indexOf('renderMessagePanel()'));
  const composer = source.slice(source.indexOf('function composerResizer('), source.indexOf('function refreshPaneSizes('));
  assert.ok(composer.includes('composer.setManualHeight(preferred)')); assert.ok(composer.includes('applyInitial: preferred !== undefined'));
  assert.ok(composer.includes('composer.setManualHeight(undefined)')); assert.doesNotMatch(source, /--composer-height/);
});
test('per-tab pane sizes accept bounded integers and storage failures remain nonfatal', async () => {
  const values = new Map<string, string>();
  const working = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};
  const fail = () => {throw new Error('Storage denied');};
  Reflect.set(globalThis, 'sessionStorage', working);
  assert.equal(app.tabSize('pane', 40, 640), undefined);
  for (const [text, expected] of [['40', 40], ['640', 640], ['144', 144], ['39', undefined], ['641', undefined], ['40.5', undefined], ['NaN', undefined], ['', undefined]] as const) {
    values.set('pane', text); assert.equal(app.tabSize('pane', 40, 640), expected);
  }
  app.storeTabSize('pane', 144); assert.equal(values.get('pane'), '144'); app.storeTabSize('pane', undefined); assert.equal(values.has('pane'), false);
  Reflect.set(globalThis, 'sessionStorage', {getItem: fail, setItem: fail, removeItem: fail});
  assert.equal(app.tabSize('pane', 40, 640), undefined);
  assert.doesNotThrow(() => app.storeTabSize('pane', 144)); assert.doesNotThrow(() => app.storeTabSize('pane', undefined));
  Reflect.set(globalThis, 'sessionStorage', hostSessionStorage);
});
test('Primary metadata exposes scoped text while project identity remains separate', () => {
  const usage = source.slice(source.indexOf('function renderPrimaryUsage('), source.indexOf('export function renderTabActions('));
  assert.ok(source.includes('renderPrimaryUsage(item)')); assert.ok(usage.includes('const usage = usageFacts(item, item ? primaryBlocks(state, item.key) : undefined)'));
  assert.ok(usage.includes("element('span', 'usage-fact', fact.text)")); assert.ok(usage.includes('node.dataset.key = fact.key'));
  assert.ok(usage.includes("element('p', 'usage-detail', fact.detail)")); assert.ok(usage.includes('if (!fact.summary) continue'));
  assert.doesNotMatch(usage, /element\('meter'|usage-separator|launchCwd/);
  assert.match(source, /projectIdentity\(\{cwd:projectPath\(\)\}, launchCwd, picker\.projectPaths\(\)\)/); assert.ok(html.includes('id="primary-context"'));
});

test('queued primary input renders labeled text, preserves full titles and clears when empty', () => {
  const list = primaryControl('queued');
  app.renderPrimaryQueue({pending: 2, steering: ['Check this first\nThen inspect the output'], followUp: ['<tag>literal input</tag>']});
  assert.equal(list.hidden, false); assert.equal(list.children.length, 2);
  assert.deepEqual(list.children.map(row => ({tag: row.tagName, className: row.className, mode: row.dataset.mode, text: row.textContent, title: row.title})), [
    {tag: 'li', className: 'queued-message', mode: 'steer', text: 'Next step: Check this first\nThen inspect the output', title: 'Check this first\nThen inspect the output'},
    {tag: 'li', className: 'queued-message', mode: 'followUp', text: 'After response: <tag>literal input</tag>', title: '<tag>literal input</tag>'},
  ]);
  app.renderPrimaryQueue({pending: 1, followUp: ['Only follow-up']}); assert.equal(list.children.length, 1); assert.equal(list.children[0]?.dataset.mode, 'followUp');
  app.renderPrimaryQueue({pending: 0, steering: [], followUp: []}); assert.equal(list.hidden, true); assert.equal(list.children.length, 0);
  app.renderPrimaryQueue(undefined); assert.equal(list.hidden, true);
  const form = primaryControl('composer'); assert.equal(list.parentNode, form); assert.ok(form.children.indexOf(list) < form.children.findIndex(node => node.classList.contains('composer-input')));
  assert.ok(source.includes('renderPrimaryQueue(conversation?.queue)')); assert.ok(source.includes("name === 'primary.recovery' || name === 'primary.queue'"));
});

test('every stored appearance value reads as dark, light or system and a missing value follows the OS', async () => {
  const assignment = source.match(/document\.documentElement\.dataset\.appearance = ([^;]+);/); assert.ok(assignment);
  assert.equal(assignment[1], 'resolveAppearance(state.workspace.appearance)');
  const expected: Record<string, string> = {dark: 'dark', light: 'light', system: 'system', latte: 'light', frappe: 'dark', macchiato: 'dark', mocha: 'dark'};
  for (const appearance of [...Object.keys(expected), undefined]) {
    await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', ...(appearance ? {appearance} : {})}, primaries: [primaryFixture()], roster: []});
    assert.equal(hostDocument.documentElement.dataset.appearance, appearance ? expected[appearance] : 'system');
  }
});
test('editors keep accessible recipient labels and recipient placeholders', async () => {
  const row=agentFixture('labels-agent'); await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:row.identity},conversationLayout:twoPanes(row.identity)},primaries:[primaryFixture({epoch:709})],roster:[row]});
  for(const control of [primaryControl,agentControl]){const editor=control('editor') as HostNode & {placeholder:string}; assert.equal(editor.placeholder.replace(' · @ files…','…'),`${control('recipient').textContent.replace(/^Draft for /, 'Message ')}…`); assert.match(editor.placeholder,/ · @ files…$/,'a loaded working folder names the typed @ trigger'); assert.equal((control('recipient') as HostNode & {htmlFor:string}).htmlFor,editor.id); assert.match(control('recipient').textContent,/^Message /);}
});

test('pane tabs keep separate menus and focused facts while both target owners stay retained', async () => {
  const identity='agent-pane',agent={kind:'agent' as const,identity}; await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:agent,conversationLayout:twoPanes(identity)},primaries:[primaryFixture({epoch:710})],roster:[agentFixture(identity)],observations:[observation(identity)],targets:[targetFixture('pane-p',{kind:'primary',key:'p',epoch:710},{draft:{revision:1,text:'Primary draft',mode:'steer',persisted:true}}),targetFixture('pane-a',agent,{draft:{revision:1,text:'Agent draft',mode:'prompt',persisted:true}})]});
  const p=controls(app.primaryComposer()),a=controls(app.agentComposer()),pe=p('editor'),ae=a('editor'); pe.setSelectionRange(1,3); ae.setSelectionRange(2,4); byId('primary-usage-details').open=true;
  app.focusPane('primary-pane'); await settle(); assert.equal(hostDocument.activeElement,pe); assert.equal(byId('workbench-status').dataset.pane,'primary'); assert.equal(byId('workbench-status-primary').hidden,false); assert.equal(byId('workbench-status-agent').hidden,true); assert.equal(byId('workbench-scope').title,`${byId('workbench-scope').textContent}\np`); assert.equal(app.state.conversations.get(JSON.stringify(['agent',identity]))?.connectionEpoch,1);
  for(const pane of ['primary-pane','agent-pane']){app.openTabActions(pane);assert.equal(menuNode().getAttribute('aria-label'),'Tab and view actions');contextMenu.close();}
  app.focusPane('agent-pane');await settle();assert.equal(hostDocument.activeElement,ae);assert.equal(byId('workbench-scope').title,`${byId('workbench-scope').textContent}\n${identity}`);assert.equal(byId('workbench-status-primary').hidden,true);assert.equal(byId('workbench-status-agent').hidden,false);assert.equal(a('editor'),ae);assert.equal(p('editor'),pe);assert.deepEqual([pe.selectionStart,pe.selectionEnd],[1,3]);assert.deepEqual([ae.selectionStart,ae.selectionEnd],[2,4]);assert.equal(byId('primary-usage-details').open,true);
});

test('pointer pane focus holds footer geometry before paint and leaves native actions in their existing phase', async t => {
  const identity = 'pointer-focus-owner';
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 711})], roster: [agentFixture(identity)]});
  app.focusPane('agent-pane'); await settle();
  const footer = byId('workbench-status'), scope = byId('workbench-scope'), style = footer.style, agentEditor = agentControl('editor');
  const bounds = footer.getBoundingClientRect, attribute = scope.setAttribute;
  let height = 26, measurements = 0, paints = 0, pressed = false, clicks = 0;
  Reflect.set(style, 'getPropertyPriority', () => '');
  Reflect.set(footer, 'getBoundingClientRect', () => {measurements++; return {...bounds.call(footer), height};});
  Reflect.set(scope, 'setAttribute', function(this: HostNode, name: string, value: string) {
    if (pressed && name === 'aria-label') {paints++; assert.equal(style.getPropertyValue('height'), `${height}px`, 'The immediate selection paint retains the pressed geometry.');}
    attribute.call(this, name, value);
  });
  const latest = primaryControl('composer').querySelector('.latest'); assert.ok(latest);
  const clicked = () => {clicks++; assert.equal(style.getPropertyValue('height'), '26px', 'The existing target handler precedes geometry cleanup.');};
  latest.addEventListener('click', clicked);
  t.after(() => {for (const pointerId of [41, 42, 43, 44]) for (const handler of documentHandlers.get('pointercancel') ?? []) handler({pointerId}); latest.removeEventListener('click', clicked); Reflect.set(footer, 'getBoundingClientRect', bounds); Reflect.set(scope, 'setAttribute', attribute); Reflect.deleteProperty(style, 'getPropertyPriority');});
  const keyboardAgent = () => {agentEditor.blur(); agentEditor.focus();};
  const before = transportLog.length;
  const press = (node: HostNode, pointerId: number) => node.dispatch('pointerdown', {type: 'pointerdown', pointerId, button: 0, isPrimary: true});
  const content = paneNode('primary-pane').querySelector('.pane-content'); assert.ok(content);
  pressed = true; press(latest, 41);
  assert.equal(app.focusedPane, 'primary-pane'); assert.equal(footer.dataset.pane, 'primary'); assert.ok(paints > 0);
  assert.equal(style.getPropertyValue('height'), '26px'); assert.equal(clicks, 0); assert.equal(measurements, 1);
  press(content, 41); assert.equal(measurements, 1, 'The second focus site does not acquire again for this press.');
  latest.dispatch('click', {pointerId: 41}); pressed = false;
  assert.equal(clicks, 1); assert.equal(style.getPropertyValue('height'), ''); await settle();
  keyboardAgent(); await settle();
  assert.equal(app.focusedPane, 'agent-pane'); assert.equal(footer.dataset.pane, 'agent');
  assert.equal(measurements, 1, 'Keyboard focus has no pointer hold.'); assert.equal(style.getPropertyValue('height'), '');
  height = 63; pressed = true; press(content, 42); pressed = false;
  assert.equal(app.focusedPane, 'primary-pane'); assert.equal(style.getPropertyValue('height'), '63px'); assert.equal(measurements, 2);
  byId('workbench-version').focus(); assert.equal(style.getPropertyValue('height'), '', 'Footer focus restores access to facts immediately.'); await settle();
  keyboardAgent(); await settle(); press(content, 43);
  for (const handler of documentHandlers.get('pointercancel') ?? []) handler({pointerId: 43});
  assert.equal(style.getPropertyValue('height'), ''); assert.equal(clicks, 1); flushFrames(); await settle();
  keyboardAgent(); await settle(); press(content, 44);
  for (const handler of documentHandlers.get('pointerup') ?? []) handler({pointerId: 44});
  assert.equal(style.getPropertyValue('height'), '63px'); flushFrames(); await settle();
  assert.equal(style.getPropertyValue('height'), ''); assert.equal(clicks, 1);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs') || call.path.endsWith('/start') || (call.path === '/api/primaries' && call.method === 'POST')).length, 0);
});

test('footer facts follow a Message recipient while Primary stays selected', async () => {
  const recipient=agentFixture('footer-recipient'),target={kind:'primary' as const,key:'p',epoch:8600}; await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:8600})],roster:[recipient],targets:[targetFixture('footer-p',target),targetFixture('footer-b',{kind:'agent',identity:recipient.identity},{draft:{revision:1,text:'Recipient draft',mode:'prompt',persisted:true}})]});
  byId('roster').querySelector('[data-identity="footer-recipient"]')?.querySelector('.row-message')?.click(); await settle(); const editor=messageControl('editor');editor.focus();editor.setSelectionRange(2,6); const disclosure=byId('agent-usage-details');disclosure.open=true;
  assert.equal(byId('workbench-status').dataset.pane,'agent');assert.equal(byId('workbench-scope').title,`${byId('workbench-scope').textContent}\n${recipient.identity}`);assert.deepEqual(app.state.workspace?.selectedTarget,target);assert.equal(editor.value,'Recipient draft');assert.equal(byId('workbench-status-primary').hidden,true);assert.equal(byId('workbench-status-agent').hidden,false);app.renderConnection();assert.equal(byId('workbench-scope').title,`${byId('workbench-scope').textContent}\n${recipient.identity}`);assert.equal(messageControl('editor'),editor);assert.equal(hostDocument.activeElement,editor);assert.deepEqual([editor.selectionStart,editor.selectionEnd],[2,6]);assert.equal(disclosure.open,true);byId('agent-message-close').click();await settle();
});
test('explicit observed conversation activation focuses its editor while incidental repaint retains Primary focus', async () => {
  const identity='row-focus',target={kind:'agent' as const,identity}; await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:twoPanes(identity)},primaries:[primaryFixture({epoch:778})],roster:[agentFixture(identity)],observations:[observation(identity)],targets:[targetFixture('row-p',{kind:'primary',key:'p',epoch:778},{draft:{revision:1,text:'Primary row draft',mode:'steer',persisted:true}}),targetFixture('row-a',target,{draft:{revision:1,text:'Agent row draft',mode:'prompt',persisted:true}})]});
  const p=controls(app.primaryComposer()),a=controls(app.agentComposer()),pe=p('editor'),ae=a('editor');pe.setSelectionRange(2,7);ae.setSelectionRange(3,8);app.focusPane('primary-pane');await settle();const readings=[...app.state.targets.values()].map(item=>item.reading),before=transportLog.length;
  const row=byId('sidebar-conversations').querySelector('[data-tab-key="agent:row-focus"]');assert.ok(row);row.click();await settle();assert.equal(hostDocument.activeElement,ae);assert.equal(app.focusedPane,'agent-pane');assert.deepEqual(app.state.workspace?.selectedTarget,target);assert.equal(byId('sidebar-conversations').querySelector('[data-tab-key="agent:row-focus"]')?.getAttribute('aria-current'),'true');assert.equal(paneNode('primary-pane').dataset.focused,'false');assert.equal(paneNode('agent-pane').dataset.focused,'true');assert.equal(pe.value,'Primary row draft');assert.equal(ae.value,'Agent row draft');assert.deepEqual([...app.state.targets.values()].map(item=>item.reading),readings);
  app.focusPane('primary-pane');await settle();await app.reload();await settle();assert.equal(hostDocument.activeElement,pe);assert.equal(app.focusedPane,'primary-pane');tabsNode('agent-pane').querySelector('[data-tab-key="agent:row-focus"]')?.click();await settle();assert.equal(hostDocument.activeElement,ae);assert.equal(p('editor'),pe);assert.equal(a('editor'),ae);assert.deepEqual([pe.selectionStart,pe.selectionEnd],[2,7]);assert.deepEqual([ae.selectionStart,ae.selectionEnd],[3,8]);assert.equal(transportLog.slice(before).filter(call=>call.path.endsWith('/start')||call.path.includes('/inputs')).length,0);
});

test('the whole-workbench footer owns facts while composers retain direct delivery actions', async () => {
  const identity='delivery-owner';await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity},conversationLayout:twoPanes(identity)},primaries:[primaryFixture({epoch:9538})],roster:[agentFixture(identity)]});const agent=controls(app.agentComposer());
  app.focusPane('primary-pane'); await settle(); const footer=byId('workbench-status'); for(const id of ['primary-context','primary-usage','extension-status'])assert.equal(footer.contains(byId(id)),true);for(const name of ['model','thinking'])assert.equal(footer.contains(primaryControl(name)),false);assert.ok(primaryControl('composer').contains(primaryControl('model')));
  const slots=byId('focused-composer-status'); assert.equal(slots.children.length,2); assert.match(slots.children[0]?.id??'',/-save$/); assert.match(slots.children[1]?.id??'',/-receipt-details$/);
  for(const owner of [primaryControl,agent]){const form=owner('composer');assert.ok(form.contains(owner('modes')));assert.ok(form.contains(owner('send')));assert.equal(form.querySelector('.usage-details'),null);assert.equal(form.querySelector('.composer-guidance'),null);assert.ok(form.querySelector('.composer-settings'));}assert.ok(source.includes("elements.model?.addEventListener('click', () => actions.modelPicker())"));assert.ok(source.includes("elements.thinking?.addEventListener('click', () => actions.thinkingPicker())"));
});

test('a live agent with unavailable catalog metadata keeps title pane and composer coherent without a Primary', async () => {
  const row=agentFixture('a', {state:'unavailable', availability:'live', name:'Worker'});
  await arrive({workspace:{id:'w',revision:1,selectedTarget:{kind:'agent',identity:'a'},panelVisible:true},primaries:[],roster:[row],targets:[targetFixture('agent-a',{kind:'agent',identity:'a'})]});
  assert.equal(hostDocument.title,'Pi · Worker · Ready'); assert.equal(byId('primary-row').hidden,true); assert.equal(byId('project-name').textContent,'project'); assert.equal(byId('project-button').title, 'Working folder: /fixture/project');
  const active = tabsNode().children.find(node => node.attributes.get('aria-selected') === 'true'); assert.ok(active); assert.equal(active.querySelector('.tab-state'), null); assert.match(active.getAttribute('aria-label') ?? '', /Ready/); assert.equal(active.querySelector('.tab-dot')?.title, 'Ready');
  assert.equal(agentControl('recipient').textContent,'Message Worker'); assert.equal(agentControl('send').disabled,true); assert.equal(agentControl('editor').disabled,false);
});

test('sidebar sections retain their collapsed state per workspace and tab and filter focus expands agents', async () => {
  const values = new Map<string, string>();
  Reflect.set(globalThis, 'sessionStorage', {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}});
  const workspace = (id: string): Workspace => ({id, revision: 1, primaryKey: 'p'});
  await arrive({workspace: workspace('w'), primaries: [primaryFixture()], roster: []});
  app.renderSidebarSections(); assert.equal(byId('agents-heading').attributes.get('aria-expanded'), 'false');
  assert.equal(byId('agents-section-body').hidden, true); assert.equal(byId('primary-section-body').hidden, true);
  app.setSidebarSection('agents', false);
  assert.equal(byId('agents-section-body').hidden, false); assert.equal(values.get('ui:sections:w:agents'), 'false'); assert.equal(byId('agents-count').hidden, true);
  app.setSidebarSection('agents', true); assert.equal(values.get('ui:sections:w:agents'), 'true');
  app.setSidebarSection('files', true); assert.equal(values.get('ui:sections:w:files'), 'true');
  assert.equal(byId('files-heading').getAttribute('aria-expanded'), 'false'); assert.equal(byId('files-section-body').hidden, true);
  await arrive({workspace: workspace('w'), primaries: [primaryFixture()], roster: []});
  app.renderSidebarSections(); assert.equal(byId('agents-section-body').hidden, true);
  await arrive({workspace: workspace('other'), primaries: [primaryFixture()], roster: []});
  app.renderSidebarSections(); assert.equal(byId('agents-section-body').hidden, true);
  await arrive({workspace: workspace('w'), primaries: [primaryFixture()], roster: []});
  app.renderSidebarSections(); assert.equal(byId('agents-section-body').hidden, true);
  assert.equal(byId('files-section-body').hidden, true); app.setSidebarSection('files', false);
  assert.equal(byId('files-heading').getAttribute('aria-expanded'), 'true'); assert.equal(byId('files-section-body').hidden, false);
  assert.equal(byId('agents-section-body').hidden, true);
  byId('sidebar').hidden = true; const before = browser.frameCount; app.focusAgentSearch(); await settle();
  assert.equal(byId('sidebar').hidden, false); assert.equal(byId('agents-section-body').hidden, false);
  assert.equal(hostDocument.activeElement, byId('agent-search')); assert.ok(browser.frameCount > before);
  const denied = () => {throw new Error('denied');};
  Reflect.set(globalThis, 'sessionStorage', {getItem: denied, setItem: denied, removeItem: denied});
  assert.doesNotThrow(() => app.setSidebarSection('agents', true)); app.renderSidebarSections();
  assert.equal(byId('agents-section-body').hidden, true);
  Reflect.set(globalThis, 'sessionStorage', hostSessionStorage);
  assert.doesNotMatch(html, /id="primary-heading"/);
  assert.match(html, /id="session-open"[^>]*aria-haspopup="dialog">Find session…/);
  assert.match(html, /id="tabs-open-session"[^>]*>Find session…/);
  for (const section of ['files', 'agents']) { assert.equal(byId(`${section}-heading`).querySelector('svg'), null); assert.ok(byId(`${section}-count`)); }
  assert.match(html, /id="agents-heading" class="section-toggle"[^>]*aria-controls="agents-section-body">AGENTS/);
});
test('palette key aliases prevent browser defaults and preserve IME, repeat and open-dialog guards', async () => {
  const modalNode = byId('modal');
  const closeDialog = () => { if (modalNode.open) { modalNode.open = false; modalNode.dispatch('close'); } };
  const press = (key: string, options: Record<string, boolean> = {}) => {
    const pressed = {key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options};
    app.appKey(pressed as never); return pressed;
  };
  for (const modifier of ['metaKey', 'ctrlKey']) {
    closeDialog();
    assert.equal(press('k', {[modifier]: true}).defaultPrevented, true);
    assert.equal(modalNode.open, true); assert.equal(modalNode.dataset.mode, 'commands');
    closeDialog();
    assert.equal(press('P', {[modifier]: true, shiftKey: true}).defaultPrevented, true);
    assert.equal(modalNode.dataset.mode, 'commands');
    closeDialog();
    assert.equal(press('p', {[modifier]: true}).defaultPrevented, true);
    assert.equal(modalNode.dataset.mode, 'goto');
    closeDialog();
  }
  const count = byId('modal-title').writes;
  assert.equal(press('p', {metaKey: true, isComposing: true}).defaultPrevented, false);
  assert.equal(press('p', {metaKey: true, altKey: true}).defaultPrevented, false); assert.equal(press('p').defaultPrevented, false);
  assert.equal(modalNode.open, false); assert.equal(byId('modal-title').writes, count);
  press('k', {metaKey: true}); assert.equal(modalNode.open, true); const openTitle = byId('modal-title').writes;
  assert.equal(press('p', {metaKey: true, repeat: true}).defaultPrevented, true);
  assert.equal(byId('modal-title').writes, openTitle); assert.equal(modalNode.dataset.mode, 'commands');
  press('p', {ctrlKey: true}); assert.equal(byId('modal-title').writes, openTitle);
  closeDialog();
  assert.ok(source.includes("document.addEventListener('keydown', appKey)"));
});

test('tab selection changes the observation atomically and split-only edits keep the selection lane', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:'a'},conversationLayout:singlePane([{kind:'primary'},{kind:'agent',identity:'a'}],'agent:a')},primaries:[primaryFixture()],roster:[agentFixture('a')]});selectionSaves.length=0;transportLog.length=0;
  app.applyLayout(twoPanes('a'));await settle();assert.ok(selectionSaves[0]?.body.conversationLayout);assert.deepEqual(selectionSaves[0]?.body.selectedTarget,{kind:'agent',identity:'a'});assert.equal(selectionSaves[0]?.body.panelVisible,true);
  app.applyLayout(singlePane());await settle();assert.deepEqual(selectionSaves[1]?.body.selectedTarget,{kind:'primary',key:'p',epoch:1});app.applyLayout(singlePane([]));await settle();assert.equal(selectionSaves[2]?.body.selectedTarget,null);assert.equal(selectionSaves[2]?.body.panelVisible,false);assert.equal(transportLog.filter(call=>call.path==='/api/operations').length,0);
});
test('split panes retain both transcript and composer nodes and use the shared resize primitive', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:'split-a'},conversationLayout:singlePane([{kind:'primary'},{kind:'agent',identity:'split-a'}],'agent:split-a')},primaries:[primaryFixture({epoch:711})],roster:[agentFixture('split-a')]});const p=controls(app.primaryComposer()),a=controls(app.agentComposer()),roots=[p('root'),a('root')],editors=[p('editor'),a('editor')],transcripts=[p('transcript'),a('transcript')],forms=[p('composer'),a('composer')];
  app.applyLayout(twoPanes('split-a'));await settle();assert.equal(p('root'),roots[0]);assert.equal(a('root'),roots[1]);assert.equal(p('editor'),editors[0]);assert.equal(a('editor'),editors[1]);assert.equal(p('transcript'),transcripts[0]);assert.equal(a('transcript'),transcripts[1]);assert.equal(p('composer'),forms[0]);assert.equal(a('composer'),forms[1]);const handle=byId('conversation-panes').querySelector('.pane-divider');assert.ok(handle);assert.equal(handle.getAttribute('role'),'separator');assert.equal(handle.tabIndex,0);handle.dispatch('keydown',{key:'ArrowRight'});await settle();assert.ok(selectionSaves.at(-1)?.body.conversationLayout);
});
test('an addressed split retains Primary and agent owners without a permanent Split control', async () => {
  const identity='split-target';const layout=singlePane([{kind:'primary'},{kind:'agent',identity}]);await arrive({workspace:{id:'w',revision:1,primaryKey:'p',conversationLayout:layout},primaries:[primaryFixture({epoch:712})],roster:[agentFixture(identity)]});app.focusPane(app.focusedPane);await settle();const p=controls(app.primaryComposer()),editor=p('editor');editor.value='Retain the Primary draft';editor.dispatch('input');editor.setSelectionRange(3,8);editor.dispatch('select');
  const next=splitPane(layout,'pane-1','x',{width:1400,height:640,divider:4},`agent:${identity}`);app.applyLayout(next);await settle();assert.deepEqual(app.state.workspace?.selectedTarget,{kind:'agent',identity});assert.equal(p('editor'),editor);assert.equal(editor.value,'Retain the Primary draft');assert.deepEqual([editor.selectionStart,editor.selectionEnd],[3,8]);assert.equal(paneLeaves(app.state.workspace?.conversationLayout?.root??next.root).length,2);assert.equal(hostDocument.getElementById('tab-split'),undefined);
});

test('Primary tool start and end refresh the pane and active tab without another state event', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({activity: 'running'})], roster: []});
  const target = {kind: 'primary' as const, key: 'p', epoch: 1};
  const activeStatus = () => tabsNode().children.find(node => node.attributes.get('aria-selected') === 'true')?.querySelector('.tab-dot')?.title;
  assert.equal(activeStatus(), 'Working');
  event('primary.tool', {callId: 'chrome-tool', name: 'generic', phase: 'start', arguments: {value: {}, truncated: false}}, target);
  assert.equal(activeStatus(), 'Working · generic');
  event('primary.tool', {callId: 'chrome-tool', name: 'generic', phase: 'end'}, target);
  assert.equal(activeStatus(), 'Working');
});

test('stream bursts reduce immediately and defer the Primary transcript index to one frame', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []}); flushFrames();
  const {Transcript} = await import('./render.ts'); const transcript = primaryControl('transcript'); const set = Transcript.prototype.set; let indexed = 0;
  Transcript.prototype.set = function (...args: Parameters<typeof set>) { if (this.node === transcript as unknown) indexed++; return set.apply(this, args); };
  try {
    const editor = primaryControl('editor'); editor.value = 'Keep this local draft'; editor.focus(); editor.setSelectionRange(3, 7);
    const before = transportLog.length; const target = {kind: 'primary' as const, key: 'p', epoch: 1};
    for (let delta = 0; delta < 20; delta++) event('primary.delta', {messageId: 'burst-message', index: 0, kind: 'text', delta: 'x'}, target);
    assert.equal(indexed, 0); assert.equal(app.state.conversations.get(JSON.stringify(['primary', 'p', 1]))?.messages.has('burst-message'), true);
    assert.equal(editor.value, 'Keep this local draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [3, 7]); assert.equal(hostDocument.activeElement, editor);
    flushFrames(); assert.equal(indexed, 1); assert.match(primaryControl('transcript').textContent, /x{20}/);
    assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
  } finally { Transcript.prototype.set = set; }
});
test('loaded assistant usage refreshes on completed messages and history, not streaming deltas or partials', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({contextUsage: {tokens: 1000, contextWindow: 4000, percent: 25}})], roster: []});
  flushFrames();
  const usageNode = byId('primary-usage'); const baseline = usageNode.writes;
  const coverageTiny = {complete: true, truncated: false, omitted: 0};
  const primary = {kind: 'primary' as const, key: 'p', epoch: 1};
  event('primary.delta', {messageId: 'm1', index: 0, kind: 'text', delta: 'streaming'}, primary);
  event('primary.tool', {callId: 'c1', name: 'generic', phase: 'start', arguments: {value: {}, truncated: false}}, primary);
  event('primary.entry', {entry: {id: 'e-side', kind: 'notice', data: {value: 'side', truncated: false}}}, primary);
  event('primary.message', {message: {id: 'm1', role: 'assistant', parts: [textPart('streaming')], state: 'partial', coverage: coverageTiny}}, primary);
  flushFrames(); await settle();
  assert.equal(usageNode.writes, baseline);
  event('primary.message', {message: {id: 'm1', role: 'assistant', parts: [textPart('streaming')], state: 'final', coverage: coverageTiny,
    usage: {input: 4, cacheRead: 4, cacheWrite: 0}}}, primary);
  flushFrames(); await settle();
  assert.ok(usageNode.writes > baseline);
  assert.match(usageNode.textContent, /input 4, cache read 4, cache write 0/);
  assert.match(byId('primary-usage-summary').textContent, /Cache 50%/); assert.match(usageNode.textContent, /Loaded assistant window only/);
  assert.doesNotMatch(byId('primary-usage-summary').textContent, /●/);
  assert.ok(descendants(primaryControl('transcript')).some(node => node.textContent.includes('streaming')));
  const final = {...messageFixture('history-usage', [textPart('Earlier usage')]), usage: {input: 9, cacheRead: 3, cacheWrite: 0}};
  browser.fixture = {...browser.fixture, history: [entryFixture('history-usage-entry', [final])]}; await app.reload(); await settle();
  assert.match(usageNode.textContent, /input 13, cache read 7, cache write 0/);
});
test('image URLs bind each transcript pane rather than the movable composer or active pane', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  event('primary.message', {message: {id: 'img1', role: 'user', parts: [imagePart('img1')], state: 'final', coverage}}, {kind: 'primary', key: 'p', epoch: 1});
  flushFrames(); await settle();
  const primaryImage = descendants(primaryControl('transcript')).find(node => node.tagName === 'img');
  assert.ok(primaryImage); assert.match(String(primaryImage.properties.get('src') ?? (primaryImage as {src?: string}).src ?? ''), /^\/api\/primaries\/p\/history\/image\?/);
  assert.match(String((primaryImage as {src?: string}).src ?? ''), /workspace=w/); assert.match(String((primaryImage as {src?: string}).src ?? ''), /epoch=1/);
  const frame: ProjectedFrame = {revision: 1, observedAt: '', entries: [entryFixture('img2', [messageFixture('img2', [imagePart('img2')])])], live: [], nextBefore: null, status: {busy: false}, coverage};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'a'}, panelVisible: true}, primaries: [primaryFixture()],
    roster: [agentFixture('a')], targets: [targetFixture('image-a', {kind: 'agent', identity: 'a'})], observations: [observation('a', frame)]});
  flushFrames(); await settle();
  const agentImage = descendants(agentControl('transcript')).find(node => node.tagName === 'img');
  assert.ok(agentImage); assert.match(String((agentImage as {src?: string}).src ?? ''), /^\/api\/agents\/a\/history\/image\?/);
  assert.match(String((agentImage as {src?: string}).src ?? ''), /workspace=w/);
  assert.doesNotMatch(String((agentImage as {src?: string}).src ?? ''), /epoch/);
});
test('metadata summary keeps context counts together and details expose scope without meters or dots', () => {
  const facts = [
    {key: 'context', text: 'Context unknown', title: 'Unknown context', detail: 'Current Primary context is unknown.', summary: true},
    {key: 'contextTokens', text: '?/1k', title: 'Estimated tokens', detail: 'Model window: 1,000 tokens.', summary: true},
    {key: 'cost', text: 'Session ~$0.01', title: 'Reported cost', detail: 'Whole-session estimate, not billing.', summary: true},
    {key: 'cacheHitShare', text: 'Cache 50% · loaded', title: 'Loaded window only', detail: 'Loaded finalized assistant usage only.', summary: true},
    {key: 'unavailable', text: 'Unavailable', title: 'No report', detail: 'Not reported, not zero.', summary: false},
  ];
  const nodes = app.usageNodes({facts, contextFraction: null}, true);
  assert.equal(nodes.length, 3); assert.deepEqual(nodes.map(node => node.dataset.group), ['context', 'cost', 'cache']);
  assert.deepEqual(nodes[0]?.children.map(node => node.textContent), ['Context unknown', '?/1k']);
  assert.ok(nodes.every(node => node.className === 'usage-group'));
  for (const group of nodes) for (const node of group.children) { assert.equal(node.className, 'usage-fact'); assert.equal(node.attributes.get('aria-label'), node.title); }
  const details = app.usageNodes({facts, contextFraction: .25}, false);
  assert.deepEqual(details.map(node => node.textContent), facts.map(fact => fact.detail));
  assert.ok(details.every(node => node.tagName === 'p')); assert.equal(app.usageNodes({facts: [], contextFraction: null}, true).length, 0);
});

test('session reload restores the ready composer after dialog close without changing its draft', async () => {
  const saved = targetFixture('primary-draft', {kind: 'primary', key: 'p', epoch: 8800}, {draft: {revision: 1, text: 'Retained session draft', mode: 'prompt', persisted: true}});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: saved.target}, primaries: [primaryFixture({epoch: 8800, activity: 'idle'})], roster: [], targets: [saved]});
  const editor = primaryControl('editor'); assert.equal(editor.value, 'Retained session draft');
  byId('project-button').focus(); byId('modal').showModal(); await app.reloadSelection(); byId('modal').close();
  assert.equal(hostDocument.activeElement, editor); assert.equal(editor.value, 'Retained session draft'); assert.equal(editor.disabled, false);
});
test('context menus capture inactive tabs and never close a later selection', async () => {
  const layout=singlePane([{kind:'primary'},{kind:'agent',identity:'menu-a'},{kind:'agent',identity:'menu-b'}]);const base={workspace:{id:'w',revision:1,primaryKey:'p',conversationLayout:layout},primaries:[primaryFixture({epoch:713})],roster:[agentFixture('menu-a'),agentFixture('menu-b')]};await arrive(base);
  const tab=tabsNode().querySelector('[data-tab-key="agent:menu-a"]');assert.ok(tab);pressContext(tab);const close=menuNode().children.find(node=>node.textContent==='Close tab');assert.ok(close);close.click();await settle();assert.deepEqual(paneLeaves(app.state.workspace?.conversationLayout?.root??layout.root).flatMap(pane=>pane.tabs).map(tabKey),['primary','agent:menu-b']);
  await arrive(base);const stale=tabsNode().querySelector('[data-tab-key="agent:menu-a"]');assert.ok(stale);pressContext(stale);const staleClose=menuNode().children.find(node=>node.textContent==='Close tab');assert.ok(staleClose);app.applyLayout(activatePaneTab(layout,'pane-1','agent:menu-b'));await settle();const saves=selectionSaves.length;staleClose.click();await settle();assert.equal(selectionSaves.length,saves);assert.deepEqual(app.state.workspace?.selectedTarget,{kind:'agent',identity:'menu-b'});assert.match(byId('announcements').textContent,/changed.*again/);
});
test('agent and Primary pane menus expose supported actions while text inputs keep native menus', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:'context-agent'},conversationLayout:twoPanes('context-agent')},primaries:[primaryFixture({epoch:714})],roster:[agentFixture('context-agent',{capabilities:{input:true,inspect:true}})]});app.openConversationActions('agent-pane');for(const label of ['Message','Copy agent ID','Conversation details','Sent and received tasks…','Open in Pi terminal…'])assert.ok(menuNode().children.some(node=>node.textContent===label));assert.equal(menuNode().children.some(node=>node.textContent==='New session'),false);contextMenu.close();assert.equal(hostDocument.activeElement,paneNode('agent-pane').querySelector('.pane-conversation-actions'));
  pressContext(primaryControl('editor'));assert.equal(contextMenu.openNow,false);app.openConversationActions('primary-pane');assert.equal(menuNode().children.some(node=>['Appearance','Help','Model','Thinking','Refresh agent roster'].includes(node.textContent)),false); assert.ok(menuNode().children.some(node=>node.textContent==='Commands…')); const thinking = menuNode().children.find(node=>node.textContent==='Show thinking'); assert.ok(thinking); assert.equal(thinking.getAttribute('role'),'menuitemcheckbox'); assert.equal(thinking.getAttribute('aria-checked'),'true'); assert.equal(menuNode().children.some(node=>node.textContent==='Hide thinking'),false); assert.equal(menuNode().children.some(node=>node.textContent==='Show conversation'),false);contextMenu.close();
});
test('an agent tab without a roster row keeps its conversation actions but not Show conversation or Message', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'agent',identity:'child-agent:23464'},conversationLayout:twoPanes('child-agent:23464')},primaries:[primaryFixture({epoch:715})],roster:[]});
  app.openConversationActions('agent-pane'); const labels=menuNode().children.map(node=>node.textContent);
  for(const label of ['Sent and received tasks…','Open in Pi terminal…','Find text','Show thinking','Expand loaded tools','Collapse loaded tools','Conversation details','Copy agent ID','Commands…'])assert.ok(labels.includes(label),label);
  for(const label of ['Show conversation','Message'])assert.equal(labels.includes(label),false,label);
  contextMenu.close();
});
test('direct conversation actions capture each inactive pane without navigation or editor replacement', async () => {
  const identity = 'direct-menu-agent', primaryTarget = {kind: 'primary' as const, key: 'p', epoch: 716}, agentTarget = {kind: 'agent' as const, identity};
  await arrive({workspace: {id: 'direct-menu', revision: 1, primaryKey: 'p', selectedTarget: agentTarget, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 716})], roster: [agentFixture(identity)], targets: [targetFixture('direct-primary', primaryTarget, {draft: {revision: 1, text: 'Primary draft', mode: 'prompt', persisted: true}}), targetFixture('direct-agent', agentTarget, {draft: {revision: 1, text: 'Agent draft', mode: 'followUp', persisted: true}})]});
  const roots = [primaryControl('root'), agentControl('root')], editors = [primaryControl('editor'), agentControl('editor')], forms = [primaryControl('composer'), agentControl('composer')];
  const parents = editors.map(editor => editor.parentNode), formParents = forms.map(form => form.parentNode), values = editors.map(editor => editor.value);
  for (const editor of editors) editor.setSelectionRange(1, 4, 'backward');
  for (const [focused, inactive, index] of [['primary-pane', 'agent-pane', 1], ['agent-pane', 'primary-pane', 0]] as const) {
    app.focusPane(focused); await settle(); const selected = app.state.workspace?.selectedTarget, saves = selectionSaves.length, requests = transportLog.length;
    const root = roots[index], bar = paneNode(inactive).querySelector('.tab-bar'), trigger = bar?.querySelector('.pane-conversation-actions'); assert.ok(bar && trigger);
    assert.equal(bar.children.at(-1), trigger); assert.equal(bar.querySelectorAll('.pane-conversation-actions').length, 1); assert.equal(root.querySelectorAll('.inspection-navigation').length, 0);
    assert.equal(trigger.title, 'Conversation actions'); assert.equal(trigger.getAttribute('aria-label'), 'Conversation actions'); assert.equal(trigger.getAttribute('aria-haspopup'), 'menu'); assert.ok(trigger.querySelector('.card-icon-more'));
    trigger.dispatch('pointerdown', {type: 'pointerdown', button: 0, isPrimary: true}); trigger.focus(); trigger.click();
    assert.equal(app.focusedPane, focused); assert.deepEqual(app.state.workspace?.selectedTarget, selected); assert.equal(selectionSaves.length, saves); assert.equal(transportLog.length, requests);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true'); assert.equal(menuNode().getAttribute('aria-label'), 'Conversation actions');
    for (const label of ['Find text', 'Show thinking', 'Message input…', 'Conversation details']) assert.ok(menuNode().children.find(node => node.textContent === label));
    contextMenu.close(); assert.equal(hostDocument.activeElement, trigger); assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(app.focusedPane, focused);
    trigger.click(); const thinking = menuNode().children.find(node => node.textContent === 'Show thinking'); assert.ok(thinking); const shown = thinking.getAttribute('aria-checked'); thinking.click(); await settle();
    trigger.click(); assert.notEqual(menuNode().children.find(node => node.textContent === 'Show thinking')?.getAttribute('aria-checked'), shown); contextMenu.close();
    assert.equal(app.focusedPane, focused); assert.deepEqual(app.state.workspace?.selectedTarget, selected);
    const transcript=root.querySelector('.transcript'),other=roots[index===0?1:0].querySelector('.transcript');assert.ok(transcript&&other);const otherView=other.dataset.view;
    trigger.click();const grouped=menuNode().children.find(node=>node.textContent==='Grouped');assert.ok(grouped);assert.equal(grouped.getAttribute('aria-description'),'View: Grouped');assert.equal(grouped.getAttribute('role'),'menuitemradio');grouped.click();await settle();assert.equal(transcript.dataset.view,'grouped');assert.equal(other.dataset.view,otherView);
    app.openTabActions(inactive);const route=menuNode().children.find(node=>node.textContent==='Conversation actions…');assert.ok(route);route.click();const conversation=menuNode().children.find(node=>node.textContent==='Conversation');assert.ok(conversation);assert.equal(conversation.title,'View: Conversation');assert.equal(menuNode().children.find(node=>node.textContent==='Grouped')?.getAttribute('aria-checked'),'true');conversation.click();await settle();assert.equal(transcript.dataset.view,'chronological');assert.equal(other.dataset.view,otherView);assert.deepEqual(app.state.workspace?.selectedTarget,selected);
    assert.equal(root.dataset.paneId, inactive);
  }
  assert.equal(primaryControl('editor'), editors[0]); assert.equal(agentControl('editor'), editors[1]);
  assert.deepEqual(editors.map(editor => editor.parentNode), parents); assert.deepEqual(forms.map(form => form.parentNode), formParents); assert.deepEqual(editors.map(editor => editor.value), values);
  assert.deepEqual(editors.map(editor => [editor.selectionStart, editor.selectionEnd, editor.selectionDirection]), [[1, 4, 'backward'], [1, 4, 'backward']]);
});
test('direct conversation menu rejects an action after its captured layout changes', async () => {
  const identity = 'stale-direct-menu', layout = twoPanes(identity);
  await arrive({workspace: {id: 'stale-direct', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: layout}, primaries: [primaryFixture({epoch: 717})], roster: [agentFixture(identity)]});
  const trigger = paneNode('agent-pane').querySelector('.pane-conversation-actions'); assert.ok(trigger); trigger.click();
  const details = menuNode().children.find(node => node.textContent === 'Grouped'); assert.ok(details);const transcript=agentControl('transcript'),view=transcript.dataset.view;
  app.applyLayout({...layout, focusedPane: 'primary-pane'}); await settle(); const before = transportLog.length;
  details.click(); await settle(); assert.equal(transcript.dataset.view,view); assert.equal(transportLog.length, before); assert.match(byId('announcements').textContent, /changed.*again/); assert.equal(contextMenu.openNow, false);
});
test('a child conversation without its own name reads as its parent name plus its number', async () => {
  const root = '10000000-0000-4000-8000-0000000000aa', named = `${root}:31`, bare = `${root}:22260`, orphan = '10000000-0000-4000-8000-0000000000bb:7';
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: [agentFixture(root, {name: 'Web UI manager'}), agentFixture(named, {name: 'Observed worker'})]});
  const derived = app.toolSubjectCaption(bare); assert.equal(derived?.text, 'Web UI manager · 22260'); assert.equal(derived?.derived, true); assert.equal(derived?.title, bare);
  const own = app.toolSubjectCaption(named); assert.equal(own?.name, 'Observed worker'); assert.equal(own?.derived, undefined);
  assert.equal(app.toolSubjectCaption(orphan)?.derived, undefined); assert.equal(app.toolSubjectCaption(orphan)?.text, 'Unresolved conversation');
});
test('Primary model and thinking are picker buttons under its composer with accessible names', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({cwd: '/fixture', lifecycle: 'ready', model: {provider: 'provider', id: 'model', name: 'Model', reasoning: false, input: ['text']}, thinkingLevel: 'high'})], roster: []});
  const model = primaryControl('model'), thinking = primaryControl('thinking');
  assert.equal(model.textContent, 'model'); assert.equal(model.title, 'provider/model · Primary'); assert.equal(model.attributes.get('aria-label'), 'Model for Primary: provider/model');
  assert.equal(thinking.textContent, 'high'); assert.equal(thinking.attributes.get('aria-label'), 'Thinking level for Primary: high'); assert.ok(primaryControl('meta').contains(model)); assert.equal(primaryControl('settings').querySelector('.composer-settings-separator')?.hidden, false);
});

test('local conversation actions group existing controls and open workspace input settings without navigation', async () => {
  const identity = 'grouped-menu-agent';
  await arrive({workspace: {id: 'grouped-menu', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 715})], roster: [agentFixture(identity, {capabilities: {input: true, inspect: true}})]});
  const selected = app.state.workspace?.selectedTarget, saves = selectionSaves.length, requests = transportLog.length;
  app.openConversationActions('agent-pane'); const menu = menuNode();
  assert.deepEqual(menu.children.filter(node => node.className === 'context-menu-heading').map(node => node.textContent), ['View', 'Messages and tasks', 'Session', 'Details']);
  const labels = menu.children.filter(node => node.tagName === 'button').map(node => node.textContent);
  assert.deepEqual(labels, ['Conversation', 'Grouped', 'Show thinking', 'Find text', 'Expand loaded tools', 'Collapse loaded tools', 'Message', 'Sent and received tasks…', 'Saved drafts and messages', 'Message input…', 'Open in Pi terminal…', 'Conversation details', 'Copy agent ID', 'Commands…']);
  for (const label of ['Conversation', 'Grouped']) {const choice = menu.children.find(node => node.textContent === label); assert.ok(choice); assert.equal(choice.getAttribute('role'), 'menuitemradio'); assert.equal(choice.getAttribute('aria-description'), `View: ${label}`); assert.equal(choice.title, `View: ${label}`); assert.equal(choice.getAttribute('aria-checked'), String(label === 'Conversation'));}
  assert.equal(labels.includes('Show conversation'), false); assert.equal(labels.includes('New session'), false);
  menu.children.find(node => node.textContent === 'Message input…')?.click();
  assert.equal(byId('modal-title').textContent, 'Message input'); assert.match(byId('modal-body').textContent, /Applies to this workspace/);
  assert.deepEqual(app.state.workspace?.selectedTarget, selected); assert.equal(selectionSaves.length, saves); assert.equal(transportLog.length, requests);
  byId('modal-close').click(); app.focusPane('primary-pane'); await settle(); app.openConversationActions('primary-pane');
  assert.deepEqual(menuNode().children.filter(node => node.className === 'context-menu-heading').map(node => node.textContent), ['View', 'Messages and tasks', 'Session', 'Details']);
  const primaryLabels = menuNode().children.filter(node => node.tagName === 'button').map(node => node.textContent);
  assert.ok(primaryLabels.indexOf('New session') > primaryLabels.indexOf('Message input…')); assert.ok(primaryLabels.indexOf('Conversation details') > primaryLabels.indexOf('Continue in terminal…')); assert.equal(primaryLabels.at(-1), 'Commands…'); contextMenu.close();
});
test('composer settings preserve exact long values and existing eligibility without replacing controls', async () => {
  const id = 'long-model-value'.repeat(60);
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({lifecycle: 'ready', model: {provider: 'provider', id, name: id, reasoning: true, input: ['text']}, thinkingLevel: 'high'})], roster: []});
  const model = primaryControl('model'), thinking = primaryControl('thinking');
  app.primaryChrome(primaryFixture({model: {provider: 'provider', id, name: id, reasoning: true, input: ['text']}, thinkingLevel: 'high'}));
  assert.equal(byId('primary-settings-detail').textContent,`Model provider/${id} · Thinking high`);assert.equal(byId('primary-settings-detail').hidden,false);
  assert.equal(primaryControl('model'), model); assert.equal(primaryControl('thinking'), thinking); assert.equal(model.textContent, id); assert.equal(model.disabled, false); assert.equal(thinking.hidden, false);
  const current = app.state.primaries.get('p'); assert.ok(current); event('primary.state', {...current, lifecycle: 'starting', model: undefined, thinkingLevel: undefined}, {kind: 'primary', key: 'p', epoch: current.epoch}); await settle(); assert.equal(primaryControl('model'), model); assert.equal(model.hidden, true); assert.equal(model.disabled, true); assert.equal(thinking.hidden, true);assert.equal(byId('primary-settings-detail').hidden,true);assert.equal(byId('primary-settings-detail').textContent,'');
});
test('loaded prompt metadata updates Primary captions without input or target changes', async context => {
  const item=primaryFixture({epoch:42,sessionId:'caption-session',sessionFile:'/fixture/caption-session.jsonl',sessionName:undefined,extension:undefined,activity:'idle'});
  const target={kind:'primary' as const,key:item.key,epoch:item.epoch};await arrive({workspace:{id:'w',revision:1,primaryKey:item.key,selectedTarget:target},primaries:[item],roster:[]});
  const editor=primaryControl('editor'),text=editor.value,selection=[editor.selectionStart,editor.selectionEnd], original=globalThis.fetch;
  const prompt='Describe the exact current session '.repeat(5), response={items:[{id:item.sessionId,path:item.sessionFile,project:item.cwd,revision:'caption-r1',title:prompt,titleSource:'prompt',titleState:'ready',modifiedAt:'2026-01-01T00:00:00Z',size:10}],total:1,omitted:0,nextCursor:null,titleCursor:null,observedAt:'2026-01-02T00:00:00Z'};
  context.mock.method(globalThis,'fetch',async(input,init)=>String(input).startsWith('/api/sessions/published')?Response.json({ok:true,data:response}):String(input).startsWith('/api/sessions?')?Response.json({ok:true,data:{...response,items:[],total:0}}):original(input,init));
  context.after(()=>byId('modal-close').click());assert.equal(byId('primary-row-title').textContent,'Primary');
  const requests=transportLog.length;byId('session-open').click();await settle();
  const label=`${prompt.slice(0,64).trimEnd()}…`;assert.equal(byId('primary-row-title').textContent,label);assert.equal(primaryControl('recipient').textContent,`Message ${label}`);
  const row=byId('primary-row');assert.match(row.title,/Session ID: caption-session/);assert.ok(row.title.includes(prompt));assert.match(row.attributes.get('aria-description')??'',/Title from first message, not a supplied name/);
  event('primary.state',{...item,sessionName:'Native name'},target);assert.equal(byId('primary-row-title').textContent,'Native name');assert.doesNotMatch(row.title,/Title from first message/);
  event('primary.state',{...item,sessionName:''},target);assert.equal(byId('primary-row-title').textContent,label);
  const newer=response.items[0];assert.ok(newer);response.observedAt='2026-01-03T00:00:00Z';newer.revision='caption-r2';newer.titleState='unavailable';byId('session-open').click();await settle();assert.equal(byId('primary-row-title').textContent,'Primary');assert.doesNotMatch(row.title,/Title from first message/);
  event('primary.state',{...item,sessionFile:'/fixture/other.jsonl'},target);assert.equal(byId('primary-row-title').textContent,'Primary');
  assert.equal(primaryControl('editor'),editor);assert.equal(editor.value,text);assert.deepEqual([editor.selectionStart,editor.selectionEnd],selection);assert.deepEqual(app.state.workspace?.selectedTarget,target);
  assert.equal(transportLog.slice(requests).some(call=>call.method==='POST'),false);
});
test('the Primary composer uses the projected conversation name without replacing its editor', async () => {
  const item=primaryFixture({epoch:41,sessionName:'Named conversation',activity:'idle'});await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'primary',key:'p',epoch:41}},primaries:[item],roster:[]});const editor=primaryControl('editor');assert.equal(primaryControl('recipient').textContent,'Message Named conversation');assert.equal(byId('primary-row-state').dataset.glyph,'✓'); assert.ok(byId('primary-row-state').querySelector('.card-icon-success'));event('primary.state',{...item,sessionName:'Renamed conversation'},{kind:'primary',key:'p',epoch:41});assert.equal(primaryControl('recipient').textContent,'Message Renamed conversation');assert.equal(primaryControl('editor'),editor);
});

test('navigation uses drawer state while a breakpoint resize still has desktop DOM visibility', async () => {
  host.viewport = 1200; await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', sidebarVisible: true}, primaries: [primaryFixture()], roster: []});
  assert.equal(byId('sidebar').hidden, false); host.viewport = 760; byId('sidebar-show').click();
  assert.equal(app.drawerOpen, true); assert.equal(byId('sidebar').hidden, false); app.toggleSidebar(false); host.viewport = 1200;
});

test('drawer Close, outside pointer and Escape retain drafts and desktop visibility preference', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'primary', key: 'p', epoch: 1}, sidebarVisible: true}, primaries: [primaryFixture()], roster: []});
  host.viewport = 760; selectionSaves.length = 0; primaryControl('editor').value = 'Exact retained draft'; primaryControl('editor').dispatch('input'); primaryControl('transcript').scrollTop = 140;
  app.toggleSidebar(true); assert.equal(app.drawerOpen, true); assert.equal(byId('sidebar-show').hidden, false);
  byId('sidebar-close').click(); assert.equal(app.drawerOpen, false); assert.equal(hostDocument.activeElement, byId('sidebar-show'));
  app.toggleSidebar(true); let prevented = 0; let stopped = 0;
  app.dismissDrawerPointer({target: primaryControl('send'), preventDefault: () => {prevented++;}, stopImmediatePropagation: () => {stopped++;}} as unknown as PointerEvent);
  assert.equal(app.drawerOpen, false); assert.equal(prevented, 1); assert.equal(stopped, 1);
  app.consumeDrawerClick({detail: 1, preventDefault: () => {prevented++;}, stopImmediatePropagation: () => {stopped++;}} as unknown as MouseEvent);
  assert.equal(prevented, 2); assert.equal(stopped, 2); assert.equal(hostDocument.activeElement, byId('sidebar-show'));
  app.toggleSidebar(true); app.appKey({key: 'Escape', preventDefault() {}} as KeyboardEvent); assert.equal(app.drawerOpen, false);
  assert.equal(primaryControl('editor').value, 'Exact retained draft'); assert.equal(primaryControl('transcript').scrollTop, 140); assert.equal(selectionSaves.length, 0); assert.equal(app.state.workspace?.sidebarVisible, true);
  app.toggleSidebar(true); host.viewport = 1100; app.renderNavigation(); assert.equal(app.drawerOpen, false); assert.equal(byId('sidebar').hidden, false);
});
test('projected Message pointers stay inside the drawer without exempting the conversation transcript', async t => {
  t.after(() => {app.toggleSidebar(false); byId('agent-message-close').click(); host.viewport = 1200;});
  for (const visiblePane of [false, true]) {
    const row = agentFixture(`drawer-message-${visiblePane}`), primary = primaryFixture({epoch: visiblePane ? 718 : 717});
    const target = {kind: 'primary' as const, key: primary.key, epoch: primary.epoch};
    await arrive({workspace: {id: 'drawer-message', revision: 1, primaryKey: primary.key, selectedTarget: target,
      conversationLayout: visiblePane ? twoPanes(row.identity) : singlePane([{kind: 'primary'}])}, primaries: [primary], roster: [row]});
    host.viewport = 390; app.toggleSidebar(true);
    const message = byId('roster').querySelector(`[data-identity="${row.identity}"]`)?.querySelector('.row-message'); assert.ok(message); message.click(); await settle();
    const editor = messageControl('editor'), form = messageControl('composer'), parent = form.parentNode;
    editor.value = 'Retained Message draft'; editor.dispatch('input'); editor.focus(); editor.setSelectionRange(2, 7, 'backward');
    for (const node of [editor, messageControl('send'), form]) {
      assert.equal(byId('sidebar').contains(node), false);
      app.dismissDrawerPointer({target: node, preventDefault: () => assert.fail('Message pointer was canceled'), stopImmediatePropagation: () => assert.fail('Message pointer was stopped')} as unknown as PointerEvent);
      app.consumeDrawerClick({detail: 1, preventDefault: () => assert.fail('Message click was canceled'), stopImmediatePropagation: () => assert.fail('Message click was stopped')} as unknown as MouseEvent);
      assert.equal(app.drawerOpen, true); assert.equal(hostDocument.activeElement, editor); assert.equal(form.parentNode, parent);
      assert.equal(editor.value, 'Retained Message draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]);
    }
    let prevented = false;
    app.dismissDrawerPointer({target: primaryControl('transcript'), preventDefault: () => {prevented = true;}, stopImmediatePropagation() {}} as unknown as PointerEvent);
    assert.equal(prevented, true); assert.equal(app.drawerOpen, false);
    byId('agent-message-close').click(); await settle(); host.viewport = 1200;
  }
});
test('drawer dismissal excludes its own controls, dialogs, command lists and context menus', () => {
  host.viewport = 760; app.toggleSidebar(true);
  for (const node of [byId('sidebar'), new HostNode('dialog'), Object.assign(new HostNode('div'), {className: 'command-menu'}), Object.assign(new HostNode('div'), {className: 'context-menu'})]) {
    app.dismissDrawerPointer({target: node, preventDefault: () => assert.fail('excluded surface'), stopImmediatePropagation: () => assert.fail('excluded surface')} as unknown as PointerEvent);
    assert.equal(app.drawerOpen, true);
  }
  contextMenu.open(byId('sidebar-show') as unknown as HTMLElement, {x: 4, y: 4}, 'Fixture menu', [{label: 'Fixture', run() {}}]);
  app.dismissDrawerPointer({target: primaryControl('send')} as unknown as PointerEvent); assert.equal(app.drawerOpen, true);
  app.appKey({key: 'Escape', preventDefault: () => assert.fail('menu Escape belongs to its menu')} as KeyboardEvent); assert.equal(app.drawerOpen, true);
  contextMenu.close(); app.toggleSidebar(false); host.viewport = 1200;
});
test('the conversation list reuses exact tab activation without a new navigation lane', async () => {
  const layout = singlePane([{kind: 'primary'}, {kind: 'agent', identity: 'list-a'}, {kind: 'agent', identity: 'list-b'}]);
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: layout}, primaries: [primaryFixture({epoch: 715})], roster: [agentFixture('list-a', {name: 'Review'}), agentFixture('list-b', {name: 'Review'})]});
  const rows = byId('sidebar-conversations').querySelectorAll('.conversation-row'); assert.equal(rows.length, 3); assert.notEqual(rows[1]?.textContent, rows[2]?.textContent); assert.notEqual(rows[1]?.getAttribute('aria-label'), rows[2]?.getAttribute('aria-label'));
  for (const [index, row] of rows.entries()) {const status = row.querySelector('.conversation-state'); assert.ok(status); assert.equal(status.getAttribute('aria-hidden'), 'true'); assert.equal(status.querySelector('svg'), null); assert.equal(status.textContent, index === 0 ? '•' : ''); assert.equal(status.title, index === 0 ? 'Working' : 'Running'); assert.match(row.getAttribute('aria-label') ?? '', index === 0 ? /Working/ : /Running/);}
  rows[2]?.click(); await settle(); assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: 'list-b'}); assert.equal(hostDocument.activeElement, agentControl('editor')); assert.equal(rows[2]?.getAttribute('aria-current'), 'true');
});

test('reselecting the active conversation entry closes a drawer without a desktop preference write', async () => {
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',sidebarVisible:true,selectedTarget:{kind:'agent',identity:'overflow-a'},conversationLayout:singlePane([{kind:'primary'},{kind:'agent',identity:'overflow-a'}],'agent:overflow-a')},primaries:[primaryFixture({epoch:716})],roster:[agentFixture('overflow-a')]});host.viewport=760;app.toggleSidebar(true);selectionSaves.length=0;byId('sidebar-conversations').querySelector('[data-tab-key="agent:overflow-a"]')?.click();await settle();assert.equal(app.drawerOpen,false);assert.equal(byId('sidebar').hidden,true);assert.equal(app.state.workspace?.sidebarVisible,true);assert.equal(selectionSaves.some(save=>save.body.sidebarVisible!==undefined),false);host.viewport=1200;
});

test('the desktop transition restores the hidden-sidebar preference and a visible focus target', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', sidebarVisible: false, selectedTarget: {kind: 'primary', key: 'p', epoch: 1}}, primaries: [primaryFixture()], roster: []});
  host.viewport = 760; app.toggleSidebar(true); assert.equal(hostDocument.activeElement?.id, 'project-button');
  const sidebar = byId('sidebar'); const project = byId('project-button'), parent = project.parentNode, sibling = project.nextSibling; assert.ok(parent); sidebar.append(project);
  host.viewport = 1100; app.renderNavigation(); assert.equal(app.drawerOpen, false); assert.equal(byId('sidebar').hidden, true); assert.equal(app.state.workspace?.sidebarVisible, false);
  assert.equal(hostDocument.activeElement, byId('sidebar-show')); parent.insertBefore(project, sibling); host.viewport = 1200;
});

test('unread notifications name their direct control and clear only after deliberate review', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  const counter = byId('notices-count'); const control = byId('notifications-button'); assert.equal(counter.hidden, true);
  event('notice', {id: 'visible-notice', level: 'info', message: 'A notification', at: 'now'});
  assert.equal(counter.hidden, false); assert.equal(counter.textContent, '1'); assert.equal(control.attributes.get('aria-label'), 'Notifications (1 unread)');
  assert.equal(control.title, 'Notifications (1 unread)'); assert.equal(counter.parentNode, control);
  control.click(); assert.equal(contextMenu.openNow, false); assert.match(byId('modal-body').textContent, /A notification/);
  assert.equal(counter.hidden, true); assert.equal(control.attributes.get('aria-label'), 'Notifications'); byId('modal-close').click();
});


test('project navigation remains an anchored project-first menu beside direct utility actions', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({sessionId: 'named-project', sessionName: 'Release notes'})], roster: []});
  const project = byId('project-button'); project.click(); await settle(); const projects = menuNode();
  assert.equal(projects.getAttribute('aria-label'), 'Working folder'); assert.equal(project.getAttribute('aria-expanded'), 'true');
  assert.equal(byId('modal').open, false); assert.doesNotMatch(projects.textContent, /Release notes|In this window|List details|Cancel/);
  const choice = projects.children.find(node => node.textContent === 'project'); assert.ok(choice); assert.equal(choice.getAttribute('aria-description'),'/fixture/project');
  assert.equal(projects.style.left, `${Math.max(4, project.getBoundingClientRect().left)}px`);
  projects.dispatch('keydown', {key: 'Escape', preventDefault() {}, stopPropagation() {}});
  assert.equal(project.getAttribute('aria-expanded'), 'false'); assert.equal(hostDocument.activeElement, project);
  byId('appearance-button').click(); assert.equal(contextMenu.openNow, false); assert.equal(byId('modal').open, true);
  assert.equal(byId('modal-title').textContent, 'Appearance'); byId('modal-close').click();
  assert.doesNotMatch(html, /id="app-menu"|id="window-menu"/);
});
test('three direct utility icons preserve inventory, native button focus, destinations and unread count', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  const footer = byId('sidebar').querySelector('.sidebar-footer'); assert.ok(footer);
  assert.deepEqual(footer.querySelectorAll('button').map(node => node.getAttribute('aria-label')), ['Commands', 'Notifications', 'Appearance']);
  assert.equal(hostDocument.getElementById('app-menu'), undefined); assert.doesNotMatch(source, /byId\('app-menu'\)|'App menu'/);
  event('notice', {id: 'direct-utility-notice', level: 'info', message: 'Review through the direct icon', at: 'now'});
  for (const [id, icon, title] of [['commands-button', 'commands', 'Commands'], ['appearance-button', 'appearance', 'Appearance'], ['notifications-button', 'notifications', 'Notifications']]) {
    const control = byId(id as string); assert.equal(control.getAttribute('type'), 'button'); assert.equal(control.tabIndex, 0); assert.equal(control.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(control.querySelector('svg')?.getAttribute('class'), `card-icon card-icon-${icon}`);
    assert.equal(control.querySelector('svg')?.getAttribute('aria-hidden'), 'true'); assert.ok(control.title.startsWith(title as string));
    control.focus(); control.click(); await settle(); assert.equal(contextMenu.openNow, false); assert.equal(byId('modal').open, true); assert.equal(byId('modal-title').textContent, title);
    assert.equal(byId('notices-count').hidden, id === 'notifications-button');
    byId('modal-close').click(); assert.equal(hostDocument.activeElement, control);
  }
});
test('notifications produce existing semantic classes instead of unused prefixed classes', async () => {
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(source, /notification \$\{group\.level\}/);
  assert.match(css, /\.secondary, \.info \{ color: var\(--muted\)/);
  assert.match(css, /\.warning \{ color: var\(--warning\)/);
  assert.match(css, /\.error, button.danger \{ color: var\(--error\)/);
});
test('Message panel settings describe its captured agent instead of a prior agent or Primary', async () => {
  const row = agentFixture('message-settings', {name: 'Recipient', model: {provider: 'agent-provider', modelId: 'recipient-model'}, thinkingLevel: 'low'});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'primary', key: 'p', epoch: 1}}, primaries: [primaryFixture({model: {provider: 'primary-provider', id: 'primary-model', name: 'Primary model', reasoning: false, input: ['text']}})], roster: [row]});
  const agent = byId('roster').children.find(node => node.dataset.identity === row.identity); assert.ok(agent); const message = agent.querySelector('.row-message'); assert.ok(message); message.click(); await settle();
  const settingsText = () => messageControl('settings-text');
  assert.equal(byId('agent-message-panel').hidden, false); assert.equal(settingsText()?.hidden, false);
  assert.equal(settingsText()?.textContent, 'recipient-model · low'); assert.equal(settingsText()?.title, 'Last observed: Model agent-provider/recipient-model · Thinking low');
  assert.equal(settingsText()?.getAttribute('aria-label'), settingsText()?.title); assert.match(byId('agent-settings-detail').textContent, /Last observed settings are not confirmed current\./); assert.equal(byId('agent-settings-detail').hidden, false); assert.equal(byId('agent-settings-detail').classList.contains('phone-status-facts'), false);
  assert.equal(messageControl('recipient').textContent, 'Message Recipient'); assert.equal(primaryControl('root').hidden, false);
  const editor = messageControl('editor'); editor.value = 'Keep the recipient draft'; editor.dispatch('input'); editor.focus(); editor.setSelectionRange(3, 8);
  event('agent.availability', {identity: row.identity, connectionEpoch: app.state.agentEpochs.get(row.identity) ?? 1, state: 'live', capabilities: {input: false}});
  assert.match(byId('agent-message-status').textContent, /Message access changed/); assert.equal(messageControl('recipient').textContent, 'Draft for Recipient');
  assert.equal(messageControl('send').disabled, false); assert.equal(messageControl('editor'), editor); assert.equal(editor.value, 'Keep the recipient draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [3, 8]);
  assert.equal(hostDocument.activeElement, editor); assert.doesNotMatch(messageControl('send').getAttribute('aria-description') ?? '', /not connected/);
  const retry = byId('agent-message-retry'); assert.equal(retry.hidden, false); assert.equal(retry.disabled, false); assert.equal(retry.textContent, 'Check agent');
  const preparations = transportLog.filter(call => call.path.endsWith('/targets')).length;
  const inputs = transportLog.filter(call => call.path.includes('/inputs')).length;
  const staleRetry = retry.onclick; retry.focus(); retry.click();
  assert.equal(retry.hidden, false); assert.equal(retry.disabled, true); assert.equal(hostDocument.activeElement, editor); await settle();
  assert.equal(transportLog.filter(call => call.path.endsWith('/targets')).length, preparations + 1);
  assert.equal(transportLog.filter(call => call.path.includes('/inputs')).length, inputs);
  assert.equal(byId('agent-message-panel').hidden, false); assert.equal(retry.hidden, true);
  assert.equal(messageControl('editor'), editor); assert.equal(editor.value, 'Keep the recipient draft');
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [3, 8]); assert.equal(hostDocument.activeElement, editor);
  assert.equal(app.state.workspace?.selectedTarget?.kind, 'primary');
  const completed = transportLog.filter(call => call.path.endsWith('/targets')).length; staleRetry?.(); await settle();
  assert.equal(transportLog.filter(call => call.path.endsWith('/targets')).length, completed); byId('agent-message-close').click();
});

test('a connected agent without input retains a draft without a false disconnection explanation', async () => {
  const row = agentFixture('no-input', {availability: 'live', capabilities: {input: false}});
  await arrive({workspace: {id: 'w', revision: 1, selectedTarget: {kind: 'agent', identity: row.identity}, panelVisible: true}, primaries: [], roster: [row], targets: [targetFixture('no-input', {kind: 'agent', identity: row.identity})]});
  assert.match(hostDocument.title, /Read only$/); assert.equal(agentControl('editor').disabled, false); assert.equal(agentControl('send').disabled, true);
  assert.equal(agentControl('send').attributes.get('aria-describedby'), agentControl('state').id); assert.match(agentControl('state-line').textContent, /Messages are read only/); assert.doesNotMatch(agentControl('state-line').textContent, /connected/);
});

test('the sidebar avoids a duplicate Primary destination and retains its closed-tab return action', async () => {
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  assert.equal(byId('primary-row').hidden, true);
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', conversationLayout: singlePane([])}, primaries: [primaryFixture()], roster: []});
  assert.equal(byId('primary-row').hidden, false); assert.equal(byId('primary-row').attributes.get('aria-label'), 'Return to Primary');
  byId('primary-row').click(); await settle(); assert.equal(byId('primary-row').hidden, true);
  assert.equal(paneLeaves(app.state.workspace?.conversationLayout?.root ?? singlePane([]).root)[0]?.tabs[0]?.kind, 'primary');
});

test('stored connection checks keep both drafts and reserve no input while Start is offered', async () => {
  const target = {kind: 'agent' as const, identity: 'stored-check'};
  const primaryTarget = {kind: 'primary' as const, key: 'p', epoch: 2};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target, panelVisible: true}, primaries: [primaryFixture({epoch: 2})], roster: [agentFixture(target.identity, {availability: 'stored', capabilities: {input: false}})], targets: [targetFixture('check-primary', primaryTarget, {draft: {revision: 7, text: 'Primary keep', mode: 'prompt', persisted: true}}), targetFixture('check-agent', target, {draft: {revision: 7, text: 'Agent keep', mode: 'followUp', persisted: true}})]});
  const primaryEditor = primaryControl('editor'); const agentEditor = agentControl('editor');
  assert.equal(agentControl('state').hidden, false); app.openConversationActions(); menuNode().children.find(node => node.textContent === 'Open in Pi terminal…')?.click(); assert.match(byId('modal-body').textContent, /agent attach stored-check/); byId('modal-close').click();
  assert.equal(byId('agent-usage-details').hidden, false); assert.equal(agentControl('editor').disabled, false); assert.equal(agentControl('start').hidden, false); assert.equal(agentControl('send').hidden, true);
  assert.match(byId('agent-usage').textContent, /Cache usage is not reported/); assert.equal(byId('agent-usage-summary').textContent, '');
  const start = transportLog.length; await app.checkAgentConnection('w', target.identity); await settle();
  const mutations = transportLog.slice(start).filter(item => item.method === 'POST'); assert.deepEqual(mutations.map(item => item.path), ['/api/workspaces/w/targets']);
  assert.deepEqual(mutations[0]?.body, {target});assert.equal(transportLog.slice(start).some(call=>call.path.includes('/inputs')||call.path.endsWith('/start')),false); assert.equal(primaryControl('editor'), primaryEditor); assert.equal(agentControl('editor'), agentEditor);
  assert.equal(primaryEditor.value, 'Primary keep'); assert.equal(agentEditor.value, 'Agent keep'); assert.deepEqual(app.state.workspace?.selectedTarget, target);
});

test('old Check settlement repaints current stored controls without old-target status or focus transfer', async t => {
  const oldTarget = {kind: 'agent' as const, identity: 'check-old'}; const newTarget = {kind: 'agent' as const, identity: 'check-new'};
  const primaryTarget = {kind: 'primary' as const, key: 'p', epoch: 2222};
  const oldRow = agentFixture(oldTarget.identity, {availability: 'stored', capabilities: {input: false}});
  const newRow = agentFixture(newTarget.identity, {availability: 'stored', capabilities: {input: false}});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: oldTarget, panelVisible: true,
    conversationLayout: twoPanes(oldTarget.identity, 'agent-pane', [{kind:'agent',identity:newTarget.identity}])},
    primaries: [primaryFixture({epoch: primaryTarget.epoch})], roster: [oldRow, newRow],
    targets: [targetFixture('navigation-check-primary', primaryTarget, {draft: {revision: 9, text: 'Primary exact draft', mode: 'steer', persisted: true}}),
      targetFixture('check-old', oldTarget, {draft: {revision: 9, text: 'Old exact draft', mode: 'followUp', persisted: true}}),
      targetFixture('check-new', newTarget, {draft: {revision: 9, text: 'New exact draft', mode: 'followUp', persisted: true}})]});
  const fakeFetch = globalThis.fetch; let complete: ((response: Response) => void) | undefined;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), 'http://ui.test').pathname; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === '/api/workspaces/w/targets' && body?.target?.identity === oldTarget.identity) return new Promise(resolve => { complete = resolve; });
    return fakeFetch(input, init);
  });
  const before = transportLog.length; const pending = app.checkAgentConnection('w', oldTarget.identity); assert.ok(complete);
  const primaryEditor = primaryControl('editor'); const oldEditor = agentControl('editor');
  await app.selectAgent(newRow); await settle(); const agentEditor = agentControl('editor'); assert.notEqual(agentEditor, oldEditor); primaryEditor.setSelectionRange(2, 8); agentEditor.setSelectionRange(1, 6); agentEditor.focus();
  assert.equal(agentControl('start').disabled, true); assert.equal(agentControl('history-reload').disabled, true);
  const status = agentControl('state-line').textContent; const afterNavigation = transportLog.length;
  complete(Response.json({ok: true, data: {targetState: targetFixture('old-late', oldTarget), availability: 'live', capabilities: {input: true}}}));
  await pending; await settle();
  assert.equal(agentControl('start').disabled, false); assert.equal(agentControl('history-reload').disabled, false);
  assert.deepEqual(app.state.workspace?.selectedTarget, newTarget); assert.equal(agentControl('state-line').textContent, status);
  assert.equal(primaryControl('editor'), primaryEditor); assert.equal(agentControl('editor'), agentEditor);
  assert.equal(primaryEditor.value, 'Primary exact draft'); assert.equal(agentEditor.value, 'New exact draft'); assert.equal(oldEditor.value, 'Old exact draft');
  assert.deepEqual([primaryEditor.selectionStart, primaryEditor.selectionEnd], [2, 8]); assert.deepEqual([agentEditor.selectionStart, agentEditor.selectionEnd], [1, 6]);
  assert.equal(hostDocument.activeElement, agentEditor); assert.deepEqual(transportLog.slice(afterNavigation), []);
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start') || call.path.includes('/inputs')).length, 0);
});

function startDetail(): string { agentControl('state-detail').click(); const detail = byId('modal-body').textContent; byId('modal-close').click(); return detail; }
let launchEpoch = 600;
async function storedLaunchFixture(identity: string): Promise<void> {
  const target = {kind: 'agent' as const, identity}; const primaryTarget = {kind: 'primary' as const, key: 'p', epoch: ++launchEpoch};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target, panelVisible: true, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: primaryTarget.epoch})], roster: [agentFixture(identity, {availability: 'stored', capabilities: {input: false}})], targets: [targetFixture(`launch-primary-${identity}`, primaryTarget, {draft: {revision: 9, text: 'Primary launch keep', mode: 'prompt', persisted: true}}), targetFixture(`launch-agent-${identity}`, target, {draft: {revision: 9, text: 'Agent launch keep', mode: 'followUp', persisted: true}})]});
}
function confirmLaunch(identity: string): Response {
  const row = agentFixture(identity);
  browser.fixture = {...browser.fixture, roster: browser.fixture.roster.map(item => item.identity === identity ? row : item), observations: [observation(identity, {revision:1,observedAt:'now',entries:[],live:[],nextBefore:null,status:{busy:false},coverage}, (app.state.agentEpochs.get(identity) ?? 0) + 1)]};
  event('agent.availability', {identity, connectionEpoch: browser.fixture.observations?.[0]?.connectionEpoch, state: 'live', capabilities: row.capabilities});
  return Response.json({ok: true, data: fixturePreparation({kind: 'agent', identity})});
}

test('Check connection cannot select or accept a result from a retired stream', async t => {
  const recovery = preparationRecovery();
  const original = globalThis.fetch, pending = Promise.withResolvers<Response>(), b = agentFixture('late-explicit-check'), target = {kind: 'agent' as const, identity: b.identity}, saved = targetFixture('late-explicit-check', target, {draft: {revision: 4, text: 'Keep checked draft', mode: 'followUp', persisted: true}});
  t.after(async () => {pending.resolve(Response.json({ok: true, data: {targetState: saved, availability: 'live', capabilities: b.capabilities}})); globalThis.fetch = original; await settle(); await recovery.dispose();});
  await arrive({workspace: {id: 'late-explicit-check', revision: 1, selectedTarget: target}, primaries: [], roster: [b], targets: [saved], confirmed: false});
  const editor = agentControl('editor'); editor.setSelectionRange(2, 6, 'backward');
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname.endsWith('/targets') && init?.method === 'POST' ? pending.promise : original(input, init);
  const selections = selectionSaves.length, checking = app.checkAgentConnection('late-explicit-check', b.identity); await settle(); await interruptPreparation('reconnect', recovery);
  pending.resolve(Response.json({ok: true, data: {targetState: saved, availability: 'live', capabilities: b.capabilities}})); await checking; await settle();
  assert.equal(selectionSaves.length, selections); assert.equal(agentControl('send').disabled, false); assert.doesNotMatch(tabsNode().querySelector('[data-tab-key="agent:late-explicit-check"]')?.title ?? '', /Connected|Ready/);
  assert.equal(agentControl('editor'), editor); assert.equal(editor.value, saved.draft.text); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 6, 'backward']);
});

test('a stored Start response across stream replacement retains uncertainty without another Start', async t => {
  const pending = Promise.withResolvers<Response>(), identity = 'late-stored-start', recovery = preparationRecovery();
  t.after(async () => {pending.resolve(Response.json({ok: false, error: {code: 'not_ready', message: 'Retired start', retry: 'manual'}})); browser.startPreparation = undefined; await settle(); await recovery.dispose();});
  await storedLaunchFixture(identity); const editor = agentControl('editor'); editor.setSelectionRange(2, 6, 'backward'); const before = transportLog.length;
  browser.startPreparation = async () => pending.promise; const starting = app.startStoredAgent('w', identity); await settle(); await interruptPreparation('reconnect', recovery);
  pending.resolve(Response.json({ok: true, data: {...fixturePreparation({kind: 'agent', identity}), availability: 'live', capabilities: agentFixture(identity).capabilities}})); await starting; await settle();
  assert.equal(agentControl('send').hidden, true); assert.equal(agentControl('state-line').textContent, 'Start did not complete.'); assert.equal(agentControl('start').textContent, 'Try again'); assert.match(tabsNode().querySelector('[data-tab-key="agent:late-stored-start"]')?.title ?? '', /Start failed/); assert.match(startDetail(), /browser connection changed/);
  assert.equal(agentControl('editor'), editor); assert.equal(editor.value, 'Agent launch keep'); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 6, 'backward']);
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start')).length, 1); assert.equal(transportLog.slice(before).some(call => call.path.includes('/inputs')), false);
});

for (const action of ['Check', 'Start']) test(`${action} does not restore preparation after disconnect during snapshot confirmation`, async t => {
  const original = globalThis.fetch, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), recovery = preparationRecovery(); let hold = true;
  const identity = `post-response-${action}`;
  t.after(async () => {release.resolve(); globalThis.fetch = original; browser.startPreparation = undefined; await settle(); await recovery.dispose();});
  await storedLaunchFixture(identity); const editor = agentControl('editor'); editor.setSelectionRange(2, 6, 'backward');
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname;
    if (path === '/api/snapshot' && hold) {hold = false; const response = await original(input, init); entered.resolve(); await release.promise; return response;}
    if (path.endsWith('/targets') && init?.method === 'POST') return confirmLaunch(identity);
    return original(input, init);
  };
  browser.startPreparation = async () => confirmLaunch(identity);
  const confirming = action === 'Check' ? app.checkAgentConnection('w', identity) : app.startStoredAgent('w', identity); await entered.promise;
  await recovery.disconnect(); release.resolve(); await confirming; await settle();
  assert.equal(agentControl('send').disabled, action === 'Start'); assert.doesNotMatch(tabsNode().querySelector(`[data-tab-key="agent:${identity}"]`)?.title ?? '', /Connected|Ready/);
  assert.equal(agentControl('editor'), editor); assert.equal(editor.value, 'Agent launch keep'); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 6, 'backward']);
  if (action === 'Start') {assert.equal(agentControl('state-line').textContent, 'Start did not complete.'); assert.match(startDetail(), /browser connection changed/);}
});

test('stored Start is explicit, uses fresh keys and retains both drafts, caret, focus and ready input', async t => {
  t.after(() => { browser.startPreparation = undefined; }); const identity = 'explicit-start';
  const before = transportLog.length; await storedLaunchFixture(identity);
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start')).length, 0);
  const primaryEditor = primaryControl('editor'); const agentEditor = agentControl('editor');
  primaryEditor.setSelectionRange(2, 7); primaryEditor.dispatch('select'); agentEditor.setSelectionRange(3, 8); agentEditor.dispatch('select'); app.focusPane('agent-pane');
  browser.startPreparation = async captured => confirmLaunch(captured);
  await app.startStoredAgent('w', identity); await settle();
  const first = transportLog.slice(before).find(call => call.path.endsWith('/start')); assert.ok(first);
  assert.equal(first.path, '/api/agents/explicit-start/start'); assert.equal(first.workspace, 'w'); assert.deepEqual(first.body, {});
  assert.match(first.key ?? '', /^[0-9a-f-]{36}$/); assert.equal(agentControl('start').hidden, true); assert.equal(agentControl('send').hidden, false); assert.equal(agentControl('send').disabled, false); assert.equal(agentControl('state').hidden, true);
  assert.equal(primaryEditor.value, 'Primary launch keep'); assert.equal(agentEditor.value, 'Agent launch keep');
  assert.equal(primaryControl('editor'), primaryEditor); assert.equal(agentControl('editor'), agentEditor);
  assert.deepEqual([primaryEditor.selectionStart, primaryEditor.selectionEnd], [2, 7]); assert.deepEqual([agentEditor.selectionStart, agentEditor.selectionEnd], [3, 8]);
  assert.equal(hostDocument.activeElement, agentEditor); assert.equal(app.focusedPane, 'agent-pane'); assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity});
  browser.fixture = {...browser.fixture, roster: [agentFixture(identity, {availability: 'stored', capabilities: {input: false}})], observations: []};
  event('agent.availability', {identity, connectionEpoch: 2, state: 'stored', capabilities: {input: false}}); await settle();
  await app.startStoredAgent('w', identity); await settle();
  const starts = transportLog.slice(before).filter(call => call.path.endsWith('/start')); assert.equal(starts.length, 2); assert.notEqual(starts[1]?.key, first.key);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
});

test('uncertain stored Start remains attach-only across navigation and keeps the editable draft', async t => {
  t.after(() => { browser.startPreparation = undefined; }); const identity = 'uncertain-start'; await storedLaunchFixture(identity);
  const editor = agentControl('editor'); editor.focus(); editor.setSelectionRange(2, 7); const before = transportLog.length;
  browser.startPreparation = async () => Response.json({ok: false, error: {code: 'not_ready', message: 'Readiness was not confirmed.', retry: 'manual'}});
  await app.startStoredAgent('w', identity); await settle();
  assert.equal(agentControl('state-line').textContent, 'Start did not complete.'); assert.equal(agentControl('start').textContent, 'Try again'); assert.equal(agentControl('start').hidden, false); assert.match(startDetail(), /Readiness was not confirmed\./);
  assert.equal(agentControl('history-reload').disabled, false); assert.equal(editor.value, 'Agent launch keep'); assert.equal(editor.disabled, false);
  assert.equal(agentControl('send').attributes.get('aria-describedby'), agentControl('state').id);
  assert.equal(hostDocument.activeElement, editor); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]);
  await app.startStoredAgent('w', identity); await storedLaunchFixture('other-start'); await storedLaunchFixture(identity); await app.startStoredAgent('w', identity);
  assert.equal(agentControl('start').textContent, 'Try again'); assert.equal(agentControl('state-line').textContent, 'Start did not complete.');
  assert.equal(agentControl('send').attributes.get('aria-describedby'), agentControl('state').id);
  const starts = transportLog.slice(before).filter(call => call.path.endsWith('/start')); assert.equal(starts.length, 1);
  const retryCalls = transportLog.length; agentControl('history-reload').click(); await settle();
  assert.deepEqual(transportLog.slice(retryCalls).map(call => [call.method, call.path]), [['GET', '/api/agents/uncertain-start/history']]);
  assert.equal(agentControl('start').textContent, 'Try again'); assert.equal(agentControl('state-line').textContent, 'Start did not complete.');
  confirmLaunch(identity); await app.checkAgentConnection('w', identity); await settle();
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start')).length, 1);
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/targets')).length, 1);
  assert.equal(agentControl('send').disabled, false); assert.equal(agentControl('start').hidden, true); assert.equal(agentControl('state').hidden, true);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
});

test('exact connection checks clear Start uncertainty independently of observation', async t => {
  t.after(() => { browser.startPreparation = undefined; }); const identity = 'unobserved-check'; await storedLaunchFixture(identity);
  browser.startPreparation = async () => Response.json({ok: false, error: {code: 'not_ready', message: 'No readiness.', retry: 'manual'}});
  await app.startStoredAgent('w', identity); const editor = agentControl('editor'); editor.focus(); editor.setSelectionRange(2, 7);
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (new URL(String(input), 'http://ui.test/app').pathname.endsWith('/targets')) return Response.json({ok: true, data: {targetState: targetFixture('unobserved', {kind: 'agent', identity}), availability: 'live', capabilities: {input: true}}});
    return original(input, init);
  });
  const before = transportLog.length; await app.checkAgentConnection('w', identity); await settle();
  assert.equal(agentControl('start').hidden, true); assert.equal(agentControl('state').hidden, true);
  assert.equal(agentControl('send').hidden, false); assert.equal(agentControl('send').disabled, false);
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity}); assert.equal(editor.value, 'Agent launch keep');
  assert.equal(hostDocument.activeElement, editor); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]);
  const selections = transportLog.slice(before).filter(call => call.path.endsWith('/selection')); assert.equal(selections.length, 1);
  const savedSelection = selections[0]?.body as {selectedTarget?: unknown} | undefined; assert.ok(savedSelection);
  assert.deepEqual(savedSelection.selectedTarget, {kind: 'agent', identity});
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start') || call.path.includes('/inputs')).length, 0);
});

test('a check that finds the agent still stored returns the composer to Start', async t => {
  t.after(() => { browser.startPreparation = undefined; }); const identity = 'still-stored-check'; await storedLaunchFixture(identity);
  browser.startPreparation = async () => Response.json({ok: false, error: {code: 'not_ready', message: 'No readiness.', retry: 'manual'}});
  await app.startStoredAgent('w', identity); await settle();
  assert.equal(agentControl('state-line').textContent, 'Start did not complete.'); assert.equal(agentControl('start').textContent, 'Try again'); assert.equal(agentControl('start').title, 'Check whether the agent started.');
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (new URL(String(input), 'http://ui.test/app').pathname.endsWith('/targets')) return Response.json({ok: true, data: {targetState: targetFixture('still-stored', {kind: 'agent', identity}), availability: 'stored', capabilities: {input: false}}});
    return original(input, init);
  });
  const before = transportLog.length; await app.checkAgentConnection('w', identity); await settle();
  assert.equal(agentControl('state-line').textContent, 'Not running. Start it to send a message.'); assert.equal(agentControl('start').textContent, 'Start'); assert.equal(agentControl('start').hidden, false); assert.equal(agentControl('start').disabled, false);
  assert.equal(transportLog.slice(before).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
});

test('a read-only agent disables Send, describes it with the state line, and keeps the draft editable', async () => {
  const identity = 'read-only-send', target = {kind: 'agent' as const, identity};
  await arrive({workspace: {id: 'w', revision: 1, selectedTarget: target, panelVisible: true}, primaries: [], roster: [agentFixture(identity, {availability: 'incompatible', capabilities: {input: false}})], targets: [targetFixture('read-only-send', target, {draft: {revision: 3, text: 'Draft kept while read only', mode: 'followUp', persisted: true}})]});
  assert.equal(agentControl('state-line').textContent, 'This agent cannot run here. Messages are read only.'); assert.equal(agentControl('start').hidden, true);
  assert.equal(agentControl('send').hidden, false); assert.equal(agentControl('send').disabled, true); assert.equal(agentControl('send').attributes.get('aria-describedby'), agentControl('state').id);
  assert.equal(agentControl('editor').disabled, false); assert.equal(agentControl('editor').value, 'Draft kept while read only');
  const before = transportLog.length; await app.agentComposer().send(); await settle(); assert.equal(transportLog.slice(before).some(call => call.path.includes('/inputs')), false);
});

async function reconnectFixture(identities: string[], visible: string) {
  const targets = identities.map(identity => ({kind: 'agent' as const, identity}));
  const rows = identities.map(identity => agentFixture(identity));
  const layout = singlePane(targets, `agent:${visible}`);
  await arrive({workspace: {id: 'reconnect-w', revision: 1, selectedTarget: targets[0], conversationLayout: layout}, primaries: [], roster: rows, targets: targets.map(target => targetFixture(`saved-${target.identity}`, target, {draft: {revision: 2, text: `Draft ${target.identity}`, mode: 'followUp', persisted: true}}))});
  for (const row of rows) { event('agent.availability', {identity: row.identity, connectionEpoch: 1, state: 'live', capabilities: row.capabilities}); await settle(); }
  return {layout, targets, rows};
}
const preparations = (from: number, identity?: string) => transportLog.slice(from).filter(call => call.method === 'POST' && call.path.endsWith('/targets') && (!identity || (call.body as {target?: {identity?: string}} | undefined)?.target?.identity === identity));

test('after a browser reconnect a still-running agent shows the normal composer once its target is prepared again', async t => {
  const recovery = preparationRecovery(); t.after(async () => { await recovery.dispose(); });
  const identity = 'reconnect-live';
  await reconnectFixture([identity], identity);
  assert.equal(agentControl('state').hidden, true); assert.equal(agentControl('send').disabled, false);
  await recovery.disconnect();
  const before = transportLog.length; await recovery.recover(); await settle();
  assert.equal(preparations(before, identity).length, 1);
  assert.equal(agentControl('state').hidden, true); assert.equal(agentControl('state-line').textContent, ''); assert.equal(agentControl('start').hidden, true);
  assert.equal(agentControl('send').hidden, false); assert.equal(agentControl('send').disabled, false); assert.equal(agentControl('editor').disabled, false);
  assert.equal(transportLog.slice(before).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
});

test('a failed preparation after reconnect says the agent could not be reached and offers Check agent', async t => {
  const recovery = preparationRecovery(); const original = globalThis.fetch; let fail = true;
  t.after(async () => { globalThis.fetch = original; await recovery.dispose(); });
  const identity = 'reconnect-fail';
  await reconnectFixture([identity], identity);
  await recovery.disconnect();
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname.endsWith('/targets') && init?.method === 'POST' && fail ? Response.json({ok: false, error: {code: 'host_unavailable', message: 'The agent socket is closed.', retry: 'manual'}}) : original(input, init);
  const before = transportLog.length; await recovery.recover(); await settle();
  assert.equal(agentControl('state-line').textContent, 'Could not reach the agent.'); assert.equal(agentControl('start').textContent, 'Check agent'); assert.equal(agentControl('start').hidden, false);
  assert.equal(agentControl('send').hidden, true); assert.equal(agentControl('state-detail').hidden, false);
  agentControl('state-detail').click(); assert.match(byId('modal-body').textContent, /agent socket is closed/); byId('modal-close').click();
  const failed = preparations(before, identity).length; await settle(); assert.equal(preparations(before, identity).length, failed);
  fail = false; agentControl('start').click(); await settle();
  assert.equal(preparations(before, identity).length, failed + 1);
  assert.equal(agentControl('state').hidden, true); assert.equal(agentControl('send').hidden, false); assert.equal(agentControl('send').disabled, false);
});

test('a background tab keeps its stale connection and makes no preparation request until it is visible', async t => {
  const recovery = preparationRecovery(); t.after(async () => { await recovery.dispose(); });
  const {layout} = await reconnectFixture(['reconnect-front', 'reconnect-back'], 'reconnect-back');
  app.applyLayout(activatePaneTab(layout, 'pane-1', 'agent:reconnect-back')); await app.selectionQueue.drain(); await settle();
  app.applyLayout(activatePaneTab(app.state.workspace?.conversationLayout ?? layout, 'pane-1', 'agent:reconnect-front')); await app.selectionQueue.drain(); await settle();
  for (const identity of ['reconnect-front', 'reconnect-back']) { event('agent.availability', {identity, connectionEpoch: 2, state: 'live', capabilities: agentFixture(identity).capabilities}); await settle(); }
  await recovery.disconnect();
  const before = transportLog.length; await recovery.recover(); await settle();
  assert.equal(preparations(before, 'reconnect-front').length, 1); assert.equal(preparations(before, 'reconnect-back').length, 0);
  app.applyLayout(activatePaneTab(app.state.workspace?.conversationLayout ?? layout, 'pane-1', 'agent:reconnect-back')); await app.selectionQueue.drain(); await settle();
  assert.equal(preparations(before, 'reconnect-back').length, 1); assert.equal(preparations(before, 'reconnect-front').length, 1);
});

test('pending stored Start deduplicates clicks and a stale completion never changes the new recipient or focus', async t => {
  t.after(() => { browser.startPreparation = undefined; }); const identity = 'pending-start'; await storedLaunchFixture(identity);
  let complete: ((response: Response) => void) | undefined;
  browser.startPreparation = () => new Promise(resolve => { complete = resolve; }); const before = transportLog.length;
  const pending = app.startStoredAgent('w', identity); await app.startStoredAgent('w', identity);
  assert.equal(agentControl('start').disabled, true); assert.equal(agentControl('start').textContent, 'Starting…'); assert.equal(agentControl('history-reload').disabled, true);
  await storedLaunchFixture('new-recipient'); const editor = agentControl('editor'); editor.focus(); editor.setSelectionRange(1, 6);
  assert.ok(complete); complete(Response.json({ok: true, data: {targetState: targetFixture('late-target', {kind: 'agent', identity}), availability: 'live', capabilities: {input: true}}})); await pending; await settle();
  assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start')).length, 1);
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: 'new-recipient'}); assert.equal(editor.value, 'Agent launch keep');
  assert.equal(hostDocument.activeElement, editor); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [1, 6]);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
});

test('stored Start refuses a wrong prepared recipient or missing input and stale controls do not launch', async t => {
  t.after(() => { browser.startPreparation = undefined; });
  for (const invalid of ['wrong-recipient', 'no-input']) {
    const identity = `invalid-start-${invalid}`; await storedLaunchFixture(identity); const before = transportLog.length;
    browser.startPreparation = async () => Response.json({ok: true, data: {targetState: targetFixture('invalid-preparation', {kind: 'agent', identity: invalid === 'wrong-recipient' ? 'different' : identity}), availability: 'live', capabilities: {input: invalid !== 'no-input'}}});
    await app.startStoredAgent('w', identity); await settle(); assert.equal(agentControl('state-line').textContent, 'Start did not complete.');
    assert.equal(agentControl('send').hidden, true); assert.equal(agentControl('start').textContent, 'Try again');
    await app.startStoredAgent('wrong-workspace', identity); await app.startStoredAgent('w', 'different');
    assert.equal(transportLog.slice(before).filter(call => call.path.endsWith('/start')).length, 1);
    assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs')).length, 0);
  }
});

test('failed-session recovery leaves retained text and unconfirmed input under the old target', async () => {
  const target = {kind: 'primary' as const, key: 'p', epoch: 3};
  const unconfirmed = [{admission: 'unconfirmed' as const, images: [], operationId: 'unresolved', target, text: 'Unconfirmed text', mode: 'prompt', submittedDraftRevision: 1, createdAt: 'now', reason: 'Uncertain'}];
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target}, primaries: [primaryFixture({epoch: 3, lifecycle: 'failed', sessionFile: '/fixture/exact.jsonl', pid: 42, lastError: {code: 'host_unavailable', message: 'Failed', retry: 'manual'}})], roster: [], targets: [targetFixture('failed-retained', target, {draft: {revision: 7, text: 'Retained failure draft', mode: 'prompt', persisted: true}, unconfirmed})]});
  assert.match(primaryControl('activity').textContent, /This session is not ready/); assert.match(primaryControl('activity').textContent, /Sessions/);
  assert.equal(primaryControl('editor').value, 'Retained failure draft'); assert.equal(app.primaryComposer().state?.unconfirmed[0]?.operationId, 'unresolved');
  assert.doesNotMatch(primaryControl('activity').textContent, /Resume this session/);
});

test('accepted working activity owns the tool while retained settings stay composer-local', async () => {
  const row=agentFixture('tool-agent',{state:'working',currentTool:{name:'read',argument:'src/current-file.ts'},model:{provider:'fixture',modelId:'model'}});
  await arrive({workspace:{id:'w',revision:1,selectedTarget:{kind:'agent',identity:row.identity},panelVisible:true},primaries:[],roster:[row],observations:[observation(row.identity,{revision:1,observedAt:'now',entries:[],live:[],nextBefore:null,status:{busy:true},coverage})]});
  assert.equal(tabsNode().children.find(node => node.attributes.get('aria-selected') === 'true')?.querySelector('.tab-dot')?.title, 'Working'); assert.equal(agentControl('settings-text')?.textContent,'model');
  assert.equal(agentControl('settings-text')?.title,'Last observed model fixture/model'); assert.doesNotMatch(html, /agent-pane-heading/);
  app.openConversationActions(); const menu = hostDocument.body.children.find(node => node.className === 'context-menu'); assert.ok(menu);
  const detailsAction = menu.children.find(node => node.textContent === 'Conversation details'); assert.ok(detailsAction); detailsAction.click();
  assert.match(byId('modal-body').textContent, /Last reported tool/); assert.match(byId('modal-body').textContent, /src\/current-file.ts/); byId('modal-close').click();
});

test('metadata updates retain the disclosure, editor, caret, saved draft and recipient-only folder', async () => {
  const target = {kind: 'primary' as const, key: 'p', epoch: 6001};
  const saved = targetFixture('metadata-draft', target, {draft: {revision: 7, text: 'Keep metadata draft', mode: 'prompt', persisted: true}});
  const contextUsage = {tokens: 0, contextWindow: 4000, percent: 0};
  const usage = {cost: 0, tokens: {input: 4, output: 5, cacheRead: 6, cacheWrite: 7, total: 22}};
  const workspace = {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target};
  await arrive({workspace, primaries: [primaryFixture({epoch: 6001, cwd: '/reported/primary', contextUsage, usage})], roster: [], targets: [saved]});
  const editor = primaryControl('editor'); const details = byId('primary-usage-details'); editor.focus(); editor.setSelectionRange(3, 9);
  Reflect.set(details, 'open', true); const height = editor.style.height;
  assert.match(byId('primary-context').textContent, /Context 0%.*0\/4/);
  assert.match(byId('primary-usage-summary').textContent, /Session ~\$0.00/);
  assert.match(byId('primary-usage').textContent, /whole-session.*input 4, output 5, cache read 6, cache write 7/);
  assert.equal(byId('primary-folder').textContent, 'Folder /reported/primary');
  const inputs = transportLog.filter(call => call.path.includes('/inputs')).length;
  await arrive({workspace, primaries: [primaryFixture({epoch: 6001, cwd: undefined, contextUsage: {tokens: null, contextWindow: 4000, percent: null}})], roster: [], targets: [saved]});
  assert.equal(primaryControl('editor'), editor); assert.equal(byId('primary-usage-details'), details); assert.equal(Reflect.get(details, 'open'), true);
  assert.equal(editor.value, saved.draft.text); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [3, 9]); assert.equal(hostDocument.activeElement, editor); assert.equal(editor.style.height, height);
  assert.match(byId('primary-context').textContent, /Context unknown.*\?\/4/); assert.match(byId('primary-usage').textContent, /Missing cost is not zero/);
  assert.equal(byId('primary-folder').hidden, true); assert.equal(byId('primary-folder').textContent, '');
  assert.equal(transportLog.filter(call => call.path.includes('/inputs')).length, inputs);
});

test('Message panel uses its captured loaded cache and ignores unaccepted late frames without focus or admission changes', async () => {
  const row = agentFixture('metadata-recipient', {cwd: '/saved/recipient', model: {provider: 'saved', modelId: 'retained'}, thinkingLevel: 'low'});
  const message = {...messageFixture('metadata-final', [textPart('Retained result')]), usage: {input: 5, cacheRead: 5, cacheWrite: 0}};
  const frame = {revision: 1, observedAt: 'now', entries: [entryFixture('metadata-entry', [message])], live: [], nextBefore: null, status: {busy: false, model: {provider: 'accepted', modelId: 'live-model'}}, coverage};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: row.identity}, panelVisible: true}, primaries: [primaryFixture()], roster: [row], observations: [observation(row.identity, frame)]});
  await arrive({workspace: {id: 'w', revision: 2, primaryKey: 'p', selectedTarget: {kind: 'primary', key: 'p', epoch: 1}, conversationLayout: twoPanes(row.identity, 'primary-pane')}, primaries: [primaryFixture()], roster: [row, agentFixture('other-recipient')], observations: [observation(row.identity, frame)]});
  byId('roster').children.find(node => node.dataset.identity === row.identity)?.querySelector('.row-message')?.click(); await settle();
  const editor = messageControl('editor'); editor.value = 'Keep captured draft'; editor.dispatch('input'); await settle(); editor.focus(); editor.setSelectionRange(2, 7);
  const details = byId('agent-usage-details'); Reflect.set(details, 'open', true);
  assert.equal(byId('workbench-status').dataset.pane, 'agent'); assert.equal(byId('workbench-scope').title, `${byId('workbench-scope').textContent}\n${row.identity}`);
  assert.equal(byId('workbench-status-primary').hidden, true); assert.equal(byId('workbench-status-agent').hidden, false);
  assert.equal(app.state.workspace?.selectedTarget?.kind, 'primary');
  const before = transportLog.length;
  event('agent.frame', {identity: row.identity, connectionEpoch: 0, frame: {...frame, revision: 2, status: {busy: false, model: {provider: 'unaccepted', modelId: 'late-model'}}}}); flushFrames(); await settle();
  assert.equal(messageControl('settings-text')?.textContent, 'live-model · low');
  assert.match(byId('agent-usage-summary').textContent, /Cache 50%/); assert.match(byId('agent-usage').textContent, /Loaded assistant window only/); assert.doesNotMatch(byId('agent-usage').textContent, /Primary|whole-session cost|context window/);
  assert.equal(byId('agent-folder').textContent, 'Saved folder /saved/recipient');
  event('agent.frame', {identity: 'other-recipient', connectionEpoch: 1, frame: {...frame, status: {busy: true, model: {provider: 'other', modelId: 'not-recipient'}}}}); flushFrames(); await settle();
  assert.equal(messageControl('settings-text')?.textContent, 'live-model · low');
  assert.equal(messageControl('editor'), editor); assert.equal(editor.value, 'Keep captured draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [2, 7]); assert.equal(hostDocument.activeElement, editor);
  assert.equal(byId('agent-usage-details'), details); assert.equal(Reflect.get(details, 'open'), true);
  assert.equal(transportLog.slice(before).filter(call => call.path.includes('/inputs') || call.path.endsWith('/targets')).length, 0);
  byId('agent-message-close').click();
});


test('three exact owners isolate drafts, carets, roots and accepted frames through pane and Message moves', async t => {
  host.viewport = 1800; t.after(() => {host.viewport = 1200; byId('agent-message-close').click();});
  const p = {kind: 'primary' as const, key: 'p', epoch: 9500}, a = {kind: 'agent' as const, identity: 'three-a'}, b = {kind: 'agent' as const, identity: 'three-b'};
  const frame = (identity: string, revision: number): ProjectedFrame => ({revision, observedAt: 'now', entries: [entryFixture(identity + revision, [messageFixture(`${identity}-m${revision}`, [textPart(`${identity} frame ${revision}`)])])], live: [], nextBefore: null, status: {busy: false, model: {provider: 'frame-owner', modelId: `${identity}-model-${revision}`}}, coverage});
  const layout: ConversationLayout = {focusedPane: 'pane-a', root: {kind: 'split', id: 'three-x', axis: 'x', ratio: 50,
    first: {kind: 'pane', id: 'pane-p', tabs: [{kind: 'primary'}], active: 'primary'},
    second: {kind: 'split', id: 'three-y', axis: 'y', ratio: 50, first: {kind: 'pane', id: 'pane-a', tabs: [a], active: tabKey(a)}, second: {kind: 'pane', id: 'pane-b', tabs: [b], active: tabKey(b)}}}};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: a, conversationLayout: layout}, primaries: [primaryFixture({epoch: p.epoch})], roster: [agentFixture(a.identity), agentFixture(b.identity)],
    observations: [observation(a.identity, frame(a.identity, 1), 10), observation(b.identity, frame(b.identity, 1), 20)], targets: [p, a, b].map((target, index) => targetFixture(`three-${index}`, target, {draft: {revision: 7, text: ['Primary exact draft', 'Alpha exact draft', 'Beta exact draft'][index] ?? '', mode: target.kind === 'primary' ? 'steer' : 'prompt', persisted: true}}))});
  const pc = controls(app.primaryComposer()), ac = controls(app.agentComposer());
  app.focusPane('pane-b'); await settle(); const bc = controls(app.agentComposer()); app.focusPane('pane-a'); await settle();
  const owners = [pc, ac, bc], roots = owners.map(owner => owner('root')), editors = owners.map(owner => owner('editor')), forms = owners.map(owner => owner('composer'));
  assert.equal(new Set(roots).size, 3); assert.equal(new Set(editors).size, 3); assert.equal(new Set(forms).size, 3);
  for (const [index, editor] of editors.entries()) { editor.value += ' local'; editor.dispatch('input'); editor.setSelectionRange(index + 1, index + 5, index === 1 ? 'backward' : 'forward'); editor.dispatch('select'); }
  await settle();
  const moved = movePaneTab(app.state.workspace?.conversationLayout ?? layout, tabKey(b), 'pane-a'); app.applyLayout(moved); await settle();
  assert.equal(bc('root'), roots[2]); assert.equal(bc('editor'), editors[2]); assert.equal(roots[2]?.parentNode, app.stableViews().host); assert.equal(app.stableViews().slot(roots[2] as unknown as HTMLElement)?.id, 'pane-content-pane-a');
  browser.fixture = {...browser.fixture, observations: [observation(a.identity, frame(a.identity, 1), 11), observation(b.identity, frame(b.identity, 1), 20)]};
  const restored = splitPane(app.state.workspace?.conversationLayout ?? moved, 'pane-a', 'y', {width: 760, height: 640, divider: 4}, tabKey(b)); app.applyLayout(restored); await settle();
  app.applyLayout(activatePaneTab(app.state.workspace?.conversationLayout ?? restored, 'pane-a', tabKey(a))); await settle();
  const bPane = paneLeaves((app.state.workspace?.conversationLayout ?? restored).root).find(pane => pane.active === tabKey(b)); assert.ok(bPane); app.openConversationActions(bPane.id); const message = menuNode().children.find(node => node.textContent === 'Message'); assert.ok(message); message.click(); await settle();
  assert.equal(messageControl('composer'), forms[2]); assert.equal(messageControl('editor'), editors[2]); assert.equal(forms[2]?.parentNode, roots[2]); assert.equal(app.stableViews().slot(forms[2] as unknown as HTMLElement)?.id,'agent-message-editor-slot'); assert.deepEqual(app.state.workspace?.selectedTarget, a); editors[2]?.focus();
  event('agent.frame', {identity: a.identity, connectionEpoch: 11, frame: frame(a.identity, 2)}); event('agent.frame', {identity: b.identity, connectionEpoch: 20, frame: frame(b.identity, 2)}); await settle();
  assert.match(ac('transcript').textContent, /three-a frame 2/); assert.doesNotMatch(ac('transcript').textContent, /three-b frame/);
  assert.match(bc('transcript').textContent, /three-b frame 2/); assert.doesNotMatch(bc('transcript').textContent, /three-a frame/); assert.equal(messageControl('stop').hidden, true); assert.equal(byId('workbench-scope').title,`${byId('workbench-scope').textContent}\n${b.identity}`); assert.match(bc('settings-text')?.textContent ?? '',/three-b-model-2/); assert.equal(hostDocument.activeElement,editors[2]);
  event('agent.frame', {identity: b.identity, connectionEpoch: 19, frame: frame('stale-b', 99)}); await settle(); assert.doesNotMatch(bc('transcript').textContent, /stale-b/);
  for (const [index, owner] of owners.entries()) { assert.equal(owner('root'), roots[index]); assert.equal(owner('editor'), editors[index]); assert.equal(owner('composer'), forms[index]); assert.deepEqual([editors[index]?.selectionStart, editors[index]?.selectionEnd], [index + 1, index + 5]); assert.equal(editors[index]?.selectionDirection,index === 1 ? 'backward' : 'forward'); }
  assert.deepEqual(editors.map(editor => editor.value), ['Primary exact draft local', 'Alpha exact draft local', 'Beta exact draft local']);
  byId('agent-message-close').click(); await settle(); assert.equal(forms[2]?.parentNode, roots[2]);
});

test('Message projection stays visible through a pending tab selection and layout-only refresh', async t => {
  const target = {kind: 'agent' as const, identity: 'projected-recipient'};
  const layout: ConversationLayout = {focusedPane: 'pane-1', root: {kind: 'pane', id: 'pane-1', tabs: [{kind: 'primary'}, target], active: tabKey(target)}};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target, conversationLayout: layout}, primaries: [primaryFixture({epoch: 9503})], roster: [agentFixture(target.identity)],
    targets: [targetFixture('projected-target', target, {draft: {revision: 2, text: 'Keep the exact draft', mode: 'prompt', persisted: true}})]});
  const owner = controls(app.agentComposer()), root = owner('root'), editor = owner('editor'), form = owner('composer');
  app.openConversationActions('pane-1'); const message = menuNode().children.find(node => node.textContent === 'Message'); assert.ok(message); message.click(); await settle();
  editor.focus(); editor.setSelectionRange(3, 12, 'backward'); editor.dispatch('select');
  const original = globalThis.fetch, held = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  t.after(() => {globalThis.fetch = original; held.resolve(); byId('agent-message-close').click();});
  globalThis.fetch = async (input, init) => {if (String(input).includes('/selection')) {started.resolve(); await held.promise;} return original(input, init);};
  app.applyLayout(activatePaneTab(layout, 'pane-1', 'primary')); await started.promise;
  app.renderNavigation(); app.stableViews().sync();
  assert.equal(root.hidden, false); assert.equal(root.inert, false); assert.equal(root.dataset.messageOnly, 'true');
  assert.equal(hostDocument.activeElement, editor); assert.equal(form.parentNode, root); assert.equal(editor.value, 'Keep the exact draft');
  assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [3, 12, 'backward']);
  held.resolve(); await app.selectionQueue.drain(); app.applyLayout(layout); await app.selectionQueue.drain();
  assert.equal(root.hidden, false); assert.equal(root.dataset.messageOnly, undefined); assert.equal(hostDocument.activeElement, editor);
  assert.equal(messageControl('editor'), editor); assert.equal(form.parentNode, root);
});

test('focused footer retains the same ordered owner nodes and replaces them only on owner change', async () => {
  const identity = 'footer-owner-change'; await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 9501})], roster: [agentFixture(identity)]});
  const slot = byId('focused-composer-status'); const agentNodes = [...slot.children], moves = agentNodes.map(node => node.moves), writes = slot.writes;
  app.renderNavigation(); app.renderNavigation(); await settle(); assert.deepEqual(slot.children, agentNodes); assert.equal(slot.writes, writes); assert.deepEqual(agentNodes.map(node => node.moves), moves);
  app.focusPane('primary-pane'); await settle(); const primaryNodes = [...slot.children]; assert.equal(primaryNodes.length, 2); assert.notEqual(primaryNodes[0], agentNodes[0]); assert.equal(slot.writes, writes + 1);
  const primaryWrites = slot.writes, primaryMoves = primaryNodes.map(node => node.moves); app.renderNavigation(); await settle(); assert.equal(slot.writes, primaryWrites); assert.deepEqual(primaryNodes.map(node => node.moves), primaryMoves);
  app.focusPane('agent-pane'); await settle(); assert.deepEqual(slot.children, agentNodes); assert.equal(slot.writes, primaryWrites + 1);
});

test('closing a Message and its tab retains an unsettled receipt under its exact owner', async t => {
  const target = {kind: 'agent' as const, identity: 'unsettled-owner'}, p = {kind: 'primary' as const, key: 'p', epoch: 9502};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: target, conversationLayout: twoPanes(target.identity)}, primaries: [primaryFixture({epoch: p.epoch})], roster: [agentFixture(target.identity)], targets: [targetFixture('unsettled-p', p), targetFixture('unsettled-a', target, {draft: {revision: 7, text: 'Exact pending input', mode: 'prompt', persisted: true}})]});
  const composer = app.agentComposer(), owner = controls(composer), editor = owner('editor'), form = owner('composer');
  const message = byId('roster').querySelector('[data-identity="unsettled-owner"]')?.querySelector('.row-message'); assert.ok(message); message.click(); await settle();
  const original = globalThis.fetch, result = Promise.withResolvers<Response>(), started = Promise.withResolvers<void>(); let operationId = '';
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => { if (new URL(String(input), 'http://ui.test').pathname === '/api/agents/unsettled-owner/inputs') {operationId = new Headers(init?.headers).get('Idempotency-Key') ?? ''; started.resolve(); return result.promise;} return original(input, init); };
  form.dispatch('submit'); await started.promise; assert.equal(composer.canDispose, false); byId('agent-message-close').click(); await settle();
  app.applyLayout(singlePane()); await settle(); assert.equal(composer.canDispose, false); message.click(); await settle(); assert.equal(messageControl('composer'), form); assert.equal(messageControl('editor'), editor);
  result.resolve(Response.json({ok: true, data: {id: operationId, kind: 'agent.input', target, state: 'uncertain', createdAt: 'now', updatedAt: 'now', error: {code: 'host_unavailable', message: 'Delivery not confirmed', retry: 'manual'}}})); await settle();
  assert.equal(messageControl('editor'), editor); assert.match(messageControl('receipt').textContent, /not confirmed|Delivery/i); assert.equal(composer.canDispose, false); assert.doesNotMatch(primaryControl('receipt').textContent, /Delivery not confirmed/); byId('agent-message-close').click();
});


test('held Agent capabilities block the captured Stop control without a reservation', async () => {
  const identity = 'held-stop-owner'; await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 9530})], roster: [agentFixture(identity, {capabilities: {input: true, abort: false}})], observations: [observation(identity)]});
  const owner = controls(app.agentComposer()), stop = owner('stop'), editor = owner('editor'), before = transportLog.length;
  assert.equal(stop.hidden, true); stop.click(); await settle();
  event('agent.availability', {identity, connectionEpoch: 1, state: 'live', capabilities: {input: false, abort: true}}); await settle(); stop.click(); await settle();
  assert.equal(stop.hidden, true); assert.equal(owner('editor'), editor); assert.equal(byId('modal').open, false);
  assert.equal(transportLog.slice(before).filter(call => call.path === '/api/operations' || call.path.endsWith('/abort')).length, 0);
});

test('a stale Stop confirmation cannot dispatch after its captured owner leaves the active pane', async () => {
  const identity = 'stale-stop-owner'; await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity}, conversationLayout: twoPanes(identity)}, primaries: [primaryFixture({epoch: 9531})], roster: [agentFixture(identity)], observations: [observation(identity, {revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: true}, coverage})]});
  const owner = controls(app.agentComposer()); owner('stop').click(); await settle();
  assert.equal(byId('modal').open, true); const confirm = byId('modal-body').querySelector('button.danger'); assert.ok(confirm); const before = transportLog.length;
  app.applyLayout(singlePane()); await settle(); const editor = primaryControl('editor'); editor.focus(); confirm.click(); await settle();
  assert.equal(transportLog.slice(before).filter(call => call.path === '/api/operations' || call.path.endsWith('/abort')).length, 0);
  assert.equal(hostDocument.activeElement, editor); assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'primary', key: 'p', epoch: 9531}); byId('modal').close();
});

test('queued view writes keep the old workspace acknowledgment despite a same-key current target', async t => {
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  for (const [index, kind] of (['reading', 'presentation'] as const).entries()) {
    const target = {kind: 'primary' as const, key: 'p', epoch: 9540 + index}, key = 'shared-view-key', workspace = `queued-old-${kind}`;
    const old = targetFixture(key, target, {reading: {revision: 7, anchorId: null, offsetPx: 0, followTail: true}, presentation: {revision: 5, expanded: [], showThinking: false, transcriptView: 'chronological'}});
    const history = Array.from({length: 20}, (_, at) => entryFixture(`queued-history-${kind}${at}`, [messageFixture(`queued-message-${kind}${at}`, [textPart(`Queued history ${at}`)])]));
    await arrive({workspace: {id: workspace, revision: 1, primaryKey: 'p', selectedTarget: target}, primaries: [primaryFixture({epoch: target.epoch})], roster: [], targets: [old], history});
    const response = Promise.withResolvers<Response>(), requests: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input), 'http://ui.test').pathname === `/api/workspaces/${workspace}/targets/${key}/${kind}`) {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        if (requests.length === 1) return response.promise;
        const {expectedRevision, ...values} = body; return Response.json({ok: true, data: {...values, revision: Number(expectedRevision) + 1}});
      }
      return original(input, init);
    };
    const scroller = primaryControl('transcript');
    const change = async (value: number) => {
      if (kind === 'reading') {scroller.scrollTop = value; scroller.dispatch('scroll'); flushFrames(); scroller.dispatch('scrollend');}
      else {app.openConversationActions(); const item = menuNode().children.find(node => node.textContent === (value === 120 ? 'Grouped' : 'Conversation')); assert.ok(item); item.click();}
      await settle();
    };
    await change(120); assert.equal(requests.length, 1); await change(240); assert.equal(requests.length, 1);
    assert.ok(old.presentation); const current = targetFixture(key, target, {reading: {...old.reading, revision: 50}, presentation: {...old.presentation, revision: 50}});
    await arrive({workspace: {id: `queued-new-${kind}`, revision: 1, primaryKey: 'p', selectedTarget: target}, primaries: [primaryFixture({epoch: target.epoch})], roster: [], targets: [current], history});
    const editor = primaryControl('editor'), notice = primaryControl('view-notice'); editor.focus(); notice.dataset.kind = kind; notice.textContent = 'Current workspace notice';
    const first = requests[0]; assert.ok(first); const {expectedRevision, ...values} = first;
    response.resolve(Response.json({ok: true, data: {...values, revision: Number(expectedRevision) + 1}})); await settle();
    assert.equal(requests.length, 2); assert.equal(requests[1]?.expectedRevision, Number(expectedRevision) + 1); assert.notEqual(requests[1]?.expectedRevision, 50);
    assert.equal(app.state.targets.get(key)?.[kind]?.revision, 50); assert.equal(notice.textContent, 'Current workspace notice'); assert.equal(hostDocument.activeElement, editor);
    globalThis.fetch = original;
  }
});

test('generic action failures keep exact details for the focused owner or an ownerless view', async t => {
  t.after(() => {browser.selectionFailure = undefined; byId('modal-close').click();});
  const diagnostic = 'connect ENOENT /fixture/selection-endpoint.sock', target = {kind: 'primary' as const, key: 'p', epoch: 9805};
  const cases: Fixture[] = [
    {workspace: {id: 'generic-error-owned', revision: 1, sidebarVisible: true, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: [], targets: [targetFixture('generic-error', target)]},
    {workspace: {id: 'generic-error-ownerless', revision: 1, sidebarVisible: true}, primaries: [], roster: []},
  ];
  for (const current of cases) {
    await arrive(current); const owner = !!current.workspace.primaryKey;
    const receipt = owner ? primaryControl('receipt') : undefined, captions: HostNode[] = []; let restoreReceipt = () => {};
    if (receipt) {
      const replace = receipt.replaceChildren.bind(receipt);
      receipt.replaceChildren = (...nodes) => {captions.push(...nodes); replace(...nodes);};
      restoreReceipt = () => {Reflect.deleteProperty(receipt, 'replaceChildren');};
    }
    browser.selectionFailure = {code: 'capacity', message: diagnostic, retry: 'capacity'};
    const before = transportLog.length; app.toggleSidebar(false); await app.selectionQueue.drain(); await settle(); browser.selectionFailure = undefined;
    restoreReceipt(); assert.ok(transportLog.slice(before).some(call => call.path.endsWith('/selection')));
    if (receipt) {
      const caption = captions.find(node => node.title === diagnostic); assert.ok(caption);
      assert.equal(caption.textContent, 'Action could not be completed.'); assert.doesNotMatch(caption.textContent, /ENOENT|selection-endpoint/); assert.equal(receipt.title, '');
      app.primaryComposer().receipts(app.state.operations.values()); assert.equal(caption.parentNode, null); assert.equal(receipt.querySelector('.status-error'), null); assert.equal(receipt.title, '');
    }
    else {assert.equal(byId('modal').open, true); assert.equal(byId('modal-body').querySelector('pre')?.textContent, diagnostic); byId('modal-close').click();}
    assert.doesNotMatch(byId('announcements').textContent, /ENOENT|selection-endpoint/);
  }
});
