import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs as parseFlags} from 'node:util';
import {LIMITS} from '../shared/api.ts';
import {CONTROL_LIMITS,CONTROL_ROUTES,controlText,readControlIntent,type ControlIntent,type ControlLayout,type ControlReceipt} from '../shared/control.ts';
import {readControlDescriptor} from '../server/control-discovery.mts';
import {statePaths} from '../server/state-paths.mts';

export const HELP=`Usage: node ui/cli/control.mts [--state-dir <private-state>] [--actor <label>] [--workspace <id>] layout|'<JSON-intent>'

layout lists workspace IDs and control state. With --workspace it returns the revision, layout and registered file-root metadata.
Other commands require an exact --workspace. Intents use closed JSON objects:
  {"action":"show","rootId":"root-id","path":"notes.md","preview":true,"paneId":"pane-1"}
  {"action":"split","paneId":"pane-1","axis":"x","view":{"kind":"primary"}}
  {"action":"focus","paneId":"pane-1","view":{"kind":"agent","identity":"exact-identity"}}
  {"action":"resize","splitId":"split-id","ratio":50}
  {"action":"swap","splitId":"split-id"}
  {"action":"notice","text":"Plain text"}
show.paneId, show.preview and focus.view are optional. A view is {kind:"primary"}, {kind:"agent",identity}, or {kind:"file",rootId,path,view?:"preview"}.
The default private state is <PI_CODING_AGENT_DIR or ~/.pi/agent>/ui. Discovery uses its owner-only control.json; the local API requires no credential.
Actor labels are supplied attribution, not verified authorship. This interface cannot send model input, write files, start hosts or control processes.
Mutations never retry. A missing acknowledgment is unconfirmed; read layout before another intent.
`;
export type ControlOptions={stateDir:string;workspaceId?:string;actor?:string;intent?:ControlIntent;help?:boolean};
export function parseArgs(args:string[],environment:NodeJS.ProcessEnv=process.env):ControlOptions {
  const {values,positionals,tokens}=parseFlags({args,allowPositionals:true,tokens:true,options:{'state-dir':{type:'string'},actor:{type:'string'},workspace:{type:'string'},help:{type:'boolean'}}});
  const names=tokens.filter(token=>token.kind==='option').map(token=>token.name);
  if(new Set(names).size!==names.length)throw new Error('Use each documented control flag at most once.');
  const options:ControlOptions={stateDir:statePaths(environment).stateDir};
  if(values.help){if(args.length!==1)throw new Error('Use --help by itself.');return {...options,help:true};}
  if(values['state-dir']!==undefined){if(!values['state-dir'])throw new Error('The state directory needs a value.');options.stateDir=resolve(values['state-dir']);}
  if(values.actor!==undefined)options.actor=controlText(values.actor,'actor',CONTROL_LIMITS.actorChars);
  if(values.workspace!==undefined)options.workspaceId=controlText(values.workspace,'workspace ID');
  if(positionals.length!==1)throw new Error('Supply one layout command or one JSON intent. Use --help for details.');
  if(positionals[0]!=='layout')options.intent=parseIntent(positionals[0] as string,options.workspaceId);
  return options;
}
function parseIntent(command:string,workspace:string|undefined):ControlIntent {
  if(!workspace)throw new Error('An exact --workspace is required for a presentation intent.');
  if(Buffer.byteLength(command)>CONTROL_LIMITS.payloadBytes)throw new Error('The control intent exceeds its byte bound.');
  let input:unknown;try {input=JSON.parse(command);}catch {throw new Error('Supply the intent as one JSON object argument.');}return readControlIntent(input);
}
class Refused extends Error {}
type Unconfirmed={state:'unconfirmed';code:'transport';message:string;requestId?:string};
export type ControlOutput=ControlLayout|ControlReceipt|Unconfirmed;
async function readResponse(response:Response):Promise<unknown> {
  const reader=response.body?.getReader();if(!reader)throw new Error('response');let size=0;const chunks:Uint8Array[]=[];
  try {while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>LIMITS.displayBytes)throw new Error('response');chunks.push(chunk.value);}}
  finally {await reader.cancel().catch(()=>{});}
  const raw=Buffer.concat(chunks);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
}
async function discoverControl(stateDir:string) {try {return await readControlDescriptor(stateDir);}catch {throw new Error('Private control discovery is unavailable. Check --state-dir and the backend.');}}
export async function runControl(options:ControlOptions,transport:typeof fetch=fetch):Promise<ControlOutput> {
  const descriptor=await discoverControl(options.stateDir);
  const signal=AbortSignal.timeout(CONTROL_LIMITS.cliMs);
  const call=async<T,>(path:string,body?:unknown):Promise<T>=> {
    const raw=body===undefined?undefined:JSON.stringify(body);if(raw&&Buffer.byteLength(raw)>CONTROL_LIMITS.payloadBytes)throw new Refused('The control request exceeds its byte bound.');
    const response=await transport(new URL(path,descriptor.origin),{method:body===undefined?'GET':'POST',headers:{Origin:descriptor.origin,'Content-Type':'application/json'},body:raw,redirect:'error',signal});
    const result=await readResponse(response) as {ok?:boolean;data?:T;error?:{code?:string}};
    if(!response.ok||result.ok!==true) {const code=typeof result.error?.code==='string'&&/^[a-z_]{1,64}$/.test(result.error.code)?result.error.code:'invalid_response';throw new Refused(`The control backend refused this request (${code}).`);}return result.data as T;
  };
  if(!options.intent) {try {return await call<ControlLayout>(`${CONTROL_ROUTES.layout}${options.workspaceId?`?workspace=${encodeURIComponent(options.workspaceId)}`:''}`);}catch(error){if(error instanceof Refused)throw error;throw new Error('The control layout read failed. Check the backend and private state directory.');}}
  let receipt:ControlReceipt|undefined;
  try {
    receipt=await call<ControlReceipt>(CONTROL_ROUTES.requests,{workspaceId:options.workspaceId,actor:options.actor,intent:options.intent});
    if(receipt.state!=='pending')return receipt;
    return await call<ControlReceipt>(`${CONTROL_ROUTES.requests}/${encodeURIComponent(receipt.requestId)}?wait=1`);
  } catch(error) {if(error instanceof Refused&&!receipt)throw error;return {state:'unconfirmed',code:'transport',message:'The browser result is not confirmed. Read layout before another intent.',...(receipt?{requestId:receipt.requestId}:{})};}
}
export async function main(args=process.argv.slice(2),io={out:(text:string)=>process.stdout.write(text),error:(text:string)=>process.stderr.write(text)}):Promise<number> {
  try {const options=parseArgs(args);if(options.help){io.out(HELP);return 0;}const output=await runControl(options);io.out(`${JSON.stringify(output)}\n`);if('state'in output&&output.state!=='applied'){io.error('The presentation result is not applied. Read layout before another intent; do not blindly retry.\n');return 2;}return 0;}
  catch(error) {io.error(`${error instanceof Error?error.message:'The control request failed.'}\n`);return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main().then(code=>{process.exitCode=code;});
