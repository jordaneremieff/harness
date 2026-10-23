import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {createPaneLayout} from './pane-layout.ts';
import {combinedSessionRows,humanSessionTitle, type SessionRow} from './sidebar-useful.ts';
import type {SessionMetadata,SessionMetadataTarget} from '../shared/api.ts';
import {eventNames} from './transport.ts';
import {targetIdentity} from './state.ts';
import {navigationViews,validNavigationView} from './navigation-view.ts';
import {validateDevReloadCheckpoint, type DevReloadCheckpoint} from './dev-reload.ts';
const browser=await createAppFixture();
Object.assign(browser.HostNode.prototype,{showPopover():void{},hidePopover():void{}});
const {app,arrive,settle,byId,host,hostDocument,primaryFixture,agentFixture,targetFixture,primaryControl,selectionSaves,twoPanes}=browser;
const fixtureFetch=globalThis.fetch;
let metadataItems:SessionMetadata[]=[];
const metadataWrites:Record<string,unknown>[]=[];
globalThis.fetch=async(input,init)=>{
  const path=new URL(String(input),'http://ui.test').pathname;if(!path.startsWith('/api/sessions/metadata'))return fixtureFetch(input,init);
  const body=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:undefined;
  if((init?.method??'GET')==='GET')return Response.json({ok:true,data:{items:metadataItems}});
  const targets=body?.targets as SessionMetadataTarget[]|undefined;
  const target=(path.endsWith('/read')?targets?.[0]:body?.target) as SessionMetadataTarget|undefined;assert.ok(target);
  const alias=target.kind==='primary'?`primary:${target.key}`:target.kind==='agent'?`agent:${target.identity}`:`path:${target.path}`;
  const metadata=metadataItems.find(item=>item.aliases.includes(alias))??{target,aliases:[alias],title:'Untitled session',archived:false,canRename:true,canArchive:false,canRestore:false,reason:'Session state unavailable.'};
  if(path.endsWith('/read'))return Response.json({ok:true,data:{items:[metadata]}});
  metadataWrites.push(body??{});
  const next={...metadata,...(body?.action==='rename'?{name:String(body.name),title:String(body.name)}:{archived:body?.action==='archive',canArchive:body?.action==='restore',canRestore:body?.action==='archive'})};metadataItems=[...metadataItems.filter(item=>item!==metadata),next];
  return Response.json({ok:true,data:{id:'metadata-operation',kind:'session.metadata',state:'completed',createdAt:'',updatedAt:'',receipt:{kind:'rpc',result:{value:next,truncated:false}}}});
};
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
    assert.equal(byId('navigation-title').textContent,view==='sessions'?'Pi':view.charAt(0).toUpperCase()+view.slice(1));
    assert.equal(byId('navigation-back').hidden,view==='sessions');
    assert.equal(byId('navigation-back').parentNode,byId('navigation-title').parentNode);
    for (const destination of ['agents','threads','files']) {
      const actions=byId(`${destination}-view-actions`);
      assert.equal(actions.parentNode,byId('navigation-view-actions')); assert.equal(actions.hidden,destination!==view);
      assert.equal(actions.inert,actions.hidden);
    }
    assert.deepEqual(app.state.workspace?.conversationLayout,layout);assert.equal(app.primaryComposer().editor,editor);
    assert.deepEqual(ancestry(editor),parents);assert.equal(editor.value,'A retained native draft');
    assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[2,9,'backward']);
    assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading,reading);assert.equal(hostDocument.activeElement,focus,'Navigation never autofocuses a filter.');
  }
  assert.equal(selectionSaves.length,0,'Navigation never writes another page\'s layout.');
  byId('navigation-back').click();assert.equal(app.navigationViews.view,'sessions');assert.equal(hostDocument.activeElement,byId('session-new'));
});

