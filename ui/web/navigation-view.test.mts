import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {createPaneLayout} from './pane-layout.ts';
import {combinedSessionRows, type SessionRow} from './sidebar-useful.ts';
import {navigationViews,validNavigationView} from './navigation-view.ts';
import {validateDevReloadCheckpoint, type DevReloadCheckpoint} from './dev-reload.ts';
const browser=await createAppFixture();
const {app,arrive,settle,byId,host,hostDocument,primaryFixture,agentFixture,targetFixture,primaryControl,selectionSaves,twoPanes}=browser;
const sections={sessions:'primary-section',agents:'roster-section',threads:'threads-section',files:'files-section',settings:'settings-section'};
function ancestry(node:HostNode):HostNode[]{const nodes:HostNode[]=[];for(let item:HostNode|null=node;item;item=item.parentNode)nodes.push(item);return nodes;}

test('named navigation views preserve pane layout, native editor, caret, draft and reading ownership',async t=>{
  t.after(()=>{host.viewport=1200;app.toggleSidebar(false);});
  const primary=primaryFixture({epoch:23100,activity:'idle'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  const saved=targetFixture('navigation-primary',target,{draft:{revision:1,text:'A retained native draft',mode:'prompt',images:[],persisted:true}});
  await arrive({workspace:{id:'navigation-owners',revision:1,primaryKey:primary.key,selectedTarget:target,conversationLayout:twoPanes('navigation-agent','primary-pane')},primaries:[primary],roster:[agentFixture('navigation-agent')],targets:[saved,targetFixture('navigation-agent-draft',{kind:'agent',identity:'navigation-agent'})]});
  const layout=structuredClone(app.state.workspace?.conversationLayout),reading=structuredClone(saved.reading),editor=primaryControl('editor'),parents=ancestry(editor);
  editor.setSelectionRange(2,9,'backward');host.viewport=390;app.toggleSidebar(true);selectionSaves.length=0;
  const focus=hostDocument.activeElement;
  for(const view of navigationViews){
    app.showNavigationView(view);await settle();
    for(const [name,id]of Object.entries(sections)){assert.equal(byId(id).hidden,name!==view,`${view}: ${id}`);assert.equal(byId(id).inert,name!==view);}
    assert.equal(byId('navigation-title').textContent,view.charAt(0).toUpperCase()+view.slice(1));
    assert.equal(byId('navigation-back').hidden,view==='sessions');
    assert.deepEqual(app.state.workspace?.conversationLayout,layout);assert.equal(app.primaryComposer().editor,editor);
    assert.deepEqual(ancestry(editor),parents);assert.equal(editor.value,'A retained native draft');
    assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,9,'backward']);
    assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading,reading);assert.equal(hostDocument.activeElement,focus,'Navigation never autofocuses a filter.');
  }
  assert.equal(selectionSaves.length,0,'Navigation never writes another page\'s layout.');
  byId('navigation-back').click();assert.equal(app.navigationViews.view,'sessions');assert.equal(hostDocument.activeElement,byId('session-new'));
});

test('stored pane layouts never restore a visible top tab strip',async()=>{
  const primary=primaryFixture({epoch:23200,activity:'idle',sessionName:'The current conversation'});
  for(const explicit of [false,true]){
    const layout=explicit?twoPanes('header-agent','primary-pane'):createPaneLayout([{kind:'primary'}]);
    await arrive({workspace:{id:`header-${explicit}`,revision:1,primaryKey:primary.key,conversationLayout:layout},primaries:[primary],roster:[agentFixture('header-agent')]});
    app.renderNavigation();
    assert.equal(byId('navigation-access').parentNode,byId('workspace'));assert.equal(byId('navigation-access').hidden,false);
    assert.equal(byId('conversation-title').textContent,'The current conversation');
    assert.equal(byId('workspace').dataset.singleConversation,'true');
    for(const bar of byId('conversation-panes').querySelectorAll('.tab-bar'))assert.equal(bar.hidden,true);
    assert.deepEqual(app.state.workspace?.conversationLayout,layout);
  }
});

