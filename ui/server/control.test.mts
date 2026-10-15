import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {readControlIntent,readControlAck,readControlProvenance,type ControlRequest,type ControlProvenance} from '../shared/control.ts';
import {workspaceTabKey,type ConversationLayout,type WorkspaceTab} from '../shared/api.ts';
import {StateStore} from './state.mts';
import {Journal} from './journal.mts';
import {Control} from './control.mts';
import {FileResponse} from './files.mts';
import type {Registry} from './registry.mts';
import {controlLayout,validateControlChange} from './control-layout.mts';

class Page extends EventEmitter {writes:string[]=[];writableLength=0;writeHead(){}flushHeaders(){}write(text:string){this.writes.push(text);return true;}end(){this.emit('close');}get response(){return this as unknown as ServerResponse;}}
const file:WorkspaceTab={kind:'file',rootId:'root',path:'keep.txt'};
const initial:ConversationLayout={root:{kind:'pane',id:'pane-1',tabs:[file],active:workspaceTabKey(file)},focusedPane:'pane-1'};
function provenance(request:ControlRequest):ControlProvenance {const {requestId,bootId,workspaceId,pageId,connectionId}=request;return {requestId,bootId,workspaceId,pageId,connectionId};}
async function fixture(t:TestContext) {
  const directory=await mkdtemp(join(tmpdir(),'ui-control-')),journal=new Journal(),store=await StateStore.open(directory,{onChange:(name,data,workspace,target)=>journal.publish(name,target,data,workspace)});
  let workspace=await store.createWorkspace();workspace=await store.updateSelection(workspace.id,{expectedRevision:workspace.revision,conversationLayout:initial});
  const jobs:string[]=[],logs:Record<string,unknown>[]=[];let logFails=false,nextLog:(()=>Promise<void>)|undefined;const primaries:{key:string;epoch:number}[]=[];
  const registry=new Proxy({store,journal,views:()=>primaries,agents:{rosterRow:(id:string)=>id==='known:agent'?{}:undefined}}, {get(target,key){if(!(key in target))throw new Error(`Execution access is forbidden: ${String(key)}`);return Reflect.get(target,key);}}) as unknown as Registry;
  const control=new Control(registry,{request:async job=> {jobs.push(job.kind);if(job.kind==='roots')return new FileResponse(JSON.stringify({ok:true,data:[{id:'root',name:'Project',path:'/project'}]}),200);assert.equal(job.kind,'text');if(job.kind==='text'&&(job.rootId!=='root'||job.path==='missing.txt'))return new FileResponse(JSON.stringify({ok:false,error:{code:'file_missing',message:'The file is unavailable.',retry:'read'}}),404);return new FileResponse(JSON.stringify({ok:true,data:{text:'PRIVATE FILE CONTENT'}}),200);}},{control:async text=>{if(logFails)throw new Error('disk');const hook=nextLog;nextLog=undefined;await hook?.();logs.push(JSON.parse(text));}});
  t.after(async()=>{await control.close();journal.close();await store.close();await rm(directory,{recursive:true,force:true});});
  const connect=(pageId='page',session='browser')=>{const page=new Page();journal.attach(page.response,workspace.id,session,journal.cursor,undefined,pageId);return page;};
  const submit=async(intent:unknown,extra:Record<string,unknown>={})=>{const cut=journal.cursor,receipt=await control.submit({workspaceId:workspace.id,actor:'Test actor',intent,...extra});const record=journal.replay(cut,workspace.id).records.find(record=>record.name==='control.request');assert.ok(record);return {receipt,request:record.envelope.data as ControlRequest};};
  return {control,store,journal,workspace,connect,submit,jobs,logs,primaries,atNextLog(hook:()=>Promise<void>){nextLog=hook;},failLog(){logFails=true;}};
}

