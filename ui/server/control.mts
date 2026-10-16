import {randomUUID} from 'node:crypto';
import {CONTROL_LIMITS,controlText,readControlAck,readControlIntent,readControlProvenance,type ControlAck,type ControlIntent,type ControlLayout,type ControlProvenance,type ControlReceipt,type ControlRequest,type ControlWorkspace} from '../shared/control.ts';
import type {Workspace,WorkspaceTab,PaneNode} from '../shared/api.ts';
import type {Registry} from './registry.mts';
import type {Files} from './files.mts';
import type {LifecycleLog} from './lifecycle-log.mts';
import {ApiError} from './errors.mts';
import {controlLayout,controlView,validateControlChange} from './control-layout.mts';

type Entry={request:ControlRequest;receipt:ControlReceipt;timer?:ReturnType<typeof setTimeout>;savedRevision?:number;saving?:boolean;finishing?:Promise<void>;waiter?:(receipt:ControlReceipt)=>void};
function invalid(message='The control request is invalid.'):ApiError {return new ApiError('invalid_request',message);}
function fields(body:Record<string,unknown>,required:string[],optional:string[]=[]):void {if(required.some(key=>!Object.hasOwn(body,key))||Object.keys(body).some(key=>!required.includes(key)&&!optional.includes(key)))throw invalid();}
function safe<T>(read:()=>T):T {try{return read();}catch(error){throw invalid(error instanceof Error?error.message:undefined);}}
function submission(body:Record<string,unknown>):{workspaceId:string;actor:string;intent:ControlIntent;expectedRevision?:number} {
  fields(body,['workspaceId','intent'],['actor','expectedRevision']);
  const workspaceId=controlText(body.workspaceId,'workspace ID'),actor=body.actor===undefined?'Local agent':controlText(body.actor,'actor',CONTROL_LIMITS.actorChars),intent=readControlIntent(body.intent);
  if(body.expectedRevision!==undefined&&(!Number.isSafeInteger(body.expectedRevision)||(body.expectedRevision as number)<0))throw new Error('The workspace revision is invalid.');
  return {workspaceId,actor,intent,expectedRevision:body.expectedRevision as number|undefined};
}
function findNode(node:PaneNode,id:string):PaneNode|undefined {return node.id===id?node:node.kind==='split'?findNode(node.first,id)??findNode(node.second,id):undefined;}
function address(workspace:Workspace,intent:ControlIntent):void {
  const layout=controlLayout(workspace);
  if(intent.action==='focus'||intent.action==='split'||intent.action==='show') {
    const pane=intent.paneId??layout.focusedPane;if(findNode(layout.root,pane)?.kind!=='pane')throw invalid('The exact pane is unavailable.');
  } else if(intent.action==='resize'||intent.action==='swap') {if(findNode(layout.root,intent.splitId)?.kind!=='split')throw invalid('The exact split is unavailable.');}
}
function resultLabel(request:ControlRequest,receipt:ControlReceipt):string {
  if(receipt.state!=='applied')return receipt.state==='refused'?'presentation refused':'presentation not confirmed';
  return request.intent.action==='notice'?request.intent.text:`${request.intent.action} applied`;
}
/** Presentation receipts correlate one browser application; no input or process execution is available. */
export class Control {
  private entries=new Map<string,Entry>();private admitting=new Set<string>();private stopped=false;private tokens:number=CONTROL_LIMITS.burst;private at=performance.now();
  private registry:Registry;private files:Pick<Files,'request'>;private log:Pick<LifecycleLog,'control'>|undefined;
  constructor(registry:Registry,files:Pick<Files,'request'>,log:Pick<LifecycleLog,'control'>|undefined) {this.registry=registry;this.files=files;this.log=log;}
  private rate():void {const now=performance.now();this.tokens=Math.min(CONTROL_LIMITS.burst,this.tokens+(now-this.at)/1000*CONTROL_LIMITS.perSecond);this.at=now;if(this.tokens<1)throw new ApiError('capacity','The control request rate exceeds its bound.',429);this.tokens--;}
  private primary(workspace:Workspace):ControlRequest['primary'] {const view=this.registry.views().find(view=>view.key===workspace.primaryKey);return view?{kind:'primary',key:view.key,epoch:view.epoch}:undefined;}
  async layout(workspaceId?:string):Promise<ControlLayout> {
    if(workspaceId!==undefined)safe(()=>controlText(workspaceId,'workspace ID'));
    const workspaces=workspaceId===undefined?await this.registry.store.workspaceList():[await this.registry.store.workspace(workspaceId)];
    const rows:ControlWorkspace[]=await Promise.all(workspaces.map(async workspace=> {
      const row:ControlWorkspace={id:workspace.id,revision:workspace.revision,enabled:workspace.agentControl!==false,pages:this.registry.journal.workspaceClients(workspace.id),primary:this.primary(workspace)};
      if(workspaceId) {row.layout=controlLayout(workspace);const result=await this.files.request({kind:'roots'});const data=JSON.parse(result.json);if(!data.ok)throw new ApiError('file_unavailable','Registered folder metadata is unavailable.',503);row.roots=data.data;}
      return row;
    }));return {bootId:this.registry.journal.bootId,workspaces:rows};
  }
  private capacity(workspace:string):void {if(this.admitting.has(workspace)||[...this.entries.values()].some(entry=>entry.receipt.state==='pending'&&entry.request.workspaceId===workspace))throw new ApiError('control_busy','A presentation request already uses this workspace.',409);if(this.admitting.size+[...this.entries.values()].filter(entry=>entry.receipt.state==='pending').length>=CONTROL_LIMITS.outstanding)throw new ApiError('capacity','The presentation request capacity is full.',429);}
  private enabled(workspace:Workspace):void {if(this.stopped)throw new ApiError('not_ready','Presentation control is stopped.',503);if(workspace.agentControl===false)throw new ApiError('control_disabled','Agent presentation control is off for this workspace.',403);}
  private async view(workspace:Workspace,view:WorkspaceTab,primary:ControlRequest['primary']):Promise<void> {
    if(view.kind==='primary'){if(!primary||primary.key!==workspace.primaryKey)throw new ApiError('stale_epoch','The current primary is unavailable.',409);return;}
    if(view.kind==='agent'){if(!this.registry.agents.rosterRow(view.identity))throw new ApiError('invalid_request','The exact agent identity is not in the current catalog.',404);return;}
    if(view.view==='preview'&&!/\.(md|markdown|mdown)$/i.test(view.path))throw invalid('This file does not support Markdown preview.');
    const result=await this.files.request({kind:'text',rootId:view.rootId,path:view.path});const data=JSON.parse(result.json);if(!data.ok)throw new ApiError(data.error.code,data.error.message,result.status,data.error.retry);
  }
  async submit(body:Record<string,unknown>):Promise<ControlReceipt> {
    const {workspaceId,actor,intent,expectedRevision}=safe(()=>submission(body));this.rate();
    this.capacity(workspaceId);this.admitting.add(workspaceId);let admitted:ControlRequest|undefined;
    try {
      const workspace=await this.registry.store.workspace(workspaceId);this.enabled(workspace);
      if(expectedRevision!==undefined&&expectedRevision!==workspace.revision)throw new ApiError('stale_revision','The workspace revision changed.',409,'read');
      const page=this.registry.journal.controlPage(workspaceId);if(!page)throw new ApiError('control_page_unavailable','Use exactly one connected page for this workspace.',409);
      const request:ControlRequest={requestId:randomUUID(),bootId:this.registry.journal.bootId,workspaceId,pageId:page.pageId,connectionId:page.connectionId,expectedRevision:workspace.revision,expiresAt:Date.now()+CONTROL_LIMITS.executionMs,actor,intent,primary:this.primary(workspace)};
      address(workspace,intent);
      const view=controlView(request);if(view)await this.view(workspace,view,request.primary);
      await this.record(request,'admitted');admitted=request;
      const current=await this.registry.store.workspace(workspaceId);this.enabled(current);
      if(current.revision!==workspace.revision)throw new ApiError('stale_revision','The workspace changed during presentation admission.',409,'read');
      if(this.registry.journal.controlPage(workspaceId)?.connectionId!==page.connectionId||!this.registry.journal.hasConnection(workspaceId,page.pageId,page.connectionId))throw new ApiError('control_page_unavailable','The addressed page connection changed.',409);
      if(request.expiresAt<=Date.now())throw new ApiError('control_expired','Presentation admission exceeded its deadline.',408);
      const receipt:ControlReceipt={requestId:request.requestId,workspaceId,actor,action:intent.action,state:'pending',createdAt:new Date().toISOString()},entry:Entry={request,receipt};
      this.entries.set(request.requestId,entry);entry.timer=setTimeout(()=>{void this.finish(entry,'unconfirmed','deadline');},Math.max(1,request.expiresAt-Date.now()));entry.timer.unref();
      this.registry.journal.publish('control.request',undefined,request,workspaceId);return structuredClone(receipt);
    } catch(error) {if(admitted&&!this.entries.has(admitted.requestId))await this.record(admitted,'refused');throw error;}
    finally {this.admitting.delete(workspaceId);}
  }
  private async record(request:ControlRequest,result:string,revision?:number):Promise<void> {if(!this.log)throw new ApiError('control_log_unavailable','Retained presentation logging is unavailable.',503);try {await this.log.control(JSON.stringify({requestId:request.requestId,actor:request.actor,workspaceId:request.workspaceId,action:request.intent.action,result,...(revision===undefined?{}:{revision})}));}catch {throw new ApiError('control_log_unavailable','Retained presentation logging is unavailable.',503);}}
  private entry(id:string):Entry {safe(()=>controlText(id,'request ID'));const entry=this.entries.get(id);if(!entry)throw new ApiError('control_unknown','This presentation receipt is unavailable. Read the current layout before a new intent.',404);return entry;}
  async receipt(id:string):Promise<ControlReceipt> {const entry=this.entry(id);if(entry.finishing)await entry.finishing;if(entry.receipt.state==='pending'&&!this.registry.journal.hasConnection(entry.request.workspaceId,entry.request.pageId,entry.request.connectionId))await this.finish(entry,'unconfirmed','connection_changed');return structuredClone(entry.receipt);}
  async wait(id:string):Promise<ControlReceipt> {await this.receipt(id);const entry=this.entry(id);if(entry.finishing)await entry.finishing;if(entry.receipt.state!=='pending')return structuredClone(entry.receipt);if(entry.waiter)throw new ApiError('capacity','This presentation receipt already has a waiter.',429);return new Promise(resolve=>{entry.waiter=resolve;});}
  private match(entry:Entry,provenance:ControlProvenance):void {
    if(entry.finishing||entry.receipt.state!=='pending'||entry.request.expiresAt<=Date.now())throw new ApiError('control_expired','This presentation request no longer accepts actions.',409);
    if(this.registry.journal.controlPage(provenance.workspaceId)?.connectionId!==provenance.connectionId||['requestId','bootId','workspaceId','pageId','connectionId'].some(key=>provenance[key as keyof ControlProvenance]!==entry.request[key as keyof ControlProvenance])||!this.registry.journal.hasConnection(provenance.workspaceId,provenance.pageId,provenance.connectionId))throw new ApiError('control_stale_connection','The presentation connection changed.',409);
    if(this.primary({id:entry.request.workspaceId,revision:0,primaryKey:entry.request.primary?.key})?.epoch!==entry.request.primary?.epoch)throw new ApiError('stale_epoch','The primary conversation changed.',409);
  }
  async selection(workspaceId:string,raw:unknown,body:Record<string,unknown>,save:(guard:(current:Workspace)=>void)=>Promise<Workspace>):Promise<Workspace> {
    const provenance=safe(()=>readControlProvenance(raw)),entry=this.entry(provenance.requestId);
    if(workspaceId!==provenance.workspaceId)throw invalid();this.match(entry,provenance);
    if(entry.savedRevision!==undefined||entry.saving)throw new ApiError('control_busy','This presentation request already used its selection write.',409);
    entry.saving=true;
    try {const result=await save(current=> {this.match(entry,provenance);this.enabled(current);if(current.revision!==entry.request.expectedRevision||body.expectedRevision!==entry.request.expectedRevision)throw new ApiError('stale_revision','The presentation workspace changed.',409,'read');validateControlChange(current,entry.request,body);});entry.savedRevision=result.revision;return result;}
    finally {entry.saving=false;}
  }
  private applied(entry:Entry,ack:Extract<ControlAck,{result:'applied'}>,workspace:Workspace):void {
    if(ack.appliedRevision!==(entry.savedRevision??entry.request.expectedRevision))throw invalid('The acknowledgment revision does not match its presentation write.');
    if(entry.savedRevision!==undefined)return;
    if(workspace.revision!==entry.request.expectedRevision)throw invalid('The workspace changed before an unsaved presentation acknowledgment.');
    if(entry.request.intent.action!=='notice')validateControlChange(workspace,entry.request,{expectedRevision:workspace.revision,conversationLayout:controlLayout(workspace)});
  }
  async ack(raw:Record<string,unknown>):Promise<ControlReceipt> {
    const ack:ControlAck=safe(()=>readControlAck(raw)),entry=this.entry(ack.requestId);this.match(entry,ack);const workspace=await this.registry.store.workspace(ack.workspaceId);this.enabled(workspace);this.match(entry,ack);
    if(ack.result==='applied') {this.applied(entry,ack,workspace);await this.finish(entry,'applied',undefined,ack.appliedRevision);}
    else {if(ack.result==='refused'&&(entry.savedRevision!==undefined||entry.saving))throw invalid('A dispatched selection requires an unconfirmed result, not refusal.');await this.finish(entry,ack.result,ack.result==='refused'?ack.refusalCode:'browser_unconfirmed');}
    return structuredClone(entry.receipt);
  }
  async workspaceChanged(workspace:Workspace):Promise<void> {if(workspace.agentControl===false)await Promise.all([...this.entries.values()].filter(entry=>entry.request.workspaceId===workspace.id&&entry.receipt.state==='pending').map(entry=>this.finish(entry,'unconfirmed','control_disabled')));}
  private finish(entry:Entry,state:ControlReceipt['state'],code?:string,revision?:number):Promise<void> {
    if(entry.finishing)return entry.finishing;if(entry.receipt.state!=='pending')return Promise.resolve();clearTimeout(entry.timer);entry.timer=undefined;
    entry.finishing=(async()=> {
      let receipt:ControlReceipt={...entry.receipt,state,...(code?{code}:{}),...(revision===undefined?{}:{appliedRevision:revision})};
      try {await this.record(entry.request,state,revision);}catch {receipt={...receipt,state:'unconfirmed',code:'control_log_unavailable'};}
      entry.receipt=receipt;
      const label=resultLabel(entry.request,receipt);
      this.registry.journal.publish('notice',undefined,{level:receipt.state==='applied'?'info':'warning',message:`${entry.request.actor}: ${label}`,code:`control_${receipt.state}`},entry.request.workspaceId);
      entry.waiter?.(structuredClone(receipt));entry.waiter=undefined;
      const terminal=[...this.entries].filter(([,item])=>item.receipt.state!=='pending');for(const [id] of terminal.slice(0,Math.max(0,terminal.length-CONTROL_LIMITS.receipts)))this.entries.delete(id);
    })();return entry.finishing;
  }
  async close():Promise<void> {this.stopped=true;await Promise.all([...this.entries.values()].filter(entry=>entry.receipt.state==='pending').map(entry=>this.finish(entry,'unconfirmed','backend_stopped')));}
}
