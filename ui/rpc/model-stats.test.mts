import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import type { PrimaryView } from '../shared/api.ts';
import { FakeChild } from './fake-child.mts';
import { PrimarySession } from './session.mts';

test('model acknowledgment invalidates old statistics before metadata and refreshes reported context afterward', async () => {
  const child = new FakeChild(); const signals = new EventEmitter(); let changedModel = false;
  const alternate = { provider: 'acceptance-fixture', id: 'alternate', name: 'Alternate fixture', reasoning: true, input: ['text'] };
  const sample = { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0, contextUsage: { tokens: 10, contextWindow: 1000, percent: 1 } };
  child.onCommand = (record) => {
    if (record.type === 'get_session_stats') signals.emit('request', record);
    else if (record.type === 'set_model') { changedModel = true; child.response(record, alternate); }
    else if (record.type === 'get_available_thinking_levels' && changedModel) signals.emit('levels', record);
    else if (record.type === 'get_state' && changedModel) child.response(record, { sessionId: 'fixture', isStreaming: false, isCompacting: false, model: alternate });
    else child.defaults(record);
  };
  const session = new PrimarySession({ key: 'key', executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn,
    publish: (name, _target, data) => { if (name === 'primary.state' && (data as PrimaryView).usage) signals.emit('applied'); } });
  await session.start(); const initial = await child.command('get_session_stats');
  const initialApplied = once(signals, 'applied'); child.response(initial, sample); await initialApplied;
  const oldRequest = once(signals, 'request'); child.event({ type: 'agent_settled' }); const [old] = await oldRequest;
  const levels = once(signals, 'levels'); const control = session.control({ epoch: 1, action: 'model', provider: alternate.provider, modelId: alternate.id });
  const [heldLevels] = await levels; assert.equal(session.view.contextUsage, undefined); assert.equal(session.view.usage, undefined);
  assert.equal(session.view.capabilities.input, true); child.response(old, sample); await session.client.request('get_commands');
  assert.equal(session.view.contextUsage, undefined); assert.equal(session.view.usage, undefined);
  const freshRequest = once(signals, 'request'); child.response(heldLevels, { levels: ['off', 'high'] }); await control; const [fresh] = await freshRequest;
  assert.equal(session.view.model?.id, 'alternate'); assert.equal(session.view.contextUsage, undefined);
  const applied = once(signals, 'applied'); child.response(fresh, { ...sample, contextUsage: { tokens: 20, contextWindow: 2000, percent: 1 } }); await applied;
  assert.equal((session.view as PrimaryView).contextUsage?.contextWindow, 2000); assert.equal(session.view.capabilities.input, true);
  assert.equal(child.writes.filter((record) => record.type === 'get_session_stats').length, 3); await session.close();
});
