import type {FileDirectoryPage, FileEntry, FileRoot} from '../shared/files.ts';
import {cardAction, cardIcon} from './card-icons.ts';
import {element, placeRetained, setText} from './dom.ts';
import {contextMenu, nativeEditingTarget} from './context-menu.ts';
import {movedFilePath, type FileMove} from './file-identity.ts';

type Directory = {entries: FileEntry[]; nextCursor: string | null; expanded: boolean; loading: boolean; again?:boolean; error?: string; incomplete?: string};
export type FileTreeAction = 'file'|'directory'|'rename'|'move'|'trash';
type Naming = {action:Exclude<FileTreeAction,'trash'>;path:string;parent:string;depth:number;row:HTMLElement;input:HTMLInputElement;commit:HTMLButtonElement;cancel:HTMLButtonElement;busy:boolean};
function createAction(action:FileTreeAction):boolean {return action === 'file' || action === 'directory';}
function parentPath(path:string):string {return path.split('/').slice(0,-1).join('/');}
function namingLabel(action:Naming['action']):string {switch (action) {case 'move':return 'Destination path from working folder';case 'rename':return 'New name';case 'directory':return 'New folder name';case 'file':return 'New file name';}}
const quietEntryNames = new Set(['node_modules','package-lock.json','npm-shrinkwrap.json','yarn.lock','pnpm-lock.yaml']);
export type FileTreeRow = {entry: FileEntry; depth: number; parent: string};
export function visibleFileEntry(entry:FileEntry):boolean {return entry.kind !== 'file' || entry.name !== '.DS_Store';}
export function visibleFileRows(directories: ReadonlyMap<string, Directory>, path = '', depth = 0): FileTreeRow[] {
  const directory = directories.get(path); if (!directory?.expanded) return [];
  return directory.entries.flatMap(entry => !visibleFileEntry(entry) ? [] : [{entry, depth, parent: path}, ...(entry.kind === 'directory' ? visibleFileRows(directories, entry.path, depth + 1) : [])]);
}
export type FilesTreeHooks = {choose?():void;page(rootId: string, path: string, cursor?: string): Promise<FileDirectoryPage>; select(rootId: string, path: string): void; keep?(rootId:string,path:string):void; addToMessage?(rootId:string,path:string):void; escape(): void; scope?():Promise<void>|void;status?(message:string):void;operation?(rootId:string,action:FileTreeAction,path:string,value?:string):Promise<undefined|(()=>void)>};
/** Disclosed directories retain their rows while bounded disk changes refresh their pages. */
export class FilesTree {
  readonly node: HTMLElement;
  private root?: FileRoot;
  private directories = new Map<string, Directory>();
  private buttons = new Map<string, HTMLButtonElement>();
  private selected?: string;
  private generation = 0;
  private scope = '';
  private hooks: FilesTreeHooks;private naming?:Naming;private pendingFocus?:string;private dirty = new Set<string>();private frame = 0;private refreshing = 0;
  constructor(node: HTMLElement, hooks: FilesTreeHooks) { this.node = node; this.hooks = hooks; node.setAttribute('role', 'tree'); node.setAttribute('aria-label', 'Files'); node.addEventListener('keydown', event => this.key(event));node.addEventListener('contextmenu',event=> {if (nativeEditingTarget(event.target)) return;event.preventDefault();this.menu(event.target as HTMLElement,{x:event.clientX,y:event.clientY});}); }
  setRoot(root?: FileRoot, scope = ''): void {
    if (root?.id === this.root?.id && scope === this.scope) return;
    this.scope = scope;this.root = root; this.generation++; this.directories.clear(); this.buttons.clear(); this.selected = undefined;this.naming = undefined;this.pendingFocus = undefined;this.dirty.clear();cancelAnimationFrame(this.frame);this.frame = 0;this.refreshing = 0;
    this.paint(); if (root) void this.load('');
  }
  refresh(): void {this.invalidate(this.root?.id ?? '',[],true);}
  diagnostics():string {
    return [...this.directories].flatMap(([path,directory])=>[directory.loading?'Loading files':'',directory.error,directory.incomplete].filter(Boolean).map(line=>`${path||this.root?.path||'Files'}: ${line}`)).join('\n');
  }
  private chooseFolder():HTMLElement {const node=element('button','file-tree-more','Choose folder');node.type='button';node.addEventListener('click',()=>this.hooks.choose?.());return node;}
  disclosed():string[] {return [...this.directories].filter(([path,directory])=>!path || directory.expanded).map(([path])=>path);}
  rootId():string|undefined {return this.root?.id;}
  /** Loaded top-level entries; a following page is reported so a count never claims to be complete. */
  rootCount():{count:number;more:boolean}|undefined {const top=this.directories.get('');return top?{count:top.entries.length,more:top.nextCursor!==null}:undefined;}
  invalidate(rootId:string,paths:string[],rescan = false):void {
    if (rootId !== this.root?.id) return;const dirty = new Set(paths);
    for (const [path,directory] of this.directories) if ((!path || directory.expanded) && (rescan || dirty.has(path))) {if (directory.loading) directory.again = true;else this.dirty.add(path);}
    this.scheduleRefresh();
  }
  private scheduleRefresh():void {
    if (this.frame || !this.dirty.size || this.refreshing >= 2) return;
    this.frame = requestAnimationFrame(()=> {this.frame = 0;while (this.dirty.size && this.refreshing < 2) {const path = this.dirty.values().next().value as string;this.dirty.delete(path);if (path && !this.directories.get(path)?.expanded) continue;this.refreshing++;const generation = this.generation;void this.load(path).finally(()=> {if (generation === this.generation) {this.refreshing--;this.scheduleRefresh();}});}});
  }
  remap(move:FileMove):void {
    if (move.rootId !== this.root?.id) return;
    for (const [path,directory] of [...this.directories]) {const next = movedFilePath(path,move);directory.entries = directory.entries.map(entry=> {const path = movedFilePath(entry.path,move);return path === entry.path ? entry : {...entry,path,name:path.split('/').at(-1) ?? entry.name};});if (next !== path) {this.directories.delete(path);this.directories.set(next,directory);}}
    if (this.selected) this.selected = movedFilePath(this.selected,move);this.remapButtons(move);this.paint();this.hooks.scope?.();
  }
  private remapButtons(move:FileMove):void {
    const buttons = [...this.buttons];this.buttons.clear();
    for (const [path,button] of buttons) if (movedFilePath(path,move) === path) this.buttons.set(path,button);
    for (const [path,button] of buttons) {const next = movedFilePath(path,move);if (next === path) continue;button.dataset.path = next;this.buttons.set(next,button);}
  }
  reveal(rootId:string,parent:string,path?:string):void {
    if (rootId !== this.root?.id) return;
    const parts = parent.split('/').filter(Boolean);for (let index = 1;index <= parts.length;index++) {const ancestor = parts.slice(0,index).join('/');const directory = this.directories.get(ancestor);if (directory) directory.expanded = true;else void this.load(ancestor);}
    this.invalidate(rootId,[parent]);if (path) void this.load(path);
  }
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
      if (this.hooks.scope) await this.hooks.scope();if (generation !== this.generation || root.id !== this.root?.id) return;
      const page = await this.hooks.page(root.id, path, append ? directory.nextCursor ?? undefined : undefined);
      if (generation !== this.generation || root.id !== this.root?.id) return;
      if (page.rootId !== root.id || page.path !== path) throw new Error('The folder response identity changed.');
      this.applyPage(directory, page, append);
    } catch (error) { this.loadError(directory, error, generation); }
    finally {this.settleLoad(path,directory,generation);}
  }
  private settleLoad(path:string,directory:Directory,generation:number):void {if (generation !== this.generation) return;directory.loading = false;this.paint();void this.hooks.scope?.();if (directory.again) {directory.again = false;this.dirty.add(path);this.scheduleRefresh();}}

  private choose(entry: FileEntry): void {
    this.pendingFocus = undefined;
    if (entry.kind === 'directory') {
      const directory = this.directories.get(entry.path);
      if (directory) {directory.expanded = !directory.expanded;this.paint();this.hooks.scope?.();} else void this.load(entry.path);
    } else if (entry.kind === 'file' && this.root) {this.selected = entry.path;this.paint(); this.hooks.select(this.root.id, entry.path);}
  }
  private rowButton(entry: FileEntry): HTMLButtonElement {
    const existing = this.buttons.get(entry.path); if (existing) return existing;
    const button = element('button', 'file-row'); button.type = 'button'; button.dataset.path = entry.path;
    button.append(cardIcon(entry.kind === 'directory' ? 'folder' : 'file'),element('span','file-name',entry.name));
    this.buttons.set(entry.path, button); button.addEventListener('click', () => {const current = this.entry(button.dataset.path ?? '');if (current) this.choose(current);});button.addEventListener('dblclick',()=> {const current = this.entry(button.dataset.path ?? '');if (current?.kind === 'file' && this.root) this.hooks.keep?.(this.root.id,current.path);}); return button;
  }
  private paintRow({entry, depth}: FileTreeRow, tabStop?: string): HTMLButtonElement {
    const button = this.rowButton(entry);
    button.classList.toggle('file-row-quiet',entry.name.startsWith('.') || quietEntryNames.has(entry.name));
    button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', String(depth + 1)); button.setAttribute('aria-selected', String(entry.path === this.selected));
    button.style.setProperty('--file-depth', String(depth)); button.title = entry.path; button.tabIndex = entry.path === tabStop ? 0 : -1;
    button.disabled = entry.kind === 'other' || entry.kind === 'symlink';
    const expanded = this.directories.get(entry.path)?.expanded ?? false;
    if (entry.kind === 'directory') button.setAttribute('aria-expanded', String(expanded)); else button.removeAttribute('aria-expanded');
    this.paintRowIcon(button.children[0] as SVGSVGElement,entry.kind === 'directory' ? expanded ? 'folder-open' : 'folder' : 'file');setText(button.children[1] as HTMLElement,entry.name);return button;
  }
  private paintRowIcon(icon:SVGSVGElement,name:'file'|'folder'|'folder-open'):void {
    if (icon.classList.contains(`card-icon-${name}`)) return;
    const next = cardIcon(name);icon.setAttribute('class',next.getAttribute('class') ?? '');icon.querySelector('path')?.setAttribute('d',next.querySelector('path')?.getAttribute('d') ?? '');
  }
  private directoryStatus(path: string, directory: Directory): HTMLElement[] {
    const children: HTMLElement[] = []; if (!directory.expanded) return children;
    if (directory.error || directory.nextCursor) {const more = element('button', 'file-tree-more', directory.error ? 'Retry files' : 'More files'); more.type = 'button'; more.addEventListener('click', () => {void this.load(path, !directory.error);}); children.push(more);}
    return children;
  }
  private rootStatus(rows: FileTreeRow[]): HTMLElement[] {
    if (!this.root) return [this.chooseFolder()];
    const base = this.directories.get(''); if (!base) return [];
    const children: HTMLElement[] = [];
    if (!rows.length && !base.error && !base.nextCursor) children.push(this.chooseFolder());
    return [...children, ...this.directoryStatus('', base)];
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
      if (path && row) children.push(...this.directoryStatus(path, directory));
    }
    this.namingChildren(children);this.syncChildren(children);
    this.restoreFocus(focus,tabStop);
    const retained = new Set(rows.map(row=>row.entry.path));for (const path of this.buttons.keys()) if (!retained.has(path)) this.buttons.delete(path);
  }
  private restoreFocus(focus?:string,tabStop?:string):void {
    if (this.pendingFocus && !this.naming && this.node.contains(document.activeElement)) {const button = this.buttons.get(this.pendingFocus);if (button) {this.pendingFocus = undefined;button.focus({preventScroll:true});return;}}
    if (focus && tabStop && !this.naming) this.buttons.get(tabStop)?.focus({preventScroll:true});
  }
  private namingChildren(children:HTMLElement[]):void {
    const naming = this.naming;if (!naming) return;
    if (!createAction(naming.action)) {const index = children.findIndex(node=>node.dataset.path === naming.path);if (index >= 0) children.splice(index,1,naming.row);else children.push(naming.row);}
    else {const parent = children.findIndex(node=>node.dataset.path === naming.parent);children.splice(parent >= 0 ? parent + 1 : 0,0,naming.row);}
  }
  private syncChildren(children:HTMLElement[]):void {
    const desired = new Set(children);for (const child of [...this.node.children]) if (!desired.has(child as HTMLElement)) child.remove();
    let anchor:Node|null = this.node.firstChild;for (const child of children) {if (child === anchor) anchor = anchor.nextSibling;else placeRetained(child,this.node,anchor);}
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
  private entry(path:string):FileEntry|undefined {return [...this.directories.values()].flatMap(directory=>directory.entries).find(entry=>entry.path === path);}
  private menu(origin:HTMLElement,point:{x:number;y:number}):void {
    if (!this.root || !this.hooks.operation || this.naming?.busy) return;
    const root = this.root,entry = this.entry(origin.closest<HTMLElement>('[data-path]')?.dataset.path ?? '');
    if (entry && entry.kind !== 'file' && entry.kind !== 'directory') return;
    const items = [{label:'New file',run:()=>this.name('file',entry)},{label:'New folder',run:()=>this.name('directory',entry)}];
    if (entry?.kind === 'file' && this.hooks.addToMessage) items.push({label:'Add to message',run:()=>this.hooks.addToMessage?.(root.id,entry.path)});
    if (entry) items.push({label:'Rename',run:()=>this.name('rename',entry)},{label:'Move',run:()=>this.name('move',entry)},{label:'Move to Trash',run:()=>this.trash(entry)});
    contextMenu.open(origin,point,'File actions',items,()=>this.root === root && (!entry || !!this.entry(entry.path)));
  }
  private name(action:Naming['action'],entry?:FileEntry):void {
    if (!this.root || !this.hooks.operation || this.naming?.busy) return;
    this.pendingFocus = undefined;
    const path = entry?.path ?? '',parent = createAction(action) && entry?.kind === 'directory' ? path : parentPath(path);
    const depth = parent ? parent.split('/').length : 0,row = element('div','file-row file-naming'),input = element('input','file-name-input');
    row.style.setProperty('--file-depth',String(depth));row.setAttribute('role','treeitem');input.setAttribute('aria-label',namingLabel(action));input.autocomplete = 'off';input.spellcheck = false;
    input.value = action === 'move' ? path : action === 'rename' ? entry?.name ?? '' : '';
    const commit = cardAction('success','Confirm name',()=> {void this.submit(naming);});
    const cancel = cardAction('close','Cancel name',()=>this.cancelNaming(naming));
    const actions = element('span','file-name-actions');actions.append(commit,cancel);
    row.append(cardIcon(action === 'directory' || entry?.kind === 'directory' ? 'folder' : 'file'),input,actions);
    const naming:Naming = {action,path,parent,depth,row,input,commit,cancel,busy:false};this.naming = naming;
    input.addEventListener('keydown',event=>this.namingKey(event,naming));
    this.paint();input.focus();input.setSelectionRange(0,input.value.length);
    if (createAction(action) && parent && !this.directories.get(parent)?.expanded) void this.load(parent);
  }
  private cancelNaming(naming:Naming):void {
    if (this.naming !== naming || naming.busy) return;
    this.naming = undefined;this.paint();(this.buttons.get(naming.path) ?? this.node).focus({preventScroll:true});
  }
  private namingKey(event:KeyboardEvent,naming:Naming):void {
    if (event.isComposing) return;
    if (event.key === 'Escape' && !naming.busy) {event.preventDefault();event.stopPropagation();this.cancelNaming(naming);}
    else if (event.key === 'Enter') {event.preventDefault();event.stopPropagation();if (!event.repeat) void this.submit(naming);}
  }
  private namingBusy(naming:Naming,busy:boolean):void {
    if (busy && naming.row.contains(document.activeElement)) naming.input.focus({preventScroll:true});
    naming.busy = busy;naming.input.readOnly = busy;naming.commit.disabled = busy;naming.cancel.disabled = busy;
  }
  private async submit(naming:Naming):Promise<void> {
    const root = this.root;if (!root || !this.hooks.operation || naming.busy || this.naming !== naming) return;
    const value = naming.input.value;
    if (!value || (naming.action !== 'move' && /[/\\]/.test(value))) {this.hooks.status?.('Enter a file or folder name without a separator.');return;}
    const generation = this.generation;this.namingBusy(naming,true);
    try {const completed = await this.hooks.operation(root.id,naming.action,createAction(naming.action) ? naming.parent : naming.path,value);if (generation === this.generation && this.naming === naming) this.finishNaming(naming,value,completed);}
    catch(error) {if (generation === this.generation && this.naming === naming) {this.hooks.status?.(error instanceof Error ? error.message : 'The file action failed.');this.namingBusy(naming,false);naming.input.focus();}}
  }
  private finishNaming(naming:Naming,value:string,completed:undefined|(()=>void)):void {
    const focus = naming.row.contains(document.activeElement);this.naming = undefined;this.paint();if (!focus) return;
    if (naming.action === 'file') {completed?.();return;}
    this.pendingFocus = naming.action === 'move' ? value : [naming.parent,value].filter(Boolean).join('/');this.node.focus({preventScroll:true});this.restoreFocus();
  }
  private trash(entry:FileEntry):void {if (this.root && this.hooks.operation) void this.hooks.operation(this.root.id,'trash',entry.path).catch(error=>this.hooks.status?.(error instanceof Error ? error.message : 'The file action failed.'));}
  private menuKey(event:KeyboardEvent):boolean {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return false;
    event.preventDefault();const origin = event.target as HTMLElement,rect = origin.getBoundingClientRect();this.menu(origin,{x:rect.left,y:rect.bottom});return true;
  }
  private operationKey(event:KeyboardEvent):boolean {
    const origin = event.target as HTMLElement,entry = this.entry(origin.dataset.path ?? '');
    if (event.key === 'F2' && entry) {event.preventDefault();this.name('rename',entry);return true;}
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {event.preventDefault();this.name(event.shiftKey ? 'directory' : 'file',entry);return true;}
    if ((event.key === 'Delete' || event.key === 'Backspace' && event.metaKey) && entry) {event.preventDefault();this.trash(entry);return true;}
    return false;
  }
  private key(event: KeyboardEvent): void {
    if (nativeEditingTarget(event.target) || event.isComposing || this.menuKey(event) || this.operationKey(event)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const rows = visibleFileRows(this.directories).filter(row => row.entry.kind === 'file' || row.entry.kind === 'directory');
    const focusedPath = (event.target as HTMLElement).dataset.path; const index = rows.findIndex(row => row.entry.path === focusedPath); const row = rows[index];
    if (event.key === 'Escape') {event.preventDefault(); this.hooks.escape(); return;}
    if (!row) return;
    const next = this.keyDestination(event.key, row, rows, index); if (next === false) return;
    event.preventDefault(); if (next) this.focusRow(next);
  }
}
