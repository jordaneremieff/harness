/**
 * agent/durable-host: the process-local control and observation runtime for one
 * Pi Durable storage.
 *
 * A host owns one SQLite file and one Harness for its lifetime. Callers reach it
 * through `request(method, params)` with JSON-safe parameters, so a runner can
 * serve the same methods in-process or over any transport. The runtime takes
 * every scheduling, checkpoint, replay, and notification decision from Pi
 * Durable; it decodes no private SQL and opens no ordinary session.
 *
 * The caller owns the exclusive writer claim for the storage file. This class
 * does not arbitrate a second writer and reports no recovery guarantee for
 * power loss. `DurableObservation` reads a cold copy of the same file without a
 * writer claim.
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { Harness, ROOT_CONVERSATION_ID, UsageDoc, type AgentChange, type Conversation, type ConversationId, type EntryId, type HarnessInspection, type HarnessOptions, type ModelRef, type SubmissionId, type TaskGraph } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acknowledgeDeliveries, acknowledgeReports, AgentDeliveryDoc, AgentForkDoc, AgentMetaDoc, abortConversation, compactConversation, configureConversation, forkConversation, pendingDeliveries, readOutcome, reconcileDeliveries, recordReport, rewindConversation, submitConversation, undeliveredForOwner, waitForReceipts, type DeliveryOrigin, type DeliveryReceipt, type DurableConfigureParams, type DurableRunOutcome, type DurableSubmitParams, type DurableSubmitResult } from "./durable-controls.ts";
import { durableIdentity, optionalParam, parseInspectParams, readConversationList, readConversationSnapshot, readConversationStatus, readDashboard, readInspection, readReceipts, readUsage, requestBoolean, requestInteger, requestPositiveId, requestRequiredId, requestRequiredString, requestString, resolveSessionConversationId, type ConversationStatus, type DurableDashboardOptions, type DurableListParams, type DurableStatusOptions, type RequestParams } from "./durable-observation.ts";
import type { DurableCommand, DurableContributionHost } from "./durable-services.ts";

export type { AgentConversationSnapshot, AgentConversationSummary } from "./dashboard-types.ts";
export type { ConfigurationResult } from "./configuration.ts";
export type { AgentDeliveryState, AgentMeta, DeliveryIntent, DeliveryReceipt, DeliveryReport, DurableConfigureParams, DurableRunOutcome, DurableSubmitParams, DurableSubmitResult } from "./durable-controls.ts";
export type { ConversationStatus, ConversationSummary, DurableInspectParams, DurableListParams, DurableStatusOptions, RequestParams } from "./durable-observation.ts";
export type { DurableCommandCall, DurableCommand as DurableContributionCommand } from "./durable-services.ts";
export { AgentDeliveryDoc, AgentForkDoc, AgentMetaDoc };

/** The services bootstrap's contribution host, passed to a command call. */
export type DurableCommandHost = DurableContributionHost;

/** One command a Durable contribution registers for the `command` request. */
export type DurableHostCommand = DurableCommand;

export interface DurableHostOptions {
	/** SQLite file this host owns for its lifetime. The caller owns the writer claim. */
	readonly storagePath: string;
	/** External identity of this storage; the root conversation's identity is this value. */
	readonly storageId: string;
	/** Working directory the storage directory represents, used by status and dashboard defaults. */
	readonly cwd?: string;
	/** Durable host configuration: the process registry whose extensions resolve tools and sections. */
	readonly registry: HarnessOptions["registry"];
	readonly settings?: HarnessOptions["settings"];
	readonly env?: HarnessOptions["env"];
	/** Model access. `ModelRuntime` already implements this interface. */
	readonly models: Models;
	/** Root-conversation agent choices, including the model. Applied when the root is created; ignored on an existing root. */
	readonly agent?: AgentChange;
	/** Root conversation metadata, applied when the root is created. */
	readonly meta?: { readonly name?: string; readonly owner?: string };
	/** Commands contributed to Durable agents, invoked by the `command` request. */
	readonly commands?: readonly DurableHostCommand[] | ReadonlyMap<string, DurableHostCommand>;
	/** The services bootstrap's contribution host, passed to each command's fourth argument. */
	readonly contributionHost?: DurableContributionHost;
	/** Start scheduling unfinished work on open. Default true. */
	readonly resume?: boolean;
	/** Resolved generation retry ceiling (`maxRetries + 1`) for dashboard auto-retry health. */
	readonly retryMaxAttempts?: number;
	readonly onReport?: HarnessOptions["onReport"];
}

