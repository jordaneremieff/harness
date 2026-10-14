import assert from 'node:assert/strict';
import test from 'node:test';
import {FileOwner} from './file-owner.ts';
import {FileRootChoice} from './file-root.ts';
import {ApiError} from './transport.ts';
import {fileSource, type FileText, type FileRootSelection, type FileDraft, type FileSave, type FileRevision} from '../shared/files.ts';
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
  const disk:FileText = {...text,text:'base',revision:{...text.revision,size:4}}, saving = deferred<FileSave>(), puts:string[] = [],bases:FileRevision[] = [];let revision = 0;
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},async()=>disk,()=>{}, {
    draft:async()=>({revision:0,draft:null}),put:async(_w,_tab,_revision,base,value,encoding)=> {puts.push(value);bases.push(base);return {revision:++revision,base,encoding,text:value};},save:()=>saving.promise,
  });
  await owner.load();owner.edit('captured');const work = owner.save();await new Promise(resolve=>setImmediate(resolve));assert.equal(owner.saving,true);
  owner.edit('newer');const source = {...disk,text:'captured',revision:{size:8,mtimeMs:2,digest:'b'.repeat(64)}};
  saving.resolve({source,draft:{revision:++revision,base:source.revision,encoding:fileSource(source.text).encoding,text:'captured'}});await work;await owner.drain();
  assert.equal(owner.text,'newer');assert.equal(owner.acknowledged,'newer');assert.equal(owner.source?.text,'captured');assert.equal(owner.modified,true);assert.deepEqual(puts,['captured','newer']);assert.deepEqual(bases,[disk.revision,source.revision]);owner.dispose();
});
test('unload protection covers unacknowledged input, queued writes and errors but releases acknowledged drafts',async()=> {
  const disk = {...text,text:'base'}, writing = deferred<FileDraft>();let revision = 0;
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},async()=>disk,()=>{}, {
    draft:async()=>({revision:0,draft:null}),put:()=>writing.promise,save:async()=> {throw new Error('save failed');},
  });
  await owner.load();assert.equal(owner.canDispose,true);owner.edit('draft');assert.equal(owner.canDispose,false);
  const drain = owner.drain();assert.equal(owner.canDispose,false);await new Promise(resolve=>setImmediate(resolve));assert.equal(owner.persisting,true);
  writing.resolve({revision:++revision,base:disk.revision,text:'draft',encoding:fileSource(disk.text).encoding});await drain;
  assert.equal(owner.modified,true);assert.equal(owner.canDispose,true);
  const saving = owner.save();assert.equal(owner.canDispose,false);await assert.rejects(saving,/save failed/);assert.equal(owner.canDispose,false);
  owner.dispose();
  const failed = new FileOwner('w',owner.tab,async()=>disk,()=>{}, {draft:async()=>({revision:0,draft:null}),put:async()=> {throw new Error('draft failed');},save:async()=> {throw new Error('unused');}});
  await failed.load();failed.edit('unacknowledged');await assert.rejects(failed.drain(),/draft failed/);assert.equal(failed.canDispose,false);assert.match(failed.draftError ?? '',/draft failed/);assert.equal(failed.conflict,false);failed.dispose();
});
test('first draft refusal immediately exposes conflict and keeps newer local text without a passive read',async context=> {
  const disk:FileText = {...text,text:'base'},writing = deferred<FileDraft>();let reads = 0;const revisions:number[] = [];
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},async()=> {reads++;return disk;},()=>{}, {
    draft:async()=>({revision:0,draft:null}),put:(_w,_tab,revision)=> {revisions.push(revision);return writing.promise;},save:async()=> {throw new Error('unused');}
  });context.after(()=>owner.dispose());
  await owner.load();const source = owner.source,encoding = owner.encoding;owner.edit('captured');const pending = owner.drain();await new Promise(resolve=>setImmediate(resolve));owner.edit('newer local text');
  const refusal = new ApiError({code:'file_changed',message:'The disk identity no longer matches.'});writing.reject(refusal);await assert.rejects(pending,error=>error === refusal);
  assert.deepEqual(revisions,[0]);assert.equal(reads,1);assert.equal(owner.conflict,true);assert.equal(owner.text,'newer local text');assert.equal(owner.acknowledged,'base');assert.equal(owner.source,source);assert.equal(owner.encoding,encoding);assert.equal(owner.replacement,0);assert.equal(owner.canDispose,false);assert.match(owner.status,/File changed on disk\. Local edits not saved\./);
});
test('read failures do not guard unload unless local text remains unacknowledged',async()=> {
  const unavailable = new FileOwner('w',{kind:'file',rootId:'r',path:'missing.md'},async()=> {throw new Error('read unavailable');},()=>{});
  await unavailable.load();assert.match(unavailable.error ?? '',/read unavailable/);assert.equal(unavailable.canDispose,true);unavailable.dispose();
  let failRead = false;const disk = {...text,text:'base'};
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},async()=> {if (failRead) throw new Error('read unavailable');return disk;},()=>{});
  await owner.load();failRead = true;await owner.reread();assert.match(owner.error ?? '',/read unavailable/);
  assert.equal(owner.text,'base');assert.equal(owner.acknowledged,'base');assert.equal(owner.canDispose,true);
  owner.edit('local text');await owner.reread();assert.equal(owner.canDispose,false);assert.equal(owner.text,'local text');owner.dispose();
});
test('uncertain Save remains guarded through read errors until authoritative recovery succeeds',async()=> {
  for (const recovery of ['refresh','reread','save']) {
    let failRead = false,failSave = true,revision = 0,stored:FileDraft|undefined;const disk = {...text,text:'base'};
    const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},async()=> {if (failRead) throw new Error('read unavailable');return disk;},()=>{}, {
      draft:async()=>({revision:stored?.revision ?? 0,draft:stored ?? null}),
      put:async(_w,_tab,_revision,base,value,encoding)=> {stored = {revision:++revision,base,text:value,encoding};return stored;},
      save:async()=> {if (failSave) throw new Error('save acknowledgment lost');stored = {revision:++revision,base:disk.revision,text:'base',encoding:fileSource(disk.text).encoding};return {source:disk,draft:stored};},
    });
    await owner.load();await assert.rejects(owner.save(),/save acknowledgment lost/);
    assert.equal(owner.unsaved,false);assert.equal(owner.modified,false);assert.equal(owner.canDispose,false);
    failRead = true;await owner.load(true);assert.match(owner.error ?? '',/read unavailable/);assert.equal(owner.canDispose,false);
    await owner.reread();assert.equal(owner.canDispose,false);
    failRead = false;failSave = false;
    if (recovery === 'refresh') await owner.load(true);else if (recovery === 'reread') await owner.reread();else await owner.save();
    assert.equal(owner.canDispose,true,recovery);owner.dispose();
  }
});
test('compact clean state retains its CAS revision for the next local edit',async()=> {
  const disk = {...text,text:'saved'}, revisions:number[] = [];
  const owner = new FileOwner('w',{kind:'file',rootId:'r',path:'note.md'},async()=>disk,()=>{}, {
    draft:async()=>({revision:8,draft:null}),put:async(_w,_tab,revision,base,value,encoding)=> {revisions.push(revision);return {revision:revision+1,base,text:value,encoding};},save:async()=> {throw new Error('unused');},
  });
  await owner.load();assert.equal(owner.text,'saved');assert.equal(owner.canDispose,true);owner.edit('next');await owner.drain();assert.deepEqual(revisions,[8]);assert.equal(owner.acknowledged,'next');owner.dispose();
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
