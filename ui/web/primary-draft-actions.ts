import {button, element} from './dom.ts';

export type PrimaryDraftSource = {caption: () => string; href?: () => string|undefined; current: () => boolean};
export type PrimaryDraftActions = {reason: () => string; append: (source: PrimaryDraftSource, selection?: string) => void};
export type TranscriptDraftActions = PrimaryDraftActions & {caption: () => string; reference?: (entryId: string) => string|undefined; current: () => boolean};

export function primaryDraftText(source: PrimaryDraftSource, selection?: string): string {
  const caption = source.caption().replace(/[\r\n]/g, ' ').replace(/[\\`*_~{}[\]()<>#!|]/g, '\\$&'), href = source.href?.();
  const label = href ? `[${caption}](${href.replaceAll('(', '%28').replaceAll(')', '%29')})` : caption;
  const line = `— ${label}`;
  return selection === undefined ? line : `> ${selection.replace(/(\r\n|\r|\n)/g, '$1> ')}\n\n${line}`;
}
export function selectionWithin(selection: Selection, node: HTMLElement): boolean {
  return !!selection.anchorNode && !!selection.focusNode && node.contains(selection.anchorNode) && node.contains(selection.focusNode);
}
/** The bar owns no transcript nodes or draft copy; its action reads the live selection at commit. */
export class PrimaryDraftSelection {
  private node = element('div', 'primary-draft-selection');
  private add: HTMLButtonElement;
  private source?: PrimaryDraftSource;
  private frame = 0;
  private locate: (selection: Selection) => PrimaryDraftSource|undefined;
  private actions: PrimaryDraftActions;
  constructor(locate: (selection: Selection) => PrimaryDraftSource|undefined, actions: PrimaryDraftActions) {
    this.locate = locate; this.actions = actions;
    this.add = button('Add to Primary', () => this.commit());
    this.add.addEventListener('pointerdown', event => event.preventDefault());
    this.node.setAttribute('role', 'toolbar'); this.node.setAttribute('aria-label', 'Selection actions'); this.node.hidden = true;
    this.node.append(this.add); document.body.append(this.node);
    document.addEventListener('selectionchange', () => this.refresh());
    document.addEventListener('scroll', () => {if (this.source) this.position();}, {capture: true, passive: true});
    window.addEventListener('resize', () => this.position(), {passive: true});
  }
  refresh(): void {
    const selection = document.getSelection();
    this.source = selection && !selection.isCollapsed && selection.toString() ? this.locate(selection) : undefined;
    if (!this.source?.current()) {this.node.hidden = true; return;}
    const reason = this.actions.reason(); this.add.disabled = !!reason; this.add.title = reason || 'Add to Primary';
    this.node.hidden = false; this.position();
  }
  private position(): void {
    if (this.frame || !this.source) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const selection = document.getSelection();
      if (!this.source?.current() || !selection?.rangeCount || selection.isCollapsed) {this.node.hidden = true; return;}
      const rect = selection.getRangeAt(selection.rangeCount - 1).getBoundingClientRect();
      if (!rect.width && !rect.height || rect.bottom < 0 || rect.top > window.innerHeight) {this.node.hidden = true; return;}
      this.node.hidden = false;
      const box = this.node.getBoundingClientRect();
      this.node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`;
      this.node.style.top = `${Math.max(8, Math.min(rect.top - box.height - 6, window.innerHeight - box.height - 8))}px`;
    });
  }
  private commit(): void {
    const selection = document.getSelection(), source = this.source;
    if (!selection || selection.isCollapsed || !source?.current()) {this.refresh(); return;}
    const current = this.locate(selection); if (!current?.current()) {this.refresh(); return;}
    this.actions.append(current, selection.toString());
  }
}
