import type { FileSearchResult, FileSearchRow } from '../shared/files.ts';
import { cardIcon } from './card-icons.ts';
import { announce, element } from './dom.ts';
import { directoryOf, mentionToken, shortDirectory, type MentionToken } from './file-mention-state.ts';

export type FileMentionHooks = {
  /** Undefined when no working folder or composer can take a result; the typed text then stays plain. */
  search(query: string, signal: AbortSignal): Promise<FileSearchResult> | undefined;
  accept(token: MentionToken, row: FileSearchRow): void;
};
type View = {token?: MentionToken; rows: FileSearchRow[]; more: boolean; reason?: string; state: 'idle' | 'searching' | 'ready' | 'failed'; error?: string; active: number; suppressed?: string; open: boolean};
const SEARCH_DELAY_MS = 80;
/** Typed `@` file suggestions: one cancellable name search per query, no file bodies, nothing sent. */
export class FileMentionMenu {
  private view: View = {rows: [], more: false, state: 'idle', active: 0, open: false};
  private composing = false; private focused = false; private destroyed = false;
  private generation = 0; private timer?: ReturnType<typeof setTimeout>; private abort?: AbortController;
  private searched?: string; private painted = ''; private announced?: string;
  private cleanup: (() => void)[] = [];
  private editor: HTMLTextAreaElement; private menu: HTMLElement; private hooks: FileMentionHooks;
  constructor(editor: HTMLTextAreaElement, menu: HTMLElement, hooks: FileMentionHooks) {
    this.editor = editor; this.menu = menu; this.hooks = hooks;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'Working-folder files');
    this.listen(editor, 'focus', () => { this.focused = true; this.update(); });
    this.listen(editor, 'blur', event => { if (event.relatedTarget && menu.contains(event.relatedTarget as Node)) return; this.focused = false; this.close(); });
    this.listen(editor, 'select', () => this.update());
    this.listen(editor, 'click', () => this.update());
    this.listen(editor, 'keyup', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) this.update(); });
    this.listen(editor, 'compositionstart', () => { this.composing = true; this.update(); });
    this.listen(editor, 'compositionend', () => { this.composing = false; this.update(); });
  }
  private listen<K extends keyof HTMLElementEventMap>(node: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void): void {
    const listener = handler as EventListener; node.addEventListener(type, listener); this.cleanup.push(() => node.removeEventListener(type, listener));
  }
  destroy(): void {
    if (this.destroyed) return; this.reset(); this.destroyed = true;
    for (const cleanup of this.cleanup) cleanup(); this.cleanup = [];
  }
  /** A target, root or draft owner change drops the open list and any search still in flight. */
  reset(): void { this.generation++; this.cancel(); this.view = {rows: [], more: false, state: 'idle', active: 0, open: false}; this.searched = undefined; this.announced = undefined; this.paint(); }
  close(): void { this.cancel(); this.view = {...this.view, open: false}; this.paint(); }
  private cancel(): void { clearTimeout(this.timer); this.timer = undefined; this.abort?.abort(); this.abort = undefined; }
  update(): void {
    if (this.destroyed) return;
    const token = this.focused && !this.editor.disabled && !this.composing ? mentionToken(this.editor.value, this.editor.selectionStart, this.editor.selectionEnd) : undefined;
    if (!token) { this.cancel(); this.view = {...this.view, token: undefined, open: false, suppressed: undefined}; this.searched = undefined; this.paint(); return; }
    const suppressed = token.query === this.view.suppressed ? this.view.suppressed : undefined;
    const open = suppressed === undefined;
    if (this.view.token?.query !== token.query || this.searched === undefined) { this.view = {...this.view, token, suppressed, open, state: 'searching', active: 0}; if (open) this.schedule(token.query); else this.cancel(); }
    else this.view = {...this.view, token, suppressed, open};
    this.paint();
  }
  private schedule(query: string): void {
    this.cancel(); const generation = ++this.generation; this.searched = query;
    this.timer = setTimeout(() => { void this.run(query, generation); }, SEARCH_DELAY_MS);
  }
  private async run(query: string, generation: number): Promise<void> {
    const abort = new AbortController(); this.abort = abort; const pending = this.hooks.search(query, abort.signal);
    if (!pending) { this.view = {...this.view, open: false, state: 'idle'}; this.searched = undefined; this.paint(); return; }
    try {
      const result = await pending; if (generation !== this.generation || abort.signal.aborted) return;
      this.view = {...this.view, rows: result.rows, more: result.more, reason: result.coverage.complete ? undefined : result.coverage.reason, state: 'ready', error: undefined, active: 0};
    } catch (error) {
      if (generation !== this.generation || abort.signal.aborted) return;
      this.view = {...this.view, rows: [], more: false, state: 'failed', error: error instanceof Error ? error.message : 'Files are unavailable.'};
    }
    this.paint();
  }
  key(event: KeyboardEvent): boolean {
    if (this.destroyed || !this.view.open || event.defaultPrevented || this.composing || event.isComposing || event.keyCode === 229) return false;
    const rows = this.view.rows;
    if (event.key === 'Escape') { event.preventDefault(); this.view = {...this.view, open: false, suppressed: this.view.token?.query}; this.cancel(); this.paint(); return true; }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !rows.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); this.view = {...this.view, active: Math.max(0, Math.min(rows.length - 1, this.view.active + (event.key === 'ArrowDown' ? 1 : -1)))}; this.paint(); return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.repeat) { event.preventDefault(); this.accept(this.view.active); return true; }
    return event.key === 'Enter' || event.key === 'Tab';
  }
  private accept(index: number): void {
    const row = this.view.rows[index], token = this.view.token; if (!row || !token) return;
    this.cancel(); this.view = {...this.view, open: false}; this.paint(); this.hooks.accept(token, row);
  }
  private row(row: FileSearchRow, index: number): HTMLElement {
    const node = element('div', 'command-option mention-option'); node.id = `${this.menu.id}-option-${index}`;
    node.setAttribute('role', 'option'); node.setAttribute('aria-selected', String(index === this.view.active));
    const name = element('span', 'command-name'); const icon = cardIcon(row.kind === 'directory' ? 'folder' : 'file');
    const label = element('span'); const query = this.view.token?.query.split('/').at(-1) ?? '';
    const start = query ? row.name.toLowerCase().indexOf(query.toLowerCase()) : -1;
    if (start < 0) label.textContent = row.name;
    else label.append(element('span', undefined, row.name.slice(0, start)), element('mark', undefined, row.name.slice(start, start + query.length)), element('span', undefined, row.name.slice(start + query.length)));
    if (row.kind === 'directory') label.append(element('span', undefined, '/'));
    name.append(icon, label);
    const directory = directoryOf(row.path), where = element('span', 'command-desc mention-directory', shortDirectory(directory)); where.title = row.path; where.id = `${node.id}-directory`;
    node.title = row.path; node.setAttribute('aria-describedby', where.id);
    node.setAttribute('aria-label', `${row.kind === 'directory' ? 'Folder' : 'File'} ${row.path}`);
    node.append(name, where);
    node.addEventListener('pointerdown', event => event.preventDefault());
    node.addEventListener('click', () => this.accept(index));
    return node;
  }
  private status(): string {
    if (this.view.state === 'searching') return 'Searching…';
    if (this.view.state === 'failed') return this.view.error ?? 'Files are unavailable.';
    if (!this.view.rows.length) return this.view.reason ? `No matches in the searched part of the folder. ${this.view.reason}` : 'No matching files.';
    return this.view.reason ?? '';
  }
  private paint(): void {
    const key = JSON.stringify([this.view.open, this.view.token?.query, this.view.rows, this.view.more, this.view.reason, this.view.state, this.view.error, this.view.active]);
    if (key === this.painted) return; this.painted = key;
    this.editor.removeAttribute('aria-activedescendant'); this.menu.hidden = !this.view.open; this.menu.replaceChildren();
    if (!this.view.open) return;
    this.editor.setAttribute('aria-autocomplete', 'list'); this.editor.setAttribute('aria-controls', this.menu.id);
    const heading = element('div', 'composer-menu-heading', 'Working-folder files'); heading.setAttribute('role', 'presentation'); heading.setAttribute('aria-hidden', 'true'); this.menu.append(heading);
    this.menu.append(...this.view.rows.map((row, index) => this.row(row, index)));
    if (this.view.more) this.menu.append(element('div', 'command-hint mention-more', 'More matches. Type more of the name'));
    const status = this.status(); if (status) this.menu.append(element('div', 'command-hint', status));
    const active = this.menu.querySelectorAll<HTMLElement>('[role="option"]')[this.view.active];
    if (this.view.rows.length && active) { this.editor.setAttribute('aria-activedescendant', active.id); active.scrollIntoView?.({block: 'nearest'}); }
    if (this.view.state === 'ready' && this.view.token?.query !== this.announced) {
      this.announced = this.view.token?.query; const count = this.view.rows.length; announce(`${count} ${count === 1 ? 'file or folder' : 'files and folders'}`);
    }
  }
}
