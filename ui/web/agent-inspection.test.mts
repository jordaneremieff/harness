import assert from 'node:assert/strict';
import test from 'node:test';
import type {ActivityInspection, AgentInspectionView, InspectRequest, InspectionCheckpoint} from '../shared/inspection.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {AgentInspection} from './agent-inspection.ts';
const {settle}=await createAppFixture();
const identity='00000000-0000-4000-8000-000000000001:2';
function activity():ActivityInspection{return {view:'activity',identity,readAt:'now',entries:[{id:7,kind:'assistant',source:'assistant',text:{text:'Readable worker answer',shortened:false,protected:false},truncated:false,calls:[],callsOmitted:0,tools:[]}],nextCursor:null,coverage:{complete:false,scannedEntries:22,scannedBytes:65536,omittedEntries:13,entryLimitReached:false,scanByteLimitReached:true,byteLimitReached:true,metadataTruncated:false},displayOmitted:0,detail:{text:'Native bounded digest',shortened:false,protected:false},metadata:{live:false,owner:'unavailable',operation:null,pending:null,runningTools:[],runningToolsOmitted:0}};}
function fixture(read:(input:InspectRequest,signal:AbortSignal)=>Promise<AgentInspectionView>=async()=>activity(),restore?:InspectionCheckpoint){
  const calls:InspectRequest[]=[];let saved:InspectionCheckpoint|null=restore??null,changed=0;
  const inspection=new AgentInspection(identity,{read:async(input,signal)=>{calls.push(input);return read(input,signal);},current:()=>true,changed:()=>{changed++;},restore:()=>saved,save:value=>{saved=value;}});
  return {inspection,calls,get saved(){return saved;},get changed(){return changed;}};
}
function click(owner:AgentInspection,label:string){const target=(owner.node as unknown as HostNode).querySelectorAll('button').find(node=>node.textContent===label);assert.ok(target,label);target.click();}
test('retained activity is readable, persistent and explicit about omissions without a fake continuation',async()=>{
  const f=fixture();f.inspection.open('activity');f.inspection.visibility(true);await settle();
  assert.equal(f.calls.length,1);assert.match(f.inspection.node.textContent??'',/Readable worker answer/);assert.match(f.inspection.node.textContent??'',/13 native entries omitted/);assert.match(f.inspection.node.textContent??'',/No continuation supplied/);assert(!f.inspection.node.textContent?.includes('More activity'));
  f.inspection.scroller.scrollTop=71;(f.inspection.scroller as unknown as HostNode).dispatch('scroll');(f.inspection.scroller as unknown as HostNode).dispatch('scrollend');f.inspection.visibility(false);f.inspection.visibility(true);assert.equal(f.inspection.scroller.scrollTop,71);assert.equal(f.saved?.scrollTop,71);f.inspection.destroy();
});
test('activity renders call-only summaries and separates display omissions from complete native coverage',async()=>{
  const value=activity();value.coverage={...value.coverage,complete:true,omittedEntries:0,scanByteLimitReached:false,byteLimitReached:false};
  value.metadata.runningTools=Array.from({length:16},(_,index)=>({name:`tool-${index}`,toolCallId:`call-${index}`}));value.metadata.runningToolsOmitted=1;
  value.entries=[{id:7,kind:'assistant',source:'assistant',text:{text:'',shortened:false,protected:false},truncated:false,calls:[{name:{text:'read',shortened:false,protected:false},arguments:{text:'{"path":"fixture.ts"}',shortened:false,protected:false},truncated:false}],callsOmitted:0,tools:[]}];
  const f=fixture(async()=>value);f.inspection.open('activity');f.inspection.visibility(true);await settle();const shown=f.inspection.node.textContent??'';
  assert.match(shown,/1 running tool omitted from display/);assert.match(shown,/read/);assert.match(shown,/fixture\.ts/);assert(!shown.includes('Native tool-call summary is incomplete'));assert(!shown.includes('native entries omitted'));f.inspection.destroy();
});
test('native call truncation, browser cuts and protected call text remain visible',async()=>{
  const value=activity();value.entries=[{id:7,kind:'assistant',source:'assistant',text:{text:'',shortened:false,protected:false},truncated:false,calls:[{name:{text:'read',shortened:false,protected:false},arguments:{text:'[redacted]',shortened:true,protected:true},truncated:true}],callsOmitted:1,tools:[]}];
  const f=fixture(async()=>value);f.inspection.open('activity');f.inspection.visibility(true);await settle();const shown=f.inspection.node.textContent??'';
  for(const expected of ['Native tool-call summary is incomplete','Tool-call display shortened','Some tool-call text withheld','1 tool call omitted from display'])assert(shown.includes(expected));f.inspection.destroy();
});
test('result lookup uses all native selectors and exact entry pages follow native offsets only',async()=>{
  const f=fixture(async input=>input.view==='result'?{view:'result',identity,readAt:'now',status:'done',submissionId:3,requestId:'native-request',answerEntryId:17,answer:{text:'Final answer',shortened:true,protected:false},usage:{value:{},truncated:false}}:input.view==='exact'?{view:'exact',identity,readAt:'now',entryId:17,offset:input.offset,nextOffset:input.offset===0?12000:null,text:{text:'Protected entry page',shortened:false,protected:false},truncated:input.offset===0}:activity());
  f.inspection.open('result',{submissionId:3,requestId:'native-request'});f.inspection.visibility(true);await settle();assert.deepEqual(f.calls[0],{view:'result',submissionId:3,requestId:'native-request'});assert.match(f.inspection.node.textContent??'',/Display shortened/);
  click(f.inspection,'Exact answer entry');await settle();assert.deepEqual(f.calls.at(-1),{view:'exact',entryId:17,offset:0});click(f.inspection,'Next page');await settle();assert.deepEqual(f.calls.at(-1),{view:'exact',entryId:17,offset:12000});assert.equal(f.saved?.offset,12000);assert.match(f.inspection.node.textContent??'',/End of entry/);f.inspection.destroy();
});
test('a late response after hide or conversation return never replaces the retained read view',async()=>{
  const pending=Promise.withResolvers<AgentInspectionView>();let signal:AbortSignal|undefined;
  const f=fixture(async(_input,s)=>{signal=s;return pending.promise;});f.inspection.open('activity');f.inspection.visibility(true);await settle();assert.equal(f.inspection.busy,true);f.inspection.conversation();assert.equal(signal?.aborted,true);pending.resolve(activity());await settle();assert.equal(f.inspection.active,false);assert(!f.inspection.node.textContent?.includes('Readable worker answer'));f.inspection.destroy();
});
test('checkpoint restores query mode, native offset and scroll without storing result bodies',async()=>{
  const saved:InspectionCheckpoint={identity,mode:'exact',selector:{requestId:'native-request'},entryId:17,offset:12000,scrollTop:91};const f=fixture(async input=>({view:'exact',identity,readAt:'now',entryId:17,offset:input.view==='exact'?input.offset:0,nextOffset:null,text:{text:'Next page',shortened:false,protected:false},truncated:false}),saved);
  f.inspection.visibility(true);await settle();assert.equal(f.inspection.active,true);assert.deepEqual(f.calls,[{view:'exact',entryId:17,offset:12000}]);assert.equal(f.inspection.scroller.scrollTop,91);assert.deepEqual(f.inspection.checkpoint(),saved);assert(!JSON.stringify(f.saved).includes('Next page'));f.inspection.destroy();
});
test('live activity uses the existing bounded observation without another inspect request',async()=>{
  const f=fixture();f.inspection.open('activity');f.inspection.visibility(true);await settle();
  f.inspection.observe({revision:1,observedAt:'now',entries:[],live:[{id:'live',kind:'message',messages:[{id:'partial',role:'assistant',state:'partial',parts:[{type:'text',text:'Current worker text'},{type:'text',text:'Withheld text',redacted:true}],coverage:{complete:true,truncated:false,omitted:0}}]}],nextBefore:null,status:{busy:true},coverage:{complete:true,truncated:false,omitted:0}},true);
  assert.match(f.inspection.node.textContent??'',/Live activity: Working.*Current worker text/);assert(!f.inspection.node.textContent?.includes('Withheld text'));assert.equal(f.calls.length,1);f.inspection.destroy();
});
test('activity continuation keeps its native cursor across a checkpoint without accumulating pages',async()=>{
  const f=fixture(async input=>({...activity(),nextCursor:input.view==='activity'&&!input.cursor?{before:7}:null}));f.inspection.open('activity');f.inspection.visibility(true);await settle();click(f.inspection,'More activity');await settle();assert.deepEqual(f.calls.at(-1),{view:'activity',limit:4,cursor:{before:7}});assert.deepEqual(f.inspection.checkpoint()?.cursor,{before:7});const saved=f.inspection.checkpoint();f.inspection.destroy();
  const next=fixture(async()=>activity(),saved);next.inspection.visibility(true);await settle();assert.deepEqual(next.calls[0],{view:'activity',limit:4,cursor:{before:7}});next.inspection.destroy();
});
test('an unavailable result keeps its native reason without inventing selector IDs',async()=>{
  const f=fixture(async()=>({view:'result',identity,readAt:'now',status:'unavailable',reason:{text:'No matching retained submission',shortened:false,protected:false},usage:{value:{},truncated:false}}));f.inspection.open('result',{submissionId:3});f.inspection.visibility(true);await settle();assert.match(f.inspection.node.textContent??'',/No matching retained submission/);assert(!f.inspection.node.textContent?.includes('selectors do not match'));f.inspection.destroy();
});
test('wrong target and contradictory result selectors are explicit read failures',async()=>{
  const f=fixture(async()=>({view:'result',identity:'another',readAt:'now',status:'done',submissionId:99,usage:{value:{},truncated:false}}));f.inspection.open('result',{submissionId:3});f.inspection.visibility(true);await settle();assert.match(f.inspection.node.textContent??'',/inspection target changed/);f.inspection.destroy();
});
