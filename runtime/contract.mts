import type {EvolutionOperation} from './evolution.mts';

export const RUNTIME_PROTOCOL = 'harness.runtime/1' as const;
export const REQUEST_BYTES = 131072;
export const RESPONSE_BYTES = 262144;
export type RuntimeConfig = {
  port?: number;
  privatePort?: number;
  privateOrigin?: string;
  privateOwnerLogin?: string;
};
export type PiPreferences = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
  enabledModels?: string[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  autoCompaction?: boolean;
  autoRetry?: boolean;
};
export type RuntimeOperation =
  | {operation:'health'|'diagnostics'}
  | {operation:'config.inspect'; target:'runtime'|'pi'}
  | {operation:'config.validate'|'config.apply'; target:'runtime'; values:RuntimeConfig; expectedDigest?:string}
  | {operation:'config.validate'|'config.apply'; target:'pi'; values:PiPreferences; expectedDigest?:string}
  | {operation:'config.repair';target:'runtime';values:RuntimeConfig;expectedDigest:string;confirm:true}
  | {operation:'config.repair';target:'pi';values:PiPreferences;expectedDigest:string;confirm:true}
  | {operation:'auth.status'}
  | {operation:'auth.login'; provider:string; type:'api_key'|'oauth'}
  | {operation:'auth.poll'|'auth.cancel'; flowId:string}
  | {operation:'auth.respond'; flowId:string; promptId:string; value:string}
  | {operation:'auth.logout'; provider:string}
  | {operation:'trust.inspect'; cwd:string}
  | {operation:'trust.set'; cwd:string; decision:boolean|null}
  | {operation:'resources.inspect'; cwd:string}
  | {operation:'packages.list'; cwd:string}
  | {operation:'packages.install'|'packages.remove'; cwd:string; source:string; local?:boolean}
  | {operation:'packages.update'; cwd:string; source?:string}
  | {operation:'sessions.create'; requestId:string; cwd:string; name?:string;model?:string;thinkingLevel?:string;preset?:string}
  | {operation:'sessions.source';identity:string}
  | {operation:'sessions.list'}
  | {operation:'lifecycle.status'|'lifecycle.start'|'lifecycle.stop'}
  | {operation:'release.status'|'release.stage'|'release.rollback'}
  | {operation:'release.switch'; releaseId:string}
  | EvolutionOperation;
export type RuntimeRequest = {protocol:typeof RUNTIME_PROTOCOL; request:RuntimeOperation};
export type RuntimeResponse = {ok:true; value:unknown}|{ok:false;error:{code:string;message:string;uncertain:boolean}};
export type RuntimeDescriptor = {protocol:typeof RUNTIME_PROTOCOL; pid:number; incarnation:string; origin:string; socket:string; startedAt:string; privateOrigin?:string};
export type RuntimeHealth = {protocol:typeof RUNTIME_PROTOCOL; incarnation:string; startedAt:string; pid:number; state:'ready'; configuration:'valid'|'invalid'; activeMutation:boolean};

