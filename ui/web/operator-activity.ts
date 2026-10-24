/** When the operator last acted on each session from this browser. Agent output, delegated messages and file changes never count. */
const STORAGE_KEY = 'ui.activity.v1';
const LIMIT = 512;
type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Saved session files start with their creation time, such as `2026-10-24T05-00-00-000Z_<id>.jsonl`. */
export function startedAtFromPath(path: string | undefined): number | undefined {
  const name = path?.split('/').at(-1) ?? '';
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
  if (!match) return undefined;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(at) ? at : undefined;
}

export class OperatorActivity {
  private readonly times = new Map<string, number>();
  private readonly store: Store | undefined;
  private readonly now: () => number;
  constructor(store?: Store, now: () => number = Date.now) {
    this.store = store ?? (typeof localStorage === 'undefined' ? undefined : localStorage); this.now = now;
    try {
      const raw = this.store?.getItem(STORAGE_KEY);
      if (raw) for (const [key, at] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) if (typeof at === 'number' && Number.isFinite(at)) this.times.set(key, at);
    } catch { /* Unreadable memory starts empty. */ }
  }
  /** Records an operator send, interrupt, answer or start for every identity of one session. */
  stamp(identities: readonly string[]): void {
    const at = this.now(); for (const identity of identities) this.times.set(identity, at);
    try {
      const kept = [...this.times.entries()].sort((a, b) => b[1] - a[1]).slice(0, LIMIT);
      this.store?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch { /* A full or blocked store only loses the memory. */ }
  }
  /** The operator's latest recorded action across a session's identities. */
  at(identities: readonly string[]): number | undefined {
    let latest: number | undefined;
    for (const identity of identities) { const at = this.times.get(identity); if (at !== undefined && (latest === undefined || at > latest)) latest = at; }
    return latest;
  }
}
