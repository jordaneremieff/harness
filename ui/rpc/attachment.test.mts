import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,realpath,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrimarySession} from './session.mts';
import type {PrimaryTransport} from './transport.mts';
import type {RpcClientOptions,RpcRecord} from './client.mts';
import type {OwnerBaseline,OwnerDescriptor,OwnerEvent} from '../shared/owner.ts';
const descriptor:OwnerDescriptor={key:'primary',epoch:1,cwd:process.cwd(),executable:'pi',recoveryWorkspaceId:'workspace',pid:123,exited:false,available:true,synchronized:true,sequence:8,stderr:'',recoveryPending:false};
const raw=(seq:number,record:RpcRecord,at=Date.now()):OwnerEvent=>({seq,at,record:record as never});
const message={role:'assistant',timestamp:17,content:[],model:'fixture',provider:'fixture',stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
class Transport implements PrimaryTransport {
  child={pid:123};exited=false;available=true;stderrTail='';pendingCount=0;synchronized=true;writes:string[]=[];detached=false;closed=false;
  sessionFile?:string;
  baseline:OwnerBaseline;callbacks:Pick<RpcClientOptions,'onEvent'|'onExit'|'onProtocolError'>={};entries:unknown={entries:[],leafId:null};
  constructor(baseline:OwnerBaseline){this.baseline=baseline;}
  start(){}markSynchronized(){this.synchronized=true;}
  async request(type:string){this.writes.push(type);switch(type){case'get_state':return{sessionId:'fixture',sessionFile:this.sessionFile,isStreaming:true,isCompacting:false,pendingMessageCount:0};case'get_commands':return{commands:[]};case'get_available_models':return{models:[]};case'get_available_thinking_levels':return{levels:[]};case'get_entries':return this.entries;case'get_session_stats':return{tokens:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},cost:0};default:return{};}}
  async requestPrepared():Promise<unknown>{throw Error('Not part of attachment.');}async sendUI(){this.writes.push('extension_ui_response');}
  async close(){this.closed=true;this.exited=true;this.callbacks.onExit?.();}async detach(){this.detached=true;}
  async captureBegin(){return{token:'capture',from:this.baseline.from};}async captureFinish(){return this.baseline;}async captureAck(){this.callbacks.onEvent?.({type:'message_update',__ownerSequence:9,assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' suffix'}});}
}
function baseline():OwnerBaseline {
  return{descriptor,from:1,cursor:8,complete:true,reasons:[],overlap:[],activeMessage:{startSequence:2,complete:true,events:[raw(2,{type:'message_start',message}),raw(3,{type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}}),raw(4,{type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'before replace'}})]},tools:[],state:[],dialogs:[]};
}
async function attach(transport:Transport,sessionFile?:string){const session=new PrimarySession({key:'primary',cwd:process.cwd(),executable:'pi',sessionFile,attach:true,ownerIdentity:'owner:primary:1',transport:callbacks=>{transport.callbacks=callbacks;return transport;},publish:()=>{}});await session.start();return session;}
test('raw wire delta tape rebuilds an active message with stable identity and reduces the post-capture suffix once',async()=> {
  const first=new Transport(baseline()),session=await attach(first);
  assert.equal(session.view.pid,123);assert.equal(session.messages.length,1);assert.equal(session.messages[0]?.id,'live:owner:primary:1:2');assert.equal(session.messages[0]?.state,'partial');
  assert.deepEqual(session.messages[0]?.parts,[{type:'text',text:'before replace suffix'}]);
  const second=await attach(new Transport(baseline()));assert.equal(second.messages[0]?.id,session.messages[0]?.id);
  await session.detach();await second.detach();assert.equal(first.closed,false);assert.equal(first.detached,true);assert.ok(!first.writes.includes('abort'));assert.ok(!first.writes.includes('clear_queue'));
});
test('reattachment uses the owned Pi when its allocated session path has no file yet',async context=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-attach-unpersisted-')));context.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'allocated.jsonl'),b=baseline();b.descriptor={...descriptor,sessionFile:path};
  const transport=new Transport(b);transport.sessionFile=path;const session=await attach(transport,path);context.after(()=>session.detach());
  assert.equal(session.view.lifecycle,'ready');assert.equal(session.view.pid,123);assert.equal(session.view.sessionFile,path);await assert.rejects(()=>access(path),{code:'ENOENT'});assert.ok(!transport.writes.includes('new_session'));
});
test('capture overlap upserts exact committed messages and tool slots preserve the supplied partial',async()=> {
  const b=baseline(),final={...message,content:[{type:'text',text:'committed'}]};b.activeMessage=null;b.overlap=[raw(3,{type:'message_start',message}),raw(4,{type:'message_end',message:final})];b.tools=[{callId:'call',start:raw(5,{type:'tool_execution_start',toolCallId:'call',toolName:'fixture',args:{}}),latest:raw(6,{type:'tool_execution_update',toolCallId:'call',toolName:'fixture',partialResult:{content:[{type:'text',text:'supplied'}],details:{}}})}];
  const transport=new Transport(b);transport.captureAck=async()=>{};transport.entries={entries:[{id:'entry',parentId:null,type:'message',message:final}],leafId:'entry'};
  const session=await attach(transport);assert.equal(session.messages.filter(v=>v.role==='assistant').length,1);assert.match(JSON.stringify(session.messages.find(v=>v.role==='toolResult')?.parts),/supplied/);await session.detach();
});
test('a message that ends after history read keeps its pre-capture start identity and joins its native entry once',async()=> {
  const b=baseline(),final={...message,content:[{type:'text',text:'ended during attach'}]};b.activeMessage=null;
  b.overlap=[{...raw(4,{type:'message_end',message:final}),messageStartSequence:2},raw(5,{type:'entry_appended',entry:{id:'native',parentId:null,type:'message',message:final}})];
  const transport=new Transport(b);transport.captureAck=async()=>{};const session=await attach(transport);
  assert.equal(session.messages.length,1);assert.equal(session.messages[0]?.id,'live:owner:primary:1:2');assert.equal(session.entries[0]?.id,'native');await session.detach();
});
test('dialog restoration keeps the original deadline and timeout zero stays unanswered until explicit response',async context=> {
  const b=baseline(),at=Date.now()-10000;b.activeMessage=null;b.dialogs=[{event:raw(1,{type:'extension_ui_request',id:'timed',method:'input',title:'Timed',timeout:20000},at),expiresAt:at+20000},{event:raw(2,{type:'extension_ui_request',id:'zero',method:'confirm',title:'No timer',timeout:0},at)}];
  const transport=new Transport(b);transport.captureAck=async()=>{};const session=await attach(transport);context.after(()=>session.detach());
  assert.equal(session.view.pendingDialogs.find(v=>v.id==='timed')?.deadline,new Date(at+20000).toISOString());assert.equal(session.view.pendingDialogs.find(v=>v.id==='zero')?.deadline,undefined);
  assert.equal(session.view.pendingDialogs.length,2);await session.respond('zero',{epoch:1,confirmed:true});assert.equal(transport.writes.filter(v=>v==='extension_ui_response').length,1);
});
test('incomplete active tape stays explicit and blocks a planned release without aborting Pi',async()=> {
  const b=baseline();b.complete=false;b.reasons=['active-message-limit'];if(b.activeMessage)b.activeMessage.complete=false;
  const transport=new Transport(b);transport.captureAck=async()=>{};const session=await attach(transport);
  assert.equal(session.coverage.complete,false);assert.equal(session.view.capabilities.input,false);assert.equal(session.view.capabilities.control,true);assert.equal(session.messages.length,0);await assert.rejects(()=>session.prepareDetach(),/cannot reconstruct/);assert.ok(!transport.writes.includes('abort'));await session.detach();
});
