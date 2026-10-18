import type {FileDirectoryPage,FileEntry,FileRoot} from '../shared/files.ts';
import {LIMITS} from '../shared/api.ts';
import {button,element,setText,announce} from './dom.ts';
import {cardIcon} from './card-icons.ts';
import {visibleFileEntry} from './files-tree.ts';
import type {Modal} from './modal.ts';

type Hooks = {current():boolean;page(path:string,cursor:string|undefined,signal:AbortSignal):Promise<FileDirectoryPage>;stage(path:string,signal:AbortSignal,current:()=>boolean):Promise<boolean>};
export function chooseWorkingFile(modal:Modal,root:FileRoot,caption:string,identity:HTMLElement,hooks:Hooks):void {new WorkingFileChooser(modal,root,caption,identity,hooks);}
/** One directory page owner; filtering never expands the saved-folder read scope. */
class WorkingFileChooser {
  private modal:Modal;private root:FileRoot;private caption:string;private identity:HTMLElement;private hooks:Hooks;private token:number;
  private abort=new AbortController();private pageAbort?:AbortController;private generation=0;
  private path='';private entries:FileEntry[]=[];private cursor:string|null=null;private incomplete?:string;private error?:string;private choice?:string;private loading=false;private adding=false;
  private folder=element('p','file-message-fact');private filter=element('input','working-file-filter');private list=element('div','working-file-list');private status=element('p','secondary');private selected=element('p','file-message-fact');
  private up=button('Parent folder',()=>{void this.load(this.path.split('/').slice(0,-1).join('/'));});
  private more=button('More',()=>{void this.load(this.path,true);});private retry=button('Retry files',()=>{void this.load(this.path,this.entries.length>0);});
  private add=button('Add file',()=>{void this.stage();});private cancel=button('Cancel',()=>this.modal.close());
  constructor(modal:Modal,root:FileRoot,caption:string,identity:HTMLElement,hooks:Hooks) {
    this.modal=modal;this.root=root;this.caption=caption;this.identity=identity;this.hooks=hooks;
    modal.open('Choose working-folder file',undefined,()=>this.abort.abort());this.token=modal.token;
    this.filter.type='search';this.filter.placeholder='Filter this folder';this.filter.setAttribute('aria-label','Filter this folder');this.status.setAttribute('role','status');
    this.filter.addEventListener('input',()=>this.paint());
    modal.body.append(element('p','file-message-fact',`Destination: ${caption}`),identity,element('p','secondary','Uses the saved file. Unsaved editor changes are not included. Text files up to 32 KiB. Use Include text after adding; draft text stays within 64 KiB. Nothing is sent.'),this.folder,this.up,this.filter,this.list,this.status,this.selected,this.more,this.retry);
    modal.actions(this.cancel,this.add);this.filter.focus();void this.load('');
  }
  private current():boolean {return this.modal.owns(this.token)&&!this.abort.signal.aborted;}
  private currentPage(generation:number):boolean {return this.current()&&generation===this.generation;}
  private check():void {if(!this.hooks.current())throw new Error('The file folder or destination changed. Choose working-folder file again.');}
  private fullPath(path:string):string {return path?`${this.root.path}${this.root.path.endsWith('/')?'':'/'}${path}`:this.root.path;}
  private choose(entry:FileEntry):void {
    if(this.loading||this.adding)return;
    if(entry.kind==='directory'){void this.load(entry.path);return;}
    if(entry.kind==='file'){this.choice=entry.path;this.paint();this.list.querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus();}
  }
  private row(entry:FileEntry):HTMLButtonElement {
    const row=button('',()=>this.choose(entry));row.className='working-file-row';row.dataset.path=entry.path;
    row.disabled=this.loading||this.adding||!['file','directory'].includes(entry.kind);row.title=entry.path;
    row.append(cardIcon(entry.kind==='directory'?'folder':'file'),element('span','file-name',entry.name));
    if(entry.kind==='file')row.setAttribute('aria-pressed',String(this.choice===entry.path));
    if(entry.kind==='directory')row.setAttribute('aria-label',`Open folder ${entry.name}`);
    return row;
  }
  private emptyText(shown:number):string {
    if(this.loading||shown||this.error)return '';
    if(this.filter.value)return 'No loaded entries match this filter.';
    return this.entries.length?'No visible files in this folder.':'No files loaded in this folder.';
  }
  private statusText(shown:number):string {
    const activity=this.loading?'Loading files…':this.adding?'Reading saved file…':this.error??'';
    return [activity,this.incomplete,this.cursor?'More entries are available.':'',this.emptyText(shown)].filter(Boolean).join(' ');
  }
  private paint():void {
    setText(this.folder,this.fullPath(this.path));const busy=this.loading||this.adding;
    this.up.disabled=!this.path||busy;this.more.hidden=!this.cursor;this.more.disabled=busy;this.retry.hidden=!this.error;this.retry.disabled=busy;
    this.add.disabled=!this.choice||busy;this.filter.disabled=this.adding;
    setText(this.selected,this.choice?`Selected file: ${this.choice}`:'Choose a file.');
    const query=this.filter.value.toLocaleLowerCase(),shown=this.entries.filter(entry=>visibleFileEntry(entry)&&entry.name.toLocaleLowerCase().includes(query));
    this.list.replaceChildren(...shown.map(entry=>this.row(entry)));setText(this.status,this.statusText(shown.length));
  }
  private accept(page:FileDirectoryPage,path:string,append:boolean):void {
    if(page.rootId!==this.root.id||page.path!==path)throw new Error('The folder response identity changed.');
    const combined=[...new Map((append?[...this.entries,...page.entries]:page.entries).map(entry=>[entry.path,entry])).values()];
    if(combined.length>LIMITS.fileDirectoryEntries)throw new Error('The folder exceeds the directory entry limit.');
    this.entries=combined;this.cursor=page.nextCursor;this.incomplete=page.coverage.complete?undefined:page.coverage.reason??'The directory scan is incomplete.';
  }
  private focusBeforePage():void {
    const active=document.activeElement;
    if(this.list.contains(active)||[this.up,this.more,this.retry].some(node=>node===active))this.filter.focus({preventScroll:true});
  }
  private async load(next:string,append=false):Promise<void> {
    if(!this.current()||this.adding)return;
    this.focusBeforePage();this.pageAbort?.abort();this.pageAbort=new AbortController();const generation=++this.generation;
    const cursor=append?this.cursor??undefined:undefined;this.path=next;this.choice=undefined;this.error=undefined;
    if(!append){this.entries=[];this.cursor=null;this.incomplete=undefined;this.filter.value='';}
    this.modal.node.querySelector('#modal-error')?.replaceChildren();this.loading=true;this.paint();
    try {
      this.check();const page=await this.hooks.page(next,cursor,AbortSignal.any([this.abort.signal,this.pageAbort.signal]));
      if(!this.currentPage(generation))return;this.check();this.accept(page,next,append);
    }catch(failure){if(this.currentPage(generation))this.error=failure instanceof Error?failure.message:'Files are unavailable.';}
    finally{if(this.currentPage(generation)){this.loading=false;this.paint();}}
  }
  private receipt(path:string):void {
    const receipt=`File staged for ${this.caption}. Use Include text in that conversation. Nothing was sent.`;
    this.modal.open('Add file to message');this.modal.body.append(element('p','file-message-fact',`Saved file: ${this.fullPath(path)}`),this.identity,element('p','file-message-fact',receipt));
    const close=button('Close',()=>this.modal.close());this.modal.actions(close);close.focus();announce(receipt);
  }
  private async stage():Promise<void> {
    const path=this.choice;if(!path||this.add.disabled||!this.current())return;
    if(document.activeElement===this.add||this.list.contains(document.activeElement))this.cancel.focus({preventScroll:true});
    this.modal.node.querySelector('#modal-error')?.replaceChildren();this.adding=true;this.paint();
    try {this.check();if(await this.hooks.stage(path,this.abort.signal,()=>this.current())&&this.current())this.receipt(path);}
    catch(failure){if(this.current())this.modal.error(failure,'The file was not added.');}
    finally{if(this.current()){this.adding=false;this.paint();}}
  }
}
