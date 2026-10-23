import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture, HostNode} from './app-fixture.mts';
const {app, arrive, event, settle, byId, hostDocument, transportLog} = await createAppFixture();
import {createPaneLayout,splitPane} from './pane-layout.ts';
import {movedWorkspaceFiles} from './file-identity.ts';
import type {FileTab} from '../shared/api.ts';
import type {FileDraft} from '../shared/files.ts';
import {contextMenu} from './context-menu.ts';
function files(context:test.TestContext) {
  const previous = globalThis.fetch;context.after(()=> {globalThis.fetch = previous;contextMenu.close();});let clock = 1,revision = 0,moved = false,failedText:string|undefined;const disk = new Map([['note.md','# Base']]);const drafts = new Map<string,FileDraft>();let failedCode:'file_missing'|'file_changed' = 'file_missing';
  function draftResponse(path:string,body?:FileDraft & {expectedRevision?:number},method?:string):Response {
    if (method === 'PUT' && body && body.text === failedText) return Response.json({ok:false,error:{code:failedCode,message:failedCode === 'file_changed' ? 'The disk identity no longer matches.' : 'The file is missing.'}},{status:failedCode === 'file_changed' ? 409 : 404});
    if (method === 'PUT' && body) {const draft = {...body,revision:++revision};delete draft.expectedRevision;drafts.set(path,draft);return Response.json({ok:true,data:draft});}
    return Response.json({ok:true,data:{revision:drafts.get(path)?.revision ?? 0,draft:drafts.get(path) ?? null}});
  }
  function read(url:URL,body?:FileDraft & {expectedRevision?:number},method?:string):Response|undefined {
    const path = url.searchParams.get('path') ?? '';
    if (url.pathname.endsWith('/files/root')) return Response.json({ok:true,data:{revision:1,root:{id:'root',path:'/project',name:'project'}}});
    if (url.pathname.endsWith('/directory')) return Response.json({ok:true,data:{rootId:'root',path,entries:[...disk.keys()].map(path=>({path,name:path,kind:'file'})),revision:String(clock),nextCursor:null,coverage:{complete:true,visited:disk.size}}});
    if (url.pathname.endsWith('/text')) {const text = disk.get(path);if (text === undefined) return Response.json({ok:false,error:{code:'file_missing',message:'The file or directory is unavailable.'}},{status:404});return Response.json({ok:true,data:{rootId:'root',path,text,revision:{size:text.length,mtimeMs:clock,digest:String(clock).repeat(64)}}});}
    if (url.pathname.endsWith('/draft')) return draftResponse(path,body,method);
    return undefined;
  }
  function mutation(url:URL,body:{from:string;to:string;path:string;kind:string},method?:string):Response|undefined {
    const path = url.searchParams.get('path') ?? '';
    if (url.pathname.endsWith('/move')) {const text = disk.get(body.from);assert.notEqual(text,undefined);disk.delete(body.from);disk.set(body.to,text as string);const draft = drafts.get(body.from);if (draft) {drafts.delete(body.from);drafts.set(body.to,draft);}moved = true;event('files.changed',{rootId:'root',directories:[''],files:[body.to],rescan:false,watch:'live',move:{from:body.from,to:body.to,kind:'file'}});return Response.json({ok:true,data:{rootId:'root',operation:'move',path:body.to,kind:'file',previousPath:body.from}});}
    if (url.pathname.endsWith('/entries')) {disk.set(body.path,'');return Response.json({ok:true,data:{rootId:'root',operation:'create',path:body.path,kind:body.kind}});}
    if (url.pathname.endsWith('/entry') && method === 'DELETE') {disk.delete(path);return Response.json({ok:true,data:{rootId:'root',operation:'trash',path,kind:'file'}});}
    return undefined;
  }
  globalThis.fetch = async(input,init)=> {
    const url = new URL(String(input),'http://ui.test'),body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const result = read(url,body,init?.method) ?? mutation(url,body,init?.method);if (result) return result;
    const response = await previous(input,init);if (moved && url.pathname === '/api/snapshot') {const data = await response.json();data.data.workspace = {...movedWorkspaceFiles(data.data.workspace,{rootId:'root',from:'note.md',to:'renamed.ts'}),revision:data.data.workspace.revision + 1};return Response.json(data);}return response;
  };
  return {disk,failDraft(text:string,code:typeof failedCode = 'file_missing') {failedText = text;failedCode = code;},change(path:string,text:string) {disk.set(path,text);clock++;event('files.changed',{rootId:'root',directories:[''],files:[path],rescan:false,watch:'live'});}};
}
test('watch PUTs use the page scope ID and ready resends the full current scope',async context=> {
  files(context);await arrive({workspace:{id:'page-watch',revision:1,conversationLayout:createPaneLayout([])},primaries:[],roster:[],targets:[]});await settle();const puts = ()=>transportLog.filter(call=>call.method === 'PUT' && call.path.endsWith('/files/watch'));const before = puts().length;assert.equal((puts().at(-1)?.body as {clientId:string})?.clientId,app.fileWatch.clientId);event('ready',{bootId:'boot'});await settle();assert.equal(puts().length,before + 1,JSON.stringify(puts().slice(before).map(call=>call.body)));assert.deepEqual(puts().at(-1)?.body,{clientId:app.fileWatch.clientId,roots:[{rootId:'root',files:[],directories:['']}]});
});
test('live file events preserve typed drafts and show conflict and watcher recovery beside the file',async context=> {
  const fixture = files(context),tab:FileTab = {kind:'file',rootId:'root',path:'note.md'};await arrive({workspace:{id:'live-files',revision:1,conversationLayout:createPaneLayout([tab])},primaries:[],roster:[],targets:[]});const workspace = app.state.workspace;assert.ok(workspace);const view = app.filesViews.view(workspace,tab);await view.owner.load();await settle();const editor = view.editor;assert.ok(editor);
  fixture.change('note.md','# External');await settle();assert.equal(editor.value,'# External');editor.value = '# Local';(editor as unknown as HostNode).dispatch('input');fixture.change('note.md','# Another');await settle();assert.equal(editor.value,'# Local');assert.equal(view.owner.conflict,true);assert.match(byId('workbench-activity').textContent,/changed on disk/);assert.equal(byId('workbench-status').hidden,true);assert.match(view.root.querySelector('.file-feedback')?.textContent??'',/changed on disk/);
  await view.owner.drain();event('files.changed',{rootId:'root',directories:[],files:[],rescan:false,watch:'unavailable',reason:'Watch unavailable.'});await settle();assert.equal(byId('files-tree').textContent.includes('Watch unavailable'),false);assert.match(view.root.querySelector('.file-feedback')?.textContent??'',/Watch unavailable/);assert.ok(view.root.querySelector('.file-feedback')?.querySelectorAll('button').find(node=>node.textContent==='Refresh files'));
  fixture.disk.delete('note.md');event('files.changed',{rootId:'root',directories:[''],files:['note.md'],rescan:false,watch:'live'});await settle();assert.equal(view.owner.missing,true);assert.equal(editor.value,'# Local');assert.match(byId('workbench-activity').textContent,/unavailable.*Draft retained/);
});
test('first draft HTTP refusal shows existing conflict controls without a disk event and preserves the native source',async context=> {
  const fixture = files(context),tab:FileTab = {kind:'file',rootId:'root',path:'note.md'};fixture.failDraft('# Local','file_changed');
  await arrive({workspace:{id:'refused-draft',revision:1,conversationLayout:createPaneLayout([tab])},primaries:[],roster:[],targets:[]});const workspace = app.state.workspace;assert.ok(workspace);const view = app.filesViews.view(workspace,tab);await view.owner.load();await settle();const editor = view.editor;assert.ok(editor);const parent = editor.parentNode,acknowledged = view.owner.acknowledged,source = view.owner.source;
  editor.value = '# Local';editor.setSelectionRange(2,6,'backward');(editor as unknown as HostNode).dispatch('input');await assert.rejects(view.owner.drain(),/identity/);
  assert.equal(view.owner.conflict,true);assert.equal(view.owner.text,'# Local');assert.equal(view.owner.acknowledged,acknowledged);assert.equal(view.owner.source,source);assert.equal(view.owner.canDispose,false);assert.equal(editor.parentNode,parent);assert.equal(editor.value,'# Local');assert.equal(editor.readOnly,false);assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,6,'backward']);assert.match(byId('workbench-activity').textContent,/File changed on disk\. Local edits not saved\./);
  const controls = byId('focused-composer-status').querySelectorAll('button');assert.ok(controls.find(button=>button.textContent === 'Keep editing'));const reread = controls.find(button=>button.textContent === 'Re-read file');assert.ok(reread);reread.click();await settle();assert.equal(view.owner.conflict,false);assert.equal(view.owner.canDispose,true);assert.equal(editor.value,'# Base');
});
test('new file shows directly for typing and Trash uses one worded confirmation while drafts stay',async context=> {
  const focus = HostNode.prototype.focus;
  context.mock.method(HostNode.prototype,'focus',function(this:HostNode) {if (this.closest('[hidden],[inert]')) return;focus.call(this);});
  const fixture = files(context);await arrive({workspace:{id:'create-files',revision:1,conversationLayout:createPaneLayout([])},primaries:[],roster:[],targets:[]});await settle();app.showNavigationView('files');
  const tree = byId('files-tree');tree.dispatch('keydown',{target:tree,key:'n',ctrlKey:true});const input = tree.querySelector('.file-name-input');assert.ok(input);input.value = 'new.md';input.dispatch('keydown',{key:'Enter'});await settle();await settle();
  assert.equal(fixture.disk.get('new.md'),'');const workspace = app.state.workspace;assert.ok(workspace);const tab:FileTab = {kind:'file',rootId:'root',path:'new.md'},view = app.filesViews.view(workspace,tab),editor = view.editor;assert.ok(editor);assert.equal(editor.hidden,false);assert.equal(editor.readOnly,false);assert.equal(hostDocument.activeElement,editor);
  editor.value = 'recoverable';(editor as unknown as HostNode).dispatch('input');await view.owner.drain();const row = tree.querySelector('[data-path="new.md"]');assert.ok(row);tree.dispatch('keydown',{target:row,key:'Delete'});assert.equal(byId('modal').open,true);assert.equal(byId('modal-title').textContent,'Move to Trash?');assert.match(byId('modal-body').textContent,/Unsaved drafts stay available/);byId('modal-body').querySelectorAll('button').find(button=>button.textContent === 'Move to Trash')?.click();await settle();await settle();
  assert.equal(byId('modal').open,false);assert.equal(fixture.disk.has('new.md'),false);assert.equal(view.owner.text,'recoverable');assert.equal(view.owner.missing,true);assert.equal(app.filesViews.view(app.state.workspace as typeof workspace,tab),view);
});
for (const phase of ['mutation','source'] as const) test(`new file completion preserves deliberate focus during ${phase}`,async context=> {
  const fixture = files(context),workspaceId = `create-focus-${phase}`;
  await arrive({workspace:{id:workspaceId,revision:1,conversationLayout:createPaneLayout([])},primaries:[],roster:[],targets:[]});await settle();
  const previous = globalThis.fetch;let release!:()=>void,started!:()=>void;
  const gate = new Promise<void>(resolve=> {release = resolve;}),pending = new Promise<void>(resolve=> {started = resolve;});
  globalThis.fetch = async(input,init)=> {const url = new URL(String(input),'http://ui.test');if (phase === 'mutation' ? url.pathname.endsWith('/entries') : url.pathname.endsWith('/text') && url.searchParams.get('path') === 'delayed.md') {started();await gate;}return previous(input,init);};
  const tree = byId('files-tree');tree.dispatch('keydown',{target:tree,key:'n',ctrlKey:true});const input = tree.querySelector('.file-name-input');assert.ok(input);input.value = 'delayed.md';input.dispatch('keydown',{key:'Enter'});await pending;
  const chosen = byId('workbench-version');chosen.focus();release();await settle();await settle();
  assert.equal(fixture.disk.get('delayed.md'),'');assert.equal(hostDocument.activeElement,chosen);assert.equal(tree.querySelector('.file-name-input'),null);
  if (phase === 'mutation') assert.equal(app.state.workspace?.conversationLayout?.root.kind === 'pane' ? app.state.workspace.conversationLayout.root.tabs.length : -1,0);
});
for (const change of ['pane','workspace'] as const) test(`file completion does not cross a changed ${change}`,async context=> {
  files(context);const workspaceId = `creation-${change}`;
  await arrive({workspace:{id:workspaceId,revision:1,conversationLayout:createPaneLayout([])},primaries:[],roster:[],targets:[]});await settle();
  const previous = globalThis.fetch;let release!:()=>void,started!:()=>void;
  const gate = new Promise<void>(resolve=> {release = resolve;}),pending = new Promise<void>(resolve=> {started = resolve;});
  globalThis.fetch = async(input,init)=> {const url = new URL(String(input),'http://ui.test');if (url.pathname.endsWith('/text') && url.searchParams.get('path') === 'pending.md') {started();await gate;}return previous(input,init);};
  const tree = byId('files-tree');tree.dispatch('keydown',{target:tree,key:'n',ctrlKey:true});const input = tree.querySelector('.file-name-input');assert.ok(input);input.value = 'pending.md';input.dispatch('keydown',{key:'Enter'});await pending;
  if (change === 'pane') {const layout = app.state.workspace?.conversationLayout;assert.ok(layout);app.applyLayout(splitPane(layout,layout.focusedPane,'x',{width:1600,height:900,divider:4}));}
  else await arrive({workspace:{id:'another-creation-workspace',revision:1,conversationLayout:createPaneLayout([])},primaries:[],roster:[],targets:[]});
  const chosenLayout = structuredClone(app.state.workspace?.conversationLayout);release();await settle();await settle();
  assert.deepEqual(app.state.workspace?.conversationLayout,chosenLayout);
  assert.notEqual(hostDocument.activeElement?.getAttribute('aria-label'),'pending.md');
  if (change === 'workspace') assert.equal(app.state.workspace?.id,'another-creation-workspace');
});
test('a closed destination collision exposes distinct retained text through the bottom line after authoritative repaint',async context=> {
  const fixture = files(context),source:FileTab = {kind:'file',rootId:'root',path:'note.md'},destination:FileTab = {...source,path:'missing.md'};fixture.disk.set(destination.path,'# Previous destination');fixture.failDraft('# Unacknowledged destination');
  await arrive({workspace:{id:'retained-files',revision:1,conversationLayout:createPaneLayout([source,destination])},primaries:[],roster:[],targets:[]});const workspace = app.state.workspace;assert.ok(workspace);
  const sourceView = app.filesViews.view(workspace,source),targetView = app.filesViews.view(workspace,destination);await Promise.all([sourceView.owner.load(),targetView.owner.load()]);const editor = targetView.editor;assert.ok(editor);editor.value = '# Unacknowledged destination';(editor as unknown as HostNode).dispatch('input');await assert.rejects(targetView.owner.drain(),/missing/);
  event('workspace.changed',{...workspace,revision:2,conversationLayout:createPaneLayout([])});await settle();assert.equal(app.filesViews.canDispose,false);
  fixture.disk.delete(source.path);fixture.disk.set(destination.path,'# Base');event('files.changed',{rootId:'root',directories:[''],files:[destination.path],rescan:false,watch:'live',move:{from:source.path,to:destination.path,kind:'file'}});
  event('workspace.changed',{...workspace,revision:3,conversationLayout:createPaneLayout([destination])});await settle();await settle();
  assert.equal(app.filesViews.owner(workspace.id,destination),sourceView.owner);assert.equal(sourceView.owner.text,'# Base');assert.equal(targetView.owner.text,'# Unacknowledged destination');assert.equal(app.filesViews.canDispose,false);
  const review = byId('file-retained-drafts');assert.equal(review.hidden,false);review.click();assert.equal(byId('modal-title').textContent,'Retained draft');const retainedText = byId('modal-body').querySelector('textarea');assert.ok(retainedText);assert.equal(retainedText.readOnly,true);assert.equal(retainedText.value,'# Unacknowledged destination');assert.equal(retainedText.getAttribute('aria-label'),'Retained draft: missing.md');
  byId('modal-body').querySelectorAll('button').find(button=>button.textContent === 'Close')?.click();assert.equal(app.filesViews.canDispose,false);review.click();byId('modal-body').querySelectorAll('button').find(button=>button.textContent === 'Discard retained draft')?.click();assert.equal(byId('modal-title').textContent,'Discard retained draft?');byId('modal-body').querySelectorAll('button').find(button=>button.textContent === 'Cancel')?.click();assert.equal(app.filesViews.canDispose,false);
  review.click();byId('modal-body').querySelectorAll('button').find(button=>button.textContent === 'Discard retained draft')?.click();byId('modal-body').querySelectorAll('button').find(button=>button.textContent === 'Discard retained draft')?.click();await settle();assert.equal(app.filesViews.retained().length,0);assert.equal(review.hidden,true);assert.equal(sourceView.owner.text,'# Base');assert.equal(app.filesViews.canDispose,true);
});
test('inline rename follows stream identity before workspace repaint and preserves native source nodes',async context=> {
  files(context);const tab:FileTab = {kind:'file',rootId:'root',path:'note.md'},preview:FileTab = {...tab,view:'preview'};await arrive({workspace:{id:'move-files',revision:1,conversationLayout:createPaneLayout([tab,preview])},primaries:[],roster:[],targets:[]});app.filesTree.setRoot({id:'root',path:'/project',name:'project'},'move-files');await settle();const workspace = app.state.workspace;assert.ok(workspace);const source = app.filesViews.view(workspace,tab),reading = app.filesViews.view(workspace,preview);await source.owner.load();const editor = source.editor;assert.ok(editor);editor.value = '# Draft';editor.setSelectionRange(2,5,'backward');(editor as unknown as HostNode).dispatch('input');await source.owner.drain();const parent = editor.parentNode;
  const row = byId('files-tree').querySelector('[data-path="note.md"]');assert.ok(row);byId('files-tree').dispatch('keydown',{target:row,key:'F2'});const input = byId('files-tree').querySelector('.file-name-input');assert.ok(input);input.value = 'renamed.ts';input.dispatch('keydown',{key:'Enter'});await settle();await settle();
  const current = app.state.workspace;assert.ok(current);const next = {...tab,path:'renamed.ts'};assert.ok(app.filesViews.view(current,next)===source,'Rename retains the exact source FileView');assert.ok(app.filesViews.view(current,{...next,view:'preview'})===reading,'Rename retains the exact preview FileView');assert.equal(editor.parentNode,parent);assert.equal(editor.value,'# Draft');assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,5,'backward']);assert.equal(source.owner.tab.path,'renamed.ts');assert.equal(hostDocument.body.querySelector('.file-name-input'),null);
});
