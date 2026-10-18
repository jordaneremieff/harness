import assert from 'node:assert/strict';
import test from 'node:test';
import {InputEchoes} from './input-echoes.ts';
import type {EntryView} from '../shared/api.ts';

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
