import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn, execFileSync} from 'node:child_process';
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
import type {Bootstrap, PrimaryView, HistoryPage, OperationView, Target, OperationKind} from '../shared/api.ts';
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
function killGroup(pid: number): void {
  try {process.kill(-pid, 'SIGKILL');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
}
function childGroups(root: number | undefined, groups: Set<number>): void {
  if (!root) return;
  const queue = [{pid: root, depth: 0}], found = new Set<number>();
  for (const {pid, depth} of queue) {
    assert.ok(depth < 8 && queue.length <= 32, 'Owned process inventory exceeds its bound.');
    let children: string;
    try {children = execFileSync('pgrep', ['-P', String(pid)], {encoding: 'utf8', maxBuffer: 4096, timeout: 2000});}
    catch (error) {if ((error as {status?: number}).status === 1) continue; throw error;}
    for (const value of children.trim().split(/\s+/)) {
      const child = Number(value); assert.ok(Number.isSafeInteger(child) && child > 1);
      if (!found.has(child)) {found.add(child); groups.add(child); queue.push({pid: child, depth: depth + 1});}
    }
  }
}
async function gone(pids: Set<number>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {if ([...pids].every(pid => !present(pid) && !present(-pid))) return; await ownerTurn();}
  assert.fail('An owned process or group remains; retain the test state.');
}
async function ownedLauncher(entry: string, args: string[], cwd: string, stop: () => Promise<unknown>, action: (run: {next: () => Promise<string>; pids: Set<number>; pid: number}) => Promise<void>, signal: AbortSignal, grace = 10000, cleaned: () => void = () => {}): Promise<void> {
  const agent = join(cwd, 'agent'); await mkdir(agent, {mode: 0o700});
  const child = spawn(process.execPath, [entry, ...args], {cwd, shell: false, detached: true, stdio: ['pipe','pipe','pipe'], env: {PATH: process.env.PATH, HOME: cwd, PI_CODING_AGENT_DIR: agent, PI_AGENT_SESSIONS_DIR: join(agent, 'agent-sessions')}});
  const pids = new Set<number>(); if (child.pid) pids.add(child.pid);
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
    const url = urls.shift(); assert.ok(url); return url;
  };
  try {assert.ok(child.pid); await action({next, pids, pid: child.pid});}
  catch (error) {failed = true; throw error;}
  finally {
    let forced = false;
    try {childGroups(child.pid, pids);}
    finally {
      try {await stop(); if (!ended) await once(child, 'exit', {signal: AbortSignal.timeout(grace)});}
      catch {
        forced = true;
        try {childGroups(child.pid, pids);}
        finally {for (const pid of pids) killGroup(pid); if (!ended) await once(child, 'exit', {signal: AbortSignal.timeout(5000)});}
      }
    }
    await gone(pids); cleaned();
    if (forced && !failed) assert.fail('The owner did not confirm normal stop; forced cleanup is not compatibility success.');
  }
}
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt++) {const value = await read(); if (accepts(value)) return value; await ownerTurn();}
  throw new Error('The controlled fixture phase did not arrive.');
}
function publicApi(initial: string, signal: AbortSignal) {
  let url = initial, workspace = '';
  async function call<T>(pathname: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
    const origin = new URL(url).origin, destination = new URL(pathname, origin); if (workspace) destination.searchParams.set('workspace', workspace);
    const response = await fetch(destination, {method, headers: {Origin: origin, 'Content-Type': 'application/json', ...(key ? {'Idempotency-Key': key} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])});
    const value = await response.json() as {ok: boolean; data: T}; assert.ok(response.ok && value.ok, JSON.stringify(value)); return value.data;
  }
  async function mutation<T>(kind: OperationKind, pathname: string, body: unknown, target?: Target): Promise<T> {
    const reservation = await call<{operationId: string}>('/api/operations','POST',{kind, ...(target ? {target} : {})});
    return call<T>(pathname, 'POST', body, reservation.operationId);
  }
  async function version(release: Release) {
    const response = await fetch(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])}), html = await response.text();
    assert.ok(Buffer.byteLength(html) <= 2 * 1024 * 1024);
    const meta = html.match(/<meta name="ui-identity" content="([^"]+)"/); assert.ok(meta);
    const identity = readIdentity(meta[1] ?? null);
    assert.equal(identity.git?.commit, release.manifest.sourceCommit); assert.equal(identity.git?.modified, false); assert.equal(identity.assets?.digest, release.manifest.assetDigest);
  }
  return {call, mutation, version, use: (next: string) => {url = next;}, hydrate: async () => {const boot = await call<Bootstrap>('/api/bootstrap'); workspace = boot.workspace.id; return boot;}};
}
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
        const opening = await api.mutation<{primaryKey: string; operation: OperationView}>('primary.open','/api/primaries',{cwd}); assert.equal(opening.operation.state, 'completed');
        const key = opening.primaryKey, read = () => api.call<PrimaryView>(`/api/primaries/${key}`), first = await until(read, view => view.lifecycle === 'ready' && !!view.pid && !!view.sessionId), target = {kind: 'primary' as const, key, epoch: first.epoch};
        const original = await status(); assert.equal(original.current, plan.old.manifest.id); assert.equal(original.ownerPid, run.pid); assert.equal(original.ownerProtocol, OWNER_PROTOCOL); assert.ok(first.pid); assert.ok(first.sessionId); assert.ok(original.ownerIncarnation); run.pids.add(first.pid);
        assert.deepEqual(original.primaries, [{key, epoch: target.epoch, pid: first.pid}]);
        const transitions: {release: string; backendPid?: number}[] = [{release: original.current as string, backendPid: original.backendPid}];
        if (original.backendPid) run.pids.add(original.backendPid);
        const input = (message: string) => sendInput(api, target, message);
        const refresh = () => api.mutation<OperationView>('primary.control',`/api/primaries/${key}/control`,{epoch: target.epoch, action: 'resync'},target);
        const history = () => api.call<HistoryPage>(`/api/primaries/${key}/history`);
        const started = await input('/fixture owner-recovery'); assert.equal(started.state, 'accepted'); assert.ok(started.receipt?.kind === 'rpc'); assert.equal(started.receipt.disposition, 'started');
        await until(read, view => view.pendingDialogs.length > 0); const retained = liveEntry(await history()); assert.match(retained.text, /before/);
        const switchTo = async (release: Release, rollback = false) => {
          const [receipt, url] = await Promise.all([requestReleaseControl(plan.control, rollback ? {kind: 'rollback'} : {kind: 'switch', release: release.manifest.id}), run.next()]);
          const result = receipt as ReleaseStatus; api.use(url); assert.equal(result.current, release.manifest.id); assert.equal(result.state, 'ready');
          const current = await status(); assert.equal(current.ownerPid, original.ownerPid); assert.equal(current.ownerIncarnation, original.ownerIncarnation);
          assert.deepEqual(current.primaries, original.primaries); assert.ok(current.backendPid); run.pids.add(current.backendPid); assert.notEqual(current.backendPid, original.backendPid);
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
test('the current backend runs with an actual sealed owner and exposes its unsupported recovery', {skip: !process.env.UI_TEST_OLD_RELEASE, timeout: 180000}, async context => {
  const input = {stateDir: process.env.UI_TEST_RELEASE_STATE ?? '', oldDirectory: process.env.UI_TEST_OLD_RELEASE ?? '', currentDirectory: process.env.UI_TEST_CURRENT_RELEASE ?? '', currentCommit: process.env.UI_TEST_CURRENT_COMMIT ?? '', currentTree: process.env.UI_TEST_CURRENT_TREE ?? ''};
  for (const value of Object.values(input)) assert.ok(value, 'Both prepared releases, isolated state, and independent current commit/tree bindings are required.');
  await compatibility(input, context.signal, (plan, signal) => publicScenario(plan, signal, value => context.diagnostic(value)));
});
