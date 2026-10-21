import type {AgentRow, CommunicationBody, DialogView, Target} from '../shared/api.ts';
import type {ConversationTask} from './conversation-tasks.ts';
import {unreadReviewNotice, type CommunicationNotice} from './notice-presentation.ts';
import {button, element, setText} from './dom.ts';

export type DeskRow = {key:string; target:Target; caption:string; fact:string; reason:string; kind:'dialog'|'notice'|'blocked'|'working'|'task'; notice?:CommunicationNotice; task?:ConversationTask; dialog?:DialogView; ask?:CommunicationBody; answer?:CommunicationBody};
export type DeskData = {rows:DeskRow[]; agents:AgentRow[]; tasks:ConversationTask[]; complete:boolean};
type Hooks = {select:(row:DeskRow,slot:HTMLElement)=>void; open:(row:DeskRow)=>void; dialog:(row:DeskRow,slot:HTMLElement)=>void; close:()=>void; changed:()=>void; caption:(sender:Pick<AgentRow,'identity'|'name'>)=>string;canOpen:(row:DeskRow)=>boolean};
type RowView = {node:HTMLElement; title:HTMLButtonElement; body:HTMLElement; slot:HTMLElement; signature:string};
const rank={dialog:0,notice:1,blocked:2,working:3,task:4};
const reviewable=(row:DeskRow|undefined):boolean=>row?.kind==='dialog'||unreadReviewNotice(row?.notice);
const active=(row:DeskRow):boolean=>row.kind==='dialog'||row.kind==='blocked'||row.kind==='working';

