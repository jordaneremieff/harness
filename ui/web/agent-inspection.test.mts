import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentInspectionView, InspectRequest, InspectionCheckpoint} from '../shared/inspection.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {AgentInspection} from './agent-inspection.ts';
import type {ConversationTask} from './conversation-tasks.ts';
const {settle,hostDocument,HostResizeObserver}=await createAppFixture();
const identity='00000000-0000-4000-8000-000000000001:2';
function fixture(read:(input:InspectRequest,signal:AbortSignal)=>Promise<AgentInspectionView>,restore?:InspectionCheckpoint){
  const calls:InspectRequest[]=[];let saved:InspectionCheckpoint|null=restore??null,changed=0;
  const inspection=new AgentInspection(identity,{read:async(input,signal)=>{calls.push(input);return read(input,signal);},current:()=>true,changed:()=>{changed++;},restore:()=>saved,save:value=>{saved=value;}});
  return {inspection,calls,get saved(){return saved;},get changed(){return changed;}};
}
function click(owner:AgentInspection,label:string){const target=(owner.node as unknown as HostNode).querySelectorAll('button').find(node=>node.textContent===label);assert.ok(target,label);target.click();}
test('result lookup uses all native selectors and exact entry pages follow native offsets only',async()=>{
  const f=fixture(async input=>input.view==='result'?{view:'result',identity,readAt:'now',status:'done',submissionId:3,requestId:'native-request',answerEntryId:17,answer:{text:'Final answer',shortened:true,protected:false},usage:{value:{},truncated:false}}:{view:'exact',identity,readAt:'now',entryId:17,offset:input.view==='exact'?input.offset:0,nextOffset:input.view==='exact'&&input.offset===0?12000:null,text:{text:'Protected entry page',shortened:false,protected:false},truncated:input.view==='exact'&&input.offset===0});
  f.inspection.open('result',{submissionId:3,requestId:'native-request'});f.inspection.visibility(true);await settle();assert.deepEqual(f.calls[0],{view:'result',submissionId:3,requestId:'native-request'});assert.match(f.inspection.node.textContent??'',/Only retained text is shown/);
  click(f.inspection,'Read exact answer source');await settle();assert.deepEqual(f.calls.at(-1),{view:'exact',entryId:17,offset:0});click(f.inspection,'Next page');await settle();assert.deepEqual(f.calls.at(-1),{view:'exact',entryId:17,offset:12000});assert.equal(f.saved?.offset,12000);assert.match(f.inspection.node.textContent??'',/Protected entry page/);assert.equal((f.inspection.node as unknown as HostNode).querySelectorAll('button').some(node=>node.textContent==='Next page'),false);f.inspection.destroy();
});
test('a late response after hide or conversation return never replaces the retained read view',async()=>{
  const pending=Promise.withResolvers<AgentInspectionView>();let signal:AbortSignal|undefined;
  const f=fixture(async(_input,s)=>{signal=s;return pending.promise;});f.inspection.open('result',{submissionId:3});f.inspection.visibility(true);await settle();assert.equal(f.inspection.busy,true);f.inspection.conversation();assert.equal(signal?.aborted,true);pending.resolve({view:'result',identity,readAt:'now',status:'done',submissionId:3,answer:{text:'Readable worker answer',shortened:false,protected:false},usage:{value:{},truncated:false}});await settle();assert.equal(f.inspection.active,false);assert(!f.inspection.node.textContent?.includes('Readable worker answer'));f.inspection.destroy();
});
test('checkpoint restores query mode, native offset and scroll without storing result bodies',async()=>{
  const saved:InspectionCheckpoint={identity,mode:'exact',selector:{requestId:'native-request'},entryId:17,offset:12000,scrollTop:91};const f=fixture(async input=>({view:'exact',identity,readAt:'now',entryId:17,offset:input.view==='exact'?input.offset:0,nextOffset:null,text:{text:'Next page',shortened:false,protected:false},truncated:false}),saved);
  f.inspection.visibility(true);await settle();assert.equal(f.inspection.active,true);assert.deepEqual(f.calls,[{view:'exact',entryId:17,offset:12000}]);assert.equal(f.inspection.scroller.scrollTop,91);assert.deepEqual(f.inspection.checkpoint(),saved);assert(!JSON.stringify(f.saved).includes('Next page'));f.inspection.destroy();
});
test('an unavailable result keeps its native reason without inventing selector IDs',async()=>{
  const f=fixture(async()=>({view:'result',identity,readAt:'now',status:'unavailable',reason:{text:'No matching retained submission',shortened:false,protected:false},usage:{value:{},truncated:false}}));f.inspection.open('result',{submissionId:3});f.inspection.visibility(true);await settle();assert.match(f.inspection.node.textContent??'',/No matching retained submission/);assert(!f.inspection.node.textContent?.includes('selectors do not match'));f.inspection.destroy();
});
test('wrong target and contradictory result selectors are explicit read failures',async()=>{
  const f=fixture(async()=>({view:'result',identity:'another',readAt:'now',status:'done',submissionId:99,usage:{value:{},truncated:false}}));f.inspection.open('result',{submissionId:3});f.inspection.visibility(true);await settle();assert.match(f.inspection.node.textContent??'',/answer target changed/);f.inspection.destroy();
});
for(const source of ['local','historical'] as const)test(`long ${source} task subjects retain their full input behind a compact row`,async()=>{
  const subject='Review the current task presentation. '.repeat(60),input={text:subject,complete:true,redacted:false};
  const local:ConversationTask={key:'task',entryId:'17',subject,state:'recorded',input};
  const inspection=new AgentInspection(identity,{
    read:async()=>({view:'history',identity,readAt:'now',entries:[{id:17,kind:'message',source:'user',text:{text:subject,shortened:false,protected:false},truncated:false,calls:[],callsOmitted:0,tools:[]}],nextCursor:null,detail:{text:'',shortened:false,protected:false}}),
    history:source==='historical',tasks:()=>source==='local'?[local]:[],current:()=>true,changed:()=>{},restore:()=>null,save:()=>{},
  });
  inspection.open('result');inspection.visibility(true);await settle();
  const node=inspection.node as unknown as HostNode,row=node.querySelector('.task-select');assert.ok(row);
  assert.equal(row.textContent,`${subject.slice(0,80)} · recorded input`);assert.equal(row.title,subject);
  row.click();await settle();
  const text=node.querySelector('.task-text');assert.ok(text);assert.equal(text.textContent,subject);assert.equal(text.dataset.open,'false');
  click(inspection,'Show more');assert.equal(text.dataset.open,'true');assert.equal(text.textContent,subject);
  assert.equal(row.textContent,`${subject.slice(0,80)} · recorded input`);inspection.destroy();
});
test('task disclosure follows rendered overflow and retains expansion across resize, content and visibility changes',async t=>{
  let row:ConversationTask={key:'geometry-task',entryId:'17',subject:'Measured task',state:'recorded',input:{text:'Brief input',complete:false,redacted:true},answer:{text:'Retained answer with a source [link](https://example.test/source)',complete:false,redacted:false}};
  const inspection=new AgentInspection(identity,{read:async()=>{assert.fail('Disclosure never fetches omitted source text');},history:false,tasks:()=>[row],showConversation:()=>{},current:()=>true,changed:()=>{},restore:()=>null,save:()=>{}});
  t.after(()=>inspection.destroy());
  const node=inspection.node as unknown as HostNode;hostDocument.body.append(node);inspection.open('result');inspection.visibility(true);await settle();
  node.querySelector('.task-select')?.click();await settle();
  const prose=()=>node.querySelectorAll('.task-prose'),text=(section:HostNode)=>{const value=section.querySelector('.task-text');assert.ok(value);return value;},toggle=(section:HostNode)=>{const value=section.querySelector('button');assert.ok(value);return value;};
  const geometry=(value:HostNode,width:number,full:number,clamped:number)=>Object.defineProperties(value,{clientWidth:{configurable:true,get:()=>width},scrollHeight:{configurable:true,get:()=>full},clientHeight:{configurable:true,get:()=>clamped}});
  const input=text(prose()[0]),answer=text(prose()[1]),inputToggle=toggle(prose()[0]),answerToggle=toggle(prose()[1]);
  const resize=HostResizeObserver.instances.find(observer=>observer.observed.has(answer));assert.ok(resize);
  geometry(input,600,24,24);geometry(answer,600,120,72);resize.callback();
  assert.equal(inputToggle.hidden,true);assert.equal(answerToggle.hidden,false);assert.equal(answerToggle.textContent,'Show more');
  answerToggle.click();assert.equal(answer.dataset.open,'true');assert.equal(answerToggle.textContent,'Show less');assert.equal(answerToggle.hidden,false);
  geometry(answer,1000,24,24);resize.callback();assert.equal(answer.dataset.open,'true');assert.equal(answerToggle.hidden,false);
  row={...row,answer:{text:'Updated short retained answer',complete:false,redacted:false}};inspection.observe(undefined,true);
  const updated=text(prose()[1]),updatedToggle=toggle(prose()[1]);assert.equal(updated.dataset.open,'true');assert.equal(updatedToggle.textContent,'Show less');assert.equal(updatedToggle.hidden,false);assert.equal(updated.textContent,row.answer?.text);assert.equal(resize.observed.has(answer),false);
  geometry(updated,1000,24,24);updatedToggle.click();assert.equal(updated.dataset.open,'false');assert.equal(updatedToggle.hidden,true);
  const updatedInput=text(prose()[0]),updatedInputToggle=toggle(prose()[0]);
  inspection.visibility(false);geometry(updatedInput,0,120,72);resize.callback();assert.equal(updatedInputToggle.hidden,true);
  geometry(updatedInput,160,120,72);inspection.visibility(true);await settle();assert.equal(updatedInputToggle.hidden,false);assert.equal(updatedInput.textContent,row.input?.text);
  geometry(updated,160,120,72);resize.callback();assert.equal(updatedToggle.hidden,false);updatedToggle.click();assert.equal(updated.textContent,row.answer?.text);assert.equal(updatedToggle.textContent,'Show less');
  assert.match(node.textContent,/Some text is withheld\./);assert.match(node.textContent,/Only retained text is shown\./);assert.ok(node.querySelectorAll('button').some(button=>button.textContent==='Copy answer'));assert.ok(node.querySelectorAll('button').some(button=>button.textContent==='Show in conversation'));
  inspection.destroy();assert.equal(resize.observed.size,0);
});
test('the task list names itself, returns to the conversation, and says what its empty lists searched',async()=>{
  let returned=0;const calls:InspectRequest[]=[];
  const inspection=new AgentInspection(identity,{read:async input=>{calls.push(input);return {view:'history',identity,readAt:'now',entries:[],coverage:{complete:true,truncated:false,omitted:0},detail:{text:'',shortened:false,protected:false}} as unknown as AgentInspectionView;},current:()=>true,changed:()=>{},returned:()=>{returned++;},restore:()=>null,save:()=>{}});
  inspection.open('result');inspection.visibility(true);await settle();
  const node=inspection.node as unknown as HostNode;
  assert.equal(node.querySelector('.inspection-title')?.textContent,'Sent and received tasks');assert.equal(node.querySelector('.inspection-navigation'),null);
  const text=node.textContent??'';assert.match(text,/No inputs found in the last 100 messages\./);assert.match(text,/No sent tasks found in the loaded messages\./);
  assert.equal(calls.some(call=>call.view==='history'&&call.limit===100),true);
  click(inspection,'Back to conversation');assert.equal(inspection.active,false);assert.equal(returned,1);inspection.destroy();
});