test('dedicated destinations show every loaded row and Settings retains the current toggle state',async()=>{
  const agents=Array.from({length:12},(_,index)=>agentFixture(`destination-${index}`,{handle:undefined,state:'idle'}));
  browser.threadHandler=()=>({items:Array.from({length:12},(_,index)=>({id:`storage/${index}`,storageId:'storage',title:`Thread ${index}`,purpose:'',updatedAt:index,closed:false,members:1})),storages:[],hosts:{total:0,answered:0,unavailable:0,failed:0,notRunning:0},rosterComplete:true,truncated:false,omitted:0,bounds:{perHost:256,total:200},observedAt:new Date().toISOString()});
  await arrive({workspace:{id:'destination-lists',revision:1,primaryKey:'p',agentControl:false},primaries:[primaryFixture()],roster:agents});
  app.showNavigationView('agents');await settle();
  assert.equal(byId('roster').querySelectorAll('.agent-row').length,12);
  assert.equal(byId('agent-filter-box').hidden,false);assert.equal(byId('roster').querySelector('.roster-older'),null);
  app.showNavigationView('threads');byId('threads-refresh').click();await settle();
  assert.equal(byId('threads-list').querySelectorAll('button').length,12);assert.equal(byId('threads-filter-box').hidden,false);
  assert.equal(byId('threads-footer').querySelectorAll('button').length,0);
  selectionSaves.length=0;app.showNavigationView('settings');
  assert.deepEqual(byId('settings-choices').querySelectorAll('.settings-group-title').map(node=>node.id),['settings-preferences-title','settings-workspace-title','settings-help-title']);
  for(const name of ['preferences','workspace','help'])assert.equal(byId(`settings-${name}`).getAttribute('aria-labelledby'),`settings-${name}-title`);
  assert.deepEqual(byId('settings-preferences').querySelectorAll('button').map(node=>node.dataset.setting),['Appearance','Message input','Agent presentation control','Keyboard shortcuts']);
  assert.equal(byId('project-button').closest('.settings-group'),byId('settings-workspace'));
  assert.deepEqual(byId('settings-workspace').querySelectorAll('button').map(node=>node.dataset.setting).filter(Boolean),['Workspaces','Archived workspaces','Archived sessions','Saved drafts and messages']);
  assert.deepEqual(byId('settings-help').querySelectorAll('button').map(node=>node.dataset.setting),['Help','Version and health','Interface updates']);
  assert.equal(app.state.workspace?.agentControl,false);assert.equal(selectionSaves.length,0,'Settings navigation never changes a preference.');
  const control=byId('settings-choices').querySelectorAll('button').find(node=>node.dataset.setting==='Agent presentation control');assert.ok(control);
  assert.equal(control.getAttribute('role'),'switch');assert.equal(control.getAttribute('aria-label'),'Agent control');
  assert.equal(control.getAttribute('aria-checked'),'false');assert.equal(control.querySelector('.settings-control-switch')?.textContent,'Off');
  assert.equal(control.getAttribute('aria-describedby'),'settings-agent-control-description');
  assert.equal(byId('settings-agent-control-description').textContent,'Allow agents to arrange this workspace and show notices.');
  const description=control.querySelector('.settings-control-description'),switchState=control.querySelector('.settings-control-switch');
  byId('sidebar').scrollTop=87;control.focus();app.renderNavigation();
  assert.equal(hostDocument.activeElement,control);assert.equal(byId('sidebar').scrollTop,87);assert.equal(selectionSaves.length,0);
  control.click();await settle();
  assert.equal(app.state.workspace?.agentControl,true);assert.equal(control.getAttribute('aria-checked'),'true');
  assert.equal(control.querySelector('.settings-control-switch')?.textContent,'On');assert.equal(hostDocument.activeElement,control);
  assert.equal(control.querySelector('.settings-control-description'),description);assert.equal(control.querySelector('.settings-control-switch'),switchState);
  assert.equal(byId('settings-choices').querySelectorAll('button').find(node=>node.dataset.setting==='Agent presentation control'),control);
  const update=new browser.HostNode('span');update.className='workbench-update';update.append(new browser.HostNode('button'));byId('workbench-status').append(update);
  byId('settings-choices').querySelectorAll('button').find(node=>node.dataset.setting==='Interface updates')?.click();assert.equal(update.parentNode,byId('modal-body'));byId('modal-close').click();assert.equal(update.parentNode,byId('workbench-status'));update.remove();
});