/** A page-local review queue. New arrivals never replace the open answer or reorder retained notices. */
export class Desk {
  readonly node=element('section','desk');
  private heading=element('div','desk-heading');
  private scope=element('div','desk-scope');
  private arrivals=button('',()=>this.showNew(),'desk-new');
  private next=button('',()=>this.nextReview(),'desk-next');
  private list=element('div','desk-list');
  private rows=new Map<string,RowView>();
  private data:DeskData={rows:[],agents:[],tasks:[],complete:false};
  private queue:string[]=[];
  private retained=new Map<string,DeskRow>();
  private pending:string[]=[];
  private selected?:string;
  private direct?:DeskRow;
  private close=button('Close',()=>this.hooks.close());
  closeLabel(label:string):void{setText(this.close,label);}
  private all=false;
  private initialized=false;
  private catalog=false;
  private hooks:Hooks;
  constructor(hooks:Hooks){
    this.hooks=hooks;this.node.setAttribute('aria-label','Desk');
    this.heading.append(element('h2',undefined,'Desk'),this.close);
    this.node.append(this.heading,this.scope,this.arrivals,this.next,this.list);
  }
  captureReload():{queue:string[];retained:DeskRow[];pending:string[];selected?:string;direct?:DeskRow;all:boolean;initialized:boolean;catalog:boolean;scrollTop:number} {
    return structuredClone({queue:this.queue,retained:[...this.retained.values()],pending:this.pending,selected:this.selected,direct:this.direct,all:this.all,initialized:this.initialized,catalog:this.catalog,scrollTop:this.node.scrollTop});
  }
  restoreReload(value:ReturnType<Desk['captureReload']>):void {
    this.queue=value.queue;this.retained=new Map(value.retained.map(row=>[row.key,row]));this.pending=value.pending;this.selected=value.selected;this.direct=value.direct;
    this.all=value.all;this.initialized=value.initialized;this.catalog=value.catalog;this.paint();this.node.scrollTop=value.scrollTop;
  }
  reset():void{
    this.queue=[];this.retained.clear();this.pending=[];this.selected=undefined;this.initialized=false;
    this.catalog=false;this.direct=undefined;this.rows.clear();this.list.replaceChildren();
  }
  update(data:DeskData):void{
    this.data=data;
    if(!this.initialized){this.all=!data.tasks.length;this.initialized=true;this.admit();}
    const eligible=this.eligible(),live=new Set(eligible.map(row=>row.key));
    for(const row of eligible)if(this.retained.has(row.key))this.retained.set(row.key,row);
    this.queue=this.queue.filter(key=>this.keep(key,live));
    for(const row of eligible.filter(active))this.retain(row);
    this.pending=eligible.filter(row=>!this.retained.has(row.key)).map(row=>row.key);
    this.order();this.paint();
  }
  private keep(key:string,live:Set<string>):boolean{return this.retained.get(key)?.kind==='notice'||live.has(key);}
  private inScope(row:DeskRow):boolean{
    if(this.all)return row.kind!=='task';
    if(row.kind==='dialog'||row.task)return true;
    const target=row.target,identity=row.notice?.sender.identity??(target.kind==='agent'?target.identity:undefined);
    return !!identity&&this.data.tasks.some(task=>task.reference?.sessionId===identity);
  }
  private eligible():DeskRow[]{return this.data.rows.filter(row=>this.inScope(row));}
  private retain(row:DeskRow):void{if(!this.queue.includes(row.key))this.queue.push(row.key);this.retained.set(row.key,row);}
  private order():void{this.queue.sort((a,b)=>rank[this.retained.get(a)?.kind??'task']-rank[this.retained.get(b)?.kind??'task']);}
  private admit():void{for(const row of this.eligible())this.retain(row);this.pending=[];this.order();}
  private showNew():void{this.admit();this.paint();}
  isNoticeSelected(key:string):boolean{return this.selected===key&&!this.catalog;}
  nextUnread():CommunicationNotice|undefined{return this.queued().find(row=>unreadReviewNotice(row.notice))?.notice;}
  refreshNotice(row:DeskRow):void{if(this.direct?.key===row.key)this.direct=row;if(this.retained.has(row.key))this.retained.set(row.key,row);this.paint();}
  showNotice(row:DeskRow):void{this.all=true;this.catalog=false;if(row.notice?.kind==='check-in')this.direct=row;else{this.direct=undefined;this.retain(row);}this.selected=row.key;this.paint();}
  private queued():DeskRow[]{return this.queue.flatMap(key=>{const row=this.retained.get(key);return row?[row]:[];});}
  private nextReview():void{const row=this.queued().find(reviewable);if(row){this.direct=undefined;this.selected=row.key;this.catalog=false;this.paint();}}
  private changeScope(all:boolean):void{
    this.all=all;this.catalog=false;this.direct=undefined;this.queue=[];this.retained.clear();this.selected=undefined;this.admit();this.paint();
  }
  private paintHeader(queue:DeskRow[]):void{
    const labels=[this.data.complete?'This conversation':'Loaded tasks','All agents'];
    this.scope.replaceChildren(...labels.map((label,index)=>{
      const control=button(label,()=>this.changeScope(index===1));control.setAttribute('aria-pressed',String(this.all===(index===1)));return control;
    }));
    setText(this.arrivals,`${this.pending.length} new · Show`);this.arrivals.hidden=!this.pending.length;
    const next=queue.find(reviewable);setText(this.next,next?`Next review · ${next.reason}`:'');this.next.hidden=!next;
  }
  private showsCatalog(queue:DeskRow[]):boolean{
    if(this.catalog)return true;
    if(queue.some(row=>row.kind==='dialog'||row.kind==='notice'||row.kind==='blocked'||row.kind==='working'))return false;
    return this.all||!queue.length;
  }
  private paint():void{
    const queue=this.queued();this.paintHeader(queue);
    if(this.direct){this.selected=this.direct.key;this.place([this.paintRow(this.direct)]);this.hooks.changed();return;}
    if(!this.selected)this.selected=queue.find(row=>row.kind==='dialog'||row.kind==='notice')?.key;
    if(!queue.some(row=>row.key===this.selected))this.selected=undefined;
    const nodes=this.showsCatalog(queue)?this.agentNodes():queue.map(row=>this.paintRow(row));
    if(!this.showsCatalog(queue))nodes.push(button(`All agents (${this.data.agents.length})`,()=>{this.catalog=true;this.paint();},'desk-agent'));
    this.place(nodes);this.hooks.changed();
  }
  private agentNodes():HTMLElement[]{return this.data.agents.map(agent=>{
    const caption=this.hooks.caption(agent),row:DeskRow={key:`agent:${agent.identity}`,target:{kind:'agent',identity:agent.identity},caption,fact:agent.state,reason:agent.state,kind:'task'};
    return button(caption,()=>this.hooks.open(row),'desk-agent');
  });}
  private view(row:DeskRow):RowView{
    const existing=this.rows.get(row.key);if(existing)return existing;
    const node=element('article','desk-row'),body=element('div','desk-answer'),slot=element('div','desk-composer');slot.id=`desk-composer-${this.rows.size}`;
    const title=button('',()=>{this.selected=row.key;this.paint();},'desk-row-title');node.append(title,body,slot);
    const view={node,title,body,slot,signature:''};this.rows.set(row.key,view);return view;
  }
  private paintRow(row:DeskRow):HTMLElement{
    const current=row.notice ? {...row,caption:this.hooks.caption(row.notice.sender)} : row;
    const view=this.view(current);setText(view.title,`${current.caption} · ${current.fact}`);
    view.title.title=row.target.kind==='agent'?row.target.identity:`${row.target.key}:${row.target.epoch}`;
    const expanded=row.key===this.selected;view.title.setAttribute('aria-expanded',String(expanded));view.body.hidden=view.slot.hidden=!expanded;
    if(expanded)this.paintAnswer(current,view);
    return view.node;
  }
  private paintAnswer(row:DeskRow,view:RowView):void{
    const signature=JSON.stringify([row.ask,row.answer,row.dialog,row.task?.state,row.task?.reason,this.hooks.canOpen(row)]);
    if(view.signature!==signature){
      view.signature=signature;view.body.replaceChildren();
      if(row.ask)this.body(view.body,'Asked',row.ask);
      if(row.answer)this.body(view.body,'Answer',row.answer);
      if(row.task)view.body.append(element('p','secondary',[row.task.state,row.task.reason].filter(Boolean).join(' · ')));
      if(!row.dialog&&this.hooks.canOpen(row))view.body.append(button('Open',()=>this.hooks.open(this.retained.get(row.key)??row)));
    }
    if(row.dialog){view.slot.hidden=true;this.hooks.dialog(row,view.body);}
    else this.hooks.select(row,view.slot);
  }
  private place(nodes:HTMLElement[]):void{
    const keep=new Set(nodes);for(const child of [...this.list.children])if(!keep.has(child as HTMLElement))child.remove();
    for(let index=0;index<nodes.length;index++){const node=nodes[index];if(node&&this.list.children[index]!==node)this.list.insertBefore(node,this.list.children[index]??null);}
  }
  private body(parent:HTMLElement,label:string,body:CommunicationBody):void{
    parent.append(element('h3',undefined,label),element('pre','desk-body',body.text));
    if(!body.complete||body.redacted)parent.append(element('p','secondary',[!body.complete?'Partial text':'',body.redacted?'Redacted':''].filter(Boolean).join(' · ')));
  }
}
