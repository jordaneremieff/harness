import type {PrimaryView, SavedSession, SavedSessionPage, SessionMetadata, SessionMetadataTarget, Target} from '../shared/api.ts';
import {button, byId, element, setText} from './dom.ts';
import {cardAction,cardActionLabel} from './card-icons.ts';
import {reconcileChildren} from './render.ts';
import {conversationIdentityText} from './tabs.ts';
import {request} from './transport.ts';
import {sessionCaptionRecord} from './sender-caption.ts';

export function humanSessionTitle(values:readonly (string|undefined)[],empty=false):string {
  for (const value of values) {
    const title=value?.trim().split(/\r?\n/,1)[0]?.trim();
    if(title&&!conversationIdentityText(title)&&!/^[a-f0-9]{8,}$/i.test(title)&&!/ · [a-f0-9]{4,8}$/i.test(title))return title.slice(0,120);
  }
  return empty?'New session':'Untitled session';
}
export type SessionRow={key:string;identities?:string[];name:string;at:number;title:string;selected?:boolean;activate?:()=>void;target?:Target;primary?:PrimaryView;saved?:SavedSession};
/** Only explicit identities join live places and retained session metadata. Names never establish identity. */
export function combinedSessionRows(open:readonly SessionRow[],catalog:readonly SessionRow[]):SessionRow[]{
  const seen=new Set<string>(),rows:SessionRow[]=[];
  for(const row of [...open,...catalog]){const identities=row.identities??[row.key];if(identities.some(identity=>seen.has(identity)))continue;for(const identity of identities)seen.add(identity);rows.push(row);}
  return rows;
}
type SessionHooks={older?:()=>{count:number;run:()=>void}|undefined;openTabs?:()=>SessionRow[];menu?:(item:SessionRow,origin:HTMLElement)=>void;updated?:()=>void;primaries:()=>readonly PrimaryView[];selected:()=>string|undefined;openPrimary:(primary:PrimaryView,saved?:SavedSession)=>void;openSaved:(saved:SavedSession)=>void};
type Catalog={pages:SavedSessionPage[];notes:string[];published:Set<string>};
type SessionRowNode={item:SessionRow;node:HTMLElement;open:HTMLButtonElement;label:HTMLElement;menu:HTMLButtonElement};
function primarySession(primary:PrimaryView,saved:SavedSession|undefined):SessionRow {
  const at=saved?Date.parse(saved.modifiedAt):0,name=humanSessionTitle([primary.extension?.title,primary.sessionName,saved?sessionCaptionRecord(saved).name:undefined],!primary.sessionFile);
  return {key:primary.sessionFile??primary.key,identities:[`primary:${primary.key}`,...primary.sessionFile?[`path:${primary.sessionFile}`]:[],...primary.sessionId?[`id:${primary.sessionId}`]:[]],name,at,title:name,target:{kind:'primary',key:primary.key,epoch:primary.epoch},primary,saved};
}
function publishedSession(saved:SavedSession):SessionRow {
  const at=Date.parse(saved.modifiedAt),name=humanSessionTitle([sessionCaptionRecord(saved).name]);
  return {key:saved.path,identities:[`path:${saved.path}`,`id:${saved.id}`],name,at,title:name,saved};
}
/** Saved-session catalogs supply ages; publisher presence never grants an execution capability. */
export class SessionSidebar {
  private scope='';private loadedAt=0;private pending=false;private controller?:AbortController;
  private saved:SavedSession[]=[];private published=new Set<string>();private notes:string[]=[];
  private metadata:SessionMetadata[]=[];
  private readonly rowNodes=new Map<string,SessionRowNode>();
  private readonly olderButton=button('Show more',()=>{this.hooks.older?.()?.run();},'nav-row sidebar-action');
  private readonly node=byId('recent-sessions');private readonly empty=element('p','secondary sidebar-empty','No recent sessions.');private hooks:SessionHooks;
  constructor(hooks:SessionHooks){this.hooks=hooks;}
  diagnostics():string{return this.notes.join('\n');}
  refreshNames():void {this.paint();}
  metadataFor(identities:readonly string[]):SessionMetadata|undefined {return this.metadata.find(item=>item.aliases.some(alias=>identities.includes(alias)));}
  applyMetadata(item:SessionMetadata):void {
    this.metadata=this.metadata.filter(old=>!old.aliases.some(alias=>item.aliases.includes(alias)));this.metadata.push(item);this.paint();this.hooks.updated?.();
  }
  async readMetadata(target:SessionMetadataTarget):Promise<SessionMetadata> {
    const response=await request<{items:SessionMetadata[]}>('/api/sessions/metadata/read','POST',{targets:[target]},undefined,AbortSignal.timeout(15_000));
    const item=response.items[0];if(!item)throw new Error('Session state unavailable.');return item;
  }
  archivedRecords():SessionMetadata[] {return this.metadata.filter(item=>item.archived);}
  async archived():Promise<SessionMetadata[]> {await this.loadMetadata();return this.archivedRecords();}
  private async loadMetadata(signal?:AbortSignal):Promise<void> {
    const before=new Set(this.metadata),scope=this.scope;
    const response=await request<{items:SessionMetadata[]}>('/api/sessions/metadata','GET',undefined,undefined,signal);
    if(signal?.aborted||scope!==this.scope)return;
    // Newer records replace matching aliases without discarding unrelated listing facts.
    const changed=this.metadata.filter(item=>!before.has(item)),aliases=new Set(changed.flatMap(item=>item.aliases));
    this.metadata=[...response.items.filter(item=>!item.aliases.some(alias=>aliases.has(alias))),...changed];this.paint();this.hooks.updated?.();
  }
  refresh(workspace:string|undefined):void {
    if(!workspace)return;
    const primaries=this.hooks.primaries(),projects=[...new Set(primaries.map(item=>item.cwd))],scope=JSON.stringify([workspace,projects,primaries.map(item=>[item.key,item.epoch,item.sessionId,item.sessionFile])]);
    if(scope!==this.scope){this.controller?.abort();this.scope=scope;this.saved=[];this.published.clear();this.notes=[];this.metadata=[];this.loadedAt=0;this.pending=false;}
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
    const metadata=this.loadMetadata(controller.signal).catch(error=>{if(!controller.signal.aborted)catalog.notes.push(error instanceof Error?error.message:String(error));});
    for(let at=0;at<paths.length;at+=4){
      if(controller.signal.aborted)return;
      await Promise.all(paths.slice(at,at+4).map(path=>this.catalogPage(path,controller.signal,catalog)));
    }
    await metadata;if(controller.signal.aborted)return;
    const saved=new Map<string,SavedSession>();for(const page of catalog.pages)for(const item of page.items)saved.set(item.path,item);
    this.saved=[...saved.values()];this.published=catalog.published;this.notes=catalog.notes;this.hooks.updated?.();
    byId('session-open').title='Search sessions';
  }
  registered(identity:string):SavedSession|undefined{return this.saved.find(item=>item.id===identity&&this.published.has(item.path));}
  private sessionRows():SessionRow[]{
    const metadata=new Map(this.saved.map(item=>[item.path,item])),seen=new Set<string>(),rows:SessionRow[]=[];
    const primaries=[...this.hooks.primaries()].sort((a,b)=>Number(b.lifecycle==='ready')-Number(a.lifecycle==='ready'));
    for(const primary of primaries){const key=primary.sessionFile??primary.key;if(seen.has(key))continue;seen.add(key);rows.push(primarySession(primary,primary.sessionFile?metadata.get(primary.sessionFile):undefined));}
    for(const saved of this.saved)if(!seen.has(saved.path)&&this.published.has(saved.path))rows.push(publishedSession(saved));
    return combinedSessionRows(this.hooks.openTabs?.()??[],rows.sort((a,b)=>(Number.isFinite(b.at)?b.at:0)-(Number.isFinite(a.at)?a.at:0))).flatMap(row=>{
      const metadata=this.metadataFor(row.identities??[row.key]);if(metadata?.archived)return [];
      const name=humanSessionTitle([metadata?.name,row.name,metadata?.title]);return [{...row,name,title:name}];
    });
  }
  private createRow(item:SessionRow):SessionRowNode {
    const node=element('div','sidebar-session-row'),label=element('span','row-title');
    const open=button('',()=>{const item=view.item;if(item.activate)item.activate();else if(item.primary)this.hooks.openPrimary(item.primary,item.saved);else if(item.saved)this.hooks.openSaved(item.saved);},'nav-row sidebar-content-row');
    const menu=cardAction('menu',`Actions for ${item.name}`,()=>this.hooks.menu?.(view.item,menu),'session-row-menu');
    const view:SessionRowNode={item,node,open,label,menu};open.append(label);node.append(open,menu);
    node.dataset.sessionKey=open.dataset.sessionKey=menu.dataset.sessionKey=item.key;
    menu.setAttribute('aria-haspopup','menu');menu.setAttribute('aria-expanded','false');return view;
  }
  private restoreFocus(active:HTMLElement,focused:string|undefined,index:number,nodes:HTMLElement[]):void {
    if(active.isConnected){if(document.activeElement!==active)active.focus({preventScroll:true});}
    else([...(this.node.querySelectorAll<HTMLButtonElement>('.sidebar-content-row'))].find(node=>node.dataset.sessionKey===focused)??nodes[Math.min(Math.max(0,index),nodes.length-1)]?.querySelector<HTMLButtonElement>('.sidebar-content-row')??byId('sessions-heading')).focus({preventScroll:true});
  }
  private paint():void{
    try {
    const active=document.activeElement as HTMLElement|null,focused=active?.dataset.sessionKey,owned=!!active&&this.node.contains(active),index=[...this.node.children].findIndex(node=>node.contains(active));
    const keep=new Set<string>(),nodes:HTMLElement[]=this.sessionRows().map(item=>{
      keep.add(item.key);let view=this.rowNodes.get(item.key);if(!view){view=this.createRow(item);this.rowNodes.set(item.key,view);}view.item=item;
      setText(view.label,item.name);view.open.title=item.name;view.open.setAttribute('aria-label',item.name);cardActionLabel(view.menu,`Actions for ${item.name}`);
      if(item.selected??(!!item.primary?.key&&item.primary.key===this.hooks.selected())){view.open.setAttribute('aria-current','page');view.node.dataset.selected='true';}
      else{view.open.removeAttribute('aria-current');delete view.node.dataset.selected;}
      return view.node;
    });
    for(const key of this.rowNodes.keys())if(!keep.has(key))this.rowNodes.delete(key);
    if(this.hooks.older?.())nodes.push(this.olderButton);
    reconcileChildren(this.node,nodes.length?nodes:[this.empty]);
    if(owned&&active)this.restoreFocus(active,focused,index,nodes);
    } catch (error) {try {window.reportClientError?.('Sessions',error);} catch {} throw error;}
  }
}
