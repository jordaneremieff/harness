import { announce, element } from './dom.ts';
import { acceptCommand, emptyMenu, menuKey, updateMenu } from './command-menu-state.ts';
import type { CommandInventory, CommandMatch, MenuState } from './command-menu-state.ts';

export class CommandMenu {
  private state: MenuState = emptyMenu();
  private composing = false;
  private focused = false;
  private announced?: string;
  private painted = '';
  private editor: HTMLTextAreaElement;
  private menu: HTMLElement;
  private inventory: () => CommandInventory;
  private change: (text: string) => void;
  constructor(editor: HTMLTextAreaElement, menu: HTMLElement, inventory: () => CommandInventory, change: (text: string) => void) {
    this.editor = editor; this.menu = menu; this.inventory = inventory; this.change = change;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'Commands');
    editor.setAttribute('aria-autocomplete', 'list'); editor.setAttribute('aria-controls', menu.id);
    editor.addEventListener('focus', () => { this.focused = true; this.update(); });
    editor.addEventListener('blur', () => { this.focused = false; this.close(); });
    editor.addEventListener('select', () => this.update());
    editor.addEventListener('selectionchange', () => this.update());
    editor.addEventListener('click', () => this.update());
    editor.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) this.update(); });
    editor.addEventListener('compositionstart', () => { this.composing = true; this.update(); });
    editor.addEventListener('compositionend', () => { this.composing = false; this.update(); });
    // The list height follows the viewport, so a resize can move the active row behind the hint footer.
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.keepActiveVisible()).observe(menu);
  }
  keepActiveVisible(): void {
    const hint = this.menu.children[this.menu.children.length - 1] as HTMLElement | undefined;
    if (this.state.open && this.state.matches.length && hint) this.showActive(hint);
  }
  update(): void {
    this.state = updateMenu(this.state, this.editor.value, this.editor.selectionStart, this.editor.selectionEnd, this.inventory(), this.composing);
    if (!this.focused || this.editor.disabled) this.state.open = false;
    this.paint();
  }
  reset(): void { this.state = emptyMenu(); this.announced = undefined; this.close(); }
  close(): void { this.state = {...this.state, open: false}; this.paint(); }
  key(event: KeyboardEvent): boolean {
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
    this.editor.value = result.text; this.editor.setSelectionRange(result.caret, result.caret); this.change(result.text);
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
  private emptyText(): string {
    return this.state.incomplete ? 'Command list is incomplete · Open Commands (⌘K) to discover more' : `No commands match /${this.state.token?.name ?? ''} · Esc to keep typing`;
  }
  private paint(): void {
    const key = JSON.stringify([this.state.open, this.state.inventory, this.state.token?.name, this.state.active, this.state.matches, this.state.incomplete]);
    if (key === this.painted) return; this.painted = key;
    this.editor.removeAttribute('aria-activedescendant'); this.menu.hidden = !this.state.open;
    this.menu.replaceChildren();
    if (!this.state.open) return;
    if (this.state.inventory === 'loading') this.menu.append(element('div', 'command-empty', 'Loading commands…'));
    else if (!this.state.matches.length) this.menu.append(element('div', 'command-empty', this.emptyText()));
    else this.menu.append(...this.state.matches.map((match, index) => this.row(match, index)));
    const hint = element('div', 'command-hint', '↑↓ to choose · Enter or Tab to insert · Esc to close');
    hint.setAttribute('aria-hidden', 'true'); this.menu.append(hint);
    if (this.state.matches.length) this.showActive(hint);
    const query = this.state.token?.name;
    if (this.state.inventory === 'ready' && query !== this.announced) {
      this.announced = query; const count = this.state.matches.length;
      announce(`${count} ${count === 1 ? 'command' : 'commands'}${query ? ` for /${query}` : ''}`);
    }
  }
}
