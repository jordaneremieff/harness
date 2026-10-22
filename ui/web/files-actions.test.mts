import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
const {HostNode, byId, hostDocument, settle} = await createAppFixture();
type HostNode = InstanceType<typeof HostNode>;
import {FilesTree,type FileTreeAction} from './files-tree.ts';
import {contextMenu} from './context-menu.ts';
import type {FileDirectoryPage,FileEntry} from '../shared/files.ts';
const root = {id:'r',path:'/project',name:'project'};
function page(path:string,entries:FileEntry[]):FileDirectoryPage {return {rootId:'r',path,entries,revision:'v',nextCursor:null,coverage:{complete:true,visited:entries.length}};}
function fixture(context:test.TestContext,operation:(action:FileTreeAction,path:string,value?:string)=>Promise<undefined|(()=>void)>,addToMessage?:(root:string,path:string)=>void) {
  const node = new HostNode('div');byId('workspace').append(node);context.after(()=> {node.remove();contextMenu.close();});
  const statuses:string[] = [];let entries:FileEntry[] = [{name:'folder',path:'folder',kind:'directory'},{name:'note.md',path:'note.md',kind:'file'}];
  const tree = new FilesTree(node as unknown as HTMLElement,{page:async(_root,path)=>page(path,path ? [] : entries),select:()=>{},escape:()=>{},addToMessage,operation:async(_root,action,path,value)=>operation(action,path,value),status:message=>statuses.push(message)});tree.setRoot(root);
  return {node,tree,statuses,entries:(value:FileEntry[])=> {entries = value;}};
}
function row(node:HostNode,path:string):HostNode {const found = node.querySelector(`[data-path="${path}"]`);assert.ok(found);return found;}
function field(node:HostNode):HostNode {const input = node.querySelector('.file-name-input');assert.ok(input);return input;}
test('Add to message captures only a regular file before destructive operations',async context=> {
  const added:unknown[] = [],mutations:unknown[] = [];const {node,entries,tree} = fixture(context,async(...args)=> {mutations.push(args);},(...args)=>added.push(args));await settle();
  const file = row(node,'note.md');file.dispatch('contextmenu',{clientX:10,clientY:10});let menu = hostDocument.body.querySelector('.context-menu');assert.ok(menu);const labels = menu.children.map(item=>item.textContent);assert.ok(labels.indexOf('Add to message') < labels.indexOf('Move to Trash'));menu.children.find(item=>item.textContent === 'Add to message')?.click();assert.deepEqual(added,[['r','note.md']]);assert.deepEqual(mutations,[]);
  row(node,'folder').dispatch('contextmenu',{clientX:10,clientY:10});menu = hostDocument.body.querySelector('.context-menu');assert.ok(menu);assert.equal(menu.children.some(item=>item.textContent === 'Add to message'),false);contextMenu.close();
  entries([{name:'link',path:'link',kind:'symlink'}]);tree.invalidate('r',['']);await settle();row(node,'link').dispatch('contextmenu',{clientX:10,clientY:10});assert.equal(contextMenu.openNow,false);
});
test('keyboard rename, new file, folder and move use a retained inline input',async context=> {
  const calls:unknown[] = [];const {node,tree,entries} = fixture(context,async(...args)=> {calls.push(args);});await settle();
  const original = row(node,'note.md');original.focus();node.dispatch('keydown',{target:original,key:'F2'});const input = field(node);assert.equal(input.value,'note.md');input.value = 'typed.ts';input.setSelectionRange(2,5);entries([{name:'early',path:'early',kind:'file'},{name:'note.md',path:'note.md',kind:'file'}]);tree.invalidate('r',['']);await settle();
  assert.equal(field(node),input);assert.equal(hostDocument.activeElement,input);assert.deepEqual([input.selectionStart,input.selectionEnd],[2,5]);input.dispatch('keydown',{key:'Enter'});await settle();assert.deepEqual(calls[0],['rename','note.md','typed.ts']);
  const folder = row(node,'early');node.dispatch('keydown',{target:folder,key:'n',ctrlKey:true});const newFile = field(node);newFile.value = 'new.md';newFile.dispatch('keydown',{key:'Enter'});await settle();assert.deepEqual(calls[1],['file','','new.md']);
  node.dispatch('keydown',{target:node,key:'n',metaKey:true,shiftKey:true});field(node).value = 'new-folder';field(node).dispatch('keydown',{key:'Enter'});await settle();assert.deepEqual(calls[2],['directory','','new-folder']);
  row(node,'note.md').dispatch('contextmenu',{clientX:10,clientY:10});const menu = hostDocument.body.querySelector('.context-menu');assert.ok(menu);menu.children.find(item=>item.textContent === 'Move')?.click();const move = field(node);assert.equal(move.getAttribute('aria-label'),'Destination path from working folder');move.value = 'folder/moved.md';move.dispatch('keydown',{key:'Enter'});await settle();assert.deepEqual(calls[3],['move','note.md','folder/moved.md']);
});
test('live repaint retains the row label and icon children through a pointer interaction',async context=> {
  const {node,tree,entries} = fixture(context,async()=>{});await settle();const original = row(node,'note.md'),children = [...original.children],label = original.querySelector('.file-name');assert.ok(label);label.dispatch('mousedown');tree.selectFile('r','note.md');tree.invalidate('r',['']);await settle();assert.equal(row(node,'note.md'),original);assert.deepEqual(original.children.map((child,index)=>child === children[index]),[true,true]);assert.equal(original.querySelector('.file-name'),label);assert.equal(label.parentNode,original);const folder = row(node,'folder'),folderLabel = folder.querySelector('.file-name');tree.remap({rootId:'r',from:'folder',to:'renamed-folder'});assert.equal(row(node,'renamed-folder'),folder);assert.equal(folder.querySelector('.file-name'),folderLabel);assert.equal(original.querySelector('.file-name'),label);assert.equal(label.parentNode,original);
  entries([{name:'folder',path:'folder',kind:'directory'},{name:'changed name',path:'note.md',kind:'directory'}]);tree.invalidate('r',['']);await settle();assert.deepEqual(original.children.map((child,index)=>child === children[index]),[true,true]);assert.equal(label.textContent,'changed name');assert.equal(original.getAttribute('aria-expanded'),'false');assert.equal(original.children[0].getAttribute('class'),'card-icon card-icon-folder');label.dispatch('mouseup');original.click();await settle();assert.equal(original.getAttribute('aria-expanded'),'true');assert.equal(original.children[0].getAttribute('class'),'card-icon card-icon-folder-open');
});
test('invalid names and refused operations retain the input and report only through status',async context=> {
  const {node,statuses} = fixture(context,async()=> {throw new Error('Destination already exists.');});await settle();
  node.dispatch('keydown',{target:row(node,'note.md'),key:'F2'});const input = field(node);input.value = 'folder/name';input.dispatch('keydown',{key:'Enter'});await settle();assert.match(statuses.at(-1) ?? '',/without a separator/);assert.equal(field(node),input);
  input.value = 'existing.md';input.dispatch('keydown',{key:'Enter'});await settle();assert.equal(field(node),input);assert.equal(input.readOnly,false);assert.match(statuses.at(-1) ?? '',/already exists/);assert.doesNotMatch(node.textContent,/already exists/);
  input.dispatch('keydown',{key:'Escape'});assert.equal(node.querySelector('.file-name-input'),null);
});
test('tree menu and keyboard Trash each capture the exact entry without a routine dialog',async context=> {
  const calls:unknown[] = [];const {node} = fixture(context,async(...args)=> {calls.push(args);});await settle();const file = row(node,'note.md');
  node.dispatch('keydown',{target:file,key:'F10',shiftKey:true});const menu = hostDocument.body.querySelector('.context-menu');assert.ok(menu);menu.children.find(item=>item.textContent === 'Move to Trash')?.click();await settle();assert.deepEqual(calls,[['trash','note.md',undefined]]);
  node.dispatch('keydown',{target:file,key:'Delete'});await settle();assert.deepEqual(calls.at(-1),['trash','note.md',undefined]);
});
for (const change of ['none','focus','scope'] as const) test(`file completion follows naming removal only for the same focused scope: ${change}`,async context=> {
  let release!:(completed:()=>void)=>void,calls = 0;
  const pending = new Promise<()=>void>(resolve=> {release = resolve;}),{node,tree} = fixture(context,async()=>pending);await settle();
  node.dispatch('keydown',{target:node,key:'n',ctrlKey:true});const input = field(node);input.value = 'created.txt';input.dispatch('keydown',{key:'Enter'});
  if (change === 'focus') byId('workbench-version').focus();
  if (change === 'scope') tree.setRoot(root,'different-workspace');
  release(()=> {calls++;assert.equal(node.querySelector('.file-name-input'),null);});await settle();
  assert.equal(calls,change === 'none' ? 1 : 0);
});
test('inline name buttons submit and cancel through the captured tree operation',async context=> {
  const calls:unknown[] = [];let completed = 0;
  const {node} = fixture(context,async(...args)=> {calls.push(args);return ()=> {completed++;assert.equal(node.querySelector('.file-name-input'),null);};});await settle();
  node.dispatch('contextmenu',{clientX:10,clientY:10});
  hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').find(item=>item.textContent === 'New file')?.click();
  const input = field(node),commit = node.querySelector('[aria-label="Confirm name"]'),cancel = node.querySelector('[aria-label="Cancel name"]');assert.ok(commit);assert.ok(cancel);
  input.value = 'touch.txt';input.dispatch('keydown',{key:'Enter',isComposing:true});assert.equal(calls.length,0);
  commit.focus();commit.click();await settle();assert.deepEqual(calls,[['file','','touch.txt']]);assert.equal(completed,1);
  node.dispatch('keydown',{target:row(node,'note.md'),key:'F2'});const changed = field(node),dismiss = node.querySelector('[aria-label="Cancel name"]');assert.ok(dismiss);changed.value = 'do-not-write.txt';dismiss.focus();dismiss.click();await settle();
  assert.equal(node.querySelector('.file-name-input'),null);assert.equal(calls.length,1);assert.equal(hostDocument.activeElement,row(node,'note.md'));
});
for (const change of ['none','focus','scope'] as const) test(`touch name completion retains exact pending ownership: ${change}`,async context=> {
  let release!:(value:()=>void)=>void,completed = 0,calls = 0;
  const pending = new Promise<()=>void>(resolve=> {release = resolve;}),{node,tree} = fixture(context,async()=> {calls++;return pending;});await settle();
  node.dispatch('keydown',{target:node,key:'n',ctrlKey:true});field(node).value = 'touch.txt';
  const commit = node.querySelector('[aria-label="Confirm name"]'),cancel = node.querySelector('[aria-label="Cancel name"]');assert.ok(commit);assert.ok(cancel);commit.focus();commit.click();
  assert.equal(commit.disabled,true);assert.equal(cancel.disabled,true);commit.click();cancel.click();assert.equal(calls,1);
  if (change === 'focus') byId('workbench-version').focus();
  if (change === 'scope') tree.setRoot(root,'replacement');
  release(()=> {completed++;});await settle();assert.equal(completed,change === 'none' ? 1 : 0);
  if (change === 'scope') {commit.click();cancel.click();assert.equal(calls,1);}
});
test('refused touch naming restores the same field and both actions',async context=> {
  const {node,statuses} = fixture(context,async()=> {throw new Error('Destination exists.');});await settle();
  node.dispatch('keydown',{target:row(node,'note.md'),key:'F2'});const input = field(node),commit = node.querySelector('[aria-label="Confirm name"]'),cancel = node.querySelector('[aria-label="Cancel name"]');assert.ok(commit);assert.ok(cancel);
  input.value = 'duplicate';commit.focus();commit.click();await settle();assert.equal(field(node),input);assert.equal(commit.disabled,false);assert.equal(cancel.disabled,false);assert.equal(hostDocument.activeElement,input);assert.equal(statuses.at(-1),'Destination exists.');
});
test('directory bursts coalesce an in-flight listing and retain disclosed branches',async context=> {
  let finish!:(value:FileDirectoryPage)=>void,reads = 0;const delayed = new Promise<FileDirectoryPage>(resolve=> {finish = resolve;});const node = new HostNode('div');byId('workspace').append(node);context.after(()=>node.remove());
  const tree = new FilesTree(node as unknown as HTMLElement,{page:async(_root,path)=> {reads++;if (reads === 2) return delayed;return page(path,path ? [{name:'child',path:'folder/child',kind:'file'}] : [{name:'folder',path:'folder',kind:'directory'}]);},select:()=>{},escape:()=>{}});tree.setRoot(root);await settle();row(node,'folder').click();for (let index = 0;index < 200;index++) tree.invalidate('r',['folder']);assert.equal(reads,2);finish(page('folder',[]));await settle();assert.equal(reads,3);assert.equal(row(node,'folder').getAttribute('aria-expanded'),'true');assert.ok(row(node,'folder/child'));
});
