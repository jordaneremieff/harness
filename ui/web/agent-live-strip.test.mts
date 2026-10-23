import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {EntryView, ProjectedFrame} from '../shared/api.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {AgentLiveStrip, type AgentContext} from './agent-live-strip.ts';
import type {ConversationPresentation} from './conversation-presentation.ts';

const browser=await createAppFixture();
const {hostDocument,entryFixture,messageFixture,textPart,agentFixture,settle}=browser;
const view=(activity:string):ConversationPresentation=>({name:'Repeated name',activity,tone:'secondary',input:true,busy:false,lastObserved:false,retainedModel:false,retainedThinking:false});
function received(id:string,text:string):EntryView {
  return {...entryFixture(id,[{...messageFixture(`message-${id}`,[textPart(text)]),role:'user'}]),sender:{identity:'sender',kind:'agent'}};
}
function frame(id:string,answer:number):ProjectedFrame {
  return {revision:1,observedAt:'',entries:[],live:[],nextBefore:null,coverage:browser.coverage,status:{busy:false,submissions:{value:[{type:'input',entryId:Number(id),status:'done',answerEntryId:answer}],truncated:false}}};
}
function fixture(entries:EntryView[]=[],projected?:ProjectedFrame) {
  const strip=new AgentLiveStrip(),node=strip.node as unknown as HostNode,expanded=new Set<string>(),revealed:string[]=[];
  let layouts=0;
  const context:AgentContext={identity:'exact-agent',entries,frame:projected,beginning:false,
    caption:()=> 'Sender',resolve:id=>`loaded:${id}`,reveal:id=>revealed.push(id),expanded:key=>expanded.has(key),
    disclosure:(key,open)=>{if(open)expanded.add(key);else expanded.delete(key);},layout:change=>{layouts++;change();},image:()=>undefined,preview:()=>{}};
  hostDocument.body.append(node);strip.updateContext(context);
  return {strip,node,context,expanded,revealed,get layouts(){return layouts;}};
}
function action(node:HostNode,label:string):HostNode {
  const button=node.querySelectorAll('button').find(item=>item.textContent===label);assert.ok(button,label);return button;
}

test('live context omits repeated profile facts and empty request controls while meaningful activity remains',t=>{
  const f=fixture(),row=agentFixture('exact-agent',{role:'Repeated role',model:{provider:'provider',modelId:'repeated-model'},modifiedAt:Date.now()});
  t.after(()=>f.node.remove());
  for(const activity of ['Ready','Idle','Done']){f.strip.update(row,view(activity),undefined,true);assert.equal(f.strip.node.hidden,true);}
  assert.equal(f.node.querySelector('.agent-context-profile'),null);assert.equal(f.node.querySelector('.agent-live-model'),null);
  assert.equal(f.node.querySelector('.agent-request-row')?.hidden,true);assert.equal(f.node.querySelectorAll('button').some(item=>item.textContent==='Load'),false);
  f.strip.update(row,{...view('Working'),tool:{name:'Read',argument:'source.ts'}},undefined,true);
  assert.equal(f.strip.node.hidden,false);assert.equal(f.node.querySelector('.agent-live-state')?.textContent,'Working');assert.equal(f.node.querySelector('.agent-live-tool')?.textContent,'Read source.ts');
  f.strip.update(row,view('Provider blocked'),{label:'Blocked',tone:'warning'},true);assert.equal(f.node.querySelector('.agent-live-tool')?.textContent,'Provider blocked');
  f.strip.update(row,view('Response failed'),{label:'Failed',tone:'error'},true);assert.equal(f.node.querySelector('.agent-live-tool')?.textContent,'Turn failed');
  f.strip.update(row,view('Read only'),undefined,true);assert.equal(f.node.querySelector('.agent-live-state')?.textContent,'Read only');
  f.strip.update(row,view('Ready'),undefined,true);assert.equal(f.strip.node.hidden,true);
});

