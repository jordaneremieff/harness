import assert from 'node:assert/strict';
import test from 'node:test';
import type {ConversationTab, EntryView, SavedSession, SessionTab} from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';
import {createPaneLayout} from './pane-layout.ts';
import {SessionReader} from './session-reader.ts';
import {tabKey} from './tabs.ts';

const browser=await createAppFixture();
const {app,arrive,settle,event,hostDocument,primaryFixture,transportLog,byId,agentFixture,targetFixture}=browser;
const saved:SavedSession={id:'retained-session',path:'/fixture/retained.jsonl',project:'/fixture',revision:'r1',title:'Retained session',titleState:'ready',titleSource:'name',modifiedAt:'2026-01-01T00:00:00Z',size:10};
const tab:SessionTab={kind:'session',id:saved.id,path:saved.path,project:saved.project,name:saved.title};
function page(session:SavedSession,entries:EntryView[]=[]):Response {return Response.json({ok:true,data:{session,entries,coverage:{complete:true,truncated:false,omitted:0},leaf:null,before:null,observedAt:'2026-01-01T00:00:00Z'}});}
function stateWords():[string|undefined,string|undefined] {
  const key=tabKey(tab);
  return [hostDocument.querySelectorAll('.conversation-tab').find(node=>node.dataset.tabKey===key)?.querySelector('.tab-session-state')?.textContent,
    hostDocument.querySelectorAll('.conversation-row').find(node=>node.dataset.tabKey===key)?.querySelector('.conversation-state')?.textContent];
}
function readerNode(){const node=hostDocument.querySelector('.session-reader');assert.ok(node);return node;}
function openReaderDetails():void {byId('conversation-actions').click();const item=hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').find(node=>node.textContent==='Conversation details');assert.ok(item);item.click();}

test('saved tab, Tabs row and reader share checked metadata and current exact ownership',async t=>{
  const original=globalThis.fetch,gate=Promise.withResolvers<void>();let writer:'live'|undefined='live';
  t.after(()=>{gate.resolve();byId('modal-close').click();globalThis.fetch=original;});
  globalThis.fetch=async(input,init)=>{
    if(new URL(String(input),'http://ui.test').pathname!=='/api/sessions/history')return original(input,init);
    await gate.promise;return page({...saved,...(writer?{writer}:{})});
  };
  await arrive({workspace:{id:'checked-reader',revision:1,conversationLayout:createPaneLayout([tab])},primaries:[],roster:[]});
  assert.deepEqual(stateWords(),['','']);assert.equal(readerNode().querySelector('.session-state-bar'),null);openReaderDetails();assert.equal(byId('modal-body').querySelector('.session-state-bar')?.hidden,true);
  assert.equal(byId('workbench-status').dataset.pane,'session');assert.equal(byId('workbench-scope').textContent,saved.title);assert.equal(byId('workbench-activity').textContent,'');
  gate.resolve();await settle();
  assert.deepEqual(stateWords(),['live','Live']);assert.equal(byId('modal-body').querySelector('.session-state-label')?.textContent,'Live in terminal');
  assert.equal(byId('workbench-activity').textContent,'Live in terminal');
  const calls=transportLog.length;writer=undefined;event('sessions.writers',{released:[saved.id]});await settle();
  assert.deepEqual(stateWords(),['closed','Closed']);assert.equal(byId('modal-body').querySelector('.session-state-label')?.textContent,'Closed');assert.equal(byId('workbench-activity').textContent,'Closed');
  const owner=primaryFixture({key:'reader-owner',epoch:31,cwd:saved.project,sessionId:saved.id,sessionFile:saved.path,activity:'idle'});
  event('primary.state',owner);await settle();
  assert.deepEqual(stateWords(),['idle','Idle']);assert.equal(byId('modal-body').querySelector('.session-state-bar')?.hidden,true);assert.equal(byId('workbench-activity').textContent,'Idle');
  event('primary.state',{...owner,activity:'running'});await settle();assert.deepEqual(stateWords(),['live','Live']);assert.equal(byId('workbench-activity').textContent,'Live');
  event('primary.state',{...owner,lifecycle:'stopped'});await settle();assert.deepEqual(stateWords(),['closed','Closed']);assert.equal(byId('workbench-activity').textContent,'Closed');
  event('primary.state',{...owner,sessionId:'different-session'});await settle();assert.deepEqual(stateWords(),['','']);assert.equal(byId('workbench-activity').textContent,'');
  assert.equal(byId('modal-body').querySelector('.session-state-bar')?.hidden,true);
  assert.equal(transportLog.slice(calls).some(call=>call.method!=='GET'),false);
  const bar=byId('modal-body').querySelector('.session-state-bar');assert.ok(bar);byId('modal-close').click();assert.equal(bar.isConnected,false);
});

test('saved reader details retain the existing controls and content warnings without normal diagnostic frames',async t=>{
  const fetch=globalThis.fetch,details=new browser.HostNode('section'),copies:string[]=[];let resumed=0,reads=0;
  const clipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{copies.push(text);}}});
  const reader=new SessionReader({embedded:true,primaries:()=>[],focus:()=>{},close:()=>{},resume:source=>{assert.equal(source.saved?.id,saved.id);assert.equal(source.saved?.path,saved.path);resumed++;}});
  const message=browser.messageFixture('shortened-message',[{type:'text',text:'A retained excerpt'},{type:'omitted',label:'This content is shortened.'}]),entries=[browser.entryFixture('shortened-entry',[message])];
  t.after(()=>{reader.close();details.remove();if(clipboard)Object.defineProperty(navigator,'clipboard',clipboard);else Reflect.deleteProperty(navigator,'clipboard');});
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(new URL(String(input),'http://ui.test').pathname!=='/api/sessions/history')return fetch(input,init);
    reads++;return Response.json({ok:true,data:{session:saved,entries,coverage:{complete:false,truncated:true,omitted:1,reason:'Earlier entries remain available.'},leaf:'leaf',before:reads<3?'older':null,observedAt:'2026-01-01T00:00:00Z'}});
  });
  hostDocument.body.append(reader.node as unknown as typeof details,details);reader.open({saved});await settle();
  assert.equal(reader.node.querySelector('.session-state-bar'),null);assert.equal(reader.node.querySelector<HTMLElement>('.session-reader-header')?.hidden,true);assert.doesNotMatch(reader.node.textContent??'',/entries loaded|as of|Earlier entries remain available/);assert.match(reader.node.textContent??'',/This content is shortened/);
  const release=reader.presentDetails(details as unknown as HTMLElement),bar=details.querySelector('.session-state-bar');assert.ok(bar);assert.match(details.textContent,/entries loaded|as of/);assert.match(bar.textContent,/Closed/);
  const refresh=details.querySelectorAll('button').find(node=>node.textContent==='Refresh');assert.ok(refresh);refresh.click();await settle();assert.equal(reads,2);
  const earlier=(reader.node as unknown as typeof details).querySelectorAll('button').find(node=>node.textContent==='Earlier retained entries');assert.ok(earlier);earlier.click();await settle();assert.equal(reads,3);assert.match(reader.node.textContent??'',/This content is shortened/);
  const resume=bar.querySelectorAll('button').find(node=>node.textContent==='Resume'),copy=bar.querySelectorAll('button').find(node=>node.textContent==='Copy');assert.ok(resume);assert.ok(copy);
  resume.dispatch('click');copy.dispatch('click');await settle();assert.equal(resumed,1);assert.deepEqual(copies,["pi --session '/fixture/retained.jsonl'"]);
  release();resume.dispatch('click');copy.dispatch('click');await settle();assert.equal(resumed,1);assert.equal(copies.length,1);assert.equal(bar.isConnected,false);
  const releaseAgain=reader.presentDetails(details as unknown as HTMLElement);assert.equal(details.querySelector('.session-state-bar')===bar,true);releaseAgain();
});

