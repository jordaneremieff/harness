import assert from 'node:assert/strict';
import test from 'node:test';
import {operatorConversation, operatorTime, recentRowVisible, type SessionRow} from './sidebar-useful.ts';
import type {PrimaryView} from '../shared/api.ts';
const primary = (facts:Partial<PrimaryView>={}):PrimaryView=>({key:'p',epoch:1,cwd:'/project',lifecycle:'stopped',activity:'unknown',pendingDialogs:[],pendingOperationIds:[],capabilities:{},...facts});
const row=(facts:Partial<SessionRow>={}):SessionRow=>({key:'p',name:'New session',title:'New session',at:999,...facts});

test('only confirmed operator provenance admits a Durable conversation',()=>{
  assert.equal(operatorConversation(undefined),false);
  for(const creator of ['agent','unknown'] as const)assert.equal(operatorConversation({recents:{creator}}),false);
  assert.equal(operatorConversation({recents:{creator:'operator'}}),true);
});
test('empty saved and fileless primaries are selected-only, independently of lifecycle and title',()=>{
  for(const lifecycle of ['ready','failed','stopped'] as const)for(const sessionFile of [undefined,'/project/empty.jsonl']){
    const empty=row({primary:primary({lifecycle,sessionFile,hasMessages:false})});
    assert.equal(recentRowVisible(empty,undefined),false);
    assert.equal(recentRowVisible(empty,'p'),true);
    assert.equal(recentRowVisible({...empty,selected:true},undefined),true);
  }
  const saved=row({saved:{id:'s',path:'/project/empty.jsonl',project:'/project',title:'Named but empty',revision:'r',modifiedAt:'2026-10-25T00:00:00Z',size:300,hasMessages:false}});
  assert.equal(recentRowVisible(saved,undefined),false);
  assert.equal(recentRowVisible({...saved,selected:true},undefined),true);
  assert.ok(saved.saved);assert.equal(recentRowVisible({...saved,saved:{...saved.saved,hasMessages:true}},undefined),true);
});
test('selection preserves stopped and failed empty rows without changing their state or unknown activity',()=>{
  for(const lifecycle of ['stopped','failed'] as const){
    const empty=row({primary:primary({lifecycle,hasMessages:false})}),before=structuredClone(empty);
    assert.equal(recentRowVisible(empty,'p'),true);assert.equal(operatorTime(empty),0);
    assert.equal(recentRowVisible({...empty,selected:true},undefined),true);
    assert.equal(recentRowVisible(empty,'other'),false);assert.equal(recentRowVisible(empty,undefined),false);
    assert.deepEqual(empty,before);
  }
});
test('unknown historical creation stays unknown while actual messages outrank creation',()=>{
  const empty=row({primary:primary()});assert.equal(operatorTime(empty),0);assert.equal(operatorTime(empty),0);
  const active=row({primary:primary({createdAt:100,lastUserAt:200,lastAnswerAt:300})});assert.equal(operatorTime(active),300);
  assert.ok(active.primary);active.primary.lastUserAt=400;assert.equal(operatorTime(active),400);
  active.primary.createdAt=500;assert.equal(operatorTime(active),500);
  assert.equal(operatorTime(row({activityTimes:{createdAt:100,lastUserAt:200,lastAnswerAt:300}})),300);
});