test('closed intents and provenance reject unknown fields, unsafe paths and all execution vocabulary',()=> {
  for(const intent of [{action:'notice',text:'hello'},{action:'show',rootId:'r',path:'a.md',preview:true},{action:'split',paneId:'p',axis:'x',view:{kind:'primary'}},{action:'focus',paneId:'p'},{action:'resize',splitId:'s',ratio:20},{action:'swap',splitId:'s'}])assert.deepEqual(readControlIntent(intent),intent);
  for(const intent of [{action:'input',text:'x'},{action:'start',identity:'x'},{action:'move',paneId:'p'},{action:'notice',text:'x',html:'x'},{action:'notice',text:'x'.repeat(513)},{action:'notice',text:'bad\ntext'},{action:'show',rootId:'r',path:'../file'},{action:'show',rootId:'r',path:'/absolute'},{action:'show',rootId:'r',path:'%2e%2e/file'},{action:'focus',paneId:'p',view:{kind:'primary',key:'other'}},{action:'resize',splitId:'s',ratio:80.5},{action:'resize',splitId:'s',ratio:81}])assert.throws(()=>readControlIntent(intent));
  const id={requestId:'r',bootId:'b',workspaceId:'w',pageId:'p',connectionId:'c'};assert.deepEqual(readControlProvenance(id),id);assert.throws(()=>readControlProvenance({...id,actor:'replacement'}));assert.deepEqual(readControlAck({...id,result:'applied',appliedRevision:1}),{...id,result:'applied',appliedRevision:1});assert.throws(()=>readControlAck({...id,result:'applied',appliedRevision:1,intent:{action:'notice',text:'replacement'}}));
});

test('layout reads disclose only layout and registered metadata without target preparation',async t=> {
  const f=await fixture(t),before=f.journal.cursor;const summary=await f.control.layout();assert.equal(summary.workspaces[0]?.enabled,true);assert.equal(summary.workspaces[0]?.pages,0);assert.equal(summary.workspaces[0]?.layout,undefined);
  await assert.rejects(()=>f.control.layout(''),/workspace ID/);await assert.rejects(()=>f.control.receipt('x'.repeat(201)),/request ID/);
  const detail=await f.control.layout(f.workspace.id);assert.deepEqual(detail.workspaces[0]?.layout,initial);assert.equal(detail.workspaces[0]?.roots?.[0]?.id,'root');assert.deepEqual(f.jobs,['roots']);assert.equal(f.journal.cursor,before);assert.doesNotMatch(JSON.stringify(detail),/PRIVATE|draft|prompt|transcript|credential/);
});

test('the optional control setting persists and rejects non-boolean changes',async t=> {
  const directory=await mkdtemp(join(tmpdir(),'ui-control-setting-'));let store=await StateStore.open(directory);t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});const workspace=await store.createWorkspace();assert.equal(workspace.agentControl,undefined);const off=await store.updateSelection(workspace.id,{expectedRevision:workspace.revision,agentControl:false});await store.close();store=await StateStore.open(directory);assert.equal((await store.workspace(workspace.id)).agentControl,false);await assert.rejects(()=>store.updateSelection(workspace.id,{expectedRevision:off.revision,agentControl:'yes' as unknown as boolean}),/Invalid agent control/);assert.equal((await store.workspace(workspace.id)).revision,off.revision);
});

test('no page, multiple pages, off, stale and unknown exact targets refuse before dispatch',async t=> {
  const f=await fixture(t);await assert.rejects(()=>f.submit({action:'notice',text:'x'}),/one connected page/);const a=f.connect(),b=f.connect('second');await assert.rejects(()=>f.submit({action:'notice',text:'x'}),/one connected page/);b.emit('close');
  await assert.rejects(()=>f.submit({action:'notice',text:'x'},{expectedRevision:0}),/revision/);await assert.rejects(()=>f.submit({action:'focus',paneId:'missing'}),/pane/);await assert.rejects(()=>f.submit({action:'focus',paneId:'pane-1',view:{kind:'agent',identity:'unknown'}}),/exact agent/);await assert.rejects(()=>f.submit({action:'focus',paneId:'pane-1',view:{kind:'primary'}}),/primary/);
  const workspace=await f.store.updateSelection(f.workspace.id,{expectedRevision:f.workspace.revision,agentControl:false});await f.control.workspaceChanged(workspace);await assert.rejects(()=>f.submit({action:'notice',text:'x'}),/off/);assert.ok(a);assert.equal(f.logs.length,0);
});

