import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { connectTransport, LocalTransportRefusal, type FeedKind, type TransportClient, type TransportSubscription } from "../../transport/index.ts";
import { assertOperation, decodeDescriptor, decodeFrame, decodeInput, decodeNativeMessage, decodeResponse, supportedOperations, type Admission, type ConversationFrame, type JsonObject, type OperationName, type RuntimeDescriptor } from "./contract.mts";

export interface HostEndpoint { serverId: string; socketPath: string }
export interface LinkOptions { handshakeTimeoutMs?: number; maxPending?: number; onMeasure?: (name: string, durationMs: number) => void }
export { AgentError, validateSubmitInput } from "./input.mts";
export type { SubmitInput, NativeSubmitInput } from "./input.mts";
import { AgentError, nativeInputDigest, type NativeSubmitInput } from "./input.mts";
import { LIMITS } from "../shared/api.ts";
export interface RequestContext { wireRequestId?: string; identity?: string; requestId?: string; token?: string }
export interface ObservationSubscription { baseline: ConversationFrame; start(): void; dispose(): Promise<void> }
const mutations = new Set<OperationName>(["task-submit", "abort", "configure"]);
const localRefusalCodes = { "frame-limit": "payload_too_large", "queue-limit": "capacity", serialization: "invalid_request" } as const;

/** One negotiated connection. Disconnect never replays work or opens another connection. */
export class HostLink {
  readonly endpoint: HostEndpoint;
  readonly descriptor: RuntimeDescriptor;
  readonly #client: TransportClient;
  readonly #maxPending: number;
  readonly #onMeasure?: LinkOptions["onMeasure"];
  #pending = 0;
  #closed = false;
  #closePromise?: Promise<void>;
  readonly #disabled = new Set<OperationName>();
  readonly #disconnectListeners = new Set<(error: Error) => void>();
  readonly #subscriptions = new Set<{ dispose(): Promise<void> }>();
  readonly #inputs = new Map<string, { digest: string; promise: Promise<Admission> }>();
  readonly #unsubscribe: () => void;

