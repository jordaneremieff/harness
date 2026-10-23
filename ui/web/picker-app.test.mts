import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
import {createPaneLayout,splitPane} from './pane-layout.ts';
import {activeTab,tabKey,workspaceLayout} from './tabs.ts';
import type {ConversationTab,Target} from '../shared/api.ts';
const browser = await createAppFixture();
const {app,arrive,settle,byId,hostDocument,primaryFixture,agentFixture,targetFixture,primaryControl,agentControl,documentHandlers,transportLog} = browser;
function input(name:string):void {for (const handler of documentHandlers.get(name) ?? []) handler({isTrusted:true,target:byId('modal'),key:'ArrowDown'});}
for (const trigger of ['project-button', 'compact-project-button']) test(`${trigger} opens the file-root chooser and Other folder retains the browse path`, async t => {
  const target = {kind: 'primary' as const, key: 'folder-primary', epoch: 160}, folder = '/browse/current';
  await arrive({workspace: {id: `folder-${trigger}`, revision: 1, primaryKey: target.key, selectedTarget: target, conversationLayout: createPaneLayout([{kind: 'primary'}])},
    primaries: [primaryFixture({...target, cwd: '/sessions/project'}), primaryFixture({key: 'same-directory', epoch: 161, cwd: '/sessions/project'})], roster: [],
    targets: [targetFixture(`folder-target-${trigger}`, target)]});
  await app.fileRoot.choose(folder); await settle();
  const original = globalThis.fetch, calls: {path: string; method: string}[] = [];
  t.after(() => {globalThis.fetch = original; byId('modal-close').click();});
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname, method = init?.method ?? 'GET'; calls.push({path, method});
    assert.equal(method, 'GET', 'Opening the folder chooser must not mutate state.');
    if (path === '/api/projects') return Response.json({ok: true, data: {items: [{path: folder, name: 'current'}], total: 1, omitted: 0, nextCursor: null, observedAt: '2026-01-01T00:00:00Z'}});
    return original(input, init);
  };
  const workspace = structuredClone(app.state.workspace), root = structuredClone(app.fileRoot.selection), control = byId(trigger);
  control.focus(); control.click(); await settle();
  const menu = hostDocument.body.querySelector('.context-menu'); assert.ok(menu);
  assert.equal(menu.getAttribute('aria-label'), 'Working folder'); assert.equal(control.getAttribute('aria-expanded'), 'true'); assert.equal(byId('modal').open, false);
  const folders = menu.querySelectorAll('[role="menuitemradio"]');
  assert.equal(folders.filter(row => row.getAttribute('aria-description') === '/sessions/project').length, 1, 'Sessions in one directory share a folder row.');
  assert.deepEqual(folders.filter(row => row.getAttribute('aria-checked') === 'true').map(row => row.getAttribute('aria-description')), [folder]);
  menu.dispatch('keydown', {key: 'Escape', preventDefault() {}, stopPropagation() {}}); assert.equal(hostDocument.activeElement, control);
  control.click(); await settle();
  const other = hostDocument.body.querySelector('.context-menu')?.children.find(row => row.textContent === 'Other folder'); assert.ok(other); other.click();
  assert.equal(byId('modal-title').textContent, 'Working folder'); assert.equal(byId('picker-project').value, folder); assert.equal(hostDocument.activeElement, byId('picker-project'));
  assert.ok(byId('modal-body').querySelectorAll('button').find(row => row.textContent === 'Use folder'));
  assert.deepEqual(app.state.workspace, workspace); assert.deepEqual(app.fileRoot.selection, root);
  assert.ok(calls.some(call => call.path === '/api/projects')); assert.equal(calls.some(call => call.path === '/api/workspaces' || call.path === '/api/sessions' || call.path === '/api/primaries'), false);
});
function originTab(origin:string,identity:string):ConversationTab|undefined {
  if (origin === 'file') return {kind:'file',rootId:'root',path:'retained.md'};
  if (origin === 'agent') return {kind:'agent',identity};
  return origin === 'primary' ? {kind:'primary'} : undefined;
}
for (const origin of ['empty','file','agent','primary'] as const) for (const action of ['new','resume'] as const) test(`${action} completion accepts the server-selected Primary from ${origin}`,async t=> {
  const key = `${origin}-${action}`,old = {kind:'primary' as const,key:'old',epoch:20},target = {kind:'primary' as const,key,epoch:21},row = agentFixture(key);
  const tab = originTab(origin,row.identity);
  const layout = createPaneLayout(tab ? [tab] : []),selectedTarget = origin === 'agent' ? {kind:'agent' as const,identity:row.identity} : origin === 'empty' ? undefined : old;
  await arrive({workspace:{id:key,revision:1,...(origin === 'empty' ? {} : {primaryKey:old.key,selectedTarget}),conversationLayout:layout},primaries:origin === 'empty' ? [] : [primaryFixture({key:old.key,epoch:old.epoch})],roster:[row],targets:origin === 'empty' ? [] : [targetFixture(`old-${key}`,old),targetFixture(`agent-${key}`,{kind:'agent',identity:row.identity})]});
  await app.fileRoot.choose(`/project/${key}`);await settle();
  const previous = globalThis.fetch;let opens = 0;
  t.after(()=> {globalThis.fetch = previous;});
  globalThis.fetch = async(input,init)=> {
    const path = new URL(String(input),'http://ui.test').pathname;
    if (path === '/api/sessions') return Response.json({ok:true,data:{items:[{id:key,path:`/project/${key}.jsonl`,project:'/project',revision:'r',title:key,titleState:'ready',modifiedAt:'2026-01-01T00:00:00Z',size:10}],total:1,omitted:0,nextCursor:null,titleCursor:null,observedAt:'2026-01-01T00:00:00Z'}});
    if (path === '/api/sessions/history') return Response.json({ok:true,data:{session:{id:key,path:`/project/${key}.jsonl`,project:'/project',revision:'r',title:key,titleSource:'name',titleState:'ready',modifiedAt:'2026-01-01T00:00:00Z',size:10},entries:[],coverage:{complete:true,truncated:false,omitted:0},leaf:null,before:null,observedAt:'2026-01-01T00:00:00Z'}});
    if (path === '/api/primaries' && init?.method === 'POST') {
      opens++;const body = JSON.parse(String(init.body));assert.equal(body.sessionFile,action === 'resume' ? `/project/${key}.jsonl` : undefined);
      browser.fixture = {workspace:{id:key,revision:(app.state.workspace?.revision ?? 1)+1,primaryKey:key,selectedTarget:target,conversationLayout:layout},primaries:[primaryFixture({key,epoch:target.epoch})],roster:[row],targets:[targetFixture(`opened-${key}`,target)]};
      return Response.json({ok:true,data:{primaryKey:key,operation:{state:'completed'}}});
    }
    return previous(input,init);
  };
  byId('workbench-version').focus();
  if (action === 'new') byId('session-new').click();
  else {byId('session-open').click();await settle();const saved = hostDocument.body.querySelector('.picker-select');assert.ok(saved);saved.click();await settle();const resume = hostDocument.body.querySelectorAll('button').find(node=>node.textContent === 'Resume' && !node.hidden);assert.ok(resume,'The closed-session view offers Resume');resume.click();}
  await settle();await app.selectionQueue.drain();await settle();assert.equal(opens,1);
  assert.equal(app.state.workspace?.primaryKey,key);assert.deepEqual(app.state.workspace?.selectedTarget,target);if (action === 'new') assert.equal(activeTab(workspaceLayout(app.state.workspace))?.kind,'primary');
  if (action === 'new' || origin !== 'file') assert.equal(hostDocument.activeElement,primaryControl('editor'));
  const rendered = workspaceLayout(app.state.workspace);
  if (tab?.kind === 'file') assert.ok(rendered.root.kind === 'pane' && rendered.root.tabs.some(item=>tabKey(item) === tabKey(tab)));
});
for (const name of ['keydown','wheel','pointerdown','input','compositionstart']) test(`input ${name} preserves admitted Resume selection without late focus`,async()=> {
  const target = {kind:'primary' as const,key:'p',epoch:30},tab = {kind:'file' as const,rootId:'root',path:'retained.md'};
  await arrive({workspace:{id:`input-${name}`,revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:createPaneLayout([tab])},primaries:[primaryFixture({epoch:30})],roster:[],targets:[targetFixture(`input-${name}`,target)]});
  byId('modal').showModal();const completed = app.capturePrimarySelection();byId('modal').focus();const focus = hostDocument.activeElement;
  input(name);await completed('p');await settle();
  assert.equal(activeTab(workspaceLayout(app.state.workspace))?.kind,'primary');assert.deepEqual(app.state.workspace?.selectedTarget,target);assert.equal(hostDocument.activeElement,focus);byId('modal').close();
});
for (const choice of ['agent','pane','primary','away-back'] as const) test(`late completion preserves a newer explicit ${choice} choice`,async()=> {
  const target = {kind:'primary' as const,key:'p',epoch:40},other = {kind:'primary' as const,key:'other',epoch:41},row = agentFixture(`later-${choice}`);
  const layout = createPaneLayout([{kind:'primary'},{kind:'agent',identity:row.identity}]);
  await arrive({workspace:{id:`choice-${choice}`,revision:1,primaryKey:'p',selectedTarget:target,conversationLayout:layout},primaries:[primaryFixture({epoch:40}),primaryFixture({key:'other',epoch:41})],roster:[row],targets:[targetFixture(`choice-${choice}`,target),targetFixture(`other-${choice}`,other),targetFixture(`later-${choice}`,{kind:'agent',identity:row.identity})]});
  const completed = app.capturePrimarySelection();
  if (choice === 'agent' || choice === 'away-back') {await app.selectAgent(row);if (choice === 'away-back') {app.applyLayout(layout);await app.selectionQueue.drain();}}
  else if (choice === 'pane') {app.applyLayout(splitPane(layout,layout.focusedPane,'x',{width:1000,height:700,divider:4}));await app.selectionQueue.drain();}
  else {await app.capturePrimarySelection()('other');}
  const before = structuredClone(app.state.workspace),focus = hostDocument.activeElement;await completed('p');await settle();
  assert.deepEqual(app.state.workspace,before);assert.equal(hostDocument.activeElement,focus);
});
test('a newer target from a snapshot defeats an older completion without a local input event',async()=> {
  const primary = {kind:'primary' as const,key:'p',epoch:50},row = agentFixture('remote-choice'),target:Target = {kind:'agent',identity:row.identity},layout = createPaneLayout([{kind:'primary'},{kind:'agent',identity:row.identity}]);
  await arrive({workspace:{id:'remote-choice',revision:1,primaryKey:'p',selectedTarget:primary,conversationLayout:layout},primaries:[primaryFixture({epoch:50})],roster:[row],targets:[targetFixture('remote-primary',primary),targetFixture('remote-agent',target)]});
  const completed = app.capturePrimarySelection();
  await arrive({...browser.fixture,workspace:{...browser.fixture.workspace,selectedTarget:target}});const focus = hostDocument.activeElement;await completed('p');
  assert.deepEqual(app.state.workspace?.selectedTarget,target);assert.equal(hostDocument.activeElement,focus);
});
test('cold agent history distinguishes no read, an active read, and a confirmed empty result',async t=> {
  const primary = {kind:'primary' as const,key:'p',epoch:60},row = agentFixture('cold-status',{availability:'stored',capabilities:{input:false}}),target = {kind:'agent' as const,identity:row.identity};
  await arrive({workspace:{id:'cold-status',revision:1,primaryKey:'p',selectedTarget:primary},primaries:[primaryFixture({epoch:60})],roster:[row],targets:[targetFixture('cold-primary',primary),targetFixture('cold-agent',target)]});
  const original = globalThis.fetch,selection = Promise.withResolvers<void>(),history = Promise.withResolvers<void>(),started = Promise.withResolvers<void>();
  t.after(()=> {selection.resolve();history.resolve();globalThis.fetch = original;});let reads = 0;
  globalThis.fetch = async(input,init)=> {const path = new URL(String(input),'http://ui.test').pathname;if (path.endsWith('/selection')) await selection.promise;if (path.includes('/agents/cold-status/history')) {reads++;started.resolve();await history.promise;}return original(input,init);};
  const before = transportLog.length,pending = app.selectAgent(row);await settle();
  assert.equal(reads,0);assert.match(agentControl('history-note-line').textContent,/^Messages not loaded\./);assert.doesNotMatch(agentControl('history-note-line').textContent,/Loading|unavailable/);
  selection.resolve();await started.promise;assert.match(agentControl('history-note-line').textContent,/^Reading saved messages/);
  history.resolve();await pending;await settle();assert.match(agentControl('history-note-line').textContent,/^No messages yet\./);
  assert.equal(transportLog.slice(before).some(call=>call.path.includes('/inputs') || call.path.endsWith('/start')),false);
});

