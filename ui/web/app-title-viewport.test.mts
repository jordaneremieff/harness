import assert from 'node:assert/strict';
import test from 'node:test';
import type {EntryView, PrimaryView, ReadingView} from '../shared/api.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {contextMenu} from './context-menu.ts';
const browser=await createAppFixture();
const {app,arrive,settle,primaryFixture,primaryControl,targetFixture,entryFixture,messageFixture,textPart,byId,hostDocument}=browser;
function user(id:string,text:string):EntryView {return entryFixture(id,[{...messageFixture(`${id}-message`,[textPart(text)]),role:'user'}]);}
function page(primary:PrimaryView,items:EntryView[],nextCursor:string|null=null):Response {
  return Response.json({ok:true,data:{target:{kind:'primary',key:primary.key,epoch:primary.epoch},items,nextCursor,revision:'history',coverage:browser.coverage}});
}
function parents(node:HostNode):HostNode[]{const values:HostNode[]=[];for(let value:HostNode|null=node;value;value=value.parentNode)values.push(value);return values;}

test('completed bounded session titles name a partial transcript without opening the session picker',async t=>{
  const primary=primaryFixture({epoch:25100,sessionId:'title-source',sessionFile:'/fixture/project/title-source.jsonl'}),fetch=globalThis.fetch;
  const saved={id:primary.sessionId,path:primary.sessionFile,project:primary.cwd,revision:'snapshot',title:'Build a compact personal workspace',titleState:'ready',titleSource:'prompt',modifiedAt:'2026-10-24T00:00:00Z',size:1000};
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input),'http://ui.test');
    if(url.pathname==='/api/sessions')return Response.json({ok:true,data:{items:[saved],total:1,omitted:0,nextCursor:null,titleCursor:null,observedAt:'2026-10-24T00:00:00Z'}});
    if(url.pathname==='/api/primaries/p/history')return page(primary,[user('latest-request','A later message must not become the session title')],'earlier');
    return fetch(input,init);
  });
  await arrive({workspace:{id:'bounded-header-title',revision:1,primaryKey:primary.key},primaries:[primary],roster:[]});await settle();app.renderNavigation();
  assert.equal(byId('conversation-title').textContent,saved.title);
  assert.equal(byId('recent-sessions').querySelector('.row-title')?.textContent,saved.title);
  assert.equal(byId('modal').open,false);
  browser.event('primary.state',{...primary,sessionName:'A manual session name'});await settle();app.renderNavigation();
  assert.equal(byId('conversation-title').textContent,'A manual session name');
});

test('a partial loaded suffix never supplies a title and the proven history beginning supplies the first prompt',async t=>{
  const primary=primaryFixture({epoch:25101,sessionId:'partial-title',sessionFile:'/fixture/project/partial-title.jsonl'}),fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input),'http://ui.test');
    if(url.pathname==='/api/primaries/p/history')return url.searchParams.has('cursor')?page(primary,[user('original-request','The original recognisable request')]):page(primary,[user('latest-request','A recent suffix prompt')],'earlier');
    return fetch(input,init);
  });
  await arrive({workspace:{id:'partial-header-title',revision:1,primaryKey:primary.key},primaries:[primary],roster:[]});await settle();app.renderNavigation();
  assert.equal(byId('conversation-title').textContent,'Untitled session');
  primaryControl('earlier').click();await settle();app.renderNavigation();
  assert.equal(byId('conversation-title').textContent,'The original recognisable request');
});

