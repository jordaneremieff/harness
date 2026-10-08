import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventProjection } from './events.mts';
import type { EventData, EventName, PrimaryView } from '../shared/api.ts';

function create() {
  const view: PrimaryView = { key: 'primary', cwd: '', epoch: 1, lifecycle: 'ready', activity: 'idle', pendingDialogs: [], pendingOperationIds: [], capabilities: {} };
  const emitted: {name: EventName; data: EventData[EventName]}[] = [];
  const projection = new EventProjection(view, (name, _target, data) => emitted.push({name, data: structuredClone(data)}), () => {});
  return { projection, emitted };
}
test('messages with identical role and timestamp retain distinct stable IDs', () => {
  const { projection } = create();
  for (const word of ['first', 'second']) {
    projection.reduce({ type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [] } });
    projection.reduce({ type: 'message_end', message: { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: word }] } });
  }
  const ids = projection.messages.map((m) => m.id); assert.equal(new Set(ids).size, 2);
  projection.snapshot({ entries: ['first', 'second'].map((word, i) => ({ type: 'message', id: word, parentId: i ? 'first' : null,
    message: { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: word }] } })), leafId: 'second' });
  assert.deepEqual(projection.messages.map((m) => m.id), ids);
});
test('streamed display text and emitted delta records stay bounded at Unicode boundaries', () => {
  const { projection, emitted } = create();
  projection.reduce({ type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [] } });
  for (const delta of ['雪'.repeat(30_000), 'later text']) projection.reduce({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } });
  for (const event of emitted) { assert.ok(Buffer.byteLength(JSON.stringify(event.data)) < 256 * 1024); assert.equal(JSON.stringify(event.data).includes('\ufffd'), false); }
  assert.equal(projection.messages[0]?.coverage.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(projection.messages[0])) <= 60 * 1024);
});
test('tool updates occupy one cached result slot until authoritative result message', () => {
  const { projection, emitted } = create();
  for (const phase of ['update', 'end']) projection.reduce({ type: `tool_execution_${phase}`, toolCallId: 'call', toolName: 'read', result: { content: [{ type: 'text', text: phase }] }, partialResult: { content: [{ type: 'text', text: phase }] } });
  const raw = { role: 'toolResult', toolCallId: 'call', toolName: 'read', timestamp: 1, content: [{ type: 'text', text: 'final' }] };
  projection.reduce({ type: 'message_start', message: raw }); projection.reduce({ type: 'message_end', message: raw });
  const tools = emitted.filter((event) => event.name === 'primary.tool').map((event) => event.data as EventData['primary.tool']);
  assert.deepEqual(tools[1]?.parts, [{ type: 'text', text: 'end' }]);
  assert.equal(projection.messages.length, 1); assert.equal(projection.messages[0]?.id, 'tool:call'); assert.equal(projection.messages[0]?.state, 'final');
});
