import assert from 'node:assert/strict';
import test from 'node:test';
import type {ConversationTab, Workspace} from '../shared/api.ts';
import {activeTab, ConversationCaptions, conversationIdentityText, agentIdentityTails, agentName, closeTab, duplicateIdentityTails, duplicateTabTails, FileBrowseState, layoutTarget, MAX_TABS, openTab, switchTab, tabForTarget, workspaceLayout} from './tabs.ts';
import {createPaneLayout, paneById, paneLeaves, splitPane} from './pane-layout.ts';
const agent = (identity: string): ConversationTab => ({kind: 'agent', identity});
const base = () => createPaneLayout([{kind: 'primary'}]);
const workspace = (layout = base()): Workspace => ({id: 'fixture', revision: 0, primaryKey: 'primary-key', conversationLayout: layout});

test('caption priority uses exact public names, first-message excerpts and honest absence', () => {
  const identity = '00000000-0000-4000-8000-000000000001';
  assert.equal(agentName(' Name ', 'handle', identity, ' Reported '), 'Reported');
  assert.equal(agentName(identity, 'writer', identity, '  '), 'writer');
  assert.equal(agentName(identity, undefined, identity, undefined, ' First request\nLater content'), 'First request');
  assert.equal(agentName(undefined, undefined, identity, undefined, '😀'.repeat(100)), `${'😀'.repeat(79)}…`);
  assert.equal(agentName(undefined, undefined, identity, undefined, identity), 'Unnamed conversation');
  assert.equal(conversationIdentityText(`${identity}:7906`), true); assert.equal(conversationIdentityText(`prefix ${identity}`), false);
});
test('caption qualifiers preserve distinct root and child ownership across reorder and rename', () => {
  const captions = new ConversationCaptions(), root = 'root', child = 'root:7906';
  const rows = [{identity: root, name: 'Review'}, {identity: child, name: 'Review'}, {identity: 'excerpt', firstMessage: 'Review the result\nMore prose'}, {identity: 'unknown'}];
  captions.update(rows); const first = {...captions.get(root)}, second = {...captions.get(child)};
  assert.deepEqual(first, {name: 'Review', tail: '1'}); assert.deepEqual(second, {name: 'Review', tail: '2'});
  assert.equal(captions.get('excerpt').source, 'first-message'); assert.equal(captions.get('unknown').name, 'Unnamed conversation');
  captions.update([...rows].reverse()); assert.deepEqual(captions.get(root), first); assert.deepEqual(captions.get(child), second);
  captions.update([{identity: child}, {identity: root, name: 'Root name'}]); assert.equal(captions.get(child).name, 'Unnamed conversation');
  captions.update(rows.map(row => row.identity === root || row.identity === child ? {...row, name: 'Renamed'} : row));
  assert.equal(captions.get(root).tail, first.tail); assert.equal(captions.get(child).tail, second.tail);
  assert.deepEqual(rows.slice(0, 2).map(row => row.identity), [root, child]);
});
test('complete captions stay distinct from supplied literal names across reorder', () => {
  const captions = new ConversationCaptions(), rows = [{identity:'a',name:'Review'},{identity:'b',name:'Review'},{identity:'c',name:'Review · 1'},{identity:'d',name:'Review · 1 · 3'}];
  const text = (identity:string) => {const caption=captions.get(identity);return caption.tail ? `${caption.name} · ${caption.tail}` : caption.name;};
  captions.update(rows); const first = new Map(rows.map(row=>[row.identity,text(row.identity)]));
  assert.equal(new Set(first.values()).size,rows.length); assert.equal(first.get('a'),'Review · 1'); assert.equal(first.get('b'),'Review · 2');
  assert.equal(captions.get('c').tail,'Label 3'); const revision=captions.revision;
  captions.update([...rows].reverse()); assert.equal(captions.revision,revision); for(const row of rows)assert.equal(text(row.identity),first.get(row.identity));
  captions.update([...rows,{identity:'e',name:'Review · 1 · Label 3'}]); assert.equal(new Set([...rows,{identity:'e'}].map(row=>text(row.identity))).size,5);
  captions.update(rows); assert.equal(captions.get('a').tail,'1'); assert.equal(captions.get('b').tail,'2'); assert.equal(captions.get('c').tail,'Label 3');
});

test('duplicate captions prefer distinct public handles and folder suffixes before ordinals', () => {
  const captions = new ConversationCaptions();
  captions.update([{identity:'a',name:'Review',handle:'reader'},{identity:'b',name:'Review',handle:'writer'},{identity:'c',name:'Build',cwd:'/projects/one'},{identity:'d',name:'Build',cwd:'/projects/two'}]);
  assert.deepEqual(['a','b','c','d'].map(identity=>captions.get(identity).tail), ['reader','writer','one','two']);
  captions.update([{identity:'a',name:'Same',cwd:'/1'},{identity:'b',name:'Same'}]);
  assert.notEqual(captions.get('a').tail, captions.get('b').tail);
  const retained = new ConversationCaptions(); retained.update([{identity:'a',name:'Same'},{identity:'b',name:'Same'}]);
  retained.update([{identity:'a',name:'Renamed'},{identity:'c',name:'Renamed',cwd:'/1'}]);
  assert.equal(retained.get('a').tail,'Label 1'); assert.equal(retained.get('c').tail,'1');
  retained.update([{identity:'a',name:'Folder'},{identity:'c',name:'Folder',cwd:'/projects'},{identity:'d',name:'Folder',cwd:'/work/projects'}]);
  assert.equal(retained.get('c').tail,'/projects'); assert.equal(retained.get('d').tail,'work/projects');
});

