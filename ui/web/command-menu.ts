import { announce, button, element } from './dom.ts';
import { insertNativeText } from './native-insertion.ts';
import { acceptCommand, emptyMenu, menuKey, updateMenu } from './command-menu-state.ts';
import type { CommandInventory, CommandMatch, MenuState } from './command-menu-state.ts';

export class CommandMenu {
  private state: MenuState = emptyMenu();
  private composing = false;
  private focused = false;
  private announced?: string;
  private painted = '';
  private more?: () => Promise<void>;
  private continuing = false;
  private continuationError?: string;
  private generation = 0;
  private editor: HTMLTextAreaElement;
  private menu: HTMLElement;
  private inventory: () => CommandInventory;
  private change: (text: string, error?: string, prepared?: string) => void;
  private cleanup: (() => void)[] = [];
  private observer?: ResizeObserver;
  private destroyed = false;
  constructor(editor: HTMLTextAreaElement, menu: HTMLElement, inventory: () => CommandInventory, change: (text: string, error?: string, prepared?: string) => void, more?: () => Promise<void>) {
    this.editor = editor; this.menu = menu; this.inventory = inventory; this.change = change; this.more = more;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'Commands');
    editor.setAttribute('aria-autocomplete', 'list'); editor.setAttribute('aria-controls', menu.id);
    this.listen(editor, 'focus', () => { this.focused = true; this.update(); });
    this.listen(editor, 'blur', event => { if (event.relatedTarget && menu.contains(event.relatedTarget as Node)) return; this.focused = false; this.close(); });
    this.listen(menu, 'focusout', event => { if (event.relatedTarget === editor || (event.relatedTarget && menu.contains(event.relatedTarget as Node))) return; this.focused = false; this.close(); });
    this.listen(editor, 'select', () => this.update());
    this.listen(editor, 'selectionchange', () => this.update());
    this.listen(editor, 'click', () => this.update());
    this.listen(editor, 'keyup', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) this.update(); });
    this.listen(editor, 'compositionstart', () => { this.composing = true; this.update(); });
    this.listen(editor, 'compositionend', () => { this.composing = false; this.update(); });
    // The list height follows the viewport, so a resize can move the active row behind the hint footer.
    if (typeof ResizeObserver === 'function') {this.observer = new ResizeObserver(() => this.keepActiveVisible()); this.observer.observe(menu);}
  }
  private listen<K extends keyof HTMLElementEventMap>(node: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void): void {
    const listener = handler as EventListener; node.addEventListener(type, listener); this.cleanup.push(() => node.removeEventListener(type, listener));
  }
  destroy(): void {
    if (this.destroyed) return; this.reset(); this.destroyed = true;
    for (const cleanup of this.cleanup) cleanup(); this.cleanup = []; this.observer?.disconnect(); this.observer = undefined;
    this.editor.removeAttribute('aria-autocomplete'); this.editor.removeAttribute('aria-controls');
  }
  keepActiveVisible(): void {
    const hint = this.menu.children[this.menu.children.length - 1] as HTMLElement | undefined;
    if (this.state.open && this.state.matches.length && hint) this.showActive(hint);
  }
  update(): void {
    if (this.destroyed) return;
    this.state = updateMenu(this.state, this.editor.value, this.editor.selectionStart, this.editor.selectionEnd, this.inventory(), this.composing);
    if (!this.focused || this.editor.disabled) this.state.open = false;
    this.paint();
  }
  reset(): void { this.generation++; this.continuing = false; this.continuationError = undefined; this.state = emptyMenu(); this.announced = undefined; this.close(); }
  close(): void { this.state = {...this.state, open: false}; this.paint(); }
  key(event: KeyboardEvent): boolean {
    if (this.destroyed) return false;
    if (event.defaultPrevented || this.composing || event.isComposing || event.keyCode === 229) return this.composing || event.isComposing || event.keyCode === 229;
    const result = menuKey(this.state, event); this.state = result.state;
    if (result.action === 'accept') { event.preventDefault(); this.accept(this.state.active); return true; }
    if (result.action === 'handled') { event.preventDefault(); this.paint(); return true; }
    if (event.key === 'Enter' && event.shiftKey) this.paint();
    return false;
  }
  private accept(index: number): void {
    const token = this.state.token; const match = this.state.matches[index]; if (!token || !match) return;
    const result = acceptCommand(this.editor.value, token, match.item.name);
    this.state = {...this.state, open: false}; this.paint();
    const end = token.end + (this.editor.value[token.end] === ' ' ? 1 : 0);
    const inserted = insertNativeText(this.editor, result.text.slice(0, result.caret), 0, end);
    this.change(inserted.text, inserted.status === 'inserted' ? undefined : inserted.status === 'refused' ? 'Text insertion was refused. Copy the prepared text.' : 'Text insertion changed unexpectedly. Your native edit is unchanged.', inserted.status === 'refused' ? inserted.prepared : undefined);
  }
  private row(match: CommandMatch, index: number): HTMLElement {
    const node = element('div', 'command-option'); node.id = `${this.menu.id}-option-${encodeURIComponent(match.item.name)}`;
    node.setAttribute('role', 'option'); node.setAttribute('aria-selected', String(index === this.state.active));
    const name = element('span', 'command-name'); name.append(element('span', undefined, '/'));
    const marks = new Set(match.marks);
    for (let offset = 0; offset < match.item.name.length; offset++) name.append(element(marks.has(offset) ? 'mark' : 'span', undefined, match.item.name[offset]));
    const desc = element('span', 'command-desc', match.item.description); desc.id = `${node.id}-desc`;
    const source = element('span', 'command-source', match.item.source); source.id = `${node.id}-source`;
    node.setAttribute('aria-label', `/${match.item.name}`); node.setAttribute('aria-describedby', `${desc.id} ${source.id}`);
    node.append(name, desc, source);
    node.addEventListener('pointerdown', event => event.preventDefault());
    node.addEventListener('click', () => this.accept(index));
    return node;
  }
  private showActive(hint: HTMLElement): void {
    const active = this.menu.children[this.state.active] as HTMLElement;
    this.editor.setAttribute('aria-activedescendant', active.id);
    const top = active.offsetTop; const bottom = top + active.offsetHeight;
    const visibleHeight = Math.max(active.offsetHeight, this.menu.clientHeight - hint.offsetHeight);
    if (top < this.menu.scrollTop) this.menu.scrollTop = top;
    else if (bottom > this.menu.scrollTop + visibleHeight) this.menu.scrollTop = bottom - visibleHeight;
    // Rendered geometry includes list padding that offsets omit, so finish against the sticky hint itself.
    const overlap = active.getBoundingClientRect().bottom - hint.getBoundingClientRect().top;
    if (overlap > 0 && active.offsetHeight < visibleHeight + overlap) this.menu.scrollTop += overlap;
  }
  private async continue(): Promise<void> {
    if (!this.more || this.continuing || !this.state.open || !this.state.incomplete || this.editor.disabled) return;
    const generation = this.generation; this.continuing = true; this.continuationError = undefined;
    this.editor.focus({preventScroll: true}); this.paint();
    try { await this.more(); }
    catch (error) { if (generation === this.generation) this.continuationError = error instanceof Error ? error.message : String(error); }
    finally { if (generation === this.generation) { this.continuing = false; this.update(); } }
  }
  private emptyText(): string {
    return this.state.incomplete ? 'The command list is incomplete.' : `No commands match /${this.state.token?.name ?? ''}`;
  }
  private hint(count: number): HTMLElement {
    const hint = element('div', 'command-hint', `${count} ${count === 1 ? 'command' : 'commands'}`);
    if (!this.state.incomplete || !this.more) { hint.setAttribute('aria-hidden', 'true'); return hint; }
    if (count) hint.append(element('span', undefined, ' · The command list is incomplete.'));
    if (this.continuationError) hint.append(element('span', 'command-error', `Could not load more commands. ${this.continuationError}`));
    const label = this.continuing ? 'Loading commands…' : this.continuationError ? 'Try again' : 'More commands';
    const action = button(label, () => { void this.continue(); }); action.disabled = this.continuing;
    action.addEventListener('pointerdown', event => event.preventDefault()); hint.append(action); return hint;
  }
  private paint(): void {
    const key = JSON.stringify([this.state.open, this.state.inventory, this.state.token?.name, this.state.active, this.state.matches, this.state.incomplete, this.continuing, this.continuationError]);
    if (key === this.painted) return; this.painted = key;
    this.editor.removeAttribute('aria-activedescendant'); this.menu.hidden = !this.state.open;
    this.menu.replaceChildren();
    if (!this.state.open) return;
    if (this.state.inventory === 'loading') this.menu.append(element('div', 'command-empty', 'Loading commands…'));
    else if (!this.state.matches.length) this.menu.append(element('div', 'command-empty', this.emptyText()));
    else this.menu.append(...this.state.matches.map((match, index) => this.row(match, index)));
    const count = this.state.matches.length;
    const hint = this.hint(count); this.menu.append(hint);
    if (this.state.matches.length) this.showActive(hint);
    const query = this.state.token?.name;
    if (this.state.inventory === 'ready' && query !== this.announced) {
      this.announced = query;
      announce(`${count} ${count === 1 ? 'command' : 'commands'}${query ? ` for /${query}` : ''}`);
    }
  }
}
