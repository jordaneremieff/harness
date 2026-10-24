/** What this browser remembers about models: the ones the operator pinned and when each model first appeared in the list. */
export const NEW_MODEL_DAYS = 14;
const DAY_MS = 86_400_000;
const PIN_LIMIT = 64;
const SEEN_LIMIT = 2000;
const STORAGE_KEY = 'ui.models.v1';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
type Saved = {pins: string[]; seen: Record<string, number>};

export function modelKey(provider: string, id: string): string { return `${provider}/${id}`; }

export class ModelMemory {
  private pins: string[] = [];
  private seen = new Map<string, number>();
  private readonly store: Store | undefined;
  private readonly now: () => number;
  constructor(store?: Store, now: () => number = Date.now) {
    this.store = store ?? (typeof localStorage === 'undefined' ? undefined : localStorage); this.now = now; this.load();
  }
  private load(): void {
    try {
      const raw = this.store?.getItem(STORAGE_KEY); if (!raw) return;
      const value = JSON.parse(raw) as Partial<Saved>;
      if (Array.isArray(value.pins)) this.pins = value.pins.filter((item): item is string => typeof item === 'string').slice(0, PIN_LIMIT);
      if (value.seen && typeof value.seen === 'object') for (const [key, at] of Object.entries(value.seen)) if (typeof at === 'number' && Number.isFinite(at)) this.seen.set(key, at);
    } catch { /* Unreadable memory starts empty; it never blocks the picker. */ }
  }
  private save(): void {
    try {
      const entries = [...this.seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, SEEN_LIMIT);
      this.store?.setItem(STORAGE_KEY, JSON.stringify({pins: this.pins, seen: Object.fromEntries(entries)} satisfies Saved));
    } catch { /* A full or blocked store only loses the memory. */ }
  }
  isPinned(key: string): boolean { return this.pins.includes(key); }
  /** Pins or unpins a model; returns whether it is now pinned. */
  togglePin(key: string): boolean {
    const pinned = !this.isPinned(key);
    this.pins = pinned ? [key, ...this.pins].slice(0, PIN_LIMIT) : this.pins.filter(item => item !== key);
    this.save(); return pinned;
  }
  /** Records the current list. The first list this browser sees counts as known, not new; later additions are stamped with the time. */
  observe(keys: readonly string[]): void {
    const first = this.seen.size === 0; let changed = false;
    for (const key of keys) if (!this.seen.has(key)) { this.seen.set(key, first ? 0 : this.now()); changed = true; }
    if (changed) this.save();
  }
  isNew(key: string): boolean {
    const at = this.seen.get(key);
    return at !== undefined && at > 0 && this.now() - at < NEW_MODEL_DAYS * DAY_MS;
  }
}
