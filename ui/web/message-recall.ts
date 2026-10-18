import type { EntryView, MessageView } from '../shared/api.ts';

export const RECALL_LIMITS = {entries: 50, bytes: 64 * 1024};
const IMAGE_REFERENCE = /\n\nAttached image /;
/** Plain, complete, finished user text only: carriers, partial, shortened, redacted and image-bearing records are never recalled. */
export function recallText(message: MessageView): string | undefined {
  if (message.role !== 'user' || message.communication || message.state !== 'final' || message.error) return undefined;
  if (message.coverage.truncated || message.coverage.omitted > 0 || message.coverage.complete === false || message.attachments?.length) return undefined;
  let text = '';
  for (const part of message.parts) {
    if (part.type !== 'text' || part.redacted || part.more) return undefined;
    text += part.text;
  }
  return text.trim() && !IMAGE_REFERENCE.test(text) ? text : undefined;
}
function localEcho(entry: EntryView): boolean {
  const value = entry.data?.value;
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getOwnPropertyDescriptor(value, 'delivery')?.value === 'Sent';
}
function collect(entries: readonly EntryView[]): string[] {
  const all: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'ui.input' && !localEcho(entry)) continue;
    for (const message of entry.messages ?? []) {
      const text = recallText(message);
      if (text !== undefined && all.at(-1) !== text) all.push(text);
    }
  }
  return all;
}
/** Oldest first. Browser-owned copies count only once their delivery was accepted; the bounds keep the newest. */
export function recallItems(entries: readonly EntryView[]): string[] {
  const all = collect(entries), kept: string[] = []; let bytes = 0;
  for (let index = all.length - 1; index >= 0 && kept.length < RECALL_LIMITS.entries; index--) {
    const text = all[index] as string, cost = new TextEncoder().encode(text).length;
    if (cost > RECALL_LIMITS.bytes) continue;
    if (bytes + cost > RECALL_LIMITS.bytes) break;
    bytes += cost; kept.push(text);
  }
  return kept.reverse();
}
export type RecallSnapshot = {text: string; start: number; end: number; direction: 'forward' | 'backward' | 'none'; scrollTop: number};
export type Recall = {items: string[]; index: number; snapshot: RecallSnapshot; shown: string};
/** The first or last line of the text, where an arrow would otherwise leave it; a wrapped line counts as one line. */
export function onEdge(text: string, caret: number, edge: 'first' | 'last'): boolean {
  return edge === 'first' ? !text.slice(0, caret).includes('\n') : !text.slice(caret).includes('\n');
}
/** The position counts back from the newest message, so the first Up reads 1 of N. */
export function recallLabel(index: number, total: number): {visible: string; spoken: string} {
  const place = `Earlier message ${total - index} of ${total}`;
  return {visible: `${place} · Esc restores your draft`, spoken: `${place} from the loaded conversation. Escape restores your draft.`};
}
