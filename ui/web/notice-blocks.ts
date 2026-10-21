import type {Communication, CommunicationSender, EntryView, MessageView} from '../shared/api.ts';
import type {TranscriptRow} from './transcript-rows.ts';
import type {CommunicationCard} from './communication.ts';
import {senderName} from './entry-presentation.ts';
import type {NamedDestination} from './tool-sentences.ts';
import {button, element, setText} from './dom.ts';
import {compactAge, clockTime, isValidTimestamp, timestampDetails} from './format.ts';
import {noticeTimeOrder} from './transcript-groups.ts';

type Notice = Extract<Communication,{kind:'notice'|'check-in'}>;
type Item = {id:string; message:MessageView; value:Notice; key:string; at?:number};
type Run = {id:string; key:string; items:Item[];received?:boolean};
type Block = {node:HTMLElement; body:HTMLElement; header:HTMLElement; title:HTMLButtonElement; plain:HTMLElement; count:HTMLElement; close:HTMLButtonElement;run:Run; painted?:string};
export type NoticeChild = {node:HTMLElement; id?:string};
type Hooks = {owner?:string;toggle?:(id:string)=>void;retained?:(id:string)=>boolean;senderCaption?:(sender:CommunicationSender)=>string; subject?:(identity:string)=>NamedDestination|undefined; thread?:(id:string,title?:string)=>void;
  source:(id:string)=>CommunicationCard|undefined; protected:(id:string)=>boolean; reconcile:(node:HTMLElement,children:HTMLElement[])=>void};
