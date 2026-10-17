import type {EntryView, MessageView} from '../shared/api.ts';
import type {JoinedTool} from './transcript-tools.ts';
import type {ResultInspection} from '../shared/inspection.ts';
import {conversationIdentityText} from './tabs.ts';

export type TaskReference = {sessionId:string;submissionId:number;requestId?:string};
export type TaskAnswer = {text:string;complete:boolean;redacted:boolean};
export type ConversationTask = {key:string;entryId:string;tool?:JoinedTool;reference?:TaskReference;subject:string;answer?:TaskAnswer;answerEntryId?:string;answerReference?:{identity:string;entryId:number};state:'awaiting'|'answered'|'unanswered'|'queued'|'unavailable'|'recorded';reason?:string;asked?:true;asker?:string;time?:number};
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
    if(part.type==='toolResult'){if(parts.length+part.parts.length<=128)parts.push(...part.parts);continue;}
    if(part.type!=='text'||!part.structured||part.structured.truncated)continue;
    const reference=taskReference(own(part.structured.value,'result'));if(!reference)continue;
    const target=own(tool.args?.value,'sessionId');
    if(canonical(target)&&target!==reference.sessionId)continue;
    if(selected&&(selected.sessionId!==reference.sessionId||selected.submissionId!==reference.submissionId||selected.requestId!==reference.requestId))return;
    selected=reference;
  }
  return selected;
}
function subject(tool:JoinedTool):string {
  const value=own(tool.args?.value,tool.name==='agent_spawn'?'prompt':'message');
  if(typeof value!=='string')return 'Task';
  const first=value.split(/\r?\n/,1)[0]??'';return first.slice(0,80)+(first.length>80?'…':'')||'Task';
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
  private applyResult(row:ConversationTask,value:ResultInspection):void {
    row.state=value.status==='done'?(value.answer?'answered':'unavailable'):value.status==='unanswered'?'unanswered':value.status==='queued'?'queued':value.status==='placed'?'awaiting':'unavailable';
    if(value.answer)row.answer={text:value.answer.text,complete:!value.answer.shortened,redacted:value.answer.protected};row.reason=value.reason?.text;
    if(value.answerEntryId)row.answerReference={identity:value.identity,entryId:value.answerEntryId};
  }
  update(entries:readonly EntryView[],tools:ReadonlyMap<string,JoinedTool>):void {
    const selected=new Map([...tools].filter(([,tool])=>['agent_send','agent_steer','agent_spawn'].includes(tool.name)));
    if(entries.length===this.sources.length&&entries.every((entry,at)=>entry===this.sources[at])&&selected.size===this.toolSources.size&&[...selected].every(([id,tool])=>this.toolSources.get(id)===tool))return;
    this.sources=[...entries];this.toolSources=selected;
    this.sent.length=0;this.asked.length=0;this.byCall.clear();this.replies.clear();
    const positions=new Map(entries.map((entry,at)=>[entry.id,at]));
    for(const tool of tools.values()){
      const reference=toolTaskReference(tool);if(!reference)continue;
      const row:ConversationTask={key:tool.callId,entryId:tool.owner,tool,reference,subject:subject(tool),state:'awaiting'};
      const native=this.nativeAnswers.get(tool.callId);if(native&&native.identity===reference.sessionId&&native.submissionId===reference.submissionId&&!(native.requestId&&reference.requestId&&native.requestId!==reference.requestId))this.applyResult(row,native);
      this.sent.push(row);this.byCall.set(tool.callId,row);
    }
    this.sent.sort((a,b)=>(positions.get(b.entryId)??0)-(positions.get(a.entryId)??0));
    const incoming=new Set<string>();
    let recorded:ConversationTask|undefined;
    for(const entry of entries)for(const message of entry.messages??[]){
      if(message.role==='user'&&!message.communication){
        const text=message.parts.flatMap(part=>part.type==='text'&&!part.redacted?[part.text]:[]).join('\n');
        if(text.trim()){recorded={key:`recorded:${entry.id}:${message.id}`,entryId:entry.id,subject:text.split(/\r?\n/,1)[0]?.slice(0,80)||'Recorded input',state:'recorded',asked:true,time:message.timestamp};this.asked.push(recorded);}
      }else if(message.role==='assistant'&&recorded){
        const text=message.parts.flatMap(part=>part.type==='text'&&!part.redacted?[part.text]:[]).join('\n');
        if(text.trim()){recorded.answer={text:[recorded.answer?.text,text].filter(Boolean).join('\n\n'),complete:message.state==='final'&&message.coverage.complete&&!message.coverage.truncated,redacted:false};recorded.answerEntryId=entry.id;}
      }

      const carrier=message.communication;if(carrier){const key=JSON.stringify([entry.id,message.id]);incoming.add(key);if(!this.incomingIds.has(key))this.incomingRevision++;}if(carrier?.state!=='ready')continue;
      const value=carrier.value;
      if(carrier.origin.kind==='native'&&carrier.origin.target.mode==='input'){
        const target=carrier.origin.target,identity=target.conversationId===1?target.storageId:`${target.storageId}:${target.conversationId}`;
        const reference=taskReference({sessionId:identity,submissionId:target.submissionId,requestId:target.requestId});
        if(reference)this.asked.push({key:`asked:${entry.id}:${message.id}`,entryId:entry.id,reference,subject:value.body.text.split(/\r?\n/,1)[0]?.slice(0,80)||'Task',state:'awaiting',asked:true,asker:value.sender.name,time:value.recordedAt});
      }
      if(value.kind!=='result')continue;
      for(const row of this.sent){
        const reference=row.reference;if(!reference||value.sender.identity!==reference.sessionId)continue;
        const match=value.metadata.references.find(item=>item.submissionId===reference.submissionId&&!(item.requestId&&reference.requestId&&item.requestId!==reference.requestId));
        if(!match)continue;
        row.state=value.metadata.status==='done'?'answered':'unanswered';row.answer={...value.body};row.answerEntryId=entry.id;row.reason=value.metadata.reason;this.replies.set(message,row);
      }
    }
    this.asked.reverse();this.incomingIds=incoming;
  }
}
