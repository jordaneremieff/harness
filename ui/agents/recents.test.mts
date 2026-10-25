import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {AgentCatalog} from './catalog.mts';
import type {RecentActivity} from '../../extensions/agent/recents.ts';
const id='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const stamp='2026-10-20T00:00:00.000Z';
function deferred(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};}
async function fixture(t:test.TestContext){
  const store=await mkdtemp(join(tmpdir(),'ui-recents-cache-')),root=join(store,'durable');await mkdir(root);
  t.after(()=>rm(store,{recursive:true,force:true}));
  const row=(storageId:string)=>({id:storageId,storageId,cwd:'/project',modifiedAt:999,owner:'here',state:'idle',cost:0,partial:false});
  const record=(storageId:string,ownerId:string)=>({storageId,ownerId,cwd:'/project',agentDir:'/agent',packageDir:'/pi',storagePath:join(root,`${storageId}.sqlite`),model:{provider:'fixture',modelId:'fixture'},thinkingLevel:'high',createdAt:stamp,view:{updatedAt:stamp,rows:[row(storageId),{...row(storageId),id:`${storageId}:2`}],coverage:{complete:true,omitted:0}}});
  const operator=record(id,`operator:${'a'.repeat(64)}`),unknown=record(other,id);
  await Promise.all([writeFile(join(root,`${id}.json`),JSON.stringify(operator)),writeFile(join(root,`${other}.json`),JSON.stringify(unknown))]);
  return{store,root,operator};
}
test('one batch per storage enriches operator children and preserves all row facts across cached reads', {timeout:5000},async t=>{
  const f=await fixture(t),ready=deferred(),reads:{identity:string;conversationIds:number[]}[]=[];
  const catalog=new AgentCatalog({store:f.store,readRecents:async(identity,conversationIds)=>{
    reads.push({identity,conversationIds});return {items:conversationIds.map(conversationId=>{
      const activity:RecentActivity=identity===id?(conversationId===1?{creator:'operator',createdAt:100,lastUserAt:200,lastAnswerAt:300,hasMessages:true}:{creator:'agent'}):(conversationId===1?{creator:'unknown'}:{creator:'operator',lastUserAt:350,lastAnswerAt:400,hasMessages:true});
      return {conversationId,activity};
    })};
  },onChange:page=>{if(page.changed?.some(row=>row.id===`${other}:2`&&row.recents?.lastAnswerAt===400))ready.resolve();}});t.after(()=>catalog.close());
  await catalog.refresh();await ready.promise;
  const rows=catalog.page({limit:100}).rows;
  assert.deepEqual(reads,[{identity:id,conversationIds:[1,2]},{identity:other,conversationIds:[1,2]}]);
  assert.deepEqual(rows.find(row=>row.id===id)?.recents,{creator:'operator',createdAt:100,lastUserAt:200,lastAnswerAt:300,hasMessages:true});
  assert.equal(rows.find(row=>row.id===`${id}:2`)?.recents?.creator,'agent');
  assert.equal(rows.find(row=>row.id===other)?.recents?.creator,'unknown');assert.equal(rows.find(row=>row.id===`${other}:2`)?.recents?.creator,'operator');
  for(let n=0;n<10;n++)catalog.page({limit:100});assert.equal(reads.length,2);
  f.operator.view.updatedAt='2026-10-21T00:00:00.000Z';await writeFile(join(f.root,`${id}.json`),JSON.stringify(f.operator));await catalog.refresh();
  assert.equal(reads.length,2,'publication bursts respect the retained-read throttle');
  assert.equal(catalog.page({limit:100}).rows.find(row=>row.id===id)?.recents?.lastAnswerAt,300);
  assert.equal(catalog.page({limit:100}).rows.find(row=>row.id===`${id}:2`)?.recents?.creator,'agent');
});
test('pending batch reads do not block refresh or ordinary list access',{timeout:5000},async t=>{
  const f=await fixture(t),release=deferred();let reads=0;
  const catalog=new AgentCatalog({store:f.store,readRecents:async(_identity,conversationIds)=>{reads++;await release.promise;return {items:conversationIds.map(conversationId=>({conversationId,activity:{creator:'unknown' as const}}))};}});t.after(()=>catalog.close());
  await catalog.refresh();assert.equal(catalog.page({limit:100}).scan.state,'ready');assert.equal(catalog.page({limit:100}).rows.length,4);assert.equal(reads,2);release.resolve();
});
test('reader errors leave the catalogue available and do not retry on paints', {timeout:5000},async t=>{
  const f=await fixture(t),attempted=deferred();let reads=0;
  const catalog=new AgentCatalog({store:f.store,readRecents:async()=>{reads++;attempted.resolve();throw Error('Reader unavailable');}});t.after(()=>catalog.close());
  await catalog.refresh();await attempted.promise;
  for(let n=0;n<10;n++)assert.equal(catalog.page({limit:100}).scan.state,'ready');
  assert.equal(reads,2);assert.equal(catalog.page({limit:100}).rows.length,4);
});
