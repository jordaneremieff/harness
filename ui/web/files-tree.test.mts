import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
const {HostNode, byId, hostDocument, settle} = await createAppFixture();
type HostNode = InstanceType<typeof HostNode>;
import {FilesTree} from './files-tree.ts';
import type {FileDirectoryPage,FileEntry} from '../shared/files.ts';
const root = {id:'r',path:'/project',name:'project'};
function page(path:string,entries:FileEntry[],complete = true):FileDirectoryPage {return {rootId:'r',path,entries,revision:'v',nextCursor:null,coverage:{complete,visited:entries.length,...(!complete ? {reason:'The scan is incomplete.'} : {})}};}
function node() {const node = new HostNode('div');byId('workspace').append(node);return node;}
function row(node:HostNode,path:string):HostNode {const row = node.querySelector(`[data-path="${path}"]`);assert.ok(row);return row;}
test('disclosure preserves selected files and roving focus skips unsupported and hidden rows',async context=> {
  const host = node();context.after(()=>host.remove());const selected:string[] = [];
  const tree = new FilesTree(host as unknown as HTMLElement,{page:async(_root,path)=>path ? page(path,[{name:'child',path:'folder/child',kind:'file'}]) : page('',[{name:'blocked',path:'blocked',kind:'symlink'},{name:'folder',path:'folder',kind:'directory'},{name:'file',path:'file',kind:'file'}]),select:(_root,path)=>selected.push(path),escape:()=>{}});
  tree.setRoot(root);await settle();assert.equal(row(host,'blocked').tabIndex,-1);assert.equal(row(host,'folder').tabIndex,0);
  row(host,'file').click();row(host,'folder').click();await settle();assert.deepEqual(selected,['file']);assert.equal(row(host,'file').getAttribute('aria-selected'),'true');
  tree.selectFile('r','folder/child');row(host,'folder').click();await settle();assert.equal(row(host,'folder').tabIndex,0);assert.equal(host.querySelector('[data-path="folder/child"]'),null);
  host.dispatch('keydown',{target:row(host,'folder'),key:'ArrowDown'});assert.equal(hostDocument.activeElement,row(host,'file'));
});
test('only regular .DS_Store files disappear from root and nested keyboard rows',async context=> {
  const host=node();context.after(()=>host.remove());const reads:string[]=[],selected:string[]=[];
  const rootEntries:FileEntry[]=[{name:'node_modules',path:'node_modules',kind:'directory'},{name:'.DS_Store',path:'.DS_Store',kind:'file'},{name:'.gitignore',path:'.gitignore',kind:'file'},{name:'.env',path:'.env',kind:'file'},{name:'.ds_store',path:'.ds_store',kind:'file'},{name:'.DS_Store.backup',path:'.DS_Store.backup',kind:'file'}];
  const tree=new FilesTree(host as unknown as HTMLElement,{page:async(_root,path)=>{reads.push(path);return page(path,path?[{name:'.DS_Store',path:'node_modules/.DS_Store',kind:'file'},{name:'package.js',path:'node_modules/package.js',kind:'file'},{name:'nested',path:'node_modules/nested',kind:'directory'}]:rootEntries);},select:(_root,path)=>selected.push(path),escape:()=>{}});
  tree.setRoot(root);await settle();assert.deepEqual(reads,['']);assert.equal(host.querySelector('[data-path=".DS_Store"]'),null);
  for(const path of ['node_modules','.gitignore','.env','.ds_store','.DS_Store.backup'])assert.ok(row(host,path));
  row(host,'node_modules').focus();host.dispatch('keydown',{target:row(host,'node_modules'),key:'ArrowDown'});assert.equal(hostDocument.activeElement,row(host,'.gitignore'));
  row(host,'node_modules').click();await settle();assert.deepEqual(reads,['','node_modules']);assert.equal(host.querySelector('[data-path="node_modules/.DS_Store"]'),null);
  row(host,'node_modules').focus();host.dispatch('keydown',{target:row(host,'node_modules'),key:'ArrowRight'});assert.equal(hostDocument.activeElement,row(host,'node_modules/package.js'));row(host,'node_modules/package.js').click();assert.deepEqual(selected,['node_modules/package.js']);assert.equal(rootEntries.length,6);
});
for(const path of ['', 'folder'])test(`filtered ${path?'nested':'root'} pages preserve incomplete status and their next cursor`,async context=>{
  const host=node();context.after(()=>host.remove());const prefix=path?`${path}/`:'';const cursors:(string|undefined)[]=[];
  const first={...page(path,[{name:'.DS_Store',path:`${prefix}.DS_Store`,kind:'file'}],false),nextCursor:'next-page'};
  const tree=new FilesTree(host as unknown as HTMLElement,{page:async(_root,requested,cursor)=>{if(path&&!requested)return page('',[{name:'folder',path,kind:'directory'}]);cursors.push(cursor);return cursor?page(path,[{name:'.gitignore',path:`${prefix}.gitignore`,kind:'file'}]):first;},select:()=>{},escape:()=>{}});
  tree.setRoot(root);await settle();if(path){row(host,path).click();await settle();}
  assert.equal(host.querySelector(`[data-path="${prefix}.DS_Store"]`),null);assert.match(host.textContent,/incomplete/);assert.doesNotMatch(host.textContent,/No (?:visible )?files/);
  const more=host.querySelector('.file-tree-more');assert.ok(more);more.click();await settle();assert.deepEqual(cursors,[undefined,'next-page']);assert.ok(row(host,`${prefix}.gitignore`));assert.equal(first.entries.length,1);assert.equal(first.nextCursor,'next-page');
});
test('a complete filtered folder says no visible files and preserves same-named nonfiles',async context=>{
  const host=node();context.after(()=>host.remove());let entries:FileEntry[]=[{name:'.DS_Store',path:'.DS_Store',kind:'file'}];
  const tree=new FilesTree(host as unknown as HTMLElement,{page:async()=>page('',entries),select:()=>{},escape:()=>{}});tree.setRoot(root);await settle();assert.match(host.textContent,/No visible files in this folder/);assert.doesNotMatch(host.textContent,/No files in this folder/);assert.equal(host.tabIndex,0);
  for(const kind of ['directory','symlink','other'] as const){entries=[{name:'.DS_Store',path:'.DS_Store',kind}];tree.setRoot(root,kind);await settle();assert.ok(row(host,'.DS_Store'));}
});
test('Right on an expanded empty folder stays there rather than reaching its sibling',async context=> {
  const host = node();context.after(()=>host.remove());
  const tree = new FilesTree(host as unknown as HTMLElement,{page:async(_root,path)=>page(path,path ? [] : [{name:'empty',path:'empty',kind:'directory'},{name:'sibling',path:'sibling',kind:'file'}]),select:()=>{},escape:()=>{}});
  tree.setRoot(root);await settle();row(host,'empty').click();await settle();row(host,'empty').focus();host.dispatch('keydown',{target:row(host,'empty'),key:'ArrowRight'});assert.equal(hostDocument.activeElement,row(host,'empty'));
});
test('incomplete empty listings and mismatched responses never claim an empty folder',async context=> {
  const host = node();context.after(()=>host.remove());
  const tree = new FilesTree(host as unknown as HTMLElement,{page:async()=>page('',[],false),select:()=>{},escape:()=>{}});tree.setRoot(root);await settle();assert.match(host.textContent,/incomplete/);assert.doesNotMatch(host.textContent,/No files/);
  const mismatch = new FilesTree(host as unknown as HTMLElement,{page:async()=>({...page('',[]),rootId:'wrong'}),select:()=>{},escape:()=>{}});mismatch.setRoot(root);await settle();assert.match(host.textContent,/identity/);assert.doesNotMatch(host.textContent,/No files/);
});
for (const pending of ['queued', 'loading'] as const) test(`collapse survives a ${pending} directory refresh`,async context=> {
  const host=node();context.after(()=>host.remove());const frames=new Map<number,FrameRequestCallback>();let frame=0;
  context.mock.method(globalThis,'requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++frame,callback);return frame;});
  context.mock.method(globalThis,'cancelAnimationFrame',(id:number)=>{frames.delete(id);});
  const flush=()=>{const queued=[...frames.values()];frames.clear();for(const callback of queued)callback(0);};
  const reads:string[]=[],scopes:string[][]=[];let finish!:(value:FileDirectoryPage)=>void;
  const delayed=new Promise<FileDirectoryPage>(resolve=>{finish=resolve;});
  const children=page('folder',[{name:'child',path:'folder/child',kind:'file'}]);
  const tree=new FilesTree(host as unknown as HTMLElement,{page:async(_root,path)=>{reads.push(path);return !path?page('',[{name:'folder',path:'folder',kind:'directory'}]):pending==='loading'&&reads.length===2?delayed:children;},scope:()=>{scopes.push(tree.disclosed());},select:()=>{},escape:()=>{}});
  tree.setRoot(root);await settle();assert.deepEqual(reads,['']);
  row(host,'folder').click();await settle();tree.invalidate('r',['folder']);
  row(host,'folder').click();assert.equal(row(host,'folder').getAttribute('aria-expanded'),'false');
  finish(children);await settle();flush();await settle();
  assert.equal(row(host,'folder').getAttribute('aria-expanded'),'false');assert.equal(host.querySelector('[data-path="folder/child"]'),null);
  assert.deepEqual(tree.disclosed(),['']);assert.deepEqual(scopes.at(-1),['']);assert.deepEqual(reads,['','folder']);
  row(host,'folder').click();assert.ok(row(host,'folder/child'));tree.invalidate('r',['folder']);flush();await settle();
  assert.equal(row(host,'folder').getAttribute('aria-expanded'),'true');assert.deepEqual(reads,['','folder','folder']);assert.ok(row(host,'folder/child'));
});
test('same root in another workspace invalidates every late directory outcome',async context=> {
  const host = node();context.after(()=>host.remove());let reject!:(error:Error)=>void,reads = 0;
  const old = new Promise<FileDirectoryPage>((_resolve,no)=> {reject=no;});
  const tree = new FilesTree(host as unknown as HTMLElement,{page:async()=>++reads === 1 ? old : page('',[{name:'fresh',path:'fresh',kind:'file'}]),select:()=>{},escape:()=>{}});
  tree.setRoot(root,'a');tree.setRoot(root,'b');await settle();reject(new Error('old failure'));await settle();assert.equal(host.textContent.includes('old failure'),false);assert.ok(row(host,'fresh'));
});
