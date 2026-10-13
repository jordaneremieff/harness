import { AgentCatalog, deriveEndpoint, readClaim, type CatalogPage, type CatalogRecord, type CatalogScan } from "./catalog.mts";
import { AgentError, HostLink, validateSubmitInput, type SubmitInput } from "./client.mts";
import { decodeInput, type AbortReceipt, type Admission, type ConversationFrame, type InspectResult, type JsonObject, type Snapshot } from "./contract.mts";
import { ObservationManager, type AvailabilityListener } from "./observation.mts";
import { RetainedReader } from "./retained-read.mts";
import { retainedReaderPath } from "../server/agent-start.mts";
export { AgentError, HostLink } from "./client.mts";
export { AgentCatalog, deriveEndpoint, readClaim } from "./catalog.mts";
export type { CatalogPage, CatalogRecord, CatalogScan, CatalogRow } from "./catalog.mts";
export type { AbortReceipt, Admission, ConversationFrame, InspectResult, Snapshot } from "./contract.mts";
export type { SubmitInput } from "./client.mts";
export type { AvailabilityListener, AvailabilityState } from "./observation.mts";

export interface AgentServiceOptions {
  store: string;
  installationId: string;
  agentDir?: string;
  onRoster?: (page: CatalogPage) => void;
  onFrame?: (workspaceId: string, identity: string, connectionEpoch: number, frame: ConversationFrame) => void;
  onAvailability?: AvailabilityListener;
  frameProjection?: (frame: ConversationFrame) => ConversationFrame;
}
export interface HistoryOptions { before?: number; limit?: number; maxBytes?: number }
export interface InspectOptions {
  view: "history" | "activity" | "exact" | "result";
  cursor?: JsonObject; limit?: number; entryId?: number; offset?: number; submissionId?: number; requestId?: string; operationId?: string;
}
export interface UnavailableConfiguration { available: false; reason: string }
interface InputRecord { identity: string; input: SubmitInput; digest: string; promise: Promise<Admission>; link?: HostLink }
function inspectionSelectors(options: InspectOptions, params: JsonObject): void {
  for (const field of ["entryId", "submissionId"] as const) if (options[field] !== undefined) { positive(options[field], field); params[field] = options[field]; }
  for (const field of ["requestId", "operationId"] as const) if (options[field] !== undefined) {
    const value = options[field];
    if (typeof value !== "string" || !value.length || value.length > 1024) throw new AgentError("invalid_request", `Invalid ${field}.`);
    params[field] = value;
  }
  if (options.requestId !== undefined && options.view !== "result") throw new AgentError("invalid_request", "Request IDs select only result inspection.");
  if (options.view === "result" && options.submissionId === undefined && options.requestId === undefined && options.operationId === undefined) throw new AgentError("invalid_request", "Result inspection requires a submission, request or operation ID.");
}
function inspectionParams(identity: string, options: InspectOptions): JsonObject {
  if (!["history", "activity", "exact", "result"].includes(options.view)) throw new AgentError("invalid_request", "Unsupported inspection view.");
  const params: JsonObject = {sessionId: identity, view: options.view}; inspectionSelectors(options, params);
  if (options.limit !== undefined) { bounded(options.limit, 1, 100, "Inspection limit"); params.limit = options.limit; }
  if (options.offset !== undefined) { bounded(options.offset, 0, Number.MAX_SAFE_INTEGER, "Inspection offset"); params.offset = options.offset; }
  if (options.cursor !== undefined) {
    if (!options.cursor || typeof options.cursor !== "object" || Array.isArray(options.cursor) || Buffer.byteLength(JSON.stringify(options.cursor)) > 4096) throw new AgentError("invalid_request", "Invalid inspection cursor.");
    params.cursor = options.cursor;
  }
  if (options.view === "exact" && options.entryId === undefined) throw new AgentError("invalid_request", "Exact inspection requires an entry ID.");
  return params;
}

