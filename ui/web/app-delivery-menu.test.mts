import assert from 'node:assert/strict';
import test from 'node:test';
import type {OperationView} from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';
const browser=await createAppFixture();
const {app,arrive,settle,primaryFixture,primaryControl,targetFixture,byId,hostDocument,event,transportLog,entryFixture,messageFixture,textPart}=browser;

test('Tasks exposes explicit Queue for the captured busy draft without changing Send or Stop',async t=>{
  const primary=primaryFixture({epoch:25200,activity:'running'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch},fetch=globalThis.fetch,inputs:Record<string,unknown>[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path==='/api/primaries/p/inputs'){
      const body=JSON.parse(String(init?.body));inputs.push(body);
      return Response.json({ok:true,data:{id:new Headers(init?.headers).get('Idempotency-Key')??'queue-input',kind:'primary.input',target,state:'accepted',createdAt:'',updatedAt:'',receipt:{kind:'rpc',disposition:'queued'}}});
    }
    return fetch(input,init);
  });
  await arrive({workspace:{id:'tasks-queue',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[targetFixture('tasks-queue-draft',target,{draft:{revision:1,text:'An explicit follow-up draft',mode:'prompt',images:[],persisted:true}})]});event('ready',{bootId:'boot'});await settle();
  primaryControl('editor').dispatch('pointerdown',{isTrusted:true});await settle();
  const editor=primaryControl('editor'),parent=editor.parentNode,send=primaryControl('send'),stop=primaryControl('stop');
  assert.equal(send.getAttribute('aria-label'),'Send message');assert.equal(stop.hidden,false);assert.equal(primaryControl('queue').hidden,true);
  byId('conversation-actions').click();hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').find(node=>node.textContent==='Tasks')?.click();
  const queue=hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').find(node=>node.textContent==='Queue message');assert.ok(queue);queue.click();await settle();
  assert.equal(inputs.length,1);assert.equal(inputs[0]?.mode,'followUp');assert.equal(inputs[0]?.message,'An explicit follow-up draft');assert.equal(inputs[0]?.epoch,target.epoch);assert.equal(editor.parentNode,parent);assert.equal(primaryControl('stop'),stop);
  assert.equal(transportLog.some(call=>call.path.endsWith('/stop')||call.path.endsWith('/abort')),false);
});

test('a queued menu action refuses a replaced Primary instead of sending its retained draft elsewhere',async()=>{
  const primary=primaryFixture({epoch:25202,activity:'running'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  await arrive({workspace:{id:'stale-tasks-queue',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[targetFixture('stale-tasks-queue-draft',target,{draft:{revision:1,text:'Keep this exact recipient',mode:'prompt',images:[],persisted:true}})]});event('ready',{bootId:'boot'});await settle();
  primaryControl('editor').dispatch('pointerdown',{isTrusted:true});await settle();byId('conversation-actions').click();hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').find(node=>node.textContent==='Tasks')?.click();
  const queue=hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').find(node=>node.textContent==='Queue message');assert.ok(queue);
  event('primary.state',{...primary,epoch:25203},target);await settle();const start=transportLog.length;queue.click();await settle();
  assert.equal(transportLog.slice(start).some(call=>call.path.includes('/inputs')),false);assert.equal(app.state.targets.get('stale-tasks-queue-draft')?.draft.text,'Keep this exact recipient');
});

test('an accepted journal input settles its echo before a late HTTP failure and native history replaces that copy once',async t=>{
  const primary=primaryFixture({epoch:25201,activity:'running'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch},fetch=globalThis.fetch;
  const pending=Promise.withResolvers<Response>(),started=Promise.withResolvers<void>();let operationId='';
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path==='/api/primaries/p/inputs'){operationId=new Headers(init?.headers).get('Idempotency-Key')??'';started.resolve();return pending.promise;}
    return fetch(input,init);
  });
  t.after(()=>pending.reject(new Error('Fixture transport closed.')));
  const text='A message accepted before the HTTP connection ended';
  await arrive({workspace:{id:'journal-before-http',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[targetFixture('journal-before-http-draft',target,{draft:{revision:1,text,mode:'prompt',images:[],persisted:true}})]});event('ready',{bootId:'boot'});await settle();
  primaryControl('editor').dispatch('pointerdown',{isTrusted:true});primaryControl('composer').dispatch('submit');await started.promise;
  const accepted:OperationView={id:operationId,kind:'primary.input',target,state:'accepted',createdAt:'2026-10-24T00:00:00Z',updatedAt:'2026-10-24T00:00:01Z',receipt:{kind:'rpc',disposition:'queued'}};
  event('operation.changed',accepted,target);await settle();pending.reject(new Error('The HTTP response was lost.'));await settle();app.renderNavigation();await settle();
  const transcript=primaryControl('transcript'),echo=transcript.querySelector(`[data-entry-id="ui-input:${operationId}"]`);assert.ok(echo);assert.match(echo.textContent,/A message accepted before the HTTP connection ended/);assert.doesNotMatch(echo.textContent,/Delivery not confirmed|Message not sent/);
  event('primary.entry',{entry:entryFixture('accepted-native-entry',[{...messageFixture('accepted-native-message',[textPart(text)]),role:'user'}])},target);await settle();
  assert.equal(transcript.querySelector(`[data-entry-id="ui-input:${operationId}"]`),null);assert.equal(transcript.querySelectorAll('[data-entry-id="accepted-native-entry"]').length,1);
});
