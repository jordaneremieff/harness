import type {AgentRow, Target, EntryView, MessageView, PartView, ImageView, CommunicationSender, ProjectedFrame} from '../shared/api.ts';
import {agentRequest, requestKey, type AgentRequest} from './agent-request.ts';
import {attachmentParts} from './attachment-parts.ts';
import {cardIcon} from './card-icons.ts';
import {transcriptImage} from './image.ts';
import {messageCopyText} from './communication.ts';
import type {Attention} from './attention.ts';
import type {ConversationPresentation} from './conversation-presentation.ts';
import {button, copy, element, rawText, setText} from './dom.ts';
import {compactAge, isValidTimestamp, toolArgumentText} from './format.ts';

function blockedFact(row: AgentRow | undefined, view: ConversationPresentation, attention?: Attention): string {
  if(attention?.label === 'Failed')return 'Turn failed';
  if(attention?.label !== 'Blocked')return '';
  if(view.activity === 'Provider blocked')return 'Provider blocked';
  const hint=row?.attention;
  if(hint?.kind === 'task-blocked')return hint.reason ? `Task blocked: ${hint.reason.replaceAll('_',' ')}` : 'Task blocked';
  return 'Provider blocked';
}
function stateWord(row: AgentRow | undefined, view: ConversationPresentation, hasFrame: boolean): string {
  if(!row && !hasFrame)return '';
  if(view.hideVisibleState && row) {
    const states:Record<string,string>={working:'Working',idle:'Idle',starting:'Starting',done:'Done',failed:'Failed',stopped:'Stopped',interrupted:'Interrupted',new:'New',unavailable:'Not reachable'};
    return states[row.state] ?? view.activity;
  }
  return view.activity;
}
function usefulState(state:string):string {
  return ['Idle','Done','Ready'].includes(state)?'':state;
}
function toolFact(row: AgentRow | undefined, view: ConversationPresentation, attention?: Attention): string {
  if(attention)return blockedFact(row,view,attention);
  const current=view.tool ?? (view.hideVisibleState && row?.state === 'working' ? row.currentTool : undefined);
  return current ? [current.name,toolArgumentText(current.argument)].filter(Boolean).join(' ') : '';
}
export function createAgentLiveStrip(kind: Target['kind'], root: HTMLElement): AgentLiveStrip | undefined {
  if(kind !== 'agent')return;
  const strip=new AgentLiveStrip();root.prepend(strip.node);return strip;
}
export type AgentContext = {identity:string;entries:readonly EntryView[];frame?:ProjectedFrame;beginning:boolean;
  caption:(sender:CommunicationSender)=>string;resolve:(id:string,answer?:boolean)=>string|undefined;reveal:(id:string)=>void;
  expanded:(key:string)=>boolean;disclosure:(key:string,open:boolean)=>void;layout:(change:()=>void)=>void;image:(part:ImageView)=>string|undefined;preview:(part:ImageView,url:string,opener:HTMLElement)=>void};
