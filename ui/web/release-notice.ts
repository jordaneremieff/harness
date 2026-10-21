import { readHealthSnapshot, type HealthSnapshot } from '../shared/health.ts';
import type { UiIdentity } from '../shared/version.ts';
import { element, setText } from './dom.ts';
import { request } from './transport.ts';

export type ReleaseReloadState = 'ready' | 'pending' | 'failed' | 'blocked';
export type ReleaseIdentity = {commit: string; generation: string; release?: string; moduleFamily?: string};
export function loadedRelease(identity: UiIdentity, generation: string | null, moduleFamily: string | null = null): ReleaseIdentity | undefined {
  if (!identity.git || !generation || !/^[a-f0-9]{64}$/.test(generation)) return;
  return {commit: identity.git.commit, generation, ...(identity.release ? {release: identity.release} : {}), ...(moduleFamily && /^[a-f0-9]{64}$/.test(moduleFamily) ? {moduleFamily} : {})};
}
export function servedRelease(snapshot: HealthSnapshot): ReleaseIdentity | undefined {
  const {commit, assetDigest, moduleFamily} = snapshot.identity;
  if (!commit || !assetDigest) return;
  return {commit, generation: assetDigest, ...(snapshot.backend?.release ? {release: snapshot.backend.release} : {}), ...(moduleFamily ? {moduleFamily} : {})};
}
export function differentRelease(loaded: ReleaseIdentity, served: ReleaseIdentity): boolean {
  return loaded.commit !== served.commit || loaded.generation !== served.generation ||
    loaded.release !== undefined && served.release !== undefined && loaded.release !== served.release;
}
export type ReleaseNoticeHooks = {
  before: HTMLElement;
  read(signal: AbortSignal): Promise<unknown>;
  reload(signal: AbortSignal, release: ReleaseIdentity): Promise<void>;
  stylesheet(release: ReleaseIdentity, signal: AbortSignal): Promise<void>;
  reloadState(): ReleaseReloadState;
  failure(error: unknown): void;
  clock: {now(): number; set(callback: () => void, delay: number): number; clear(timer: number): void};
};
export const RELEASE_CHECK_MS = 30_000;
export const readReleaseHealth = (signal: AbortSignal): Promise<unknown> =>
  request('/api/health', 'GET', undefined, undefined, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));

/** One health observer adopts immutable assets only after the page's current input work is safe. */
export class ReleaseNotice {
  readonly node = element('span', 'workbench-release');
  private served?: ReleaseIdentity;
  private active = false;
  private destroyed = false;
  private timer?: number;
  private wake?: number;
  private clearStatus?: number;
  private readAbort?: AbortController;
  private updateAbort?: AbortController;
  private typingAt?: number;
  private lastKey = 0;
  private retryAt = 0;
  private navigating = false;
  private loaded: ReleaseIdentity | undefined;
  private hooks: ReleaseNoticeHooks;
  constructor(loaded: ReleaseIdentity | undefined, hooks: ReleaseNoticeHooks) {
    this.loaded = loaded; this.hooks = hooks;
    this.node.hidden = true;
    this.node.setAttribute('role', 'status'); this.node.setAttribute('aria-live', 'polite');
    hooks.before.parentElement?.insertBefore(this.node, hooks.before);
  }
  key(): void {this.lastKey = this.hooks.clock.now(); this.refresh();}
  get quiet(): boolean {return this.hooks.clock.now() - this.lastKey >= 2000;}
  readiness(active: boolean): void {
    if (this.destroyed || this.active === active) return;
    this.active = active;
    if (!active) {
      if (this.timer !== undefined) this.hooks.clock.clear(this.timer);
      if (this.wake !== undefined) this.hooks.clock.clear(this.wake);
      this.timer = undefined; this.wake = undefined; this.readAbort?.abort(); this.readAbort = undefined;
      this.updateAbort?.abort(); this.updateAbort = undefined;
    } else {this.navigating=false; if (this.loaded) void this.check();}
    this.refresh();
  }
  private async check(): Promise<void> {
    if (!this.active || this.destroyed || this.readAbort) return;
    const controller = new AbortController(); this.readAbort = controller;
    try {
      const identity = servedRelease(readHealthSnapshot(await this.hooks.read(controller.signal)));
      if (!controller.signal.aborted && this.active && !this.destroyed && identity) {
        this.served = identity; this.refresh();
      }
    } catch { /* A failed observation never replaces the last exact identity. */ }
    finally {
      if (this.readAbort === controller) {
        this.readAbort = undefined;
        if (this.active && !this.destroyed) this.timer = this.hooks.clock.set(() => {this.timer = undefined; void this.check();}, RELEASE_CHECK_MS);
      }
    }
  }
  updated(release: ReleaseIdentity): void {
    this.loaded = {...release}; this.typingAt = undefined; this.retryAt = 0;
    this.status(`Updated to ${(release.release ?? release.commit).slice(0, 8)}`);
    if (this.clearStatus !== undefined) this.hooks.clock.clear(this.clearStatus);
    this.clearStatus = this.hooks.clock.set(() => {this.clearStatus = undefined; this.status(''); this.refresh();}, 6000);
  }
  private status(text: string): void {setText(this.node, text); this.node.hidden = !text;}
  private waiting(now:number):void {
    if(this.quiet)this.typingAt=undefined;else this.typingAt??=now;
    if (this.clearStatus === undefined) this.status(this.typingAt!==undefined && now - this.typingAt >= 60_000 ? 'Update waiting' : '');
  }
  refresh(): void {
    if (this.destroyed) return;
    if (this.wake !== undefined) this.hooks.clock.clear(this.wake);
    this.wake = undefined;
    if (!this.loaded || !this.served || !differentRelease(this.loaded, this.served)) {
      this.typingAt = undefined; if (this.clearStatus === undefined) this.status(''); return;
    }
    const now = this.hooks.clock.now(); this.waiting(now);
    if (!this.active || this.updateAbort || this.navigating) return;
    if (this.quiet && this.hooks.reloadState() === 'ready' && now >= this.retryAt) {void this.update(this.served); return;}
    this.wake = this.hooks.clock.set(() => {this.wake = undefined; this.refresh();}, 250);
  }
  private async update(release: ReleaseIdentity): Promise<void> {
    const controller = new AbortController(); this.updateAbort = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    try {
      if (this.loaded?.moduleFamily && this.loaded.moduleFamily === release.moduleFamily) {
        await this.hooks.stylesheet(release, signal); signal.throwIfAborted(); this.updated(release);
      } else {await this.hooks.reload(signal, release); this.navigating = true;}
    } catch (error) {
      if (!controller.signal.aborted && !this.destroyed) {this.retryAt = this.hooks.clock.now() + RELEASE_CHECK_MS; this.hooks.failure(error);}
    } finally {if (this.updateAbort === controller) {this.updateAbort = undefined; this.refresh();}}
  }
  destroy(): void {
    if (this.destroyed) return;
    this.readiness(false); this.destroyed = true;
    if (this.clearStatus !== undefined) this.hooks.clock.clear(this.clearStatus);
    this.node.remove();
  }
}
