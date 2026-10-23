import assert from 'node:assert/strict';
import test from 'node:test';
import {FileOwner} from './file-owner.ts';
import {FileView} from './file-view.ts';
import {FilesViews} from './files-views.ts';
import {createAppFixture} from './app-fixture.mts';
const {byId, settle, HostNode, app,hostDocument} = await createAppFixture();
type HostNode = InstanceType<typeof HostNode>;
import {createPaneLayout} from './pane-layout.ts';
import type {FileTab,Workspace} from '../shared/api.ts';
import {fileSource, type FileText} from '../shared/files.ts';
import {primaryDraftText, type PrimaryDraftSource} from './primary-draft-actions.ts';
const tab:FileTab = {kind:'file',rootId:'r',path:'note.txt'};
function source(text:string,path = tab.path):FileText {return {rootId:'r',path,text,revision:{size:text.length,mtimeMs:1,digest:'a'.repeat(64)}};}
test('view retains normalized native source, reading position and DOM on an unchanged refresh',async context=> {
  const saved:unknown[] = [];let view:FileView;
  const owner = new FileOwner('w',tab,async()=>source('\ufeff<script>x</script>\r\nlast\r'),()=>view?.paint());
  view = new FileView(owner,{scrollTop:120,scrollLeft:8},position=>saved.push(position));byId('workspace').append(view.root as unknown as HostNode);view.root.hidden = false;view.root.inert = false;context.after(()=>view.destroy());
  await owner.load();await settle();const editor = view.editor;assert.ok(editor);assert.equal(editor.value,fileSource(owner.source?.text ?? '').text);assert.equal(view.root.querySelector('textarea'),editor);assert.equal(view.root.querySelector('script'),null);
  assert.equal(view.scroller.scrollTop,120);view.scroller.scrollTop = 240;(view.scroller as unknown as HostNode).dispatch('scroll');assert.deepEqual(saved,[{scrollTop:240,scrollLeft:8}]);
  await owner.load(true);assert.equal(view.root.querySelector('textarea'),editor);assert.equal(view.scroller.scrollTop,240);assert.notEqual(owner,view);
});
for (const modified of [false,true]) test(`native source quotation preserves the editor and labels its exact range: modified=${modified}`,async context=> {
  let view:FileView,addition = '',captured:PrimaryDraftSource|undefined;
  const disk = 'first\nsecond\nthird\n',owner = new FileOwner('quote',tab,async()=>source(disk),()=>view?.paint());
  view = new FileView(owner,undefined,()=>{},false,undefined,{reason:()=>'',current:()=>true,append:(source,text)=> {captured = source;addition = primaryDraftText(source,text);}});
  byId('workspace').append(view.root as unknown as HostNode);view.root.hidden = false;view.root.inert = false;context.after(()=> {owner.dispose();view.destroy();});await owner.load();await settle();
  const editor = view.editor as unknown as HostNode,quote = (view.root as unknown as HostNode).querySelector('.file-quote-selection');assert.ok(quote);assert.equal(quote.hidden,true);
  if (modified) {editor.value = 'first\nsecond\tγ\nthird\n';editor.dispatch('input');}
  const text = editor.value,start = text.indexOf('second'),end = text.indexOf('third'),selected = text.slice(start,end),parent = editor.parentNode,moves = editor.moves;
  editor.setSelectionRange(start,end,'backward');editor.scrollTop = 54;editor.scrollLeft = 12;editor.focus();editor.dispatch('select');assert.equal(quote.hidden,false);
  let value = editor.value,assignments = 0;Object.defineProperty(editor,'value',{configurable:true,get:()=>value,set:(next:string)=> {assignments++;value = next;}});
  let prevented = false;quote.dispatch('pointerdown',{preventDefault:()=> {prevented = true;}});quote.click();view.paint();
  assert.equal(prevented,true);assert.equal(hostDocument.activeElement,editor);assert.equal(editor.parentNode,parent);assert.equal(editor.moves,moves);assert.equal(assignments,0);assert.equal(editor.value,text);
  assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection,editor.scrollTop,editor.scrollLeft],[start,end,'backward',54,12]);
  assert.equal(addition,`> ${selected.replaceAll('\n','\n> ')}\n\n— note.txt:2 · ${modified ? 'Editor selection \\(modified\\)' : 'Saved file selection'}`);assert.equal(captured?.current(),true);
  editor.setSelectionRange(start,start);editor.dispatch('select');assert.equal(quote.hidden,true);assert.equal(captured?.current(),false);
});
for (const change of ['edit','range','workspace','hidden','move','disk'] as const) test(`native source quotation refuses a stale ${change}`,async context=> {
  let view:FileView,current = true,captured:PrimaryDraftSource|undefined,calls = 0;
  const owner = new FileOwner('stale-quote',tab,async()=>source('first\nsecond\n'),()=>view?.paint());
  view = new FileView(owner,undefined,()=>{},false,undefined,{reason:()=>'',current:()=>current,append:source=> {captured = source;calls++;}});
  byId('workspace').append(view.root as unknown as HostNode);view.root.hidden = false;view.root.inert = false;context.after(()=> {owner.dispose();view.destroy();});await owner.load();await settle();
  const editor = view.editor as unknown as HostNode,quote = (view.root as unknown as HostNode).querySelector('.file-quote-selection');assert.ok(quote);editor.setSelectionRange(6,12);editor.dispatch('select');quote.click();assert.equal(captured?.current(),true);
  if (change === 'edit') {editor.value += 'edited';editor.dispatch('input');editor.value = 'first\nsecond\n';editor.dispatch('input');}
  else if (change === 'range') editor.setSelectionRange(0,5);
  else if (change === 'workspace') current = false;
  else if (change === 'hidden') view.root.hidden = true;
  else if (change === 'move') owner.remap('new.txt');
  else owner.source = source('first\nsecond\n');
  assert.equal(captured?.current(),false);quote.click();view.refreshQuotation();assert.equal(calls,1);assert.equal(quote.hidden,true);
});
test('source quotation exposes the existing Primary refusal without an append',async context=> {
  let view:FileView,reason = 'Primary draft is unavailable.',calls = 0;const owner = new FileOwner('refused-quote',tab,async()=>source('text'),()=>view?.paint());
  view = new FileView(owner,undefined,()=>{},false,undefined,{reason:()=>reason,current:()=>true,append:()=> {calls++;}});byId('workspace').append(view.root as unknown as HostNode);view.root.hidden = false;view.root.inert = false;context.after(()=> {owner.dispose();view.destroy();});await owner.load();await settle();
  const editor = view.editor as unknown as HostNode,quote = (view.root as unknown as HostNode).querySelector('.file-quote-selection');assert.ok(quote);editor.setSelectionRange(0,4);editor.dispatch('select');assert.equal(quote.disabled,true);assert.equal(quote.title,reason);quote.click();assert.equal(calls,0);
  reason = '';editor.dispatch('select');view.refreshQuotation();assert.equal(quote.disabled,false);quote.click();assert.equal(calls,1);
});
test('Markdown uses the current sanitized DOM renderer and external link policy',async context=> {
  let view:FileView;const text = '# Heading\n\n[external](https://example.com) [relative](note.txt) [fragment](#heading) [script](javascript:alert)\n\n<img src="https://example.com/image">\n\n![image](https://example.com/x.png)';
  const owner = new FileOwner('w',{...tab,path:'note.md'},async()=>source(text,'note.md'),()=>view?.paint());view = new FileView(owner,undefined,()=>{},true);byId('workspace').append(view.root as unknown as HostNode);view.root.hidden = false;view.root.inert = false;context.after(()=>view.destroy());await owner.load();await settle();
  assert.equal(view.root.querySelector('h1')?.textContent,'Heading');assert.equal(view.root.querySelector('img'),null);assert.equal(view.root.querySelector('script'),null);
  const links = view.root.querySelectorAll('a');assert.equal(links.length,1);assert.equal(links[0]?.target,'_blank');assert.equal(links[0]?.rel,'noopener noreferrer');assert.match(view.root.textContent ?? '',/<img/);assert.equal(owner.source?.text,text);
});
test('source and preview share an acknowledged draft without native value assignments on acknowledgment',async context=> {
  const markdown:FileTab = {...tab,path:'shared.md'}, preview:FileTab = {...markdown,view:'preview'};
  const workspace:Workspace = {id:'shared',revision:0,conversationLayout:createPaneLayout([markdown,preview])};let revision = 0;
  const manager = new FilesViews(app.stableViews,async()=>source('# Disk','shared.md'),()=>workspace,()=>{},()=>{}, {draft:async()=>({revision:0,draft:null}),put:async(_w,_tab,_revision,base,text,encoding)=>({revision:++revision,base,text,encoding}),save:async()=> {throw new Error('not used');}});
  const sourceView = manager.view(workspace,markdown), previewView = manager.view(workspace,preview);context.after(()=> {app.stableViews().forget(sourceView.root);app.stableViews().forget(previewView.root);sourceView.destroy();previewView.destroy();});await sourceView.owner.load();assert.equal(sourceView.owner,previewView.owner);
  const editor = sourceView.editor;assert.ok(editor);editor.value = '# Draft';editor.setSelectionRange(2,5,'backward');editor.scrollTop = 42;(editor as unknown as HostNode).dispatch('input');
  assert.equal(previewView.root.querySelector('h1')?.textContent,'Disk');await sourceView.owner.drain();assert.equal(previewView.root.querySelector('h1')?.textContent,'Draft');assert.equal(editor.value,'# Draft');assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,5,'backward']);assert.equal(editor.scrollTop,42);
});
test('development reload restores file ranges and claimed focus only after matching document hydration',async context=> {
  const preview:FileTab={...tab,view:'preview'},workspace:Workspace={id:'reload-ranges',revision:0,conversationLayout:createPaneLayout([tab,preview])},text='Exact file content '.repeat(20),saved:unknown[]=[],views:FileView[]=[];
  const old=new FilesViews(app.stableViews,async()=>source(text),()=>workspace,(_workspace,_key,position)=>saved.push(position),()=>{});
  const hydrated=Promise.withResolvers<FileText>(),fresh=new FilesViews(app.stableViews,()=>hydrated.promise,()=>workspace,()=>{},()=>{});
  const slots=[new HostNode('div'),new HostNode('div')];byId('workspace').append(...slots);
  const before=old.view(workspace,tab),after=fresh.view(workspace,tab);views.push(before,old.view(workspace,preview),after,fresh.view(workspace,preview));
  context.after(()=> {for(const view of views) {app.stableViews().forget(view.root);view.destroy();}for(const slot of slots)slot.remove();});
  app.stableViews().place(before.root,slots[0] as unknown as HTMLElement);app.stableViews().place(after.root,slots[1] as unknown as HTMLElement);app.stableViews().sync();
  await before.owner.load();await settle();const original=before.editor,restored=after.editor;assert.ok(original);assert.ok(restored);assert.notEqual(original,restored);
  original.setSelectionRange(24,44,'backward');before.focus();const initial=old.checkpoint(workspace);hostDocument.body.focus();
  const restoring=fresh.restore(workspace,initial,()=>true);await Promise.resolve();assert.equal(restored.value,'');assert.equal(hostDocument.activeElement,hostDocument.body);
  hydrated.resolve(source(text));assert.equal(await restoring,true);await settle();assert.deepEqual([restored.selectionStart,restored.selectionEnd,restored.selectionDirection],[24,44,'backward']);assert.equal(hostDocument.activeElement,restored);
  for(const focused of [false,true])for(const [start,end,direction] of [[24,44,'backward'],[7,11,'forward'],[13,13,'none']] as const) {
    original.setSelectionRange(start,end,direction);before.scroller.scrollTop=500;before.scroller.scrollLeft=40;(before.scroller as unknown as HostNode).dispatch('scroll');
    if(focused)before.focus();else hostDocument.body.focus();await old.drain();const files=old.checkpoint(workspace),file=files[0],previewFile=files[1];assert.ok(file);assert.ok(previewFile);
    assert.deepEqual(file.selection,{start,end,direction});assert.equal(files[1]?.selection,undefined);assert.equal(file.focused,focused);
    restored.setSelectionRange(text.length,text.length,'none');hostDocument.body.focus();
    assert.equal(await fresh.restore(workspace,[{...file,digest:'b'.repeat(64)}],()=>true),false);
    assert.equal(await fresh.restore(workspace,[file,{...previewFile,digest:'b'.repeat(64)}],()=>true),false);
    assert.equal(await fresh.restore(workspace,[{...file,selection:{start:0,end:text.length+1,direction:'none'}}],()=>true),false);
    assert.equal(await fresh.restore(workspace,[{...file,selection:undefined}],()=>true),false);
    assert.equal(await fresh.restore(workspace,files,()=>false),false);
    assert.deepEqual([restored.selectionStart,restored.selectionEnd],[text.length,text.length]);assert.equal(hostDocument.activeElement,hostDocument.body);
    assert.equal(await fresh.restore(workspace,files,()=>true),true);await settle();
    assert.deepEqual([restored.selectionStart,restored.selectionEnd,restored.selectionDirection],[start,end,direction]);assert.equal(hostDocument.activeElement,focused ? restored : hostDocument.body);
    assert.deepEqual([after.scroller.scrollTop,after.scroller.scrollLeft],[500,40]);assert.equal(restored.value,text);
  }
  assert.ok(saved.length);assert.ok(saved.every(position=>JSON.stringify(position) === JSON.stringify({scrollTop:500,scrollLeft:40})));
});
test('queued view positions never save into a later workspace and owners survive pane placement',async context=> {
  let workspace:Workspace = {id:'a',revision:0,conversationLayout:createPaneLayout([tab])};const saves:unknown[] = [];
  const manager = new FilesViews(app.stableViews,async()=>source('content'),()=>workspace,(...args)=>saves.push(args),()=>{});
  const slot = new HostNode('div');byId('workspace').append(slot);context.after(()=>slot.remove());
  const view = manager.view(workspace,tab);app.stableViews().place(view.root,slot as unknown as HTMLElement);app.stableViews().sync();await view.owner.load();await settle();
  assert.equal(manager.view(workspace,tab),view);const owner = view.owner;
  const slotBefore = app.stableViews().slot(view.root);manager.reconcile(workspace,[tab],[tab]);assert.equal(view.root.hidden,false);assert.equal(app.stableViews().slot(view.root),slotBefore);
  view.focus();const files = manager.checkpoint(workspace);assert.equal(files[0]?.focused,true);assert.equal('text' in (files[0] ?? {}),false);
  const checkpoint = files[0];assert.ok(checkpoint);
  assert.equal(await manager.restore(workspace,[{...checkpoint,digest:'b'.repeat(64)}],()=>true),false);assert.equal(await manager.restore(workspace,files,()=>true),true);await settle();
  view.scroller.scrollTop = 100;(view.scroller as unknown as HostNode).dispatch('scroll');workspace = {id:'b',revision:0,conversationLayout:createPaneLayout([])};manager.reconcile(workspace,[],[]);manager.drain();assert.deepEqual(saves,[]);assert.equal(owner.source?.text,'content');
});
