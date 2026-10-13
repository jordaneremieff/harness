import { element } from './dom.ts';
import { composerSyntax } from './composer-syntax.ts';
import type { TokenRange } from './highlight.ts';
const metrics = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'fontKerning', 'fontVariantLigatures', 'fontFeatureSettings', 'fontVariationSettings', 'textRendering', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textAlign', 'textTransform', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'whiteSpace', 'overflowWrap', 'wordBreak', 'direction'] as const;
/** Native text is visible until one exact decoration and its geometry are ready. */
export class ComposerOverlay {
  private editor: HTMLTextAreaElement;
  private layer: HTMLElement;
  private content: HTMLElement;
  private generation = 0;
  private frame?: number;
  private composing = false;
  private destroyed = false;
  private cleanup: (() => void)[] = [];
  private marks: {name: string; highlight: Highlight; range: Range}[] = [];
  constructor(editor: HTMLTextAreaElement, layer: HTMLElement) {
    this.editor = editor; this.layer = layer; this.content = element('div', 'composer-colors'); layer.append(this.content);
    const invalidate = () => this.invalidate();
    for (const event of ['input', 'scroll'] as const) { editor.addEventListener(event, invalidate); this.cleanup.push(() => editor.removeEventListener(event, invalidate)); }
    const start = () => {this.composing = true; this.invalidate();}; const end = () => {this.composing = false; this.invalidate();};
    editor.addEventListener('compositionstart', start); editor.addEventListener('compositionend', end);
    this.cleanup.push(() => {editor.removeEventListener('compositionstart', start); editor.removeEventListener('compositionend', end);});
    const resize = new ResizeObserver(invalidate); resize.observe(editor); this.cleanup.push(() => resize.disconnect());
    const theme = new MutationObserver(records => {if (records.some(record => !!record.attributeName && document.documentElement.getAttribute(record.attributeName) !== record.oldValue)) invalidate();});
    theme.observe(document.documentElement, {attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'data-appearance']}); this.cleanup.push(() => theme.disconnect());
    for (const query of ['(forced-colors: active)', '(prefers-color-scheme: light)']) {
      const media = matchMedia(query); media.addEventListener('change', invalidate); this.cleanup.push(() => media.removeEventListener('change', invalidate));
    }
    window.addEventListener('resize', invalidate); this.cleanup.push(() => window.removeEventListener('resize', invalidate));
    document.fonts?.addEventListener('loadingdone', invalidate); this.cleanup.push(() => document.fonts?.removeEventListener('loadingdone', invalidate));
  }
  invalidate(): void {
    if (this.destroyed) return;
    this.generation++; this.editor.removeAttribute('data-decorated'); this.layer.hidden = true; this.clearMarks();
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {this.frame = undefined; this.decorate();});
  }
  private scaledAncestor(): boolean {
    for (let node: HTMLElement | null = this.editor; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.transform && style.transform !== 'none' || style.zoom && style.zoom !== 'normal' && Number.parseFloat(style.zoom) !== 1) return true;
    }
    return false;
  }
  private unprovenMetrics(style: CSSStyleDeclaration, text: string): boolean {
    const editor = this.editor, rect = editor.getBoundingClientRect();
    if (this.scaledAncestor()) return true;
    if (editor.scrollHeight > editor.clientHeight || editor.scrollWidth > editor.clientWidth || window.devicePixelRatio !== 1 || (window.visualViewport?.scale ?? 1) !== 1 || Math.abs(rect.width - editor.offsetWidth) > 0.5) return true;
    const width = editor.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    const canvas = document.createElement('canvas').getContext('2d'); if (!canvas || width <= 0) return true;
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const spacing = Number.parseFloat(style.letterSpacing) || 0;
    return [...text.matchAll(/\S+/g)].some(match => canvas.measureText(match[0]).width + Math.max(0, match[0].length - 1) * spacing > width);
  }
  private clearMarks(): void {
    for (const mark of this.marks) {
      mark.highlight.delete(mark.range);
      if (!mark.highlight.size && CSS.highlights.get(mark.name) === mark.highlight) CSS.highlights.delete(mark.name);
    }
    this.marks = [];
  }
  private color(source: Text, ranges: TokenRange[]): void {
    for (const token of ranges) {
      const range = document.createRange(); range.setStart(source, token.start); range.setEnd(source, token.end);
      const name = `composer-${token.tone}`, highlight = CSS.highlights.get(name) ?? new Highlight();
      highlight.add(range); CSS.highlights.set(name, highlight); this.marks.push({name, highlight, range});
    }
  }
  private decorate(): void {
    if (this.destroyed || this.composing || !this.editor.isConnected || this.editor.closest('[hidden],[inert]') || matchMedia('(forced-colors: active)').matches) return;
    const generation = this.generation, text = this.editor.value, top = this.editor.scrollTop, left = this.editor.scrollLeft;
    const ranges = composerSyntax(text); if (!ranges?.length || typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    const style = getComputedStyle(this.editor);
    if (!Number.isFinite(Number.parseFloat(style.lineHeight)) || style.writingMode !== 'horizontal-tb' || style.textAlign !== 'start' && style.textAlign !== 'left') return;
    if (this.unprovenMetrics(style, text)) return;
    // One text run retains native shaping across color boundaries.
    const source = document.createTextNode(`${text}\n`);
    for (const metric of metrics) this.content.style[metric] = style[metric];
    this.layer.style.width = `${this.editor.clientWidth}px`; this.layer.style.height = `${this.editor.clientHeight}px`;
    this.content.style.width = `${this.editor.clientWidth}px`; this.content.style.transform = `translate(${-left}px, ${-top}px)`;
    if (generation !== this.generation || text !== this.editor.value || top !== this.editor.scrollTop || left !== this.editor.scrollLeft) return;
    this.content.replaceChildren(source); this.color(source, ranges); this.layer.hidden = false; this.editor.dataset.decorated = 'true';
  }
  destroy(): void {
    this.destroyed = true; if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    for (const cleanup of this.cleanup) cleanup(); this.editor.removeAttribute('data-decorated'); this.layer.hidden = true; this.clearMarks();
  }
}
