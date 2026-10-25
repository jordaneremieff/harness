import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {HostManager,Instance} from '@earendil-works/chord/node';
import type {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {NamespaceRecovery,type RecoveryManagerFactory} from './namespace-recovery.mts';
import {SessionSources,type SourcePlacement} from './sessions.mts';
import {Authentication} from './auth.mts';
import {serveRuntime} from './http.mts';
import {callRuntime} from './client.mts';

test('a failed retained recovery owner does not block another namespace, configuration or authentication',async t=>{
  const root=await realpath(await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rr-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const options={agentDir:root,stateDir:root,cwd:root,sourceRoot:root,uiStateDir:join(root,'ui'),env:{},network:{port:0}};
  const placements:SourcePlacement[]=[{format:'runtime.source/1',root:join(root,'native-old'),sourceRoot:'/sealed-old',packageDir:'/dependencies-old'},{format:'runtime.source/1',root:join(root,'native-new'),sourceRoot:'/sealed-new',packageDir:'/dependencies-new'}];
  const sources=new SessionSources(options);sources.list=async()=>({roots:placements,complete:true});sources.selectedSources=async()=>placements.map(({root,sourceRoot,packageDir})=>({root,sourceRoot,packageDir}));
  const started:string[]=[],stopped:string[]=[];
  const factory:RecoveryManagerFactory=(source,_options,existingSources)=>{
    assert.deepEqual(existingSources,placements.filter(value=>value.root!==source.root).map(({root,sourceRoot,packageDir})=>({root,sourceRoot,packageDir})));
    let state:HostManager['status']='stopped';
    return {get status(){return state;},instance:undefined,liveness:{booting:false,activeCalls:0,viewers:0,durableTasks:1,idleFor:0},start:async()=>{started.push(source.sourceRoot);if(source.sourceRoot==='/sealed-old')throw new Error('Private provider diagnostics must not escape');state='running';return {} as Instance;},stop:async()=>{state='stopped';stopped.push(source.sourceRoot);},replace:async()=>{throw new Error('No replacement required');}};
  };
  const recovery=new NamespaceRecovery(sources,options,factory),authentication=new Authentication(async()=>({getProviders:()=>[],listCredentials:async()=>[]} as unknown as ModelRuntime));
  const runtime=await serveRuntime(options,{sessions:sources,recovery,authentication});t.after(()=>runtime.close());
  await recovery.refresh();await Promise.resolve();assert.deepEqual(new Set(started),new Set(['/sealed-old','/sealed-new']));
  assert.equal(recovery.status().owners.find(owner=>owner.sourceRoot==='/sealed-old')?.error,'recovery_owner_unavailable');assert.equal(recovery.status().owners.find(owner=>owner.sourceRoot==='/sealed-new')?.state,'running');
  assert.equal(JSON.stringify(recovery.status()).includes('Private provider'),false);
  assert.equal((await fetch(`${runtime.descriptor.origin}/runtime/`)).status,200);
  assert.equal((await callRuntime({operation:'auth.status'},{stateDir:root})).ok,true);
  assert.equal((await callRuntime({operation:'config.validate',target:'runtime',values:{port:4320}},{stateDir:root})).ok,true);
  await runtime.close();assert.deepEqual(new Set(stopped),new Set(['/sealed-old','/sealed-new']));
});
test('Chord restores each retained source-bound recovery process after management replacement', {timeout:20000},async t=>{
  const root=await realpath(await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rr-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const options={agentDir:root,stateDir:root,cwd:root,sourceRoot:root},placements:SourcePlacement[]=[];
  const helper=`import {childControl} from ${JSON.stringify(import.meta.resolve('@earendil-works/chord/node'))};import {writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';const metadata=JSON.parse(process.argv[2]);const control=childControl();await control.init;await control.lock();await writeFile(join(metadata.root,'owner-ready.json'),JSON.stringify({...metadata,sourceRoot:resolve(fileURLToPath(new URL('../../',import.meta.url))),incarnation:randomUUID()}));const stop=()=>process.exit(0);control.onShutdown(stop);process.once('disconnect',stop);control.ready();control.report({durableTasks:1});`;
  for(const name of ['first','second']) {
    const sourceRoot=join(root,name),nativeRoot=join(root,`${name}-native`),packageDir=join(root,`${name}-dependencies`);await mkdir(join(sourceRoot,'extensions','agent'),{recursive:true});await mkdir(nativeRoot);await mkdir(packageDir);
    await writeFile(join(sourceRoot,'extensions','agent','namespace-recovery.ts'),helper);placements.push({format:'runtime.source/1',root:nativeRoot,sourceRoot,packageDir});
  }
  const sources=new SessionSources(options);sources.list=async()=>({roots:placements,complete:true});sources.selectedSources=async()=>placements.map(({root,sourceRoot,packageDir})=>({root,sourceRoot,packageDir}));
  const first=new NamespaceRecovery(sources,options);t.after(()=>first.close());await first.refresh();assert.equal(first.status().owners.every(owner=>owner.state==='running'),true);
  const retained=await Promise.all(placements.map(async source=>JSON.parse(await readFile(join(source.root,'owner-ready.json'),'utf8')) as {sourceRoot:string;packageDir:string;incarnation:string}));
  for(let index=0;index<placements.length;index++){assert.equal(retained[index].sourceRoot,placements[index].sourceRoot);assert.equal(retained[index].packageDir,placements[index].packageDir);}
  await first.close();const replacement=new NamespaceRecovery(sources,options);t.after(()=>replacement.close());await replacement.refresh();assert.equal(replacement.status().owners.every(owner=>owner.state==='running'),true);
  for(let index=0;index<placements.length;index++){const ready=JSON.parse(await readFile(join(placements[index].root,'owner-ready.json'),'utf8'));assert.notEqual(ready.incarnation,retained[index].incarnation);assert.equal(ready.packageDir,placements[index].packageDir);}
});
