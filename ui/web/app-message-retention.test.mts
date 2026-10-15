import assert from 'node:assert/strict';
import test from 'node:test';
import {LIMITS} from '../shared/api.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {closeTab} from './tabs.ts';

const f = await createAppFixture();
const {app, arrive, settle, byId, primaryFixture, agentFixture, targetFixture, singlePane, twoPanes} = f;
function ancestors(node: HostNode): HostNode[] {
  const chain: HostNode[] = [];
  for (let parent = node.parentNode; parent; parent = parent.parentNode) chain.push(parent);
  return chain;
}
function currentLayout() {
  const layout = app.state.workspace?.conversationLayout; assert.ok(layout); return layout;
}
async function seed(workspace: string, identities: string[], text = '', visible = false): Promise<void> {
  const primary = primaryFixture({epoch: 12001}), first = identities[0]; assert.ok(first);
  await arrive({workspace: {id: workspace, revision: 1, primaryKey: primary.key,
    selectedTarget: {kind: 'primary', key: primary.key, epoch: primary.epoch},
    conversationLayout: visible ? twoPanes(first) : singlePane()}, primaries: [primary],
    roster: identities.map(identity => agentFixture(identity)), targets: identities.map(identity =>
      targetFixture(`saved-${identity}`, {kind: 'agent', identity}, {draft: {revision: 1, text, mode: 'prompt', persisted: true}}))});
}
function messageAction(identity: string): HostNode {
  const action = byId('roster').querySelector(`[data-identity="${identity}"]`)?.querySelector('.row-message');
  assert.ok(action); return action;
}
async function open(identity: string): Promise<HostNode> {
  messageAction(identity).click(); await settle();
  const editor = f.hostDocument.body.querySelector('.composer[data-message-panel="true"] textarea');
  assert.ok(editor); return editor;
}
async function close(): Promise<void> {byId('agent-message-close').click(); await settle();}

test('acknowledged and empty Message drafts keep native editors and Resume labels across panel Close', async () => {
  for (const text of ['Saved native draft', '']) {
    const identity = text ? 'saved-message-editor' : 'empty-message-editor';
    await seed(`retention-${identity}`, [identity], 'Before the native edit');
    const editor = await open(identity), chain = ancestors(editor);
    editor.value = text; editor.dispatch('input');
    await app.drainDev(new AbortController().signal); await settle();
    const acknowledged = f.fixture.targets?.find(saved => saved.targetKey === `saved-${identity}`)?.draft;
    assert.equal(acknowledged?.text, text); assert.equal(acknowledged?.persisted, true); assert.equal(acknowledged?.revision, 2);
    editor.focus(); editor.setSelectionRange(text ? 2 : 0, text ? 9 : 0, 'backward'); editor.dispatch('select');
    const range = [editor.selectionStart, editor.selectionEnd, editor.selectionDirection];
    await close();
    assert.equal(editor.isConnected, true); assert.deepEqual(ancestors(editor), chain);
    assert.match(messageAction(identity).getAttribute('aria-label') ?? '', /^Resume message to /);
    assert.equal(await open(identity), editor); assert.equal(editor.value, text);
    assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], range);
    await close();
  }
});

test('Message target switches keep exact native owners and workspace changes release settled editors', async () => {
  await seed('retention-targets', ['retained-a', 'retained-b'], 'Exact saved draft');
  const a = await open('retained-a'), aChain = ancestors(a); await close();
  const b = await open('retained-b'), bChain = ancestors(b); await close();
  assert.equal(await open('retained-a'), a); assert.deepEqual(ancestors(a), aChain); await close();
  assert.equal(await open('retained-b'), b); assert.deepEqual(ancestors(b), bChain); await close();
  await seed('retention-other-workspace', ['other-owner']);
  assert.equal(a.isConnected, false); assert.equal(b.isConnected, false);
});

test('recipient switches retire the old projection visibility while retaining each native editor', async () => {
  for (const visible of [false, true]) {
    const a = `projection-a-${visible}`, b = `projection-b-${visible}`;
    await seed(`retention-projection-${visible}`, [a, b], 'Exact native draft', visible);
    const first = await open(a), firstChain = ancestors(first), firstRoot = first.closest('.conversation'); assert.ok(firstRoot);
    const second = await open(b), secondChain = ancestors(second), secondRoot = second.closest('.conversation'); assert.ok(secondRoot);
    const assertOwner = (current: HostNode, previous: HostNode, previousVisible: boolean): void => {
      const currentRoot = current.closest('.conversation'), previousRoot = previous.closest('.conversation');
      const previousForm = previous.closest('.composer'); assert.ok(currentRoot); assert.ok(previousRoot); assert.ok(previousForm);
      assert.equal(f.hostDocument.body.querySelectorAll('.composer[data-message-panel="true"]').length, 1);
      assert.equal(current.closest('[hidden],[inert]'), null);
      assert.equal(currentRoot.hidden, false); assert.equal(currentRoot.inert, false);
      assert.equal(app.stableViews().slot(current as unknown as HTMLElement)?.id, 'agent-message-editor-slot');
      assert.equal(previousForm.dataset.messagePanel, undefined); assert.notEqual(previousForm.style.position, 'absolute');
      assert.equal(previousRoot.hidden, !previousVisible); assert.equal(previousRoot.inert, !previousVisible);
      const previousSlot = app.stableViews().slot(previous as unknown as HTMLElement);
      if (previousVisible) assert.ok(previousSlot?.closest('.pane-leaf')); else assert.equal(previousSlot, undefined);
      assert.equal(previous.isConnected, true);
    };
    assertOwner(second, first, visible);
    assert.equal(await open(a), first); assertOwner(first, second, false);
    assert.deepEqual(ancestors(first), firstChain); assert.deepEqual(ancestors(second), secondChain);
    assert.equal(byId('agent-message-identity').textContent, a);
    await close();
    assert.equal(secondRoot.hidden, true); assert.equal(secondRoot.inert, true);
  }
});

