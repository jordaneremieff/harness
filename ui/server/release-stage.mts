import {execFile} from 'node:child_process';
import {mkdir,copyFile,lstat,opendir,rename,realpath} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {assetMap} from './http.mts';
import {assetDigest} from './version.mts';
import {assertBrowserAssetsFresh} from './browser-assets.mts';
import {AssetGeneration} from './asset-generations.mts';
import {RELEASE_FORMAT,BROWSER_API,type ReleaseManifest} from '../shared/release.ts';
import {UI_ITERATION} from '../shared/version.ts';
import {atomicJson,boundedFile,inventory,RELEASE_LIMITS,releaseRoot,sealTree,sha256,removeStagingTree,manifestAt,assertSealedTree,type InventoryEntry} from './release-store.mts';
const run=(cwd:string,args:string[])=>new Promise<string>((accept,reject)=>execFile('git',['--no-optional-locks',...args],{cwd,encoding:'utf8',timeout:5000,maxBuffer:256*1024},(error,out)=>error?reject(error):accept(out.trim())));
async function copyInventory(source:string,target:string,entries:InventoryEntry[]) {
  await mkdir(target,{recursive:true,mode:0o700});const digest=createHash('sha256');
  for(const entry of entries){const destination=join(target,entry.path);if(entry.directory){await mkdir(destination,{mode:0o700});continue;}
    const data=await boundedFile(join(source,entry.path),RELEASE_LIMITS.fileBytes);if(data.length!==entry.bytes)throw new Error('Runtime dependencies changed during staging.');
    digest.update(JSON.stringify([entry.path,data.length,sha256(data),entry.executable]));await copyFile(join(source,entry.path),destination,1);
  }return digest.digest('hex');
}
async function dependencyDigest(source:string,entries:InventoryEntry[]) {
  const digest=createHash('sha256');for(const entry of entries)if(!entry.directory){const bytes=await boundedFile(join(source,entry.path),RELEASE_LIMITS.fileBytes);digest.update(JSON.stringify([entry.path,bytes.length,sha256(bytes),entry.executable]));}return digest.digest('hex');
}
async function descriptorCount(root:string) {
  let count=0;const directory=await opendir(root,{bufferSize:1});
  for await(const entry of directory)if(++count>RELEASE_LIMITS.releases||!entry.isFile()||!/^[a-f0-9]{64}\.json$/.test(entry.name))throw new Error('Release descriptor capacity or integrity prevents staging.');return count;
}
async function exists(path:string) {try{await lstat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function sourceRevision(source:string,allowDirty?:boolean) {
  const [sourceCommit,sourceTree,committedAt,branch,dirty]=await Promise.all([
    run(source,['rev-parse','HEAD']),run(source,['rev-parse','HEAD^{tree}']),run(source,['show','--no-patch','--format=%cI','HEAD']),run(source,['rev-parse','--abbrev-ref','HEAD']),run(source,['status','--porcelain=v1','--untracked-files=normal','--','ui','transport','package.json','package-lock.json'])]);
  if(dirty&&!allowDirty)throw new Error('Release staging requires checked, committed UI and transport source.');return {sourceCommit,sourceTree,committedAt,branch};
}
async function snapshotInputs(source:string) {
  const names=['ui/server','ui/rpc','ui/agents','ui/shared','ui/web','ui/dist','ui/cli','transport'],inputs=new Map<string,InventoryEntry[]>();let bytes=128*1024,count=0;
  for(const name of names){const entries=await inventory(join(source,name));inputs.set(name,entries);count+=entries.length;bytes+=entries.reduce((sum,v)=>sum+v.bytes,0);}
  if(count>4096||bytes>128*1024**2)throw new Error('The release source exceeds its staging reservation.');return {inputs,bytes};
}
async function reserveCapacity(root:string,runtime:string,dependencies:InventoryEntry[],snapshotBytes:number) {
  const entries=await inventory(join(root,'runtimes'),false,RELEASE_LIMITS.rootBytes,RELEASE_LIMITS.entries*RELEASE_LIMITS.releases),retained=entries.reduce((sum,v)=>sum+v.bytes,0);
  const additional=await exists(runtime)?0:dependencies.reduce((sum,v)=>sum+v.bytes,0);
  if(retained+snapshotBytes+additional>RELEASE_LIMITS.rootBytes)throw new Error('The release root byte capacity is full; protected snapshots remain intact.');
}
async function ensureRuntime(root:string,runtime:string,source:string,dependencies:InventoryEntry[],digest:string) {
  try{const info=await lstat(join(runtime,'node_modules'));if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Invalid sealed runtime.');
    const retained=(await inventory(join(runtime,'node_modules'),true)).sort((a,b)=>a.path.localeCompare(b.path));
    if(await dependencyDigest(join(runtime,'node_modules'),retained)!==digest)throw new Error('Sealed runtime integrity mismatch.');
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const temporary=join(root,'runtimes',`.stage-${randomUUID()}`);
    try{const copied=await copyInventory(source,join(temporary,'node_modules'),dependencies);if(copied!==digest)throw new Error('Runtime dependencies changed during staging.');await sealTree(join(temporary,'node_modules'));await mkdir(join(temporary,'releases'),{mode:0o700});await rename(temporary,runtime);}
    catch(failure){await removeStagingTree(temporary).catch(()=>{});throw failure;}
  }
}
async function copySourceEntry(source:string,directory:string,name:string,entry:InventoryEntry,files:Record<string,string>) {
  if(entry.path.endsWith('.test.mts')||entry.path.endsWith('.test.ts'))return;
  const path=`${name}/${entry.path}`,destination=join(directory,path);if(entry.directory){await mkdir(destination,{recursive:true,mode:0o700});return;}
  const bytes=await boundedFile(join(source,name,entry.path),RELEASE_LIMITS.fileBytes);if(bytes.length!==entry.bytes)throw new Error('The source changed after its staging reservation.');files[path]=sha256(bytes);
  await mkdir(dirname(destination),{recursive:true,mode:0o700});await copyFile(join(source,name,entry.path),destination,1);
  if(sha256(await boundedFile(destination,RELEASE_LIMITS.fileBytes))!==files[path])throw new Error('Source changed during staging.');
}
async function copySource(source:string,directory:string,inputs:Map<string,InventoryEntry[]>) {
  const files:Record<string,string>={};for(const [name,entries]of inputs){await mkdir(join(directory,name),{recursive:true,mode:0o700});for(const entry of entries)await copySourceEntry(source,directory,name,entry,files);}
  const bytes=await boundedFile(join(source,'package.json'),128*1024);files['package.json']=sha256(bytes);await copyFile(join(source,'package.json'),join(directory,'package.json'),1);return files;
}
async function buildManifest(directory:string,revision:Awaited<ReturnType<typeof sourceRevision>>,runtimeDigest:string,lockDigest:string,files:Record<string,string>,ownerProtocol:string):Promise<ReleaseManifest> {
  const assets=await assetMap(join(directory,'ui')),imports:Record<string,string[]>={};for(const [route,asset]of assets)if(route.endsWith('.js'))imports[route]=[...new vm.SourceTextModule(asset.data.toString('utf8')).dependencySpecifiers];
  const generation=new AssetGeneration(assets,new Map(Object.entries(imports))),stagedAt=new Date().toISOString(),id=sha256(JSON.stringify({sourceCommit:revision.sourceCommit,sourceTree:revision.sourceTree,runtimeDigest,files,ownerProtocol}));
  return {format:RELEASE_FORMAT,id,...revision,stagedAt,iteration:UI_ITERATION,runtimeDigest,lockDigest,assetDigest:assetDigest(assets),ownerProtocol,browserApi:BROWSER_API,generation:generation.id,moduleFamily:generation.family.id,files,imports};
}
function manifestIdentity(m:ReleaseManifest):string {
  return JSON.stringify([m.format,m.id,m.sourceCommit,m.sourceTree,m.iteration,m.committedAt,m.branch,m.lockDigest,m.runtimeDigest,m.assetDigest,m.ownerProtocol,m.browserApi,m.generation,m.moduleFamily,Object.entries(m.files).sort(([a],[b])=>a.localeCompare(b)),Object.entries(m.imports).sort(([a],[b])=>a.localeCompare(b))]);
}
async function checkedSnapshot(directory:string,expected:ReleaseManifest,published:boolean):Promise<ReleaseManifest> {
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||await realpath(directory)!==directory)throw new Error('The retained release directory identity is invalid.');
  const entries=await inventory(directory),retained=await manifestAt(directory,true);
  if(manifestIdentity(retained)!==manifestIdentity(expected))throw new Error('The retained release manifest differs from the staged content.');
  const actualFiles=entries.filter(entry=>!entry.directory).map(entry=>entry.path).sort(),expectedFiles=[...Object.keys(retained.files),'release.json'].sort();
  if(JSON.stringify(actualFiles)!==JSON.stringify(expectedFiles))throw new Error('The retained release file inventory differs from its manifest.');
  if(!published)await sealTree(directory);
  await assertSealedTree(directory);return retained;
}
export async function publishSnapshot(root:string,runtime:string,directory:string,manifest:ReleaseManifest) {
  await atomicJson(join(directory,'release.json'),manifest);
  const destination=join(runtime,'releases',manifest.id),descriptor=join(root,'releases',`${manifest.id}.json`),published=await exists(descriptor),retained=await exists(destination);
  if(published&&!retained)throw new Error('The published release directory is unavailable.');
  if(retained){manifest=await checkedSnapshot(destination,manifest,published);await removeStagingTree(directory);}
  else{await rename(directory,destination);manifest=await checkedSnapshot(destination,manifest,false);}
  const count=await descriptorCount(join(root,'releases'));
  if(count>=RELEASE_LIMITS.releases&&!published)throw new Error('Release capacity is full; protected releases were not removed.');
  if(!published)await atomicJson(descriptor,{runtimeDigest:manifest.runtimeDigest});return {directory:destination,manifest};
}
/** Staging reads checked source and copies real bytes. It never changes the selected release. */
export async function stageRelease(sourceRoot:string,stateDir:string,options:{ownerProtocol:string;allowDirty?:boolean}):Promise<{directory:string;manifest:ReleaseManifest}> {
  const source=resolve(sourceRoot),{root}=await releaseRoot(stateDir),revision=await sourceRevision(source,options.allowDirty);
  await assertBrowserAssetsFresh(source);
  await mkdir(join(root,'releases'),{recursive:true,mode:0o700});await descriptorCount(join(root,'releases'));
  const runtimeSource=join(source,'node_modules'),dependencies=(await inventory(runtimeSource,true)).sort((a,b)=>a.path.localeCompare(b.path));
  const lockDigest=sha256(await boundedFile(join(source,'package-lock.json'),16*1024**2)),runtimeDigest=await dependencyDigest(runtimeSource,dependencies),runtime=join(root,'runtimes',runtimeDigest);
  await mkdir(join(root,'runtimes'),{recursive:true,mode:0o700});const snapshot=await snapshotInputs(source);await reserveCapacity(root,runtime,dependencies,snapshot.bytes);await ensureRuntime(root,runtime,runtimeSource,dependencies,runtimeDigest);
  const directory=join(runtime,'releases',`.stage-${randomUUID()}`);
  try{await mkdir(directory,{mode:0o700});const files=await copySource(source,directory,snapshot.inputs),manifest=await buildManifest(directory,revision,runtimeDigest,lockDigest,files,options.ownerProtocol);return await publishSnapshot(root,runtime,directory,manifest);}
  catch(error){await removeStagingTree(directory).catch(()=>{});throw error;}
}
