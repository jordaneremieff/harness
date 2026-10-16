import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startBackend} from './backend.mts';
import type {AgentAdapter} from './registry.mts';
import {readControlDescriptor} from './control-discovery.mts';
import {runControl} from '../cli/control.mts';
import type {ControlRequest,ControlReceipt,ControlLayout} from '../shared/control.ts';
import {workspaceTabKey,type Workspace,type WorkspaceTab} from '../shared/api.ts';

class Page extends EventEmitter {writableLength=0;onRequest?:(request:ControlRequest)=>void;writeHead(){}flushHeaders(){}write(text:string){if(text.includes('event: control.request\n'))this.onRequest?.(JSON.parse(/^data: (.+)$/m.exec(text)?.[1]??'{}').data);return true;}end(){this.emit('close');}get response(){return this as unknown as ServerResponse;}}
type Reply={status:number;body:{ok:true;data:unknown}|{ok:false;error:{code:string}}};
function data<T>(reply:Reply):T {assert.equal(reply.body.ok,true);return reply.body.data as T;}
async function fixture(t:TestContext) {
  const directory=await mkdtemp(join(tmpdir(),'ui-control-http-')),project=join(directory,'project'),stateDir=join(directory,'state');await mkdir(project);await writeFile(join(project,'notes.md'),'PRIVATE FILE CONTENT');
  const forbidden=async():Promise<never>=>{throw new Error('Input, preparation and process work are forbidden.');};
  const catalog={rows:[],nextCursor:null,coverage:{complete:true,omitted:0},stale:false,scan:{state:'ready' as const,complete:true,visited:0,skipped:0,omitted:0}};
  const agents:AgentAdapter={roster:()=>catalog,rosterRow:()=>undefined,imageInputAvailable:()=>false,refresh:async()=>catalog.scan,prepare:forbidden,select:forbidden,reconnect:forbidden,history:forbidden,image:forbidden,inspect:forbidden,submit:forbidden,retrySubmit:forbidden,abort:forbidden,configure:()=>{throw new Error('No configuration');},hide:async()=>{},disconnectWorkspace:async()=>{},close:async()=>{}};
  const app=await startBackend({cwd:project,port:0,pi:'not-executed',stateDir},{agents:()=>agents,assets:new Map([['/',{data:Buffer.from('<html><head></head><body></body></html>'),type:'text/html'}]])});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const origin=app.http.boundary.origin,descriptor=await readControlDescriptor(stateDir);
  const request=async(path:string,method='GET',body?:unknown,headers:Record<string,string>={}):Promise<Reply>=>{const response=await fetch(new URL(path,origin),{method,headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error'});return {status:response.status,body:await response.json() as Reply['body']};};
  const browser=(path:string,method='GET',body?:unknown)=>request(path,method,body);
  const agent=(path:string,method='GET',body?:unknown)=>request(path,method,body);
  const workspace=await app.registry.store.createWorkspace();
  const connect=()=>{const page=new Page();app.registry.journal.attach(page.response,workspace.id,app.registry.journal.cursor,undefined,randomUUID());return page;};
  return {...app,origin,stateDir,project,workspace,browser,agent,request,connect,descriptor};
}

test('real HTTP opens local control and preserves browser request guards and bounded intents',async t=> {
  const f=await fixture(t);assert.equal((await f.request('/api/control/layout')).status,200);assert.equal((await f.browser('/api/control/layout')).status,200);assert.equal((await f.agent('/api/bootstrap')).status,200);assert.equal((await f.request('/api/control/layout','GET',undefined,{Origin:'http://127.0.0.1:1'})).status,403);
  const layout=data<ControlLayout>(await f.agent(`/api/control/layout?workspace=${f.workspace.id}`));assert.equal(layout.workspaces[0]?.id,f.workspace.id);assert.equal(layout.workspaces[0]?.enabled,true);assert.doesNotMatch(JSON.stringify(layout),/PRIVATE|credential|draft|prompt/);
  assert.equal((await f.agent('/api/control/requests','POST',{workspaceId:f.workspace.id,intent:{action:'notice',text:'x'.repeat(17000)}})).status,413);assert.equal((await f.agent('/api/control/requests','POST',{workspaceId:f.workspace.id,intent:{action:'start',identity:'not-allowed'}})).status,400);assert.equal(f.registry.sessions.size,0);assert.deepEqual(await f.registry.operations.list(f.workspace.id),[]);
});

test('control read rate exhaustion leaves browser reads and acknowledgments admitted',async t=> {
  let now=1;t.mock.method(performance,'now',()=>now);const f=await fixture(t);
  for(let i=0;i<240;i++)assert.equal((await f.agent('/api/control/layout')).status,200,String(i));
  assert.equal((await f.agent('/api/control/layout')).status,429);
  assert.equal((await f.request('/api/control/layout','GET',undefined,{})).status,429);
  assert.equal((await f.browser(`/api/snapshot?workspace=${f.workspace.id}`)).status,200);
  assert.equal((await f.browser(`/api/control/ack?workspace=${f.workspace.id}`,'POST',{})).status,400);
  assert.equal((await f.agent('/api/control/ack','POST',{})).status,400);
  now+=3000;
  for(let i=0;i<240;i++)assert.equal((await f.browser('/api/control/ack','POST',{})).status,400,String(i));
  assert.equal((await f.browser(`/api/snapshot?workspace=${f.workspace.id}`)).status,429);
  assert.equal((await f.agent('/api/control/layout')).status,200);
});

test('a real CLI notice completes only after the addressed browser acknowledgment',async t=> {
  const f=await fixture(t),page=f.connect();let ackTask:Promise<Reply>|undefined;page.onRequest=request=>{const {requestId,bootId,workspaceId,pageId,connectionId}=request;ackTask=f.browser('/api/control/ack','POST',{requestId,bootId,workspaceId,pageId,connectionId,result:'applied',appliedRevision:request.expectedRevision});};
  const output=await runControl({stateDir:f.stateDir,workspaceId:f.workspace.id,actor:'Native test actor',intent:{action:'notice',text:'Plain notice'}});assert.equal('state'in output&&output.state,'applied');assert.ok(ackTask);assert.equal((await ackTask).status,200);
  const log=await readFile(join(f.stateDir,'lifecycle.log'),'utf8');assert.match(log,/Native test actor/);assert.doesNotMatch(log,/Plain notice|PRIVATE FILE CONTENT/);assert.equal((await f.registry.store.workspace(f.workspace.id)).revision,f.workspace.revision);
});

test('registered-root reveal uses the existing selection save and rejects unrelated fields',async t=> {
  const f=await fixture(t);const root=data<{root:{id:string}}>(await f.browser(`/api/workspaces/${f.workspace.id}/files/root`,'PUT',{path:f.project,expectedRevision:0})).root;assert.ok(root.id);
  const page=f.connect();let addressed:ControlRequest|undefined;page.onRequest=request=>{addressed=request;};
  const receipt=data<ControlReceipt>(await f.agent('/api/control/requests','POST',{workspaceId:f.workspace.id,actor:'File actor',intent:{action:'show',rootId:root.id,path:'notes.md',preview:true}}));assert.equal(receipt.state,'pending');assert.ok(addressed);const {requestId,bootId,workspaceId,pageId,connectionId}=addressed,control={requestId,bootId,workspaceId,pageId,connectionId};
  const tab:WorkspaceTab={kind:'file',rootId:root.id,path:'notes.md',view:'preview'},change={expectedRevision:f.workspace.revision,conversationLayout:{root:{kind:'pane',id:'pane-1',tabs:[tab],active:workspaceTabKey(tab)},focusedPane:'pane-1'},control};
  assert.equal((await f.browser(`/api/workspaces/${f.workspace.id}/selection`,'PUT',{...change,sidebarVisible:false})).status,400);const saved=data<Workspace>(await f.browser(`/api/workspaces/${f.workspace.id}/selection`,'PUT',change));assert.equal(Object.hasOwn(saved,'control'),false);assert.equal(data<ControlReceipt>(await f.agent(`/api/control/requests/${requestId}`)).state,'pending');
  const ack={...control,result:'applied',appliedRevision:saved.revision},ackPath=`/api/control/ack?workspace=${encodeURIComponent(workspaceId)}`;
  for(const path of ['/api/control/ack?workspace=other','/api/control/ack?workspace=',`${ackPath}&workspace=${encodeURIComponent(workspaceId)}`,`${ackPath}&unknown=1`])assert.equal((await f.browser(path,'POST',ack)).status,400);
  assert.equal(data<ControlReceipt>(await f.agent(`/api/control/requests/${requestId}`)).state,'pending');
  assert.equal((await f.browser(ackPath,'POST',{...ack,appliedRevision:saved.revision+1})).status,400);assert.equal(data<ControlReceipt>(await f.browser(ackPath,'POST',ack)).state,'applied');
  const detail=data<ControlLayout>(await f.agent(`/api/control/layout?workspace=${workspaceId}`));assert.equal(detail.workspaces[0]?.roots?.[0]?.id,root.id);assert.doesNotMatch(JSON.stringify(detail),/PRIVATE FILE CONTENT/);assert.equal(await readFile(join(f.project,'notes.md'),'utf8'),'PRIVATE FILE CONTENT');
});

test('off persists through the ordinary browser selection and blocks fresh control admission',async t=> {
  const f=await fixture(t);f.connect();const saved=data<Workspace>(await f.browser(`/api/workspaces/${f.workspace.id}/selection`,'PUT',{expectedRevision:f.workspace.revision,agentControl:false}));assert.equal(saved.agentControl,false);assert.equal((await f.agent('/api/control/requests','POST',{workspaceId:f.workspace.id,intent:{action:'notice',text:'No'}})).status,403);assert.equal(data<ControlLayout>(await f.agent('/api/control/layout')).workspaces[0]?.enabled,false);
});
