import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Registry, type RegistryOptions } from './registry.mts';
import { LocalHttp, assetMap, type Asset } from './http.mts';
import {Files} from './files.mts';
import { ApiError,errorView } from './errors.mts';
import { DevelopmentBuild } from './development-build.mts';
import { DiagnosticDisk, DiagnosticSink } from './diagnostics.mts';
import { collectIdentity } from './version.mts';
import { identityLabel, type UiIdentity } from '../shared/version.ts';
import type {BackendHealthFacts} from '../shared/health.ts';
import {LifecycleLog,redactLifecycle} from './lifecycle-log.mts';
import {parseArgs, type Options} from './options.mts';
export {parseArgs} from './options.mts';
import {Control} from './control.mts';
import {ControlDiscovery} from './control-discovery.mts';
import {AssetGeneration, AssetGenerations} from './asset-generations.mts';
import {OwnerConnection} from './owner-client.mts';
import {manifestAt} from './release-store.mts';
import type {OwnerHello, OwnerStateIdentity} from '../shared/owner.ts';
import type {ReleaseManifest} from '../shared/release.ts';


/** Opens a URL in the default macOS browser through the system opener, without a shell. */
export function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve,reject)=> {
    const child=spawn('open',[url],{stdio:'ignore'});
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(new Error(`The browser opener exited with code ${code}.`)));
  });
}