test('writer release replaces a pending read and a closed tab rejects its late metadata',async t=>{
  const original=globalThis.fetch,first=Promise.withResolvers<Response>(),last=Promise.withResolvers<Response>();let reads=0;
  t.after(()=>{first.resolve(page({...saved,writer:'live'}));last.resolve(page({...saved,writer:'live'}));globalThis.fetch=original;});
  globalThis.fetch=async(input,init)=>{
    if(new URL(String(input),'http://ui.test').pathname!=='/api/sessions/history')return original(input,init);
    reads++;return reads===1?first.promise:reads===2?page(saved):last.promise;
  };
  await arrive({workspace:{id:'reader-release',revision:1,conversationLayout:createPaneLayout([tab])},primaries:[],roster:[]});
  assert.deepEqual(stateWords(),['','']);event('sessions.writers',{released:['unrelated']});await settle();assert.equal(reads,1);
  event('sessions.writers',{released:[saved.id]});await settle();assert.equal(reads,2);assert.deepEqual(stateWords(),['closed','Closed']);
  first.resolve(page({...saved,writer:'live'}));await settle();assert.deepEqual(stateWords(),['closed','Closed']);
  event('sessions.writers',{released:[saved.id]});await settle();assert.equal(reads,3);
  app.applyLayout(createPaneLayout([]));await app.selectionQueue.drain();await settle();
  last.resolve(page({...saved,writer:'live'}));await settle();
  assert.equal(hostDocument.querySelector('.session-reader'),null);assert.deepEqual(stateWords(),[undefined,undefined]);
});

