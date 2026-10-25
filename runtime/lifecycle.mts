import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {join} from 'node:path';
import {realpath} from 'node:fs/promises';
import {RuntimeError} from './contract.mts';

export type LifecycleOptions = {sourceRoot:string;uiStateDir:string;cwd:string;agentDir:string;piExecutable?:string};
export type CommandResult = {exitCode:number|null;value:unknown;uncertain:boolean};
export type CommandRunner = (executable:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;timeoutMs:number})=>Promise<CommandResult>;
export const runCommand:CommandRunner=(executable,args,options)=>new Promise(resolve=>{
  execFile(executable,args,{cwd:options.cwd,env:options.env,timeout:options.timeoutMs,maxBuffer:262144,encoding:'utf8'},(error,stdout)=> {
    let value:unknown=null;try{value=JSON.parse(stdout);}catch{/* A missing receipt is not permission to repeat the command. */}
    resolve({exitCode:error?typeof error.code==='number'?error.code:null:0,value,uncertain:!!error&&(!('code' in error)||typeof error.code!=='number')});
  });
});
/** Native sessions remain Agent-owned. These controls address only the UI's existing supervisor. */
export class Lifecycle {
  private launch?:ChildProcess;
  readonly options:LifecycleOptions;private run:CommandRunner;private spawnChild:typeof spawn;
  constructor(options:LifecycleOptions,run:CommandRunner=runCommand,spawnChild:typeof spawn=spawn) {this.options=options;this.run=run;this.spawnChild=spawnChild;}
  async release(kind:'status'|'stage'|'switch'|'rollback'|'stop',releaseId?:string) {
    const {sourceRoot,uiStateDir,cwd,agentDir}=this.options;
    const args=[...(kind==='stage'?['--experimental-vm-modules']:[]),join(sourceRoot,'ui','cli','release.mts'),kind,'--state-dir',uiStateDir];
    if(kind==='stage')args.push('--source',await realpath(cwd));if(kind==='switch')args.push('--release',releaseId as string);
    const result=await this.run(process.execPath,args,{cwd,env:{...process.env,PI_CODING_AGENT_DIR:agentDir},timeoutMs:kind==='stage'?180000:65000});
    if(result.exitCode!==0)throw new RuntimeError('lifecycle_unavailable',result.uncertain?'The lifecycle result is unconfirmed. Inspect status before another action.':'The existing release command refused the action.',result.uncertain);
    return result.value;
  }
  async start() {
    const status=await this.release('status') as {state?:string};
    if(status?.state!=='stopped')return {started:false,status};
    if(this.launch&&this.launch.exitCode===null&&this.launch.signalCode===null)return {started:false,state:'starting'};
    const {sourceRoot,uiStateDir,cwd,agentDir,piExecutable}=this.options;
    const args=[join(sourceRoot,'ui','server','main.mts'),'--state-dir',uiStateDir,'--cwd',cwd,...(piExecutable?['--pi',piExecutable]:[])];
    const child=this.spawnChild(process.execPath,args,{cwd:sourceRoot,env:{...process.env,PI_CODING_AGENT_DIR:agentDir},detached:true,stdio:'ignore',shell:false});this.launch=child;
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new RuntimeError('lifecycle_unavailable','The UI launcher did not start.')));});
    child.unref();return {started:true,state:'starting',pid:child.pid,confirmation:'Read lifecycle.status to confirm readiness.'};
  }
}
