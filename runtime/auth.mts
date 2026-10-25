import {randomUUID} from 'node:crypto';
import type {AuthEvent,AuthPrompt} from '@earendil-works/pi-ai';
import type {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {RuntimeError} from './contract.mts';

type PromptView = {id:string;type:AuthPrompt['type'];message:string;placeholder?:string;options?:readonly {id:string;label:string;description?:string}[]};
type Flow = {id:string;provider:string;controller:AbortController;events:AuthEvent[];state:'pending'|'completed'|'cancelled'|'failed';prompt?:PromptView;answer?:(value:string)=>void;reject?:(error:Error)=>void;timer:NodeJS.Timeout};
/** OAuth state and submitted secrets stay only in the owning login invocation. */
export class Authentication {
  private flows=new Map<string,Flow>();
  private models:()=>Promise<Pick<ModelRuntime,'login'|'logout'|'getProviders'|'getProviderAuthStatus'|'listCredentials'>>;
  constructor(models:()=>Promise<Pick<ModelRuntime,'login'|'logout'|'getProviders'|'getProviderAuthStatus'|'listCredentials'>>) {this.models=models;}
  async status() {const models=await this.models();return {providers:models.getProviders().map(provider=>({id:provider.id,status:models.getProviderAuthStatus(provider.id)})),credentials:await models.listCredentials()};}
  async start(provider:string,type:'api_key'|'oauth') {
    if([...this.flows.values()].some(flow=>flow.provider===provider&&flow.state==='pending'))throw new RuntimeError('auth_busy','A login already uses this provider.');
    if(this.flows.size>=8)throw new RuntimeError('capacity','Close a completed login before another login.');
    const models=await this.models(),controller=new AbortController(),id=randomUUID();
    const flow:Flow={id,provider,controller,events:[],state:'pending',timer:setTimeout(()=>this.cancel(id),300000)};flow.timer.unref();this.flows.set(id,flow);
    void models.login(provider,type,{signal:controller.signal,prompt:prompt=>this.prompt(flow,prompt),notify:event=>{if(flow.state==='pending'){flow.events.push(event);if(flow.events.length>32)flow.events.shift();}}}).then(()=>{flow.state='completed';},()=>{flow.state=controller.signal.aborted?'cancelled':'failed';}).finally(()=>{clearTimeout(flow.timer);flow.prompt=undefined;flow.answer=undefined;flow.reject=undefined;});
    return this.poll(id);
  }
  private prompt(flow:Flow,prompt:AuthPrompt):Promise<string> {
    if(flow.controller.signal.aborted||prompt.signal?.aborted)return Promise.reject(new Error('Login cancelled.'));
    if(flow.prompt)return Promise.reject(new Error('Concurrent authentication prompt.'));
    const id=randomUUID();flow.prompt={id,type:prompt.type,message:prompt.message.slice(0,4096),...('placeholder' in prompt?{placeholder:prompt.placeholder}:{}),...('options' in prompt?{options:prompt.options}: {})};
    return new Promise((resolve,reject)=> {
      const cancel=()=>finish(undefined,new Error('Login cancelled.'));
      const finish=(value?:string,error?:Error)=>{flow.controller.signal.removeEventListener('abort',cancel);prompt.signal?.removeEventListener('abort',cancel);flow.prompt=undefined;flow.answer=undefined;flow.reject=undefined;if(error)reject(error);else resolve(value??'');};
      flow.answer=value=>finish(value);flow.reject=error=>finish(undefined,error);flow.controller.signal.addEventListener('abort',cancel,{once:true});prompt.signal?.addEventListener('abort',cancel,{once:true});
    });
  }
  poll(id:string) {const flow=this.flows.get(id);if(!flow)throw new RuntimeError('auth_unknown','The login is unavailable. Start a new login.');return {flowId:id,provider:flow.provider,state:flow.state,events:structuredClone(flow.events),prompt:flow.prompt?structuredClone(flow.prompt):null};}
  respond(id:string,promptId:string,value:string) {const flow=this.flows.get(id);if(flow?.state!=='pending'||flow.prompt?.id!==promptId||!flow.answer)throw new RuntimeError('auth_stale','The login prompt changed. Read the current prompt.');if(flow.prompt.type==='select'&&!flow.prompt.options?.some(option=>option.id===value))throw new RuntimeError('invalid_request','The authentication choice is invalid.');flow.answer(value);return this.poll(id);}
  cancel(id:string) {const flow=this.flows.get(id);if(!flow)throw new RuntimeError('auth_unknown','The login is unavailable.');flow.controller.abort();flow.reject?.(new Error('Login cancelled.'));clearTimeout(flow.timer);this.flows.delete(id);return {cancelled:true};}
  async logout(provider:string) {if([...this.flows.values()].some(flow=>flow.provider===provider&&flow.state==='pending'))throw new RuntimeError('auth_busy','Cancel the active login before logout.');await (await this.models()).logout(provider);return {loggedOut:true,provider};}
  close() {for(const id of this.flows.keys())this.cancel(id);}
}
