import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn, execFileSync, type ChildProcess} from 'node:child_process';
import {createConnection} from 'node:net';
import {EventEmitter, once} from 'node:events';
import {mkdtemp,realpath,rm,mkdir,writeFile,chmod,lstat,opendir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createPrimaryOwner} from './primary-owner.mts';
import {OWNER_PROTOCOL} from '../shared/owner.ts';
import {connectTestOwner,ownerTurn} from './owner-test-fixture.mts';
import {PrimarySession} from '../rpc/session.mts';
import {FakeChild} from '../rpc/fake-child.mts';
import {RpcError} from '../rpc/client.mts';
import {RELEASE_FORMAT, BROWSER_API, type ReleaseManifest, type ReleaseStatus} from '../shared/release.ts';
import {LIMITS, type Bootstrap, type PrimaryView, type HistoryPage, type OperationView, type Target, type OperationKind, type EventEnvelope} from '../shared/api.ts';
import {readIdentity} from '../shared/version.ts';
import {manifestAt, inventory, assertSealedTree, releaseRoot, findRelease, readSelection, boundedFile, sha256, atomicJson, sealTree} from './release-store.mts';
import {requestReleaseControl, assertControlPath} from './release-control.mts';
const message={role:'assistant',timestamp:7,content:[],model:'fixture',provider:'fixture',stopReason:'stop'};
async function fixture(context:test.TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-owner-recover-'))),child=new FakeChild();child.onCommand=record=>child.defaults(record);
  const owner=await createPrimaryOwner({state:{root,instanceId:randomUUID()},spawnChild:child.spawn as typeof spawn}),channel=connectTestOwner(owner);
  const primary={key:'primary',epoch:1,cwd:root,executable:'unused',recoveryWorkspaceId:randomUUID()},session=new PrimarySession({...primary,transport:channel.connection.factory(primary),ownerIdentity:`${owner.incarnation}:primary:1`,publish:()=>{},onBeforeClearQueue:async()=>{throw new RpcError('not_ready','Fixture queue storage is unavailable.');},onRecoveredQueue:async()=>{},onQueueClearFailed:async()=>{}});
  context.after(async()=>{child.exit(0);await session.detach();channel.connection.close();channel.detach();await owner.dispose();await rm(root,{recursive:true,force:true});});
  await session.start();return{root,child,owner,channel,session};
}
test('verified native refresh clears the owner protocol latch before prompt and complete capture',async context=>{
  const {child,session}=await fixture(context);child.event({type:'response',id:'unknown',command:'get_state',success:true,data:{}});await ownerTurn();await ownerTurn();
  assert.equal(session.client.synchronized,false);await assert.rejects(()=>session.input('not yet','prompt'),{code:'protocol_error'});
  const before=child.writes.filter(record=>record.type==='get_available_models').length;await session.resynchronize();
  assert.equal(session.client.synchronized,true);assert.equal(child.writes.filter(record=>record.type==='get_available_models').length,before+1);
  await session.input('after refresh','prompt');await session.prepareDetach();
});
test('one drain notice across a refused Stop recaptures the lost live suffix and resumes records',async context=>{
  const {child,channel,session}=await fixture(context);child.event({type:'message_start',message});child.event({type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}});child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'before'}});await ownerTurn();
  child.event({type:'extension_ui_request',id:'confirm',method:'confirm',title:'Fixture'});await ownerTurn();
  const id=session.messages[0]?.id,reads=child.writes.filter(record=>record.type==='get_state').length;channel.parent.hold=true;assert.equal(channel.wire.send({kind:'padding',data:'x'.repeat(9*1024*1024)}),true);
  child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' missing'}});await ownerTurn();assert.doesNotMatch(JSON.stringify(session.messages),/missing/);
  child.blocked=true;const stopped=assert.rejects(()=>session.stop(),{code:'not_ready'});await child.command('extension_ui_response');
  channel.parent.drain();await ownerTurn();child.blocked=false;child.release?.();await stopped;await ownerTurn();await ownerTurn();assert.equal(session.client.synchronized,true);assert.equal(session.messages[0]?.id,id);assert.match(JSON.stringify(session.messages[0]?.parts),/before missing/);
  child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' after'}});await ownerTurn();assert.match(JSON.stringify(session.messages[0]?.parts),/before missing after/);assert.equal(child.writes.filter(record=>record.type==='get_state').length,reads+2);
  assert.equal(child.writes.some(record=>['abort','clear_queue','new_session'].includes(record.type)),false);
});

