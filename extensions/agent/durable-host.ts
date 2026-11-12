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
import { randomUUID } from "node:crypto";
import { reconcileInputCommunications } from "./communication-retention.ts";
import { parseCommunication, parseCommunicationPassive } from "./communication.ts";
import { taskInputSender } from "./task-senders.ts";
import { cancelRequest, readRunScope, stopRun, type ForeignStop } from "./run-control.ts";
import { ProviderModels } from "./provider-models.ts";
import { ProviderRetryNotices, ProviderRetryNoticeSchema } from "./provider-notices.ts";
import { validateContinuityDelivered } from "./continuity-facts.ts";
import { ContinuityMirror } from "./continuity-mirror.ts";
import { recordContinuityDelivered } from "./continuity-native.ts";
import { continuityRequestHooks } from "./continuity-request.ts";
import { TaskHookReports } from "./task-hook-reports.ts";
import { ChildCapacityReports, childContinuityFact, continuityLines, type PlanningBudgetLookup } from "./capacity-reports.ts";
import { THREAD_NOTICE_ENTRY_KIND, threadNoticeRequestHooks } from "./thread-notice-request.ts";
import type { ProviderRetryNotice } from "./provider-block.ts";
import { readInputProviderBlock, initializeProviderControl, reconcileProviderControls } from "./provider-block.ts";
import { canonicalIdentity } from "./native-identity.ts";
import { storageStatusCoverage, storageStatusScanInput } from "./storage-status.ts";
import { matchesSchema } from "./schema-check.ts";
import { placeLeftoverWrites, StrandedInputRecovery } from "./stranded-inputs.ts";
import { admittedResult } from "./result-reference.ts";
import { ResultReferenceSchema, type ResultReference } from "./result-schema.ts";
import type { InputProvenance } from "./awaited-results.ts";
import { ownAwaitFact, producerRetryFact, releaseAwait } from "./await-observation.ts";
import { initializeProfile, reconcileProfiles, readProfile, updateProfile, type ProfileSeed } from "./profile.ts";
import { AwaitInputSuppressed, richSubmitConversation } from "./durable-controls.ts";
import { modelFailureText } from "./provider-block-facts.ts";
import { parseReportIntervention } from "./report-intervention.ts";
import { receiptSourceIdentity, receiptDeliveryRequestId, receiptReferencePage, migrateDeliveryStore, snapshotIntent, snapshotReceipt } from "./delivery-store.ts";
import { listCollaboration, readCollaboration, mutateCollaboration } from "./collaboration.ts";
import { checkInMinutes } from "./check-in-options.ts";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { ModelEvidenceCollector } from "./model-evidence.ts";
import { isInputKind } from "./input-entry.ts";
import { Harness, SessionFailed, ROOT_CONVERSATION_ID, UsageDoc, DEFAULT_RETRY_POLICY, type AgentChange, type Conversation, type ConversationId, type EntryId, type GenerationHooks, type HarnessInspection, type HarnessOptions, type ModelRef, type Submission, type SubmissionRecord, type SubmissionId, type TaskGraph, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acknowledgeDeliveries, acknowledgeReports, AgentForkDoc, AgentMetaDoc, abortConversation, compactConversation, configureConversation, forkConversation, pendingDeliveries, readOutcome, reconcileDeliveries, recordReport, rewindConversation, submitConversation, undeliveredForOwner, waitForReceipts, type DeliveryOrigin, type DeliveryReceipt, type DurableConfigureParams, type DurableRunOutcome, type DurableSubmitParams, type DurableSubmitResult } from "./durable-controls.ts";
import { durableIdentity, optionalParam, parseConversationSnapshotParams, parseInspectParams, readConversationList, readConversationSnapshotPage, readConversationStatus, readDashboard, readInspection, readReceipts, readUsage, requestBoolean, requestInteger, requestPositiveId, requestRequiredId, requestRequiredString, requestString, resolveSessionConversationId, type ConversationStatus, type DurableDashboardOptions, type DurableListParams, type DurableStatusOptions, type RequestParams } from "./durable-observation.ts";
import { LiveObservationService, type ObservationScope } from "./live-observation.ts";
import type { DurableCommand, DurableContributionHost } from "./durable-services.ts";
import { resetConversation } from "./durable-reset.ts";
import { TIMER_TASK_NAME, cancelTimer, listTimers, scheduleTimer, type TimerMode } from "./durable-timers.ts";
import { parseDeliverAt } from "./timer-input.ts";

export type { AgentConversationSnapshot, AgentConversationSummary } from "./dashboard-types.ts";
export type { ConfigurationResult } from "./configuration.ts";
export type { AgentDeliveryState, AgentMeta, DeliveryIntent, DeliveryReceipt, DeliveryReport, DurableConfigureParams, DurableRunOutcome, DurableSubmitParams, DurableSubmitResult } from "./durable-controls.ts";
export type { ConversationStatus, ConversationSummary, DurableInspectParams, DurableListParams, DurableStatusOptions, RequestParams } from "./durable-observation.ts";
export type { DurableCommandCall, DurableCommand as DurableContributionCommand } from "./durable-services.ts";
export { AgentForkDoc, AgentMetaDoc };

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
	/** Clock used by native task deadlines and settlement timestamps. Defaults to the native wall clock. */
	readonly now?: HarnessOptions["now"];
	/** Model access. `ModelRuntime` already implements this interface. */
	readonly models: Models;
	/** Root-conversation agent choices, including the model. Applied when the root is created; ignored on an existing root. */
	readonly agent?: AgentChange;
	/** Root conversation metadata, applied when the root is created. */
	readonly meta?: { readonly name?: string; readonly owner?: string };
	readonly profileSeed?: ProfileSeed;
	/** Commands contributed to Durable agents, invoked by the `command` request. */
	readonly commands?: readonly DurableHostCommand[] | ReadonlyMap<string, DurableHostCommand>;
	/** The services bootstrap's contribution host, passed to each command's fourth argument. */
	readonly contributionHost?: DurableContributionHost;
	/** Start scheduling unfinished work on open. Default true. */
	readonly resume?: boolean;
	/** Resolved generation retry ceiling (`maxRetries + 1`) for dashboard auto-retry health. */
	readonly retryMaxAttempts?: number;
	/** Planning budget in context tokens for one exact model, when the operator configured one. A preference, never a limit. */
	readonly planningBudget?: PlanningBudgetLookup;
	readonly onReport?: HarnessOptions["onReport"];
	readonly requestRelease?: () => Promise<{ readonly retiring: boolean; readonly blockers: readonly string[] }>;
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

