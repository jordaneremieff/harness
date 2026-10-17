import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getAgentDir, getPackageDir } from '@earendil-works/pi-coding-agent';
import type { Registry } from './registry.mts';
import type { RequestContext } from './http.mts';
import { savedContextCreatorPath } from './agent-start.mts';
import {publishedOrdinaryName} from './ordinary-presence.mts';
import { savedContext } from './saved-context.mts';
import { validateSessionProject } from './sessions.mts';
import { execute } from './dispatch.mts';
import {ApiError} from './errors.mts';
import { projectJson } from './projection.mts';
import * as v from './validate.mts';
import type { DispatchResult } from './operations.mts';

type Creation={state:'completed'|'uncertain'|'rejected';identity:string|null;name:string|null};
function creationReceipt(raw:unknown):Creation|undefined {
  if(!raw||typeof raw!=='object'||!('protocol'in raw)||raw.protocol!==1||!('state'in raw)||!('identity'in raw)||!('name'in raw))return;
  const{state,identity,name}=raw;
  if(state!=='completed'&&state!=='uncertain'&&state!=='rejected')return;
  if(identity!==null&&(typeof identity!=='string'||!/^[0-9a-f-]{36}$/.test(identity)))return;
  if(name!==null&&typeof name!=='string')return;
  return{state:state==='rejected'?'rejected':state==='completed'&&identity?'completed':'uncertain',identity,name};
}
/** An absent acknowledgment never causes an automatic native creation retry. */
async function create(runner:string,metadata:Record<string,unknown>,messages:unknown):Promise<Creation> {
  const unknown:Creation={state:'uncertain',identity:null,name:typeof metadata.name==='string'?metadata.name:null};
  return new Promise(resolveResult=> {
    const child=spawn(process.execPath,[runner,JSON.stringify(metadata)],{cwd:String(metadata.cwd),stdio:['pipe','pipe','pipe']});
    const chunks:Buffer[]=[];let bytes=0,done=false;
    const finish=(value:Creation)=>{if(done)return;done=true;clearTimeout(timer);resolveResult(value);};
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(unknown);},60000);
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(messages));
    child.stderr.on('data',()=>{});
    child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes<=65536)chunks.push(data);else{child.kill('SIGTERM');finish(unknown);}});
    child.once('error',()=>finish(unknown));
    child.once('close',code=>{
      try {
        finish(code===0?creationReceipt(JSON.parse(Buffer.concat(chunks).toString('utf8')))??unknown:unknown);
      } catch {finish(unknown);}
    });
  });
}
export async function convertSaved(registry:Registry,context:RequestContext) {
  const body=context.body;v.fields(body,['path','project','id','revision'],['path','project','id','revision']);
  const path=v.string(body.path,'saved session path',4096),project=v.string(body.project,'project',4096),id=v.string(body.id,'saved session identity',512),revision=v.string(body.revision,'saved revision',128);
  const workspace=await registry.workspace(context.workspace);
  return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.convert',body},async():Promise<DispatchResult>=> {
    if(await validateSessionProject(project,path)!==id)throw new ApiError('invalid_session','The saved session identity changed.',409,'manual');
    const agentDir=registry.options.agentStart?.agentDir??getAgentDir();
    const runner=await savedContextCreatorPath(agentDir);
    const saved=await savedContext({path,project,id,revision});
    const name=saved.nameDeclared?saved.name:await publishedOrdinaryName(registry.options.agentStore,id,path);
    if(name!==undefined&&Buffer.byteLength(name)>4096)throw new ApiError('conversion_unavailable','The actual name exceeds the native creation metadata bound.',413,'manual');
    const requestId=`saved-context:${context.operationId}:${createHash('sha256').update(revision).update(saved.digest).digest('hex')}`;
    const result=await create(runner,{protocol:1,root:registry.options.agentStore,agentDir,packageDir:getPackageDir(),cwd:project,sourceId:id,requestId,name},saved.messages);
    if(result.state==='rejected')return{state:'rejected',error:{code:'conversion_refused',message:'Native creation was refused before admission. Check the saved messages and configured creation model.',retry:'manual'}};
    return{state:result.state,receipt:{kind:'rpc',result:projectJson({...result,source:'saved-context',sourceId:id,sourceRevision:revision})},...(result.state==='uncertain'?{error:{code:'conversion_uncertain',message:'Native creation was not confirmed. Inspect the returned identity and this operation before another conversion.',retry:'manual' as const}}:{})};
  });
}
