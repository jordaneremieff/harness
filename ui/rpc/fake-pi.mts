#!/usr/bin/env -S node
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
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
let model = { provider: 'acceptance-fixture', id: 'test', name: 'Fixture', reasoning: true, input: ['text', 'image'] };
const queue = {steering: [] as string[], followUp: [] as string[]};
let dialogId: string | undefined;
let serial = Promise.resolve();
let timestamp = 1;
let recoveryPhase = 0;
let recoveryMessage: Record<string, unknown> | undefined;
const commandEvidence: string[] = []; let evidenceOverflow = false;
async function saveCommandEvidence(): Promise<void> {
  if (!recoveryPhase) return;
  const file = resolve(process.cwd(), 'owner-recovery-commands.json');
  await writeFile(`${file}.pending`, JSON.stringify({pid: process.pid, sessionId, commands: commandEvidence, overflow: evidenceOverflow}));
  await rename(`${file}.pending`, file);
}
async function recordCommand(record: Record<string, unknown>): Promise<void> {
  if (commandEvidence.length < 256 && typeof record.type === 'string' && record.type.length <= 64) commandEvidence.push(record.type);
  else evidenceOverflow = true;
  await saveCommandEvidence();
}
async function recoveryDialog(): Promise<void> {
  dialogId = randomUUID(); await emit({type: 'extension_ui_request', id: dialogId, method: 'confirm', title: 'Owner recovery fixture', message: recoveryPhase === 1 ? 'Advance partial text?' : 'Inject the unmatched response?'});
}
async function advanceRecovery(): Promise<void> {
  recoveryPhase++;
  await saveCommandEvidence();
  if (recoveryPhase === 2) {
    await emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta: ' after'}});
    await recoveryDialog();
  } else {
    dialogId = undefined;
    await emit({type: 'response', id: 'owner-recovery-unmatched', command: 'get_state', success: true, data: {}});
  }
}
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
  const final = recoveryMessage ? {...recoveryMessage, content: [{type: 'text', text: recoveryPhase >= 2 ? 'before after' : 'before'}], stopReason: 'stop'} : { role: 'assistant', timestamp: timestamp++, content: [{ type: 'text', text: 'Fixture work completed.' }], stopReason: 'stop' };
  if (!recoveryMessage) await emit({ type: 'message_start', message: final });
  await emit({ type: 'message_end', message: final }); await append(final);
  await emit({ type: 'agent_end', messages: [final], willRetry: false }); await emit({ type: 'agent_settled', aborted: false });
  recoveryMessage = undefined; recoveryPhase = 0;
}
try {
  if (args.includes('--session')) {
    const lines = (await readFile(sessionFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    sessionId = lines[0]?.id ?? sessionId; entries = lines.slice(1); leafId = entries.at(-1)?.id as string ?? null;
  }
} catch { /* An empty fixture has no retained messages. */ }
async function prompt(record: Record<string, unknown>): Promise<void> {
  const images = Array.isArray(record.images) ? record.images as {type: string; mimeType: string; data: string}[] : [];
  if (images.length) await emit({type: 'extension_ui_request', id: randomUUID(), method: 'notify', message: JSON.stringify({count: images.length, images: images.map(image => ({mimeType: image.mimeType, digest: createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex')}))}), notifyType: 'info'});
  if (record.message === '/fixture handled' || record.message === 'handled-images') { await response(record, { disposition: 'handled' }); return; }
  if (running) { (record.streamingBehavior === 'followUp' ? queue.followUp : queue.steering).push(String(record.message)); await response(record, { disposition: 'queued' }); return; }
  running = true; await response(record, { disposition: 'started' }); await emit({ type: 'agent_start' });
  const user = { role: 'user', timestamp: timestamp++, content: images.length ? [...(record.message ? [{type: 'text', text: String(record.message)}] : []), ...images] : String(record.message) };
  await emit({ type: 'message_start', message: user }); await emit({ type: 'message_end', message: user }); await append(user);
  const assistant = { role: 'assistant', timestamp: timestamp++, content: [], stopReason: 'pending' };
  await emit({ type: 'message_start', message: assistant });
  if (record.message === '/fixture owner-recovery') {
    recoveryPhase = 1; recoveryMessage = assistant; await saveCommandEvidence();
    await emit({type: 'message_update', assistantMessageEvent: {type: 'text_start', contentIndex: 0}});
    await emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta: 'before'}});
    await recoveryDialog(); return;
  }
  if (record.message === '/fixture stream') {
    await emit({type: 'message_update', assistantMessageEvent: {type: 'text_start', contentIndex: 0}});
    await new Promise<void>((done, reject) => {
      let frames = 0;
      const timer = setInterval(() => {
        void emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta: `${Date.now()}\n`}}).catch(error => { clearInterval(timer); reject(error); });
        if (++frames === 300) { clearInterval(timer); done(); }
      }, 10);
    });
    await finish(); return;
  }
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
async function command(record: Record<string, unknown>): Promise<void> {
  switch (record.type) {
    case 'get_state': await response(record, { sessionId, sessionFile, sessionName, model, thinkingLevel: level, isStreaming: running, isCompacting: false, pendingMessageCount: queue.steering.length + queue.followUp.length }); return;
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
    case 'clear_queue': await response(record, {steering: queue.steering.splice(0), followUp: queue.followUp.splice(0)}); return;
    case 'abort': await finish(); await response(record); return;
    case 'new_session': case 'fork': sessionId = randomUUID(); sessionFile = resolve(process.cwd(), `fixture-${sessionId}.jsonl`); entries = []; leafId = null; await response(record, { cancelled: false }); return;
    case 'switch_session': sessionFile = String(record.sessionPath); await response(record, { cancelled: false }); return;
    case 'compact': await emit({ type: 'compaction_start', reason: 'manual' }); await emit({ type: 'compaction_end', reason: 'manual', aborted: false }); await response(record, {}); return;
    case 'extension_ui_response':
      if (record.id === dialogId) {if ((recoveryPhase === 1 || recoveryPhase === 2) && record.confirmed === true) await advanceRecovery(); else await finish();} return;
    case 'prompt': await prompt(record); return;
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
    serial = serial.then(async () => {const record = JSON.parse(line); await recordCommand(record); await command(record);}).catch(() => emit({ type: 'extension_error', error: 'Fixture command failed.' }));
  }
});
process.stdin.on('end', () => { void serial.then(() => process.stdout.end()); });
