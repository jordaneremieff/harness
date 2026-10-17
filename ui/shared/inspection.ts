import type {CommunicationPresentation, JsonDisplay} from './api.ts';

/** Native read selectors stay separate from UI operation receipts. */
export type InspectionJson = null | string | number | boolean | InspectionJson[] | {[key:string]:InspectionJson};
export type InspectCursor = {[key:string]:InspectionJson};
export type ResultSelector = {submissionId?: number; requestId?: string; operationId?: string};
export type InspectRequest = {view: 'history'; source?: 'user'; cursor?: InspectCursor; limit?: number} | {view: 'activity'; cursor?: InspectCursor; limit?: number} |
  ({view: 'result'} & ResultSelector) | {view: 'exact'; entryId: number; offset: number};
export type InspectionText = {text: string; shortened: boolean; protected: boolean};
export type InspectionCall = {name: InspectionText; arguments: InspectionText; truncated: boolean; callId?:InspectionText};
export type InspectionEntry = {id: number; kind: string; source: string; role?: string; communication?: CommunicationPresentation; text: InspectionText; truncated: boolean;
  calls: InspectionCall[]; callsOmitted: number;
  tools: {name: string; text: InspectionText; isError: boolean; truncated: boolean}[]};
export type ActivityCoverage = {complete: boolean; scannedEntries: number; scannedBytes: number; omittedEntries: number; bytes?: number;
  entryLimitReached: boolean; scanByteLimitReached: boolean; byteLimitReached: boolean; metadataTruncated: boolean};
type InspectionBase = {identity: string; readAt: string};
export type ActivityInspection = InspectionBase & {view: 'activity'; entries: InspectionEntry[]; nextCursor: InspectCursor | null;
  coverage: ActivityCoverage; displayOmitted: number; detail: InspectionText;
  metadata: {live: boolean; owner: string; operation: number | null; pending: number | null;
    runningTools: {name: string; toolCallId: string; elapsedMs?: number}[]; runningToolsOmitted: number; streamedText?: InspectionText; lastError?: InspectionText; autoRetry?:JsonDisplay; compactionFailure?:JsonDisplay}};
export type ResultInspection = InspectionBase & ResultSelector & {view: 'result'; status: 'queued' | 'placed' | 'done' | 'unanswered' | 'unavailable';
  entryId?: number; answerEntryId?: number; answer?: InspectionText; reason?: InspectionText; usage: JsonDisplay;
  providerBlock?: JsonDisplay; recoveryOf?: InspectionText};
export type ExactInspection = InspectionBase & {view: 'exact'; entryId: number; offset: number; nextOffset: number | null;
  text: InspectionText; truncated: boolean};
export type HistoryInspection = InspectionBase & {view:'history';entries:InspectionEntry[];nextCursor:InspectCursor|null;detail:InspectionText;source?:'user'};
export type AgentInspectionView = ActivityInspection | ResultInspection | ExactInspection | HistoryInspection;

/** Only compact read-view metadata belongs in a same-tab checkpoint. */
export type InspectionCheckpoint = {identity: string; mode: 'activity' | 'result' | 'exact'; selector: ResultSelector;
  entryId?: number; offset: number; scrollTop: number; cursor?:InspectCursor};
export function validInspectCursor(value:unknown):value is InspectCursor {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  try {const encoded=JSON.stringify(value);return new TextEncoder().encode(encoded).length<=4096&&validCursorValue(value,0,{nodes:0});}catch{return false;}
}
function validCursorValue(value:unknown,depth:number,budget:{nodes:number}):boolean {
  if(++budget.nodes>128||depth>8)return false;
  if(value===null||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(typeof value==='string')return value.length<=4096&&!/[\u0000-\u001f\u007f]/.test(value);
  if(Array.isArray(value))return value.every(item=>validCursorValue(item,depth+1,budget));
  if(typeof value!=='object'||!value)return false;
  return Object.entries(value).every(([key,item])=>key.length>0&&key.length<=256&&!/[\u0000-\u001f\u007f]/.test(key)&&validCursorValue(item,depth+1,budget));
}
export function validResultSelector(value: unknown): value is ResultSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ['submissionId','requestId','operationId'].includes(key)) &&
    (row.submissionId === undefined || Number.isSafeInteger(row.submissionId) && (row.submissionId as number) > 0) &&
    ['requestId','operationId'].every(key => row[key] === undefined || typeof row[key] === 'string' && (row[key] as string).length > 0 && (row[key] as string).length <= 1024 && !/[\u0000-\u001f\u007f]/.test(row[key] as string));
}
export function validInspectionCheckpoint(value: unknown): value is InspectionCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ['identity','mode','selector','entryId','offset','scrollTop','cursor'].includes(key)) &&
    typeof row.identity === 'string' && row.identity.length > 0 && row.identity.length <= 256 && !/[\s@]/.test(row.identity) &&
    ['activity','result','exact'].includes(row.mode as string) && validResultSelector(row.selector) &&
    Number.isSafeInteger(row.offset) && (row.offset as number) >= 0 &&
    typeof row.scrollTop === 'number' && Number.isFinite(row.scrollTop) && row.scrollTop >= 0 && row.scrollTop <= 1e9 &&
    (row.entryId === undefined || Number.isSafeInteger(row.entryId) && (row.entryId as number) > 0) &&
    (row.mode !== 'exact' || row.entryId !== undefined) && (row.cursor===undefined||validInspectCursor(row.cursor));
}
