import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
import {createPaneLayout} from './pane-layout.ts';
const browser=await createAppFixture();
const {app,arrive,settle,byId,hostDocument,primaryFixture,targetFixture}=browser;

for(const entry of ['sidebar','commands-sessions'])for(const empty of [false,true])test(`${entry} capacity recovery names an ${empty?'empty':'saved'} idle session and requires explicit closure`,async t=>{
  const idle=primaryFixture({key:`idle-${empty}`,epoch:22001,activity:'idle',sessionName:'Quiet session',sessionFile:empty?undefined:'/project/retained.jsonl',pendingDialogs:[],pendingOperationIds:[]});
  const busy=primaryFixture({key:'busy-session',epoch:22002,activity:'running',sessionName:'Busy session'});
  const target={kind:'primary' as const,key:idle.key,epoch:idle.epoch};
  const draft=targetFixture(`capacity-${empty}`,target,{draft:{revision:1,text:'Retained draft',mode:'prompt',images:[],persisted:true}});
  await arrive({workspace:{id:`capacity-${empty}`,revision:1,primaryKey:idle.key,selectedTarget:target,conversationLayout:createPaneLayout([{kind:'primary'}])},primaries:[idle,busy],roster:[],targets:[draft]});
  const original=globalThis.fetch,calls:{path:string;body:Record<string,unknown>}[]=[];
  t.after(()=>{globalThis.fetch=original;if(byId('modal').open)byId('modal-close').click();});
  globalThis.fetch=async(input,init)=>{
    const path=new URL(String(input),'http://ui.test').pathname,body=JSON.parse(String(init?.body??'{}'));
    if(init?.method==='POST')calls.push({path,body});
    if(path==='/api/primaries'&&init?.method==='POST')return Response.json({ok:true,data:{operation:{id:'capacity-open',state:'rejected',error:{code:'capacity',message:'The primary capacity is full.',retry:'manual'}}}});
    if(path===`/api/primaries/${idle.key}/close`){
      assert.deepEqual(body,{epoch:idle.epoch});
      browser.fixture={...browser.fixture,primaries:[{...idle,lifecycle:'stopped'},busy]};
      return Response.json({ok:true,data:{id:'capacity-close',kind:'primary.close',state:'completed'}});
    }
    return original(input,init);
  };
  if(entry==='commands-sessions'){
    byId('commands-button').click();await settle();
    const sessions=byId('modal-body').querySelectorAll('.palette-row').find(node=>node.getAttribute('aria-label')?.startsWith('Sessions,'));assert.ok(sessions);sessions.click();await settle();
    const create=byId('modal-body').querySelectorAll('button').find(node=>node.getAttribute('aria-label')==='New session');assert.ok(create);create.click();
  }else byId('session-new').click();
  await settle();
  assert.equal(byId('modal-title').textContent,'Session limit reached');
  assert.match(byId('modal-body').textContent,/The session limit is full\. Close an idle session/);
  assert.match(byId('modal-body').textContent,/Your saved conversations and drafts stay available/);
  assert.match(byId('modal-body').textContent,/The primary capacity is full/);
  const choice=byId('modal-body').querySelectorAll('button').find(node=>node.textContent.startsWith('Close Quiet session'));
  assert.ok(choice);assert.doesNotMatch(byId('modal-body').textContent,/Close Busy session/);
  assert.equal(calls.filter(call=>call.path.endsWith('/close')).length,0);
  choice.click();assert.match(byId('modal-title').textContent,/Close Quiet session/);
  assert.equal(calls.filter(call=>call.path.endsWith('/close')).length,0);
  const confirm=byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Close session');assert.ok(confirm);confirm.click();await settle();
  assert.equal(calls.filter(call=>call.path.endsWith('/close')).length,1);
  assert.equal(calls.filter(call=>call.path==='/api/primaries').length,1,'Closure never retries creation automatically.');
  assert.equal(calls.some(call=>call.path.endsWith('/handoff')||call.path.endsWith('/stop')),false);
  assert.equal(byId('modal-title').textContent,'Session closed');
  assert.ok(byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='New session'));
  assert.equal([...app.state.targets.values()].find(item=>item.targetKey===draft.targetKey)?.draft.text,'Retained draft');
});

