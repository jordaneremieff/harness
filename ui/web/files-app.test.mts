import assert from 'node:assert/strict';
import test from 'node:test';
import {app,arrive,settle,byId,hostDocument,primaryFixture,primaryControl,agentFixture,targetFixture,transportLog,paneNode} from './app-fixture.mts';
import {activeTab,tabKey} from './tabs.ts';
import {splitPane,paneLeaves} from './pane-layout.ts';
import {contextMenu} from './context-menu.ts';
import type {FileTab,ConversationLayout} from '../shared/api.ts';
function currentLayout():ConversationLayout {const layout = app.state.workspace?.conversationLayout;assert.ok(layout);return layout;}
function fileTransport(context:test.TestContext):void {
  const previous = globalThis.fetch;context.after(()=> {globalThis.fetch = previous;contextMenu.close();});
  globalThis.fetch = async(input,init)=> {
    const url = new URL(String(input),'http://ui.test');
    if (url.pathname.endsWith('/text')) {const text = '# Exact file\n\nRetained source.\n';return Response.json({ok:true,data:{rootId:decodeURIComponent(url.pathname.split('/')[4] ?? ''),path:url.searchParams.get('path'),text,revision:{size:text.length,mtimeMs:1,digest:'a'.repeat(64)}}});}
    return previous(input,init);
  };
}
test('file selection retains native conversation ancestors, caret, draft, source and split geometry',async context=> {
  fileTransport(context);const target = {kind:'primary' as const,key:'p',epoch:900};
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:900})],roster:[],targets:[targetFixture('file-primary',target,{draft:{revision:1,text:'Exact draft',mode:'prompt',images:[],persisted:true}})]});
  const editor = primaryControl('editor'),form = primaryControl('composer'),parent = form.parentNode,root = primaryControl('root');editor.focus();editor.setSelectionRange(2,6,'backward');const before = transportLog.length;
  const tab:FileTab = {kind:'file',rootId:app.fileRoot.selection?.root?.id ?? '/fixture/project',path:'note.md'};app.chooseFile(tab.rootId,tab.path);await settle();
  const workspace = app.state.workspace;assert.ok(workspace);const view = app.filesViews.view(workspace,tab),owner = view.owner,source = owner.source;
  assert.deepEqual(activeTab(currentLayout()),tab);assert.equal(view.root.hidden,false);assert.equal(root.hidden,true);assert.equal(primaryControl('editor'),editor);assert.equal(form.parentNode,parent);assert.equal(editor.value,'Exact draft');assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,6,'backward']);assert.deepEqual(workspace.selectedTarget,target);
  app.chooseFile(tab.rootId,tab.path);await settle();assert.equal(app.filesViews.view(app.state.workspace as typeof workspace,tab),view);assert.equal(paneLeaves(currentLayout().root).flatMap(pane=>pane.tabs).filter(item=>item.kind === 'file').length,1);
  const layout = app.state.workspace?.conversationLayout;assert.ok(layout);app.applyLayout(splitPane(layout,layout.focusedPane,'x',{width:1000,height:700,divider:4}));await settle();assert.equal(view.owner,owner);assert.equal(owner.source,source);assert.equal(form.parentNode,parent);assert.equal(paneLeaves(currentLayout().root).length,2);
  app.openTabsList();const menu = hostDocument.body.querySelector('.context-menu');assert.ok(menu);const choice = menu.children.find(item=>item.textContent === 'note.md');assert.ok(choice);assert.equal(choice.getAttribute('aria-description'),'note.md');assert.ok(menu.children.some(item=>item.textContent === 'Refresh file'));assert.equal(menu.children.some(item=>item.textContent === 'Conversation actions'),false);
  assert.equal(transportLog.slice(before).filter(call=>call.path.endsWith('/start') || call.path === '/api/operations' || call.path.includes('/inputs')).length,0);
});
test('focused explicit Message owns the footer while a file remains the active pane',async context=> {
  fileTransport(context);const target = {kind:'primary' as const,key:'p',epoch:901},recipient = agentFixture('file-message');
  await arrive({workspace:{id:'w',revision:1,primaryKey:'p',selectedTarget:target},primaries:[primaryFixture({epoch:901})],roster:[recipient],targets:[targetFixture('file-message-primary',target),targetFixture('file-message-agent',{kind:'agent',identity:recipient.identity},{draft:{revision:1,text:'Message draft',mode:'prompt',images:[],persisted:true}})]});
  const tab:FileTab = {kind:'file',rootId:'/fixture/project',path:'note.md'};app.chooseFile(tab.rootId,tab.path);await settle();
  assert.equal(byId('workbench-status').dataset.pane,'file');byId('roster').querySelector('[data-identity="file-message"]')?.querySelector('.row-message')?.click();await settle();
  const editor = hostDocument.body.querySelector('.composer[data-message-panel="true"]')?.querySelector('textarea');assert.ok(editor);editor.focus();editor.setSelectionRange(2,6,'backward');app.renderConnection();await settle();
  assert.equal(byId('workbench-status').dataset.pane,'agent');assert.equal(byId('workbench-scope').title,recipient.identity);assert.equal(byId('workbench-status-agent').hidden,false);assert.equal(byId('workbench-status-primary').hidden,true);assert.equal(editor.value,'Message draft');assert.equal(hostDocument.activeElement,editor);assert.deepEqual([editor.selectionStart,editor.selectionEnd],[2,6]);assert.equal(activeTab(currentLayout())?.kind,'file');assert.deepEqual(app.state.workspace?.selectedTarget,target);
  byId('agent-message-close').click();await settle();assert.equal(byId('workbench-status').dataset.pane,'file');assert.equal(paneNode(app.focusedPane).querySelectorAll('.conversation-tab').find(node=>node.dataset.tabKey === tabKey(tab))?.getAttribute('aria-selected'),'true');
});
