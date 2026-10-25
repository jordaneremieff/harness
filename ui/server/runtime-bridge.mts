import {callRuntime,discoverRuntime} from '../../runtime/client.mts';
import {RUNTIME_PROTOCOL,readRequest,isReadOperation,RuntimeError,type RuntimeOperation} from '../../runtime/contract.mts';
import type {Registry} from './registry.mts';
import type {RequestContext} from './http.mts';
import {execute} from './dispatch.mts';
import {ApiError} from './errors.mts';
import {projectJson} from './projection.mts';
import * as v from './validate.mts';

export async function runtimeValue(registry:Registry,request:RuntimeOperation):Promise<unknown> {
  try {
    const response=await callRuntime(request,{agentDir:registry.options.agentStart?.agentDir});
    if(!response.ok)throw new RuntimeError(response.error.code,response.error.message,response.error.uncertain);
    return response.value;
  } catch(error) {
    if(error instanceof RuntimeError&&!error.uncertain)throw new ApiError(error.code,error.message,503,'read');
    throw error;
  }
}
export async function dispatchRuntime(registry:Registry,context:RequestContext) {
  if(context.method==='GET') {
    const descriptor=await discoverRuntime({agentDir:registry.options.agentStart?.agentDir});
    return {managementUrl:`${descriptor.privateOrigin??descriptor.origin}/runtime/`,health:await runtimeValue(registry,{operation:'health'})};
  }
  const body=context.body;v.fields(body,['request'],['request']);
  let request:RuntimeOperation;try{request=readRequest({protocol:RUNTIME_PROTOCOL,request:body.request});}catch{throw new ApiError('invalid_request','The runtime request is invalid.');}
  if(isReadOperation(request))return runtimeValue(registry,request);
  const workspaceId=await registry.workspace(context.workspace);
  return execute(registry,context.operationId,{workspaceId,kind:'runtime.control',body},async()=>({state:'completed',receipt:{kind:'rpc',result:projectJson(await runtimeValue(registry,request))}}));
}
