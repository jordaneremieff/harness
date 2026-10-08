import { randomUUID } from "node:crypto";
import { AgentError, type HostLink, type ObservationSubscription } from "./client.mts";
import type { ConversationFrame } from "./contract.mts";

export type AvailabilityState = "live" | "stored" | "unavailable" | "incompatible";
export type AvailabilityListener = (workspaceId: string, identity: string, state: AvailabilityState, reason?: string, capabilities?: Record<string, boolean>) => void;
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
  cleanup?: Promise<void>;
}
const dependencies = ["snapshot", "observe-open", "observe-frame", "observe-close"] as const;

/** Selected frames are replacement state scoped to a fresh native observation lifetime. */
export class ObservationManager {
  readonly #options: ObservationOptions;
  readonly #selected = new Map<string, Selection>();
  readonly #lastIdentity = new Map<string, string>();
  readonly #epochs = new Map<string, number>();
  readonly #setups = new Set<Promise<void>>();
  #closed = false;
  constructor(options: ObservationOptions) { this.#options = options; }
  async select(workspaceId: string, identity?: string): Promise<void> {
    if (this.#closed) throw new AgentError("not_ready", "Observation manager is closed.");
    if (!this.#epochs.has(workspaceId) && this.#epochs.size >= 16) throw new AgentError("capacity", "Workspace observation capacity reached.");
    const epoch = (this.#epochs.get(workspaceId) ?? 0) + 1;
    this.#epochs.set(workspaceId, epoch);
    const previous = this.#selected.get(workspaceId);
    if (previous) {
      previous.disposed = true; this.#selected.delete(workspaceId);
      await this.#release(previous);
    }
    if (!identity || this.#epochs.get(workspaceId) !== epoch || this.#closed) return;
    this.#lastIdentity.set(workspaceId, identity);
    const selected: Selection = { identity, epoch, disposed: false, token: `ui:${randomUUID()}`, opened: false };
    this.#selected.set(workspaceId, selected);
    const setup = this.#open(workspaceId, selected);
    this.#setups.add(setup);
    try { await setup; } finally { this.#setups.delete(setup); }
  }
  hide(workspaceId: string): Promise<void> { return this.select(workspaceId); }
  reconnect(workspaceId: string): Promise<void> {
    const identity = this.#lastIdentity.get(workspaceId);
    if (!identity) return Promise.reject(new AgentError("invalid_request", "No agent was selected for this workspace."));
    return this.select(workspaceId, identity);
  }
  target(workspaceId: string): string | undefined { return this.#lastIdentity.get(workspaceId); }
  identities(): string[] { return [...this.#selected.values()].filter(value => !value.disposed).map(value => value.identity); }
  #current(workspaceId: string, selected: Selection): boolean {
    return !selected.disposed && this.#selected.get(workspaceId) === selected && !this.#closed;
  }
  #failed(workspaceId: string, selected: Selection, error: unknown): void {
    if (!this.#current(workspaceId, selected)) return;
    selected.disposed = true;
    const reason = error instanceof Error ? error.message : "Host observation failed.";
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const state = code === "contract_mismatch" ? "incompatible" : code === "stored" ? "stored" : "unavailable";
    this.#options.onAvailability?.(workspaceId, selected.identity, state, reason, selected.link?.capabilities());
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
      await link.request("observe-open", { token: selected.token, scope: "conversation", sessionId: selected.identity }, { identity: selected.identity, token: selected.token });
      if (!current()) return;
      await this.#installSubscription(workspaceId, selected, link);
      if (!current()) return;
      const snapshotError = await snapshotOutcome;
      if (snapshotError) throw snapshotError;
      if (current()) this.#options.onAvailability?.(workspaceId, selected.identity, "live", undefined, link.capabilities());
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
      this.#options.onAvailability?.(workspaceId, selected.identity, "unavailable", "Host frame exceeds the selected observation memory bound.", selected.link?.capabilities());
      void this.#release(selected); return;
    }
    selected.pending = frame;
    if (selected.flush) return;
    selected.flush = setImmediate(() => {
      selected.flush = undefined;
      const replacement = selected.pending; selected.pending = undefined;
      if (replacement && !selected.disposed && this.#selected.get(workspaceId) === selected && !this.#closed) this.#options.onFrame(workspaceId, selected.identity, selected.epoch, replacement);
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
      try { await subscription?.dispose(); }
      finally {
        if (opened && selected.link?.connected) await selected.link.request("observe-close", { token: selected.token }, { token: selected.token });
      }
    })();
    try { await selected.cleanup; }
    catch { if (selected.link?.connected) await selected.link.close(); }
    finally { selected.cleanup = undefined; }
  }
  async close(): Promise<void> {
    this.#closed = true;
    const selected = [...this.#selected.values()]; this.#selected.clear();
    for (const value of selected) value.disposed = true;
    await Promise.all(selected.map(value => this.#release(value)));
    await Promise.allSettled([...this.#setups]);
    this.#lastIdentity.clear(); this.#epochs.clear();
  }
}
