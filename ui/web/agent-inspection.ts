import type {AgentInspectionView, ExactInspection, HistoryInspection, InspectionCheckpoint, InspectionEntry, InspectionText, InspectRequest, ResultInspection, ResultSelector} from '../shared/inspection.ts';
import {validInspectionCheckpoint, validResultSelector} from '../shared/inspection.ts';
import type {ProjectedFrame} from '../shared/api.ts';
import {button, copy, details, element, setText} from './dom.ts';
import {markdownDom} from './safe-markdown.ts';
import {reconcileChildren} from './render.ts';
import {taskReference, type ConversationTask, type TaskReference, type TaskAnswer} from './conversation-tasks.ts';

type Mode=InspectionCheckpoint['mode'];
export type InspectionHooks={read(request:InspectRequest,signal:AbortSignal):Promise<AgentInspectionView>;
  readResult?:(identity:string,selector:ResultSelector,signal:AbortSignal)=>Promise<AgentInspectionView>;
  tasks?:()=>readonly ConversationTask[];entryKey?:(native:number)=>string|undefined;history?:boolean;showConversation?:(entry:string,identity?:string)=>void;moreConversation?:()=>void;
  changed():void;current():boolean;restore():unknown;save(value:InspectionCheckpoint|null):void};
/** Tasks are selected from recorded asks and exact public references, never from typed internal keys. */
export class AgentInspection {
  readonly navigation=element('div','inspection-navigation');
  readonly node=element('section','agent-inspection');
  readonly scroller=element('div','inspection-content');
  private readonly status=element('p','inspection-status inspection-read-status');
  private readonly content=element('div');
  private readonly conversationButton:HTMLButtonElement;
  private readonly resultButton:HTMLButtonElement;
  private readonly refresh:HTMLButtonElement;
  private readonly hooks:InspectionHooks;
  private readonly identity:string;
  private mode?:Mode;
  private selector:ResultSelector={};
  private entryId?:number;
  private offset=0;
  private scrollTop=0;
  private visible=false;
  private controller?:AbortController;
  private serial=0;
  private pending=false;
  private loaded?:AgentInspectionView;
  private pageOffsets:number[]=[];
  private frame?:ProjectedFrame;
  private history?:HistoryInspection;
  private historyAll?:HistoryInspection;
  private answers=new Map<string,ResultInspection>();
  private selected?:string;
  private shown=20;
  private readKeys=new Set<string>();
  private sections=new Map<boolean,HTMLElement>();
  private taskNodes=new Map<string,{node:HTMLElement;select:HTMLButtonElement;body:HTMLElement;row:ConversationTask;open:boolean;answerText?:string;result?:ResultInspection;reason?:string}>();
  constructor(identity:string,hooks:InspectionHooks){
    this.identity=identity;this.hooks=hooks;this.node.hidden=true;
    this.scroller.tabIndex=0;this.scroller.setAttribute('aria-label','Conversation tasks');this.status.setAttribute('role','status');
    this.conversationButton=button('Conversation',()=>this.conversation());this.resultButton=button('Tasks',()=>this.open('result'));
    this.navigation.setAttribute('aria-label','Conversation views');this.navigation.append(this.conversationButton,this.resultButton);
    this.refresh=button('Refresh tasks',()=>{this.cancel();this.readKeys.clear();this.history=undefined;this.historyAll=undefined;if(this.hasSelector())void this.load();else void this.loadTasks();});
    this.scroller.append(this.content);this.node.append(this.status,this.refresh,this.scroller);
    this.scroller.addEventListener('scroll',()=>{this.scrollTop=this.scroller.scrollTop;});this.scroller.addEventListener('scrollend',()=>this.persist());
    try{const saved=hooks.restore();if(validInspectionCheckpoint(saved)&&saved.identity===identity)this.restore(saved);}catch{/* Storage is optional. */}
    this.paintMode();
  }
  observe(frame:ProjectedFrame|undefined,_live:boolean):void {this.frame=frame;if(this.mode==='result'&&!this.hasSelector()&&this.visible&&!this.protectedContent())this.renderTasks();}
  get active():boolean{return this.mode!==undefined;}
  get busy():boolean{return this.pending;}
  checkpoint():InspectionCheckpoint|undefined{return this.mode?{identity:this.identity,mode:this.mode,selector:{...this.selector},...(this.entryId?{entryId:this.entryId}:{}),offset:this.offset,scrollTop:this.scrollTop}:undefined;}
  restore(value:InspectionCheckpoint):boolean{
    if(!validInspectionCheckpoint(value)||value.identity!==this.identity||value.mode==='activity')return false;
    this.cancel();this.visible=false;this.mode=value.mode;this.selector={...value.selector};this.entryId=value.entryId;this.offset=value.offset;this.scrollTop=value.scrollTop;this.loaded=undefined;this.paintMode();return true;
  }
  open(mode:'result',selector?:ResultSelector):void{
    if(selector&&!validResultSelector(selector))return;
    this.cancel();this.mode=mode;this.selector=selector?{...selector}:{};this.offset=0;this.entryId=undefined;this.scrollTop=0;this.loaded=undefined;this.selected=undefined;
    this.content.replaceChildren();this.paintMode();this.persist();this.hooks.changed();
    if(this.visible){if(this.hasSelector())void this.load();else void this.loadTasks();}
  }
  conversation():void{this.cancel();this.mode=undefined;this.paintMode();this.persist();this.hooks.changed();}
  visibility(visible:boolean):void{
    if(this.visible===visible)return;this.visible=visible;if(!visible){this.cancel();return;}
    if(this.mode&&!this.loaded){if(this.hasSelector()||this.mode==='exact')void this.load();else void this.loadTasks();}this.scroller.scrollTop=this.scrollTop;
  }
  destroy():void{this.cancel();this.navigation.remove();this.node.remove();}
  private hasSelector():boolean{return Object.keys(this.selector).length>0;}
  private protectedContent():boolean{const selection=document.getSelection();return !!selection&&!selection.isCollapsed&&this.content.contains(selection.anchorNode);}
  private paintMode():void{this.node.hidden=!this.mode;this.conversationButton.setAttribute('aria-pressed',String(!this.mode));this.resultButton.setAttribute('aria-pressed',String(!!this.mode));this.node.dataset.view=this.mode??'conversation';if(!this.mode)setText(this.status,'');}
  private persist():void{try{this.hooks.save(this.checkpoint()??null);}catch{/* The current tab retains its state. */}}
  private cancel():void{this.serial++;this.controller?.abort();this.controller=undefined;this.pending=false;this.refresh.disabled=false;}
  private current(serial:number,signal:AbortSignal):boolean{return !signal.aborted&&serial===this.serial&&this.visible&&this.hooks.current();}
  private async loadTasks(cursor?:HistoryInspection['nextCursor']):Promise<void>{
    this.cancel();const controller=new AbortController(),serial=this.serial;this.controller=controller;this.pending=true;this.refresh.disabled=true;this.renderTasks();
    try{
      if(this.hooks.history!==false){
        const page=await this.hooks.read({view:'history',source:'user',limit:20,...(cursor?{cursor}:{})},controller.signal);
        if(!this.current(serial,controller.signal))return;if(page.view!=='history'||page.identity!==this.identity)throw Error('The task history target changed.');this.history=page;
        const all=await this.hooks.read({view:'history',limit:100},controller.signal);
        if(!this.current(serial,controller.signal))return;if(all.view!=='history'||all.identity!==this.identity)throw Error('The reply history target changed.');this.historyAll=all;
      }
      this.renderTasks();await this.readVisibleAnswers(serial,controller.signal);if(this.current(serial,controller.signal)){setText(this.status,'Recorded tasks and available answers.');this.renderTasks();}
    }catch(error){if(this.current(serial,controller.signal))setText(this.status,error instanceof Error?error.message:'Task history is unavailable.');}
    finally{if(serial===this.serial){this.pending=false;this.refresh.disabled=false;this.controller=undefined;}}
  }
  private rows():ConversationTask[]{
    const local=[...(this.hooks.tasks?.()??[])],rows=this.history?local.filter(row=>!row.asked):[...local];
    for(const entry of this.history?.entries??[]){
      const carrier=entry.communication;let reference:TaskReference|undefined;
      if(carrier?.state==='ready'&&carrier.origin.kind==='native'&&carrier.origin.target.mode==='input'){
        const target=carrier.origin.target;reference=taskReference({sessionId:target.conversationId===1?target.storageId:`${target.storageId}:${target.conversationId}`,submissionId:target.submissionId,requestId:target.requestId});
      }
      const nativeKey=this.hooks.entryKey?.(entry.id)??String(entry.id);
      const existing=local.find(row=>row.asked&&(reference&&row.reference&&reference.sessionId===row.reference.sessionId&&reference.submissionId===row.reference.submissionId&&!(reference.requestId&&row.reference.requestId&&reference.requestId!==row.reference.requestId)||row.entryId===nativeKey));
      if(existing){rows.push({...existing,subject:entry.text.text.split(/\r?\n/,1)[0]?.slice(0,80)||existing.subject});continue;}
      const replies=reference?undefined:recordedReplies(entry.id,this.historyAll?.entries??[]),body=carrier?.state==='ready'?carrier.value.body.text:entry.text.text;
      rows.push({key:`history:${entry.id}`,entryId:nativeKey,reference,subject:body.split(/\r?\n/,1)[0]?.slice(0,80)||'Recorded input',asked:true,state:reference?'awaiting':'recorded',...(replies?{answer:replies}:{}),...(carrier?.state==='ready'&&carrier.value.sender.name?{asker:carrier.value.sender.name}:{})});
    }
    const pendingRows:ConversationTask[]=[];
    const submissions=this.frame?.status.submissions;
    if(Array.isArray(submissions?.value))for(const value of submissions.value.slice(-100).reverse()){
      if(!value||typeof value!=='object'||Array.isArray(value))continue;
      const item=value as Record<string,unknown>;if(item.type!=='input'||!['queued','placed'].includes(String(item.status)))continue;
      const reference=taskReference({sessionId:this.identity,submissionId:item.id,...(typeof item.requestId==='string'&&item.requestId?{requestId:item.requestId}:{})});
      if(!reference||rows.some(row=>referenceKey(row.reference)===referenceKey(reference)))continue;
      const entry=this.history?.entries.find(entry=>entry.id===item.entryId);
      pendingRows.push({key:`pending:${reference.submissionId}`,entryId:entry?String(entry.id):'',reference,subject:entry?.text.text.split(/\r?\n/,1)[0]?.slice(0,80)||'Admitted input',state:item.status==='queued'?'queued':'awaiting',asked:true});
    }
    return [...pendingRows,...rows];
  }
  private async readVisibleAnswers(serial:number,signal:AbortSignal):Promise<void>{
    const rows=this.rows().filter(row=>row.reference&&!row.answer).slice(0,20);
    for(const row of rows){
      const reference=row.reference;if(!reference)continue;const key=referenceKey(reference);if(this.readKeys.has(key))continue;
      try{
        const selector={submissionId:reference.submissionId,...(reference.requestId?{requestId:reference.requestId}:{})};
        const value=this.hooks.readResult?await this.hooks.readResult(reference.sessionId,selector,signal):reference.sessionId===this.identity?await this.hooks.read({view:'result',...selector},signal):undefined;
        if(!this.current(serial,signal))return;if(value?.view!=='result'||value.identity!==reference.sessionId||!resultMatches(value,selector))continue;
        this.readKeys.add(key);this.answers.set(key,value);if(this.answers.size>200){const first=this.answers.keys().next().value;if(first)this.answers.delete(first);}
        if(!this.protectedContent())this.renderTasks();
      }catch(error){if(signal.aborted)return;this.readKeys.delete(key);if(this.current(serial,signal))setText(this.status,error instanceof Error?error.message:'An answer is unavailable.');}
    }
  }
  private renderTasks():void{
    if(this.protectedContent())return;const rows=this.rows(),nodes:HTMLElement[]=[];
    for(const [asked,title] of [[false,'Sent by this conversation'],[true,'Recorded inputs and asks']] as const){
      let section=this.sections.get(asked);if(!section){section=element('section','task-section');section.append(element('h3',undefined,title),element('div','task-rows'));this.sections.set(asked,section);}
      const selected=rows.filter(row=>!!row.asked===asked).slice(0,this.shown),list=section.querySelector<HTMLElement>('.task-rows');
      const children=selected.map(row=>this.taskRow(row));if(!children.length)children.push(element('p','secondary',asked?'No recorded inputs in the loaded history.':'No linked sent tasks in the loaded conversation.'));
      if(list)reconcileChildren(list,children);nodes.push(section);
    }
    if(rows.filter(row=>row.asked).length>this.shown||rows.filter(row=>!row.asked).length>this.shown)nodes.push(button('Show more recorded tasks',()=>{this.shown+=20;this.renderTasks();}));
    if(this.frame?.status.submissions?.truncated)nodes.push(element('p','secondary','Some native task status is not shown.'));
    if(this.history?.nextCursor){const cursor=this.history.nextCursor;nodes.push(button('Earlier asks',()=>{this.selected=undefined;void this.loadTasks(cursor);}));}
    if(this.hooks.moreConversation)nodes.push(button('Load earlier conversation',this.hooks.moreConversation));
    if(this.history?.detail.text)nodes.push(details('Read details',this.history.detail.text));
    reconcileChildren(this.content,nodes);
    for(const [key,cached] of this.taskNodes)if(!this.content.contains(cached.node))this.taskNodes.delete(key);
  }
  private taskRow(row:ConversationTask):HTMLElement{
    const result=row.reference?this.answers.get(referenceKey(row.reference)):undefined;
    const state=row.answer?row.state==='unanswered'?'no answer':row.state==='recorded'?'recorded reply':'answered':result?resultLabel(result):row.state==='queued'?'waiting to start':row.reference?'awaiting answer':'recorded input';
    let cached=this.taskNodes.get(row.key);
    if(!cached){const node=element('section','task-row'),select=button('',()=>{this.selected=this.selected===row.key?undefined:row.key;this.renderTasks();this.persist();if(this.selected)void this.readSelected(row.key);}),body=element('div','task-answer');select.className='task-select';node.append(select,body);cached={node,select,body,row,open:false};this.taskNodes.set(row.key,cached);}
    cached.row=row;setText(cached.select,[row.asker,row.subject,state].filter(Boolean).join(' · '));cached.select.dataset.state=state;cached.select.setAttribute('aria-expanded',String(this.selected===row.key));
    const item=cached.body;item.hidden=this.selected!==row.key;
    const currentAnswer=row.answer??(result?.answer?{text:result.answer.text,complete:!result.answer.shortened,redacted:result.answer.protected}:undefined);
    if(cached.open===(this.selected===row.key)&&cached.answerText===currentAnswer?.text&&cached.result===result&&cached.reason===row.reason)return cached.node;
    cached.open=this.selected===row.key;cached.answerText=currentAnswer?.text;cached.result=result;cached.reason=row.reason;item.replaceChildren();
    if(this.selected===row.key){
      const answer=row.answer??(result?.answer?{text:result.answer.text,complete:!result.answer.shortened,redacted:result.answer.protected}:undefined);
      if(answer){item.append(markdownDom(answer.text),button('Copy answer',()=>{void copy(answer.text,item);}));if(!answer.complete||answer.redacted)item.append(element('p','secondary',answer.redacted?'Some answer text is withheld.':'Only retained answer text is shown.'));}
      else item.append(element('p','secondary',result?.reason?.text??'No answer is present in this read.'));
      if(row.reason)item.append(element('p','secondary',row.reason));
      if(this.hooks.showConversation)item.append(button('Show in conversation',()=>{this.conversation();const native=row.answerReference??(result?.answerEntryId&&row.reference?{identity:row.reference.sessionId,entryId:result.answerEntryId}:undefined);if(row.answerEntryId)this.hooks.showConversation?.(row.answerEntryId);else if(native)this.hooks.showConversation?.(String(native.entryId),native.identity);else this.hooks.showConversation?.(row.entryId);}));
      item.append(details('Details',JSON.stringify({reference:row.reference,entryId:row.entryId,...(result?{status:result.status,answerEntryId:result.answerEntryId}: {})},null,2)));
    }
    return cached.node;
  }
  private async readSelected(key:string):Promise<void>{
    const row=this.rows().find(row=>row.key===key);if(!row?.reference||row.answer||this.answers.has(referenceKey(row.reference)))return;
    this.cancel();const controller=new AbortController(),serial=this.serial;this.controller=controller;
    try{const reference=row.reference,selector={submissionId:reference.submissionId,...(reference.requestId?{requestId:reference.requestId}:{})};const value=this.hooks.readResult?await this.hooks.readResult(reference.sessionId,selector,controller.signal):await this.hooks.read({view:'result',...selector},controller.signal);if(this.current(serial,controller.signal)&&value.view==='result'&&value.identity===reference.sessionId&&resultMatches(value,selector)){this.answers.set(referenceKey(reference),value);this.renderTasks();}}
    catch(error){if(this.current(serial,controller.signal))setText(this.status,error instanceof Error?error.message:'The answer is unavailable.');}
    finally{if(serial===this.serial)this.controller=undefined;}
  }
  private async load():Promise<void>{
    if(!this.visible||!this.hooks.current())return;
    const request:InspectRequest=this.mode==='exact'?{view:'exact',entryId:this.entryId as number,offset:this.offset}:{view:'result',...this.selector};
    this.cancel();const controller=new AbortController(),serial=this.serial;this.controller=controller;this.pending=true;this.refresh.disabled=true;setText(this.status,'Reading the selected answer…');
    try{
      const value=await this.hooks.read(request,controller.signal);if(!this.current(serial,controller.signal))return;
      if(value.identity!==this.identity||value.view!==request.view)throw Error('The answer target changed.');
      if(value.view==='result'&&request.view==='result'&&!resultMatches(value,request))throw Error('The result reference does not match.');
      if(value.view==='exact'&&request.view==='exact'&&(value.entryId!==request.entryId||value.offset!==request.offset))throw Error('The entry page changed.');
      this.loaded=value;this.content.replaceChildren(...(value.view==='exact'?this.renderExact(value):value.view==='result'?this.renderResult(value):[]));this.scroller.scrollTop=this.scrollTop;setText(this.status,`Read at ${value.readAt}`);this.persist();
    }catch(error){if(this.current(serial,controller.signal))setText(this.status,error instanceof Error?error.message:'The answer is unavailable.');}
    finally{if(serial===this.serial){this.pending=false;this.refresh.disabled=false;this.controller=undefined;}}
  }
  private prose(value:InspectionText):HTMLElement{const section=element('section','inspection-text');section.append(markdownDom(value.text));if(value.shortened||value.protected)section.append(element('p','secondary',[value.shortened?'Display shortened':'',value.protected?'Some text withheld':''].filter(Boolean).join(' · ')));return section;}
  private exactEntry(id:number):void{this.mode='exact';this.entryId=id;this.offset=0;this.pageOffsets=[];this.scrollTop=0;this.loaded=undefined;this.paintMode();this.persist();void this.load();}
  private renderResult(value:ResultInspection):HTMLElement[]{
    const nodes:HTMLElement[]=[element('h3',undefined,resultLabel(value))];if(value.answer)nodes.push(this.prose(value.answer),button('Copy answer',()=>{void copy(value.answer?.text??'',this.node);}));if(value.reason)nodes.push(this.prose(value.reason));
    const diagnostic=details('Details','');diagnostic.append(resultFacts(value));if(value.answerEntryId)diagnostic.append(button('Read exact answer source',()=>this.exactEntry(value.answerEntryId as number)));if(value.entryId)diagnostic.append(button('Read exact input source',()=>this.exactEntry(value.entryId as number)));diagnostic.append(details('Usage',JSON.stringify(value.usage.value,null,2)),button('Copy agent ID',()=>{void copy(this.identity,this.node);}));if(value.providerBlock)diagnostic.append(details('Provider block',JSON.stringify(value.providerBlock.value,null,2)));if(value.recoveryOf)diagnostic.append(this.prose(value.recoveryOf));nodes.push(diagnostic);return nodes;
  }
  private renderExact(value:ExactInspection):HTMLElement[]{
    const raw=element('pre','raw');setText(raw,value.text.text);const nodes:HTMLElement[]=[element('h3',undefined,'Recorded source'),element('p','secondary','Protected raw entry page, not a complete answer export.'),raw];
    if(value.text.protected)nodes.push(element('p','secondary','Some text withheld.'));nodes.push(button('Copy displayed source page',()=>{void copy(value.text.text,this.node);}));
    if(this.pageOffsets.length)nodes.push(button('Previous page',()=>{this.offset=this.pageOffsets.pop()??0;void this.load();}));const next=value.nextOffset;if(next!==null)nodes.push(button('Next page',()=>{this.pageOffsets.push(value.offset);this.offset=next;void this.load();}));return nodes;
  }
}
function referenceKey(reference?:TaskReference):string{return reference?JSON.stringify([reference.sessionId,reference.submissionId,reference.requestId??null]):'';}
function resultMatches(value:ResultInspection,request:ResultSelector):boolean{return !(['submissionId','requestId','operationId'] as const).some(key=>request[key]!==undefined&&(value[key]!==undefined||value.status!=='unavailable')&&value[key]!==request[key]);}
function resultLabel(value:ResultInspection):string{return value.status==='done'?(value.answer?'answered':'answer text unavailable'):value.status==='unanswered'?'no answer':value.status==='queued'?'waiting to start':value.status==='placed'?'awaiting answer':'answer unavailable';}
function resultFacts(value:ResultInspection):HTMLElement{const facts=element('dl','kv');for(const [name,id] of [['Submission',value.submissionId],['Native request',value.requestId],['Native operation',value.operationId],['Input entry',value.entryId],['Answer entry',value.answerEntryId]])if(id!==undefined)facts.append(element('dt',undefined,String(name)),element('dd',undefined,String(id)));return facts;}
/** Entry order groups recorded conversation replies; it does not create a Durable task outcome. */
function recordedReplies(id:number,entries:readonly InspectionEntry[]):TaskAnswer|undefined{
  const ordered=[...entries].reverse(),at=ordered.findIndex(entry=>entry.id===id);if(at<0)return;
  const replies:InspectionEntry[]=[];for(const entry of ordered.slice(at+1)){if(entry.source==='user')break;if(entry.source==='assistant'&&entry.text.text.trim())replies.push(entry);}
  return replies.length?{text:replies.map(entry=>entry.text.text).join('\n\n'),complete:replies.every(entry=>!entry.truncated&&!entry.text.shortened),redacted:replies.some(entry=>entry.text.protected)}:undefined;
}
