import type {ActivityInspection, AgentInspectionView, ExactInspection, InspectionCheckpoint, InspectionEntry, InspectionText, InspectRequest, ResultInspection, ResultSelector} from '../shared/inspection.ts';
import {validInspectionCheckpoint, validResultSelector} from '../shared/inspection.ts';
import {button, copy, details, element, setText} from './dom.ts';
import {markdownDom} from './safe-markdown.ts';
import type {ProjectedFrame} from '../shared/api.ts';

type Mode = InspectionCheckpoint['mode'];
export type InspectionHooks = {read(request: InspectRequest, signal: AbortSignal): Promise<AgentInspectionView>;
  changed(): void; current(): boolean; restore(): unknown; save(value: InspectionCheckpoint | null): void};
/** One read-only inspection owner per exact agent; native message editors stay outside this subtree. */
export class AgentInspection {
  readonly navigation = element('div','inspection-navigation');
  readonly node = element('section','agent-inspection');
  readonly scroller = element('div','inspection-content');
  private readonly status = element('p','inspection-status inspection-read-status');
  private readonly liveStatus=element('p','inspection-status inspection-live-status');
  private readonly content = element('div');
  private readonly form = element('form','inspection-query');
  private readonly submission = element('input');
  private readonly requestId = element('input');
  private readonly operationId = element('input');
  private readonly activityButton: HTMLButtonElement;
  private readonly resultButton: HTMLButtonElement;
  private readonly conversationButton: HTMLButtonElement;
  private readonly refresh: HTMLButtonElement;
  private readonly hooks: InspectionHooks;
  private mode?: Mode;
  private selector: ResultSelector = {};
  private entryId?: number;
  private offset = 0;
  private scrollTop = 0;
  private visible = false;
  private controller?: AbortController;
  private serial = 0;
  private loaded?: AgentInspectionView;
  private pageOffsets: number[] = [];
  private activityCursor?:ActivityInspection['nextCursor'];
  private pending = false;
  private readonly identity: string;
  constructor(identity: string, hooks: InspectionHooks) {
    this.identity=identity;this.hooks=hooks;
    this.node.hidden=true;this.scroller.tabIndex=0;this.scroller.setAttribute('aria-label','Agent inspection');
    this.status.setAttribute('role','status');
    this.conversationButton=button('Conversation',()=>this.conversation());
    this.activityButton=button('Activity',()=>this.open('activity'));
    this.resultButton=button('Result',()=>this.open('result'));
    this.navigation.setAttribute('aria-label','Agent views');this.navigation.append(this.conversationButton,this.activityButton,this.resultButton);
    this.refresh=button('Refresh',()=>{void (this.mode==='result'?this.find():this.load());});
    const identityLine=element('div','inspection-identity');identityLine.append(element('span','identity',identity),button('Copy agent ID',()=>{void copy(identity,this.node);}));
    for(const [field,label] of [[this.submission,'Submission ID'],[this.requestId,'Native request ID'],[this.operationId,'Native operation ID']] as const) {
      const owner=element('label');owner.append(element('span',undefined,label),field);field.setAttribute('aria-label',label);field.maxLength=1024;this.form.append(owner);
      field.addEventListener('input',()=>{this.cancel();this.captureSelector();this.persist();});
    }
    this.submission.inputMode='numeric';const submit=element('button',undefined,'Find result');submit.type='submit';
    this.form.append(submit);this.form.addEventListener('submit',event=>{event.preventDefault();void this.find();});
    this.scroller.append(this.content);this.node.append(identityLine,this.form,this.liveStatus,this.status,this.refresh,this.scroller);
    this.scroller.addEventListener('scroll',()=>{this.scrollTop=this.scroller.scrollTop;});
    this.scroller.addEventListener('scrollend',()=>this.persist());
    try {const saved=hooks.restore();if(validInspectionCheckpoint(saved)&&saved.identity===identity)this.restore(saved);}catch { /* Unavailable storage does not alter this view. */ }
    this.paintMode();
  }
  observe(frame:ProjectedFrame|undefined,live:boolean):void {
    if(!frame){this.liveStatus.hidden=true;return;}
    const selection=document.getSelection();if(selection&&!selection.isCollapsed&&this.liveStatus.contains(selection.anchorNode))return;
    const label=live?'Live activity':'Last observed activity';
    const current=frame.live.slice(-4).flatMap(entry=>(entry.messages??[]).slice(-2)).flatMap(message=>message.parts.slice(-8)).flatMap(part=>part.type==='text'&&!part.redacted?[part.text.slice(-800)]:[]).join(' ').slice(-800);
    setText(this.liveStatus,`${label}: ${frame.status.busy?'Working':'Idle'}${current?` · ${current}`:''}`);this.liveStatus.title=frame.observedAt;this.liveStatus.hidden=false;
  }
  get active(): boolean {return this.mode !== undefined;}
  get busy(): boolean {return this.pending;}
  checkpoint(): InspectionCheckpoint | undefined {
    return this.mode ? {identity:this.identity,mode:this.mode,selector:{...this.selector},...(this.entryId ? {entryId:this.entryId} : {}),offset:this.offset,scrollTop:this.scrollTop,...(this.mode==='activity'&&this.activityCursor?{cursor:this.activityCursor}:{})} : undefined;
  }
  restore(value: InspectionCheckpoint): boolean {
    if(!validInspectionCheckpoint(value)||value.identity!==this.identity)return false;
    this.cancel();this.visible=false;this.mode=value.mode;this.selector={...value.selector};this.entryId=value.entryId;this.offset=value.offset;this.scrollTop=value.scrollTop;this.activityCursor=value.cursor;
    this.submission.value=value.selector.submissionId===undefined?'':String(value.selector.submissionId);this.requestId.value=value.selector.requestId??'';this.operationId.value=value.selector.operationId??'';
    this.loaded=undefined;this.paintMode();return true;
  }
  open(mode: 'activity'|'result', selector?: ResultSelector): void {
    if(selector&&!validResultSelector(selector))return;
    this.cancel();this.mode=mode;this.offset=0;this.entryId=undefined;this.scrollTop=0;this.loaded=undefined;this.activityCursor=undefined;
    if(selector){this.selector={...selector};this.submission.value=selector.submissionId===undefined?'':String(selector.submissionId);this.requestId.value=selector.requestId??'';this.operationId.value=selector.operationId??'';}
    this.content.replaceChildren();setText(this.status,mode==='result'&&!this.hasSelector()?'Enter a native result selector.':'');this.paintMode();this.persist();this.hooks.changed();
    if(this.visible&&!this.pending&&(mode==='activity'||selector))void this.load();
  }
  conversation(): void {this.cancel();this.mode=undefined;this.paintMode();this.persist();this.hooks.changed();}
  visibility(visible: boolean): void {
    if(this.visible===visible)return;this.visible=visible;
    if(!visible){this.cancel();return;}
    if(this.mode&&!this.loaded&&(this.mode!=='result'||this.hasSelector()))void this.load();
    this.scroller.scrollTop=this.scrollTop;
  }
  destroy(): void {this.cancel();this.navigation.remove();this.node.remove();}
  private hasSelector(): boolean {return Object.keys(this.selector).length>0;}
  private captureSelector(): boolean {
    const submission=this.submission.value;
    if(submission&&!/^[1-9]\d*$/.test(submission))return false;
    const value:ResultSelector={...(submission?{submissionId:Number(submission)}:{}),...(this.requestId.value?{requestId:this.requestId.value}:{}),...(this.operationId.value?{operationId:this.operationId.value}:{})};
    if(!validResultSelector(value))return false;this.selector=value;return true;
  }
  private async find(): Promise<void> {
    if(!this.captureSelector()||!this.hasSelector()){setText(this.status,'Enter a positive submission ID, an exact native request ID, or a native operation ID.');return;}
    this.mode='result';this.offset=0;this.scrollTop=0;this.paintMode();this.persist();await this.load();
  }
  private paintMode(): void {
    this.node.hidden=!this.mode;this.form.hidden=this.mode!=='result';
    for(const [node,active] of [[this.conversationButton,!this.mode],[this.activityButton,this.mode==='activity'],[this.resultButton,this.mode==='result'||this.mode==='exact']] as const)node.setAttribute('aria-pressed',String(active));
    this.node.dataset.view=this.mode??'conversation';
    if(!this.mode)this.status.textContent='';
  }
  private persist(): void {try{this.hooks.save(this.checkpoint()??null);}catch { /* Current-tab state remains authoritative. */ }}
  private cancel(): void {this.serial++;this.controller?.abort();this.controller=undefined;this.pending=false;this.refresh.disabled=false;}
  private readRequest(cursor?:ActivityInspection['nextCursor']):InspectRequest|undefined {
    if(!this.visible||!this.hooks.current())return;
    switch(this.mode){
      case 'activity':{const selected=cursor??this.activityCursor;return {view:'activity',limit:4,...(selected?{cursor:selected}:{})};}
      case 'exact':return {view:'exact',entryId:this.entryId as number,offset:this.offset};
      case 'result':return this.hasSelector()?{view:'result',...this.selector}:undefined;
    }
  }
  private currentRead(serial:number,signal:AbortSignal):boolean {return !signal.aborted&&serial===this.serial&&this.visible&&this.hooks.current();}
  private checkResult(value:AgentInspectionView,request:InspectRequest):void {
    if(value.identity!==this.identity||value.view!==request.view)throw Error('The inspection target changed.');
    if(value.view==='exact'&&request.view==='exact'&&(value.entryId!==request.entryId||value.offset!==request.offset))throw Error('The exact page changed.');
    if(value.view==='result'&&request.view==='result'&&!resultMatches(value,request))throw Error('The result selectors do not match.');
  }
  private async load(cursor?:ActivityInspection['nextCursor']):Promise<void> {
    const request=this.readRequest(cursor);if(!request)return;
    this.cancel();const controller=new AbortController(),serial=this.serial;this.controller=controller;this.pending=true;this.refresh.disabled=true;
    setText(this.status,this.loaded?'Updating the last inspection…':'Reading inspection…');
    try {
      const value=await this.hooks.read(request,controller.signal);
      if(!this.currentRead(serial,controller.signal))return;
      this.checkResult(value,request);if(request.view==='activity')this.activityCursor=request.cursor;this.loaded=value;this.render(value);setText(this.status,`Read at ${value.readAt}`);this.scroller.scrollTop=this.scrollTop;this.persist();
    }catch(error){if(this.currentRead(serial,controller.signal))this.readError(error);}
    finally{if(serial===this.serial){this.controller=undefined;this.pending=false;this.refresh.disabled=false;}}
  }
  private readError(error:unknown):void {const prefix=this.loaded?'Last inspection retained. ':'';setText(this.status,prefix+(error instanceof Error?error.message:'Inspection is unavailable.'));}
  private prose(value: InspectionText, title?: string): HTMLElement {
    const section=element('section','inspection-text');if(title)section.append(element('h3',undefined,title));section.append(markdownDom(value.text));
    if(value.shortened||value.protected)section.append(element('p','secondary',[value.shortened?'Display shortened':'',value.protected?'Some text withheld':''].filter(Boolean).join(' · ')));
    return section;
  }
  private exactEntry(id: number): void {this.mode='exact';this.entryId=id;this.offset=0;this.pageOffsets=[];this.scrollTop=0;this.loaded=undefined;this.paintMode();this.persist();this.hooks.changed();void this.load();}
  private render(value:AgentInspectionView):void {
    const nodes=value.view==='activity'?this.renderActivity(value):value.view==='result'?this.renderResult(value):this.renderExact(value);
    this.content.replaceChildren(...nodes);
  }
  private renderActivity(value:ActivityInspection):HTMLElement[] {
    const meta=value.metadata,nodes:HTMLElement[]=[element('p','inspection-facts',activityFacts(meta))];
    nodes.push(...this.renderRunningTools(meta));
    if(meta.lastError)nodes.push(this.prose(meta.lastError,'Reported error'));
    if(meta.streamedText)nodes.push(this.prose(meta.streamedText,'Current text'));
    if(meta.autoRetry)nodes.push(displayDetails('Retry',meta.autoRetry));
    if(meta.compactionFailure)nodes.push(displayDetails('Compaction failure',meta.compactionFailure));
    nodes.push(...value.entries.map(entry=>this.renderEntry(entry)));
    const note=activityCoverage(value);if(note)nodes.push(element('p','inspection-coverage',note));
    if(value.nextCursor)nodes.push(button('More activity',()=>{this.scrollTop=0;void this.load(value.nextCursor);}));
    if(!value.entries.length)nodes.push(element('p',undefined,value.coverage.complete?'No retained activity.':'No activity in this incomplete read.'));
    if(value.detail.text)nodes.push(details('Read details',value.detail.text));return nodes;
  }
  private renderRunningTools(meta:ActivityInspection['metadata']):HTMLElement[] {
    const nodes=meta.runningTools.map(tool=>element('p','inspection-tool',tool.name+(tool.elapsedMs===undefined?'':` · ${tool.elapsedMs} ms`)));
    if(meta.runningToolsOmitted)nodes.push(element('p','inspection-coverage',`${meta.runningToolsOmitted} running ${meta.runningToolsOmitted===1?'tool':'tools'} omitted from display.`));return nodes;
  }
  private renderEntry(entry:InspectionEntry):HTMLElement {
    const section=element('section','inspection-entry');section.append(element('h3',undefined,`${entry.source} · ${entry.kind}`),this.prose(entry.text),button(`Exact entry ${entry.id}`,()=>this.exactEntry(entry.id)));
    for(const call of entry.calls)section.append(this.renderCall(call));
    if(entry.callsOmitted)section.append(element('p','inspection-coverage',`${entry.callsOmitted} ${entry.callsOmitted===1?'tool call':'tool calls'} omitted from display.`));
    for(const tool of entry.tools)section.append(this.prose(tool.text,`${tool.name}${tool.isError?' · Error':''}${tool.truncated?' · Incomplete':''}`));
    if(entry.truncated)section.append(element('p','secondary','Native entry preview is incomplete.'));return section;
  }
  private renderCall(call:InspectionEntry['calls'][number]):HTMLElement {
    const section=element('section','inspection-call'),args=element('pre','raw');setText(args,call.arguments.text);
    section.append(element('h4',undefined,call.name.text||'Tool call'),args);
    const notes=[call.truncated?'Native tool-call summary is incomplete.':'',call.name.shortened||call.arguments.shortened?'Tool-call display shortened.':'',call.name.protected||call.arguments.protected?'Some tool-call text withheld.':''].filter(Boolean);
    if(notes.length)section.append(element('p','secondary',notes.join(' ')));
    if(call.callId)section.append(this.prose(call.callId,'Call identity'));return section;
  }
  private renderResult(value:ResultInspection):HTMLElement[] {
    const nodes=[element('h3',undefined,`Result: ${value.status}`),resultFacts(value)];
    if(value.reason)nodes.push(this.prose(value.reason,'Reason'));
    const answer=value.answer;if(answer)nodes.push(this.prose(answer,'Answer'),button('Copy displayed answer',()=>{void copy(answer.text,this.node);}));
    const answerEntry=value.answerEntryId;if(answerEntry)nodes.push(button('Exact answer entry',()=>this.exactEntry(answerEntry)));
    const inputEntry=value.entryId;if(inputEntry)nodes.push(button('Exact input entry',()=>this.exactEntry(inputEntry)));
    nodes.push(displayDetails('Usage',value.usage));if(value.providerBlock)nodes.push(displayDetails('Provider block',value.providerBlock));
    if(value.recoveryOf)nodes.push(this.prose(value.recoveryOf,'Recovery reference'));return nodes;
  }
  private renderExact(value:ExactInspection):HTMLElement[] {
    const raw=element('pre','raw');setText(raw,value.text.text);
    const nodes:HTMLElement[]=[element('h3',undefined,`Exact entry ${value.entryId}`),element('p','secondary','Protected raw entry serialization. This is not a complete answer export.'),raw];
    if(value.text.protected)nodes.push(element('p','secondary','Some text withheld.'));
    nodes.push(element('p','secondary',`Offset ${value.offset}${value.nextOffset===null?' · End of entry':` · Next offset ${value.nextOffset}`}`),button('Copy displayed entry page',()=>{void copy(value.text.text,this.node);}));
    if(value.offset>0)nodes.push(button('Start over',()=>{this.offset=0;this.pageOffsets=[];this.scrollTop=0;void this.load();}));
    if(this.pageOffsets.length)nodes.push(button('Previous page',()=>{this.offset=this.pageOffsets.pop()??0;this.scrollTop=0;void this.load();}));
    const next=value.nextOffset;if(next!==null)nodes.push(button('Next page',()=>{this.pageOffsets.push(value.offset);this.offset=next;this.scrollTop=0;void this.load();}));return nodes;
  }
}
function resultMatches(value:ResultInspection,request:ResultSelector):boolean {
  return !(['submissionId','requestId','operationId'] as const).some(key=>request[key]!==undefined&&(value[key]!==undefined||value.status!=='unavailable')&&value[key]!==request[key]);
}
function resultFacts(value:ResultInspection):HTMLElement {
  const ids=[['Submission',value.submissionId],['Native request',value.requestId],['Native operation',value.operationId],['Input entry',value.entryId],['Answer entry',value.answerEntryId]].filter(([,v])=>v!==undefined);
  const facts=element('dl','kv');for(const [name,id] of ids)facts.append(element('dt',undefined,String(name)),element('dd',undefined,String(id)));return facts;
}
function displayDetails(title:string,value:{value:unknown;truncated:boolean}):HTMLElement {return details(title+(value.truncated?' (display incomplete)':''),JSON.stringify(value.value,null,2));}
function activityFacts(meta:ActivityInspection['metadata']):string {
  return [meta.live?'Live observation':'Retained observation',meta.pending===null?'Pending unavailable':`${meta.pending} pending`,meta.operation===null?'':`Operation ${meta.operation}`].filter(Boolean).join(' · ');
}
function activityCoverage(value:ActivityInspection):string {
  const c=value.coverage;if(c.complete&&!c.omittedEntries&&!value.displayOmitted&&!c.metadataTruncated)return '';
  return ['Incomplete inspection',`${c.scannedEntries} entries scanned`,`${c.omittedEntries} native entries omitted`,value.displayOmitted?`${value.displayOmitted} display entries omitted`:'',
    c.byteLimitReached||c.scanByteLimitReached?'Byte limit reached':'',c.entryLimitReached?'Entry limit reached':'',c.metadataTruncated?'Metadata incomplete':'',value.nextCursor?'':'No continuation supplied'].filter(Boolean).join(' · ');
}
