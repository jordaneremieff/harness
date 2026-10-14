import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileState} from './file-state.mts';
import {StateStore} from './state.mts';
import {readText} from './file-access.mts';
import {fileSource,type FileMutation} from '../shared/files.ts';
import {workspaceTabKey,type ConversationLayout,type FileTab} from '../shared/api.ts';
test('directory moves migrate drafts, every workspace view and position before refusing old writes',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-remap-')),stateDir = join(directory,'state'),project = join(directory,'project');await mkdir(stateDir);await mkdir(project);await mkdir(join(project,'folder'));await writeFile(join(project,'folder','note.md'),'base');
  const events:string[] = [],store = await StateStore.open(stateDir,{onChange:name=>events.push(name)}),files = new FileState(stateDir);context.after(async()=> {await store.close();await rm(directory,{recursive:true,force:true});});await files.load();
  const one = await store.workspace(),two = await store.createWorkspace(),three = await store.createWorkspace(),selected = await files.select(one.id,project,0);assert.ok(selected.root);const root = files.root(selected.root.id),source = await readText(root,'folder/note.md');
  const draft = await files.putDraft(root.id,'folder/note.md',0,source.revision,'unsaved draft',fileSource(source.text).encoding);
  const sourceTab:FileTab = {kind:'file',rootId:root.id,path:'folder/note.md'},preview:FileTab = {...sourceTab,view:'preview'},sourceKey = workspaceTabKey(sourceTab),previewKey = workspaceTabKey(preview);
  const layout:ConversationLayout = {root:{kind:'split',id:'split',axis:'x',ratio:50,first:{kind:'pane',id:'source',tabs:[sourceTab],active:sourceKey},second:{kind:'pane',id:'preview',tabs:[preview],active:previewKey}},focusedPane:'source'};
  for (const workspace of [one,two]) await store.updateSelection(workspace.id,{expectedRevision:0,conversationLayout:layout,filePositions:{[sourceKey]:{scrollTop:80,scrollLeft:2},[previewKey]:{scrollTop:120,scrollLeft:0}}});events.length = 0;
  let admitted!:()=>void,release!:()=>void;const entered = new Promise<void>(resolve=> {admitted = resolve;}),hold = new Promise<void>(resolve=> {release = resolve;});
  const moving = store.moveFiles(root.id,'folder','renamed',async()=> {admitted();await hold;return files.move(root.id,'folder','renamed');});await entered;
  const stale = assert.rejects(store.updateSelection(one.id,{expectedRevision:1,conversationLayout:layout}),{code:'stale_revision'}),ghost = assert.rejects(store.updateSelection(three.id,{expectedRevision:0,conversationLayout:layout}),{code:'stale_revision'});release();await moving;await stale;await ghost;
  assert.deepEqual(events,['files.changed','workspace.changed','workspace.changed','workspace.changed']);
  assert.equal((await store.workspace(three.id)).revision,1);
  for (const workspace of [one,two]) {const moved = await store.workspace(workspace.id);assert.equal(moved.revision,2);assert.deepEqual(moved.filePositions?.[workspaceTabKey({...sourceTab,path:'renamed/note.md'})],{scrollTop:80,scrollLeft:2});assert.equal(moved.conversationLayout?.root.kind,'split');}
  assert.deepEqual(files.draft(root.id,'renamed/note.md').draft,draft);assert.deepEqual(files.draft(root.id,'folder/note.md'),{revision:0,draft:null});
  await assert.rejects(files.putDraft(root.id,'folder/note.md',draft.revision,source.revision,'ghost',fileSource(source.text).encoding),{code:'stale_revision'});
  await assert.rejects(files.putDraft(root.id,'folder/note.md',0,source.revision,'ghost',fileSource(source.text).encoding),{code:'ENOENT'});
  const reopened = new FileState(stateDir);await reopened.load();assert.deepEqual(reopened.draft(root.id,'renamed/note.md').draft,draft);assert.equal(await readFile(join(project,'renamed','note.md'),'utf8'),'base');
});
test('saved destination state refuses moves before any effect even without a source draft',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-collision-'));context.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(join(directory,'state'));await mkdir(join(directory,'project'));await writeFile(join(directory,'project','source.md'),'source');await writeFile(join(directory,'project','destination.md'),'destination');
  const files = new FileState(join(directory,'state'));await files.load();const selection = await files.select('00000000-0000-4000-8000-000000000001',join(directory,'project'),0);assert.ok(selection.root);const root = files.root(selection.root.id),disk = await readText(root,'destination.md');
  const draft = await files.putDraft(root.id,'destination.md',0,disk.revision,'retained',fileSource(disk.text).encoding);await rm(join(directory,'project','destination.md'));
  await assert.rejects(files.move(root.id,'source.md','destination.md'),{code:'file_changed'});assert.equal(await readFile(join(directory,'project','source.md'),'utf8'),'source');assert.deepEqual(files.draft(root.id,'destination.md').draft,draft);
});
test('delayed first destination drafts refuse a replaced base while acknowledged conflict edits remain retained',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-first-draft-'));context.after(()=>rm(directory,{recursive:true,force:true}));const stateDir = join(directory,'state'),project = join(directory,'project');await mkdir(stateDir);await mkdir(project);await writeFile(join(project,'source.md'),'source');await writeFile(join(project,'destination.md'),'destination');
  const files = new FileState(stateDir);await files.load();const selection = await files.select('00000000-0000-4000-8000-000000000001',project,0);assert.ok(selection.root);const root = files.root(selection.root.id),old = await readText(root,'destination.md');await rm(join(project,'destination.md'));await files.move(root.id,'source.md','destination.md');
  await assert.rejects(files.putDraft(root.id,'destination.md',0,old.revision,'another document draft',fileSource(old.text).encoding),{code:'file_changed'});assert.deepEqual(files.draft(root.id,'destination.md'),{revision:0,draft:null});
  const fresh = await readText(root,'destination.md'),encoding = fileSource(fresh.text).encoding;await assert.rejects(files.putDraft(root.id,'destination.md',0,fresh.revision,'wrong encoding',{...encoding,bom:!encoding.bom}),{code:'file_changed'});assert.equal(await readFile(join(project,'destination.md'),'utf8'),'source');
  const acknowledged = await files.putDraft(root.id,'destination.md',0,fresh.revision,'acknowledged draft',encoding);await writeFile(join(project,'destination.md'),'external');
  const kept = await files.putDraft(root.id,'destination.md',acknowledged.revision,acknowledged.base,'keep editing',acknowledged.encoding);assert.equal(kept.text,'keep editing');await assert.rejects(files.saveDraft(root.id,'destination.md',kept.revision),{code:'file_changed'});assert.deepEqual(files.draft(root.id,'destination.md').draft,kept);
});
test('workspace destination collision refuses before the worker starts',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-layout-collision-')),store = await StateStore.open(directory);context.after(async()=> {await store.close();await rm(directory,{recursive:true,force:true});});const workspace = await store.workspace();
  const tabs:FileTab[] = [{kind:'file',rootId:'root',path:'from.md'},{kind:'file',rootId:'root',path:'to.md'}];const first = tabs[0];assert.ok(first);await store.updateSelection(workspace.id,{expectedRevision:0,conversationLayout:{root:{kind:'pane',id:'files',tabs,active:workspaceTabKey(first)},focusedPane:'files'}});
  let started = false;await assert.rejects(store.moveFiles('root','from.md','to.md',async()=> {started = true;return {} as FileMutation;}),{code:'file_changed'});assert.equal(started,false);
});
test('source and destination preview identities refuse without choosing a tab or position winner',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-view-collision-')),events:string[] = [],store = await StateStore.open(directory,{onChange:name=>events.push(name)});context.after(async()=> {await store.close();await rm(directory,{recursive:true,force:true});});const workspace = await store.workspace();
  const source:FileTab = {kind:'file',rootId:'root',path:'from.md'},destination:FileTab = {...source,path:'to.md',view:'preview'},sourceKey = workspaceTabKey(source),destinationKey = workspaceTabKey(destination);
  const saved = await store.updateSelection(workspace.id,{expectedRevision:0,conversationLayout:{root:{kind:'pane',id:'files',tabs:[source,destination],active:sourceKey},focusedPane:'files'},filePositions:{[sourceKey]:{scrollTop:10,scrollLeft:0},[destinationKey]:{scrollTop:20,scrollLeft:0}}});events.length = 0;
  let started = false;await assert.rejects(store.moveFiles('root','from.md','to.md',async()=> {started = true;return {} as FileMutation;}),{code:'file_changed',status:409,retry:'read'});
  assert.equal(started,false);assert.deepEqual(await store.workspace(workspace.id),saved);assert.deepEqual(events,[]);
});
test('destination document prefixes in another workspace refuse even without a source view there',async context=> {
  const directory = await mkdtemp(join(tmpdir(),'ui-file-workspace-prefix-')),store = await StateStore.open(directory);context.after(async()=> {await store.close();await rm(directory,{recursive:true,force:true});});const one = await store.workspace(),two = await store.createWorkspace();
  const source:FileTab = {kind:'file',rootId:'root',path:'from/child.md'},destination:FileTab = {...source,path:'to/nested.md',view:'preview'};
  for (const [workspace,tab] of [[one,source],[two,destination]] as const) await store.updateSelection(workspace.id,{expectedRevision:0,conversationLayout:{root:{kind:'pane',id:'files',tabs:[tab],active:workspaceTabKey(tab)},focusedPane:'files'}});
  let started = false;await assert.rejects(store.moveFiles('root','from','to',async()=> {started = true;return {} as FileMutation;}),{code:'file_changed'});assert.equal(started,false);assert.equal((await store.workspace(one.id)).revision,1);assert.equal((await store.workspace(two.id)).revision,1);
  await store.moveFiles('root','from','unrelated',async()=>({rootId:'root',operation:'move',path:'unrelated',previousPath:'from',kind:'directory'}));assert.equal((await store.workspace(one.id)).revision,2);
});
