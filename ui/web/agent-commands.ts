import type { AgentCommandList } from '../shared/api.ts';
import type { CommandInventory } from './command-menu-state.ts';

/** What decides whether one agent's host can list commands now. A new connection epoch is a new host connection. */
export type CommandSource = {live: boolean; supported: boolean; epoch: number};
type Entry = {epoch: number; state: 'loading' | 'ready' | 'failed'; list?: AgentCommandList; message?: string; failedAt?: number};
function refuse(source: CommandSource): CommandInventory | undefined {
  if (!source.live) return {items: [], state: 'unavailable', message: 'Start the agent to run commands.'};
  return source.supported ? undefined : {items: [], state: 'unavailable', message: 'This agent host does not offer commands.'};
}
/** A failed read is tried again by the next deliberate slash, but not on every keystroke. */
export const COMMAND_RETRY_MS = 5000;

/** The command inventory of one agent conversation, read from its live host on the first deliberate slash and kept for that connection epoch. */
export class AgentCommandInventory {
  private entry?: Entry;
  private readonly load: (signal: AbortSignal) => Promise<AgentCommandList>;
  private readonly changed: () => void;
  private readonly now: () => number;
  private abort?: AbortController;
  constructor(load: (signal: AbortSignal) => Promise<AgentCommandList>, changed: () => void, now: () => number = Date.now) {
    this.load = load; this.changed = changed; this.now = now;
  }
  /** `deliberate` is true only while the draft starts with a slash. Other reads never start a request. */
  inventory(source: CommandSource, deliberate: boolean): CommandInventory {
    const refusal = refuse(source);
    if (refusal) { this.forget(); return refusal; }
    if (this.entry && this.entry.epoch !== source.epoch) this.forget();
    const entry = this.entry;
    if (!entry) { if (deliberate) this.start(source.epoch); return {items: [], state: 'loading'}; }
    if (entry.state === 'ready' && entry.list) return {items: entry.list.items.map(item => ({...item})), state: 'ready', ...(entry.list.incomplete ? {incomplete: true} : {})};
    if (entry.state === 'loading') return {items: [], state: 'loading'};
    if (deliberate && this.now() - (entry.failedAt ?? 0) >= COMMAND_RETRY_MS) { this.start(source.epoch); return {items: [], state: 'loading'}; }
    return {items: [], state: 'unavailable', message: entry.message ?? 'Commands could not be loaded.'};
  }
  forget(): void { this.abort?.abort(); this.abort = undefined; this.entry = undefined; }
  private start(epoch: number): void {
    this.abort?.abort(); const abort = new AbortController(); this.abort = abort;
    const entry: Entry = {epoch, state: 'loading'}; this.entry = entry;
    void this.load(abort.signal).then(list => { entry.list = list; entry.state = 'ready'; }, error => {
      entry.state = 'failed'; entry.failedAt = this.now();
      entry.message = `Commands could not be loaded. ${error instanceof Error ? error.message : ''}`.trim();
    }).finally(() => { if (this.entry === entry && !abort.signal.aborted) this.changed(); });
  }
}
