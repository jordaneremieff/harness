import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventProjection, model } from './events.mts';

test('unchanged owner wire messages supply actual activity without new owner fields',()=>{
  const {projection}=create();
  const saved={role:'user',timestamp:100,content:'A real prompt'};
  projection.snapshot({entries:[{id:'u',parentId:null,type:'message',timestamp:new Date(100).toISOString(),message:saved}],leafId:'u'});
  assert.equal(projection.view.lastUserAt,100);assert.equal(projection.view.hasMessages,true);
  for(const [timestamp,stopReason,content] of [[200,'toolUse',[{type:'text',text:'I will use a tool'},{type:'toolCall',id:'t',name:'read',arguments:{}}]],[300,'stop',[{type:'thinking',thinking:'not an answer'}]],[400,'error',[{type:'text',text:'failed'}]],[500,'stop',[{type:'text',text:'The actual answer'}]]] as const){
    projection.reduce({type:'message_start',message:{role:'assistant',timestamp,content:[]}});
    projection.reduce({type:'message_end',message:{role:'assistant',timestamp,stopReason,content}});
    assert.equal(projection.view.lastAnswerAt,timestamp===500?500:undefined);
  }
  projection.reduce({type:'agent_settled'});assert.equal(projection.view.lastAnswerAt,500);
  projection.reset();assert.equal(projection.view.lastUserAt,undefined);assert.equal(projection.view.lastAnswerAt,undefined);assert.equal(projection.view.hasMessages,false);
});

test('model resources retain exact supported thinking levels from Pi capability maps',()=> {
  const base={provider:'fixture',id:'model',name:'Fixture',reasoning:true,input:['text']};
  assert.deepEqual(model(base).thinkingLevels,['off','minimal','low','medium','high']);
  assert.deepEqual(model({...base,thinkingLevelMap:{off:null,minimal:null,xhigh:'extra',max:'maximum'}}).thinkingLevels,['low','medium','high','xhigh','max']);
  assert.deepEqual(model({...base,reasoning:false}).thinkingLevels,['off']);
  assert.throws(()=>model({...base,thinkingLevelMap:{max:{invalid:true}}}),/thinking map/);
});
import type { EventData, EventName, PrimaryView } from '../shared/api.ts';

