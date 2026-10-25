import assert from 'node:assert/strict';
import test from 'node:test';
import {startedAtFromPath} from './operator-activity.ts';

test('a saved file name carries its start time', () => {
  assert.equal(startedAtFromPath('/fixtures/agent/sessions/--x--/2026-10-24T05-00-00-123Z_abc.jsonl'), Date.parse('2026-10-24T05:00:00.123Z'));
  assert.equal(startedAtFromPath('/tmp/notes.jsonl'), undefined); assert.equal(startedAtFromPath(undefined), undefined);
});
