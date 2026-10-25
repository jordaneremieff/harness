import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {createPaneLayout} from './pane-layout.ts';
import {combinedSessionRows,humanSessionTitle,operatorTime,recentGroup, type SessionRow} from './sidebar-useful.ts';
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
    assert.equal(byId('navigation-title').textContent,view==='sessions'?'Sessions':view.charAt(0).toUpperCase()+view.slice(1));
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
  assert.deepEqual(byId('settings-preferences').querySelectorAll('button').map(node=>node.dataset.setting),['Appearance','Agent presentation control','Keyboard shortcuts']);
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

test('a pane shows its top tab strip only when it holds two or more tabs',async()=>{
  const primary=primaryFixture({epoch:23200,activity:'idle',sessionName:'The current conversation'});
  for(const shape of ['single','panes','tabs'] as const){
    const layout=shape==='panes'?twoPanes('header-agent','primary-pane'):shape==='tabs'?createPaneLayout([{kind:'primary'},{kind:'agent',identity:'header-agent'}]):createPaneLayout([{kind:'primary'}]);
    await arrive({workspace:{id:`header-${shape}`,revision:1,primaryKey:primary.key,conversationLayout:layout},primaries:[primary],roster:[agentFixture('header-agent')]});
    app.renderNavigation();
    assert.equal(byId('navigation-access').parentNode,byId('workspace'));assert.equal(byId('navigation-access').hidden,false);
    assert.equal(byId('conversation-title').textContent,'The current conversation');
    assert.equal(byId('workbench-status').hidden,true);
    for(const bar of byId('conversation-panes').querySelectorAll('.tab-bar'))assert.equal(bar.hidden,shape!=='tabs',`${shape}: a strip with one tab stays hidden`);
    assert.deepEqual(app.state.workspace?.conversationLayout,layout);
  }
  const user={...browser.messageFixture('first-user',[browser.textPart('Explain this interface\nwith its exact controls')]),role:'user' as const};
  await arrive({workspace:{id:'loaded-human-title',revision:1,primaryKey:'p'},primaries:[primaryFixture({epoch:23800,sessionId:'human-title',sessionFile:'/fixture/project/human-title.jsonl',capabilities:{history:true}})],roster:[],history:[browser.entryFixture('first-entry',[user])]});await settle();
  assert.equal(byId('conversation-title').textContent,'Explain this interface');assert.equal(byId('recent-sessions').querySelector('.sidebar-content-row')?.textContent,'Explain this interface');
});

