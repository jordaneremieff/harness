import { AgentCatalog, deriveEndpoint, readClaim, type CatalogPage, type CatalogRecord, type CatalogScan } from "./catalog.mts";
import { AgentError, HostLink, type SubmitInput } from "./client.mts";
import { captureSubmitInput, submitInputDigest, type NativeInputMessage, type NativeInputPart } from "./input.mts";
import { readVerifiedDraftImages, verifiedImageReferences } from "../server/draft-images.mts";
import { imageMessageDigest, imageReferenceMessage } from "../server/images.mts";
import { isAbsolute } from "node:path";
import { decodeInput, type AbortReceipt, type Admission, type CommandResult, type ConversationFrame, type HostInventory, type InspectResult, type JsonObject, type Snapshot, type StatusReply, type ThreadList, type ThreadPage } from "./contract.mts";
import { ObservationManager, type AvailabilityListener } from "./observation.mts";
import { RetainedReader } from "./retained-read.mts";
import { retainedReaderPath } from "../server/agent-start.mts";
export { AgentError, HostLink } from "./client.mts";
export { AgentCatalog, deriveEndpoint, readClaim } from "./catalog.mts";
export type { CatalogPage, CatalogRecord, CatalogScan, CatalogRow } from "./catalog.mts";
export type { AbortReceipt, Admission, CommandResult, ConversationFrame, HostInventory, InspectResult, Snapshot, ThreadEvent, ThreadFrame, ThreadList, ThreadMember, ThreadPage, ThreadRecord, ThreadSummary } from "./contract.mts";
export type { SubmitInput } from "./client.mts";
export type { AvailabilityListener, AvailabilityState } from "./observation.mts";

