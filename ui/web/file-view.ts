import type {FilePosition} from '../shared/api.ts';
import {element} from './dom.ts';
import {markdownDom} from './safe-markdown.ts';
import type {FileOwner} from './file-owner.ts';
/** A retained view owns only DOM and position; it never becomes the source authority. */
export class FileView {
  readonly root = element('section','file-view');
  readonly scroller = element('div','file-reading');
  private status = element('p','file-state');
  private content = element('div','file-content');
  private displayed?:FileOwner['source'];
  private restored = false;
  private frame = 0;
  private restoring = false;
  position:FilePosition;
  readonly owner:FileOwner;
  private save:(position:FilePosition)=>void;
  constructor(owner:FileOwner,position:FilePosition|undefined,save:(position:FilePosition)=>void) {
    this.owner = owner;this.save = save;
    this.position = {...position ?? {scrollTop:0,scrollLeft:0}};
    this.root.hidden = true;this.root.inert = true;
    this.scroller.tabIndex = 0;this.scroller.setAttribute('aria-label',owner.tab.path);
    this.status.setAttribute('role','status');this.scroller.append(this.status,this.content);this.root.append(this.scroller);
    this.scroller.addEventListener('scroll',()=> {
      if (!this.restored || this.restoring || this.root.hidden || this.root.inert) return;
      this.position = {scrollTop:this.scroller.scrollTop,scrollLeft:this.scroller.scrollLeft};this.save({...this.position});
    });
    this.paint();
  }
  paint():void {
    const owner = this.owner;
    this.status.textContent = owner.loading ? 'Loading file…' : owner.error ? `${owner.source ? 'Cached content. ' : ''}${owner.error}` : '';
    this.status.hidden = !this.status.textContent;
    if (owner.source && owner.source !== this.displayed) {
      const source = owner.source;
      const content = /\.(md|markdown|mdown)$/i.test(owner.tab.path) ? markdownDom(source.text) : element('pre','file-text',source.text);
      this.content.replaceChildren(content);this.displayed = source;this.restored = false;
    }
    this.restore();
  }
  restore():void {
    if (this.restored || !this.displayed || this.root.hidden || this.frame) return;
    this.frame = requestAnimationFrame(()=> {
      this.frame = 0;
      if (this.root.hidden || this.root.inert || !this.root.isConnected || !this.displayed) return;
      this.restoring = true;this.scroller.scrollTop = this.position.scrollTop;this.scroller.scrollLeft = this.position.scrollLeft;
      this.restored = true;
      requestAnimationFrame(()=> {this.restoring = false;});
    });
  }
  setPosition(position:FilePosition):void {this.position = {...position};this.restored = false;this.restore();}
  capture():FilePosition {return {...this.position};}
  focus():void {this.scroller.focus({preventScroll:true});}
  destroy():void {cancelAnimationFrame(this.frame);this.root.remove();}
}