test('Recents excludes empty ordinary rows and model-owned or unknown native tabs without a bootstrap open',async()=>{
  const active=primaryFixture({key:'operator-active',epoch:23301,hasMessages:true,createdAt:100,lastUserAt:200,lastAnswerAt:300});
  const stale=primaryFixture({key:'stale-capacity',epoch:1,lifecycle:'stopped',activity:'idle',hasMessages:false});
  const empty=primaryFixture({key:'header-only',epoch:23302,hasMessages:false,sessionFile:'/fixture/header-only.jsonl',createdAt:900});
  const agents=[
    agentFixture('operator-live',{recents:{creator:'operator',createdAt:100,lastAnswerAt:500,hasMessages:true}}),
    agentFixture('operator-stored',{availability:'stored',recents:{creator:'operator',createdAt:400,hasMessages:true}}),
    agentFixture('operator-empty',{recents:{creator:'operator',createdAt:900,hasMessages:false}}),
    agentFixture('model-worker',{recents:{creator:'agent',createdAt:1000,hasMessages:true}}),
    agentFixture('unknown-lead',{recents:{creator:'unknown',createdAt:2000,hasMessages:true}}),
    agentFixture('owned-child'),
    agentFixture('operator-rewind:2',{recents:{creator:'operator',lastUserAt:600,lastAnswerAt:700,hasMessages:true}}),
    agentFixture('model-child:2',{recents:{creator:'agent',lastUserAt:10000,hasMessages:true}}),
    agentFixture('plain-fork:2',{recents:{creator:'unknown',lastUserAt:11000,hasMessages:true}}),
  ];
  const layout=createPaneLayout([{kind:'primary'},...agents.map(row=>({kind:'agent' as const,identity:row.identity}))]);
  const calls=browser.transportLog.length;
  await arrive({workspace:{id:'recents-policy',revision:1,primaryKey:active.key,selectedTarget:{kind:'primary',key:active.key,epoch:active.epoch},conversationLayout:layout},primaries:[active,stale,empty],roster:agents,targets:[targetFixture('recents-active-draft',{kind:'primary',key:active.key,epoch:active.epoch})]});
  app.showNavigationView('sessions');
  const keys=()=>byId('recent-sessions').querySelectorAll('.sidebar-content-row').map(row=>row.dataset.sessionKey);
  assert.ok(keys().includes('agent:operator-live'));assert.ok(keys().includes('agent:operator-stored'));assert.ok(byId('recent-sessions').querySelectorAll('.sidebar-content-row').some(row=>row.getAttribute('aria-current')==='page'));
  for(const key of ['primary:stale-capacity','stale-capacity','primary:header-only','header-only','/fixture/header-only.jsonl','agent:operator-empty','agent:model-worker','agent:unknown-lead','agent:owned-child','agent:model-child:2','agent:plain-fork:2'])assert.equal(keys().includes(key),false,key);
  assert.equal(keys()[0],'agent:operator-rewind:2');
  assert.equal(primaryControl('editor').disabled,false);
  assert.equal(browser.transportLog.slice(calls).some(call=>call.method==='POST'&&call.path.split('?')[0]==='/api/primaries'),false);
  const rewind=byId('recent-sessions').querySelector('.sidebar-content-row[data-session-key="agent:operator-rewind:2"]');assert.ok(rewind);rewind.click();await settle();
  assert.deepEqual(app.state.workspace?.selectedTarget,{kind:'agent',identity:'operator-rewind:2'});
  app.showNavigationView('agents');assert.equal(byId('roster-section').hidden,false);
  assert.ok(app.state.roster.has('unknown-lead'));assert.ok(app.state.roster.has('model-worker'));
});

test('selected stopped and failed fileless empty sessions stay visible across reload without an implicit open',async()=>{
  for(const lifecycle of ['stopped','failed'] as const){
    const current=primaryFixture({key:`selected-${lifecycle}`,epoch:23310,lifecycle,activity:'unknown',hasMessages:false}),calls=browser.transportLog.length;
    await arrive({workspace:{id:`selected-empty-${lifecycle}`,revision:1,primaryKey:current.key,selectedTarget:{kind:'primary',key:current.key,epoch:current.epoch}},primaries:[current],roster:[]});
    app.showNavigationView('sessions');
    const rows=byId('recent-sessions').querySelectorAll('.sidebar-content-row');assert.equal(rows.length,1);assert.equal(rows[0].getAttribute('aria-current'),'page');
    assert.doesNotMatch(rows[0].querySelector('.sidebar-session-context')?.textContent??'',/ago|now|Today/);
    assert.equal(app.state.primaries.get(current.key)?.lifecycle,lifecycle);assert.equal(app.state.primaries.get(current.key)?.createdAt,undefined);
    assert.equal(browser.transportLog.slice(calls).some(call=>call.method==='POST'&&(call.path.split('?')[0]==='/api/primaries'||(call.body as {kind?:unknown}|undefined)?.kind==='primary.open')),false);
  }
});

