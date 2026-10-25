import assert from 'node:assert/strict';
import test from 'node:test';
import {createFederatedService} from './federated.mts';
import type {AgentService,AgentServiceOptions,CatalogPage,CatalogRow} from './index.mts';
const row=(id:string,modifiedAt=1):CatalogRow=>({id,storageId:id,cwd:'/fixture',modifiedAt,owner:'here',state:'idle',cost:0,partial:false,claim:'live'});
function fixture(contents:Map<string,CatalogRow[]>,retained=new Map<string,CatalogRow[]>()) {
  const calls:{root:string;method:string;identity:string}[]=[];
  const factory=(options:AgentServiceOptions)=>{
    const rows=contents.get(options.store)??[];
    const snapshot=():CatalogPage=>({rows:structuredClone(rows),nextCursor:null,coverage:{complete:true,omitted:0},stale:false,scan:{state:'ready',complete:true,visited:rows.length,skipped:0,omitted:0}});
    return {available:true,catalogSnapshot:snapshot,rosterRow:(identity:string)=>rows.find(value=>value.id===identity),lookup:async(identities:string[])=>{for(const identity of identities){const found=retained.get(options.store)?.find(value=>value.id===identity);if(found&&!rows.some(value=>value.id===identity))rows.push(found);}},history:async(identity:string)=>{calls.push({root:options.store,method:'history',identity});return {};},control:async(identity:string)=>{calls.push({root:options.store,method:'control',identity});return {};},imageInputAvailable:()=>false,refresh:async()=>snapshot().scan,close:async()=>{}} as unknown as AgentService;
  };
  const service=createFederatedService({store:'/ordinary',stateDir:'/state',installationId:'fixture'},factory);service.addStore('/managed','/sealed/retained-read.ts');
  return {service,calls};
}
test('the combined catalogue reports every row omitted by its aggregate bound',()=>{
  const a=Array.from({length:1100},(_,index)=>row(`ordinary-${index}`,index));
  const b=Array.from({length:1100},(_,index)=>row(`managed-${index}`,index));
  const {service}=fixture(new Map([['/ordinary',a],['/managed',b]]));
  const first=service.roster({limit:100});assert.equal(first.coverage.omitted,152);assert.equal(first.coverage.complete,false);assert.equal(first.scan.complete,false);assert.equal(first.scan.omitted,152);
  let cursor=first.nextCursor,total=first.rows.length;while(cursor){const page=service.roster({limit:100,cursor});total+=page.rows.length;cursor=page.nextCursor;assert.equal(page.coverage.omitted,152);}assert.equal(total,2048);
});
test('uncached managed identities resolve within their exact native root before a read or control',async()=>{
  const {service,calls}=fixture(new Map([['/ordinary',[]],['/managed',[]]]),new Map([['/managed',[row('managed-id')]]]));
  assert.equal(service.rosterRow('managed-id'),undefined);
  await service.history('managed-id');await service.control('managed-id','reset',{});
  assert.deepEqual(calls,[{root:'/managed',method:'history',identity:'managed-id'},{root:'/managed',method:'control',identity:'managed-id'}]);
});
test('unknown identities never route to the ordinary root',async()=>{
  const {service,calls}=fixture(new Map([['/ordinary',[]],['/managed',[]]]));
  await assert.rejects(service.history('unknown'),/exact agent root is unknown/);
  await assert.rejects(service.control('unknown','reset',{}),/exact agent root is unknown/);assert.deepEqual(calls,[]);
});
test('the combined catalogue refuses duplicate native identities instead of choosing a root',()=>{
  const {service}=fixture(new Map([['/ordinary',[row('duplicate')]],['/managed',[row('duplicate')]]]));
  assert.throws(()=>service.roster(),/two native roots/);assert.throws(()=>service.rosterRow('duplicate'),/two native roots/);
});
