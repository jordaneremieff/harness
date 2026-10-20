import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
const {app, arrive, settle, byId, hostDocument, beforeUnload, primaryFixture, primaryControl, agentFixture, targetFixture, transportLog, paneNode, documentHandlers, event, twoPanes} = await createAppFixture();
import {activeTab,tabKey} from './tabs.ts';
import {splitPane,paneLeaves} from './pane-layout.ts';
import {contextMenu} from './context-menu.ts';
import {Composer} from './composer.ts';
import type {FileTab,ConversationLayout} from '../shared/api.ts';
function currentLayout():ConversationLayout {const layout = app.state.workspace?.conversationLayout;assert.ok(layout);return layout;}
function fileTransport(context:test.TestContext):void {
  const previous = globalThis.fetch;context.after(()=> {globalThis.fetch = previous;contextMenu.close();});
  globalThis.fetch = async(input,init)=> {
    const url = new URL(String(input),'http://ui.test');
    if (url.pathname.endsWith('/draft')) return Response.json({ok:true,data:{revision:0,draft:null}});
    if (url.pathname.endsWith('/text')) {const text = '# Exact file\n\nRetained source.\n';return Response.json({ok:true,data:{rootId:decodeURIComponent(url.pathname.split('/')[4] ?? ''),path:url.searchParams.get('path'),text,revision:{size:text.length,mtimeMs:1,digest:'a'.repeat(64)}}});}
    return previous(input,init);
  };
}
async function workingFixture(context:test.TestContext,name:string) {
  fileTransport(context);const target={kind:'primary' as const,key:'p',epoch:940};
  await arrive({workspace:{id:`working-${name}`,revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:940})],roster:[],targets:[targetFixture(`working-target-${name}`,target,{draft:{revision:1,text:'Keep this draft',mode:'prompt',images:[],persisted:true}})]});await settle();
  const root=app.fileRoot.selection?.root?.id;assert.ok(root);const previous=globalThis.fetch,reads:URL[]=[];
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input),'http://ui.test');if(url.pathname.endsWith('/directory')){reads.push(url);const path=url.searchParams.get('path')??'';return Response.json({ok:true,data:{rootId:root,path,entries:[{name:'saved.md',path:path?`${path}/saved.md`:'saved.md',kind:'file'}],nextCursor:null,revision:'r',coverage:{complete:true,visited:1}}});}return previous(input,init);};
  const open=()=>{const sources=primaryControl('composer').querySelector('.attachment-sources');assert.ok(sources);sources.click();const menu=hostDocument.body.querySelector('.context-menu');assert.ok(menu);assert.equal(menu.getAttribute('aria-label'),'Add to message');assert.deepEqual(menu.children.map(node=>node.textContent.replace('@','')),['Add to message','Upload files or images','Reference a file','Run a command/','','Earlier messages']);assert.equal(menu.children[4]?.getAttribute('role'),'separator');assert.equal(menu.children[3]?.getAttribute('aria-keyshortcuts'),'/');assert.equal(menu.children[2]?.getAttribute('aria-keyshortcuts'),'@');menu.children[2]?.click();};
  const add=()=>{byId('modal-body').querySelector('[data-path="saved.md"]')?.click();const button=byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Add file');assert.ok(button);button.click();};
  return {root,reads,open,add,composer:app.primaryComposer(),editor:primaryControl('editor'),target};
}
test('Escape closes the Add menu and returns focus to the add button',async context=>{
  const f=await workingFixture(context,'escape');f.composer.attach('working-escape',undefined);
  const sources=primaryControl('composer').querySelector('.attachment-sources');assert.ok(sources);sources.focus();sources.click();
  const menu=hostDocument.body.querySelector('.context-menu');assert.ok(menu);menu.dispatch('keydown',{key:'Escape'});
  assert.equal(hostDocument.body.querySelector('.context-menu'),null);assert.equal(hostDocument.activeElement,sources);
});
test('composer sources preserve direct local intake and stage saved text for the captured editor',async context=>{
  const f=await workingFixture(context,'intake'),parent=f.editor.parentNode,form=primaryControl('composer'),formParent=form.parentNode,before=transportLog.length;
  f.editor.setSelectionRange(2,5,'backward');const attach=form.querySelector('.attach'),picker=form.querySelector('.composer-intake')?.querySelector('input');assert.ok(attach);assert.ok(picker);let picks=0;picker.addEventListener('click',()=>picks++);attach.click();assert.equal(picks,1);
  form.querySelector('.attachment-sources')?.click();hostDocument.body.querySelector('.context-menu')?.querySelector('[role="menuitem"]')?.click();assert.equal(picks,2);
  f.open();await settle();assert.equal(byId('modal-title').textContent,'Choose working-folder file');assert.equal(byId('modal-body').querySelector('select'),null);assert.equal(f.reads.length,1);assert.equal(f.reads[0]?.searchParams.get('workspace'),'working-intake');
  assert.match(byId('modal-body').textContent,/Destination:.*Unsaved editor changes.*32 KiB.*64 KiB/s);f.add();await settle();
  const staged=f.composer.captureReload()[0]?.attachments?.items[0];assert.ok(staged?.file);assert.equal(await staged.file.text(),'# Exact file\n\nRetained source.\n');assert.equal(staged.state,'text');assert.equal(f.editor.value,'Keep this draft');assert.equal(f.editor.parentNode,parent);assert.equal(form.parentNode,formParent);assert.deepEqual([f.editor.selectionStart,f.editor.selectionEnd,f.editor.selectionDirection],[2,5,'backward']);
  assert.match(byId('modal-body').textContent,/File staged.*Include text.*Nothing was sent/);assert.equal(transportLog.slice(before).some(call=>call.path.endsWith('/inputs')||call.path.endsWith('/prepare')||call.path.endsWith('/start')||call.method==='PUT'&&call.path.endsWith('/text')),false);byId('modal-close').click();
});
test('working-folder navigation filters only loaded entries and pages explicitly with the tree display policy',async context=>{
  const f=await workingFixture(context,'pages'),previous=globalThis.fetch;const pages:URL[]=[];
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input),'http://ui.test');if(!url.pathname.endsWith('/directory'))return previous(input,init);pages.push(url);const path=url.searchParams.get('path')??'',more=url.searchParams.has('cursor');return Response.json({ok:true,data:{rootId:f.root,path,entries:path?[]:more?[{name:'later.md',path:'later.md',kind:'file'}]:[{name:'.DS_Store',path:'.DS_Store',kind:'file'},{name:'.gitignore',path:'.gitignore',kind:'file'},{name:'folder',path:'folder',kind:'directory'},{name:'link',path:'link',kind:'symlink'}],nextCursor:path||more?null:'page-two',revision:'r',coverage:{complete:false,visited:4,reason:'Directory scan bound reached.'}}});};
  f.open();await settle();const body=byId('modal-body'),filter=body.querySelector('.working-file-filter');assert.ok(filter);assert.equal(body.querySelector('[data-path=".DS_Store"]'),null);assert.ok(body.querySelector('[data-path=".gitignore"]'));assert.equal(body.querySelector('[data-path="link"]')?.disabled,true);
  filter.value='later';filter.dispatch('input');assert.match(body.textContent,/No loaded entries match this filter/);assert.match(body.textContent,/Directory scan bound reached/);assert.equal(pages.length,1);const more=body.querySelectorAll('button').find(node=>node.textContent==='More');assert.ok(more);more.focus();more.click();assert.equal(hostDocument.activeElement,filter);await settle();assert.equal(hostDocument.activeElement,filter);assert.equal(more.hidden,true);assert.equal(pages.length,2);assert.equal(pages[1]?.searchParams.get('cursor'),'page-two');assert.ok(body.querySelector('[data-path="later.md"]'));assert.match(body.textContent,/Directory scan bound reached/);
  filter.value='';filter.dispatch('input');body.querySelector('[data-path="folder"]')?.click();await settle();assert.equal(pages[2]?.searchParams.get('path'),'folder');body.querySelectorAll('button').find(node=>node.textContent==='Parent folder')?.click();await settle();assert.equal(pages[3]?.searchParams.get('path'),'');byId('modal-close').click();
});
for(const outcome of ['empty','error','focus-moved','cancel','replacement'] as const)test(`directory keyboard focus survives ${outcome} completion`,async context=>{
  const f=await workingFixture(context,`focus-${outcome}`),previous=globalThis.fetch,reply=Promise.withResolvers<Response>();
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input),'http://ui.test');if(!url.pathname.endsWith('/directory'))return previous(input,init);if(url.searchParams.get('path'))return reply.promise;return Response.json({ok:true,data:{rootId:f.root,path:'',entries:[{name:'folder',path:'folder',kind:'directory'}],nextCursor:null,revision:'r',coverage:{complete:true,visited:1}}});};
  f.open();await settle();const body=byId('modal-body'),filter=body.querySelector('.working-file-filter'),folder=body.querySelector('[data-path="folder"]');assert.ok(filter);assert.ok(folder);folder.focus();folder.click();assert.equal(hostDocument.activeElement,filter);
  if(outcome==='focus-moved'){const cancel=body.querySelectorAll('button').find(node=>node.textContent==='Cancel');assert.ok(cancel);cancel.focus();}
  if(outcome==='cancel')byId('modal-close').click();if(outcome==='replacement')app.addFileToMessage(f.root,'saved.md');const focused=hostDocument.activeElement;
  reply.resolve(outcome==='error'?Response.json({ok:false,error:{code:'file_unavailable',message:'Folder read failed',retry:'read'}},{status:503}):Response.json({ok:true,data:{rootId:f.root,path:'folder',entries:[],nextCursor:null,revision:'r',coverage:{complete:true,visited:0}}}));await settle();assert.equal(hostDocument.activeElement,focused);
  if(outcome==='empty')assert.match(body.textContent,/No files loaded/);if(outcome==='error')assert.match(body.textContent,/Folder read failed/);byId('modal-close').click();
});
test('working-folder directory failures, retry and canceled late pages keep their own presentation',async context=>{
  const f=await workingFixture(context,'directory'),previous=globalThis.fetch;let fails=true;const late=Promise.withResolvers<Response>();let signal:AbortSignal|undefined;
  globalThis.fetch=async(input,init)=>{if(!new URL(String(input),'http://ui.test').pathname.endsWith('/directory'))return previous(input,init);if(fails)return Response.json({ok:false,error:{code:'file_unavailable',message:'Directory unavailable',retry:'read'}},{status:503});signal=init?.signal??undefined;return late.promise;};
  f.open();await settle();assert.match(byId('modal-body').textContent,/Directory unavailable/);assert.doesNotMatch(byId('modal-body').textContent,/Loading files/);fails=false;byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Retry files')?.click();assert.ok(signal);assert.match(byId('modal-body').textContent,/Loading files/);byId('modal-close').click();assert.equal(signal.aborted,true);
  app.addFileToMessage(f.root,'other.md');const before=byId('modal-body').textContent;late.resolve(Response.json({ok:true,data:{rootId:f.root,path:'',entries:[{name:'late.md',path:'late.md',kind:'file'}],nextCursor:null,revision:'r',coverage:{complete:true,visited:1}}}));await settle();assert.equal(byId('modal-body').textContent,before);assert.equal(f.composer.captureReload()[0]?.attachments?.items.length??0,0);byId('modal-close').click();
});
test('an unloaded composer exposes the refusal without directory reads or preparation',async context=>{
  const f=await workingFixture(context,'unloaded');f.composer.attach('working-unloaded',undefined);const before=transportLog.length;primaryControl('composer').querySelector('.attachment-sources')?.click();const choice=hostDocument.body.querySelector('.context-menu')?.children[2];assert.ok(choice);assert.equal(choice.getAttribute('aria-disabled'),'true');assert.equal(choice.textContent.replace('@',''),'Reference a file');assert.match(choice.title,/Draft is not loaded/);assert.match(choice.getAttribute('aria-description')??'',/Draft is not loaded/);choice.click();assert.equal(f.reads.length,0);assert.equal(transportLog.length,before);contextMenu.close();
});
for(const stale of ['cancel','modal','root','workspace','recipient','tab'] as const)test(`composer file read refuses ${stale} replacement`,async context=>{
  const f=await workingFixture(context,stale);f.open();await settle();const response=Promise.withResolvers<Response>(),previous=globalThis.fetch;let signal:AbortSignal|undefined;
  globalThis.fetch=async(input,init)=>{if(new URL(String(input),'http://ui.test').pathname.endsWith('/text')){signal=init?.signal??undefined;return response.promise;}return previous(input,init);};f.add();assert.ok(signal);assert.equal(hostDocument.activeElement?.textContent,'Cancel');
  if(stale==='cancel')byId('modal-close').click();else if(stale==='modal')app.addFileToMessage(f.root,'saved.md');else if(stale==='root')app.fileRoot.selection={revision:999,root:{id:'new-root',path:'/other',name:'other'}};
  else if(stale==='workspace')await arrive({workspace:{id:'replacement-working-workspace',revision:1},primaries:[],roster:[],targets:[]});
  else if(stale==='recipient')event('primary.state',primaryFixture({epoch:941}),f.target);
  else {const pane=paneLeaves(currentLayout().root)[0];assert.ok(pane);app.applyLayout({focusedPane:pane.id,root:{kind:'pane',id:pane.id,tabs:[],active:null}});}
  response.resolve(Response.json({ok:true,data:{rootId:f.root,path:'saved.md',text:'Do not stage',revision:{size:12,mtimeMs:1,digest:'a'.repeat(64)}}}));await settle();assert.equal(f.composer.captureReload()[0]?.attachments?.items.length??0,0);assert.equal(f.editor.value,'Keep this draft');
  if(stale==='cancel'||stale==='modal')assert.equal(signal.aborted,true);else assert.match(byId('modal-error').textContent,/changed/);byId('modal-close').click();
});
for(const refusal of ['binary','oversized','unsafe','failed'] as const)test(`composer saved-file ${refusal} refusal retains its draft and reason`,async context=>{
  const f=await workingFixture(context,refusal);f.open();await settle();const previous=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{if(!new URL(String(input),'http://ui.test').pathname.endsWith('/text'))return previous(input,init);return refusal==='oversized'?Response.json({ok:true,data:{rootId:f.root,path:'saved.md',text:'x'.repeat(32769),revision:{size:32769,mtimeMs:1,digest:'a'.repeat(64)}}}):Response.json({ok:false,error:{code:`file_${refusal}`,message:`Saved file ${refusal}`,retry:'read'}},{status:400});};f.add();await settle();assert.equal(f.composer.captureReload()[0]?.attachments?.items.length??0,0);assert.equal(f.editor.value,'Keep this draft');assert.match(byId('modal-error').textContent,refusal==='oversized'?/32 KiB/:new RegExp(refusal));byId('modal-close').click();
});
test('composer file staging retains the pre-chooser edit guard for explicit Include text',async context=>{
  const f=await workingFixture(context,'edit');f.editor.setSelectionRange(2,5);f.open();await settle();f.editor.value='Newer edit';f.editor.dispatch('input');f.add();await settle();byId('modal-close').click();const include=primaryControl('composer').querySelector('[aria-label="Include text from saved.md"]');assert.ok(include);include.click();await settle();assert.equal(typeof f.composer.captureReload()[0]?.attachments?.items[0]?.prepared,'string');assert.equal(f.editor.value,'Newer edit');assert.match(primaryControl('composer').textContent,/changed|prepared|Insert text/i);
});
test('Add file stages exact saved bytes in the named draft without reading or changing its source editor',async context=> {
  fileTransport(context);const target={kind:'primary' as const,key:'p',epoch:920},savedText='\ufeffSaved\r\ntext\n';
  await arrive({workspace:{id:'file-message',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:920})],roster:[],targets:[targetFixture('file-message-target',target,{draft:{revision:1,text:'Keep recipient text',mode:'prompt',images:[],persisted:true}})]});await settle();
  const root=app.fileRoot.selection?.root?.id;assert.ok(root);const editor=primaryControl('editor'),parent=editor.parentNode;editor.setSelectionRange(2,5,'backward');const composer=app.primaryComposer(),selection=structuredClone(app.state.workspace?.selectedTarget),before=transportLog.length;
  const previous=globalThis.fetch;let reads=0;globalThis.fetch=async(input,init)=> {const url=new URL(String(input),'http://ui.test');if(url.pathname.endsWith('/text')) {reads++;assert.equal(init?.method ?? 'GET','GET');return Response.json({ok:true,data:{rootId:root,path:'saved.md',text:savedText,revision:{size:new TextEncoder().encode(savedText).length,mtimeMs:1,digest:'a'.repeat(64)}}});}return previous(input,init);};
  app.addFileToMessage(root,'saved.md');assert.equal(reads,0);assert.equal(byId('modal-title').textContent,'Add file to message');const select=byId('file-message-destination');assert.notEqual(select.value,'');assert.match(byId('modal-body').textContent,/Uses the saved file.*Unsaved editor changes are not included/);
  byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Add file')?.click();await settle();assert.equal(reads,1);assert.equal(byId('modal').open,true);assert.match(byId('modal-body').textContent,/File staged.*Use Include text.*Nothing was sent/);assert.deepEqual(byId('modal-body').querySelectorAll('button').map(node=>node.textContent),['Close']);const identity=byId('modal-body').querySelector('.file-message-identity');assert.ok(identity);assert.equal(identity.open,false);assert.match(identity.textContent,/Primary key: p\nEpoch: 920/);assert.equal(byId('modal-body').textContent.includes(select.value),false);
  const staged=composer.captureReload()[0]?.attachments?.items[0];assert.ok(staged?.file);assert.deepEqual(new Uint8Array(await staged.file.arrayBuffer()),new TextEncoder().encode(savedText));assert.equal(staged.name,'saved.md');assert.equal(staged.state,'text');assert.equal(editor.value,'Keep recipient text');assert.equal(editor.parentNode,parent);assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,5,'backward']);assert.deepEqual(app.state.workspace?.selectedTarget,selection);assert.match(byId('announcements').textContent,/File staged.*Include text/);
  assert.equal(transportLog.slice(before).some(call=>call.path.endsWith('/inputs')||call.path.endsWith('/start')||call.path.endsWith('/prepare')||call.method==='PUT'&&call.path.endsWith('/text')),false);byId('modal-close').click();
});
test('file destinations show one qualified name and collapsed exact ordinary or Durable identity',async context=>{
  fileTransport(context);const target={kind:'primary' as const,key:'p',epoch:930},identity='10000000-0000-4000-8000-000000000001:2',agent={kind:'agent' as const,identity};
  await arrive({workspace:{id:'file-readable-destination',revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:twoPanes(identity,'primary-pane')},primaries:[primaryFixture({epoch:930,sessionName:'Shared destination',sessionId:'ordinary-native-session'})],roster:[agentFixture(identity,{name:'Shared destination'})],targets:[targetFixture('readable-primary',target),targetFixture('readable-agent',agent)]});
  const root=app.fileRoot.selection?.root?.id;assert.ok(root);const editor=primaryControl('editor'),text=editor.value,before=transportLog.length;
  app.addFileToMessage(root,'saved.md');const select=byId('file-message-destination'),options=select.children.filter(item=>!!item.value),body=byId('modal-body');
  assert.equal(options.length,2);assert.deepEqual(options.map(item=>item.textContent),['Shared destination · Ordinary Primary','Shared destination · Durable']);assert.deepEqual(options.map(item=>item.title),options.map(item=>item.textContent));
  assert.doesNotMatch(body.querySelector('.file-message-detail')?.textContent??'',/Shared destination/);
  let disclosure=body.querySelector('.file-message-identity');assert.ok(disclosure);assert.equal(disclosure.open,false);assert.equal(disclosure.querySelector('summary')?.textContent,'Conversation identity');
  assert.match(disclosure.textContent,/Ordinary Primary\nSession ID: ordinary-native-session\nPrimary key: p\nEpoch: 930\nTogether these identify the exact Primary target\./);assert.equal(body.textContent.includes(select.value),false);
  select.value=options[1]?.value??'';select.dispatch('change');disclosure=body.querySelector('.file-message-identity');assert.ok(disclosure);assert.equal(disclosure.open,false);assert.equal(disclosure.querySelector('p')?.textContent,`Durable conversation ID: ${identity}`);assert.equal(body.textContent.includes(select.value),false);
  disclosure.open=true;assert.equal(transportLog.length,before);assert.equal(primaryControl('editor'),editor);assert.equal(editor.value,text);
  select.value=options[0]?.value??'';app.state.primaries.set('p',primaryFixture({epoch:931,sessionId:'later-native-session'}));select.dispatch('change');assert.match(body.querySelector('.file-message-identity')?.textContent??'',/Session ID: Unavailable/);assert.doesNotMatch(body.textContent,/later-native-session/);
  byId('modal-close').click();assert.equal(editor.value,text);assert.equal(transportLog.length,before);
});
test('file-focused Add requires an explicit open destination and never substitutes unsaved file text',async context=> {
  fileTransport(context);const target={kind:'primary' as const,key:'p',epoch:921};
  await arrive({workspace:{id:'file-message-explicit',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:921})],roster:[],targets:[targetFixture('file-message-explicit-target',target)]});await settle();const composer=app.primaryComposer(),root=app.fileRoot.selection?.root?.id;assert.ok(root);const tab:FileTab={kind:'file',rootId:root,path:'note.md'};app.chooseFile(root,tab.path);await settle();const workspace=app.state.workspace;assert.ok(workspace);const view=app.filesViews.view(workspace,tab);assert.ok(view.editor);view.editor.value='Unsaved editor content must not become the attachment';
  const layout=structuredClone(currentLayout()),selected=structuredClone(workspace.selectedTarget);app.addFileToMessage(root,tab.path);const select=byId('file-message-destination'),add=byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Add file');assert.ok(add);assert.equal(select.value,'');assert.equal(add.disabled,true);const option=select.children.find(node=>!!node.value);assert.ok(option);select.value=option.value;select.dispatch('change');assert.equal(add.disabled,false);assert.deepEqual(currentLayout(),layout);assert.deepEqual(app.state.workspace?.selectedTarget,selected);add.click();await settle();
  const staged=composer.captureReload()[0]?.attachments?.items[0];assert.ok(staged?.file);assert.equal(await staged.file.text(),'# Exact file\n\nRetained source.\n');assert.equal(view.editor.value,'Unsaved editor content must not become the attachment');assert.deepEqual(currentLayout(),layout);assert.deepEqual(app.state.workspace?.selectedTarget,selected);assert.match(byId('modal-body').textContent,/File staged/);byId('modal-close').click();
});
test('Add file keeps an empty layout explicit without a workspace Primary fallback',async context=> {
  fileTransport(context);await arrive({workspace:{id:'file-message-empty',revision:1,primaryKey:'p',conversationLayout:{focusedPane:'empty-pane',root:{kind:'pane',id:'empty-pane',tabs:[],active:null}}},primaries:[primaryFixture({epoch:925})],roster:[],targets:[]});await settle();const root=app.fileRoot.selection?.root?.id;assert.ok(root);const before=transportLog.length;app.addFileToMessage(root,'saved.md');assert.equal(byId('file-message-destination').value,'');assert.match(byId('modal-body').textContent,/No open conversation is available/);assert.equal(byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Add file')?.disabled,true);assert.equal(transportLog.length,before);byId('modal-close').click();
});
test('unloaded open drafts stay visible without preparation or saved-file reads',async context=> {
  fileTransport(context);const target={kind:'primary' as const,key:'p',epoch:926};await arrive({workspace:{id:'file-message-unloaded',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:926})],roster:[],targets:[targetFixture('file-message-unloaded-target',target)]});await settle();const root=app.fileRoot.selection?.root?.id;assert.ok(root);app.primaryComposer().attach('file-message-unloaded',undefined);const before=transportLog.length;app.addFileToMessage(root,'saved.md');assert.match(byId('file-message-destination').textContent,/Draft is not loaded.*Open this conversation first/);assert.equal(byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Add file')?.disabled,true);assert.equal(transportLog.length,before);byId('modal-close').click();
});
for(const stale of ['closed','cancel','replaced','workspace'] as const) test(`saved file staging refuses a later ${stale} destination`,async context=> {
  fileTransport(context);const target={kind:'primary' as const,key:'p',epoch:922};await arrive({workspace:{id:`file-message-${stale}`,revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:922})],roster:[],targets:[targetFixture(`file-message-target-${stale}`,target)]});await settle();const composer=app.primaryComposer(),root=app.fileRoot.selection?.root?.id;assert.ok(root);const previous=globalThis.fetch,response=Promise.withResolvers<Response>();let reads=0;globalThis.fetch=async(input,init)=> {if(new URL(String(input),'http://ui.test').pathname.endsWith('/text')) {reads++;return response.promise;}return previous(input,init);};
  app.addFileToMessage(root,'note.md');byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Add file')?.click();assert.equal(reads,1);
  if(stale==='cancel') byId('modal-close').click();else if(stale==='closed') {const layout=currentLayout(),pane=paneLeaves(layout.root)[0];assert.ok(pane);app.applyLayout({focusedPane:pane.id,root:{kind:'pane',id:pane.id,tabs:[],active:null}});}else if(stale==='workspace') await arrive({workspace:{id:'other-file-message-workspace',revision:1},primaries:[],roster:[],targets:[]});else event('primary.state',primaryFixture({epoch:923}),target);
  response.resolve(Response.json({ok:true,data:{rootId:root,path:'note.md',text:'Do not stage',revision:{size:12,mtimeMs:1,digest:'a'.repeat(64)}}}));await settle();assert.equal(composer.captureReload()[0]?.attachments?.items.length ?? 0,0);if(stale!=='cancel') {assert.match(byId('modal-error').textContent,/changed/);byId('modal-close').click();}
});
for(const refusal of ['oversized','identity','missing'] as const) test(`saved file staging preserves the draft after a ${refusal} read`,async context=> {
  fileTransport(context);const target={kind:'primary' as const,key:'p',epoch:924};await arrive({workspace:{id:`file-message-refusal-${refusal}`,revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:924})],roster:[],targets:[targetFixture(`file-message-refusal-${refusal}`,target)]});await settle();const composer=app.primaryComposer(),root=app.fileRoot.selection?.root?.id;assert.ok(root);const previous=globalThis.fetch;globalThis.fetch=async(input,init)=> {if(new URL(String(input),'http://ui.test').pathname.endsWith('/text'))return refusal==='missing'?Response.json({ok:false,error:{code:'file_unavailable',message:'Saved file is missing',retry:'read'}},{status:404}):Response.json({ok:true,data:{rootId:root,path:refusal==='identity'?'other.md':'note.md',text:refusal==='oversized'?'x'.repeat(32769):'Saved',revision:{size:32769,mtimeMs:1,digest:'a'.repeat(64)}}});return previous(input,init);};
  const draft=primaryControl('editor').value;app.addFileToMessage(root,'note.md');byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Add file')?.click();await settle();assert.equal(composer.captureReload()[0]?.attachments?.items.length ?? 0,0);assert.equal(primaryControl('editor').value,draft);assert.match(byId('modal-error').textContent,refusal==='oversized'?/32 KiB/:refusal==='missing'?/missing/:/changed/);byId('modal-close').click();
});
test('restored file-first split constructs every tab region before document hydration',async context=> {
  fileTransport(context);hostDocument.activeElement=hostDocument.body;const target={kind:'primary' as const,key:'p',epoch:899},tab:FileTab={kind:'file',rootId:'root',path:'restored.md'};
  const layout:ConversationLayout={focusedPane:'restored-primary',root:{kind:'split',id:'restored-split',axis:'x',ratio:50,first:{kind:'pane',id:'restored-file',tabs:[tab],active:tabKey(tab)},second:{kind:'pane',id:'restored-primary',tabs:[{kind:'primary'}],active:'primary'}}},start=transportLog.length;
  await arrive({workspace:{id:'restored-file-first',revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:layout},primaries:[primaryFixture({epoch:899})],roster:[],targets:[targetFixture('restored-primary',target)]});await settle();
  assert.equal(primaryControl('root').hidden,false);assert.equal(paneNode('restored-file').querySelectorAll('.conversation-tab').length,1);assert.equal(paneNode('restored-primary').querySelectorAll('.conversation-tab').length,1);
  const workspace=app.state.workspace;assert.ok(workspace);const view=app.filesViews.view(workspace,tab);assert.equal(view.root.hidden,false);assert.equal(view.owner.loading,false);assert.equal(view.owner.source?.text,'# Exact file\n\nRetained source.\n');assert.deepEqual(currentLayout(),layout);assert.equal(hostDocument.activeElement,hostDocument.body);
  assert.equal(transportLog.slice(start).some(call=>call.path.endsWith('/prepare') || call.path.endsWith('/start') || call.path === '/api/operations' || call.path.includes('/inputs') || call.method === 'PUT' && (call.path.endsWith('/draft') || call.path.endsWith('/text'))),false);
});
test('file selection retains native conversation ancestors, caret, draft, source and split geometry',async context=> {
  fileTransport(context);const target = {kind:'primary' as const,key:'p',epoch:900};
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:900})],roster:[],targets:[targetFixture('file-primary',target,{draft:{revision:1,text:'Exact draft',mode:'prompt',images:[],persisted:true}})]});
  const editor = primaryControl('editor'),form = primaryControl('composer'),parent = form.parentNode,root = primaryControl('root');editor.focus();editor.setSelectionRange(2,6,'backward');const before = transportLog.length;
  const tab:FileTab = {kind:'file',rootId:app.fileRoot.selection?.root?.id ?? '/fixture/project',path:'note.md'};app.chooseFile(tab.rootId,tab.path);await settle();
  const workspace = app.state.workspace;assert.ok(workspace);const view = app.filesViews.view(workspace,tab),owner = view.owner,source = owner.source;
  assert.deepEqual(activeTab(currentLayout()),tab);assert.equal(view.root.hidden,false);assert.equal(root.hidden,true);assert.equal(primaryControl('editor'),editor);assert.equal(form.parentNode,parent);assert.equal(editor.value,'Exact draft');assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,6,'backward']);assert.deepEqual(workspace.selectedTarget,target);
  app.chooseFile(tab.rootId,tab.path);await settle();assert.equal(app.filesViews.view(app.state.workspace as typeof workspace,tab),view);assert.equal(paneLeaves(currentLayout().root).flatMap(pane=>pane.tabs).filter(item=>item.kind === 'file').length,1);
  const layout = app.state.workspace?.conversationLayout;assert.ok(layout);app.applyLayout(splitPane(layout,layout.focusedPane,'x',{width:1000,height:700,divider:4}));await settle();assert.equal(view.owner,owner);assert.equal(owner.source,source);assert.equal(form.parentNode,parent);assert.equal(paneLeaves(currentLayout().root).length,2);
  app.openTabsList();const menu = hostDocument.body.querySelector('.context-menu');assert.ok(menu);const choice = menu.children.find(item=>item.textContent === 'note.md');assert.ok(choice);assert.equal(choice.getAttribute('aria-description'),'note.md');assert.ok(menu.children.some(item=>item.textContent === 'Re-read file'));assert.equal(menu.children.some(item=>item.textContent === 'Conversation actions'),false);
  assert.equal(transportLog.slice(before).filter(call=>call.path.endsWith('/start') || call.path === '/api/operations' || call.path.includes('/inputs')).length,0);
});
test('stable file pointer and native focus select their pane without moving views or controls',async context=> {
  fileTransport(context);const target = {kind:'primary' as const,key:'p',epoch:909},tab:FileTab = {kind:'file',rootId:'root',path:'split.md'};
  const layout:ConversationLayout = {focusedPane:'primary-pane',root:{kind:'split',id:'file-focus-split',axis:'x',ratio:50,first:{kind:'pane',id:'primary-pane',tabs:[{kind:'primary'}],active:'primary'},second:{kind:'pane',id:'file-pane',tabs:[tab],active:tabKey(tab)}}};
  await arrive({workspace:{id:'stable-file-focus',revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:layout},primaries:[primaryFixture({epoch:909})],roster:[],targets:[targetFixture('stable-file-primary',target)]});await settle();
  const workspace = app.state.workspace;assert.ok(workspace);const view = app.filesViews.view(workspace,tab);await view.owner.load();await settle();const editor = view.editor as unknown as HostNode,root = view.root as unknown as HostNode,save = root.querySelector('.file-save');assert.ok(save);
  const parent = editor.parentNode,host = root.parentNode,moves = root.moves,controls = [...root.children];primaryControl('editor').focus();assert.equal(app.focusedPane,'primary-pane');
  save.dispatch('pointerdown',{pointerId:7});assert.equal(app.focusedPane,'file-pane');save.focus();assert.equal(byId('workbench-status').dataset.pane,'file',JSON.stringify({focused:app.focusedPane,tab:activeTab(currentLayout()),active:hostDocument.activeElement?.getAttribute('aria-label'),root:root.className,parent:root.parentNode?.className}));assert.equal(root.querySelector('.file-save'),save);assert.deepEqual(root.children,controls);
  app.applyLayout({...app.state.workspace?.conversationLayout as ConversationLayout,focusedPane:'primary-pane'});primaryControl('editor').focus();editor.focus();await app.selectionQueue.drain();
  assert.equal(app.focusedPane,'file-pane');assert.equal(byId('workbench-status').dataset.pane,'file');assert.equal(hostDocument.activeElement,editor);assert.equal(editor.parentNode,parent);assert.equal(root.parentNode,host);assert.equal(root.moves,moves);assert.deepEqual(app.state.workspace?.selectedTarget,target);
});
test('a Markdown file offers Preview and Source beside Save and runs the tab-menu action; other files offer neither',async context=> {
  fileTransport(context);const target = {kind:'primary' as const,key:'p',epoch:941},source:FileTab = {kind:'file',rootId:'root',path:'doc.md'},preview:FileTab = {...source,view:'preview'},code:FileTab = {kind:'file',rootId:'root',path:'code.ts'},data:FileTab = {kind:'file',rootId:'root',path:'data.json'};
  const layout:ConversationLayout = {focusedPane:'file-pane',root:{kind:'pane',id:'file-pane',tabs:[source,code,data],active:tabKey(source)}};
  await arrive({workspace:{id:'markdown-switch',revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:layout},primaries:[primaryFixture({epoch:941})],roster:[],targets:[targetFixture('markdown-switch-primary',target)]});await settle();
  const workspace = app.state.workspace;assert.ok(workspace);
  const control = (view:ReturnType<typeof app.filesViews.view>)=> (view.root as unknown as HostNode).querySelectorAll('button').filter(item=>item.className === 'file-view-switch');
  const sourceView = app.filesViews.view(workspace,source),sourceRoot = sourceView.root as unknown as HostNode,row = sourceRoot.querySelector('.file-view-actions');assert.ok(row);
  assert.deepEqual(control(sourceView).map(item=>item.textContent),['Preview']);assert.deepEqual(row.children.map(item=>item.textContent),['Preview','Save']);
  for (const other of [code,data]) assert.equal(control(app.filesViews.view(workspace,other)).length,0);
  app.openTabsList();const menu = hostDocument.body.querySelector('.context-menu');assert.ok(menu);assert.ok(menu.children.some(item=>item.textContent === 'Re-read file'));contextMenu.close();
  control(sourceView)[0]?.dispatch('click');await settle();
  assert.deepEqual(activeTab(currentLayout()),preview);assert.equal(paneLeaves(currentLayout().root)[0]?.tabs.some(item=>tabKey(item) === tabKey(source)),true);
  const previewView = app.filesViews.view(app.state.workspace as typeof workspace,preview);assert.equal(previewView.owner,sourceView.owner);assert.deepEqual(control(previewView).map(item=>item.textContent),['Source']);
  control(previewView)[0]?.dispatch('click');await settle();assert.deepEqual(activeTab(currentLayout()),source);
  assert.equal(paneLeaves(currentLayout().root).flatMap(pane=>pane.tabs).filter(item=>item.kind === 'file' && item.path === 'doc.md').length,2);
});
test('explicit session completion selects its exact Primary while ordinary refresh retains the file',async context=> {
  fileTransport(context);const target = {kind:'primary' as const,key:'p',epoch:910},other = {kind:'primary' as const,key:'returned',epoch:911},tab:FileTab = {kind:'file',rootId:'root',path:'retained.md'};
  await arrive({workspace:{id:'resume-file',revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:{focusedPane:'file-pane',root:{kind:'pane',id:'file-pane',tabs:[tab],active:tabKey(tab)}}},primaries:[primaryFixture({epoch:910}),primaryFixture({key:'returned',epoch:911})],roster:[],targets:[targetFixture('original-primary',target),targetFixture('returned-primary',other)]});await settle();
  await app.reload();assert.deepEqual(activeTab(currentLayout()),tab);
  byId('modal').showModal();const completed = app.capturePrimarySelection();
  for (const name of ['scroll','select']) for (const handler of documentHandlers.get(name) ?? []) handler({isTrusted:true,target:primaryControl('editor')});
  await completed('returned');assert.equal(app.state.workspace?.primaryKey,'returned');assert.equal(activeTab(currentLayout())?.kind,'primary');byId('modal').close();
  assert.equal(hostDocument.activeElement?.getAttribute('aria-label'),'Message Primary');
});
for (const change of ['selection','workspace','cancel','input'] as const) test(`session completion preserves a later ${change}`,async context=> {
  fileTransport(context);const target = {kind:'primary' as const,key:'p',epoch:912},tab:FileTab = {kind:'file',rootId:'root',path:'retained.md'};
  await arrive({workspace:{id:`resume-${change}`,revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:{focusedPane:'file-pane',root:{kind:'pane',id:'file-pane',tabs:[tab],active:tabKey(tab)}}},primaries:[primaryFixture({epoch:912})],roster:[],targets:[targetFixture(`resume-${change}`,target)]});await settle();
  byId('modal').showModal();const completed = app.capturePrimarySelection();
  if (change === 'selection') app.chooseFile('root','later.md');
  else if (change === 'workspace') await arrive({workspace:{id:'later-resume-workspace',revision:1,conversationLayout:{focusedPane:'file-pane',root:{kind:'pane',id:'file-pane',tabs:[tab],active:tabKey(tab)}}},primaries:[],roster:[],targets:[]});
  else if (change === 'input') for (const handler of documentHandlers.get('keydown') ?? []) handler({isTrusted:true,key:'ArrowRight',target:byId('modal')});
  else byId('modal').close();
  const before = structuredClone(currentLayout()),focus = hostDocument.activeElement;await completed('p');
  if (change === 'input') {assert.equal(activeTab(currentLayout())?.kind,'primary');assert.ok(paneLeaves(currentLayout().root).some(pane=>pane.tabs.some(item=>tabKey(item) === tabKey(tab))));}
  else assert.deepEqual(currentLayout(),before);
  assert.equal(hostDocument.activeElement,focus);byId('modal').close();
});
for (const interrupted of [false,true]) test(`warming Resume focus retains its exact input intent: ${interrupted}`,async context=> {
  fileTransport(context);const target = {kind:'primary' as const,key:'p',epoch:913},tab:FileTab = {kind:'file',rootId:'root',path:'retained.md'},warming = primaryFixture({epoch:913,lifecycle:'starting',activity:'idle',capabilities:{input:true}});
  await arrive({workspace:{id:`warming-resume-${interrupted}`,revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:{focusedPane:'file-pane',root:{kind:'pane',id:'file-pane',tabs:[tab],active:tabKey(tab)}}},primaries:[warming],roster:[],targets:[targetFixture(`warming-${interrupted}`,target)]});await settle();
  byId('modal').showModal();await app.capturePrimarySelection()('p');byId('modal').close();const chosen = byId('workbench-version');chosen.focus();
  if (interrupted) for (const handler of documentHandlers.get('pointerdown') ?? []) handler({isTrusted:true,target:chosen});
  event('primary.state',{...warming,lifecycle:'ready'},target);await settle();
  assert.equal(activeTab(currentLayout())?.kind,'primary');assert.equal(hostDocument.activeElement,interrupted ? chosen : primaryControl('editor'));
});
test('focused explicit Message owns the footer while a file remains the active pane',async context=> {
  fileTransport(context);const target = {kind:'primary' as const,key:'p',epoch:901},recipient = agentFixture('file-message');
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:901})],roster:[recipient],targets:[targetFixture('file-message-primary',target),targetFixture('file-message-agent',{kind:'agent',identity:recipient.identity},{draft:{revision:1,text:'Message draft',mode:'prompt',images:[],persisted:true}})]});
  const tab:FileTab = {kind:'file',rootId:'/fixture/project',path:'note.md'};app.chooseFile(tab.rootId,tab.path);await settle();
  assert.equal(byId('workbench-status').dataset.pane,'file');byId('roster').querySelector('[data-identity="file-message"]')?.querySelector('.row-message')?.click();await settle();
  const editor = hostDocument.body.querySelector('.composer[data-message-panel="true"]')?.querySelector('textarea');assert.ok(editor);editor.focus();editor.setSelectionRange(2,6,'backward');app.renderConnection();await settle();
  assert.equal(byId('workbench-status').dataset.pane,'agent');assert.equal(byId('workbench-scope').title,`${byId('workbench-scope').textContent}\n${recipient.identity}`);assert.equal(byId('workbench-status-agent').hidden,false);assert.equal(byId('workbench-status-primary').hidden,true);assert.equal(editor.value,'Message draft');assert.equal(hostDocument.activeElement,editor);assert.deepEqual([editor.selectionStart,editor.selectionEnd],[2,6]);assert.equal(activeTab(currentLayout())?.kind,'file');assert.deepEqual(app.state.workspace?.selectedTarget,target);
  byId('agent-message-close').click();await settle();assert.equal(byId('workbench-status').dataset.pane,'file');assert.equal(paneNode(app.focusedPane).querySelectorAll('.conversation-tab').find(node=>node.dataset.tabKey === tabKey(tab))?.getAttribute('aria-selected'),'true');
});
test('the existing unload guard protects immediate file input, pending acknowledgment and failed drafts',async context=> {
  fileTransport(context);const previous = globalThis.fetch;let release!:()=>void, failed = false, readFailed = false, revision = 0;
  const gate = new Promise<void>(resolve=> {release = resolve;});
  globalThis.fetch = async(input,init)=> {
    const url = new URL(String(input),'http://ui.test');
    if (url.pathname.endsWith('/text') && readFailed) throw new Error('forced read failure');
    if (url.pathname.endsWith('/text') && init?.method === 'PUT') throw new Error('forced Save failure');
    if (url.pathname.endsWith('/draft') && init?.method === 'PUT') {
      if (failed) throw new Error('forced draft failure');await gate;
      const body = JSON.parse(String(init.body));return Response.json({ok:true,data:{revision:++revision,base:body.base,text:body.text,encoding:body.encoding}});
    }
    return previous(input,init);
  };
  const target = {kind:'primary' as const,key:'p',epoch:902};
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:902})],roster:[],targets:[targetFixture('file-unload-primary',target)]});
  const tab:FileTab = {kind:'file',rootId:'/fixture/project',path:'unload.md'};app.chooseFile(tab.rootId,tab.path);await settle();
  const workspace = app.state.workspace;assert.ok(workspace);const owner = app.filesViews.view(workspace,tab).owner;
  const composers = context.mock.getter(Composer.prototype,'canDispose',()=>true);
  assert.equal(beforeUnload(),false);owner.edit('immediate input');assert.equal(beforeUnload(),true);
  const writing = owner.drain();await new Promise(resolve=>setImmediate(resolve));assert.equal(owner.persisting,true);assert.equal(beforeUnload(),true);
  release();await writing;assert.equal(owner.modified,true);assert.equal(beforeUnload(),false);
  composers.mock.mockImplementation(()=>false);assert.equal(beforeUnload(),true);composers.mock.mockImplementation(()=>true);
  readFailed = true;await owner.reread();assert.match(owner.error ?? '',/forced read failure/);assert.equal(beforeUnload(),false);
  readFailed = false;await assert.rejects(owner.save(),/forced Save failure/);assert.equal(beforeUnload(),true);
  readFailed = true;await owner.reread();assert.equal(beforeUnload(),true);
  readFailed = false;await owner.reread();assert.equal(beforeUnload(),false);
  failed = true;owner.edit('unacknowledged');await assert.rejects(owner.drain(),/forced draft failure/);assert.equal(beforeUnload(),true);
  app.filesViews.reconcile(workspace,[],[]);await assert.rejects(owner.drain(),/forced draft failure/);assert.equal(beforeUnload(),true);
});
test('the Add menu offers the slash list: a notice over text, the slash itself over an empty draft',async context=>{
  const f=await workingFixture(context,'slash'),form=primaryControl('composer');
  const choose=()=>{form.querySelector('.attachment-sources')?.click();const menu=hostDocument.body.querySelector('.context-menu');assert.ok(menu);const item=menu.children[3];assert.ok(item);assert.equal(item.getAttribute('aria-disabled')==='true',false);item.click();};
  choose();assert.equal(f.editor.value,'Keep this draft');assert.match(primaryControl('receipt').textContent,/Commands start a message\. Clear the draft to choose one\./);
  Object.defineProperty(hostDocument,'execCommand',{configurable:true,value:(_command:string,_ui:boolean,value:string)=>{const target=hostDocument.activeElement as unknown as typeof f.editor;const at=target.selectionStart;target.value=target.value.slice(0,at)+value+target.value.slice(target.selectionEnd);target.setSelectionRange(at+value.length,at+value.length);target.dispatch('input');return true;}});
  try{f.composer.setText('');choose();assert.equal(f.editor.value,'/');}finally{Reflect.deleteProperty(hostDocument,'execCommand');}
});
