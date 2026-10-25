import {randomUUID} from 'node:crypto';
import {Configuration,validatePiPreferences,validateRuntimeConfig} from './config.mts';
import {Authentication} from './auth.mts';
import {SessionSources,type NativeSource} from './sessions.mts';
import {NamespaceRecovery} from './namespace-recovery.mts';
import {PiManagement} from './pi.mts';
import {Lifecycle,type LifecycleOptions} from './lifecycle.mts';
import {dispatchEvolutionOperation,type EvolutionOperation} from './evolution.mts';
import {RUNTIME_PROTOCOL,RuntimeError,isReadOperation,readRequest,type RuntimeHealth,type RuntimeOperation,type RuntimeResponse} from './contract.mts';

export type ManagementOptions = LifecycleOptions & {stateDir:string;env?:Readonly<Record<string,string|undefined>>;existingSource?:NativeSource};
export type ManagementDomains = {configuration:Configuration;pi:PiManagement;authentication:Authentication;lifecycle:Lifecycle;sessions:SessionSources;recovery:NamespaceRecovery;evolution:typeof dispatchEvolutionOperation};
/** This composition owns admission only. Domain services own their data and effects. */
export class ManagementService {
  readonly incarnation=randomUUID();readonly startedAt=new Date().toISOString();
  readonly domains:ManagementDomains;
  private activeMutations=new Set<string>();
  readonly options:ManagementOptions;
  constructor(options:ManagementOptions,domains:Partial<ManagementDomains>={}) {
    this.options=options;
    const pi=domains.pi??new PiManagement(options.agentDir),sessions=domains.sessions??new SessionSources(options);
    this.domains={configuration:domains.configuration??new Configuration(options.agentDir,options.cwd,options.env),pi,authentication:domains.authentication??new Authentication(()=>pi.models()),lifecycle:domains.lifecycle??new Lifecycle(options),sessions,recovery:domains.recovery??new NamespaceRecovery(sessions,options),evolution:domains.evolution??dispatchEvolutionOperation};
  }
  startRecovery() {void this.domains.recovery.refresh();}
  private async createConversation(request:Extract<RuntimeOperation,{operation:'sessions.create'}>) {const result=await this.domains.sessions.create(request);this.startRecovery();return result;}
  async health():Promise<RuntimeHealth> {const configuration=await this.domains.configuration.startup();return {protocol:RUNTIME_PROTOCOL,incarnation:this.incarnation,startedAt:this.startedAt,pid:process.pid,state:'ready',configuration:configuration.valid?'valid':'invalid',activeMutation:this.activeMutations.size>0};}
  async call(input:unknown):Promise<RuntimeResponse> {
    let request:RuntimeOperation|undefined,admitted=false,key:string|undefined;
    try {
      request=readRequest(input);
      if(!isReadOperation(request)) {
        key=this.mutationKey(request);
        if(this.activeMutations.has(key))throw new RuntimeError('busy','A change to this resource is active. Read its owning status before another change.');
        this.activeMutations.add(key);admitted=true;
      }
      const value=await this.dispatch(request);return {ok:true,value};
    }catch(error){return {ok:false,error:error instanceof RuntimeError?{code:error.code,message:error.message,uncertain:error.uncertain}:{code:'domain_unavailable',message:'The owning service did not confirm the operation. Inspect its state before another change.',uncertain:admitted}};}
    finally{if(admitted&&key)this.activeMutations.delete(key);}
  }
  private mutationKey(request:RuntimeOperation):string {
    if(request.operation.startsWith('evolution.')||request.operation.startsWith('upstream.'))return `maintenance:${this.options.cwd}`;
    if(request.operation.startsWith('packages.')) {
      const scope='local' in request&&request.local&&'cwd' in request?request.cwd:this.options.agentDir;return `packages:${scope}`;
    }
    if(request.operation==='sessions.create')return `creation:${request.requestId}`;
    if('provider' in request)return `auth:${request.provider}`;
    if('flowId' in request)return `auth:${request.flowId}`;
    if(request.operation==='config.apply'||request.operation==='config.repair')return `config:${request.target}`;
    if(request.operation==='trust.set')return 'project-trust';
    return 'ui-lifecycle';
  }
  private async dispatch(request:RuntimeOperation):Promise<unknown> {
    const {configuration,pi,authentication,lifecycle,sessions,evolution}=this.domains;
    switch(request.operation) {
      case 'health':return this.health();
      case 'diagnostics':return {health:await this.health(),recovery:this.domains.recovery.status(),configuration:await Promise.all(['runtime','pi'].map(async target=>({target,...await configuration.inspect(target as 'runtime'|'pi').catch(()=>({status:'unavailable'}))}))),boundaries:{sessions:'Agent-owned',replay:'No automatic mutation replay',restart:'Management restart leaves native sessions and the UI supervisor independent'}};
      case 'config.inspect':return configuration.inspect(request.target);
      case 'config.validate':return {valid:true,values:request.target==='runtime'?validateRuntimeConfig(request.values):validatePiPreferences(request.values)};
      case 'config.apply':return configuration.apply(request.target,request.values,request.expectedDigest);
      case 'config.repair':return configuration.repair(request.target,request.values,request.expectedDigest);
      case 'auth.status':return authentication.status();
      case 'auth.login':return authentication.start(request.provider,request.type);
      case 'auth.poll':return authentication.poll(request.flowId);
      case 'auth.respond':return authentication.respond(request.flowId,request.promptId,request.value);
      case 'auth.cancel':return authentication.cancel(request.flowId);
      case 'auth.logout':return authentication.logout(request.provider);
      case 'trust.inspect':return pi.trust(request.cwd);
      case 'trust.set':return pi.trust(request.cwd,request.decision);
      case 'resources.inspect':return pi.resources(request.cwd);
      case 'packages.list':case 'packages.install':case 'packages.remove':case 'packages.update':return pi.packageAction(request);
      case 'sessions.create':return this.createConversation(request);
      case 'sessions.source':return sessions.source(request.identity);
      case 'sessions.list':return sessions.list();
      case 'lifecycle.status':case 'release.status':return lifecycle.release('status');
      case 'lifecycle.start':return lifecycle.start();
      case 'lifecycle.stop':return lifecycle.release('stop');
      case 'release.stage':return lifecycle.release('stage');
      case 'release.switch':return lifecycle.release('switch',request.releaseId);
      case 'release.rollback':return lifecycle.release('rollback');
      default:return evolution({cwd:this.options.cwd},request as EvolutionOperation);
    }
  }
  close() {this.domains.authentication.close();return this.domains.recovery.close();}
}
