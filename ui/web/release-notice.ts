import { readHealthSnapshot, type HealthSnapshot } from '../shared/health.ts';
import type { UiIdentity } from '../shared/version.ts';
import { button, element, setText } from './dom.ts';
import { request } from './transport.ts';

export type ReleaseReloadState = 'ready' | 'pending' | 'failed' | 'blocked';
export type ReleaseIdentity = {commit: string; generation: string; release?: string};
export function loadedRelease(identity: UiIdentity, generation: string | null): ReleaseIdentity | undefined {
  if (!identity.git || !generation || !/^[a-f0-9]{64}$/.test(generation)) return;
  return {commit: identity.git.commit, generation, ...(identity.release ? {release: identity.release} : {})};
}
export function servedRelease(snapshot: HealthSnapshot): ReleaseIdentity | undefined {
  const {commit, assetDigest} = snapshot.identity;
  if (!commit || !assetDigest) return;
  return {commit, generation: assetDigest, ...(snapshot.backend?.release ? {release: snapshot.backend.release} : {})};
}
export function differentRelease(loaded: ReleaseIdentity, served: ReleaseIdentity): boolean {
  return loaded.commit !== served.commit || loaded.generation !== served.generation ||
    loaded.release !== undefined && served.release !== undefined && loaded.release !== served.release;
}
function releaseLabels(loaded: ReleaseIdentity, served: ReleaseIdentity): [string, string] {
  const generation = loaded.commit === served.commit && loaded.generation !== served.generation;
  return [(generation ? served.generation : served.commit).slice(0, 8), (generation ? loaded.generation : loaded.commit).slice(0, 8)];
}
export type ReleaseNoticeHooks = {
  before: HTMLElement;
  read(signal: AbortSignal): Promise<unknown>;
  reload(signal: AbortSignal): Promise<void>;
  details(): void;
  reloadState(): ReleaseReloadState;
  changed(visible: boolean): void;
  failure(): void;
  clock: {set(callback: () => void, delay: number): number; clear(timer: number): void};
};
export const RELEASE_CHECK_MS = 30_000;
export const readReleaseHealth = (signal: AbortSignal): Promise<unknown> =>
  request('/api/health', 'GET', undefined, undefined, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));

/** Loaded page metadata is immutable; health reads observe only the currently served release. */
export class ReleaseNotice {
  readonly node = element('span', 'workbench-release');
  readonly facts = element('span', 'workbench-release-facts');
  readonly reloadButton: HTMLButtonElement;
  readonly detailsButton: HTMLButtonElement;
  private readonly announcement = element('span', 'sr-only');
  private readonly servedText = element('span');
  private readonly loadedText = element('span', 'workbench-release-tab');
  private readonly disclosure = element('details', 'composer-details workbench-status-details workbench-release-disclosure');
  private served?: ReleaseIdentity;
  private active = false;
  private destroyed = false;
  private timer?: number;
  private readAbort?: AbortController;
  private reloadAbort?: AbortController;
  private announced = '';
  private readonly loaded: ReleaseIdentity | undefined;
  private readonly hooks: ReleaseNoticeHooks;
  constructor(loaded: ReleaseIdentity | undefined, hooks: ReleaseNoticeHooks) {
    this.loaded = loaded; this.hooks = hooks;
    this.node.hidden = true;
    this.announcement.setAttribute('role', 'status'); this.announcement.setAttribute('aria-live', 'polite'); this.announcement.setAttribute('aria-atomic', 'true');
    this.facts.setAttribute('aria-hidden', 'true'); this.facts.append(this.servedText, this.loadedText);
    this.reloadButton = button('Reload', () => {void this.reload();});
    this.detailsButton = button('Details', hooks.details, 'workbench-release-details');
    this.detailsButton.setAttribute('aria-label', 'Release details');
    const summary = element('summary', undefined, 'Status details');
    const body = element('div', 'composer-detail-body'), narrowDetails = button('Details', hooks.details);
    narrowDetails.setAttribute('aria-label', 'Release details'); body.append(narrowDetails); this.disclosure.append(summary, body);
    this.node.append(this.facts, this.reloadButton, this.detailsButton, this.disclosure, this.announcement);
    hooks.before.parentElement?.insertBefore(this.node, hooks.before);
  }
  /** The app's existing connection and visibility state controls all background reads. */
  readiness(active: boolean): void {
    if (this.destroyed || this.active === active) return;
    this.active = active;
    if (!active) {
      if (this.timer !== undefined) this.hooks.clock.clear(this.timer);
      this.timer = undefined; this.readAbort?.abort(); this.readAbort = undefined;
      this.reloadAbort?.abort(); this.reloadAbort = undefined;
    } else if (this.loaded) void this.check();
    this.refresh();
  }
  private async check(): Promise<void> {
    if (!this.active || this.destroyed || this.readAbort) return;
    const controller = new AbortController(); this.readAbort = controller;
    try {
      const snapshot = readHealthSnapshot(await this.hooks.read(controller.signal));
      if (!controller.signal.aborted && this.active && !this.destroyed) {
        const identity = servedRelease(snapshot);
        if (identity) {this.served = identity; this.refresh();}
      }
    } catch { /* An unavailable read does not replace the last observed identity. */ }
    finally {
      if (this.readAbort === controller) {
        this.readAbort = undefined;
        if (this.active && !this.destroyed) this.timer = this.hooks.clock.set(() => {this.timer = undefined; void this.check();}, RELEASE_CHECK_MS);
      }
    }
  }
  refresh(): void {
    if (this.destroyed) return;
    const visible = !!this.loaded && !!this.served && differentRelease(this.loaded, this.served);
    const changed = this.node.hidden === visible;
    this.node.hidden = !visible;
    if (changed) this.hooks.changed(visible);
    if (!visible || !this.loaded || !this.served) {setText(this.announcement, ''); this.announced = ''; return;}
    const [live, loaded] = releaseLabels(this.loaded, this.served);
    const text = `Release ${live} live · this tab ${loaded}`;
    setText(this.servedText, `Release ${live} live`); setText(this.loadedText, ` · this tab ${loaded}`);
    this.node.title = text;
    const identityKey = JSON.stringify(this.served);
    if (identityKey !== this.announced) {this.announced = identityKey; setText(this.announcement, text);}
    const state = this.hooks.reloadState();
    setText(this.reloadButton, state === 'pending' ? 'Reload after draft save' : 'Reload');
    this.reloadButton.disabled = !this.active || !!this.reloadAbort || state !== 'ready';
    this.reloadButton.setAttribute('aria-label', `Reload to release ${live}`);
  }
  private async reload(): Promise<void> {
    if (this.destroyed || this.node.hidden || !this.active || this.reloadAbort || this.hooks.reloadState() !== 'ready') return;
    const controller = new AbortController(); this.reloadAbort = controller; this.refresh();
    try {await this.hooks.reload(controller.signal);}
    catch {if (!controller.signal.aborted && !this.destroyed) this.hooks.failure();}
    finally {if (this.reloadAbort === controller) {this.reloadAbort = undefined; this.refresh();}}
  }
  destroy(): void {
    if (this.destroyed) return;
    this.readiness(false); this.destroyed = true; this.node.remove();
  }
}
