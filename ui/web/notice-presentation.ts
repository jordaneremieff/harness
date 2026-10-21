import type {EntryView, NoticeView, Target, CommunicationSender} from '../shared/api.ts';
import type {UiState} from './state.ts';

/** `times` is set only when identical notices for one conversation share the row. */
export type NoticeGroup = {items: NoticeView[]; level: NoticeView['level']; message: string; times?: number};
/** Resolves the conversation a notice names; undefined leaves the notice text as supplied. */
export type NoticeNamer = (target: Target) => string | undefined;
export type CommunicationNotice = {key:string;target:Target;entryId:string;messageId:string;kind:'report'|'result'|'check-in';sender:CommunicationSender;firstLine:string;timestamp?:number;read:boolean};
export function unreadReviewNotice(notice:CommunicationNotice|undefined):boolean{return !!notice&&!notice.read&&(notice.kind==='report'||notice.kind==='result');}
type Arrival = Omit<CommunicationNotice,'key'|'target'|'read'>;
function noticeTimestamp(value:unknown):{timestamp?:number}{return typeof value==='number'&&Number.isFinite(value)?{timestamp:value}:{};}
function communications(entries:readonly EntryView[]):Arrival[]{
  const result:Arrival[]=[];
  for(const entry of entries)for(const message of entry.messages??[]){
    const carrier=message.communication;if(carrier?.state!=='ready'||carrier.value.kind==='notice')continue;
    const value=carrier.value,line=value.body.text.split(/\r?\n/).find(line=>line.trim())?.trim()??'';
    result.push({entryId:entry.id,messageId:message.id,kind:value.kind,sender:value.sender,firstLine:line.slice(0,240)+(line.length>240?'…':''),...noticeTimestamp(message.timestamp)});
  }
  return result;
}
const retentionPriority=(notice:CommunicationNotice):number=>notice.read?0:notice.kind==='check-in'?1:2;
/** Loaded Primary communications and live arrivals share this workspace-scoped browser shelf. */
export class CommunicationNoticeShelf {
  readonly items=new Map<string,CommunicationNotice>();
  private context='';
  // Exact IDs survive row eviction so repeated loaded history never restores a dropped row.
  private known=new Set<string>();
  private importantDrops=0;
  get droppedUnread():number {return this.importantDrops;}
  scope(context:string):boolean{
    if(this.context===context)return false;
    this.context=context;this.items.clear();this.known.clear();this.importantDrops=0;return true;
  }
  seed(target:Extract<Target,{kind:'primary'}>,entries:readonly EntryView[]):boolean{
    let changed=false;for(const item of communications(entries))changed=this.retain(target,item,true)||changed;return changed;
  }
  capture(target:Target,previous:readonly EntryView[],current:readonly EntryView[],baseline=false):boolean{
    if(baseline)return false;
    const previousIds=new Set(communications(previous).map(item=>item.messageId));let changed=false;
    for(const item of communications(current))if(!previousIds.has(item.messageId))changed=this.retain(target,item,false)||changed;
    return changed;
  }
  private retain(target:Target,item:Arrival,read:boolean):boolean{
    const key=JSON.stringify([targetKey(target),item.messageId]),existing=this.items.get(key);
    if(existing){if(read&&existing.entryId!==item.entryId){existing.entryId=item.entryId;return true;}return false;}
    if(this.known.has(key))return false;
    this.known.add(key);this.items.set(key,{...item,key,target,read});
    if(this.items.size>32){
      const oldest=[...this.items.values()].sort((a,b)=>retentionPriority(a)-retentionPriority(b)||(a.timestamp??0)-(b.timestamp??0))[0];
      if(oldest){this.items.delete(oldest.key);if(retentionPriority(oldest)===2)this.importantDrops++;}
    }
    return true;
  }
  unread():number{return [...this.items.values()].filter(item=>!item.read).length;}
}
const severity = {info: 0, warning: 1, error: 2};
const targetKey = (target: Target) => target.kind === 'agent' ? `agent:${target.identity}` : `primary:${target.key}:${target.epoch}`;
function raise(group: NoticeGroup, level: NoticeView['level']): void {if (severity[level] > severity[group.level]) group.level = level;}
/** The row sentence: the conversation name when the notice has one, then the supplied text or its fixed summary. */
function noticeMessage(notice: NoticeView, nameOf?: NoticeNamer): string {
  const unavailable = notice.code === 'observation_unavailable', name = notice.target ? nameOf?.(notice.target) : undefined;
  if (!name) return unavailable ? 'The agent connection is unavailable.' : notice.message;
  return `${name}: ${unavailable ? 'the agent connection is unavailable.' : notice.message}`;
}
/** Only a notice with a target and a code can share a row, and only with the same displayed sentence. */
const mergeKey = (notice: NoticeView, message: string) => notice.target && notice.code ? JSON.stringify([notice.workspaceId, targetKey(notice.target), notice.code, message]) : undefined;
/** Group by the supplied diagnostic code, never by text or filename guesses. */
export function noticeGroups(notices: readonly NoticeView[], nameOf?: NoticeNamer): NoticeGroup[] {
  const groups: NoticeGroup[] = []; let refused: NoticeGroup | undefined; const merged = new Map<string, NoticeGroup>();
  for (const notice of notices) {
    if (notice.code === 'state_record_refused') {
      if (!refused) {refused = {items: [], level: notice.level, message: ''}; groups.push(refused);}
      refused.items.push(notice); raise(refused, notice.level);
      continue;
    }
    const message = noticeMessage(notice, nameOf), key = mergeKey(notice, message), same = key ? merged.get(key) : undefined;
    if (same) {same.items.push(notice); same.times = same.items.length; raise(same, notice.level); continue;}
    const group: NoticeGroup = {items: [notice], level: notice.level, message}; groups.push(group);
    if (key) merged.set(key, group);
  }
  if (refused) refused.message = `${refused.items.length} saved ${refused.items.length === 1 ? 'record could' : 'records could'} not be read. The saved files remain unchanged.`;
  return groups;
}
/** The row text: the message, then the repeat count when notices were merged. */
export function noticeGroupText(group: NoticeGroup): string {return group.times ? `${group.message.replace(/\.$/u, '')} · ${group.times} times` : group.message;}
/** Only a current exact public target is a destination. Names and diagnostic text are not identities. */
export function noticeTarget(state: UiState, notice: NoticeView): Target | undefined {
  if (!state.workspace || notice.workspaceId && notice.workspaceId !== state.workspace.id || state.noticeShelf.get(notice.id) !== notice || state.dismissedNotices.has(notice.id)) return;
  const target = notice.target; if (!target) return;
  if (target.kind === 'agent') return state.roster.has(target.identity) ? target : undefined;
  const index = state.primaryIndex.find(item => item.key === target.key), view = state.primaries.get(target.key);
  if (index && index.epoch !== target.epoch || view && view.epoch !== target.epoch) return;
  return index || view ? target : undefined;
}
