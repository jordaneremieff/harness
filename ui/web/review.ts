import type {CommunicationBody, EntryView} from '../shared/api.ts';
import {button, copy, element, setText} from './dom.ts';
import {TranscriptIndex, type JoinedTool} from './transcript-tools.ts';
import type {ThinkingTime, ToolState} from './state.ts';
import {Transcript, type ViewHooks} from './render.ts';
import {suppliedDifference, differenceNotice} from './supplied-difference.ts';

export type ReviewSince = {entries:EntryView[];tools:ReadonlyMap<string,ToolState>;thinking:ReadonlyMap<string,ThinkingTime>;yours:boolean;earlier:boolean;loading:boolean;error?:string};
export type ReviewData = {caption:string;outcome:string;ask?:CommunicationBody;answer?:CommunicationBody;changes:JoinedTool[];turnLoaded:boolean;loading:boolean;error?:string;since?:ReviewSince};
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
const text=(value:unknown):string|undefined=>typeof value==='string'?value:undefined;
function requestEntry(entry:EntryView):boolean {
  return !!entry.messages?.some(message=>{
    if(message.role!=='user')return false;
    const carrier=message.communication;
    return carrier?.state!=='ready'||carrier.origin.kind==='native'&&carrier.origin.target.mode==='input';
  });
}
/** An exact input and answer bound one uninterrupted loaded turn; no surrounding task is inferred. */
export function reviewChanges(entries:readonly EntryView[],tools:ReadonlyMap<string,ToolState>,input?:string,answer?:string):{changes:JoinedTool[];loaded:boolean}{
  const start=entries.findIndex(entry=>entry.id===input),end=entries.findIndex(entry=>entry.id===answer);
  if(start<0||end<start)return {changes:[],loaded:false};
  const turn=entries.slice(start,end+1);
  if(turn.slice(1).some(requestEntry))return {changes:[],loaded:false};
  const calls=new Set(turn.flatMap(entry=>[...(entry.tool?[entry.tool.callId]:[]),...(entry.messages??[]).flatMap(message=>message.parts.flatMap(part=>part.type==='toolCall'?[part.callId]:[]))]));
  const index=new TranscriptIndex();index.update(turn,tools);
  return {changes:[...index.joined.values()].filter(tool=>calls.has(tool.callId)&&(tool.name==='edit'||tool.name==='write')).reverse(),loaded:true};
}
function coverage(parent:HTMLElement,body:CommunicationBody):void {
  const labels=[!body.complete?'Partial text':'',body.redacted?'Redacted':''].filter(Boolean);
  if(labels.length)parent.append(element('p','secondary',labels.join(' · ')));
}
function lineCount(value:string):number{return value===''?0:value.replace(/\r\n|\r/g,'\n').replace(/\n$/,'').split('\n').length;}
function diffBlock(oldText:string,newText:string):HTMLElement {
  const comparison=suppliedDifference(oldText,newText),pre=element('pre','review-supplied');
  const append=(lines:string[],kind:string,mark:string)=>{for(const line of lines){const row=element('span',`diff-row ${kind}`),marker=element('span','diff-marker',mark);marker.setAttribute('aria-hidden','true');row.append(marker,element('span','diff-text',`${line}\n`));pre.append(row);}};
  if(comparison.contextBefore!==null)append([comparison.contextBefore],'','  ');
  append(comparison.removed,'diff-del','- ');append(comparison.added,'diff-add','+ ');
  if(comparison.contextAfter!==null)append([comparison.contextAfter],'','  ');
  const node=element('div','review-diff');node.append(pre);
  const notice=differenceNotice(comparison);if(notice)node.append(element('p','secondary',notice));
  if(comparison.omittedBefore||comparison.omittedAfter||comparison.scanLimited){
    for(const [label,value]of [['Supplied old text',oldText],['Supplied new text',newText]] as const){const disclosure=element('details');disclosure.append(element('summary',undefined,label),element('pre','review-supplied',value),button('Copy',()=>{void copy(value,disclosure);}));node.append(disclosure);}
  }
  return node;
}
function editPairs(args:Record<string,unknown>):{oldText:string;newText:string}[] {
  if(!Array.isArray(args.edits))return [];
  return args.edits.flatMap(value=>{const edit=record(value),oldText=text(edit.oldText),newText=text(edit.newText);return oldText!==undefined&&newText!==undefined?[{oldText,newText}]:[];});
}
function changeView(tool:JoinedTool):HTMLElement {
  const args=record(tool.args?.value),path=text(args.path),content=text(args.content),node=element('section','review-change');
  const name=path?.split('/').at(-1)??tool.name;
  const edits=tool.name==='edit'?editPairs(args):[];
  const write=tool.name==='write'&&content!==undefined;
  const verb=tool.status==='success'&&!tool.args?.truncated?'written':'supplied';
  const heading=write?`${name} · ${verb} · ${lineCount(content)} lines`:edits.length?name:[tool.name,path].filter(Boolean).join(' · ');
  node.append(element('h4',undefined,heading));
  if((write||edits.length)&&path)node.append(element('p','secondary',path));
  for(const edit of edits)node.append(diffBlock(edit.oldText,edit.newText));
  if(tool.args?.truncated)node.append(element('p','secondary','Partial supplied arguments. This is not a complete file change.'));
  return node;
}
/** A read-only page-local companion. No view state participates in reload capture. */
export class Review {
  readonly node=element('section','desk-review');
  private title=element('h2');
  private outcome=element('p','secondary');
  private changes=element('section','review-changes');
  private asked=element('section','review-asked');
  private answer=element('section','review-answer');
  private status=element('p','secondary');
  private content=element('div','review-content');
  private since=element('section','review-since');
  private sinceTitle=element('h3');
  private sinceEarlier=element('p','secondary');
  private sinceError=element('p','secondary');
  private sinceBody=element('div','review-since-body');
  private sinceLoad:HTMLButtonElement;
  private sinceView:Transcript;
  private sinceBoundary?:string;
  private step:HTMLButtonElement;
  private observed=new ResizeObserver(()=>this.measureAsk());
  private signature='';
  private askSignature='';
  private answerSignature='';
  private askWidth?:number;
  private askLines?:number;
  constructor(back:()=>void,step:()=>void,load:()=>void,hooks:Pick<ViewHooks,'subject'|'senderCaption'|'senderSummary'|'image'>){
    this.node.hidden=true;this.node.setAttribute('aria-label','Review');
    const header=element('div','review-header');header.append(this.title,button('Back to Desk',back));
    const transcript=element('div','transcript review-since-transcript'),latest=element('button','latest','Latest');
    transcript.tabIndex=0;transcript.setAttribute('aria-label','Since the last instruction');
    this.sinceView=new Transcript({transcript,latest},{...hooks,sourceOrder:true,operatorInput:true,presentation:()=>{},reading:()=>{}});
    this.sinceLoad=button('Load',load);this.sinceEarlier.append(document.createTextNode('Earlier entries not loaded · '),this.sinceLoad);
    this.sinceBody.append(transcript,latest);this.since.append(this.sinceTitle,this.sinceEarlier,this.sinceError,this.sinceBody);this.since.hidden=true;
    this.step=button('Open the step that sent it',step);this.content.append(this.changes,this.asked,this.answer,this.since);
    this.node.append(header,this.outcome,this.status,this.content,this.step);this.observed.observe(this.asked);
  }
  reset():void {this.signature='';this.askSignature='';this.answerSignature='';this.content.scrollTop=0;this.changes.replaceChildren();this.asked.replaceChildren();this.answer.replaceChildren();this.clearSince();}
  update(data:ReviewData):void {
    setText(this.title,`Review · ${data.caption}`);setText(this.outcome,data.outcome);setText(this.status,data.error??(data.loading?'Reading exact task result':''));this.status.hidden=!this.status.textContent;
    const signature=JSON.stringify([data.ask,data.answer,data.changes,data.turnLoaded]);
    const selection=document.getSelection();
    if(selection&&!selection.isCollapsed&&this.content.contains(selection.anchorNode))return;
    this.paintSince(data.since);
    if(signature===this.signature)return;
    this.signature=signature;this.changes.replaceChildren(element('h3',undefined,'Changes'));
    if(data.changes.length)this.changes.append(...data.changes.map(changeView));
    else this.changes.append(element('p','secondary',data.turnLoaded?'No supplied edit or write calls in this answer turn.':'Exact answer-turn changes are not in the loaded history.'));
    const askSignature=JSON.stringify(data.ask)??'';
    if(this.askSignature!==askSignature||!this.asked.children.length){
      this.askSignature=askSignature;this.asked.replaceChildren();
      if(data.ask)this.askBody(data.ask);else this.asked.append(element('h3',undefined,'Asked'),element('p','secondary','Ask text is not supplied.'));
    }
    this.paintAnswer(data.answer);this.measureAsk();
  }
  private paintAnswer(body:CommunicationBody|undefined):void {
    const signature=JSON.stringify(body)??'';if(this.answerSignature===signature&&this.answer.children.length)return;
    this.answerSignature=signature;this.answer.replaceChildren(element('h3',undefined,'Answer'));
    if(body){this.answer.append(element('pre','review-supplied',body.text),button('Copy answer',()=>{void copy(body.text,this.answer);}));coverage(this.answer,body);}
    else this.answer.append(element('p','secondary','Answer text is not supplied.'));
  }
  private clearSince():void {this.since.hidden=true;this.sinceBoundary=undefined;this.sinceView.reset();}
  private paintSince(data:ReviewSince|undefined):void {
    if(!data){if(!this.since.hidden)this.clearSince();return;}
    const boundary=data.entries[0]?.id;
    this.since.hidden=false;setText(this.sinceTitle,`Since the last instruction${data.yours?' · yours':''}`);
    this.sinceEarlier.hidden=!data.earlier;this.sinceLoad.disabled=data.loading;
    this.sinceLoad.setAttribute('aria-busy',String(data.loading));
    this.sinceError.hidden=!data.error;setText(this.sinceError,data.error??'');this.sinceBody.hidden=!boundary;
    if(!boundary){if(this.sinceBoundary){this.sinceView.reset();this.sinceBoundary=undefined;}this.sinceView.visibilityChanged();return;}
    const changed=boundary!==this.sinceBoundary;
    if(changed)this.sinceView.reset();
    this.sinceView.set(data.entries,data.tools,data.thinking,false);
    if(changed){this.sinceBoundary=boundary;this.sinceView.revealEntry(boundary,false);}
    this.sinceView.visibilityChanged();
  }
  refreshNames():void {this.sinceView.refreshSubjects();}
  visibility(visible:boolean):void {this.node.hidden=!visible;if(visible)this.measureAsk();this.sinceView.visibilityChanged();}
  destroy():void {this.observed.disconnect();this.sinceView.destroy();}
  private askBody(body:CommunicationBody):void {
    this.askWidth=undefined;this.askLines=undefined;
    const viewport=element('div','operator-message-viewport'),content=element('pre','review-ask-text',body.text);viewport.append(content);
    const toggle=button('',()=>{const expanded=viewport.dataset.folded==='true';toggle.dataset.chosen='true';viewport.dataset.folded=String(!expanded);toggle.setAttribute('aria-expanded',String(expanded));setText(toggle,expanded?'Show less':`Show ${Math.max(0,(this.askLines??0)-8)} more lines`);},'operator-message-toggle');toggle.hidden=true;
    this.asked.append(element('h3',undefined,'Asked'),viewport,toggle,button('Copy ask',()=>{void copy(body.text,this.asked);}));coverage(this.asked,body);
  }
  private measureAsk():void {
    const content=this.asked.querySelector<HTMLElement>('.review-ask-text'),viewport=content?.parentElement,toggle=this.asked.querySelector<HTMLButtonElement>('.operator-message-toggle');if(!content||!viewport||!toggle)return;
    const width=content.clientWidth;if(!width)return;
    if(this.askLines===undefined||this.askWidth!==width){const lineHeight=Number.parseFloat(getComputedStyle(content).lineHeight);if(!Number.isFinite(lineHeight)||lineHeight<=0)return;this.askLines=Math.ceil(content.getBoundingClientRect().height/lineHeight);this.askWidth=width;}
    const long=this.askLines>12;toggle.hidden=!long;
    if(!toggle.dataset.chosen){viewport.dataset.folded=String(long);toggle.setAttribute('aria-expanded','false');setText(toggle,`Show ${Math.max(0,this.askLines-8)} more lines`);}
  }
}
