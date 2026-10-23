import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectedFrame } from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';
import {Transcript} from './render.ts';
const {app, arrive, settle, comparePanes, event, hostDocument, byId, agentControl, primaryControl, primaryFixture, agentFixture, targetFixture, entryFixture, messageFixture, textPart, observation, singlePane, coverage, transportLog} = await createAppFixture();

test('caption fact events refresh idle subjects and every affected recipient without transcript rebuilds', async t => {
  const a='00000000-0000-4000-8000-000000000301', b='00000000-0000-4000-8000-000000000302', targetA={kind:'agent' as const,identity:a}, targetB={kind:'agent' as const,identity:b};
  const targetP={kind:'primary' as const,key:'p',epoch:3801};
  const layout={root:{kind:'split' as const,id:'caption-root',axis:'x' as const,ratio:50,first:{kind:'pane' as const,id:'primary-pane',tabs:[{kind:'primary' as const}],active:'primary'},second:{kind:'split' as const,id:'caption-agents',axis:'y' as const,ratio:50,first:{kind:'pane' as const,id:'agent-a',tabs:[targetA],active:`agent:${a}`},second:{kind:'pane' as const,id:'agent-b',tabs:[targetB],active:`agent:${b}`}}},focusedPane:'agent-b'};
  const tool=entryFixture('idle-subject',[messageFixture('idle-source',[{type:'toolCall',callId:'idle-call',name:'custom',arguments:{value:{sessionId:a},truncated:false}},{type:'toolResult',callId:'idle-call',name:'custom',isError:false,parts:[textPart(`Supplied ${a}`)]}])]);
  await arrive({workspace:{id:'caption-events',revision:1,primaryKey:'p',selectedTarget:targetB,conversationLayout:layout},primaries:[primaryFixture({epoch:targetP.epoch,activity:'idle'})],roster:[agentFixture(b,{name:'Partner',handle:undefined})],history:[tool],
    targets:[targetFixture('caption-p',targetP),targetFixture('caption-a',targetA),targetFixture('caption-b',targetB,{draft:{revision:1,text:'Keep B draft',mode:'prompt',persisted:true}})]});
  await comparePanes(b);
  byId('roster').querySelectorAll('button').find(item => item.textContent.startsWith('All agents'))?.click(); await settle();
  const primaryRoot=primaryControl('transcript'), card=primaryRoot.querySelector('.tool-card'), subject=card?.querySelector('.tool-target'), preview=card?.querySelector('.tool-preview'); assert.ok(card && subject && preview);
  assert.equal(subject.textContent,''); assert.equal(subject.hidden,true); assert.equal(subject.title,a); const editor=app.agentComposer().editor; editor.focus(); editor.setSelectionRange(1,5,'backward');
  let primarySets=0, refreshes=0; const originalSet=Transcript.prototype.set, originalRefresh=Transcript.prototype.refreshSubjects;
  t.mock.method(Transcript.prototype,'set',function(this:Transcript,...args:Parameters<Transcript['set']>){if(this.node===primaryRoot as unknown as HTMLElement)primarySets++;return originalSet.apply(this,args);});
  t.mock.method(Transcript.prototype,'refreshSubjects',function(this:Transcript){refreshes++;return originalRefresh.call(this);});
  const publish=(name:string,modifiedAt=0)=>event('agent.roster',{revision:app.state.rosterRevision+1,changed:[agentFixture(a,{name,modifiedAt,handle:undefined})],removed:[],scan:{state:'ready',complete:true,visited:2,skipped:0,omitted:0},stale:false});
  publish('Discovered'); await settle(); const link=subject.querySelector('.tool-subject-link'); assert.ok(link); assert.equal(link.textContent,'Discovered'); assert.ok(refreshes>0);
  publish('Renamed idle subject'); await settle(); assert.equal(subject.querySelector('.tool-subject-link'),link); assert.equal(link.textContent,'Renamed idle subject');
  const beforeMetadata=refreshes; publish('Renamed idle subject',1000); await settle(); assert.equal(refreshes,beforeMetadata);
  const frame:ProjectedFrame={revision:1,observedAt:'',live:[],entries:[],nextBefore:null,coverage,status:{busy:false,name:'Partner'}};
  const connectionEpoch=app.state.agentEpochs.get(a)??1; event('agent.frame',{identity:a,connectionEpoch,frame}); await settle();
  const rosterA=byId('roster').querySelector(`[data-identity="${a}"]`), rosterB=byId('roster').querySelector(`[data-identity="${b}"]`); assert.ok(rosterA && rosterB);
  assert.equal(rosterA.querySelector('.row-name')?.textContent,'Partner'); assert.equal(rosterB.querySelector('.row-name')?.textContent,'Partner');
  const aTail=rosterA.querySelector('.row-identity')?.textContent,bTail=rosterB.querySelector('.row-identity')?.textContent; assert.ok(aTail && bTail); assert.notEqual(aTail,bTail);
  assert.equal(link.textContent,'Partner'); assert.equal(subject.title,a); assert.equal(agentControl('recipient').textContent,`Draft for Partner · ${bTail}`);
  const beforeDelta=refreshes; event('agent.frame',{identity:a,connectionEpoch,frame:{...frame,revision:2,observedAt:'later',status:{...frame.status,busy:true}}}); await settle(); assert.equal(refreshes,beforeDelta);
  assert.equal(primarySets,0); assert.equal(primaryRoot.querySelector('.tool-card'),card); assert.equal(card.querySelector('.tool-preview'),preview); assert.equal(card.open,false);
  assert.equal(app.agentComposer().editor,editor); assert.equal(editor.value,'Keep B draft'); assert.deepEqual([editor.selectionStart,editor.selectionEnd,editor.selectionDirection],[1,5,'backward']); assert.equal(hostDocument.activeElement,editor);
});

