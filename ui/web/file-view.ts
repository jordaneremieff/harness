import type {FilePosition} from '../shared/api.ts';
import {element} from './dom.ts';
import {markdownDom} from './safe-markdown.ts';
import type {FileOwner} from './file-owner.ts';
import {ComposerOverlay} from './composer-overlay.ts';
import {fileSyntaxRanges} from './file-syntax.ts';
import {markdownPath} from './file-identity.ts';
/** The requested line clamps to the final native source line; a range never selects text. */
export function fileLineTarget(text:string,wanted:number):{line:number;start:number} {
  let line = 1,start = 0;
  for (let index = 0;index < text.length && line < wanted;index++) if (text[index] === '\n') {line++;start = index + 1;}
  return {line,start};
}
/** The native editor and its ancestors remain fixed; acknowledgments only paint status and preview. */
export class FileView {
  readonly root = element('section','file-view');readonly scroller:HTMLElement;
  readonly editor?:HTMLTextAreaElement;
  private status = element('p','file-state');private content = element('div','file-content');
  private displayed?:string;private path = '';private initialized = false;private replacement = 0;private overlay?:ComposerOverlay;
  private targetLine?:number;private lineBand?:HTMLElement;private lineTimer?:ReturnType<typeof setTimeout>;private markedPosition?:FilePosition;
  private restored = false;private frame = 0;private restoring = false;private saveButton?:HTMLButtonElement;private actions?:HTMLElement;private switchButton?:HTMLButtonElement;private switchView?:()=>void;
  position:FilePosition;readonly owner:FileOwner;readonly preview:boolean;
  private save:(position:FilePosition)=>void;
  constructor(owner:FileOwner,position:FilePosition|undefined,save:(position:FilePosition)=>void,preview = false,switchView?:()=>void) {
    this.owner = owner;this.save = save;this.preview = preview;this.switchView = switchView;this.position = {...position ?? {scrollTop:0,scrollLeft:0}};
    this.root.hidden = true;this.root.inert = true;this.root.dataset.view = preview ? 'preview' : 'source';
    this.status.setAttribute('role','status');
    if (preview) {
      this.scroller = element('div','file-reading file-preview');this.scroller.tabIndex = 0;this.scroller.append(this.status,this.content);this.actions = element('div','file-view-actions');this.root.append(this.scroller,this.actions);
    } else {
      const host = element('div','file-editor-host'), layer = element('div','composer-overlay file-editor-color');layer.setAttribute('aria-hidden','true');layer.hidden = true;
      const editor = element('textarea','file-editor');editor.spellcheck = false;editor.wrap = 'off';editor.setAttribute('autocapitalize','off');editor.setAttribute('autocomplete','off');
      this.editor = editor;this.scroller = editor;this.lineBand = element('div','file-line-band');this.lineBand.hidden = true;this.lineBand.setAttribute('aria-hidden','true');host.append(this.lineBand,layer,editor);this.root.append(this.status,host);
      const actions = element('div','file-view-actions'), saveButton = element('button','file-save','Save');saveButton.type = 'button';saveButton.setAttribute('aria-label','Save file');
      saveButton.addEventListener('click',()=> {void owner.save().catch(()=>{});});actions.append(saveButton);this.root.append(actions);this.actions = actions;this.saveButton = saveButton;
      this.overlay = new ComposerOverlay(editor,layer,text=>fileSyntaxRanges(owner.tab.path,text));
      editor.addEventListener('input',()=> {this.clearLineMark();owner.edit(editor.value);this.overlay?.invalidate();});
      editor.addEventListener('keydown',event=> {if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {event.preventDefault();if (!event.repeat && !event.isComposing) void owner.save().catch(()=>{});}});
    }
    this.scroller.setAttribute('aria-label',owner.tab.path);
    this.scroller.addEventListener('scroll',()=> {
      if (this.markedPosition && (this.scroller.scrollTop !== this.markedPosition.scrollTop || this.scroller.scrollLeft !== this.markedPosition.scrollLeft)) this.clearLineMark();
      if (!this.restored || this.restoring || this.root.hidden || this.root.inert) return;
      this.position = {scrollTop:this.scroller.scrollTop,scrollLeft:this.scroller.scrollLeft};this.save({...this.position});
    });this.paint();
  }
  paint():void {
    const owner = this.owner;
    if (this.path !== owner.tab.path) {this.path = owner.tab.path;this.scroller.setAttribute('aria-label',this.path);this.overlay?.invalidate();}
    this.status.textContent = owner.loading ? 'Loading file…' : owner.text === undefined ? owner.error ?? '' : '';
    this.status.hidden = !this.status.textContent;
    this.syncSwitch();this.syncSource();
    if (this.editor) {this.editor.hidden = owner.text === undefined;this.editor.readOnly = owner.loading || owner.moving || owner.retained;}
    if (this.preview && owner.acknowledged !== undefined && this.displayed !== owner.acknowledged) {this.content.replaceChildren(markdownDom(owner.acknowledged));this.displayed = owner.acknowledged;this.restored = false;}
    if (this.saveButton) this.saveButton.disabled = owner.text === undefined || owner.loading || owner.moving || owner.retained || owner.saving || owner.encoding?.writable === false;
    this.restore();
  }
  private syncSwitch():void {
    const wanted = !!this.switchView && markdownPath(this.owner.tab.path);
    if (!wanted) {this.switchButton?.remove();this.switchButton = undefined;if (this.preview && this.actions) this.actions.hidden = true;return;}
    if (this.preview && this.actions) this.actions.hidden = false;
    if (!this.switchButton && this.actions) {
      const button = element('button','file-view-switch');button.type = 'button';button.textContent = this.preview ? 'Source' : 'Preview';
      button.setAttribute('aria-label',this.preview ? 'Show file source' : 'Show Markdown preview');
      button.addEventListener('click',()=> {this.switchView?.();});this.actions.prepend(button);this.switchButton = button;
    }
  }
  private syncSource():void {
    const editor = this.editor,text = this.owner.text;if (!editor || text === undefined || this.initialized && this.replacement === this.owner.replacement) return;
    const start = editor.selectionStart,end = editor.selectionEnd,direction = editor.selectionDirection;
    if (this.initialized) this.position = {scrollTop:editor.scrollTop,scrollLeft:editor.scrollLeft};
    editor.value = text;if (this.initialized) editor.setSelectionRange(Math.min(start,text.length),Math.min(end,text.length),direction);
    this.initialized = true;this.replacement = this.owner.replacement;this.restored = false;this.overlay?.invalidate();
  }
  restore():void {
    if (this.restored || (!this.initialized && this.displayed === undefined) || this.root.hidden || this.frame) return;
    this.frame = requestAnimationFrame(()=> {
      this.frame = 0;if (this.root.hidden || this.root.inert || !this.root.isConnected) return;
      this.restoring = true;
      if (this.targetLine !== undefined && this.editor) {const line = this.targetLine;this.targetLine = undefined;this.placeLine(line);}
      else {this.scroller.scrollTop = this.position.scrollTop;this.scroller.scrollLeft = this.position.scrollLeft;}
      this.restored = true;this.overlay?.invalidate();
      requestAnimationFrame(()=> {this.restoring = false;});
    });
  }
  revealLine(line:number):void {this.targetLine = line;this.restored = false;this.restore();}
  private placeLine(wanted:number):void {
    const editor = this.editor,band = this.lineBand;if (!editor || !band) return;
    this.clearLineMark();const target = fileLineTarget(editor.value,wanted),style = getComputedStyle(editor);
    const height = Number.parseFloat(style.lineHeight),padding = Number.parseFloat(style.paddingTop) || 0;
    editor.focus({preventScroll:true});editor.setSelectionRange(target.start,target.start);
    if (!Number.isFinite(height) || height <= 0) return;
    const top = padding + (target.line - 1) * height;
    editor.scrollTop = Math.max(0,top - Math.max(height * 5,editor.clientHeight / 3));editor.scrollLeft = 0;
    this.position = {scrollTop:editor.scrollTop,scrollLeft:editor.scrollLeft};this.save({...this.position});
    band.style.top = `${top - editor.scrollTop}px`;band.style.height = `${height}px`;band.hidden = false;
    this.markedPosition = {...this.position};this.lineTimer = setTimeout(()=>this.clearLineMark(),3000);
  }
  private clearLineMark():void {clearTimeout(this.lineTimer);this.lineTimer = undefined;this.markedPosition = undefined;if (this.lineBand) this.lineBand.hidden = true;}
  setPosition(position:FilePosition):void {this.position = {...position};this.restored = false;this.restore();}
  capture():FilePosition {return {...this.position};}
  focus():void {this.scroller.focus({preventScroll:true});this.overlay?.invalidate();}
  destroy():void {this.clearLineMark();cancelAnimationFrame(this.frame);this.overlay?.destroy();this.root.remove();}
}
