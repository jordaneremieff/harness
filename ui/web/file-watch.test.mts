import assert from 'node:assert/strict';
import test from 'node:test';
import {FileWatch} from './file-watch.ts';
import {movedWorkspaceFiles,movedFilePath} from './file-identity.ts';
import {workspaceTabKey,type FileTab} from '../shared/api.ts';
import {createPaneLayout} from './pane-layout.ts';
import type {FileWatchState} from '../shared/files.ts';
test('watch scope writes deduplicate stable renders and coalesce in-flight changes',async()=> {
  let resolve!:(state:FileWatchState)=>void;const first = new Promise<FileWatchState>(yes=> {resolve = yes;});const calls:string[] = [];
  const watch = new FileWatch({put:async(_workspace,roots)=> {calls.push(roots[0]?.files.join(',') ?? '');return calls.length === 1 ? first : {roots:[{rootId:'r',watch:'live'}]};},changed:()=>{}});
  const scope = (files:string[])=>[{rootId:'r',directories:[''],files}];const work = watch.scope('w',scope(['a']));void watch.scope('w',scope(['b']));void watch.scope('w',scope(['c']));assert.deepEqual(calls,['a']);resolve({roots:[{rootId:'r',watch:'live'}]});await work;assert.deepEqual(calls,['a','c']);await watch.scope('w',scope(['c']));assert.equal(calls.length,2);
  watch.change({rootId:'r',directories:[],files:[],rescan:false,watch:'unavailable',reason:'Directory watch dropped.'});assert.match(watch.status,/unavailable.*dropped/);watch.change({rootId:'r',directories:[],files:[],rescan:false,watch:'live'});assert.equal(watch.status,'');
});
test('watch refusal has one quiet state and no automatic retry loop',async()=> {
  let calls = 0;const watch = new FileWatch({put:async()=> {calls++;throw new Error('Watch capacity reached.');},changed:()=>{}});
  const roots = [{rootId:'r',directories:[''],files:[]}];await watch.scope('w',roots);await watch.scope('w',roots);assert.equal(calls,1);assert.match(watch.status,/capacity/);await watch.scope('w',roots,true);assert.equal(calls,2);
});
test('folder identity maps source, preview, active keys and positions but not neighboring prefixes',()=> {
  const source:FileTab = {kind:'file',rootId:'r',path:'old/child.md'},preview:FileTab = {...source,view:'preview'},other:FileTab = {...source,path:'older/child.md'};
  const workspace = {id:'w',revision:2,conversationLayout:createPaneLayout([source,preview,other]),filePositions:{[workspaceTabKey(source)]:{scrollTop:20,scrollLeft:5},[workspaceTabKey(preview)]:{scrollTop:30,scrollLeft:0}}};
  const moved = movedWorkspaceFiles(workspace,{rootId:'r',from:'old',to:'new'});assert.equal(moved.revision,2);assert.equal(movedFilePath(other.path,{from:'old',to:'new'}),other.path);assert.ok(moved.filePositions?.[workspaceTabKey({...source,path:'new/child.md'})]);assert.ok(moved.filePositions?.[workspaceTabKey({...preview,path:'new/child.md'})]);assert.equal(moved.filePositions?.[workspaceTabKey(source)],undefined);
  const pane = moved.conversationLayout?.root;assert.ok(pane?.kind === 'pane');assert.deepEqual(pane.tabs.map(tab=>tab.kind === 'file' ? tab.path : ''),['new/child.md','new/child.md','older/child.md']);
});
