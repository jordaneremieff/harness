import type {EntryView, MessageView} from '../shared/api.ts';
import {slot, type JoinedTool} from './transcript-tools.ts';

export type StepRun = {key: string; tools: JoinedTool[]};
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
  derive(entries: readonly EntryView[], joined: ReadonlyMap<string, JoinedTool>, sessionOwners: ReadonlyMap<string, string>, showThinking: boolean): EntryView[] {
    if(this.thinking===showThinking&&entries.length===this.sources.length&&entries.every((entry,at)=>entry===this.sources[at])){
      let missing=false;
      for(const run of this.runs.values())run.tools.forEach((tool,at)=>{const current=joined.get(tool.callId);if(current&&current.owner===tool.owner&&current.slot===tool.slot)run.tools[at]=current;else missing=true;});
      if(!missing)return this.result;
    }
    this.sources=[...entries];this.thinking=showThinking;
    this.byId.clear();this.owners.clear();this.calls.clear();this.runs.clear();this.nestedCounts.clear();
    const rows: EntryView[] = [], used = new Set<string>();let run: TranscriptRow | undefined;
    const rowId = (entry: EntryView, suffix: string): string => {
      if (!used.has(entry.id)) {used.add(entry.id);return entry.id;}
      return `${suffix}:${entry.id}`;
    };
    const add = (entry: EntryView, suffix: string, parts?: Map<string, Set<number>>): TranscriptRow => {
      const id = rowId(entry,suffix), view = id === entry.id ? entry : {...entry,id};
      const row: TranscriptRow = {view,source:entry,parts};rows.push(view);this.byId.set(id,row);
      if (!this.owners.has(entry.id)) this.owners.set(entry.id,id);return row;
    };
    const step = (entry: EntryView, tool: JoinedTool): void => {
      if (!run) {run=add(entry,`steps:${tool.slot}`);run.steps={key:`steps:${tool.slot}`,tools:[]};this.runs.set(run.view.id,run.steps);}
      run.steps?.tools.push(tool);this.calls.set(tool.callId,run.view.id);
      if(tool.parentCallId)this.nestedCounts.set(tool.parentCallId,(this.nestedCounts.get(tool.parentCallId)??0)+1);
      if (!this.owners.has(entry.id)) this.owners.set(entry.id,run.view.id);
    };
    for (const entry of entries) {
      if (sessionOwners.has(entry.id) && sessionOwners.get(entry.id)!==entry.id) continue;
      if (entry.data || !entry.messages?.length && !entry.tool) {run=undefined;add(entry,'event');continue;}
      if (entry.tool) {const tool=joined.get(entry.tool.callId);if(tool?.owner===entry.id)step(entry,tool);continue;}
      for (const message of entry.messages??[]) {
        if (message.communication) {run=undefined;add(entry,`message:${message.id}`,new Map([[message.id,new Set(message.parts.map((_,at)=>at))]]));continue;}
        let prose: TranscriptRow | undefined;
        message.parts.forEach((part,at)=>{
          if (part.type==='toolCall'||part.type==='toolResult') {
            prose=undefined;const tool=joined.get(part.callId);
            if(tool?.slot===slot(entry.id,message.id,at))step(entry,tool);
            return;
          }
          if (part.type==='thinking'&&!showThinking) return;
          if ((part.type==='text'||part.type==='thinking')&&!part.text.trim()&&!part.redacted&&!part.more) return;
          run=undefined;
          prose??=add(entry,`prose:${message.id}:${at}`,new Map([[message.id,new Set()]]));
          prose.parts?.get(message.id)?.add(at);
        });
        if (message.error||message.stopReason==='error'||message.stopReason==='aborted'||incomplete(message)) {
          if (!prose) {run=undefined;add(entry,`notice:${message.id}`,new Map([[message.id,new Set()]]));}
        }
      }
    }
    // Result-only records point back to the exact call's derived row rather than acquiring a second row.
    for (const entry of entries) if (!this.owners.has(entry.id)) {
      for (const message of entry.messages??[]) for (const part of message.parts) if(part.type==='toolResult') {
        const owner=this.calls.get(part.callId);if(owner)this.owners.set(entry.id,owner);
      }
    }
    this.result=rows;return rows;
  }
}
function incomplete(message: MessageView): boolean {return message.coverage.truncated||message.coverage.omitted>0||!message.coverage.complete;}