  private constructor(endpoint: HostEndpoint, client: TransportClient, descriptor: RuntimeDescriptor, options: LinkOptions) {
    this.endpoint = endpoint; this.#client = client; this.descriptor = descriptor;
    this.#maxPending = options.maxPending ?? 32; this.#onMeasure = options.onMeasure;
    this.#unsubscribe = client.onClose(reason => {
      const error = new AgentError("host_unavailable", `Host connection closed: ${reason}. Accepted work continues independently.`);
      for (const subscription of this.#subscriptions) void subscription.dispose();
      for (const listener of this.#disconnectListeners) listener(error);
    });
  }
  static async connect(endpoint: HostEndpoint, options: LinkOptions = {}): Promise<HostLink> {
    const maxPending = options.maxPending ?? 32;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32) throw new AgentError("invalid_request", "Invalid host concurrency bound.");
    const timeout = options.handshakeTimeoutMs ?? 5000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30000) throw new AgentError("invalid_request", "Invalid handshake deadline.");
    let client: TransportClient | undefined;
    const controller = new AbortController();
    const expired = new AgentError("host_unavailable", "Host handshake or negotiation exceeded its deadline.");
    const timer = setTimeout(() => { controller.abort(expired); void client?.dispose(); }, timeout);
    try {
      client = await connectTransport({ serverId: endpoint.serverId, path: endpoint.socketPath,
        timeoutMs: timeout, maxFrameBytes: 16 * 1024 * 1024,
        maxSendFrameBytes: LIMITS.inputFrameBytes - 1, maxQueueBytes: LIMITS.agentPendingBytes });
      controller.signal.throwIfAborted();
      const descriptor = decodeDescriptor(await client.request({ method: "runtime-contract" }, controller.signal));
      controller.signal.throwIfAborted();
      return new HostLink(endpoint, client, descriptor, options);
    } catch (error) {
      const unavailable = !client?.connected;
      await client?.dispose();
      if (controller.signal.aborted) throw expired;
      if (unavailable) throw new AgentError("host_unavailable", error instanceof Error ? error.message : "Host connection failed.");
      throw contractFailure(error);
    }
    finally { clearTimeout(timer); }
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
      try { assertOperation(this.descriptor, member); } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "incompatible") {
          const describe = (value: RuntimeDescriptor["operations"][string] | undefined) => value ? `${value.request}, response ${value.response}${value.durable ? `, Durable ${value.durable}` : ""}` : "not advertised";
          throw new AgentError("contract_mismatch", `Host operation ${member} is unavailable. Required: ${describe(supportedOperations[member])}. Host: ${describe(this.descriptor.operations[member])}.`);
        }
        throw contractFailure(error);
      }
    }
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.#disconnectListeners.add(listener); return () => this.#disconnectListeners.delete(listener);
  }
  async request(member: OperationName, params: JsonObject | null, context: RequestContext = {}, signal?: AbortSignal): Promise<unknown> {
    this.require([member]);
    if (!this.connected) throw new AgentError("host_unavailable", "Host connection is unavailable. Reconnect explicitly.");
    try { decodeInput(member, params ?? {}, context); } catch (error) { throw new AgentError("invalid_request", error instanceof Error ? error.message : "Invalid host operation input."); }
    if (signal?.aborted) throw new AgentError("cancelled", "Host request wait was cancelled before dispatch.");
    this.#reserve();
    try {
      const value = await this.#send(member, params, context, signal);
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
  async #send(member: OperationName, params: JsonObject | null, context: RequestContext, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.#client.request({ method: member, params,
        requestId: context.wireRequestId ?? randomUUID(), contract: supportedOperations[member] }, signal);
    } catch (error) {
      if (error instanceof LocalTransportRefusal) throw new AgentError(localRefusalCodes[error.reason], error.message);
      if (!this.connected) throw new AgentError("host_unavailable", "Host connection lost. Remote admission is not known.", mutations.has(member));
      if (signal?.aborted) throw new AgentError("cancelled", "Host request wait was cancelled. Accepted work continues independently.", mutations.has(member));
      throw error;
    }
  }
  submit(identity: string, input: NativeSubmitInput, installationId: string, signal?: AbortSignal): Promise<Admission> {
    if (!input || typeof input.operationId !== "string" || !/^[a-zA-Z0-9._:-]{1,125}$/.test(input.operationId)
      || !["steer", "followUp"].includes(input.mode)) return Promise.reject(new AgentError("invalid_request", "Invalid native input."));
    const requestId = `ui:${input.operationId}`;
    const params = { sessionId: identity, message: input.message, origin: "operator", requester: `ui:${installationId}`, replyTo: identity, requestId, whenBusy: input.mode };
    try { decodeNativeMessage(input.message); }
    catch (error) { return Promise.reject(new AgentError("invalid_request", error instanceof Error ? error.message : "Invalid native input.")); }
    const digest = nativeInputDigest(identity, input, installationId);
    const previous = this.#inputs.get(requestId);
    if (previous) {
      if (previous.digest !== digest) return Promise.reject(new AgentError("operation_conflict", "Agent request key was reused with changed input."));
      return previous.promise;
    }
    if (this.#inputs.size >= 2048) return Promise.reject(new AgentError("capacity", "Host input receipt cache is full."));
    const promise = this.request("task-submit", params, { identity, requestId, wireRequestId: requestId }, signal) as Promise<Admission>;
    this.#inputs.set(requestId, { digest, promise });
    return promise;
  }
  async subscribeObservation(token: string, onFrame: (frame: ConversationFrame) => void, identity?: string, onError?: (error: Error) => void): Promise<ObservationSubscription> {
    this.require(["observe-open", "observe-frame", "observe-close"]);
    return this.#subscribe("observation", token, value => {
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
    const sub = await this.#subscribe("changes", undefined, decode, onChange, onError);
    onChange(sub.baseline); return sub;
  }
  async #subscribe<T>(kind: FeedKind, token: string | undefined, decode: (value: unknown) => T, receive: (value: T) => void, onError?: (error: Error) => void): Promise<{ baseline: T; start(): void; dispose(): Promise<void> }> {
    this.#reserve();
    let sub: TransportSubscription | undefined;
    let started = false;
    let disposed = false;
    let pending: { value: T } | undefined;
    let failure: Error | undefined;
    const dispose = async () => {
      disposed = true; pending = undefined;
      this.#subscriptions.delete(owned);
      await sub?.dispose();
    };
    const owned = { dispose };
    const fail = (error: unknown) => {
      if (disposed) return;
      failure = subscriptionFailure(error);
      if (!(failure instanceof AgentError && failure.code === "host_unavailable")) this.#disabled.add(kind === "observation" ? "observe-frame" : "changes");
      void dispose();
      if (onError) onError(failure); else void this.close();
    };
    const current = (value: unknown): T => {
      if (value === null) throw new AgentError("host_unavailable", "Host observation is unavailable.");
      return decode(value);
    };
    try {
      sub = await this.#client.subscribe(kind, token, value => {
        if (disposed || !this.connected) return;
        try {
          const decoded = current(value);
          if (started) receive(decoded); else pending = { value: decoded };
        } catch (error) { fail(error); }
      });
      if (failure) throw failure;
      if (!this.connected) throw new AgentError("host_unavailable", "Host connection closed during subscription.");
      let baseline: T;
      try { baseline = current(sub.value); } catch (error) { fail(error); throw failure; }
      // The hydrated value includes changes received before subscribe() returns.
      pending = undefined;
      this.#subscriptions.add(owned);
      return { baseline, start: () => {
        if (disposed || started) return;
        started = true;
        const next = pending; pending = undefined;
        if (next) { try { receive(next.value); } catch (error) { fail(error); } }
      }, dispose };
    } catch (error) {
      await dispose();
      if (failure) throw failure;
      if (!this.connected) throw new AgentError("host_unavailable", "Host connection closed during subscription.");
      throw error;
    } finally { this.#pending--; }
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
      await Promise.all([...this.#subscriptions].map(subscription => subscription.dispose()));
      await this.#client.dispose();
      this.#subscriptions.clear(); this.#disconnectListeners.clear();
    })();
    return this.#closePromise;
  }
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
    if (params.view === "result") {
      for (const field of ["submissionId", "requestId", "operationId"]) equal(field, params[field]);
    }
    if (params.view === "exact") { equal("entryId", params.entryId); equal("offset", params.offset ?? 0); }
  }
}
function subscriptionFailure(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  return new AgentError("protocol_error", error instanceof Error ? error.message : "Invalid subscription state.");
}
function contractFailure(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error && (error.code === "incompatible" || error.code === "unavailable" || error.code === "malformed")) return new AgentError(error.code === "malformed" ? "protocol_error" : "contract_mismatch", error instanceof Error ? error.message : "Host contract is unavailable.");
  return error;
}