test('public root and child captions agree across subjects, tabs, roster, chooser and exact recipients', async () => {
  const root = '00000000-0000-4000-8000-000000000101', child = `${root}:7906`, unknown = '00000000-0000-4000-8000-000000000909';
  const target = {kind:'agent' as const,identity:root}, childTarget = {kind:'agent' as const,identity:child};
  const rows = [agentFixture(root,{name:'Review',handle:'main-review'}),agentFixture(child,{name:'Review',handle:'branch-review'})];
  const tool = (identity:string,id:string) => entryFixture(id,[messageFixture(id,[{type:'toolCall',callId:id,name:'custom',arguments:{value:{sessionId:identity},truncated:false}},{type:'toolResult',callId:id,name:'custom',isError:false,parts:[textPart(`Exact supplied ${identity}`)]}])]);
  const entries = [tool(child,'known-subject'),tool(unknown,'unknown-subject'),tool('arbitrary target','literal-subject')];
  const frame:ProjectedFrame = {revision:1,observedAt:'',live:[],entries,nextBefore:null,coverage,status:{busy:false}};
  await arrive({workspace:{id:'root-child-captions',revision:1,selectedTarget:target,conversationLayout:singlePane([target,childTarget],`agent:${root}`)},primaries:[],roster:rows,
    targets:[targetFixture('root-draft',target,{draft:{revision:3,text:'Root draft',mode:'followUp',persisted:true}}),targetFixture('child-draft',childTarget,{draft:{revision:7,text:'Child draft',mode:'prompt',persisted:true}})],observations:[observation(root,frame)]});
  const rootEditor=app.agentComposer().editor; rootEditor.setSelectionRange(1,4,'backward');
  const known = agentControl('root').querySelector('[data-entry-id="known-subject"]'), unresolved=agentControl('root').querySelector('[data-entry-id="unknown-subject"]'); assert.ok(known && unresolved);
  const link=known.querySelector('.tool-subject-link'); assert.ok(link); assert.equal(link.textContent,'Review'); assert.equal(known.querySelector('.tool-target')?.title,child);
  assert.equal(unresolved.querySelector('.tool-target')?.textContent,''); assert.equal(unresolved.querySelector('.tool-target')?.hidden,true); assert.equal(unresolved.querySelector('.tool-subject-link'),null); assert.equal(unresolved.querySelector('.tool-target')?.title,unknown);
  assert.equal(agentControl('root').querySelector('[data-entry-id="literal-subject"] .tool-target')?.textContent,''); assert.equal(agentControl('root').querySelector('[data-entry-id="literal-subject"] .tool-target')?.title,'arbitrary target');
  const tab=byId('sidebar-conversations').querySelector(`[data-tab-key="agent:${child}"]`); assert.ok(tab); assert.equal(tab.querySelector('.conversation-name')?.textContent,'Review'); assert.equal(tab.querySelector('.conversation-identity')?.textContent,'branch-review');
  const rosterRow=byId('roster').querySelector(`[data-identity="${child}"]`); assert.ok(rosterRow); assert.equal(rosterRow.querySelector('.row-name')?.textContent,'Review'); assert.equal(rosterRow.querySelector('.row-identity')?.textContent,'branch-review');
  link.click(); await settle(); assert.deepEqual(app.state.workspace?.selectedTarget,childTarget); assert.equal(app.agentComposer().editor.value,'Child draft'); assert.equal(agentControl('recipient').textContent,'Draft for Review · branch-review');
  app.appKey({key:'p',metaKey:true,preventDefault:()=>{}} as KeyboardEvent); await settle();
  const choices=byId('modal-body').querySelectorAll('.palette-row'); assert.ok(choices.some(row=>row.getAttribute('aria-label')?.startsWith('Review, branch-review,'))); assert.ok(choices.some(row=>row.title===root));
  byId('modal-close').click(); const rootRow=rows[0]; assert.ok(rootRow); await app.selectAgent(rootRow); await settle(); assert.equal(app.agentComposer().editor,rootEditor); assert.equal(rootEditor.value,'Root draft'); assert.deepEqual([rootEditor.selectionStart,rootEditor.selectionEnd,rootEditor.selectionDirection],[1,4,'backward']);
  assert.equal(transportLog.some(call=>call.path.includes('/inputs') || call.path.endsWith('/start')),false);
  await arrive({workspace:{id:'root-child-captions',revision:2,selectedTarget:target,conversationLayout:singlePane([target,childTarget],`agent:${root}`)},primaries:[],roster:rows.map(row=>({...row,name:'Renamed review'})),observations:[observation(root,frame)]});
  assert.equal(agentControl('root').querySelector('.tool-subject-link')?.textContent,'Renamed review'); assert.equal(app.agentComposer().editor,rootEditor);
});

