import type { PrimaryView } from '../shared/api.ts';
import type { RpcClient } from './client.mts';

type Stats = Pick<PrimaryView, 'usage' | 'contextUsage'>;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid optional statistics.');
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid optional statistics.');
  return value;
}
function nullable(value: unknown): number | null { return value === null ? null : count(value); }
export function decodeStats(value: unknown): Stats {
  const data = record(value);
  if (Buffer.byteLength(JSON.stringify(data)) > 16 * 1024) throw new Error('Optional statistics exceed the display budget.');
  const tokens = record(data.tokens);
  const usage: NonNullable<PrimaryView['usage']> = {
    tokens: { input: count(tokens.input), output: count(tokens.output), cacheRead: count(tokens.cacheRead), cacheWrite: count(tokens.cacheWrite), total: count(tokens.total) },
    cost: count(data.cost),
  };
  if (data.contextUsage === undefined) return { usage };
  const context = record(data.contextUsage);
  return { usage, contextUsage: { tokens: nullable(context.tokens), contextWindow: count(context.contextWindow), percent: nullable(context.percent) } };
}

/** Optional statistics share one request lane and never participate in readiness. */
export class SessionStats {
  private wanted = false;
  private generation = 0;
  private running = false;
  private view: PrimaryView;
  private client: RpcClient;
  private changed: () => void;
  constructor(view: PrimaryView, client: RpcClient, changed: () => void) { this.view = view; this.client = client; this.changed = changed; }
  refresh(): void {
    this.wanted = true;
    if (this.running || this.view.lifecycle !== 'ready') return;
    this.running = true;
    void this.read().catch(() => {}).finally(() => { this.running = false; if (this.wanted && this.view.lifecycle === 'ready' && !this.client.exited) this.refresh(); });
  }
  clear(): void { this.generation++; this.wanted = false; this.apply({}); }
  private async read(): Promise<void> {
    while (this.wanted && this.view.lifecycle === 'ready' && !this.client.exited) {
      this.wanted = false;
      const epoch = this.view.epoch; const generation = this.generation;
      let stats: Stats = {};
      try { stats = decodeStats(await this.client.request('get_session_stats')); }
      catch { /* Optional statistics remain unavailable after a refusal or invalid payload. */ }
      if (epoch === this.view.epoch && generation === this.generation && this.view.lifecycle === 'ready' && !this.wanted) this.apply(stats);
    }
  }
  private apply(stats: Stats): void {
    const old = JSON.stringify({ usage: this.view.usage, contextUsage: this.view.contextUsage });
    if (old === JSON.stringify(stats)) return;
    this.view.usage = stats.usage; this.view.contextUsage = stats.contextUsage; this.changed();
  }
}