test('capacity confirmation refuses a session that becomes busy and Cancel closes nothing',async t=>{
  const idle=primaryFixture({key:'capacity-stale',epoch:22100,activity:'idle',sessionName:'Changing session',pendingOperationIds:[]});
  await arrive({workspace:{id:'capacity-stale',revision:1,primaryKey:idle.key},primaries:[idle],roster:[]});
  const original=globalThis.fetch;let closes=0;t.after(()=>{globalThis.fetch=original;if(byId('modal').open)byId('modal-close').click();});
  globalThis.fetch=async(input,init)=>{
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path==='/api/primaries'&&init?.method==='POST')return Response.json({ok:true,data:{operation:{state:'rejected',error:{code:'capacity',message:'The primary capacity is full.',retry:'manual'}}}});
    if(path.endsWith('/close'))closes++;
    return original(input,init);
  };
  byId('session-new').click();await settle();
  let choice=byId('modal-body').querySelectorAll('button').find(node=>node.textContent.startsWith('Close Changing session'));assert.ok(choice);choice.click();
  const cancel=byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Cancel');assert.ok(cancel);cancel.click();await settle();assert.equal(closes,0);
  byId('session-new').click();await settle();choice=byId('modal-body').querySelectorAll('button').find(node=>node.textContent.startsWith('Close Changing session'));assert.ok(choice);choice.click();
  app.state.primaries.set(idle.key,{...idle,activity:'running'});
  const confirm=byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Close session');assert.ok(confirm);confirm.click();await settle();
  assert.equal(closes,0);assert.match(byId('modal-error').textContent,/no longer idle/);
});

for(const placement of ['modal','inline'])test(`${placement} creation retains ordinary errors outside capacity recovery`,async t=>{
  const primary=primaryFixture({key:`ordinary-error-${placement}`,epoch:22200,activity:'idle'});
  await arrive({workspace:{id:`ordinary-error-${placement}`,revision:1,primaryKey:placement==='inline'?null:primary.key,conversationLayout:createPaneLayout(placement==='inline'?[]:[{kind:'primary'}])},primaries:placement==='inline'?[]:[primary],roster:[]});
  await app.fileRoot.choose('/project');await settle();
  const original=globalThis.fetch;let closes=0,opens=0;t.after(()=>{globalThis.fetch=original;if(byId('modal').open)byId('modal-close').click();});
  globalThis.fetch=async(input,init)=>{
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path==='/api/primaries'&&init?.method==='POST'){opens++;return Response.json({ok:true,data:{operation:{state:'rejected',error:{code:'invalid_path',message:'The selected folder does not exist.',retry:'manual'}}}});}
    if(path.endsWith('/close'))closes++;
    return original(input,init);
  };
  byId('session-new').click();await settle();
  assert.equal(opens,1);
  const error=placement==='modal'?byId('modal-error'):byId('session-chooser').querySelector('.picker-error');assert.ok(error);
  assert.match(error.textContent,/The session did not open\. Your project choice is unchanged\./);
  assert.match(error.textContent,/The selected folder does not exist\./);assert.equal(closes,0);
  assert.equal(byId('modal').open,placement==='modal');assert.notEqual(byId('modal-title').textContent,'Session limit reached');
});

for(const newer of ['dialog','workspace'])test(`a delayed idle close preserves the newer ${newer}`,async t=>{
  const idle=primaryFixture({key:`delayed-${newer}`,epoch:22300,activity:'idle',sessionName:'Delayed session',pendingOperationIds:[]});
  await arrive({workspace:{id:`delayed-${newer}`,revision:1,primaryKey:idle.key},primaries:[idle],roster:[]});
  const original=globalThis.fetch,pending=Promise.withResolvers<Response>();let closes=0;
  t.after(()=>{pending.resolve(Response.json({ok:true,data:{id:'late-close',kind:'primary.close',state:'completed'}}));globalThis.fetch=original;if(byId('modal').open)byId('modal-close').click();});
  globalThis.fetch=async(input,init)=>{
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path==='/api/primaries'&&init?.method==='POST')return Response.json({ok:true,data:{operation:{state:'rejected',error:{code:'capacity',message:'The primary capacity is full.',retry:'manual'}}}});
    if(path.endsWith('/close')){closes++;return pending.promise;}
    return original(input,init);
  };
  byId('session-new').click();await settle();
  const choice=byId('modal-body').querySelectorAll('button').find(node=>node.textContent.startsWith('Close Delayed session'));assert.ok(choice);choice.click();
  const confirm=byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Close session');assert.ok(confirm);confirm.click();await settle();assert.equal(closes,1);
  if(newer==='dialog'){byId('commands-button').click();assert.equal(byId('modal-title').textContent,'Commands');}
  else await arrive({workspace:{id:'newer-workspace',revision:1,primaryKey:idle.key},primaries:[idle],roster:[]});
  pending.resolve(Response.json({ok:true,data:{id:'late-close',kind:'primary.close',state:'completed'}}));await settle();
  assert.notEqual(byId('modal-title').textContent,'Session closed');
  if(newer==='dialog'){assert.equal(byId('modal-title').textContent,'Commands');assert.equal(byId('modal').open,true);}
  else assert.equal(app.state.workspace?.id,'newer-workspace');
});

