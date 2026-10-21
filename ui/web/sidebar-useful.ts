import type {PrimaryView, SavedSession, SavedSessionPage} from '../shared/api.ts';
import type {CommunicationNotice} from './notice-presentation.ts';
import {button, byId, element, setText} from './dom.ts';
import {absoluteTime, compactAge, isValidTimestamp} from './format.ts';
import {request} from './transport.ts';

function row(label:string,state:string,title:string,run:()=>void):HTMLButtonElement {
  const node=button('',run,'nav-row sidebar-content-row');
  node.append(element('span','row-title',label),element('span','row-meta',state));node.title=title;
  node.setAttribute('aria-label',[label,state].filter(Boolean).join(' · '));return node;
}
const recentPriority=(notice:CommunicationNotice):number=>!notice.read&&notice.kind!=='check-in'?0:1;
export function recentCommunications(notices:readonly CommunicationNotice[]):CommunicationNotice[]{
  return [...notices].reverse().sort((a,b)=>recentPriority(a)-recentPriority(b)||(b.timestamp??0)-(a.timestamp??0)).slice(0,6);
}
export class RecentSidebar {
  private nodes=new Map<string,HTMLButtonElement>();
  private entries=new Map<string,CommunicationNotice>();
  private readonly list=byId('recent-notices');
  private readonly all:HTMLButtonElement;
  private name:(notice:CommunicationNotice)=>string;
  private open:(notice:CommunicationNotice)=>void;
  constructor(name:(notice:CommunicationNotice)=>string,open:(notice:CommunicationNotice)=>void,notices:()=>void){
    this.name=name;this.open=open;this.all=button('Open notices',notices,'nav-row sidebar-action');
  }
  private noticeRow(notice:CommunicationNotice):HTMLButtonElement {
    let node=this.nodes.get(notice.key);
    if(!node){
      const key=notice.key;node=row('','','',()=>{const current=this.entries.get(key);if(current)this.open(current);});
      node.dataset.noticeKey=key;this.nodes.set(key,node);
    }
    const label=[this.name(notice),notice.kind,notice.firstLine].filter(Boolean).join(' · ');
    const age=notice.timestamp!==undefined&&isValidTimestamp(notice.timestamp)?compactAge(notice.timestamp,Date.now()):'';
    setText(node.querySelector('.row-title') as HTMLElement,label);setText(node.querySelector('.row-meta') as HTMLElement,age);
    node.dataset.unread=String(!notice.read);node.title=[label,notice.timestamp===undefined?'':absoluteTime(notice.timestamp)].filter(Boolean).join('\n');
    node.setAttribute('aria-label',[label,age,!notice.read?'Unread':''].filter(Boolean).join(' · '));return node;
  }
  render(notices:readonly CommunicationNotice[]):void {
    this.entries=new Map(notices.map(notice=>[notice.key,notice]));
    const nodes:HTMLElement[]=recentCommunications(notices).map(notice=>this.noticeRow(notice));
    setText(this.all,notices.length?`All notices (${notices.length})`:'Open notices');nodes.push(this.all);
    for(const node of nodes)this.list.append(node);
    const keep=new Set(nodes);for(const node of [...this.list.children])if(!keep.has(node as HTMLElement))node.remove();
    const keys=new Set(this.entries.keys());for(const key of this.nodes.keys())if(!keys.has(key))this.nodes.delete(key);
  }
}
type SessionRow={key:string;name:string;at:number;state:string;title:string;primary?:PrimaryView;saved?:SavedSession};
type SessionHooks={primaries:()=>readonly PrimaryView[];selected:()=>string|undefined;choose:(primary:PrimaryView,saved?:SavedSession)=>void;resume:(saved:SavedSession)=>void;create:()=>void};
type Catalog={pages:SavedSessionPage[];notes:string[];published:Set<string>};
function primarySession(primary:PrimaryView,saved:SavedSession|undefined):SessionRow {
  const at=saved?Date.parse(saved.modifiedAt):0,name=primary.sessionName||saved?.title||primary.cwd.split('/').filter(Boolean).at(-1)||'Primary';
  return {key:primary.sessionFile??primary.key,name,at,state:primary.lifecycle!=='ready'&&saved?.writer==='live'?'live':at?compactAge(at,Date.now()):'',title:[name,primary.cwd,primary.lifecycle,saved?.modifiedAt,saved?.writer==='live'?'Live publisher; open session options':''].filter(Boolean).join('\n'),primary,saved};
}
function publishedSession(saved:SavedSession):SessionRow {
  const at=Date.parse(saved.modifiedAt),name=saved.title||saved.project.split('/').filter(Boolean).at(-1)||'Session';
  return {key:saved.path,name,at,state:saved.writer==='live'?'live':compactAge(at,Date.now()),title:[name,saved.project,saved.path,saved.modifiedAt,saved.writer==='live'?'Live in terminal; open session options':''].filter(Boolean).join('\n'),saved};
}
/** Saved-session catalogs supply ages; publisher presence never grants an execution capability. */
export class SessionSidebar {
  private scope='';private loadedAt=0;private pending=false;private controller?:AbortController;
  private saved:SavedSession[]=[];private published=new Set<string>();private notes:string[]=[];
  private readonly node=byId('recent-sessions');private readonly create:HTMLButtonElement;private hooks:SessionHooks;
  constructor(hooks:SessionHooks){this.hooks=hooks;this.create=button('New session',hooks.create,'nav-row sidebar-action');this.node.append(this.create);}
  diagnostics():string{return this.notes.join('\n');}
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
    this.saved=[...saved.values()];this.published=catalog.published;this.notes=catalog.notes;
    byId('session-open').title=['Find session',...catalog.notes].join('\n');
  }
  private sessionRows():SessionRow[]{
    const metadata=new Map(this.saved.map(item=>[item.path,item])),seen=new Set<string>(),rows:SessionRow[]=[];
    const primaries=[...this.hooks.primaries()].sort((a,b)=>Number(b.lifecycle==='ready')-Number(a.lifecycle==='ready'));
    for(const primary of primaries){const key=primary.sessionFile??primary.key;if(seen.has(key))continue;seen.add(key);rows.push(primarySession(primary,primary.sessionFile?metadata.get(primary.sessionFile):undefined));}
    for(const saved of this.saved)if(!seen.has(saved.path)&&this.published.has(saved.path))rows.push(publishedSession(saved));
    return rows.sort((a,b)=>(Number.isFinite(b.at)?b.at:0)-(Number.isFinite(a.at)?a.at:0)).slice(0,6);
  }
  private paint():void{
    const focused=(document.activeElement as HTMLElement|null)?.dataset.sessionKey;
    const nodes=this.sessionRows().map(item=>{
      const node=row(item.name,item.state,item.title,()=>{if(item.primary)this.hooks.choose(item.primary,item.saved);else if(item.saved)this.hooks.resume(item.saved);});
      node.dataset.sessionKey=item.key;if(item.primary?.key===this.hooks.selected())node.setAttribute('aria-current','page');return node;
    });
    this.node.replaceChildren(...(nodes.length?nodes:[this.create]));
    if(focused)[...this.node.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.dataset.sessionKey===focused)?.focus({preventScroll:true});
  }
}