test('an acknowledged explicit tab close releases its settled Message editor without deleting its draft', async () => {
  const identity = 'explicit-editor-close';
  await seed('retention-disposal', [identity], 'Saved text survives explicit disposal', true);
  const editor = await open(identity); await close();
  app.applyLayout(closeTab(currentLayout(), `agent:${identity}`));
  await app.selectionQueue.drain(); await settle();
  assert.equal(editor.isConnected, false);
  assert.equal(f.fixture.targets?.find(saved => saved.targetKey === `saved-${identity}`)?.draft.text, 'Saved text survives explicit disposal');
});

test('a newer Message intent survives an older explicit tab-close acknowledgment', async t => {
  const identity = 'renewed-editor-owner';
  await seed('retention-close-race', [identity], 'Saved native state', true);
  const editor = await open(identity); await close();
  const original = globalThis.fetch, started = Promise.withResolvers<void>(), pending = Promise.withResolvers<Response>();
  let finish: (() => Promise<void>) | undefined;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'PUT' && new URL(String(input), 'http://ui.test').pathname.endsWith('/selection')) {
      finish = async () => {pending.resolve(await original(input, init));}; started.resolve(); return pending.promise;
    }
    return original(input, init);
  };
  t.after(async () => {globalThis.fetch = original; await finish?.(); await app.selectionQueue.drain();});
  app.applyLayout(closeTab(currentLayout(), `agent:${identity}`)); await started.promise;
  assert.equal(editor.isConnected, true); assert.equal(await open(identity), editor); await close();
  await finish?.(); await app.selectionQueue.drain(); await settle();
  assert.equal(editor.isConnected, true); assert.equal(await open(identity), editor); await close();
});

test('a refused explicit tab close preserves its native Message editor', async t => {
  const identity = 'refused-editor-close';
  await seed('retention-refused-close', [identity], 'Saved native state', true);
  const editor = await open(identity), chain = ancestors(editor); await close();
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => init?.method === 'PUT' && new URL(String(input), 'http://ui.test').pathname.endsWith('/selection')
    ? Response.json({ok: false, error: {code: 'capacity', message: 'Close refused', retry: 'manual'}}) : original(input, init);
  app.applyLayout(closeTab(currentLayout(), `agent:${identity}`));
  await app.selectionQueue.drain(); await settle();
  assert.equal(editor.isConnected, true); assert.deepEqual(ancestors(editor), chain);
  assert.equal(await open(identity), editor); await close();
});

test('a tab reopened before its close acknowledgment retains its native Message editor', async t => {
  const identity = 'reopened-editor-tab';
  await seed('retention-reopened-tab', [identity], 'Saved native state', true);
  const editor = await open(identity); await close();
  const layout = currentLayout(), original = globalThis.fetch;
  const started = Promise.withResolvers<void>(), pending = Promise.withResolvers<Response>(); let held = false;
  let finish: (() => Promise<void>) | undefined;
  globalThis.fetch = async (input, init) => {
    if (!held && init?.method === 'PUT' && new URL(String(input), 'http://ui.test').pathname.endsWith('/selection')) {
      held = true; finish = async () => {pending.resolve(await original(input, init));}; started.resolve(); return pending.promise;
    }
    return original(input, init);
  };
  t.after(async () => {globalThis.fetch = original; await finish?.(); await app.selectionQueue.drain();});
  app.applyLayout(closeTab(layout, `agent:${identity}`)); await started.promise;
  app.applyLayout(layout); await finish?.(); await app.selectionQueue.drain(); await settle();
  assert.equal(editor.isConnected, true);
  app.applyLayout(closeTab(currentLayout(), `agent:${identity}`));
  await app.selectionQueue.drain(); await settle(); assert.equal(editor.isConnected, false);
});

test('retained Message editors share the existing capacity and explicit tab disposal releases a slot', async () => {
  const editors: HostNode[] = [], workspace = 'retention-capacity';
  for (let index = 0; index < LIMITS.conversationTabs - 1; index++) {
    const identity = `capacity-owner-${index}`; await seed(workspace, [identity]);
    editors.push(await open(identity)); await close();
  }
  assert.equal(app.stableViews().host.querySelectorAll('.conversation').length, LIMITS.conversationTabs);
  await seed(workspace, ['capacity-overflow']); messageAction('capacity-overflow').click(); await settle();
  assert.equal(byId('agent-message-panel').hidden, true);
  assert.equal(app.stableViews().host.querySelectorAll('.conversation').length, LIMITS.conversationTabs);
  assert.ok(editors.every(editor => editor.isConnected));
  await seed(workspace, ['capacity-owner-0'], '', true);
  app.applyLayout(closeTab(currentLayout(), 'agent:capacity-owner-0'));
  await app.selectionQueue.drain(); await settle();
  assert.equal(editors[0]?.isConnected, false); assert.equal(editors[1]?.isConnected, true);
  await seed(workspace, ['capacity-overflow']); assert.ok(await open('capacity-overflow')); await close();
  assert.equal(app.stableViews().host.querySelectorAll('.conversation').length, LIMITS.conversationTabs);
});