for(const entry of ['commands','conversation'])test(`${entry} closes a named empty idle session only after confirmation`,async t=>{
  const primary=primaryFixture({key:`normal-close-${entry}`,epoch:22400,activity:'idle',sessionFile:undefined,sessionName:'Empty session',pendingOperationIds:[]}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  const draft=targetFixture(`normal-close-${entry}`,target,{draft:{revision:1,text:'Keep this draft',mode:'prompt',images:[],persisted:true}});
  await arrive({workspace:{id:`normal-close-${entry}`,revision:1,primaryKey:primary.key,selectedTarget:target,conversationLayout:createPaneLayout([{kind:'primary'}])},primaries:[primary],roster:[],targets:[draft]});
  const layout=structuredClone(app.state.workspace?.conversationLayout),original=globalThis.fetch;let closes=0;
  t.after(()=>{globalThis.fetch=original;if(byId('modal').open)byId('modal-close').click();});
  globalThis.fetch=async(input,init)=>{
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path===`/api/primaries/${primary.key}/close`){closes++;assert.deepEqual(JSON.parse(String(init?.body)),{epoch:primary.epoch});browser.fixture={...browser.fixture,primaries:[{...primary,lifecycle:'stopped'}]};return Response.json({ok:true,data:{id:'normal-close',kind:'primary.close',state:'completed'}});}
    assert.equal(path.endsWith('/handoff')||path.endsWith('/stop'),false);return original(input,init);
  };
  if(entry==='commands')byId('commands-button').click();else {app.openConversationActions();hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').find(node=>node.textContent==='Session details')?.click();}await settle();
  const choices=entry==='commands'?byId('modal-body').querySelectorAll('.palette-row'):hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button');
  const close=choices?.find(node=>entry==='commands'?node.getAttribute('aria-label')?.startsWith('Close session,'):node.textContent==='Close session');assert.ok(close);close.click();
  assert.match(byId('modal-title').textContent,/Close Empty session/);assert.equal(closes,0);
  const confirm=byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Close session');assert.ok(confirm);confirm.click();await settle();
  assert.equal(closes,1);assert.equal(app.state.primaries.get(primary.key)?.lifecycle,'stopped');
  assert.equal(app.state.targets.get(draft.targetKey)?.draft.text,'Keep this draft');assert.deepEqual(app.state.workspace?.conversationLayout,layout,'Close session is not Close tab.');
});

test('normal Close session stays absent for busy or stale Primary state',async()=>{
  for(const lifecycle of ['ready','stopped'] as const){
    const primary=primaryFixture({key:`close-ineligible-${lifecycle}`,epoch:22500,lifecycle,activity:'running'});
    await arrive({workspace:{id:`close-ineligible-${lifecycle}`,revision:1,primaryKey:primary.key},primaries:[primary],roster:[]});
    byId('commands-button').click();assert.equal(byId('modal-body').querySelectorAll('.palette-row').some(node=>node.getAttribute('aria-label')?.startsWith('Close session,')),false);byId('modal-close').click();
    app.openConversationActions();assert.equal(hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').some(node=>node.textContent==='Close session'),false);
    const menu=hostDocument.body.querySelector('.context-menu');menu?.dispatch('keydown',{key:'Escape',preventDefault(){},stopPropagation(){}});
  }
});