test('reader state stays unknown before a checked read and survives snapshot restoration',async t=>{
  const original=globalThis.fetch,gate=Promise.withResolvers<Response>();let changes=0;
  const reader=new SessionReader({primaries:()=>[],focus:()=>{},close:()=>{},resume:()=>{assert.fail('State refresh never resumes a session');},state:()=>{changes++;}});
  const restored=new SessionReader({primaries:()=>[],focus:()=>{},close:()=>{},resume:()=>{}});
  t.after(()=>{gate.resolve(page(saved));reader.close();restored.close();globalThis.fetch=original;});
  globalThis.fetch=async(input,init)=>new URL(String(input),'http://ui.test').pathname==='/api/sessions/history'?gate.promise:original(input,init);
  reader.open({saved});assert.deepEqual(reader.viewState(),{});gate.resolve(page({...saved,writer:'live'}));await settle();
  assert.equal(reader.viewState().terminal,true);assert.ok(changes>1);
  const checkpoint=reader.captureReload();assert.ok(checkpoint);restored.restoreReload(checkpoint);
  assert.deepEqual(restored.viewState(),reader.viewState());reader.close();assert.deepEqual(reader.viewState(),{});
});

test('saved footer uses checked caption, hides unrelated facts and skips to its reader',async t=>{
  const original=globalThis.fetch,checked={...saved,title:'Checked saved caption',writer:'live' as const};
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(input,init)=>new URL(String(input),'http://ui.test').pathname==='/api/sessions/history'?page(checked):original(input,init);
  await arrive({workspace:{id:'saved-footer',revision:1,primaryKey:'p',conversationLayout:createPaneLayout([{kind:'primary'},tab],tabKey(tab))},primaries:[primaryFixture({epoch:32})],roster:[]});
  const calls=transportLog.length;
  assert.equal(byId('workbench-scope').textContent,checked.title);assert.equal(byId('workbench-scope').title,`${checked.title}\n${saved.path}`);
  assert.equal(byId('workbench-activity').textContent,'Live in terminal');assert.equal(byId('workbench-activity').dataset.busy,'false');
  assert.equal(byId('workbench-status-primary').hidden,true);assert.equal(byId('workbench-status-agent').hidden,true);
  assert.equal(byId('focused-composer-status').hidden,true);assert.equal(byId('focused-composer-status').children.length,0);
  assert.equal(byId('skip-composer').textContent,'Skip to session');byId('skip-composer').click();
  assert.equal(hostDocument.activeElement,readerNode().querySelector('.session-reader-transcript'));
  assert.equal(transportLog.slice(calls).some(call=>call.method!=='GET'),false);
});