test('Sessions combines confirmed operator tabs with known sessions',async()=>{
  const primary=primaryFixture({epoch:23300,activity:'idle'}),agents=Array.from({length:9},(_,index)=>agentFixture(`recent-${index}`,{name:`Recent ${index}`,recents:{creator:'operator',hasMessages:true,createdAt:index+1}}));
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
  assert.equal(rows.length,2);assert.deepEqual(selected.map(node=>node.querySelector('.row-title')?.textContent),[first.title]);
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
  trigger.focus();trigger.click();assert.deepEqual(menu()?.querySelectorAll('button').map(node=>node.textContent),['Session details','Display','Commands']);
  assert.equal(menu()?.querySelectorAll('[role="separator"]').length,0);
  chooseMenu('Session details');assert.equal(byId('modal-title').textContent,'Conversation details');assert.ok(byId('modal').querySelectorAll('.session-summary-action-label').map(node=>node.textContent).includes('Copy session ID'),'the sheet leads with a summary and copy actions');byId('modal-close').click();assert.equal(hostDocument.activeElement,trigger);
  trigger.click();chooseMenu('Display');chooseMenu('Arrange view…');
  const labels=menu()?.querySelectorAll('button').map(node=>node.textContent)??[];
  for(const label of ['Split right','Split down','Move tab to pane','Close tab','Close pane','Close others','Close all'])assert.ok(labels.some(text=>text.startsWith(label)),label);
  menu()?.dispatch('keydown',{key:'Escape'});assert.equal(hostDocument.activeElement,trigger);
  trigger.click();chooseMenu('Display');const stale=menu()?.querySelectorAll('button').find(node=>node.textContent==='Close view');assert.ok(stale);
  const workspace=app.state.workspace;assert.ok(workspace);workspace.revision++;const before=structuredClone(workspace.conversationLayout);stale.click();await settle();assert.deepEqual(app.state.workspace?.conversationLayout,before);workspace.revision--;
  const start=browser.transportLog.length;trigger.click();chooseMenu('Display');chooseMenu('Close view');await settle();
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
  assert.deepEqual(byId('modal-body').querySelectorAll('.session-summary-action-label').map(node=>node.textContent).slice(0,2),['Copy session ID','Copy resume command'],'a stopped Primary offers its ID and resume command at the head of the sheet');
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
  host.viewport=390;app.toggleSidebar(true);app.openConversationActions('agent-pane');chooseMenu('Tasks');const message=hostDocument.body.querySelector('.context-menu')?.querySelectorAll('button').find(node=>node.textContent==='Message');assert.ok(message);message.click();await settle();
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

test('direct destinations and Settings pages retain the conversation without input or preference writes',async()=>{
  await arrive({workspace:{id:'navigation-pages',revision:1,primaryKey:'p'},primaries:[primaryFixture()],roster:[]});
  const editor=primaryControl('editor'),parents=ancestry(editor),start=browser.transportLog.length;
  selectionSaves.length=0;
  for(const view of ['agents','threads','files'] as const){byId(`navigate-${view}`).click();assert.equal(app.navigationViews.view,view);byId('navigation-back').click();}
  byId('settings-button').click();assert.equal(byId('settings-preferences').hidden,false);assert.equal(byId('settings-workspace').hidden,true);assert.equal(byId('settings-help').hidden,true);
  byId('settings-workspace-page').click();assert.equal(byId('settings-workspace').hidden,false);assert.equal(byId('settings-preferences').hidden,true);
  byId('settings-back').click();byId('settings-help-page').click();assert.equal(byId('settings-help').hidden,false);byId('settings-back').click();
  assert.deepEqual(ancestry(editor),parents);assert.equal(selectionSaves.length,0);
  assert.equal(browser.transportLog.slice(start).some(call=>call.path.includes('/inputs')||call.path==='/api/operations'),false);
});

test('recent rows join bounded title cursors and filter only loaded context without transcript reads',async t=>{
  const saved={id:'cursor-session',path:'/fixture/project/cursor-session.jsonl',project:'/fixture/project',revision:'r',title:'(title pending)',titleState:'pending' as const,modifiedAt:'2026-10-23T00:00:00Z',size:10};
  const fetch=globalThis.fetch,reads:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input),'http://ui.test');
    if(url.pathname==='/api/sessions'){
      reads.push(url.href);const filled=url.searchParams.has('titles');
      return Response.json({ok:true,data:{items:[filled?{...saved,title:'A recognisable prompt',titleSource:'prompt',titleState:'ready'}:saved],total:1,omitted:0,nextCursor:null,titleCursor:filled?null:'bounded-cursor',observedAt:''}});
    }
    return fetch(input,init);
  });
  const primary=primaryFixture({epoch:24100,sessionId:saved.id,sessionFile:saved.path,sessionName:undefined});
  await arrive({workspace:{id:'cursor-rows',revision:1,primaryKey:primary.key},primaries:[primary],roster:[]});await settle();
  const row=byId('recent-sessions').querySelector('.sidebar-content-row');assert.ok(row);
  assert.equal(row.querySelector('.row-title')?.textContent,'A recognisable prompt');assert.match(row.querySelector('.sidebar-session-context')?.textContent??'',/project/);
  assert.equal(reads.length,2);assert.ok(reads[1]?.includes('titles=bounded-cursor'));
  const requests=browser.transportLog.length,filter=byId('session-search');filter.value='not in loaded rows';filter.dispatch('input');assert.match(byId('recent-sessions').textContent,/No matches in loaded recent sessions/);
  filter.value='project';filter.dispatch('input');assert.equal(byId('recent-sessions').querySelector('.sidebar-content-row'),row);
  assert.equal(browser.transportLog.length,requests);filter.value='';filter.dispatch('input');
});

