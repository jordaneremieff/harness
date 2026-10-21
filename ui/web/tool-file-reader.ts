import type {FileTab} from '../shared/api.ts';
import type {FileReferenceDestination} from './references.ts';
import {FileOwner,type FileRead} from './file-owner.ts';
import {FileView} from './file-view.ts';
import {button,element,setText} from './dom.ts';
import {clockTime,isValidTimestamp,timestampDetails} from './format.ts';

type OpenFile = {workspace:string;tab:FileTab;current:()=>boolean};
type ShownFile = {owner:FileOwner;view:FileView};
/** An explicit, page-local disk snapshot never attaches a draft or a file watcher. */
export class ToolFileReader {
  readonly node=element('section','tool-file-reader');
  private path=element('span','tool-file-path row-title');
  private modified=element('time','secondary');
  private reloadButton=button('Reload',()=>{void this.reload();});
  private dismiss:HTMLButtonElement;
  private error=element('p','file-state');
  private body=element('div','tool-file-body');
  private opened?:OpenFile;private shown?:ShownFile;private pending?:FileOwner;private serial=0;private read:FileRead;
  constructor(read:FileRead,close:()=>void) {
    this.read=read;
    const header=element('div','tool-file-header');this.dismiss=button('Close',close);
    this.reloadButton.addEventListener('pointerdown',event=>{if(event.button===0)event.preventDefault();});
    header.append(this.path,this.modified,this.reloadButton,this.dismiss);this.error.setAttribute('role','status');this.error.hidden=true;
    this.node.append(header,this.error,this.body);
  }
  closeLabel(label:string):void {setText(this.dismiss,label);}
  open(workspace:string,destination:FileReferenceDestination,current:()=>boolean):void {
    this.close();this.opened={workspace,tab:{kind:'file',rootId:destination.rootId,path:destination.path},current};
    setText(this.path,destination.path);this.path.title=destination.path;this.modified.hidden=true;void this.reload();
  }
  private valid(opened:OpenFile,serial:number):boolean {return this.opened===opened&&this.serial===serial&&opened.current();}
  private async reload():Promise<void> {
    const opened=this.opened;if(!opened?.current())return;
    const serial=++this.serial;this.pending?.dispose();this.reloadButton.disabled=true;setText(this.error,this.shown?'':'Loading file');this.error.hidden=!!this.shown;
    const owner=new FileOwner(opened.workspace,opened.tab,this.read,()=>{});this.pending=owner;
    try {
      await owner.load();if(!this.valid(opened,serial))return;
      if(!owner.source||owner.error)throw new Error(owner.error??'The file snapshot is unavailable.');
      owner.retain();this.adopt(owner);
    } catch(error) {this.readError(opened,serial,error);}
    finally {if(this.shown?.owner!==owner)owner.dispose();if(this.opened===opened&&this.serial===serial){this.pending=undefined;this.reloadButton.disabled=false;}}
  }
  private readError(opened:OpenFile,serial:number,error:unknown):void {
    if(!this.valid(opened,serial))return;setText(this.error,error instanceof Error?error.message:'The file is unavailable.');this.error.hidden=false;
  }
  private adopt(owner:FileOwner):void {
    this.error.hidden=true;const previous=this.shown,editor=previous?.view.editor;
    const selection=editor?{start:editor.selectionStart,end:editor.selectionEnd,direction:editor.selectionDirection,focused:document.activeElement===editor}:undefined;
    const position=previous?{scrollTop:previous.view.scroller.scrollTop,scrollLeft:previous.view.scroller.scrollLeft}:undefined;
    const view=new FileView(owner,position,()=>{});view.root.hidden=false;view.root.inert=false;
    this.shown={owner,view};this.body.replaceChildren(view.root);view.paint();
    if(selection&&view.editor){view.editor.setSelectionRange(selection.start,selection.end,selection.direction);if(selection.focused)view.editor.focus({preventScroll:true});}
    previous?.view.destroy();previous?.owner.dispose();
    const at=owner.source?.revision.mtimeMs;this.modified.hidden=at===undefined||!isValidTimestamp(at);
    if(at!==undefined&&isValidTimestamp(at)){setText(this.modified,`Modified ${clockTime(at)}`);this.modified.dateTime=new Date(at).toISOString();this.modified.title=timestampDetails(at).display;}
  }
  mounted():void {this.shown?.view.restore();}
  close():void {
    this.serial++;this.pending?.dispose();this.pending=undefined;this.shown?.view.destroy();this.shown?.owner.dispose();this.shown=undefined;this.opened=undefined;this.body.replaceChildren();this.node.remove();
  }
}
