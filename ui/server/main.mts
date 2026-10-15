import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Registry, type RegistryOptions } from './registry.mts';
import { LocalHttp, assetMap, type Asset } from './http.mts';
import {Files} from './files.mts';
import { ApiError } from './errors.mts';
import { DevelopmentBuild } from './development-build.mts';
import { DiagnosticDisk, DiagnosticSink } from './diagnostics.mts';
import { collectIdentity } from './version.mts';
import { identityLabel, type UiIdentity } from '../shared/version.ts';
import type {BackendHealthFacts} from '../shared/health.ts';
import {Auth} from './auth.mts';
import {LifecycleLog} from './lifecycle-log.mts';
import {supervise} from './supervisor.mts';

export type Options = {cwd: string; port: number; pi: string; stateDir?: string; open?: boolean; devReload?:boolean; devDiagnostics?:boolean};
/** CLI flags select process boundaries, never environment or arbitrary commands. */
export function parseArgs(args: string[], cwd = process.cwd()): Options {
  const result: Options = {cwd,port:4318,pi:'pi',open:false};
  const flags = new Set(['--cwd','--port','--pi','--state-dir']);
  for(let i=0;i<args.length;i+=1) {
    const flag=args[i];
    if(flag==='--open') {result.open=true;continue;}
    if(flag==='--dev-reload') {result.devReload=true;continue;}
    if(flag==='--dev-diagnostics') {result.devDiagnostics=true;continue;}
    const value=args[i+1];
    if(!flag || !flags.has(flag) || !value || value.startsWith('--')) throw new ApiError('invalid_request','Use --cwd, --port, --pi, and --state-dir with values, or --open, --dev-reload, and --dev-diagnostics.');
    assignFlag(result,flag,value);
    i+=1;
  }
  return result;
}
/** Opens a URL in the default macOS browser through the system opener, without a shell. */
export function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve,reject)=> {
    const child=spawn('open',[url],{stdio:'ignore'});
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(new Error(`The browser opener exited with code ${code}.`)));
  });
}
function assignFlag(result: Options, flag: string, value: string) {
  if(flag==='--cwd') result.cwd=resolve(value);
  if(flag==='--pi') result.pi=value;
  if(flag==='--state-dir') result.stateDir=resolve(value);
  if(flag==='--port') {
    const port=Number(value);
    if(!Number.isInteger(port)||port<0||port>65535) throw new ApiError('invalid_request','The port must be a local TCP port.');
    result.port=port;
  }
}
function expand(path: string) {return path==='~'?homedir():path.startsWith('~/')?join(homedir(),path.slice(2)):resolve(path);}
export function statePaths(environment:NodeJS.ProcessEnv=process.env) {
  const agentDir=environment.PI_CODING_AGENT_DIR?expand(environment.PI_CODING_AGENT_DIR):join(homedir(),'.pi','agent');
  const agentStore=environment.PI_AGENT_SESSIONS_DIR?expand(environment.PI_AGENT_SESSIONS_DIR):join(agentDir,'agent-sessions');
  return {agentDir,agentStore,stateDir:join(agentDir,'ui')};
}
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
/** Test injection changes adapters, not the public HTTP route or authentication surface. */
export async function startBackend(options:Options, injection:Partial<Pick<RegistryOptions,'agents'|'primary'|'measure'>> & {assets?:Map<string,Asset>; assetRoot?:string; identity?:UiIdentity; supervisorRestarts?:number; onRestart?:()=>void}={}) {
  const startedAt=new Date().toISOString(),paths=statePaths(),stateDir=options.stateDir??paths.stateDir;
  if(!isAbsolute(options.cwd)) throw new ApiError('invalid_request','The project directory must be absolute.');
  let development:Awaited<ReturnType<typeof DevelopmentBuild.open>>|undefined;
  let diagnostics:DiagnosticSink|undefined,log:LifecycleLog|undefined,auth:Auth|undefined;
  let startupRegistry:Registry|undefined,startupHttp:LocalHttp|undefined,files:Files|undefined;
  try {
    development=options.devReload?await DevelopmentBuild.open(injection.assetRoot):undefined;
    const assets=injection.assets??(development?new Map<string,Asset>():await assetMap(injection.assetRoot));
    const identity=injection.identity??await collectIdentity(assets,{root:injection.assetRoot?resolve(injection.assetRoot,'..'):undefined,assetRoot:injection.assetRoot,startedAt,build:development?.generations.identity()});
    const registry=await Registry.open({stateDir,cwd:options.cwd,executable:options.pi,agentStore:paths.agentStore,agents:injection.agents,primary:injection.primary,measure:injection.measure});startupRegistry=registry;
    auth=await Auth.open(stateDir);
    try {log=await LifecycleLog.open(stateDir);log.record('restart',`Supervisor replacements: ${injection.supervisorRestarts??0}.`);} catch {process.stderr.write('Local lifecycle logging is unavailable.\n');}
    if(options.devDiagnostics) {
      try {diagnostics=new DiagnosticSink(await DiagnosticDisk.open(stateDir),undefined,undefined,()=>development?.generations.status().generation);}
      catch {process.stderr.write('Local diagnostics are unavailable.\n');}
    }
    files=await Files.open(stateDir,()=>registry.fileIdentityFailed());
    files.observe((change,workspace)=>registry.journal.publish('files.changed',undefined,change,workspace));
    await registry.validatePath(options.cwd,true);
    let stopping=false,closing:Promise<void>|undefined,closedServices:Promise<PromiseSettledResult<void>[]>|undefined;
    const health=():BackendHealthFacts=>({startedAt,supervisorRestarts:injection.supervisorRestarts??0,
      services:serviceHealth(registry,files,stopping),
      build:{state:development?.generations.status().status??'static'}});
    const http=new LocalHttp(registry,assets,undefined,{generations:development?.generations,diagnostics,identity,files,health},auth);startupHttp=http;
    const launchUrl=await http.listen(options.port);
    development?.generations.observe(status=> {
      diagnostics?.emit({event:'reload',code:status.status==='failed'?'failed':status.status==='ready'?'applied':'deferred'},'build');
      if(status.status==='restart-required') injection.onRestart?.();
    });
    development?.build.start();diagnostics?.emit({event:'connection',code:'applied'});
    void registry.agents.refresh().catch(()=>registry.journal.publish('notice',undefined,{level:'warning',message:'The retained agent catalog is unavailable.',code:'catalog_unavailable'}));
    const close=()=>closing??=(async()=> {
      stopping=true;http.stopAdmission();registry.journal.close();log?.record('shutdown','Admission stopped; owned resources will close.');
      closedServices??=Promise.allSettled([http.close(),files?.close(),development?.build.close(),diagnostics?.close(),log?.close()]);
      const services=await closedServices,primaries=await Promise.allSettled([registry.close()]);
      const failed=[...primaries,...services].find(item=>item.status==='rejected');if(failed?.status==='rejected') throw failed.reason;
    })().catch(error=>{closing=undefined;throw error;});
    return {registry,http,launchUrl,identity,close,log};
  } catch(error) {
    await Promise.allSettled([files?.close(),startupHttp?.close(),auth?.close(),development?.build.close(),diagnostics?.close(),log?.close()]);
    await Promise.allSettled([startupRegistry?.close()]);throw error;
  }
}
export async function main(args=process.argv.slice(2), opener:(url:string)=>Promise<void>=openInBrowser,injection:Parameters<typeof startBackend>[1]&{announce?:(text:string)=>void}={}) {
  const options=parseArgs(args),app=await startBackend(options,injection);
  if(process.send) process.send({kind:'ready',launchUrl:app.launchUrl,identity:app.identity});
  else injection.announce?.(`${app.launchUrl}\n${identityLabel(app.identity)}\n`);
  if(options.open) await opener(app.launchUrl).catch(()=>process.stderr.write('The browser did not open; use the printed launch URL.\n'));
  let shutdownWork:Promise<void>|undefined;
  const detach=()=>{process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);process.off('unhandledRejection',rejection);process.off('uncaughtException',exception);};
  const close=async()=>{await app.close();detach();};
  const shutdown=()=>{shutdownWork??=close().then(()=>{if(process.connected) process.disconnect?.();}).catch(()=>{shutdownWork=undefined;process.stderr.write('The backend did not confirm an orderly primary exit.\n');process.exitCode=1;});};
  const fatal=(kind:string)=> {
    app.http.stopAdmission();app.log?.record('fatal',kind);
    const deadline=setTimeout(()=>process.exit(1),5000);deadline.unref();
    shutdownWork??=close();void shutdownWork.catch(()=>{}).finally(()=>{clearTimeout(deadline);process.exit(1);});
  };
  const rejection=()=>fatal('Unhandled rejection.'),exception=()=>fatal('Uncaught exception.');
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('unhandledRejection',rejection);process.on('uncaughtException',exception);
  return {...app,close};
}
async function cli() {
  if(process.send) {
    process.once('message',(message:{kind?:string;options?:Options;restarts?:number})=> {
      if(message.kind!=='start'||!message.options) {process.exitCode=1;return;}
      const options=message.options;
      const args=['--cwd',options.cwd,'--port',String(options.port),'--pi',options.pi];
      if(options.stateDir) args.push('--state-dir',options.stateDir);
      if(options.devReload) args.push('--dev-reload');if(options.devDiagnostics) args.push('--dev-diagnostics');
      let app:Awaited<ReturnType<typeof main>>|undefined,restartRequested=false;
      const finishRestart=()=>{if(app)void app.close().then(()=>process.exit(0),()=>process.exit(1));};
      void main(args,openInBrowser,{supervisorRestarts:message.restarts??0,onRestart:()=> {
        if(restartRequested)return;restartRequested=true;process.send?.({kind:'restart'});finishRestart();
      }}).then(value=>{app=value;if(restartRequested)finishRestart();},()=>{process.stderr.write('The backend failed to start.\n');process.exitCode=1;process.disconnect?.();});
    });return;
  }
  const options=parseArgs(process.argv.slice(2));let announced=false;
  const parent=supervise(options,{output:line=>process.stderr.write(`${line}\n`),ready:message=> {
    if(announced) return;announced=true;process.stdout.write(`${message.launchUrl}\n${identityLabel(message.identity)}\n`);
    if(options.open) void openInBrowser(message.launchUrl).catch(()=>process.stderr.write('The browser did not open; use the printed launch URL.\n'));
  }});
  const stop=()=>parent.stop(),fatal=()=>{process.exitCode=1;parent.stop();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('unhandledRejection',fatal);process.on('uncaughtException',fatal);
  const code=await parent.closed;process.exitCode=process.exitCode||code;
  process.off('SIGINT',stop);process.off('SIGTERM',stop);process.off('unhandledRejection',fatal);process.off('uncaughtException',fatal);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) void cli().catch(()=>{process.stderr.write('The backend failed to start.\n');process.exitCode=1;});
