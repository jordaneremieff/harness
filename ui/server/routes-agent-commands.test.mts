import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {AgentError} from '../agents/index.mts';
import type {CommandInput, CommandResult, HostInventory} from '../agents/index.mts';
import {STORAGE} from '../agents/fake-host.mts';
import {COMMAND_RESULT_BYTES} from '../shared/api.ts';
import type {OperationView, Target} from '../shared/api.ts';
import {boundCommandResult, projectCommandList} from './agent-commands.mts';
import {ApiError} from './errors.mts';
import type {RequestContext} from './http.mts';
import {Operations} from './operations.mts';
import type {Registry} from './registry.mts';
import {dispatchAgent} from './routes-agent.mts';
import {StateStore} from './state.mts';

const inventory = (): HostInventory => ({contributions: [
  {name: 'alpha', source: 'alpha.ts', commands: [{name: 'ping', description: 'Reply with pong'}, {name: 'tree', description: 'Reserved'}, {name: 'reload', description: 'Reserved'}]},
  {name: 'beta', source: 'beta.ts', commands: [{name: 'ping', description: 'Repeat'}, {name: 'status', description: 'Show\u0007 status'}, {name: 'bad name', description: 'Skipped'}]}],
  ordinaryOnly: ['plain']});

async function harness(t: TestContext, agents: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'ui-agent-commands-')); const store = await StateStore.open(root);
  t.after(async () => {await store.close(); await rm(root, {recursive: true, force: true});});
  const operations = new Operations(store), workspaceId = (await store.workspace()).id;
  const registry = {store, operations, options: {}, workspace: async () => workspaceId, agents} as unknown as Registry;
  const target: Target = {kind: 'agent', identity: STORAGE};
  const run = async (body: unknown, id?: string): Promise<OperationView> => {
    const operation = id ?? (await operations.reserve(workspaceId, 'agent.command', target)).id;
    const context: RequestContext = {parts: ['api', 'agents', STORAGE, 'command'], body: body as Record<string, unknown>, method: 'POST', url: new URL('http://localhost/api'), workspace: workspaceId, operationId: operation};
    return await dispatchAgent(registry, context) as OperationView;
  };
  const list = (query = '', identity = STORAGE) => dispatchAgent(registry, {parts: ['api', 'agents', identity, 'commands'], body: {}, method: 'GET', url: new URL(`http://localhost/api${query}`)});
  return {registry, operations, workspaceId, target, run, list};
}

test('the command list flattens the host inventory, leaves reserved and unsendable names out and names each source', () => {
  const list = projectCommandList(inventory());
  assert.deepEqual(list.items.map(item => [item.name, item.source]), [['ping', 'alpha'], ['status', 'beta']]);
  assert.equal(list.items[1]?.description, 'Show status');
  assert.equal(list.incomplete, true, 'a skipped name marks the list incomplete');
  const clean = projectCommandList({contributions: [{name: 'a', source: 'a.ts', commands: [{name: 'one', description: ''}]}], ordinaryOnly: []});
  assert.deepEqual(clean, {items: [{name: 'one', description: '', source: 'a'}], incomplete: false});
  assert.equal(projectCommandList({...inventory(), failed: [{path: '/x', error: 'boom'}]}).incomplete, true);
  const many = projectCommandList({contributions: [{name: 'a', source: 'a.ts', commands: Array.from({length: 600}, (_, index) => ({name: `c${index}`, description: ''}))}], ordinaryOnly: []});
  assert.equal(many.items.length, 512); assert.equal(many.incomplete, true);
});

test('a command result keeps its first 16 KiB on a character boundary and says when it was cut', () => {
  assert.deepEqual(boundCommandResult('short'), {text: 'short', truncated: false});
  const exact = boundCommandResult('x'.repeat(COMMAND_RESULT_BYTES)); assert.equal(exact.truncated, false);
  const cut = boundCommandResult('é'.repeat(COMMAND_RESULT_BYTES));
  assert.equal(cut.truncated, true); assert.equal(Buffer.byteLength(cut.text), COMMAND_RESULT_BYTES); assert.doesNotMatch(cut.text, /\uFFFD/);
  assert.equal(boundCommandResult('a Bearer abcdef123456 b').text, 'a Bearer [redacted] b');
});

