import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
import type {Factory} from './reload-storage.fixture.mts';
import {readReloadState} from './reload-storage.ts';
const browser = await createAppFixture();
const {app, arrive, primaryFixture, targetFixture, singlePane, settle} = browser;
const workspace = 'notice-workspace', primary = primaryFixture({activity:'idle', capabilities:{input:true,history:true}});
const saved = targetFixture('notice-target', {kind:'primary',key:primary.key,epoch:primary.epoch}, {draft:{revision:1,text:'Saved draft',mode:'prompt',images:[],persisted:true}});
async function prepare() {
  await arrive({workspace:{id:workspace,revision:1,primaryKey:primary.key,conversationLayout:singlePane()},primaries:[primary],roster:[],targets:[saved]});
  sessionStorage.setItem('ui:dev-checkpoint', 'retained checkpoint');
  const notice = new browser.HostNode('span'); notice.className = 'secondary workbench-update';
  app.renderDevReloadNotice(notice as unknown as HTMLElement, {state:'failed',code:'checkpoint',retryable:false});
  return notice;
}
test('Reload waits for the real snapshot transaction and retained draft save before the clean workspace route', async t => {
  const notice = await prepare(), storage = indexedDB as unknown as Factory, original = fetch;
  const held = Promise.withResolvers<Response>(); let pending: {input:RequestInfo|URL;init?:RequestInit}|undefined;
  const navigations:string[] = [];
  Reflect.set(location,'assign',(url:string)=>{assert.equal(sessionStorage.getItem('ui:dev-checkpoint'),null);navigations.push(url);});
  t.after(()=>{storage.automatic=true;Reflect.deleteProperty(location,'assign');});
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(init?.method==='PUT'&&new URL(String(input),'http://ui.test').pathname.endsWith('/notice-target/draft')){pending={input,init};return held.promise;}return original(input,init);
  });
  app.primaryComposer().setText('Exact draft before Reload'); await settle();
  storage.automatic=false;
  const reload = app.reloadDev(); await settle();
  assert.equal(storage.latest().state,'active'); assert.deepEqual(navigations,[]); assert.equal(sessionStorage.getItem('ui:dev-checkpoint'),'retained checkpoint');
  storage.latest().commit(); await settle(); assert.deepEqual(navigations,[]); assert.ok(pending);
  const key=app.captureDevCheckpoint().composerStateKey;assert.ok(key);storage.automatic=true;
  held.resolve(await original(pending.input,pending.init)); await reload;await settle();
  assert.equal(await readReloadState(key,new AbortController().signal),undefined,'safe Reload releases its unlinked transfer record');
  assert.equal(app.primaryComposer().canDispose,true); assert.equal(browser.primaryControl('editor').value,'Exact draft before Reload');
  assert.deepEqual(navigations,['http://ui.test/?workspace=notice-workspace']);
  assert.equal(notice.textContent,'Automatic updates stopped.Reload'); assert.equal(notice.title,'failed (checkpoint)');
  assert.equal(notice.classList.contains('secondary'),true); assert.equal(notice.classList.contains('error'),false); assert.equal(notice.classList.contains('warning'),false);
});
test('a refused Reload drain retains the checkpoint, draft and page, then restores its action', async t => {
  const notice = await prepare(), storage = indexedDB as unknown as Factory;
  const draft = browser.primaryControl('editor').value, checkpoint = sessionStorage.getItem('ui:dev-checkpoint');
  Reflect.set(location,'assign',()=>assert.fail('A refused drain must not navigate.'));
  storage.issueFailure=new DOMException('Synthetic Reload storage refusal','QuotaExceededError');
  t.after(()=>{storage.issueFailure=undefined;Reflect.deleteProperty(location,'assign');});
  const reload=notice.querySelector('button');assert.ok(reload);reload.dispatch('click');assert.equal(reload.disabled,true);await settle();
  assert.equal(reload.disabled,false);assert.equal(sessionStorage.getItem('ui:dev-checkpoint'),checkpoint);assert.equal(browser.primaryControl('editor').value,draft);
  assert.match(notice.title,/failed \(checkpoint\)[\s\S]*Reload did not finish[\s\S]*Synthetic Reload storage refusal/);
});
test('Reload refuses changed ownership and local-only copies or failed files even after snapshot preservation',async t=>{
  await prepare();const storage=indexedDB as unknown as Factory;
  Reflect.set(location,'assign',()=>assert.fail('Retained local work must not navigate.'));
  t.after(()=>{storage.automatic=true;Reflect.deleteProperty(location,'assign');});
  storage.automatic=false;
  const changed=app.reloadDev();await settle();
  app.primaryComposer().setText('Newer edit during Reload');await settle();storage.latest().commit();
  await assert.rejects(changed,/draft changed during preservation/);assert.equal(sessionStorage.getItem('ui:dev-checkpoint'),'retained checkpoint');
  storage.automatic=true;await settle();
  const composer=app.primaryComposer(),snapshot=composer.captureReload()[0];assert.ok(snapshot);
  const current=app.state.targets.get(saved.targetKey);assert.ok(current);
  composer.restoreReload({...snapshot,localCopy:'Only this page holds these bytes.'},current);
  assert.equal(composer.canDispose,true,'local copies need an explicit check beyond disposal');
  await assert.rejects(app.reloadDev(),/Retained drafts or view ownership changed/);
  assert.equal(composer.captureReload()[0]?.localCopy,'Only this page holds these bytes.');assert.equal(sessionStorage.getItem('ui:dev-checkpoint'),'retained checkpoint');
  composer.restoreReload(snapshot,current);
  composer.addFiles([new File(['local failed bytes'],'failed.png',{type:'image/png',lastModified:456})]);await settle();
  await assert.rejects(app.reloadDev(),/did not settle/);
  const file=composer.captureReload()[0]?.attachments?.items[0]?.file;assert.ok(file);assert.equal(await file.text(),'local failed bytes');
  assert.equal(sessionStorage.getItem('ui:dev-checkpoint'),'retained checkpoint');
});
