import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm,rename,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateStore} from './state.mts';
import {FileState} from './file-state.mts';
import {Files} from './files.mts';
import {moveFileEntry,createFileEntry,trashFileEntry,nativeFileOperation} from './file-operations.mts';
import {readText} from './file-access.mts';
import {fileSource,type FileMutation} from '../shared/files.ts';
import {workspaceTabKey,type FileTab} from '../shared/api.ts';
const result:FileMutation = {rootId:'root',operation:'move',path:'to',previousPath:'from',kind:'file'};
const workspace = '00000000-0000-4000-8000-000000000001';
test('pending file work does not hold unrelated state mutations',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-identity-')),store = await StateStore.open(directory);let release!:(value:FileMutation)=>void,entered!:()=>void;
  context.after(async()=> {await store.close();await rm(directory,{recursive:true,force:true});});const original = await store.workspace();
  const admission = new Promise<void>(resolve=> {entered = resolve;});
  const move = store.moveFiles('root','from','to',()=> {entered();return new Promise<FileMutation>(resolve=> {release = resolve;});});await admission;
  let timer:NodeJS.Timeout|undefined;const unrelated = Promise.all([store.createWorkspace(),store.updateSelection(original.id,{expectedRevision:0,appearance:'light'})]);
  const free = await Promise.race([unrelated.then(()=>true),new Promise<boolean>(resolve=> {timer = setTimeout(()=>resolve(false),1000);})]);clearTimeout(timer);release(result);await move;const [created] = await unrelated;
  assert.equal(free,true);assert.equal((await store.workspace(original.id)).revision,2);assert.equal((await store.workspace(original.id)).appearance,'light');assert.equal((await store.workspace(created.id)).revision,1);
});
test('an expired move never publishes a late identity or admits another layout or file mutation',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-expired-')),events:string[] = [],store = await StateStore.open(directory,{fileDeadlineMs:10,onChange:name=>events.push(name)});context.after(async()=> {await store.close();await rm(directory,{recursive:true,force:true});});const original = await store.workspace();events.length = 0;
  context.mock.timers.enable({apis:['setTimeout']});let release!:(value:FileMutation)=>void,entered!:()=>void;const admission = new Promise<void>(resolve=> {entered = resolve;});
  const expired = assert.rejects(store.moveFiles('root','from','to',()=> {entered();return new Promise<FileMutation>(resolve=> {release = resolve;});}),{code:'file_identity_uncertain',retry:'manual'});await admission;
  await assert.rejects(store.updateSelection(original.id,{expectedRevision:0,filePositions:{}}),{code:'file_identity_busy'});context.mock.timers.tick(10);await expired;
  await assert.rejects(store.updateSelection(original.id,{expectedRevision:0}),{code:'file_identity_uncertain'});let retried = false;await assert.rejects(store.createFiles('root','from',async()=> {retried = true;return result;}),{code:'file_identity_uncertain'});assert.equal(retried,false);
  release(result);await store.transaction(async()=>{});assert.equal((await store.workspace(original.id)).revision,0);assert.deepEqual(events,[]);await store.createWorkspace();
});
async function fixture(context:test.TestContext,operations:ConstructorParameters<typeof FileState>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-effects-')),stateDir = join(directory,'state'),project = join(directory,'project');await mkdir(stateDir);await mkdir(project);await writeFile(join(project,'from.md'),'base');
  context.after(()=>rm(directory,{recursive:true,force:true}));const state = new FileState(stateDir,operations);await state.load();const selected = await state.select(workspace,project,0);assert.ok(selected.root);const root = state.root(selected.root.id),source = await readText(root,'from.md');const draft = await state.putDraft(root.id,'from.md',0,source.revision,'local draft',fileSource(source.text).encoding);return {directory,stateDir,project,state,root,source,draft};
}
for (const failure of ['missing-ack','malformed-ack','timeout','missing-destination','different-inode','parent-identity','sync','draft-persist'] as const) test(`post-effect ${failure} refuses all file mutations and preserves saved draft state`,async context=> {
  let project = '';
  const moved:typeof moveFileEntry = (root,from,to)=>moveFileEntry(root,from,to,async(operation,source,destination)=> {
    assert.ok(destination);
    if (failure === 'missing-ack' || failure === 'malformed-ack' || failure === 'timeout') return nativeFileOperation(operation,source,destination,async()=> {await rename(source,destination);if (failure === 'timeout') throw new Error('deadline');return failure === 'malformed-ack' ? 'null' : 'no confirmation';});
    await rename(source,destination);
    if (failure === 'missing-destination') await rename(destination,`${destination}.retained`);
    if (failure === 'different-inode') {await rename(destination,`${destination}.retained`);await writeFile(destination,'different file');}
    if (failure === 'parent-identity') {await rename(join(project,'folder'),join(project,'folder-retained'));await mkdir(join(project,'folder'));}
  },async()=> {if (failure === 'sync') throw new Error('EIO');});
  const setup = await fixture(context,{move:moved});project = setup.project;const {state,root,stateDir,draft} = setup;let from = 'from.md';
  if (failure === 'parent-identity') {await mkdir(join(project,'folder'));await rename(join(project,from),join(project,'folder',from));from = 'folder/from.md';}
  if (failure === 'draft-persist') context.mock.method(state as unknown as {persist(...args:unknown[]):Promise<void>},'persist',async()=> {throw new Error('persist');});
  const before = await readFile(join(stateDir,'file-drafts.json'));await assert.rejects(state.move(root.id,from,'to.md'),{code:'file_identity_uncertain',retry:'manual'});
  assert.deepEqual(await readFile(join(stateDir,'file-drafts.json')),before);assert.deepEqual(state.draft(root.id,'from.md').draft,draft);
  await assert.rejects(state.move(root.id,'to.md','again.md'),{code:'file_identity_uncertain'});await assert.rejects(state.create(root.id,'from.md','file'),{code:'file_identity_uncertain'});await assert.rejects(state.trash(root.id,'to.md'),{code:'file_identity_uncertain'});await assert.rejects(state.putDraft(root.id,'from.md',draft.revision,draft.base,'new',draft.encoding),{code:'file_identity_uncertain'});
});
for (const operation of ['create','trash'] as const) test(`${operation} post-effect sync failure poisons file state`,async context=> {
  const sync = async()=> {throw new Error('EIO');};
  const {state,root,project} = await fixture(context,{create:(root,path,kind)=>createFileEntry(root,path,kind,sync),trash:(root,path)=>trashFileEntry(root,path,async(_operation,source)=>rename(source,`${source}.retained`),sync)});
  await assert.rejects(operation === 'create' ? state.create(root.id,'new.md','file') : state.trash(root.id,'from.md'),{code:'file_identity_uncertain'});
  assert.equal(await readFile(join(project,operation === 'create' ? 'new.md' : 'from.md.retained'),'utf8'),operation === 'create' ? '' : 'base');await assert.rejects(state.create(root.id,'other.md','file'),{code:'file_identity_uncertain'});
});
test('create refuses text and compact draft identities, preserving stale CAS protection across restart',async context=> {
  const {state,stateDir,root,source,draft,project} = await fixture(context);await rm(join(project,'from.md'));
  const files = await Files.open(stateDir);context.after(()=>files.close());const refused = await files.request({kind:'create',rootId:root.id,path:'from.md',entryKind:'file'});assert.equal(refused.status,409);await assert.rejects(readFile(join(project,'from.md')),{code:'ENOENT'});assert.deepEqual(state.draft(root.id,'from.md').draft,draft);await files.close();
  await writeFile(join(project,'from.md'),source.text);const refreshed = await readText(root,'from.md'),rebased = await state.putDraft(root.id,'from.md',draft.revision,refreshed.revision,'saved',draft.encoding),saved = await state.saveDraft(root.id,'from.md',rebased.revision);await rm(join(project,'from.md'));
  const reopened = new FileState(stateDir);await reopened.load();assert.deepEqual(reopened.draft(root.id,'from.md'),{revision:saved.draft.revision,draft:null});
  await assert.rejects(reopened.create(root.id,'from.md','file'),{code:'file_changed'});await assert.rejects(reopened.move(root.id,'other.md','from.md'),{code:'file_changed'});await assert.rejects(reopened.putDraft(root.id,'from.md',0,saved.draft.base,'stale client',saved.draft.encoding),{code:'stale_revision'});
});
test('failed workspace publication poisons identity after a confirmed effect without closing unrelated state work',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-publication-')),events:string[] = [],store = await StateStore.open(directory,{onChange:name=>events.push(name)});context.after(async()=> {await store.close();await rm(directory,{recursive:true,force:true});});const original = await store.workspace();events.length = 0;
  const persistence = context.mock.method(store as unknown as {atomic(...args:unknown[]):Promise<void>},'atomic',async()=> {throw new Error('EIO');});
  await assert.rejects(store.moveFiles('root','from','to',async()=>result),{code:'file_identity_uncertain',retry:'manual'});persistence.mock.restore();assert.equal((await store.workspace(original.id)).revision,0);assert.deepEqual(events,[]);
  await assert.rejects(store.updateSelection(original.id,{expectedRevision:0}),{code:'file_identity_uncertain'});await assert.rejects(store.moveFiles('root','from','other',async()=>result),{code:'file_identity_uncertain'});await store.createWorkspace();
});
test('a concurrent identity failure during persistence cannot be cleared by a late move completion',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-concurrent-')),events:string[] = [],store = await StateStore.open(directory,{onChange:name=>events.push(name)});context.after(async()=> {await store.close();await rm(directory,{recursive:true,force:true});});const original = await store.workspace();events.length = 0;
  const owner = store as unknown as {atomic(...args:unknown[]):Promise<void>},atomic = owner.atomic.bind(owner);let entered!:()=>void,release!:()=>void;const writing = new Promise<void>(resolve=> {entered = resolve;}),hold = new Promise<void>(resolve=> {release = resolve;});
  const persistence = context.mock.method(owner,'atomic',async(...args:unknown[])=> {entered();await hold;return atomic(...args);});const move = assert.rejects(store.moveFiles('root','from','to',async()=>result),{code:'file_identity_uncertain'});await writing;store.fileIdentityFailed();release();await move;persistence.mock.restore();
  assert.deepEqual(events,[]);assert.equal((await store.workspace(original.id)).revision,0);await assert.rejects(store.updateSelection(original.id,{expectedRevision:0}),{code:'file_identity_uncertain'});await store.createWorkspace();
});
test('create refuses a retained destination layout before it dispatches project work',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-create-layout-')),store = await StateStore.open(directory);context.after(async()=> {await store.close();await rm(directory,{recursive:true,force:true});});const original = await store.workspace();
  const tab:FileTab = {kind:'file',rootId:'root',path:'to/note.md',view:'preview'};await store.updateSelection(original.id,{expectedRevision:0,conversationLayout:{root:{kind:'pane',id:'files',tabs:[tab],active:workspaceTabKey(tab)},focusedPane:'files'}});let started = false;
  await assert.rejects(store.createFiles('root','to',async()=> {started = true;return result;}),{code:'file_changed'});assert.equal(started,false);
});