test('request disclosure keeps navigation, exact Copy and source inside the retained expanded request across updates',async t=>{
  const entry=received('17','Exact first line\nRetained request content'),f=fixture([entry],frame('17',21)),copied:string[]=[];
  const clipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{copied.push(text);}}});
  t.after(()=>{f.node.remove();if(clipboard)Object.defineProperty(navigator,'clipboard',clipboard);else Reflect.deleteProperty(navigator,'clipboard');});
  const toggle=f.node.querySelector('.agent-request-title');assert.ok(toggle);assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.ok(toggle.querySelector('.card-icon-chevron'));
  assert.equal(f.node.querySelector('.agent-request-row')?.querySelectorAll('button').length,1);assert.equal(f.node.querySelectorAll('button').some(item=>item.textContent==='Go to request'),false);
  toggle.click();const body=f.node.querySelector('.agent-request-body');assert.ok(body);assert.equal(body.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'true');assert.equal(f.layouts,1);
  action(body,'Go to request').click();action(body,'Go to answer').click();assert.deepEqual(f.revealed,['loaded:17','loaded:21']);
  const copy=action(body,'Copy');copy.click();await settle();assert.deepEqual(copied,['Exact first line\nRetained request content']);
  const source=body.querySelector('.agent-request-source');assert.ok(source);source.open=true;body.scrollTop=73;copy.focus();
  const retainedText=body.querySelector('.agent-request-text'),next={...f.context,entries:[entry,received('30','A newer request')],frame:frame('30',31)};
  f.strip.updateContext(next);assert.equal(body.querySelector('.agent-request-text'),retainedText);assert.equal(body.querySelector('.agent-request-source'),source);
  assert.equal(source.open,true);assert.equal(body.scrollTop,73);assert.equal(hostDocument.activeElement,copy);
  action(body,'Go to request').click();action(body,'Go to answer').click();assert.deepEqual(f.revealed.slice(-2),['loaded:17','loaded:21']);
  const saved=f.strip.captureReload();assert.equal(saved.request?.entry,entry);assert.equal(saved.scrollTop,73);assert.equal(saved.sourceOpen,true);
  action(body,'Close request').click();assert.equal(body.hidden,true);assert.equal(hostDocument.activeElement,toggle);
});

test('cached request reopen refreshes navigation after a closed context update',t=>{
  const entry=received('17','Retained request'),f=fixture([entry],frame('17',21));t.after(()=>f.node.remove());
  const toggle=f.node.querySelector('.agent-request-title');assert.ok(toggle);toggle.click();
  const body=f.node.querySelector('.agent-request-body');assert.ok(body);const text=body.querySelector('.agent-request-text');
  action(body,'Close request').click();f.strip.updateContext({...f.context});
  assert.equal(action(body,'Go to request').hidden,true);assert.equal(action(body,'Go to answer').hidden,true);
  toggle.click();assert.equal(body.querySelector('.agent-request-text'),text);
  assert.equal(action(body,'Go to request').hidden,false);assert.equal(action(body,'Go to answer').hidden,false);
  action(body,'Go to request').click();action(body,'Go to answer').click();assert.deepEqual(f.revealed,['loaded:17','loaded:21']);
});

