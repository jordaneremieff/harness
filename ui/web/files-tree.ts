import type {FileDirectoryPage, FileEntry, FileRoot} from '../shared/files.ts';
import {cardIcon} from './card-icons.ts';
import {element} from './dom.ts';

type Directory = {entries: FileEntry[]; nextCursor: string | null; expanded: boolean; loading: boolean; error?: string; incomplete?: string};
export type FileTreeRow = {entry: FileEntry; depth: number; parent: string};
export function visibleFileRows(directories: ReadonlyMap<string, Directory>, path = '', depth = 0): FileTreeRow[] {
  const directory = directories.get(path); if (!directory?.expanded) return [];
  return directory.entries.flatMap(entry => [{entry, depth, parent: path}, ...(entry.kind === 'directory' ? visibleFileRows(directories, entry.path, depth + 1) : [])]);
}
export type FilesTreeHooks = {page(rootId: string, path: string, cursor?: string): Promise<FileDirectoryPage>; select(rootId: string, path: string): void; keep?(rootId:string,path:string):void; escape(): void};
/** Directory work starts only at root selection, refresh, or explicit disclosure. */
export class FilesTree {
  readonly node: HTMLElement;
  private root?: FileRoot;
  private directories = new Map<string, Directory>();
  private buttons = new Map<string, HTMLButtonElement>();
  private selected?: string;
  private generation = 0;
  private scope = '';
  private hooks: FilesTreeHooks;
  constructor(node: HTMLElement, hooks: FilesTreeHooks) { this.node = node; this.hooks = hooks; node.setAttribute('role', 'tree'); node.setAttribute('aria-label', 'Files'); node.addEventListener('keydown', event => this.key(event)); }
  setRoot(root?: FileRoot, scope = ''): void {
    if (root?.id === this.root?.id && scope === this.scope) return;
    this.scope = scope;this.root = root; this.generation++; this.directories.clear(); this.buttons.clear(); this.selected = undefined;
    this.paint(); if (root) void this.load('');
  }
  refresh(): void { this.generation++; this.directories.clear(); this.buttons.clear(); this.paint(); if (this.root) void this.load(''); }
  selectFile(rootId?:string,path?:string):void {
    const selected = rootId === this.root?.id ? path : undefined;
    if (selected === this.selected) return;
    this.selected = selected;this.paint();
  }
  unavailable(message:string):void {this.node.replaceChildren(element('p','file-tree-status',message));}
  private prepareDirectory(path: string): Directory | undefined {
    const previous = this.directories.get(path); if (previous?.loading) return;
    const directory: Directory = previous ?? {entries: [], nextCursor: null, expanded: true, loading: false};
    directory.expanded = true; directory.loading = true; directory.error = undefined;
    this.directories.set(path, directory); this.paint(); return directory;
  }
  private applyPage(directory: Directory, page: FileDirectoryPage, append: boolean): void {
    const entries = append ? [...directory.entries, ...page.entries] : page.entries;
    directory.entries = [...new Map(entries.map(entry => [entry.path, entry])).values()]; directory.nextCursor = page.nextCursor;
    directory.incomplete = page.coverage.complete ? undefined : page.coverage.reason ?? 'The directory scan is incomplete.';
  }
  private loadError(directory: Directory, error: unknown, generation: number): void {
    if (generation !== this.generation) return;
    directory.error = error instanceof Error ? error.message : 'Files are unavailable.';
  }
  private async load(path: string, append = false): Promise<void> {
    const root = this.root; if (!root) return;
    const directory = this.prepareDirectory(path); if (!directory) return;
    const generation = this.generation;
    try {
      const page = await this.hooks.page(root.id, path, append ? directory.nextCursor ?? undefined : undefined);
      if (generation !== this.generation || root.id !== this.root?.id) return;
      if (page.rootId !== root.id || page.path !== path) throw new Error('The folder response identity changed.');
      this.applyPage(directory, page, append);
    } catch (error) { this.loadError(directory, error, generation); }
    finally { if (generation === this.generation) {directory.loading = false; this.paint();} }
  }
  private choose(entry: FileEntry): void {
    if (entry.kind === 'directory') {
      const directory = this.directories.get(entry.path);
      if (directory) {directory.expanded = !directory.expanded;this.paint();} else void this.load(entry.path);
    } else if (entry.kind === 'file' && this.root) {this.selected = entry.path;this.paint(); this.hooks.select(this.root.id, entry.path);}
  }
  private rowButton(entry: FileEntry): HTMLButtonElement {
    const existing = this.buttons.get(entry.path); if (existing) return existing;
    const button = element('button', 'file-row'); button.type = 'button'; button.dataset.path = entry.path;
    this.buttons.set(entry.path, button); button.addEventListener('click', () => this.choose(entry));button.addEventListener('dblclick',()=> {if (entry.kind === 'file' && this.root) this.hooks.keep?.(this.root.id,entry.path);}); return button;
  }
  private paintRow({entry, depth}: FileTreeRow, tabStop?: string): HTMLButtonElement {
    const button = this.rowButton(entry);
    button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', String(depth + 1)); button.setAttribute('aria-selected', String(entry.path === this.selected));
    button.style.setProperty('--file-depth', String(depth)); button.title = entry.path; button.tabIndex = entry.path === tabStop ? 0 : -1;
    button.disabled = entry.kind === 'other' || entry.kind === 'symlink';
    const expanded = this.directories.get(entry.path)?.expanded ?? false;
    if (entry.kind === 'directory') button.setAttribute('aria-expanded', String(expanded)); else button.removeAttribute('aria-expanded');
    const disclosure = cardIcon('chevron'); disclosure.classList.add('file-disclosure'); if (entry.kind !== 'directory') disclosure.setAttribute('data-hidden', 'true'); disclosure.dataset.expanded = String(expanded);
    button.replaceChildren(disclosure, cardIcon(entry.kind === 'directory' ? 'folder' : 'file'), element('span', 'file-name', entry.name)); return button;
  }
  private directoryStatus(path: string, directory: Directory, depth: number): HTMLElement[] {
    const children: HTMLElement[] = []; if (!directory.expanded) return children;
    const line = directory.loading ? 'Loading files…' : directory.error ?? directory.incomplete;
    if (line) {const status = element('p', 'file-tree-status', line); status.style.setProperty('--file-depth', String(depth)); status.setAttribute('role', 'status'); children.push(status);}
    if (directory.error || directory.nextCursor) {const more = element('button', 'file-tree-more', directory.error ? 'Retry files' : 'More files'); more.type = 'button'; more.addEventListener('click', () => {void this.load(path, !directory.error);}); children.push(more);}
    return children;
  }
  private rootStatus(rows: FileTreeRow[]): HTMLElement[] {
    if (!this.root) return [element('p', 'file-tree-status', 'Choose a working folder.')];
    const base = this.directories.get(''); if (!base) return [];
    const children: HTMLElement[] = [];
    if (!rows.length && !base.loading && !base.error && !base.incomplete) children.push(element('p', 'file-tree-status', 'No files in this folder.'));
    return [...children, ...this.directoryStatus('', base, 0)];
  }
  private paint(): void {
    const focus = this.node.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.path : undefined;
    const rows = visibleFileRows(this.directories), enabled = rows.filter(row=>row.entry.kind === 'file' || row.entry.kind === 'directory');
    const visible = new Set(enabled.map(row=>row.entry.path));
    const tabStop = focus && visible.has(focus) ? focus : this.selected && visible.has(this.selected) ? this.selected : enabled[0]?.entry.path;
    this.node.tabIndex = enabled.length ? -1 : 0;
    const children: HTMLElement[] = rows.map(row => this.paintRow(row, tabStop)); children.push(...this.rootStatus(rows));
    for (const [path, directory] of this.directories) {
      const row = rows.find(row => row.entry.path === path);
      if (path && row) children.push(...this.directoryStatus(path, directory, row.depth + 1));
    }
    this.node.replaceChildren(...children); if (focus && tabStop) this.buttons.get(tabStop)?.focus({preventScroll: true});
  }
  private left(row: FileTreeRow, rows: FileTreeRow[]): FileTreeRow | undefined {
    const directory = this.directories.get(row.entry.path);
    if (directory?.expanded) {directory.expanded = false; this.paint(); return;}
    return rows.find(item => item.entry.path === row.parent);
  }
  private right(row: FileTreeRow, rows: FileTreeRow[], index: number): FileTreeRow | undefined {
    if (row.entry.kind !== 'directory') return;
    if (this.directories.get(row.entry.path)?.expanded) return rows[index + 1]?.parent === row.entry.path ? rows[index + 1] : undefined;
    this.choose(row.entry);
  }
  private keyDestination(key: string, row: FileTreeRow, rows: FileTreeRow[], index: number): FileTreeRow | undefined | false {
    switch (key) {
      case 'ArrowDown': return rows[Math.min(rows.length - 1, index + 1)];
      case 'ArrowUp': return rows[Math.max(0, index - 1)];
      case 'Home': return rows[0];
      case 'End': return rows.at(-1);
      case 'ArrowLeft': return this.left(row, rows);
      case 'ArrowRight': return this.right(row, rows, index);
      case 'Enter': case ' ': this.choose(row.entry); return;
      default: return false;
    }
  }
  private focusRow(row: FileTreeRow): void {
    for (const button of this.buttons.values()) button.tabIndex = -1;
    const button = this.buttons.get(row.entry.path); if (button) {button.tabIndex = 0; button.focus();}
  }
  private key(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const rows = visibleFileRows(this.directories).filter(row => row.entry.kind === 'file' || row.entry.kind === 'directory');
    const path = (event.target as HTMLElement).dataset.path; const index = rows.findIndex(row => row.entry.path === path); const row = rows[index];
    if (event.key === 'Escape') {event.preventDefault(); this.hooks.escape(); return;}
    if (!row) return;
    const next = this.keyDestination(event.key, row, rows, index); if (next === false) return;
    event.preventDefault(); if (next) this.focusRow(next);
  }
}