test('a replaced session never borrows a title or time from the same saved path with another id',async t=>{
  const saved={id:'old-session',path:'/fixture/project/reused.jsonl',project:'/fixture/project',revision:'r',title:'Another session name',titleSource:'name',titleState:'ready',modifiedAt:'2026-10-23T00:00:00Z',size:10},fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path==='/api/sessions'||path==='/api/sessions/published')return Response.json({ok:true,data:{items:[saved],total:1,omitted:0,nextCursor:null,titleCursor:null,observedAt:''}});
    return fetch(input,init);
  });
  const primary=primaryFixture({epoch:24500,sessionId:'replacement-session',sessionFile:saved.path,sessionName:undefined});
  await arrive({workspace:{id:'replaced-row-metadata',revision:1,primaryKey:primary.key},primaries:[primary],roster:[]});await settle();
  const rows=byId('recent-sessions').querySelectorAll('.sidebar-content-row');assert.equal(rows.length,1);assert.equal(rows[0]?.querySelector('.row-title')?.textContent,'Untitled session');assert.equal(rows[0]?.querySelector('.sidebar-session-context')?.textContent,'');
});

test('a title cursor failure preserves successful catalogue rows and its separate diagnostic',async t=>{
  const saved={id:'failed-title',path:'/fixture/project/failed-title.jsonl',project:'/fixture/project',revision:'r',title:'(title pending)',titleState:'pending' as const,modifiedAt:'2026-10-23T00:00:00Z',size:10};
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input),'http://ui.test');if(url.pathname==='/api/sessions'){
      if(url.searchParams.has('titles'))throw new Error('Title source is unavailable.');
      return Response.json({ok:true,data:{items:[saved],total:1,omitted:0,nextCursor:null,titleCursor:'failed-title-cursor',observedAt:''}});
    }
    return fetch(input,init);
  });
  const primary=primaryFixture({epoch:24300,sessionId:saved.id,sessionFile:saved.path});
  await arrive({workspace:{id:'failed-title-rows',revision:1,primaryKey:primary.key},primaries:[primary],roster:[]});await settle();
  const row=byId('recent-sessions').querySelector('.sidebar-content-row');assert.ok(row);assert.match(row.querySelector('.sidebar-session-context')?.textContent??'',/project/);
  byId('settings-button').click();byId('settings-help-page').click();
  byId('settings-help').querySelectorAll('button').find(node=>node.dataset.setting==='Version and health')?.click();await settle();
  assert.match(byId('modal-body').textContent,/Title source is unavailable/);byId('modal-close').click();
});

