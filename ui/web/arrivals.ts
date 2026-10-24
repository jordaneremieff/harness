import type { EntryView, MessageView } from '../shared/api.ts';
import { pairedTimestamp } from './state.ts';

/** The most the count shows; a larger count reads as "99+". */
export const ARRIVAL_CAP = 99;

/** A message the reader would notice: text or an image, or a typed communication. Tool calls, tool results and thinking alone are not arrivals. */
function readable(message: MessageView): boolean {
  if (message.communication) return true;
  return message.parts.some(part => (part.type === 'text' && part.text.trim() !== '') || part.type === 'image');
}
/** The control that returns to the end is an icon; its badge text is empty until messages arrive, and its accessible name always says what it does. */
export function latestLabel(count: number): {text: string; accessible: string} {
  if (count <= 0) return {text: '', accessible: 'Latest message'};
  const shown = count > ARRIVAL_CAP ? `${ARRIVAL_CAP}+` : String(count);
  return {text: shown, accessible: count > ARRIVAL_CAP ? `Latest message, more than ${ARRIVAL_CAP} new` : `Latest message, ${count} new`};
}

/**
 * Counts messages that reach the end of a conversation while the reader is away from it. A message counts once, the first time it has
 * readable content, whether it arrives whole or streams in. Older history, the operator's own input and growth of a known message never count.
 */
export class ArrivalCounter {
  count = 0;
  private readonly seen = new Set<string>();
  private readonly counted = new Set<string>();
  private readonly liveStamps = new Set<number>();
  private primed = false;
  /** Back at the end: the count restarts, and known messages stay known. */
  clear(): void { this.count = 0; }
  /** A different conversation or an emptied transcript. */
  reset(): void { this.seen.clear(); this.counted.clear(); this.liveStamps.clear(); this.primed = false; this.count = 0; }
  /** A streamed agent reply is published under a live id and saved under another; both carry the same role and timestamp, so they are one message here. */
  private identity(message: MessageView): string {
    const stamp = pairedTimestamp(message);
    if (stamp === undefined) return message.id;
    if (message.id.startsWith('live:')) this.liveStamps.add(stamp);
    return this.liveStamps.has(stamp) ? `stamp:${stamp}` : message.id;
  }
  /** Returns how many arrivals this update added. `own` skips the operator's own user messages. */
  observe(entries: readonly EntryView[], away: boolean, own: boolean): number {
    const boundary = this.primed ? entries.findIndex(entry => (entry.messages ?? []).some(message => this.seen.has(this.identity(message)))) : 0;
    let added = 0;
    entries.forEach((entry, index) => {
      if (entry.kind === 'ui.input') return;
      for (const message of entry.messages ?? []) {
        const key = this.identity(message);
        this.seen.add(key);
        if (this.counted.has(key) || !readable(message)) continue;
        this.counted.add(key);
        if (this.primed && away && boundary >= 0 && index >= boundary && !(own && message.role === 'user')) added++;
      }
    });
    this.primed = true; this.count += added;
    return added;
  }
}
