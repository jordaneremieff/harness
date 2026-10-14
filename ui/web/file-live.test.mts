import assert from 'node:assert/strict';
import test from 'node:test';
import {FileOwner} from './file-owner.ts';
import {fileSource,type FileText,type FileDraft,type FileRevision} from '../shared/files.ts';
import {mkdtemp,mkdir,writeFile,readFile,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FileState} from '../server/file-state.mts';
import {fileFailure,readText} from '../server/file-access.mts';
import {errorView} from '../server/errors.mts';
import {ApiError} from './transport.ts';
function source(text:string,mtimeMs = 1):FileText {return {rootId:'r',path:'note.md',text,revision:{size:text.length,mtimeMs,digest:String(mtimeMs).repeat(64)}};}
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise = new Promise<T>((yes,no)=> {resolve = yes;reject = no;});return {promise,resolve,reject};}
async function document(context:test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(),'ui-edit-base-')),project = join(directory,'project'),stateDirectory = join(directory,'state');await mkdir(project);await mkdir(stateDirectory);const path = join(project,'note.md');await writeFile(path,'base\n');context.after(()=>rm(directory,{recursive:true,force:true}));
  const state = new FileState(stateDirectory);await state.load();const workspace = randomUUID(),selection = await state.select(workspace,project,0),root = selection.root;assert.ok(root);const bases:FileRevision[] = [];let saves = 0;
  async function request<T>(task:()=>Promise<T>):Promise<T> {try {return await task();} catch(error) {throw new ApiError(errorView(fileFailure(error)));}}
  const owner = new FileOwner(workspace,{kind:'file',rootId:root.id,path:'note.md'},async()=>request(()=>readText(state.root(root.id),'note.md')),()=>{}, {
    draft:async()=>state.draft(root.id,'note.md'),put:async(_w,_tab,revision,base,text,encoding)=> {bases.push({...base});return request(()=>state.putDraft(root.id,'note.md',revision,base,text,encoding));},save:async(_w,_tab,revision)=> {saves++;return request(()=>state.saveDraft(root.id,'note.md',revision));}
  });context.after(()=>owner.dispose());await owner.load();return {owner,state,root,path,bases,saves:()=>saves};
}
test('unacknowledged text keeps its original base across passive changes so Save refuses without changing external bytes',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const fixture = await document(context),{owner,state,root,path,bases} = fixture,base = owner.source?.revision;assert.ok(base);
  owner.edit('local text');const external = Buffer.from('external bytes\n');await writeFile(path,external);await owner.refreshDisk();assert.equal(owner.draft,undefined);assert.equal(owner.text,'local text');assert.equal(owner.conflict,true);assert.notDeepEqual(owner.source?.revision,base);
  await assert.rejects(owner.save(),error=>error instanceof ApiError && error.view.code === 'file_changed');assert.deepEqual(bases,[base]);assert.equal(fixture.saves(),0);assert.deepEqual(await readFile(path),external);assert.equal(owner.text,'local text');assert.equal(owner.acknowledged,'base\n');assert.equal(owner.canDispose,false);assert.equal(owner.replacement,0);assert.equal(state.draft(root.id,'note.md').revision,0);
  await assert.rejects(owner.drain(),error=>error instanceof ApiError && error.view.code === 'file_changed');assert.deepEqual(bases,[base,base]);await owner.load(true);assert.equal(owner.text,'local text');assert.equal(owner.canDispose,false);assert.deepEqual(bases,[base,base,base]);assert.deepEqual(await readFile(path),external);
});
test('clean passive adoption and explicit re-read adopt the matching base and encoding for later edits',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const {owner,path} = await document(context);await writeFile(path,'\ufeffclean\r\n');await owner.refreshDisk();owner.edit('clean edit\n');await owner.save();assert.equal(await readFile(path,'utf8'),'\ufeffclean edit\r\n');assert.equal(owner.conflict,false);
  owner.edit('not saved');await writeFile(path,'replacement\n');await owner.refreshDisk();await assert.rejects(owner.save(),error=>error instanceof ApiError && error.view.code === 'file_changed');await owner.reread();assert.equal(owner.text,'replacement\n');assert.equal(owner.conflict,false);owner.edit('after re-read\n');await owner.save();assert.equal(await readFile(path,'utf8'),'after re-read\n');assert.equal(owner.canDispose,true);
});
test('acknowledged conflict edits retain the stored base and Save refuses changed disk',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const {owner,path,bases} = await document(context),base = owner.source?.revision;owner.edit('acknowledged');await owner.drain();await writeFile(path,'external\n');await owner.refreshDisk();owner.edit('new local text');await owner.drain();assert.deepEqual(bases,[base,base]);
  await assert.rejects(owner.save(),error=>error instanceof ApiError && error.view.code === 'file_changed');assert.equal(await readFile(path,'utf8'),'external\n');assert.equal(owner.text,'new local text');assert.equal(owner.canDispose,false);
});
test('unacknowledged text never adopts the base of a deleted and recreated file',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const {owner,path,bases} = await document(context),base = owner.source?.revision;owner.edit('local text');await unlink(path);await owner.refreshDisk();assert.equal(owner.missing,true);await writeFile(path,'recreated\n');await owner.refreshDisk();
  await assert.rejects(owner.save(),error=>error instanceof ApiError && error.view.code === 'file_changed');assert.deepEqual(bases,[base]);assert.equal(await readFile(path,'utf8'),'recreated\n');assert.equal(owner.text,'local text');assert.equal(owner.canDispose,false);
});
for (const adoption of ['save','reread']) test(`a late passive result never rolls back the authoritative ${adoption} base`,async context=> {
  let disk = source('base'),reads = 0,revision = 0,stored:FileDraft|undefined;const passive = deferred<FileText>(),bases:FileRevision[] = [];
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},()=>++reads === 2 ? passive.promise : Promise.resolve(disk),()=>{}, {
    draft:async()=>({revision:0,draft:null}),put:async(_w,_tab,_revision,base,text,encoding)=> {bases.push(base);stored = {revision:++revision,base,text,encoding};return stored;},save:async()=> {assert.ok(stored);disk = source(stored.text,2);stored = {...stored,revision:++revision,base:disk.revision};return {source:disk,draft:stored};}
  });context.after(()=>owner.dispose());await owner.load();const refreshing = owner.refreshDisk();await new Promise(resolve=>setImmediate(resolve));
  if (adoption === 'save') {owner.edit('saved');await owner.save();} else {disk = source('replacement',2);await owner.reread();}
  const adopted = owner.text;passive.resolve(source('base'));await refreshing;await new Promise(resolve=>setImmediate(resolve));assert.equal(owner.text,adopted);assert.deepEqual(owner.source?.revision,disk.revision);assert.equal(owner.conflict,false);
  owner.edit('after adoption');await owner.drain();assert.deepEqual(bases.at(-1),disk.revision);
});
test('clean disk changes replace source while dirty changes preserve local draft and report conflict',async()=> {
  let disk = source('old');let revision = 0;const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},async()=>disk,()=>{}, {draft:async()=>({revision:0,draft:null}),put:async(_w,_tab,_revision,base,text,encoding)=>({revision:++revision,base,text,encoding}),save:async()=> {throw new Error('unused');}});
  await owner.load();disk = source('new',2);await owner.refreshDisk();assert.equal(owner.text,'new');assert.equal(owner.replacement,1);assert.equal(owner.modified,false);
  owner.edit('local');await owner.drain();disk = source('other',3);await owner.refreshDisk();assert.equal(owner.text,'local');assert.equal(owner.acknowledged,'local');assert.equal(owner.conflict,true);assert.equal(owner.replacement,1);assert.match(owner.status,/changed on disk/);owner.dispose();
});
test('typing during a passive disk read stays editable and is never replaced by the late source',async()=> {
  const read = deferred<FileText>(),disk = source('base');let reads = 0;const bases:FileRevision[] = [];
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},()=>++reads === 1 ? Promise.resolve(disk) : read.promise,()=>{}, {draft:async()=>({revision:0,draft:null}),put:async(_w,_tab,_revision,base)=> {bases.push(base);throw new ApiError({code:'file_changed',message:'The file changed on disk.'});},save:async()=> {throw new Error('unexpected Save');}});
  await owner.load();const refresh = owner.refreshDisk();await new Promise(resolve=>setImmediate(resolve));assert.equal(owner.loading,false);owner.edit('typed meanwhile');read.resolve(source('external',2));await refresh;
  assert.equal(owner.text,'typed meanwhile');assert.equal(owner.conflict,true);assert.equal(owner.replacement,0);await assert.rejects(owner.save(),error=>error instanceof ApiError && error.view.code === 'file_changed');assert.deepEqual(bases,[disk.revision]);owner.dispose();
});
test('missing disk source preserves an acknowledged draft and quiet missing state',async()=> {
  let missing = false;const disk = source('base'),draft:FileDraft = {revision:3,base:disk.revision,encoding:fileSource(disk.text).encoding,text:'retained'};
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},async()=> {if (missing) throw new Error('The file is missing.');return disk;},()=>{}, {draft:async()=>({revision:3,draft}),put:async()=>draft,save:async()=> {throw new Error('missing');}});
  await owner.load();missing = true;await owner.refreshDisk();assert.equal(owner.text,'retained');assert.equal(owner.missing,true);assert.match(owner.status,/missing.*Draft retained/);assert.equal(owner.canDispose,true);owner.dispose();
});
test('identity moves invalidate old disk responses and subsequent draft writes use the new path',async()=> {
  const old = deferred<FileText>();let reads = 0,revision = 0;const paths:string[] = [];
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},()=>++reads === 1 ? Promise.resolve(source('base')) : old.promise,()=>{}, {draft:async()=>({revision:0,draft:null}),put:async(_w,tab,_revision,base,text,encoding)=> {paths.push(tab.path);return {revision:++revision,base,text,encoding};},save:async()=> {throw new Error('unused');}});
  await owner.load();const refresh = owner.refreshDisk();await new Promise(resolve=>setImmediate(resolve));owner.remap('moved.ts');old.resolve(source('stale',2));await refresh;assert.equal(owner.text,'base');assert.equal(owner.tab.path,'moved.ts');assert.equal(owner.source?.path,'moved.ts');assert.equal(owner.replacement,0);
  owner.edit('draft');await owner.drain();assert.deepEqual(paths,['moved.ts']);owner.dispose();
});
test('burst disk notifications retain one active read and one coalesced follow-up',async()=> {
  const changed = deferred<FileText>();let reads = 0;
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},()=> {reads++;return reads === 1 ? Promise.resolve(source('base')) : reads === 2 ? changed.promise : Promise.resolve(source('last',3));},()=>{});
  await owner.load();const first = owner.refreshDisk();await new Promise(resolve=>setImmediate(resolve));for (let index = 0;index < 200;index++) void owner.refreshDisk();assert.equal(reads,2);
  changed.resolve(source('next',2));await first;await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,3);assert.equal(owner.text,'last');owner.dispose();
});
