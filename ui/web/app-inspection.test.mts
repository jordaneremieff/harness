import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
import type {MessageView} from '../shared/api.ts';
import {paneLeaves} from './pane-layout.ts';
const f=await createAppFixture();const {app,arrive,settle,primaryFixture,agentFixture,targetFixture,singlePane,primaryControl,hostDocument,transportLog}=f;
const identity='00000000-0000-4000-8000-000000000001:2';
const target={kind:'agent' as const,identity};
function activeInspection(){const node=hostDocument.querySelectorAll('.agent-inspection').find(node=>!node.hidden);assert.ok(node);return node;}
function source(){return {view:'history',identity,readAt:'now',entries:[{id:7,kind:'user',source:'user',text:{text:'Retained worker ask',shortened:false,protected:false},truncated:false,calls:[],callsOmitted:0,tools:[]}],nextCursor:null,detail:{text:'',shortened:false,protected:false}};}
test('Tasks uses an adjacent exact-agent pane and preserves the Primary native draft, range and focus',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(path,init)=>/\/agents\/[^/]+\/inspect(?:\?|$)/.test(String(path))?Response.json({ok:true,data:source()}):original(path,init);
  const primary=primaryFixture({epoch:7001});const draft=targetFixture('inspection-primary',{kind:'primary',key:primary.key,epoch:primary.epoch},{draft:{revision:1,text:'Keep Primary draft',mode:'prompt',images:[],persisted:true}});
  await arrive({workspace:{id:'inspection-pane',revision:1,primaryKey:primary.key,conversationLayout:singlePane()},primaries:[primary],roster:[agentFixture(identity,{availability:'stored',capabilities:{history:false,observe:false,input:false,abort:false,configure:false}})],targets:[draft,targetFixture('inspection-agent',target)]});
  const editor=primaryControl('editor'),ancestors=[editor.parentNode,editor.parentNode?.parentNode],moves=editor.moves;editor.setSelectionRange(2,9,'backward');editor.scrollTop=31;editor.focus();const before=transportLog.length;
  app.inspectAgent(identity);await settle();
  assert.equal(app.state.workspace?.conversationLayout?.root.kind,'split');const panes=hostDocument.querySelectorAll('.pane-leaf');assert.equal(panes.length,2);assert.equal(primaryControl('editor'),editor);assert.equal(editor.value,'Keep Primary draft');assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,9,'backward']);assert.equal(editor.scrollTop,31);assert.deepEqual([editor.parentNode,editor.parentNode?.parentNode],ancestors);assert.equal(editor.moves,moves);assert.equal(hostDocument.activeElement,editor);
  assert.match(activeInspection().textContent,/Retained worker ask/);assert.equal(hostDocument.querySelector('#modal')?.open,false);
  const effects=transportLog.slice(before).filter(row=>row.method==='POST'&&/\/(targets|inputs|start|abort)$/.test(row.path));assert.deepEqual(effects,[]);
  const scroller=activeInspection().querySelector('.inspection-content');assert.ok(scroller);scroller.scrollTop=78;scroller.dispatch('scroll');scroller.dispatch('scrollend');const css=app.captureDevCssState();scroller.scrollTop=1;app.applyDevCssState(css);assert.equal(scroller.scrollTop,78);
  const checkpoint=app.captureDevCheckpoint();assert.equal(checkpoint.inspections?.[0]?.identity,identity);assert.equal(checkpoint.inspections?.[0]?.mode,'result');assert.equal(checkpoint.inspections?.[0]?.scrollTop,78);
  assert.equal(await app.restoreDevCheckpoint({...checkpoint,version:1,generation:'a'.repeat(64),oldClient:'b'.repeat(24),capturedAt:Date.now(),interactionRevision:0},new AbortController().signal),true);await settle();assert.equal(primaryControl('editor'),editor);assert.equal(editor.value,'Keep Primary draft');
});
test('exact result reads use the producer identity and native references without input admission',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const requests:{path:string;body:unknown}[]=[];
  globalThis.fetch=async(path,init)=>{if(/\/agents\/[^/]+\/inspect(?:\?|$)/.test(String(path))){requests.push({path:String(path),body:JSON.parse(String(init?.body))});return Response.json({ok:true,data:{view:'result',identity,readAt:'now',status:'done',submissionId:9,requestId:'producer-request',answerEntryId:17,answer:{text:'Exact producer answer',shortened:false,protected:false},usage:{value:{},truncated:false}}});}return original(path,init);};
  const message:MessageView={id:'result-message',role:'custom',state:'final',parts:[{type:'text',text:'Transport paragraph'}],coverage:f.coverage,communication:{state:'ready',origin:{kind:'ordinary-custom',customType:'agent.peer',renderEntryId:'result-message'},value:{format:'agent.communication/1',sender:{identity,name:'Worker'},body:{text:'Task complete',complete:false,redacted:false},recordedAt:1700000000000,kind:'result',metadata:{status:'done',references:[{submissionId:9,requestId:'producer-request',answerEntryId:'17'}],omittedReferences:0}}}};
  const primary=primaryFixture({epoch:7011});await arrive({workspace:{id:'result-link',revision:1,primaryKey:primary.key,conversationLayout:singlePane()},primaries:[primary],roster:[agentFixture(identity,{availability:'stored'})],targets:[targetFixture('link-primary',{kind:'primary',key:primary.key,epoch:primary.epoch}),targetFixture('link-agent',target)],history:[f.entryFixture('result-entry',[message])]});
  const before=transportLog.length, action=primaryControl('root').querySelector('.communication-results .communication-result-link');assert.ok(action);
  assert.equal(action.getAttribute('aria-label'),'Full text of result 1');assert.equal(action.textContent,'full text');
  assert.equal(action.parentNode?.textContent,'Shortened · full text');
  action.click();await settle();
  assert.equal(requests.length,1);assert.match(requests[0]?.path??'',new RegExp(encodeURIComponent(identity)));assert.deepEqual(requests[0]?.body,{view:'result',submissionId:9,requestId:'producer-request'});assert.match(activeInspection().textContent,/Exact producer answer/);assert.deepEqual(transportLog.slice(before).filter(row=>row.method==='POST'&&/\/(targets|inputs|start|abort)$/.test(row.path)),[]);
});

