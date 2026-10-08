#!/usr/bin/env -S node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Executable RPC fixture used by browser and process-boundary regression tests. */
const args = process.argv.slice(2);
let sessionFile = args.includes('--session') ? String(args[args.indexOf('--session') + 1]) : resolve(process.cwd(), 'fixture-session.jsonl');
let sessionId = randomUUID();
let entries: Record<string, unknown>[] = [];
let leafId: string | null = null;
let running = false;
let level = 'high';
let sessionName = 'Fixture session';
let model = { provider: 'acceptance-fixture', id: 'test', name: 'Fixture', reasoning: true, input: ['text'] };
let dialogId: string | undefined;
let serial = Promise.resolve();
let timestamp = 1;
async function emit(value: unknown): Promise<void> {
  await new Promise<void>((done) => process.stdout.write(`${JSON.stringify(value)}\n`, () => done()));
}
async function response(record: Record<string, unknown>, data?: unknown): Promise<void> {
  await emit({ type: 'response', id: record.id, command: record.type, success: true, ...(data === undefined ? {} : { data }) });
}
async function append(message: unknown): Promise<void> {
  const id = randomUUID(); entries.push({ type: 'message', id, parentId: leafId, timestamp: new Date().toISOString(), message }); leafId = id;
  await writeFile(sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd: process.cwd() })}\n${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
}
async function finish(): Promise<void> {
  if (!running) return;
  dialogId = undefined; running = false;
  const final = { role: 'assistant', timestamp: timestamp++, content: [{ type: 'text', text: 'Fixture work completed.' }], stopReason: 'stop' };
  await emit({ type: 'message_start', message: final }); await emit({ type: 'message_end', message: final }); await append(final);
  await emit({ type: 'agent_end', messages: [final], willRetry: false }); await emit({ type: 'agent_settled', aborted: false });
}
try {
  if (args.includes('--session')) {
    const lines = (await readFile(sessionFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    sessionId = lines[0]?.id ?? sessionId; entries = lines.slice(1); leafId = entries.at(-1)?.id as string ?? null;
  }
} catch { /* An empty fixture has no retained messages. */ }
async function command(record: Record<string, unknown>): Promise<void> {
  switch (record.type) {
    case 'get_state': await response(record, { sessionId, sessionFile, sessionName, model, thinkingLevel: level, isStreaming: running, isCompacting: false, pendingMessageCount: 0 }); return;
    case 'get_entries': {
      const since = record.since === undefined ? -1 : entries.findIndex(entry => entry.id === record.since);
      if (record.since !== undefined && since < 0) { await emit({type: 'response', id: record.id, command: 'get_entries', success: false, error: 'Entry not found.'}); return; }
      await response(record, {entries: entries.slice(since + 1), leafId}); return;
    }
    case 'get_session_stats': await response(record, { tokens: { input: entries.length * 10, output: entries.length * 5, cacheRead: 0, cacheWrite: 0, total: entries.length * 15 }, cost: 0, contextUsage: { tokens: entries.length * 15, contextWindow: 128000, percent: entries.length * 15 / 128000 * 100 } }); return;
    case 'get_commands': await response(record, { commands: [{ name: 'fixture', description: 'Run deterministic fixture output', source: 'extension' }] }); return;
    case 'get_available_models': await response(record, { models: [model, { ...model, id: 'alternate', name: 'Alternate fixture' }] }); return;
    case 'get_available_thinking_levels': await response(record, { levels: ['off', 'high'] }); return;
    case 'set_model': model = { ...model, id: String(record.modelId), provider: String(record.provider) }; await response(record, model); return;
    case 'set_thinking_level': level = String(record.level); await emit({ type: 'thinking_level_changed', level }); await response(record); return;
    case 'set_session_name': sessionName = String(record.name); await response(record); return;
    case 'clear_queue': await response(record, { steering: [], followUp: [] }); return;
    case 'abort': await finish(); await response(record); return;
    case 'new_session': case 'fork': sessionId = randomUUID(); sessionFile = resolve(process.cwd(), `fixture-${sessionId}.jsonl`); entries = []; leafId = null; await response(record, { cancelled: false }); return;
    case 'switch_session': sessionFile = String(record.sessionPath); await response(record, { cancelled: false }); return;
    case 'compact': await emit({ type: 'compaction_start', reason: 'manual' }); await emit({ type: 'compaction_end', reason: 'manual', aborted: false }); await response(record, {}); return;
    case 'extension_ui_response': if (record.id === dialogId) await finish(); return;
    case 'prompt': {
      if (record.message === '/fixture handled') { await response(record, { disposition: 'handled' }); return; }
      if (running) { await response(record, { disposition: 'queued' }); return; }
      running = true; await response(record, { disposition: 'started' }); await emit({ type: 'agent_start' });
      const user = { role: 'user', timestamp: timestamp++, content: String(record.message) };
      await emit({ type: 'message_start', message: user }); await emit({ type: 'message_end', message: user }); await append(user);
      const assistant = { role: 'assistant', timestamp: timestamp++, content: [], stopReason: 'pending' };
      await emit({ type: 'message_start', message: assistant });
      await emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
      await emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'The fixture uses no provider.' } });
      await emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } });
      await emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Text, tool output, and a dialog follow.' } });
      const final = { ...assistant, stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'The fixture uses no provider.' }, { type: 'text', text: 'Text, tool output, and a dialog follow.' }, { type: 'toolCall', id: 'fixture-read', name: 'read', arguments: { path: 'example.txt' } }] };
      await emit({ type: 'message_end', message: final }); await append(final);
      await emit({ type: 'tool_execution_start', toolCallId: 'fixture-read', toolName: 'read', args: { path: 'example.txt' } });
      await emit({ type: 'tool_execution_update', toolCallId: 'fixture-read', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'Partial fixture output' }] } });
      const result = { role: 'toolResult', timestamp: timestamp++, toolCallId: 'fixture-read', toolName: 'read', content: [{ type: 'text', text: 'Fixture file content\nSecond line' }], isError: false };
      await emit({ type: 'tool_execution_end', toolCallId: 'fixture-read', toolName: 'read', result, isError: false, durationMs: 1 });
      await emit({ type: 'message_start', message: result }); await emit({ type: 'message_end', message: result }); await append(result);
      await emit({ type: 'entry_appended', entry: { id: randomUUID(), type: 'custom', data: { message: 'Generic fixture entry', values: [1, true] } } });
      if (String(record.message).includes('no-dialog')) { await finish(); return; }
      dialogId = randomUUID(); await emit({ type: 'extension_ui_request', id: dialogId, method: 'confirm', title: 'Fixture confirmation', message: 'Finish this deterministic fixture?' }); return;
    }
    default: await response(record); return;
  }
}
const decoder = new StringDecoder('utf8');
let input = '';
process.stdin.on('data', (bytes) => {
  input += decoder.write(bytes);
  for (;;) {
    const lf = input.indexOf('\n'); if (lf < 0) break;
    const line = input.slice(0, lf); input = input.slice(lf + 1);
    serial = serial.then(() => command(JSON.parse(line))).catch(() => emit({ type: 'extension_error', error: 'Fixture command failed.' }));
  }
});
process.stdin.on('end', () => { void serial.then(() => process.stdout.end()); });
