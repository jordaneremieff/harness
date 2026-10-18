import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,chmod,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {releaseRoot,sha256,atomicJson,findRelease,readSelection,writeSelection,inventory,sealTree,readManifest} from './release-store.mts';
import {RELEASE_FORMAT,BROWSER_API,type ReleaseManifest} from '../shared/release.ts';
import {OWNER_PROTOCOL} from '../shared/owner.ts';
const hash='a'.repeat(64);
function manifest():ReleaseManifest {return {format:RELEASE_FORMAT,id:hash,sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),iteration:'1.6',stagedAt:new Date().toISOString(),committedAt:new Date().toISOString(),branch:'fixture',lockDigest:hash,runtimeDigest:hash,assetDigest:hash,ownerProtocol:OWNER_PROTOCOL,browserApi:BROWSER_API,generation:hash,moduleFamily:hash,files:{},imports:{}};}
test('selected release roots stay isolated and descriptors bind sealed bytes',async context=> {
  const root=await mkdtemp(join(tmpdir(),'ui-release-'));context.after(()=>rm(root,{recursive:true,force:true}));
  const first=await releaseRoot(join(root,'first')),second=await releaseRoot(join(root,'second'));
  assert.notEqual(first.control,second.control);assert.equal(first.recovery,join(first.root,'owner-recovery'));
  const directory=join(first.root,'runtimes',hash,'releases',hash);await mkdir(join(directory,'ui/server'),{recursive:true});
  const bytes='export const fixture=true;';await writeFile(join(directory,'ui/server/backend.mts'),bytes);
  const m=manifest();m.files['ui/server/backend.mts']=sha256(bytes);await atomicJson(join(directory,'release.json'),m);
  await mkdir(join(first.root,'releases'));await atomicJson(join(first.root,'releases',`${hash}.json`),{runtimeDigest:hash});
  assert.equal((await findRelease(first.root,hash)).directory,directory);
  await writeSelection(first.root,hash,'b'.repeat(64));assert.equal((await readSelection(first.root))?.lastGood,'b'.repeat(64));assert.equal(await readSelection(second.root),undefined);
  await writeFile(join(directory,'ui/server/backend.mts'),'changed');await assert.rejects(()=>findRelease(first.root,hash),/integrity mismatch/);
});
test('a sealed capsule resolves bare imports without checkout paths',async context=> {
  const root=await mkdtemp(join(tmpdir(),'ui-capsule-'));context.after(async()=>{await chmod(join(root,'capsule/node_modules/fixture/index.js'),0o600).catch(()=>{});await chmod(join(root,'capsule/node_modules/fixture/package.json'),0o600).catch(()=>{});await chmod(join(root,'capsule/node_modules/fixture'),0o700).catch(()=>{});await chmod(join(root,'capsule/node_modules'),0o700).catch(()=>{});await rm(root,{recursive:true,force:true});});
  const capsule=join(root,'capsule');await mkdir(join(capsule,'node_modules/fixture'),{recursive:true});await mkdir(join(capsule,'releases',hash),{recursive:true});
  await writeFile(join(capsule,'node_modules/fixture/package.json'),JSON.stringify({name:'fixture',type:'module',exports:'./index.js'}));await writeFile(join(capsule,'node_modules/fixture/index.js'),'export const value="sealed";');
  await writeFile(join(capsule,'releases',hash,'entry.mjs'),'import {value} from "fixture";process.stdout.write(value);');
  const entries=await inventory(capsule);assert.equal(entries.filter(v=>!v.directory).length,3);
  await sealTree(join(capsule,'node_modules'));assert.equal((await lstat(join(capsule,'node_modules/fixture/index.js'))).mode&0o222,0);
  const output=await new Promise<string>((accept,reject)=>execFile(process.execPath,[join(capsule,'releases',hash,'entry.mjs')],{cwd:root,env:{PATH:process.env.PATH},timeout:5000,encoding:'utf8'},(error,out)=>error?reject(error):accept(out)));
  assert.equal(output,'sealed');
});
test('release manifests refuse path escape and incompatible identities',()=> {
  assert.equal(readManifest(manifest()).ownerProtocol,OWNER_PROTOCOL);
  assert.throws(()=>readManifest({...manifest(),files:{'ui/../../outside':hash}}));
  assert.throws(()=>readManifest({...manifest(),browserApi:'unknown'}));
});
test('a release manifest keeps a valid history list, drops an invalid one and still reads one that has none',()=>{
  const base=JSON.parse(JSON.stringify(manifest())) as Record<string,unknown>;
  assert.equal(readManifest(base).recent,undefined);
  const recent=[{commit:'a'.repeat(40),subject:'Change'}];
  assert.deepEqual(readManifest({...base,recent}).recent,recent);
  for(const bad of ['text',[],[{commit:'x',subject:'y'}],[{commit:'a'.repeat(40),subject:'a\u0001b'}]])assert.equal(readManifest({...base,recent:bad}).recent,undefined);
});
