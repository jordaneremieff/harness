import assert from 'node:assert/strict';
import test from 'node:test';
import type {Target} from '../shared/api.ts';
import {contextMenu} from './context-menu.ts';
import {createAppFixture} from './app-fixture.mts';
const {app, arrive, settle, event, byId, primaryControl, paneNode, primaryFixture, agentFixture, targetFixture, entryFixture, messageFixture, textPart, twoPanes, observation, coverage, transportLog} = await createAppFixture();

const forbidden = (start: number) => transportLog.slice(start).filter(call => call.method === 'POST' && (call.path.endsWith('/targets') || call.path.endsWith('/start') || call.path.includes('/inputs') || call.path === '/api/operations'));
function notice(target: Target, code = 'observation_unavailable'): void {
  event('notice', {level: 'warning', code, message: 'Native attach diagnostic: endpoint unavailable'}, target); byId('notifications-button').click();
}

test('notice inspection navigates without target preparation, Start or send and preserves the existing native image draft', async () => {
  const target: Target = {kind: 'agent', identity: 'passive-notice'}, p: Target = {kind: 'primary', key: 'p', epoch: 120};
  const images = [{name: 'image.png', digest: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, width: 1, height: 1}];
  const saved = targetFixture('passive-primary', p, {draft: {revision: 7, text: 'Keep Primary draft', mode: 'steer', images, persisted: true}});
  await arrive({workspace: {id: 'passive', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: 120})], roster: [agentFixture(target.identity, {name: 'Parser'})], targets: [saved]});
  const editor = primaryControl('editor'), parent = editor.parentNode; editor.setSelectionRange(2, 7, 'backward');
  notice(target); const destination = byId('modal-body').querySelector('.notice-destination'); assert.ok(destination);
  assert.equal(destination.textContent, 'Open Parser'); assert.match(byId('modal-body').textContent, /Native attach diagnostic: endpoint unavailable/);
  const start = transportLog.length; destination.click(); await settle();
  assert.deepEqual(app.state.workspace?.selectedTarget, target); assert.deepEqual(forbidden(start), []);
  assert.equal(primaryControl('editor'), editor); assert.equal(editor.parentNode, parent); assert.equal(editor.value, 'Keep Primary draft');
  assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']);
  assert.deepEqual(app.state.targets.get(saved.targetKey)?.draft.images, images);
  app.openConversationActions(); const menu = globalThis.document.querySelector('.context-menu'); assert.ok(menu);
  const explicit = [...menu.querySelectorAll('button')].find(node => node.textContent === 'Message'); assert.ok(explicit);
  const beforeMessage = transportLog.length; explicit.click(); await settle();
  assert.equal(transportLog.slice(beforeMessage).filter(call => call.method === 'POST' && call.path.endsWith('/targets')).length, 1);
  assert.equal(transportLog.slice(beforeMessage).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
  byId('agent-message-close').click(); await settle();
});

test('cold live indexed notice and reference destinations never reserve input until explicit Message', async () => {
  for (const route of ['notice', 'reference']) {
    const identity = route === 'notice' ? '10000000-0000-4000-8000-000000000004' : '10000000-0000-4000-8000-000000000005';
    const target: Target = {kind: 'agent', identity}, p: Target = {kind: 'primary', key: 'p', epoch: 125};
    const images = [{name: 'cold.png', digest: 'b'.repeat(64), mimeType: 'image/png', bytes: 67, width: 1, height: 1}];
    const saved = targetFixture(`cold-${route}`, target, {draft: {revision: 2, text: 'Retained cold draft', mode: 'followUp', images, persisted: true}});
    await arrive({workspace: {id: `cold-${route}`, revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: 125})],
      roster: [agentFixture(identity, {name: 'Cold live destination', availability: 'live', capabilities: {input: true}})],
      observations: [observation(identity)], targets: [targetFixture(`cold-primary-${route}`, p), saved],
      history: [entryFixture(`cold-entry-${route}`, [messageFixture(`cold-message-${route}`, [textPart(`Inspect ${identity}`)])])]});
    if (route === 'notice') notice(target);
    const destination = route === 'notice' ? byId('modal-body').querySelector('.notice-destination') : primaryControl('transcript').querySelector('.reference-link');
    assert.ok(destination); const start = transportLog.length; destination.click(); await settle();
    assert.deepEqual(app.state.workspace?.selectedTarget, target); assert.deepEqual(forbidden(start), []);
    assert.deepEqual(app.state.targets.get(saved.targetKey)?.draft, saved.draft);
    event('agent.availability', {identity, connectionEpoch: app.state.agentEpochs.get(identity) ?? 1, state: 'live', capabilities: {input: true}}); await settle();
    assert.deepEqual(forbidden(start), []);
    app.openConversationActions(); const menu = globalThis.document.querySelector('.context-menu'); assert.ok(menu);
    const explicit = [...menu.querySelectorAll('button')].find(node => node.textContent === 'Message'); assert.ok(explicit);
    const before = transportLog.length; explicit.click(); await settle();
    const calls = transportLog.slice(before);
    assert.equal(calls.filter(call => call.method === 'POST' && call.path.endsWith('/targets')).length, 1);
    assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/api/operations').length, 1);
    assert.equal(calls.some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
    byId('agent-message-close').click(); await settle();
  }
});

