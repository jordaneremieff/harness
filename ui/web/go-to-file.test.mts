import assert from 'node:assert/strict';
import test from 'node:test';
import type {FileSearchResult, FileSearchRow} from '../shared/files.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {activeTab, workspaceLayout} from './tabs.ts';
import {paneLeaves} from './pane-layout.ts';
const {app,arrive,settle,byId,hostDocument}=await createAppFixture();
const rows:FileSearchRow[]=[{name:'note.md',path:'docs/note.md',kind:'file'},{name:'note.md',path:'packages/other/note.md',kind:'file'},{name:'docs',path:'docs',kind:'directory'}];
async function setup(t:test.TestContext,name:string) {
  await arrive({workspace:{id:`file-navigation-${name}`,revision:1,conversationLayout:{focusedPane:'files',root:{kind:'pane',id:'files',tabs:[],active:null}}},primaries:[],roster:[],targets:[]});
  await app.fileRoot.choose('/navigation/project');await settle();const root=app.fileRoot.selection?.root;assert.ok(root);
  const previous=globalThis.fetch,calls:{url:URL;method:string;signal?:AbortSignal|null}[]=[];
  const result=(query:string,overrides:Partial<FileSearchResult>={}):FileSearchResult=>({rootId:root.id,query,scope:'',rows,more:false,coverage:{complete:true,visited:3,skipped:0},...overrides});
  let search=(url:URL,_signal?:AbortSignal|null):Promise<Response>=>Promise.resolve(Response.json({ok:true,data:result(url.searchParams.get('q')??'')}));
  globalThis.fetch=async(input,init)=> {
    const url=new URL(String(input),'http://ui.test'),method=init?.method??'GET';calls.push({url,method,signal:init?.signal});
    if(url.pathname.endsWith('/search'))return search(url,init?.signal);
    if(url.pathname.endsWith('/text')){const text='# Exact source\n';return Response.json({ok:true,data:{rootId:root.id,path:url.searchParams.get('path'),text,revision:{size:text.length,mtimeMs:1,digest:'a'.repeat(64)}}});}
    if(url.pathname.endsWith('/draft')){
      if(method==='PUT'){const {expectedRevision,base,text,encoding}=JSON.parse(String(init?.body));return Response.json({ok:true,data:{revision:expectedRevision+1,base,text,encoding}});}
      return Response.json({ok:true,data:{revision:0,draft:null}});
    }
    return previous(input,init);
  };
  t.after(()=>{byId('modal-close').click();globalThis.fetch=previous;});
  const open=()=>{byId('files-search').focus();byId('files-search').click();};
  const query=(value:string)=>{const field=byId('go-to-file-query');field.value=value;field.dispatch('input');return field;};
  const searches=()=>calls.filter(call=>call.url.pathname.endsWith('/search'));
  return {root,result,calls,open,query,searches,setSearch:(handler:typeof search)=>{search=handler;}};
}
for(const entry of ['files','commands'])test(`Go to file opens a nested file from ${entry} without any conversation or draft`,async t=> {
  const f=await setup(t,entry),origin=byId(entry==='files'?'files-search':'commands-button');origin.focus();
  if(entry==='files')origin.click();
  else {origin.click();const choice=byId('modal-body').querySelectorAll('button').find(node=>node.getAttribute('aria-label')?.startsWith('Go to file…,'));assert.ok(choice);choice.click();}
  await settle();assert.equal(byId('modal-title').textContent,'Go to file…');assert.equal(hostDocument.activeElement,byId('go-to-file-query'));
  assert.equal(f.searches().length,1);assert.equal(f.searches()[0]?.method,'GET');assert.equal(f.searches()[0]?.url.searchParams.get('workspace'),`file-navigation-${entry}`);
  assert.equal(f.searches()[0]?.url.searchParams.has('target'),false);assert.equal(byId('modal-body').querySelectorAll('.file-navigation-scope').length,1);
  byId('modal-body').querySelector('[data-path="docs/note.md"]')?.click();await app.selectionQueue.drain();await settle();
  assert.equal(byId('modal').open,false);assert.deepEqual(activeTab(workspaceLayout(app.state.workspace)),{kind:'file',rootId:f.root.id,path:'docs/note.md'});
  const workspace=app.state.workspace;assert.ok(workspace);const view=app.filesViews.view(workspace,{kind:'file',rootId:f.root.id,path:'docs/note.md'});
  assert.equal(view.owner.text,'# Exact source\n');assert.ok(view.editor);assert.equal(view.editor.readOnly,false);
  assert.equal(f.calls.some(call=>/\/(inputs|start|prepare)$/.test(call.url.pathname)||call.method==='PUT'&&call.url.pathname.endsWith('/text')),false);
});
test('duplicate filenames keep full parent paths and folders refine the same query with native keyboard focus',async t=> {
  const f=await setup(t,'folders');f.open();await settle();const list=byId('go-to-file-results'),field=byId('go-to-file-query');
  assert.deepEqual(list.querySelectorAll('.file-navigation-name').map(node=>node.textContent),['note.md','note.md','docs/']);
  assert.deepEqual(list.querySelectorAll('.file-navigation-parent').map(node=>node.textContent),['docs','packages/other','.']);
  field.dispatch('keydown',{key:'ArrowDown'});assert.equal(hostDocument.activeElement,list.children[0]);
  list.querySelector('[data-path="docs"]')?.click();assert.equal(field.value,'docs/');assert.equal(hostDocument.activeElement,field);await settle();
  assert.equal(f.searches().at(-1)?.url.searchParams.get('q'),'docs/');assert.equal(byId('modal-title').textContent,'Go to file…');assert.equal(byId('modal-body').querySelectorAll('.file-navigation-scope').length,1);
  byId('modal').dispatch('cancel');assert.equal(byId('modal').open,false);assert.equal(hostDocument.activeElement,byId('files-search'));
});
test('long partial results keep coverage before the scroll list and Cancel outside it, with no empty complete status',async t=> {
  const f=await setup(t,'coverage-layout'),reason='Searched part of the folder: the search reached its match bound.';
  const longRows=Array.from({length:100},(_,index)=>({name:`note-${index}.md`,path:`docs/note-${index}.md`,kind:'file' as const}));
  f.setSearch(async url=>Response.json({ok:true,data:f.result(url.searchParams.get('q')??'',{rows:longRows,more:true,coverage:{complete:false,visited:100,skipped:0,reason}})}));
  f.open();await settle();const body=byId('modal-body'),list=byId('go-to-file-results'),status=body.querySelector('.file-navigation-status'),actions=body.querySelector('.dialog-actions');
  assert.ok(status&&actions);assert.equal(list.classList.contains('picker-results'),true);assert.equal(list.children.length,100);
  assert.equal(status.getAttribute('role'),'status');assert.equal(status.textContent,`More matches. Refine the name or folder. ${reason}`);
  assert.deepEqual(body.children.map(node=>node.className),['secondary file-navigation-scope','sr-only','picker-input','secondary file-navigation-status','file-navigation-list picker-results','dialog-actions']);
  assert.equal(actions.children[0]?.textContent,'Cancel');assert.equal(list.contains(status),false);assert.equal(list.contains(actions),false);
  f.setSearch(async url=>Response.json({ok:true,data:f.result(url.searchParams.get('q')??'')}));f.query('complete');await settle();
  assert.equal(status.textContent,'');assert.equal(list.classList.contains('picker-results'),true);assert.equal(list.children.length,rows.length);
  actions.children[0]?.click();assert.equal(byId('modal').open,false);assert.equal(hostDocument.activeElement,byId('files-search'));
});
test('coverage and replaced searches never claim an empty complete folder and never retry automatically',async t=> {
  const f=await setup(t,'coverage');f.setSearch(async url=>Response.json({ok:true,data:f.result(url.searchParams.get('q')??'',{rows:[],more:true,coverage:{complete:false,visited:4000,skipped:0,reason:'Searched part of the folder: the search reached its entry bound.'}})}));
  f.open();await settle();let status=byId('modal-body').querySelector('.file-navigation-status');assert.match(status?.textContent??'',/No matches in the searched part.*More matches\. Refine the name or folder\..*entry bound/);assert.doesNotMatch(status?.textContent??'',/No matching files or folders/);
  f.setSearch(async()=>Response.json({ok:false,error:{code:'file_cancelled',message:'A newer file search replaced this one.',retry:'read'}},{status:409}));f.query('other');await settle();
  status=byId('modal-body').querySelector('.file-navigation-status');assert.equal(status?.textContent,'Another file search replaced this search. Refine the name or folder again.');assert.equal(f.searches().length,2);assert.equal(byId('go-to-file-results').children.length,0);
  f.setSearch(async url=>Response.json({ok:true,data:f.result(url.searchParams.get('q')??'',{rows:[]})}));f.query('absent');await settle();assert.equal(status?.textContent,'No matching files or folders.');
});
for(const stale of ['query','cancel','modal','root','workspace'] as const)test(`late file search rejects ${stale} replacement and old choices`,async t=> {
  const f=await setup(t,`stale-${stale}`);f.open();await settle();const old=byId('go-to-file-results').children[0];assert.ok(old);
  const late=Promise.withResolvers<Response>();f.setSearch(()=>late.promise);f.query('late');const pending=f.searches().at(-1);assert.ok(pending?.signal);
  old.click();assert.equal(activeTab(workspaceLayout(app.state.workspace)),undefined);
  if(stale==='query'){f.setSearch(async url=>Response.json({ok:true,data:f.result(url.searchParams.get('q')??'',{rows:[{name:'current.md',path:'current.md',kind:'file'}]})}));f.query('current');await settle();}
  else if(stale==='cancel')byId('modal-close').click();
  else if(stale==='modal')app.addFileToMessage(f.root.id,'unrelated.md');
  else if(stale==='root')app.fileRoot.selection={revision:999,root:{id:'other',name:'other',path:'/other'}};
  else await arrive({workspace:{id:'another-navigation-workspace',revision:1,conversationLayout:{focusedPane:'empty',root:{kind:'pane',id:'empty',tabs:[],active:null}}},primaries:[],roster:[],targets:[]});
  const before=byId('modal-body').textContent;late.resolve(Response.json({ok:true,data:f.result('late',{rows:[{name:'late.md',path:'late.md',kind:'file'}]})}));await settle();
  if(stale==='root'||stale==='workspace'){assert.match(byId('modal-body').textContent,/workspace or working folder changed/);assert.equal(byId('go-to-file-results').children.length,0);assert.equal(byId('go-to-file-query').disabled,true);}
  else assert.equal(byId('modal-body').textContent,before);
  if(stale==='query'||stale==='cancel'||stale==='modal')assert.equal(pending.signal.aborted,true);
  assert.equal(activeTab(workspaceLayout(app.state.workspace)),undefined);
});
test('an already presented choice refuses a root change without opening any file',async t=> {
  const f=await setup(t,'stale-choice');f.open();await settle();const choice=byId('go-to-file-results').children[0];assert.ok(choice);
  app.fileRoot.selection={revision:500,root:{id:f.root.id,name:'project',path:f.root.path}};choice.click();
  assert.equal(activeTab(workspaceLayout(app.state.workspace)),undefined);assert.match(byId('modal-body').textContent,/working folder changed/);assert.equal(f.calls.some(call=>call.url.pathname.endsWith('/text')),false);
});
test('Go to file preserves the modified-file guard and the native editor when another file opens',async t=> {
  const f=await setup(t,'modified');f.open();await settle();byId('go-to-file-results').children[0]?.click();await app.selectionQueue.drain();await settle();
  const workspace=app.state.workspace;assert.ok(workspace);const tab={kind:'file' as const,rootId:f.root.id,path:'docs/note.md'},view=app.filesViews.view(workspace,tab),editor=view.editor;assert.ok(editor);
  editor.value='Exact unsaved changes';(editor as unknown as HostNode).dispatch('input');await view.owner.drain();
  f.open();await settle();byId('modal-body').querySelector('[data-path="packages/other/note.md"]')?.click();await app.selectionQueue.drain();await settle();
  const tabs=paneLeaves(workspaceLayout(app.state.workspace).root).flatMap(pane=>pane.tabs);assert.ok(tabs.some(item=>item.kind==='file'&&item.path===tab.path));
  assert.equal(view.editor,editor);assert.equal(view.owner.text,'Exact unsaved changes');assert.equal(activeTab(workspaceLayout(app.state.workspace))?.kind,'file');
});
test('phone Markdown navigation retains the existing preview and source editor route',async t=> {
  const f=await setup(t,'phone'),previous=globalThis.matchMedia;t.after(()=>{globalThis.matchMedia=previous;});
  globalThis.matchMedia=(query:string)=>({...previous(query),matches:query==='(pointer:coarse) and (max-width:599px)'||previous(query).matches});
  f.open();await settle();byId('go-to-file-query').dispatch('keydown',{key:'Enter'});await app.selectionQueue.drain();await settle();
  const tab=activeTab(workspaceLayout(app.state.workspace));assert.deepEqual(tab,{kind:'file',rootId:f.root.id,path:'docs/note.md',view:'preview'});
  const workspace=app.state.workspace;assert.ok(workspace);assert.ok(tab?.kind==='file');const preview=app.filesViews.view(workspace,tab);assert.equal(preview.owner.text,'# Exact source\n');
  const source=(preview.root as unknown as HostNode).querySelector('.file-view-switch');assert.ok(source);assert.equal(source.getAttribute('aria-label'),'Show file source');source.click();await app.selectionQueue.drain();await settle();
  const selected=activeTab(workspaceLayout(app.state.workspace));assert.ok(selected?.kind==='file');assert.equal(selected.view,undefined);const current=app.state.workspace;assert.ok(current);const view=app.filesViews.view(current,selected);assert.ok(view.editor);assert.equal(view.editor.readOnly,false);assert.equal(view.owner,preview.owner);
});
