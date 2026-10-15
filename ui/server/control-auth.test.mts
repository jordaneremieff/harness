import assert from 'node:assert/strict';
import test from 'node:test';
import {chmod,link,lstat,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {ControlAuth,readControlDescriptor} from './control-auth.mts';
import {LifecycleLog} from './lifecycle-log.mts';

const request=(authorization?:string,cookie?:string)=>({headers:{authorization,cookie}} as IncomingMessage);
test('private control descriptors rotate independently and old owners cannot remove replacements',async t=> {
  const directory=await mkdtemp(join(tmpdir(),'ui-control-auth-')),first=new ControlAuth(),second=new ControlAuth();t.after(async()=>{await first.close();await second.close();await rm(directory,{recursive:true,force:true});});
  await first.publish(directory,'http://127.0.0.1:4318',randomUUID());const original=await readControlDescriptor(directory);assert.equal((await lstat(join(directory,'control.json'))).mode&0o777,0o600);assert.throws(()=>first.authorize(request()));assert.throws(()=>first.authorize(request('Bearer wrong')));first.authorize(request(`Bearer ${original.credential}`));assert.throws(()=>first.authorize(request(`Bearer ${original.credential}`,'browser=unrelated')));
  await second.publish(directory,'http://127.0.0.1:4319',randomUUID());const replacement=await readControlDescriptor(directory);assert.notEqual(original.credential,replacement.credential);assert.notEqual(original.bootId,replacement.bootId);assert.throws(()=>second.authorize(request(`Bearer ${original.credential}`)));await first.close();assert.deepEqual(await readControlDescriptor(directory),replacement);await second.close();await assert.rejects(()=>readControlDescriptor(directory));
});

test('descriptor publication replaces stale entries without modifying another hardlink',async t=> {
  for(const kind of ['malformed','wrong-mode','hardlinked']) {
    const directory=await mkdtemp(join(tmpdir(),'ui-control-stale-')),auth=new ControlAuth();
    t.after(async()=>{await auth.close();await rm(directory,{recursive:true,force:true});});
    const path=join(directory,'control.json'),other=join(directory,'other.json');
    const stale=kind==='malformed'?'not JSON':JSON.stringify({origin:'http://127.0.0.1:4317',bootId:randomUUID(),credential:new ControlAuth().credential});
    await writeFile(path,stale,{mode:0o600});if(kind==='wrong-mode')await chmod(path,0o644);if(kind==='hardlinked')await link(path,other);
    const original=kind==='hardlinked'?await lstat(other):undefined;await assert.rejects(()=>readControlDescriptor(directory));
    const bootId=randomUUID();await auth.publish(directory,'http://127.0.0.1:4318',bootId);
    assert.deepEqual(await readControlDescriptor(directory),{origin:'http://127.0.0.1:4318',bootId,credential:auth.credential});
    const published=await lstat(path);assert.equal(published.mode&0o777,0o600);assert.equal(published.nlink,1);
    if(original) {const retained=await lstat(other);assert.equal(await readFile(other,'utf8'),stale);assert.equal(retained.ino,original.ino);assert.equal(retained.mode,original.mode);assert.notEqual(published.ino,retained.ino);}
  }
});

test('discovery refuses unsafe permissions, unknown metadata fields and oversized content',async t=> {
  const directory=await mkdtemp(join(tmpdir(),'ui-control-discovery-')),auth=new ControlAuth();t.after(async()=>{await rm(directory,{recursive:true,force:true});});await auth.publish(directory,'http://127.0.0.1:4318',randomUUID());const path=join(directory,'control.json'),descriptor=await readFile(path,'utf8');
  await chmod(path,0o644);await assert.rejects(()=>readControlDescriptor(directory));await chmod(path,0o600);await chmod(directory,0o755);await assert.rejects(()=>readControlDescriptor(directory));await chmod(directory,0o700);
  await writeFile(path,JSON.stringify({...JSON.parse(descriptor),extra:true}));await assert.rejects(()=>readControlDescriptor(directory));await writeFile(path,'x'.repeat(2049));await assert.rejects(()=>readControlDescriptor(directory));await writeFile(path,descriptor);await auth.close();
});

test('control audit waits for retained bytes, excludes bodies and reports a failed writer',async t=> {
  const directory=await mkdtemp(join(tmpdir(),'ui-control-log-')),log=await LifecycleLog.open(directory);t.after(async()=>{await log.close().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  await log.control(JSON.stringify({requestId:'request',actor:'Test actor',workspaceId:'workspace',action:'show',result:'applied',revision:2}));const rows=(await readFile(join(directory,'lifecycle.log'),'utf8')).trim().split('\n').map(row=>JSON.parse(row));const last=rows.at(-1);assert.equal(last.event,'control');assert.equal(JSON.parse(last.detail).result,'applied');
  const file=(log as unknown as {file:{close():Promise<void>}}).file;await file.close();await assert.rejects(()=>log.control('unavailable'),/logging is unavailable/);await assert.rejects(()=>log.control('still unavailable'),/logging is unavailable/);
});
