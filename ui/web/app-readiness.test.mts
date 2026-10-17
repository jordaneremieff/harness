import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
const browser=await createAppFixture();
const {app,arrive,agentFixture,targetFixture,singlePane,agentControl,observation,coverage,settle,fixturePreparation}=browser;

test('Check connection restores snapshot readiness without another availability event or draft replacement',async t=> {
  const identity='snapshot-ready',target={kind:'agent' as const,identity},workspace='snapshot-readiness';
  const saved=targetFixture('ready-target',target,{draft:{revision:3,text:'Keep this exact draft',mode:'followUp',persisted:true}});
  await arrive({workspace:{id:workspace,revision:1,selectedTarget:target,conversationLayout:singlePane([target])},primaries:[],roster:[agentFixture(identity,{availability:'stored',capabilities:{input:false}})],targets:[saved]});
  const editor=agentControl('editor');editor.setSelectionRange(2,7,'backward');assert.equal(agentControl('send').disabled,false);
  const row=agentFixture(identity),epoch=(app.state.agentEpochs.get(identity)??0)+1;
  const capabilities=row.capabilities;assert.ok(capabilities);
  const availability={identity,connectionEpoch:epoch,state:'live' as const,capabilities};
  browser.fixture={...browser.fixture,roster:[row],observations:[{...observation(identity,{revision:1,observedAt:'now',entries:[],live:[],nextBefore:null,status:{busy:false},coverage},epoch),availability}]};
  const original=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=> {
    if(new URL(String(input),'http://ui.test').pathname.endsWith('/targets')&&init?.method==='POST')return Response.json({ok:true,data:fixturePreparation(target)});
    return original(input,init);
  });
  await app.checkAgentConnection(workspace,identity);await settle();
  assert.equal(agentControl('send').disabled,false);assert.doesNotMatch(agentControl('agent-state-line').textContent,/unavailable|not confirmed/i);
  assert.equal(app.state.agentAvailability.get(identity)?.connectionEpoch,epoch);
  assert.equal(agentControl('editor'),editor);assert.equal(editor.value,saved.draft.text);
  assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,7,'backward']);
});

test('native input stays available without a current observation confirmation',async t=> {
  const identity='unobserved-readiness',target={kind:'agent' as const,identity},workspace='unobserved-readiness';
  const saved=targetFixture('unobserved-target',target,{draft:{revision:2,text:'Keep unconfirmed draft',mode:'followUp',persisted:true}});
  await arrive({workspace:{id:workspace,revision:1,selectedTarget:target,conversationLayout:singlePane([target])},primaries:[],roster:[agentFixture(identity,{availability:'stored',capabilities:{input:false}})],targets:[saved],observations:[]});
  browser.fixture={...browser.fixture,roster:[agentFixture(identity)]};
  const original=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=> {
    if(new URL(String(input),'http://ui.test').pathname.endsWith('/targets')&&init?.method==='POST')return Response.json({ok:true,data:fixturePreparation(target)});
    return original(input,init);
  });
  await app.checkAgentConnection(workspace,identity);await settle();
  assert.equal(app.state.agentAvailability.has(identity),false);assert.equal(agentControl('send').disabled,false);
  assert.doesNotMatch(agentControl('agent-state-line').textContent,/unavailable/);assert.equal(agentControl('editor').value,saved.draft.text);
});
