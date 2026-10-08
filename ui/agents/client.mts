import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { JsonValue, ServiceProviderUpdate, ServiceSubscriptionSnapshot } from "@earendil-works/chord";
import { Client, type ServiceSubscription } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { assertOperation, decodeDescriptor, decodeFrame, decodeInput, decodeResponse, supportedOperations, type Admission, type ConversationFrame, type JsonObject, type OperationName, type RuntimeDescriptor } from "./contract.mts";

export interface HostEndpoint { serverId: string; socketPath: string }
export interface LinkOptions { handshakeTimeoutMs?: number; maxPending?: number; onMeasure?: (name: string, durationMs: number) => void }
export class AgentError extends Error {
  readonly code: string;
  readonly uncertain: boolean;
  constructor(code: string, message: string, uncertain = false) {
    super(message); this.name = "AgentError"; this.code = code; this.uncertain = uncertain;
  }
}
export interface RequestContext { wireRequestId?: string; identity?: string; requestId?: string; token?: string }
export interface ObservationSubscription { baseline: ConversationFrame; start(): void; dispose(): Promise<void> }
export interface SubmitInput { operationId: string; message: string; mode: "steer" | "followUp" }
const mutations = new Set<OperationName>(["task-submit", "abort", "configure"]);

/** One negotiated connection. Disconnect never replays work or opens another connection. */
export class HostLink {
  readonly endpoint: HostEndpoint;
  readonly descriptor: RuntimeDescriptor;
  readonly #client: Client;
  readonly #maxPending: number;
  readonly #onMeasure?: LinkOptions["onMeasure"];
  #pending = 0;
  #closed = false;
  #closePromise?: Promise<void>;
  readonly #disabled = new Set<OperationName>();
  readonly #disconnectListeners = new Set<(error: Error) => void>();
  readonly #subscriptions = new Set<ServiceSubscription>();
  readonly #inputs = new Map<string, { digest: string; promise: Promise<Admission> }>();
  readonly #unsubscribe: () => void;