test('unnamed and duplicate agent names retain unique nonrouting suffixes across storage identities',()=> {
  const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
  const rows=ids.map(identity=>({identity,name:identity})), tails=agentIdentityTails(rows);
  assert.deepEqual(ids.map(id=>tails.get(id)),['1','2']);assert.equal(agentName(ids[0],'writer',ids[0]??''),'writer');assert.equal(agentName('  ',undefined,ids[0]??''),'Unnamed conversation');
  const conversations=ids.map(identity=>({identity:`${identity}:2`,name:'Review'})), same=duplicateIdentityTails(conversations);
  assert.deepEqual(conversations.map(row=>same.get(row.identity)),['0001:2','0002:2']);
  const reversed=duplicateIdentityTails([...conversations].reverse());for(const row of conversations)assert.equal(same.get(row.identity),reversed.get(row.identity));
  const first=conversations[0],second=conversations[1];assert.ok(first&&second);const renamed=duplicateIdentityTails([{...first,name:'Named'},second]);assert.equal(renamed.get(first.identity),undefined);
  assert.deepEqual(rows.map(row=>row.identity),ids);
});
test('generic blank or identity captions do not adopt agent singleton suffixes', () => {
  for (const name of ['', 'session-1234']) assert.equal(duplicateIdentityTails([{name, identity: 'session-1234'}]).size, 0);
  assert.equal(agentIdentityTails([{name: '', identity: 'session-1234'}]).get('session-1234'), undefined);
});
test('Primary captions never derive an agent suffix from the internal tab key', () => {
  const tails = duplicateTabTails([{kind: 'primary'}, agent('store:conversation')], () => 'Review');
  assert.equal(tails.get('primary'), undefined); assert.equal(tails.get('store:conversation'), undefined);
});

