import assert from 'node:assert/strict';
import test from 'node:test';
import {FileOwner} from './file-owner.ts';
import {FileView} from './file-view.ts';
import {FilesViews} from './files-views.ts';
import {byId,settle,HostNode,app} from './app-fixture.mts';
import {createPaneLayout} from './pane-layout.ts';
import type {FileTab,Workspace} from '../shared/api.ts';
import type {FileText} from '../shared/files.ts';
const tab:FileTab = {kind:'file',rootId:'r',path:'note.txt'};
function source(text:string,path = tab.path):FileText {return {rootId:'r',path,text,revision:{size:text.length,mtimeMs:1,digest:'a'.repeat(64)}};}
test('view retains exact plain text, reading position and DOM on an unchanged refresh',async context=> {
  const saved:unknown[] = [];let view:FileView;
  const owner = new FileOwner('w',tab,async()=>source('\ufeff<script>x</script>\r\nlast\r'),()=>view?.paint());
  view = new FileView(owner,{scrollTop:120,scrollLeft:8},position=>saved.push(position));byId('workspace').append(view.root as unknown as HostNode);view.root.hidden = false;view.root.inert = false;context.after(()=>view.destroy());
  await owner.load();await settle();const pre = view.root.querySelector('pre');assert.ok(pre);assert.equal(pre.textContent,owner.source?.text);assert.equal(view.root.querySelector('textarea'),null);assert.equal(view.root.querySelector('script'),null);
  assert.equal(view.scroller.scrollTop,120);view.scroller.scrollTop = 240;(view.scroller as unknown as HostNode).dispatch('scroll');assert.deepEqual(saved,[{scrollTop:240,scrollLeft:8}]);
  await owner.load(true);assert.equal(view.root.querySelector('pre'),pre);assert.equal(view.scroller.scrollTop,240);assert.notEqual(owner,view);
});
test('Markdown uses the current sanitized DOM renderer and external link policy',async context=> {
  let view:FileView;const text = '# Heading\n\n[external](https://example.com) [relative](note.txt) [fragment](#heading) [script](javascript:alert)\n\n<img src="https://example.com/image">\n\n![image](https://example.com/x.png)';
  const owner = new FileOwner('w',{...tab,path:'note.md'},async()=>source(text,'note.md'),()=>view?.paint());view = new FileView(owner,undefined,()=>{});byId('workspace').append(view.root as unknown as HostNode);view.root.hidden = false;view.root.inert = false;context.after(()=>view.destroy());await owner.load();await settle();
  assert.equal(view.root.querySelector('h1')?.textContent,'Heading');assert.equal(view.root.querySelector('img'),null);assert.equal(view.root.querySelector('script'),null);
  const links = view.root.querySelectorAll('a');assert.equal(links.length,1);assert.equal(links[0]?.target,'_blank');assert.equal(links[0]?.rel,'noopener noreferrer');assert.match(view.root.textContent ?? '',/<img/);assert.equal(owner.source?.text,text);
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
