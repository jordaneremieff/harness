import type {EntryView, HistoryPage, PresentationView, PrimaryView, ReadingView, SavedSession, SavedSessionRead} from '../shared/api.ts';
import {button, element, setText} from './dom.ts';
import {absoluteTime} from './format.ts';
import {sessionLabel} from './picker-state.ts';
import {readSessionState, SessionStateBar, type SessionState} from './session-state.ts';
import {Transcript} from './render.ts';
import {request} from './transport.ts';
import type {PrimaryDraftActions, PrimaryDraftSource} from './primary-draft-actions.ts';
/** Entries held in memory by one session reader. */
const ENTRY_WINDOW=500;

export type SessionReadSource={saved:SavedSession}|{primary:PrimaryView;saved?:SavedSession};
export type SessionReaderReload={source:SessionReadSource;entries:EntryView[];leaf:string|null;before:string|null;primaryCursor:string|null;loaded:boolean;asOf:string;status:string;reading:ReadingView;presentation:PresentationView;scrollLeft:number;focused:boolean};
/** Where a saved reader stopped: an entry anchor with its pixel offset, or the tail. */
export type SessionView={anchorId:string|null;offsetPx:number;followTail:boolean;scrollLeft:number};
export function readSessionView(value:unknown):SessionView|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const view=value as Record<string,unknown>,anchor=view.anchorId;
  if(!(anchor===null||typeof anchor==='string'&&anchor.length>0&&anchor.length<=256)||typeof view.followTail!=='boolean')return;
  if(typeof view.offsetPx!=='number'||!Number.isFinite(view.offsetPx)||typeof view.scrollLeft!=='number'||!Number.isFinite(view.scrollLeft))return;
  return {anchorId:anchor,offsetPx:view.offsetPx,followTail:view.followTail,scrollLeft:view.scrollLeft};
}
export function sameSessionView(a:SessionView|undefined,b:SessionView|undefined):boolean {
  return !!a&&!!b&&a.anchorId===b.anchorId&&a.followTail===b.followTail&&Math.abs(a.offsetPx-b.offsetPx)<16&&Math.abs(a.scrollLeft-b.scrollLeft)<16;
}
type Hooks={primaryDraft?:PrimaryDraftActions;primaries?:()=>readonly PrimaryView[]|undefined;focus:()=>void;close:()=>void;resume:(source:SessionReadSource)=>void;
  /** A saved session tab supplies its own title and close control, and reports its reading position. */
  embedded?:boolean;view?:(view:SessionView)=>void};
