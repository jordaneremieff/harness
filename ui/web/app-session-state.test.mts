import assert from 'node:assert/strict';
import test from 'node:test';
import type {SavedSession, SessionTab} from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';
import {createPaneLayout} from './pane-layout.ts';
import {SessionReader} from './session-reader.ts';
import {tabKey} from './tabs.ts';

const browser=await createAppFixture();
const {app,arrive,settle,event,hostDocument,primaryFixture,transportLog}=browser;
const saved:SavedSession={id:'retained-session',path:'/fixture/retained.jsonl',project:'/fixture',revision:'r1',title:'Retained session',modifiedAt:'2026-01-01T00:00:00Z',size:10};
const tab:SessionTab={kind:'session',id:saved.id,path:saved.path,project:saved.project,name:saved.title};
function page(session:SavedSession):Response {return Response.json({ok:true,data:{session,entries:[],coverage:{complete:true,truncated:false,omitted:0},leaf:null,before:null,observedAt:'2026-01-01T00:00:00Z'}});}
function stateWords():[string|undefined,string|undefined] {
  const key=tabKey(tab);
  return [hostDocument.querySelectorAll('.conversation-tab').find(node=>node.dataset.tabKey===key)?.querySelector('.tab-session-state')?.textContent,
    hostDocument.querySelectorAll('.conversation-row').find(node=>node.dataset.tabKey===key)?.querySelector('.conversation-state')?.textContent];
}
function readerNode(){const node=hostDocument.querySelector('.session-reader');assert.ok(node);return node;}

test('saved tab, Tabs row and reader share checked metadata and current exact ownership',async t=>{
  const original=globalThis.fetch,gate=Promise.withResolvers<void>();let writer:'live'|undefined='live';
  t.after(()=>{gate.resolve();globalThis.fetch=original;});
  globalThis.fetch=async(input,init)=>{
    if(new URL(String(input),'http://ui.test').pathname!=='/api/sessions/history')return original(input,init);
    await gate.promise;return page({...saved,...(writer?{writer}:{})});
  };
  await arrive({workspace:{id:'checked-reader',revision:1,conversationLayout:createPaneLayout([tab])},primaries:[],roster:[]});
  assert.deepEqual(stateWords(),['','']);assert.equal(readerNode().querySelector('.session-state-bar')?.hidden,true);
  gate.resolve();await settle();
  assert.deepEqual(stateWords(),['live','Live']);assert.equal(readerNode().querySelector('.session-state-label')?.textContent,'Live in terminal');
  const calls=transportLog.length;writer=undefined;event('sessions.writers',{released:[saved.id]});await settle();
  assert.deepEqual(stateWords(),['closed','Closed']);assert.equal(readerNode().querySelector('.session-state-label')?.textContent,'Closed');
  const owner=primaryFixture({key:'reader-owner',epoch:31,cwd:saved.project,sessionId:saved.id,sessionFile:saved.path,activity:'idle'});
  event('primary.state',owner);await settle();
  assert.deepEqual(stateWords(),['idle','Idle']);assert.equal(readerNode().querySelector('.session-state-bar')?.hidden,true);
  event('primary.state',{...owner,activity:'running'});await settle();assert.deepEqual(stateWords(),['live','Live']);
  event('primary.state',{...owner,lifecycle:'stopped'});await settle();assert.deepEqual(stateWords(),['closed','Closed']);
  event('primary.state',{...owner,sessionId:'different-session'});await settle();assert.deepEqual(stateWords(),['','']);
  assert.equal(readerNode().querySelector('.session-state-bar')?.hidden,true);
  assert.equal(transportLog.slice(calls).some(call=>call.method!=='GET'),false);
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
