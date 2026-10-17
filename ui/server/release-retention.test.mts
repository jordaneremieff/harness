import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retirementPlan} from './release-retention.mts';

test('retention frees one slot using the oldest unprotected descriptor',()=>{
  const records=Array.from({length:8},(_,index)=>({id:String(index),stagedAt:`2026-01-0${index+1}T00:00:00.000Z`}));
  assert.deepEqual(retirementPlan(records,new Set(['0','1','2','3','4'])),['5']);
  assert.deepEqual(retirementPlan(records.slice(0,7),new Set(['0'])),[]);
  assert.throws(()=>retirementPlan(records,new Set(records.map(record=>record.id))),/protected/);
});
