import type {EntryView, MessageView, PartView} from '../shared/api.ts';
import {slot,routineSessionEntry,type JoinedTool,type SessionGroup} from './transcript-tools.ts';

export type StepRun = {key: string; tools: JoinedTool[];events:EntryView[]};
type RunPosition={id:string;at:number};
export type TranscriptRow = {view: EntryView; source: EntryView; parts?: Map<string, Set<number>>; steps?: StepRun};
/** View rows retain original source objects and original part offsets for copy, menus and tool joins. */
export class TranscriptRows {
  readonly byId = new Map<string, TranscriptRow>();
  readonly owners = new Map<string, string>();
  readonly calls = new Map<string, string>();
  readonly runs = new Map<string, StepRun>();
  readonly nestedCounts=new Map<string,number>();
  private sources:readonly EntryView[]=[];
  private thinking?:boolean;
  private result:EntryView[]=[];
  private used=new Set<string>();
  private run?:TranscriptRow;
  private routine=new Map<string,readonly EntryView[]>();
  derive(entries:readonly EntryView[],joined:ReadonlyMap<string,JoinedTool>,sessionOwners:ReadonlyMap<string,string>,showThinking:boolean,sessions:ReadonlyMap<string,SessionGroup>=new Map()):EntryView[]{
    if(this.reuse(entries,joined,showThinking))return this.result;
    this.sources=[...entries];this.thinking=showThinking;
    this.byId.clear();this.owners.clear();this.calls.clear();this.runs.clear();this.nestedCounts.clear();
    this.result=[];this.used.clear();this.run=undefined;this.routine.clear();
    for(const entry of entries)this.entry(entry,joined,sessionOwners,showThinking,sessions);
    this.foldRoutineEvents();
    // Result-only records point back to the exact call's derived row rather than acquiring a second row.
    for(const entry of entries)if(!this.owners.has(entry.id))this.linkResults(entry);
    return this.result;
  }
  private reuse(entries:readonly EntryView[],joined:ReadonlyMap<string,JoinedTool>,showThinking:boolean):boolean{
    if(this.thinking!==showThinking||entries.length!==this.sources.length||!entries.every((entry,at)=>entry===this.sources[at]))return false;
    let missing=false;
    for(const run of this.runs.values())run.tools.forEach((tool,at)=>{
      const current=joined.get(tool.callId);
      if(current&&current.owner===tool.owner&&current.slot===tool.slot)run.tools[at]=current;else missing=true;
    });
    return !missing;
  }
  private add(entry:EntryView,suffix:string,parts?:Map<string,Set<number>>):TranscriptRow{
    const id=this.used.has(entry.id)?`${suffix}:${entry.id}`:entry.id;this.used.add(entry.id);
    const view=id===entry.id?entry:{...entry,id},row:TranscriptRow={view,source:entry,parts};
    this.result.push(view);this.byId.set(id,row);
    if(!this.owners.has(entry.id))this.owners.set(entry.id,id);
    return row;
  }
  private step(entry:EntryView,tool:JoinedTool):void{
    if(!this.run){this.run=this.add(entry,`steps:${tool.slot}`);this.run.steps={key:`steps:${tool.slot}`,tools:[],events:[]};this.runs.set(this.run.view.id,this.run.steps);}
    this.run.steps?.tools.push(tool);this.calls.set(tool.callId,this.run.view.id);
    if(tool.parentCallId)this.nestedCounts.set(tool.parentCallId,(this.nestedCounts.get(tool.parentCallId)??0)+1);
    if(!this.owners.has(entry.id))this.owners.set(entry.id,this.run.view.id);
  }
  private entry(entry:EntryView,joined:ReadonlyMap<string,JoinedTool>,sessionOwners:ReadonlyMap<string,string>,showThinking:boolean,sessions:ReadonlyMap<string,SessionGroup>):void{
    if(sessionOwners.has(entry.id)&&sessionOwners.get(entry.id)!==entry.id)return;
    if(entry.data||!entry.messages?.length&&!entry.tool){this.event(entry,sessions.get(entry.id));return;}
    if(entry.tool){const tool=joined.get(entry.tool.callId);if(tool?.owner===entry.id)this.step(entry,tool);return;}
    for(const message of entry.messages??[])this.message(entry,message,joined,showThinking);
  }
  private event(entry:EntryView,group?:SessionGroup):void{
    const members=group?.entries??[entry],routine=members.every(routineSessionEntry);
    if(!routine)this.run=undefined;
    const row=this.add(entry,'event');if(routine)this.routine.set(row.view.id,members);
  }
  private foldRoutineEvents():void{
    if(!this.runs.size||!this.routine.size)return;
    const next=new Map<string,RunPosition>();let after:RunPosition|undefined;
    for(let at=this.result.length-1;at>=0;at--){const row=this.result[at];if(!row)continue;if(this.runs.has(row.id))after={id:row.id,at};if(after&&this.routine.has(row.id))next.set(row.id,after);}
    const kept:EntryView[]=[];let before:RunPosition|undefined;
    this.result.forEach((row,at)=>{
      if(this.runs.has(row.id))before={id:row.id,at};
      const events=this.routine.get(row.id),owner=nearestRun(at,before,next.get(row.id));
      if(events&&owner)this.attachEvents(row,events,owner);else kept.push(row);
    });
    this.result=kept;
  }
  private attachEvents(row:EntryView,events:readonly EntryView[],owner:RunPosition):void{
    this.runs.get(owner.id)?.events.push(...events);this.byId.delete(row.id);
    for(const entry of events)this.owners.set(entry.id,owner.id);
  }
  private message(entry:EntryView,message:MessageView,joined:ReadonlyMap<string,JoinedTool>,showThinking:boolean):void{
    if(message.communication){this.run=undefined;this.add(entry,`message:${message.id}`,new Map([[message.id,new Set(message.parts.map((_,at)=>at))]]));return;}
    let prose:TranscriptRow|undefined;
    message.parts.forEach((part,at)=>{prose=this.part(entry,message,part,at,joined,showThinking,prose);});
    if(messageNotice(message)&&!prose){this.run=undefined;this.add(entry,`notice:${message.id}`,new Map([[message.id,new Set()]]));}
  }
  private part(entry:EntryView,message:MessageView,part:PartView,at:number,joined:ReadonlyMap<string,JoinedTool>,showThinking:boolean,prose?:TranscriptRow):TranscriptRow|undefined{
    if(part.type==='toolCall'||part.type==='toolResult'){
      const tool=joined.get(part.callId);if(tool?.slot===slot(entry.id,message.id,at))this.step(entry,tool);
      return;
    }
    if(hiddenPart(part,showThinking))return prose;
    this.run=undefined;prose??=this.add(entry,`prose:${message.id}:${at}`,new Map([[message.id,new Set()]]));
    prose.parts?.get(message.id)?.add(at);return prose;
  }
  private linkResults(entry:EntryView):void{
    for(const message of entry.messages??[])for(const part of message.parts)if(part.type==='toolResult'){
      const owner=this.calls.get(part.callId);if(owner)this.owners.set(entry.id,owner);
    }
  }
}
function nearestRun(at:number,before?:RunPosition,after?:RunPosition):RunPosition|undefined{
  if(!before)return after;if(!after)return before;return at-before.at<=after.at-at?before:after;
}
function hiddenPart(part:PartView,showThinking:boolean):boolean{
  if(part.type==='thinking'&&!showThinking)return true;
  return (part.type==='text'||part.type==='thinking')&&!part.text.trim()&&!part.redacted&&!part.more;
}
function messageNotice(message:MessageView):boolean{return !!message.error||message.stopReason==='error'||message.stopReason==='aborted'||message.coverage.truncated||message.coverage.omitted>0||!message.coverage.complete;}
