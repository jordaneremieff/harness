import assert from 'node:assert/strict';
import test from 'node:test';
import type {OperationView} from '../shared/api.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
const {app,arrive,settle,event,byId,agentControl,primaryControl,primaryFixture,agentFixture,targetFixture,twoPanes,observation,coverage,hostDocument,controls,transportLog}=await createAppFixture();

test('agent selectors keep exact recipient, confirmed labels, draft and caret through pending and applied changes',async t=> {
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const identity='configure-agent',target={kind:'agent' as const,identity},draft=targetFixture('configure-draft',target,{draft:{revision:1,text:'Keep this exact draft',mode:'steer',images:[],persisted:true}});
  const row=agentFixture(identity,{name:'Recipient',model:{provider:'fixture',modelId:'model'},thinkingLevel:'low'});
  let resolve!:(value:Response)=>void;let calls=0;const response=new Promise<Response>(yes=>{resolve=yes;});
  globalThis.fetch=async(input,init)=> {
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path.endsWith('/resources/models'))return Response.json({ok:true,data:{items:[{provider:'fixture',id:'model',name:'Readable model',reasoning:true,input:['text'],thinkingLevels:['off','low','high']}],nextCursor:null,revision:'r'}});
    if(path.endsWith('/configure')){assert.equal(path,`/api/agents/${identity}/configure`);assert.deepEqual(JSON.parse(String(init?.body)),{thinkingLevel:'high'});calls++;return response;}
    return original(input,init);
  };
  const frame={revision:1,observedAt:'2026-01-01T00:00:00.000Z',entries:[],live:[],nextBefore:null,status:{busy:false,model:{provider:'fixture',modelId:'model'},thinkingLevel:'low'},coverage};
  await arrive({workspace:{id:'configure',revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:twoPanes(identity,'agent-pane')},primaries:[primaryFixture({epoch:8120,activity:'idle'})],roster:[row],targets:[draft],observations:[observation(identity,frame)]});await settle();
  const connectionEpoch=(app.state.agentEpochs.get(identity)??0)+1;
  event('agent.availability',{identity,connectionEpoch,state:'live',capabilities:row.capabilities});event('agent.frame',{identity,connectionEpoch,frame},target);await settle();
  assert.equal(agentControl('model').textContent,'Readable model');assert.equal(agentControl('thinking').textContent,'Low');assert.equal(agentControl('thinking').disabled,false,agentControl('thinking').title);
  const captured=controls(app.agentComposer()),editor=captured('editor');editor.focus();editor.setSelectionRange(2,8,'backward');
  agentControl('thinking').click();await settle();app.focusPane('primary-pane');await settle();
  const high=byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='high');assert.ok(high);high.click();await settle();
  assert.equal(calls,1);assert.equal(captured('thinking').textContent,'Low');assert.equal(captured('model').disabled,true);assert.equal(captured('thinking').disabled,true);assert.match(captured('state').textContent,/Updating settings/);
  const result:OperationView={id:'op-1',kind:'agent.configure',target,state:'completed',createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:01.000Z',receipt:{kind:'configuration',identity,outcome:'applied',after:{name:'Recipient',model:'fixture/model',thinkingLevel:'high'},afterSource:'live',persistence:'completed'}};
  resolve(Response.json({ok:true,data:result}));await settle();
  assert.equal(captured('thinking').textContent,'High');assert.equal(captured('editor'),editor);assert.equal(editor.value,draft.draft.text);assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,8,'backward']);assert.equal(hostDocument.activeElement,editor);assert.equal(calls,1);
  event('agent.frame',{identity,connectionEpoch,frame:{...frame,revision:2,status:{...frame.status,busy:true}}},target);await settle();
  assert.equal(captured('model').disabled,true);assert.equal(captured('thinking').disabled,true);
  assert.match(captured('state').textContent,/Steer at the next step; Queue adds a follow-up\./);assert.doesNotMatch(captured('state').textContent,/locked|Wait while/);
  for(const key of ['model','thinking']){const node=captured(key);assert.equal(node.getAttribute('aria-description'),'Model and thinking are locked while this agent works.');assert.match(node.title,/Model and thinking are locked while this agent works\./);assert.equal(node.getAttribute('aria-describedby'),null);}
  assert.equal((editor as HostNode & {placeholder:string}).placeholder,'Message');
});

