import type {PrimaryView, SavedSession, SavedSessionPage} from '../shared/api.ts';
import {button, byId, element} from './dom.ts';
import {compactAge} from './format.ts';
import {request} from './transport.ts';
import {senderCaption,sessionCaptionRecord,type SenderCaptionRecord} from './sender-caption.ts';

function row(label:string,state:string,title:string,run:()=>void):HTMLButtonElement {
  const node=button('',run,'nav-row sidebar-content-row');
  node.append(element('span','row-title',label),element('span','row-meta',state));node.title=title;
  node.setAttribute('aria-label',[label,state].filter(Boolean).join(' · '));return node;
}
export type SessionRow={key:string;identities?:string[];name:string;at:number;state:string;title:string;selected?:boolean;activate?:()=>void;primary?:PrimaryView;saved?:SavedSession};
/** Only explicit identities join live places and retained session metadata. Names never establish identity. */
export function combinedSessionRows(open:readonly SessionRow[],catalog:readonly SessionRow[]):SessionRow[]{
  const seen=new Set<string>(),rows:SessionRow[]=[];
  for(const row of [...open,...catalog]){const identities=row.identities??[row.key];if(identities.some(identity=>seen.has(identity)))continue;for(const identity of identities)seen.add(identity);rows.push(row);}
  return rows;
}
type SessionHooks={older?:()=>{count:number;run:()=>void}|undefined;openTabs?:()=>SessionRow[];caption?:(sender:{identity:string;name?:string},registered?:SenderCaptionRecord)=>string;updated?:()=>void;primaries:()=>readonly PrimaryView[];selected:()=>string|undefined;openPrimary:(primary:PrimaryView,saved?:SavedSession)=>void;openSaved:(saved:SavedSession)=>void};
type Catalog={pages:SavedSessionPage[];notes:string[];published:Set<string>};
function primarySession(primary:PrimaryView,saved:SavedSession|undefined,caption=senderCaption):SessionRow {
  const identity=primary.sessionId??saved?.id??primary.key,sender={identity,name:primary.sessionName};
  const registered=saved?.id === identity ? sessionCaptionRecord(saved) : {identity,cwd:primary.cwd};
  const at=saved?Date.parse(saved.modifiedAt):0,name=caption(sender,undefined,registered);
  return {key:primary.sessionFile??primary.key,identities:[`primary:${primary.key}`,...primary.sessionFile?[`path:${primary.sessionFile}`]:[],...primary.sessionId?[`id:${primary.sessionId}`]:[]],name,at,state:primary.lifecycle!=='ready'&&saved?.writer==='live'?'live':at?compactAge(at,Date.now()):'',title:[name,primary.sessionId,`Primary ${primary.key}`,primary.sessionFile,primary.cwd,primary.lifecycle,saved?.modifiedAt,saved?.writer==='live'?'Live in terminal · read-only snapshot':''].filter(Boolean).join('\n'),primary,saved};
}
function publishedSession(saved:SavedSession,caption=senderCaption):SessionRow {
  const at=Date.parse(saved.modifiedAt),name=caption({identity:saved.id},undefined,sessionCaptionRecord(saved));
  return {key:saved.path,identities:[`path:${saved.path}`,`id:${saved.id}`],name,at,state:saved.writer==='live'?'live in terminal':compactAge(at,Date.now()),title:[name,saved.id,saved.project,saved.path,saved.modifiedAt,saved.writer==='live'?'Live in terminal · read-only snapshot':''].filter(Boolean).join('\n'),saved};
}
/** Saved-session catalogs supply ages; publisher presence never grants an execution capability. */
export class SessionSidebar {
  private scope='';private loadedAt=0;private pending=false;private controller?:AbortController;
  private saved:SavedSession[]=[];private published=new Set<string>();private notes:string[]=[];
  private readonly node=byId('recent-sessions');private readonly empty=element('p','secondary sidebar-empty','No recent sessions.');private hooks:SessionHooks;
  constructor(hooks:SessionHooks){this.hooks=hooks;}
  diagnostics():string{return this.notes.join('\n');}
  refreshNames():void {this.paint();}
  refresh(workspace:string|undefined):void {
    if(!workspace)return;
    const projects=[...new Set(this.hooks.primaries().map(item=>item.cwd))],scope=JSON.stringify([workspace,projects]);
    if(scope!==this.scope){this.controller?.abort();this.scope=scope;this.saved=[];this.published.clear();this.notes=[];this.loadedAt=0;this.pending=false;}
    this.paint();if(this.pending||Date.now()-this.loadedAt<60_000)return;
    this.pending=true;const controller=new AbortController();this.controller=controller;
    void this.load(projects,controller).finally(()=>{if(this.controller===controller){this.pending=false;this.loadedAt=Date.now();this.paint();}});
  }
  private async catalogPage(path:string,signal:AbortSignal,catalog:Catalog):Promise<void>{
    try{
      const page=await request<SavedSessionPage>(path,'GET',undefined,undefined,AbortSignal.any([signal,AbortSignal.timeout(15_000)]));
      if(signal.aborted)return;catalog.pages.push(page);
      if(path==='/api/sessions/published')for(const item of page.items)catalog.published.add(item.path);
      if(page.nextCursor||page.omitted)catalog.notes.push(`Session catalog: ${page.items.length} loaded; ${page.omitted} omitted; more: ${!!page.nextCursor}`);
    }catch(error){if(!signal.aborted)catalog.notes.push(error instanceof Error?error.message:String(error));}
  }
  private async load(projects:string[],controller:AbortController):Promise<void>{
    const paths=['/api/sessions/published',...projects.map(project=>`/api/sessions?project=${encodeURIComponent(project)}`)];
    const catalog:Catalog={pages:[],notes:[],published:new Set()};
    for(let at=0;at<paths.length;at+=4){
      if(controller.signal.aborted)return;
      await Promise.all(paths.slice(at,at+4).map(path=>this.catalogPage(path,controller.signal,catalog)));
    }
    if(controller.signal.aborted)return;
    const saved=new Map<string,SavedSession>();for(const page of catalog.pages)for(const item of page.items)saved.set(item.path,item);
    this.saved=[...saved.values()];this.published=catalog.published;this.notes=catalog.notes;this.hooks.updated?.();
    byId('session-open').title=['Find session',...catalog.notes].join('\n');
  }
  registered(identity:string):SavedSession|undefined{return this.saved.find(item=>item.id===identity&&this.published.has(item.path));}
  private sessionRows():SessionRow[]{
    const metadata=new Map(this.saved.map(item=>[item.path,item])),seen=new Set<string>(),rows:SessionRow[]=[];
    const primaries=[...this.hooks.primaries()].sort((a,b)=>Number(b.lifecycle==='ready')-Number(a.lifecycle==='ready'));
    for(const primary of primaries){const key=primary.sessionFile??primary.key;if(seen.has(key))continue;seen.add(key);rows.push(primarySession(primary,primary.sessionFile?metadata.get(primary.sessionFile):undefined,(sender,_roster,registered)=>this.hooks.caption?.(sender,registered)??senderCaption(sender,undefined,registered)));}
    for(const saved of this.saved)if(!seen.has(saved.path)&&this.published.has(saved.path))rows.push(publishedSession(saved,(sender,_roster,registered)=>this.hooks.caption?.(sender,registered)??senderCaption(sender,undefined,registered)));
    return combinedSessionRows(this.hooks.openTabs?.()??[],rows.sort((a,b)=>(Number.isFinite(b.at)?b.at:0)-(Number.isFinite(a.at)?a.at:0)));
  }
  private paint():void{
    try {
    const focused=(document.activeElement as HTMLElement|null)?.dataset.sessionKey;
    const nodes=this.sessionRows().map(item=>{
      const node=row(item.name,item.state,item.title,()=>{if(item.activate)item.activate();else if(item.primary)this.hooks.openPrimary(item.primary,item.saved);else if(item.saved)this.hooks.openSaved(item.saved);});
      node.dataset.sessionKey=item.key;if(item.selected??(item.primary?.key===this.hooks.selected()))node.setAttribute('aria-current','page');return node;
    });
    const older=this.hooks.older?.();if(older)nodes.push(button(`Show earlier conversations (${older.count})`,older.run,'nav-row sidebar-action'));
    this.node.replaceChildren(...(nodes.length?nodes:[this.empty]));
    if(focused)[...this.node.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.dataset.sessionKey===focused)?.focus({preventScroll:true});
    } catch (error) {try {window.reportClientError?.('Sessions',error);} catch {} throw error;}
  }
}
