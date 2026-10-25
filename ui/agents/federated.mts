import {createAgentService, type AgentService, type AgentServiceOptions, type CatalogPage, type CatalogRow, type CatalogScan} from './index.mts';
import {compareRosterRows} from './catalog-state.mts';
import {AgentError} from './client.mts';

export type FederatedAgents = Omit<AgentService,'catalogSnapshot'> & {addStore(store:string,readerPath?:string):void};
function offsetOf(cursor:string|undefined,revision:number):number {
  if(!cursor)return 0;
  const match=/^(\d+):(\d+)$/.exec(Buffer.from(cursor,'base64url').toString());
  if(!match||Number(match[1])!==revision)throw new AgentError('stale_cursor','The catalogue changed. Refresh it.');
  return Number(match[2]);
}
function combineRows(pages:CatalogPage[]):{rows:CatalogRow[];omitted:number} {
  const rows=new Map<string,CatalogRow>();
  for(const page of pages)for(const row of page.rows){
    if(rows.has(row.id))throw new AgentError('identity_conflict','An agent identity appears in two native roots.');
    rows.set(row.id,row);
  }
  const sorted=[...rows.values()].sort(compareRosterRows),retained:CatalogRow[]=[];let bytes=2048;
  for(const row of sorted){const size=Buffer.byteLength(JSON.stringify(row));if(retained.length===2048||bytes+size>8*1024*1024)break;retained.push(row);bytes+=size;}
  return {rows:retained,omitted:sorted.length-retained.length};
}
function scanState(pages:CatalogPage[]):CatalogScan['state'] {
  if(pages.some(page=>page.scan.state==='failed'))return 'failed';
  if(pages.some(page=>page.scan.state==='running'))return 'running';
  return pages.every(page=>page.scan.state==='ready')?'ready':'not-started';
}
function combineScan(pages:CatalogPage[],omitted:number):CatalogScan {
  const error=pages.find(page=>page.scan.error)?.scan.error;
  return {state:scanState(pages),complete:omitted===0&&pages.every(page=>page.scan.complete&&page.coverage.complete),
    visited:pages.reduce((n,page)=>n+page.scan.visited,0),skipped:pages.reduce((n,page)=>n+page.scan.skipped,0),
    omitted:omitted+pages.reduce((n,page)=>n+Math.max(page.scan.omitted,page.coverage.omitted),0),...(error?{error}:{})};
}
function displayPage(rows:CatalogRow[],offset:number,limit:number):CatalogRow[] {
  const selected:CatalogRow[]=[];let bytes=2048;
  for(const row of rows.slice(offset,offset+limit)){const size=Buffer.byteLength(JSON.stringify(row));if(bytes+size>256*1024)break;selected.push(row);bytes+=size;}
  return selected;
}
/** Native roots retain separate readers and execution links. Only bounded display rows are combined. */
export function createFederatedService(options:AgentServiceOptions,factory=createAgentService):FederatedAgents {
  const services=new Map<string,AgentService>();let revision=0;
  const roster=(paging:{cursor?:string;limit?:number}={}):CatalogPage=>{
    const limit=paging.limit??20;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new AgentError('invalid_request','Invalid catalogue page size.');
    const offset=offsetOf(paging.cursor,revision),pages=[...services.values()].map(service=>service.catalogSnapshot());
    const combined=combineRows(pages),scan=combineScan(pages,combined.omitted),rows=displayPage(combined.rows,offset,limit);
    const next=offset+rows.length,nextCursor=next<combined.rows.length?Buffer.from(`${revision}:${next}`).toString('base64url'):null;
    return {rows,nextCursor,coverage:{complete:scan.complete&&!nextCursor,omitted:scan.omitted},scan,stale:combined.omitted>0||pages.some(page=>page.stale)};
  };
  const addStore=(store:string,readerPath?:string)=>{
    if(services.has(store))return;
    if(services.size>=32)throw new AgentError('capacity','The native-root reader capacity is full.');
    const service=factory({...options,store,...(readerPath?{readerPath}:{}),onRoster:page=>{revision++;options.onRoster?.({...roster({limit:100}),changed:page.changed??page.rows,removed:page.removed});}});
    services.set(store,service);
  };
  addStore(options.store);
  const find=(identity:string)=>{
    const storageId=identity.split(':')[0];
    const found=[...services.values()].filter(service=>service.rosterRow(identity)||service.rosterRow(storageId));
    if(found.length>1)throw new AgentError('identity_conflict','An agent identity appears in two native roots.');
    return found[0];
  };
  const resolve=async(identity:string)=>{
    const prior=find(identity);if(prior)return prior;
    await Promise.all([...services.values()].map(service=>service.lookup([identity])));
    const selected=find(identity);
    if(!selected)throw new AgentError('host_unavailable','The exact agent root is unknown. Refresh managed native roots before retry.');
    return selected;
  };
  const identityMethods=new Set(['prepare','history','image','inspect','inventory','command','threads','thread','submit','retrySubmit','abort','configure','control']);
  const object={addStore,roster,rosterRow:(identity:string)=>find(identity)?.rosterRow(identity),imageInputAvailable:(identity:string)=>find(identity)?.imageInputAvailable(identity)??false,
    lookup:async(identities:string[])=>{await Promise.all([...services.values()].map(service=>service.lookup(identities)));},
    refresh:async(scanId?:string)=>{await Promise.all([...services.values()].map(service=>service.refresh(scanId)));return roster().scan;},
    close:async()=>{await Promise.all([...services.values()].map(service=>service.close()));},
    disconnectWorkspace:async(workspace:string)=>{await Promise.all([...services.values()].map(service=>service.disconnectWorkspace(workspace)));},
    select:async(workspace:string,identity?:string)=>{if(identity)return (await resolve(identity)).select(workspace,identity);await Promise.all([...services.values()].map(service=>service.select(workspace)));},
    hide:async(workspace:string,identity?:string)=>{await Promise.all([...services.values()].map(service=>service.hide(workspace,identity)));},
    reconnect:async(workspace:string,identity:string)=>(await resolve(identity)).reconnect(workspace,identity)};
  return new Proxy(object,{get(target,key){
    if(key==='available')return [...services.values()].every(service=>service.available);
    if(typeof key==='string'&&identityMethods.has(key))return async(identity:string,...args:unknown[])=>{
      const service=await resolve(identity);
      return (service[key as keyof AgentService] as (...values:unknown[])=>unknown).call(service,identity,...args);
    };
    return Reflect.get(target,key);
  }}) as unknown as FederatedAgents;
}
