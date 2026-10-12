import { randomUUID } from "node:crypto";
import { AgentError, type HostLink, type ObservationSubscription } from "./client.mts";
import type { ConversationFrame } from "./contract.mts";

export type AvailabilityState = "live" | "stored" | "unavailable" | "incompatible";
export type AvailabilityListener = (workspaceId: string, identity: string, connectionEpoch: number, state: AvailabilityState, reason?: string, capabilities?: Record<string, boolean>) => void;
export interface ObservationOptions {
  getLink(identity: string): Promise<HostLink>;
  onFrame(workspaceId: string, identity: string, connectionEpoch: number, frame: ConversationFrame): void;
  onAvailability?: AvailabilityListener;
  projectFrame?: (frame: ConversationFrame) => ConversationFrame;
}
interface Selection {
  identity: string; epoch: number; disposed: boolean; link?: HostLink; token: string;
  opened: boolean; subscription?: ObservationSubscription; unsubscribe?: () => void;
  pending?: ConversationFrame; flush?: ReturnType<typeof setImmediate>; revision?: number;
  cleanup?: Promise<void>; setup?: Promise<void>; settingUp: boolean; unreleased?: boolean;
}
const dependencies = ["snapshot", "observe-open", "observe-frame", "observe-close"] as const;

/** Selected frames are replacement state scoped to a fresh native observation lifetime. */
export class ObservationManager {
  readonly #options: ObservationOptions;
  readonly #selected = new Map<string, Map<string, Selection>>();
  readonly #lifetimes = new Set<Selection>();
  #epoch = 0;
  readonly #setups = new Set<Promise<void>>();
  #closed = false;
  constructor(options: ObservationOptions) { this.#options = options; }
  select(workspaceId: string, identity?: string, connectionEpoch?: number): Promise<void> {
    if (this.#closed) return Promise.reject(new AgentError("not_ready", "Observation manager is closed."));
    if (!identity) return this.hide(workspaceId);
    const targets = this.#selected.get(workspaceId) ?? new Map<string, Selection>();
    const previous = targets.get(identity);
    if (previous) return previous.setup ?? Promise.resolve();
    this.#prune();
    const count = [...this.#selected.values()].reduce((total, values) => total + values.size, 0);
    if (targets.size >= 4 || count >= 16 || this.#lifetimes.size >= 16)
      return Promise.reject(new AgentError("capacity", "Agent observation capacity reached."));
    const epoch = connectionEpoch ?? this.#epoch + 1;
    if (!Number.isSafeInteger(epoch) || epoch <= 0)
      return Promise.reject(new AgentError("invalid_request", "Observation epoch must be positive."));
    this.#epoch = Math.max(this.#epoch, epoch);
    const selected: Selection = {identity, epoch, disposed: false, token: `ui:${randomUUID()}`, opened: false, settingUp: true};
    targets.set(identity, selected); this.#selected.set(workspaceId, targets); this.#lifetimes.add(selected);
    const setup = this.#open(workspaceId, selected).finally(() => {
      selected.settingUp = false; this.#setups.delete(setup); this.#prune();
    });
    selected.setup = setup; this.#setups.add(setup); return setup;
  }
  async hide(workspaceId: string, identity?: string): Promise<void> {
    const targets = this.#selected.get(workspaceId);
    if (!targets) return;
    const removed = [...targets.values()].filter(selected => identity === undefined || selected.identity === identity);
    for (const selected of removed) { selected.disposed = true; targets.delete(selected.identity); }
    if (!targets.size) this.#selected.delete(workspaceId);
    await Promise.all(removed.map(selected => this.#release(selected))); this.#prune();
  }
  async reconnect(workspaceId: string, identity: string, connectionEpoch?: number): Promise<void> {
    if (!this.#selected.get(workspaceId)?.has(identity)) throw new AgentError("invalid_request", "The target is not observed in this workspace.");
    await this.hide(workspaceId, identity);
    await this.select(workspaceId, identity, connectionEpoch);
  }
  identities(connectedOnly = false): string[] {
    return [...this.#selected.values()].flatMap(values => [...values.values()].filter(value => !value.disposed && (!connectedOnly || value.link?.connected)).map(value => value.identity));
  }
  #prune(): void {
    for (const selected of this.#lifetimes) {
      if (selected.disposed && !selected.settingUp && !selected.cleanup &&
        (!selected.unreleased || selected.link?.connected === false)) this.#lifetimes.delete(selected);
    }
  }
  #current(workspaceId: string, selected: Selection): boolean {
    return !selected.disposed && this.#selected.get(workspaceId)?.get(selected.identity) === selected && !this.#closed;
  }
  #failed(workspaceId: string, selected: Selection, error: unknown): void {
    if (!this.#current(workspaceId, selected)) return;
    selected.disposed = true;
    const reason = error instanceof Error ? error.message : "Host observation failed.";
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const state = code === "contract_mismatch" ? "incompatible" : code === "stored" ? "stored" : "unavailable";
    this.#options.onAvailability?.(workspaceId, selected.identity, selected.epoch, state, reason, selected.link?.capabilities());
    void this.#release(selected);
  }
  async #installSubscription(workspaceId: string, selected: Selection, link: HostLink): Promise<void> {
    const subscription = await link.subscribeObservation(selected.token, frame => {
      if (this.#current(workspaceId, selected)) this.#replace(workspaceId, selected, frame);
    }, selected.identity, error => this.#failed(workspaceId, selected, error));
    selected.subscription = subscription;
    if (!this.#current(workspaceId, selected)) { await this.#release(selected); return; }
    // The subscription baseline is newer than observe-open and governs the live projection.
    this.#replace(workspaceId, selected, subscription.baseline);
    subscription.start();
  }
  async #open(workspaceId: string, selected: Selection): Promise<void> {
    const current = () => this.#current(workspaceId, selected);
    try {
      const link = await this.#options.getLink(selected.identity);
      selected.link = link;
      if (!current()) return;
      link.require(dependencies);
      selected.unsubscribe = link.onDisconnect(error => this.#failed(workspaceId, selected, error));
      const snapshot = link.request("snapshot", { sessionId: selected.identity, limit: 50, maxBytes: 65536 }, { identity: selected.identity });
      // Attach a rejection handler before opening so a fast snapshot failure never becomes unhandled.
      const snapshotOutcome = snapshot.then(() => undefined, error => error);
      selected.opened = true;
      try {
        await link.request("observe-open", { token: selected.token, scope: "conversation", sessionId: selected.identity }, { identity: selected.identity, token: selected.token });
      } finally {
        // A late open response needs a close even if disposal already sent an earlier close.
        selected.opened = true;
      }
      if (!current()) return;
      await this.#installSubscription(workspaceId, selected, link);
      if (!current()) return;
      const snapshotError = await snapshotOutcome;
      if (snapshotError) throw snapshotError;
      if (current()) this.#options.onAvailability?.(workspaceId, selected.identity, selected.epoch, "live", undefined, link.capabilities());
    } catch (error) {
      this.#failed(workspaceId, selected, error);
      await this.#release(selected);
      throw error;
    } finally {
      if (!current()) await this.#release(selected);
    }
  }
  #replace(workspaceId: string, selected: Selection, frame: ConversationFrame): void {
    if (selected.revision !== undefined && frame.revision <= selected.revision) return;
    selected.revision = frame.revision;
    try { frame = this.#options.projectFrame?.(frame) ?? frame; }
    catch (error) { this.#failed(workspaceId, selected, error); return; }
    // Bound retained native state before it reaches the backend projector.
    if (Buffer.byteLength(JSON.stringify(frame)) > 1024 * 1024) {
      selected.disposed = true;
      this.#options.onAvailability?.(workspaceId, selected.identity, selected.epoch, "unavailable", "Host frame exceeds the selected observation memory bound.", selected.link?.capabilities());
      void this.#release(selected); return;
    }
    selected.pending = frame;
    if (selected.flush) return;
    selected.flush = setImmediate(() => {
      selected.flush = undefined;
      const replacement = selected.pending; selected.pending = undefined;
      if (replacement && this.#current(workspaceId, selected)) this.#options.onFrame(workspaceId, selected.identity, selected.epoch, replacement);
    });
  }
  async #release(selected: Selection): Promise<void> {
    if (selected.flush) { clearImmediate(selected.flush); selected.flush = undefined; }
    selected.pending = undefined; selected.unsubscribe?.(); selected.unsubscribe = undefined;
    if (selected.cleanup) await selected.cleanup;
    // Setup may finish after an earlier cleanup; release whichever reference arrived last.
    const subscription = selected.subscription; selected.subscription = undefined;
    const opened = selected.opened; selected.opened = false;
    if (!subscription && !opened) return;
    selected.cleanup = (async () => {
      try {
        try { await subscription?.dispose(); }
        finally {
          if (opened && selected.link?.connected) await selected.link.request("observe-close", { token: selected.token }, { token: selected.token });
        }
      } catch {
        // An uncertain token keeps its capacity reservation without closing other observers' transport.
        selected.unreleased = true;
      }
    })();
    try { await selected.cleanup; }
    finally { selected.cleanup = undefined; this.#prune(); }
  }
  async close(): Promise<void> {
    this.#closed = true;
    const selected = [...this.#selected.values()].flatMap(values => [...values.values()]); this.#selected.clear();
    for (const value of selected) value.disposed = true;
    await Promise.all(selected.map(value => this.#release(value)));
    await Promise.allSettled([...this.#setups]);
    this.#lifetimes.clear();
  }
}
