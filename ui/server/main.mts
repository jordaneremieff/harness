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
/** Test injection changes adapters, not the public HTTP route or authentication surface. */
export async function startBackend(options:Options, injection:Partial<Pick<RegistryOptions,'agents'|'primary'|'measure'>> & {assets?:Map<string,Asset>; assetRoot?:string; identity?:UiIdentity}={}) {
  const startedAt = new Date().toISOString();
  const paths=statePaths();
  if(!isAbsolute(options.cwd)) throw new ApiError('invalid_request','The project directory must be absolute.');
  const development=options.devReload?await DevelopmentBuild.open(injection.assetRoot):undefined;
  const assets=injection.assets??(development?new Map<string,Asset>():await assetMap(injection.assetRoot));
  const identity = injection.identity ?? await collectIdentity(assets, {root: injection.assetRoot ? resolve(injection.assetRoot, '..') : undefined, assetRoot: injection.assetRoot, startedAt, build: development?.generations.identity()});
  const stateDir=options.stateDir??paths.stateDir;
  const registry=await Registry.open({stateDir,cwd:options.cwd,executable:options.pi,agentStore:paths.agentStore,agents:injection.agents,primary:injection.primary,measure:injection.measure});
  let diagnostics:DiagnosticSink|undefined;
  if(options.devDiagnostics) {
    try {diagnostics=new DiagnosticSink(await DiagnosticDisk.open(stateDir),undefined,undefined,()=>development?.generations.status().generation);}
    catch {process.stderr.write('Local diagnostics are unavailable.\n');}
  }
  let startupHttp:LocalHttp|undefined;
  let files:Files|undefined;
  try {
    files = await Files.open(stateDir);
    await registry.validatePath(options.cwd,true);
    const http=new LocalHttp(registry,assets,undefined,{generations:development?.generations,diagnostics,identity,files});startupHttp=http;
    const launchUrl=await http.listen(options.port);
    development?.generations.observe(status=>{diagnostics?.emit({event:'reload',code:status.status==='failed'?'failed':status.status==='ready'?'applied':'deferred'},'build');});
    development?.build.start();diagnostics?.emit({event:'connection',code:'applied'});
    void registry.agents.refresh().catch(()=>registry.journal.publish('notice',undefined,{level:'warning',message:'The retained agent catalog is unavailable.',code:'catalog_unavailable'}));
    let closing:Promise<void>|undefined;
    let closedServices:Promise<PromiseSettledResult<void>[]>|undefined;
    const close=()=>closing??=(async()=> {
      http.stopAdmission();registry.journal.close();
      closedServices??=Promise.allSettled([http.close(),files?.close(),development?.build.close(),diagnostics?.close()]);
      const services = await closedServices;
      const primaries = await Promise.allSettled([registry.close()]);
      const failed=[...primaries,...services].find(item=>item.status==='rejected');if(failed?.status==='rejected') throw failed.reason;
    })().catch(error=> {closing=undefined;throw error;});
    return {registry,http,launchUrl,identity,close};
  } catch(error) {await Promise.allSettled([files?.close(),startupHttp?.close(),development?.build.close(),diagnostics?.close()]);await Promise.allSettled([registry.close()]);throw error;}
}
export async function main(args=process.argv.slice(2), opener: (url: string) => Promise<void> = openInBrowser, injection: Parameters<typeof startBackend>[1] = {}) {
  const options=parseArgs(args);
  const app=await startBackend(options, injection);
  process.stdout.write(`${app.launchUrl}\n${identityLabel(app.identity)}\n`);
  if(options.open) await opener(app.launchUrl).catch(()=>process.stderr.write('The browser did not open; use the printed launch URL.\n'));
  let closing=false;
  const shutdown=()=> {
    if(closing) return;closing=true;
    void app.close().then(()=> {process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);})
      .catch(()=> {closing=false;process.stderr.write('The backend did not confirm an orderly primary exit.\n');process.exitCode=1;});
  };
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  return app;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) void main().catch(error=> {
  process.stderr.write(error instanceof ApiError?`${error.message}\n`:'The backend failed to start.\n');process.exitCode=1;
});
