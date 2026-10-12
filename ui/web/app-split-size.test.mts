import assert from 'node:assert/strict';
import test from 'node:test';
import {activeTab} from './tabs.ts';
import { createPaneLayout, splitPane } from './pane-layout.ts';
import {app, arrive, settle, host, byId, paneNode, primaryControl, agentControl, primaryFixture, agentFixture, targetFixture, twoPanes, selectionSaves, failSelection} from './app-fixture.mts';
async function fixture(width = 1200, ratio = 50, sidebar = true) {
  host.viewport = width; failSelection(undefined); const layout = twoPanes('a'); assert.equal(layout.root.kind, 'split'); if (layout.root.kind === 'split') layout.root.ratio = ratio;
  const primary = targetFixture('size-primary', {kind: 'primary', key: 'p', epoch: 1}), agent = targetFixture('size-agent', {kind: 'agent', identity: 'a'});
  primary.draft.text = 'Primary draft'; agent.draft.text = 'Agent draft';
  await arrive({workspace: {id: 'pane-size', revision: 10, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'a'}, sidebarVisible: sidebar, conversationLayout: layout}, primaries: [primaryFixture()], roster: [agentFixture('a')], targets: [primary, agent]});
  selectionSaves.length = 0; const node = byId('conversation-panes').querySelector('.pane-split'); assert.ok(node); const handle = node.querySelector('.pane-divider'); assert.ok(handle);
  return {layout, node, handle, primary: primaryControl('root'), agent: agentControl('root'), editors: [app.primaryComposer().editor, app.agentComposer().editor], drafts: [app.primaryComposer().state?.draft, app.agentComposer().state?.draft]};
}
test('split restoration clamps pixel tracks without replacing the saved ratio or retained conversation state', async () => {
  const f = await fixture(1200, 20); assert.equal(app.splitActive(), true); assert.equal(f.node.properties.get('--pane-first'), '320px');
  assert.deepEqual(app.state.workspace?.conversationLayout, f.layout); assert.equal(selectionSaves.length, 0); assert.equal(f.handle.getAttribute('aria-valuemin'), '320'); assert.equal(f.handle.getAttribute('aria-valuemax'), '604');
  host.viewport = 2000; app.renderNavigation(); await settle(); assert.equal(f.node.properties.get('--pane-first'), '345px');
  assert.equal(primaryControl('root'), f.primary); assert.equal(agentControl('root'), f.agent); assert.deepEqual([app.primaryComposer().editor, app.agentComposer().editor], f.editors); assert.deepEqual([app.primaryComposer().state?.draft, app.agentComposer().state?.draft], f.drafts); assert.equal(selectionSaves.length, 0);
});
test('a safe split uses the current pane menu contract without changing the sidebar preference or selected target', async () => {
  const f = await fixture(1200); const single = createPaneLayout([{kind: 'primary'}, {kind: 'agent', identity: 'a'}], 'agent:a');
  app.applyLayout(single); await settle(); selectionSaves.length = 0;
  const next = splitPane(single, single.focusedPane, 'x', {width: 928, height: 640, divider: 4}, 'agent:a'); app.applyLayout(next); await settle();
  assert.equal(app.splitActive(), true); assert.equal(byId('sidebar').hidden, false); assert.equal(app.state.workspace?.sidebarVisible, true); assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: 'a'});
  assert.equal(selectionSaves.length, 1); assert.equal(selectionSaves[0]?.body.sidebarVisible, undefined); assert.deepEqual([app.primaryComposer().editor, app.agentComposer().editor], f.editors);
});
test('an insufficient window closes the drawer and refuses a new split without changing the target or drafts', async () => {
  const f = await fixture(620); const single = createPaneLayout([{kind: 'primary'}, {kind: 'agent', identity: 'a'}], 'agent:a'); app.applyLayout(single); await settle(); app.toggleSidebar(true); await settle();
  const next = splitPane(single, single.focusedPane, 'x', {width: 620, height: 640, divider: 4}); assert.equal(next, single); app.applyLayout(next); await settle();
  assert.equal(app.drawerOpen, false); assert.equal(byId('sidebar').hidden, true); assert.equal(app.splitActive(), false); assert.equal(primaryControl('root').hidden, true); assert.equal(agentControl('root').hidden, false); assert.equal(activeTab(app.state.workspace?.conversationLayout ?? single)?.kind, 'agent');
  assert.deepEqual([app.primaryComposer().state?.draft, app.agentComposer().state?.draft], f.drafts); assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: 'a'});
});
test('restored splits use the fixed divider threshold and narrowness shows only focus without changing the tree', async () => {
  for (const pointerWidth of [5, 44]) {
    host.splitter = pointerWidth; const f = await fixture(644, 80, false); assert.equal(f.node.properties.get('--pane-first'), '320px'); assert.equal(f.handle.getAttribute('aria-valuemin'), '320'); assert.equal(f.handle.getAttribute('aria-valuemax'), '320');
    host.viewport = 643; app.renderNavigation(); await settle(); assert.equal(app.splitActive(), true); assert.equal(paneNode('primary-pane').hidden, true); assert.equal(paneNode('agent-pane').hidden, false); assert.deepEqual(app.state.workspace?.conversationLayout, f.layout); assert.equal(selectionSaves.length, 0);
    host.viewport = 1000; app.renderNavigation(); await settle(); assert.equal(paneNode('primary-pane').hidden, false); assert.deepEqual([app.primaryComposer().editor, app.agentComposer().editor], f.editors);
  }
});
test('viewport corrections do not reorder queued selection or replay a refused layout write', async () => {
  const f = await fixture(1200); const single = createPaneLayout([{kind: 'primary'}, {kind: 'agent', identity: 'a'}], 'agent:a');
  await app.selectionQueue.select({conversationLayout: single}); await settle(); assert.equal(selectionSaves.length, 1);
  host.viewport = 600; app.renderNavigation(); await settle(); assert.equal(selectionSaves.length, 1); assert.equal(app.state.workspace?.sidebarVisible, true);
  failSelection({code: 'capacity', message: 'Selection unavailable', retry: 'capacity'}); await assert.rejects(app.selectionQueue.select({conversationLayout: f.layout}), /Selection unavailable/); await settle();
  const refused = app.state.workspace?.conversationLayout; app.renderNavigation(); await settle(); assert.equal(selectionSaves.length, 1); assert.deepEqual(app.state.workspace?.conversationLayout, refused); assert.deepEqual([app.primaryComposer().editor, app.agentComposer().editor], f.editors); failSelection(undefined);
});
