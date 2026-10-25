import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {RpcError, type RpcClientOptions} from '../rpc/client.mts';
import {PrimarySession} from '../rpc/session.mts';
import type {PrimaryTransport} from '../rpc/transport.mts';
import type {OwnerBaseline, OwnerDescriptor} from '../shared/owner.ts';
import type {CatalogPage} from '../agents/index.mts';
import type {AgentAdapter} from './registry.mts';
import {startBackend} from './backend.mts';

const empty: CatalogPage = {rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false,
  scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}};
const forbidden = async (): Promise<never> => {throw new Error('No native agent work belongs in this fixture');};
const agents: AgentAdapter = {roster: () => empty, rosterRow: () => undefined, lookup: forbidden, imageInputAvailable: () => false,
  refresh: async () => empty.scan, prepare: forbidden, select: forbidden, reconnect: forbidden, history: forbidden,
  image: forbidden, inspect: forbidden, inventory: forbidden, command: forbidden, threads: forbidden, thread: forbidden, submit: forbidden, retrySubmit: forbidden, control: forbidden, abort: forbidden,
  configure: () => {throw new Error('No native agent configuration');}, hide: async () => {}, disconnectWorkspace: async () => {}, close: async () => {}};

/** The backend reads private-access settings from the machine document; a fixture must never inherit the operator's and bind the live private port. */
function isolateAgent(t: TestContext, root: string): void {
  const keys = ['PI_CODING_AGENT_DIR', 'PI_HARNESS_FILE', 'PI_UI_PRIVATE_ORIGIN', 'PI_UI_PRIVATE_OWNER_LOGIN', 'PI_UI_PRIVATE_PORT'];
  const previous = keys.map(key => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent'); process.env.PI_HARNESS_FILE = 'harness.json';
  for (const key of keys.slice(2)) delete process.env[key];
  t.after(() => keys.forEach((key, index) => {const value = previous[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value;}));
}

type Callbacks = Pick<RpcClientOptions, 'onEvent' | 'onExit' | 'onProtocolError'>;
const descriptor = (key: string, cwd: string): OwnerDescriptor => ({key, epoch: 1, cwd, executable: 'pi', recoveryWorkspaceId: 'workspace', pid: 4321, exited: false, available: true, synchronized: true, sequence: 1, stderr: '', recoveryPending: false});

/** An owner-held primary: the owner answers every capture, as it does for a live writer. */
class OwnedTransport implements PrimaryTransport {
  child = {pid: 4321}; exited = false; available = true; stderrTail = ''; pendingCount = 0; synchronized = true; captures = 0; callbacks: Callbacks = {};
  readonly key: string; readonly cwd: string;
  constructor(key: string, cwd: string) {this.key = key; this.cwd = cwd;}
  start() {}
  markSynchronized() {this.synchronized = true;}
  async request(type: string) {
    switch (type) {
      case 'get_state': return {sessionId: `session-${this.key}`, isStreaming: false, isCompacting: false, pendingMessageCount: 0};
      case 'get_commands': return {commands: []};
      case 'get_available_models': return {models: []};
      case 'get_available_thinking_levels': return {levels: []};
      case 'get_entries': return {entries: [], leafId: null};
      case 'get_session_stats': return {tokens: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}, cost: 0};
      default: return {};
    }
  }
  async requestPrepared(): Promise<unknown> {throw new Error('No prompt belongs in this fixture');}
  async sendUI() {}
  async close() {this.exited = true; this.callbacks.onExit?.();}
  async detach() {}
  async captureBegin() {this.captures++; return {token: `capture-${this.captures}`, from: 1};}
  async captureFinish(): Promise<OwnerBaseline> {return {descriptor: descriptor(this.key, this.cwd), from: 1, cursor: 1, complete: true, reasons: [], overlap: [], activeMessage: null, tools: [], state: [], dialogs: []};}
  async captureAck() {}
}

/** An open the owner refused: no descriptor ever arrives, so the transport never reports an exit, and the owner holds no primary to capture. */
class RefusedTransport implements PrimaryTransport {
  child = undefined; exited = false; available = false; stderrTail = ''; pendingCount = 0; synchronized = true; captures = 0; callbacks: Callbacks = {};
  async start() {throw new RpcError('capacity', 'The primary capacity is full.');}
  markSynchronized() {}
  async request(): Promise<unknown> {throw new RpcError('not_ready', 'The primary is not owned.');}
  async requestPrepared(): Promise<unknown> {throw new RpcError('not_ready', 'The primary is not owned.');}
  async sendUI() {}
  async close() {}
  async detach() {}
  async captureBegin(): Promise<{token: string; from: number}> {this.captures++; throw new RpcError('not_ready', 'The primary is not owned.');}
  async captureFinish(): Promise<OwnerBaseline> {throw new RpcError('not_ready', 'The primary is not owned.');}
  async captureAck() {}
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-release-drain-'));
  const cwd = join(root, 'project'); await mkdir(cwd); isolateAgent(t, root);
  const transports: (OwnedTransport | RefusedTransport)[] = [];
  const app = await startBackend({cwd, stateDir: join(root, 'state'), pi: 'unused', port: 0}, {
    assets: new Map([['/', {type: 'text/html', data: Buffer.from('<title>Fixture</title>')}]]), agents: () => agents,
    primary: options => {
      const transport = transports.length === 0 ? new OwnedTransport(options.key, cwd) : new RefusedTransport();
      transports.push(transport);
      return new PrimarySession({...options, attach: true, ownerIdentity: `owner:${options.key}:1`, transport: callbacks => {transport.callbacks = callbacks; return transport;}});
    },
  });
  // Shutdown treats an unavailable owner transport as already gone, so the fixture needs no queue or abort protocol.
  t.after(async () => {for (const transport of transports) transport.available = false; await app.close().catch(() => {}); await rm(root, {recursive: true, force: true});});
  return {app, cwd, transports};
}

test('a release drain captures only owner-held primaries and skips a session whose open the owner refused', async t => {
  const {app, cwd, transports} = await fixture(t);
  const {registry} = app; const workspace = await registry.store.workspace();
  const ready = await registry.openPrimary(cwd, undefined, workspace.id); await registry.waitPrimaryReady(ready);
  const refused = await registry.openPrimary(cwd, undefined, workspace.id);
  await assert.rejects(registry.waitPrimaryReady(refused), {code: 'capacity'});
  const [owned, denied] = transports as [OwnedTransport, RefusedTransport];
  const attached = owned.captures; assert.equal(attached, 1, 'attachment captured the live primary once');

  assert.throws(()=>registry.primary(refused),{code:'not_ready'});
  assert.equal((await registry.store.readPrimaries()).some(view=>view.key===refused),false);
  assert.equal(registry.primary(ready).view.lifecycle, 'ready');
  assert.deepEqual(registry.ownedSessions().map(session => session.view.key), [ready]);

  await app.prepareRelease();
  assert.equal(owned.captures, attached + 1, 'the drain captures the live primary once more');
  assert.equal(denied.captures, 0, 'no capture is requested for a primary the owner never held');
  app.cancelRelease();
});

test('a release drain still refuses when an owner-held primary cannot be reconstructed', async t => {
  const {app, cwd, transports} = await fixture(t);
  const {registry} = app; const workspace = await registry.store.workspace();
  const ready = await registry.openPrimary(cwd, undefined, workspace.id); await registry.waitPrimaryReady(ready);
  const [owned] = transports as [OwnedTransport];
  const attached = owned.captures;
  owned.captureFinish = async () => ({descriptor: descriptor(ready, cwd), from: 1, cursor: 1, complete: false, reasons: ['active-message-limit'], overlap: [], activeMessage: null, tools: [], state: [], dialogs: []});
  await assert.rejects(app.prepareRelease(), {code: 'history_limit'});
  assert.equal(owned.captures, attached + 1);
  app.cancelRelease();
});
