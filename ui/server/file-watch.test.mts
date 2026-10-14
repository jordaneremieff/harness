import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,rename,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileWatches,type WatchFactory} from './file-watch.mts';
import {registerRoot,directoryPage} from './file-access.mts';
import {LIMITS} from '../shared/api.ts';
import type {FileChanges} from '../shared/files.ts';
class Watcher extends EventEmitter {closed = false;close() {this.closed = true;this.emit('close');}}
function requiredHandle(handles:Map<string,Watcher>,path:string):Watcher {const handle = handles.get(path);assert.ok(handle);return handle;}
async function setup(context:test.TestContext) {
  const path = await mkdtemp(join(tmpdir(),'ui-file-watch-'));await mkdir(join(path,'visible'));await mkdir(join(path,'hidden'));const root = await registerRoot(path,'root');
  const handles = new Map<string,Watcher>(),events:{change:FileChanges;workspace:string}[] = [];let delivered:((change:FileChanges)=>void)|undefined;
  const factory = ((path:string,_options:unknown,callback:(event:string,name:string|null)=>void)=> {const handle = new Watcher();handle.on('hint',name=>callback('rename',name));handles.set(path,handle);return handle;}) as unknown as WatchFactory;
  const watches = new FileWatches(id=> {assert.equal(id,'root');return root;},(change,workspace)=> {events.push({change,workspace});delivered?.(change);delivered = undefined;},factory);
  context.after(async()=> {watches.close();await rm(path,{recursive:true,force:true});});context.mock.timers.enable({apis:['setTimeout']});
  const next = ()=>new Promise<FileChanges>(resolve=> {delivered = resolve;});
  return {path:root.path,watches,handles,events,next};
}
test('scoped watches share handles, coalesce hints and ignore unrelated undisclosed files',{timeout:5000},async context=> {
  const {path,watches,handles,events,next} = await setup(context);
  assert.deepEqual(await watches.replace('one','page',[{rootId:'root',directories:['visible'],files:['hidden/open.md']}]),{roots:[{rootId:'root',watch:'live'}]});
  await watches.replace('two','page',[{rootId:'root',directories:['visible'],files:[]}]);assert.equal(handles.size,2);assert.ok(!handles.has(path));
  const baseline = next();context.mock.timers.tick(LIMITS.fileWatchCoalesceMs);await baseline;events.length = 0;
  const pending = next();requiredHandle(handles,join(path,'hidden')).emit('hint','other.md');requiredHandle(handles,join(path,'hidden')).emit('hint','open.md');requiredHandle(handles,join(path,'hidden')).emit('hint','open.md');context.mock.timers.tick(LIMITS.fileWatchCoalesceMs);
  const change = await pending;assert.deepEqual(change.files,['hidden/open.md']);assert.deepEqual(change.directories,[]);assert.ok(events.every(event=>event.workspace === 'one'));
  events.length = 0;const visible = next();for (let i = 0;i < 1000;i++) requiredHandle(handles,join(path,'visible')).emit('hint',`file-${i}.md`);context.mock.timers.tick(LIMITS.fileWatchCoalesceMs);
  const burst = await visible;assert.equal(burst.rescan,true);assert.ok(burst.files.length+burst.directories.length <= LIMITS.fileChangePaths);assert.ok(Buffer.byteLength(JSON.stringify(burst)) < 34*1024);
  await watches.release('one','page');assert.equal(requiredHandle(handles,join(path,'hidden')).closed,true);assert.equal(requiredHandle(handles,join(path,'visible')).closed,false);
  await watches.release('two','page');assert.equal(requiredHandle(handles,join(path,'visible')).closed,true);
});
test('two pages in one workspace retain the union and release only their own handles',async context=> {
  const {path,watches,handles,events,next} = await setup(context);
  await watches.replace('one','page-a',[{rootId:'root',directories:['visible'],files:['visible/open.md']}]);await watches.replace('one','page-b',[{rootId:'root',directories:['hidden'],files:['hidden/open.md']}]);
  assert.equal(requiredHandle(handles,join(path,'visible')).closed,false);assert.equal(requiredHandle(handles,join(path,'hidden')).closed,false);assert.equal(watches.state('one','page-a').roots[0]?.watch,'live');assert.equal(watches.state('one','page-b').roots[0]?.watch,'live');
  const baseline = next();context.mock.timers.tick(LIMITS.fileWatchCoalesceMs);await baseline;events.length = 0;
  const changed = next();requiredHandle(handles,join(path,'visible')).emit('hint','open.md');requiredHandle(handles,join(path,'hidden')).emit('hint','open.md');context.mock.timers.tick(LIMITS.fileWatchCoalesceMs);const event = await changed;
  assert.deepEqual(event.directories,['visible','hidden']);assert.deepEqual(event.files,['visible/open.md','hidden/open.md']);assert.equal(events.length,1);
  await watches.release('one','page-a');assert.equal(requiredHandle(handles,join(path,'visible')).closed,true);assert.equal(requiredHandle(handles,join(path,'hidden')).closed,false);assert.deepEqual(watches.state('one','page-a'),{roots:[]});assert.equal(watches.state('one','page-b').roots[0]?.watch,'live');
  await watches.replace('one','page-a',[{rootId:'root',directories:['visible'],files:[]}]);assert.equal(requiredHandle(handles,join(path,'visible')).closed,false);await watches.replace('one','page-b',[]);assert.equal(requiredHandle(handles,join(path,'hidden')).closed,true);assert.equal(requiredHandle(handles,join(path,'visible')).closed,false);
});
test('unavailable watches emit one quiet state and explicit scope replacement recovers',async context=> {
  const {path,watches,handles,events} = await setup(context);const scope = [{rootId:'root',directories:['visible'],files:[]}];await watches.replace('one','page',scope);events.length = 0;
  requiredHandle(handles,join(path,'visible')).emit('error',new Error('not available'));assert.equal(watches.state('one','page').roots[0]?.watch,'unavailable');assert.equal(events.length,1);assert.equal(requiredHandle(handles,join(path,'visible')).closed,true);
  await watches.replace('one','page',scope);assert.equal(watches.state('one','page').roots[0]?.watch,'live');
  await assert.rejects(watches.replace('one','page',[{rootId:'root',directories:[],files:Array.from({length:LIMITS.fileWatchFiles+1},(_,i)=>`file-${i}`)}]),{code:'capacity'});
  assert.equal(watches.state('one','page').roots[0]?.watch,'live');
});
test('registered open paths refuse destination prefixes across workspaces and exclude moved sources',async context=> {
  const {watches} = await setup(context);await watches.replace('one','page',[{rootId:'root',directories:['visible'],files:['visible/source.md']}]);await watches.replace('two','page',[{rootId:'root',directories:[],files:['hidden/open.md']}]);
  assert.throws(()=>watches.assertMove('root','visible/source.md','hidden/open.md'),{code:'file_changed',status:409});assert.throws(()=>watches.assertMove('root','visible','hidden'),{code:'file_changed'});
  assert.doesNotThrow(()=>watches.assertMove('root','visible','new-folder'));assert.doesNotThrow(()=>watches.assertMove('root','hidden','hidden'));assert.doesNotThrow(()=>watches.assertMove('other-root','visible','hidden'));
  await watches.release('two','page');assert.doesNotThrow(()=>watches.assertMove('root','visible','hidden'));
});
test('one coalesced baseline rescan covers immediate external creates without a watcher handshake',{timeout:5000},async context=> {
  const path = await mkdtemp(join(tmpdir(),'ui-file-watch-baseline-')),root = await registerRoot(path,'root');let receive:((change:FileChanges)=>void)|undefined;
  const watches = new FileWatches(()=>root,change=> {receive?.(change);});context.after(async()=> {watches.close();await rm(path,{recursive:true,force:true});});
  await watches.replace('workspace','page',[{rootId:'root',directories:[''],files:[]}]);
  const event = new Promise<FileChanges>(resolve=> {receive = resolve;});await writeFile(join(path,'early.md'),'early');assert.equal((await event).rescan,true);
  const page = await directoryPage(root,'',200);assert.ok(page.entries.some(entry=>entry.path === 'early.md'));
});
test('replacement of a watched directory degrades instead of following an unverified inode',{timeout:5000},async context=> {
  const {path,watches,handles,next} = await setup(context);await watches.replace('one','page',[{rootId:'root',directories:['visible'],files:[]}]);const pending = next();
  await rename(join(path,'visible'),join(path,'old'));await mkdir(join(path,'visible'));requiredHandle(handles,join(path,'visible')).emit('hint','visible');context.mock.timers.tick(LIMITS.fileWatchCoalesceMs);
  assert.equal((await pending).watch,'unavailable');
});
