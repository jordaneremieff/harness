import assert from 'node:assert/strict';
import test from 'node:test';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {startBackend} from './main.mts';
import {createAgentService} from '../agents/index.mts';
const mainModule=pathToFileURL(fileURLToPath(new URL('./main.mts',import.meta.url))).href;
const stateModule=pathToFileURL(fileURLToPath(new URL('./state.mts',import.meta.url))).href;
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'ui-main-lifecycle-')),cwd=join(root,'project'),agent=join(root,'agent'),state=join(root,'state');
  await mkdir(cwd);await mkdir(agent);await mkdir(join(root,'agent-sessions'));return {root,cwd,agent,state};
}
const assets=new Map([['/',{type:'text/html; charset=utf-8',data:Buffer.from('<title>Fixture</title>') }]]);
function isolated(root:string,agent:string):Parameters<typeof startBackend>[1] {return {assets,agents:options=>createAgentService({...options,store:join(root,'agent-sessions'),agentDir:agent})};}
function ready(child:ReturnType<typeof fork>) {return new Promise<{kind:string;url:string}>((resolve,reject)=>{child.once('message',value=>resolve(value as {kind:string;url:string}));child.once('error',reject);child.once('exit',()=>reject(new Error('Child exited before readiness.')));});}

test('actual Registry startup recovers a proven dead owner and refuses a live owner', {timeout:15000},async context=> {
  const {root,cwd,agent,state}=await fixture();context.after(()=>rm(root,{recursive:true,force:true}));
  const module=join(root,'lock.mjs');await writeFile(module,`import {StateStore} from ${JSON.stringify(stateModule)};await StateStore.open(${JSON.stringify(state)});process.send({ready:true});`);
  const child=fork(module,[],{stdio:['ignore','ignore','ignore','ipc']});context.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  await ready(child);const options={cwd,port:0,pi:'pi',stateDir:state};
  await assert.rejects(()=>startBackend(options,isolated(root,agent)),/live or unknown/);
  const done=once(child,'exit');child.kill('SIGKILL');await done;
  const app=await startBackend(options,isolated(root,agent));context.after(()=>app.close());
  const lock=JSON.parse(await readFile(join(state,'lock.json'),'utf8'));assert.equal(lock.pid,process.pid);
  await app.close();assert.equal(await access(join(state,'lock.json')).then(()=>true,()=>false),false);
});

test('routine backend restart keeps open access and acknowledged workspace state', {timeout:15000},async context=> {
  const {root,cwd,agent,state}=await fixture();const apps:Awaited<ReturnType<typeof startBackend>>[]=[];
  context.after(async()=>{for(const app of apps)await app.close();await rm(root,{recursive:true,force:true});});
  const options={cwd,port:0,pi:'pi',stateDir:state};let app=await startBackend(options,isolated(root,agent));apps.push(app);
  assert.equal(new URL(app.url).hash,'');
  const w=await app.registry.store.workspace();await app.registry.store.updateSelection(w.id,{expectedRevision:w.revision,appearance:'light'});
  await assert.rejects(()=>access(join(state,'auth.json')),{code:'ENOENT'});await app.close();
  app=await startBackend(options,isolated(root,agent));apps.push(app);const response=await fetch(new URL(`/api/bootstrap?workspace=${w.id}`,app.url));
  assert.equal(response.status,200);const result=await response.json() as {data:{workspace:{appearance:string;revision:number}}};assert.equal(result.data.workspace.appearance,'light');assert.equal(result.data.workspace.revision,w.revision+1);
  const health=await fetch(new URL('/api/health',app.url));assert.equal(health.status,200);
});

