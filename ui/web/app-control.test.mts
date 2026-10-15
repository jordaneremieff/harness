import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
import type {ControlAck, ControlRequest} from '../shared/control.ts';
import type {FileTab} from '../shared/api.ts';
const f = await createAppFixture();
const {app,arrive,settle,event,hostDocument,primaryFixture,targetFixture,primaryControl,transportLog,byId} = f;
let serial = 0;
function command(intent:ControlRequest['intent']):ControlRequest {
  const workspace = app.state.workspace;assert.ok(workspace);
  return {requestId:`control-${++serial}`,bootId:'boot',workspaceId:workspace.id,pageId:app.fileWatch.clientId,connectionId:'control-stream',expectedRevision:workspace.revision,expiresAt:Date.now()+5000,actor:'Helper',intent};
}
async function apply(request:ControlRequest):Promise<ControlAck|undefined> {
  const original = globalThis.fetch;let ack:ControlAck|undefined;
  globalThis.fetch = async(input,init)=> {if(String(input).startsWith('/api/control/ack')) {ack = JSON.parse(String(init?.body));return Response.json({ok:true,data:{}});}return original(input,init);};
  try {const work = app.browserControl.receive(request);await settle();await work;return ack;}finally {globalThis.fetch = original;}
}
async function setup(id:string,split=false) {
  const target = {kind:'primary',key:'p',epoch:1} as const,row=f.agentFixture(`${id}-side`);
  await arrive({workspace:{id,revision:1,primaryKey:'p',...(split ? {conversationLayout:f.twoPanes(row.identity,'primary-pane')} : {})},primaries:[primaryFixture({activity:'idle'})],roster:split ? [row] : [],targets:[targetFixture(id,target,{draft:{revision:1,text:'Native draft remains exact',mode:'prompt',persisted:true}}),...(split ? [targetFixture(row.identity,{kind:'agent',identity:row.identity})] : [])]});
  event('ready',{bootId:'boot',connectionId:'control-stream'});await settle();
}
test('restored drafts remain passive without autofocus, input preparation or draft-mode writes',async()=> {
  hostDocument.activeElement = hostDocument.body;const start = transportLog.length;await setup('passive');
  const editor = app.primaryComposer().editor;
  assert.equal(hostDocument.activeElement,hostDocument.body);assert.equal(editor.value,'Native draft remains exact');
  assert.deepEqual(transportLog.slice(start).filter(call=>call.path.endsWith('/targets') || call.path === '/api/operations' || call.method === 'PUT' && call.path.endsWith('/draft')),[]);
  primaryControl('editor').dispatch('pointerdown');await settle();
  assert.equal(transportLog.slice(start).some(call=>call.path === '/api/operations'),true);
});
test('control focus and split preserve the visible native root without any hidden transition and send exact provenance',async t=> {
  await setup('native',true);const editor = app.primaryComposer().editor,root = primaryControl('root');editor.focus();editor.setSelectionRange(2,7,'backward');
  const parent = editor.parentElement,rootParent = root.parentElement;let hidden = root.hidden;const hides:boolean[]=[];
  Object.defineProperty(root,'hidden',{configurable:true,get:()=>hidden,set:value=> {hidden=value;hides.push(value);}});
  t.after(()=> {delete (root as unknown as {hidden?:boolean}).hidden;root.hidden=hidden;});
  const request = command({action:'focus',paneId:'primary-pane'});const ack = await apply(request);
  assert.equal(ack?.result,'applied');assert.equal(hostDocument.activeElement,editor);assert.equal(editor.parentElement,parent);assert.equal(root.parentElement,rootParent);
  assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,7,'backward']);assert.equal(hides.includes(true),false);
  const start = transportLog.length;
  const split = command({action:'split',paneId:'agent-pane',axis:'y',view:{kind:'agent',identity:'new'}});assert.equal((await apply(split))?.result,'refused');
  assert.equal(transportLog.slice(start).some(call=>call.path.includes('/selection')),false);
  const row=f.agentFixture('visible');f.fixture.roster.push(row);app.state.roster.set(row.identity,row);
  const target=f.targetFixture('visible',{kind:'agent',identity:'visible'});f.fixture.targets?.push(target);
  const requestSplit=command({action:'split',paneId:'agent-pane',axis:'y',view:{kind:'agent',identity:'visible'}});
  const result=await apply(requestSplit);assert.equal(result?.result,'applied');
  const write=transportLog.slice(start).find(call=>call.path.endsWith('/selection'));assert.ok(write);
  assert.deepEqual((write.body as {control:unknown}).control,{requestId:requestSplit.requestId,bootId:'boot',workspaceId:'native',pageId:app.fileWatch.clientId,connectionId:'control-stream'});
  assert.equal(hostDocument.activeElement,editor);assert.equal(editor.parentElement,parent);assert.equal(root.parentElement,rootParent);
  assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,7,'backward']);assert.equal(hides.includes(true),false);
  assert.deepEqual(transportLog.slice(start).filter(call=>call.path.endsWith('/targets') || call.path === '/api/operations'),[]);
});
test('a file split waits for its existing load before a rendered receipt and a later show retains that owner',async()=> {
  await setup('file-receipt',true);const editor=app.primaryComposer().editor,root=primaryControl('root'),parent=editor.parentElement,rootParent=root.parentElement;
  editor.focus();editor.setSelectionRange(3,8,'backward');const original=globalThis.fetch,pending=Promise.withResolvers<Response>(),acks:ControlAck[]=[];
  const tab:FileTab={kind:'file',rootId:'/fixture/project',path:'receipt.md'},text='Exact file text\n';let reads=0;const start=transportLog.length;
  const response=()=>Response.json({ok:true,data:{rootId:tab.rootId,path:tab.path,text,revision:{size:text.length,mtimeMs:1,digest:'a'.repeat(64)}}});
  globalThis.fetch=async(input,init)=> {
    const url=new URL(String(input),'http://ui.test');
    if(url.pathname === '/api/control/ack') {acks.push(JSON.parse(String(init?.body)));return Response.json({ok:true,data:{}});}
    if(url.pathname.endsWith('/text')) {reads++;return pending.promise;}
    if(url.pathname.endsWith('/draft'))return Response.json({ok:true,data:{revision:0,draft:null}});
    return original(input,init);
  };
  const request=command({action:'split',paneId:'agent-pane',axis:'y',view:tab}),work=app.browserControl.receive(request);
  try {
    await settle();const workspace=app.state.workspace;assert.ok(workspace);const view=app.filesViews.view(workspace,tab),owner=view.owner;
    assert.equal(reads,1);assert.equal(owner.loading,true);assert.equal(acks.length,0);assert.equal(root.hidden,false);
    pending.resolve(response());await settle();await work;
    assert.deepEqual(acks[0],{requestId:request.requestId,bootId:'boot',workspaceId:workspace.id,pageId:app.fileWatch.clientId,connectionId:'control-stream',result:'applied',appliedRevision:workspace.revision});
    assert.equal(owner.text,text);assert.equal(view.root.hidden,false);assert.equal(view.root.isConnected,true);
    assert.equal(hostDocument.activeElement,editor);assert.equal(editor.parentElement,parent);assert.equal(root.parentElement,rootParent);
    assert.equal(editor.value,'Native draft remains exact');assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[3,8,'backward']);
    const writes=transportLog.slice(start).filter(call=>call.path.endsWith('/selection'));assert.equal(writes.length,1);
    const shown=await apply(command({action:'show',rootId:tab.rootId,path:tab.path}));assert.equal(shown?.result,'applied');
    assert.equal(app.filesViews.view(app.state.workspace as typeof workspace,tab).owner,owner);assert.equal(reads,1);
    assert.equal(transportLog.slice(start).filter(call=>call.path.endsWith('/selection')).length,1);
    assert.deepEqual(transportLog.slice(start).filter(call=>call.path.endsWith('/targets') || call.path === '/api/operations'),[]);
  } finally {pending.resolve(response());await settle();await work;globalThis.fetch=original;}
});
test('focused native pane geometry changes refuse before any selection save or optimistic paint',async t=> {
  await setup('native-geometry',true);const editor=app.primaryComposer().editor,root=primaryControl('root'),layout=JSON.stringify(app.state.workspace?.conversationLayout),parent=editor.parentElement;
  editor.focus();editor.setSelectionRange(2,7,'backward');editor.scrollTop=41;editor.scrollLeft=13;
  let hidden=root.hidden;const paints:boolean[]=[];Object.defineProperty(root,'hidden',{configurable:true,get:()=>hidden,set:value=> {hidden=value;paints.push(value);}});
  t.after(()=> {delete (root as unknown as {hidden?:boolean}).hidden;root.hidden=hidden;});
  const intents:ControlRequest['intent'][]=[{action:'resize',splitId:'split-fixture',ratio:30},{action:'swap',splitId:'split-fixture'},{action:'split',paneId:'primary-pane',axis:'y',view:{kind:'file',rootId:'root',path:'new.md'}}];
  for(const intent of intents) {
    const start=transportLog.length,result=await apply(command(intent));assert.equal(result?.result,'refused');assert.equal(result?.result === 'refused' && result.refusalCode,'native_owner_geometry');
    assert.equal(transportLog.slice(start).some(call=>call.path.endsWith('/selection')),false);assert.equal(JSON.stringify(app.state.workspace?.conversationLayout),layout);
    assert.equal(hostDocument.activeElement,editor);assert.equal(editor.parentElement,parent);assert.equal(editor.value,'Native draft remains exact');
    assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection,editor.scrollTop,editor.scrollLeft],[2,7,'backward',41,13]);
  }
  assert.deepEqual(paints,[]);
});
test('neutral control refuses reflow of an anchored reading pane and preserves its actual offset and saved revision',async()=> {
  hostDocument.activeElement=hostDocument.body;const target={kind:'primary' as const,key:'p',epoch:41},row=f.agentFixture('reading-side'),reading={revision:2,anchorId:'reading-anchor',offsetPx:25,followTail:false};
  const saved=targetFixture('reading-geometry',target,{reading}),history=['before-anchor','reading-anchor',...Array.from({length:12},(_,index)=>`after-${index}`)].map(id=>f.entryFixture(id,[f.messageFixture(`message-${id}`,[f.textPart(id)])]));
  await arrive({workspace:{id:'reading-geometry',revision:1,primaryKey:'p',conversationLayout:f.twoPanes(row.identity,'primary-pane')},primaries:[primaryFixture({epoch:41})],roster:[row],targets:[saved,targetFixture('reading-side',{kind:'agent',identity:row.identity})],history});
  event('ready',{bootId:'boot',connectionId:'control-stream'});await settle();const transcript=primaryControl('transcript');
  const position=()=> {const anchor=transcript.querySelector('[data-entry-id="reading-anchor"]');assert.ok(anchor);return {id:anchor.dataset.entryId,offset:transcript.scrollTop-(anchor.offsetTop-transcript.offsetTop)};};
  const before=position(),layout=JSON.stringify(app.state.workspace?.conversationLayout);assert.deepEqual(before,{id:reading.anchorId,offset:reading.offsetPx});assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading,reading);
  const intents:ControlRequest['intent'][]=[{action:'resize',splitId:'split-fixture',ratio:37},{action:'swap',splitId:'split-fixture'},{action:'split',paneId:'primary-pane',axis:'y',view:{kind:'file',rootId:'root',path:'reading.md'}}];
  for(const intent of intents) {
    const start=transportLog.length,result=await apply(command(intent));assert.equal(result?.result,'refused');assert.equal(result?.result === 'refused' && result.refusalCode,'reading_owner_geometry');
    assert.deepEqual(position(),before);assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading,reading);assert.equal(JSON.stringify(app.state.workspace?.conversationLayout),layout);
    assert.equal(transportLog.slice(start).some(call=>call.path.endsWith('/selection') || call.method === 'PUT' && call.path.endsWith('/reading')),false);
  }
  assert.equal((await apply(command({action:'focus',paneId:'agent-pane'})))?.result,'applied');assert.deepEqual(position(),before);assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading,reading);
});
test('an empty source split refuses before any optimistic paint, target creation or file read',async()=> {
  hostDocument.activeElement=hostDocument.body;await arrive({workspace:{id:'empty-source',revision:1},primaries:[],roster:[],targets:[]});event('ready',{bootId:'boot',connectionId:'control-stream'});await settle();
  const layout=JSON.stringify(app.state.workspace?.conversationLayout),start=transportLog.length;
  const result=await apply(command({action:'split',paneId:'pane-1',axis:'x',view:{kind:'file',rootId:'root',path:'empty.md'}}));
  assert.equal(result?.result,'refused');assert.equal(result?.result === 'refused' && result.refusalCode,'source_empty');
  assert.equal(JSON.stringify(app.state.workspace?.conversationLayout),layout);assert.deepEqual(transportLog.slice(start),[]);
});
test('addressed journal events advance replay cursors and notices use quiet bottom attribution',async()=> {
  await setup('events');const before = app.state.cursor,request = command({action:'notice',text:'Read this bounded notice'});
  const original = globalThis.fetch;let ack:ControlAck|undefined;
  globalThis.fetch = async(input,init)=> {if(String(input).startsWith('/api/control/ack')) {ack = JSON.parse(String(init?.body));return Response.json({ok:true,data:{}});}return original(input,init);};
  try {event('control.request',request);await settle();assert.equal(ack?.result,'applied');assert.equal(app.state.needsResync,false);assert.notEqual(app.state.cursor,before);}finally {globalThis.fetch=original;}
  event('notice',{level:'info',message:'Helper: Read this bounded notice',code:'control_applied'});await settle();
  assert.equal(byId('control-attribution').textContent,'Helper: Read this bounded notice');assert.equal(byId('modal').open,false);
});
test('replayed requests before fresh ready advance the cursor without effects or later execution',async()=> {
  await setup('replay');const old=command({action:'notice',text:'Do not replay'}),original=globalThis.fetch,acks:ControlAck[]=[],start=transportLog.length;
  globalThis.fetch=async(input,init)=> {if(String(input).startsWith('/api/control/ack')) {acks.push(JSON.parse(String(init?.body)));return Response.json({ok:true,data:{}});}return original(input,init);};
  const visibility=(hidden:boolean)=> {hostDocument.hidden=hidden;for(const handler of f.documentHandlers.get('visibilitychange') ?? [])handler({target:hostDocument});};
  try {
    visibility(true);visibility(false);await settle();const fresh=f.streamSources.at(-1);assert.ok(fresh);
    const before=app.state.cursor;fresh.emit('control.request',old);await settle();const replay=app.state.cursor;assert.notEqual(replay,before);
    assert.equal(acks.length,0);assert.equal(app.state.needsResync,false);
    fresh.emit('ready',{bootId:'boot',connectionId:'replacement'});await settle();
    app.receive({name:'control.request',id:replay ?? '',envelope:{at:'',data:old}});await settle();assert.equal(acks.length,0);
    fresh.emit('control.request',{...command({action:'notice',text:'Fresh request'}),connectionId:'replacement'});await settle();
    assert.equal(acks.length,1);assert.equal(acks[0]?.result,'applied');
    assert.equal(transportLog.slice(start).some(call=>call.path.endsWith('/selection')),false);
  } finally {hostDocument.hidden=false;globalThis.fetch=original;}
});
test('control refuses a native owner hide and an unsettled selection instead of waiting',async()=> {
  await setup('busy');app.primaryComposer().editor.focus();
  const row = f.agentFixture('other');f.fixture.roster.push(row);app.state.roster.set(row.identity,row);
  const root = primaryControl('root');const result = await apply(command({action:'focus',paneId:'pane-1',view:{kind:'agent',identity:'other'}}));
  assert.equal(result?.result,'refused');assert.equal(result?.result === 'refused' && result.refusalCode,'native_owner_hidden');assert.equal(root.hidden,false);
  const original = globalThis.fetch,pending = Promise.withResolvers<Response>();
  globalThis.fetch=async(input,init)=>String(input).includes('/selection') ? pending.promise : original(input,init);
  const selecting = app.selectionQueue.select({sidebarWidth:300});await Promise.resolve();
  try {const receipt = await apply(command({action:'notice',text:'Later'}));assert.equal(receipt?.result,'refused');assert.equal(receipt?.result === 'refused' && receipt.refusalCode,'selection_busy');}
  finally {pending.resolve(Response.json({ok:true,data:{...app.state.workspace,revision:(app.state.workspace?.revision ?? 0)+1}}));await selecting;globalThis.fetch=original;await settle();}
});