import {statePaths} from './state-paths.mts';
function rpcHealth(registry:Registry):'ready'|'unavailable'|'stopped' {
  const sessions=[...registry.sessions.values()];
  if(sessions.some(session=>session.view.lifecycle==='failed'))return 'unavailable';
  if(sessions.some(session=>session.view.lifecycle==='ready'||session.view.lifecycle==='starting'))return 'ready';
  return 'stopped';
}
function serviceHealth(registry:Registry,files:Files|undefined,stopping:boolean):BackendHealthFacts['services'] {
  if(stopping)return [{name:'files',state:'stopped'},{name:'agents',state:'stopped'},{name:'rpc',state:'stopped'}];
  return [{name:'files',state:files?.available?'ready':'unavailable'},
    {name:'agents',state:registry.agents.available===false?'unavailable':'ready'},
    {name:'rpc',state:rpcHealth(registry)}];
}
type BackendRelease={directory:string;manifest:ReleaseManifest;previous?:string};
async function releaseGenerations(assets:Map<string,Asset>,release:BackendRelease):Promise<AssetGenerations> {
  const initial=new AssetGeneration(assets,new Map(Object.entries(release.manifest.imports)));let previous:AssetGeneration|undefined;
  if(release.previous){const manifest=await manifestAt(release.previous);previous=new AssetGeneration(await assetMap(resolve(release.previous,'ui')),new Map(Object.entries(manifest.imports)));}
  return new AssetGenerations(initial,previous);
}
function requireAbsoluteCwd(cwd:string):void {if(!isAbsolute(cwd))throw new ApiError('invalid_request','The project directory must be absolute.');}
/** Test injection changes adapters, not the public HTTP route or request boundary. */
export async function startBackend(options:Options, injection:Partial<Pick<RegistryOptions,'agents'|'primary'|'measure'|'connectOwner'>> & {assets?:Map<string,Asset>; assetRoot?:string; identity?:UiIdentity; supervisorRestarts?:number; onRestart?:()=>void; release?:{directory:string;manifest:ReleaseManifest;previous?:string}}={}) {
  const startedAt=new Date().toISOString(),paths=statePaths(),stateDir=options.stateDir??paths.stateDir;
  requireAbsoluteCwd(options.cwd);
  let development:Awaited<ReturnType<typeof DevelopmentBuild.open>>|undefined;
  let diagnostics:DiagnosticSink|undefined,log:LifecycleLog|undefined;
  let startupRegistry:Registry|undefined,startupHttp:LocalHttp|undefined,files:Files|undefined,control:Control|undefined,controlDiscovery:ControlDiscovery|undefined;
  try {
    const release = injection.release, assetRoot = release ? resolve(release.directory, 'ui') : injection.assetRoot;
    development=options.devReload&&!release?await DevelopmentBuild.open(assetRoot):undefined;
    const assets=injection.assets??(development?new Map<string,Asset>():await assetMap(assetRoot));
    let generations = development?.generations;
    if(release)generations=await releaseGenerations(assets,release);
    const identity=injection.identity??await collectIdentity(assets,{root:assetRoot?resolve(assetRoot,'..'):undefined,assetRoot,startedAt,build:generations?.identity(),release:release?.manifest});
    const registry=await Registry.open({stateDir,cwd:options.cwd,executable:options.pi,agentStore:paths.agentStore,agents:injection.agents,primary:injection.primary,measure:injection.measure,connectOwner:injection.connectOwner});startupRegistry=registry;
    try {log=await LifecycleLog.open(stateDir);log.record('restart',`Supervisor replacements: ${injection.supervisorRestarts??0}.`);} catch {process.stderr.write('Local lifecycle logging is unavailable.\n');}
    if(options.devDiagnostics) {
      try {diagnostics=new DiagnosticSink(await DiagnosticDisk.open(stateDir),undefined,undefined,()=>development?.generations.status().generation);}
      catch {process.stderr.write('Local diagnostics are unavailable.\n');}
    }
    files=await Files.open(stateDir,()=>registry.fileIdentityFailed());
    files.observe((change,workspace)=>registry.journal.publish('files.changed',undefined,change,workspace));
    await registry.validatePath(options.cwd,true);
    control=new Control(registry,files,log);controlDiscovery=new ControlDiscovery();registry.control=control;
    let stopping=false,closing:Promise<void>|undefined,closedServices:Promise<PromiseSettledResult<void>[]>|undefined;
    const health=():BackendHealthFacts=>({startedAt,supervisorRestarts:injection.supervisorRestarts??0,
      services:serviceHealth(registry,files,stopping),
      build:{state:generations?.status().status??'static'},
      ...(registry.options.owner ? {owner:{pid:process.ppid,incarnation:registry.options.owner.hello.ownerIncarnation,protocol:registry.options.owner.hello.protocol},backend:{pid:process.pid,...(release?{release:release.manifest.id}:{})}} : {})});
    const http=new LocalHttp(registry,assets,undefined,{generations,diagnostics,identity,files,health,control:{service:control}});startupHttp=http;
    const url=await http.listen(options.port);
    await controlDiscovery.publish(stateDir,http.boundary.origin,registry.journal.bootId);
    development?.generations.observe(status=> {
      diagnostics?.emit({event:'reload',code:status.status==='failed'?'failed':status.status==='ready'?'applied':'deferred'},'build');
      if(status.status==='restart-required') injection.onRestart?.();
    });
    development?.build.start();diagnostics?.emit({event:'connection',code:'applied'});
    void registry.agents.refresh().catch(()=>registry.journal.publish('notice',undefined,{level:'warning',message:'The retained agent catalog is unavailable.',code:'catalog_unavailable'}));
    const close=()=>closing??=(async()=> {
      stopping=true;http.stopAdmission();
      const controls=await Promise.allSettled([control?.close(),controlDiscovery?.close()]);
      registry.journal.close();log?.record('shutdown','Admission stopped; owned resources will close.');
      const primaries=await Promise.allSettled([registry.close()]);
      closedServices??=Promise.allSettled([http.close(),files?.close(),development?.build.close(),diagnostics?.close(),log?.close()]);
      const services=await closedServices;
      const failed=[...controls,...primaries,...services].find(item=>item.status==='rejected');if(failed?.status==='rejected') throw failed.reason;
    })().catch(error=>{closing=undefined;throw error;});
    let releaseAttempt=0,preparedRelease=false;
    const cancelRelease=()=>{releaseAttempt++;preparedRelease=false;http.resumeAdmission();};
    const prepareRelease=async()=> {
      const attempt=++releaseAttempt;
      await Promise.all([...registry.sessions.values()].filter(session => !session.client.exited).map(session => session.prepareDetach()));
      if(attempt!==releaseAttempt)throw new ApiError('not_ready','The release attempt was canceled.',503);
      await http.fence();
      if(attempt!==releaseAttempt){http.resumeAdmission();throw new ApiError('not_ready','The release attempt was canceled.',503);}
      preparedRelease=true;
    };
    const detach = async (prepared=false) => {
      if(prepared&&!preparedRelease)throw new ApiError('not_ready','The backend has no prepared release fence.',503);
      if(!prepared)await prepareRelease();
      stopping = true;
      await control?.close(); await controlDiscovery?.close();
      await http.close(); await registry.detach();
      await Promise.all([files?.close(), development?.build.close(), diagnostics?.close(), log?.close()]);
    };
    return {registry,http,url,identity,close,detach,prepareRelease,cancelRelease,log};
  } catch(error) {
    await Promise.allSettled([control?.close(),controlDiscovery?.close()]);
    await Promise.allSettled([files?.close(),startupHttp?.close(),development?.build.close(),diagnostics?.close(),log?.close()]);
    await Promise.allSettled([startupRegistry?.close()]);throw error;
  }
}
export async function main(args=process.argv.slice(2), opener:(url:string)=>Promise<void>=openInBrowser,injection:Parameters<typeof startBackend>[1]&{announce?:(text:string)=>void}={}) {
  const options=parseArgs(args),app=await startBackend(options,injection);
  if(process.send) process.send({kind:'ready',url:app.url,identity:app.identity});
  else injection.announce?.(`${app.url}\n${identityLabel(app.identity)}\n`);
  if(options.open) await opener(app.url).catch(()=>process.stderr.write('The browser did not open; use the printed local URL.\n'));
  let shutdownWork:Promise<void>|undefined;
  const detach=()=>{process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);process.off('unhandledRejection',rejection);process.off('uncaughtException',exception);};
  const close=async()=>{await app.close();detach();};
  const shutdown=()=>{shutdownWork??=(app.registry.options.owner ? app.detach() : close()).then(()=>{if(process.connected) process.disconnect?.();}).catch(()=>{shutdownWork=undefined;process.stderr.write('The backend did not confirm an orderly primary exit.\n');process.exitCode=1;});};
  const fatal=(kind:string)=> {
    app.http.stopAdmission();app.log?.record('fatal',kind);
    const deadline=setTimeout(()=>process.exit(1),5000);deadline.unref();
    shutdownWork??=app.registry.options.owner ? app.detach() : close();void shutdownWork.catch(()=>{}).finally(()=>{clearTimeout(deadline);process.exit(1);});
  };
  const rejection=()=>fatal('Unhandled rejection.'),exception=()=>fatal('Uncaught exception.');
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('unhandledRejection',rejection);process.on('uncaughtException',exception);
  return {...app,close};
}
function releaseBlockReason(error:unknown):{code:string;message:string}{
  const view=errorView(error),code=/^[a-z][a-z0-9_]{0,63}$/.test(view.code)?view.code:'internal';
  return {code,message:redactLifecycle(view.message)};
}
function shutdownBlockCode(error:unknown):string {
  if(error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code))return error.code;
  return 'handoff_blocked';
}
async function cli() {
  if (!process.send) {await main(); return;}
  type Start = {kind: string; options: Options; restarts?: number; owner?: boolean; ownerState?:OwnerStateIdentity; release?: {directory:string; manifest:ReleaseManifest; previous?:string}};
  let pending: Start | undefined, app: Awaited<ReturnType<typeof main>> | undefined, restartRequested = false;
  const connectOwner = (state: OwnerStateIdentity) => new Promise<OwnerConnection>((resolve, reject) => {
    const receive = (value: unknown) => {
      const message = value as {kind?: string; hello?: OwnerHello; error?: string};
      if (message.kind !== 'owner-hello') return;
      process.off('message', receive);
      if (!message.hello) reject(new Error(message.error ?? 'Owner attachment failed.')); else resolve(OwnerConnection.fromProcess(message.hello));
    };
    process.on('message', receive); process.send?.({kind: 'owner-connect', state});
  });
  const launch = async (message: Start) => {
    const options = message.options, args = ['--cwd',options.cwd,'--port',String(options.port),'--pi',options.pi];
    if (options.stateDir) args.push('--state-dir',options.stateDir);
    if (options.devReload) args.push('--dev-reload'); if (options.devDiagnostics) args.push('--dev-diagnostics');
    const finishRestart = () => {if (app) void (app.registry.options.owner ? app.detach() : app.close()).then(() => process.exit(0), () => process.exit(1));};
    app = await main(args, openInBrowser, {supervisorRestarts:message.restarts??0, release:message.release, ...(message.owner ? {connectOwner} : {}), onRestart:() => {
      if (restartRequested) return; restartRequested=true; process.send?.({kind:'restart'}); finishRestart();
    }});
    if (restartRequested) finishRestart();
  };
  const prewarm=async(message:Start)=>{
    if(!message.release)throw new Error('Prewarm requires a sealed release.');
    await manifestAt(message.release.directory,true);await assetMap(resolve(message.release.directory,'ui'));
    if(message.ownerState){const probe=await connectOwner(message.ownerState);try{const hello=await probe.request<OwnerHello>({kind:'hello'});if(hello.protocol!==message.release.manifest.ownerProtocol)throw new Error('The live owner protocol differs.');}finally{probe.close();}}
    process.send?.({kind:'prewarmed'});
  };
  const appControl=(kind:string)=>{
    if(!app)return;
    switch(kind){
      case 'drain':void app.prepareRelease().then(()=>process.send?.({kind:'fenced'}),error=>{
        const reason=releaseBlockReason(error);process.send?.({kind:'drain-blocked',...reason});
        app?.log?.record('unavailable',`Release drain refused (${reason.code}): ${error instanceof Error?error.message:reason.message}`);
        process.stderr.write(`Release drain refused (${reason.code}): ${reason.message}\n`);
      });break;
      case 'drain-cancel':app.cancelRelease();break;
      case 'detach':void app.detach(true).then(()=>{process.send?.({kind:'drained'});process.exit(0);},()=>{process.send?.({kind:'detach-failed'});process.exit(1);});break;
      case 'whole-stop':void app.close().then(()=>process.exit(0),error=>process.send?.({kind:'stop-blocked',code:shutdownBlockCode(error)}));break;
    }
  };
  process.on('message',(value:unknown)=>{
    const message=value as Start;
    switch(message.kind){
      case 'prewarm':pending=message;void prewarm(message).catch(()=>{process.send?.({kind:'prewarm-failed'});process.exit(1);});break;
      case 'activate':if(pending){const start=pending;pending=undefined;if(message.options)start.options=message.options;void launch(start).catch(()=>process.exit(1));}break;
      case 'start':if(message.options)void launch(message).catch(()=>{process.stderr.write('The backend failed to start.\n');process.exit(1);});break;
      default:appControl(message.kind);
    }
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) void cli().catch(()=>{process.stderr.write('The backend failed to start.\n');process.exitCode=1;});
