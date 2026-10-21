import type {EntryView, MessageView, ProjectedFrame} from '../shared/api.ts';

export type AgentRequest = {entry:EntryView;message:MessageView;label:'Current task'|'Latest request'|'Started with';answerId?:string};
function realUser(message:MessageView):boolean {return message.role==='user'&&message.communication===undefined;}
function receivedRequest(entries:readonly EntryView[]):AgentRequest|undefined {
  for(let index=entries.length-1;index>=0;index--){const entry=entries[index];if(!entry?.sender)continue;const message=entry.messages?.findLast(realUser);if(message)return {entry,message,label:'Latest request'};}
  return;
}
function firstRequest(entries:readonly EntryView[]):AgentRequest|undefined {
  for(const entry of entries){const message=entry.messages?.find(realUser);if(message)return {entry,message,label:'Started with'};}
  return;
}
function positiveId(value:unknown):value is number {return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;}
function inputLink(value:unknown,id:string):value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const row=value as Record<string,unknown>;
  return row.type==='input'&&positiveId(row.entryId)&&String(row.entryId)===id;
}
/** Only a supplied input link names an open request; catalog activity is not a task association. */
export function agentRequest(entries:readonly EntryView[],frame:ProjectedFrame|undefined,beginning:boolean):AgentRequest|undefined {
  const selected=receivedRequest(entries)??(beginning?firstRequest(entries):undefined);
  if(!selected||selected.label==='Started with')return selected;
  const supplied=frame?.status.submissions;
  if(!supplied||supplied.truncated||!Array.isArray(supplied.value))return selected;
  const matches=supplied.value.filter(value=>inputLink(value,selected.entry.id));
  const link=matches.length===1?matches[0]:undefined;if(!link)return selected;
  const coverage=selected.message.coverage;
  if(link.status==='placed'&&coverage.complete&&!coverage.truncated&&!coverage.omitted)selected.label='Current task';
  if(link.status==='done'&&positiveId(link.answerEntryId))selected.answerId=String(link.answerEntryId);
  return selected;
}
export function requestKey(request:Pick<AgentRequest,'entry'|'message'>):string {return `agent-request:${JSON.stringify([request.entry.id,request.message.id])}`;}
