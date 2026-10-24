import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type {EntryView, PartView} from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';

const f = await createAppFixture();
const {arrive, settle, byId, primaryFixture, targetFixture, entryFixture, messageFixture, singlePane, primaryControl, agentFixture} = f;
const recipient = '00000000-0000-4000-8000-000000000601';

function sent(id: string): EntryView {
  const reference: PartView = {type: 'text', text: 'Sent', structured: {value: {result: {sessionId: recipient, submissionId: 5, requestId: 'request-5'}}, truncated: false}};
  return entryFixture(id, [messageFixture(id, [
    {type: 'toolCall', callId: id, name: 'agent_send', arguments: {value: {sessionId: recipient, message: 'Build the release'}, truncated: false}},
    {type: 'toolResult', callId: id, name: 'agent_send', isError: false, parts: [reference]},
  ])]);
}
function recipientWork(t: TestContext, initial: 'placed' | 'queued' | 'done') {
  const original = globalThis.fetch, aborts: unknown[] = [], stops: string[] = [];
  let status: string = initial;
  t.after(() => { globalThis.fetch = original; if (byId('modal').open) byId('modal-close').click(); });
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname;
    if (path === `/api/agents/${recipient}/inspect`) return Response.json({ok: true, data: {view: 'result', identity: recipient, readAt: 'now', status, submissionId: 5, requestId: 'request-5',
      ...(status === 'done' ? {answerEntryId: 9, answer: {text: 'Finished', shortened: false, protected: false}} : {}), usage: {value: {}, truncated: false}}});
    if (path === `/api/agents/${recipient}/abort`) {aborts.push(JSON.parse(String(init?.body))); status = 'unanswered'; return Response.json({ok: true, data: {id: 'abort-operation', kind: 'agent.abort', state: 'completed'}});}
    if (path.endsWith('/stop')) stops.push(path);
    return original(input, init);
  };
  return {aborts, stops};
}
async function show(workspace: string): Promise<void> {
  const primary = primaryFixture({key: `${workspace}-primary`, epoch: 7101, activity: 'idle'});
  await arrive({workspace: {id: workspace, revision: 1, primaryKey: primary.key, conversationLayout: singlePane()}, primaries: [primary], roster: [agentFixture(recipient)],
    targets: [targetFixture(`${workspace}-target`, {kind: 'primary', key: primary.key, epoch: primary.epoch})], history: [sent(`${workspace}-send`)]});
  await settle();
}
const cardStop = () => primaryControl('root').querySelector('.step-answer-stop');

for (const status of ['placed', 'queued'] as const) test(`a ${status} request offers Stop on its card and in the composer of an idle session`, async t => {
  recipientWork(t, status);
  await show(`delegated-${status}`);
  assert.ok(cardStop(), 'The request card offers Stop.');
  assert.equal(primaryControl('stop').hidden, false, 'The composer offers Stop while the session waits for delegated work.');
});

test('the card Stop aborts the recipient at once and both Stop controls leave after the read', async t => {
  const calls = recipientWork(t, 'placed');
  await show('delegated-card-stop');
  const stop = cardStop(); assert.ok(stop);
  stop.click(); await settle();
  assert.deepEqual(calls.aborts, [{background: false}]);
  assert.equal(byId('modal').open, false, 'Stop asks for no confirmation.');
  assert.deepEqual(calls.stops, [], 'An idle session receives no stop request of its own.');
  assert.equal(cardStop(), null);
  assert.equal(primaryControl('stop').hidden, true);
});

test('the composer Stop aborts delegated work that an idle session still waits for', async t => {
  const calls = recipientWork(t, 'placed');
  await show('delegated-composer-stop');
  primaryControl('stop').click(); await settle();
  assert.deepEqual(calls.aborts, [{background: false}]);
  assert.deepEqual(calls.stops, []);
  assert.equal(primaryControl('stop').hidden, true);
});

test('an answered request offers no Stop', async t => {
  const calls = recipientWork(t, 'done');
  await show('delegated-answered');
  assert.equal(cardStop(), null);
  assert.equal(primaryControl('stop').hidden, true);
  assert.deepEqual(calls.aborts, []);
});