const oldSource = '851e599d8a243abf2cdadd1f1e9c05939600c6f0';
const ownerFiles = ['ui/server/primary-owner.mts','ui/server/owner-records.mts','ui/server/owner-recovery.mts','ui/server/owner-decode-worker.mts','ui/server/owner-wire.mts','ui/shared/owner.ts','ui/server/owner-client.mts','ui/rpc/session.mts'];
const launchFiles = ['ui/server/main.mts','ui/server/supervisor.mts','ui/server/backend.mts','ui/server/release-control.mts','ui/server/release-store.mts'];
const executable = fileURLToPath(new URL('../rpc/fake-pi.mts', import.meta.url));
type Release = {directory: string; manifest: ReleaseManifest};
type Prepared = {stateDir: string; oldDirectory: string; currentDirectory: string; currentCommit: string; currentTree: string};
type Plan = {old: Release; current: Release; control: string; state: string};
async function checkedRelease(directory: string, commit: string, tree?: string): Promise<Release> {
  assert.match(commit, /^[a-f0-9]{40,64}$/, 'Expected source commit is required.');
  const canonical = await realpath(directory), manifest = await manifestAt(canonical, true);
  assert.equal(manifest.sourceCommit, commit, 'Release source commit differs.');
  if (tree !== undefined) {assert.match(tree, /^[a-f0-9]{40,64}$/); assert.equal(manifest.sourceTree, tree, 'Release source tree differs.');}
  assert.equal(manifest.ownerProtocol, OWNER_PROTOCOL, 'Owner protocol differs.');
  for (const name of [...ownerFiles, ...launchFiles]) {
    assert.ok(Object.hasOwn(manifest.files, name), `Required sealed file is missing: ${name}`);
    assert.equal(createHash('sha256').update(await boundedFile(join(canonical, name), 128 * 1024 ** 2)).digest('hex'), manifest.files[name]);
  }
  const files = (await inventory(canonical)).filter(entry => !entry.directory).map(entry => entry.path).sort();
  assert.deepEqual(files, [...Object.keys(manifest.files), 'release.json'].sort(), 'Executed inventory differs from the complete manifest.');
  await assertSealedTree(canonical); return {directory: canonical, manifest};
}
async function prepared(input: Prepared): Promise<Plan> {
  const old = await checkedRelease(input.oldDirectory, oldSource);
  const current = await checkedRelease(input.currentDirectory, input.currentCommit, input.currentTree);
  assert.notEqual(current.manifest.id, old.manifest.id); assert.notEqual(current.manifest.sourceCommit, oldSource); assert.notEqual(current.manifest.sourceTree, old.manifest.sourceTree);
  const state = await realpath(input.stateDir), info = await lstat(state);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && !(info.mode & 0o077), 'A private isolated prepared state is required.');
  for await (const entry of await opendir(state)) assert.equal(entry.name, 'releases', 'Prepared state must have no previous runtime state.');
  const paths = await releaseRoot(state); assertControlPath(paths.control);
  for (const release of [old, current]) assert.equal((await findRelease(paths.root, release.manifest.id)).directory, release.directory, 'Release is outside the prepared store.');
  const selection = await readSelection(paths.root); if (selection) assert.equal(selection.current, old.manifest.id);
  await assert.rejects(lstat(paths.claim), {code: 'ENOENT'}); await assert.rejects(lstat(paths.control), {code: 'ENOENT'});
  return {old, current, control: paths.control, state};
}
function present(pid: number): boolean {
  try {process.kill(pid, 0); return true;} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error;}
}
/** A terminated process stays visible to kill(pid, 0) as a zombie until its parent reaps it; the reaper may be slow under load, so exit means the process is gone or a zombie. */
function running(pid: number): boolean {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {return !execFileSync('ps', ['-o','stat=','-p',String(pid)], {encoding: 'utf8', maxBuffer: 256, timeout: 2000, env: {PATH: process.env.PATH, LC_ALL: 'C'}}).trim().startsWith('Z');}
  catch (error) {if ((error as {status?: number}).status === 1) return false; throw error;}
}
type ProcessIdentity = {pid: number; parent: number; group: number; uid: number; started: string; signature: string; token: string};
type ProcessIO = {probe: (pid: number) => ProcessIdentity | undefined; members: (group: number) => number[]; signal: (group: number) => void};
/** macOS appends kernel exec strings to a young process's ps eww text and drops them later; identity covers only the arguments and environment. */
const kernelExecStrings = /\s(?:pfz|stack_guard|malloc_entropy|ptr_munge|main_stack|executable_file|dyld_file|executable_cdhash|executable_boothash|arm64e_abi|th_port|security_config)=\S*/g;
function processIdentity(text: string): ProcessIdentity {
  assert.ok(Buffer.byteLength(text) <= 16384);
  const fields = text.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/); assert.ok(fields);
  const token = fields[6]?.match(/(?:^|\s)UI_TEST_OWNER_TOKEN=([a-f0-9-]+)(?:\s|$)/)?.[1]; assert.ok(token, 'Owned run token is unavailable.');
  return {pid: Number(fields[1]), parent: Number(fields[2]), group: Number(fields[3]), uid: Number(fields[4]), started: fields[5] as string, signature: sha256((fields[6] as string).replace(kernelExecStrings, "")), token};
}
function processProbe(pid: number): ProcessIdentity | undefined {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {return processIdentity(execFileSync('ps', ['eww','-p',String(pid),'-o','pid=,ppid=,pgid=,uid=,lstart=,command='], {encoding: 'utf8', maxBuffer: 16384, timeout: 2000, env: {PATH: process.env.PATH, LC_ALL: 'C'}}));}
  catch (error) {if ((error as {status?: number}).status === 1) return undefined; throw error;}
}
function processIds(flag: '-P' | '-g', pid: number): number[] {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  let output: string;
  try {output = execFileSync('pgrep', [flag, String(pid)], {encoding: 'utf8', maxBuffer: 4096, timeout: 2000});}
  catch (error) {if ((error as {status?: number}).status === 1) return []; throw error;}
  const ids = output.trim().split(/\s+/).map(Number); assert.ok(ids.length <= 32 && ids.every(id => Number.isSafeInteger(id) && id > 1)); return ids;
}
const processIO: ProcessIO = {probe: processProbe, members: group => processIds('-g',group), signal: group => {try {process.kill(-group,'SIGKILL');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}}};
// Reparenting changes PPID, not the retained birth and run-ownership evidence.
function sameIdentity(expected: Omit<ProcessIdentity,'parent'>, current: ProcessIdentity | undefined): boolean {
  return !!current && expected.pid === current.pid && expected.group === current.group && expected.uid === current.uid && expected.started === current.started && expected.signature === current.signature && expected.token === current.token;
}
function remember(records: Map<number, ProcessIdentity>, token: string, pid: number) {
  const current = processProbe(pid); assert.ok(current && current.token === token && current.uid === process.getuid?.(), 'Current ownership is unavailable.');
  const previous = records.get(pid); if (previous) assert.ok(sameIdentity(previous,current), 'A recorded process identity changed.');
  assert.ok(records.has(pid) || records.size < 32, 'Owned process inventory exceeds its bound.'); records.set(pid,current);
}
function childGroups(root: number, token: string, records: Map<number, ProcessIdentity>): void {
  const queue = [{pid: root, depth: 0}], found = new Set([root]);
  for (const {pid, depth} of queue) {
    assert.ok(depth < 8 && queue.length <= 32, 'Owned process inventory exceeds its bound.'); remember(records,token,pid);
    for (const child of processIds('-P',pid)) {
      remember(records,token,child); assert.equal(records.get(child)?.parent,pid, 'Owned ancestry changed during capture.');
      if (!found.has(child)) {assert.ok(queue.length < 32); found.add(child); queue.push({pid: child, depth: depth + 1});}
    }
  }
}
function forceOwned(records: Map<number, ProcessIdentity>, io = processIO): string[] {
  const refused: string[] = [];
  for (const group of new Set([...records.values()].map(record => record.group))) {
    try {
      const members = io.members(group); if (!members.length) continue;
      for (const pid of members) {const expected = records.get(pid); assert.ok(expected && expected.group === group && sameIdentity(expected,io.probe(pid)), `Identity or ownership unavailable for group ${group}.`);}
      assert.deepEqual(io.members(group),members, 'Group membership changed before force.'); io.signal(group);
    } catch (error) {refused.push(String(error).slice(0,256));}
  }
  return refused;
}
function retireExited(records: Map<number, ProcessIdentity>, io = processIO): void {
  for (const group of new Set([...records.values()].map(record => record.group))) {
    assert.deepEqual(io.members(group),[], `Owned group ${group} exit is unverified.`);
    for (const [pid, record] of records) if (record.group === group) records.delete(pid);
  }
}
async function cleanupRefused(cwd: string, observed: ProcessIdentity[], records: Map<number, ProcessIdentity>, reasons: string[], owner: {pid?: number; token: string}): Promise<never> {
  const path = join(cwd,'cleanup-unverified.json'), report = {verified: false, retainedDirectory: cwd, reportPath: path, expectedOwner: owner, reasons: reasons.slice(0,64), observedProcesses: observed, unverifiedProcesses: [...records.values()]};
  try {assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 65536); await atomicJson(path,report);}
  catch (error) {throw new Error(`Cleanup is unverified; retained state: ${cwd}; report write failed: ${path}.`,{cause:error});}
  throw new Error(`Cleanup is unverified; retained state: ${cwd}; report: ${path}. ${report.reasons.join(' ')}`);
}
async function forceLauncher(child: ChildProcess, records: Map<number, ProcessIdentity>, ended: () => boolean): Promise<string[]> {
  const refused = forceOwned(records);
  if (!ended() && child.pid && records.has(child.pid) && refused.length === 0) {try {await once(child,'exit',{signal: AbortSignal.timeout(5000)});} catch {refused.push('The launcher exit is unverified.');}}
  return refused;
}
function captureBeforeStop(child: ChildProcess, records: Map<number, ProcessIdentity>, token: string, ended: boolean, leaf: boolean, reasons: string[]): boolean {
  if (ended) {if (!leaf) reasons.push('Launcher exited before the final inventory; detached descendant coverage is incomplete.'); return false;}
  try {assert.ok(child.pid); childGroups(child.pid,token,records); return true;} catch (error) {reasons.push(String(error).slice(0,256)); return false;}
}
async function stopLauncher(child: ChildProcess, records: Map<number, ProcessIdentity>, token: string, cwd: string, stop: () => Promise<unknown>, ended: () => boolean, grace: number, leaf: boolean, failed: boolean) {
  const reasons: string[] = []; let forced = false, normal = false;
  if (!child.pid || !records.has(child.pid)) reasons.push('The launcher ownership record is unavailable.');
  if (!leaf && failed) reasons.push('The scenario did not complete; detached descendant coverage is unverified.');
  const captured = captureBeforeStop(child,records,token,ended(),leaf,reasons);
  if (leaf && records.size !== 1) reasons.push('The child-free fixture inventory is incomplete.');
  const observed = [...records.values()];
  try {
    const receipt = await stop() as {accepted?: boolean}; assert.equal(receipt.accepted,true);
    if (!ended()) await once(child,'exit',{signal: AbortSignal.timeout(grace)});
    normal = captured && child.exitCode === 0;
  } catch {
    forced = true; reasons.push(...await forceLauncher(child,records,ended));
  }
  if (!leaf && !normal) reasons.push('No complete normal-stop witness; parent-based discovery cannot certify detached descendants.');
  try {retireExited(records);} catch (error) {reasons.push(String(error).slice(0,256));}
  if (reasons.length) await cleanupRefused(cwd,observed,records,reasons,{pid:child.pid,token});
  return forced;
}
async function ownedLauncher(entry: string, args: string[], cwd: string, stop: () => Promise<unknown>, action: (run: {next: () => Promise<string>; remember: (pid: number) => void; pid: number; exited: Promise<void>; token: string; startDetachedFixture: () => void}) => Promise<void>, signal: AbortSignal, grace = 10000, cleaned: () => void = () => {}, token = randomUUID()): Promise<void> {
  const agent = join(cwd, 'agent'); await mkdir(agent, {mode: 0o700});
  const records = new Map<number, ProcessIdentity>();
  const child = spawn(process.execPath, [entry, ...args], {cwd, shell: false, detached: true, stdio: ['pipe','pipe','pipe'], env: {PATH: process.env.PATH, HOME: cwd, PI_CODING_AGENT_DIR: agent, PI_AGENT_SESSIONS_DIR: join(agent, 'agent-sessions'), UI_TEST_OWNER_TOKEN: token}});
  const exited = new Promise<void>(resolve => {child.once('exit',() => resolve()); child.once('error',() => resolve());});
  const events = new EventEmitter(), urls: string[] = []; let ended = false, failed = false, bytes = 0, pending = '';
  events.on('error', () => {});
  child.once('exit', () => {ended = true; events.emit('error', new Error('The launcher exited before readiness.'));});
  child.once('error', error => {ended = true; events.emit('error', error);});
  child.stderr.on('data', chunk => {bytes += chunk.length; if (bytes > 65536) events.emit('error', new Error('Launcher output exceeds its bound.'));});
  child.stdout.on('data', chunk => {
    bytes += chunk.length; if (bytes > 65536) {events.emit('error', new Error('Launcher output exceeds its bound.')); return;}
    pending += chunk.toString('utf8'); const lines = pending.split('\n'); pending = lines.pop() ?? '';
    for (const line of lines) if (/^http:\/\/127\.0\.0\.1:\d+\/$/.test(line)) {urls.push(line); events.emit('ready');}
  });
  const next = async () => {
    if (ended) throw new Error('The launcher exited.');
    if (!urls.length) await once(events, 'ready', {signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])});
    const url = urls.shift(); assert.ok(url); assert.ok(child.pid && !ended); childGroups(child.pid,token,records); return url;
  };
  try {assert.ok(child.pid); childGroups(child.pid,token,records); await action({next, remember: pid => childGroups(pid,token,records), pid: child.pid, exited, token, startDetachedFixture: () => {child.stdin.end('detach\n');}});}
  catch (error) {failed = true; throw error;}
  finally {
    // Only the no-argument RPC fixture has a child-free contract; sealed launchers require normal-stop evidence.
    const forced = await stopLauncher(child,records,token,cwd,stop,() => ended,grace,entry === executable && args.length === 0,failed);
    cleaned();
    if (forced && !failed) assert.fail('The owner did not confirm normal stop; forced cleanup is not compatibility success.');
  }
}
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt++) {const value = await read(); if (accepts(value)) return value; await ownerTurn();}
  throw new Error('The controlled fixture phase did not arrive.');
}
function publicApi(initial: string, signal: AbortSignal) {
  let url = initial, workspace = '', cursor = '';
  async function call<T>(pathname: string, method = 'GET', body?: unknown, key?: string, scope = signal): Promise<T> {
    const origin = new URL(url).origin, destination = new URL(pathname, origin); if (workspace) destination.searchParams.set('workspace', workspace);
    const response = await fetch(destination, {method, headers: {Origin: origin, 'Content-Type': 'application/json', ...(key ? {'Idempotency-Key': key} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.any([scope, AbortSignal.timeout(5000)])});
    const value = await response.json() as {ok: boolean; data: T}; assert.ok(response.ok && value.ok, JSON.stringify(value)); return value.data;
  }
  async function mutation<T>(kind: OperationKind, pathname: string, body: unknown, target?: Target, scope = signal): Promise<T> {
    const reservation = await call<{operationId: string}>('/api/operations','POST',{kind, ...(target ? {target} : {})},undefined,scope);
    return call<T>(pathname, 'POST', body, reservation.operationId,scope);
  }
  async function events(scope: AbortSignal) {
    assert.ok(workspace && cursor);
    const origin = new URL(url).origin, destination = new URL('/api/events',origin);
    destination.searchParams.set('workspace',workspace); destination.searchParams.set('after',cursor);
    const response = await fetch(destination,{headers:{Origin:origin},signal:scope});
    return {response,workspace};
  }
  async function version(release: Release) {
    const response = await fetch(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])}), html = await response.text();
    assert.ok(Buffer.byteLength(html) <= 2 * 1024 * 1024);
    const meta = html.match(/<meta name="ui-identity" content="([^"]+)"/); assert.ok(meta);
    const identity = readIdentity(meta[1] ?? null);
    assert.equal(identity.git?.commit, release.manifest.sourceCommit); assert.equal(identity.git?.modified, false); assert.equal(identity.assets?.digest, release.manifest.generation);
  }
  return {call, mutation, version, events, use: (next: string) => {url = next;}, hydrate: async () => {const boot = await call<Bootstrap>('/api/bootstrap'); workspace = boot.workspace.id; cursor = boot.cursor; return boot;}};
}
function primaryFrame(wire: string, workspace: string, key: string, epoch: number): PrimaryView | undefined {
  const name = /^event: (.+)$/m.exec(wire)?.[1], data = /^data: (.+)$/m.exec(wire)?.[1];
  if (name !== 'primary.state' || !data) return;
  const envelope = JSON.parse(data) as EventEnvelope<'primary.state'>, view = envelope?.data;
  if (envelope?.workspaceId !== workspace || envelope.target?.kind !== 'primary' || envelope.target.key !== key || envelope.target.epoch !== epoch || view?.key !== key || view.epoch !== epoch) return;
  return view;
}
async function primaryEvents(reader: ReadableStreamDefaultReader<Uint8Array>, workspace: string, key: string, epoch: number, ready: (view: PrimaryView) => boolean, wait: <T>(work: Promise<T>) => Promise<T>): Promise<PrimaryView> {
  const decoder = new TextDecoder(); let buffer = '', bytes = 0;
  for (;;) {
    const chunk = await wait(reader.read());
    if (chunk.done) throw new Error('The Primary state stream ended before readiness.');
    bytes += chunk.value.byteLength; assert.ok(bytes <= LIMITS.clientQueueBytes,'The startup event stream exceeds its bound.');
    buffer += decoder.decode(chunk.value,{stream:true});
    for (;;) {
      const cut = buffer.indexOf('\n\n'); if (cut < 0) break;
      const wire = buffer.slice(0,cut); buffer = buffer.slice(cut+2);
      const view = primaryFrame(wire,workspace,key,epoch);
      if (view && ready(view)) return view;
    }
  }
}
async function initialPrimary(api: Pick<ReturnType<typeof publicApi>,'events'|'mutation'|'call'>, cwd: string, signal: AbortSignal, exited: Promise<void>): Promise<PrimaryView> {
  signal.throwIfAborted();
  const startup = new AbortController(), scope = AbortSignal.any([signal,startup.signal]);
  const deadline = setTimeout(()=>startup.abort(new Error('Primary startup deadline expired.')),30_000);
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve,reject)=>{abort=()=>reject(scope.reason);scope.addEventListener('abort',abort,{once:true});});
  const stopped = exited.then(()=>{throw new Error('The launcher exited before Primary readiness.');});
  const interrupted = Promise.race([cancelled,stopped]);
  const wait = <T,>(work: Promise<T>) => Promise.race([work,interrupted]);
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await wait(api.events(scope)); response = stream.response;
    assert.equal(response.status,200); assert.ok(response.body); reader = response.body.getReader();
    const opening = await wait(api.mutation<{primaryKey: string; operation: OperationView}>('primary.open','/api/primaries',{cwd},undefined,scope));
    assert.equal(opening.operation.state,'completed');
    const key = opening.primaryKey, first = await wait(api.call<PrimaryView>(`/api/primaries/${key}`,'GET',undefined,undefined,scope));
    assert.equal(first.key,key); assert.ok(Number.isSafeInteger(first.epoch) && first.epoch > 0);
    const ready = (view: PrimaryView) => {
      if (view.lastError) throw new Error(`Primary startup failed: ${view.lastError.message}`);
      if (['failed','stopping','stopped'].includes(view.lifecycle)) throw new Error(`Primary startup ended: ${view.lifecycle}`);
      return view.lifecycle === 'ready' && !!view.pid && !!view.sessionId;
    };
    if (ready(first)) return first;
    return await primaryEvents(reader,stream.workspace,key,first.epoch,ready,wait);
  } finally {
    clearTimeout(deadline); scope.removeEventListener('abort',abort); startup.abort();
    if (reader) {await reader.cancel().catch(()=>{}); reader.releaseLock();}
    else await response?.body?.cancel().catch(()=>{});
  }
}
function startupFixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>, exit!: () => void, cancelled = 0, subscribed = false;
  let beforeRead = () => {};
  const body = new ReadableStream<Uint8Array>({start(value){controller=value;},cancel(){cancelled++;}}), response = new Response(body);
  const first: PrimaryView = {key:'primary',epoch:1,cwd:'/fixture',lifecycle:'starting',activity:'unknown',pendingOperationIds:[],pendingDialogs:[],capabilities:{}};
  const exited = new Promise<void>(resolve=>{exit=resolve;});
  const api = {
    events: async (_scope: AbortSignal) => {subscribed=true;return {response,workspace:'workspace'};},
    mutation: async <T,>() => {assert.equal(subscribed,true);return {primaryKey:'primary',operation:{state:'completed'}} as T;},
    call: async <T,>() => {beforeRead();return structuredClone(first) as T;},
  };
  const frame = (view: PrimaryView, fields: Partial<EventEnvelope<'primary.state'>> = {}) => `event: primary.state\ndata: ${JSON.stringify({at:new Date(0).toISOString(),workspaceId:'workspace',target:{kind:'primary',key:'primary',epoch:1},data:view,...fields})}\n\n`;
  return {api,first,exited,exit,response,frame,send:(wire:string)=>controller.enqueue(new TextEncoder().encode(wire)),end:()=>controller.close(),fail:(error:Error)=>controller.error(error),beforeRead(work:()=>void){beforeRead=work;},get cancelled(){return cancelled;}};
}
test('initial Primary readiness subscribes before open and retains events across the first read',async()=>{
  const f=startupFixture(),ready={...f.first,lifecycle:'ready' as const,pid:123,sessionId:'session'};
  f.beforeRead(()=>f.send(f.frame(ready)));
  const actual=await initialPrimary(f.api,'/fixture',new AbortController().signal,f.exited);
  assert.deepEqual(actual,ready);assert.equal(f.cancelled,1);assert.equal(f.response.body?.locked,false);
});
test('initial Primary readiness ignores other workspaces, keys and epochs before pending becomes ready',async()=>{
  const f=startupFixture(),ready={...f.first,lifecycle:'ready' as const,pid:123,sessionId:'session'};let resolved=false;
  const waiting=initialPrimary(f.api,'/fixture',new AbortController().signal,f.exited);void waiting.then(()=>{resolved=true;},()=>{});await ownerTurn();
  f.send(f.frame(ready,{workspaceId:'other'}));f.send(f.frame(ready,{target:{kind:'primary',key:'other',epoch:1}}));f.send(f.frame(ready,{target:{kind:'primary',key:'primary',epoch:2}}));f.send(f.frame({...ready,epoch:2}));f.send(f.frame({...ready,key:'other'}));
  await ownerTurn();assert.equal(resolved,false);
  const wire=f.frame(ready);f.send(wire.slice(0,17));f.send(wire.slice(17));assert.deepEqual(await waiting,ready);assert.equal(f.cancelled,1);assert.equal(f.response.body?.locked,false);
});
test('initial Primary readiness accepts an already ready snapshot and closes the subscribed stream',async()=>{
  const f=startupFixture();Object.assign(f.first,{lifecycle:'ready',pid:123,sessionId:'session'});
  assert.deepEqual(await initialPrimary(f.api,'/fixture',new AbortController().signal,f.exited),f.first);assert.equal(f.cancelled,1);assert.equal(f.response.body?.locked,false);
});
test('initial Primary readiness preserves a correlated startup error and closes the stream',async()=>{
  const f=startupFixture(),waiting=initialPrimary(f.api,'/fixture',new AbortController().signal,f.exited),rejected=assert.rejects(waiting,/Primary startup failed: fixture rejected/);await ownerTurn();
  f.send(f.frame({...f.first,lastError:{code:'protocol_error',message:'fixture rejected',retry:'none'}}));await rejected;assert.equal(f.cancelled,1);assert.equal(f.response.body?.locked,false);
});
test('initial Primary readiness rejects stopped startup without accepting an earlier ready event',async()=>{
  const f=startupFixture();f.first.lifecycle='stopped';f.beforeRead(()=>f.send(f.frame({...f.first,lifecycle:'ready',pid:123,sessionId:'session'})));
  await assert.rejects(()=>initialPrimary(f.api,'/fixture',new AbortController().signal,f.exited),/Primary startup ended: stopped/);assert.equal(f.cancelled,1);
});
test('initial Primary readiness rejects launcher exit and closes the stream',async()=>{
  const f=startupFixture(),waiting=initialPrimary(f.api,'/fixture',new AbortController().signal,f.exited),rejected=assert.rejects(waiting,/launcher exited before Primary readiness/);await ownerTurn();f.exit();await rejected;assert.equal(f.cancelled,1);assert.equal(f.response.body?.locked,false);
});
test('initial Primary readiness preserves cancellation and closes the stream',async()=>{
  const f=startupFixture(),cancel=new AbortController(),waiting=initialPrimary(f.api,'/fixture',cancel.signal,f.exited),rejected=assert.rejects(waiting,/fixture cancelled/);await ownerTurn();cancel.abort(new Error('fixture cancelled'));await rejected;assert.equal(f.cancelled,1);assert.equal(f.response.body?.locked,false);
});
test('initial Primary readiness enforces and disposes the owning startup deadline',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const f=startupFixture(),waiting=initialPrimary(f.api,'/fixture',new AbortController().signal,f.exited),rejected=assert.rejects(waiting,/Primary startup deadline expired/);await ownerTurn();context.mock.timers.tick(30_000);await rejected;assert.equal(f.cancelled,1);assert.equal(f.response.body?.locked,false);
});
test('initial Primary readiness rejects a closed or failed event stream',async()=>{
  const closed=startupFixture(),waiting=initialPrimary(closed.api,'/fixture',new AbortController().signal,closed.exited),rejected=assert.rejects(waiting,/state stream ended before readiness/);await ownerTurn();closed.end();await rejected;assert.equal(closed.response.body?.locked,false);
  const failed=startupFixture(),reading=initialPrimary(failed.api,'/fixture',new AbortController().signal,failed.exited),error=assert.rejects(reading,/fixture stream failed/);await ownerTurn();failed.fail(new Error('fixture stream failed'));await error;assert.equal(failed.response.body?.locked,false);
});
test('initial Primary readiness bounds stream bytes and closes before rejection',async()=>{
  const f=startupFixture(),waiting=initialPrimary(f.api,'/fixture',new AbortController().signal,f.exited),rejected=assert.rejects(waiting,/startup event stream exceeds its bound/);await ownerTurn();f.send('x'.repeat(LIMITS.clientQueueBytes+1));await rejected;assert.equal(f.cancelled,1);assert.equal(f.response.body?.locked,false);
});
function liveEntry(page: HistoryPage) {
  const entry = page.items.find(item => item.messages?.some(value => value.role === 'assistant' && value.parts.some(part => part.type === 'text' && part.text.includes('before'))));
  assert.ok(entry); return {id: entry.id, text: entry.messages?.flatMap(value => value.parts.flatMap(part => part.type === 'text' ? [part.text] : [])).join('') ?? ''};
}
async function commandAudit(cwd: string, pid: number, sessionId: string | undefined) {
  const value = JSON.parse((await boundedFile(join(cwd, 'owner-recovery-commands.json'), 65536)).toString('utf8'));
  assert.equal(value.pid, pid); assert.equal(value.sessionId, sessionId); assert.equal(value.overflow, false);
  assert.ok(Array.isArray(value.commands) && value.commands.length <= 256);
  assert.equal(value.commands.some((name: string) => ['abort','clear_queue','new_session'].includes(name)), false);
  return value.commands as string[];
}
async function sendInput(api: ReturnType<typeof publicApi>, target: Target & {kind: 'primary'}, message: string): Promise<OperationView> {
  const snapshot = await api.call<Bootstrap>('/api/snapshot'), saved = snapshot.targets?.find(value => value.target.kind === 'primary' && value.target.key === target.key && value.target.epoch === target.epoch); assert.ok(saved);
  const draft = await api.call<{revision: number}>(`/api/workspaces/${snapshot.workspace.id}/targets/${saved.targetKey}/draft`, 'PUT', {expectedRevision: saved.draft.revision, text: message, mode: 'steer'});
  return api.mutation<OperationView>('primary.input', `/api/primaries/${target.key}/inputs`, {epoch: target.epoch, message, mode: 'steer', draftRevision: draft.revision, literal: false}, target);
}
async function publicScenario(plan: Plan, signal: AbortSignal, diagnostic: (value: string) => void = () => {}): Promise<void> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'or-run-'))); let removed = false;
  try {
    await ownedLauncher(join(plan.old.directory, 'ui/server/main.mts'), ['--state-dir', plan.state, '--cwd', cwd, '--port', '0', '--pi', executable], cwd,
      () => requestReleaseControl(plan.control, {kind: 'stop'}), async run => {
        const api = publicApi(await run.next(), signal); await api.version(plan.old); await api.hydrate();
        const status = () => requestReleaseControl(plan.control, {kind: 'status'}) as Promise<ReleaseStatus>;
        const first = await initialPrimary(api,cwd,signal,run.exited);
        const key = first.key, read = () => api.call<PrimaryView>(`/api/primaries/${key}`), target = {kind: 'primary' as const, key, epoch: first.epoch};
        const original = await status(); assert.equal(original.current, plan.old.manifest.id); assert.equal(original.ownerPid, run.pid); assert.equal(original.ownerProtocol, OWNER_PROTOCOL); assert.ok(first.pid); assert.ok(first.sessionId); assert.ok(original.ownerIncarnation); run.remember(first.pid);
        assert.deepEqual(original.primaries, [{key, epoch: target.epoch, pid: first.pid}]);
        const transitions: {release: string; backendPid?: number}[] = [{release: original.current as string, backendPid: original.backendPid}];
        if (original.backendPid) run.remember(original.backendPid);
        const input = (message: string) => sendInput(api, target, message);
        const refresh = () => api.mutation<OperationView>('primary.control',`/api/primaries/${key}/control`,{epoch: target.epoch, action: 'resync'},target);
        const history = () => api.call<HistoryPage>(`/api/primaries/${key}/history`);
        const started = await input('/fixture owner-recovery'); assert.equal(started.state, 'accepted'); assert.ok(started.receipt?.kind === 'rpc'); assert.equal(started.receipt.disposition, 'started');
        await until(read, view => view.pendingDialogs.length > 0); const retained = liveEntry(await history()); assert.match(retained.text, /before/);
        const switchTo = async (release: Release, rollback = false) => {
          const [receipt, url] = await Promise.all([requestReleaseControl(plan.control, rollback ? {kind: 'rollback'} : {kind: 'switch', release: release.manifest.id}), run.next()]);
          const result = receipt as ReleaseStatus; api.use(url); assert.equal(result.current, release.manifest.id); assert.equal(result.state, 'ready');
          const current = await status(); assert.equal(current.ownerPid, original.ownerPid); assert.equal(current.ownerIncarnation, original.ownerIncarnation);
          assert.deepEqual(current.primaries, original.primaries); assert.ok(current.backendPid); run.remember(current.backendPid); assert.notEqual(current.backendPid, original.backendPid);
          transitions.push({release: current.current as string, backendPid: current.backendPid});
          await api.version(release); const view = await read(); assert.equal(view.sessionId, first.sessionId); assert.equal(view.sessionFile, first.sessionFile); assert.equal(view.pid, first.pid); assert.equal(view.epoch, target.epoch);
          const live = liveEntry(await history()); assert.equal(live.id, retained.id); assert.match(live.text, /before/);
        };
        await switchTo(plan.current); const healthy = await input('healthy old owner'); assert.equal(healthy.state, 'accepted'); assert.ok(healthy.receipt?.kind === 'rpc'); assert.equal(healthy.receipt.disposition, 'queued'); assert.equal((await refresh()).state, 'completed');
        const advance = async () => {const view = await until(read, value => value.pendingDialogs.length > 0), dialog = view.pendingDialogs.find(item => item.method === 'confirm'); assert.ok(dialog); return api.mutation<OperationView>('primary.dialog',`/api/primaries/${key}/dialogs/${dialog.id}`,{epoch: target.epoch, confirmed: true},target);};
        assert.equal((await advance()).state, 'completed'); await until(history, page => liveEntry(page).text.includes('before after'));
        await switchTo(plan.old, true); assert.match(liveEntry(await history()).text, /before after/);
        await switchTo(plan.current); assert.equal((await advance()).state, 'completed');
        await until(read, view => view.capabilities.input === false);
        const refused = await refresh(); assert.equal(refused.state, 'rejected'); assert.equal(refused.error?.code, 'unsupported');
        const unavailable = await read(); assert.equal(unavailable.capabilities.input, false); assert.equal(unavailable.pid, first.pid);
        const final = await status(); assert.equal(final.ownerIncarnation, original.ownerIncarnation); assert.deepEqual(final.primaries, original.primaries);
        assert.equal(liveEntry(await history()).id, retained.id);
        const commands = await commandAudit(cwd, first.pid, first.sessionId); assert.ok(commands.includes('prompt')); assert.ok(commands.includes('get_state'));
        diagnostic(JSON.stringify({old: {id: plan.old.manifest.id, sourceCommit: plan.old.manifest.sourceCommit, sourceTree: plan.old.manifest.sourceTree, files: Object.fromEntries(ownerFiles.map(name => [name, plan.old.manifest.files[name]])), manifest: sha256(await boundedFile(join(plan.old.directory, 'release.json'), 2 * 1024 ** 2))}, currentManifest: sha256(await boundedFile(join(plan.current.directory, 'release.json'), 2 * 1024 ** 2)), current: plan.current.manifest.id, currentCommit: plan.current.manifest.sourceCommit, currentTree: plan.current.manifest.sourceTree,
          ownerPid: original.ownerPid, ownerIncarnation: original.ownerIncarnation, piPid: first.pid, sessionId: first.sessionId, key, epoch: target.epoch, entry: retained.id, text: liveEntry(await history()).text, transitions, resync: refused, input: unavailable.capabilities.input, commands}));
      }, signal, 10000, () => {removed = true;});
  } finally {if (removed) await rm(cwd, {recursive: true, force: true});}
}
async function compatibility(input: Prepared, signal: AbortSignal, launch = publicScenario): Promise<void> {await launch(await prepared(input), signal);}