test('stored pane layouts never restore a visible top tab strip',async()=>{
  const primary=primaryFixture({epoch:23200,activity:'idle',sessionName:'The current conversation'});
  for(const explicit of [false,true]){
    const layout=explicit?twoPanes('header-agent','primary-pane'):createPaneLayout([{kind:'primary'}]);
    await arrive({workspace:{id:`header-${explicit}`,revision:1,primaryKey:primary.key,conversationLayout:layout},primaries:[primary],roster:[agentFixture('header-agent')]});
    app.renderNavigation();
    assert.equal(byId('navigation-access').parentNode,byId('workspace'));assert.equal(byId('navigation-access').hidden,false);
    assert.equal(byId('conversation-title').textContent,'The current conversation');
    assert.equal(byId('workspace').dataset.singleConversation,'true');assert.equal(byId('workbench-status').hidden,true);
    for(const bar of byId('conversation-panes').querySelectorAll('.tab-bar'))assert.equal(bar.hidden,true);
    assert.deepEqual(app.state.workspace?.conversationLayout,layout);
  }
  const user={...browser.messageFixture('first-user',[browser.textPart('Explain this interface\nwith its exact controls')]),role:'user' as const};
  await arrive({workspace:{id:'loaded-human-title',revision:1,primaryKey:'p'},primaries:[primaryFixture({epoch:23800,sessionId:'human-title',sessionFile:'/fixture/project/human-title.jsonl',capabilities:{history:true}})],roster:[],history:[browser.entryFixture('first-entry',[user])]});await settle();
  assert.equal(byId('conversation-title').textContent,'Explain this interface');assert.equal(byId('recent-sessions').querySelector('.sidebar-content-row')?.textContent,'Explain this interface');
});

test('Sessions combines every open conversation with known sessions rather than the former small subset',async()=>{
  const primary=primaryFixture({epoch:23300,activity:'idle'}),agents=Array.from({length:9},(_,index)=>agentFixture(`recent-${index}`,{name:`Recent ${index}`}));
  const layout=createPaneLayout([{kind:'primary'},...agents.map(row=>({kind:'agent' as const,identity:row.identity}))]);
  await arrive({workspace:{id:'combined-recent',revision:1,primaryKey:primary.key,conversationLayout:layout},primaries:[primary],roster:agents});
  app.showNavigationView('sessions');
  const list=byId('recent-sessions'),rows=list.querySelectorAll('.sidebar-content-row');
  assert.equal(rows.length,10);assert.equal(new Set(rows.map(row=>row.dataset.sessionKey)).size,10);
  const last=rows.find(row=>row.dataset.sessionKey==='agent:recent-8');assert.ok(last);host.viewport=390;app.toggleSidebar(true);last.click();await settle();
  assert.equal(app.drawerOpen,false);assert.deepEqual(app.state.workspace?.selectedTarget,{kind:'agent',identity:'recent-8'});host.viewport=1200;
});