test('the command list route reads the live host inventory and refuses other queries and identities', async t => {
  const calls: string[] = []; let failure: Error | undefined;
  const {list} = await harness(t, {inventory: async (identity: string) => {calls.push(identity); if (failure) throw failure; return inventory();}});
  const result = await list('?workspace=w') as {items: {name: string}[]; incomplete: boolean};
  assert.deepEqual(result.items.map(item => item.name), ['ping', 'status']); assert.deepEqual(calls, [STORAGE]);
  await assert.rejects(list('?limit=2'), {code: 'invalid_request'});
  await assert.rejects(list('', 'bad id'), {code: 'invalid_request'});
  assert.equal(calls.length, 1);
  failure = new AgentError('commands_unavailable', 'Host operation status is unavailable.');
  await assert.rejects(list(), (error: unknown) => error instanceof ApiError && error.code === 'commands_unavailable' && error.status === 501);
  failure = new AgentError('stored', 'Stored metadata; no live compatible host.');
  await assert.rejects(list(), error => error === failure);
});

test('a command runs once through the operation path and keeps a bounded result in its receipt', async t => {
  const calls: [string, CommandInput][] = [];
  const {run, operations} = await harness(t, {command: async (identity: string, input: CommandInput): Promise<CommandResult> => {calls.push([identity, input]); return {name: input.name, conversationId: 1, identity, text: 'é'.repeat(COMMAND_RESULT_BYTES)};}});
  const reserved = await operations.reserve((await operations.store.workspace()).id, 'agent.command', {kind: 'agent', identity: STORAGE});
  const first = await run({name: 'ping', args: 'one two'}, reserved.id);
  assert.equal(first.state, 'completed'); assert.equal(first.kind, 'agent.command');
  assert.equal(first.receipt?.kind, 'command');
  if (first.receipt?.kind !== 'command') return;
  assert.equal(first.receipt.name, 'ping'); assert.equal(first.receipt.truncated, true); assert.equal(Buffer.byteLength(first.receipt.text), COMMAND_RESULT_BYTES);
  assert.deepEqual(calls, [[STORAGE, {operationId: reserved.id, name: 'ping', args: 'one two'}]]);
  const again = await run({name: 'ping', args: 'one two'}, reserved.id);
  assert.equal(again.state, 'completed'); assert.equal(calls.length, 1, 'a repeated request with the same key never reaches the host again');
  await assert.rejects(run({name: 'ping', args: 'changed'}, reserved.id), {code: 'operation_conflict'});
  assert.equal(calls.length, 1);
});

test('a host refusal is a definite rejection with the host message and keeps no result', async t => {
  const {run} = await harness(t, {command: async () => {throw new AgentError('command_refused', 'durable command nope is not registered');}});
  const result = await run({name: 'nope'});
  assert.equal(result.state, 'rejected'); assert.equal(result.error?.code, 'command_refused'); assert.match(result.error?.message ?? '', /not registered/); assert.equal(result.receipt, undefined);
});

test('a lost connection or an unclassified failure leaves the outcome uncertain and the operation removable', async t => {
  for (const failure of [new AgentError('host_unavailable', 'Host connection lost. Remote admission is not known.', true), new AgentError('protocol_error', 'Invalid command response.', true), new Error('socket closed')]) {
    let calls = 0;
    const {run, operations} = await harness(t, {command: async () => {calls++; throw failure;}});
    const result = await run({name: 'ping'});
    assert.equal(result.state, 'uncertain', failure.message); assert.equal(calls, 1);
    assert.equal(result.error?.code, 'delivery_uncertain');
    await operations.remove(result.id);
    await assert.rejects(operations.get(result.id), {code: 'unknown_operation'});
  }
});

test('a request that names a reserved, malformed or extra field never reaches the host', async t => {
  let calls = 0;
  const {run} = await harness(t, {command: async () => {calls++; return {name: 'x', conversationId: 1, identity: STORAGE, text: ''};}});
  for (const body of [{name: 'tree', args: '1'}, {name: 'reload'}, {name: ''}, {name: 'has space'}, {name: '/ping'}, {args: 'x'}, {name: 'ping', args: 3}, {name: 'ping', extra: true}, {name: 'ping', args: 'x'.repeat(64 * 1024 + 1)}]) {
    await assert.rejects(run(body), error => error instanceof ApiError, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(calls, 0);
});
