import type { EntryView, MessageView, Target } from '../shared/api.ts';
import { element } from './dom.ts';

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
export type ReferenceResolution = {destination: ReferenceDestination} | {reason: string};
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
  private seen = new WeakSet<Node>();
  private lookup: (query: ReferenceQuery) => ReferenceResolution;
  private navigate: (destination: ReferenceDestination) => void;
  constructor(lookup: (query: ReferenceQuery) => ReferenceResolution, navigate: (destination: ReferenceDestination) => void) { this.lookup = lookup; this.navigate = navigate; }
  render(query: ReferenceQuery, active: (node: HTMLElement) => boolean): HTMLElement {
    const text = typeof query === 'string' ? query : query.text; const result = this.lookup(query);
    if ('reason' in result) { const node = element('span', 'reference-unresolved', text); node.title = result.reason; node.setAttribute('aria-description', result.reason); return node; }
    const node = element('a', 'reference-link', text);
    node.href = `#reference=${encodeURIComponent(JSON.stringify(result.destination))}`;
    node.addEventListener('click', event => {
      event.preventDefault();
      if (!node.isConnected || !active(node)) return;
      const current = this.lookup(query);
      if ('destination' in current && JSON.stringify(current.destination) === JSON.stringify(result.destination)) this.navigate(current.destination);
    });
    return node;
  }
  decorate(root: HTMLElement, active: (node: HTMLElement) => boolean, room: (parent: Node) => number = () => Infinity): void {
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
    if (this.seen.has(child)) return;
    this.seen.add(child);
    const text = child.textContent ?? ''; const matches = referenceCandidates(text); if (!matches.length) return;
    if (room < matches.length * 3 + 1) { root.setAttribute('aria-description', 'Some references remain text within the preview node limit.'); return; }
    let offset = 0;
    for (const match of matches) {
      if (match.start > offset) parent.insertBefore(document.createTextNode(text.slice(offset, match.start)), child);
      parent.insertBefore(this.render(match.text, active), child); offset = match.end;
    }
    if (offset < text.length) parent.insertBefore(document.createTextNode(text.slice(offset)), child);
    (child as ChildNode).remove();
  }
}
