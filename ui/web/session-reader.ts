import type {EntryView, HistoryPage, PresentationView, PrimaryView, ReadingView, SavedSession, SavedSessionRead} from '../shared/api.ts';
import {button, element, setText} from './dom.ts';
import {absoluteTime} from './format.ts';
import {sessionLabel} from './picker-state.ts';
import {Transcript} from './render.ts';
import {request} from './transport.ts';

export type SessionReadSource={saved:SavedSession}|{primary:PrimaryView;saved?:SavedSession};
export type SessionReaderReload={source:SessionReadSource;entries:EntryView[];leaf:string|null;before:string|null;primaryCursor:string|null;loaded:boolean;asOf:string;status:string;reading:ReadingView;presentation:PresentationView;scrollLeft:number;focused:boolean};
type Hooks={focus:()=>void;close:()=>void;resume:(source:SessionReadSource)=>void};
/** A page-local read-only view has no conversation target, writer, composer, or saved layout entry. */
export class SessionReader {
  readonly node=element('section','session-reader');
  private heading=button('',()=>this.focus(),'session-reader-title');
  private status=element('p','session-reader-status secondary');
  private time=element('span','secondary');
  private scroller=element('div','transcript session-reader-transcript');
  private latest=element('button','latest','Latest');
  private earlier=button('Earlier retained entries',()=>{void this.read(true);},'quiet');
  private refresh=button('Refresh',()=>{void this.read(false);},'quiet');
  private resume=button('Resume here',()=>{if(this.source)this.hooks.resume(this.source);},'quiet');
  private transcript:Transcript;
  private source?:SessionReadSource;
  private controller?:AbortController;
  private entries:EntryView[]=[];
  private leaf:string|null=null;
  private before:string|null=null;
  private primaryCursor:string|null=null;
  private reading=false;
  private loaded=false;
  private reloadPresentation:PresentationView={revision:0,expanded:[],showThinking:false};
  get reloadReady():boolean{return !this.source||!this.reading;}
  get saved():SavedSession|undefined{return this.loaded?this.source?.saved:undefined;}
  private hooks:Hooks;
  constructor(hooks:Hooks){
    this.hooks=hooks;
    const header=element('header','session-reader-header'),actions=element('div','session-reader-actions');
    actions.append(this.time,this.refresh,this.resume,button('Close',hooks.close,'quiet'));
    const tabs=element('div','session-reader-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Read-only session');
    this.heading.setAttribute('role','tab');this.heading.setAttribute('aria-selected','true');tabs.append(this.heading);
    header.append(tabs,actions,this.status);this.scroller.tabIndex=0;
    this.node.append(header,this.scroller,this.latest);this.node.hidden=true;
    this.node.addEventListener('focusin',hooks.focus);
    this.node.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();hooks.close();}});
    this.node.addEventListener('contextmenu',event=>{if(!(event.target instanceof Element)||!event.target.closest('.transcript'))event.stopPropagation();});
    this.transcript=new Transcript({transcript:this.scroller,latest:this.latest,earlier:this.earlier},{operatorInput:true,cwd:()=>this.source?.saved?.project??(this.source&&'primary' in this.source?this.source.primary.cwd:undefined),presentation:(expanded,showThinking,transcriptView,thinking)=>{this.reloadPresentation={...this.reloadPresentation,revision:this.reloadPresentation.revision+1,expanded:[...expanded],showThinking,...(transcriptView?{transcriptView}:{}),...(thinking?{thinking}:{})};},reading:()=>{},earlier:()=>{void this.read(true);}});
  }
  open(source:SessionReadSource):void {
    this.controller?.abort();this.source=source;this.entries=[];this.before=null;this.primaryCursor=null;this.leaf=null;this.reading=false;this.loaded=false;setText(this.time,'');
    this.transcript.reset();this.reloadPresentation={revision:0,expanded:[],showThinking:false};this.node.hidden=false;this.paintHeader();void this.read(false);
  }
  captureReload():SessionReaderReload|undefined {
    if(!this.source)return;
    if(this.reading)throw new Error('The session snapshot read is still pending.');
    const geometry=this.transcript.captureGeometry();
    return structuredClone({source:this.source,entries:this.entries,leaf:this.leaf,before:this.before,primaryCursor:this.primaryCursor,loaded:this.loaded,asOf:this.time.textContent??'',status:this.status.textContent??'',presentation:this.reloadPresentation,scrollLeft:this.scroller.scrollLeft,focused:this.node.contains(document.activeElement),reading:{revision:0,anchorId:geometry.anchor?.id??null,offsetPx:geometry.anchor?.offsetPx??0,followTail:geometry.followTail}});
  }
  restoreReload(value:SessionReaderReload):void {
    if(value.entries.length>500)throw new Error('The retained session snapshot exceeds its view bound.');
    this.controller?.abort();this.controller=undefined;this.source=structuredClone(value.source);this.entries=structuredClone(value.entries);
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
  close():void {this.controller?.abort();this.source=undefined;this.reading=false;this.node.hidden=true;this.node.remove();}
  focus():void {this.scroller.focus({preventScroll:true});}
  private paintHeader():void {
    if(!this.source)return;
    const saved=this.source.saved,primary='primary' in this.source?this.source.primary:undefined;
    const title=primary?.sessionName?.trim()||(saved?sessionLabel(saved):`${primary?.cwd.split('/').filter(Boolean).at(-1)||'Session'} · ${(primary?.sessionId??primary?.key??'').slice(-4)}`);
    const folder=saved?.project??primary?.cwd??'',live=saved?.writer==='live',folderName=folder.split('/').filter(Boolean).at(-1)||folder;
    setText(this.heading,[title,live?'live in terminal':'',folderName].filter(Boolean).join(' · '));
    this.heading.title=[saved?.id??primary?.sessionId,primary?`Primary ${primary.key}`:'',saved?.path??primary?.sessionFile,folder].filter(Boolean).join('\n');
    this.resume.hidden=!this.loaded||live||!saved&&primary?.lifecycle!=='ready'&&!primary?.sessionFile;this.resume.disabled=this.reading;
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
    if(this.entries.length>500){this.entries=this.entries.slice(-500);this.before=null;this.primaryCursor=null;}
  }
  private coverage(coverage:HistoryPage['coverage']):void {
    const shortened=coverage.truncated||this.entries.some(entry=>entry.data?.truncated||entry.messages?.some(message=>message.coverage.truncated));
    setText(this.status,[`${this.entries.length} retained entries loaded`,coverage.complete&&!shortened?'Complete retained ancestry':'Bounded retained ancestry',coverage.reason,shortened?'Content is shortened or incomplete.':'',this.entries.length>=500?'This view reached its entry bound; Refresh reads the latest snapshot.':''].filter(Boolean).join(' · '));
  }
}
