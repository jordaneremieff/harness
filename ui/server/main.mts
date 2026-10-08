import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Registry, type RegistryOptions } from './registry.mts';
import { LocalHttp, assetMap, type Asset } from './http.mts';
import { ApiError } from './errors.mts';

export type Options = {cwd: string; port: number; pi: string; stateDir?: string};
/** CLI flags select process boundaries, never environment or arbitrary commands. */
export function parseArgs(args: string[], cwd = process.cwd()): Options {
  const result: Options = {cwd,port:4318,pi:'pi'};
  const flags = new Set(['--cwd','--port','--pi','--state-dir']);
  for(let i=0;i<args.length;i+=2) {
    const flag=args[i]; const value=args[i+1];
    if(!flag || !flags.has(flag) || !value || value.startsWith('--')) throw new ApiError('invalid_request','Use --cwd, --port, --pi, and --state-dir with values.');
    assignFlag(result,flag,value);
  }
  return result;
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
export async function startBackend(options:Options, injection:Partial<Pick<RegistryOptions,'agents'|'primary'|'measure'>> & {assets?:Map<string,Asset>}={}) {
  const paths=statePaths();
  if(!isAbsolute(options.cwd)) throw new ApiError('invalid_request','The project directory must be absolute.');
  const registry=await Registry.open({stateDir:options.stateDir??paths.stateDir,cwd:options.cwd,executable:options.pi,agentStore:paths.agentStore,...injection});
  try {
    await registry.validatePath(options.cwd,true);
    const http=new LocalHttp(registry,injection.assets??await assetMap());
    const launchUrl=await http.listen(options.port);
    void registry.agents.refresh().catch(()=>registry.journal.publish('notice',undefined,{level:'warning',message:'The retained agent catalog is unavailable.',code:'catalog_unavailable'}));
    let closing:Promise<void>|undefined;
    const close=()=>closing??=(async()=> {
      http.stopAdmission();registry.journal.close();
      const result=await Promise.allSettled([registry.close(),http.close()]);
      const failed=result.find(item=>item.status==='rejected');if(failed?.status==='rejected') throw failed.reason;
    })();
    return {registry,http,launchUrl,close};
  } catch(error) {await registry.close().catch(()=>{});throw error;}
}
export async function main(args=process.argv.slice(2)) {
  const app=await startBackend(parseArgs(args));
  process.stdout.write(`${app.launchUrl}\n`);
  let closing=false;
  const shutdown=()=> {
    if(closing) return;closing=true;
    void app.close().catch(()=> {process.stderr.write('The backend did not confirm an orderly primary exit.\n');process.exitCode=1;});
  };
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  return app;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) void main().catch(error=> {
  process.stderr.write(error instanceof ApiError?`${error.message}\n`:'The backend failed to start.\n');process.exitCode=1;
});
