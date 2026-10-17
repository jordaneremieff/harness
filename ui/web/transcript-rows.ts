import type {EntryView, MessageView, PartView} from '../shared/api.ts';
import {slot,routineSessionEntry,type JoinedTool,type SessionGroup} from './transcript-tools.ts';

export type StepRun = {key: string; tools: JoinedTool[];events:EntryView[]};
type RunPosition={id:string;at:number};
export type TranscriptRow = {view: EntryView; source: EntryView; parts?: Map<string, Set<number>>; steps?: StepRun; actionsOnly?: boolean};
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
  private routine=new Map<string,readonly EntryView[]>();
  private retained=new Set<string>();
  derive(entries:readonly EntryView[],joined:ReadonlyMap<string,JoinedTool>,sessionOwners:ReadonlyMap<string,string>,showThinking:boolean,sessions:ReadonlyMap<string,SessionGroup>=new Map(),retained:ReadonlySet<string>=new Set()):EntryView[]{
    if(this.reuse(entries,joined,showThinking)&&retained.size===this.retained.size&&[...retained].every(id=>this.retained.has(id)))return this.result;
    const previous=this.result,controls=[...retained].flatMap(id=>{const row=this.byId.get(id);return row?[row]:[];});
    const calls=new Map([...this.runs].flatMap(([id,run])=>run.tools[0]?[[id,run.tools[0].callId] as const]:[]));
    this.sources=[...entries];this.thinking=showThinking;this.retained=new Set(retained);
    this.byId.clear();this.owners.clear();this.calls.clear();this.runs.clear();this.nestedCounts.clear();
    this.result=[];this.used.clear();this.routine.clear();
    for(const entry of entries)this.entry(entry,joined,sessionOwners,sessions);
    this.foldRoutineEvents();
    // Result-only records point back to the exact call's derived row rather than acquiring a second row.
    for(const entry of entries)if(!this.owners.has(entry.id))this.linkResults(entry);
    this.retainControls(entries,previous,controls,calls);
    return this.result;
  }
  private retainControls(entries:readonly EntryView[],previous:readonly EntryView[],controls:readonly TranscriptRow[],previousCalls:ReadonlyMap<string,string>):void{
    if(!controls.length)return;
    const current=new Map(entries.map(entry=>[entry.id,entry]));
    for(const old of controls)this.retainControl(current.get(old.source.id),old,previous,previousCalls);
  }
  private retainControl(source:EntryView|undefined,old:TranscriptRow,previous:readonly EntryView[],previousCalls:ReadonlyMap<string,string>):void{
    if(!source)return;
    const parts=new Map((source.messages??[]).filter(message=>old.parts?.has(message.id)).map(message=>[message.id,new Set<number>()]));
    if(!parts.size)return;
    const row=this.byId.get(old.view.id);
    if(row){if(row.steps){row.parts=parts;row.actionsOnly=true;}return;}
    const view={...source,id:old.view.id};
    this.byId.set(view.id,{view,source,parts,actionsOnly:true});
    const next=previous.slice(previous.indexOf(old.view)+1).map(entry=>this.byId.has(entry.id)?entry.id:this.calls.get(previousCalls.get(entry.id)??'')).find(id=>id!==undefined);
    const at=next===undefined?-1:this.result.findIndex(entry=>entry.id===next);
    this.result.splice(at<0?this.result.length:at,0,view);
    if(!this.owners.has(source.id))this.owners.set(source.id,view.id);
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
    const row=this.add(entry,`steps:${tool.slot}`);row.steps={key:`tool:${tool.callId}`,tools:[tool],events:[]};this.runs.set(row.view.id,row.steps);
    this.calls.set(tool.callId,row.view.id);
    if(tool.parentCallId)this.nestedCounts.set(tool.parentCallId,(this.nestedCounts.get(tool.parentCallId)??0)+1);
    if(!this.owners.has(entry.id))this.owners.set(entry.id,row.view.id);
  }
  private entry(entry:EntryView,joined:ReadonlyMap<string,JoinedTool>,sessionOwners:ReadonlyMap<string,string>,sessions:ReadonlyMap<string,SessionGroup>):void{
    if(sessionOwners.has(entry.id)&&sessionOwners.get(entry.id)!==entry.id)return;
    if(entry.data||!entry.messages?.length&&!entry.tool){this.event(entry,sessions.get(entry.id));return;}
    if(entry.tool){const tool=joined.get(entry.tool.callId);if(tool?.owner===entry.id)this.step(entry,tool);return;}
    for(const message of entry.messages??[])this.message(entry,message,joined);
  }
  private event(entry:EntryView,group?:SessionGroup):void{
    const members=group?.entries??[entry],routine=members.every(routineSessionEntry);
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
  private message(entry:EntryView,message:MessageView,joined:ReadonlyMap<string,JoinedTool>):void{
    if(message.communication){this.add(entry,`message:${message.id}`,new Map([[message.id,new Set(message.parts.map((_,at)=>at))]]));return;}
    let prose:TranscriptRow|undefined;
    message.parts.forEach((part,at)=>{prose=this.part(entry,message,part,at,joined,prose);});
    if(messageNotice(message)&&!prose){this.add(entry,`notice:${message.id}`,new Map([[message.id,new Set()]]));}
  }
  private part(entry:EntryView,message:MessageView,part:PartView,at:number,joined:ReadonlyMap<string,JoinedTool>,prose?:TranscriptRow):TranscriptRow|undefined{
    if(part.type==='toolCall'||part.type==='toolResult'){
      const tool=joined.get(part.callId);if(tool?.slot===slot(entry.id,message.id,at))this.step(entry,tool);
      return;
    }
    if(hiddenPart(part))return prose;
    prose??=this.add(entry,`prose:${message.id}:${at}`,new Map([[message.id,new Set()]]));
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
function hiddenPart(part:PartView):boolean{
  return (part.type==='text'||part.type==='thinking')&&!part.text.trim()&&!part.redacted&&!part.more;
}
function messageNotice(message:MessageView):boolean{return !!message.error||message.stopReason==='error'||message.stopReason==='aborted'||message.coverage.truncated||message.coverage.omitted>0||!message.coverage.complete;}