test('Recents selects only the exact saved row when no Primary is selected',async t=>{
  const first={id:'selected-saved',path:'/fixture/selected.jsonl',project:'/fixture',revision:'r',title:'Selected saved session',titleSource:'name' as const,titleState:'ready' as const,modifiedAt:'2026-01-01T00:00:00Z',size:10};
  const other={...first,id:'other-saved',path:'/fixture/other.jsonl',title:'Other saved session'},fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path==='/api/sessions/published')return Response.json({ok:true,data:{items:[first,other],total:2,omitted:0,nextCursor:null,titleCursor:null,observedAt:''}});
    if(path==='/api/sessions/history')return Response.json({ok:true,data:{session:first,entries:[],coverage:browser.coverage,leaf:null,before:null,observedAt:'2026-01-01T00:00:00Z'}});
    return fetch(input,init);
  });
  await arrive({workspace:{id:'saved-selection',revision:1,conversationLayout:createPaneLayout([{kind:'session',id:first.id,path:first.path,project:first.project,name:first.title}])},primaries:[],roster:[]});await settle();
  const rows=byId('recent-sessions').querySelectorAll('.sidebar-content-row'),selected=rows.filter(node=>node.getAttribute('aria-current')==='page');
  assert.equal(rows.length,2);assert.deepEqual(selected.map(node=>node.textContent),[first.title]);
});

test('saved header actions keep pane controls behind Arrange view and close only the captured view',async t=>{
  t.after(()=>{byId('modal-close').click();});
  const saved={id:'saved-menu',path:'/fixture/saved-menu.jsonl',project:'/fixture',revision:'r',title:'Saved conversation',titleSource:'name' as const,titleState:'ready' as const,modifiedAt:'2026-01-01T00:00:00Z',size:10},fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(new URL(String(input),'http://ui.test').pathname==='/api/sessions/history')return Response.json({ok:true,data:{session:saved,entries:[],coverage:browser.coverage,leaf:null,before:null,observedAt:''}});
    return fetch(input,init);
  });
  await arrive({workspace:{id:'saved-header-menu',revision:1,conversationLayout:createPaneLayout([{kind:'session',id:saved.id,path:saved.path,project:saved.project,name:saved.title}])},primaries:[],roster:[]});await settle();
  const trigger=byId('conversation-actions'),menu=()=>hostDocument.body.querySelector('.context-menu');
  trigger.focus();trigger.click();assert.deepEqual(menu()?.querySelectorAll('button').map(node=>node.textContent),['Conversation details','Arrange view…','Close view']);
  assert.equal(menu()?.querySelectorAll('[role="separator"]').length,1);
  chooseMenu('Conversation details');assert.equal(byId('modal-title').textContent,'Conversation details');byId('modal-close').click();assert.equal(hostDocument.activeElement,trigger);
  trigger.click();chooseMenu('Arrange view…');
  const labels=menu()?.querySelectorAll('button').map(node=>node.textContent)??[];
  for(const label of ['Split right','Split down','Move tab to pane','Close tab','Close pane','Close others','Close all'])assert.ok(labels.some(text=>text.startsWith(label)),label);
  menu()?.dispatch('keydown',{key:'Escape'});assert.equal(hostDocument.activeElement,trigger);
  trigger.click();const stale=menu()?.querySelectorAll('button').find(node=>node.textContent==='Close view');assert.ok(stale);
  const workspace=app.state.workspace;assert.ok(workspace);workspace.revision++;const before=structuredClone(workspace.conversationLayout);stale.click();await settle();assert.deepEqual(app.state.workspace?.conversationLayout,before);workspace.revision--;
  const start=browser.transportLog.length;trigger.click();chooseMenu('Close view');await settle();
  assert.equal(byId('conversation-actions').disabled,true);assert.equal(hostDocument.activeElement,trigger);
  assert.equal(browser.transportLog.slice(start).some(call=>call.path==='/api/operations'||call.path.startsWith('/api/sessions/metadata')),false);
});

