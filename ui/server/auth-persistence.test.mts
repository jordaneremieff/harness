import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AUTH_SESSION_LIMIT, Auth } from './auth.mts';
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
function output() {const headers = new Map<string,string>(); return {headers,response:{setHeader:(name:string,value:string) => headers.set(name,value)} as unknown as ServerResponse};}
function request(token:string) {return {headers:{cookie:`pi_ui_session=${token}`}} as IncomingMessage;}
async function directory(context:TestContext) {const root = await mkdtemp(join(tmpdir(),'ui-auth-'));await chmod(root,0o700);context.after(() => rm(root,{recursive:true,force:true}));return root;}
const unavailable = (error:unknown) => error instanceof Error && 'status' in error && error.status === 503;

test('durable launch retains hashes, private modes and authentication across close and reopen',async context => {
  const root = await directory(context), auth = await Auth.open(root), out = output();
  const token = await auth.launch(auth.capability,out.response), bytes = await readFile(join(root,'auth.json'),'utf8');
  assert.equal(out.headers.get('Set-Cookie')?.includes(token),true);assert.equal(bytes.includes(token),false);assert.equal(bytes.includes(auth.capability),false);
  assert.deepEqual(JSON.parse(bytes),{format:'ui.auth/1',sessions:[digest(token)]});assert.equal((await lstat(join(root,'auth.json'))).mode & 0o777,0o600);
  assert.deepEqual(await readdir(root),['auth.json']);await auth.close();assert.throws(() => auth.session(request(token)));
  const reopened = await Auth.open(root);assert.equal(reopened.session(request(token)),token);await reopened.close();assert.equal(await readFile(join(root,'auth.json'),'utf8'),bytes);
});
test('logout durably revokes only its exact browser before the clearing cookie',async context => {
  const root = await directory(context), auth = await Auth.open(root), out = output(), token = await auth.launch(auth.capability,out.response);await auth.close();
  const reopened = await Auth.open(root), second = await reopened.launch(reopened.capability,output().response);
  const clear = output();await reopened.logout(token,clear.response);assert.match(clear.headers.get('Set-Cookie') ?? '',/Max-Age=0/);await reopened.close();
  const after = await Auth.open(root);assert.throws(() => after.session(request(token)));assert.equal(after.session(request(second)),second);await after.close();
});
test('launch cookie follows the complete serialized publication',async context => {
  let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
  const root = await directory(context), auth = await Auth.open(root), out = output();
  const writer = auth as unknown as {publish(sessions:Set<string>):Promise<void>};const publish = writer.publish.bind(auth);let entered!:()=>void;const ready = new Promise<void>(resolve => {entered = resolve;});
  context.mock.method(writer,'publish',async (sessions:Set<string>) => {entered();await gate;await publish(sessions);});
  const launching = auth.launch(auth.capability,out.response);await ready;assert.equal(out.headers.size,0);await assert.rejects(readFile(join(root,'auth.json')),{code:'ENOENT'});release();const token = await launching;
  assert.equal(JSON.parse(await readFile(join(root,'auth.json'),'utf8')).sessions[0],digest(token));await auth.close();
});
test('logout does not clear its cookie or report success before durable publication',async context => {
  const root = await directory(context), auth = await Auth.open(root), token = await auth.launch(auth.capability,output().response), out = output();
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => {release = resolve;}), ready = new Promise<void>(resolve => {entered = resolve;});
  const writer = auth as unknown as {publish(sessions:Set<string>):Promise<void>}, publish = writer.publish.bind(auth);
  context.mock.method(writer,'publish',async (sessions:Set<string>) => {entered();await gate;await publish(sessions);});
  let settled = false; const logout = auth.logout(token,out.response).then(() => {settled = true;});await ready;
  assert.equal(settled,false);assert.equal(out.headers.size,0);assert.equal(auth.session(request(token)),token);assert.deepEqual(JSON.parse(await readFile(join(root,'auth.json'),'utf8')).sessions,[digest(token)]);
  release();await logout;assert.match(out.headers.get('Set-Cookie') ?? '',/Max-Age=0/);assert.deepEqual(JSON.parse(await readFile(join(root,'auth.json'),'utf8')).sessions,[]);await auth.close();
});
test('session capacity refuses new launch without eviction or capability consumption',async context => {
  const root = await directory(context), tokens = Array.from({length:AUTH_SESSION_LIMIT},() => randomBytes(32).toString('base64url'));
  await writeFile(join(root,'auth.json'),JSON.stringify({format:'ui.auth/1',sessions:tokens.map(digest)}),{mode:0o600});
  const auth = await Auth.open(root), out = output();await assert.rejects(auth.launch(auth.capability,out.response),error => error instanceof Error && 'status' in error && error.status === 429);assert.equal(out.headers.size,0);
  for (const token of tokens) assert.equal(auth.session(request(token)),token);
  await auth.logout(tokens[0] as string,output().response);await auth.launch(auth.capability,out.response);for (const token of tokens.slice(1)) assert.equal(auth.session(request(token)),token);await auth.close();
});
test('concurrent uses of one capability publish and issue only one browser session',async context => {
  const root = await directory(context), auth = await Auth.open(root), a = output(), b = output();
  const results = await Promise.allSettled([auth.launch(auth.capability,a.response),auth.launch(auth.capability,b.response)]);
  assert.deepEqual(results.map(r => r.status),['fulfilled','rejected']);assert.equal(a.headers.size,1);assert.equal(b.headers.size,0);assert.equal(JSON.parse(await readFile(join(root,'auth.json'),'utf8')).sessions.length,1);await auth.close();
});
test('corrupt, over-bound and unsafe authentication files fail closed without replacement',async context => {
  const root = await directory(context);
  const values = ['invalid',JSON.stringify({format:'ui.auth/1',sessions:['plain-token']}),JSON.stringify({format:'ui.auth/1',sessions:['a'.repeat(64),'a'.repeat(64)]}),JSON.stringify({format:'ui.auth/1',sessions:[],extra:true}),' '.repeat(8193)];
  for (const [index,value] of values.entries()) {const dir = join(root,String(index));await mkdir(dir,{mode:0o700});await writeFile(join(dir,'auth.json'),value,{mode:0o600});await assert.rejects(Auth.open(dir),unavailable);assert.equal(await readFile(join(dir,'auth.json'),'utf8'),value);}
  const unsafe = join(root,'unsafe');await mkdir(unsafe,{mode:0o700});const path = join(unsafe,'auth.json');await writeFile(path,JSON.stringify({format:'ui.auth/1',sessions:[]}),{mode:0o644});await assert.rejects(Auth.open(unsafe),unavailable);
  await chmod(path,0o600);await link(path,join(root,'hardlink'));await assert.rejects(Auth.open(unsafe),unavailable);
  const symbolic = join(root,'symbolic');await mkdir(symbolic,{mode:0o700});await symlink(path,join(symbolic,'auth.json'));await assert.rejects(Auth.open(symbolic),unavailable);assert((await lstat(join(symbolic,'auth.json'))).isSymbolicLink());
  await symlink(unsafe,join(root,'root-link'));await assert.rejects(Auth.open(join(root,'root-link')),unavailable);
});
test('publication failure sets no cookie and refuses further authentication until reopen',async context => {
  const root = await directory(context), auth = await Auth.open(root), out = output();await mkdir(join(root,'auth.json'),{mode:0o700});
  await assert.rejects(auth.launch(auth.capability,out.response),unavailable);assert.equal(out.headers.size,0);await assert.rejects(auth.launch(auth.capability,out.response),unavailable);await auth.close();
});
test('a failed directory sync refuses logout success and poisons live authentication',async context => {
  const root = await directory(context), first = await Auth.open(root), token = await first.launch(first.capability,output().response);await first.close();
  const auth = await Auth.open(root), probe = await open(join(root,'probe'),'wx',0o600), sync = probe.sync, prototype = Object.getPrototypeOf(probe);await probe.close();let calls = 0;
  context.mock.method(prototype,'sync',async function(this:Awaited<ReturnType<typeof open>>) {calls++;if(calls===2)throw new Error('directory sync refused');await sync.call(this);});
  const out = output();await assert.rejects(auth.logout(token,out.response),unavailable);assert.equal(calls,2);assert.equal(out.headers.size,0);assert.throws(()=>auth.session(request(token)));await auth.close();
  assert.deepEqual(JSON.parse(await readFile(join(root,'auth.json'),'utf8')).sessions,[]);
});
test('a failed file sync never issues a cookie or changes existing durable bytes',async context => {
  const root = await directory(context), auth = await Auth.open(root), token = await auth.launch(auth.capability,output().response);await auth.close();const bytes = await readFile(join(root,'auth.json'));
  const next = await Auth.open(root), probe = await open(join(root,'probe'),'wx',0o600);const prototype = Object.getPrototypeOf(probe);await probe.close();context.mock.method(prototype,'sync',async () => {throw new Error('sync refused');});
  const out = output();await assert.rejects(next.launch(next.capability,out.response),unavailable);assert.equal(out.headers.size,0);assert.deepEqual(await readFile(join(root,'auth.json')),bytes);assert.throws(() => next.session(request(token)));await next.close();
});