  private constructor(endpoint: HostEndpoint, client: Client, descriptor: RuntimeDescriptor, options: LinkOptions) {
    this.endpoint = endpoint; this.#client = client; this.descriptor = descriptor;
    this.#maxPending = options.maxPending ?? 32; this.#onMeasure = options.onMeasure;
    this.#unsubscribe = client.onConnectionStateChange(change => {
      if (change.state !== "disconnected") return;
      const error = change.error ?? new AgentError("host_unavailable", "Host connection closed. Accepted work continues independently.");
      for (const listener of this.#disconnectListeners) listener(error);
    });
  }
  static async connect(endpoint: HostEndpoint, options: LinkOptions = {}): Promise<HostLink> {
    const maxPending = options.maxPending ?? 32;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32) throw new AgentError("invalid_request", "Invalid host concurrency bound.");
    const timeout = options.handshakeTimeoutMs ?? 5000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30000) throw new AgentError("invalid_request", "Invalid handshake deadline.");
    const unix = createUnixTransportFactory({ path: endpoint.socketPath, maxPendingBytes: 1024 * 1024 });
    const client = new Client({ serverId: endpoint.serverId, transportFactory: handlers => unix({ ...handlers, onData: chunk => {
      const started = performance.now();
      try { handlers.onData(chunk); } finally { options.onMeasure?.("native.transport.decode", performance.now() - started); }
    } }), maxFrameLength: 16 * 1024 * 1024 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); client.disconnect("Host handshake deadline");
      reject(new AgentError("host_unavailable", "Host handshake or negotiation exceeded its deadline."));
    }, timeout); });
    try {
      const descriptor = await Promise.race([(async () => {
        await client.connect();
        return decodeDescriptor(await client.request({ serverId: endpoint.serverId }, { serviceId: "pi.agent.host", member: "runtime-contract", args: [] }, controller.signal));
      })(), deadline]);
      return new HostLink(endpoint, client, descriptor, options);
    } catch (error) { await client.dispose(); throw contractFailure(error); }
    finally { if (timer) clearTimeout(timer); }
  }
  get connected(): boolean { return !this.#closed && this.#client.connected; }
  supports(member: OperationName): boolean {
    if (this.#disabled.has(member)) return false;
    try { assertOperation(this.descriptor, member); return true; } catch { return false; }
  }
  capabilities(): Record<string, boolean> {
    return Object.fromEntries(Object.keys(supportedOperations).map(member => [member, this.supports(member as OperationName)]));
  }
  require(members: readonly OperationName[]): void {
    for (const member of members) {
      if (this.#disabled.has(member)) throw new AgentError("protocol_error", `Host returned malformed ${member} data.`);
      try { assertOperation(this.descriptor, member); } catch (error) { throw contractFailure(error); }
    }
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.#disconnectListeners.add(listener); return () => this.#disconnectListeners.delete(listener);
  }
  async request(member: OperationName, params: JsonObject | null, context: RequestContext = {}): Promise<unknown> {
    this.require([member]);
    if (!this.connected) throw new AgentError("host_unavailable", "Host connection is unavailable. Reconnect explicitly.");
    try { decodeInput(member, params ?? {}, context); } catch (error) { throw new AgentError("invalid_request", error instanceof Error ? error.message : "Invalid host operation input."); }
    this.#reserve();
    try {
      let value: unknown;
      try {
        value = await this.#client.request({ serverId: this.endpoint.serverId }, {
          serviceId: "pi.agent.host", member,
          args: [params as JsonValue, context.wireRequestId ?? randomUUID(), supportedOperations[member] as unknown as JsonValue],
        });
      } catch (error) {
        if (!this.connected) throw new AgentError("host_unavailable", "Host connection lost. Remote admission is not known.", mutations.has(member));
        throw error;
      }
      const decodeStarted = performance.now();
      try {
        const decoded = decodeResponse(member, value, context);
        assertResponseContext(member, decoded, params);
        return decoded;
      }
      catch (error) {
        this.#disabled.add(member);
        throw new AgentError("protocol_error", error instanceof Error ? error.message : `Invalid ${member} response.`, mutations.has(member));
      } finally { this.#onMeasure?.(`native.${member}.validate`, performance.now() - decodeStarted); }
    } finally { this.#pending--; }
  }
  submit(identity: string, input: SubmitInput, installationId: string): Promise<Admission> {
    try { validateSubmitInput(input); } catch (error) { return Promise.reject(error); }
    const requestId = `ui:${input.operationId}`;
    const params = { sessionId: identity, message: input.message, origin: "operator", requester: `ui:${installationId}`, replyTo: identity, requestId, whenBusy: input.mode };
    const digest = JSON.stringify(params);
    const previous = this.#inputs.get(requestId);
    if (previous) {
      if (previous.digest !== digest) return Promise.reject(new AgentError("operation_conflict", "Agent request key was reused with changed input."));
      return previous.promise;
    }
    if (this.#inputs.size >= 2048) return Promise.reject(new AgentError("capacity", "Host input receipt cache is full."));
    const promise = this.request("task-submit", params, { identity, requestId, wireRequestId: requestId }) as Promise<Admission>;
    this.#inputs.set(requestId, { digest, promise });
    return promise;
  }
  async subscribeObservation(token: string, onFrame: (frame: ConversationFrame) => void, identity?: string, onError?: (error: Error) => void): Promise<ObservationSubscription> {
    this.require(["observe-open", "observe-frame", "observe-close"]);
    return this.#subscribe(`pi.agent.host.observe:${token}`, "pi.agent.host.observe", "frame", value => {
      const started = performance.now();
      try {
        const frame = decodeFrame(value, { identity });
        if (frame.scope !== "conversation") throw new AgentError("protocol_error", "Expected a conversation observation frame.");
        return frame as ConversationFrame;
      } finally { this.#onMeasure?.("native.observe-frame.validate", performance.now() - started); }
    }, onFrame, onError);
  }
  async subscribeChanges(onChange: (revision: number) => void, onError?: (error: Error) => void): Promise<{ start(): void; dispose(): Promise<void> }> {
    this.require(["changes"]);
    const decode = (value: unknown): number => {
      if (!value || typeof value !== "object" || !("revision" in value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new AgentError("protocol_error", "Invalid host change state.");
      return value.revision as number;
    };
    const sub = await this.#subscribe("pi.agent.host.changes", "pi.agent.host.changes", "change", decode, onChange, onError);
    onChange(sub.baseline); return sub;
  }
  async #subscribe<T>(serviceId: string, baselineService: string, member: string, decode: (value: unknown) => T, receive: (value: T) => void, onError?: (error: Error) => void): Promise<{ baseline: T; start(): void; dispose(): Promise<void> }> {
    this.#reserve();
    let sub: ServiceSubscription | undefined;
    const fail = (error: unknown) => {
      if (!(error instanceof AgentError && error.code === "host_unavailable")) this.#disabled.add(member === "frame" ? "observe-frame" : "changes");
      const cause = error instanceof Error ? error : new AgentError("protocol_error", "Invalid subscription state.");
      if (onError) onError(cause); else this.#client.disconnect("Malformed subscription state");
    };
    try {
      sub = await this.#client.subscribeService({ serverId: this.endpoint.serverId }, serviceId, "singleton", update => {
        try {
          if (update.type === "unavailable") throw new AgentError("host_unavailable", "Host observation is unavailable.");
          const raw = update.type === "reset" ? snapshotValue(update.snapshot, baselineService, member) : updateValue(update, member);
          receive(decode(raw));
        } catch (error) { fail(error); }
      });
      const baseline = decode(snapshotValue(sub.snapshot, baselineService, member));
      this.#subscriptions.add(sub);
      const owned = sub;
      return { baseline, start: () => owned.start(), dispose: async () => { this.#subscriptions.delete(owned); await owned.dispose(); } };
    } catch (error) { if (sub) { await sub.dispose(); fail(error); } throw error; }
    finally { this.#pending--; }
  }
  #reserve(): void {
    if (!this.connected) throw new AgentError("host_unavailable", "Host connection is unavailable. Reconnect explicitly.");
    if (this.#pending >= this.#maxPending) throw new AgentError("capacity", "Host request capacity reached.");
    this.#pending++;
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    for (const listener of this.#disconnectListeners) listener(new AgentError("host_unavailable", "Host link closed. Accepted work remains independent."));
    this.#closePromise = (async () => {
      this.#unsubscribe();
      await this.#client.dispose();
      this.#subscriptions.clear(); this.#disconnectListeners.clear();
    })();
    return this.#closePromise;
  }
}
export function validateSubmitInput(input: SubmitInput): void {
  if (!input || typeof input.operationId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.operationId) || typeof input.message !== "string" || !input.message.trim() || Buffer.byteLength(input.message) > 65536 || !["steer", "followUp"].includes(input.mode)) throw new AgentError("invalid_request", "Invalid agent input.");
}
function assertResponseContext(member: OperationName, value: unknown, params: JsonObject | null): void {
  if (!params || !value || typeof value !== "object") return;
  const response = value as Record<string, unknown>;
  const equal = (field: string, expected: unknown) => {
    if (expected !== undefined && response[field] !== expected) throw new AgentError("protocol_error", `Host returned a different ${field}.`);
  };
  if (member === "abort") equal("background", params.background ?? false);
  if (member === "inspect") {
    equal("view", params.view ?? "history");
    if (params.view === "result") equal("submissionId", params.submissionId);
    if (params.view === "exact") { equal("entryId", params.entryId); equal("offset", params.offset ?? 0); }
  }
}
function contractFailure(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error && (error.code === "incompatible" || error.code === "unavailable" || error.code === "malformed")) return new AgentError(error.code === "malformed" ? "protocol_error" : "contract_mismatch", error instanceof Error ? error.message : "Host contract is unavailable.");
  return error;
}
function rootValue(ops: readonly unknown[]): unknown {
  if (ops.length !== 1 || !Array.isArray(ops[0]) || ops[0].length !== 2 || ops[0][0] !== "r") throw new AgentError("protocol_error", "Host subscription requires root replacement state.");
  return ops[0][1];
}
function snapshotValue(snapshot: ServiceSubscriptionSnapshot, serviceId: string, member: string): unknown {
  if (snapshot.serviceId !== serviceId || snapshot.mode !== "singleton" || snapshot.instances.length !== 1) throw new AgentError("protocol_error", "Invalid host subscription baseline.");
  const instance = snapshot.instances[0];
  if (!instance || instance.instance || instance.members.length !== 1) throw new AgentError("protocol_error", "Invalid host singleton baseline.");
  const state = instance.members[0];
  if (state?.kind !== "state" || state.name !== member) throw new AgentError("protocol_error", "Invalid host subscription member.");
  return rootValue(state.ops);
}
function updateValue(update: ServiceProviderUpdate, member: string): unknown {
  if (update.type !== "state" || update.member !== member || update.instance) throw new AgentError("protocol_error", "Invalid host subscription update.");
  return rootValue(update.ops);
}