test('stopped Primary keeps terminal command and Copy in details instead of the conversation summary',async t=>{
  t.after(()=>byId('modal-close').click());
  const primary=primaryFixture({epoch:24000,lifecycle:'stopped',activity:'idle',sessionId:'stopped-details',sessionFile:"/fixture/project/quoted's session.jsonl"}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  await arrive({workspace:{id:'stopped-details',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[targetFixture('stopped-details-draft',target)]});await settle();
  const summary=primaryControl('root').querySelector('.session-state-bar');assert.ok(summary);
  assert.equal(summary.querySelector('.session-state-label')?.textContent,'Closed');assert.equal(summary.querySelector('.session-resume-command'),null);
  assert.equal(summary.querySelectorAll('button').find(node=>node.getAttribute('aria-label')==='Copy resume command'),undefined);
  byId('conversation-actions').click();chooseMenu('Conversation details');
  const detail=byId('modal-body').querySelector('.session-state-bar');assert.ok(detail);
  assert.equal(detail.querySelector('.session-resume-command')?.hidden,false);assert.equal(detail.querySelector('.session-resume-command')?.textContent,"pi --session '/fixture/project/quoted'\\''s session.jsonl'");
  const resume=detail.querySelectorAll('button').find(node=>node.textContent==='Resume');assert.ok(resume);assert.equal(resume.hidden,false);
  const copy=detail.querySelectorAll('button').find(node=>node.getAttribute('aria-label')==='Copy resume command');assert.ok(copy);assert.equal(copy.hidden,false);
  const start=browser.transportLog.length;browser.event('primary.state',{...primary,sessionId:'replacement',sessionFile:'/fixture/project/replacement.jsonl'});await settle();resume.click();await settle();
  assert.equal(browser.transportLog.slice(start).some(call=>call.path==='/api/operations'),false,'Old details never resume the replacement session.');
});

test('recent rows merge exact known identities without merging equal names',()=>{
  const row=(key:string,identities:string[]):SessionRow=>({key,identities,name:'Same name',at:0,title:''});
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

function chooseMenu(label:string):void {
  const item=hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').find(node=>node.textContent===label);assert.ok(item,label);item.click();
}
test('tablet drawer blocks background controls and restores focus without moving the editor',async t=>{
  t.after(()=>{host.viewport=1200;app.toggleSidebar(false);});
  const primary=primaryFixture({epoch:23500,activity:'idle'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  await arrive({workspace:{id:'tablet-modal',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[targetFixture('tablet-draft',target,{draft:{revision:1,text:'Keep this draft',mode:'prompt',images:[],persisted:true}})]});
  const editor=primaryControl('editor'),parents=ancestry(editor);editor.focus();editor.setSelectionRange(3,7,'backward');host.viewport=768;app.toggleSidebar(true);
  assert.equal(byId('sidebar').getAttribute('role'),'dialog');assert.equal(byId('sidebar').getAttribute('aria-modal'),'true');assert.equal(byId('sidebar-scrim').hidden,false);
  assert.equal(byId('navigation-access').inert,true);assert.ok(ancestry(editor).some(node=>node.inert));editor.focus();assert.equal(hostDocument.activeElement,byId('sidebar-close'));
  byId('sidebar-scrim').click();assert.equal(app.drawerOpen,false);assert.equal(hostDocument.activeElement,editor);assert.equal(ancestry(editor).some(node=>node.inert),false);
  assert.deepEqual(ancestry(editor),parents);assert.deepEqual([editor.value,editor.selectionStart,editor.selectionEnd,editor.selectionDirection],['Keep this draft',3,7,'backward']);
  host.viewport=1000;app.renderNavigation();assert.equal(byId('sidebar').hidden,false);assert.equal(byId('sidebar').getAttribute('aria-modal'),null);assert.equal(byId('sidebar-scrim').hidden,true);
});

test('session metadata rename, archive, restore and replacement use exact aliases without input or Resume',async t=>{
  t.after(()=>{metadataItems=[];byId('modal-close').click();});metadataWrites.length=0;
  const primary=primaryFixture({epoch:23600,lifecycle:'stopped',activity:'idle',sessionId:'native-a',sessionFile:'/fixture/project/a.jsonl',sessionName:'Research topic'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  metadataItems=[{target,aliases:['primary:p','path:/fixture/project/a.jsonl','id:native-a'],title:'Untitled session',archived:false,canRename:true,canArchive:true,canRestore:false}];
  await arrive({workspace:{id:'session-labels',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[targetFixture('labels-draft',target)]});app.showNavigationView('sessions');await settle();selectionSaves.length=0;
  const editor=primaryControl('editor'),parents=ancestry(editor),rows=()=>byId('recent-sessions').querySelectorAll('.sidebar-content-row');
  assert.equal(rows()[0]?.textContent,'Research topic');assert.equal(rows()[0]?.getAttribute('aria-label'),'Research topic');
  const origin=byId('recent-sessions').querySelector('.session-row-menu');assert.ok(origin);origin.focus();origin.click();await settle();
  const popup=hostDocument.body.querySelector('.context-menu'),focused=hostDocument.activeElement;app.renderNavigation();await settle();
  assert.equal(origin.isConnected,true,'A live repaint keeps the menu anchor connected.');assert.equal(byId('recent-sessions').querySelector('.session-row-menu')===origin,true);assert.equal(hostDocument.body.querySelector('.context-menu')===popup,true);assert.equal(hostDocument.activeElement===focused,true);assert.equal(origin.getAttribute('aria-expanded'),'true');chooseMenu('Rename');
  byId('session-rename-name').value='A useful title';byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Save')?.click();await settle();
  assert.equal(rows()[0]?.textContent,'A useful title');assert.equal(byId('conversation-title').textContent,'A useful title');assert.equal(selectionSaves.length,0);
  byId('recent-sessions').querySelector('.session-row-menu')?.click();await settle();chooseMenu('Archive');await settle();
  assert.equal(rows().length,0);assert.equal(hostDocument.activeElement,byId('sessions-heading'));assert.deepEqual(ancestry(editor),parents);assert.equal(byId('conversation-title').textContent,'A useful title');
  assert.deepEqual(metadataWrites.map(item=>item.action),['rename','archive']);assert.equal(metadataWrites[1]?.title,'A useful title');
  const reservation=browser.transportLog.filter(item=>item.path==='/api/operations').at(-1);assert.deepEqual(reservation?.body,{kind:'session.metadata'});
  app.showNavigationView('settings');byId('settings-choices').querySelectorAll('button').find(node=>node.dataset.setting==='Archived sessions')?.click();await settle();
  assert.equal(byId('modal-body').querySelector('.sidebar-content-row')?.textContent,'A useful title');byId('modal-body').querySelector('.session-row-menu')?.click();await settle();chooseMenu('Restore');await settle();
  assert.equal(rows()[0]?.textContent,'A useful title');assert.equal(byId('modal-body').textContent,'No archived sessions.');assert.equal(hostDocument.activeElement,byId('modal-close'));assert.equal(selectionSaves.length,0);
  byId('modal-close').click();assert.equal(eventNames.filter(name=>name==='sessions.metadata').length,1);
  const originalMetadata=metadataItems[0];assert.ok(originalMetadata);
  const renamed={...originalMetadata,name:'Name from the event'};browser.event('sessions.metadata',renamed);assert.equal(byId('conversation-title').textContent,'Name from the event');
  metadataItems=[{...renamed,target:{kind:'session',id:'native-a',path:'/fixture/project/a.jsonl',project:'/fixture/project'},aliases:['path:/fixture/project/a.jsonl','id:native-a'],archived:true}];
  browser.event('primary.state',{...primary,sessionId:'native-b',sessionFile:'/fixture/project/b.jsonl',sessionName:undefined});await settle();
  assert.equal(byId('conversation-title').textContent,'Untitled session');assert.equal(rows()[0]?.textContent,'Untitled session');
  app.showNavigationView('sessions');byId('recent-sessions').querySelector('.session-row-menu')?.click();await settle();chooseMenu('Rename');byId('session-rename-name').value='Keep this refusal input';
  const writes=metadataWrites.length;browser.event('primary.state',{...primary,sessionId:'native-c',sessionFile:'/fixture/project/c.jsonl',sessionName:undefined});
  byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Save')?.click();await settle();assert.equal(metadataWrites.length,writes);assert.equal(byId('session-rename-name').value,'Keep this refusal input');assert.match(byId('modal-error').textContent,/session changed/);
  assert.equal(humanSessionTitle(['project · abcdef12','A loaded prompt']),'A loaded prompt');
});

test('metadata listing retains unrelated archive facts when a live mutation arrives during its read',async t=>{
  const primary=primaryFixture({epoch:23900,activity:'idle',sessionId:'race-primary',sessionFile:'/fixture/project/race-primary.jsonl',sessionName:'Original title'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch},identity='archived-during-list';
  const before:SessionMetadata={target,aliases:['primary:p','path:/fixture/project/race-primary.jsonl','id:race-primary'],title:'Original title',archived:false,canRename:true,canArchive:false,canRestore:false};
  const archived:SessionMetadata={target:{kind:'agent',identity},aliases:[`agent:${identity}`],title:'Already archived',archived:true,canRename:true,canArchive:false,canRestore:true};
  const snapshot=[before,archived],fetch=globalThis.fetch;let release!:()=>void,started!:()=>void,hold=true;
  const gate=new Promise<void>(resolve=>{release=resolve;}),reading=new Promise<void>(resolve=>{started=resolve;});
  t.after(()=>{release();metadataItems=[];});
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(hold&&new URL(String(input),'http://ui.test').pathname==='/api/sessions/metadata'&&(init?.method??'GET')==='GET'){hold=false;started();await gate;return Response.json({ok:true,data:{items:snapshot}});}
    return fetch(input,init);
  });
  const arrival=arrive({workspace:{id:'metadata-list-race',revision:1,primaryKey:primary.key,conversationLayout:createPaneLayout([{kind:'primary'},{kind:'agent',identity}])},primaries:[primary],roster:[agentFixture(identity)],targets:[targetFixture('metadata-race-draft',target)]});
  await reading;await arrival;browser.event('sessions.metadata',{...before,name:'Name from the mutation'});release();await settle();
  const names=byId('recent-sessions').querySelectorAll('.sidebar-content-row').map(node=>node.textContent);
  assert.deepEqual(names,['Name from the mutation']);assert.equal(byId('conversation-title').textContent,'Name from the mutation');
});

test('message box range and desktop handle share one height preference and preserve the native draft',async t=>{
  t.after(()=>{byId('modal-close').click();host.viewport=1200;});host.viewport=390;
  const primary=primaryFixture({epoch:23700,activity:'idle'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  await arrive({workspace:{id:'message-size',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[targetFixture('size-draft',target,{draft:{revision:1,text:'A draft with its caret',mode:'prompt',images:[],persisted:true}})]});
  const editor=primaryControl('editor'),parents=ancestry(editor);editor.setSelectionRange(2,8,'backward');
  byId('conversation-actions').click();chooseMenu('Message box size');const range=byId('message-box-height');range.value='100';range.dispatch('input');await settle();
  const key=`ui:pane:message-size:${targetIdentity(target)}:composer-min`;assert.equal(browser.hostSessionStorage.getItem(key),'100');
  byId('modal-close').click();const handle=primaryControl('composer').querySelector('.resizer');assert.ok(handle);handle.dispatch('keydown',{key:'End'});await settle();
  byId('conversation-actions').click();chooseMenu('Message box size');assert.equal(byId('message-box-height').value,browser.hostSessionStorage.getItem(key));
  byId('modal-body').querySelectorAll('button').find(node=>node.textContent==='Automatic height')?.click();await settle();assert.equal(browser.hostSessionStorage.getItem(key),null);
  assert.deepEqual(ancestry(editor),parents);assert.deepEqual([editor.value,editor.selectionStart,editor.selectionEnd,editor.selectionDirection],['A draft with its caret',2,8,'backward']);
});