type ResultRead = {path:string;body:unknown};
function referenceLine(complete:boolean,count:number,numbers:string):string {
  if (complete) return count===1?'Result record':`Result records: ${numbers}`;
  return count===1?'Shortened · full text':`Shortened · full text: ${numbers}`;
}
async function referenceCase(complete:boolean,count:number,requests:ResultRead[]):Promise<void> {
  const references=Array.from({length:count},(_,index)=>({submissionId:20+index,...(index===1?{}:{requestId:`answer-${index}`})}));
  const message:MessageView={id:`answer-${complete}-${count}`,role:'custom',state:'final',parts:[{type:'text',text:'Transport'}],coverage:f.coverage,communication:{state:'ready',origin:{kind:'ordinary-custom',customType:'agent.peer',renderEntryId:`answer-${complete}-${count}`},value:{format:'agent.communication/1',sender:{identity,name:'Worker'},body:{text:'Answer body',complete,redacted:false},recordedAt:1700000000000,kind:'result',metadata:{status:'done',references,omittedReferences:0}}}};
  const primary=primaryFixture({epoch:7020});
  await arrive({workspace:{id:`answer-label-${complete}-${count}`,revision:1,primaryKey:primary.key,conversationLayout:singlePane()},primaries:[primary],roster:[agentFixture(identity)],history:[f.entryFixture(`answer-entry-${complete}-${count}`,[message])]});
  const row=primaryControl('root').querySelector('.communication-results');assert.ok(row);assert.equal(row.hidden,false);
  const numbers=references.map((_,index)=>String(index+1)).join(' · ');
  assert.equal(row.textContent,referenceLine(complete,count,numbers));
  assert.equal(row.querySelector('.card-action'),null);assert.equal(row.querySelector('svg'),null);
  const actions=row.querySelectorAll('.communication-result-link');assert.equal(actions.length,count);
  for(const [index,action] of actions.entries()){
    const label=`${complete?'Result record':'Full text of result'} ${index+1}`;
    assert.equal(action.getAttribute('aria-label'),label);assert.equal(action.title,label);assert.equal(action.tagName,'button');
    const single=complete?'Result record':'full text';
    assert.equal(action.textContent,count>1?String(index+1):single);assert.equal(action.children.length,0);
    const before=requests.length;action.click();await settle();
    assert.equal(requests.length,before+1);assert.match(requests.at(-1)?.path??'',new RegExp(encodeURIComponent(identity)));
    assert.deepEqual(requests.at(-1)?.body,{view:'result',...references[index]});
    const layout=app.state.workspace?.conversationLayout;assert.ok(layout);const primaryPane=paneLeaves(layout.root).find(pane=>pane.active==='primary');assert.ok(primaryPane);app.focusPane(primaryPane.id);await settle();
  }
}
test('result references use all four exact plain-text variants and retain every native selector',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const requests:ResultRead[]=[];
  globalThis.fetch=async(path,init)=>{if(/\/agents\/[^/]+\/inspect(?:\?|$)/.test(String(path))){const selector=JSON.parse(String(init?.body)) as {view:'result';submissionId:number;requestId?:string};requests.push({path:String(path),body:selector});return Response.json({ok:true,data:{...selector,identity,readAt:'now',status:'done',answer:{text:'Exact answer',shortened:false,protected:false},usage:{value:{},truncated:false}}});}return original(path,init);};
  for(const complete of [false,true])for(const count of [1,2,3])await referenceCase(complete,count,requests);
});
test('result reference labels follow completeness changes with unchanged native references',async()=>{
  const references=[{submissionId:40,requestId:'same-result'}],primary=primaryFixture({epoch:7021});
  const base={id:'same-completeness-card',role:'custom',state:'final' as const,parts:[{type:'text' as const,text:'Transport'}],coverage:f.coverage};
  const message=(complete:boolean):MessageView=>({...base,communication:{state:'ready',origin:{kind:'ordinary-custom',customType:'agent.peer',renderEntryId:base.id},value:{format:'agent.communication/1',sender:{identity,name:'Worker'},body:{text:'Retained answer body',complete,redacted:false},recordedAt:1700000000000,kind:'result',metadata:{status:'done',references,omittedReferences:0}}}});
  const frame=(complete:boolean,revision:number)=>({workspace:{id:'same-completeness-workspace',revision,primaryKey:primary.key,conversationLayout:singlePane()},primaries:[primary],roster:[agentFixture(identity)],history:[f.entryFixture('same-completeness-entry',[message(complete)])]});
  await arrive(frame(false,1));const row=primaryControl('root').querySelector('.communication-results');assert.ok(row);assert.equal(row.textContent,'Shortened · full text');
  await arrive(frame(true,2));assert.equal(primaryControl('root').querySelector('.communication-results'),row);assert.equal(row.textContent,'Result record');assert.equal(row.querySelector('.communication-result-link')?.getAttribute('aria-label'),'Result record 1');
  await arrive(frame(false,3));assert.equal(primaryControl('root').querySelector('.communication-results'),row);assert.equal(row.textContent,'Shortened · full text');assert.equal(row.querySelector('.communication-result-link')?.getAttribute('aria-label'),'Full text of result 1');
});
test('result cards with no references do not display a reference lead-in',async()=>{
  const message:MessageView={id:'unreferenced-result',role:'custom',state:'final',parts:[{type:'text',text:'Transport'}],coverage:f.coverage,communication:{state:'ready',origin:{kind:'ordinary-custom',customType:'agent.peer',renderEntryId:'unreferenced-result'},value:{format:'agent.communication/1',sender:{identity,name:'Worker'},body:{text:'Retained answer',complete:false,redacted:false},recordedAt:1700000000000,kind:'result',metadata:{status:'done',references:[],omittedReferences:0}}}};
  const primary=primaryFixture({epoch:7022});await arrive({workspace:{id:'unreferenced-result',revision:1,primaryKey:primary.key,conversationLayout:singlePane()},primaries:[primary],roster:[agentFixture(identity)],history:[f.entryFixture('unreferenced-result-entry',[message])]});
  const row=primaryControl('root').querySelector('.communication-results');assert.ok(row);assert.equal(row.hidden,true);assert.equal(row.textContent,'');
});
test('retained Tasks stays reachable when an agent lacks a live inspect capability',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const reads:unknown[]=[];
  globalThis.fetch=async(path,init)=>{if(/\/agents\/[^/]+\/inspect(?:\?|$)/.test(String(path))){reads.push(JSON.parse(String(init?.body)));return Response.json({ok:true,data:source()});}return original(path,init);};
  await arrive({workspace:{id:'inspection-stored',revision:1,selectedTarget:target,conversationLayout:singlePane([target])},primaries:[],roster:[agentFixture(identity,{availability:'stored',capabilities:{history:false,observe:false,input:false,abort:false,configure:false}})],targets:[targetFixture('inspection-stored-agent',target)],confirmed:false});
  reads.length=0;app.inspectAgent(identity);await settle();assert.deepEqual(reads,[{view:'history',source:'user',limit:20},{view:'history',source:'user',limit:20},{view:'history',limit:100}]);assert.equal(activeInspection().hidden,false);assert.equal(app.agentComposer().editor.disabled,false);
});