/** A request arrived after close, or a long wait was interrupted by close. */
export class DurableHostClosedError extends Error {
	constructor() {
		super("durable host is closed");
		this.name = "DurableHostClosedError";
	}
}

/** Default byte bound for one transcript read, independent of the entry-count bound. */
export const TRANSCRIPT_MAX_BYTES = 16 * 1024;

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function modelRefFrom(value: unknown): ModelRef | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "object" || value === null) throw new TypeError("model must be an object or null");
	const candidate = value as { provider?: unknown; modelId?: unknown };
	if (typeof candidate.provider !== "string" || candidate.provider === "" || typeof candidate.modelId !== "string" || candidate.modelId === "") {
		throw new TypeError("model requires non-empty provider and modelId strings");
	}
	return { provider: candidate.provider, modelId: candidate.modelId };
}

function messageFrom(value: unknown): DurableSubmitParams["message"] {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const part of value) {
			if (part === null || typeof part !== "object" || typeof (part as { type?: unknown }).type !== "string") throw new TypeError("message parts require a type");
		}
		return value as DurableSubmitParams["message"];
	}
	throw new TypeError("message must be a string or a content-part array");
}

function validateTranscriptBounds(limit: number, maxBytes: number): void {
	if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`transcript limit must be a non-negative integer, received ${String(limit)}`);
	if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new RangeError(`transcript maxBytes must be a non-negative integer, received ${String(maxBytes)}`);
}

/** Name the bound that omitted older entries, or the empty string when none did. */
function transcriptMarker(byteOmitted: boolean, countOmitted: boolean, limit: number, maxBytes: number): string {
	if (byteOmitted) return `[transcript truncated at ${maxBytes} bytes]`;
	if (countOmitted) return `[transcript limited to ${limit} ${limit === 1 ? "entry" : "entries"}]`;
	return "";
}

/** Keep the newest lines that fit, reserving room for an already-selected notice. */
function boundTranscript(lines: readonly string[], maxBytes: number, notice: string): string {
	const reserve = notice === "" ? 0 : Buffer.byteLength(notice) + 1;
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const size = Buffer.byteLength(line) + 1;
		if (bytes + size > maxBytes - reserve) break;
		bytes += size;
		kept.push(line);
	}
	const text = kept.reverse().join("\n");
	return notice === "" ? text : `${text}\n${notice}`;
}

