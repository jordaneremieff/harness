import { createHash, randomBytes } from 'node:crypto';
import { Parser } from 'htmlparser2';
import type { Asset } from './http.mts';
import type { DevLeaseIdentity } from '../shared/api.ts';

export const GENERATION_FILE_BYTES = 2 * 1024 * 1024;
export const GENERATION_TOTAL_BYTES = 16 * 1024 * 1024;
export const GENERATION_ENTRIES = 256;
export type BuildStatus = {revision:number; generation:string; previous:string|null; change:'css'|'reload'; status:'ready'|'building'|'failed'|'held'|'restart-required'; code:'none'|'compile'|'input-changed'|'invalid-assets'|'capacity'|'backend-change'|'io'};
const digest = (data: string|Buffer) => createHash('sha256').update(data).digest('hex');
const validId = (id:string) => /^[a-f0-9]{64}$/.test(id);
const prefix = (id:string) => `/_ui/${id}`;
const documentMetadata=(id:string,client:string,family:string)=>`<meta name="ui-generation" content="${id}"><meta name="ui-client" content="${client}"><meta name="ui-module-family" content="${family}">`;
const documentMetadataBytes=Buffer.byteLength(documentMetadata('0'.repeat(64),'0'.repeat(24),'0'.repeat(64)));

/** CSS variants share exact immutable module and favicon bytes, never HTML or CSS. */
class ModuleFamily {
  readonly id:string;
  readonly bytes:number;
  private assets:Map<string,Asset>;
  constructor(assets:ReadonlyMap<string,Asset>,identities:ReadonlyMap<string,string>) {
    this.id=digest(JSON.stringify([...identities].filter(([route])=>route!=='/style.css').sort(([a],[b])=>a.localeCompare(b)).map(([route,hash])=>[route,hash,assets.get(route)?.type])));
    this.assets=new Map([...assets].filter(([route])=>route!=='/'&&route!=='/style.css'));
    this.bytes=[...this.assets.values()].reduce((sum,asset)=>sum+asset.data.length,0);
  }
  asset(route:string):Asset|undefined {const asset=this.assets.get(route);return asset?{type:asset.type,data:Buffer.from(asset.data)}:undefined;}
}

