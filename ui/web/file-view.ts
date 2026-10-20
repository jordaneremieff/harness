import type {FilePosition} from '../shared/api.ts';
import {element} from './dom.ts';
import {markdownDom} from './safe-markdown.ts';
import type {FileOwner} from './file-owner.ts';
import {ComposerOverlay} from './composer-overlay.ts';
import {fileSyntaxRanges} from './file-syntax.ts';
import {markdownPath} from './file-identity.ts';
/** The native editor and its ancestors remain fixed; acknowledgments only paint status and preview. */
export class FileView {
  readonly root = element('section','file-view');readonly scroller:HTMLElement;
  readonly editor?:HTMLTextAreaElement;
  private status = element('p','file-state');private content = element('div','file-content');
  private displayed?:string;private path = '';private initialized = false;private replacement = 0;private overlay?:ComposerOverlay;
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
      this.editor = editor;this.scroller = editor;host.append(layer,editor);this.root.append(this.status,host);
      const actions = element('div','file-view-actions'), saveButton = element('button','file-save','Save');saveButton.type = 'button';saveButton.setAttribute('aria-label','Save file');
      saveButton.addEventListener('click',()=> {void owner.save().catch(()=>{});});actions.append(saveButton);this.root.append(actions);this.actions = actions;this.saveButton = saveButton;
      this.overlay = new ComposerOverlay(editor,layer,text=>fileSyntaxRanges(owner.tab.path,text));
      editor.addEventListener('input',()=> {owner.edit(editor.value);this.overlay?.invalidate();});
      editor.addEventListener('keydown',event=> {if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {event.preventDefault();if (!event.repeat && !event.isComposing) void owner.save().catch(()=>{});}});
    }
    this.scroller.setAttribute('aria-label',owner.tab.path);
    this.scroller.addEventListener('scroll',()=> {
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
      this.restoring = true;this.scroller.scrollTop = this.position.scrollTop;this.scroller.scrollLeft = this.position.scrollLeft;this.restored = true;this.overlay?.invalidate();
      requestAnimationFrame(()=> {this.restoring = false;});
    });
  }
  setPosition(position:FilePosition):void {this.position = {...position};this.restored = false;this.restore();}
  capture():FilePosition {return {...this.position};}
  focus():void {this.scroller.focus({preventScroll:true});this.overlay?.invalidate();}
  destroy():void {cancelAnimationFrame(this.frame);this.overlay?.destroy();this.root.remove();}
}