export class RuntimeError extends Error {
  readonly code:string;readonly uncertain:boolean;
  constructor(code:string,message:string,uncertain=false) {super(message);this.code=code;this.uncertain=uncertain;}
}
export function object(value:unknown):value is Record<string,unknown> {return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
export function text(value:unknown,name:string,max=4096):string {
  if(typeof value!=='string'||!value.length||value.length>max||/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value))throw new RuntimeError('invalid_request',`The ${name} is invalid.`);
  return value;
}
export function exact(value:Record<string,unknown>,keys:readonly string[]) {
  if(Object.keys(value).some(key=>!keys.includes(key)))throw new RuntimeError('invalid_request','The request has unsupported fields.');
}
const requestFields:Record<string,string[]>={
    health:[],diagnostics:[],'config.inspect':['target'],'config.validate':['target','values','expectedDigest'],'config.apply':['target','values','expectedDigest'],'config.repair':['target','values','expectedDigest','confirm'],
    'auth.status':[],'auth.login':['provider','type'],'auth.poll':['flowId'],'auth.cancel':['flowId'],'auth.respond':['flowId','promptId','value'],'auth.logout':['provider'],
    'trust.inspect':['cwd'],'trust.set':['cwd','decision'],'resources.inspect':['cwd'],'packages.list':['cwd'],'packages.install':['cwd','source','local'],'packages.remove':['cwd','source','local'],'packages.update':['cwd','source'],
    'sessions.create':['requestId','cwd','name','model','thinkingLevel','preset'],'sessions.source':['identity'],'sessions.list':[],
    'lifecycle.status':[],'lifecycle.start':[],'lifecycle.stop':[],'release.status':[],'release.stage':[],'release.switch':['releaseId'],'release.rollback':[],
    'evolution.status':[],'evolution.sync':['sourceOnly'],'evolution.promotion-plan':['slices','full'],'evolution.promote-local':['slices','full'],'upstream.status':[],'upstream.update':[],
};
function validateConfigurationRequest(op:string,r:Record<string,unknown>) {
    if(!['runtime','pi'].includes(String(r.target)))throw new RuntimeError('invalid_request','The configuration target is invalid.');
    if(op!=='config.inspect'&&!object(r.values))throw new RuntimeError('invalid_request','Configuration values must be an object.');
    if(r.expectedDigest!==undefined&&!/^(?:missing|[a-f0-9]{64})$/.test(String(r.expectedDigest)))throw new RuntimeError('invalid_request','The configuration digest is invalid.');
    if(op==='config.apply'||op==='config.repair')text(r.expectedDigest,'configuration digest',64);
  if(op==='config.repair'&&r.confirm!==true)throw new RuntimeError('invalid_request','Invalid-document repair requires explicit confirmation.');
}
function validateAuthenticationRequest(op:string,r:Record<string,unknown>) {
  if(op==='auth.login'&&(!r.provider||!['api_key','oauth'].includes(String(r.type))))throw new RuntimeError('invalid_request','The login request is invalid.');
  if(op==='auth.respond'&&(typeof r.value!=='string'||r.value.length>16384||!r.promptId||!r.flowId))throw new RuntimeError('invalid_request','The login response is invalid.');
  if(['auth.poll','auth.cancel'].includes(op)&&!r.flowId||op==='auth.logout'&&!r.provider)throw new RuntimeError('invalid_request','The authentication identity is absent.');
}
function validateDomainRequest(op:string,r:Record<string,unknown>) {
  if((op.startsWith('trust.')||op.startsWith('packages.')||op==='resources.inspect'||op==='sessions.create')&&typeof r.cwd!=='string')throw new RuntimeError('invalid_request','A working folder is required.');
  if(op==='trust.set'&&r.decision!==null&&typeof r.decision!=='boolean')throw new RuntimeError('invalid_request','The trust decision is invalid.');
  if(['packages.install','packages.remove'].includes(op)&&!r.source)throw new RuntimeError('invalid_request','A package source is required.');
  if(r.local!==undefined&&typeof r.local!=='boolean'||r.full!==undefined&&typeof r.full!=='boolean')throw new RuntimeError('invalid_request','The flag is invalid.');
  if(op==='release.switch'&&!/^[a-f0-9]{64}$/.test(String(r.releaseId)))throw new RuntimeError('invalid_request','The release identity is invalid.');
}
function validateEvolutionRequest(op:string,r:Record<string,unknown>) {
  if(op==='evolution.sync'&&r.sourceOnly!==true)throw new RuntimeError('invalid_request','Source-only synchronisation is required.');
  if(op==='evolution.promotion-plan'||op==='evolution.promote-local') {
    if(!Array.isArray(r.slices)||!r.slices.length||r.slices.length>64||r.slices.some(item=>typeof item!=='string'||!/^[A-Za-z0-9_./-]{1,128}$/.test(item)))throw new RuntimeError('invalid_request','The slice selection is invalid.');
  }
}
function validateSessionRequest(op:string,r:Record<string,unknown>) {
  for(const [key,max]of Object.entries({requestId:1024,name:256,model:512,thinkingLevel:512,preset:512}))if(r[key]!==undefined)text(r[key],key,max);
  if(op==='sessions.create'&&(!r.requestId||!r.cwd))throw new RuntimeError('invalid_request','Creation needs a request identity and working folder.');
  if(op==='sessions.source'&&(!r.identity||!/^[a-zA-Z0-9-]+(?::[1-9][0-9]*)?$/.test(String(r.identity))))throw new RuntimeError('invalid_request','The conversation identity is invalid.');
}
export function readRequest(input:unknown):RuntimeOperation {
  if(!object(input)||input.protocol!==RUNTIME_PROTOCOL||!object(input.request))throw new RuntimeError('contract_mismatch','The runtime request contract is invalid.');
  exact(input,['protocol','request']);const r=input.request,op=text(r.operation,'operation',80);
  if(!Object.hasOwn(requestFields,op))throw new RuntimeError('unsupported','The runtime operation is unsupported.');exact(r,['operation',...requestFields[op]]);
  for(const key of ['provider','flowId','promptId','cwd','source','releaseId','requestId','identity','name','model','thinkingLevel','preset'])if(r[key]!==undefined)text(r[key],key);
  if(op.startsWith('config.'))validateConfigurationRequest(op,r);
  if(op.startsWith('auth.'))validateAuthenticationRequest(op,r);
  validateDomainRequest(op,r);validateEvolutionRequest(op,r);validateSessionRequest(op,r);
  return r as RuntimeOperation;
}
export function isReadOperation(request:RuntimeOperation) {
  return ['health','diagnostics','config.inspect','config.validate','auth.status','auth.poll','trust.inspect','resources.inspect','packages.list','lifecycle.status','sessions.source','sessions.list','release.status','evolution.status','evolution.promotion-plan','upstream.status'].includes(request.operation);
}