test('a notice uses the original actor, a browser-only ack and no selection or execution owner',async t=> {
  const f=await fixture(t);f.connect();const {receipt,request}=await f.submit({action:'notice',text:'Keep this plain'});assert.equal(receipt.state,'pending');await assert.rejects(()=>f.control.ack({...provenance(request),result:'applied',appliedRevision:f.workspace.revision},'wrong-browser'),/connection/);
  const wait=f.control.wait(receipt.requestId);const result=await f.control.ack({...provenance(request),result:'applied',appliedRevision:f.workspace.revision},'browser');assert.equal(result.state,'applied');assert.deepEqual(await wait,result);assert.equal((await f.store.workspace(f.workspace.id)).revision,f.workspace.revision);assert.deepEqual(f.jobs,[]);assert.equal(f.logs.length,2);assert.doesNotMatch(JSON.stringify(f.logs),/Keep this plain/);assert.equal(f.logs[1]?.actor,'Test actor');
});

test('saved layout is not an application ack; only its exact revision correlates to success',async t=> {
  const f=await fixture(t);f.connect();const {receipt,request}=await f.submit({action:'show',rootId:'root',path:'notes.md',preview:true});const layout=structuredClone(initial);assert.equal(layout.root.kind,'pane');if(layout.root.kind!=='pane')return;const tab:WorkspaceTab={kind:'file',rootId:'root',path:'notes.md',view:'preview'};layout.root.tabs.push(tab);layout.root.active=workspaceTabKey(tab);
  const change={expectedRevision:f.workspace.revision,conversationLayout:layout};await assert.rejects(()=>f.control.ack({...provenance(request),result:'applied',appliedRevision:f.workspace.revision},'browser'),/intent/);
  const saved=await f.control.selection(f.workspace.id,provenance(request),'browser',change,guard=>f.store.updateSelection(f.workspace.id,change,guard));assert.equal((await f.control.receipt(receipt.requestId)).state,'pending');
  await assert.rejects(()=>f.control.ack({...provenance(request),result:'applied',appliedRevision:saved.revision+1},'browser'),/revision/);await assert.rejects(()=>f.control.ack({...provenance(request),result:'refused',refusalCode:'busy'},'browser'),/unconfirmed/);
  await f.store.updateSelection(f.workspace.id,{expectedRevision:saved.revision,sidebarVisible:true});const applied=await f.control.ack({...provenance(request),result:'applied',appliedRevision:saved.revision},'browser');assert.equal(applied.appliedRevision,saved.revision);assert.equal(applied.state,'applied');assert.deepEqual(f.jobs,['text']);
});

test('reconnect changes incarnation and invalidates old saves and acknowledgments without replay',async t=> {
  const f=await fixture(t),old=f.connect();const {request,receipt}=await f.submit({action:'notice',text:'x'});old.emit('close');f.connect();assert.notEqual(f.journal.controlPage(f.workspace.id)?.connectionId,request.connectionId);await assert.rejects(()=>f.control.ack({...provenance(request),result:'applied',appliedRevision:f.workspace.revision},'browser'),/connection/);assert.equal((await f.control.receipt(receipt.requestId)).state,'unconfirmed');assert.equal((await f.store.workspace(f.workspace.id)).revision,f.workspace.revision);
});

test('the deadline resolves a bounded waiter as unconfirmed and a late ack cannot change it',async t=> {
  const f=await fixture(t);f.connect();t.mock.timers.enable({apis:['setTimeout','Date']});const {request,receipt}=await f.submit({action:'notice',text:'x'}),wait=f.control.wait(receipt.requestId);await Promise.resolve();t.mock.timers.tick(5001);const result=await wait;assert.equal(result.state,'unconfirmed');assert.equal(result.code,'deadline');await assert.rejects(()=>f.control.ack({...provenance(request),result:'applied',appliedRevision:f.workspace.revision},'browser'),/no longer/);
});