/** Live links attach only. Independent retained reads never acquire an execution owner. */
export class AgentService {
  readonly #catalog: AgentCatalog;
  readonly #installationId: string;
  readonly #observations: ObservationManager;
  readonly #reader: RetainedReader;
  readonly #links = new Map<string, Promise<HostLink>>();
  readonly #inputs = new Map<string, InputRecord>();
  #closed = false;
  #closing?: Promise<void>;
  constructor(options: AgentServiceOptions, catalogFactory: (options: ConstructorParameters<typeof AgentCatalog>[0]) => AgentCatalog = options => new AgentCatalog(options), readerFactory: (options: ConstructorParameters<typeof RetainedReader>[0]) => RetainedReader = options => new RetainedReader(options)) {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(options.installationId)) throw new AgentError("invalid_request", "Invalid UI installation identity.");
    this.#installationId = options.installationId;
    this.#reader = readerFactory({store:options.store,reader:() => retainedReaderPath(options.agentDir)});
    this.#catalog = catalogFactory({ store: options.store, onChange: options.onRoster });
    this.#observations = new ObservationManager({ getLink: identity => this.#link(identity, true, true), onFrame: options.onFrame ?? (() => {}), onAvailability: options.onAvailability, projectFrame: options.frameProjection });
  }
  roster(options: { cursor?: string; limit?: number } = {}): CatalogPage { return this.#catalog.page(options); }
  refresh(scanId?: string): Promise<CatalogScan> { this.#ready(); return this.#catalog.refresh(scanId); }
  select(workspaceId: string, identity?: string, connectionEpoch?: number): Promise<void> { this.#ready(); return this.#observations.select(workspaceId, identity, connectionEpoch); }
  hide(workspaceId: string, identity?: string): Promise<void> { return this.#observations.hide(workspaceId, identity); }
  reconnect(workspaceId: string, identity: string, connectionEpoch?: number): Promise<void> {
    this.#ready();
    return this.#observations.reconnect(workspaceId, identity, connectionEpoch);
  }
  async prepare(identity: string): Promise<Record<string, boolean>> {
    this.#ready();
    const link = await this.#link(identity, true, true);
    if (!link.connected) throw new AgentError("host_unavailable", "Host connection is unavailable. Reconnect explicitly.");
    return link.capabilities();
  }
  async history(identity: string, options: HistoryOptions = {}, signal?: AbortSignal): Promise<Snapshot> {
    this.#ready();
    const params: JsonObject = { sessionId: identity, limit: 50, maxBytes: 65536 };
    if (options.before !== undefined) { positive(options.before, "History boundary"); params.before = options.before; }
    if (options.limit !== undefined) { bounded(options.limit, 1, 100, "History limit"); params.limit = options.limit; }
    if (options.maxBytes !== undefined) { bounded(options.maxBytes, 1, 1048576, "History byte target"); params.maxBytes = options.maxBytes; }
    signal?.throwIfAborted();
    let link: HostLink | undefined;
    try { link = await this.#link(identity); return (await link.request("snapshot", params, { identity })) as Snapshot; }
    catch (error) {
      if (!retainedEligible(error, link !== undefined)) throw error;
      this.#ready();
      const {sessionId: _target, ...readParams} = params;
      return this.#reader.request("snapshot", identity, readParams, signal);
    }
  }
  async inspect(identity: string, options: InspectOptions, signal?: AbortSignal): Promise<InspectResult> {
    this.#ready();
    const params = inspectionParams(identity, options);
    validateInspectParams(params, identity);
    signal?.throwIfAborted();
    let link: HostLink | undefined;
    try { link = await this.#link(identity); return (await link.request("inspect", params, { identity, ...(options.requestId === undefined ? {} : {requestId: options.requestId}) })) as InspectResult; }
    catch (error) {
      if (!retainedEligible(error, link !== undefined)) throw error;
      this.#ready();
      const {sessionId: _target, ...readParams} = params;
      return this.#reader.request("inspect", identity, readParams, signal);
    }
  }
  submit(identity: string, input: SubmitInput): Promise<Admission> {
    this.#ready();
    try { validateSubmitInput(input); this.#record(identity); } catch (error) { return Promise.reject(error); }
    const digest = JSON.stringify({ identity, ...input });
    const prior = this.#inputs.get(input.operationId);
    if (prior) {
      if (prior.digest !== digest) return Promise.reject(new AgentError("operation_conflict", "Agent operation key was reused with changed input or target."));
      return prior.promise;
    }
    if (this.#inputs.size >= 2048) return Promise.reject(new AgentError("capacity", "Agent input receipt cache is full."));
    const captured = { ...input };
    const promise = this.#link(identity).then(link => {
      const record = this.#inputs.get(input.operationId);
      if (record) record.link = link;
      return link.submit(identity, captured, this.#installationId);
    });
    this.#inputs.set(input.operationId, { identity, input: captured, digest, promise });
    return promise;
  }
  /** Explicit reconciliation alone repeats the original native admission key and captured payload. */
  async retrySubmit(identity: string, input: SubmitInput): Promise<Admission> {
    this.#ready();
    validateSubmitInput(input);
    const prior = this.#inputs.get(input.operationId);
    if (prior && prior.digest !== JSON.stringify({ identity, ...input })) throw new AgentError("operation_conflict", "Reconciliation changed the captured input.");
    let link = await this.#link(identity, true);
    if (prior?.link === link) {
      await this.#discardLink(this.#record(identity).storageId);
      link = await this.#link(identity, true);
    }
    const requestId = `ui:${input.operationId}`;
    const params = { sessionId: identity, message: input.message, origin: "operator", requester: `ui:${this.#installationId}`, replyTo: identity, requestId, whenBusy: input.mode };
    // Reuse HostLink's local validation and key comparison before any explicit remote repetition.
    if (!prior) return this.submit(identity, input);
    const promise = link.request("task-submit", params, { identity, requestId, wireRequestId: requestId }) as Promise<Admission>;
    prior.promise = promise; prior.link = link; return promise;
  }
  async abort(identity: string): Promise<AbortReceipt> {
    this.#ready();
    return (await (await this.#link(identity)).request("abort", { sessionId: identity, background: false }, { identity })) as AbortReceipt;
  }
  configure(_identity: string, _options?: unknown): UnavailableConfiguration {
    return { available: false, reason: "Agent configuration is available through the primary agent command, not this UI adapter." };
  }
  /** Last browser detach releases observation and transport, not admitted Durable work. */
  async disconnectWorkspace(workspaceId: string): Promise<void> {
    await this.hide(workspaceId);
    const active = new Set(this.#observations.identities().map(identity => this.#record(identity).storageId));
    const unused: Promise<void>[] = [];
    for (const [key, pending] of this.#links) if (!active.has(key)) {
      this.#links.delete(key); unused.push(pending.then(link => link.close(), () => {}));
    }
    await Promise.all(unused);
  }
  #record(identity: string): CatalogRecord {
    if (typeof identity !== "string" || identity.length > 512 || /[\u0000-\u001f\u007f/\\]/.test(identity)) throw new AgentError("invalid_request", "Invalid agent identity.");
    const colon = identity.lastIndexOf(":");
    const storageId = colon < 0 ? identity : identity.slice(0, colon);
    if (colon >= 0 && (!/^[1-9]\d*$/.test(identity.slice(colon + 1)) || !Number.isSafeInteger(Number(identity.slice(colon + 1))) || Number(identity.slice(colon + 1)) <= 1)) throw new AgentError("invalid_request", "Invalid conversation identity.");
    const record = this.#catalog.get(storageId);
    if (!record) throw new AgentError("host_unavailable", "Agent storage is not in the retained catalog. Refresh explicitly.");
    return record;
  }
  #checkReplacement(storageId: string, link: HostLink, protectObservation: boolean): void {
    if (!protectObservation || !link.connected) return;
    const active = new Set(this.#observations.identities(true).map(identity => this.#record(identity).storageId));
    if (active.has(storageId)) throw new AgentError("host_unavailable", "Retained host endpoint changed while observed. Reconnect the observation explicitly.");
  }
  async #link(identity: string, reconnect = false, protectObservation = false): Promise<HostLink> {
    this.#ready();
    const record = this.#record(identity);
    const endpoint = deriveEndpoint(record);
    const existing = this.#links.get(record.storageId);
    if (existing) {
      const link = await existing;
      if (this.#links.get(record.storageId) !== existing) return this.#link(identity, reconnect, protectObservation);
      const sameEndpoint = link.endpoint.serverId === endpoint.serverId && link.endpoint.socketPath === endpoint.socketPath;
      if (sameEndpoint && (link.connected || !reconnect)) return link;
      if (!reconnect) throw new AgentError("host_unavailable", "Retained host endpoint changed. Reconnect explicitly.");
      this.#checkReplacement(record.storageId, link, protectObservation);
      this.#links.delete(record.storageId); await link.close();
      if (this.#links.has(record.storageId)) return this.#link(identity, reconnect, protectObservation);
    }
    if (this.#links.size >= 32) throw new AgentError("capacity", "Host link capacity reached.");
    const pending = (async () => {
      const claim = await readClaim(record);
      if (claim.state !== "live") throw new AgentError(claim.state === "unknown" ? "host_unavailable" : "stored", "Stored metadata; no live compatible host.");
      const link = await HostLink.connect(endpoint);
      if (this.#closed) { await link.close(); throw new AgentError("not_ready", "Host connection attempt is obsolete."); }
      return link;
    })();
    this.#links.set(record.storageId, pending);
    return this.#trackLink(record.storageId, pending);
  }
  async #discardLink(storageId: string): Promise<void> {
    const pending = this.#links.get(storageId);
    this.#links.delete(storageId);
    if (pending) await pending.then(link => link.close(), () => {});
  }
  async #trackLink(storageId: string, pending: Promise<HostLink>): Promise<HostLink> {
    try { return await pending; }
    catch (error) {
      if (this.#links.get(storageId) === pending) this.#links.delete(storageId);
      throw error;
    }
  }
  #ready(): void { if (this.#closed) throw new AgentError("not_ready", "Agent service is closed."); }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      try {
        await this.#observations.close(async () => {
          const closed = await Promise.allSettled([this.#reader.close(),
            ...[...this.#links.values()].map(pending => pending.then(link => link.close(), () => {}))]);
          const failed = closed.find(result => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        });
      } finally { this.#links.clear(); await this.#catalog.close(); }
    })();
    return this.#closing;
  }
}
function retainedEligible(error: unknown, linked: boolean): boolean {
  return error instanceof AgentError && (["stored", "host_unavailable", "contract_mismatch"].includes(error.code) || !linked && error.code === "protocol_error");
}
function validateInspectParams(params: JsonObject, identity: string): void {
  try { decodeInput("inspect", params, { identity }); }
  catch (error) { throw new AgentError("invalid_request", error instanceof Error ? error.message : "Invalid result selector."); }
}
function bounded(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new AgentError("invalid_request", `${name} is outside its bound.`);
}
function positive(value: number, name: string): void { bounded(value, 1, Number.MAX_SAFE_INTEGER, name); }
export function createAgentService(options: AgentServiceOptions): AgentService { return new AgentService(options); }