/** A read-only view has no conversation target, writer or composer. A saved session tab keeps only its reading position in the layout. */
export class SessionReader {
  readonly node=element('section','session-reader');
  private heading=button('',()=>this.focus(),'session-reader-title');
  private status=element('p','session-reader-status secondary');
  private time=element('span','secondary');
  private scroller=element('div','transcript session-reader-transcript');
  private latest=element('button','latest','Latest');
  private earlier=button('Earlier retained entries',()=>{void this.read(true);},'quiet');
  private refresh=button('Refresh',()=>{void this.read(false);},'quiet');
  private resume=button('Resume here',()=>this.resumeCurrent(),'quiet');
  private sessionBar=new SessionStateBar();
  private barSource?:SessionReadSource;
  private transcript:Transcript;
  private source?:SessionReadSource;
  private controller?:AbortController;
  private entries:EntryView[]=[];
  private leaf:string|null=null;
  private before:string|null=null;
  private windowTrimmed=false;
  private primaryCursor:string|null=null;
  private reading=false;
  private loaded=false;
  private reloadPresentation:PresentationView={revision:0,expanded:[],showThinking:false};
  private pendingView?:SessionView;
  private lastView?:SessionView;
  private viewTimer?:ReturnType<typeof setTimeout>;
  get reloadReady():boolean{return !this.source||!this.reading;}
  get saved():SavedSession|undefined{return this.loaded?this.source?.saved:undefined;}
  private hooks:Hooks;
  selectionSource(selection:Selection):PrimaryDraftSource|undefined {return this.transcript.selectionSource(selection);}
  constructor(hooks:Hooks){
    this.hooks=hooks;
    const header=element('header','session-reader-header'),actions=element('div','session-reader-actions');
    const close=button('Close',hooks.close,'quiet');close.hidden=!!hooks.embedded;
    actions.append(this.time,this.refresh,this.resume,close);
    const tabs=element('div','session-reader-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Read-only session');tabs.hidden=!!hooks.embedded;
    this.heading.setAttribute('role','tab');this.heading.setAttribute('aria-selected','true');tabs.append(this.heading);
    header.append(tabs,actions,this.status);this.scroller.tabIndex=0;
    this.node.append(header,this.scroller,this.latest,this.sessionBar.node);this.node.hidden=true;
    this.node.addEventListener('focusin',hooks.focus);
    if(hooks.embedded)this.scroller.addEventListener('scroll',()=>this.scheduleView(),{passive:true});
    else this.node.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();hooks.close();}});
    this.node.addEventListener('contextmenu',event=>{if(!(event.target instanceof Element)||!event.target.closest('.transcript'))event.stopPropagation();});
    this.transcript=new Transcript({transcript:this.scroller,latest:this.latest,earlier:this.earlier},{primaryDraft:hooks.primaryDraft&&{...hooks.primaryDraft,caption:()=>this.heading.textContent??'Session',current:()=>this.loaded&&!!this.source&&!this.node.closest('[hidden],[inert]')},operatorInput:true,cwd:()=>this.source?.saved?.project??(this.source&&'primary' in this.source?this.source.primary.cwd:undefined),presentation:(expanded,showThinking,transcriptView,thinking)=>{this.reloadPresentation={...this.reloadPresentation,revision:this.reloadPresentation.revision+1,expanded:[...expanded],showThinking,...(transcriptView?{transcriptView}:{}),...(thinking?{thinking}:{})};},reading:()=>{},earlier:()=>{void this.read(true);}});
  }
  open(source:SessionReadSource):void {
    this.controller?.abort();this.source=source;this.entries=[];this.before=null;this.primaryCursor=null;this.windowTrimmed=false;this.leaf=null;this.reading=false;this.loaded=false;setText(this.time,'');
    this.transcript.reset();this.reloadPresentation={revision:0,expanded:[],showThinking:false};this.node.hidden=false;this.paintHeader();void this.read(false);
  }
  /** Opens a saved session tab and returns to its stored reading position once the snapshot loads. */
  openTab(source:SessionReadSource,view?:SessionView):void {this.pendingView=view;this.lastView=view;this.open(source);}
  captureView():SessionView|undefined {
    if(!this.source||!this.loaded)return this.pendingView;
    if(this.node.closest('[hidden],[inert]')||!this.node.isConnected)return this.lastView;
    const geometry=this.transcript.captureGeometry();
    return {anchorId:geometry.followTail?null:geometry.anchor?.id??null,offsetPx:geometry.followTail?0:Math.round(geometry.anchor?.offsetPx??0),followTail:geometry.followTail,scrollLeft:Math.round(this.scroller.scrollLeft)};
  }
  /** Keeps the position before a hidden tab loses its scroll offset. */
  hide():void {
    if(this.node.hidden)return;
    const view=this.captureView();if(view)this.lastView=view;
    this.node.hidden=true;
  }
  show():void {
    if(!this.node.hidden)return;
    this.node.hidden=false;this.transcript.visibilityChanged();
    const view=this.lastView;if(!view||!this.loaded)return;
    this.transcript.restore({revision:0,anchorId:view.anchorId,offsetPx:view.offsetPx,followTail:view.followTail});
    requestAnimationFrame(()=>{if(!this.node.hidden)this.scroller.scrollLeft=view.scrollLeft;});
  }
  private scheduleView():void {
    if(!this.loaded||!this.hooks.view||this.node.closest('[hidden],[inert]'))return;
    if(this.viewTimer!==undefined)clearTimeout(this.viewTimer);
    this.viewTimer=setTimeout(()=>{
      this.viewTimer=undefined;const view=this.captureView();
      if(view&&this.source){this.lastView=view;this.hooks.view?.(view);}
    },800);
  }
  captureReload():SessionReaderReload|undefined {
    if(!this.source)return;
    if(this.reading)throw new Error('The session snapshot read is still pending.');
    const geometry=this.transcript.captureGeometry();
    return structuredClone({source:this.source,entries:this.entries,leaf:this.leaf,before:this.before,primaryCursor:this.primaryCursor,loaded:this.loaded,asOf:this.time.textContent??'',status:this.status.textContent??'',presentation:this.reloadPresentation,scrollLeft:this.scroller.scrollLeft,focused:this.node.contains(document.activeElement),reading:{revision:0,anchorId:geometry.anchor?.id??null,offsetPx:geometry.anchor?.offsetPx??0,followTail:geometry.followTail}});
  }
  restoreReload(value:SessionReaderReload):void {
    this.controller?.abort();this.controller=undefined;this.source=structuredClone(value.source);this.entries=structuredClone(value.entries.slice(0,ENTRY_WINDOW));
    this.leaf=value.leaf;this.before=value.before;this.primaryCursor=value.primaryCursor;this.loaded=value.loaded;this.reading=false;
    this.refresh.disabled=false;this.earlier.disabled=false;this.node.hidden=false;this.transcript.reset();this.reloadPresentation=structuredClone(value.presentation);
    this.transcript.configure(this.reloadPresentation,value.reading);this.transcript.set(this.entries,undefined,undefined,!this.before&&!this.primaryCursor);this.transcript.historyAvailable(!!this.before||!!this.primaryCursor);
    setText(this.time,value.asOf);setText(this.status,value.status);this.paintHeader();this.transcript.restore(value.reading);this.transcript.schedule();
    const source=this.source;requestAnimationFrame(()=>{if(this.source!==source)return;this.scroller.scrollLeft=value.scrollLeft;if(value.focused)this.focus();});
  }
  captureGeometry():{source:SessionReadSource;geometry:ReturnType<Transcript['captureGeometry']>;scrollLeft:number}|undefined {
    if(this.source)return {source:this.source,geometry:this.transcript.captureGeometry(),scrollLeft:this.scroller.scrollLeft};
  }
  applyGeometry(value:ReturnType<SessionReader['captureGeometry']>):void {
    if(value&&this.source===value.source){this.transcript.applyGeometry(value.geometry);this.scroller.scrollLeft=value.scrollLeft;}
  }
  close():void {
    this.controller?.abort();this.source=undefined;this.reading=false;this.node.hidden=true;this.node.remove();
    if(this.viewTimer!==undefined){clearTimeout(this.viewTimer);this.viewTimer=undefined;}
  }
  focus():void {this.scroller.focus({preventScroll:true});}
  refreshState():void {this.paintHeader();}
  private bindSessionBar(source:SessionReadSource):void {
    if(this.barSource===source)return;
    this.sessionBar.node.remove();this.sessionBar=new SessionStateBar();this.barSource=source;this.node.append(this.sessionBar.node);
  }
  private viewState():SessionState {return readSessionState(this.source&&'primary' in this.source?this.source.primary:undefined,this.source?.saved,this.hooks.primaries?.());}
  private resumeCurrent():void {
    const source=this.source,view=this.viewState();
    if(!source||!this.loaded||this.reading||view.terminal||this.node.closest('[hidden],[inert]'))return;
    if(view.word==='closed'||view.primary?.lifecycle==='ready')this.hooks.resume(source);
  }
  private paintHeader():void {
    if(!this.source)return;
    const saved=this.source.saved,primary='primary' in this.source?this.source.primary:undefined;
    const title=primary?.sessionName?.trim()||(saved?sessionLabel(saved):`${primary?.cwd.split('/').filter(Boolean).at(-1)||'Session'} · ${(primary?.sessionId??primary?.key??'').slice(-4)}`);
    const source=this.source,view=this.viewState(),folder=saved?.project??primary?.cwd??'',folderName=folder.split('/').filter(Boolean).at(-1)||folder;
    this.bindSessionBar(source);
    setText(this.heading,[title,view.word??'',folderName].filter(Boolean).join(' · '));
    this.heading.title=[saved?.id??primary?.sessionId,primary?`Primary ${primary.key}`:'',saved?.path??primary?.sessionFile,folder].filter(Boolean).join('\n');
    this.resume.hidden=!this.loaded||!!view.terminal||view.primary?.lifecycle!=='ready';this.resume.disabled=this.reading;
    const current=()=>{const next=this.viewState();return this.source===source&&this.loaded&&!this.reading&&next.word===view.word&&next.terminal===view.terminal&&next.path===view.path&&next.project===view.project&&next.primary?.key===view.primary?.key&&next.primary?.epoch===view.primary?.epoch;};
    this.sessionBar.update(this.loaded||view.terminal?view:{},current,()=>this.resumeCurrent(),!this.reading);
  }
  private async read(earlier:boolean):Promise<void>{
    const source=this.source;if(!source||this.reading)return;
    if(earlier&&!this.before&&!this.primaryCursor)return;
    this.reading=true;this.refresh.disabled=true;this.earlier.disabled=true;this.paintHeader();setText(this.status,'Reading retained snapshot');
    const controller=new AbortController();this.controller=controller;
    try{
      await this.fetchSnapshot(source,earlier,AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]));
      this.presentSnapshot(source,controller);
    }catch(error){if(!controller.signal.aborted&&this.source===source)setText(this.status,error instanceof Error?error.message:'The retained snapshot did not load.');}
    finally{if(this.controller===controller){this.reading=false;this.refresh.disabled=false;this.earlier.disabled=false;this.paintHeader();}}
  }
  private presentSnapshot(source:SessionReadSource,controller:AbortController):void {
    if(controller.signal.aborted||this.source!==source)return;
    this.loaded=true;this.transcript.set(this.entries,undefined,undefined,!this.before&&!this.primaryCursor);this.transcript.historyAvailable(!!this.before||!!this.primaryCursor);
    const view=this.pendingView;this.pendingView=undefined;
    if(view){
      this.transcript.restore({revision:0,anchorId:view.anchorId,offsetPx:view.offsetPx,followTail:view.followTail});
      requestAnimationFrame(()=>{if(this.source===source)this.scroller.scrollLeft=view.scrollLeft;});
    }
  }
  private async fetchSnapshot(source:SessionReadSource,earlier:boolean,signal:AbortSignal):Promise<void>{
    if('primary' in source&&source.primary.lifecycle==='ready')return this.primaryPage(source.primary,earlier,signal);
    if(source.saved)return this.savedPage(source.saved,earlier,signal);
    if('primary' in source&&source.primary.sessionFile&&source.primary.sessionId)return this.savedPage({id:source.primary.sessionId,path:source.primary.sessionFile,project:source.primary.cwd},earlier,signal);
    throw new Error('This session has no available retained source.');
  }
  private async primaryPage(primary:PrimaryView,earlier:boolean,signal:AbortSignal):Promise<void>{
    const cursor=earlier&&this.primaryCursor?`&cursor=${encodeURIComponent(this.primaryCursor)}`:'';
    const page=await request<HistoryPage>(`/api/primaries/${encodeURIComponent(primary.key)}/history?epoch=${primary.epoch}${cursor}`,'GET',undefined,undefined,signal);
    if(signal.aborted)return;
    this.primaryCursor=page.nextCursor;this.merge(page.items,earlier);
    setText(this.time,`as of ${absoluteTime(Date.now())}`);this.coverage(page.coverage);
  }
  private async savedPage(saved:Pick<SavedSession,'id'|'path'|'project'>,earlier:boolean,signal:AbortSignal):Promise<void>{
    const query=new URLSearchParams({id:saved.id,path:saved.path,project:saved.project});
    if(earlier&&this.before){query.set('before',this.before);if(this.leaf)query.set('leaf',this.leaf);}
    const page=await request<SavedSessionRead>(`/api/sessions/history?${query}`,'GET',undefined,undefined,signal);
    if(signal.aborted)return;
    if(this.source)this.source.saved=page.session;
    this.leaf=page.leaf;this.before=page.before;this.merge(page.entries,earlier);
    setText(this.time,`as of ${absoluteTime(page.observedAt)}`);this.coverage(page.coverage);
  }
  private merge(entries:EntryView[],earlier:boolean):void {
    const known=new Set(entries.map(entry=>entry.id));this.entries=earlier?[...entries,...this.entries.filter(entry=>!known.has(entry.id))]:entries;
    this.windowTrimmed=false;
    if(this.entries.length<=ENTRY_WINDOW)return;
    // Older pages keep the oldest entries in view and unload the newest, so the paging cursors stay valid and scrolling up never ends early.
    if(earlier){this.entries=this.entries.slice(0,ENTRY_WINDOW);this.windowTrimmed=true;}
    else this.entries=this.entries.slice(-ENTRY_WINDOW);
  }
  private coverage(coverage:HistoryPage['coverage']):void {
    const shortened=coverage.truncated||this.entries.some(entry=>entry.data?.truncated||entry.messages?.some(message=>message.coverage.truncated));
    setText(this.status,[`${this.entries.length} retained entries loaded`,coverage.complete&&!shortened?'Complete retained ancestry':'Bounded retained ancestry',coverage.reason,shortened?'Content is shortened or incomplete.':'',this.windowTrimmed?'Newer entries are unloaded to keep this view bounded; Refresh returns to the latest.':''].filter(Boolean).join(' · '));
  }
}