test('off invalidates pending work; duplicate workspace admission and missing logs refuse',async t=> {
  const f=await fixture(t);f.connect();const {receipt}=await f.submit({action:'notice',text:'x'});await assert.rejects(()=>f.submit({action:'notice',text:'y'}),/already/);const workspace=await f.store.updateSelection(f.workspace.id,{expectedRevision:f.workspace.revision,agentControl:false});await f.control.workspaceChanged(workspace);assert.equal((await f.control.receipt(receipt.requestId)).code,'control_disabled');
  const enabled=await f.store.updateSelection(f.workspace.id,{expectedRevision:workspace.revision,agentControl:true});assert.ok(enabled.agentControl);f.failLog();const cut=f.journal.cursor;await assert.rejects(()=>f.submit({action:'notice',text:'z'}),/logging is unavailable/);assert.equal(f.journal.cursor,cut);
});

test('logging failure after a browser ack cannot claim an applied retained result',async t=> {
  const f=await fixture(t);f.connect();const {request}=await f.submit({action:'notice',text:'x'});f.failLog();const result=await f.control.ack({...provenance(request),result:'applied',appliedRevision:f.workspace.revision},'browser');assert.equal(result.state,'unconfirmed');assert.equal(result.code,'control_log_unavailable');
});

test('control saves recheck current revision and reject unrelated settings or target changes',async t=> {
  const f=await fixture(t);f.connect();const {request}=await f.submit({action:'focus',paneId:'pane-1'}),change={expectedRevision:f.workspace.revision,conversationLayout:initial};await assert.rejects(()=>f.control.selection(f.workspace.id,provenance(request),'browser',{...change,appearance:'light'},guard=>f.store.updateSelection(f.workspace.id,{...change,appearance:'light'},guard)),/intent/);
  await f.store.updateSelection(f.workspace.id,{expectedRevision:f.workspace.revision,sidebarVisible:true});await assert.rejects(()=>f.control.selection(f.workspace.id,provenance(request),'browser',change,guard=>f.store.updateSelection(f.workspace.id,{...change,expectedRevision:f.workspace.revision+1},guard)),/workspace changed/);
});

test('bounded mutation rate excludes receipt reads and burst exhaustion dispatches nothing further',async t=> {
  const f=await fixture(t);f.connect();for(let i=0;i<8;i++){const {request,receipt}=await f.submit({action:'notice',text:'x'});for(let j=0;j<12;j++)assert.equal((await f.control.receipt(receipt.requestId)).state,'pending');await f.control.ack({...provenance(request),result:'refused',refusalCode:'busy'},'browser');}await assert.rejects(()=>f.submit({action:'notice',text:'x'}),/rate/);
});

test('a terminal result between receipt lookup and waiter registration cannot strand the wait',async t=> {
  const f=await fixture(t);f.connect();const {request,receipt}=await f.submit({action:'notice',text:'x'}),read=f.control.receipt.bind(f.control);
  t.mock.method(f.control,'receipt',async (id:string)=>{const captured=await read(id);await f.control.ack({...provenance(request),result:'applied',appliedRevision:f.workspace.revision},'browser');return captured;});
  assert.equal((await f.control.wait(receipt.requestId)).state,'applied');
});

test('admission races produce a logged refusal without dispatch or overwritten operator state',async t=> {
  const f=await fixture(t);f.connect();f.atNextLog(async()=>{await f.store.updateSelection(f.workspace.id,{expectedRevision:f.workspace.revision,sidebarVisible:true});});const cut=f.journal.cursor;
  await assert.rejects(()=>f.submit({action:'notice',text:'x'}),/admission/);assert.deepEqual(f.logs.map(row=>row.result),['admitted','refused']);assert.equal(f.journal.replay(cut,f.workspace.id).records.some(record=>record.name==='control.request'),false);assert.equal((await f.store.workspace(f.workspace.id)).sidebarVisible,true);
});