/** Live observation services keyed by the Harness they observe; watches stop with the host lifecycle. */
const liveObservations = new WeakMap<Harness, LiveObservationService>();

const OBSERVATION_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/u;

/** One observation token from request parameters. */
function observationToken(params: RequestParams | undefined): string {
	const token = requestRequiredString(params, "token");
	if (!OBSERVATION_TOKEN.test(token)) throw new TypeError("token must be 1..128 letters, digits, dot, underscore, colon, or dash");
	return token;
}

/** Resolve one observation scope; conversations resolve through the same identity rules as status. */
function observationScope(storageId: string, params: RequestParams | undefined): ObservationScope {
	const scope = requestRequiredString(params, "scope");
	if (scope === "tasks") return { scope: "tasks" };
	if (scope !== "conversation") throw new TypeError("scope must be conversation or tasks");
	const conversationId = resolveSessionConversationId(storageId, requestString(params, "sessionId"), requestPositiveId(params?.conversationId, "conversationId"));
	return { scope: "conversation", conversationId };
}

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
/** One committed task-graph value through a synchronous observer, detached at once. */
export async function readTaskGraph(harness: Harness, context: Context): Promise<TaskGraph> {
	const observation = await harness.observeTaskGraph({ advance: () => {}, end: () => {} }, context);
	observation.detach();
	return observation.value;
}

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
	private providerModels?: ProviderModels;
	private providerNotices?: ProviderRetryNotices;
	private hookReports?: TaskHookReports;
	private capacityReports?: ChildCapacityReports;
	private continuity?: ContinuityMirror;
	private readonly continuityMismatches = new Map<ConversationId, number>();
	private continuityDiagnostic: ((error: unknown) => void) | undefined;
	private readonly storage: Storage;
	private readonly storagePath: string;
	private readonly lifecycle = new AbortController();
	private closed = false;
	private sessionClosing = false;
	private idleValue = false;
	private idleDirty = true;
	private commitGeneration = 0;
	private readonly defaultCwd: string | undefined;
	private readonly registry: HarnessOptions["registry"];
	private readonly retryMaxAttempts: number | undefined;
	private readonly retryCeiling: () => number;
	private readonly now: () => number;
	private deliveryError: string | undefined;
	private communicationDiagnostic: "retention-unavailable" | "invalid-envelope" | undefined;
	private recovery: StrandedInputRecovery | undefined;
	private resumeWork: Promise<void> | undefined;
	private recoveryError: ((error: unknown) => void) | undefined;
	private requestRelease: DurableHostOptions["requestRelease"];

	private constructor(harness: Harness, storage: Storage, storageId: string, root: Conversation, commands: readonly DurableHostCommand[] | ReadonlyMap<string, DurableHostCommand>, contributionHost: DurableContributionHost | undefined, cwd: string | undefined, models: Models, storagePath: string, registry: HarnessOptions["registry"], retryMaxAttempts: number | undefined, settings: HarnessOptions["settings"], now: () => number) {
		this.harness = harness;
		this.storage = storage;
		this.storageId = storageId;
		this.rootConversation = root;
		this.models = models;
		this.storagePath = storagePath;
		this.registry = registry;
		this.retryMaxAttempts = retryMaxAttempts;
		this.retryCeiling = () => { const retry = { ...DEFAULT_RETRY_POLICY, ...(typeof settings === "function" ? settings() : settings)?.retry }; return retry.enabled ? retry.maxRetries + 1 : 1; };
		this.now = now;
		const commandMap = new Map<string, DurableHostCommand>();
		if (Array.isArray(commands)) for (const command of commands as readonly DurableHostCommand[]) commandMap.set(command.name, command);
		else for (const [name, command] of commands as ReadonlyMap<string, DurableHostCommand>) commandMap.set(name, command);
		this.commands = commandMap;
		this.contributionHost = contributionHost;
		this.defaultCwd = cwd;
		harness.subscribeClose(() => {
			this.sessionClosing = true;
			this.idleDirty = true;
		});
		void harness.closed.then((end) => {
			this.lifecycle.abort(end.kind === "failed" ? new SessionFailed(end.error) : new DurableHostClosedError());
		});
		// A stored commit may add or remove work; the cached idle result is stale until the refresh settles.
		harness.observeCommits({ end: () => {}, advance: (publication) => {
			if (publication.changes.length > 0) liveObservations.get(harness)?.invalidate();
			if (publication.changes.some((change) => change.type === "submission" || (change.type === "entry" && isInputKind(change.value.kind)))) queueMicrotask(() => {
				if (!this.closed) void reconcileInputCommunications(harness, this.storageId, BACKGROUND_CONTEXT).catch(() => { this.communicationDiagnostic = "retention-unavailable"; });
			});
			this.commitGeneration += 1;
			this.idleDirty = true;
			queueMicrotask(() => {
				void this.refreshIdle().catch(() => {
					this.idleDirty = true;
				});
			});
		} });
	}

	/**
	 * Conservative synchronous idle check: false while an inspection refresh is
	 * pending, so a race cannot retire a host that just admitted work.
	 */
	get idle(): boolean {
		return !this.closed && !this.sessionClosing && !this.idleDirty && this.idleValue;
	}

	/** Native Session closure seals host admission, including after a fatal storage error. */
	get sessionEnded(): boolean { return this.sessionClosing; }

	private async requireOpen(): Promise<void> {
		if (this.sessionClosing) {
			const end = await this.harness.closed;
			if (end.kind === "failed") throw new SessionFailed(end.error);
			throw new DurableHostClosedError();
		}
		if (this.closed) throw new DurableHostClosedError();
	}

	isIdle(): boolean {
		return this.idle;
	}

	/** Bounded owner diagnostic, never a sender assertion or an admission failure. */
	get communicationMetadataDiagnostic(): "retention-unavailable" | "invalid-envelope" | undefined {
		return this.communicationDiagnostic;
	}

	/**
	 * Refresh the idle cache from committed task state and submissions. Every
	 * live task counts, including one waiting with no dependencies: a host must
	 * not retire while an external effect may still resume it. Unsettled
	 * submissions count.
	 */
	async refreshIdle(context: Context = BACKGROUND_CONTEXT): Promise<boolean> {
		if (this.closed || this.sessionClosing) return false;
		const generation = this.commitGeneration;
		const inspection = await this.harness.inspect(context);
		const value = sessionIsIdle(await readTaskGraph(this.harness, context), inspection);
		this.idleValue = value;
		if (generation === this.commitGeneration) this.idleDirty = false;
		return value && !this.idleDirty;
	}

	static async open(options: DurableHostOptions, context: Context = BACKGROUND_CONTEXT): Promise<DurableHost> {
		const storage = await openNodeSqliteStorage(options.storagePath);
		const now = options.now ?? Date.now;
		const report = (error: unknown): void => options.onReport?.({ kind: "extension_error", extension: "agent", error });
		let opened: DurableHost | undefined;
		// The sink's own failure goes to the caller's callback without a task, so retention never feeds itself.
		const hookReports = new TaskHookReports((error) => {
			const stopped = new Error("Task hook report retention stopped after a rejected write; reopen the host to resume it.", { cause: error });
			opened?.reportDeliveryError(stopped);
			report(stopped);
		}, now);
		let continuity: ContinuityMirror | undefined;
		let harness: Harness;
		const providerModels = new ProviderModels(options.models, () => harness, options.storageId, now);
		try {
			harness = await Harness.open(
				storage,
				{
					models: providerModels.models,
					registry: options.registry,
					...(options.settings === undefined ? {} : { settings: options.settings }),
					...(options.env === undefined ? {} : { env: options.env }),
					now,
					conversationCreated: async (tx, record) => {
						await initializeProfile(tx, record.id, options.storageId);
						await initializeProviderControl(tx, record.id);
					},
					onReport: (value) => {
						hookReports.record(value);
						options.onReport?.(value);
					},
				},
				context,
			);
		} catch (error) {
			await hookReports.close();
			try {
				await storage.close(BACKGROUND_CONTEXT);
			} catch {
				// Retain the open failure.
			}
			throw error;
		}
		try {
			await migrateDeliveryStore(harness, context);
			const root = await harness.root(context, {
				...(options.agent === undefined ? {} : { agent: options.agent }),
				init: async (tx, conversationId) => {
					const meta = await tx.doc(AgentMetaDoc, conversationId);
					if (options.meta?.name !== undefined) meta.name = options.meta.name;
					if (options.meta?.owner !== undefined) meta.owner = options.meta.owner;
					await initializeProfile(tx, conversationId, options.storageId, options.profileSeed);
				},
			});
			// Request hooks read this mirror from memory only, so it must hold every retained fact and head before any act that enables scheduling.
			continuity = new ContinuityMirror(harness, options.storageId);
			await continuity.initialize(context);
			await reconcileProfiles(harness, options.storageId, context, report);
			await reconcileProviderControls(harness, context);
			providerModels.bind();
			const host = new DurableHost(harness, storage, options.storageId, root, options.commands ?? [], options.contributionHost, options.cwd, options.models, options.storagePath, options.registry, options.retryMaxAttempts, options.settings, now);
			host.requestRelease = options.requestRelease;
			host.providerModels = providerModels;
			host.continuity = continuity;
			host.continuityDiagnostic = report;
			opened = host;
			host.hookReports = hookReports;
			hookReports.bind(harness);
			host.providerNotices = new ProviderRetryNotices(harness, options.storageId, options.settings, (error) => { host.deliveryError = `Provider retry notice failed: ${error instanceof Error ? error.message : String(error)}`; report(error); }, now);
			await host.providerNotices.initialize();
			host.capacityReports = new ChildCapacityReports(harness, options.storageId, () => options.models, options.planningBudget ?? (() => undefined), (error) => {
				host.reportDeliveryError(new Error(`Child capacity report failed: ${error instanceof Error ? error.message : String(error)}`));
				report(error);
			}, now);
			host.recoveryError = (error) => {
				host.deliveryError = `Queued-input recovery failed: ${error instanceof Error ? error.message : String(error)}`;
				report(error);
			};
			if (options.resume !== false) await host.resume(context);
			// A fresh host has no commit to trigger the subscriber; establish the idle cache now.
			await host.refreshIdle(context);
			return host;
		} catch (error) {
			await opened?.capacityReports?.close().catch(() => undefined);
			continuity?.close();
			await hookReports.close();
			try {
				await harness.close(BACKGROUND_CONTEXT);
			} catch {
				// Retain the open failure.
			}
			throw error;
		}
	}

	private foreignStop?: ForeignStop;
	setForeignStop(stop: ForeignStop): void { this.foreignStop = stop; }

	/** Observed context facts of one producing conversation, as lines for its result delivery. A failed read yields one line and never rejects. */
	async childContinuityLines(conversationId: ConversationId, unusable: boolean): Promise<string[]> {
		return continuityLines(await childContinuityFact(this.harness, conversationId, () => this.models, BACKGROUND_CONTEXT), unusable);
	}

	/**
	 * Generation hooks that insert the frozen continuity note of the current context head. The
	 * composition root installs them; they read the mirror that `open` loaded before scheduling.
	 * A head whose stored message differs from the request gets no note and one diagnostic.
	 */
	continuityHooks(): Partial<GenerationHooks> {
		return continuityRequestHooks(() => this.continuity, (found) => {
			if (this.continuityMismatches.get(found.conversationId) === found.headId) return;
			this.continuityMismatches.set(found.conversationId, found.headId);
			this.continuityDiagnostic?.(new Error(`Continuity note omitted for ${this.identity(found.conversationId)}: context head entry ${found.headId} does not match the request (${found.mismatch}).`));
		});
	}

	/**
	 * Generation hooks that replace passive thread notices with frozen range markers. The
	 * composition root installs one instance before the continuity hooks; frozen ranges of the
	 * process live in that instance.
	 */
	threadNoticeHooks(): Partial<GenerationHooks> {
		return threadNoticeRequestHooks({ storageId: this.storageId, identity: (conversationId) => this.identity(conversationId) });
	}

	/** Resume only after the caller installs contributions and model-facing sections. */
	async resume(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.requireOpen();
		this.resumeWork ??= (async () => {
			this.recovery = new StrandedInputRecovery(this.harness, (error) => this.recoveryError?.(error));
			try { await reconcileInputCommunications(this.harness, this.storageId, context); }
			catch { this.communicationDiagnostic = "retention-unavailable"; }
			this.harness.resume();
			await reconcileDeliveries(this.harness, context);
			await this.recovery.open(context);
		})();
		return this.resumeWork;
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
		await this.requireOpen();
		const requestContext = context instanceof AbortSignal ? withAbortSignal(context, BACKGROUND_CONTEXT) : context;
		switch (method) {
			case "collaboration-list": return listCollaboration(this.harness, params ?? {}, requestContext);
			case "collaboration-read": return readCollaboration(this.harness, params ?? {}, requestContext);
			case "collaboration-mutate": return mutateCollaboration(this.harness, this.storageId, params ?? {}, requestContext);
			case "passive-submit": return this.passiveSubmitRequest(params, requestContext);
			case "profile-read": {
				const conversation = await this.target(params, requestContext);
				return readProfile(this.harness, this.storageId, conversation.id, requestContext, true);
			}
			case "profile-update": {
				const conversation = await this.target(params, requestContext);
				return updateProfile(this.harness, this.storageId, conversation.id, {
					expectedRevision: requestRequiredString(params, "expectedRevision"), requestId: requestRequiredString(params, "requestId"), senderIdentity: requestRequiredString(params, "senderIdentity"),
					...optionalParam("role", requestString(params, "role")), ...optionalParam("expertise", requestString(params, "expertise")),
				}, requestContext);
			}
			case "run-scope": {
				const conversation = await this.target(params, requestContext);
				return readRunScope(this.harness, this.storageId, conversation.id, requestContext);
			}
			case "run-stop": {
				const conversation = await this.target(params, requestContext);
				const inputs = params?.inputs;
				if (inputs !== undefined && (!Array.isArray(inputs) || inputs.length > 200 || inputs.some(input => !matchesSchema(ResultReferenceSchema, input)))) throw new TypeError("Invalid guarded run inputs");
				return stopRun(this.harness, this.storageId, conversation.id, requestRequiredId(params?.runId, "runId") as import("@earendil-works/pi-durable").SubmissionId, requestContext, { inputs: inputs as ResultReference[] | undefined, foreign: this.foreignStop });
			}
			case "request-cancel": {
				if (!matchesSchema(ResultReferenceSchema, params?.result)) throw new TypeError("An exact native result is required");
				const result = params.result as ResultReference;
				const conversation = await this.conversation(result.sessionId, requestContext);
				return cancelRequest(this.harness, this.storageId, result, conversation.id, requestContext);
			}
			case "task-submit": return this.taskSubmitRequest(params, requestContext);
			case "submit":
				return this.submitRequest(params, requestContext).catch((error) => {
					if (error instanceof AwaitInputSuppressed) return { suppressed: true };
					throw error;
				});
			case "receipts":
				return this.receiptsRequest(params, requestContext);
			case "await-state": return this.awaitStateRequest(params, requestContext);
			case "await-release": return this.awaitReleaseRequest(params, requestContext);
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
			case "release":
				return this.releaseRequest(params, requestContext);
			case "compact":
				return this.compactRequest(params, requestContext);
			case "configure":
				return this.configureRequest(params, requestContext);
			case "command":
				return this.commandRequest(params, requestContext);
			case "reset":
				return this.resetRequest(params, requestContext);
			case "timer-schedule":
				return this.timerScheduleRequest(params, requestContext);
			case "timer-list":
				return this.timerListRequest(requestContext);
			case "timer-cancel":
				return this.timerCancelRequest(params, requestContext);
			case "dashboard": {
				const conversationId = requestPositiveId(params?.conversationId, "conversationId");
				return readDashboard(this.harness, this.storageId, conversationId === undefined ? {} : { conversationId: conversationId as ConversationId }, this.dashboardOptions(params), requestContext);
			}
			case "snapshot":
				return this.snapshotRequest(params, requestContext);
			case "observe-open":
				return this.observeOpenRequest(params, requestContext);
			case "observe-frame":
				return this.observeFrameRequest(params, requestContext);
			case "observe-close":
				return this.observeCloseRequest(params, requestContext);
			case "close":
				await this.close();
				return {};
			default:
				throw new TypeError(`unknown durable host method ${method}`);
		}
	}

	/** Read publication rows and evidence together without changing the host wire contract. */
	async catalogProjection(context: Context = BACKGROUND_CONTEXT) {
		const evidence = new ModelEvidenceCollector(new Date().toISOString());
		const rows = await readDashboard(this.harness, this.storageId, {}, { ...this.dashboardOptions(undefined), modelEvidence: evidence }, context);
		return { rows, modelEvidence: evidence.value, updatedAt: evidence.observedAt };
	}

	private dashboardOptions(params: RequestParams | undefined): DurableDashboardOptions {
		const cwd = requestString(params, "cwd");
		return {
			storage: this.storage,
			owner: "here",
			live: true,
			...(this.retryMaxAttempts === undefined ? {} : { retryMaxAttempts: this.retryMaxAttempts }),
			...(this.defaultCwd === undefined ? {} : { cwd: this.defaultCwd }),
			...(cwd === undefined ? {} : { cwd }),
		};
	}

	private async awaitStateRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const target = await this.target(params, context);
		const results = params?.results ?? [];
		const identity = canonicalIdentity(this.storageId, target.id);
		if (!Array.isArray(results) || results.length > 16 || results.some((result) => !matchesSchema(ResultReferenceSchema, result) || result.sessionId !== identity)) throw new Error("Invalid producer result references");
		return this.harness.commit(async (tx) => {
			const awaiting = await ownAwaitFact(tx, target.id);
			const execution = await producerRetryFact(tx, target.id, results, this.retryCeiling());
			return { ...(awaiting === undefined ? {} : { awaiting }), ...(execution === undefined ? {} : { execution }) };
		}, context);
	}
	private async awaitReleaseRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const target = await this.target(params, context);
		return this.harness.commit((tx) => releaseAwait(tx, this.storageId, target.id, requestRequiredId(params?.expectedRunId, "expectedRunId")), context);
	}
	private async taskSubmitRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const origin = this.originParam(params);
		if (origin === undefined) throw new TypeError("task-submit requires an explicit origin");
		const conversation = await this.target(params, context);
		await conversation.commit((tx) => initializeProfile(tx, conversation.id, this.storageId), context);
		const requester = requestRequiredString(params, "requester");
		const checkedSender = taskInputSender(requester);
		const senderConversation = requester === this.storageId ? ROOT_CONVERSATION_ID : checkedSender !== undefined && requester.startsWith(`${this.storageId}:`) ? Number(requester.slice(this.storageId.length + 1)) as ConversationId : undefined;
		const senderName = senderConversation === undefined ? undefined : (await this.harness.snapshot(AgentMetaDoc, senderConversation, context).catch(() => undefined))?.name;
		const taskSender = taskInputSender(requester, senderName);
		const submitted = await richSubmitConversation(conversation, {
			message: messageFrom(params?.message), requestId: requestRequiredString(params, "requestId"), requester,
			communication: { storageId: this.storageId, value: undefined, ...(taskSender === undefined ? {} : { taskSender }) },
			origin, ...optionalParam("replyTo", requestString(params, "replyTo")), ...optionalParam("whenBusy", this.busyMode(params)), ...optionalParam("operationId", requestString(params, "operationId")),
			...(params?.checkInMinutes === undefined ? {} : { checkInMinutes: checkInMinutes(params.checkInMinutes) }), senderIdentity: this.identity(conversation.id),
		}, context);
		return { ...submitted, identity: this.identity(conversation.id), result: admittedResult(this.identity(conversation.id), submitted, requestRequiredString(params, "requestId")) };
	}

	private async submitRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const communication = params?.communication === undefined ? undefined : parseCommunication(params.communication) ?? null;
		if (communication === null) this.communicationDiagnostic = "invalid-envelope";
		const conversation = await this.target(params, context);
		await conversation.commit((tx) => initializeProfile(tx, conversation.id, this.storageId), context);
		const provenance = params?.provenance as Omit<InputProvenance, "conversationId" | "requestId" | "submissionId"> | undefined;
		const providerRetry = params?.providerRetry;
		if (providerRetry !== undefined && (!matchesSchema(ProviderRetryNoticeSchema, providerRetry) || providerRetry.fact.execution === undefined)) throw new TypeError("Invalid provider retry notice evidence");
		const message = messageFrom(params?.message);
		const requestId = requestRequiredString(params, "requestId");
		const delivered = params?.deliveredResults;
		if (delivered !== undefined) validateContinuityDelivered(delivered);
		// A replayed body admission is deduplicated, and a body that an active wait already returned is
		// suppressed; in both cases the result reached this conversation, so its delivered facts complete.
		const complete = async (): Promise<void> => {
			if (delivered !== undefined) await this.harness.commit((tx) => recordContinuityDelivered(tx, conversation.id, delivered), context);
		};
		const submitted = await submitConversation(
			conversation,
			{
				message,
				requestId,
				communication: { storageId: this.storageId, value: communication },
				...(provenance === undefined ? {} : { provenance }),
				...(providerRetry === undefined ? {} : { providerRetry: providerRetry as ProviderRetryNotice }),
				...optionalParam("ownerId", requestString(params, "ownerId")),
				...optionalParam("whenBusy", this.busyMode(params)),
				...optionalParam("operationId", requestString(params, "operationId")),
				...optionalParam("origin", this.originParam(params)),
				...(params?.checkInMinutes === undefined ? {} : { checkInMinutes: checkInMinutes(params.checkInMinutes) }),
				senderIdentity: this.identity(conversation.id),
			},
			context,
			this.now,
		).catch(async (error) => {
			if (error instanceof AwaitInputSuppressed) await complete();
			throw error;
		});
		await complete();
		return { ...submitted, identity: this.identity(conversation.id) };
	}

	private async passiveSubmitRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const communication = params?.communication === undefined ? undefined : parseCommunication(params.communication) ?? null;
		const conversation = await this.target(params, context);
		const message = requestRequiredString(params, "message");
		if (Buffer.byteLength(message) > 16 * 1024) throw new Error("Passive report exceeds its byte bound");
		if (params?.provenance !== undefined && (params.provenance as { intervention?: unknown }).intervention !== undefined) throw new Error("An intervention report must remain active");
		const requestId = requestRequiredString(params, "requestId");
		let data: ReturnType<typeof parseCommunicationPassive> | { format: "agent.communication-invalid/1"; reason: "invalid" };
		if (communication !== undefined) {
			try { data = parseCommunicationPassive({ format: "agent.communication-passive/1", requestId, value: communication === null ? null : { ...communication, recordedAt: this.now() } }); }
			catch { data = undefined; }
			if (data === undefined) {
				this.communicationDiagnostic = "invalid-envelope";
				data = { format: "agent.communication-invalid/1", reason: "invalid" };
			}
		}
		const submission = await conversation.submit({ type: "write", requestId, entry: { kind: communication?.kind === "report" ? "agent.passive-report" : THREAD_NOTICE_ENTRY_KIND, model: [{ role: "user", content: message, timestamp: Date.now() }], ...(data === undefined ? {} : { data }) } }, context);
		return { submissionId: submission.id, conversationId: conversation.id, passive: true };
	}

	private busyMode(params: RequestParams | undefined): "steer" | "followUp" | "reject" | undefined {
		const value = params?.whenBusy;
		if (value === undefined) return undefined;
		if (value === "steer" || value === "followUp" || value === "reject") return value;
		throw new TypeError("whenBusy must be steer, followUp, or reject");
	}

	/** Validate a supplied admission origin; each admission method enforces its absence policy. */
	private originParam(params: RequestParams | undefined): DeliveryOrigin | undefined {
		const value = params?.origin;
		if (value === undefined) return undefined;
		if (value === "operator" || value === "model") return value;
		throw new TypeError("origin must be operator or model");
	}

	private async resultSubmission(reference: ResultReference, context: Context) {
		if (!matchesSchema(ResultReferenceSchema, reference)) throw new Error("Invalid exact result reference");
		const submission = await this.harness.submission(reference.submissionId as SubmissionId, context);
		const status = await submission?.status(context);
		if (submission === undefined || status?.type !== "input" || this.identity(status.conversationId) !== reference.sessionId || (reference.requestId !== undefined && status.requestId !== reference.requestId)) throw new Error("The exact receipt does not identify the selected native input");
		return { submission, status };
	}
	private async requireResultRecipient(status: Extract<SubmissionRecord, { type: "input" }>, ownerId: string, context: Context): Promise<void> {
		const receipt = await snapshotReceipt(this.harness, status.id, context);
		if (receipt?.ownerId === ownerId) return;
		const intent = status.requestId === undefined ? undefined : await snapshotIntent(this.harness, status.conversationId, status.requestId, context);
		if (intent?.ownerId !== ownerId) throw new Error("The selected result is not addressed to this recipient");
	}
	private async resultOutcome(submission: Submission, metadataOnly: boolean, context: Context): Promise<Omit<DurableRunOutcome, "usage">> {
		if (!metadataOnly) {
			const { usage: _storageUsage, ...outcome } = await readOutcome(this.harness, submission.id, context);
			return outcome;
		}
		const settled = await submission.wait(context);
		if (settled.type !== "input") throw new Error("The selected result is not an input");
		const common = { submissionId: settled.id, conversationId: settled.conversationId, ...(settled.requestId === undefined ? {} : { requestId: settled.requestId }), ...(settled.entry === undefined ? {} : { entryId: settled.entry }) };
		if (settled.status === "done") return { ...common, status: "done", answerEntryId: settled.answer };
		const providerBlock = await this.harness.commit((tx) => readInputProviderBlock(tx, settled.id), context);
		return { ...common, status: "unanswered", reason: modelFailureText(settled.reason, settled.detail, providerBlock), ...(providerBlock === undefined ? {} : { providerBlock }) };
	}
	private async selectedReceipt(reference: ResultReference, ownerId: string, context: Context, receiptCursor?: string, metadataOnly = false): Promise<unknown> {
		const { submission, status } = await this.resultSubmission(reference, context);
		await this.requireResultRecipient(status, ownerId, context);
		const outcome = await this.resultOutcome(submission, metadataOnly, context);
		await reconcileDeliveries(this.harness, context);
		const selected = await snapshotReceipt(this.harness, status.id, context);
		if (selected === undefined || selected.ownerId !== ownerId) return { outcome };
		const receiptGroup = await this.harness.commit((tx) => receiptReferencePage(tx, this.storageId, selected, receiptCursor), context);
		const delivery = { requestId: receiptDeliveryRequestId(this.storageId, selected), sourceId: receiptSourceIdentity(this.storageId, selected), producerStorageId: this.storageId, recipient: ownerId, ...(selected.answerEntryId === null ? {} : { answerEntryId: selected.answerEntryId }), results: receiptGroup.results, complete: receiptGroup.complete };
		return { outcome, delivery, receiptGroup };
	}

	private async receiptsRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const ownerId = requestRequiredString(params, "ownerId");
		if (params?.result !== undefined) return this.selectedReceipt(params.result as ResultReference, ownerId, context, requestString(params, "receiptCursor"), requestBoolean(params, "metadataOnly") ?? false);
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
		const passive = requestBoolean(params, "passive");
		const report = await recordReport(
			this.harness,
			{ ownerId, senderIdentity, requestId, message, ...(replyTo === undefined ? {} : { replyTo }), ...(passive === undefined ? {} : { passive }), ...(params?.intervention === undefined ? {} : { intervention: parseReportIntervention(params.intervention), storageId: this.storageId }) },
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

	/**
	 * Record the latest bounded delivery routing failure for status, or clear it.
	 * A stalled delivery names its reason here, so an operator can act on it.
	 */
	reportDeliveryError(error: Error | undefined): void {
		const message = error?.message;
		this.deliveryError = message === undefined || message === "" ? undefined : message.length > 512 ? `${message.slice(0, 509)}...` : message;
	}

	private async statusRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const sessionId = requestString(params, "sessionId");
		const conversationId = requestPositiveId(params?.conversationId, "conversationId");
		const options: DurableStatusOptions = this.defaultCwd === undefined ? {} : { cwd: this.defaultCwd };
		const reported = this.deliveryError === undefined ? {} : { deliveryError: this.deliveryError };
		if (params?.view === "storage-page" && (sessionId !== undefined || conversationId !== undefined)) throw new Error("Storage status does not accept a conversation selector");
		if (sessionId === undefined && conversationId === undefined) {
			const input = storageStatusScanInput(params, this.storageId);
			const page = await this.harness.commit((tx) => tx.scanConversations({}, input.limit, input.cursor), context);
			const conversations: ConversationStatus[] = [];
			for (const record of page.items) {
				const status = await readConversationStatus(this.harness, this.storageId, record.id, options, context);
				if (status) conversations.push(status);
			}
			return { conversations, coverage: storageStatusCoverage(this.storageId, input.limit, page.items.length, conversations.length, page.next), ...reported };
		}
		const conversation = await this.target(params, context);
		const status = await readConversationStatus(this.harness, this.storageId, conversation.id, options, context);
		if (!status) throw new Error(`conversation ${this.identity(conversation.id)} does not exist`);
		return { conversation: status, ...reported };
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
		const ownerId = requestBoolean(params, "selfOwned") === true
			? (conversationId: ConversationId) => this.identity(conversationId)
			: requestString(params, "ownerId");
		const result = await rewindConversation(
			this.harness,
			conversation,
			{
				entryId: entryId as EntryId,
				correction: requestRequiredString(params, "correction"),
				...optionalParam("requestId", requestString(params, "requestId")),
				...optionalParam("name", requestString(params, "name")),
				owner: requestString(params, "ownerId") ?? this.identity(conversation.id),
				...optionalParam("ownerId", ownerId),
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

	private async releaseRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		if (requestBoolean(params, "background") === true) throw new Error("release cannot be combined with background; abort with background first, then release");
		if (params?.timerId !== undefined) throw new Error("release cannot be combined with timerId");
		const aborted = await this.abortRequest(params, context);
		let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
		let writesPlaced = 0;
		do {
			const page = await this.harness.commit((tx) => tx.scanConversations({}, 50, cursor), context);
			for (const record of page.items) {
				const conversation = await this.harness.conversation(record.id, context);
				if (conversation) writesPlaced += await placeLeftoverWrites(conversation, context);
			}
			cursor = page.next;
		} while (cursor);
		const outcome = this.requestRelease ? await this.requestRelease() : { retiring: false, blockers: ["Release is not available in this host."] };
		return { aborted, writesPlaced, ...outcome };
	}

	private async compactRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		const agent = await conversation.agent(context);
		let name: string | undefined;
		let metadataError: string | undefined;
		try { name = (await this.harness.snapshot(AgentMetaDoc, conversation.id, context))?.name ?? undefined; }
		catch (error) { metadataError = error instanceof Error ? error.message : String(error); }
		const model = agent.model === undefined ? undefined : this.models.getModel(agent.model.provider, agent.model.modelId);
		const compaction = { identity: this.identity(conversation.id), name, provider: agent.model?.provider, modelId: agent.model?.modelId, thinkingLevel: agent.thinkingLevel, ...(metadataError === undefined ? {} : { metadataError }), ...(model === undefined ? {} : { before: { contextWindow: model.contextWindow } }) };
		const outcome = await compactConversation(this.harness, conversation, requestString(params, "instructions"), requestBoolean(params, "wait") ?? true, context);
		return { ...outcome, compaction: { ...compaction, ...(outcome.summaryChars === undefined ? {} : { summaryChars: outcome.summaryChars }) } };
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
		const origin = this.originParam(params);
		const answer = await command.run({
			args: requestString(params, "args") ?? "",
			...(params?.data === undefined ? {} : { data: params.data as import("@earendil-works/chord/json").JsonValue }),
			...(origin === undefined ? {} : { origin }),
			conversation,
			context,
			host: this.contributionHost,
			invocationId: requestRequiredString(params, "invocationId"),
			harness: this.harness,
		});
		const result = typeof answer === "string" ? { text: answer } : answer;
		if (typeof result?.text !== "string") throw new Error(`durable command ${name} returned no text`);
		return { name, conversationId: conversation.id, identity: this.identity(conversation.id), text: result.text, ...(result.data === undefined ? {} : { data: result.data }) };
	}

	/**
	 * Reset one conversation's active context through a retained write
	 * submission. Placed immediately while idle, at the next boundary while
	 * busy; an admitted reset starts no model turn.
	 */
	private async resetRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		const handoff = requestString(params, "handoff");
		const requestId = requestString(params, "requestId") ?? randomUUID();
		const result = await resetConversation(conversation, { ...(handoff === undefined ? {} : { handoff }), requestId }, context);
		return { ...result, identity: this.identity(conversation.id) };
	}

	private timerMode(params: RequestParams | undefined): TimerMode {
		const value = params?.mode;
		if (value === undefined) return "followUp";
		if (value === "followUp" || value === "steer") return value;
		throw new TypeError("mode must be followUp or steer");
	}

	/**
	 * Create one host-owned scheduled input. The deadline, target, message,
	 * mode, origin, and request identity commit as the task input before any
	 * sleep, so a restart resumes the same deadline and admits at most once.
	 */
	private async timerScheduleRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		if (this.registry.snapshot().task(TIMER_TASK_NAME) === undefined) throw new Error("Scheduled inputs require the agent contribution in this storage");
		const message = requestRequiredString(params, "message");
		const deadline = parseDeliverAt(params?.deliverAt);
		const mode = this.timerMode(params);
		const origin = this.originParam(params) ?? "model";
		const requester = requestRequiredString(params, "ownerId");
		const ownerId = requestBoolean(params, "selfOwned") === true ? this.identity(conversation.id) : requester;
		const scheduleId = requestString(params, "scheduleId") ?? `timer:${randomUUID()}`;
		const requestId = requestString(params, "requestId") ?? `timer-delivery:${randomUUID()}`;
		return await scheduleTimer(
			this.harness,
			{ scheduleId, deadline, conversationId: conversation.id, identity: this.identity(conversation.id), message, mode, origin, ownerId, requestId, requestContext: { requestId, requester, replyTo: ownerId, origin }, createdAt: Date.now(), ...(params?.checkInMinutes === undefined ? {} : { checkInMinutes: checkInMinutes(params.checkInMinutes) }) },
			context,
		);
	}

	private async timerListRequest(context: Context): Promise<unknown> {
		return listTimers(this.harness, context);
	}

	private async timerCancelRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const timerId = requestPositiveId(params?.timerId, "timerId");
		if (timerId === undefined) throw new TypeError("timerId is required");
		const conversation = await this.target(params, context);
		// The receipt names the conversation that this host resolved, as the schedule receipt does.
		return { ...await cancelTimer(this.harness, timerId, context, conversation.id), identity: this.identity(conversation.id) };
	}

	private async snapshotRequest(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversation = await this.target(params, context);
		return readConversationSnapshotPage(this.harness, conversation.id, parseConversationSnapshotParams(params), context, this.storageId);
	}

	// ----- live observation -----------------------------------------------------------------

	/** Observe native view publications without treating a streamed delta as a storage commit. */
	onObservationChange(listener: () => void): () => void {
		return this.liveObservation().onChange(listener);
	}

	/** Live tokens cannot survive replacement of the Harness that owns their watches. */
	get observationCount(): number { return liveObservations.get(this.harness)?.size ?? 0; }

	/** Lazily created per open Harness; watches stop when the host lifecycle aborts. */
	private liveObservation(): LiveObservationService {
		let service = liveObservations.get(this.harness);
		if (service === undefined) {
			service = new LiveObservationService(this.harness, { storageId: this.storageId }, withAbortSignal(this.lifecycle.signal, BACKGROUND_CONTEXT));
			liveObservations.set(this.harness, service);
		}
		return service;
	}

	private async observeOpenRequest(params: RequestParams | undefined, _context: Context): Promise<unknown> {
		const token = observationToken(params);
		const scope = observationScope(this.storageId, params);
		const frame = await this.liveObservation().open(token, scope);
		return { token, frame };
	}

	private async observeFrameRequest(params: RequestParams | undefined, _context: Context): Promise<unknown> {
		const token = observationToken(params);
		const frame = await this.liveObservation().frame(token);
		if (frame === undefined) throw new TypeError(`unknown observation token ${token}`);
		return frame;
	}

	private async observeCloseRequest(params: RequestParams | undefined, _context: Context): Promise<unknown> {
		const token = observationToken(params);
		return { closed: await this.liveObservation().close(token) };
	}

	/**
	 * Admit the prompt with a stable request ID. A repeated request ID returns
	 * the existing submission; a supplied owner also retains a delivery intent.
	 */
	async submit(params: DurableSubmitParams & { readonly conversationId?: ConversationId }, context: Context = BACKGROUND_CONTEXT): Promise<DurableSubmitResult & { readonly identity: string }> {
		const conversation = params.conversationId === undefined ? this.rootConversation : await this.conversation(params.conversationId, context);
		const submitted = await submitConversation(conversation, { ...params, communication: params.communication ?? { storageId: this.storageId, value: undefined } }, context);
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
		await this.recovery?.close();
		await this.providerNotices?.close();
		await this.capacityReports?.close();
		await this.hookReports?.close();
		this.continuity?.close();
		this.providerModels?.close();
		await this.harness.close(BACKGROUND_CONTEXT);
	}
}
