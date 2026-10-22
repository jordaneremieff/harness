import assert from 'node:assert/strict';
import test from 'node:test';
import type {PrimaryView} from '../shared/api.ts';
import {projectFrame} from '../server/projection.mts';
import {transferFrame} from '../agents/transfer.mts';
import {frame as nativeFrame, blockedResult} from '../agents/fake-host.mts';
import type {ConversationFrame} from '../agents/contract.mts';
import {createAppFixture} from './app-fixture.mts';
const f = await createAppFixture();
let target = {kind: 'primary' as const, key: 'p', epoch: 1};
function messageEntries() {
  const user = {...f.messageFixture('user', [f.textPart('Exact previous user message')]), role: 'user'};
  const failed = {...f.messageFixture('failed', [f.textPart('Retained partial response')]), stopReason: 'error', error: 'Opaque provider diagnostic'};
  return [f.entryFixture('user-entry', [user]), f.entryFixture('failed-entry', [failed])];
}
async function primary(name: string, overrides: Partial<PrimaryView> = {}, draft = '') {
  target = {kind: 'primary', key: name, epoch: 1};
  const item = f.primaryFixture({key: name, activity: 'idle', capabilities: {input: true, control: true}, ...overrides});
  await f.arrive({workspace: {id: name, revision: 1, primaryKey: name}, primaries: [item], roster: [], history: messageEntries(), targets: [f.targetFixture(name, target, {draft: {revision: 1, text: draft, mode: 'prompt', images: [], persisted: true}})]});
  for (const entry of messageEntries()) f.event('primary.entry', {entry}, target); await f.settle();
  return item;
}
test('same-backend retry snapshots show counters and qualified time without a raw retry paragraph', async () => {
  const retry = {attempt: 2, maxAttempts: 9, delayMs: 60000, at: 1700000060000, error: 'Opaque provider diagnostic'};
  const item = await primary('retry-snapshot', {activity: 'retrying', retry}, 'Unsent draft');
  const editor = f.app.primaryComposer().editor; editor.focus();
  assert.match(f.byId('workbench-activity').textContent, /^Retrying · retry 2 of 9 · next about /);
  assert.match(f.byId('workbench-activity').title, /estimated from backend receipt/);
  assert.match(f.byId('workbench-activity').title, /Opaque provider diagnostic/);
  assert.equal(f.primaryControl('activity').textContent, '');
  await f.app.reload(); await f.settle(); assert.match(f.byId('workbench-activity').textContent, /^Retrying · retry 2 of 9/);
  f.event('primary.state', {...item, activity: 'running', retry: undefined}, target); await f.settle();
  assert.equal(f.byId('workbench-activity').textContent, 'Working'); assert.equal(f.primaryControl('activity').textContent, '');
  assert.equal(f.app.primaryComposer().editor, editor); assert.equal(editor.value, 'Unsent draft');
});
test('a terminal model error keeps input and partial content but uses collapsed diagnostics', async () => {
  await primary('terminal-failure', {responseOutcome: 'failed'}, 'Unsent draft');
  assert.equal(f.byId('workbench-activity').textContent, 'Response failed');
  assert.equal(f.primaryControl('editor').disabled, false); assert.equal(f.primaryControl('editor').value, 'Unsent draft');
  const failure = f.primaryControl('root').querySelectorAll('.response-failure').find(node => !node.closest('[hidden]')); assert.ok(failure);
  const toggle = failure.querySelector('.response-failure-toggle'), body = failure.querySelector('.response-failure-body'); assert.ok(toggle); assert.ok(body);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert.equal(body.hidden, true); assert.equal(body.querySelector('pre')?.textContent, 'Opaque provider diagnostic');
  assert.equal(f.primaryControl('activity').textContent, 'Review message');
});
test('native retry and block facts cross the worker boundary into separate quiet states', async () => {
  const source = nativeFrame(1) as ConversationFrame, identity = source.storageId;
  const row = f.agentFixture(identity); const agentTarget = {kind: 'agent' as const, identity};
  source.entries = [{id: '1', kind: 'pi.assistant', model: [{role: 'assistant', content: [{type: 'text', text: 'Retained partial response'}], stopReason: 'error', errorMessage: 'Unclassified failure text'}]}];
  source.status.busy = true; source.status.live = {generation: {attempt: 2, retry: {at: 1700000060000, error: 'Unclassified failure text'}}};
  let display = projectFrame(transferFrame(source));
  await f.arrive({workspace: {id: 'native-failure', revision: 1, selectedTarget: agentTarget}, primaries: [], roster: [row], observations: [f.observation(identity, display)], targets: [f.targetFixture('native-failure', agentTarget, {draft: {revision: 1, text: 'Unsent native draft', mode: 'followUp', images: [], persisted: true}})]});
  const epoch = f.app.state.agentEpochs.get(identity); f.event('agent.availability', {identity, connectionEpoch: epoch, state: 'live', capabilities: row.capabilities}); await f.settle();
  assert.match(f.byId('workbench-activity').textContent, /^Retrying · attempt 2 · next /);
  assert.equal(f.agentControl('state-line').textContent, 'Steer at the next step; Queue adds a follow-up.');
  assert.equal(f.agentControl('model').getAttribute('aria-description'), 'Model and thinking are locked while this agent works.');
  assert.equal(f.agentControl('thinking').getAttribute('aria-description'), 'Model and thinking are locked while this agent works.');
  assert.equal(f.agentControl('model').disabled, true); assert.equal(f.agentControl('thinking').disabled, true);
  assert.doesNotMatch(f.agentControl('state-line').textContent, /Unclassified failure text/);
  source.revision = 2; source.status.live = {generation: {attempt: 3}};
  display = projectFrame(transferFrame(source)); f.event('agent.frame', {identity, connectionEpoch: epoch, frame: display}); await f.settle();
  assert.equal(f.byId('workbench-activity').textContent, 'Working');
  source.revision = 3; source.status.busy = false; source.status.live = {};
  display = projectFrame(transferFrame(source)); f.event('agent.frame', {identity, connectionEpoch: epoch, frame: display}); await f.settle();
  assert.equal(f.byId('workbench-activity').textContent, 'Response failed');
  source.revision = 4; source.status.providerBlock = blockedResult(identity).providerBlock;
  display = projectFrame(transferFrame(source)); f.event('agent.frame', {identity, connectionEpoch: epoch, frame: display}); await f.settle();
  assert.equal(f.byId('workbench-activity').textContent, 'Provider blocked'); assert.equal(f.agentControl('state-line').textContent, 'Provider blocked. Configure this agent through Primary.');
  assert.equal(f.agentControl('editor').value, 'Unsent native draft'); assert.doesNotMatch(f.agentControl('state-line').textContent, /quota|error|disconnected/i);
});
test('message-free native status details follow the current target without reported model or usage', async () => {
  const source = nativeFrame(1); source.status.providerBlock = blockedResult(source.storageId).providerBlock;
  const block = projectFrame(transferFrame(source)).status.providerBlock; assert.ok(block);
  block.error = 'Protected provider block diagnostic'; block.errorRedacted = true; block.errorTruncated = true;
  const first = f.agentFixture(source.storageId, {cwd: '', model: undefined, thinkingLevel: undefined});
  const second = f.agentFixture('empty-native-status', {cwd: '', model: undefined, thinkingLevel: undefined});
  const display = {revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: false, providerBlock: block}, coverage: f.coverage};
  const firstTarget = {kind: 'agent' as const, identity: first.identity}, secondTarget = {kind: 'agent' as const, identity: second.identity};
  await f.arrive({workspace: {id: 'status-diagnostics', revision: 1, selectedTarget: firstTarget}, primaries: [], roster: [first, second], observations: [f.observation(first.identity, display)]});
  f.event('agent.availability', {identity: first.identity, connectionEpoch: f.app.state.agentEpochs.get(first.identity), state: 'live', capabilities: first.capabilities}); await f.settle();
  const disclosure = f.byId('agent-usage-details'), text = f.byId('agent-settings-detail');
  assert.equal(disclosure.hidden, false); assert.equal(disclosure.open, false);
  assert.match(text.textContent, /Protected provider block diagnostic/); assert.match(text.textContent, /redacted/); assert.match(text.textContent, /shortened/);
  assert.equal(f.agentControl('root').querySelectorAll('.message-error').length, 0);
  await f.arrive({workspace: {id: 'status-diagnostics', revision: 2, selectedTarget: secondTarget}, primaries: [], roster: [first, second], observations: [f.observation(second.identity, {...display, status: {busy: false}})]});
  f.event('agent.availability', {identity: second.identity, connectionEpoch: f.app.state.agentEpochs.get(second.identity), state: 'live', capabilities: second.capabilities}); await f.settle();
  assert.equal(disclosure.hidden, false); assert.equal(text.textContent, ''); assert.match(f.byId('agent-usage').textContent, /Cache usage is not reported/);
  const epoch = f.app.state.agentEpochs.get(second.identity);
  f.event('agent.frame', {identity: second.identity, connectionEpoch: epoch, frame: {...display, revision: 2, status: {busy: true, retry: {attempt: 2, at: 1700000060000, error: 'Current retry diagnostic'}}}}); await f.settle();
  assert.equal(disclosure.hidden, false); assert.equal(text.textContent, 'Current retry diagnostic');
  f.event('agent.frame', {identity: first.identity, connectionEpoch: f.app.state.agentEpochs.get(first.identity), frame: {...display, revision: 3}}); await f.settle();
  assert.equal(text.textContent, 'Current retry diagnostic');
});
test('nonready Primaries expose lifecycle errors without a dead review control in the panel or palette', async () => {
  for (const lifecycle of ['stopped', 'failed', 'starting', 'switching', 'stopping'] as const) {
    await primary(`review-${lifecycle}`, {lifecycle, lastError: {code: 'not_ready', message: 'Start the session before use.', retry: 'manual'}}, 'Retained draft');
    assert.match(f.primaryControl('activity').textContent, /This session is not ready/);
    assert.doesNotMatch(f.primaryControl('activity').textContent, /The response failed|Review message/);
    assert.equal(f.primaryControl('activity').querySelector('details')?.open, false);
    assert.equal(f.primaryControl('editor').value, 'Retained draft');
    f.byId('commands-button').dispatch('click'); await f.settle();
    assert.equal(f.byId('modal-body').querySelectorAll('.palette-row').some(node => node.textContent.includes('Review message')), false);
    f.byId('modal-close').dispatch('click');
  }
  await primary('review-ready-palette', {responseOutcome: 'failed'});
  f.byId('commands-button').dispatch('click'); await f.settle();
  assert.equal(f.byId('modal-body').querySelectorAll('.palette-row').some(node => node.textContent.includes('Review message')), true);
  f.byId('modal-close').dispatch('click');
});
test('Review message refuses a replaced Primary and never replays input', async () => {
  const item = await primary('review-stale', {responseOutcome: 'failed'});
  const editor = f.app.primaryComposer().editor, review = f.primaryControl('activity').querySelector('button'); assert.ok(review); review.dispatch('click'); await f.settle();
  const confirm = f.byId('modal-body').querySelectorAll('button').find(node => node.textContent === 'Restore message'); assert.ok(confirm);
  const before = f.transportLog.length; f.event('primary.state', {...item, epoch: 2, responseOutcome: undefined}, {kind: 'primary', key: item.key, epoch: 2}); await f.settle();
  confirm.dispatch('click'); await f.settle();
  assert.equal(editor.value, ''); assert.match(f.byId('modal-error').textContent, /Primary or its draft changed/);
  assert.equal(f.transportLog.slice(before).some(call => /\/inputs$/.test(call.path)), false); f.byId('modal-close').dispatch('click');
});
test('Review message refuses a newer draft on the same Primary', async () => {
  await primary('review-newer-draft', {responseOutcome: 'failed'}, 'Original unsent draft');
  const review = f.primaryControl('activity').querySelector('button'); assert.ok(review); review.dispatch('click'); await f.settle();
  assert.match(f.byId('modal-body').textContent, /Exact previous user message/); assert.match(f.byId('modal-body').textContent, /Original unsent draft/);
  const confirm = f.byId('modal-body').querySelectorAll('button').find(node => node.textContent === 'Restore message'); assert.ok(confirm);
  f.app.primaryComposer().setText('Newer unsent draft'); await f.settle(); const before = f.transportLog.length;
  confirm.dispatch('click'); await f.settle(); assert.equal(f.app.primaryComposer().editor.value, 'Newer unsent draft');
  assert.match(f.byId('modal-error').textContent, /Primary or its draft changed/); assert.equal(f.transportLog.slice(before).some(call => call.path.endsWith('/inputs')), false); f.byId('modal-close').dispatch('click');
});
test('Review message restores only the captured prompt for review without sending', async () => {
  await primary('review-current', {responseOutcome: 'failed'});
  const review = f.primaryControl('activity').querySelector('button'); assert.ok(review); review.dispatch('click'); await f.settle();
  const confirm = f.byId('modal-body').querySelectorAll('button').find(node => node.textContent === 'Restore message'); assert.ok(confirm);
  const before = f.transportLog.length; confirm.dispatch('click'); await f.settle();
  assert.equal(f.app.primaryComposer().editor.value, 'Exact previous user message');
  assert.equal(f.transportLog.slice(before).some(call => /\/inputs$/.test(call.path)), false);
});