function noticeSource(entry:EntryView):boolean {
  return !!entry.messages?.length && entry.messages.every(message=>message.communication?.state === 'ready' && (message.communication.value.kind === 'notice' || message.communication.value.kind === 'check-in'));
}
function sourcePositions(source:readonly EntryView[]):Map<string,number> {
  return new Map(source.flatMap((entry,index)=>noticeSource(entry) ? [[entry.id,index] as const] : []));
}
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
function receivedNotice(item:Item,owner:string|undefined):boolean {
  return !!owner&&item.value.kind==='notice'&&item.value.sender.identity!==owner&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?::[1-9][0-9]*)?$/.test(item.value.sender.identity);
}
function continuesRun(run:Run,item:Item,received:boolean,position:number|undefined,prior:number|undefined):boolean {
  if(run.key!==item.key||run.received!==received||position===undefined||prior===undefined)return false;
  if(position!==prior&&position!==prior+1)return false;
  const before=run.items.at(-1)?.message.timestamp,after=item.message.timestamp;
  return !(typeof before==='number'&&typeof after==='number'&&isValidTimestamp(before)&&isValidTimestamp(after)&&after-before>30*60_000);
}
/** Groups the existing view nodes; original entry/message owners and virtual rows remain unchanged. */
export class NoticeBlocks {
  private byRow=new Map<string,Run>();
  private blocks=new Map<string,Block>();
  private collapsed=new Map<string,string>();
  private summaries=new Map<string,{node:HTMLButtonElement;label:HTMLElement;time:HTMLElement;signature:string}>();
  private hooks:Hooks;
  constructor(hooks:Hooks) {this.hooks=hooks;}
  clear():void {this.byRow.clear();this.blocks.clear();this.collapsed.clear();this.summaries.clear();}
  rebuild(entries:readonly EntryView[],rows:ReadonlyMap<string,TranscriptRow>,source:readonly EntryView[]):EntryView[] {
    const previous=this.byRow,next=new Map<string,Run>(),used=new Set<string>(),positions=sourcePositions(source);
    let run:Run|undefined,prior:number|undefined;
    for(const entry of entries) {
      const old=previous.get(entry.id);
      const row=rows.get(entry.id),position=row ? positions.get(row.source.id) : undefined;
      const item=this.currentItem(entry.id,row,old);
      if(!item){run=undefined;prior=undefined;continue;}
      const received=position!==undefined&&receivedNotice(item,this.hooks.owner);
      if(!run||!continuesRun(run,item,received,position,prior)) {
        const reuse=old?.key === item.key && !used.has(old.id) ? old.id : item.id;
        run={id:reuse,key:item.key,items:[],received};used.add(reuse);
      }
      run.items.push(item);next.set(entry.id,run);prior=position;
    }
    for(const group of new Set(next.values()))group.items=noticeTimeOrder(group.items,item=>item.message.timestamp);
    this.retainRuns(previous,next);this.byRow=next;
    return this.ordered(entries,next);
  }
  private currentItem(id:string,row:TranscriptRow|undefined,old:Run|undefined):Item|undefined {
    return this.hooks.protected(id) ? old?.items.find(item=>item.id === id) : noticeItem(row);
  }
  private ordered(entries:readonly EntryView[],runs:ReadonlyMap<string,Run>):EntryView[] {
    const byId=new Map(entries.map(entry=>[entry.id,entry])),seen=new Set<Run>(),result:EntryView[]=[];
    for(const entry of entries){const run=runs.get(entry.id);if(!run){result.push(entry);continue;}if(seen.has(run))continue;seen.add(run);for(const item of run.items){const current=byId.get(item.id);if(current)result.push(current);}}
    return result;
  }
  private retainRuns(previous:ReadonlyMap<string,Run>,next:ReadonlyMap<string,Run>):void {
    const used=new Set<string>();
    for(const run of new Set(next.values())) {
      const prior=run.items.map(item=>previous.get(item.id)).find(old=>old?.key === run.key && !used.has(old.id));
      run.id=prior?.id ?? run.items[0]?.id ?? run.id;used.add(run.id);
    }
    for(const id of this.blocks.keys())if(!used.has(id))this.blocks.delete(id);
  }
  private key(id:string,open:boolean):string {return `received-${open?'open':'closed'}:${id}`;}
  private choice(run:Run,expanded:Set<string>,open:boolean):boolean {return expanded.has(this.key(run.id,open))||run.items.some(item=>expanded.has(this.key(item.id,open)));}
  private runOpen(run:Run,expanded:Set<string>,reading?:string):boolean {
    const closed=this.choice(run,expanded,false),readingInside=run.items.some(item=>item.id===reading);
    if(readingInside&&!closed)expanded.add(this.key(run.id,true));
    return this.choice(run,expanded,true)||run.items.some(item=>this.hooks.retained?.(item.id))||readingInside&&!closed;
  }
  project(entries:EntryView[],expanded:Set<string>,reading?:string):EntryView[] {
    this.collapsed.clear();const retained=new Set<string>();
    for(const run of new Set(this.byRow.values())) {
      if(!run.received)continue;retained.add(run.id);
      if(this.runOpen(run,expanded,reading))continue;
      const first=run.items[0];if(!first)continue;
      expanded.add(this.key(run.id,false));
      for(const item of run.items)this.collapsed.set(item.id,first.id);
      this.summaryRow(run);
    }
    for(const id of this.summaries.keys())if(!retained.has(id))this.summaries.delete(id);
    return entries.filter(entry=>!this.collapsed.has(entry.id)||this.collapsed.get(entry.id)===entry.id);
  }
  toggle(id:string,expanded:Set<string>):boolean {
    const run=[...new Set(this.byRow.values())].find(run=>run.id===id);if(!run?.received)return false;
    const open=this.collapsed.has(run.items[0]?.id??'');
    if(!open&&run.items.some(item=>this.hooks.protected(item.id)))return false;
    for(const member of new Set([run.id,...run.items.map(item=>item.id)])){expanded.delete(this.key(member,true));expanded.delete(this.key(member,false));}
    expanded.add(this.key(run.id,open));return true;
  }
  open(id:string,expanded:Set<string>):boolean {
    const run=this.byRow.get(id);if(!run?.received||!this.collapsed.has(id))return false;
    for(const member of new Set([run.id,...run.items.map(item=>item.id)]))expanded.delete(this.key(member,false));
    expanded.add(this.key(run.id,true));return true;
  }
  focus(id:string):void {const run=[...new Set(this.byRow.values())].find(run=>run.id===id);if(!run)return;const node=this.collapsed.has(run.items[0]?.id??'')?this.summaries.get(id)?.node:this.blocks.get(id)?.close;if(node?.isConnected&&!node.closest('[hidden],[inert]'))node.focus({preventScroll:true});}
  alias(id:string):string {return this.collapsed.get(id)??id;}
  summary(id:string):HTMLElement|undefined {const run=this.byRow.get(id);return this.collapsed.get(id)===id&&run?this.summaries.get(run.id)?.node:undefined;}
  private summaryRow(run:Run):void {
    let cached=this.summaries.get(run.id);
    if(!cached){const node=button('',()=>this.hooks.toggle?.(run.id),'received-notice-toggle'),label=element('span','row-title'),time=element('span','notice-block-count');node.append(label,time);cached={node,label,time,signature:''};this.summaries.set(run.id,cached);}
    const first=run.items[0],last=run.items.at(-1);if(!first)return;
    const start=first.message.timestamp,end=last?.message.timestamp;
    const range=typeof start==='number'&&typeof end==='number'&&isValidTimestamp(start)&&isValidTimestamp(end)?`${clockTime(start)} to ${clockTime(end)}`:'';
    const title=this.threadTitle(run)??`Thread · ${first.value.kind==='notice'?first.value.metadata.threadId.slice(-8):''}`,label=`${run.items.length} posts in ${title}`,signature=JSON.stringify([label,range,run.key]);
    if(cached.signature===signature)return;cached.signature=signature;setText(cached.label,label);setText(cached.time,range);
    cached.node.setAttribute('aria-expanded','false');cached.node.title=[label,first.value.kind==='notice'?first.value.metadata.threadId:'',typeof start==='number'&&isValidTimestamp(start)?timestampDetails(start).display:'',typeof end==='number'&&isValidTimestamp(end)?timestampDetails(end).display:''].filter(Boolean).join('\n');
  }
  refresh():void {for(const block of this.blocks.values())this.paint(block);}
  decorate(id:string,card:CommunicationCard|undefined):void {
    const run=this.byRow.get(id), first=run?.items[0];
    card?.groupRow(first ? {hideSender:first.value.kind === 'check-in',at:run?.items.find(item=>item.id === id)?.at} : undefined);
  }
  leading(id:string):number {
    const run=this.byRow.get(id);
    if(this.collapsed.has(id))return 0;
    return run?.items[0]?.id === id ? 12+(this.blocks.get(run.id)?.header.offsetHeight ?? 32) : 0;
  }
  trailing(id:string):number {const run=this.byRow.get(id);return !this.collapsed.has(id)&&run?.items.at(-1)?.id === id ? 12 : 0;}
  overhead(id:string):number {return this.leading(id)+this.trailing(id);}
  wrap(children:NoticeChild[]):HTMLElement[] {
    const result:HTMLElement[]=[], bodies=new Map<Block,HTMLElement[]>();let current:Block|undefined;let pending:HTMLElement[]=[];
    for(const child of children) {
      if(!child.id){pending.push(child.node);continue;}
      const run=this.byRow.get(child.id), block=run&&!this.collapsed.has(child.id) ? this.block(run) : undefined;
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
      const title=button('',()=>{if(block)this.openThread(block);},'notice-block-title'),plain=element('span','notice-block-title'),count=element('span','notice-block-count');
      const close=button('Collapse',()=>{if(block)this.hooks.toggle?.(block.run.id);},'received-notice-close');
      header.append(title,plain,count,close);node.append(header,body);block={node,header,body,title,plain,count,close,run};this.blocks.set(run.id,block);
    }
    block.run=run;block.close.hidden=!run.received;block.node.classList.toggle('received-notice-open',!!run.received);return block;
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
    const {run}=block, first=run.items[0];if(!first || this.hooks.protected(first.id))return;
    const label=this.label(run), enabled=first.value.kind === 'notice' ? !!this.hooks.thread : !!this.hooks.source(first.id);
    const identity=first.value.kind === 'notice' ? first.value.metadata.threadId : first.value.metadata.sourceId;
    const newest=run.items.reduce((at,item)=>Math.max(at,item.at ?? 0),0);
    const count=`${run.items.length} notices${newest > 0 ? ` · ${compactAge(newest,Date.now())}` : ''}`, signature=JSON.stringify([label,enabled,identity,count]);
    if(block.painted===signature)return;
    block.painted=signature;
    setText(block.title,label);setText(block.plain,label);block.title.hidden=!enabled;block.plain.hidden=enabled;
    block.title.title=`${label}\n${identity}`;block.plain.title=block.title.title;
    setText(block.count,count);
    block.node.setAttribute('aria-label',label);
  }
  private openThread(block:Block):void {
    const first=block.run.items[0];if(!first)return;
    if(first.value.kind === 'notice')this.hooks.thread?.(first.value.metadata.threadId,this.threadTitle(block.run));
    else this.hooks.source(first.id)?.openSource(block.title);
  }
  private mount(block:Block,children:HTMLElement[]):void {
    const first=block.run.items[0]?.id,last=block.run.items.at(-1)?.id;
    const starts=children.some(node=>node.dataset.entryId === first), ends=children.some(node=>node.dataset.entryId === last);
    block.header.hidden=!starts;
    if(block.node.dataset.start!==String(starts))block.node.dataset.start=String(starts);
    if(block.node.dataset.end!==String(ends))block.node.dataset.end=String(ends);
    this.hooks.reconcile(block.body,children);this.paint(block);
  }
}