test('empty target records remain distinct from preparation and existing drafts stay unchanged',async t=> {
  const f=await fixture(t);f.connect();const target=await f.store.target(f.workspace.id,{kind:'agent',identity:'known:agent'});assert.equal(target.draft.text,'');assert.equal(target.draft.mode,'followUp');
  await f.store.putDraft(f.workspace.id,target.targetKey,{expectedRevision:0,text:'Keep this draft',mode:'followUp'});await f.store.putReading(f.workspace.id,target.targetKey,{expectedRevision:0,anchorId:'saved-entry',offsetPx:42,followTail:false});const before=await f.store.getTarget(f.workspace.id,target.targetKey);
  const {request}=await f.submit({action:'focus',paneId:'pane-1',view:{kind:'agent',identity:'known:agent'}}),layout=structuredClone(initial);if(layout.root.kind!=='pane')return;layout.root.tabs.push({kind:'agent',identity:'known:agent'});layout.root.active='agent:known:agent';const change={expectedRevision:f.workspace.revision,conversationLayout:layout,selectedTarget:{kind:'agent' as const,identity:'known:agent'},panelVisible:true};
  const saved=await f.control.selection(f.workspace.id,provenance(request),'browser',change,guard=>f.store.updateSelection(f.workspace.id,change,guard));await f.control.ack({...provenance(request),result:'applied',appliedRevision:saved.revision},'browser');assert.deepEqual(await f.store.target(f.workspace.id,before.target),before);assert.deepEqual(f.jobs,[]);
});

test('a primary reveal binds the exact current key and epoch rather than starting a primary',async t=> {
  const f=await fixture(t);f.connect();f.primaries.push({key:'current-primary',epoch:2});await f.store.updateSelection(f.workspace.id,{expectedRevision:f.workspace.revision,primaryKey:'current-primary'});const {request}=await f.submit({action:'focus',paneId:'pane-1',view:{kind:'primary'}});assert.deepEqual(request.primary,{kind:'primary',key:'current-primary',epoch:2});f.primaries[0]={key:'current-primary',epoch:3};await assert.rejects(()=>f.control.ack({...provenance(request),result:'refused',refusalCode:'busy'},'browser'),/primary conversation changed/);
});

test('outstanding capacity and terminal retention stay bounded independently of status reads',async t=> {
  const f=await fixture(t);let clock=performance.now();t.mock.method(performance,'now',()=>clock);
  for(let i=0;i<9;i++) {const workspace=await f.store.createWorkspace(),page=new Page();f.journal.attach(page.response,workspace.id,'browser',f.journal.cursor,undefined,`page-${i}`);clock+=1000;const submit=()=>f.control.submit({workspaceId:workspace.id,intent:{action:'notice',text:'x'}});if(i===8)await assert.rejects(submit,/capacity is full/);else assert.equal((await submit()).state,'pending');}
  await f.control.close();
});

test('terminal receipts retain only the bounded newest window',async t=> {
  const f=await fixture(t);f.connect();let clock=performance.now();t.mock.method(performance,'now',()=>clock);let first='',last='';
  for(let i=0;i<66;i++){clock+=1000;const {request,receipt}=await f.submit({action:'notice',text:'x'});if(i===0)first=receipt.requestId;last=receipt.requestId;await f.control.ack({...provenance(request),result:'refused',refusalCode:'busy'},'browser');}
  await assert.rejects(()=>f.control.receipt(first),/unavailable/);assert.equal((await f.control.receipt(last)).state,'refused');
});