test('uncertain configuration unlocks only after newer authoritative readback, without replay',async t=> {
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(input,init)=>String(input).includes('/resources/models')?Response.json({ok:true,data:{items:[{provider:'fixture',id:'readback',name:'Readback model',reasoning:true,input:['text'],thinkingLevels:['off','high']}],nextCursor:null,revision:'readback'}}):original(input,init);
  const identity='readback-settings',target={kind:'agent' as const,identity},row=agentFixture(identity,{model:{provider:'fixture',modelId:'readback'},thinkingLevel:'high'});
  const operation:OperationView={id:'readback-uncertain',kind:'agent.configure',target,state:'uncertain',createdAt:'2030-01-01T00:00:00.000Z',updatedAt:'2030-01-01T00:00:01.000Z',error:{code:'configuration_uncertain',message:'Native write was not confirmed.',retry:'none'}};
  await arrive({workspace:{id:'readback',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:8121,activity:'idle'})],roster:[row],pendingOperations:[operation]});event('ready',{bootId:'boot'});
  const connectionEpoch=(app.state.agentEpochs.get(identity)??0)+1,frame={revision:1,observedAt:'2030-01-01T00:00:00.000Z',entries:[],live:[],nextBefore:null,status:{busy:false,model:{provider:'fixture',modelId:'readback'},thinkingLevel:'high'},coverage};
  event('agent.availability',{identity,connectionEpoch,state:'live',capabilities:row.capabilities});event('agent.frame',{identity,connectionEpoch,frame},target);await settle();
  const before=transportLog.length;assert.equal(agentControl('model').disabled,true);assert.equal(agentControl('thinking').disabled,true);assert.match(agentControl('state').textContent,/not confirmed/);
  event('agent.frame',{identity,connectionEpoch,frame:{...frame,revision:2,observedAt:'2030-01-01T00:00:02.000Z'}},target);await settle();
  assert.equal(agentControl('model').disabled,false);assert.equal(agentControl('thinking').disabled,false);assert.match(agentControl('state').textContent,/checked after unconfirmed/);assert.equal(app.state.operations.get(operation.id)?.state,'uncertain');assert.equal(transportLog.slice(before).filter(call=>call.path.endsWith('/configure')).length,0);
});

test('busy Primary retains its existing model and thinking controls',async t=> {
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(input,init)=>String(input).includes('/resources/models')?Response.json({ok:true,data:{items:[{provider:'fixture',id:'primary-busy',name:'Busy Primary model',reasoning:true,input:['text']}],nextCursor:null,revision:'busy'}}):original(input,init);
  const primary=primaryFixture({epoch:8130,activity:'running',model:{provider:'fixture',id:'primary-busy',name:'Busy Primary model',reasoning:true,input:['text']},thinkingLevel:'high'});
  await arrive({workspace:{id:'primary-busy',revision:1,primaryKey:primary.key,selectedTarget:{kind:'primary',key:primary.key,epoch:primary.epoch}},primaries:[primary],roster:[],targets:[targetFixture('primary-busy-draft',{kind:'primary',key:primary.key,epoch:primary.epoch})]});event('ready',{bootId:'boot'});await settle();
  assert.equal(primaryControl('model').disabled,false);assert.equal(primaryControl('thinking').disabled,false);assert.doesNotMatch(primaryControl('model').title,/locked|Wait while/);assert.equal(primaryControl('thinking').textContent,'High');
  assert.equal((primaryControl('editor') as HostNode & {placeholder:string}).placeholder,'Message');assert.match(primaryControl('state').textContent,/Steer at the next step; Queue adds a follow-up\./);
  for(const key of ['send','queue']){assert.equal(primaryControl(key).hidden,false);assert.equal(primaryControl(key).disabled,true);}
});

test('unknown capability and uncertain configure remain visible without fabricated levels or automatic retry',async()=> {
  const identity='unknown-settings',target={kind:'agent' as const,identity};
  const row=agentFixture(identity,{model:{provider:'unlisted',modelId:'unknown'},thinkingLevel:'high'});
  const uncertain:OperationView={id:'uncertain-settings',kind:'agent.configure',target,state:'uncertain',createdAt:'2026-10-20T01:00:00.000Z',updatedAt:'2026-10-20T01:00:01.000Z',error:{code:'configuration_uncertain',message:'Native write was not confirmed.',retry:'none'}};
  await arrive({workspace:{id:'unknown',revision:1,primaryKey:null,selectedTarget:target},primaries:[],roster:[row],pendingOperations:[uncertain],observations:[observation(identity,{revision:1,observedAt:'2026-01-01T00:00:00.000Z',entries:[],live:[],nextBefore:null,status:{busy:false},coverage})]});await settle();
  assert.equal(agentControl('model').hidden,true);assert.equal(agentControl('thinking').hidden,true);assert.equal(agentControl('model').disabled,true);assert.equal(agentControl('thinking').disabled,true);assert.match(agentControl('state').textContent,/not confirmed/);assert.equal(agentControl('state-details').textContent,'Native write was not confirmed.');
});

test('missing settings hide disabled selectors without an unrelated composer notice',async()=> {
  const identity='missing-settings',target={kind:'agent' as const,identity},row=agentFixture(identity);
  await arrive({workspace:{id:'missing-settings',revision:1,primaryKey:null,selectedTarget:target},primaries:[],roster:[row],observations:[observation(identity,{revision:1,observedAt:'now',entries:[],live:[],nextBefore:null,status:{busy:false},coverage})]});
  event('agent.availability',{identity,connectionEpoch:app.state.agentEpochs.get(identity),state:'live',capabilities:row.capabilities});await settle();
  assert.equal(agentControl('state').hidden,true);
  for(const [key,label,reason]of [['model','Model unavailable','The model catalog is unavailable.'],['thinking','Thinking unavailable','Thinking capabilities are unavailable for this exact model.']] as const){
    const control=agentControl(key);assert.equal(control.hidden,true);assert.equal(control.disabled,true);assert.equal(control.querySelector('.composer-setting-label')?.textContent,label);assert.equal(control.getAttribute('aria-description'),reason);assert.ok(control.title.includes(reason));
  }
});
