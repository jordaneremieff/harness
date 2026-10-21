import type {Communication, CommunicationSender, EntryView, MessageView} from '../shared/api.ts';
import type {TranscriptRow} from './transcript-rows.ts';
import type {CommunicationCard} from './communication.ts';
import {senderName} from './entry-presentation.ts';
import type {NamedDestination} from './tool-sentences.ts';
import {button, element, setText} from './dom.ts';
import {compactAge, isValidTimestamp} from './format.ts';

type Notice = Extract<Communication,{kind:'notice'|'check-in'}>;
type Item = {id:string; message:MessageView; value:Notice; key:string; at?:number};
type Run = {id:string; key:string; items:Item[]};
type Block = {node:HTMLElement; body:HTMLElement; header:HTMLElement; title:HTMLButtonElement; plain:HTMLElement; count:HTMLElement; run:Run};
export type NoticeChild = {node:HTMLElement; id?:string};
type Hooks = {senderCaption?:(sender:CommunicationSender)=>string; subject?:(identity:string)=>NamedDestination|undefined; thread?:(id:string,title?:string)=>void;
  source:(id:string)=>CommunicationCard|undefined; protected:(id:string)=>boolean; reconcile:(node:HTMLElement,children:HTMLElement[])=>void};
function noticeItem(row:TranscriptRow|undefined):Item|undefined {
  if(!row?.parts || row.actionsOnly || row.parts.size !== 1)return;
  const message=row.source.messages?.find(message=>row.parts?.has(message.id));
  const value=message?.communication;
  if(!message || value?.state !== 'ready' || (value.value.kind !== 'notice' && value.value.kind !== 'check-in'))return;
  const notice=value.value, source=notice.kind === 'notice' ? notice.metadata.threadId : notice.metadata.sourceId;
  const key=JSON.stringify(notice.kind === 'notice' ? [notice.kind,source] : [notice.kind,source,notice.sender.identity]);
  const timestamp=message.timestamp && isValidTimestamp(message.timestamp) ? message.timestamp : notice.recordedAt;
  return {id:row.view.id,message,value:notice,key,...(timestamp > 0 && isValidTimestamp(timestamp) ? {at:timestamp} : {})};
}
/** Groups the existing view nodes; original entry/message owners and virtual rows remain unchanged. */
export class NoticeBlocks {
  private byRow=new Map<string,Run>();
  private blocks=new Map<string,Block>();
  private hooks:Hooks;
  constructor(hooks:Hooks) {this.hooks=hooks;}
  clear():void {this.byRow.clear();this.blocks.clear();}
  rebuild(entries:readonly EntryView[],rows:ReadonlyMap<string,TranscriptRow>):void {
    const previous=this.byRow, next=new Map<string,Run>(), used=new Set<string>();let run:Run|undefined;
    for(const entry of entries) {
      const old=previous.get(entry.id);
      const item=this.hooks.protected(entry.id) ? old?.items.find(item=>item.id === entry.id) : noticeItem(rows.get(entry.id));if(!item){run=undefined;continue;}
      if(run?.key !== item.key) {
        const reuse=old?.key === item.key && !used.has(old.id) ? old.id : item.id;
        run={id:reuse,key:item.key,items:[]};used.add(reuse);
      }
      run.items.push(item);next.set(entry.id,run);
    }
    this.retainRuns(previous,next);this.byRow=next;
  }
  private retainRuns(previous:ReadonlyMap<string,Run>,next:ReadonlyMap<string,Run>):void {
    const used=new Set<string>();
    for(const run of new Set(next.values())) {
      const prior=run.items.map(item=>previous.get(item.id)).find(old=>old?.key === run.key && !used.has(old.id));
      run.id=prior?.id ?? run.items[0]?.id ?? run.id;used.add(run.id);
    }
    for(const id of this.blocks.keys())if(!used.has(id))this.blocks.delete(id);
  }
  refresh():void {for(const block of this.blocks.values())this.paint(block);}
  decorate(id:string,card:CommunicationCard|undefined):void {
    const run=this.byRow.get(id), first=run?.items[0];
    card?.groupRow(first ? {hideSender:first.value.kind === 'check-in',at:run?.items.find(item=>item.id === id)?.at} : undefined);
  }
  overhead(id:string):number {
    const run=this.byRow.get(id);if(!run)return 0;
    return (run.items[0]?.id === id ? 12+(this.blocks.get(run.id)?.header.offsetHeight ?? 32) : 0)+(run.items.at(-1)?.id === id ? 12 : 0);
  }
  wrap(children:NoticeChild[]):HTMLElement[] {
    const result:HTMLElement[]=[], bodies=new Map<Block,HTMLElement[]>();let current:Block|undefined;let pending:HTMLElement[]=[];
    for(const child of children) {
      if(!child.id){pending.push(child.node);continue;}
      const run=this.byRow.get(child.id), block=run ? this.block(run) : undefined;
      child.node.classList.toggle('notice-block-entry',!!block);
      if(block !== current){result.push(...pending);pending=[];current=block;if(block)result.push(block.node);}
      if(block){const body=bodies.get(block) ?? [];body.push(...pending,child.node);pending=[];bodies.set(block,body);}
      else {result.push(...pending,child.node);pending=[];}
    }
    result.push(...pending);
    this.mountBlocks(bodies);return result;
  }
  private mountBlocks(bodies:ReadonlyMap<Block,HTMLElement[]>):void {
    for(const [block,body]of bodies)this.mount(block,body);
    for(const [id,block]of this.blocks)if(!bodies.has(block)){this.hooks.reconcile(block.body,[]);this.blocks.delete(id);}
  }
  private block(run:Run):Block {
    let block=this.blocks.get(run.id);
    if(!block) {
      const node=element('section','notice-block'), header=element('div','notice-block-header'), body=element('div','notice-block-body');
      const title=button('',()=>{if(block)this.open(block);},'notice-block-title'),plain=element('span','notice-block-title'),count=element('span','notice-block-count');
      header.append(title,plain,count);node.append(header,body);block={node,header,body,title,plain,count,run};this.blocks.set(run.id,block);
    }
    block.run=run;return block;
  }
  private threadTitle(run:Run):string|undefined {
    for(let at=run.items.length-1;at>=0;at--){const value=run.items[at]?.value;if(value?.kind === 'notice' && value.metadata.title?.trim())return value.metadata.title;}
    return undefined;
  }
  private label(run:Run):string {
    const value=run.items[0]?.value;if(!value)return '';
    return value.kind === 'notice' ? this.threadTitle(run) || `Thread · ${value.metadata.threadId.slice(-8)}` : `Check-ins · ${this.hooks.senderCaption?.(value.sender) ?? senderName(value.sender,this.hooks.subject?.(value.sender.identity))}`;
  }
  private paint(block:Block):void {
    const {run}=block, first=run.items[0];if(!first)return;
    const label=this.label(run), enabled=first.value.kind === 'notice' ? !!this.hooks.thread : !!this.hooks.source(first.id);
    setText(block.title,label);setText(block.plain,label);block.title.hidden=!enabled;block.plain.hidden=enabled;
    const identity=first.value.kind === 'notice' ? first.value.metadata.threadId : first.value.metadata.sourceId;
    block.title.title=`${label}\n${identity}`;block.plain.title=block.title.title;
    const newest=run.items.reduce((at,item)=>Math.max(at,item.at ?? 0),0);
    setText(block.count,`${run.items.length} notices${newest > 0 ? ` · ${compactAge(newest,Date.now())}` : ''}`);
    block.node.setAttribute('aria-label',label);
  }
  private open(block:Block):void {
    const first=block.run.items[0];if(!first)return;
    if(first.value.kind === 'notice')this.hooks.thread?.(first.value.metadata.threadId,this.threadTitle(block.run));
    else this.hooks.source(first.id)?.openSource(block.title);
  }
  private mount(block:Block,children:HTMLElement[]):void {
    const first=block.run.items[0]?.id,last=block.run.items.at(-1)?.id;
    const starts=children.some(node=>node.dataset.entryId === first), ends=children.some(node=>node.dataset.entryId === last);
    block.header.hidden=!starts;block.node.dataset.start=String(starts);block.node.dataset.end=String(ends);
    this.hooks.reconcile(block.body,children);this.paint(block);
  }
}
