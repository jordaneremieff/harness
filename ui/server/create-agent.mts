import type {Registry} from './registry.mts';
import type {RequestContext} from './http.mts';
import {runtimeValue} from './runtime-bridge.mts';
import {execute} from './dispatch.mts';
import {projectJson} from './projection.mts';
import * as v from './validate.mts';

/** The runtime owns source placement; the Agent owns native creation. */
export async function createAgent(registry:Registry,context:RequestContext) {
  const body=context.body;v.fields(body,['cwd','name','model','thinkingLevel','preset'],['cwd']);
  const cwd=await registry.validatePath(v.string(body.cwd,'working folder',4096),true);
  const patch:Record<string,string>={};
  for(const key of ['name','model','thinkingLevel','preset'])if(body[key]!==undefined)patch[key]=v.string(body[key],key,key==='model'?512:256);
  const workspace=await registry.workspace(context.workspace);
  return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.create',body},async()=>{
    const result=await runtimeValue(registry,{operation:'sessions.create',requestId:`ui:${context.operationId}`,cwd,...patch}) as {state:string;identity?:string;root?:string;sourceRoot?:string;packageDir?:string};
    if(result.state!=='completed'||!result.identity||!result.root||!result.sourceRoot||!result.packageDir)throw new Error('Native creation was not confirmed. Inspect its operation before another attempt.');
    try {await registry.addManagedRoot(result.root,result.sourceRoot,result.packageDir);await registry.agents.lookup([result.identity]);}
    catch {registry.journal.publish('notice',undefined,{level:'warning',message:'The native conversation exists. Its browser connection is not confirmed. Refresh agents before another creation.',code:'connection_unavailable'});}
    return {state:'completed',receipt:{kind:'rpc',result:projectJson(result)}};
  });
}