/** Private buffers and a complete route identity are constructed before publication. */
export class AssetGeneration {
  readonly builtAt = new Date().toISOString();
  readonly id:string;
  readonly manifest:Readonly<Record<string,string>>;
  readonly bytes:number;
  private assets:Map<string,Asset>;
  private modules:ModuleFamily;
  constructor(input:ReadonlyMap<string,Asset>, imports:ReadonlyMap<string,readonly string[]>) {
    const identities=validateAssets(input,imports);
    this.id=digest(JSON.stringify([...identities].sort(([a],[b])=>a.localeCompare(b))));
    const sealed=sealAssets(input,this.id);this.modules=new ModuleFamily(sealed.assets,identities);
    this.assets=new Map([...sealed.assets].filter(([route])=>route==='/'||route==='/style.css'));this.manifest=sealed.manifest;this.bytes=sealed.bytes;
  }
  /** Responses receive copies, so external mutation cannot change retained generation bytes. */
  asset(route:string):Asset|undefined {const asset=this.assets.get(route);return asset?{type:asset.type,data:Buffer.from(asset.data)}:this.modules.asset(route);}
  get family() {return this.modules;}
  sameExceptCss(other:AssetGeneration) {return this.modules.id===other.modules.id;}
  shareModules(other:AssetGeneration) {if(!this.sameExceptCss(other)) throw new Error('invalid-assets');this.modules=other.modules;}
}
function validateImports(route:string,references:readonly string[]|undefined,input:ReadonlyMap<string,Asset>) {
  if(!references) throw new Error('invalid-assets');
  for(const reference of references) {
    if(!/^\.{1,2}\//.test(reference)||/[?#\\\\]/.test(reference)) throw new Error('invalid-assets');
    const resolved=new URL(reference,`http://build.invalid${route}`);
    if(!input.has(resolved.pathname)||!resolved.pathname.endsWith('.js')) throw new Error('invalid-assets');
  }
}
function validateAssets(input:ReadonlyMap<string,Asset>,imports:ReadonlyMap<string,readonly string[]>) {
  if(input.size>GENERATION_ENTRIES||!['/','/style.css','/favicon.svg','/web/app.js','/shared/api.js'].every(route=>input.has(route))) throw new Error('invalid-assets');
  const identities=new Map<string,string>();let bytes=0;
  for(const [route,asset] of input) {
    if(!/^\/(?:|style\.css|favicon\.svg|(?:web|shared)\/[a-zA-Z0-9_-]+\.js)$/.test(route)||asset.data.length>GENERATION_FILE_BYTES) throw new Error('invalid-assets');
    bytes+=asset.data.length;if(bytes>GENERATION_TOTAL_BYTES) throw new Error('capacity');
    if(route.endsWith('.js')) validateImports(route,imports.get(route),input);
    identities.set(route,digest(asset.data));
  }
  return identities;
}
function sealAssets(input:ReadonlyMap<string,Asset>,id:string) {
  const assets=new Map<string,Asset>();const manifest:Record<string,string>={};let bytes=0;
  for(const [route,asset] of input) {
    const data=route==='/'?Buffer.from(pinHtml(asset.data.toString('utf8'),id,input)):Buffer.from(asset.data);
    if(route==='/') validateDocument(data);
    if(route==='/style.css'&&/@import\b|url\s*\(/i.test(data.toString('utf8'))) throw new Error('invalid-assets');
    bytes+=data.length;if(data.length>GENERATION_FILE_BYTES||bytes>GENERATION_TOTAL_BYTES) throw new Error('capacity');
    assets.set(route,{type:asset.type,data});manifest[route]=digest(data);
  }
  return {assets,manifest:Object.freeze(manifest),bytes};
}
function validateDocument(data:Buffer) {
  if(!/<head\b[^>]*>/i.test(data.toString('utf8'))) throw new Error('invalid-assets');
  if(data.length+documentMetadataBytes>GENERATION_FILE_BYTES) throw new Error('capacity');
}
function bootstrapAsset(generation:AssetGeneration,id:string,client:string) {
  const asset=generation.asset('/');if(!asset) throw new Error('invalid-assets');
  return {...asset,data:Buffer.from(asset.data.toString('utf8').replace(/<head\b[^>]*>/i,head=>head+documentMetadata(id,client,generation.family.id)))};
}
function pinHtml(html:string,id:string,assets:ReadonlyMap<string,Asset>) {
  const edits:{start:number;end:number;text:string}[]=[];
  const parser=new Parser({onopentag(name,attributes) {
    if(name!=='script' && name!=='link') return;
    const attribute=name==='script'?'src':'href'; const value=attributes[attribute];if(!value) throw new Error('invalid-assets');
    if(!assets.has(value)) throw new Error('invalid-assets');
    const start=parser.startIndex;const end=parser.endIndex+1;const tag=html.slice(start,end);
    const pattern=new RegExp(`(\\s${attribute}\\s*=\\s*)(["'])(.*?)\\2`,'i');
    if(!pattern.test(tag)) throw new Error('invalid-assets');
    edits.push({start,end,text:tag.replace(pattern,(_all,assignment:string,quote:string)=>`${assignment}${quote}${prefix(id)}${value}${quote}`)});
  }},{decodeEntities:true});
  parser.write(html);parser.end();
  for(const edit of edits.reverse()) html=html.slice(0,edit.start)+edit.text+html.slice(edit.end);
  return html;
}

type Lease={generation:string;cssGeneration:string;predecessor?:DevLeaseIdentity&{adopted?:boolean}};
type LeaseResult={lease:'present'|'missing';build:BuildStatus}|{lease:'replaced';client:string;build:BuildStatus};
/** Two full snapshots and one candidate; live JS aliases share their immutable families. */
export class AssetGenerations {
  private active:AssetGeneration;
  private previous?:AssetGeneration;
  private candidate?:AssetGeneration;
  private jsPins=new Map<string,ModuleFamily>();
  private leases=new Map<string,Lease>();
  private subscribers=new Map<string,{notify:(status:BuildStatus)=>void}>();
  private blocked=false;
  private state:BuildStatus;
  private observer?: (status:BuildStatus)=>void;
  constructor(initial:AssetGeneration) {this.active=initial;this.state={revision:0,generation:initial.id,previous:null,change:'reload',status:'ready',code:'none'};}
  status():BuildStatus {return {...this.state};}
  private pageStatus(client:string):BuildStatus {
    const lease=this.leases.get(client);
    return {...this.state,change:lease&&this.jsFamily(lease.generation)?.id===this.active.family.id?'css':'reload'};
  }
  identity(id = this.active.id) {const generation = this.find(id); return generation ? {digest: generation.id, builtAt: generation.builtAt} : undefined;}
  observe(observer:(status:BuildStatus)=>void) {this.observer=observer;observer(this.status());}
  counts() {
    const snapshots=[this.active,this.previous,this.candidate].filter((item):item is AssetGeneration=>!!item);
    const families=new Set([...snapshots.map(item=>item.family),...this.jsPins.values()]);
    const bytes=snapshots.reduce((sum,item)=>sum+item.bytes-item.family.bytes,0)+[...families].reduce((sum,item)=>sum+item.bytes,0);
    return {published:1+Number(!!this.previous),candidate:Number(!!this.candidate),clients:this.leases.size,jsPins:this.jsPins.size,bytes};
  }
  private find(id:string) {return this.active.id===id?this.active:this.previous?.id===id?this.previous:undefined;}
  private jsFamily(id:string) {return this.find(id)?.family??this.jsPins.get(id);}
  asset(id:string,route:string) {return validId(id)&&route!=='/'&&route!=='/index.html'?(this.find(id)?.asset(route)??this.jsPins.get(id)?.asset(route)):undefined;}
  document(id=this.active.id) {
    const generation=this.find(id);if(!generation) throw new Error('invalid-assets');
    if(this.leases.size>=64) throw new Error('capacity');
    const client=randomBytes(12).toString('hex');const asset=bootstrapAsset(generation,id,client);
    this.leases.set(client,{generation:id,cssGeneration:id});return {client,generation:id,asset};
  }
  documentHead(id=this.active.id) {const generation=this.find(id);return generation?bootstrapAsset(generation,id,'0'.repeat(24)):undefined;}
  bind(client:string) {
    const lease=this.leases.get(client);if(!lease) throw new Error('invalid-assets');
  }
  subscribe(client:string,notify:(status:BuildStatus)=>void) {
    this.bind(client);if(this.subscribers.has(client)) throw new Error('capacity');
    this.adopt(client);this.subscribers.set(client,{notify});try {notify(this.pageStatus(client));} catch(error) {this.subscribers.delete(client);throw error;}
    return ()=>this.subscribers.delete(client);
  }
  acknowledge(client:string,generation:string,cssGeneration:string) {
    this.bind(client);const js=this.jsFamily(generation);const css=this.find(cssGeneration);
    if(!js||!css||js.id!==css.family.id) throw new Error('invalid-assets');
    this.leases.set(client,{...this.leases.get(client),generation,cssGeneration});this.adopt(client);this.publish();
  }
  /** Only an absent identity can rotate. Known identities never bypass byte checks. */
  checkLease(client:string,generation:string,cssGeneration:string,family:string):LeaseResult {
    if(!/^[a-f0-9]{24}$/.test(client)||!validId(generation)||!validId(cssGeneration)||!validId(family)) throw new Error('invalid-assets');
    const lease=this.leases.get(client);
    if(lease) {
      if(lease.generation!==generation||lease.cssGeneration!==cssGeneration||this.jsFamily(generation)?.id!==family) throw new Error('invalid-assets');
      this.bind(client);this.adopt(client);
      return {lease:'present' as const,build:this.pageStatus(client)};
    }
    const identity={client,generation,cssGeneration,family};
    return this.replacementFor(identity)??this.rotateLease(identity);
  }
  private replacementFor({client,generation,cssGeneration,family}:DevLeaseIdentity):LeaseResult|undefined {
    // The reservation owns retry identity and capacity until its normal page release.
    for(const [replacement,reserved] of this.leases) if(reserved.predecessor?.client===client) {
      const prior=reserved.predecessor;
      if(prior.generation!==generation||prior.cssGeneration!==cssGeneration||prior.family!==family) throw new Error('invalid-assets');
      return {lease:'replaced',client:replacement,build:this.pageStatus(replacement)};
    }
    return undefined;
  }
  private rotateLease({client,generation,cssGeneration,family}:DevLeaseIdentity):LeaseResult {
    if(this.leases.size>=64) throw new Error('capacity');
    const js=this.jsFamily(generation),css=this.find(cssGeneration);
    if(js&&js.id!==family||css&&css.family.id!==family) throw new Error('invalid-assets');
    if(!css) return {lease:'missing' as const,build:this.status()};
    const replacement=this.replacementIdentity(client);
    // A bootstrap family digest verifies exact module bytes across CSS-only generations.
    if(!js) this.jsPins.set(generation,css.family);
    this.leases.set(replacement,{generation,cssGeneration,predecessor:{client,generation,cssGeneration,family}});
    return {lease:'replaced' as const,client:replacement,build:this.pageStatus(replacement)};
  }
  private replacementIdentity(predecessor:string):string {
    for(let attempt=0;attempt<4;attempt++) {const fresh=randomBytes(12).toString('hex');if(fresh!==predecessor&&!this.leases.has(fresh)) return fresh;}
    throw new Error('capacity');
  }
  /** A valid request under the replacement identity proves adoption; predecessor retries do not. */
  private adopt(client:string) {const predecessor=this.leases.get(client)?.predecessor;if(predecessor) predecessor.adopted=true;}
  release(client:string):'released'|'absent' {
    if(!/^[a-f0-9]{24}$/.test(client)) throw new Error('invalid-assets');
    if(!this.leases.has(client)) {
      for(const [replacement,reserved] of this.leases) if(reserved.predecessor?.client===client) {
        if(!reserved.predecessor.adopted) {this.leases.delete(replacement);this.publish();}
        break;
      }
      return 'absent';
    }
    this.bind(client);this.leases.delete(client);this.subscribers.delete(client);this.publish();return 'released';
  }
  offer(generation:AssetGeneration,revision:number) {
    if(this.blocked||revision<this.state.revision) return false;
    this.state={...this.state,revision};
    if(generation.id===this.active.id) {this.candidate=undefined;this.update('ready','none');return true;}
    const shared=[this.active,this.previous].find(item=>item?.sameExceptCss(generation));if(shared) generation.shareModules(shared);
    this.candidate=generation;return this.publish();
  }
  building(revision:number) {if(!this.blocked) {this.candidate=undefined;this.state={...this.state,revision};this.update('building','none');}}
  failure(revision:number,code:BuildStatus['code']) {if(!this.blocked&&revision>=this.state.revision) {this.state={...this.state,revision};this.candidate=undefined;this.update('failed',code);}}
  restartRequired() {this.blocked=true;this.candidate=undefined;this.update('restart-required','backend-change');}
  private publish() {
    const liveJs=new Set([...this.leases.values()].map(item=>item.generation));
    for(const id of this.jsPins.keys()) if(!liveJs.has(id)) this.jsPins.delete(id);
    if(!this.candidate||this.blocked) return false;
    const previous=this.previous;
    if(previous&&[...this.leases.values()].some(item=>item.cssGeneration===previous.id||(!previous.sameExceptCss(this.active)&&this.jsFamily(item.generation)?.id===previous.family.id))) {this.update('held','capacity');return false;}
    if(previous&&liveJs.has(previous.id)) this.jsPins.set(previous.id,previous.family);
    const next=this.candidate;this.candidate=undefined;
    const change=this.active.sameExceptCss(next)?'css':'reload';this.previous=this.active;this.active=next;
    this.state={...this.state,generation:next.id,previous:this.previous.id,change};this.update('ready','none');return true;
  }
  private update(status:BuildStatus['status'],code:BuildStatus['code']) {
    this.state={...this.state,status,code};try {this.observer?.(this.status());} catch { /* Diagnostics never own publication. */ }
    for(const [client,subscription] of this.subscribers) {try {subscription.notify(this.pageStatus(client));} catch { /* An observer never owns publication. */ }}
  }
}

function buildFailure(error:unknown):BuildStatus['code'] {
  if(error instanceof Error&&error.message==='input-changed') return 'input-changed';
  if(error instanceof Error&&error.message==='compile') return 'compile';return 'invalid-assets';
}
/** A producer completion is the only publication signal, never a filesystem hint. */
export class LatestBuild {
  private revision=0;
  private dirty=false;
  private running?:Promise<void>;
  private stopped=false;
  private generations:AssetGenerations;
  private build:(revision:number)=>Promise<AssetGeneration>;
  constructor(generations:AssetGenerations,build:(revision:number)=>Promise<AssetGeneration>) {this.generations=generations;this.build=build;}
  request() {if(this.stopped) return;this.revision++;this.dirty=true;this.running??=this.run().finally(()=>{this.running=undefined;if(this.dirty&&!this.stopped) this.request();});}
  async drain() {while(this.running) await this.running;}
  stop() {this.stopped=true;this.dirty=false;}
  private async run() {
    while(this.dirty&&!this.stopped) {
      this.dirty=false;const revision=this.revision;this.generations.building(revision);
      try {const generation=await this.build(revision);if(!this.stopped && revision===this.revision) this.generations.offer(generation,revision);}
      catch(error) {if(revision===this.revision&&!this.stopped) this.generations.failure(revision,buildFailure(error));}
    }
  }
}