test('focused Message footer survives saved reader updates and navigation restores each real owner',async t=>{
  const original=globalThis.fetch;let writer:'live'|undefined='live';
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(input,init)=>new URL(String(input),'http://ui.test').pathname==='/api/sessions/history'?page({...saved,...(writer?{writer}:{})}):original(input,init);
  const recipient=agentFixture('saved-footer-recipient',{name:'Saved footer recipient'}),target={kind:'agent' as const,identity:recipient.identity};
  const agentTab:ConversationTab={kind:'agent',identity:recipient.identity},fileTab:ConversationTab={kind:'file',rootId:'root',path:'README.md'};
  const tabs:ConversationTab[]=[{kind:'primary'},agentTab,fileTab,tab];
  await arrive({workspace:{id:'saved-footer-message',revision:1,primaryKey:'p',conversationLayout:createPaneLayout(tabs,tabKey(tab))},primaries:[primaryFixture({epoch:33})],roster:[recipient],targets:[targetFixture('saved-footer-draft',target,{draft:{revision:1,text:'Retained recipient draft',mode:'prompt',persisted:true}})]});
  byId('roster').querySelector('[data-identity="saved-footer-recipient"]')?.querySelector('.row-message')?.click();await settle();
  const editor=hostDocument.querySelector('.composer[data-message-panel="true"] textarea');assert.ok(editor);editor.focus();
  const calls=transportLog.length;
  assert.equal(byId('workbench-status').dataset.pane,'agent');assert.equal(byId('workbench-scope').title,`Saved footer recipient\n${recipient.identity}`);
  writer=undefined;event('sessions.writers',{released:[saved.id]});await settle();
  assert.equal(byId('workbench-status').dataset.pane,'agent');assert.equal(hostDocument.activeElement,editor);assert.equal(editor.value,'Retained recipient draft');
  const activate=async(key:string)=>{const node=hostDocument.querySelectorAll('.conversation-tab').find(node=>node.dataset.tabKey===key);assert.ok(node);node.click();await settle();};
  await activate(tabKey(tab));assert.equal(byId('workbench-status').dataset.pane,'session');assert.equal(byId('workbench-activity').textContent,'Closed');
  assert.equal(hostDocument.activeElement,readerNode().querySelector('.session-reader-transcript'));
  await activate('primary');assert.equal(byId('workbench-status').dataset.pane,'primary');assert.equal(byId('workbench-status-primary').hidden,false);assert.equal(byId('focused-composer-status').hidden,false);assert.equal(byId('focused-composer-status').children.length,2);
  await activate(tabKey(agentTab));assert.equal(byId('workbench-status').dataset.pane,'agent');assert.equal(byId('workbench-status-agent').hidden,false);
  await activate(tabKey(fileTab));assert.equal(byId('workbench-status').dataset.pane,'file');assert.equal(byId('skip-composer').dataset.skip,'files');
  await activate(tabKey(tab));assert.equal(byId('workbench-status').dataset.pane,'session');assert.equal(byId('focused-composer-status').children.length,0);assert.equal(byId('workbench-status-primary').hidden,true);assert.equal(byId('workbench-status-agent').hidden,true);
  assert.deepEqual(transportLog.slice(calls).filter(call=>call.path.endsWith('/start')||call.path.includes('/inputs')).map(({method,path})=>({method,path})),[]);
});
