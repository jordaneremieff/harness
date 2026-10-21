import type { EntryView, MessageView, Target } from '../shared/api.ts';
import { element } from './dom.ts';
import type { FileRoot } from '../shared/files.ts';

export type FileReferenceDestination = {rootId: string; path: string; line?: number};
type FileReferences = {root: () => FileRoot | undefined; navigate: (destination: FileReferenceDestination) => void};
/** File syntax is lexical; the existing file reader still validates the registered root and disk identity. */
export function fileReference(text: string, root: FileRoot): FileReferenceDestination | undefined {
  const match = /^(.*?)(?::([1-9][0-9]*)(?::[1-9][0-9]*|-[1-9][0-9]*)?|#L([1-9][0-9]*)(?:-L[1-9][0-9]*)?)?$/.exec(text);
  let path = match?.[1]; if (!path || !/^[\p{L}\p{N}_./-]+$/u.test(path) || path.startsWith('//')) return;
  if ((path.startsWith('/') ? path.slice(1) : path).split('/').some(part => part === '..' || part === '')) return;
  if (path.startsWith('/')) {
    const base = root.path.replace(/\/$/, '');
    if (!path.startsWith(`${base}/`)) return;
    path = path.slice(base.length + 1);
  }
  if (path.startsWith('./')) path = path.slice(2);
  if (path.split('/').some(part => part === '.' || part === '..')) return;
  const line = match?.[2] ?? match?.[3];
  if (line && !Number.isSafeInteger(Number(line))) return;
  return {rootId: root.id, path, ...(line ? {line: Number(line)} : {})};
}
type FileCandidate = {text: string; start: number; end: number; destination: FileReferenceDestination};
function lineFileCandidates(line:string,root:FileRoot,offset:number):FileCandidate[] {
  const result:FileCandidate[] = [];
  for (const match of line.matchAll(/[^\s`<>"'()[\]{},;!?]+/g)) {
    const value = match[0].replace(/[.:]+$/, ''),destination = fileReference(value,root);
    if (destination && /\.[\p{L}][\p{L}\p{N}_-]*$/u.test(destination.path.split('/').at(-1) ?? '') && (value.includes('/') || destination.line !== undefined)) result.push({text:value,start:offset + match.index,end:offset + match.index + value.length,destination});
  }
  return result;
}
export function fileCandidates(text: string, root: FileRoot): FileCandidate[] {
  const result:FileCandidate[] = []; let fence: string | undefined; let offset = 0;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || marker[0] === fence[0] && marker.length >= fence.length)) {fence = fence ? undefined : marker; offset += line.length + 1; continue;}
    if (!fence) result.push(...lineFileCandidates(line,root,offset));
    offset += line.length + 1;
  }
  return result;
}

export type ReferenceField = 'identity' | 'recordEntryId' | 'entryId' | 'answerEntryId' | 'requestId' | 'submissionId';
export type QualifiedReference = {text: string; owner: string; field: ReferenceField};
export type ReferenceQuery = string | QualifiedReference;
export type ReferenceDestination = {target: Target; entryId?: string};
/** Local record numbers only have meaning within their public conversation owner and field. */
export function loadedReference(entries: readonly EntryView[], query: ReferenceQuery, grouped?: string, owner?: string): string | undefined {
  const matches = new Set<string>();
  if (typeof query === 'string' && !referenceCandidates(query).some(value => value.text === query)) return undefined;
  if (typeof query === 'string' && grouped) matches.add(grouped);
  for (const entry of entries) if (entryReference(entry, query, owner)) matches.add(entry.id);
  return matches.size === 1 ? matches.values().next().value : undefined;
}
function entryReference(entry: EntryView, query: ReferenceQuery, owner?: string): boolean {
  if (typeof query === 'string') return entry.id === query;
  if (query.owner === owner && ['entryId', 'answerEntryId'].includes(query.field) && entry.id === query.text) return true;
  return (entry.messages ?? []).some(message => receivingReference(message, query));
}
function receivingReference(message: MessageView, query: QualifiedReference): boolean {
  const carrier = message.communication; if (carrier?.state !== 'ready' || carrier.origin.kind !== 'native') return false;
  const {target, recordEntryId} = carrier.origin;
  const owner = target.conversationId === 1 ? target.storageId : `${target.storageId}:${target.conversationId}`;
  if (owner !== query.owner) return false;
  const facts = {identity: owner, recordEntryId, entryId: target.entryId, requestId: target.requestId, submissionId: target.mode === 'input' ? String(target.submissionId) : undefined, answerEntryId: undefined};
  return facts[query.field] === query.text;
}
export type ReferenceResolution = {destination: ReferenceDestination; caption?: string} | {reason: string};
// Syntax is only a candidate. The owner lookup, not this expression, supplies identity and destination.
const candidate = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[1-9][0-9]*|\/[0-9a-f]+)?/g;
export function referenceCandidates(text: string): Array<{text: string; start: number; end: number}> {
  const result: Array<{text: string; start: number; end: number}> = [];
  for (const match of text.matchAll(candidate)) {
    const start = match.index; const end = start + match[0].length;
    if (/[a-zA-Z0-9_:/-]/.test(text[start - 1] ?? '') || /[a-zA-Z0-9_:/-]/.test(text[end] ?? '')) continue;
    result.push({text: match[0], start, end});
  }
  return result;
}
/** One renderer and click path for all transcript text surfaces. Copy continues to use original sources. */
export class ReferenceResolver {
  private seen = new WeakMap<Node, string>();
  private prose = new WeakMap<HTMLElement, string>();
  private files?: FileReferences;
  private lookup: (query: ReferenceQuery) => ReferenceResolution;
  private navigate: (destination: ReferenceDestination) => void;
  constructor(lookup: (query: ReferenceQuery) => ReferenceResolution, navigate: (destination: ReferenceDestination) => void, files?: FileReferences) { this.lookup = lookup; this.navigate = navigate; this.files = files; }
  renderFile(text: string, active: (node: HTMLElement) => boolean, line?: number): HTMLElement | undefined {
    const root = this.files?.root(); const destination = root && fileReference(text, root); if (!destination) return;
    if (line !== undefined) destination.line = line;
    const node = element('a', 'reference-link file-reference', text);
    node.dataset.fileRoot = JSON.stringify([root.id,root.path]);
    node.href = `#file=${encodeURIComponent(JSON.stringify(destination))}`;
    node.addEventListener('click', event => {
      event.preventDefault(); if (!node.isConnected || !active(node)) return;
      const current = this.files?.root(); const resolved = current && fileReference(text, current);
      if (resolved && resolved.rootId === destination.rootId && resolved.path === destination.path) this.files?.navigate(destination);
    });
    return node;
  }
  render(query: ReferenceQuery, active: (node: HTMLElement) => boolean, prose = false): HTMLElement {
    const text = typeof query === 'string' ? query : query.text; const result = this.lookup(query);
    if ('reason' in result) { const node = element('span', 'reference-unresolved', text); node.title = result.reason; node.setAttribute('aria-description', result.reason); return node; }
    const node = element('a', 'reference-link', text);
    if (prose && typeof query === 'string' && !result.destination.entryId) {
      this.prose.set(node, text); node.textContent = result.caption ?? text; node.title = text;
    }
    node.href = `#reference=${encodeURIComponent(JSON.stringify(result.destination))}`;
    node.addEventListener('click', event => {
      event.preventDefault();
      if (!node.isConnected || !active(node)) return;
      const current = this.lookup(query);
      if ('destination' in current && JSON.stringify(current.destination) === JSON.stringify(result.destination)) this.navigate(current.destination);
    });
    return node;
  }
  private refreshCaptions(root: HTMLElement, protectedNode: (node: HTMLElement) => boolean): void {
    for (const link of root.querySelectorAll<HTMLElement>('a.reference-link')) {
      const text = this.prose.get(link); if (!text || protectedNode(link)) continue;
      const result = this.lookup(text);
      const caption = 'destination' in result && !result.destination.entryId ? result.caption ?? text : text;
      if (link.textContent !== caption) link.textContent = caption;
    }
  }
  decorate(root: HTMLElement, active: (node: HTMLElement) => boolean, room: (parent: Node) => number = () => Infinity, protectedNode: (node: HTMLElement) => boolean = () => false): void {
    this.refreshCaptions(root, protectedNode);
    const fileRoot = this.files?.root(), key = fileRoot ? JSON.stringify([fileRoot.id,fileRoot.path]) : '';
    for (const link of root.querySelectorAll<HTMLElement>('.file-reference')) if (link.dataset.fileRoot !== key) {
      link.parentNode?.insertBefore(document.createTextNode(link.textContent ?? ''),link);link.remove();
    }
    const pending: Node[] = [root];
    while (pending.length) {
      const parent = pending.pop(); if (!parent || this.ignored(parent)) continue;
      for (const child of [...parent.childNodes]) {
        if (child.nodeType === 3) this.decorateText(root, parent, child, active, room(parent));
        else pending.push(child);
      }
    }
  }
  private ignored(parent: Node): boolean {
    if (parent.nodeType !== 1) return false;
    const node = parent as HTMLElement;
    return ['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SCRIPT', 'STYLE'].includes(node.tagName.toUpperCase()) || node.classList.contains('reference-unresolved');
  }
  private decorateText(root: HTMLElement, parent: Node, child: Node, active: (node: HTMLElement) => boolean, room: number): void {
    const node = parent as HTMLElement;
    const fileRoot = !node.closest?.('pre, summary, .tool-shell, .message-source') && node.closest?.('.message-text') ? this.files?.root() : undefined;
    const key = fileRoot ? JSON.stringify([fileRoot.id, fileRoot.path]) : '';
    if (this.seen.get(child) === key) return;
    this.seen.set(child, key);
    const text = child.textContent ?? '';
    const identities = referenceCandidates(text);
    const files = fileRoot ? fileCandidates(text, fileRoot).filter(file => !identities.some(identity => file.start < identity.end && file.end > identity.start)) : [];
    const matches = [...identities.map(value => ({...value, file: false})), ...files.map(value => ({...value, file: true}))].sort((a,b) => a.start - b.start);
    if (!matches.length) return;
    if (room < matches.length * 3 + 1) { root.setAttribute('aria-description', 'Some references remain text within the preview node limit.'); return; }
    const prose = !node.closest?.('pre, code, .message-source, summary');
    let offset = 0;
    for (const match of matches) {
      if (match.start > offset) parent.insertBefore(document.createTextNode(text.slice(offset, match.start)), child);
      parent.insertBefore(match.file ? this.renderFile(match.text, active) ?? document.createTextNode(match.text) : this.render(match.text, active, prose), child); offset = match.end;
    }
    if (offset < text.length) parent.insertBefore(document.createTextNode(text.slice(offset)), child);
    (child as ChildNode).remove();
  }
}