async function metadataFixture(context: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'or-meta-')));
  context.after(async () => {const entries = await inventory(root); for (const entry of entries) if (entry.directory) await chmod(join(root, entry.path), 0o700); await rm(root, {recursive: true, force: true});});
  const manifests: ReleaseManifest[] = [], directories: string[] = [];
  for (const kind of ['old', 'current']) {
    const directory = join(root, kind), files: Record<string, string> = {};
    for (const name of [...ownerFiles, ...launchFiles]) {const filename = join(directory, name); await mkdir(join(filename, '..'), {recursive: true}); await writeFile(filename, 'export {};'); files[name] = sha256('export {};');}
    const manifest: ReleaseManifest = {format: RELEASE_FORMAT, browserApi: BROWSER_API, ownerProtocol: OWNER_PROTOCOL, id: (kind === 'old' ? 'a' : 'b').repeat(64), sourceCommit: kind === 'old' ? oldSource : 'c'.repeat(40), sourceTree: (kind === 'old' ? 'd' : 'e').repeat(40), runtimeDigest: 'f'.repeat(64), lockDigest: 'f'.repeat(64), assetDigest: 'f'.repeat(64), generation: 'f'.repeat(64), moduleFamily: 'f'.repeat(64), iteration: '1.6', branch: 'fixture', stagedAt: new Date(0).toISOString(), committedAt: new Date(0).toISOString(), files, imports: {}};
    await atomicJson(join(directory, 'release.json'), manifest); await sealTree(directory); manifests.push(manifest); directories.push(directory);
  }
  const oldDirectory = directories[0] as string, currentDirectory = directories[1] as string;
  return {root, oldDirectory, currentDirectory, oldManifest: manifests[0] as ReleaseManifest, currentManifest: manifests[1] as ReleaseManifest,
    input: {stateDir: root, oldDirectory, currentDirectory, currentCommit: 'c'.repeat(40), currentTree: 'e'.repeat(40)}};
}
async function beforeSpawn(input: Prepared, signal: AbortSignal, error: RegExp) {
  let launches = 0;
  await assert.rejects(compatibility(input, signal, async () => {launches++;}), error);
  assert.equal(launches, 0);
}
for (const wrong of ['source', 'protocol', 'missing', 'hash', 'extra', 'candidate'] as const) test(`sealed launcher refuses ${wrong} metadata before spawn`, async context => {
  const f = await metadataFixture(context);
  if (wrong === 'source') f.oldManifest.sourceCommit = 'a'.repeat(40);
  if (wrong === 'protocol') f.oldManifest.ownerProtocol = 'incompatible';
  if (wrong === 'missing') delete f.oldManifest.files[ownerFiles[0] as string];
  if (wrong === 'hash') {const file = join(f.oldDirectory, ownerFiles[0] as string); await chmod(file, 0o600); await writeFile(file, 'changed');}
  if (wrong === 'extra') {await chmod(f.oldDirectory, 0o700); await writeFile(join(f.oldDirectory, 'unlisted.mts'), 'export {};');}
  if (wrong === 'candidate') f.input.currentTree = 'f'.repeat(40);
  if (['source','protocol','missing'].includes(wrong)) {await chmod(join(f.oldDirectory, 'release.json'), 0o600); await writeFile(join(f.oldDirectory, 'release.json'), JSON.stringify(f.oldManifest));}
  const errors = {source: /source commit differs/, protocol: /Owner protocol differs/, missing: /Required sealed file is missing/, hash: /integrity mismatch/, extra: /complete manifest/, candidate: /source tree differs/};
  await beforeSpawn(f.input, context.signal, errors[wrong]);
});
for (const failure of ['scenario', 'timeout']) test(`owned launcher cleans its process group after ${failure} failure`, {timeout: 10000}, async context => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'or-clean-'))); let pid = 0, cleaned = false;
  try {
    await assert.rejects(ownedLauncher(executable, [], cwd, async () => {throw new Error('No owner socket in the failure fixture.');}, async run => {
      pid = run.pid; if (failure === 'scenario') throw new Error('Scenario refused.'); await run.next();
    }, failure === 'timeout' ? AbortSignal.timeout(20) : context.signal, 20, () => {cleaned = true;}), failure === 'scenario' ? /Scenario refused/ : /aborted/);
    assert.equal(cleaned, true); assert.equal(present(pid), false); assert.equal(present(-pid), false);
  } finally {if (cleaned) await rm(cwd, {recursive: true, force: true});}
});
for (const mismatch of ['reused','ownership-changed','unavailable','unknown-member'] as const) test(`forced cleanup refuses ${mismatch} ownership without a real process probe`, () => {
  const old: ProcessIdentity = {pid:101,parent:100,group:101,uid:501,started:'old birth',signature:'old signature',token:'private-owner'};
  const records = new Map([[old.pid,old]]), signals: number[] = [];
  const io: ProcessIO = {members: () => mismatch === 'unknown-member' ? [101,102] : [101], probe: () => mismatch === 'unavailable' ? undefined : {...old,...(mismatch === 'reused' ? {started:'new birth'} : {}),...(mismatch === 'ownership-changed' ? {token:'different-owner'} : {})}, signal: group => {signals.push(group);}};
  assert.equal(forceOwned(records,io).length,1); assert.deepEqual(signals,[]);
  assert.throws(() => retireExited(records,io),/exit is unverified/); assert.equal(records.size,1);
  io.members = () => []; retireExited(records,io); assert.equal(records.size,0);
});
type DetachedReceipt = Omit<ProcessIdentity,'parent'> & {port: number};
async function readDetachedReceipt(cwd: string): Promise<DetachedReceipt> {
  const proof = JSON.parse((await boundedFile(join(cwd,'owner-recovery-orphan.json'),1024)).toString('utf8')) as DetachedReceipt;
  assert.ok(proof && typeof proof === 'object' && !Array.isArray(proof));
  assert.deepEqual(Object.keys(proof).sort(),['group','pid','port','signature','started','token','uid']);
  for (const id of [proof.pid,proof.group]) assert.ok(Number.isSafeInteger(id) && id > 1);
  assert.ok(Number.isSafeInteger(proof.uid) && proof.uid >= 0); assert.ok(Number.isSafeInteger(proof.port) && proof.port > 0 && proof.port <= 65535);
  assert.ok(typeof proof.started === 'string' && proof.started.length <= 32); assert.match(proof.started,/^\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4}$/);
  assert.match(proof.token,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/); assert.match(proof.signature,/^[a-f0-9]{64}$/);
  return proof;
}
async function finishDetachedFixture(cwd: string, token: string) {
  const proof = await readDetachedReceipt(cwd);
  const starting = JSON.parse((await boundedFile(join(cwd,'owner-recovery-orphan-starting.json'),4096)).toString('utf8')); assert.equal(starting.pid,proof.pid);
  assert.equal(proof.token,token); assert.ok(sameIdentity(proof,processProbe(proof.pid)));
  const socket = createConnection({host:'127.0.0.1',port:proof.port});
  try {socket.resume(); await Promise.all([once(socket,'connect',{signal:AbortSignal.timeout(5000)}).then(() => {socket.write(`${token}\n`);}), once(socket,'end',{signal:AbortSignal.timeout(5000)})]);}
  finally {socket.destroy();}
  assert.deepEqual(processIds('-g',proof.group),[]); assert.equal(running(proof.pid),false); assert.equal(present(-proof.group),false);
}
test('a child that has exited reads as not running before its parent reaps it', {timeout:15000}, async () => {
  const child = spawn(process.execPath,['-e',"process.stdout.write('x')"],{shell:false,stdio:['ignore','pipe','ignore']});
  assert.ok(child.pid); child.stdout.resume(); await once(child.stdout,'end');
  assert.equal(running(child.pid),false); await once(child,'exit');
});
test('launcher exit with a detached child refuses cleanup and retains state until verified fixture teardown', {timeout:15000}, async context => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(),'or-orphan-'))), token = randomUUID(); let cleaned = false, verified = false;
  try {
    await assert.rejects(ownedLauncher(executable,['--fixture-detached-parent'],cwd,async () => {throw new Error('The parent is gone.');},async run => {run.startDetachedFixture(); await run.exited;},context.signal,20,() => {cleaned = true;},token),error => {
      assert.match(String(error),/Cleanup is unverified/); assert.ok(String(error).includes(cwd)); return true;
    });
    assert.equal(cleaned,false); assert.ok((await lstat(cwd)).isDirectory());
    const refusal = JSON.parse((await boundedFile(join(cwd,'cleanup-unverified.json'),65536)).toString('utf8'));
    assert.equal(refusal.verified,false); assert.equal(refusal.retainedDirectory,cwd); assert.equal(refusal.reportPath,join(cwd,'cleanup-unverified.json')); assert.match(JSON.stringify(refusal.reasons),/coverage is incomplete/);
    const receipt = await readDetachedReceipt(cwd);
    assert.deepEqual(Object.keys(receipt).sort(),['group','pid','port','signature','started','token','uid']);
    assert.equal(Object.hasOwn(receipt,'identity'),false); assert.doesNotMatch(JSON.stringify(receipt),/UI_TEST_OWNER_TOKEN=|PATH=|PI_CODING_AGENT_DIR=/);
  } finally {
    await finishDetachedFixture(cwd,token); verified = true; await rm(cwd,{recursive:true,force:true});
  }
  assert.equal(verified,true); context.diagnostic('The refusal retained its directory; independent fixture identity and child-group exit passed before teardown removed it.');
});
test('the current backend runs with an actual sealed owner and exposes its unsupported recovery', {skip: !process.env.UI_TEST_OLD_RELEASE, timeout: 180000}, async context => {
  const input = {stateDir: process.env.UI_TEST_RELEASE_STATE ?? '', oldDirectory: process.env.UI_TEST_OLD_RELEASE ?? '', currentDirectory: process.env.UI_TEST_CURRENT_RELEASE ?? '', currentCommit: process.env.UI_TEST_CURRENT_COMMIT ?? '', currentTree: process.env.UI_TEST_CURRENT_TREE ?? ''};
  for (const value of Object.values(input)) assert.ok(value, 'Both prepared releases, isolated state, and independent current commit/tree bindings are required.');
  await compatibility(input, context.signal, (plan, signal) => publicScenario(plan, signal, value => context.diagnostic(value)));
});