test('late old answers retain exact navigation and answer focus across newer requests and reload',t=>{
  const buttonType=Object.getOwnPropertyDescriptor(globalThis,'HTMLButtonElement');Object.defineProperty(globalThis,'HTMLButtonElement',{configurable:true,value:browser.HostNode});
  t.after(()=>{if(buttonType)Object.defineProperty(globalThis,'HTMLButtonElement',buttonType);else Reflect.deleteProperty(globalThis,'HTMLButtonElement');});
  const entry=received('17','Opened request'),newer=received('30','Newer request'),f=fixture([entry]);
  const toggle=f.node.querySelector('.agent-request-title');assert.ok(toggle);toggle.click();
  const body=f.node.querySelector('.agent-request-body'),source=body?.querySelector('.agent-request-source');assert.ok(body);assert.ok(source);
  const text=body.querySelector('.agent-request-text'),copy=action(body,'Copy');source.open=true;body.scrollTop=68;copy.focus();
  assert.equal(action(body,'Go to answer').hidden,true);
  f.strip.updateContext({...f.context,entries:[entry,newer],frame:frame('30',31)});assert.equal(action(body,'Go to answer').hidden,true);
  f.strip.updateContext({...f.context,entries:[entry,newer],frame:frame('17',21)});
  assert.equal(action(body,'Go to answer').hidden,false);assert.equal(body.querySelector('.agent-request-text'),text);
  assert.equal(body.querySelector('.agent-request-source'),source);assert.equal(source.open,true);assert.equal(body.scrollTop,68);assert.equal(hostDocument.activeElement,copy);
  action(body,'Go to answer').click();assert.deepEqual(f.revealed,['loaded:21']);
  f.strip.updateContext({...f.context,entries:[entry,newer],frame:frame('30',31)});const answer=action(body,'Go to answer');assert.equal(answer.hidden,false);answer.focus();
  const saved=f.strip.captureReload();f.node.remove();
  const restored=fixture([newer],frame('30',31));t.after(()=>restored.node.remove());restored.strip.restoreReload(saved);
  const retained=restored.node.querySelector('.agent-request-body');assert.ok(retained);const restoredAnswer=action(retained,'Go to answer');
  assert.equal(restoredAnswer.hidden,false);assert.equal(hostDocument.activeElement,restoredAnswer);assert.equal(retained.scrollTop,68);assert.equal(retained.querySelector('.agent-request-source')?.open,true);
  restoredAnswer.click();assert.deepEqual(restored.revealed,['loaded:21']);
});

test('request reload retains source, scroll and exact control focus without restoring an empty toolbar',t=>{
  const buttonType=Object.getOwnPropertyDescriptor(globalThis,'HTMLButtonElement');Object.defineProperty(globalThis,'HTMLButtonElement',{configurable:true,value:browser.HostNode});
  t.after(()=>{if(buttonType)Object.defineProperty(globalThis,'HTMLButtonElement',buttonType);else Reflect.deleteProperty(globalThis,'HTMLButtonElement');});
  const entry=received('17','Retained request'),first=fixture([entry],frame('17',21));
  const toggle=first.node.querySelector('.agent-request-title');assert.ok(toggle);toggle.click();
  const body=first.node.querySelector('.agent-request-body'),source=body?.querySelector('.agent-request-source');assert.ok(body);assert.ok(source);
  source.open=true;body.scrollTop=51;action(body,'Copy').focus();const saved=first.strip.captureReload();first.node.remove();
  const next=fixture([entry],frame('17',21));t.after(()=>next.node.remove());next.strip.restoreReload(saved);
  const restored=next.node.querySelector('.agent-request-body');assert.ok(restored);assert.equal(restored.hidden,false);assert.equal(restored.scrollTop,51);
  assert.equal(restored.querySelector('.agent-request-source')?.open,true);assert.equal(hostDocument.activeElement,action(restored,'Copy'));
  assert.equal(next.node.querySelectorAll('button').some(item=>item.textContent==='Load'),false);
});

test('request controls wrap at natural height with touch targets and no reserved strip space',()=>{
  const css=readFileSync(new URL('./style.css',import.meta.url),'utf8');
  const rule=(selector:string)=>{const start=css.indexOf(`${selector} {`);assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};
  assert.doesNotMatch(rule('.agent-live-strip'),/(?:min-)?height:/);
  assert.match(rule('.agent-request-title'),/min-height: 44px/);assert.match(rule('.agent-request-title'),/white-space: normal/);
  assert.match(rule('.agent-request-actions'),/flex-wrap: wrap/);assert.match(rule('.agent-request-body button'),/min-height: 44px/);
});
