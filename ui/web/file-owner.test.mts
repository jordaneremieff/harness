import assert from 'node:assert/strict';
import test from 'node:test';
import {FileOwner} from './file-owner.ts';
import {FileRootChoice} from './file-root.ts';
import type {FileText,FileRootSelection} from '../shared/files.ts';
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