test('a source restart before CLI startup completes closes the assigned backend once', {timeout:15000},async context=> {
  const {root,cwd,agent,state}=await fixture();
  const preload=join(root,'restart.mjs'),development=new URL('./development-build.mts',import.meta.url).href,generation=new URL('./asset-generations.mts',import.meta.url).href;
  await writeFile(preload,`import {DevelopmentBuild} from ${JSON.stringify(development)};import {AssetGeneration,AssetGenerations} from ${JSON.stringify(generation)};
    const assets=new Map([
      ['/',{type:'text/html',data:Buffer.from('<html><head><link rel="stylesheet" href="/style.css"><link rel="icon" href="/favicon.svg"></head><body><script type="module" src="/web/app.js"></script></body></html>')}],
      ['/style.css',{type:'text/css',data:Buffer.from('body{}')}],['/favicon.svg',{type:'image/svg+xml',data:Buffer.from('<svg/>')}],
      ['/web/app.js',{type:'text/javascript',data:Buffer.from("import '../shared/api.js';")}],['/shared/api.js',{type:'text/javascript',data:Buffer.from('export {};')}]
    ]);
    const generations=new AssetGenerations(new AssetGeneration(assets,new Map([['/web/app.js',['../shared/api.js']],['/shared/api.js',[]]])));
    DevelopmentBuild.open=async()=>({generations,build:{start(){generations.restartRequired();generations.restartRequired();},async close(){process.send?.({kind:'fixture-closed'});}}});`);
  const child=fork(fileURLToPath(mainModule),[],{execArgv:['--import',pathToFileURL(preload).href],stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_AGENT_SESSIONS_DIR:join(root,'agent-sessions')}});
  const done=once(child,'exit'),messages:string[]=[];child.on('message',value=>{messages.push((value as {kind:string}).kind);});
  context.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await done;await rm(root,{recursive:true,force:true});});
  let forced=false;const deadline=setTimeout(()=>{forced=true;child.kill('SIGKILL');},3000);
  context.after(()=>clearTimeout(deadline));
  child.send({kind:'start',options:{cwd,port:0,pi:'pi',stateDir:state,devReload:true}});
  const [code,signal]=await done;clearTimeout(deadline);
  assert.equal(forced,false,'The CLI must close without the supervisor kill deadline.');assert.equal(code,0);assert.equal(signal,null);
  assert.equal(messages.filter(kind=>kind==='restart').length,1);assert.equal(messages.filter(kind=>kind==='fixture-closed').length,1);
  assert.ok(messages.indexOf('restart')<messages.indexOf('ready'));
  assert.equal(await access(join(state,'lock.json')).then(()=>true,()=>false),false);
});

test('fatal rejection and exception stop admission, close state, and exit rather than continuing', {timeout:30000},async context=> {
  for(const kind of ['rejection','exception','signal']) {
    const {root,cwd,agent,state}=await fixture();const module=join(root,'fatal.mjs');
    await writeFile(module,`import {main} from ${JSON.stringify(mainModule)};await main(['--cwd',${JSON.stringify(cwd)},'--port','0','--state-dir',${JSON.stringify(state)}],undefined,{assets:new Map([['/',{type:'text/html',data:Buffer.from('<title>Fixture</title>')}]])});process.once('message',()=>{${kind==='exception'?'process.nextTick(()=>{throw Error("secret fatal payload")});':kind==='rejection'?'void Promise.reject(Error("secret fatal payload"));':''}});`);
    const child=fork(module,[],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_AGENT_SESSIONS_DIR:join(root,'agent-sessions')}});
    context.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});});
    const started=await ready(child);assert.equal(started.kind,'ready');const done=once(child,'exit');
    if(kind==='signal')child.kill('SIGTERM');else child.send({fault:true});
    const [code,signal]=await done;assert.equal(signal,null);assert.equal(code,kind==='signal'?0:1);
    assert.equal(await access(join(state,'lock.json')).then(()=>true,()=>false),false);
    const log=await readFile(join(state,'lifecycle.log'),'utf8');assert.equal(log.includes('secret fatal payload'),false);
    if(kind!=='signal')assert.match(log,/fatal/);
    await assert.rejects(()=>fetch(new URL('/api/bootstrap',started.url)));
  }
});