test('the read projection follows selected conversations but never displaces an active file',()=> {
  const target={kind:'agent' as const,identity:'known:agent'},fallback=controlLayout({id:'w',revision:1,primaryKey:'p',selectedTarget:target});assert.equal(fallback.root.kind,'pane');if(fallback.root.kind!=='pane')return;assert.deepEqual(fallback.root.tabs,[{kind:'primary'},target]);assert.equal(fallback.root.active,'agent:known:agent');
  assert.deepEqual(controlLayout({id:'w',revision:1,conversationLayout:initial,selectedTarget:target}),initial);
  const stored:ConversationLayout={root:{kind:'pane',id:'pane-1',tabs:[target],active:'agent:known:agent'},focusedPane:'pane-1'},workspace={id:'w',revision:1,primaryKey:'p',selectedTarget:{kind:'primary' as const,key:'p',epoch:1},conversationLayout:stored};const projected=controlLayout(workspace);assert.notDeepEqual(projected,stored);assert.equal(stored.root.kind==='pane'&&stored.root.tabs.length,1);assert.equal(projected.root.kind==='pane'&&projected.root.active,'primary');
});

test('layout guards refuse a new-view split from an empty source pane',()=> {
  const empty:ConversationLayout={root:{kind:'pane',id:'pane-1',tabs:[],active:null},focusedPane:'pane-1'};
  const request:ControlRequest={requestId:'r',bootId:'b',workspaceId:'w',pageId:'p',connectionId:'c',expectedRevision:1,expiresAt:Date.now()+5000,actor:'actor',intent:{action:'split',paneId:'pane-1',axis:'x',view:{kind:'agent',identity:'known:agent'}}};
  const view:WorkspaceTab={kind:'agent',identity:'known:agent'},key=workspaceTabKey(view);
  const candidates:ConversationLayout[]=[
    {focusedPane:'new-pane',root:{kind:'split',id:'new-split',axis:'x',ratio:50,first:{kind:'pane',id:'pane-1',tabs:[view],active:key},second:{kind:'pane',id:'new-pane',tabs:[],active:null}}},
    {focusedPane:'new-pane',root:{kind:'split',id:'new-split',axis:'x',ratio:50,first:empty.root,second:{kind:'pane',id:'new-pane',tabs:[view],active:key}}},
  ];
  for(const conversationLayout of candidates)assert.throws(()=>validateControlChange({id:'w',revision:1,conversationLayout:empty},request,{conversationLayout}));
});

test('layout guards preserve tabs and source activation, including property-order-independent JSON',()=> {
  const request:ControlRequest={requestId:'r',bootId:'b',workspaceId:'w',pageId:'p',connectionId:'c',expectedRevision:1,expiresAt:Date.now()+5000,actor:'actor',intent:{action:'split',paneId:'pane-1',axis:'x',view:{kind:'agent',identity:'known:agent'}}};
  const right={kind:'pane' as const,id:'new-pane',tabs:[{kind:'agent' as const,identity:'known:agent'}],active:'agent:known:agent'},layout:ConversationLayout={focusedPane:'new-pane',root:{kind:'split',id:'new-split',axis:'x',ratio:50,first:structuredClone(initial.root),second:right}};
  assert.doesNotThrow(()=>validateControlChange({id:'w',revision:1,conversationLayout:initial},request,{expectedRevision:1,conversationLayout:layout}));const lost=structuredClone(layout);if(lost.root.kind==='split'&&lost.root.first.kind==='pane')lost.root.first.tabs=[];assert.throws(()=>validateControlChange({id:'w',revision:1,conversationLayout:initial},request,{conversationLayout:lost}));
  const resized=structuredClone(layout);if(resized.root.kind==='split')resized.root.ratio=80;assert.doesNotThrow(()=>validateControlChange({id:'w',revision:1,conversationLayout:layout},{...request,intent:{action:'resize',splitId:'new-split',ratio:80}},{conversationLayout:resized}));
  const swapped=structuredClone(layout);if(swapped.root.kind==='split')[swapped.root.first,swapped.root.second]=[swapped.root.second,swapped.root.first];assert.doesNotThrow(()=>validateControlChange({id:'w',revision:1,conversationLayout:layout},{...request,intent:{action:'swap',splitId:'new-split'}},{conversationLayout:swapped}));
});
