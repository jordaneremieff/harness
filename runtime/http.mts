import {createServer,type IncomingMessage,type ServerResponse,type Server} from 'node:http';
import {chmod,mkdir,realpath,rename,unlink,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {processLock} from '@earendil-works/chord/node';
import {RUNTIME_PROTOCOL,REQUEST_BYTES,RESPONSE_BYTES,RuntimeError,type RuntimeConfig,type RuntimeDescriptor,type RuntimeResponse} from './contract.mts';
import {validateRuntimeConfig} from './config.mts';
import {validateEntrypoint,secureResponse} from './boundary.mts';
import {recoveryHtml,recoveryCss,recoveryJs} from './recovery.mts';
import {ManagementService,type ManagementOptions,type ManagementDomains} from './service.mts';

export type ServeOptions = ManagementOptions & {network?:RuntimeConfig};
function send(response:ServerResponse,value:RuntimeResponse,status=200,mayMutate=false) {
  let body=JSON.stringify(value);if(Buffer.byteLength(body)>RESPONSE_BYTES){status=413;body=JSON.stringify({ok:false,error:{code:'response_limit',message:'The result exceeds the runtime response bound. Inspect the owning domain directly.',uncertain:mayMutate}});}
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(body);
}
async function body(request:IncomingMessage) {
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type']??''))throw new RuntimeError('invalid_request','The request must use JSON.');
  if(Number(request.headers['content-length']??0)>REQUEST_BYTES)throw new RuntimeError('request_limit','The request exceeds the runtime bound.');
  let size=0;const chunks:Buffer[]=[];
  for await(const part of request){size+=part.length;if(size>REQUEST_BYTES)throw new RuntimeError('request_limit','The request exceeds the runtime bound.');chunks.push(part);}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new RuntimeError('invalid_request','The request is not valid UTF-8 JSON.');}
}
function listen(server:Server,address:number|string):Promise<number> {
  return new Promise((accept,reject)=>{server.once('error',reject);const ready=()=>{server.off('error',reject);const bound=server.address();accept(typeof bound==='object'&&bound?bound.port:0);};if(typeof address==='string')server.listen(address,ready);else server.listen(address,'127.0.0.1',ready);});
}
async function close(server:Server) {server.closeIdleConnections();server.closeAllConnections();if(!server.listening)return;await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()));}
type Entrypoint = 'local'|'private'|'socket';
type RequestContext = {service:ManagementService;network:RuntimeConfig;origin:()=>string;admitted:()=>boolean};
const assets:Record<string,{type:string;value:string}>={
  '/':{type:'text/html',value:recoveryHtml},'/runtime':{type:'text/html',value:recoveryHtml},'/recovery.js':{type:'text/javascript',value:recoveryJs},'/recovery.css':{type:'text/css',value:recoveryCss},
};
async function routeRequest(context:RequestContext,kind:Entrypoint,request:IncomingMessage,response:ServerResponse) {
  validateEntrypoint(request,context.origin(),kind,context.network);
  if(!context.admitted())throw new RuntimeError('not_ready','The runtime listeners are not ready.');
  const path=new URL(request.url??'/','http://localhost').pathname;
  // Direct loopback access and the private path proxy require these two mount forms.
  const route=path.startsWith('/runtime/')?path.slice(8):path;
  const asset=Object.hasOwn(assets,route)?assets[route]:undefined;
  if(asset&&request.method==='GET'){response.writeHead(200,{'Content-Type':`${asset.type}; charset=utf-8`});response.end(asset.value);return;}
  if(route==='/health'&&request.method==='GET'){send(response,{ok:true,value:await context.service.health()});return;}
  if(route!=='/operation'||request.method!=='POST')throw new RuntimeError('not_found','The runtime route does not exist.');
  if(kind==='socket'&&request.headers['x-runtime-incarnation']!==context.service.incarnation)throw new RuntimeError('stale_runtime','The runtime process changed. Discover it again.');
  send(response,await context.service.call(await body(request)),200,true);
}
function handleRequest(context:RequestContext,kind:Entrypoint) {
  return async(request:IncomingMessage,response:ServerResponse)=> {
    secureResponse(response);
    try {await routeRequest(context,kind,request,response);}
    catch(error){send(response,{ok:false,error:error instanceof RuntimeError?{code:error.code,message:error.message,uncertain:error.uncertain}:{code:'runtime_unavailable',message:'The runtime request did not complete.',uncertain:request.method==='POST'}},error instanceof RuntimeError&&error.code==='forbidden'?403:400);request.resume();}
  };
}
/** No application assets, session admission or provider initialisation precedes this listener. */
export async function serveRuntime(options:ServeOptions,domains:Partial<ManagementDomains>={}) {
  await mkdir(options.stateDir,{recursive:true,mode:0o700});
  if(await realpath(options.stateDir)!==resolve(options.stateDir))throw new RuntimeError('invalid_config','The runtime state directory must be canonical.');
  const service=new ManagementService(options,domains);
  const configured=await service.domains.configuration.startup();
  const network=validateRuntimeConfig(options.network??configured.config);
  const socket=join(options.stateDir,'control.sock');if(Buffer.byteLength(socket)>103)throw new RuntimeError('invalid_config','The runtime state directory produces an unsupported socket path.');
  const release=await processLock(`harness-runtime:${resolve(options.stateDir)}`);
  const descriptorPath=join(options.stateDir,'service.json');
  const servers:Server[]=[];let localOrigin='',admission=false,descriptor:RuntimeDescriptor|undefined;
  const context:RequestContext={service,network,origin:()=>localOrigin,admitted:()=>admission};
  const handler=(kind:Entrypoint)=>handleRequest(context,kind);
  const make=(kind:'local'|'private'|'socket')=>{const server=createServer((req,res)=>{void handler(kind)(req,res);});server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=64;server.maxConnections=32;servers.push(server);return server;};
  try {
    const port=await listen(make('local'),network.port??4320);localOrigin=`http://127.0.0.1:${port}`;
    let privatePort:number|undefined;
    if(network.privateOrigin){if((network.privatePort??4321)===port)throw new RuntimeError('invalid_config','Private and local runtime ports must differ.');privatePort=await listen(make('private'),network.privatePort??4321);}
    await unlink(socket).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
    await listen(make('socket'),socket);await chmod(socket,0o600);
    descriptor={protocol:RUNTIME_PROTOCOL,pid:process.pid,incarnation:service.incarnation,origin:localOrigin,socket,startedAt:service.startedAt,...(network.privateOrigin?{privateOrigin:network.privateOrigin}: {})};
    const temporary=`${descriptorPath}.new`,file=await open(temporary,'w',0o600);try{await file.writeFile(JSON.stringify(descriptor));await file.sync();}finally{await file.close();}await rename(temporary,descriptorPath);admission=true;service.startRecovery();
    let closing:Promise<void>|undefined;
    const stop=()=>{closing??=(async()=>{admission=false;await Promise.all([service.close(),...servers.map(close)]);await unlink(socket).catch(()=>{});await unlink(descriptorPath).catch(()=>{});await release();})();return closing;};
    return {descriptor,privatePort,service,close:stop};
  }catch(error){await Promise.all([service.close(),...servers.map(close)]);await unlink(socket).catch(()=>{});await release();throw error;}
}
