import type { AgentRow } from '../shared/api.ts';
import { LIMITS } from '../shared/api.ts';

export type IdentityLoader = (identities: string[], signal: AbortSignal) => Promise<AgentRow[]>;

/**
 * Names for agent identities that the loaded roster pages do not hold. Wanted identities are
 * collected during one turn and asked in batches; an identity is asked once. The ones the server
 * does not hold stay asked until `forget`, which a roster refresh calls.
 */
export class IdentityLookup {
  private readonly answered = new Map<string, AgentRow>();
  private readonly asked = new Set<string>();
  private queue = new Set<string>();
  private scheduled = false;
  private readonly controller = new AbortController();
  revision = 0;
  private readonly load: IdentityLoader;
  private readonly changed: () => void;
  private readonly loaded: (identity: string) => boolean;
  constructor(load: IdentityLoader, changed: () => void, loaded: (identity: string) => boolean) { this.load = load; this.changed = changed; this.loaded = loaded; }
  rows(): IterableIterator<AgentRow> { return this.answered.values(); }
  get(identity: string): AgentRow | undefined { return this.answered.get(identity); }
  want(identity: string): void {
    if (this.asked.has(identity) || this.queue.has(identity) || this.loaded(identity)) return;
    this.queue.add(identity);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.flush(); });
  }
  /** Identities the server did not name are asked again after this. Named answers stay. */
  forget(): void {
    for (const identity of [...this.asked]) if (!this.answered.has(identity)) this.asked.delete(identity);
  }
  close(): void { this.controller.abort(); }
  private flush(): void {
    const identities = [...this.queue].filter(identity => !this.loaded(identity)); this.queue = new Set();
    for (let index = 0; index < identities.length; index += LIMITS.identityLookup) {
      const batch = identities.slice(index, index + LIMITS.identityLookup);
      for (const identity of batch) this.asked.add(identity);
      void this.load(batch, this.controller.signal).then(rows => {
        let added = false;
        for (const row of rows) if (batch.includes(row.identity)) { this.answered.set(row.identity, row); added = true; }
        if (added) { this.revision++; this.changed(); }
      }, () => { /* The identities stay asked; a roster refresh asks again. */ });
    }
  }
}
