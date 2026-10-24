import type {EntryView, MessageView, PartView, TaskSender} from '../shared/api.ts';
import type {JoinedTool} from './transcript-tools.ts';
import type {ResultInspection} from '../shared/inspection.ts';
import {conversationIdentityText} from './tabs.ts';

export type TaskReference = {sessionId:string;submissionId:number;requestId?:string};
export type TaskAnswer = {text:string;complete:boolean;redacted:boolean};
export type ConversationTask = {key:string;entryId:string;tool?:JoinedTool;reference?:TaskReference;subject:string;answer?:TaskAnswer;answerEntryId?:string;answerReference?:{identity:string;entryId:number};state:'awaiting'|'answered'|'unanswered'|'queued'|'unavailable'|'recorded';reason?:string;asked?:true;fromUi?:true;sender?:TaskSender;input?:TaskAnswer;time?:number};
function own(value:unknown,key:string):unknown {
  return value&&typeof value==='object'&&!Array.isArray(value)?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
}
function canonical(value:unknown):value is string {return typeof value==='string'&&value===value.toLowerCase()&&conversationIdentityText(value);}
export function taskReference(value:unknown):TaskReference|undefined {
  const sessionId=own(value,'sessionId'),submissionId=own(value,'submissionId'),requestId=own(value,'requestId');
  if(!canonical(sessionId)||!Number.isSafeInteger(submissionId)||(submissionId as number)<1)return;
  if(requestId!==undefined&&(typeof requestId!=='string'||!requestId||requestId.length>1024||/[\u0000-\u001f\u007f]/.test(requestId)))return;
  return {sessionId,submissionId:submissionId as number,...(requestId===undefined?{}:{requestId:requestId as string})};
}
/** Only the documented structured reference is a link. Prose, script output and admission status are not task outcomes. */
export function toolTaskReference(tool:JoinedTool):TaskReference|undefined {
  if(!['agent_send','agent_steer','agent_spawn'].includes(tool.name))return;
  const parts=[...(tool.result??[])];let visits=0,selected:TaskReference|undefined;
  for(let at=0;at<parts.length&&visits++<128;at++){
    const part=parts[at];if(!part)continue;
    if(part.type==='toolResult'){appendResultParts(parts,part);continue;}
    const reference=partReference(part,own(tool.args?.value,'sessionId'));if(!reference)continue;
    if(selected&&!sameReference(selected,reference))return;
    selected=reference;
  }
  return selected;
}
function appendResultParts(parts:PartView[],part:Extract<PartView,{type:'toolResult'}>):void{
  if(parts.length+part.parts.length<=128)parts.push(...part.parts);
}
function partReference(part:PartView,target:unknown):TaskReference|undefined {
  if(part.type!=='text'||!part.structured||part.structured.truncated)return;
  const reference=taskReference(own(part.structured.value,'result'));if(!reference)return;
  if(canonical(target)&&target!==reference.sessionId)return;
  return reference;
}
function sameReference(a:TaskReference,b:TaskReference):boolean{return a.sessionId===b.sessionId&&a.submissionId===b.submissionId&&a.requestId===b.requestId;}
function nativeMatches(value:ResultInspection,reference:TaskReference):boolean{return value.identity===reference.sessionId&&value.submissionId===reference.submissionId&&!(value.requestId&&reference.requestId&&value.requestId!==reference.requestId);}
function messageText(message:MessageView):string{return message.parts.flatMap(part=>part.type==='text'&&!part.redacted?[part.text]:[]).join('\n');}
type ReadyCarrier=Extract<NonNullable<MessageView['communication']>,{state:'ready'}>;
function subject(tool:JoinedTool):string {
  const value=own(tool.args?.value,tool.name==='agent_spawn'?'prompt':'message');
  if(typeof value!=='string')return 'Task';
  const first=value.split(/\r?\n/,1)[0]??'';return first||'Task';
}
export class ConversationTasks {
  readonly sent:ConversationTask[]=[];
  readonly asked:ConversationTask[]=[];
  readonly byCall=new Map<string,ConversationTask>();
  readonly replies=new Map<MessageView,ConversationTask>();
  private sources:readonly EntryView[]=[];
  private toolSources=new Map<string,JoinedTool>();
  private nativeAnswers=new Map<string,ResultInspection>();
  private incomingIds=new Set<string>();
  incomingRevision=0;
  recordResult(callId:string,value:ResultInspection):boolean {
    const row=this.byCall.get(callId),reference=row?.reference;
    if(!row||!reference||value.identity!==reference.sessionId||value.submissionId!==reference.submissionId||reference.requestId&&value.requestId&&reference.requestId!==value.requestId)return false;
    this.nativeAnswers.set(callId,value);if(this.nativeAnswers.size>200){const first=this.nativeAnswers.keys().next().value;if(first)this.nativeAnswers.delete(first);}this.applyResult(row,value);return true;
  }
  /** A result read reported this request placed or queued: the recipient still works on it, or has yet to start. */
  outstandingCall(callId:string):boolean {
    const row=this.byCall.get(callId),native=this.nativeAnswers.get(callId);
    return !!row?.reference&&!!native&&nativeMatches(native,row.reference)&&(native.status==='placed'||native.status==='queued');
  }
  /** One reference per recipient that still works on a request this conversation sent. */
  outstanding():TaskReference[] {
    const recipients=new Set<string>(),references:TaskReference[]=[];
    for(const row of this.sent){
      if(!row.tool||!row.reference||recipients.has(row.reference.sessionId)||!this.outstandingCall(row.tool.callId))continue;
      recipients.add(row.reference.sessionId);references.push(row.reference);
    }
    return references;
  }
  private applyResult(row:ConversationTask,value:ResultInspection):void {
    row.state=value.status==='done'?(value.answer?'answered':'unavailable'):value.status==='unanswered'?'unanswered':value.status==='queued'?'queued':value.status==='placed'?'awaiting':'unavailable';
    if(value.answer)row.answer={text:value.answer.text,complete:!value.answer.shortened,redacted:value.answer.protected};row.reason=value.reason?.text;
    if(value.answerEntryId)row.answerReference={identity:value.identity,entryId:value.answerEntryId};
  }
  update(entries:readonly EntryView[],tools:ReadonlyMap<string,JoinedTool>):void {
    const selected=new Map([...tools].filter(([,tool])=>['agent_send','agent_steer','agent_spawn'].includes(tool.name)));
    if(this.unchanged(entries,selected))return;
    this.sources=[...entries];this.toolSources=selected;
    this.sent.length=0;this.asked.length=0;this.byCall.clear();this.replies.clear();
    const positions=new Map(entries.map((entry,at)=>[entry.id,at]));
    for(const tool of tools.values())this.addSent(tool);
    this.sent.sort((a,b)=>(positions.get(b.entryId)??0)-(positions.get(a.entryId)??0));
    const incoming=new Set<string>();
    let recorded:ConversationTask|undefined;
    for(const entry of entries)for(const message of entry.messages??[]){
      recorded=this.recordMessage(entry,message,recorded);this.communication(entry,message,incoming);
    }
    this.asked.reverse();this.incomingIds=incoming;
  }
  private unchanged(entries:readonly EntryView[],selected:ReadonlyMap<string,JoinedTool>):boolean{
    return entries.length===this.sources.length&&entries.every((entry,at)=>entry===this.sources[at])&&selected.size===this.toolSources.size&&[...selected].every(([id,tool])=>this.toolSources.get(id)===tool);
  }
  private addSent(tool:JoinedTool):void{
    const reference=toolTaskReference(tool);if(!reference)return;
    const row:ConversationTask={key:tool.callId,entryId:tool.owner,tool,reference,subject:subject(tool),state:'awaiting'};
    const input = own(tool.args?.value, tool.name === 'agent_spawn' ? 'prompt' : 'message');
    if (typeof input === 'string') row.input = {text:input,complete:!tool.args?.truncated,redacted:false};
    const native=this.nativeAnswers.get(tool.callId);if(native&&nativeMatches(native,reference))this.applyResult(row,native);
    this.sent.push(row);this.byCall.set(tool.callId,row);
  }
  private recordMessage(entry:EntryView,message:MessageView,recorded?:ConversationTask):ConversationTask|undefined{
    if(message.role==='user'&&message.communication?.state!=='ready'){
      const text=messageText(message);
      if(text.trim()){recorded={key:`recorded:${entry.id}:${message.id}`,entryId:entry.id,subject:text.split(/\r?\n/,1)[0]?.slice(0,80)||'Recorded input',state:'recorded',asked:true,sender:entry.sender,input:{text,complete:message.coverage.complete&&!message.coverage.truncated,redacted:false},time:message.timestamp};this.asked.push(recorded);}
    }else if(message.role==='assistant'&&recorded){
      const text=messageText(message);
      if(text.trim()){recorded.answer={text:[recorded.answer?.text,text].filter(Boolean).join('\n\n'),complete:message.state==='final'&&message.coverage.complete&&!message.coverage.truncated,redacted:false};recorded.answerEntryId=entry.id;}
    }
    return recorded;
  }
  private communication(entry:EntryView,message:MessageView,incoming:Set<string>):void{
    const carrier=message.communication;
    if(carrier){const key=JSON.stringify([entry.id,message.id]);incoming.add(key);if(!this.incomingIds.has(key))this.incomingRevision++;}
    if(carrier?.state!=='ready')return;
    this.addAsked(entry,message,carrier);this.matchReplies(entry,message,carrier);
  }
  private addAsked(entry:EntryView,message:MessageView,carrier:ReadyCarrier):void{
    if(carrier.origin.kind!=='native'||carrier.origin.target.mode!=='input')return;
    const target=carrier.origin.target,identity=target.conversationId===1?target.storageId:`${target.storageId}:${target.conversationId}`;
    const reference=taskReference({sessionId:identity,submissionId:target.submissionId,requestId:target.requestId});
    if(reference)this.asked.push({key:`asked:${entry.id}:${message.id}`,entryId:entry.id,reference,subject:carrier.value.body.text.split(/\r?\n/,1)[0]?.slice(0,80)||'Task',state:'awaiting',asked:true,sender:carrier.value.sender,input:carrier.value.body,time:carrier.value.recordedAt});
  }
  private matchReplies(entry:EntryView,message:MessageView,carrier:ReadyCarrier):void{
    const value=carrier.value;if(value.kind!=='result')return;
    for(const row of this.sent){
      const reference=row.reference;if(!reference||value.sender.identity!==reference.sessionId)continue;
      const match=value.metadata.references.find(item=>item.submissionId===reference.submissionId&&!(item.requestId&&reference.requestId&&item.requestId!==reference.requestId));
      if(!match)continue;
      row.state=value.metadata.status==='done'?'answered':'unanswered';row.answer={...value.body};row.answerEntryId=entry.id;row.reason=value.metadata.reason;this.replies.set(message,row);
    }
  }
}
