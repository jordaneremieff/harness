export type ConnectionPhase = 'healthy' | 'quiet' | 'reconnecting' | 'offline' | 'auth';
export type ConnectionClock = {now: () => number; set: (callback: () => void, delay: number) => number; clear: (timer: number) => void};
export type ConnectionHooks = {attempt: () => Promise<void>; paint: (phase: ConnectionPhase, error?: unknown) => void; unauthorized: (error: unknown) => boolean};
const ATTEMPTS = [250, 1000, 3000, 6000];
export type ConnectionSurface = {owner: 'connection' | 'workspace-alert'; visible: boolean};
/** One surface explains a visible recovery or failure: the sidebar footer when shown, otherwise the main pane. */
export function connectionSurface(phase: ConnectionPhase, sidebarVisible: boolean): ConnectionSurface {
  return {owner: sidebarVisible ? 'connection' : 'workspace-alert', visible: phase === 'reconnecting' || phase === 'offline' || phase === 'auth'};
}
const clock: ConnectionClock = {now: () => Date.now(), set: (callback, delay) => window.setTimeout(callback, delay), clear: timer => window.clearTimeout(timer)};

/** Read-only recovery ends after a bounded episode; admission remains independent. */
export class ConnectionRecovery {
  phase: ConnectionPhase = 'healthy';
  private generation = 0;
  private started = 0;
  private attempts = 0;
  private retryTimer?: number;
  private quietTimer?: number;
  private active = false;
  private error?: unknown;
  private hooks: ConnectionHooks;
  private clock: ConnectionClock;
  constructor(hooks: ConnectionHooks, timer: ConnectionClock = clock) { this.hooks = hooks; this.clock = timer; }
  private paint(phase: ConnectionPhase): void { this.phase = phase; this.hooks.paint(phase, this.error); }
  private clear(): void {
    if (this.retryTimer !== undefined) this.clock.clear(this.retryTimer);
    if (this.quietTimer !== undefined) this.clock.clear(this.quietTimer);
    this.retryTimer = undefined; this.quietTimer = undefined;
  }
  healthy(): void { this.generation++; this.clear(); this.error = undefined; this.paint('healthy'); }
  auth(error: unknown): void { this.generation++; this.clear(); this.error = error; this.paint('auth'); }
  lost(error?: unknown): void {
    if (error !== undefined) this.error = error;
    if (error !== undefined && this.hooks.unauthorized(error)) { this.auth(error); return; }
    if (this.phase !== 'healthy') return;
    this.begin(); this.schedule();
  }
  reconnect(): void {
    if (this.active) return;
    this.begin(); void this.run(this.generation);
  }
  private begin(): void {
    this.generation++; this.clear(); this.started = this.clock.now(); this.attempts = 0; this.paint('quiet');
    this.quietTimer = this.clock.set(() => { this.quietTimer = undefined; if (this.phase === 'quiet') this.paint('reconnecting'); }, 750);
  }
  private schedule(): void {
    const at = ATTEMPTS[this.attempts];
    if (at === undefined) { this.clear(); this.paint('offline'); return; }
    const generation = this.generation;
    this.retryTimer = this.clock.set(() => { this.retryTimer = undefined; void this.run(generation); }, Math.max(0, this.started + at - this.clock.now()));
  }
  private async run(generation: number): Promise<void> {
    if (generation !== this.generation || this.active) return;
    this.active = true; this.attempts++;
    try {
      await this.hooks.attempt();
      if (generation === this.generation) this.healthy();
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error;
      if (this.hooks.unauthorized(error)) this.auth(error);
      else this.schedule();
    } finally { this.active = false; }
  }
}