test('resolved transcript references also remain passive without a saved destination state', async () => {
  const identity = '10000000-0000-4000-8000-000000000123';
  const p: Target = {kind: 'primary', key: 'p', epoch: 121};
  await arrive({workspace: {id: 'passive-reference', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: 121})], roster: [agentFixture(identity)], targets: [targetFixture('reference-primary', p)], history: [entryFixture('reference-entry', [messageFixture('reference-message', [textPart(`Inspect ${identity}`)])])]});
  const link = primaryControl('transcript').querySelector('.reference-link'); assert.ok(link);
  const start = transportLog.length; link.click(); await settle();
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity}); assert.deepEqual(forbidden(start), []);
});

test('a captured notice refuses a changed agent epoch or workspace rather than activating a replacement', async () => {
  const target: Target = {kind: 'agent', identity: 'stale-notice'};
  const fixture = {workspace: {id: 'notice-guard', revision: 1, primaryKey: 'p', conversationLayout: twoPanes(target.identity, 'primary-pane')}, primaries: [primaryFixture({epoch: 122})], roster: [agentFixture(target.identity, {name: 'Parser'})], observations: [observation(target.identity)], targets: [targetFixture('guard-agent', target)]};
  for (const change of ['epoch', 'workspace']) {
    await arrive(fixture); notice(target); const destination = byId('modal-body').querySelector('.notice-destination'); assert.ok(destination);
    if (change === 'epoch') event('agent.availability', {identity: target.identity, connectionEpoch: (app.state.agentEpochs.get(target.identity) ?? 0) + 1, state: 'live', capabilities: {input: true}});
    else await arrive({...fixture, workspace: {...fixture.workspace, id: 'other-notice-workspace'}});
    const start = transportLog.length; destination.click(); await settle();
    assert.notDeepEqual(app.state.workspace?.selectedTarget, target); assert.deepEqual(forbidden(start), []);
    assert.equal(transportLog.slice(start).some(call => call.path.endsWith('/selection')), false);
    assert.match(byId('announcements').textContent, /no longer available/); byId('modal-close').click();
  }
});

test('grouped refusal details retain every cause and Dismiss removes only their original records', async () => {
  await arrive({workspace: {id: 'notice-group', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: 123})], roster: []});
  event('notice', {level: 'warning', code: 'state_record_refused', message: '/state/first: unsupported draft'});
  event('notice', {level: 'error', code: 'state_record_refused', message: '/state/second: malformed record'});
  event('notice', {level: 'info', message: 'Keep the other notice'}); const ids = app.state.notices.slice(0, 2).map(item => item.id);
  byId('notifications-button').click(); const rows = byId('modal-body').querySelectorAll('.notification'); assert.equal(rows.length, 2);
  const grouped = rows[0]; assert.ok(grouped); assert.equal(grouped.dataset.noticeCount, '2'); assert.match(grouped.className, /error/);
  assert.equal(grouped.querySelector('p')?.textContent, '2 saved records could not be read. The saved files remain unchanged.');
  const detail = grouped.querySelector('pre'); assert.ok(detail); for (const id of ids) assert.match(detail.textContent, new RegExp(id));
  assert.match(detail.textContent, /unsupported draft/); assert.match(detail.textContent, /malformed record/);
  const dismiss = grouped.querySelector('button'); assert.ok(dismiss); const start = transportLog.length; dismiss.click();
  assert.deepEqual([...app.state.dismissedNotices], ids); assert.equal(app.state.notices.length, 1); assert.equal(app.state.notices[0]?.message, 'Keep the other notice');
  assert.deepEqual(forbidden(start), []); byId('modal-close').click();
});

test('local conversation menus never select another recipient and target its View and thinking controls exactly', async () => {
  const target: Target = {kind: 'agent', identity: 'local-menu'};
  const p: Target = {kind: 'primary', key: 'p', epoch: 124};
  await arrive({workspace: {id: 'local-menu', revision: 1, primaryKey: 'p', conversationLayout: twoPanes(target.identity, 'primary-pane')}, primaries: [primaryFixture({epoch: 124})], roster: [agentFixture(target.identity)], targets: [targetFixture('local-primary', p), targetFixture('local-agent', target)], observations: [observation(target.identity, {revision: 1, observedAt: 'now', entries: [entryFixture('local-thinking', [messageFixture('thinking-message', [{type: 'thinking', text: 'Reported reasoning'}])])], live: [], nextBefore: null, status: {busy: false}, coverage})]});
  const selected = app.state.workspace?.selectedTarget, start = transportLog.length;
  app.openTabActions('agent-pane'); const short = globalThis.document.querySelector('.context-menu'); assert.ok(short);
  assert.equal([...short.querySelectorAll('button')].some(node => node.textContent === 'Show thinking'), false);
  const more = [...short.querySelectorAll('button')].find(node => node.textContent === 'Conversation actions…'); assert.ok(more); more.click();
  const menu = globalThis.document.querySelector('.context-menu'); assert.ok(menu); assert.equal(menu.getAttribute('aria-label'), 'Conversation actions');
  assert.deepEqual(app.state.workspace?.selectedTarget, selected); assert.deepEqual(forbidden(start), []);
  const thinking = [...menu.querySelectorAll('button')].find(node => node.textContent === 'Show thinking'); assert.ok(thinking); thinking.click(); await settle();
  const slot = paneNode('agent-pane').querySelector('.pane-content'); assert.ok(slot);
  const agentRoot = [...globalThis.document.querySelectorAll<HTMLElement>('.conversation')].find(root => app.stableViews().slot(root) === slot as unknown as HTMLElement);
  assert.ok(agentRoot); assert.equal(agentRoot.querySelector<HTMLDetailsElement>('.thinking')?.open, true); assert.deepEqual(app.state.workspace?.selectedTarget, selected);
  assert.equal(app.state.targets.get('local-agent')?.presentation?.showThinking, true);
  contextMenu.close();
});