test('picker dismissal restores its exact trigger instead of the native editor',async t=>{
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path.endsWith('/resources/models'))return Response.json({ok:true,data:{items:[{provider:'fixture',id:'model',name:'Fixture model',reasoning:true,input:['text'],thinkingLevels:['off','high']}],nextCursor:null,revision:'r'}});
    if(path.endsWith('/resources/thinking'))return Response.json({ok:true,data:{items:['off','high'],nextCursor:null,revision:'r'}});
    return fetch(input,init);
  });
  const primary=primaryFixture({epoch:24200,activity:'idle',model:{provider:'fixture',id:'model',name:'Fixture model',reasoning:true,input:['text']},thinkingLevel:'high'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  await arrive({workspace:{id:'picker-trigger',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[targetFixture('picker-trigger-draft',target)]});browser.event('ready',{bootId:'boot'});await settle();
  const editor=primaryControl('editor'),parents=ancestry(editor);
  for(const key of ['model','thinking']){const trigger=primaryControl(key);assert.equal(trigger.disabled,false);editor.focus();trigger.click();await settle();byId('modal-close').click();assert.equal(hostDocument.activeElement,trigger);assert.equal(trigger.getAttribute('aria-expanded'),'false');assert.deepEqual(ancestry(editor),parents);}
});

test('unnamed agent tabs and open saved tabs use exact supplied folder and time context',async t=>{
  const saved={id:'open-context',path:'/fixture/saved-context.jsonl',project:'/fixture/research',revision:'r',title:'Research',titleSource:'name' as const,titleState:'ready' as const,createdAt:'2026-10-23T00:00:00Z',modifiedAt:'2026-10-25T00:00:00Z',size:10};
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input),'http://ui.test').pathname;
    if(path==='/api/sessions/published')return Response.json({ok:true,data:{items:[saved],total:1,omitted:0,nextCursor:null,titleCursor:null,observedAt:''}});
    if(path==='/api/sessions/history')return Response.json({ok:true,data:{session:saved,entries:[],coverage:browser.coverage,leaf:null,before:null,observedAt:''}});
    return fetch(input,init);
  });
  const agents=[agentFixture('unnamed-agent-a',{name:undefined,handle:undefined,cwd:'/fixture/project-a',state:'working',modifiedAt:Date.parse('2026-10-25T00:00:00Z'),recents:{creator:'operator',hasMessages:true,createdAt:Date.parse('2026-10-22T00:00:00Z')}}),agentFixture('unnamed-agent-b',{name:undefined,handle:undefined,cwd:'/fixture/project-b',state:'idle',modifiedAt:Date.parse('2026-10-25T00:00:00Z'),recents:{creator:'operator',hasMessages:true,createdAt:Date.parse('2026-10-23T00:00:00Z')}})];
  const layout=createPaneLayout([{kind:'session',id:saved.id,path:saved.path,project:saved.project,name:saved.title},...agents.map(row=>({kind:'agent' as const,identity:row.identity}))]);
  await arrive({workspace:{id:'exact-row-context',revision:1,conversationLayout:layout},primaries:[],roster:agents});await settle();
  const rows=byId('recent-sessions').querySelectorAll('.sidebar-content-row'),contexts=rows.map(row=>row.querySelector('.sidebar-session-context')?.textContent??'');
  assert.equal(rows.length,3);assert.ok(contexts.some(text=>/research/.test(text)));assert.ok(contexts.some(text=>/project-b.*Last observed: idle/.test(text)));assert.ok(contexts.some(text=>/project-a.*Last observed: working/.test(text)));assert.equal(new Set(contexts).size,3);
  assert.match(rows.find(row=>row.querySelector('.row-title')?.textContent==='Research')?.title??'',/2026/,'Retained creation replaces the layout stub after exact identity matching.');
  const requests=browser.transportLog.length,filter=byId('session-search');filter.value='project-b';filter.dispatch('input');
  assert.deepEqual(byId('recent-sessions').querySelectorAll('.sidebar-content-row').map(row=>row.dataset.sessionKey),['agent:unnamed-agent-b']);
  assert.equal(browser.transportLog.length,requests);filter.value='';filter.dispatch('input');
});

