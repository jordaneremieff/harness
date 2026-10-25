import {constants} from 'node:fs';
import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {SettingsManager} from '@earendil-works/pi-coding-agent';
import {exact,object,RuntimeError,text,type PiPreferences,type RuntimeConfig} from './contract.mts';

export type DocumentSnapshot = {digest:string;status:'valid'|'invalid'|'missing';value?:Record<string,unknown>;bytes?:Buffer};
export async function readDocument(path:string):Promise<DocumentSnapshot> {
  try {
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      if(!(await file.stat()).isFile())throw new RuntimeError('invalid_config','The configuration source is not a regular file.');
      const buffer=Buffer.alloc(131073);let length=0;
      while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
      const bytes=buffer.subarray(0,length),digest=createHash('sha256').update(bytes).digest('hex');
      if(length>131072)return {digest,status:'invalid'};
      try {const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));return object(value)?{digest,status:'valid',value,bytes}:{digest,status:'invalid',bytes};}catch{return {digest,status:'invalid',bytes};}
    }finally{await file.close();}
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {digest:'missing',status:'missing'};throw new RuntimeError('config_unavailable','The configuration source is unavailable.');}
}
function validatePrivateOrigin(value:unknown) {
  const origin=text(value,'private origin');let url:URL;try{url=new URL(origin);}catch{throw new RuntimeError('invalid_config','The private origin is invalid.');}
  if(url.protocol!=='https:'||!url.hostname.endsWith('.ts.net')||url.hostname!==url.hostname.toLowerCase()||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==origin)throw new RuntimeError('invalid_config','Use an exact HTTPS ts.net origin.');
}
function validateStringList(value:unknown,name:string) {
  if(!Array.isArray(value)||value.length>256)throw new RuntimeError('invalid_config','A resource path list is invalid.');
  for(const item of value)text(item,name);
}
export function validateRuntimeConfig(value:unknown):RuntimeConfig {
  if(!object(value))throw new RuntimeError('invalid_config','Runtime settings must be an object.');
  exact(value,['port','privatePort','privateOrigin','privateOwnerLogin']);
  for(const key of ['port','privatePort'])if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||(value[key] as number)<0||(value[key] as number)>65535))throw new RuntimeError('invalid_config','A runtime port is invalid.');
  if(value.privateOrigin!==undefined)validatePrivateOrigin(value.privateOrigin);
  if(value.privateOwnerLogin!==undefined&&(typeof value.privateOwnerLogin!=='string'||!value.privateOwnerLogin.length||value.privateOwnerLogin.length>254||!/^[\x21-\x7e]+$/.test(value.privateOwnerLogin)||/[,;\\]/.test(value.privateOwnerLogin)))throw new RuntimeError('invalid_config','The private owner login is invalid.');
  if((value.privateOrigin===undefined)!==(value.privateOwnerLogin===undefined)||value.privatePort!==undefined&&value.privateOrigin===undefined)throw new RuntimeError('invalid_config','Private origin and owner login are required together.');
  return structuredClone(value) as RuntimeConfig;
}
export function validatePiPreferences(value:unknown):PiPreferences {
  if(!object(value))throw new RuntimeError('invalid_config','Pi preferences must be an object.');
  exact(value,['defaultProvider','defaultModel','defaultThinkingLevel','enabledModels','extensions','skills','prompts','themes','autoCompaction','autoRetry']);
  for(const key of ['defaultProvider','defaultModel'])if(value[key]!==undefined)text(value[key],key,256);
  if(value.defaultThinkingLevel!==undefined&&!['off','minimal','low','medium','high','xhigh','max'].includes(String(value.defaultThinkingLevel)))throw new RuntimeError('invalid_config','The default thinking level is invalid.');
  for(const key of ['enabledModels','extensions','skills','prompts','themes'])if(value[key]!==undefined)validateStringList(value[key],key);
  for(const key of ['autoCompaction','autoRetry'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw new RuntimeError('invalid_config','A Pi preference flag is invalid.');
  return structuredClone(value) as PiPreferences;
}
function runtimeEnvironment(env:Readonly<Record<string,string|undefined>>) {
  const values:Record<string,unknown>={};
  for(const [key,name]of Object.entries({port:'PI_RUNTIME_PORT',privatePort:'PI_RUNTIME_PRIVATE_PORT',privateOrigin:'PI_RUNTIME_PRIVATE_ORIGIN',privateOwnerLogin:'PI_RUNTIME_PRIVATE_OWNER_LOGIN'})) {
    const raw=env[name];if(raw===undefined)continue;
    values[key]=key.endsWith('Port')||key==='port'?/^\d+$/.test(raw)?Number(raw):NaN:raw;
  }
  return values;
}
function piReplacement(p:PiPreferences):Record<string,unknown> {
  const replacement:Record<string,unknown>={...p};delete replacement.autoCompaction;delete replacement.autoRetry;
  if(p.autoCompaction!==undefined)replacement.compaction={enabled:p.autoCompaction};if(p.autoRetry!==undefined)replacement.retry={enabled:p.autoRetry};
  return replacement;
}
function setPiPreferences(s:SettingsManager,p:PiPreferences) {
  if(p.defaultProvider!==undefined)s.setDefaultProvider(p.defaultProvider);if(p.defaultModel!==undefined)s.setDefaultModel(p.defaultModel);
  if(p.defaultThinkingLevel!==undefined)s.setDefaultThinkingLevel(p.defaultThinkingLevel);if(p.enabledModels!==undefined)s.setEnabledModels(p.enabledModels);
  if(p.extensions!==undefined)s.setExtensionPaths(p.extensions);if(p.skills!==undefined)s.setSkillPaths(p.skills);if(p.prompts!==undefined)s.setPromptTemplatePaths(p.prompts);if(p.themes!==undefined)s.setThemePaths(p.themes);
  if(p.autoCompaction!==undefined)s.setCompactionEnabled(p.autoCompaction);if(p.autoRetry!==undefined)s.setRetryEnabled(p.autoRetry);
}
export class Configuration {
  readonly harnessPath:string;
  readonly piPath:string;
  readonly agentDir:string;readonly cwd:string;readonly env:Readonly<Record<string,string|undefined>>;
  constructor(agentDir:string,cwd:string,env:Readonly<Record<string,string|undefined>>=process.env) {
    this.agentDir=agentDir;this.cwd=cwd;this.env=env;
    if(!isAbsolute(agentDir)||!isAbsolute(cwd))throw new RuntimeError('invalid_config','Runtime directories must be absolute.');
    this.harnessPath=resolve(agentDir,env.PI_HARNESS_FILE??'harness.json');this.piPath=join(agentDir,'settings.json');
  }
  async startup():Promise<{config:RuntimeConfig;valid:boolean}> {
    const source=await readDocument(this.harnessPath).catch(()=>({digest:'unavailable',status:'invalid' as const}));
    try {
      if(source.status==='invalid'||source.value&&source.value.version!==1)throw new Error('invalid');
      const section=source.value?.runtime??{};if(!object(section))throw new Error('invalid');
      const selected={...section,...runtimeEnvironment(this.env)};
      return {config:validateRuntimeConfig(selected),valid:true};
    }catch{return {config:{},valid:false};}
  }
  async inspect(target:'runtime'|'pi') {
    const source=await readDocument(target==='runtime'?this.harnessPath:this.piPath);
    let values:RuntimeConfig|PiPreferences|undefined;
    try {
      if(target==='runtime') {if(source.value&&source.value.version!==1)throw new Error('invalid');values=validateRuntimeConfig(source.value?.runtime??{});}
      else if(source.status!=='invalid') {
        const s=SettingsManager.create(this.cwd,this.agentDir,{projectTrusted:false});const raw=s.getGlobalSettings();
        values={defaultProvider:raw.defaultProvider,defaultModel:raw.defaultModel,defaultThinkingLevel:raw.defaultThinkingLevel,enabledModels:raw.enabledModels,extensions:s.getExtensionPaths(),skills:s.getSkillPaths(),prompts:s.getPromptTemplatePaths(),themes:s.getThemePaths(),autoCompaction:s.getCompactionEnabled(),autoRetry:s.getRetryEnabled()};
      }
    }catch{return {digest:source.digest,status:'invalid',values:null};}
    return {digest:source.digest,status:source.status,values:values??null};
  }
  /** Replace only an invalid document after explicit confirmation; retain its complete bytes privately. */
  async repair(target:'runtime'|'pi',values:unknown,expectedDigest:string) {
    const checked=target==='runtime'?validateRuntimeConfig(values):validatePiPreferences(values),path=target==='runtime'?this.harnessPath:this.piPath;
    const source=await readDocument(path);
    if(source.digest!==expectedDigest)throw new RuntimeError('stale_config','The configuration changed. Read it again.');
    if(source.status!=='invalid'||!source.bytes)throw new RuntimeError('repair_refused','Repair replaces only a bounded invalid document. Use field changes for a valid document.');
    const backups=join(this.agentDir,'runtime','config-backups');await mkdir(backups,{recursive:true,mode:0o700});
    const backupId=`${target}-${source.digest}`,backup=await open(join(backups,`${backupId}.json`),'wx',0o600).catch(error=>{if((error as NodeJS.ErrnoException).code==='EEXIST')return undefined;throw error;});
    if(backup)try{await backup.writeFile(source.bytes);await backup.sync();}finally{await backup.close();}
    const replacement=target==='runtime'?{version:1,runtime:checked}:piReplacement(checked as PiPreferences);
    const temporary=join(dirname(path),`.runtime-repair-${randomUUID()}`),file=await open(temporary,'wx',0o600);
    try{await file.writeFile(`${JSON.stringify(replacement,null,2)}\n`);await file.sync();}finally{await file.close();}
    try{if((await readDocument(path)).digest!==expectedDigest)throw new RuntimeError('stale_config','The configuration changed.');await rename(temporary,path);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
    return {repaired:true,backupId,scope:'The invalid document was replaced with supported values. Other original bytes remain in the private backup.',snapshot:await this.inspect(target)};
  }
  async apply(target:'runtime'|'pi',values:unknown,expectedDigest:string|undefined) {
    const checked=target==='runtime'?validateRuntimeConfig(values):validatePiPreferences(values);
    if(!expectedDigest)throw new RuntimeError('stale_config','Read the configuration digest before a change.');
    const path=target==='runtime'?this.harnessPath:this.piPath,source=await readDocument(path);
    if(source.digest!==expectedDigest)throw new RuntimeError('stale_config','The configuration changed. Read it again.');
    if(source.status==='invalid'||target==='runtime'&&source.value&&source.value.version!==1)throw new RuntimeError('invalid_config','The source is invalid. Restore a valid document before a field change.');
    if(target==='runtime') {
      const value={...(source.value??{version:1}),runtime:checked};
      await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=join(dirname(path),`.runtime-config-${randomUUID()}`);const file=await open(temp,'wx',0o600);
      try{await file.writeFile(`${JSON.stringify(value,null,2)}\n`);await file.sync();}finally{await file.close();}
      try{if((await readDocument(path)).digest!==expectedDigest)throw new RuntimeError('stale_config','The configuration changed.');await rename(temp,path);}catch(error){await unlink(temp).catch(()=>{});throw error;}
      return {applied:true,activation:'next-runtime-start',snapshot:await this.inspect(target)};
    }
    const p=checked as PiPreferences,s=SettingsManager.create(this.cwd,this.agentDir,{projectTrusted:false});
    setPiPreferences(s,p);
    await s.flush();if(s.drainErrors().length)throw new RuntimeError('config_write_failed','Pi did not confirm the preference write.',true);
    return {applied:true,activation:'new-services',snapshot:await this.inspect(target)};
  }
}
