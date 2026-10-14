import assert from 'node:assert/strict';
import test from 'node:test';
import {FileOwner} from './file-owner.ts';
import {FileRootChoice} from './file-root.ts';
import {fileSource, type FileText, type FileRootSelection, type FileDraft, type FileSave} from '../shared/files.ts';
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise = new Promise<T>((yes,no)=> {resolve=yes;reject=no;});return {promise,resolve,reject};}
const text:FileText = {rootId:'r',path:'note.md',text:'\ufeffexact\r\nlast\r',revision:{size:20,mtimeMs:1,digest:'a'.repeat(64)}};
test('source owner deduplicates reads, freezes exact source and refuses mismatched responses',async()=> {
  const read = deferred<FileText>();let reads = 0;
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},()=> {reads++;return read.promise;},()=>{});
  const first = owner.load(), second = owner.load();assert.equal(first,second);assert.equal(reads,1);read.resolve(text);await first;
  assert.equal(owner.source?.text,text.text);assert.ok(Object.isFrozen(owner.source));assert.ok(Object.isFrozen(owner.source?.revision));await owner.load();assert.equal(reads,1);
  const wrong = new FileOwner('w',owner.tab,async()=>({...text,rootId:'other'}),()=>{});await wrong.load();assert.match(wrong.error ?? '',/identity/);assert.equal(wrong.source,undefined);
});
test('refresh generation guards success, errors and loading after disposal',async()=> {
  const reads = [deferred<FileText>(),deferred<FileText>()];let index = 0,paints = 0;
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},()=>reads[index++]?.promise ?? Promise.reject(),()=> {paints++;});
  const old = owner.load(), fresh = owner.load(true);reads[0]?.reject(new Error('late error'));await old;assert.equal(owner.loading,true);assert.equal(owner.error,undefined);
  owner.dispose();const before = paints;reads[1]?.resolve(text);await fresh;assert.equal(owner.source,undefined);assert.equal(paints,before);
});
test('refresh pauses input before draft drain and resumes only after both reads settle',async()=> {
  const disk = {...text,text:'base'}, update = deferred<FileDraft>(), fresh = deferred<FileText>();let reads = 0,stored:FileDraft|undefined;
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},()=>++reads === 1 ? Promise.resolve(disk) : fresh.promise,()=>{}, {
    draft:async()=>({revision:stored?.revision ?? 0,draft:stored ?? null}),put:()=>update.promise,save:async()=> {throw new Error('unused');},
  });
  await owner.load();owner.edit('draft');const writing = owner.drain();await new Promise(resolve=>setImmediate(resolve));
  const refreshing = owner.load(true);assert.equal(owner.loading,true);owner.edit('blocked');assert.equal(owner.text,'draft');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);stored = {revision:1,base:disk.revision,text:'draft',encoding:fileSource(disk.text).encoding};update.resolve(stored);await writing;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,2);assert.equal(owner.loading,true);fresh.resolve(disk);await refreshing;
  assert.equal(owner.text,'draft');assert.equal(owner.acknowledged,'draft');assert.equal(owner.loading,false);owner.edit('new edit');assert.equal(owner.text,'new edit');owner.dispose();
});
test('draft acknowledgments and captured saves never replace newer native source',async()=> {
  const disk:FileText = {...text,text:'base',revision:{...text.revision,size:4}}, saving = deferred<FileSave>(), puts:string[] = [];let revision = 0;
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},async()=>disk,()=>{}, {
    draft:async()=>({revision:0,draft:null}),put:async(_w,_tab,_revision,base,value,encoding)=> {puts.push(value);return {revision:++revision,base,encoding,text:value};},save:()=>saving.promise,
  });
  await owner.load();owner.edit('captured');const work = owner.save();await new Promise(resolve=>setImmediate(resolve));assert.equal(owner.saving,true);
  owner.edit('newer');const source = {...disk,text:'captured',revision:{size:8,mtimeMs:2,digest:'b'.repeat(64)}};
  saving.resolve({source,draft:{revision:++revision,base:source.revision,encoding:fileSource(source.text).encoding,text:'captured'}});await work;await owner.drain();
  assert.equal(owner.text,'newer');assert.equal(owner.acknowledged,'newer');assert.equal(owner.source?.text,'captured');assert.equal(owner.modified,true);assert.deepEqual(puts,['captured','newer']);owner.dispose();
});
test('a restored stale draft keeps its text and explicit re-read alone replaces it',async()=> {
  const disk:FileText = {...text,text:'new disk'}, draft:FileDraft = {revision:2,base:{...text.revision,digest:'b'.repeat(64)},encoding:fileSource('old disk').encoding,text:'unsaved'};
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},async()=>disk,()=>{}, {draft:async()=>({revision:2,draft}),put:async(_w,_tab,revision,base,value,encoding)=>({revision:revision+1,base,text:value,encoding}),save:async()=> {throw new Error('The file changed on disk.');}});
  await owner.load();assert.equal(owner.conflict,true);assert.equal(owner.text,'unsaved');await assert.rejects(owner.save());assert.equal(owner.text,'unsaved');assert.equal(owner.modified,true);
  const rereading = owner.reread();assert.equal(owner.loading,true);owner.edit('blocked during re-read');assert.equal(owner.text,'unsaved');await rereading;
  assert.equal(owner.text,'new disk');assert.equal(owner.conflict,false);assert.equal(owner.replacement,1);assert.equal(owner.loading,false);owner.dispose();
});
test('root initialization uses its captured folder and explicit choice wins over an old response',async()=> {
  const old = deferred<FileRootSelection>(), calls:string[] = [];
  const selected:FileRootSelection = {revision:1,root:{id:'chosen',path:'/chosen',name:'chosen'}};
  let gets = 0;const root = new FileRootChoice({get:async()=>++gets === 1 ? old.promise : {revision:0,root:null},put:async(workspace,path)=> {calls.push(`${workspace}:${path}`);return selected;}},()=>{});
  root.observe('a','/primary');await root.choose('/chosen');old.reject(new Error('late'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(root.selection?.root?.id,'chosen');assert.equal(root.loading,false);assert.equal(root.error,undefined);assert.deepEqual(calls,['a:/chosen']);
  root.observe('a','/agent');assert.equal(gets,2);
});
test('root selection never paints late outcomes into another workspace',async()=> {
  const first = deferred<FileRootSelection>();let paints = 0;
  const root = new FileRootChoice({get:async workspace=>workspace === 'a' ? first.promise : {revision:0,root:null},put:async(_workspace,path)=>({revision:1,root:{id:path,path,name:path}})},()=> {paints++;});
  root.observe('a','/first');root.observe('b','/second');await new Promise(resolve=>setImmediate(resolve));const before = paints;
  first.resolve({revision:1,root:{id:'old',path:'/first',name:'first'}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(root.selection?.root?.path,'/second');assert.equal(paints,before);
});
