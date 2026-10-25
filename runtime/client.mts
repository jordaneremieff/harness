import {request as httpRequest} from 'node:http';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {readDocument} from './config.mts';
import {object,RUNTIME_PROTOCOL,REQUEST_BYTES,RESPONSE_BYTES,RuntimeError,readRequest,type RuntimeDescriptor,type RuntimeOperation,type RuntimeResponse} from './contract.mts';

export type RuntimeClientOptions = {agentDir?:string;stateDir?:string;timeoutMs?:number};
export function runtimeDirectories(options:RuntimeClientOptions={}) {
  const agentDir=resolve(options.agentDir??process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent'));
  return {agentDir,stateDir:resolve(options.stateDir??join(agentDir,'runtime'))};
}
export async function discoverRuntime(options:RuntimeClientOptions={}):Promise<RuntimeDescriptor> {
  const {stateDir}=runtimeDirectories(options),source=await readDocument(join(stateDir,'service.json'));
  const d=source.value;
  if(source.status!=='valid'||!d||d.protocol!==RUNTIME_PROTOCOL||!Number.isSafeInteger(d.pid)||typeof d.incarnation!=='string'||!d.incarnation||typeof d.origin!=='string'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(d.origin)||d.socket!==join(stateDir,'control.sock')||typeof d.startedAt!=='string')throw new RuntimeError('runtime_unavailable','The independent runtime service is unavailable. Start its CLI or OS service.');
  return d as RuntimeDescriptor;
}
/** A lost response is uncertain. This client never retries a mutation. */
export async function callRuntime(request:RuntimeOperation,options:RuntimeClientOptions={}):Promise<RuntimeResponse> {
  readRequest({protocol:RUNTIME_PROTOCOL,request});
  const descriptor=await discoverRuntime(options),data=JSON.stringify({protocol:RUNTIME_PROTOCOL,request});
  if(Buffer.byteLength(data)>REQUEST_BYTES)throw new RuntimeError('request_limit','The runtime request exceeds its bound.');
  return new Promise((accept,reject)=> {
    let written=false;
    const call=httpRequest({socketPath:descriptor.socket,path:'/runtime/operation',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'X-Runtime-Incarnation':descriptor.incarnation}},response=> {
      let size=0;const chunks:Buffer[]=[];
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>RESPONSE_BYTES){call.destroy(new Error('response limit'));return;}chunks.push(chunk);});
      response.once('end',()=>{try {const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!object(value)||typeof value.ok!=='boolean'||!value.ok&&!object(value.error))throw new Error('Invalid runtime response');accept(value as RuntimeResponse);}catch{reject(new RuntimeError('runtime_unavailable','The runtime response is invalid or incomplete.',written));}});
      response.once('error',()=>reject(new RuntimeError('runtime_unavailable','The runtime response is unconfirmed. Read status before another change.',written)));
    });
    call.setTimeout(options.timeoutMs??120000,()=>call.destroy(new Error('deadline')));
    call.once('error',()=>reject(new RuntimeError('runtime_unavailable','The runtime connection ended without a confirmed result. Read status before another change.',written)));
    call.once('finish',()=>{written=true;});call.end(data);
  });
}
