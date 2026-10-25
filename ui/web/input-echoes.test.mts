import assert from 'node:assert/strict';
import test from 'node:test';
import {InputEchoes} from './input-echoes.ts';
import type {EntryView, OperationView} from '../shared/api.ts';

test('captured input appears before dispatch and native confirmation replaces the echo once',()=>{
  const echoes=new InputEchoes(),target={kind:'agent' as const,identity:'dev'};
  echoes.capture('workspace',{operationId:'one',target,text:'hello',mode:'followUp',images:[],draftRevision:1,edit:1},[]);
  const pending=echoes.entries('workspace',target,[]);
  assert.equal(pending[0]?.messages?.[0]?.state,'partial');
  assert.deepEqual(pending[0]?.messages?.[0]?.parts,[{type:'text',text:'hello'}]);
  echoes.settle({id:'one',kind:'agent.input',target,state:'accepted',createdAt:'',updatedAt:''});
  const native:EntryView={id:'native',kind:'pi.user',messages:[{id:'message',role:'user',timestamp:Date.now(),parts:[{type:'text',text:'hello'}],state:'final',coverage:{complete:true,truncated:false,omitted:0}}]};
  assert.deepEqual(echoes.entries('workspace',target,[native]),[native]);
  assert.deepEqual(echoes.entries('workspace',target,[native]),[native]);
});
test('application user messages do not consume an identical operator input copy',()=>{
  const echoes=new InputEchoes(),target={kind:'agent' as const,identity:'dev'};
  echoes.capture('workspace',{operationId:'one',target,text:'hello',mode:'followUp',images:[],draftRevision:1,edit:1},[]);
  const application:EntryView={id:'application',kind:'app.request',messages:[{id:'message',role:'user',timestamp:Date.now(),parts:[{type:'text',text:'hello'}],state:'final',coverage:{complete:true,truncated:false,omitted:0}}]};
  assert.equal(echoes.entries('workspace',target,[application]).length,2);
  echoes.settle({id:'one',kind:'agent.input',target,state:'accepted',createdAt:'',updatedAt:''});
  assert.equal(echoes.entries('workspace',target,[application]).length,2);
  const operator:EntryView={...application,id:'operator',kind:'pi.user'};
  assert.deepEqual(echoes.entries('workspace',target,[application,operator]),[application,operator]);
});
test('queued acceptance survives a late HTTP failure and stale reconnect records without a second copy',()=>{
  const echoes=new InputEchoes(),target={kind:'primary' as const,key:'p',epoch:1};
  echoes.capture('workspace',{operationId:'queued',target,text:'hello',mode:'steer',images:[],draftRevision:1,edit:1},[]);
  const accepted:OperationView={id:'queued',kind:'primary.input',target,state:'accepted',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:01Z',receipt:{kind:'rpc',disposition:'queued'}};
  echoes.settle(accepted);echoes.failed('queued',true);echoes.failed('queued',false);
  for(const state of ['reserved','dispatched','uncertain'] as const)echoes.settle({...accepted,state,updatedAt:'2026-01-01T00:00:02Z'});
  const copies=echoes.entries('workspace',target,[]);assert.equal(copies.length,1);assert.equal(copies[0]?.messages?.[0]?.error,undefined);
  assert.deepEqual(copies[0]?.data?.value,{delivery:'Sent'});
  const native:EntryView={id:'native',kind:'message',messages:[{id:'m',role:'user',timestamp:Date.now(),parts:[{type:'text',text:'hello'}],state:'final',coverage:{complete:true,truncated:false,omitted:0}}]};
  assert.deepEqual(echoes.entries('workspace',target,[native]),[native]);echoes.failed('queued',true);assert.deepEqual(echoes.entries('workspace',target,[native]),[native]);
});
test('provisional or wrong-target events never establish input acceptance',()=>{
  const echoes=new InputEchoes(),target={kind:'primary' as const,key:'p',epoch:1};
  echoes.capture('workspace',{operationId:'one',target,text:'hello',mode:'prompt',images:[],draftRevision:1,edit:1},[]);
  for(const state of ['reserved','dispatched'] as const)echoes.settle({id:'one',kind:'primary.input',target,state,createdAt:'',updatedAt:''});
  echoes.settle({id:'one',kind:'primary.input',target:{...target,epoch:2},state:'accepted',createdAt:'',updatedAt:''});
  assert.equal(echoes.entries('workspace',target,[])[0]?.messages?.[0]?.state,'partial');
  echoes.failed('one',true);assert.equal(echoes.entries('workspace',target,[])[0]?.messages?.[0]?.error,'Delivery not confirmed');
  echoes.settle({id:'one',kind:'primary.input',target,state:'accepted',createdAt:'',updatedAt:''});
  assert.equal(echoes.entries('workspace',target,[])[0]?.messages?.[0]?.error,undefined);
});
test('a settled command with no native message keeps its time order before its notice and later messages',()=>{
  const echoes=new InputEchoes(),target={kind:'primary' as const,key:'p',epoch:1};
  const base:EntryView={id:'earlier',kind:'message',messages:[{id:'m0',role:'assistant',timestamp:Date.now()-5000,parts:[{type:'text',text:'before'}],state:'final',coverage:{complete:true,truncated:false,omitted:0}}]};
  echoes.capture('workspace',{operationId:'cmd',target,text:'/approval-probe',mode:'prompt',images:[],draftRevision:1,edit:1},[base]);
  const message=(id:string,role:'custom'|'user',offset:number):EntryView=>({id,kind:'message',messages:[{id:`${id}-m`,role,timestamp:Date.now()+offset,parts:[{type:'text',text:id}],state:'final',coverage:{complete:true,truncated:false,omitted:0}}]});
  const ids=(entries:EntryView[])=>entries.map(entry=>entry.id.startsWith('ui-input:')?'command':entry.id);
  assert.deepEqual(ids(echoes.entries('workspace',target,[base])),['earlier','command'],'an unsettled command stays last');
  echoes.settle({id:'cmd',kind:'primary.input',target,state:'accepted',createdAt:'',updatedAt:''});
  assert.deepEqual(ids(echoes.entries('workspace',target,[base])),['earlier','command'],'a finished command with nothing after it stays last');
  const notice=message('notice','custom',50),later=message('later','user',500);
  assert.deepEqual(ids(echoes.entries('workspace',target,[base,notice])),['earlier','command','notice']);
  assert.deepEqual(ids(echoes.entries('workspace',target,[base,notice,later])),['earlier','command','notice','later']);
});