export type AgentContextReload = {request?:{entry:EntryView;messageId:string;answerId?:string};scrollTop:number;sourceOpen:boolean;focus?:string};
function plainPart(part:PartView):string {
  switch(part.type){case 'text':case 'thinking':return part.redacted?'':part.text;case 'image':return part.alt;case 'omitted':return part.label;case 'toolResult':return plainParts(part.parts);default:return '';}
}
function plainParts(parts:readonly PartView[]):string {return parts.map(plainPart).join('\n');}
/** Current work and retained requests share the exact conversation's presentation owner. */
export class AgentLiveStrip {
  readonly node=element('div','agent-live-strip');
  private state=element('span','agent-live-state');
  private tool=element('span','agent-live-tool');
  private facts=element('div','agent-live-facts');
  private line=element('div','agent-request-row');
  private toggle=button('',()=>this.toggleRequest(),'agent-request-title');
  private label=element('span','agent-request-label');
  private requestLink=button('Go to request',()=>this.navigate(false));
  private answerLink=button('Go to answer',()=>this.navigate(true));
  private body=element('div','agent-request-body');
  private context?:AgentContext;
  private selected?:AgentRequest;
  private retained?:AgentRequest;
  private bodySignature?:string;
  private source?:HTMLDetailsElement;
  private pendingRestore?:AgentContextReload;
  private previewText?:{message:MessageView;text:string};
  constructor() {
    this.node.hidden=true;this.node.setAttribute('role','group');this.node.setAttribute('aria-label','Agent context');
    this.facts.append(this.state,this.tool);this.facts.hidden=true;
    this.toggle.append(cardIcon('chevron'),this.label);this.line.append(this.toggle);this.line.hidden=true;this.body.hidden=true;
    this.requestLink.hidden=this.answerLink.hidden=true;
    for(const [key,node]of Object.entries({toggle:this.toggle,request:this.requestLink,answer:this.answerLink}))node.dataset.contextFocus=key;
    this.node.append(this.facts,this.line,this.body);
  }
  updateContext(context:AgentContext):void {
    const previous=this.context;this.context=context;
    if(!previous||previous.entries!==context.entries||previous.frame?.status.submissions!==context.frame?.status.submissions||previous.beginning!==context.beginning)this.selected=agentRequest(context.entries,context.frame,context.beginning);
    this.updateRequestRow(context);this.syncRequestBody(context);this.updateNavigation(context);
    this.refreshVisibility();this.applyReload();
  }
  private requestLabel(request:AgentRequest,context:AgentContext):string {
    if(this.previewText?.message!==request.message)this.previewText={message:request.message,text:plainParts(request.message.parts).split(/\r?\n/,1)[0]??''};
    const sender=request.entry.sender,at=request.message.timestamp;
    const age=at!==undefined&&isValidTimestamp(at)?compactAge(at,Date.now()):'';
    return [`${request.label}: ${this.previewText.text}`,sender?`from ${context.caption(sender)}`:'',age].filter(Boolean).join(' · ');
  }
  private updateRequestRow(context:AgentContext):void {
    const selected=this.selected;
    this.line.hidden=!selected;
    const label=selected?this.requestLabel(selected,context):'';
    if(this.label.textContent!==label)setText(this.label,label);
    this.toggle.title=selected?`${label}\n${selected.entry.id}`:'';this.toggle.disabled=!selected;
    this.toggle.setAttribute('aria-expanded',String(!!selected&&context.expanded(requestKey(selected))));
  }
  private navigationRequest():AgentRequest|undefined {
    const retained=this.retained;
    if(retained){const linked=agentRequest([retained.entry],this.context?.frame,true);if(linked?.message.id===retained.message.id&&linked.answerId)retained.answerId=linked.answerId;}
    return retained;
  }
  private updateNavigation(context:AgentContext):void {
    const request=this.navigationRequest();
    this.requestLink.hidden=!request||!context.resolve(request.entry.id);
    this.answerLink.hidden=!request?.answerId||!context.resolve(request.answerId,true);
  }
  private refreshVisibility():void {this.node.hidden=this.facts.hidden&&this.line.hidden&&this.body.hidden;}
  private bodyProtected():boolean {
    const selection=document.getSelection();
    return this.body.contains(document.activeElement)||!!selection&&!selection.isCollapsed&&(this.body.contains(selection.anchorNode)||this.body.contains(selection.focusNode));
  }
  private syncRequestBody(context:AgentContext):void {
    if(this.bodyProtected())return;
    const selected=this.selected,retained=this.retained,showing=!!retained&&!this.body.hidden;
    // A supplied update must not replace the exact source the reader already opened.
    if(selected&&context.expanded(requestKey(selected))){if(!showing)this.renderRequest(selected);return;}
    if(!showing||selected&&requestKey(retained)===requestKey(selected)){this.body.hidden=true;this.retained=undefined;}
  }
  private toggleRequest():void {
    const request=this.selected,context=this.context;if(!request||!context)return;
    context.layout(()=>{const open=!this.retained||requestKey(this.retained)!==requestKey(request)||this.body.hidden;
      if(this.retained&&!this.body.hidden)context.disclosure(requestKey(this.retained),false);
      context.disclosure(requestKey(request),open);if(open)this.renderRequest(request);else{this.body.hidden=true;this.retained=undefined;}
      this.toggle.setAttribute('aria-expanded',String(open));this.refreshVisibility();});
  }
  private navigate(answer:boolean):void {
    const request=this.navigationRequest(),retained=this.retained,context=this.context,control=answer?this.answerLink:this.requestLink;
    if(!request||!retained||!this.current(retained,control))return;
    const id=answer?request.answerId:request.entry.id,resolved=id&&context?.resolve(id,answer);if(resolved)context?.reveal(resolved);
  }
  private renderPart(part:PartView,root:HTMLElement,path:string):void {
    const context=this.context;if(!context)return;
    if(part.type==='image'){const image=transcriptImage(part,context.image(part),()=>{},context.preview);for(const [index,node]of [...image.querySelectorAll<HTMLElement>('button,summary')].entries())node.dataset.contextFocus=`image:${path}:${index}`;root.append(image);return;}
    if(part.type==='toolResult'){part.parts.forEach((child,index)=>{this.renderPart(child,root,`${path}:${index}`);});return;}
    if(part.type==='text'||part.type==='thinking'){
      root.append(element('pre','agent-request-text',part.redacted?'Redacted text':part.text));
      if(part.more)root.append(element('p','secondary','Additional source text is not loaded. Use Go to request for the existing source controls.'));
    }else root.append(element('pre','agent-request-text',part.type==='omitted'?part.label:rawText(part)));
  }
  private renderRequest(request:AgentRequest):void {
    const previous=this.retained,same=previous&&requestKey(previous)===requestKey(request);
    this.body.hidden=false;this.retained=request;if(this.context)this.updateNavigation(this.context);
    if(same&&previous.entry===request.entry)return;
    const signature=JSON.stringify([request.message.id,request.entry]);if(this.bodySignature===signature)return;
    const scrollTop=same?this.body.scrollTop:0,sourceOpen=!!same&&this.source?.open===true;
    this.bodySignature=signature;this.body.replaceChildren();
    const first=plainParts(request.message.parts).split(/\r?\n/,1)[0]??'';
    const heading=element('div','agent-request-body-heading',`Request entry ${request.entry.id} · ${first}`);
    const copied=button('Copy',()=>{if(this.current(request,copied))void copy(messageCopyText(request.message,message=>plainParts(message.parts)),copied);});copied.dataset.contextFocus='copy';copied.title='Copy retained supplied request text';
    const close=button('Close request',()=>{const context=this.context;if(!context||!this.current(request,close))return;context.layout(()=>{context.disclosure(requestKey(request),false);this.body.hidden=true;this.retained=undefined;this.toggle.setAttribute('aria-expanded','false');this.refreshVisibility();if(!this.toggle.disabled)this.toggle.focus({preventScroll:true});});});close.dataset.contextFocus='close';
    const actions=element('div','agent-request-actions');actions.append(this.requestLink,this.answerLink,copied,close);
    heading.append(actions);this.body.append(heading);
    request.message.parts.forEach((_part,index)=>{attachmentParts(request.message,index).forEach((part,child)=>{this.renderPart(part,this.body,`${index}:${child}`);});});
    const coverage=request.message.coverage;
    if(!coverage.complete||coverage.truncated||coverage.omitted)this.body.append(element('p','secondary',coverage.reason??'Only the supplied request parts are available.'));
    const source=element('details','agent-request-source'),summary=element('summary',undefined,'Source');summary.dataset.contextFocus='source';
    const copySource=button('Copy source',()=>{if(source.open&&this.current(request,copySource))void copy(JSON.stringify(request.entry,null,2),copySource);});copySource.dataset.contextFocus='copy-source';
    source.append(summary,copySource,element('pre','agent-request-text',JSON.stringify(request.entry,null,2)));this.source=source;
    const sourceKey=`${requestKey(request)}:source`;source.open=sourceOpen||this.context?.expanded(sourceKey)===true;
    source.addEventListener('toggle',()=>{if(this.source===source&&!this.body.hidden&&this.context?.expanded(sourceKey)!==source.open)this.context?.disclosure(sourceKey,source.open);});this.body.append(source);this.body.scrollTop=scrollTop;
  }
  private current(request:AgentRequest,control:HTMLElement):boolean {
    return this.retained?.entry===request.entry&&this.retained.message.id===request.message.id&&!this.body.hidden&&this.node.isConnected&&this.body.contains(control)&&!control.closest('[hidden],[inert]');
  }
  captureReload():AgentContextReload {
    if(this.pendingRestore)return this.pendingRestore;
    const active=document.activeElement as HTMLElement|null,retained=this.navigationRequest();
    return {request:retained&&!this.body.hidden?{entry:retained.entry,messageId:retained.message.id,...(retained.answerId?{answerId:retained.answerId}:{})}:undefined,scrollTop:this.body.scrollTop,sourceOpen:this.source?.open===true,focus:active&&this.node.contains(active)?active.dataset.contextFocus:undefined};
  }
  restoreReload(saved:AgentContextReload):void {
    if(!saved||!Number.isFinite(saved.scrollTop)||saved.scrollTop<0||typeof saved.sourceOpen!=='boolean')throw new Error('The retained agent context is invalid.');
    if(saved.request){const entry=saved.request.entry,message=entry?.messages?.find(value=>value.id===saved.request?.messageId),answerId=saved.request.answerId;
      if(!entry?.id||!message||message.role!=='user'||message.communication!==undefined||!Array.isArray(message.parts)||!message.coverage)throw new Error('The exact retained request is unavailable.');
      if(answerId!==undefined&&(typeof answerId!=='string'||!/^[1-9]\d*$/.test(answerId)||!Number.isSafeInteger(Number(answerId))))throw new Error('The retained request answer is invalid.');
      this.renderRequest({entry,message,label:'Latest request',...(answerId?{answerId}:{})});if(this.source)this.source.open=saved.sourceOpen;
    }else{this.body.hidden=true;this.retained=undefined;}
    this.pendingRestore=saved;this.refreshVisibility();this.applyReload();
  }
  private applyReload():void {
    const saved=this.pendingRestore;if(!saved||!this.node.isConnected||this.node.closest('[hidden],[inert]'))return;
    this.body.scrollTop=saved.scrollTop;
    if(saved.focus){const node=[...this.node.querySelectorAll<HTMLElement>('[data-context-focus]')].find(node=>node.dataset.contextFocus===saved.focus);if(!node||node.closest('[hidden],[inert]')||node instanceof HTMLButtonElement&&node.disabled)throw new Error('The retained agent context control is unavailable.');node.focus({preventScroll:true});}
    this.pendingRestore=undefined;
  }
  update(row: AgentRow | undefined, view: ConversationPresentation, attention: Attention | undefined, hasFrame: boolean): void {
    const state=usefulState(attention?.label ?? stateWord(row,view,hasFrame));
    setText(this.state,state);this.state.hidden=!state;
    this.state.dataset.tone=attention?.tone ?? (state === 'Working' ? 'info' : view.tone);
    this.state.title=state;this.state.setAttribute('aria-label',state);
    const tool=toolFact(row,view,attention);
    setText(this.tool,tool);this.tool.hidden=!tool;this.tool.title=tool;
    this.facts.hidden=!state&&!tool;this.refreshVisibility();
  }
}
