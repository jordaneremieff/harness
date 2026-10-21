import type { CommunicationPresentation, EntryView } from '../shared/api.ts';
import {isValidTimestamp} from './format.ts';

/** Unknown timestamps keep their source slots; only known message times determine order. */
export function noticeTimeOrder<T>(items:readonly T[],timestamp:(item:T)=>number|undefined):T[] {
  const time=(item:T)=>{const value=timestamp(item);return value !== undefined && isValidTimestamp(value) ? value : undefined;};
  const known=items.flatMap(item=>{const at=time(item);return at === undefined ? [] : [{item,at}];}).sort((a,b)=>a.at-b.at);
  let at=0;return items.map(item=>time(item) === undefined ? item : known[at++]?.item ?? item);
}

export type TranscriptGroup = {key: string; id: string; label: string; kind: 'thread' | 'request'};
type GroupBlock={group?:TranscriptGroup;entries:EntryView[]};
/** Membership uses supplied relationships, never message text or a receiving conversation alone. */
export function entryGroup(entry: EntryView): TranscriptGroup | undefined {
  let selected: TranscriptGroup | undefined;
  for (const message of entry.messages ?? []) {
    const group = messageGroup(message.communication);
    if (!group || selected && selected.key !== group.key) return;
    selected = group;
  }
  return selected;
}

function messageGroup(carrier?: CommunicationPresentation): TranscriptGroup | undefined {
  if (carrier?.state !== 'ready') return;
  const {value, origin} = carrier;
  if (value.kind === 'result' && value.metadata.references.length > 1) return;
  if (value.kind === 'notice') return {key: JSON.stringify(['thread', value.metadata.threadId]), id: value.metadata.threadId, label: value.metadata.title || value.metadata.threadId, kind: 'thread'};
  if (origin.kind !== 'native') return;
  const target = origin.target;
  return {key: JSON.stringify(['request', target.storageId, target.conversationId, target.requestId]), id: target.requestId, label: target.requestId, kind: 'request'};
}
/** A derived index; unchanged entries require neither part reads nor relationship extraction. */
export class TranscriptGroups {
  readonly membership = new Map<string, TranscriptGroup>();
  private sources = new Map<string, EntryView>();
  private order?: readonly EntryView[];
  private result: EntryView[] = [];
  private headers = new Map<string, {group: TranscriptGroup; count: number}>();
  private dirty = true;
  private positions = new Map<string, number>();
  private references = new Map<string, string>();
  update(changed: ReadonlySet<string>, entries: ReadonlyMap<string, EntryView>): void {
    for (const id of changed) {
      const source = entries.get(id);
      if (source === this.sources.get(id)) continue;
      const previous = this.membership.get(id); const group = source ? entryGroup(source) : undefined;
      if (source) { this.sources.set(id, source); const position = this.positions.get(id); if (position !== undefined) this.result[position] = source; } else this.sources.delete(id);
      if (group) this.membership.set(id, group); else this.membership.delete(id);
      if (previous?.key !== group?.key || previous?.label !== group?.label) this.dirty = true;
    }
  }
  rows(entries: readonly EntryView[], structural = this.order !== entries): EntryView[] {
    // Source identity updates keep the same ordering and headers. Structural changes rebuild only row IDs.
    if (!this.dirty && !structural) return this.result;
    const blocks=this.blocks(entries);
    this.headers.clear(); this.positions.clear(); this.references.clear(); this.result = [];
    for (const block of blocks) {
      this.recordHeader(block);
      for (const entry of block.entries) { this.positions.set(entry.id, this.result.length); this.result.push(entry); }
    }
    this.order = entries; this.dirty = false; return this.result;
  }
  private blocks(entries:readonly EntryView[]):GroupBlock[] {
    const blocks:GroupBlock[]=[],groups=new Map<string,GroupBlock>();
    for(const entry of entries){const group=this.membership.get(entry.id);if(!group){blocks.push({entries:[entry]});continue;}this.groupBlock(group,blocks,groups).entries.push(entry);}
    return blocks;
  }
  private groupBlock(group:TranscriptGroup,blocks:GroupBlock[],groups:Map<string,GroupBlock>):GroupBlock {
    let block:GroupBlock|undefined;
    if(group.kind === 'thread'){groups.clear();const previous=blocks.at(-1);if(previous?.group?.key === group.key)return previous;}
    else block=groups.get(group.key);
    if(block)return block;
    block={group,entries:[]};if(group.kind !== 'thread')groups.set(group.key,block);blocks.push(block);return block;
  }
  private recordHeader(block: GroupBlock): void {
    const first = block.entries[0]; if (!block.group || !first) return;
    this.headers.set(first.id, {group: block.group, count: block.entries.length});
    if (block.group.kind === 'thread' && !this.references.has(block.group.id)) this.references.set(block.group.id, first.id);
  }
  reference(id: string): string | undefined { return this.references.get(id); }
  header(id: string): {group: TranscriptGroup; count: number} | undefined { return this.headers.get(id); }
}
