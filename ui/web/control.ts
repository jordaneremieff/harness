import type {ConversationLayout, PaneNode, WorkspaceTab} from '../shared/api.ts';
import {CONTROL_LIMITS, type ControlAck, type ControlIntent, type ControlProvenance, type ControlRequest} from '../shared/control.ts';
import {activatePaneTab, minimumPaneSize, openPaneTab, paneById, paneForTab, paneLeaves, paneSplitGeometry, resizePaneSplit, splitPane, validPaneLayout, type PaneSpace} from './pane-layout.ts';
import {tabKey} from './tabs.ts';

export class ControlRefusal extends Error {readonly code:string;constructor(code:string) {super(code);this.code = code;}}
function refuse(code:string):never {throw new ControlRefusal(code);}
function splitNode(node:PaneNode,id:string):Extract<PaneNode,{kind:'split'}>|undefined {return node.kind === 'split' ? node.id === id ? node : splitNode(node.first,id) ?? splitNode(node.second,id) : undefined;}
function swap(node:PaneNode,id:string):PaneNode {if(node.kind === 'pane')return node;if(node.id === id)return {...node,first:node.second,second:node.first};return {...node,first:swap(node.first,id),second:swap(node.second,id)};}
function reveal(layout:ConversationLayout,id:string,view?:WorkspaceTab):ConversationLayout {
  if(!paneById(layout,id))refuse('pane_missing');
  if(!view)return {...layout,focusedPane:id};
  const owner = paneForTab(layout,tabKey(view));if(owner && owner.id !== id)refuse('view_in_other_pane');
  return openPaneTab(layout,id,view);
}
function splitView(layout:ConversationLayout,intent:Extract<ControlIntent,{action:'split'}>,space:PaneSpace):ConversationLayout {
  const source = paneById(layout,intent.paneId);if(!source)refuse('pane_missing');
  const key = tabKey(intent.view),owner = paneForTab(layout,key);if(owner && owner.id !== source.id)refuse('view_in_other_pane');
  if(!source.tabs.length || owner && source.tabs.length < 2)refuse('source_empty');
  const prepared = owner ? layout : openPaneTab(layout,source.id,intent.view);
  const next = splitPane(prepared,source.id,intent.axis,space,key);if(next === prepared)refuse('geometry');
  return !owner && source.active ? {...activatePaneTab(next,source.id,source.active),focusedPane:next.focusedPane} : next;
}
function transform(layout:ConversationLayout,intent:ControlIntent,paneSpace:(id:string)=>PaneSpace):ConversationLayout {
  switch(intent.action) {
    case 'show': {const view:WorkspaceTab = {kind:'file',rootId:intent.rootId,path:intent.path,...(intent.preview ? {view:'preview'} : {})};return reveal(layout,intent.paneId ?? paneForTab(layout,tabKey(view))?.id ?? layout.focusedPane,view);}
    case 'focus':return reveal(layout,intent.paneId,intent.view);
    case 'split':return splitView(layout,intent,paneSpace(intent.paneId));
    case 'resize':if(!splitNode(layout.root,intent.splitId))refuse('split_missing');return resizePaneSplit(layout,intent.splitId,intent.ratio);
    case 'swap':if(!splitNode(layout.root,intent.splitId))refuse('split_missing');return {...layout,root:swap(layout.root,intent.splitId)};
    case 'notice':return layout;
  }
}
/** Closed presentation transforms retain every existing tab and native view identity. */
export function controlLayout(layout:ConversationLayout,intent:ControlIntent,space:PaneSpace,paneSpace:(id:string)=>PaneSpace):ConversationLayout {
  let next:ConversationLayout;
  try {next = transform(layout,intent,paneSpace);}catch(error) {if(error instanceof ControlRefusal)throw error;refuse('invalid_layout');}
  if(!validPaneLayout(next))refuse('invalid_layout');
  const minimum = minimumPaneSize(next.root,space.divider);
  if(next.root.kind === 'split' && (space.width < minimum.width || space.height < minimum.height))refuse('geometry');
  const keys = new Set(paneLeaves(next.root).flatMap(pane=>pane.tabs.map(tabKey)));
  if(paneLeaves(layout.root).some(pane=>pane.tabs.some(tab=>!keys.has(tabKey(tab)))))refuse('tab_loss');
  return next;
}
/** Uses the renderer's clamped split geometry without a trial render or native-view mutation. */
export function controlPaneBox(node:PaneNode,id:string,space:PaneSpace,x=0,y=0):{x:number;y:number;width:number;height:number}|undefined {
  if(node.kind === 'pane')return node.id === id ? {x,y,width:space.width,height:space.height} : undefined;
  const geometry = paneSplitGeometry(node,space);if(!geometry)return;
  const first = controlPaneBox(node.first,id,node.axis === 'x' ? {...space,width:geometry.first} : {...space,height:geometry.first},x,y);
  if(first)return first;
  const remaining = geometry.extent-geometry.first,offset = geometry.first+space.divider;
  return node.axis === 'x' ? controlPaneBox(node.second,id,{...space,width:remaining},x+offset,y) : controlPaneBox(node.second,id,{...space,height:remaining},x,y+offset);
}
export type ControlPage = {bootId:string;workspaceId:string;pageId:string;connectionId?:string;revision:number;enabled:boolean;connected:boolean};
type Hooks = {page:()=>ControlPage|undefined;busy:()=>string|undefined;apply:(request:ControlRequest)=>Promise<number>;ack:(ack:ControlAck)=>Promise<unknown>;now?:()=>number};
export function controlProvenance(request:ControlProvenance):ControlProvenance {const {requestId,bootId,workspaceId,pageId,connectionId}=request;return {requestId,bootId,workspaceId,pageId,connectionId};}
function addressed(page:ControlPage|undefined,request:ControlProvenance):page is ControlPage {
  return !!page?.connectionId && page.connected && page.bootId === request.bootId && page.workspaceId === request.workspaceId && page.pageId === request.pageId && page.connectionId === request.connectionId;
}
/** Stream incarnations address work; terminal uncertainty never replays an effect. */
export class BrowserControl {
  private seen = new Set<string>();private active = false;private settling = false;private hooks:Hooks;
  constructor(hooks:Hooks) {this.hooks = hooks;}
  get applying():boolean {return this.active;}
  private now():number {return this.hooks.now?.() ?? Date.now();}
  private refusal(page:ControlPage,request:ControlRequest):string|undefined {
    if(!page.enabled)return 'disabled';if(request.expiresAt <= this.now())return 'expired';
    if(page.revision !== request.expectedRevision)return 'stale_revision';if(this.active || this.settling)return 'busy';return this.hooks.busy();
  }
  private async application(request:ControlRequest):Promise<number> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    const expired = new Promise<never>((_resolve,reject)=> {timer = setTimeout(()=>reject(new Error('The presentation deadline expired.')),Math.max(0,request.expiresAt-this.now()));});
    this.settling = true;let work:Promise<number>;
    try {work = this.hooks.apply(request);}catch(error) {this.settling = false;clearTimeout(timer);throw error;}
    try {return await Promise.race([work.finally(()=> {this.settling = false;}),expired]);}finally {clearTimeout(timer);}
  }
  async receive(request:ControlRequest):Promise<void> {
    const page = this.hooks.page();if(!addressed(page,request) || this.seen.has(request.requestId))return;
    this.seen.add(request.requestId);if(this.seen.size > CONTROL_LIMITS.receipts)this.seen.delete(this.seen.values().next().value as string);
    const identity = controlProvenance(request),code = this.refusal(page,request);
    if(code) {await this.send({...identity,result:'refused',refusalCode:code});return;}
    this.active = true;
    try {
      const revision = await this.application(request),current = this.hooks.page();
      if(!addressed(current,identity) || !current.enabled || request.expiresAt <= this.now())throw new Error('The addressed page changed.');
      this.active = false;await this.send({...identity,result:'applied',appliedRevision:revision});
    } catch(error) {this.active = false;await this.send(error instanceof ControlRefusal ? {...identity,result:'refused',refusalCode:error.code} : {...identity,result:'unconfirmed'});}
  }
  private async send(ack:ControlAck):Promise<void> {try {await this.hooks.ack(ack);} catch {/* A missing receipt remains unconfirmed at the request owner. */}}
}