test('viewport geometry coalesces and shares height and top with sheets without a second keyboard offset',async t=>{
  const listeners=new Map<string,()=>void>(),viewport={scale:1,height:480.4,offsetTop:31.6,addEventListener:(name:string,run:()=>void)=>listeners.set(name,run)};
  const media=globalThis.matchMedia;t.mock.method(globalThis,'matchMedia',(query:string)=>query==='(pointer:coarse)'?{matches:true} as MediaQueryList:media(query));
  Object.defineProperty(window,'visualViewport',{configurable:true,value:viewport});
  t.after(()=>{Reflect.deleteProperty(window,'visualViewport');hostDocument.documentElement.style.removeProperty('--app-height');hostDocument.documentElement.style.removeProperty('--app-top');delete hostDocument.documentElement.dataset.keyboard;document.body.style.translate='';});
  app.installViewportSync();assert.equal(hostDocument.documentElement.properties.get('--app-height'),'480px');assert.equal(hostDocument.documentElement.properties.get('--app-top'),'32px');
  assert.equal(document.body.style.translate,'0 32px');assert.deepEqual([...listeners.keys()],['resize','scroll']);
  viewport.height=430.2;listeners.get('resize')?.();listeners.get('scroll')?.();await settle();assert.equal(hostDocument.documentElement.properties.get('--app-height'),'430px');
  viewport.scale=2;listeners.get('resize')?.();await settle();assert.equal(hostDocument.documentElement.properties.has('--app-height'),false);assert.equal(hostDocument.documentElement.properties.has('--app-top'),false);assert.equal(document.body.style.translate,'');
});

