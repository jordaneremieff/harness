import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,realpath,chmod,rm,lstat,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {publishSnapshot} from './release-stage.mts';
import {inventory,manifestAt,removeStagingTree,sealTree,sha256} from './release-store.mts';
import {RELEASE_FORMAT,BROWSER_API,type ReleaseManifest} from '../shared/release.ts';
import {OWNER_PROTOCOL} from '../shared/owner.ts';
async function fixture(context:test.TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-stage-publish-'))),runtime=join(root,'runtimes','a'.repeat(64));
  context.after(async()=>{await chmod(root,0o700);for(const entry of await inventory(root))if(entry.directory)await chmod(join(root,entry.path),0o700);await rm(root,{recursive:true});});
  await mkdir(join(runtime,'releases'),{recursive:true,mode:0o700});await mkdir(join(root,'releases'),{mode:0o700});
  const directory=join(runtime,'releases',`.stage-${randomUUID()}`);await mkdir(join(directory,'ui/server'),{recursive:true,mode:0o700});
  const data='export const sealed=true;';await writeFile(join(directory,'ui/server/backend.mts'),data);
  const hash='a'.repeat(64),id='b'.repeat(64),manifest:ReleaseManifest={format:RELEASE_FORMAT,id,sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),iteration:'1.6',stagedAt:new Date().toISOString(),committedAt:new Date().toISOString(),branch:'fixture',lockDigest:hash,runtimeDigest:hash,assetDigest:hash,ownerProtocol:OWNER_PROTOCOL,browserApi:BROWSER_API,generation:hash,moduleFamily:hash,files:{'ui/server/backend.mts':sha256(data)},imports:{}};
  return {root,runtime,directory,manifest};
}
test('snapshot publication renames writable staging before sealing and only then publishes its descriptor',async context=>{
  const f=await fixture(context),published=await publishSnapshot(f.root,f.runtime,f.directory,f.manifest);
  assert.equal(published.directory,join(f.runtime,'releases',f.manifest.id));await assert.rejects(()=>access(f.directory),{code:'ENOENT'});
  assert.equal((await lstat(published.directory)).mode&0o777,0o500);assert.equal((await lstat(join(published.directory,'ui/server'))).mode&0o222,0);
  assert.equal((await lstat(join(published.directory,'ui/server/backend.mts'))).mode&0o222,0);
  assert.equal((await manifestAt(published.directory,true)).id,f.manifest.id);
  assert.deepEqual(JSON.parse(await readFile(join(f.root,'releases',`${f.manifest.id}.json`),'utf8')),{runtimeDigest:f.manifest.runtimeDigest});
});
test('unpublished sealed staging cleanup preserves sibling snapshots and runtime dependency bytes and modes',async context=>{
  const f=await fixture(context),sibling=join(f.runtime,'releases','c'.repeat(64)),dependency=join(f.runtime,'node_modules/fixture');
  await mkdir(sibling);await writeFile(join(sibling,'published'),'published');await sealTree(sibling);
  await mkdir(dependency,{recursive:true});await writeFile(join(dependency,'index.js'),'immutable dependency');await sealTree(join(f.runtime,'node_modules'));
  await sealTree(f.directory);assert.equal((await lstat(f.directory)).mode&0o777,0o500);
  await removeStagingTree(f.directory);await assert.rejects(()=>access(f.directory),{code:'ENOENT'});
  assert.equal(await readFile(join(sibling,'published'),'utf8'),'published');assert.equal((await lstat(sibling)).mode&0o777,0o500);
  assert.equal(await readFile(join(dependency,'index.js'),'utf8'),'immutable dependency');assert.equal((await lstat(dependency)).mode&0o777,0o500);
  await assert.rejects(()=>removeStagingTree(sibling),/Only an unpublished/);
});
