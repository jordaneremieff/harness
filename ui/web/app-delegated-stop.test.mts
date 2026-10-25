import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type {EntryView, PartView} from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';

const f = await createAppFixture();
const {arrive, settle, byId, primaryFixture, targetFixture, entryFixture, messageFixture, singlePane, primaryControl, agentFixture} = f;
const recipient = '00000000-0000-4000-8000-000000000601';
const reference={sessionId:recipient,submissionId:5,requestId:'request-5'};
function sent(id: string): EntryView {
  const part: PartView = {type: 'text', text: 'Sent', structured: {value: {result: reference}, truncated: false}};
  return entryFixture(id, [messageFixture(id, [
    {type: 'toolCall', callId: id, name: 'agent_send', arguments: {value: {sessionId: recipient, message: 'Build the release'}, truncated: false}},
    {type: 'toolResult', callId: id, name: 'agent_send', isError: false, parts: [part]},
  ])]);
}
function inspectReply(status:string):Response {
  return Response.json({ok:true,data:{view:'result',identity:recipient,readAt:'now',status,submissionId:5,requestId:'request-5',...(status==='done'?{answerEntryId:9,answer:{text:'Finished',shortened:false,protected:false}}:{}),usage:{value:{},truncated:false}}});
}
function cancellationReply(state:string):Response {
  return Response.json({ok:true,data:{id:'cancel-operation',kind:'agent.control',state:'completed',receipt:{kind:'rpc',result:{value:{result:reference,state,effects:state==='aborted'?'not-started':'partial-effects-possible'},truncated:false}}}});
}
function recipientWork(t: TestContext, initial: 'placed' | 'queued' | 'done') {
  const original = globalThis.fetch, cancellations: unknown[] = [], stops: string[] = [];
  let status: string = initial;
  t.after(() => { globalThis.fetch = original; if (byId('modal').open) byId('modal-close').click(); });
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname;
    if (path === `/api/agents/${recipient}/inspect`)return inspectReply(status);
    if (path === `/api/agents/${recipient}/control`) {
      const body=JSON.parse(String(init?.body));cancellations.push(body);
      const state=status==='queued'?'aborted':'already_placed';if(state==='aborted')status='unanswered';
      return cancellationReply(state);
    }
    if (path.endsWith('/stop')||path.endsWith('/abort')) stops.push(path);
    return original(input, init);
  };
  return {cancellations, stops};
}
async function show(workspace: string): Promise<void> {
  const primary = primaryFixture({key: `${workspace}-primary`, epoch: 7101, activity: 'idle'});
  await arrive({workspace: {id: workspace, revision: 1, primaryKey: primary.key, conversationLayout: singlePane()}, primaries: [primary], roster: [agentFixture(recipient)],
    targets: [targetFixture(`${workspace}-target`, {kind: 'primary', key: primary.key, epoch: primary.epoch})], history: [sent(`${workspace}-send`)]});
  await settle();
}
const cardStop = () => primaryControl('root').querySelector('.step-answer-stop');
for (const status of ['placed', 'queued'] as const) test(`a ${status} request retains an exact cancellation action`, async t => {
  recipientWork(t, status);await show(`delegated-${status}`);assert.ok(cardStop());assert.equal(primaryControl('stop').hidden,false);
});
test('the card Stop withdraws queued input without a conversation abort',async t=>{
  const calls=recipientWork(t,'queued');await show('delegated-card-stop');const stop=cardStop();assert.ok(stop);stop.click();await settle();
  assert.deepEqual(calls.cancellations,[{method:'request-cancel',params:{result:reference}}]);assert.deepEqual(calls.stops,[]);assert.equal(byId('modal').open,false);assert.equal(cardStop(),null);assert.equal(primaryControl('stop').hidden,true);
});
test('the composer Stop preserves independently owned placed work and exposes that boundary',async t=>{
  const calls=recipientWork(t,'placed');await show('delegated-composer-stop');primaryControl('stop').click();await settle();
  assert.deepEqual(calls.cancellations,[{method:'request-cancel',params:{result:reference}}]);assert.deepEqual(calls.stops,[]);assert.ok(cardStop());assert.equal(primaryControl('stop').hidden,false);
});
test('an answered request offers no Stop',async t=>{
  const calls=recipientWork(t,'done');await show('delegated-answered');assert.equal(cardStop(),null);assert.equal(primaryControl('stop').hidden,true);assert.deepEqual(calls.cancellations,[]);
});