test('passive draft hydration leaves focus unchanged, while explicit focus and rerenders preserve native ranges', async () => {
  const target = {kind: 'agent', identity: 'caret-agent'} as const;
  const saved = targetFixture('caret-target', target, {draft: {revision: 4, text: 'saved draft', mode: 'followUp', persisted: true}, reading: {revision: 3, anchorId: 'caret-entry', offsetPx: 17, followTail: false}});
  const frame: ProjectedFrame = {revision: 1, observedAt: '', live: [], entries: [entryFixture('caret-entry', [messageFixture('caret-message', [textPart('Reading anchor')])])], nextBefore: null, coverage, status: {busy: false}};
  hostDocument.activeElement = hostDocument.body;
  await arrive({workspace: {id: 'caret-workspace', revision: 1, selectedTarget: target}, primaries: [], roster: [agentFixture(target.identity)], targets: [saved], observations: [observation(target.identity, frame)]});
  const composer = app.agentComposer(); assert.equal(hostDocument.activeElement, hostDocument.body);
  composer.editor.setSelectionRange(2, 7, 'backward'); agentControl('editor').dispatch('select');
  const unrelated = byId('agent-search'); unrelated.focus(); await app.reload(); await settle();
  assert.equal(hostDocument.activeElement, unrelated); assert.deepEqual([composer.editor.selectionStart, composer.editor.selectionEnd], [2, 7]);
  assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading, saved.reading);
  app.focusPane('pane-1'); assert.equal(hostDocument.activeElement, composer.editor);
  assert.deepEqual([composer.editor.selectionStart, composer.editor.selectionEnd, composer.editor.selectionDirection], [2, 7, 'backward']);
  assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading, saved.reading);
});
test('agent view combines pending read, source refusal and confirmed empty in one composition', {timeout: 10000}, async () => {
  const original = globalThis.fetch; let complete: (response: Response) => void = () => {}; const held = new Promise<Response>(resolve => {complete = resolve;}); let pending = true;
  const reason = 'Required Durable 1.1.0; reader Durable 1.0.3.';
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname === '/api/agents/history-state/history' ? pending ? held.then(response => response.clone()) : Response.json({ok: true, data: {target: {kind: 'agent', identity: 'history-state'}, entries: [], nextBefore: null, coverage, revision: 'empty'}}) : original(input, init);
  try {
    const arrival = arrive({workspace: {id: 'history-state', revision: 1, selectedTarget: {kind: 'agent', identity: 'history-state'}}, primaries: [], roster: [agentFixture('history-state', {availability: 'stored', capabilities: {input: false}})], targets: [targetFixture('history-state-target', {kind: 'agent', identity: 'history-state'})]});
    await settle(); assert.equal(agentControl('history-note-line').textContent, 'Reading saved messages'); assert.equal(agentControl('history-reload').hidden, true); assert.equal(agentControl('state-line').textContent, 'Not running. Start it to send a message.'); assertAgentComposition();
    complete(Response.json({ok: false, error: {code: 'contract_mismatch', message: reason, retry: 'none'}})); await arrival; await settle();
    assert.equal(agentControl('history-note-line').textContent, 'Saved messages use an unsupported format.'); assert.equal(agentControl('history-reload').hidden, false); assert.equal(agentControl('history-reload').textContent, 'Reload messages'); assert.equal(agentControl('history-details').hidden, false);
    agentControl('history-details').dispatch('click'); assert.match(byId('modal-body').textContent, /Required Durable 1\.1\.0/); byId('modal-close').click(); assertAgentComposition();
    pending = false; agentControl('history-reload').dispatch('click'); await settle();
    assert.equal(agentControl('history-note-line').textContent, 'No messages yet.'); assert.equal(agentControl('history-reload').hidden, true); assertAgentComposition();
    assert.equal(transportLog.filter(call => call.path.includes('/history-state/start') || call.path.includes('/inputs')).length, 0);
  } finally {pending = false; complete(Response.json({ok: true, data: {entries: [], nextBefore: null, coverage}})); globalThis.fetch = original;}
});
function visibleText(node: ReturnType<typeof agentControl>): string {return node.hidden ? '' : node.text + node.children.map(visibleText).join(' ');}
function assertAgentComposition(): void {
  const root = agentControl('root'), note = agentControl('history-note');
  assert.equal(root.querySelectorAll('.history-note').length, 1); assert.equal(root.querySelectorAll('.agent-state').length, 0); assert.equal(root.querySelectorAll('.inspection-navigation').length, 0);
  assert.equal(note.children[0].tagName, 'p'); assert.equal(note.children[0].attributes.get('role'), 'status'); assert.match(note.children[1]?.textContent ?? '', /^(Load|Reload) messages$/); assert.equal(note.children[2]?.textContent, 'Details'); assert.equal(note.children.length, 3);
  assert.equal(note.querySelectorAll('svg').length, 0); assert.equal(note.querySelectorAll('details').length, 0); assert.equal(note.querySelectorAll('h2').length, 0);
  assert.equal(root.querySelectorAll('.agent-start-help').length, 0); assert.equal(agentControl('view-notice').textContent, ''); assert.equal(agentControl('empty').hidden, true);
  assert.doesNotMatch(visibleText(root), /Stored metadata|History is disconnected|History could not be loaded|A start can resume|Check connection|Start in Pi|Start agent|not connected/i);
  assert.equal(agentControl('state').parentNode, agentControl('meta'));
}
test('whole agent views retain messages independently of running, idle and incompatible hosts in both themes', async () => {
  const original = globalThis.fetch;
  try {
    for (const theme of ['dark', 'light']) for (const availability of ['live', 'stored', 'incompatible'] as const) {
      hostDocument.documentElement.dataset.appearance = theme;
      const identity = `history-${theme}-${availability}`, target = {kind: 'agent', identity} as const;
      const entry = entryFixture('retained-message', [messageFixture('retained-source', [textPart('Exact retained conversation text')])]); let failed = false;
      globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname === `/api/agents/${identity}/history` ? failed ? Response.json({ok: false, error: {code: 'host_unavailable', message: 'The saved history read failed.', retry: 'read'}}) : Response.json({ok: true, data: {target, entries: [entry], nextBefore: null, coverage, revision: 'retained'}}) : original(input, init);
      const saved = targetFixture(`saved-${identity}`, target, {draft: {revision: 4, text: 'Exact editable draft', mode: 'followUp', persisted: true}});
      const row = agentFixture(identity, {availability, capabilities: {input: availability === 'live'}});
      await arrive({workspace: {id: identity, revision: 1, selectedTarget: target}, primaries: [], roster: [row], targets: [saved], observations: availability === 'live' ? [observation(identity, {revision: 1, observedAt: '', status: {busy: true}, live: [], entries: [entry], nextBefore: null, coverage})] : []});
      if (availability === 'live') {event('agent.availability', {identity, connectionEpoch: app.state.agentEpochs.get(identity), state: 'live', capabilities: row.capabilities}); await settle();}
      assertAgentComposition(); assert.match(visibleText(agentControl('root')), /Exact retained conversation text/); assert.equal(app.agentComposer().state?.draft.text, 'Exact editable draft');
      assert.equal(agentControl('editor').disabled, false); assert.equal(agentControl('start').hidden, availability !== 'stored'); assert.equal(agentControl('start').disabled, false);
      assert.equal(agentControl('state').hidden, false);
      assert.equal(agentControl('state-line').textContent, {live: 'Steer at the next step; Queue adds a follow-up.', stored: 'Not running. Start it to send a message.', incompatible: 'This agent cannot run here. Messages are read only.'}[availability]);
      assert.equal(agentControl('model').disabled, true); assert.equal(agentControl('thinking').disabled, true);
      assert.equal(agentControl('send').hidden, availability !== 'live'); assert.equal(agentControl('send').disabled, availability !== 'live');
      assert.equal(agentControl('history-note').hidden, true);
      if (availability === 'stored') {assert.match(agentControl('start').title, /resume unfinished work/); const sends = transportLog.length; await app.agentComposer().send(); await settle(); assert.equal(transportLog.slice(sends).some(call => call.path.includes('/inputs')), false);}
      const editor = app.agentComposer().editor, message = agentControl('root').querySelector('[data-entry-id=retained-message]'); assert.ok(message); editor.setSelectionRange(2, 7, 'backward'); editor.focus();
      const before = transportLog.length; failed = true; agentControl('history-reload').dispatch('click'); await settle(); assertAgentComposition();
      assert.match(visibleText(agentControl('root')), /Exact retained conversation text/); assert.doesNotMatch(visibleText(agentControl('root')), /The saved history read failed/); assert.equal(agentControl('history-note-line').textContent, 'Saved messages could not be read.'); assert.equal(agentControl('history-reload').textContent, 'Reload messages'); assert.equal(agentControl('root').querySelector('[data-entry-id=retained-message]'), message);
      agentControl('history-details').dispatch('click'); assert.match(byId('modal-body').textContent, /The saved history read failed\./); byId('modal-close').click();
      failed = false; agentControl('history-reload').dispatch('click'); await settle(); assertAgentComposition(); assert.doesNotMatch(visibleText(agentControl('root')), /read failed/); assert.equal(agentControl('history-note').hidden, true);
      assert.equal(app.agentComposer().editor, editor); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']); assert.equal(hostDocument.activeElement, editor);
      assert.equal(transportLog.slice(before).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
    }
  } finally {globalThis.fetch = original;}
});
test('Refresh messages sits in Conversation actions for saved agents only and runs the history read', async () => {
  const original = globalThis.fetch;
  try {
    for (const availability of ['live', 'stored', 'incompatible'] as const) {
      const identity = `menu-${availability}`, target = {kind: 'agent', identity} as const; let reads = 0;
      const entry = entryFixture('menu-message', [messageFixture('menu-source', [textPart('Retained text')])]);
      globalThis.fetch = async (input, init) => {
        if (new URL(String(input), 'http://ui.test').pathname !== `/api/agents/${identity}/history`) return original(input, init);
        reads++; return Response.json({ok: true, data: {target, entries: [entry], nextBefore: null, coverage, revision: 'menu'}});
      };
      const row = agentFixture(identity, {availability, capabilities: {input: availability === 'live'}});
      await arrive({workspace: {id: identity, revision: 1, selectedTarget: target}, primaries: [], roster: [row], targets: [targetFixture(`menu-${availability}-target`, target)], observations: availability === 'live' ? [observation(identity, {revision: 1, observedAt: '', status: {busy: false}, live: [], entries: [entry], nextBefore: null, coverage})] : []});
      if (availability === 'live') {event('agent.availability', {identity, connectionEpoch: app.state.agentEpochs.get(identity), state: 'live', capabilities: row.capabilities}); await settle();}
      assert.equal(agentControl('history-note').hidden, true);
      app.openConversationActions(); const menu = globalThis.document.querySelector('.context-menu'); assert.ok(menu);
      const refresh = menu.children.find(item => item.textContent === 'Refresh messages');
      if (availability === 'live') {assert.equal(refresh, undefined); continue;}
      assert.ok(refresh); assert.equal(refresh.getAttribute('aria-disabled'), 'false');
      const before = reads; const sends = transportLog.length; refresh.click(); await settle();
      assert.equal(reads, before + 1); assert.equal(agentControl('history-note').hidden, true);
      assert.equal(transportLog.slice(sends).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
    }
  } finally {globalThis.fetch = original;}
});
test('whole idle and incompatible views show one plain unreadable-history error with its diagnostic behind Details', async () => {
  const original = globalThis.fetch, diagnostic = 'The retained source is unreadable.', plain = 'Saved messages could not be read.';
  try {
    for (const theme of ['dark', 'light']) for (const availability of ['stored', 'incompatible'] as const) {
      hostDocument.documentElement.dataset.appearance = theme; const identity = `unreadable-${theme}-${availability}`, target = {kind: 'agent', identity} as const; let failed = true;
      const requests: Array<[string, string]> = [];
      globalThis.fetch = async (input, init) => {
        const path = new URL(String(input), 'http://ui.test').pathname; requests.push([init?.method ?? 'GET', path]);
        return path === `/api/agents/${identity}/history` ? failed ? Response.json({ok: false, error: {code: 'source_unreadable', message: diagnostic, retry: 'none'}}) : Response.json({ok: true, data: {target, entries: [], nextBefore: null, coverage, revision: 'empty'}}) : original(input, init);
      };
      await arrive({workspace: {id: identity, revision: 1, selectedTarget: target}, primaries: [], roster: [agentFixture(identity, {availability, capabilities: {input: false}})], targets: [targetFixture(identity, target, {draft: {revision: 4, text: 'Exact unreadable-view draft', mode: 'followUp', persisted: true}})]});
      assertAgentComposition(); const rendered = visibleText(agentControl('root')); assert.equal(rendered.split(plain).length - 1, 1); assert.doesNotMatch(rendered, /retained source|Permission denied/);
      assert.equal(agentControl('history-note-line').textContent, plain); assert.equal(agentControl('state-line').textContent, availability === 'stored' ? 'Not running. Start it to send a message.' : 'This agent cannot run here. Messages are read only.');
      agentControl('history-details').dispatch('click'); assert.equal(byId('modal-body').textContent, diagnostic); byId('modal-close').click();
      assert.equal(agentControl('editor').disabled, false); assert.equal(agentControl('start').hidden, availability !== 'stored');
      assert.equal(byId('workbench-activity').textContent, availability === 'stored' ? 'Not running' : 'Read only'); assert.doesNotMatch(hostDocument.title, /host/i);
      const editor = app.agentComposer().editor, before = requests.length; assert.equal(editor.value, 'Exact unreadable-view draft'); editor.setSelectionRange(1, 3); editor.focus(); failed = false; agentControl('history-reload').dispatch('click'); await settle();
      assertAgentComposition(); assert.match(agentControl('history-note-line').textContent, /^No messages yet/); assert.doesNotMatch(visibleText(agentControl('root')), /saved messages could not be read|retained source/); assert.equal(agentControl('history-details').hidden, true);
      assert.equal(app.agentComposer().editor, editor); assert.equal(editor.value, 'Exact unreadable-view draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [1, 3]); assert.equal(hostDocument.activeElement, editor);
      assert.deepEqual(requests.slice(before), [['GET', `/api/agents/${identity}/history`]]);
    }
  } finally {globalThis.fetch = original;}
});
test('agent settings retain model and thinking text from the exact frame without replacing global Primary facts', async () => {
  const row = agentFixture('selected', {model: {provider: 'other', modelId: 'roster-model'}, thinkingLevel: 'low'});
  const frame: ProjectedFrame = {revision: 1, observedAt: '', live: [], entries: [], nextBefore: null, coverage,
    status: {busy: false, model: {provider: 'provider', modelId: 'selected-agent-long-model-name'}, thinkingLevel: 'medium'}};
  await arrive({workspace: {id: 'agent-settings', revision: 2, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'selected'}}, primaries: [primaryFixture()], roster: [row], observations: [observation('selected', frame)]});
  event('agent.availability', {identity: row.identity, connectionEpoch: app.state.agentEpochs.get(row.identity), state: 'live', capabilities: row.capabilities}); await settle();
  const settings = () => ['model', 'thinking'].map(key => agentControl(key).querySelector('.composer-setting-label')?.textContent); const primaryModel = primaryControl('model').textContent;
  app.agentChrome('selected', row); assert.deepEqual(settings(), ['selected-agent-long-model-name', 'Medium']);
  assert.equal(agentControl('model').hidden, true); assert.equal(agentControl('thinking').hidden, true);
  assert.match(agentControl('model').getAttribute('aria-label') ?? '', /: provider\/selected-agent-long-model-name$/);
  assert.match(agentControl('thinking').getAttribute('aria-label') ?? '', /: medium$/);
  const detail=byId('agent-settings-detail'),limit='Last observed settings are not confirmed current.';
  assert.equal(detail.textContent,'Model provider/selected-agent-long-model-name · Thinking medium');assert.equal(detail.hidden,false);
  app.state.conversations.clear(); app.agentChrome('selected', row);
  assert.deepEqual(settings(), ['roster-model', 'Low']);
  assert.match(agentControl('model').getAttribute('aria-label') ?? '', /: other\/roster-model$/); assert.match(agentControl('model').title, /Last observed model/);
  assert.match(agentControl('thinking').getAttribute('aria-label') ?? '', /: low$/); assert.match(agentControl('thinking').title, /Last observed thinking/);
  assert.deepEqual(detail.textContent.split('\n'),['Last observed: Model other/roster-model · Thinking low',limit]);
  for(const [fields,text] of [[{model:undefined},'Last observed thinking low'],[{thinkingLevel:undefined},'Last observed model other/roster-model'],[{model:undefined,thinkingLevel:undefined},'']] as const){
    app.state.roster.set(row.identity,{...row,...fields});app.agentChrome(row.identity);
    assert.equal(byId('agent-settings-detail'),detail);assert.deepEqual(detail.textContent.split('\n'),text?[text,limit]:['']);assert.equal(detail.hidden,!text);
  }
  assert.equal(primaryControl('model').textContent, primaryModel); assert.doesNotMatch(primaryControl('model').textContent, /selected-agent|roster-model/);
});
test('a fresh agent selection retains each earlier control and prepares only its addressed owner', async () => {
  const a = agentFixture('a'), b = agentFixture('b'); const targetA = targetFixture('saved-a', {kind: 'agent', identity: 'a'}), targetB = targetFixture('saved-b', {kind: 'agent', identity: 'b'});
  const frame: ProjectedFrame = {revision: 1, observedAt: '', live: [], status: {busy: false}, entries: [entryFixture('a-entry', [messageFixture('a-message', [textPart('A transcript')])])], nextBefore: 1, coverage};
  await arrive({workspace: {id: 'agent-selection', revision: 3, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'a'}, conversationLayout: singlePane([{kind: 'primary'}, {kind: 'agent', identity: 'a'}], 'agent:a')}, primaries: [primaryFixture()], roster: [a, b], targets: [targetA], observations: [observation('a', frame)]});
  const earlierA = agentControl('earlier'), rootA = agentControl('root'), editorA = app.agentComposer().editor; const calls = transportLog.length;
  assert.equal(rootA.contains(earlierA), true); assert.match(rootA.textContent, /A transcript/);
  const original = globalThis.fetch; let complete: (response: Response) => void = () => {}; const pending = new Promise<Response>(resolve => {complete = resolve;});
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname.endsWith('/targets') && JSON.parse(String(init?.body)).target.identity === 'b' ? pending.then(response => response.clone()) : original(input, init);
  try {
    const selecting = app.selectAgent(b); await settle(); const earlierB = agentControl('earlier'), rootB = agentControl('root');
    assert.notEqual(rootB, rootA); assert.notEqual(earlierB, earlierA); assert.equal(rootB.contains(earlierB), true);
    assert.equal(rootA.contains(earlierA), true); assert.equal(rootA.hidden, true); assert.doesNotMatch(rootB.textContent, /A transcript/); assert.equal(app.agentComposer().state, undefined);
    complete(Response.json({ok: true, data: {targetState: targetB, availability: 'live', capabilities: b.capabilities}})); await selecting; await settle();
    assert.equal(app.agentComposer().state?.targetKey, 'saved-b'); assert.equal(agentControl('earlier'), earlierB); assert.equal(agentControl('root'), rootB);
    await app.selectAgent(a); await settle(); assert.equal(app.agentComposer().editor, editorA); assert.equal(agentControl('earlier'), earlierA);
    assert.equal(transportLog.slice(calls).some(call => call.path.endsWith('/input') || call.path.endsWith('/start')), false);
  } finally {globalThis.fetch = original;}
});
