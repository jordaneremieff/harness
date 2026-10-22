import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
import type {ProjectedFrame, ProviderBlock} from '../shared/api.ts';
const f=await createAppFixture();
const {app,arrive,settle,primaryFixture,agentFixture,targetFixture,entryFixture,messageFixture,textPart,singlePane,observation,hostDocument,agentControl}=f;
const block: ProviderBlock = {blockId:'block',conversationId:1,providerSessionId:'session',epoch:1,model:{provider:'fixture',modelId:'model'},error:'Provider denied the response',errorRedacted:false,errorTruncated:false,source:'provider',timestamp:1,originalResults:[],omittedOriginalResults:0};
function frame(status: ProjectedFrame['status'],entries: ProjectedFrame['entries']=[]): ProjectedFrame {return {revision:1,observedAt:'now',entries,live:[],nextBefore:null,status,coverage:f.coverage};}
function openRow(key:string){const row=hostDocument.querySelectorAll('.conversation-row').find(node=>node.dataset.tabKey===key);assert.ok(row);return row;}
function tab(key:string){const node=hostDocument.querySelectorAll('.conversation-tab').find(node=>node.dataset.tabKey===key);assert.ok(node);return node;}

test('an inactive current Primary keeps Question while existing activation retains the already-open modal',async()=>{
  const identity='question-side', target={kind:'agent' as const,identity};
  const primary=primaryFixture({epoch:9100,activity:'idle',pendingDialogs:[{id:'question',method:'confirm',title:'Continue the task?'}]});
  const p={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  await arrive({workspace:{id:'attention-question',revision:1,primaryKey:primary.key,selectedTarget:target,conversationLayout:singlePane([{kind:'primary'},target],`agent:${identity}`)},primaries:[primary],roster:[agentFixture(identity)],targets:[targetFixture('question-primary',p),targetFixture('question-agent',target)]});
  const row=openRow('primary');assert.equal(row.querySelector('.conversation-state')?.textContent,'Question');assert.equal(tab('primary').querySelector('.tab-dot')?.textContent,'Question');assert.equal(tab('primary').getAttribute('aria-selected'),'false');
  const modal=hostDocument.querySelector('#modal');assert.ok(modal);assert.equal(modal.open,true);
  const show=f.HostNode.prototype.showModal;let opens=0;f.HostNode.prototype.showModal=function(){opens++;show.call(this);};
  try{row.click();await settle();tab('primary').click();await settle();assert.equal(tab('primary').getAttribute('aria-selected'),'true');assert.equal(app.state.workspace?.selectedTarget?.kind,'primary');assert.equal(modal.open,true);assert.match(modal.textContent,/Continue the task\?/);assert.equal(opens,0);}finally{f.HostNode.prototype.showModal=show;}
});
test('Question clears on answered, cancelled and expired facts and ignores another Primary',async()=>{
  for(const reason of ['answered','cancelled','timeout'] as const){
    const primary=primaryFixture({epoch:9200,activity:'idle',pendingDialogs:[{id:reason,method:'confirm',title:'Continue?'}]}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
    await arrive({workspace:{id:`question-${reason}`,revision:1,primaryKey:primary.key,conversationLayout:singlePane()},primaries:[primary],roster:[],targets:[targetFixture(`question-${reason}`,target)]});
    assert.equal(tab('primary').querySelector('.tab-dot')?.textContent,'Question');f.event('extension.expired',{id:reason,reason},target);await settle();assert.equal(tab('primary').querySelector('.tab-dot')?.textContent,'');assert.equal(openRow('primary').querySelector('.conversation-state')?.textContent,'Ready');
  }
  const primary=primaryFixture({epoch:9201,activity:'idle'}),other=primaryFixture({key:'other',epoch:9202,activity:'idle',pendingDialogs:[{id:'other-question',method:'confirm',title:'Other Primary'}]});
  await arrive({workspace:{id:'question-other',revision:1,primaryKey:primary.key,conversationLayout:singlePane()},primaries:[primary,other],roster:[],targets:[targetFixture('question-current',{kind:'primary',key:primary.key,epoch:primary.epoch})]});
  assert.equal(tab('primary').querySelector('.tab-dot')?.textContent,'');assert.equal(openRow('primary').querySelector('.conversation-state')?.textContent,'Ready');
});
test('partial Primary messages do not repaint tab status; the final message updates attention',async()=>{
  const primary=primaryFixture({epoch:9203,activity:'idle'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  await arrive({workspace:{id:'attention-stream',revision:1,primaryKey:primary.key,conversationLayout:singlePane()},primaries:[primary],roster:[],targets:[targetFixture('attention-stream',target)]});
  const mark=tab('primary').querySelector('.tab-dot');assert.ok(mark);const writes=mark.writes;
  f.event('primary.message',{message:messageFixture('stream',[textPart('Partial response')],'partial')},target);await settle();assert.equal(mark.writes,writes);
  f.event('primary.message',{message:{...messageFixture('stream',[textPart('Final response')]),stopReason:'error'}},target);await settle();assert.equal(mark.textContent,'Failed');
});
test('Failed activation reveals the latest message-error outside the virtual window',async()=>{
  const primary=primaryFixture({epoch:9101,activity:'idle',responseOutcome:'failed'}), p={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  const entries=Array.from({length:70},(_,at)=>entryFixture(`failure-${at}`,[{...messageFixture(`message-${at}`,[textPart(`Message ${at}`)]),...(at===3||at===65?{stopReason:'error',error:`Failure ${at}`}:{})}]));
  await arrive({workspace:{id:'attention-failed',revision:1,primaryKey:primary.key,conversationLayout:singlePane()},primaries:[primary],roster:[],targets:[targetFixture('failed-primary',p,{reading:{revision:1,anchorId:'failure-1',offsetPx:0,followTail:false}})],history:entries});
  const calls:string[]=[];const scroll=f.HostNode.prototype.scrollIntoView;
  f.HostNode.prototype.scrollIntoView=function(){calls.push(this.textContent);};
  try{assert.equal(openRow('primary').querySelector('.conversation-state')?.textContent,'Failed');tab('primary').click();await settle();assert.ok(calls.some(text=>text.includes('Failure 65')));assert.equal(calls.some(text=>text.includes('Failure 3')),false);}finally{f.HostNode.prototype.scrollIntoView=scroll;}
});
test('connected attention sorts before work, catalog facts never invent attention, and activation falls back to composer state',async()=>{
  const identity='blocked-agent',target={kind:'agent' as const,identity}, primary=primaryFixture({epoch:9102,activity:'idle'});
  const observed=observation(identity,frame({busy:false,providerBlock:block}));
  const capabilities=agentFixture(identity).capabilities;assert.ok(capabilities);
  const rows=[agentFixture('catalog-failed',{state:'failed',error:'Not reachable Question Failed'}),agentFixture('working',{state:'working'}),agentFixture(identity),agentFixture('catalog-idle')];
  await arrive({workspace:{id:'attention-blocked',revision:1,primaryKey:primary.key,selectedTarget:target,conversationLayout:singlePane([{kind:'primary'},target],`agent:${identity}`)},primaries:[primary],roster:rows,targets:[targetFixture('blocked-primary',{kind:'primary',key:primary.key,epoch:primary.epoch}),targetFixture('blocked-agent',target)],observations:[{...observed,availability:{identity,connectionEpoch:observed.connectionEpoch,state:'live',capabilities}}]});
  app.setSidebarSection('agents',false);await settle();
  const rendered=hostDocument.querySelectorAll('.agent-row');assert.deepEqual(rendered.map(node=>node.dataset.identity),[identity,'working','catalog-failed','catalog-idle']);assert.equal(rendered[0]?.querySelector('.row-summary')?.children[0]?.textContent,'Blocked');assert.equal(rendered[0]?.querySelector('.row-state')?.dataset.tone,'warning');
  assert.equal(f.byId('agents-count').textContent,'4');assert.equal(f.byId('agents-count').hidden,false);
  app.setSidebarSection('agents',true);await settle();assert.equal(f.byId('agents-count').textContent,'4');assert.equal(f.byId('agents-count').hidden,false);
  assert.equal(openRow(`agent:${identity}`).querySelector('.conversation-state')?.textContent,'Blocked');
  const state=agentControl('composer').querySelector('.composer-state');assert.ok(state);let scrolled=false;state.scrollIntoView=()=>{scrolled=true;};
  openRow(`agent:${identity}`).click();await settle();assert.equal(scrolled,true);
  const current=app.state.agentEpochs.get(identity);assert.ok(current);f.event('agent.frame',{identity,connectionEpoch:current,frame:{...frame({busy:true}),revision:2}});await settle();
  assert.equal(openRow(`agent:${identity}`).querySelector('.conversation-state')?.textContent,'Working');assert.equal(f.byId('agents-count').textContent,'4');
});

test('an agent connection error uses Not reachable rather than catalog prose',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let attempts=0;globalThis.fetch=async(path,init)=>{if(new URL(String(path),'http://ui.test').pathname.endsWith('/targets')&&init?.method==='POST'){attempts++;throw new Error('Connection refused');}return original(path,init);};
  const identity='unreachable-agent',target={kind:'agent' as const,identity},primary=primaryFixture({epoch:9103,activity:'idle'});
  await arrive({workspace:{id:'attention-unreachable',revision:1,primaryKey:primary.key,selectedTarget:target,conversationLayout:singlePane([{kind:'primary'},target],`agent:${identity}`)},primaries:[primary],roster:[agentFixture(identity)]});
  await app.selectAgent(agentFixture(identity));await settle();assert.ok(attempts>0);
  assert.equal(openRow(`agent:${identity}`).querySelector('.conversation-state')?.textContent,'Not reachable');assert.equal(tab(`agent:${identity}`).querySelector('.tab-dot')?.dataset.tone,'warning');
});
