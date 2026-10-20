import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectedFrame } from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';
const {arrive, settle, byId, agentControl, agentFixture, targetFixture, entryFixture, messageFixture, textPart, observation, singlePane, coverage, transportLog} = await createAppFixture();

const loaded = '00000000-0000-4000-8000-000000000401', named = '00000000-0000-4000-8000-000000000402', firstOnly = '00000000-0000-4000-8000-000000000403';
const absent = '00000000-0000-4000-8000-000000000404', sender = '00000000-0000-4000-8000-000000000405';
const lookups = () => transportLog.filter(call => call.path.startsWith('/api/agents?identity='));

test('identities the roster pages do not hold are named once by the server, in the tab, the open row and the tool title', async () => {
  const tabs = [loaded, named, firstOnly, absent].map(identity => ({kind: 'agent' as const, identity}));
  const tool = entryFixture('sender-call', [messageFixture('sender-call-message', [{type: 'toolCall', callId: 'sender-call', name: 'custom', arguments: {value: {sessionId: sender}, truncated: false}}, {type: 'toolResult', callId: 'sender-call', name: 'custom', isError: false, parts: [textPart(`Supplied ${sender}`)]}])]);
  const frame: ProjectedFrame = {revision: 1, observedAt: '', live: [], entries: [tool], nextBefore: null, coverage, status: {busy: false}};
  transportLog.length = 0;
  await arrive({workspace: {id: 'identity-names', revision: 1, selectedTarget: tabs[0], conversationLayout: singlePane(tabs, `agent:${loaded}`)}, primaries: [],
    roster: [agentFixture(loaded, {name: 'Loaded name'})],
    catalog: [agentFixture(named, {name: 'Disposable readable thinking acceptance'}), agentFixture(firstOnly, {firstMessage: 'Check the release notes\nthen report'}), agentFixture(sender, {name: 'Web UI lead'})],
    targets: tabs.map(tab => targetFixture(`target-${tab.identity}`, tab)), observations: [observation(loaded, frame)]});
  await settle();

  const requests = lookups().map(call => new URL(call.path, 'http://ui.test').searchParams.getAll('identity'));
  assert.deepEqual(requests[0]?.slice().sort(), [named, firstOnly, absent].sort(), 'the tabs go in one batch');
  assert.deepEqual(requests.flat().sort(), [named, firstOnly, absent, sender].sort(), 'each identity is asked once and the loaded one never');

  const tabName = (identity: string) => byId('sidebar-conversations').querySelector(`[data-tab-key="agent:${identity}"] .conversation-name`)?.textContent;
  assert.equal(tabName(loaded), 'Loaded name');
  assert.equal(tabName(named), 'Disposable readable thinking acceptance');
  assert.equal(tabName(firstOnly), 'Check the release notes');
  assert.match(tabName(absent) ?? '', /^Unnamed/, 'an identity the catalog lacks keeps the fallback');
  const groups = [...byId('sidebar-conversations').querySelectorAll('.unnamed-conversations')];
  assert.equal(groups.some(group => group.querySelector(`[data-tab-key="agent:${named}"], [data-tab-key="agent:${firstOnly}"]`)), false, 'named rows are not grouped as unnamed');
  assert.equal(agentControl('transcript').querySelector('[data-entry-id="sender-call"] .tool-target')?.textContent, 'Web UI lead');

  await settle(); await settle();
  assert.equal(lookups().length, requests.length, 'a missing identity is not asked again without a roster refresh');
});
