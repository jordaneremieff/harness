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
test('same root in another workspace invalidates every late directory outcome',async context=> {
  const host = node();context.after(()=>host.remove());let reject!:(error:Error)=>void,reads = 0;
  const old = new Promise<FileDirectoryPage>((_resolve,no)=> {reject=no;});
  const tree = new FilesTree(host as unknown as HTMLElement,{page:async()=>++reads === 1 ? old : page('',[{name:'fresh',path:'fresh',kind:'file'}]),select:()=>{},escape:()=>{}});
  tree.setRoot(root,'a');tree.setRoot(root,'b');await settle();reject(new Error('old failure'));await settle();assert.equal(host.textContent.includes('old failure'),false);assert.ok(row(host,'fresh'));
});
