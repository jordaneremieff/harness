import assert from 'node:assert/strict';
import test from 'node:test';
import type {PrimaryView, ProjectedFrame} from '../shared/api.ts';
import {attentionCounts, conversationAttention} from './attention.ts';
const primary: PrimaryView = {key:'p',epoch:1,cwd:'/project',lifecycle:'ready',activity:'idle',pendingOperationIds:[],pendingDialogs:[],capabilities:{}};
const coverage = {complete:true,truncated:false,omitted:0};
const frame: ProjectedFrame = {revision:1,observedAt:'now',entries:[],live:[],nextBefore:null,status:{busy:false},coverage};
const providerBlock = {blockId:'block',conversationId:1,providerSessionId:'session',epoch:1,model:{provider:'fixture',modelId:'model'},error:'blocked',errorRedacted:false,errorTruncated:false,source:'provider' as const,timestamp:1,originalResults:[],omittedOriginalResults:0};
const failed: ProjectedFrame = {...frame,entries:[{id:'error',kind:'message',messages:[{id:'error',role:'assistant',state:'final',parts:[],stopReason:'error',coverage}]}]};

test('typed attention states map to explicit words and tones',()=>{
  assert.deepEqual(conversationAttention({connected:true,primary,question:true}),{label:'Question',tone:'warning'});
  assert.deepEqual(conversationAttention({connected:true,agent:{live:true,frame:{...frame,status:{busy:false,providerBlock}}}}),{label:'Blocked',tone:'warning'});
  assert.deepEqual(conversationAttention({connected:true,primary,outcome:'failed'}),{label:'Failed',tone:'error'});
  assert.deepEqual(conversationAttention({connected:true,agent:{live:true,frame:failed}}),{label:'Failed',tone:'error'});
  assert.deepEqual(conversationAttention({connected:true,agent:{live:false,connectionError:'offline'}}),{label:'Not reachable',tone:'warning'});
});
test('working, automatic retry, stopped, stored, read-only and disconnected facts do not ask for attention',()=>{
  for(const activity of ['running','retrying','compacting'] as const) assert.equal(conversationAttention({connected:true,primary:{...primary,activity},outcome:'failed'}),undefined);
  for(const lifecycle of ['stopped','failed'] as const) assert.equal(conversationAttention({connected:true,primary:{...primary,lifecycle},outcome:'failed'}),undefined);
  assert.equal(conversationAttention({connected:true,primary,outcome:'stopped'}),undefined);
  assert.equal(conversationAttention({connected:true,agent:{live:true,frame:{...failed,status:{busy:true}}}}),undefined);
  assert.equal(conversationAttention({connected:true,agent:{live:false,frame:failed}}),undefined);
  assert.equal(conversationAttention({connected:true,agent:{live:false}}),undefined);
  assert.equal(conversationAttention({connected:true}),undefined);
  assert.equal(conversationAttention({connected:false,primary,question:true}),undefined);
  assert.equal(conversationAttention({connected:false,agent:{live:false,connectionError:'offline'}}),undefined);
});
test('restart parking is blocked attention, while an expected task sleep is not a failed turn',()=>{
  assert.deepEqual(conversationAttention({connected:true,catalog:{kind:'task-blocked',reason:'restart_limit'}}),{label:'Blocked',tone:'warning',title:'A task reached its restart limit'});
  const sleeping: ProjectedFrame = {...frame,status:{busy:false,tasks:{value:[{id:7,kind:'run',status:'sleeping',background:false,abortRequested:false}],truncated:false}}};
  assert.equal(conversationAttention({connected:true,agent:{live:true,frame:sleeping}}),undefined);
});

test('collapsed heading omits zero pieces and does not count attention twice',()=>{
  const attention = {label:'Blocked',tone:'warning'} as const;
  assert.equal(attentionCounts([{attention,working:true},{working:true},{working:true}]),'1 need you · 2 working');
  assert.equal(attentionCounts([{working:true},{working:true},{working:false}]),'2 working');
  assert.equal(attentionCounts([{attention,working:false}]),'1 need you');
  assert.equal(attentionCounts([{working:false}]),'');
  assert.equal(attentionCounts([]),'');
});