for (const destination of ['new', 'existing'] as const) test(`handover Continue uses one input in the chosen ${destination} session`, async t => {
  const target = {kind: 'primary' as const, key: `handover-${destination}`, epoch: 130};
  const old = primaryFixture({...target, activity: 'idle'}), saved = targetFixture(`draft-${destination}`, target, {draft: {revision: 3, text: 'Keep current draft', mode: 'prompt', persisted: true, images: []}});
  await arrive({workspace: {id: `handover-${destination}`, revision: 1, primaryKey: target.key, selectedTarget: target}, primaries: [old, primaryFixture({key: 'busy', epoch: 131, activity: 'running'})], roster: [], targets: [saved]});
  const original = globalThis.fetch, gate = Promise.withResolvers<void>(); let opens = 0; const inputs: Record<string, unknown>[] = [];
  t.after(() => {gate.resolve(); globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname === '/api/primaries' && init?.method === 'POST') {
      opens++; assert.deepEqual(JSON.parse(String(init.body)), {cwd: byId('handover-destination').querySelector('option')?.title});
      const opened = primaryFixture({key: 'handover-opened', epoch: 132, activity: 'idle'}), selected = {kind: 'primary' as const, key: opened.key, epoch: opened.epoch};
      browser.fixture = {...browser.fixture, workspace: {...browser.fixture.workspace, primaryKey: opened.key, selectedTarget: selected}, primaries: [old, opened], targets: [saved, targetFixture('handover-opened', selected)]};
      return Response.json({ok: true, data: {primaryKey: opened.key, operation: {state: 'completed'}}});
    }
    if (url.pathname.endsWith('/inputs') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); inputs.push(body); await gate.promise;
      const headers = init.headers as Record<string, string>;
      return Response.json({ok: true, data: {id: headers['Idempotency-Key'], kind: 'primary.input', target: {kind: 'primary', key: destination === 'new' ? 'handover-opened' : target.key, epoch: destination === 'new' ? 132 : target.epoch}, state: 'accepted', createdAt: '', updatedAt: '', receipt: {kind: 'rpc', disposition: 'handled'}}});
    }
    return original(input, init);
  };
  byId('session-handover').click(); await settle();
  const body = byId('modal-body'); assert.match(body.textContent, /marks the handover active/); assert.match(body.textContent, /cannot show or control a session that runs in a terminal/);
  assert.equal(byId('handover-destination').value, 'new'); assert.equal(body.querySelectorAll('option').some(option => option.value === 'busy:131'), false);
  assert.equal(opens, 0); assert.equal(inputs.length, 0);
  byId('handover-pickup').value = 'pi "/stash get 20260101T000000Z-sample-handover remember the new port"'; byId('handover-pickup').dispatch('input');
  assert.equal(byId('handover-note').value, 'remember the new port');
  if (destination === 'existing') {byId('handover-destination').value = `${target.key}:${target.epoch}`; byId('handover-destination').dispatch('change');}
  const next = byId('handover-continue'); next.click(); next.click(); await settle();
  assert.equal(opens, destination === 'new' ? 1 : 0); assert.equal(inputs.length, 1); assert.equal(next.disabled, true);
  assert.equal(inputs[0]?.message, '/stash get 20260101T000000Z-sample-handover remember the new port'); assert.equal(inputs[0]?.mode, 'prompt');
  assert.equal(saved.draft.text, 'Keep current draft');
  gate.resolve(); await settle(); assert.equal(byId('modal').open, false);
});