test('visual viewport changes place native roots before composer measurement and retain the same editor and reading owner',async t=>{
  const primary=primaryFixture({epoch:25102}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  const saved=targetFixture('viewport-draft',target,{draft:{revision:1,text:'Keep the native draft and its range',mode:'prompt',images:[],persisted:true}});
  await arrive({workspace:{id:'viewport-native-order',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[saved],history:Array.from({length:20},(_,at)=>user(`viewport-${at}`,`Retained message ${at}`))});await settle();
  const root=primaryControl('root'),editor=primaryControl('editor'),ancestry=parents(editor),slot=app.stableViews().slot(root as unknown as HTMLElement) as unknown as HostNode;assert.ok(slot);
  const originalBox=slot.getBoundingClientRect();let slotHeight=300;
  t.mock.method(slot,'getBoundingClientRect',()=>({...originalBox,height:slotHeight}));
  const composer=app.primaryComposer(),placement=composer.placement.bind(composer),heights:string[]=[];
  t.mock.method(composer,'placement',(sidebar:boolean)=>{heights.push((root.style as unknown as {height:string}).height);placement(sidebar);});
  const callbacks=new Map<string,()=>void>(),viewport={height:700.4,offsetTop:0,scale:1,addEventListener:(name:string,run:()=>void)=>callbacks.set(name,run)};
  const media=globalThis.matchMedia;t.mock.method(globalThis,'matchMedia',(query:string)=>query==='(pointer:coarse)'?{matches:true} as MediaQueryList:media(query));
  Object.defineProperty(window,'visualViewport',{configurable:true,value:viewport});
  t.after(()=>{Reflect.deleteProperty(window,'visualViewport');hostDocument.documentElement.style.removeProperty('--app-height');hostDocument.documentElement.style.removeProperty('--app-top');delete hostDocument.documentElement.dataset.keyboard;document.body.style.translate='';});
  editor.setSelectionRange(3,10,'backward');app.installViewportSync();assert.equal(heights.at(-1),'300px');assert.deepEqual([...callbacks.keys()],['resize','scroll']);
  heights.length=0;slotHeight=140;viewport.height=360.4;viewport.offsetTop=29.7;callbacks.get('resize')?.();callbacks.get('scroll')?.();await settle();
  assert.deepEqual(heights,['140px']);assert.equal(hostDocument.documentElement.properties.get('--app-height'),'360px');assert.equal(hostDocument.documentElement.properties.get('--app-top'),'30px');
  slotHeight=260;viewport.height=620.2;viewport.offsetTop=0;callbacks.get('resize')?.();await settle();assert.equal(heights.at(-1),'260px');assert.equal(document.body.style.translate,'');
  viewport.scale=2;slotHeight=280;callbacks.get('resize')?.();await settle();assert.equal(heights.at(-1),'280px');assert.equal(hostDocument.documentElement.properties.has('--app-height'),false);assert.equal(hostDocument.documentElement.properties.has('--app-top'),false);
  assert.equal(app.primaryComposer().editor,editor);assert.deepEqual(parents(editor),ancestry);assert.equal(editor.value,'Keep the native draft and its range');assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[3,10,'backward']);
});

function historyItems():EntryView[]{return Array.from({length:24},(_,at)=>user(`reading-${at}`,`Retained conversation message ${at}`));}
function position(transcript:HostNode,id:string):number {const anchor=transcript.querySelector(`[data-entry-id="${id}"]`);assert.ok(anchor);return transcript.scrollTop-(anchor.offsetTop-transcript.offsetTop);}

test('composer input and an action sheet do not cancel a pending exact saved reading position',async t=>{
  const primary=primaryFixture({epoch:25103}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch},reading={revision:9,anchorId:'reading-8',offsetPx:21,followTail:false};
  const saved=targetFixture('pending-reading-draft',target,{reading,draft:{revision:1,text:'A retained draft',mode:'prompt',images:[],persisted:true}}),pending=Promise.withResolvers<Response>(),fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>new URL(String(input),'http://ui.test').pathname==='/api/primaries/p/history'?pending.promise:fetch(input,init));
  t.after(()=>pending.resolve(page(primary,historyItems())));
  await arrive({workspace:{id:'pending-reading-editor',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[saved]});
  const editor=primaryControl('editor'),ancestry=parents(editor);editor.dispatch('pointerdown',{isTrusted:true});editor.value='A retained draft plus typing';editor.dispatch('input',{isTrusted:true});
  byId('conversation-actions').click();contextMenu.close();pending.resolve(page(primary,historyItems()));await settle();
  const transcript=primaryControl('transcript');assert.equal(position(transcript,reading.anchorId),reading.offsetPx);assert.equal(editor.value,'A retained draft plus typing');assert.deepEqual(parents(editor),ancestry);
  assert.equal(app.state.targets.get(saved.targetKey)?.reading.followTail,false);
});

test('Latest persists tail intent without scrollend and a fresh transcript hydrates that acknowledged intent',async()=>{
  const primary=primaryFixture({epoch:25104}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch},reading={revision:9,anchorId:'reading-8',offsetPx:21,followTail:false};
  const saved=targetFixture('latest-persistence',target,{reading});
  await arrive({workspace:{id:'latest-persistence',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[saved],history:historyItems()});await settle();
  primaryControl('latest').click();await settle();const acknowledged=app.state.targets.get(saved.targetKey)?.reading;assert.ok(acknowledged);assert.equal(acknowledged.followTail,true);assert.equal(acknowledged.anchorId,null);
  const fresh=targetFixture('fresh-latest-persistence',target,{reading:{...acknowledged}});
  await arrive({workspace:{id:'fresh-latest-persistence',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[fresh],history:historyItems()});await settle();assert.equal(primaryControl('latest').hidden,true);assert.ok(primaryControl('transcript').scrollTop>0);
});

test('an explicit saved start position stays distinct from a fresh tail preference',async()=>{
  const primary=primaryFixture({epoch:25106}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  for(const followTail of [false,true]){
    const saved=targetFixture(`explicit-position-${followTail}`,target,{reading:{revision:4,anchorId:null,offsetPx:0,followTail}});
    await arrive({workspace:{id:`explicit-position-${followTail}`,revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[saved],history:historyItems()});await settle();
    assert.equal(primaryControl('latest').hidden,followTail);assert.equal(primaryControl('transcript').scrollTop===0,!followTail);
  }
});

test('scrollback persists through the existing render frame without requiring scrollend',async()=>{
  const primary=primaryFixture({epoch:25105}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch},reading:ReadingView={revision:9,anchorId:'reading-8',offsetPx:21,followTail:false};
  const saved=targetFixture('scrollback-persistence',target,{reading});
  await arrive({workspace:{id:'scrollback-persistence',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[saved],history:historyItems()});await settle();
  const transcript=primaryControl('transcript');transcript.scrollTop+=31;transcript.dispatch('scroll');await settle();
  const acknowledged=app.state.targets.get(saved.targetKey)?.reading;assert.ok(acknowledged);assert.equal(acknowledged.followTail,false);assert.equal(acknowledged.offsetPx,reading.offsetPx+31);
  const before=transcript.scrollTop;byId('conversation-actions').click();contextMenu.close();app.renderNavigation();await settle();assert.equal(transcript.scrollTop,before);
});
