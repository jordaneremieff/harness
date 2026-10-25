import {join} from 'node:path';
import {createHostManager,forkDriver,type HostManager} from '@earendil-works/chord/node';
import type {SessionSources,NativeSource,SourcePlacement} from './sessions.mts';

export type RecoveryOptions = {agentDir:string;cwd:string};
export type RecoveryManagerFactory = (source:SourcePlacement,options:RecoveryOptions,existingSources:NativeSource[],onExit:()=>void)=>HostManager;
const createRecoveryManager:RecoveryManagerFactory=(source,options,existingSources,onExit)=>createHostManager({
  driver:forkDriver({entry:join(source.sourceRoot,'extensions','agent','namespace-recovery.ts'),args:[JSON.stringify({protocol:1,root:source.root,agentDir:options.agentDir,packageDir:source.packageDir,cwd:options.cwd,existingSources})],init:null,lock:`harness-native-recovery:${source.root}`,env:{PI_CODING_AGENT_DIR:options.agentDir,PI_AGENT_SESSIONS_DIR:source.root}}),
  readyTimeout:30000,grace:5000,onExit,
});
type Owner = {source:SourcePlacement;existingSources:NativeSource[];manager?:HostManager;active:boolean;attempts:number;error?:'recovery_owner_unavailable';retry?:NodeJS.Timeout};
/** Agent recovery owns native admission. This supervisor retains only source-bound process ownership. */
export class NamespaceRecovery {
  private readonly sources:SessionSources;private readonly options:RecoveryOptions;private readonly factory:RecoveryManagerFactory;
  private readonly owners=new Map<string,Owner>();private inventory:'unknown'|'ready'|'unavailable'='unknown';private closed=false;private refreshing?:Promise<void>;private closing?:Promise<void>;
  constructor(sources:SessionSources,options:RecoveryOptions,factory:RecoveryManagerFactory=createRecoveryManager) {this.sources=sources;this.options=options;this.factory=factory;}
  refresh():Promise<void> {
    if(this.closed)return Promise.resolve();if(this.refreshing)return this.refreshing;
    const pending=this.refreshOwners().finally(()=>{if(this.refreshing===pending)this.refreshing=undefined;});this.refreshing=pending;return pending;
  }
  private async refreshOwners() {
    try {
      const placements=await this.sources.list(),selected=await this.sources.selectedSources();
      if(this.closed)return;
      this.inventory='ready';const starts:Promise<void>[]=[];
      for(const source of placements.roots) {
        if(this.owners.has(source.root))continue;
        const owner:Owner={source,existingSources:selected.filter(value=>value.root!==source.root),active:false,attempts:0};this.owners.set(source.root,owner);starts.push(this.start(owner));
      }
      await Promise.all(starts);
    }catch{this.inventory='unavailable';}
  }
  private async start(owner:Owner) {
    if(this.closed||owner.active)return;
    owner.active=true;owner.attempts++;
    try {
      owner.manager??=this.factory(owner.source,this.options,owner.existingSources,()=>this.retry(owner));
      await owner.manager.start();owner.error=undefined;
    }catch{owner.error='recovery_owner_unavailable';}
    finally{owner.active=false;if(owner.error)this.retry(owner);}
  }
  private retry(owner:Owner) {
    if(this.closed||owner.retry)return;
    const delay=Math.min(30000,1000*2**Math.min(owner.attempts-1,5));
    owner.retry=setTimeout(()=>{owner.retry=undefined;void this.start(owner);},delay);owner.retry.unref();
  }
  status() {
    return {inventory:this.inventory,owners:[...this.owners.values()].map(owner=>({root:owner.source.root,sourceRoot:owner.source.sourceRoot,packageDir:owner.source.packageDir,state:owner.manager?.status??'unavailable',attempts:owner.attempts,error:owner.error??null})),scope:'Process readiness only. Agent owns each native recovery result. No conversation or task index is copied.'};
  }
  close():Promise<void> {
    if(this.closing)return this.closing;
    this.closed=true;for(const owner of this.owners.values())clearTimeout(owner.retry);
    this.closing=(async()=>{await Promise.allSettled([...this.owners.values()].map(owner=>owner.manager?.stop()));await this.refreshing;})();return this.closing;
  }
}
