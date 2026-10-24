import {LIMITS} from '../shared/api.ts';
import {targetIdentity} from './state.ts';
import {newerOperation} from './operation-state.ts';
import {inputOperation} from './operation-label.ts';
import type {EntryView,OperationView,Target} from '../shared/api.ts';
import type {Submission} from './draft-state.ts';

type Echo={workspace:string;submission:Submission;at:number;baseline:Set<string>;state:'sending'|'accepted'|'rejected'|'uncertain';requestId?:string;result?:OperationView};
function matchesInput(echo:Echo,entry:EntryView):boolean {
  return (entry.messages??[]).some(message=>{
    if(message.role!=='user'||message.timestamp!==undefined&&message.timestamp<echo.at-1000)return false;
    const communication=message.communication;
    if(echo.requestId&&communication?.state==='ready'&&communication.origin.kind==='native'&&communication.origin.target.requestId===echo.requestId)return true;
    const text=message.parts.filter(part=>part.type==='text').map(part=>part.text).join('');
    return echo.submission.text?text===echo.submission.text||text.startsWith(`${echo.submission.text}\n\nAttached image `):echo.submission.images.every(image=>text.includes(`Attached image ${JSON.stringify(image.name)}`));
  });
}
function echoEntry(id:string,echo:Echo):EntryView {
  const text=echo.submission.text||echo.submission.images.map(image=>`Attached image: ${image.name}`).join('\n');
  const label=echo.state==='sending'?'Sending…':echo.state==='accepted'?'Sent':echo.state==='uncertain'?'Delivery not confirmed':'Message not sent';
  return {id:`ui-input:${id}`,kind:'ui.input',data:{value:{delivery:label},truncated:false},messages:[{id:`ui-input:${id}:message`,role:'user',timestamp:echo.at,parts:[{type:'text',text}],state:echo.state==='sending'?'partial':'final',...(echo.state==='rejected'||echo.state==='uncertain'?{error:label}:{}),coverage:{complete:true,truncated:false,omitted:0}}]};
}
function entryTime(entry:EntryView):number|undefined {return (entry.messages??[]).find(message=>typeof message.timestamp==='number'&&Number.isFinite(message.timestamp))?.timestamp;}
/** Browser-owned input copies are not native history or proof of admission. */
export class InputEchoes {
  private pending=new Map<string,Echo>();
  capture(workspace:string,submission:Submission,entries:readonly EntryView[]):void {
    if(this.pending.size>=LIMITS.unconfirmed)this.pending.delete(this.pending.keys().next().value as string);
    this.pending.set(submission.operationId,{workspace,submission:{...submission,images:submission.images.map(image=>({...image}))},at:Date.now(),baseline:new Set(entries.map(entry=>entry.id)),state:'sending'});
  }
  settle(result:OperationView):void {
    const echo=this.pending.get(result.id);
    if(!echo||!result.target||!inputOperation(result)||targetIdentity(echo.submission.target)!==targetIdentity(result.target))return;
    if(!['accepted','rejected','uncertain'].includes(result.state))return;
    const current=newerOperation(echo.result,result);if(current===echo.result)return;
    echo.result=current;echo.state=current.state==='rejected'?'rejected':current.state==='uncertain'?'uncertain':'accepted';
    if(current.receipt?.kind==='durable')echo.requestId=current.receipt.requestId;
  }
  failed(id:string,uncertain:boolean):void {
    const echo=this.pending.get(id);if(!echo||echo.result?.state==='accepted'||echo.result?.state==='rejected')return;
    echo.state=uncertain?'uncertain':'rejected';
  }
  entries(workspace:string,target:Target,native:readonly EntryView[]):EntryView[] {
    const result=[...native],claimed=new Set<string>();
    for(const [id,echo]of this.pending) {
      if(echo.workspace!==workspace||targetIdentity(echo.submission.target)!==targetIdentity(target))continue;
      const match=native.find(entry=>!claimed.has(entry.id)&&!echo.baseline.has(entry.id)&&matchesInput(echo,entry));
      if(match){claimed.add(match.id);this.pending.delete(id);continue;}
      const row=echoEntry(id,echo);
      // A settled input that no native message claims (an extension command) keeps its time order; unsettled input stays last.
      const later=echo.state==='accepted'?result.findIndex(entry=>{const time=entryTime(entry);return time!==undefined&&time>echo.at;}):-1;
      if(later<0)result.push(row);else result.splice(later,0,row);
    }
    return result;
  }
}