function chooseMenu(label:string):void {
  const menu=()=>hostDocument.body.querySelector('.context-menu');
  let item=menu()?.querySelectorAll('button').find(node=>node.textContent===label);
  if(!item){const group=label==='Message box size'?'Display':label==='Conversation details'?'Session details':undefined;
    menu()?.querySelectorAll('button').find(node=>node.textContent===group)?.click();item=menu()?.querySelectorAll('button').find(node=>node.textContent===label);}
  assert.ok(item,label);item.click();
}
test('tablet drawer blocks background controls and restores focus without moving the editor',async t=>{
  t.after(()=>{host.viewport=1200;app.toggleSidebar(false);});
  const primary=primaryFixture({epoch:23500,activity:'idle'}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
  await arrive({workspace:{id:'tablet-modal',revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[targetFixture('tablet-draft',target,{draft:{revision:1,text:'Keep this draft',mode:'prompt',images:[],persisted:true}})]});
  const editor=primaryControl('editor'),parents=ancestry(editor);editor.focus();editor.setSelectionRange(3,7,'backward');host.viewport=768;app.toggleSidebar(true);
  assert.equal(byId('sidebar').getAttribute('role'),'dialog');assert.equal(byId('sidebar').getAttribute('aria-modal'),'true');assert.equal(byId('sidebar-scrim').hidden,false);
  assert.equal(byId('sidebar-close').dataset.tapFocus,'true','script focus after a tap draws no ring');assert.equal(byId('navigation-access').inert,true);assert.ok(ancestry(editor).some(node=>node.inert));editor.focus();assert.equal(hostDocument.activeElement,byId('sidebar-close'));
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

test('archive prerequisites expose the real writer controls without an automatic stop or close',async t=>{
  t.after(()=>{metadataItems=[];byId('modal-close').click();});
  for(const activity of ['idle','running'] as const){
    const primary=primaryFixture({epoch:24400,activity,sessionId:`archive-${activity}`,sessionFile:`/fixture/project/archive-${activity}.jsonl`,sessionName:`Archive ${activity}`}),target={kind:'primary' as const,key:primary.key,epoch:primary.epoch};
    metadataItems=[{target,aliases:['primary:p',`path:${primary.sessionFile}`,`id:${primary.sessionId}`],title:primary.sessionName??'',archived:false,canRename:true,canArchive:false,canRestore:false,reason:'Stop this session before archiving.'}];
    await arrive({workspace:{id:`archive-route-${activity}`,revision:1,primaryKey:primary.key},primaries:[primary],roster:[],targets:[targetFixture(`archive-draft-${activity}`,target)]});await settle();
    const start=browser.transportLog.length;byId('recent-sessions').querySelector('.session-row-menu')?.click();await settle();
    const menu=hostDocument.body.querySelector('.context-menu');assert.ok(menu);assert.equal(menu.querySelectorAll('button').find(node=>node.textContent.startsWith('Archive'))?.getAttribute('aria-disabled'),'true');
    chooseMenu(activity==='idle'?'Close session':'Open conversation');await settle();
    if(activity==='idle'){assert.match(byId('modal-title').textContent,/Close Archive idle/);byId('modal-close').click();}
    assert.equal(browser.transportLog.slice(start).some(call=>call.path.endsWith('/close')||call.path.endsWith('/abort')||call.path.includes('/inputs')),false);
  }
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

test('Recents use retained creation and messages without output or current-time fallbacks',()=>{
  const row={key:'saved',name:'x',at:999999,title:'x',saved:{id:'i',path:'/s/file.jsonl',revision:'r',project:'/p',title:'x',createdAt:'2026-10-01T00:00:00.000Z',modifiedAt:'2026-10-24T09:00:00.000Z',size:1}} as SessionRow;
  assert.equal(operatorTime(row),Date.parse('2026-10-01T00:00:00.000Z'));
  assert.ok(row.saved);row.saved.lastUserAt='2026-10-20T00:00:00.000Z';assert.equal(operatorTime(row),Date.parse('2026-10-20T00:00:00.000Z'));
  row.saved.lastAnswerAt='2026-10-21T00:00:00.000Z';assert.equal(operatorTime(row),Date.parse('2026-10-21T00:00:00.000Z'));
  const fresh={key:'k',name:'n',at:0,title:'n',primary:{key:'k',epoch:1}} as SessionRow;
  assert.equal(operatorTime(fresh),0);assert.equal(operatorTime(fresh),0);
});

test('Recents group by day and each session row shows one status dot while the toggle flags other sessions that need the operator',async()=>{
  const day=new Date('2026-10-24T15:00:00').getTime();
  assert.equal(recentGroup(day,day+1000),'Today');assert.equal(recentGroup(day-86_400_000,day),'Yesterday');assert.equal(recentGroup(day-3*86_400_000,day),'Previous 7 days');assert.equal(recentGroup(day-30*86_400_000,day),'Older');assert.equal(recentGroup(0,day),'Older');
  const running=primaryFixture({epoch:23900,key:'run',activity:'running',sessionName:'Running one'}),idle=primaryFixture({epoch:23901,key:'idle',activity:'idle',sessionName:'Idle one',hasMessages:true});
  await arrive({workspace:{id:'row-dots',revision:1,primaryKey:'run'},primaries:[running,idle],roster:[]});await settle();
  const dots=byId('recent-sessions').querySelectorAll('.sidebar-content-row').map(row=>({title:row.querySelector('.row-title')?.textContent,status:row.querySelector('.session-dot')?.dataset.status,hidden:row.querySelector('.session-dot')?.hidden}));
  assert.deepEqual(dots.find(item=>item.title==='Running one'),{title:'Running one',status:'running',hidden:false});
  assert.equal(dots.find(item=>item.title==='Idle one')?.hidden,true);
  assert.ok(byId('recent-sessions').querySelectorAll('.sidebar-group').length>=1);
});

test('Recents use the latest retained primary or saved-file message',()=>{
  const row={key:'k',name:'x',at:0,title:'x',primary:primaryFixture({createdAt:10,lastUserAt:30,lastAnswerAt:40}),saved:{id:'i',path:'/s/f.jsonl',revision:'r',project:'/p',title:'x',modifiedAt:'2026-10-24T09:00:00.000Z',lastUserAt:'2026-10-23T00:00:00.000Z',size:1}} as SessionRow;
  assert.equal(operatorTime(row),Date.parse('2026-10-23T00:00:00.000Z'));
});
