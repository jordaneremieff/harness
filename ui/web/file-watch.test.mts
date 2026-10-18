import assert from 'node:assert/strict';
import test from 'node:test';
import {FileWatch} from './file-watch.ts';
import {ApiError} from './transport.ts';
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
test('each page owns a distinct scope ID that survives ready resends and workspace changes',async()=> {
  const calls:{workspace:string;clientId:string;files:string[]}[] = [];const hooks = {put:async(workspace:string,roots:import('../shared/files.ts').FileWatchScope[],clientId:string)=> {calls.push({workspace,clientId,files:roots.flatMap(root=>root.files)});return {roots:[]};},changed:()=>{}};
  const first = new FileWatch(hooks),second = new FileWatch(hooks),roots = [{rootId:'r',directories:[''],files:['a']}];assert.match(first.clientId,/^[a-f0-9-]{36}$/);assert.notEqual(first.clientId,second.clientId);
  await first.scope('one',roots);await second.scope('one',[{...roots[0],files:['b']}]);await first.scope('one',roots,true);await first.scope('two',roots);await first.scope('two',[]);
  assert.deepEqual(calls,[{workspace:'one',clientId:first.clientId,files:['a']},{workspace:'one',clientId:second.clientId,files:['b']},{workspace:'one',clientId:first.clientId,files:['a']},{workspace:'two',clientId:first.clientId,files:['a']},{workspace:'two',clientId:first.clientId,files:[]}]);
});
for (const forced of [false,true]) test(`in-flight identical scope coalesces without dropping a forced ready resend: forced=${forced}`,async()=> {
  const response = Promise.withResolvers<FileWatchState>();let calls = 0;const watch = new FileWatch({put:async()=> {calls++;return calls === 1 ? response.promise : {roots:[]};},changed:()=>{}}),roots = [{rootId:'r',directories:[''],files:['a']}];const work = watch.scope('w',roots);void watch.scope('w',roots,forced);response.resolve({roots:[]});await work;assert.equal(calls,forced ? 2 : 1);
});
test('latest scope restores a previous completed scope after a different in-flight write',async()=> {
  const response = Promise.withResolvers<FileWatchState>(),calls:string[] = [];const watch = new FileWatch({put:async(_w,roots)=> {calls.push(roots[0].files[0]);return calls.length === 2 ? response.promise : {roots:[]};},changed:()=>{}}),scope = (file:string)=>[{rootId:'r',directories:[''],files:[file]}];await watch.scope('w',scope('a'));const work = watch.scope('w',scope('b'));void watch.scope('w',scope('a'));response.resolve({roots:[]});await work;assert.deepEqual(calls,['a','b','a']);
});
test('watch refusal has one quiet state and no automatic retry loop',async()=> {
  let calls = 0;const watch = new FileWatch({put:async()=> {calls++;throw new Error('Watch capacity reached.');},changed:()=>{}});
  const roots = [{rootId:'r',directories:[''],files:[]}];await watch.scope('w',roots);await watch.scope('w',roots);assert.equal(calls,1);assert.match(watch.status,/paused/);assert.equal(watch.detail,'Watch capacity reached.');await watch.scope('w',roots,true);assert.equal(calls,2);
});
test('a failed watch write shows one fixed sentence and keeps the browser error out of the shown text',async()=> {
  const watch = new FileWatch({put:async()=> {throw new TypeError('Failed to fetch');},changed:()=>{}});
  await watch.scope('w',[{rootId:'r',directories:[''],files:[]}]);
  assert.equal(watch.status,'Live file updates paused. Use Refresh files.');assert.doesNotMatch(watch.status,/Failed to fetch/);assert.equal(watch.detail,'Failed to fetch');
  const live = new FileWatch({put:async()=> ({roots:[{rootId:'r',watch:'live'}]}),changed:()=>{}});
  await live.scope('w',[{rootId:'r',directories:[''],files:[]}]);assert.equal(live.status,'');assert.equal(live.detail,'');
  const refused = new FileWatch({put:async()=> {throw new ApiError({code:'invalid_request',message:'Watch capacity reached.',retry:'none'});},changed:()=>{}});
  await refused.scope('w',[{rootId:'r',directories:[''],files:[]}]);assert.equal(refused.status,'Live files unavailable. Watch capacity reached.');assert.equal(refused.detail,'');
});
test('folder identity maps source, preview, active keys and positions but not neighboring prefixes',()=> {
  const source:FileTab = {kind:'file',rootId:'r',path:'old/child.md'},preview:FileTab = {...source,view:'preview'},other:FileTab = {...source,path:'older/child.md'};
  const workspace = {id:'w',revision:2,conversationLayout:createPaneLayout([source,preview,other]),filePositions:{[workspaceTabKey(source)]:{scrollTop:20,scrollLeft:5},[workspaceTabKey(preview)]:{scrollTop:30,scrollLeft:0}}};
  const moved = movedWorkspaceFiles(workspace,{rootId:'r',from:'old',to:'new'});assert.equal(moved.revision,2);assert.equal(movedFilePath(other.path,{from:'old',to:'new'}),other.path);assert.ok(moved.filePositions?.[workspaceTabKey({...source,path:'new/child.md'})]);assert.ok(moved.filePositions?.[workspaceTabKey({...preview,path:'new/child.md'})]);assert.equal(moved.filePositions?.[workspaceTabKey(source)],undefined);
  const pane = moved.conversationLayout?.root;assert.ok(pane?.kind === 'pane');assert.deepEqual(pane.tabs.map(tab=>tab.kind === 'file' ? tab.path : ''),['new/child.md','new/child.md','older/child.md']);
});