test('Sessions combines every open conversation with known sessions rather than the former small subset',async()=>{
  const primary=primaryFixture({epoch:23300,activity:'idle'}),agents=Array.from({length:9},(_,index)=>agentFixture(`recent-${index}`,{name:`Recent ${index}`}));
  const layout=createPaneLayout([{kind:'primary'},...agents.map(row=>({kind:'agent' as const,identity:row.identity}))]);
  await arrive({workspace:{id:'combined-recent',revision:1,primaryKey:primary.key,conversationLayout:layout},primaries:[primary],roster:agents});
  app.showNavigationView('sessions');
  const list=byId('recent-sessions'),rows=list.querySelectorAll('button');
  assert.equal(rows.length,10);assert.equal(new Set(rows.map(row=>row.dataset.sessionKey)).size,10);
  const last=rows.find(row=>row.dataset.sessionKey==='agent:recent-8');assert.ok(last);host.viewport=390;app.toggleSidebar(true);last.click();await settle();
  assert.equal(app.drawerOpen,false);assert.deepEqual(app.state.workspace?.selectedTarget,{kind:'agent',identity:'recent-8'});host.viewport=1200;
});

test('recent rows merge exact known identities without merging equal names',()=>{
  const row=(key:string,identities:string[]):SessionRow=>({key,identities,name:'Same name',at:0,state:'',title:''});
  const first=row('open-primary',['primary:p','path:/project/a.jsonl','id:a']);
  const rows=combinedSessionRows([first,row('agent',['agent:exact'])],[row('saved-a',['path:/project/a.jsonl','id:a']),row('saved-b',['path:/project/b.jsonl','id:b'])]);
  assert.deepEqual(rows.map(item=>item.key),['open-primary','agent','saved-b']);assert.equal(rows[0],first);
});

test('reload restores the Agents drawer before its focused native Message editor',async t=>{
  t.after(()=>{byId('agent-message-close').click();host.viewport=1200;});
  const primary=primaryFixture({epoch:23400,activity:'idle'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch},identity='navigation-message';
  await arrive({workspace:{id:'navigation-reload',revision:1,primaryKey:primary.key,conversationLayout:twoPanes(identity,'primary-pane')},primaries:[primary],roster:[agentFixture(identity)],targets:[targetFixture('navigation-reload-draft',target),targetFixture('navigation-message-draft',{kind:'agent',identity},{draft:{revision:1,text:'Retained Message draft',mode:'prompt',images:[],persisted:true}})]});
  host.viewport=390;app.toggleSidebar(true);app.openConversationActions('agent-pane');const message=hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').find(node=>node.textContent==='Message');assert.ok(message);message.click();await settle();
  const editor=hostDocument.body.querySelector('.composer[data-message-panel="true"] textarea');assert.ok(editor);editor.focus();editor.setSelectionRange(2,8,'backward');
  await app.drainDev(new AbortController().signal);await settle();
  const checkpoint:DevReloadCheckpoint={...app.captureDevCheckpoint(),version:1,generation:'a'.repeat(64),oldClient:'b'.repeat(24),capturedAt:Date.now(),interactionRevision:0};
  assert.equal(checkpoint.navigationView,'agents');assert.equal(checkpoint.drawerOpen,true);assert.equal(checkpoint.focusedControl?.kind,'message');
  assert.ok(validateDevReloadCheckpoint(checkpoint,checkpoint.generation,Date.now()));
  assert.equal(validateDevReloadCheckpoint({...checkpoint,navigationView:'unknown'},checkpoint.generation,Date.now()),null);assert.equal(validNavigationView('unknown'),false);
  byId('agent-message-close').click();app.showNavigationView('sessions');app.toggleSidebar(false);
  assert.equal(await app.restoreDevCheckpoint(checkpoint,new AbortController().signal),true);
  assert.equal(app.navigationViews.view,'agents');assert.equal(app.drawerOpen,true);assert.equal(byId('agent-message-region').hidden,false);
  assert.equal(hostDocument.body.querySelector('.composer[data-message-panel="true"] textarea'),editor);assert.equal(hostDocument.activeElement,editor);assert.equal(editor.value,'Retained Message draft');
});
