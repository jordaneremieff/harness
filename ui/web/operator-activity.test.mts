import assert from 'node:assert/strict';
import test from 'node:test';
import {OperatorActivity, startedAtFromPath} from './operator-activity.ts';

const memoryStore = () => { const data = new Map<string, string>(); return {getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => {data.set(key, value);}}; };

test('the operator time of a session is the latest action on any of its identities', () => {
  const store = memoryStore(); let now = 1000;
  const activity = new OperatorActivity(store, () => now);
  assert.equal(activity.at(['path:/a', 'id:1']), undefined);
  activity.stamp(['path:/a', 'id:1']); now = 2000; activity.stamp(['path:/b']);
  assert.equal(activity.at(['id:1']), 1000); assert.equal(activity.at(['path:/b', 'id:1']), 2000);
  assert.equal(new OperatorActivity(store, () => now).at(['path:/a']), 1000, 'the record persists');
});

test('unreadable storage never blocks recording and the oldest records give way past the bound', () => {
  const broken = new OperatorActivity({getItem: () => '{broken', setItem: () => {throw new Error('full');}}, () => 5);
  broken.stamp(['path:/x']); assert.equal(broken.at(['path:/x']), 5);
  let now = 0; const store = memoryStore(); const many = new OperatorActivity(store, () => ++now);
  for (let index = 0; index < 600; index++) many.stamp([`path:/${index}`]);
  const reloaded = new OperatorActivity(store); assert.equal(reloaded.at(['path:/0']), undefined); assert.equal(reloaded.at(['path:/599']), 600);
});

test('a saved file name carries its start time', () => {
  assert.equal(startedAtFromPath('/fixtures/agent/sessions/--x--/2026-10-24T05-00-00-123Z_abc.jsonl'), Date.parse('2026-10-24T05:00:00.123Z'));
  assert.equal(startedAtFromPath('/tmp/notes.jsonl'), undefined); assert.equal(startedAtFromPath(undefined), undefined);
});