function create() {
  const view: PrimaryView = { key: 'primary', cwd: '', epoch: 1, lifecycle: 'ready', activity: 'idle', pendingDialogs: [], pendingOperationIds: [], capabilities: {} };
  const emitted: {name: EventName; data: EventData[EventName]}[] = [];
  const projection = new EventProjection(view, (name, _target, data) => emitted.push({name, data: structuredClone(data)}), () => {});
  return { projection, emitted };
}
test('ordinary retry facts survive state snapshots and clear at exact run boundaries', () => {
  const {projection, emitted} = create();
  const start = {type: 'auto_retry_start', attempt: 2, maxAttempts: 9, delayMs: 60000, errorMessage: 'fetch failed'};
  const before = Date.now(); projection.reduce(start);
  assert.equal(projection.view.activity, 'retrying'); assert.equal(projection.view.retry?.attempt, 2);
  assert.equal(projection.view.retry?.maxAttempts, 9); assert.ok((projection.view.retry?.at ?? 0) >= before + 60000);
  const state = emitted.findLast(event => event.name === 'primary.state'); assert.ok(state); assert.deepEqual((state.data as PrimaryView).retry, projection.view.retry);
  projection.reduce({type: 'agent_start'}); assert.equal(projection.view.retry, undefined); assert.equal(projection.view.responseOutcome, undefined);
  projection.reduce(start); projection.reduce({type: 'auto_retry_end', success: false, attempt: 9, finalError: 'opaque diagnostic'});
  assert.equal(projection.view.retry, undefined); assert.equal(projection.view.responseOutcome, 'failed');
  projection.reduce({type: 'agent_settled', aborted: true}); assert.equal(projection.view.responseOutcome, 'stopped');
  projection.reduce(start); projection.reduce({type: 'auto_retry_end', success: true, attempt: 2});
  assert.equal(projection.view.retry, undefined); assert.equal(projection.view.responseOutcome, undefined);
  projection.reduce(start); projection.reset(); assert.equal(projection.view.retry, undefined); assert.equal(projection.view.responseOutcome, undefined);
});
test('retry cancellation identity expires at new attempts and lifecycle resets', () => {
  for (const boundary of ['attempt', 'retry', 'reset', 'close'] as const) {
    const {projection} = create(); const start = {type: 'auto_retry_start', attempt: 1, maxAttempts: 4, delayMs: 1000};
    projection.reduce(start); const captured = projection.captureRetry(); assert.notEqual(captured, undefined);
    if (boundary === 'attempt') projection.reduce({type: 'agent_start'});
    if (boundary === 'retry') projection.reduce({...start, attempt: 2});
    if (boundary === 'reset') projection.reset();
    if (boundary === 'close') projection.clearRetry();
    projection.confirmRetryAbort(captured); projection.reduce({type: 'auto_retry_end', success: false, attempt: 1});
    assert.equal(projection.view.responseOutcome, 'failed');
  }
});
test('successful retry ends never become stopped after an old cancellation reply', () => {
  const {projection} = create(); projection.reduce({type: 'auto_retry_start', attempt: 1, maxAttempts: 4, delayMs: 1000});
  const captured = projection.captureRetry(); projection.reduce({type: 'auto_retry_end', success: true, attempt: 1});
  projection.confirmRetryAbort(captured); assert.equal(projection.view.responseOutcome, undefined);
});
test('assistant stop reasons own response outcome without classifying diagnostic text', () => {
  const {projection} = create();
  for (const [stopReason, expected] of [['error', 'failed'], ['aborted', 'stopped'], ['stop', undefined]] as const) {
    projection.reduce({type: 'message_start', message: {role: 'assistant', timestamp: 1, content: []}});
    projection.reduce({type: 'message_end', message: {role: 'assistant', timestamp: 1, content: [], stopReason, errorMessage: 'arbitrary unclassified text'}});
    assert.equal(projection.view.responseOutcome, expected);
  }
});
test('live and saved peer messages preserve the same communication value through RPC projection', () => {
  const raw = {role: 'custom', customType: 'agent.peer', timestamp: 1700000000000, content: 'Transport', details: {kind: 'report', senderIdentity: '10000000-0000-4000-8000-000000000001', message: 'Contribution', reportSourceId: 'source', requestId: 'request'}};
  const {projection} = create(); projection.reduce({type: 'message_start', message: raw}); projection.reduce({type: 'message_end', message: raw});
  const first = projection.messages[0]?.communication; assert.equal(first?.state, 'ready');
  projection.snapshot({entries: [{id: 'saved-peer', parentId: null, type: 'message', timestamp: new Date(raw.timestamp).toISOString(), message: {...raw, timestamp: undefined}}], leafId: 'saved-peer'});
  const saved = projection.messages[0]?.communication; assert.equal(saved?.state, 'ready');
  if (first?.state === 'ready' && saved?.state === 'ready') { assert.deepEqual(saved.value, first.value); assert.equal(saved.origin.kind, 'ordinary-custom'); if (saved.origin.kind === 'ordinary-custom') assert.equal(saved.origin.sourceEntryId, 'saved-peer'); }
});
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
test('complete structured text reaches live tool events and cached result messages', () => {
  const {projection, emitted} = create(); const body = `# Document\n${'retained content\n'.repeat(600)}`;
  const text = JSON.stringify({body});
  projection.reduce({type: 'tool_execution_end', toolCallId: 'structured', toolName: 'generic',
    result: {content: [{type: 'text', text}], details: {body: 'private-details'}, structuredContent: {body: 'untrusted-native-shape'}}});
  const event = emitted.find(item => item.name === 'primary.tool')?.data as EventData['primary.tool'];
  const part = event.parts?.[0]; assert.ok(part?.type === 'text'); assert.equal(part.text, text);
  assert.ok(part.structured); assert.ok((part.structured.value as {body: string}).body === body);
  const result = projection.messages[0]?.parts[0]; assert.ok(result?.type === 'toolResult');
  const cached = result.parts[0]; assert.ok(cached?.type === 'text'); assert.ok(JSON.stringify(cached.structured) === JSON.stringify(part.structured));
  assert.doesNotMatch(JSON.stringify(emitted), /private-details|untrusted-native-shape/);
});
test('live tool result facts reach both the tool event and cached message without generic details', () => {
  const {projection, emitted} = create();
  projection.reduce({type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash', isError: false,
    result: {content: [{type: 'text', text: 'tail'}], details: {truncation: {truncated: true, truncatedBy: 'bytes', outputBytes: 4, totalBytes: 200, content: 'private'},
      fullOutputPath: '/retained/output.txt', credentials: 'never display'}}});
  const tool = emitted.find(event => event.name === 'primary.tool')?.data as EventData['primary.tool']; assert.ok(tool);
  assert.deepEqual(tool.output, {truncation: {truncated: true, truncatedBy: 'bytes', outputBytes: 4, totalBytes: 200}, fullOutputPath: '/retained/output.txt'});
  assert.deepEqual(tool.parts, [{type: 'text', text: 'tail'}]);
  const part = projection.messages[0]?.parts[0]; assert.ok(part?.type === 'toolResult'); assert.deepEqual(part.output, tool.output);
  assert.doesNotMatch(JSON.stringify(emitted), /private|never display|credentials/);
});
test('a sent image in a saved or newly committed user message keeps the exact entry source for its bytes', () => {
  const image = {type: 'image', mimeType: 'image/png', digest: 'a'.repeat(64), bytes: 1024, width: 96, height: 64};
  const message = {role: 'user', timestamp: 1700000000000, content: [{type: 'text', text: 'Describe this'}, image]};
  const sourceOf = (value: ReturnType<typeof create>['projection']) => {
    const part = value.messages[0]?.parts.find(item => item.type === 'image'); return part?.type === 'image' ? part.source : undefined;
  };
  const saved = create().projection; saved.snapshot({entries: [{id: 'saved-user', parentId: null, type: 'message', message}], leafId: 'saved-user'});
  assert.deepEqual(sourceOf(saved), {entryId: 'saved-user', message: 0, part: 1});
  const live = create().projection;
  live.reduce({type: 'message_start', message}); live.reduce({type: 'message_end', message}); assert.equal(sourceOf(live), undefined);
  live.reduce({type: 'entry_appended', entry: {id: 'committed-user', parentId: null, type: 'message', message}});
  assert.deepEqual(sourceOf(live), {entryId: 'committed-user', message: 0, part: 1});
});
