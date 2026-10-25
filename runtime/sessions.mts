import {createHash,randomUUID} from 'node:crypto';
import type {Dir} from 'node:fs';
import {mkdir,open,opendir,realpath,rename,stat,unlink} from 'node:fs/promises';
import {findPackageJSON} from 'node:module';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readDocument} from './config.mts';
import {object,RuntimeError,type RuntimeOperation} from './contract.mts';
import {runCommand,type CommandRunner} from './lifecycle.mts';

type Creation = Extract<RuntimeOperation,{operation:'sessions.create'}>;
export type NativeSource = {root:string;sourceRoot:string;packageDir:string};
export type SourcePlacement = NativeSource & {format:'runtime.source/1';existingSource?:NativeSource};
export type SessionSourcesOptions = {stateDir:string;sourceRoot:string;agentDir:string;existingSource?:NativeSource};
type Receipt = SourcePlacement & {requestId:string;digest:string;state:'reserved'|'completed'|'uncertain';identity?:string;name?:string|null};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function canonicalPath(value:unknown):value is string {return typeof value==='string'&&isAbsolute(value)&&value===resolve(value);}
export function validateNativeSource(value:unknown):NativeSource {
  if(!object(value)||!canonicalPath(value.root)||!canonicalPath(value.sourceRoot)||!canonicalPath(value.packageDir)||Object.keys(value).some(key=>!['root','sourceRoot','packageDir'].includes(key)))throw new RuntimeError('source_unavailable','The selected native source route is invalid.');
  return value as NativeSource;
}
function sameSource(first:NativeSource,second:Record<string,unknown>):boolean {return first.root===second.root&&first.sourceRoot===second.sourceRoot&&first.packageDir===second.packageDir;}
function allowedSource(placement:SourcePlacement,value:Record<string,unknown>):boolean {return sameSource(placement,value)||!!placement.existingSource&&sameSource(placement.existingSource,value);}
function checkedPlacement(value:unknown,name:string,stateDir:string):SourcePlacement {
  if(!object(value)||value.format!=='runtime.source/1'||!canonicalPath(value.sourceRoot)||!canonicalPath(value.packageDir)||value.root!==join(stateDir,'sessions',hash(value.sourceRoot))||name!==`${hash(value.sourceRoot)}.json`)throw new RuntimeError('source_unavailable','A source namespace record is invalid.');
  if(value.existingSource!==undefined)validateNativeSource(value.existingSource);
  return value as SourcePlacement;
}
function checkedReceipt(value:unknown,pathName:string,roots:SourcePlacement[]):Receipt {
  if(!object(value)||value.format!=='runtime.source/1'||typeof value.requestId!=='string'||pathName!==`${hash(value.requestId)}.json`||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest))throw new RuntimeError('source_unavailable','The native creation binding is invalid.');
  if(!roots.some(root=>allowedSource(root,value))||!['reserved','completed','uncertain'].includes(String(value.state)))throw new RuntimeError('source_unavailable','The retained source route is invalid.');
  if(value.identity!==undefined&&(typeof value.identity!=='string'||!/^[-a-zA-Z0-9]+$/.test(value.identity)))throw new RuntimeError('source_unavailable','The native creation identity is invalid.');
  if(value.state==='completed'&&!value.identity)throw new RuntimeError('source_unavailable','The completed native identity is absent.');
  return value as Receipt;
}
async function checkHelper(sourceRoot:string,name:string) {
  try {const path=join(sourceRoot,'extensions','agent',name);if(await realpath(path)!==path||!(await stat(path)).isFile())throw new Error('invalid');}
  catch{throw new RuntimeError('source_unavailable','The selected native source helper is unavailable.');}
}
/** Deployment metadata binds native namespaces to immutable source and dependencies, never copied conversation state. */
export class SessionSources {
  readonly options:SessionSourcesOptions;private run:CommandRunner;
  constructor(options:SessionSourcesOptions,run:CommandRunner=runCommand) {this.options=options;this.run=run;}
  private async placement():Promise<SourcePlacement> {
    const sourceRoot=await realpath(this.options.sourceRoot);if(sourceRoot!==resolve(this.options.sourceRoot))throw new RuntimeError('source_unavailable','The native source directory must be canonical.');
    await Promise.all(['create-conversation.ts','namespace-recovery.ts'].map(name=>checkHelper(sourceRoot,name)));
    const manifest=findPackageJSON('@earendil-works/pi-coding-agent',pathToFileURL(join(sourceRoot,'package.json')));
    if(!manifest)throw new RuntimeError('source_unavailable','The selected native dependency installation is absent.');
    const packageDir=await realpath(dirname(manifest)),generation=hash(sourceRoot),root=join(this.options.stateDir,'sessions',generation),directory=join(this.options.stateDir,'sources');
    const existingSource=this.options.existingSource===undefined?undefined:validateNativeSource(this.options.existingSource);
    await mkdir(directory,{recursive:true,mode:0o700});await mkdir(root,{recursive:true,mode:0o700});
    const placement:SourcePlacement={format:'runtime.source/1',sourceRoot,packageDir,root,...(existingSource?{existingSource}:{})};const path=join(directory,`${generation}.json`),previous=await readDocument(path);
    if(previous.status==='missing')await this.write(path,placement);else if(previous.status!=='valid'||JSON.stringify(previous.value)!==JSON.stringify(placement))throw new RuntimeError('source_conflict','The native namespace source binding changed.');
    return placement;
  }
  private async write(path:string,value:unknown) {
    await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=`${path}.${randomUUID()}`,file=await open(temporary,'wx',0o600);
    try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
    try{await rename(temporary,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}}catch(error){await unlink(temporary).catch(()=>{});throw error;}
  }
  async list() {
    await this.placement();const directory=await opendir(join(this.options.stateDir,'sources'),{bufferSize:1});let visits=0;const roots:SourcePlacement[]=[];
    for await(const entry of directory) {
      if(++visits>256)throw new RuntimeError('capacity','The source namespace inventory exceeds its bound.');
      if(!/^[a-f0-9]{64}\.json$/.test(entry.name)||!entry.isFile())throw new RuntimeError('source_unavailable','A source namespace record is invalid.');
      const record=await readDocument(join(this.options.stateDir,'sources',entry.name));
      if(record.status!=='valid')throw new RuntimeError('source_unavailable','A source namespace record is unreadable.');
      roots.push(checkedPlacement(record.value,entry.name,this.options.stateDir));
    }
    return {roots,complete:true};
  }
  async selectedSources():Promise<NativeSource[]> {
    const selected=new Map<string,NativeSource>();
    for(const placement of (await this.list()).roots)for(const value of [placement,placement.existingSource]) {
      if(!value)continue;
      const route={root:value.root,sourceRoot:value.sourceRoot,packageDir:value.packageDir},previous=selected.get(route.root);
      if(previous&&!sameSource(previous,route))throw new RuntimeError('source_conflict','A retained root has conflicting source routes.');
      selected.set(route.root,route);
    }
    if(selected.size>256)throw new RuntimeError('capacity','The selected native route inventory exceeds its bound.');
    return [...selected.values()];
  }
  async source(identity:string) {
    const namespaces=await this.list(),storageId=identity.split(':')[0],directory=join(this.options.stateDir,'bindings');
    let entries:Dir;try{entries=await opendir(directory,{bufferSize:1});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {state:'absent' as const};throw error;}
    let visits=0;
    for await(const entry of entries) {
      if(++visits>4096)throw new RuntimeError('capacity','The source binding inventory exceeds its bound.');
      if(!/^[a-f0-9]{64}\.json$/.test(entry.name)||!entry.isFile())throw new RuntimeError('source_unavailable','A source binding is invalid.');
      const item=await readDocument(join(directory,entry.name));if(item.status!=='valid')throw new RuntimeError('source_unavailable','A source binding is unreadable.');
      const record=checkedReceipt(item.value,entry.name,namespaces.roots);
      if(record.identity?.split(':')[0]===storageId)return {state:'bound' as const,root:record.root,sourceRoot:record.sourceRoot,packageDir:record.packageDir};
    }
    return {state:'absent' as const};
  }
  async create(request:Creation) {
    const placement=await this.placement(),path=join(this.options.stateDir,'bindings',`${hash(request.requestId)}.json`),cwd=await realpath(request.cwd);
    const content={cwd,name:request.name,model:request.model,thinkingLevel:request.thinkingLevel,preset:request.preset},digest=hash(JSON.stringify(content)),previous=await readDocument(path);
    if(previous.status!=='missing') {
      const record=checkedReceipt(previous.value,`${hash(request.requestId)}.json`,(await this.list()).roots);
      if(record.digest!==digest||record.requestId!==request.requestId)throw new RuntimeError('request_conflict','The creation request identity has different content.');
      if(record.state!=='completed')throw new RuntimeError('creation_uncertain','Creation admission is unconfirmed. Inspect the managed native catalog before another request.',true);
      return {protocol:1,state:'completed',identity:record.identity as string,name:record.name??null,sourceRoot:record.sourceRoot,packageDir:record.packageDir,root:record.root};
    }
    const selectedSources=await this.selectedSources(),existingSources=selectedSources.filter(source=>source.root!==placement.root);
    const metadata={protocol:1,root:placement.root,agentDir:this.options.agentDir,packageDir:placement.packageDir,cwd,requestId:request.requestId,existingSources,name:request.name,model:request.model,thinkingLevel:request.thinkingLevel,preset:request.preset};
    const payload=JSON.stringify(metadata);if(Buffer.byteLength(payload)>131072)throw new RuntimeError('capacity','The native source route metadata exceeds its bound.');
    const receipt:Receipt={...placement,requestId:request.requestId,digest,state:'reserved'};await this.write(path,receipt);
    const result=await this.run(process.execPath,[join(placement.sourceRoot,'extensions','agent','create-conversation.ts'),payload],{cwd,env:{...process.env,PI_CODING_AGENT_DIR:this.options.agentDir,PI_AGENT_SESSIONS_DIR:placement.root},timeoutMs:360000});
    const value=result.value;
    if(result.exitCode!==0||!object(value)||value.protocol!==1||value.state!=='completed'||typeof value.identity!=='string'||!/^[-a-zA-Z0-9]+$/.test(value.identity)||!selectedSources.some(source=>sameSource(source,value))) {
      await this.write(path,{...receipt,state:'uncertain'});throw new RuntimeError('creation_uncertain','The Agent did not confirm native creation. Inspect the managed catalog before another request.',true);
    }
    const selected=validateNativeSource({root:value.root,sourceRoot:value.sourceRoot,packageDir:value.packageDir});
    await this.write(path,{...receipt,...selected,state:'completed',identity:value.identity,name:typeof value.name==='string'?value.name:null});
    return {protocol:1,state:'completed',identity:value.identity,name:typeof value.name==='string'?value.name:null,...selected};
  }
}