export interface AgentServiceOptions {
  store: string;
  stateDir: string;
  installationId: string;
  agentDir?: string;
  onRoster?: (page: CatalogPage) => void;
  onFrame?: (workspaceId: string, identity: string, connectionEpoch: number, frame: ConversationFrame) => void;
  onAvailability?: AvailabilityListener;
  frameProjection?: (frame: ConversationFrame) => ConversationFrame;
  onImageInput?: (storageId: string, identity: string | undefined, available: boolean) => void;
}
export interface HistoryOptions { before?: number; limit?: number; maxBytes?: number }
export interface ThreadListOptions { cursor?: string; limit?: number; query?: string }
export interface ThreadReadOptions { limit?: number; before?: number }
export interface InspectOptions {
  view: "history" | "activity" | "exact" | "result";
  cursor?: JsonObject; source?: 'user'; limit?: number; entryId?: number; offset?: number; submissionId?: number; requestId?: string; operationId?: string;
}
export interface UnavailableConfiguration { available: false; reason: string }
export interface CommandInput { operationId: string; name: string; args?: string }
interface InputRecord { identity: string; input: SubmitInput; digest: string; promise: Promise<Admission>; pending: boolean; link?: HostLink }
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
  if(options.source!==undefined){if(options.view!=='history'||options.source!=='user')throw new AgentError('invalid_request','Source selects user history only.');params.source=options.source;}
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
  readonly #stateDir: string;
  readonly #onImageInput: NonNullable<AgentServiceOptions["onImageInput"]>;
  readonly #imageDispatches = new Set<string>();
  readonly #observations: ObservationManager;
  readonly #reader: RetainedReader;
  readonly #links = new Map<string, Promise<HostLink>>();
  readonly #inputs = new Map<string, InputRecord>();
  #closed = false;
  #closing?: Promise<void>;
  constructor(options: AgentServiceOptions, catalogFactory: (options: ConstructorParameters<typeof AgentCatalog>[0]) => AgentCatalog = options => new AgentCatalog(options), readerFactory: (options: ConstructorParameters<typeof RetainedReader>[0]) => RetainedReader = options => new RetainedReader(options)) {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(options.installationId)) throw new AgentError("invalid_request", "Invalid UI installation identity.");
    if (typeof options.stateDir !== "string" || !isAbsolute(options.stateDir)) throw new AgentError("invalid_request", "An absolute image state directory is required.");
    this.#installationId = options.installationId;
    this.#stateDir = options.stateDir;
    this.#onImageInput = options.onImageInput ?? (() => {});
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
    const images = link.supports("task-submit");
    this.#onImageInput(this.#record(identity).storageId, identity, images);
    return {...link.capabilities(), images};
  }
  async history(identity: string, options: HistoryOptions = {}, signal?: AbortSignal): Promise<Snapshot> {
    this.#ready();
    const params: JsonObject = { sessionId: identity, limit: 50, maxBytes: 65536 };
    if (options.before !== undefined) { positive(options.before, "History boundary"); params.before = options.before; }
    if (options.limit !== undefined) { bounded(options.limit, 1, 100, "History limit"); params.limit = options.limit; }
    if (options.maxBytes !== undefined) { bounded(options.maxBytes, 1, 1048576, "History byte target"); params.maxBytes = options.maxBytes; }
    signal?.throwIfAborted();
    let link: HostLink | undefined;
    try { link = await this.#link(identity); return (await link.request("snapshot", params, { identity }, signal)) as Snapshot; }
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
  /** Threads live in the storage that created them; the identity selects that storage's live host. No retained fallback exists. */
  async threads(identity: string, options: ThreadListOptions = {}, signal?: AbortSignal): Promise<ThreadList> {
    this.#ready();
    const params: JsonObject = {};
    if (options.cursor !== undefined) params.cursor = options.cursor;
    if (options.limit !== undefined) params.limit = options.limit;
    if (options.query !== undefined) params.query = options.query;
    validateThreadParams("collaboration-list", params);
    signal?.throwIfAborted();
    return (await (await this.#threadLink(identity)).request("collaboration-list", params, {}, signal)) as ThreadList;
  }
  async thread(identity: string, threadId: string, options: ThreadReadOptions = {}, signal?: AbortSignal): Promise<ThreadPage> {
    this.#ready();
    const params: JsonObject = { threadId };
    if (options.limit !== undefined) params.limit = options.limit;
    if (options.before !== undefined) params.before = options.before;
    validateThreadParams("collaboration-read", params);
    if (threadId.split("/")[0] !== this.#record(identity).storageId) throw new AgentError("invalid_request", "The thread belongs to a different agent storage.");
    signal?.throwIfAborted();
    return (await (await this.#threadLink(identity)).request("collaboration-read", params, {}, signal)) as ThreadPage;
  }
  /** An absent or unequal thread operation identity is `threads_unavailable`, distinct from transport and read failures. */
  async #threadLink(identity: string): Promise<HostLink> {
    const link = await this.#link(identity);
    try { link.require(["collaboration-list", "collaboration-read"]); }
    catch (error) {
      if (error instanceof AgentError && error.code === "contract_mismatch") throw new AgentError("threads_unavailable", error.message);
      throw error;
    }
    return link;
  }
  submit(identity: string, input: SubmitInput): Promise<Admission> { return this.#input(identity, input, false); }
  /** Explicit reconciliation repeats only the captured key and freshly verified content. */
  retrySubmit(identity: string, input: SubmitInput): Promise<Admission> { return this.#input(identity, input, true); }
  #input(identity: string, input: SubmitInput, retry: boolean): Promise<Admission> {
    try {
      this.#ready();
      const captured = captureSubmitInput(input), storageId = this.#record(identity).storageId;
      const digest = submitInputDigest(identity, captured), prior = this.#inputs.get(captured.operationId);
      if (prior && prior.digest !== digest) throw new AgentError("operation_conflict", "Agent operation key was reused with changed input or target.");
      if (prior && (!retry || prior.pending)) return prior.promise;
      if (!prior && this.#inputs.size >= 2048) throw new AgentError("capacity", "Agent input receipt cache is full.");
      if (captured.images.length && this.#imageDispatches.has(storageId)) throw new AgentError("capacity", "This storage already has an image input in progress.");
      if (captured.images.length) this.#imageDispatches.add(storageId);
      let record: InputRecord;
      const promise = Promise.resolve().then(() => this.#dispatch(record, retry)).finally(() => {
        record.pending = false;
        if (captured.images.length) this.#imageDispatches.delete(storageId);
      });
      record = {identity, input: prior?.input ?? captured, digest, pending: true, promise, link: prior?.link};
      this.#inputs.set(captured.operationId, record);
      return record.promise;
    } catch (error) { return Promise.reject(error); }
  }
  async #dispatch(record: InputRecord, retry: boolean): Promise<Admission> {
    const {identity, input} = record;
    let link = await this.#link(identity, retry);
    if (retry && record.link === link) {
      await this.#discardLink(this.#record(identity).storageId);
      link = await this.#link(identity, true);
    }
    record.link = link;
    link.require(["task-submit"]);
    this.#ready();
    const message = await this.#nativeMessage(input, link.capabilities().images === true);
    this.#ready();
    try {
      const admission = {...await link.submit(identity, {operationId: input.operationId, message, mode: input.mode}, this.#installationId)};
      delete admission.sentImageMessageDigest;
      if (input.images.length && typeof message === 'string') admission.sentImageMessageDigest = imageMessageDigest(message);
      return admission;
    }
    finally {
      if (!link.connected || !link.supports("task-submit")) this.#onImageInput(this.#record(identity).storageId, undefined, false);
    }
  }
  async #nativeMessage(input: SubmitInput, acceptsImages: boolean): Promise<NativeInputMessage> {
    if (!input.images.length) return input.message;
    if (!acceptsImages) {
      const paths=await verifiedImageReferences({root:this.#stateDir,targetKey:input.targetKey,images:input.images});
      return imageReferenceMessage(input.message, input.images, paths);
    }
    const images = await readVerifiedDraftImages({root: this.#stateDir, targetKey: input.targetKey, images: input.images});
    const parts: NativeInputPart[] = input.message.length ? [{type: "text", text: input.message}] : [];
    for (let i = 0; i < images.length; i++) parts.push({type: "image", mimeType: input.images[i].mimeType, data: Buffer.from(images[i].data).toString("base64")});
    return parts;
  }
  /** The installed commands of the agent's live host. A host that is not live, or has no inventory, is `commands_unavailable`. */
  async inventory(identity: string, signal?: AbortSignal): Promise<HostInventory> {
    this.#ready();
    signal?.throwIfAborted();
    const link = await this.#link(identity);
    this.#requireCommands(link, ["status"]);
    const reply = (await link.request("status", { sessionId: identity }, { identity }, signal)) as StatusReply;
    if (!reply.inventory) throw new AgentError("commands_unavailable", "The host reported no command inventory.");
    return reply.inventory;
  }
  /** Runs one contribution command once. The call is never repeated: a lost connection leaves the outcome unknown. */
  async command(identity: string, input: CommandInput): Promise<CommandResult> {
    this.#ready();
    if (!input || typeof input.operationId !== "string" || !/^[a-zA-Z0-9._:-]{1,120}$/.test(input.operationId)) throw new AgentError("invalid_request", "Invalid command operation.");
    const params: JsonObject = { sessionId: identity, name: input.name, invocationId: `ui:${input.operationId}` };
    if (input.args !== undefined) params.args = input.args;
    try { decodeInput("command", params, { identity }); }
    catch (error) { throw new AgentError("invalid_request", error instanceof Error ? error.message : "Invalid command request."); }
    const link = await this.#link(identity);
    this.#requireCommands(link, ["command"]);
    try { return (await link.request("command", params, { identity })) as CommandResult; }
    catch (error) {
      if (error instanceof AgentError || !link.connected || !hostAnswered(error)) throw error;
      throw new AgentError("command_refused", error.message.slice(0, 512));
    }
  }
  #requireCommands(link: HostLink, members: ("status" | "command")[]): void {
    try { link.require(members); }
    catch (error) {
      if (error instanceof AgentError && error.code === "contract_mismatch") throw new AgentError("commands_unavailable", error.message);
      throw error;
    }
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
      this.#links.delete(key); this.#onImageInput(key, undefined, false); unused.push(pending.then(link => link.close(), () => {}));
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
      this.#links.delete(record.storageId); this.#onImageInput(record.storageId, undefined, false); await link.close();
      if (this.#links.has(record.storageId)) return this.#link(identity, reconnect, protectObservation);
    }
    if (this.#links.size >= 32) throw new AgentError("capacity", "Host link capacity reached.");
    const pending = (async () => {
      const claim = await readClaim(record);
      if (claim.state !== "live") throw new AgentError(claim.state === "unknown" ? "host_unavailable" : "stored", "Stored metadata; no live compatible host.");
      const link = await HostLink.connect(endpoint);
      if (this.#closed) { await link.close(); throw new AgentError("not_ready", "Host connection attempt is obsolete."); }
      link.onDisconnect(() => {
        if (this.#links.get(record.storageId) === pending) this.#onImageInput(record.storageId, undefined, false);
      });
      return link;
    })();
    this.#links.set(record.storageId, pending);
    return this.#trackLink(record.storageId, pending);
  }
  async #discardLink(storageId: string): Promise<void> {
    const pending = this.#links.get(storageId);
    this.#links.delete(storageId); this.#onImageInput(storageId, undefined, false);
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
    for (const storageId of this.#links.keys()) this.#onImageInput(storageId, undefined, false);
    this.#closing = (async () => {
      try {
        await this.#observations.close(async () => {
          const closed = await Promise.allSettled([this.#reader.close(),
            ...[...this.#links.values()].map(pending => pending.then(link => link.close(), () => {}))]);
          const failed = closed.find(result => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        });
      } finally {
        await Promise.allSettled([...this.#inputs.values()].map(record => record.promise));
        this.#links.clear(); await this.#catalog.close();
      }
    })();
    return this.#closing;
  }
}
/** The host replied with an error. A lost connection, cancellation or release says nothing about whether the command ran. */
function hostAnswered(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return false;
  const reason = "reason" in error ? error.reason : undefined;
  return ["invalid", "forbidden", "not_ready", "unavailable"].includes(error.code) && reason !== "transport";
}
function retainedEligible(error: unknown, linked: boolean): boolean {
  return error instanceof AgentError && (["stored", "host_unavailable", "contract_mismatch"].includes(error.code) || !linked && error.code === "protocol_error");
}
function validateInspectParams(params: JsonObject, identity: string): void {
  try { decodeInput("inspect", params, { identity }); }
  catch (error) { throw new AgentError("invalid_request", error instanceof Error ? error.message : "Invalid result selector."); }
}
function validateThreadParams(member: "collaboration-list" | "collaboration-read", params: JsonObject): void {
  try { decodeInput(member, params); }
  catch (error) { throw new AgentError("invalid_request", error instanceof Error ? error.message : "Invalid thread request."); }
}
function bounded(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new AgentError("invalid_request", `${name} is outside its bound.`);
}
function positive(value: number, name: string): void { bounded(value, 1, Number.MAX_SAFE_INTEGER, name); }
export function createAgentService(options: AgentServiceOptions): AgentService { return new AgentService(options); }