test('plain browsing reuses only a transient unmodified view and kept or held views remain',()=> {
  const browse = new FileBrowseState(), file = (path:string)=>({kind:'file' as const,rootId:'r',path});let layout = base();
  layout = browse.choose(layout,file('a'),()=>false);layout = browse.choose(layout,file('b'),()=>false);assert.deepEqual(paneLeaves(layout.root).flatMap(pane=>pane.tabs).filter(tab=>tab.kind === 'file'),[file('b')]);
  browse.keep('file:["r","b"]');layout = browse.choose(layout,file('c'),()=>false);assert.equal(paneLeaves(layout.root)[0]?.tabs.length,3);
  layout = browse.choose(layout,file('d'),()=>true);assert.equal(paneLeaves(layout.root)[0]?.tabs.length,4);browse.hold();layout = browse.choose(layout,file('e'),()=>false);assert.equal(paneLeaves(layout.root)[0]?.tabs.length,5);
});
test('same-name file labels use useful shortest directory suffixes, never serialized identity',()=> {
  const tabs = ['packages/one/README.md','packages/two/README.md','docs/README.md'].map(path=>({kind:'file' as const,rootId:'root-identity',path}));
  const labels = duplicateTabTails(tabs,tab=>tab.kind === 'file' ? tab.path.split('/').at(-1) ?? '' : '');
  assert.deepEqual([...labels.values()],['one','two','docs']);assert.equal([...labels.values()].some(value=>value.includes('root-identity') || value.includes('[')),false);
});
test('identical relative file paths in different roots have quiet unique captions',()=> {
  const ids = ['00000000-0000-4000-8000-00000001a000','00000000-0000-4000-8000-00000002a000'];
  const tabs = ids.map(rootId=>({kind:'file' as const,rootId,path:'docs/README.md'}));
  const labels = duplicateTabTails(tabs,()=> 'README.md');
  assert.deepEqual([...labels.values()],['docs · 1a000','docs · 2a000']);
  assert.equal(new Set(labels.values()).size,2);
});
test('file focus survives retained conversation selection and repeated selection reuses its tab',()=> {
  const file = {kind:'file' as const,rootId:'r',path:'note.md'},layout = openTab(openTab(base(),agent('a')),file);
  const value = {...workspace(layout),selectedTarget:{kind:'agent' as const,identity:'a'}};
  assert.deepEqual(activeTab(workspaceLayout(value)),file);assert.equal(layoutTarget(layout,{kind:'primary',key:'p',epoch:1}),null);assert.deepEqual(openTab(layout,file),layout);
});
test('workspace defaults, explicit empty layouts and current selected targets use the single tree', () => {
  assert.deepEqual(workspaceLayout(), createPaneLayout([])); assert.deepEqual(workspaceLayout(workspace()), base());
  const selected = {...workspace(), selectedTarget: {kind: 'agent' as const, identity: 'a'}};
  const layout = workspaceLayout(selected); assert.deepEqual(activeTab(layout), agent('a')); assert.equal(paneLeaves(layout.root).length, 1);
  assert.deepEqual(workspaceLayout(workspace(createPaneLayout([]))), createPaneLayout([]));
  assert.equal(workspaceLayout({...selected, conversationLayout: layout}), layout);
});
test('missing Primary closes only its tab, preserving agent topology and selected identity', () => {
  let layout = openTab(openTab(base(), agent('a')), agent('b'));
  layout = splitPane(layout, layout.focusedPane, 'y', {width: 900, height: 900, divider: 4});
  const value = {...workspace(layout), primaryKey: undefined, selectedTarget: {kind: 'agent' as const, identity: 'b'}};
  const current = workspaceLayout(value); assert.equal(paneLeaves(current.root).length, 2); assert.deepEqual(activeTab(current), agent('b'));
  assert.equal(paneLeaves(current.root).flatMap(pane => pane.tabs).some(tab => tab.kind === 'primary'), false);
  assert.deepEqual(workspaceLayout({...workspace(), primaryKey: undefined}), createPaneLayout([]));
});
test('opening an existing target focuses its owning pane without moving or copying it', () => {
  const original = openTab(openTab(base(), agent('a')), agent('b')); const split = splitPane(original, 'pane-1', 'x', {width: 900, height: 700, divider: 4});
  const selected = openTab(split, agent('a')); assert.equal(selected.focusedPane, 'pane-1'); assert.equal(selected.root.kind, 'split');
  assert.deepEqual(activeTab(selected), agent('a')); assert.equal(paneLeaves(selected.root).flatMap(pane => pane.tabs).length, 3);
  assert.equal(paneById(selected, 'pane-2')?.active, 'agent:b'); assert.equal(paneById(original, 'pane-1')?.active, 'agent:b');
});
test('closing routes by stable key after reorder and never uses a stale array position', () => {
  const layout = openTab(openTab(base(), agent('a')), agent('b')); const closed = closeTab(layout, 'agent:b');
  assert.deepEqual(activeTab(closed), agent('a')); assert.equal(closeTab(layout, 'missing'), layout);
  assert.deepEqual(closeTab(base(), 'primary'), createPaneLayout([])); assert.equal(paneById(layout, 'pane-1')?.tabs.length, 3);
});
test('keyboard switching wraps only in the focused group and Primary dispatch uses its current epoch', () => {
  let layout = openTab(openTab(base(), agent('a')), agent('b')); layout = splitPane(layout, 'pane-1', 'x', {width: 900, height: 700, divider: 4});
  assert.deepEqual(activeTab(switchTab(layout, 1)), agent('b'));
  const selected = openTab(layout, {kind: 'primary'}); assert.deepEqual(activeTab(switchTab(selected, -1)), agent('a'));
  assert.deepEqual(activeTab(switchTab(selected, 3)), agent('a')); assert.equal(switchTab(selected, Number.NaN), selected);
  assert.deepEqual(layoutTarget(base(), {kind: 'primary', key: 'p', epoch: 8}), {kind: 'primary', key: 'p', epoch: 8});
  assert.equal(layoutTarget(createPaneLayout([])), null); assert.deepEqual(layoutTarget(layout), {kind: 'agent', identity: 'b'});
  assert.deepEqual(tabForTarget({kind: 'primary', key: 'p', epoch: 8}), {kind: 'primary'});
  assert.deepEqual(tabForTarget({kind: 'agent', identity: 'a'}), agent('a'));
});
test('the shared cap rejects new tabs without replacing any existing target or topology', () => {
  let full = base(); for (let i = 1; i < MAX_TABS; i++) full = openTab(full, agent(String(i)));
  const before = JSON.stringify(full); assert.throws(() => openTab(full, agent('extra')), /tab limit/);
  assert.deepEqual(activeTab(openTab(full, agent('1'))), agent('1')); assert.equal(JSON.stringify(full), before);
  assert.throws(() => workspaceLayout({...workspace(full), selectedTarget: {kind: 'agent', identity: 'extra'}}), /tab limit/);
});
test('duplicate identity tails stay unique across stores without decorating unique names', () => {
  const rows = [{name: 'Review', identity: 'first:same'}, {name: 'Review', identity: 'second:same'}, {name: 'Unique', identity: 'third:same'}];
  const tails = duplicateIdentityTails(rows); assert.notEqual(tails.get('first:same'), tails.get('second:same')); assert.equal(tails.get('third:same'), undefined);
  assert.deepEqual(rows.map(row => row.identity), ['first:same', 'second:same', 'third:same']);
});
