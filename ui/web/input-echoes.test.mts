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
