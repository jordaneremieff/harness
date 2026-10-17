import type {ActivityCoverage, ActivityInspection, AgentInspectionView, ExactInspection, HistoryInspection, InspectCursor, InspectionEntry, InspectionText, ResultInspection} from '../shared/inspection.ts';
import {ApiError} from './errors.mts';
import {projectJson, safeText} from './projection.mts';
import {projectCommunication} from './communication.mts';
import {retainedTarget} from '../agents/contract.mts';

function invalid(): never {throw new ApiError('invalid_inspection', 'The inspection source is incomplete or invalid.', 502, 'read');}
function record(value: unknown): Record<string, unknown> {if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value as Record<string, unknown>;}
function integer(value: unknown, minimum = 0): number {if (!Number.isSafeInteger(value) || (value as number) < minimum) return invalid();return value as number;}
function flag(value: unknown): boolean {if (typeof value !== 'boolean') return invalid();return value;}
function string(value: unknown, max = 1024): string {if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid();return value;}
function array(value: unknown, max = Number.MAX_SAFE_INTEGER): unknown[] {if (!Array.isArray(value) || value.length > max) return invalid();return value;}
const DISPLAY_RUNNING_TOOLS=16;
const DISPLAY_ENTRY_CALLS=8;
/** Cursors are opaque native values, never protected-text previews. Oversize refuses instead of clipping. */
export function inspectCursor(value: unknown): InspectCursor | null {
  if (value === null) return null;
  const cursor = record(value);let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 128 || depth > 8) invalid();
    for(const child of cursorChildren(item))visit(child,depth+1);
  }
  visit(cursor,0);if (Buffer.byteLength(JSON.stringify(cursor)) > 4096) invalid();
  return JSON.parse(JSON.stringify(cursor)) as InspectCursor;
}
function cursorChildren(item:unknown):unknown[] {
  switch(typeof item){
    case 'boolean':return [];
    case 'number':if(!Number.isFinite(item))invalid();return [];
    case 'string':if(item.length>4096||/[\u0000-\u001f\u007f]/.test(item))invalid();return [];
    case 'object':{
      if(item===null)return [];if(Array.isArray(item))return item;
      return Object.entries(record(item)).map(([key,child])=>{string(key,256);return child;});
    }
    default:return invalid();
  }
}
function coverage(value: unknown): ActivityCoverage {
  const row = record(value);
  return {complete:flag(row.complete),scannedEntries:integer(row.scannedEntries),scannedBytes:integer(row.scannedBytes),omittedEntries:integer(row.omittedEntries),
    ...(row.bytes===undefined?{}:{bytes:integer(row.bytes)}),entryLimitReached:flag(row.entryLimitReached),scanByteLimitReached:flag(row.scanByteLimitReached),byteLimitReached:flag(row.byteLimitReached),metadataTruncated:flag(row.metadataTruncated)};
}
class InspectionProjection {
  private remaining=40*1024;
  text(raw:unknown,limit=8192):InspectionText {
    if(typeof raw!=='string')return invalid();
    const clean=safeText(raw,Number.MAX_SAFE_INTEGER),shown=safeText(clean,Math.min(limit,this.remaining));this.remaining-=Buffer.byteLength(shown);
    return {text:shown,shortened:shown!==clean,protected:clean!==raw};
  }
  private tool(raw:unknown):InspectionEntry['tools'][number] {
    const row=record(raw);return {name:string(row.name,512),text:this.text(row.text),isError:flag(row.isError),truncated:flag(row.truncated)};
  }
  private call(raw:unknown):InspectionEntry['calls'][number] {
    const row=record(raw);return {name:this.text(row.name,512),arguments:this.text(row.arguments),truncated:flag(row.truncated),...(row.callId===undefined?{}:{callId:this.text(row.callId,512)})};
  }
  private entry(raw:unknown,identity?:string):InspectionEntry {
    const row=record(raw),calls=row.toolCalls===undefined?[]:array(row.toolCalls);
    const binding=identity?retainedTarget(identity):undefined;
    const native=row.communication&&typeof row.communication==='object'&&!Object.hasOwn(row.communication,'origin')?row.communication:undefined;
    let communication=identity?projectCommunication(row,String(row.id),{...binding,singleMessage:true,nativeEntryId:String(row.id),...(native===undefined?{}:{native})},{safeText,jsonDisplay:projectJson}):undefined;
    if(communication?.state==='ready'){const body=communication.value.body,shown=this.text(body.text,16384);communication={...communication,value:{...communication.value,body:{text:shown.text,complete:body.complete&&!shown.shortened,redacted:body.redacted||shown.protected}}};}
    return {id:integer(row.id,1),kind:string(row.kind,128),source:string(row.source,128),...(row.role===undefined?{}:{role:string(row.role,32)}),...(communication?{communication}:{}),text:this.text(row.text),truncated:flag(row.truncated),
      calls:calls.slice(0,DISPLAY_ENTRY_CALLS).map(value=>this.call(value)),callsOmitted:Math.max(0,calls.length-DISPLAY_ENTRY_CALLS),
      tools:row.toolResults===undefined?[]:array(row.toolResults,8).map(value=>this.tool(value))};
  }
  private metadata(raw:unknown):ActivityInspection['metadata'] {
    const row=record(raw),runningTools=array(row.runningTools);
    return {live:flag(row.live),owner:string(row.owner,16),operation:row.operation===null?null:integer(row.operation),pending:row.pending===null?null:integer(row.pending),
      runningTools:runningTools.slice(0,DISPLAY_RUNNING_TOOLS).map(value=>{const tool=record(value);return {name:string(tool.name,512),toolCallId:string(tool.toolCallId,512),...(tool.elapsedMs===undefined?{}:{elapsedMs:integer(tool.elapsedMs)})};}),runningToolsOmitted:Math.max(0,runningTools.length-DISPLAY_RUNNING_TOOLS),
      ...(row.streamedText===undefined?{}:{streamedText:this.text(row.streamedText)}),...(row.lastError===undefined?{}:{lastError:this.text(row.lastError)}),
      ...(row.autoRetry===undefined?{}:{autoRetry:projectJson(row.autoRetry,4096)}),...(row.compactionFailure===undefined?{}:{compactionFailure:projectJson(row.compactionFailure,4096)})};
  }
  activity(row:Record<string,unknown>,identity:string,readAt:string):ActivityInspection {
    const entries=array(row.turns,12).flatMap(turn=>array(record(turn).entries,200)),selected=entries.slice(0,200);
    return {view:'activity',identity,readAt,nextCursor:inspectCursor(row.nextCursor),coverage:coverage(row.coverage),displayOmitted:Math.max(0,entries.length-selected.length),detail:this.text(row.detail,2000),metadata:this.metadata(row.metadata),entries:selected.map(value=>this.entry(value))};
  }
  history(row:Record<string,unknown>,identity:string,readAt:string):HistoryInspection {
    if(row.order!=='newestFirst'||row.format!=='compact')invalid();
    return {view:'history',identity,readAt,entries:array(row.entries,100).map(value=>this.entry(value,identity)),nextCursor:inspectCursor(row.nextCursor),detail:this.text(row.detail,2000)};
  }
  result(row:Record<string,unknown>,identity:string,readAt:string):ResultInspection {
    const status=string(row.status);if(!['queued','placed','done','unanswered','unavailable'].includes(status))invalid();
    if(status!=='unavailable')integer(row.submissionId,1);
    return {view:'result',identity,readAt,status:status as ResultInspection['status'],...resultIds(row),
      ...(row.answer===undefined?{}:{answer:this.text(row.answer,32*1024)}),...(row.reason===undefined?{}:{reason:this.text(row.reason,2000)}),usage:projectJson(row.usage,4096),
      ...(row.providerBlock===undefined?{}:{providerBlock:projectJson(row.providerBlock,4096)}),...(row.recoveryOf===undefined?{}:{recoveryOf:this.text(row.recoveryOf,2000)})};
  }
  exact(row:Record<string,unknown>,identity:string,readAt:string):ExactInspection {
    const offset=integer(row.offset),nextOffset=row.nextOffset===null?null:integer(row.nextOffset,offset+1);
    // Refuse any extra display cut that would create a gap between native exact pages.
    const body=this.text(row.text,40*1024);if(body.shortened)invalid();
    return {view:'exact',identity,readAt,entryId:integer(row.entryId,1),offset,nextOffset,text:body,truncated:flag(row.truncated)};
  }
}
function resultIds(row:Record<string,unknown>):Pick<ResultInspection,'submissionId'|'requestId'|'operationId'|'entryId'|'answerEntryId'> {
  return {...(row.submissionId===undefined?{}:{submissionId:integer(row.submissionId,1)}),...(row.requestId===undefined?{}:{requestId:string(row.requestId)}),...(row.operationId===undefined?{}:{operationId:string(row.operationId,2000)}),
    ...(row.entryId===undefined?{}:{entryId:integer(row.entryId,1)}),...(row.answerEntryId===undefined?{}:{answerEntryId:integer(row.answerEntryId,1)})};
}
/** IDs, cursors and coverage bypass lossy body projection. */
export function projectInspection(value:unknown,identity:string,readAt=new Date().toISOString()):AgentInspectionView {
  const row=record(value);if(row.sessionId!==identity)invalid();const projection=new InspectionProjection();
  switch(row.view){case 'history':return projection.history(row,identity,readAt);case 'activity':return projection.activity(row,identity,readAt);case 'result':return projection.result(row,identity,readAt);case 'exact':return projection.exact(row,identity,readAt);default:return invalid();}
}
