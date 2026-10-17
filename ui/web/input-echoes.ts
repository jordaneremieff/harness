import {LIMITS} from '../shared/api.ts';
import {targetIdentity} from './state.ts';
import type {EntryView,OperationView,Target} from '../shared/api.ts';
import type {Submission} from './draft-state.ts';

type Echo={workspace:string;submission:Submission;at:number;baseline:Set<string>;state:'sending'|'accepted'|'rejected'|'uncertain';requestId?:string};
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
/** Browser-owned input copies are not native history or proof of admission. */
export class InputEchoes {
  private pending=new Map<string,Echo>();
  capture(workspace:string,submission:Submission,entries:readonly EntryView[]):void {
    if(this.pending.size>=LIMITS.unconfirmed)this.pending.delete(this.pending.keys().next().value as string);
    this.pending.set(submission.operationId,{workspace,submission:{...submission,images:submission.images.map(image=>({...image}))},at:Date.now(),baseline:new Set(entries.map(entry=>entry.id)),state:'sending'});
  }
  settle(result:OperationView):void {
    const echo=this.pending.get(result.id);if(!echo)return;
    echo.state=result.state==='rejected'?'rejected':result.state==='uncertain'?'uncertain':'accepted';
    if(result.receipt?.kind==='durable')echo.requestId=result.receipt.requestId;
  }
  failed(id:string,uncertain:boolean):void {const echo=this.pending.get(id);if(echo)echo.state=uncertain?'uncertain':'rejected';}
  entries(workspace:string,target:Target,native:readonly EntryView[]):EntryView[] {
    const result=[...native],claimed=new Set<string>();
    for(const [id,echo]of this.pending) {
      if(echo.workspace!==workspace||targetIdentity(echo.submission.target)!==targetIdentity(target))continue;
      const match=native.find(entry=>!claimed.has(entry.id)&&!echo.baseline.has(entry.id)&&matchesInput(echo,entry));
      if(match){claimed.add(match.id);this.pending.delete(id);continue;}
      result.push(echoEntry(id,echo));
    }
    return result;
  }
}