test('a failed handover open retains the fields and exposes Details and Try again', async t => {
  const primary = primaryFixture({key: 'handover-error', epoch: 140, activity: 'idle'});
  await arrive({workspace: {id: 'handover-error', revision: 1, primaryKey: primary.key}, primaries: [primary], roster: []});
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original; byId('modal-close').click();});
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname === '/api/primaries' && init?.method === 'POST'
    ? Response.json({ok: false, error: {code: 'host_unavailable', message: 'Session did not start', retry: 'read'}}) : original(input, init);
  byId('session-handover').click(); byId('handover-pickup').value = 'sample-handover'; byId('handover-pickup').dispatch('input'); byId('handover-note').value = 'Keep the note';
  byId('handover-continue').click(); await settle();
  assert.equal(byId('modal').open, true); assert.equal(byId('handover-pickup').value, 'sample-handover'); assert.equal(byId('handover-note').value, 'Keep the note');
  assert.equal(byId('handover-continue').textContent, 'Try again'); assert.match(byId('modal-error').textContent, /Details.*Session did not start/);
});

test('the terminal pickup shortcut changes the Primary draft only after its action and sends nothing', async () => {
  const primary = primaryFixture({key: 'handover-shortcut', epoch: 150, activity: 'idle'}), target = {kind: 'primary' as const, key: primary.key, epoch: primary.epoch};
  await arrive({workspace: {id: 'handover-shortcut', revision: 1, primaryKey: primary.key}, primaries: [primary], roster: [], targets: [targetFixture('handover-shortcut', target)]});
  const composer = app.primaryComposer(), text = 'pi "/stash get sample-handover extra note"'; composer.setText(text); await settle();
  const hint = hostDocument.querySelector('.composer-handover:not([hidden])') ?? hostDocument.querySelectorAll('.composer-handover').find(node => !node.hidden); assert.ok(hint);
  const before = transportLog.length; assert.equal(composer.editor.value, text); hint.querySelector('button')?.click(); await settle();
  assert.equal(composer.editor.value, '/stash get sample-handover extra note'); assert.equal(hint.hidden, true);
  assert.equal(transportLog.slice(before).some(call => call.path.includes('/inputs')), false);
});