function messageText(messages: readonly { readonly content?: unknown }[] | undefined): string {
	if (!messages) return "";
	return messages.flatMap((message) => {
		const content = message.content;
		if (typeof content === "string") return [content];
		if (!Array.isArray(content)) return [];
		return content.flatMap((part) => (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
	}).join("");
}

/**
 * True when a committed session holds no work a host must stay alive for.
 *
 * Every native live task counts: running, pending, completing, and waiting,
 * including a task waiting with no task dependencies because it may await an
 * external effect. Every unsettled submission counts.
 */
export function sessionIsIdle(graph: TaskGraph, inspection: HarnessInspection): boolean {
	return Object.keys(graph.tasks).length === 0 && inspection.submissions.length === 0;
}

/**
 * Process-local Durable runtime for one storage. `open()` resumes unfinished
 * work by default and creates the root conversation when it is absent.
 */
export class DurableHost {
	/** The open Harness, for in-process contribution work that this runtime does not wrap. */
	readonly harness: Harness;
	readonly storageId: string;
	private readonly rootConversation: Conversation;
	private readonly commands: ReadonlyMap<string, DurableHostCommand>;
	private readonly contributionHost: DurableContributionHost | undefined;
	private readonly models: Models;
	private readonly storagePath: string;
	private readonly lifecycle = new AbortController();
	private closed = false;
	private idleValue = false;
	private idleDirty = true;
	private commitGeneration = 0;
	private readonly defaultCwd: string | undefined;
	private readonly retryMaxAttempts: number | undefined;

	private constructor(harness: Harness, storageId: string, root: Conversation, commands: readonly DurableHostCommand[] | ReadonlyMap<string, DurableHostCommand>, contributionHost: DurableContributionHost | undefined, cwd: string | undefined, models: Models, storagePath: string, retryMaxAttempts: number | undefined) {
		this.harness = harness;
		this.storageId = storageId;
		this.rootConversation = root;
		this.models = models;
		this.storagePath = storagePath;
		this.retryMaxAttempts = retryMaxAttempts;
		const commandMap = new Map<string, DurableHostCommand>();
		if (Array.isArray(commands)) for (const command of commands as readonly DurableHostCommand[]) commandMap.set(command.name, command);
		else for (const [name, command] of commands as ReadonlyMap<string, DurableHostCommand>) commandMap.set(name, command);
		this.commands = commandMap;
		this.contributionHost = contributionHost;
		this.defaultCwd = cwd;
		// A commit may add or remove work; the cached idle result is stale until the refresh settles.
		harness.subscribeCommits(() => {
			this.commitGeneration += 1;
			this.idleDirty = true;
			queueMicrotask(() => {
				void this.refreshIdle().catch(() => {
					this.idleDirty = true;
				});
			});
		});
	}

	/**
	 * Conservative synchronous idle check: false while an inspection refresh is
	 * pending, so a race cannot retire a host that just admitted work.
	 */
	get idle(): boolean {
		return !this.closed && !this.idleDirty && this.idleValue;
	}

	isIdle(): boolean {
		return this.idle;
	}

	/**
	 * Refresh the idle cache from committed task state and submissions. Every
	 * live task counts, including one waiting with no dependencies: a host must
	 * not retire while an external effect may still resume it. Unsettled
	 * submissions count.
	 */
	async refreshIdle(context: Context = BACKGROUND_CONTEXT): Promise<boolean> {
		if (this.closed) return false;
		const generation = this.commitGeneration;
		const inspection = await this.harness.inspect(context);
		const graphState = await this.harness.taskGraph(context);
		let value: boolean;
		try {
			value = sessionIsIdle(graphState.value, inspection);
		} finally {
			graphState.dispose();
		}
		this.idleValue = value;
		if (generation === this.commitGeneration) this.idleDirty = false;
		return value && !this.idleDirty;
	}

	static async open(options: DurableHostOptions, context: Context = BACKGROUND_CONTEXT): Promise<DurableHost> {
		const storage = await openNodeSqliteStorage(options.storagePath);
		let harness: Harness;
		try {
			harness = await Harness.open(
				storage,
				{
					models: options.models,
					registry: options.registry,
					...(options.settings === undefined ? {} : { settings: options.settings }),
					...(options.env === undefined ? {} : { env: options.env }),
					...(options.onReport === undefined ? {} : { onReport: options.onReport }),
				},
				context,
			);
		} catch (error) {
			try {
				await storage.close(BACKGROUND_CONTEXT);
			} catch {
				// Retain the open failure.
			}
			throw error;
		}
		try {
			if (options.resume !== false) harness.resume();
			const root = await harness.root(context, {
				...(options.agent === undefined ? {} : { agent: options.agent }),
				...(options.meta === undefined
					? {}
					: {
							init: async (tx, conversationId) => {
								const meta = await tx.doc(AgentMetaDoc, conversationId);
								if (options.meta?.name !== undefined) (meta as { name: string | null }).name = options.meta.name;
								if (options.meta?.owner !== undefined) (meta as { owner: string | null }).owner = options.meta.owner;
							},
						}),
			});
			if (options.resume !== false) await reconcileDeliveries(harness, context);
			const host = new DurableHost(harness, options.storageId, root, options.commands ?? [], options.contributionHost, options.cwd, options.models, options.storagePath, options.retryMaxAttempts);
			// A fresh host has no commit to trigger the subscriber; establish the idle cache now.
			await host.refreshIdle(context);
			return host;
		} catch (error) {
			try {
				await harness.close(BACKGROUND_CONTEXT);
			} catch {
				// Retain the open failure.
			}
			throw error;
		}
	}

	/** External identity of one conversation: the storage ID for the root, otherwise `storageId:conversationId`. */
	identity(conversationId?: ConversationId): string {
		if (conversationId === undefined || conversationId === ROOT_CONVERSATION_ID) return this.storageId;
		return durableIdentity(this.storageId, conversationId);
	}

	/** The root conversation handle. */
	root(): Conversation {
		return this.rootConversation;
	}

	/** Resolve one conversation by external identity or native ID. */
	async conversation(value: string | number | undefined, context: Context = BACKGROUND_CONTEXT): Promise<Conversation> {
		const conversationId = resolveSessionConversationId(this.storageId, typeof value === "string" ? value : undefined, typeof value === "number" ? value : undefined);
		const conversation = await this.harness.conversation(conversationId, context);
		if (!conversation) throw new Error(`conversation ${this.identity(conversationId)} does not exist`);
		return conversation;
	}

	private target(params: RequestParams | undefined, context: Context = BACKGROUND_CONTEXT): Promise<Conversation> {
		const conversationId = resolveSessionConversationId(this.storageId, requestString(params, "sessionId"), requestPositiveId(params?.conversationId, "conversationId"));
		return this.conversation(conversationId, context);
	}

	/**
	 * Transport-neutral dispatch. Every method returns a JSON-safe result and
	 * accepts only the parameters named in its signature. An unknown method or a
	 * malformed parameter rejects without changing state. A per-request
	 * `AbortSignal` cancels that request, including an abandoned `receipts` wait,
	 * without closing the host.
	 */
	async request(method: string, params?: RequestParams, context: Context | AbortSignal = BACKGROUND_CONTEXT): Promise<unknown> {
		if (this.closed) throw new DurableHostClosedError();
		const requestContext = context instanceof AbortSignal ? withAbortSignal(context, BACKGROUND_CONTEXT) : context;
		switch (method) {
			case "submit":
				return this.submitRequest(params, requestContext);
			case "receipts":
				return this.receiptsRequest(params, requestContext);
			case "report":
				return this.reportRequest(params, requestContext);
			case "acknowledge":
				return this.acknowledgeRequest(params, requestContext);
			case "inspect":
				return this.inspectRequest(params, requestContext);
			case "status":
				return this.statusRequest(params, requestContext);
			case "list":
				return this.listRequest(params, requestContext);
			case "fork":
				return this.forkRequest(params, requestContext);
			case "rewind":
				return this.rewindRequest(params, requestContext);
			case "abort":
				return this.abortRequest(params, requestContext);
			case "compact":
				return this.compactRequest(params, requestContext);
			case "configure":
				return this.configureRequest(params, requestContext);
			case "command":
				return this.commandRequest(params, requestContext);
			case "dashboard": {
				const conversationId = requestPositiveId(params?.conversationId, "conversationId");
				return readDashboard(this.harness, this.storageId, conversationId === undefined ? {} : { conversationId: conversationId as ConversationId }, this.dashboardOptions(params), requestContext);
			}
			case "snapshot":
				return this.snapshotRequest(params, requestContext);
			case "close":
				await this.close();
				return {};
			default:
				throw new TypeError(`unknown durable host method ${method}`);
		}
	}

	private dashboardOptions(params: RequestParams | undefined): DurableDashboardOptions {
		const cwd = requestString(params, "cwd");
		return {
			owner: "here",
			live: true,
			...(this.retryMaxAttempts === undefined ? {} : { retryMaxAttempts: this.retryMaxAttempts }),
			...(this.defaultCwd === undefined ? {} : { cwd: this.defaultCwd }),
			...(cwd === undefined ? {} : { cwd }),
		};
	}

	private async submitRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		const submitted = await submitConversation(
			conversation,
			{
				message: messageFrom(params?.message),
				requestId: requestRequiredString(params, "requestId"),
				...optionalParam("ownerId", requestString(params, "ownerId")),
				...optionalParam("whenBusy", this.busyMode(params)),
				...optionalParam("operationId", requestString(params, "operationId")),
				...optionalParam("origin", this.originParam(params)),
			},
			context,
		);
		return { ...submitted, identity: this.identity(conversation.id) };
	}

	private busyMode(params: RequestParams | undefined): "steer" | "followUp" | "reject" | undefined {
		const value = params?.whenBusy;
		if (value === undefined) return undefined;
		if (value === "steer" || value === "followUp" || value === "reject") return value;
		throw new TypeError("whenBusy must be steer, followUp, or reject");
	}

	/** Admission origin; an absent value keeps the model-origin default at delivery. */
	private originParam(params: RequestParams | undefined): DeliveryOrigin | undefined {
		const value = params?.origin;
		if (value === undefined) return undefined;
		if (value === "operator" || value === "model") return value;
		throw new TypeError("origin must be operator or model");
	}

	private async receiptsRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const ownerId = requestRequiredString(params, "ownerId");
		const wait = requestBoolean(params, "wait") ?? false;
		const deliveries = wait ? await waitForReceipts(this.harness, ownerId, context, this.lifecycle.signal) : await undeliveredForOwner(this.harness, ownerId, context);
		const pending = await pendingDeliveries(this.harness, ownerId, context);
		const usages = new Map<ConversationId, unknown>();
		const receipts = [];
		for (const receipt of deliveries.receipts) {
			if (!usages.has(receipt.conversationId)) usages.set(receipt.conversationId, (await this.harness.snapshot(UsageDoc, receipt.conversationId, context)) ?? null);
			receipts.push({ ...receipt, identity: this.identity(receipt.conversationId), usage: usages.get(receipt.conversationId) });
		}
		return { receipts, reports: deliveries.reports, pending };
	}

	private async reportRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const ownerId = requestRequiredString(params, "ownerId");
		const senderIdentity = requestRequiredString(params, "senderIdentity");
		const requestId = requestRequiredString(params, "requestId");
		const message = requestRequiredString(params, "message");
		const replyTo = requestString(params, "replyTo");
		const report = await recordReport(
			this.harness,
			{ ownerId, senderIdentity, requestId, message, ...(replyTo === undefined ? {} : { replyTo }) },
			context,
		);
		return { ...report };
	}

	private async acknowledgeRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const ownerId = requestRequiredString(params, "ownerId");
		const raw = params?.submissionIds;
		if (raw !== undefined && !Array.isArray(raw)) throw new TypeError("submissionIds must be an array");
		const sourceIds = params?.sourceIds;
		if (sourceIds !== undefined && !Array.isArray(sourceIds)) throw new TypeError("sourceIds must be an array");
		const ids = (raw ?? []).map((value) => requestRequiredId(value, "submissionIds[]"));
		const sources = (sourceIds ?? []).map((value) => {
			if (typeof value !== "string" || value === "") throw new TypeError("sourceIds[] must be a non-empty string");
			return value;
		});
		const acknowledged = await acknowledgeDeliveries(this.harness, ownerId, ids as SubmissionId[], context);
		const acknowledgedReports = await acknowledgeReports(this.harness, ownerId, sources, context);
		return { acknowledged, acknowledgedReports };
	}

	private async inspectRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		return readInspection(this.harness, this.storageId, conversation, parseInspectParams(params), context, {
			live: true,
			owner: "here",
			...(this.retryMaxAttempts === undefined ? {} : { retryMaxAttempts: this.retryMaxAttempts }),
		});
	}

	private async statusRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const sessionId = requestString(params, "sessionId");
		const conversationId = requestPositiveId(params?.conversationId, "conversationId");
		const options: DurableStatusOptions = this.defaultCwd === undefined ? {} : { cwd: this.defaultCwd };
		if (sessionId === undefined && conversationId === undefined) {
			const page = await this.harness.commit((tx) => tx.scanConversations({}, 50, undefined), context);
			const conversations: ConversationStatus[] = [];
			for (const record of page.items) {
				const status = await readConversationStatus(this.harness, this.storageId, record.id, options, context);
				if (status) conversations.push(status);
			}
			return { conversations };
		}
		const conversation = await this.target(params, context);
		const status = await readConversationStatus(this.harness, this.storageId, conversation.id, options, context);
		if (!status) throw new Error(`conversation ${this.identity(conversation.id)} does not exist`);
		return { conversation: status };
	}

	private async listRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const list: DurableListParams = {
			...optionalParam("limit", requestInteger(params, "limit")),
			...(params?.cursor === undefined ? {} : { cursor: params.cursor as DurableListParams["cursor"] }),
			...optionalParam("ownerConversationId", requestPositiveId(params?.ownerConversationId, "ownerConversationId") as ConversationId | undefined),
			...optionalParam("ownerTaskId", requestInteger(params, "ownerTaskId")),
		};
		return readConversationList(this.harness, this.storageId, list, context);
	}

	private async forkRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		const forked = await forkConversation(
			this.harness,
			conversation,
			requestPositiveId(params?.entryId, "entryId") as EntryId | undefined,
			{
				...optionalParam("name", requestString(params, "name")),
				owner: requestString(params, "ownerId") ?? this.identity(conversation.id),
				...optionalParam("requestId", requestString(params, "requestId")),
			},
			context,
		);
		return { conversationId: forked.conversation.id, identity: this.identity(forked.conversation.id), deduped: forked.deduped };
	}

	private async rewindRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		const entryId = requestPositiveId(params?.entryId, "entryId");
		if (entryId === undefined) throw new TypeError("entryId is required");
		const result = await rewindConversation(
			this.harness,
			conversation,
			{
				entryId: entryId as EntryId,
				correction: requestRequiredString(params, "correction"),
				...optionalParam("requestId", requestString(params, "requestId")),
				...optionalParam("name", requestString(params, "name")),
				owner: requestString(params, "ownerId") ?? this.identity(conversation.id),
				...optionalParam("ownerId", requestString(params, "ownerId")),
				...optionalParam("whenBusy", this.busyMode(params)),
				...optionalParam("operationId", requestString(params, "operationId")),
				...optionalParam("origin", this.originParam(params)),
			},
			context,
		);
		const base = {
			conversationId: result.conversation.id,
			identity: this.identity(result.conversation.id),
			predecessorEntryId: result.predecessorEntryId,
			submissionId: result.submissionId,
			deduped: result.deduped,
		};
		if (requestBoolean(params, "wait") !== true) return base;
		return { ...base, outcome: await readOutcome(this.harness, result.submissionId, context) };
	}

	private async abortRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		const background = requestBoolean(params, "background") ?? false;
		await abortConversation(conversation, background, context);
		return { conversationId: conversation.id, identity: this.identity(conversation.id), background };
	}

	private async compactRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		// Stop every reached task first; compaction starts from an idle conversation and does not resume the stopped work.
		await abortConversation(conversation, true, context);
		return compactConversation(this.harness, conversation, requestString(params, "instructions"), requestBoolean(params, "wait") ?? true, context);
	}

	private async configureRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		const model = modelRefFrom(params?.model);
		const thinking = params?.thinkingLevel;
		if (thinking !== undefined && thinking !== null && (typeof thinking !== "string" || !THINKING_LEVELS.includes(thinking))) {
			throw new TypeError(`thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
		}
		const name = params?.name;
		if (name !== undefined && name !== null && typeof name !== "string") throw new TypeError("name must be a string or null");
		const change: DurableConfigureParams = {
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinkingLevel: thinking as DurableConfigureParams["thinkingLevel"] }),
			...(name === undefined ? {} : { name: name as string | null }),
		};
		return await configureConversation(this.harness, conversation, { sessionId: this.identity(conversation.id), models: this.models, storagePath: this.storagePath }, change, context);
	}

	private async commandRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const name = requestRequiredString(params, "name");
		const command = this.commands.get(name);
		if (!command) throw new Error(`durable command ${name} is not registered`);
		const conversation = await this.target(params, context);
		if (this.contributionHost === undefined) throw new Error("no contribution host is bound to this durable host");
		const text = await command.run({
			args: requestString(params, "args") ?? "",
			conversation,
			context,
			host: this.contributionHost,
			invocationId: requestRequiredString(params, "invocationId"),
			harness: this.harness,
		});
		return { name, conversationId: conversation.id, identity: this.identity(conversation.id), text };
	}

	private async snapshotRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		return readConversationSnapshot(this.harness, conversation.id, context);
	}

	/**
	 * Admit the prompt with a stable request ID. A repeated request ID returns
	 * the existing submission; a supplied owner also retains a delivery intent.
	 */
	async submit(params: DurableSubmitParams & { readonly conversationId?: ConversationId }, context: Context = BACKGROUND_CONTEXT): Promise<DurableSubmitResult & { readonly identity: string }> {
		const conversation = params.conversationId === undefined ? this.rootConversation : await this.conversation(params.conversationId, context);
		const submitted = await submitConversation(conversation, params, context);
		return { ...submitted, identity: this.identity(conversation.id) };
	}

	/** Wait for settlement and read the retained answer, source IDs, and usage. */
	async wait(submissionId: SubmissionId, context: Context = BACKGROUND_CONTEXT): Promise<DurableRunOutcome> {
		return readOutcome(this.harness, submissionId, context);
	}

	/** Live scheduling state, tasks, and unsettled submissions. */
	async inspect(context: Context = BACKGROUND_CONTEXT): Promise<HarnessInspection> {
		return this.harness.inspect(context);
	}

	/** Delivery receipts currently awaiting their owner, without a wait. */
	async receipts(ownerId?: string, context: Context = BACKGROUND_CONTEXT): Promise<readonly DeliveryReceipt[]> {
		return readReceipts(this.harness, ownerId, context);
	}

	async usage(context: Context = BACKGROUND_CONTEXT) {
		return readUsage(this.harness, context);
	}

	/**
	 * Chronological committed transcript text (oldest to newest), keeping the
	 * newest entries within an entry-count bound and a byte cap. A notice names
	 * the bound that omitted older entries when it fits inside the cap.
	 */
	async transcript(limit = 200, maxBytes = TRANSCRIPT_MAX_BYTES, context: Context = BACKGROUND_CONTEXT): Promise<string> {
		validateTranscriptBounds(limit, maxBytes);
		const page = await this.rootConversation.entries({}, limit, undefined, context);
		const lines = page.items.map((entry) => `${entry.kind}: ${messageText(entry.model)}`);
		const total = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
		const marker = transcriptMarker(total > maxBytes, page.next !== undefined, limit, maxBytes);
		const notice = marker !== "" && Buffer.byteLength(marker) + 1 <= maxBytes ? marker : "";
		return boundTranscript(lines, maxBytes, notice);
	}

	/** Mark the root conversation's ordinary non-background work and wait for idle. */
	async abort(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.rootConversation.abort(context);
	}

	/** Seal admission, settle admitted commits, and close storage. Never uses a cancellable context. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.lifecycle.abort(new DurableHostClosedError());
		await this.harness.close(BACKGROUND_CONTEXT);
	}
}
