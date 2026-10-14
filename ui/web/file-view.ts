import type {FilePosition} from '../shared/api.ts';
import {element} from './dom.ts';
import {markdownDom} from './safe-markdown.ts';
import type {FileOwner} from './file-owner.ts';
import {ComposerOverlay} from './composer-overlay.ts';
import {fileSyntaxRanges} from './file-syntax.ts';
/** The native editor and its ancestors remain fixed; acknowledgments only paint status and preview. */
export class FileView {
  readonly root = element('section','file-view');readonly scroller:HTMLElement;
  readonly editor?:HTMLTextAreaElement;
  private status = element('p','file-state');private content = element('div','file-content');
  private displayed?:string;private initialized = false;private replacement = 0;private overlay?:ComposerOverlay;
  private restored = false;private frame = 0;private restoring = false;private saveButton?:HTMLButtonElement;
  position:FilePosition;readonly owner:FileOwner;readonly preview:boolean;
  private save:(position:FilePosition)=>void;
  constructor(owner:FileOwner,position:FilePosition|undefined,save:(position:FilePosition)=>void,preview = false) {
    this.owner = owner;this.save = save;this.preview = preview;this.position = {...position ?? {scrollTop:0,scrollLeft:0}};
    this.root.hidden = true;this.root.inert = true;this.root.dataset.view = preview ? 'preview' : 'source';
    this.status.setAttribute('role','status');
    if (preview) {
      this.scroller = element('div','file-reading file-preview');this.scroller.tabIndex = 0;this.scroller.append(this.status,this.content);this.root.append(this.scroller);
    } else {
      const host = element('div','file-editor-host'), layer = element('div','composer-overlay file-editor-color');layer.setAttribute('aria-hidden','true');layer.hidden = true;
      const editor = element('textarea','file-editor');editor.spellcheck = false;editor.wrap = 'off';editor.setAttribute('autocapitalize','off');editor.setAttribute('autocomplete','off');
      this.editor = editor;this.scroller = editor;host.append(layer,editor);this.root.append(this.status,host);
      const actions = element('div','file-view-actions'), saveButton = element('button','file-save','Save');saveButton.type = 'button';saveButton.setAttribute('aria-label','Save file');
      saveButton.addEventListener('click',()=> {void owner.save().catch(()=>{});});actions.append(saveButton);this.root.append(actions);this.saveButton = saveButton;
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
    this.status.textContent = owner.loading ? 'Loading file…' : owner.text === undefined ? owner.error ?? '' : '';
    this.status.hidden = !this.status.textContent;
    if (this.editor && owner.text !== undefined && (!this.initialized || this.replacement !== owner.replacement)) {
      this.editor.value = owner.text;this.initialized = true;this.replacement = owner.replacement;this.restored = false;this.overlay?.invalidate();
    }
    if (this.editor) {this.editor.hidden = owner.text === undefined;this.editor.readOnly = owner.loading;}
    if (this.preview && owner.acknowledged !== undefined && this.displayed !== owner.acknowledged) {this.content.replaceChildren(markdownDom(owner.acknowledged));this.displayed = owner.acknowledged;this.restored = false;}
    if (this.saveButton) this.saveButton.disabled = owner.text === undefined || owner.loading || owner.saving || owner.encoding?.writable === false;
    this.restore();
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
