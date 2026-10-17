import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
import type {ComposerReloadState} from './composer.ts';
import {readReloadState} from './reload-storage.ts';
import type {Factory} from './reload-storage.fixture.mts';
const browser=await createAppFixture();
const {app,arrive,agentFixture,targetFixture,singlePane,agentControl,observation,coverage,settle}=browser;

test('reload checkpoint preserves the exact local draft without draft-save confirmation',async t=>{
  const identity='reload-owner',target={kind:'agent' as const,identity},workspace='reload-workspace';
  const saved=targetFixture('reload-target',target,{draft:{revision:1,text:'Saved draft',mode:'followUp',persisted:true}});
  await arrive({workspace:{id:workspace,revision:1,selectedTarget:target,conversationLayout:singlePane([target])},primaries:[],roster:[agentFixture(identity)],targets:[saved],observations:[observation(identity,{revision:1,observedAt:'now',entries:[],live:[],nextBefore:null,status:{busy:false},coverage},2)]});
  const original=globalThis.fetch,pending=Promise.withResolvers<Response>();let held:{input:Parameters<typeof fetch>[0];init:RequestInit|undefined}|undefined;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
    if(init?.method==='PUT'&&String(input).endsWith('/reload-target/draft')){held={input,init};return pending.promise;}return original(input,init);
  });
  t.after(async()=>{if(held)pending.resolve(await original(held.input,held.init));await settle();});
  const editor=agentControl('editor');editor.focus();app.agentComposer().setText('Exact local draft before save');await settle();
  await app.drainDev(new AbortController().signal);const checkpoint=app.captureDevCheckpoint();assert.ok(checkpoint.composerStateKey);
  const preserved=await readReloadState(checkpoint.composerStateKey,new AbortController().signal) as ComposerReloadState[];
  assert.equal(preserved.find(value=>value.workspace===workspace&&value.targetKey===saved.targetKey)?.data.text,'Exact local draft before save');
  assert.doesNotMatch(JSON.stringify(checkpoint),/Exact local draft before save/);assert.equal(editor.value,'Exact local draft before save');
});
test('a file added during checkpoint storage prevents stale navigation and remains recoverable',async()=>{
  const storage=globalThis.indexedDB as unknown as Factory;storage.automatic=false;
  const saving=app.drainDev(new AbortController().signal);await settle();const transaction=storage.latest();assert.equal(transaction.mode,'readwrite');assert.equal(transaction.state,'active');
  app.agentComposer().addFiles([new File(['retained invalid bytes'],'retained.png',{type:'image/png',lastModified:456})]);await settle();transaction.commit();
  await assert.rejects(saving,/draft changed during preservation/);assert.equal(agentControl('editor').value,'Exact local draft before save');
  storage.automatic=true;await app.drainDev(new AbortController().signal);const checkpoint=app.captureDevCheckpoint();assert.ok(checkpoint.composerStateKey);
  const preserved=await readReloadState(checkpoint.composerStateKey,new AbortController().signal) as ComposerReloadState[];
  const file=preserved.flatMap(value=>value.attachments?.items??[]).find(item=>item.name==='retained.png');assert.ok(file);
  assert.equal(await file.file?.text(),'retained invalid bytes');assert.equal(file.lastModified,456);
});
test('reload never borrows the active workspace draft for a retained workspace with the same target key',async()=>{
  const checkpoint=app.captureDevCheckpoint();assert.ok(checkpoint.composerStateKey);
  const preserved=await readReloadState(checkpoint.composerStateKey,new AbortController().signal) as ComposerReloadState[];
  const active=app.state.targets.get('reload-target'),snapshot=preserved[0];assert.ok(active);assert.ok(snapshot);
  const other={...active,draft:{...active.draft,revision:0,text:'Other workspace draft'}};
  const retained={...snapshot,workspace:'other-workspace',data:{...snapshot.data,server:other.draft,text:other.draft.text}};
  assert.equal(app.currentPreservedTarget(other,[...preserved,retained],retained.workspace),other);
});
test('reload applies a caret only to its captured text or the exact acknowledged draft revision',async()=>{
  const checkpoint=app.captureDevCheckpoint();assert.ok(checkpoint.composerStateKey);
  const preserved=await readReloadState(checkpoint.composerStateKey,new AbortController().signal) as ComposerReloadState[];
  const captured=checkpoint.targets[0],snapshot=preserved[0];assert.ok(captured);assert.ok(snapshot);
  const selection={start:2,end:7,direction:'backward' as const},entry={...captured,selection},revision=entry.draftRevision+1;
  assert.equal(app.restoredDevSelection(entry,'Newer unrelated draft text',revision,preserved),undefined);
  assert.equal(app.restoredDevSelection(entry,snapshot.data.text,revision,preserved),selection);
  assert.equal(app.restoredDevSelection({...entry,draftRevision:revision},'Newer unrelated draft text',revision,preserved),selection);
});
